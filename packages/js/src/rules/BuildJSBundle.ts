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
  Constraints,
  FileSet,
  FileSetRef,
  MemoryFile,
  PackageFileSet,
  RewriteFn,
  RuleRegistration,
  RuleResult,
  RunnableFileSet,
  TargetContext,
} from "@fabr-build/core";
import { compileContents, formatJSTarget, JSTarget, parseJSTarget } from "../JSPackage";
import { createNodeExecAction, PNP } from "../NodeExecAction";
import { treeMountOf } from "../PnPManifest";
import {
  buildBundleOptions,
  BUNDLE_OUTDIR,
  computeBundleEntries,
  computeExternalNames,
  IBundleEntrySource,
} from "../JSBundle";

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
  /** The entry as delivered: a plain fileset is staged at the bundle root, while
   * a projection over a package stays pending — the package mounts and the entry
   * is located inside it (see composeBundle). */
  entry: Array<FileSet | FileSetRef>;
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
  css: FileSet,
  entrySources: IBundleEntrySource[]
): RuleResult {
  const { jsTarget, buildType, rewrite, defines, srcs, deps, bundler } = inputs;
  if (entrySources.length === 0) {
    throw new Error("js_bundle 'entry' resolved to no files — name at least one source to bundle");
  }
  const entries = computeBundleEntries(entrySources, rewrite);
  const external = computeExternalNames(srcs, deps);
  const options = buildBundleOptions(jsTarget, buildType, entries, external, defines);
  const workspace = {
    [TOOL_DIR]: bundler,
    "bundle-options.json": MemoryFile.from(JSON.stringify(options)),
  };
  /* The bundler launches from its own mount (its deps resolve there); cwd is
   * the working root, so the options manifest and outdir resolve against it. */
  const argv = bundler.toCommandLine(["--options=bundle-options.json"], { base: TOOL_DIR });
  /* The bundled packages go over unassembled and unmaterialized: esbuild reads
   * the PnP table natively, so the step generates it (and the trees it names)
   * on a miss. The entry paths in the options document already name those trees
   * — a pure function of content, so naming one costs nothing here. */
  return createNodeExecAction(FileSet.unionAll(code, css, FileSet.layout(workspace)), srcPackages, argv, `${BUNDLE_OUTDIR}:**`, {
    layout: PNP,
    label: "bundle",
  });
}

/** Where a bundled package's files are staged, which an entry path inside one
 * must agree with: its tree under the pool mount. */
function mountOf(pkg: PackageFileSet): string {
  return treeMountOf(pkg);
}

/** An entry that is a projection over a package is CONTAINED: the package mounts
 * like any other bundled input and the entry is located inside it, so its
 * relative imports resolve among its siblings and its self-references are
 * ordinary bare specifiers. */
function isContainedEntry(source: FileSet | FileSetRef): source is FileSetRef & { source: PackageFileSet } {
  return source instanceof FileSetRef && source.source instanceof PackageFileSet;
}

/** A name minus its extension — the identity a source and its compiled output
 * share. */
function stemOf(name: string): string {
  return name.replace(/\.[^./]+$/, "");
}

/**
 * Where a loose entry ended up in the staged tree. js_compile names its own
 * output (`.ts`→`.js`, but also `.mts`→`.mjs`/`.cts`→`.cjs`), and an
 * untranspiled `.js` passes through under its own name — so the entry is found
 * by stem in what was actually staged, never re-derived from the source name.
 */
function stagedEntry(staged: FileSet, name: string): string {
  const stem = stemOf(name);
  const match = [...staged].find(([staged]) => stemOf(staged) === stem && /\.[cm]?js$/i.test(staged));
  if (match === undefined) {
    throw new Error(`js_bundle entry '${name}' produced no JavaScript to bundle`);
  }
  return match[0];
}

/** One package per name, in order of first appearance. Which copy survives is
 * immaterial: a package named twice came twice from the one collection point,
 * so it is the same instance. */
function uniqueByName(packages: PackageFileSet[]): PackageFileSet[] {
  return [...new Map(packages.map(pkg => [pkg.packageName, pkg] as const)).values()];
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
  const containedEntries = inputs.entry.filter(isContainedEntry);
  /* Everything else is a loose entry, staged at the bundle root and built with
   * the rest of the sources. `entry` was read contained, so a projection over a
   * NON-package (a plain delivered fileset) also arrives pending — it has no
   * container to be kept in, so manifestAll extracts it, exactly as collect
   * would have. A plain fileset passes through untouched. */
  const looseSources = inputs.entry.filter(set => !isContainedEntry(set));

  /* Naming a package as `entry` mounts it — a bundle entry that isn't bundled
   * would be meaningless — so the entry containers join the srcs packages. Both
   * came from the one collection point, so a package named twice is the same
   * instance and dedups by name. */
  const srcPackages = uniqueByName([
    ...inputs.srcs.filter((set): set is PackageFileSet => set instanceof PackageFileSet),
    ...containedEntries.map(ref => ref.source),
  ]);

  /* A contained entry keeps its place inside its mount; a loose one is wherever
   * the build put it, so it is looked up rather than guessed — hence after. */
  const containedSources = containedEntries.flatMap(ref =>
    /* ref.locate (not source.locate) so a literal entry naming nothing in the
     * package is the written-reference error, not a silently-missing entry. */
    [...ref.locate()].map(([path, name]) => ({ path: `${mountOf(ref.source)}/${path}`, name }))
  );

  return context.manifestAll(looseSources).then(looseEntries => {
    const rootTree = FileSet.unionAll(
      ...inputs.srcs.filter(set => !(set instanceof PackageFileSet)),
      ...looseEntries
    );
    /* Both halves of what the sources may import: `srcs` packages are bundled in,
     * `deps` are externalized at link time — but the compile needs both. */
    return compileContents(context, rootTree, [...srcPackages, ...inputs.deps], { transpileJs: false }).then(built => {
      const code = FileSet.unionAll(built.compiled, built.passthrough);
      const entrySources: IBundleEntrySource[] = [
        ...looseEntries.flatMap(set => [...set].map(([name]) => ({ path: stagedEntry(code, name), name }))),
        ...containedSources,
      ];
      return stageBundle(inputs, srcPackages, code, built.css, entrySources);
    });
  });
}

function buildJsBundle(context: TargetContext): Computable<RuleResult> {
  return Computable.forAll(
    [context.getGlobalString("JS_TARGET"), context.getGlobalString("BUILD_TYPE")],
    (target, buildType) => {
      const jsTarget = parseJSTarget(target);
      /* A bundle asks for its inputs as ESM whatever it ships as. Only ESM
       * carries the import graph a bundler needs: `require` hands back a
       * namespace built at run time, so every export of a required module must
       * survive, and tree-shaking becomes impossible. Lowering to CommonJS is
       * lossy, and the bundler re-emits everything anyway — so the loss buys
       * nothing and costs whatever the unused half of each dependency weighs.
       *
       * The mirror of the test compile's swap to `commonjs`, and set the same
       * way: component-wise (the ES version and environment are the target's
       * own), unconditionally, so a target already emitting ESM re-spells the
       * same target and shares the one compile by cache key.
       *
       * What it does NOT decide is the shipped format — that stays
       * {@link buildBundleOptions}'s reading of JS_TARGET, so a browser bundle
       * still lands as an iife. */
      const inputTarget = Constraints.of({ JS_TARGET: formatJSTarget({ ...jsTarget, module: "esm" }) });
      return buildWithInputs(context, jsTarget, buildType, inputTarget);
    }
  );
}

function buildWithInputs(
  context: TargetContext,
  jsTarget: JSTarget,
  buildType: string,
  inputTarget: Constraints
): Computable<RuleResult> {
  return Computable.forAll(
    [
      context.getFileProperty("srcs", inputTarget),
      context.getContainedFileProperty("entry", inputTarget),
      context.getFileProperty("deps", inputTarget),
      context.getGlobalRunnable("JS_BUNDLER"),
      context.getRewrite("output"),
      context.getMap("defines"),
    ],
    (srcSources, entrySources, depSources, bundler, rewrite, defineMap) => {
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
      /* `entry` was read contained, so its projections arrive pending for
       * composeBundle to place; srcs and deps extract as usual. One collection
       * point, per-property treatment. */
      const contents = context.collect({ srcs: srcSources, entry: entrySources, deps: depSources });

      return contents.then(({ srcs, entry, deps }) =>
        composeBundle(context, {
          jsTarget,
          buildType,
          rewrite,
          defines,
          entry,
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
