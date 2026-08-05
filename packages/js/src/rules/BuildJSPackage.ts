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
  EMPTY_FILESET,
  FileSet,
  FileSource,
  PackageFileSet,
  readJsonFile,
  RepositoryRef,
  RuleRegistration,
  RuleResult,
  TargetContext,
  toJsonObject,
} from "@fabr-build/core";
import { compileJsSources, parseJSTarget, stripPackageJson, withBinShebangs } from "../JSPackage";
import { createPackageJson } from "../PackageJson";

function buildJsPackage(context: TargetContext): Computable<RuleResult> {
  return Computable.forAll(
    [
      context.getGlobalString("JS_TARGET"),
      context.getProperty("version"),
      context.getFileProperty("deps"),
      context.getFileProperty("provided_deps"),
      context.getMap("metadata"),
    ],
    (target, version, depSources, providedSources, metadata) => {
      const jsTarget = parseJSTarget(target);

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
      const gathered = context.collect({
        srcs: context.getFileProperty("srcs"),
        tests: context.getFileProperty("tests"),
        deps: depSources,
        provided: providedSources,
      });

      /* Declared (not resolved) requirements for the generated manifest: each dep
       * source reports the version it was *declared* with — an inline `@npm:pkg:1.2.3`
       * off its own ref, a catalog dep from the catalog's pin — not the version the
       * joint resolution selected. Provided deps declare `peerDependencies`. */
      const declaredDeps = context.collectDeclaredRequirements(depSources);
      const declaredProvided = context.collectDeclaredRequirements(providedSources);

      return gathered.then(({ srcs: srcSets, tests: testSets, deps, provided }) => {
        const sources = FileSet.unionAll(...srcSets);
        const tests = FileSet.unionAll(...testSets);
        /* If there's a 'package.json' in the source list, we can initialize the output package.json from it */
        const seedJson = sources.get("package.json").then(file => file && readJsonFile(file, toJsonObject));
        const compileSources = sources.minus(tests);

        return Computable.forAll([seedJson, declaredDeps, declaredProvided], (seed, declared, providedDeclared) => {
          /* Compile against the deps laid out scoped: the sources see only these
           * direct deps, while the transitive closure is reachable only by the
           * deps themselves (assembleScopedNodeModules). Provided deps are on the
           * compile path too (js codes against core's types), just not delivered. */
          const { compiled, copied } = compileJsSources(context, compileSources, [...deps, ...provided], context.name);

          /* The package's DIRECT deps as written (built packages as packages,
           * external requirements as inert references, resolved fresh at each
           * consuming collection point) — carried on the delivered package.
           * `provided_deps` are carried too: a carried dep is a reference the
           * consumer re-resolves and flat-mounts (never bundled into this package),
           * and flatten + per-name uniqueness already collapses it to the single
           * shared instance the peer contract wants. Provided differs from a plain
           * dep only in the manifest (peerDependencies, below) and in strict-
           * singleton resolution enforcement (deferred). */
          const carried = [...depSources, ...providedSources].filter(
            (source): source is PackageFileSet | RepositoryRef =>
              source instanceof PackageFileSet || source instanceof RepositoryRef
          );

          /* Delivery shape: add the generated package.json (in memory — its
           * entry points depend on the compiled file list) and wrap with
           * identity + carried deps. This runs in resolution on every evaluation
           * (whether the compile sub-target hit or missed), reconstructing the
           * runtime-only identity each time. */
          const deliver = (built: FileSet): Computable<FileSource> => {
            const contents = FileSet.unionAll(built, stripPackageJson(copied));
            /* Guarantee every declared bin opens with an interpreter line so the
             * installed npm command is launchable — derived from the bin convention,
             * not a hand-written source shebang (see withBinShebangs). */
            return withBinShebangs(contents).then(shebanged => {
              const packageJson = createPackageJson(
                shebanged,
                seed,
                context.name,
                version?.toString(),
                declared,
                providedDeclared,
                jsTarget,
                metadata
              );
              const assembled = FileSet.unionAll(shebanged, new FileSet(new Map([["package.json", packageJson]])));
              return new PackageFileSet(assembled, context.name, version?.toString(), carried);
            });
          };

          /* With TS sources the compile is a sub-target (its output wrapped
           * here); without, there is nothing to build — the package is the
           * copied files + package.json, assembled in memory. */
          return compiled ? compiled.then(deliver) : deliver(EMPTY_FILESET);
        });
      });
    }
  );
}

export const buildJsPackageRule: RuleRegistration = {
  type: "js_package",
  constraints: { [BUILD_OPERATION]: "build" },
  evaluate: buildJsPackage,
};
