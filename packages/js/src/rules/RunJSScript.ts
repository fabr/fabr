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
 * The js_script[run] rule: make a runnable Node.js program from `entry`,
 * `deps`, `args` and `env`. `entry` is either:
 *
 * - a script file, installed at its own name and launched under the `NODE`
 *   global. A TypeScript entry is first compiled through js_compile, with the
 *   source files in `deps` and against the packages there, and its emitted
 *   `.js` launched; or
 * - a package, built or from a registry, launched by its sole declared bin or
 *   the one a projection names (`entry = @npm:typescript:5.6.3:tsc`), with
 *   `deps` added to its install.
 *
 * `entry` and `deps` resolve as one collection, so the install holds one
 * `node_modules`. Packages in `deps` are installed under `node_modules`, loose
 * files at their own paths. `args` come before any arguments given at launch,
 * and `env` is set in the program's environment. The result is a
 * `RunnableFileSet` (the install and how to launch it) for `fabr run`, a
 * `generate` command or a `serve` tool; the rule runs nothing itself.
 */

import {
  BUILD_OVERRIDE,
  Computable,
  Constraints,
  FabrError,
  FileSet,
  FileSetRef,
  PackageFileSet,
  RuleResult,
  RunnableFileSet,
  TargetContext,
  defineRule,
  ContainedSources,
  PackageSources,
  NoRequirements,
  ResolutionSpec,
  toEnvironment,
} from "@fabr-build/core";
import { assembleNodeModules } from "../NodeModules";
import {
  classifySourceByExt,
  compileContents,
  formatJSTarget,
  makeNpmRunnable,
  moduleTypeFile,
  NODE_GLOBAL,
  parseJSTarget,
  resourceFiles,
  soleModuleFormat,
  stripPackageJson,
} from "../JSPackage";
import { NPM_FORMAT } from "../NPMProtocol";

/** The `js_script` rule, under `run`. */
export default defineRule({
  /**
   * State `deps` and `entry`, read under `build`, as one permissive
   * collection: a requirement the package's one selection does not satisfy is
   * installed as a fork, an instance of its own, instead of failing the
   * target. `entry` is read contained, so a projection over a package arrives
   * as a pending FileSetRef, which makeNpmRunnable reads as the selection of
   * the runnable's entry, as `fabr run pkg:cmd` does.
   */
  requirements(
    context: TargetContext
  ): ResolutionSpec<NoRequirements, { deps: Computable<PackageSources>; entry: Computable<ContainedSources> }> {
    return {
      run: {
        deps: context.getPackageProperty("deps", BUILD_OVERRIDE, NPM_FORMAT),
        entry: context.getContainedFileProperty("entry", BUILD_OVERRIDE),
      },
      permissive: true,
    };
  },
  evaluateMaterialized(context, inputs) {
    return Computable.forAll(
      [defineJsRunnable(context, inputs), context.getMap("env").then(toEnvironment)] as const,
      (runnable: RuleResult, env: ReadonlyMap<string, string>): RuleResult =>
        runnable instanceof RunnableFileSet ? runnable.withEnvironment(env) : runnable
    );
  },
});

/** @return the name tsc emits for a TypeScript entry: `.mts`→`.mjs`,
 * `.cts`→`.cjs`, `.ts`/`.tsx`→`.js`. */
export function compiledEntryName(entryName: string): string {
  return entryName.replace(/\.(?:([cm])?ts|tsx)$/i, (_match, flavour: string | undefined) => `.${(flavour ?? "").toLowerCase()}js`);
}

function defineJsRunnable(
  context: TargetContext,
  { deps, entry }: { deps: FileSet[]; entry: (FileSet | FileSetRef)[] }
): Computable<RuleResult> {
  return Computable.forAll(
    [context.getProperty("args"), context.getGlobalString("JS_TARGET")],
    (args, target): RuleResult | Computable<RuleResult> => {
      const argv = args ? args.getValues() : [];
      const sole = entry.length === 1 ? entry[0] : undefined;
      /* A package entry is the program, launched by its declared bin (or the
       * one a pending projection names), with `deps` added to its install. */
      if (sole instanceof PackageFileSet || (sole instanceof FileSetRef && sole.source instanceof PackageFileSet)) {
        return makeNpmRunnable(context, sole, deps, argv);
      }
      /* A file entry is the script. A JavaScript entry is installed as it is
       * and launched under node; a TypeScript entry is compiled first. */
      return context.applyProjections(entry).then(entrySets => {
        if (entrySets.some(set => set instanceof PackageFileSet)) {
          throw new FabrError("js_script 'entry' must be a single file or a single package — further packages belong in 'deps'");
        }
        const entrySet = FileSet.unionAll(...entrySets);
        const names = [...entrySet].map(([name]) => name);
        if (names.length !== 1) {
          throw new FabrError(
            names.length === 0
              ? "js_script 'entry' resolved to no file — name the script file (or a package) itself"
              : `js_script 'entry' resolved to ${names.length} files (${names.slice(0, 5).join(", ")}) — name exactly one`
          );
        }
        const entryName = names[0];
        const packages = deps.filter((d): d is PackageFileSet => d instanceof PackageFileSet);

        /* A TypeScript entry: compile it and the source files in `deps`
         * against the packages in `deps`, then launch its compiled `.js`. A
         * root package.json states the module `type` JS_TARGET emits (ESM by
         * default), so node loads the output in that mode. */
        if (classifySourceByExt(entryName) === "ts") {
          const jsTarget = parseJSTarget(target);
          const launchName = compiledEntryName(entryName);
          /* Loose files in `deps` the compile does not emit (.json, templates,
           * assets) are added to the install at the root, beside the compiled
           * entry, so a `./x.json` import resolves. Leave compilable files out:
           * their output is already in the compile's, and a raw .js would
           * collide with it by name. */
          const resources = resourceFiles(deps.filter(d => !(d instanceof PackageFileSet)));
          /* The install has one module `type`, so a `dual` JS_TARGET is
           * reduced to one format, for the compile as well as the manifest. For
           * a single-format target this names the same target, so the compile
           * is shared with any other of that target. */
          const format = soleModuleFormat(jsTarget.module);
          const faceTarget = Constraints.of({ JS_TARGET: formatJSTarget({ ...jsTarget, module: format }) });
          return compileContents(context, entrySet, deps, { constraints: faceTarget }).then(built => {
            const install = FileSet.unionAll(
              FileSet.layout({ node_modules: assembleNodeModules(packages) }),
              stripPackageJson(built.passthrough),
              built.compiled,
              resources,
              new FileSet(new Map([["package.json", moduleTypeFile(format)]]))
            );
            return context.launchedBy(RunnableFileSet.forEntry(install, launchName, argv), NODE_GLOBAL);
          });
        }

        /* A JavaScript entry is installed as it is, with packages under
         * node_modules and loose files at their own paths. */
        const loose = deps.filter(d => !(d instanceof PackageFileSet));
        const install = FileSet.unionAll(FileSet.layout({ node_modules: assembleNodeModules(packages) }), ...loose, entrySet);
        return context.launchedBy(RunnableFileSet.forEntry(install, entryName, argv), NODE_GLOBAL);
      });
    }
  );
}
