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
  BUILD_OPERATION,
  Computable,
  Constraints,
  FabrError,
  FileSet,
  FileSetRef,
  FileSource,
  PackageFileSet,
  Provided,
  readJsonFile,
  RepositoryRef,
  RuleDefinition,
  RuleResult,
  TargetContext,
  toJsonObject,
  Flag,
  dependencyName,
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

/**
 * Read one collected `exports` source as the plain file set it must be. The
 * property names this package's own entry points, so a dependency or a flag
 * there can only have been meant for `deps` — and unioning a package's files in
 * as sources would compile them as if they were ours, which is worth an error
 * rather than a silent miscompile.
 */
function asExportSource(source: FileSet | FileSetRef): FileSet {
  const base = source instanceof FileSetRef ? source.source : source;
  if (base instanceof PackageFileSet) {
    throw new FabrError(`exports names this package's own source files: '${base.packageName}' is a dependency`);
  }
  if (base instanceof Flag) {
    throw new FabrError(`exports names this package's own source files: '${base.name}' is a flag`);
  }
  return source instanceof FileSetRef ? source.select() : source;
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

function buildJsPackage(context: TargetContext): Computable<RuleResult> {
  return Computable.forAll(
    [
      context.getGlobalString("JS_TARGET"),
      context.getProperty("version"),
      context.getMap("metadata"),
    ],
    (target, version, metadata) => {
      const jsTarget = parseJSTarget(target);
      assertPackageVersion(version?.toString());

      /* THE collection point, singular per evaluation: srcs, tests, deps AND
       * provided_deps materialize through one joint resolution (a package needing
       * Node APIs lists `@types/node` among them), so this target's pins
       * participate across the lot. `provided_deps` are host-provided,
       * singleton-by-identity peers (the plugin↔core relationship): they
       * take part in resolution, the
       * compile, AND the carried closure exactly like `deps` (flatten +
       * per-name uniqueness already yields the one shared instance the peer
       * wants). They differ only in the generated manifest — `peerDependencies`,
       * not `dependencies` — and in strict-singleton resolution enforcement
       * (deferred). TSC is the compiler's own concern (resolved in js_compile),
       * independent of what it compiles. */
      /* Read but NOT collected: see the subtraction below — this must not draw
       * the test dependencies into the build's resolution. */
      const testDeps = context.getFileProperty("test_deps");
      const testResources = context.getFileProperty("test_resources");
      const expectations = context.getFileProperty("test_expectations");
      const gathered = context.collect({
        srcs: context.getFileProperty("srcs"),
        resources: context.getFileProperty("resources"),
        tests: context.getFileProperty("tests"),
        exports: context.getFileProperty("exports"),
        deps: context.getDependencyProperty("deps"),
        provided: context.getDependencyProperty("provided_deps"),
      });

      return Computable.forAll(
        [gathered, testDeps, testResources, expectations],
        (
          { srcs: srcSets, resources: resourceSets, tests: testSets, exports: exportSets, deps, provided },
          testDepSources,
          testResourceSources,
          expectationSources
        ) => {
        /* The declared entry points are compile inputs in their own right, so a
         * target may name one that `srcs` does not cover (js_bundle's `entry` has
         * the same relation to its `srcs`). Naming the same file twice is not a
         * conflict — a union is by file identity, not by arrival. */
        const exported = FileSet.unionAll(...exportSets.map(asExportSource));
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
         * Read WITHOUT materializing: a plain source is already a FileSet, while
         * an external package is still an inert RepositoryRef — so nothing here
         * resolves or fetches, and an ordinary `fabr build` still never touches
         * the test dependencies. PackageFileSet and Flag are excluded for the
         * same reason compileSrcsOf excludes them: a built dep's file names
         * could shadow real sources by coincidence, and a flag names nothing. */
        const testOnlySources = [...testDepSources, ...testResourceSources, ...expectationSources].filter(
          (source): source is FileSet => source instanceof FileSet && !(source instanceof PackageFileSet) && !(source instanceof Flag)
        );
        const compileSources = sources.minus(tests).minus(FileSet.unionAll(...testOnlySources));

        /* What the package requires, carried on it: the packages its `deps`
         * were delivered as — each still naming the reference it was delivered
         * for, so every consuming collection point resolves it again — and the
         * references that deliver no package. `provided_deps` are carried with
         * them, named as its provided requirements: the consumer's collection
         * point binds each to what the consumer uses under that name. */
        const carriedOf = (collected: ReadonlyArray<FileSet | RepositoryRef>): Array<PackageFileSet | RepositoryRef> =>
          collected.filter((dep): dep is PackageFileSet | RepositoryRef => dep instanceof PackageFileSet || dep instanceof RepositoryRef);
        const providedCarried = carriedOf(provided);
        const carried = [...carriedOf(deps), ...providedCarried];
        const providedNames = new Map(providedCarried.map((dep): [string, Provided] => [dependencyName(dep), "expected"]));
        const compileDeps = [...deps, ...provided].filter((dep): dep is FileSet => dep instanceof FileSet);
        /* Declared (not resolved) requirements for the generated manifest: each
         * reports what was *written* — an inline `@npm:pkg:1.2.3` off the
         * reference it was delivered for, a catalog dep from the catalog's pin —
         * not the version the joint resolution selected. Provided deps declare
         * `peerDependencies`. */
        const declaredDeps = context.collectDeclaredRequirements(carriedOf(deps));
        const declaredProvided = context.collectDeclaredRequirements(providedCarried);

        return Computable.forAll([seedJson, declaredDeps, declaredProvided], (seed, declared, providedDeclared) => {
          /* Compile against the direct deps: the sources see only these, while
           * the transitive closure is reachable only by the deps themselves —
           * the dependency manifest's doing, not a layout's. Provided deps are
           * on the compile path too (js codes against core's types), just not
           * delivered. */
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
          /* Single-format keeps the ambient target verbatim rather than respelling
           * it, so nothing about an ordinary build moves. */
          const contents = dual
            ? formatCompile("commonjs")
            : compileContents(context, compileSources, compileDeps, { packageName: context.name });
          const esmContents = dual ? formatCompile("esm") : undefined;

          /* Delivery shape: add the generated package.json (in memory — its
           * entry points depend on the compiled file list) and wrap with
           * identity + carried deps. This runs in resolution on every evaluation
           * (whether the compile sub-target hit or missed), reconstructing the
           * runtime-only identity each time. */
          const deliver = ({ compiled, css, passthrough, depOutputs, rewrites }: ICompiledContents, esm?: ICompiledContents): Computable<FileSource> => {
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
                jsTarget,
                metadata,
                /* Named by their source names: the map is generated from the
                 * emitted counterparts, so an author declares entry points in
                 * the terms they wrote them in, never in fabr's emit layout. */
                exports: [...exported].map(([sourceName]) => sourceName),
                rewrites,
              });
              const assembled = FileSet.unionAll(shebanged, new FileSet(new Map([["package.json", packageJson]])));
              return new PackageFileSet(assembled, context.name, version?.toString(), carried, undefined, providedNames);
            });
          };

          /* The compiled/lowered parts are sub-target output; a target with
           * nothing to build yields empty ones and the package is just its
           * passthrough files + package.json, assembled in memory. */
          return esmContents === undefined
            ? contents.then(primary => deliver(primary))
            : Computable.forAll([contents, esmContents], (primary, secondary) => deliver(primary, secondary));
        });
      });
    }
  );
}

export const buildJsPackageRule: RuleDefinition = {
  type: "js_package",
  properties: { [BUILD_OPERATION]: "build" },
  evaluate: buildJsPackage,
};
