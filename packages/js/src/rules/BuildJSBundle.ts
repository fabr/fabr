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
  EMPTY_FILESET,
  FileSet,
  MemoryFile,
  PackageFileSet,
  RewriteFn,
  RuleRegistration,
  RuleResult,
  RunnableFileSet,
  TargetContext,
} from "@fabr-build/core";
import { assembleNodeModules, JSTarget, parseJSTarget } from "../JSPackage";
import { buildBundleOptions, BUNDLE_OUTDIR, computeBundleEntries, computeExternalNames } from "../JSBundle";
import { isStyledSource } from "../CSSCompile";

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

/** Stage the working dir and yield the bundle action, given the resolved inputs
 * and the compiled CSS. `plainTree` is the root tree with styled sources already
 * removed; `css` is the css_compile output (plain CSS + proxy .js) that replaces
 * them — both enter esbuild through the JS import graph, so esbuild keeps
 * ownership of CSS concat/order/split. */
function stageBundle(
  inputs: IBundleInputs,
  srcPackages: PackageFileSet[],
  plainTree: FileSet,
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
    plainTree,
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

/** Partition srcs, lower styled sources via a css_compile sub-target, and stage
 * the bundle. srcs partition: packages mount at node_modules (inlined by
 * esbuild); loose files land at the working root, where entries live (an entry
 * need not be separately listed in `srcs` — union dedups; a same path resolving
 * to *different* files across `entry`/`srcs` is a real conflict `unionAll`
 * asserts). Styled sources (.scss/.sass) are replaced by the css_compile output
 * (plain CSS + per-module proxy .js); the driver's resolve convention maps the
 * original imports onto it. Plain .css passes straight to esbuild. scss `@use`
 * of shared partials resolves against the src packages (the css loadPaths). */
function composeBundle(context: TargetContext, inputs: IBundleInputs): Computable<RuleResult> {
  const srcPackages = inputs.srcs.filter((set): set is PackageFileSet => set instanceof PackageFileSet);
  const looseSrcs = inputs.srcs.filter(set => !(set instanceof PackageFileSet));
  const rootTree = FileSet.unionAll(...looseSrcs, inputs.entrySet);

  const styled = rootTree.remap(name => (isStyledSource(name) ? name : undefined));
  const plainTree = rootTree.remap(name => (isStyledSource(name) ? undefined : name));
  const cssOut =
    [...styled].length > 0
      ? context.subTarget(
          "css_compile",
          { srcs: styled, deps: srcPackages },
          { label: "Compiling styles", constraints: { [BUILD_OPERATION]: "build" } }
        )
      : Computable.resolve(EMPTY_FILESET);

  return cssOut.then(css => stageBundle(inputs, srcPackages, plainTree, css));
}

function buildJsBundle(context: TargetContext): Computable<RuleResult> {
  const config = Computable.forAll(
    [context.getGlobalString("JS_TARGET"), context.getGlobalString("BUILD_TYPE")],
    (target, buildType) => ({ target, buildType })
  );
  return Computable.forAll(
    [
      context.getFileSources("srcs"),
      context.getFileSet("entry"),
      context.getFileSources("deps"),
      config,
      context.getGlobalRunnable("JS_BUNDLER"),
      context.getRewrite("output"),
      context.getMap("defines"),
    ],
    (srcSources, entrySet, depSources, { target, buildType }, bundler, rewrite, defineMap) => {
      const jsTarget = parseJSTarget(target);
      /* esbuild `define` takes code text per identifier; a map value is that
       * text verbatim (esbuild's own contract — no probing). Sub-maps have no
       * meaning as code text, so defines is flat by contract. */
      const defines: Record<string, string> = {};
      for (const [key, value] of defineMap) {
        if (typeof value !== "string") {
          throw new TypeError(`defines value '${key}' must be a scalar string (a define is esbuild code text)`);
        }
        defines[key] = value;
      }
      /* THE collection point for the bundle's contents: srcs and deps resolve
       * jointly. The bundler resolved above is a build tool, independent of
       * what it compiles — its pins don't co-resolve with the sources'. */
      const contents = context.collect({ srcs: srcSources, deps: depSources });

      return contents.then(({ srcs, deps }) =>
        composeBundle(context, { jsTarget, buildType, rewrite, defines, entrySet, srcs, deps, bundler })
      );
    }
  );
}

export const buildJsBundleRule: RuleRegistration = {
  type: "js_bundle",
  constraints: { [BUILD_OPERATION]: "build" },
  evaluate: buildJsBundle,
};
