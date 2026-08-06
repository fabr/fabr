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
 * The js_script[run] rule: *define* a runnable JavaScript program. `entry` is
 * either a script FILE — launched under node at its resolved name; a TypeScript
 * entry is first compiled (with any source `deps`) through the shared js_compile
 * path and its emitted `.js` launched — or a PACKAGE (external or built) whose
 * declared bin is the entry; package-mode exists to decorate a packaged tool with
 * additional dependencies, so entry co-resolves with `deps` at the one
 * collection point (one joint version selection, one node_modules). `deps`
 * assemble the rest of the install (packages mount under `node_modules/<name>`,
 * loose filesets land at their own paths); `args` are fixed leading arguments.
 * It yields a `RunnableFileSet` — the assembled install plus how to launch it —
 * for `fabr run`, the generic `run` target, or a golden test to invoke. It does
 * not itself execute (executing a runnable and collecting output is the generic
 * `run` target's job).
 */

import {
  BUILD_OPERATION,
  BUILD_OVERRIDE,
  Computable,
  FileSet,
  FileSetRef,
  PackageFileSet,
  RuleRegistration,
  RuleResult,
  RunnableFileSet,
  TargetContext,
} from "@fabr-build/core";
import {
  assembleNodeModules,
  compileContents,
  makeNpmRunnable,
  moduleTypeFile,
  parseJSTarget,
  resourceFiles,
  stripPackageJson,
} from "../JSPackage";

function defineJsRunnable(context: TargetContext): Computable<RuleResult> {
  /* deps/entry are built content — resolve them under build, not the run
   * operation this rule is selected by (constraints otherwise propagate). */
  return Computable.forAll(
    [
      context.getFileProperty("deps", BUILD_OVERRIDE),
      context.getContainedFileProperty("entry", BUILD_OVERRIDE),
      context.getProperty("args"),
      context.getGlobalString("JS_TARGET"),
    ],
    (depSources, entrySources, args, target) =>
      /* THE collection point: deps AND entry materialize jointly, so an entry
       * package resolves with the deps' own pins (one environment). The
       * install is a sealed program (executed, never linked against), so
       * resolution repairs are accepted and the assembly nests npm-style.
       * `entry` is read CONTAINED, so a projected package arrives as a pending
       * FileSetRef that makeNpmRunnable consumes directly — the projection
       * selects the RUNNABLE's entry, the written form's `fabr run` meaning. */
      context
        .collect({ deps: depSources, entry: entrySources }, { resolutionMode: "permissive" })
        .then(({ deps, entry }) => {
          const argv = args ? args.getValues() : [];
          const sole = entry.length === 1 ? entry[0] : undefined;
          /* Package-mode: the (jointly-resolved) package IS the runnable —
           * its declared bin (or the pending projection's pick) the entry —
           * with the deps bundled into its install. */
          if (sole instanceof PackageFileSet || (sole instanceof FileSetRef && sole.source instanceof PackageFileSet)) {
            return makeNpmRunnable(sole, deps, argv);
          }
          /* File-mode: the entry IS the script file. A plain-JS entry is
           * contributed to the install verbatim and launched under node; a
           * TypeScript entry is compiled first (see below). */
          return context.manifestAll(entry).then(entrySets => {
            if (entrySets.some(set => set instanceof PackageFileSet)) {
              throw new Error("js_script 'entry' must be a single file or a single package — further packages belong in 'deps'");
            }
            const entrySet = FileSet.unionAll(...entrySets);
            const names = [...entrySet].map(([name]) => name);
            if (names.length !== 1) {
              throw new Error(
                names.length === 0
                  ? "js_script 'entry' resolved to no file — name the script file (or a package) itself"
                  : `js_script 'entry' resolved to ${names.length} files (${names.slice(0, 5).join(", ")}) — name exactly one`
              );
            }
            const entryName = names[0];
            const packages = deps.filter((d): d is PackageFileSet => d instanceof PackageFileSet);

            /* TypeScript entry: compile the entry + any source deps through the
             * shared js_compile path (the package deps become the compile's
             * node_modules), then launch the entry's compiled `.js`. A root
             * package.json carries the module `type` matching JS_TARGET so node
             * runs the emitted code (ESM by default) in the right mode. */
            if (/\.tsx?$/i.test(entryName)) {
              const jsTarget = parseJSTarget(target);
              const launchName = entryName.replace(/\.tsx?$/i, ".js");
              /* Loose-dep runtime resources (.json, templates, assets): tsc
               * neither compiles nor emits them, so they never ride compiledTree
               * and must be carried into the install explicitly — rooted at the
               * package root, next to the compiled entry, so a `./x.json` import
               * resolves. Compilable loose deps are excluded (their output is
               * already in compiledTree — and a raw .js would collide by name). */
              const resources = resourceFiles(deps.filter(d => !(d instanceof PackageFileSet)));
              return compileContents(context, entrySet, deps).then(built => {
                const install = FileSet.unionAll(
                  FileSet.layout({ node_modules: assembleNodeModules(packages) }),
                  stripPackageJson(built.passthrough),
                  built.compiled,
                  resources,
                  new FileSet(new Map([["package.json", moduleTypeFile(jsTarget.module)]]))
                );
                return RunnableFileSet.forEntry(install, launchName, argv, "node");
              });
            }

            /* Plain-JS entry: contributed verbatim, deps placed as-is (packages
             * under node_modules, loose files at their own paths). */
            const loose = deps.filter(d => !(d instanceof PackageFileSet));
            const install = FileSet.unionAll(FileSet.layout({ node_modules: assembleNodeModules(packages) }), ...loose, entrySet);
            return RunnableFileSet.forEntry(install, entryName, argv, "node");
          });
        })
  );
}

export const jsScriptRule: RuleRegistration = {
  type: "js_script",
  constraints: { [BUILD_OPERATION]: "run" },
  evaluate: defineJsRunnable,
};
