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
 * across the bundle boundary). The bundler is a build *tool*, independent of what
 * it bundles, so it is resolved apart as the JS_BUNDLER runnable (fabr's own
 * esbuild driver, declared in JS.fabr — the TSC precedent) and mounted under a
 * tool dir, its deps neither colliding with nor visible to the sources. The
 * bundle is a terminal artifact, delivered as a plain FileSet.
 */

import {
  BUILD_OPERATION,
  Computable,
  createExecAction,
  FileSet,
  MemoryFile,
  PackageFileSet,
  RewriteFn,
  RuleRegistration,
  RuleResult,
  RunnableFileSet,
  TargetContext,
} from "@fabr-build/core";
import { assembleNodeModules, compileContents, JSTarget, parseJSTarget } from "../JSPackage";
import { buildBundleOptions, BUNDLE_OUTDIR, computeBundleEntries, computeExternalNames } from "../JSBundle";

/** Where the esbuild toolchain + driver mount — disjoint from the workspace's
 * own node_modules so the tool's deps neither collide with nor are visible to
 * the sources being bundled. */
const TOOL_DIR = ".fabr-esbuild";

/** The resolved inputs a bundle is staged from: the target config plus the
 * collected contents (srcs/deps) and the bundler runnable. */
interface IBundleInputs {
  jsTarget: JSTarget;
  buildType: string;
  rewrite: RewriteFn;
  /** Compile-time constant substitutions (the `defines` MAP): each value is
   * esbuild `define` code text, verbatim as written (a string constant is
   * shell-quoted in source, `'"production"'`, exactly as esbuild's own CLI). */
  defines: Record<string, string>;
  entrySet: FileSet;
  srcs: FileSet[];
  deps: FileSet[];
  bundler: RunnableFileSet;
}

/** Stage the working dir and yield the bundle action. `code` and `css` are the
 * built sources — esbuild reaches both through the JS import graph, so it keeps
 * ownership of CSS concat/order/split and of css-modules scoping. */
function stageBundle(
  inputs: IBundleInputs,
  srcPackages: PackageFileSet[],
  code: FileSet,
  css: FileSet
): RuleResult {
  const { jsTarget, buildType, rewrite, defines, entrySet, srcs, deps, bundler } = inputs;
  const entryNames = [...entrySet].map(([name]) => name);
  if (entryNames.length === 0) {
    throw new Error("js_bundle 'entry' resolved to no files — name at least one source to bundle");
  }
  const entries = computeBundleEntries(entryNames, rewrite);
  const external = computeExternalNames(srcs, deps);
  const options = buildBundleOptions(jsTarget, buildType, entries, external, defines);

  const staged = FileSet.unionAll(
    code,
    css,
    FileSet.layout({
      node_modules: assembleNodeModules(srcPackages),
      [TOOL_DIR]: bundler,
      "bundle-options.json": MemoryFile.from(JSON.stringify(options)),
    })
  );
  /* The bundler launches from its own mount (its deps resolve there); cwd is
   * the working root, so the options manifest and outdir resolve against it. */
  const argv = bundler.toCommandLine(["--options=bundle-options.json"], { base: TOOL_DIR });
  return createExecAction(staged, argv, `${BUNDLE_OUTDIR}:**`, "bundle");
}

/** Build the loose sources and stage the bundle. Packages among `srcs` are
 * already built: they mount at node_modules and esbuild inlines them. The loose
 * files are compiled first (`compileContents`) and esbuild links the output, so
 * a bundled source is type-checked and gets the target's source-mode flags and
 * JSX runtime like any other. `transpileJs` is off: esbuild downlevels plain
 * JavaScript itself.
 *
 * An entry need not also be listed in `srcs` — union dedups; a same path
 * resolving to *different* files across `entry`/`srcs` is a real conflict
 * `unionAll` asserts. scss `@use` of shared partials resolves against the src
 * packages (the css loadPaths). */
function composeBundle(context: TargetContext, inputs: IBundleInputs): Computable<RuleResult> {
  const srcPackages = inputs.srcs.filter((set): set is PackageFileSet => set instanceof PackageFileSet);
  const looseSrcs = inputs.srcs.filter(set => !(set instanceof PackageFileSet));
  const rootTree = FileSet.unionAll(...looseSrcs, inputs.entrySet);

  /* Both halves of what the sources may import: `srcs` packages are bundled in,
   * `deps` are externalized at link time — but the compile needs both. */
  return compileContents(context, rootTree, [...srcPackages, ...inputs.deps], { transpileJs: false }).then(built =>
    stageBundle(inputs, srcPackages, FileSet.unionAll(built.compiled, built.passthrough), built.css)
  );
}

function buildJsBundle(context: TargetContext): Computable<RuleResult> {
  const config = Computable.forAll(
    [context.getGlobalString("JS_TARGET"), context.getGlobalString("BUILD_TYPE")],
    (target, buildType) => ({ target, buildType })
  );
  return Computable.forAll(
    [
      context.getFileProperty("srcs"),
      context.getFileProperty("entry"),
      context.getFileProperty("deps"),
      config,
      context.getGlobalRunnable("JS_BUNDLER"),
      context.getRewrite("output"),
      context.getMap("defines"),
    ],
    (srcSources, entrySources, depSources, { target, buildType }, bundler, rewrite, defineMap) => {
      const jsTarget = parseJSTarget(target);
      /* esbuild `define` takes code text per identifier; a map value is that
       * text verbatim (esbuild's own contract — no probing). Sub-maps have no
       * meaning as code text, so defines is flat by contract. */
      const defines: Record<string, string> = Object.create(null);
      for (const [key, value] of defineMap) {
        /* A map scalar is a string list; a sub-map / list of sub-maps is not code text.
         * `every` with a type-predicate narrows `value` to string[] for the join below. */
        if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === "string")) {
          throw new TypeError(`defines value '${key}' must be a scalar string (a define is esbuild code text)`);
        }
        defines[key] = value.join(" ");
      }
      /* THE collection point for the bundle's contents: srcs, entry and deps
       * resolve jointly. The bundler resolved above is a build tool, independent
       * of what it compiles — its pins don't co-resolve with the sources'. */
      const contents = context.collect({ srcs: srcSources, entry: entrySources, deps: depSources });

      return contents.then(({ srcs, entry, deps }) =>
        composeBundle(context, {
          jsTarget,
          buildType,
          rewrite,
          defines,
          entrySet: FileSet.unionAll(...entry),
          srcs,
          deps,
          bundler,
        })
      );
    }
  );
}

export const buildJsBundleRule: RuleRegistration = {
  type: "js_bundle",
  constraints: { [BUILD_OPERATION]: "build" },
  evaluate: buildJsBundle,
};
