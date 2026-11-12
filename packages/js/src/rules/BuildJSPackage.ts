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
  PackageFileSet,
  PackageSources,
  Provided,
  readJsonFile,
  ResolutionSpec,
  RuleResult,
  SourceRef,
  TargetContext,
  toJsonObject,
  describeTarget,
  descriptionFile,
  type MaterializedRequirements,
  type ResolvedRequirements,
} from "@fabr-build/core";
import {
  conventionalEmit,
  type ITypeScriptPayload,
  layOutUnits,
  MANIFEST_FILE,
  TSSERVER_PLUGIN,
  TYPESCRIPT_DATA_KIND,
} from "../Description";
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

/** The requirements of a package's build. */
type PackageRequirements = {
  srcs: Computable<SourceRef[]>;
  resources: Computable<SourceRef[]>;
  tests: Computable<SourceRef[]>;
  exports: Computable<SourceRef[]>;
  dependencies: Computable<PackageSources>;
  provided: Computable<PackageSources>;
  optional_provided: Computable<PackageSources>;
  compile_deps: Computable<PackageSources>;
  test_resources: Computable<SourceRef[]>;
  test_expectations: Computable<SourceRef[]>;
};

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
  requirements(context: TargetContext): Computable<ResolutionSpec<PackageRequirements>> {
    return context.getProperty("version").then(version => {
      assertPackageVersion(version?.toString());
      const written = version?.toString();
      const builds = { package: context.name, format: NPM_FORMAT, ...(written === undefined ? {} : { version: written }) };
      return {
        build: {
          srcs: context.getFileProperty("srcs"),
          resources: context.getFileProperty("resources"),
          tests: context.getFileProperty("tests"),
          exports: context.getFileProperty("exports"),
          dependencies: context.getPackageProperty("deps", undefined, NPM_FORMAT),
          provided: context.getPackageProperty("provided_deps", undefined, NPM_FORMAT),
          optional_provided: context.getPackageProperty("optional_provided_deps", undefined, NPM_FORMAT),
          /* Compiled against, and private to the build: not passed on. */
          compile_deps: context.getPackageProperty("compile_deps", undefined, NPM_FORMAT),
          test_resources: context.getFileProperty("test_resources"),
          test_expectations: context.getFileProperty("test_expectations"),
        },
        result: builds,
      };
    });
  },
  /* Describe the package as an editor is told of it: its build unit, and its manifest. */
  describe(context, requirements) {
    return Computable.forAll([requirements.describeAll(), context.getLooseFileProperty("test_deps")], (gathered, testDeps) =>
      describePackage(context, gathered, testDeps, requirements.resolved)
    );
  },
  evaluateResolved(context, requirements) {
    return Computable.forAll(
      [
        requirements.materializeAll(),
        requirements.packages("dependencies"),
        requirements.packages("provided"),
        requirements.packages("optional_provided"),
        /* The files `test_deps` names, subtracted from `srcs`: test support that
         * compiles with the tests and does not ship. Read here rather than among
         * the requirements, so the packages and targets it names are the tests'
         * alone, and a test-support package may depend on this one. */
        context.getLooseFileProperty("test_deps"),
      ],
      (gathered, dependencies, provided, optional_provided, testDeps) =>
        buildJsPackage(context, { ...gathered, test_deps: testDeps }, { dependencies, provided, optional_provided })
    );
  },
});

/**
 * Describe the package `context` evaluates (see Description): its BSP target,
 * the unit its build compiles — described by `js_compile` over the same inputs
 * — and the manifest its build writes, made from its declared entry points over
 * the compile's conventional emit, beside the files it ships as they are. A
 * dual package is described as its ES-module format.
 */
function describePackage(
  context: TargetContext,
  sets: MaterializedRequirements<PackageRequirements>,
  testDeps: FileSet[],
  resolved: ResolvedRequirements
): Computable<RuleResult> {
  const { exported, compileSources, compileDeps } = packageCompileInputs({
    srcs: sets.srcs,
    tests: sets.tests,
    exports: sets.exports,
    deps: [...sets.dependencies, ...sets.provided, ...sets.optional_provided, ...sets.compile_deps],
    testOnly: [...testDeps, ...sets.test_resources, ...sets.test_expectations],
  });
  return Computable.forAll(
    [context.getGlobalString("JS_TARGET"), context.getProperty("version"), context.getMap("metadata")],
    (target, version, metadata) => {
      const jsTarget = parseJSTarget(target);
      const constraints =
        jsTarget.module === "dual" ? Constraints.of({ JS_TARGET: formatJSTarget({ ...jsTarget, module: "esm" }) }) : undefined;
      return compileContents(context, compileSources, compileDeps, { packageName: context.name, constraints, describe: true }).then(
        contents => {
          const manifest = createPackageJson({
            files: conventionalEmit(compileSources, jsTarget),
            name: context.name,
            version: version?.toString(),
            declared: [],
            provided: [],
            optionalProvided: [],
            jsTarget,
            metadata,
            exports: [...exported].map(([sourceName]) => sourceName),
            rewrites: contents.rewrites,
          });
          const laidOut = layOutUnits(new Map([["build", contents.compiled]]));
          const payload: ITypeScriptPayload = { units: laidOut.units, manifest: MANIFEST_FILE, plugin: TSSERVER_PLUGIN };
          return describeTarget(context, resolved, {
            sources: [compileSources],
            tags: ["library"],
            languageIds: ["typescript", "javascript"],
            dataKind: TYPESCRIPT_DATA_KIND,
            data: payload,
          }).then(description =>
            FileSet.unionAll(
              descriptionFile(description),
              laidOut.files,
              FileSet.layout({ [MANIFEST_FILE]: manifest }),
              /* What the package ships as it is, at its own paths: what a step
               * reading the package's files (Sass, loading a partial) finds there. */
              stripPackageJson(contents.passthrough),
              ...sets.resources
            )
          );
        }
      );
    }
  );
}

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

/** What a package's compile is made from. */
export interface IPackageCompileInputs {
  /** The sources the target names as its entry points. */
  exported: FileSet;
  /** `srcs` with the entry points. */
  sources: FileSet;
  /** What the package's compile compiles: the sources, less everything test-only. */
  compileSources: FileSet;
  /** What the compile is compiled against. */
  compileDeps: FileSet[];
}

/**
 * Work out what a package's compile is made from: its sources with its entry
 * points, less its tests and everything else declared test-only, compiled
 * against its dependencies.
 */
export function packageCompileInputs(parts: {
  srcs: FileSet[];
  tests: FileSet[];
  exports: FileSet[];
  deps: FileSet[];
  testOnly: FileSet[];
}): IPackageCompileInputs {
  /* The declared entry points are compile inputs in their own right, so a
   * target may name one that `srcs` does not cover (js_bundle's `entry` has
   * the same relation to its `srcs`). Naming the same file twice is not a
   * conflict — a union is by file identity, not by arrival. */
  const exported = FileSet.unionAll(...parts.exports);
  const sources = FileSet.unionAll(...parts.srcs, exported);
  const tests = FileSet.unionAll(...parts.tests);
  /* `srcs` minus everything declared test-only. `tests` is the obvious
   * half; the other is the plain-SOURCE part of `test_deps` — test support
   * that compiles with the test types in scope but is neither run nor
   * shipped (an integration suite the entry file imports, a harness). A
   * file named there is not package content, exactly as one named in
   * `tests` is not. A Flag is excluded: it names nothing. */
  const testOnlySources = parts.testOnly.filter((source): source is FileSet => !(source instanceof Flag));
  const compileSources = sources.minus(tests).minus(FileSet.unionAll(...testOnlySources));
  const compileDeps = parts.deps.filter((dep): dep is FileSet => dep instanceof FileSet);
  return { exported, sources, compileSources, compileDeps };
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
          const { exported, sources, compileSources, compileDeps } = packageCompileInputs({
            srcs: srcSets,
            tests: testSets,
            exports: exportSets,
            deps: [...deps, ...provided, ...optionalProvided, ...compileOnly],
            testOnly: [...testDepSources, ...testResourceSources, ...expectationSources],
          });
          const dual = jsTarget.module === "dual";
          /* If there's a 'package.json' in the source list, we can initialize the output package.json from it */
          const seedJson = sources.get("package.json").then(file => file && readJsonFile(file, toJsonObject));
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
            }
          );
        }
      );
    }
  );
}
