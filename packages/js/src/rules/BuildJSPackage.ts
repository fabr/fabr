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
 * The js_package[build] rule: build an npm package named as the target, at
 * its `version`. The sources in `srcs` and the entry points in `exports` are
 * compiled through js_compile against `deps`, `provided_deps`,
 * `optional_provided_deps` and `compile_deps`, leaving out `tests` and the
 * loose files in `test_deps`, `test_resources` and `test_expectations`; their
 * stylesheets are compiled to CSS. `resources` are shipped as they are. Where
 * `JS_TARGET` names `dual`, a CommonJS and an ES-module compile (`.mjs`) are
 * shipped together.
 *
 * The generated `package.json` starts from a `package.json` among the sources,
 * and adds `metadata`, the entry points, a bin for each executable directly
 * under `bin/`, and the requirements as written: `deps` as `dependencies`,
 * `provided_deps` as `peerDependencies` and `optional_provided_deps` as
 * optional peers. The result is a PackageFileSet requiring those packages, the
 * provided ones named as provided.
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
  compileSourcesOf,
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
   * State the package's requirements as one collection, so this target's pins
   * apply to them all. `dependencies` (`deps`), `provided` (`provided_deps`)
   * and `optional_provided` are what the package passes on; each consumer binds
   * a provided one to what it uses under that name. `compile_deps` are compiled
   * against and not passed on. Throws where `version` is not a valid npm
   * version. The compiler is resolved by js_compile, apart from these.
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
          /* Compiled against, and not passed on. */
          compile_deps: context.getPackageProperty("compile_deps", undefined, NPM_FORMAT),
          test_resources: context.getFileProperty("test_resources"),
          test_expectations: context.getFileProperty("test_expectations"),
        },
        result: builds,
      };
    });
  },
  /* Describe the package for an editor: its build unit, and its manifest. */
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
        /* The loose files `test_deps` names, left out of the compile: test
         * support compiled with the tests and not shipped. Read it here, not
         * among the requirements: there the packages and targets it names would
         * resolve with this build, and a test-support package depending on this
         * one would be a cycle. */
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

/** Check that a stated `version` is one npm can read, or throw a FabrError. It
 * is written into the manifest, and whatever resolves against the package
 * compares by it. A package need state no version. */
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
  /* The entry points are compile inputs of their own, so one need not be in
   * `srcs` (as js_bundle's `entry` need not be in its `srcs`). A file named in
   * both is one file, not a conflict. */
  const exported = FileSet.unionAll(...parts.exports);
  const sources = FileSet.unionAll(...parts.srcs, exported);
  const tests = FileSet.unionAll(...parts.tests);
  /* `srcs` less everything test-only: `tests`, and the source files among
   * the test-only lists (`test_deps`' test support, such as a harness,
   * compiled with the tests but neither run nor shipped). A Flag names no
   * files and is skipped. */
  const testOnlySources = parts.testOnly.filter((source): source is FileSet => !(source instanceof Flag));
  const compileSources = compileSourcesOf(sources.minus(tests).minus(FileSet.unionAll(...testOnlySources)));
  const compileDeps = parts.deps.filter((dep): dep is FileSet => dep instanceof FileSet);
  return { exported, sources, compileSources, compileDeps };
}

/** Build the package from its materialized requirements, `edges` being the
 * edges to the packages it passes on. */
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
          /* A `package.json` among the sources seeds the generated one. */
          const seedJson = sources.get("package.json").then(file => file && readJsonFile(file, toJsonObject));
          /* The requirements as written, for the generated manifest: the
           * version an `@npm:pkg:1.2.3` reference states, or a catalog's pin,
           * not the version the resolution selected. Provided deps go to
           * `peerDependencies`, the optional ones marked so. */
          const declaredDeps = context.collectDeclaredRequirements(edges.dependencies);
          const declaredProvided = context.collectDeclaredRequirements(edges.provided);
          const declaredOptional = context.collectDeclaredRequirements(edges.optional_provided);

          return Computable.forAll(
            [seedJson, declaredDeps, declaredProvided, declaredOptional],
            (seed, declared, providedDeclared, optionalDeclared) => {
              /* Compile against the direct deps, provided ones included: the
               * sources see only these, and what they require is reachable only
               * from them. */
              /* Stylesheets in `srcs` are compiled like any other source, so the
               * package ships CSS: a css-module as its scoped stylesheet and its
               * class-name module. A stylesheet other packages `@use` belongs in
               * `resources`, which ships as it is. */
              /* A dual target is two compiles, one per module format. The
               * ES-module compile emits `.mjs`/`.d.mts`, so the two trees ship
               * together at the package root. */
              const formatCompile = (format: "commonjs" | "esm"): Computable<ICompiledContents> =>
                compileContents(context, compileSources, compileDeps, {
                  packageName: context.name,
                  constraints: Constraints.of({ JS_TARGET: formatJSTarget({ ...jsTarget, module: format }) }),
                  moduleExtension: format === "esm" ? ESM_JS_EXTENSION : undefined,
                });
              /* A single-format compile uses JS_TARGET as it is. */
              const contents = dual
                ? formatCompile("commonjs")
                : compileContents(context, compileSources, compileDeps, { packageName: context.name });
              const esmContents = dual ? formatCompile("esm") : undefined;

              /* Add the generated package.json (in memory: its entry points
               * depend on the compiled files) and make the package, with its name
               * and requirements. This runs on every evaluation, whether the
               * compile was a cache hit or not. */
              const deliver = (
                { compiled, css, passthrough, depOutputs, rewrites }: ICompiledContents,
                esm?: ICompiledContents
              ): Computable<FileSource> => {
                /* Drop what the compiler emitted for a source file in `deps`: it is
                 * compiled against, not shipped. The test pipeline keeps it, to
                 * run it. */
                const own = compiled.minus(depOutputs);
                /* Two formats, one tree — see dualFormatOutputs. */
                const formats = esm ? dualFormatOutputs(own, esm.compiled.minus(esm.depOutputs)) : [own];
                /* `resources` ship as given, never compiled: a prebuilt .js keeps
                 * its own level, and a hand-written .d.ts is its only declaration.
                 * For a dual target the passthrough files are taken from the
                 * CommonJS compile alone: both pass the same files through. */
                const delivered = FileSet.unionAll(...formats, stripPackageJson(passthrough), css, ...resourceSets);
                /* Give every bin an interpreter line, so the installed npm command
                 * can be launched (see withBinShebangs). */
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
                    /* Named by their source names; the manifest maps each to the
                     * files emitted for it. */
                    exports: [...exported].map(([sourceName]) => sourceName),
                    rewrites,
                  });
                  const assembled = FileSet.unionAll(shebanged, new FileSet(new Map([["package.json", packageJson]])));
                  return packageOf(context, assembled, version?.toString(), edges);
                });
              };

              /* A target with nothing to compile gets empty compile outputs, and
               * the package is its passthrough files and package.json. */
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
