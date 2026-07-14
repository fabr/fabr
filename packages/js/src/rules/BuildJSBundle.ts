/*
 * Copyright (c) 2026 Nathan Keynes <nkeynes@deadcoderemoval.net>
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
 * The js_bundle[build] rule: bundle a source tree into a self-contained
 * artifact with esbuild. srcs is what goes into the bundle (packages mount at
 * node_modules and are inlined; loose files land at the working root); deps is
 * runtime-provided and externalized by identity; entry names the source(s) to
 * bundle; output optionally renames each entry's result.
 *
 * srcs and deps resolve through ONE collection point (so they can't version-fork
 * across the bundle boundary). esbuild is a build *tool*, independent of what it
 * bundles, so it is resolved separately (its own pins don't co-resolve with the
 * sources' — the TSC precedent) and mounted apart under a tool dir; fabr's own
 * bundle driver runs there and requires esbuild from that mount. The bundle is a
 * terminal artifact, delivered as a plain FileSet.
 */

import { posix } from "node:path";
import {
  BUILD_OPERATION,
  Computable,
  createExecAction,
  FileSet,
  MemoryFile,
  PackageFileSet,
  RuleRegistration,
  RuleResult,
  TargetContext,
} from "@fabr/core";
import { assembleNodeModules, parseJSTarget } from "../JSPackage";
import {
  buildBundleOptions,
  BUNDLE_DRIVER_ENTRY,
  BUNDLE_OUTDIR,
  computeBundleEntries,
  computeExternalNames,
  getBundleDriver,
} from "../JSBundle";

/** Where the esbuild toolchain + driver mount — disjoint from the workspace's
 * own node_modules so the tool's deps neither collide with nor are visible to
 * the sources being bundled. */
const TOOL_DIR = ".fabr-esbuild";

function buildJsBundle(context: TargetContext): Computable<RuleResult> {
  return Computable.forAll(
    [
      context.getFileSources("srcs"),
      context.getFileSet("entry"),
      context.getFileSources("deps"),
      context.getGlobalString("JS_TARGET"),
      context.getGlobalString("BUILD_TYPE"),
      context.getGlobalSources("ESBUILD"),
      context.getRewrite("output"),
    ],
    (srcSources, entrySet, depSources, target, buildType, esbuildSources, rewrite) => {
      const jsTarget = parseJSTarget(target);
      /* THE collection point for the bundle's contents: srcs and deps resolve
       * jointly. esbuild is resolved separately below — a build tool is
       * independent of what it compiles, so its version doesn't co-resolve with
       * the sources' pins. */
      const contents = context.collect({ srcs: srcSources, deps: depSources });
      const tool = context.collect({ esbuild: esbuildSources });

      return Computable.forAll([contents, tool], ({ srcs, deps }, { esbuild }) => {
        /* srcs partition: packages mount at node_modules (inlined by esbuild);
         * loose files land at the working root, where entries live. Entry files
         * are sources by definition and share that root, so they simply union in
         * — an entry need not be separately listed in `srcs`, and a common
         * `entry ⊆ srcs` glob resolves to the same files (union dedups). A same
         * path resolving to *different* files across `entry` and `srcs` is a real
         * conflict and `unionAll` asserts it. */
        const srcPackages = srcs.filter((set): set is PackageFileSet => set instanceof PackageFileSet);
        const looseSrcs = srcs.filter(set => !(set instanceof PackageFileSet));
        const rootTree = FileSet.unionAll(...looseSrcs, entrySet);

        const entryNames = [...entrySet].map(([name]) => name);
        if (entryNames.length === 0) {
          throw new Error("js_bundle 'entry' resolved to no files — name at least one source to bundle");
        }
        const entries = computeBundleEntries(entryNames, rewrite);
        const external = computeExternalNames(srcs, deps);
        const options = buildBundleOptions(jsTarget, buildType, entries, external);

        const staged = FileSet.unionAll(
          rootTree,
          FileSet.layout({
            node_modules: assembleNodeModules(srcPackages),
            [TOOL_DIR]: FileSet.unionAll(getBundleDriver(), FileSet.layout({ node_modules: assembleNodeModules(esbuild) })),
            "bundle-options.json": MemoryFile.from(JSON.stringify(options)),
          })
        );
        /* Bare "node": the exec step resolves it against the fabr process's PATH
         * at run time, keeping the manifest free of a host-specific absolute path. */
        const argv = ["node", posix.join(TOOL_DIR, BUNDLE_DRIVER_ENTRY), "--options=bundle-options.json"];
        return createExecAction(staged, argv, `${BUNDLE_OUTDIR}:**`, "bundle");
      });
    }
  );
}

export const buildJsBundleRule: RuleRegistration = {
  type: "js_bundle",
  constraints: { [BUILD_OPERATION]: "build" },
  evaluate: buildJsBundle,
};
