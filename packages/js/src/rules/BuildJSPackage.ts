/*
 * Copyright (c) 2022 Nathan Keynes <nkeynes@deadcoderemoval.net>
 *
 * This file is part of Fabr.
 *
 * Fabr is free software: you can redistribute it and/or modify it under the
 * terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version.
 *
 * Fabr is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more
 * details.
 *
 * You should have received a copy of the GNU General Public License along with
 * Fabr. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * The js_package[build] rule: build a Node/NPM-compatible package — compile
 * its TypeScript sources against the resolved deps, generate its package.json,
 * and deliver it as a PackageFileSet carrying identity and direct deps.
 */

import {
  Computable,
  Constraints,
  defineRule,
  Dependency,
  dependencyName,
  FabrError,
  FileSet,
  FileSource,
  Flag,
  IFile,
  LooseSources,
  PackageFileSet,
  PackageSources,
  Provided,
  readJsonFile,
  ResolutionSpec,
  RuleResult,
  SourceRef,
  TargetContext,
  toJsonObject,
} from "@fabr-build/core";
import {
  compileContents,
  dualFormatOutputs,
  ESM_JS_EXTENSION,
  formatJSTarget,
  ICompiledContents,
  parseJSTarget,
  stripPackageJson,
  withBinShebangs,
} from "../JSPackage";
import { NPM_FORMAT } from "../NPMProtocol";
import { createPackageJson } from "../PackageJson";

/** The `js_package` rule, under `build`. */
export default defineRule({
  /**
   * State the package's requirements, resolved as one collection so this
   * target's pins govern the lot (a package needing Node APIs lists
   * `@types/node` among them). `dependencies` and `provided` are what the
   * package passes on. `provided_deps` take part in resolution and the compile
   * like `deps`, are written to `peerDependencies`, and are carried named as
   * provided, so a consumer's collection point binds each to what it uses under
   * that name. The compiler is resolved apart, by js_compile.
   */
  requirements(context: TargetContext): Computable<ResolutionSpec<{
    srcs: Computable<SourceRef[]>;
    resources: Computable<SourceRef[]>;
    tests: Computable<SourceRef[]>;
    exports: Computable<SourceRef[]>;
    dependencies: Computable<PackageSources>;
    provided: Computable<PackageSources>;
    optional_provided: Computable<PackageSources>;
    compile_deps: Computable<PackageSources>;
    test_deps: Computable<LooseSources>;
    test_resources: Computable<SourceRef[]>;
    test_expectations: Computable<SourceRef[]>;
  }>> {
    return context.getProperty("version").then(version => {
      assertPackageVersion(version?.toString());
      const written = version?.toString();
      const builds = { package: context.name, format: NPM_FORMAT, ...(written === undefined ? {} : { version: written }) };
      return {
        requirements: {
          srcs: context.getFileProperty("srcs"),
          resources: context.getFileProperty("resources"),
          tests: context.getFileProperty("tests"),
          exports: context.getFileProperty("exports"),
          dependencies: context.getPackageProperty("deps"),
          provided: context.getPackageProperty("provided_deps"),
          optional_provided: context.getPackageProperty("optional_provided_deps"),
          /* Compiled against, and private to the build: not passed on. */
          compile_deps: context.getPackageProperty("compile_deps"),
          /* Only the loose files of `test_deps`, which are subtracted from `srcs`:
           * a build resolves and fetches nothing the tests alone need. */
          test_deps: context.getLooseFileProperty("test_deps"),
          test_resources: context.getFileProperty("test_resources"),
          test_expectations: context.getFileProperty("test_expectations"),
        },
        builds,
      };
    });
  },
  evaluateResolved(context, requirements) {
    return Computable.forAll(
      [
        requirements.materializeAll(),
        requirements.packages("dependencies"),
        requirements.packages("provided"),
        requirements.packages("optional_provided"),
      ],
      (gathered, dependencies, provided, optional_provided) =>
        buildJsPackage(context, gathered, { dependencies, provided, optional_provided })
    );
  },
});

/** A package needs no version, but one it states must be one npm can read: it
 * is written into the manifest, and everything that later resolves against
 * the package compares by it. */
function assertPackageVersion(version: string | undefined): void {
  if (version === undefined) {
    return;
  }
  try {
    NPM_FORMAT.parseVersion(version);
  } catch {
    throw new FabrError(`'${version}' is not a valid package version`).withHelp(
      "write it as major.minor.patch (1.0.0), optionally followed by a prerelease (1.0.0-beta.1)"
    );
  }
}

/** Make the target's package: `files` under its name at `version`, requiring
 * the packages `edges.dependencies`, `edges.provided` and
 * `edges.optional_provided` lead to, the latter two named as provided. */
function packageOf(
  context: TargetContext,
  files: Iterable<[string, IFile]>,
  version: string | undefined,
  edges: PackageEdges
): PackageFileSet {
  return new PackageFileSet(
    files,
    context.name,
    version,
    [...edges.dependencies, ...edges.provided, ...edges.optional_provided],
    undefined,
    new Map([
      ...edges.provided.map((dep): [string, Provided] => [dependencyName(dep), "expected"]),
      ...edges.optional_provided.map((dep): [string, Provided] => [dependencyName(dep), "optional"]),
    ])
  );
}

/** The edges to the packages among the requirements a package passes on. */
interface PackageEdges {
  dependencies: ReadonlyArray<Dependency<PackageFileSet>>;
  provided: ReadonlyArray<Dependency<PackageFileSet>>;
  optional_provided: ReadonlyArray<Dependency<PackageFileSet>>;
}

function buildJsPackage(
  context: TargetContext,
  gathered: {
    srcs: FileSet[];
    resources: FileSet[];
    tests: FileSet[];
    exports: FileSet[];
    dependencies: FileSet[];
    provided: FileSet[];
    optional_provided: FileSet[];
    compile_deps: FileSet[];
    test_deps: FileSet[];
    test_resources: FileSet[];
    test_expectations: FileSet[];
  },
  edges: PackageEdges
): Computable<RuleResult> {
  return Computable.forAll(
    [context.getGlobalString("JS_TARGET"), context.getProperty("version"), context.getMap("metadata")],
    (target, version, metadata) => {
      const jsTarget = parseJSTarget(target);

      return Computable.resolve(gathered).then(
        ({
          srcs: srcSets,
          resources: resourceSets,
          tests: testSets,
          exports: exportSets,
          dependencies: deps,
          provided,
          optional_provided: optionalProvided,
          compile_deps: compileOnly,
          test_deps: testDepSources,
          test_resources: testResourceSources,
          test_expectations: expectationSources,
        }) => {
          /* The declared entry points are compile inputs in their own right, so a
           * target may name one that `srcs` does not cover (js_bundle's `entry` has
           * the same relation to its `srcs`). Naming the same file twice is not a
           * conflict — a union is by file identity, not by arrival. */
          const exported = FileSet.unionAll(...exportSets);
          const dual = jsTarget.module === "dual";
          const sources = FileSet.unionAll(...srcSets, exported);
          const tests = FileSet.unionAll(...testSets);
          /* If there's a 'package.json' in the source list, we can initialize the output package.json from it */
          const seedJson = sources.get("package.json").then(file => file && readJsonFile(file, toJsonObject));
          /* `srcs` minus everything declared test-only. `tests` is the obvious
           * half; the other is the plain-SOURCE part of `test_deps` — test support
           * that compiles with the test types in scope but is neither run nor
           * shipped (an integration suite the entry file imports, a harness). A
           * file named there is not package content, exactly as one named in
           * `tests` is not.
           *
           * `test_deps` arrives as its loose files alone, with nothing resolved
           * for the packages it names; the other two are files. A Flag is
           * excluded: it names nothing. */
          const testOnlySources = [...testDepSources, ...testResourceSources, ...expectationSources].filter(
            (source): source is FileSet => !(source instanceof Flag)
          );
          const compileSources = sources.minus(tests).minus(FileSet.unionAll(...testOnlySources));
          const compileDeps = [...deps, ...provided, ...optionalProvided, ...compileOnly].filter((dep): dep is FileSet => dep instanceof FileSet);
          /* Declared (not resolved) requirements for the generated manifest: each
           * reports what was *written* — an inline `@npm:pkg:1.2.3` off the
           * reference the edge was resolved for, a catalog dep from the catalog's
           * pin — not the version the joint resolution selected. Provided deps
           * declare `peerDependencies`, optional ones marked so. */
          const declaredDeps = context.collectDeclaredRequirements(edges.dependencies);
          const declaredProvided = context.collectDeclaredRequirements(edges.provided);
          const declaredOptional = context.collectDeclaredRequirements(edges.optional_provided);

          return Computable.forAll(
            [seedJson, declaredDeps, declaredProvided, declaredOptional],
            (seed, declared, providedDeclared, optionalDeclared) => {
            /* Compile against the direct deps: the sources see only these, while
             * the transitive closure is reachable only by the deps themselves —
             * the dependency manifest's doing, not a layout's. Provided deps are
             * on the compile path too (js codes against core's types). */
            /* Stylesheets in `srcs` are built like any other source, so the
             * package ships plain CSS rather than Sass — a css-module as its
             * scoped stylesheet plus the compiled class-map module. One meant to
             * be `@use`d BY other packages belongs in `resources`, which ships it
             * verbatim. */
            /* A dual target is built as TWO compiles, each pinned to a format — one
             * compile emits one module system. The ES-module format additionally
             * emits `.mjs`/`.d.mts`, so the two trees ship together at the package
             * root instead of occupying the same names. */
            const formatCompile = (format: "commonjs" | "esm"): Computable<ICompiledContents> =>
              compileContents(context, compileSources, compileDeps, {
                packageName: context.name,
                constraints: Constraints.of({ JS_TARGET: formatJSTarget({ ...jsTarget, module: format }) }),
                moduleExtension: format === "esm" ? ESM_JS_EXTENSION : undefined,
              });
            /* Single-format keeps the ambient target verbatim. */
            const contents = dual
              ? formatCompile("commonjs")
              : compileContents(context, compileSources, compileDeps, { packageName: context.name });
            const esmContents = dual ? formatCompile("esm") : undefined;

            /* Delivery shape: add the generated package.json (in memory — its
             * entry points depend on the compiled file list) and wrap with
             * identity + carried deps. This runs on every evaluation (whether the
             * compile sub-target hit or missed), reconstructing the runtime-only
             * identity each time. */
            const deliver = (
              { compiled, css, passthrough, depOutputs, rewrites }: ICompiledContents,
              esm?: ICompiledContents
            ): Computable<FileSource> => {
              /* A source dep is compiled against, not distributed, so what the
               * compiler emitted for one is dropped here — a package ships its
               * own artifacts. The test pipeline keeps them, needing the file to
               * run. */
              const own = compiled.minus(depOutputs);
              /* Two formats, one tree — see dualFormatOutputs. */
              const formats = esm ? dualFormatOutputs(own, esm.compiled.minus(esm.depOutputs)) : [own];
              /* `resources` ship exactly as given — never compiled, so a prebuilt
               * .js keeps its own level and a hand-written .d.ts is the only
               * declaration for it (no generated one to collide with). Taken from
               * the primary format alone: both compiles pass the same files through. */
              const delivered = FileSet.unionAll(...formats, stripPackageJson(passthrough), css, ...resourceSets);
              /* Guarantee every declared bin opens with an interpreter line so the
               * installed npm command is launchable — derived from the bin convention,
               * not a hand-written source shebang (see withBinShebangs). */
              return withBinShebangs(delivered).then(shebanged => {
                const packageJson = createPackageJson({
                  files: shebanged,
                  seed,
                  name: context.name,
                  version: version?.toString(),
                  declared,
                  provided: providedDeclared,
                  optionalProvided: optionalDeclared,
                  jsTarget,
                  metadata,
                  /* Named by their source names: the map is generated from the
                   * emitted counterparts, so an author declares entry points in
                   * the terms they wrote them in, never in fabr's emit layout. */
                  exports: [...exported].map(([sourceName]) => sourceName),
                  rewrites,
                });
                const assembled = FileSet.unionAll(shebanged, new FileSet(new Map([["package.json", packageJson]])));
                return packageOf(context, assembled, version?.toString(), edges);
              });
            };

            /* The compiled/lowered parts are sub-target output; a target with
             * nothing to build yields empty ones and the package is just its
             * passthrough files + package.json, assembled in memory. */
            return esmContents === undefined
              ? contents.then(primary => deliver(primary))
              : Computable.forAll([contents, esmContents], (primary, secondary) => deliver(primary, secondary));
          });
        }
      );
    }
  );
}
