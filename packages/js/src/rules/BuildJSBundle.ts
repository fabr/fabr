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
 * The js_bundle[build] rule: bundle each file `entry` names into
 * self-contained JavaScript with esbuild. The loose source files in `srcs` and
 * `entry` are first compiled through js_compile, as ES modules, against the
 * packages in `srcs` and `deps`. The packages in `srcs`, and a package `entry`
 * is a projection over, are included in the bundle, reached through a PnP
 * table; imports of the packages in `deps` are left in the output. `output`
 * renames the output files and `defines` are the constants esbuild
 * substitutes. The output's module format is `JS_BUNDLE_FORMAT`, its platform
 * follows `JS_TARGET`, and `BUILD_TYPE` decides minifying and source maps. The
 * `js/node_globals` flag provides node's globals in a browser bundle.
 *
 * `srcs`, `entry` and `deps` resolve as one collection. The bundler is the
 * `JS_BUNDLER` program, staged under its own directory so its packages are not
 * visible to the sources. The result is plain files.
 */

import {
  Computable,
  Constraints,
  ContainedSources,
  defineRule,
  FabrError,
  FileSet,
  FileSetRef,
  Flag,
  makeRewrite,
  mapEntryError,
  MemoryFile,
  PackageFileSet,
  PackageSources,
  ResolutionSpec,
  RewriteFn,
  RuleResult,
  RunnableFileSet,
  TargetContext,
} from "@fabr-build/core";
import { compileContents, formatJSTarget, JSTarget, parseJSTarget, stripExtension, usesNodeGlobals } from "../JSPackage";
import { PNP } from "../Layout";
import { createNodeExecAction } from "../NodeExecAction";
import { SOURCE_PATHS_FILE, SOURCE_PATHS_FLAG } from "@fabr-build/js-tools";
import { pnpManifestOf } from "../PnPManifest";
import {
  BundleFormat,
  buildBundleOptions,
  BUNDLE_OUTDIR,
  computeBundleEntries,
  computeAssetNames,
  computeChunkNames,
  computeExternalNames,
  IBundleEntrySource,
  toBundleFormat,
} from "../JSBundle";
import { NPM_FORMAT } from "../NPMProtocol";

/** The `js_bundle` rule. */
export default defineRule({
  /**
   * State `srcs`, `entry` and `deps`, read under the bundle's input `JS_TARGET`
   * (see bundleInputTarget), as one collection. The bundler is resolved apart
   * from them, in evaluation.
   */
  requirements(
    context: TargetContext
  ): Computable<
    ResolutionSpec<{ srcs: Computable<PackageSources>; entry: Computable<ContainedSources>; deps: Computable<PackageSources> }>
  > {
    return context.getGlobalString("JS_TARGET").then(target => {
      const inputTarget = bundleInputTarget(parseJSTarget(target));
      return {
        build: {
          srcs: context.getPackageProperty("srcs", inputTarget, NPM_FORMAT),
          entry: context.getContainedFileProperty("entry", inputTarget),
          deps: context.getPackageProperty("deps", inputTarget, NPM_FORMAT),
        },
        result: "files" as const,
      };
    });
  },
  evaluateMaterialized(context, contents) {
    return buildJsBundle(context, contents);
  },
});

/** Where the bundler's install is staged, apart from the sources so its packages
 * neither collide with nor are visible to theirs. */
const TOOL_DIR = ".fabr-esbuild";

/** The generated module behind `js/node_globals`, staged at the working root and
 * named in esbuild's `inject`. esbuild fills a free identifier from an injected
 * module's export of the same name, so the module re-exports `Buffer` and
 * `process` from their browser shim packages, which the target must include (see
 * JS.fabr); the bundler reports a missing one here. It must export: an injected
 * module that only imports binds nothing. `global` needs no package and is a
 * define instead ({@link NODE_GLOBAL_DEFINES}). */
const NODE_GLOBALS_MODULE = ".fabr-node-globals.js";
const NODE_GLOBALS_GLUE = 'export { Buffer } from "buffer";\nexport { default as process } from "process";\n';

/** The node global that is a plain expression, not a module export. An entry
 * the target's `defines` states takes precedence. */
const NODE_GLOBAL_DEFINES: Record<string, string> = { global: "globalThis" };

/** The generated module behind `import.meta.url` in a CommonJS bundle for node,
 * staged at the working root and named as esbuild's `inject`: a define can only
 * name an identifier or a literal, so the URL is an injected module's export. */
const IMPORT_META_MODULE = ".fabr-import-meta.js";
const IMPORT_META_GLUE = 'export const import_meta_url = require("url").pathToFileURL(__filename).href;\n';

/** `import.meta`'s members as a CommonJS module for node has them: a bundle's
 * inputs are compiled as ES modules, and esbuild empties `import.meta` in a
 * CommonJS bundle. An entry the target's `defines` states takes precedence. */
const IMPORT_META_DEFINES: Record<string, string> = {
  "import.meta.dirname": "__dirname",
  "import.meta.filename": "__filename",
  "import.meta.url": "import_meta_url",
};

/**
 * @return the constraints a bundle's inputs are built and compiled under:
 * `JS_TARGET` with its module format set to ESM, its ES level and environment
 * kept, so esbuild has a static import graph to tree-shake. The format is set
 * even where it is already ESM, so the compile is shared with the target's own
 * one; this also replaces `dual`, which no single compile can emit. The format
 * the bundle is written in is `JS_BUNDLE_FORMAT`, read in the bundle's own
 * configuration.
 */
function bundleInputTarget(jsTarget: JSTarget): Constraints {
  return Constraints.of({ JS_TARGET: formatJSTarget({ ...jsTarget, module: "esm" }) });
}

/** The inputs a bundle is staged from: its configuration, its materialized
 * requirements and the bundler. */
interface IBundleInputs {
  jsTarget: JSTarget;
  /** The form the bundle is written in (JS_BUNDLE_FORMAT). */
  bundleFormat: BundleFormat;
  buildType: string;
  rewrite: RewriteFn;
  /** Compile-time constant substitutions for esbuild's `define` (the `defines`
   * MAP): each value is JavaScript source text as written, so a string constant
   * is written quoted, `'"production"'`, as for esbuild's own CLI. */
  defines: Record<string, string>;
  /** True to provide node's globals: the `js/node_globals` flag among `srcs` or
   * `deps`, in a bundle for a browser. */
  nodeGlobals: boolean;
  /** True to give `import.meta` its CommonJS equivalents: a `cjs` bundle for node. */
  importMeta: boolean;
  /** The entry as materialized: a plain file set is staged at the bundle root,
   * and a projection over a package stays pending, to be located inside the
   * package (see composeBundle). */
  entry: Array<FileSet | FileSetRef>;
  srcs: FileSet[];
  deps: FileSet[];
  bundler: RunnableFileSet;
}

/** Stage the working directory and yield the bundle action, or throw where
 * there are no `entrySources`. `code` and `css` are the compiled loose sources;
 * esbuild reaches both through the JS import graph, so it orders, joins and
 * splits the CSS and scopes css-modules. */
function stageBundle(
  inputs: IBundleInputs,
  srcPackages: PackageFileSet[],
  code: FileSet,
  css: FileSet,
  entrySources: IBundleEntrySource[]
): RuleResult {
  const { jsTarget, bundleFormat, buildType, rewrite, defines, nodeGlobals, importMeta, srcs, deps, bundler } = inputs;
  if (entrySources.length === 0) {
    throw new FabrError("js_bundle 'entry' resolved to no files — name at least one source to bundle");
  }
  const entries = computeBundleEntries(entrySources, rewrite);
  /* The entry's packages are bundled as srcs are, so they count as srcs here. */
  const external = computeExternalNames([...srcs, ...srcPackages], deps);
  const inject = [...(nodeGlobals ? [NODE_GLOBALS_MODULE] : []), ...(importMeta ? [IMPORT_META_MODULE] : [])];
  const options = buildBundleOptions(
    jsTarget,
    bundleFormat,
    buildType,
    entries,
    external,
    defines,
    inject,
    computeChunkNames(rewrite),
    computeAssetNames(rewrite)
  );
  const workspace = {
    [TOOL_DIR]: bundler,
    "bundle-options.json": MemoryFile.from(JSON.stringify(options)),
    ...(nodeGlobals ? { [NODE_GLOBALS_MODULE]: MemoryFile.from(NODE_GLOBALS_GLUE) } : {}),
    ...(importMeta ? { [IMPORT_META_MODULE]: MemoryFile.from(IMPORT_META_GLUE) } : {}),
  };
  /* The bundler launches from its own directory (its packages resolve there),
   * with its cwd at the working root, which the options document's paths are
   * relative to. Its maps name each source by its source path, from the table
   * the step stages for the bundle's own sources and the packages it bundles. */
  const argv = bundler.toCommandLine(["--options=bundle-options.json", SOURCE_PATHS_FLAG, SOURCE_PATHS_FILE], { base: TOOL_DIR });
  /* The bundled packages are passed as they are: esbuild reads the PnP table,
   * which the step writes, with the trees it names, on a miss. The entry paths
   * in the options document already name those trees, which depend only on
   * the packages' content. */
  return createNodeExecAction(FileSet.unionAll(code, css, FileSet.layout(workspace)), srcPackages, argv, `${BUNDLE_OUTDIR}:**`, {
    layout: PNP,
    label: "bundle",
    sourcePaths: SOURCE_PATHS_FILE,
    packageSourcePaths: true,
  });
}

/** @return true if `source` is a projection over a package, otherwise false. Such
 * an entry is contained: the package is included like any other bundled input
 * and the entry located inside it, so its relative imports resolve among its
 * siblings and its self-imports are ordinary bare specifiers. */
function isContainedEntry(source: FileSet | FileSetRef): source is FileSetRef & { source: PackageFileSet } {
  return source instanceof FileSetRef && source.source instanceof PackageFileSet;
}

/**
 * @return the name a loose entry was staged under: the JavaScript file with the
 * entry's stem. js_compile names its own output (`.ts`→`.js`, `.mts`→`.mjs`,
 * `.cts`→`.cjs`) and a `.js` passes through, so find it in what was staged;
 * never derive it from the source name. Throws where there is none.
 */
function stagedEntry(staged: FileSet, name: string): string {
  const stem = stripExtension(name);
  const match = [...staged].find(([staged]) => stripExtension(staged) === stem && /\.[cm]?js$/i.test(staged));
  if (match === undefined) {
    throw new FabrError(`js_bundle entry '${name}' produced no JavaScript to bundle`);
  }
  return match[0];
}

/** @return one package per name, in order of first appearance. A package named
 * twice came twice from the one collection, so either copy is the same
 * instance. */
function uniqueByName(packages: PackageFileSet[]): PackageFileSet[] {
  return [...new Map(packages.map(pkg => [pkg.packageName, pkg] as const)).values()];
}

/** Compile the loose sources and stage the bundle. The loose files in `srcs` and
 * `entry` are compiled first (`compileContents`), type-checked and with the
 * target's source-mode flags and JSX runtime, and esbuild bundles the output;
 * `transpileJs` is off, since esbuild downlevels plain JavaScript itself. The
 * packages in `srcs` are already built, and esbuild reaches them through the
 * PnP table.
 *
 * An entry need not also be in `srcs`; one path naming different files in
 * `entry` and `srcs` is a ConflictError. A Sass `@use` of a shared partial
 * resolves among the packages in `srcs`, through the table the css step's
 * importer reads. */
function composeBundle(context: TargetContext, inputs: IBundleInputs): Computable<RuleResult> {
  const containedEntries = inputs.entry.filter(isContainedEntry);
  /* Every other entry is loose, staged at the bundle root and compiled with the
   * other sources. `entry` was read contained, so a projection over a plain
   * file set also arrives pending, and applyProjections selects its files; a
   * plain file set passes through as it is. */
  const looseSources = inputs.entry.filter(set => !isContainedEntry(set));

  /* A package `entry` is a projection over is included in the bundle, so it
   * joins the packages in `srcs`, one per name. */
  const srcPackages = uniqueByName([
    ...inputs.srcs.filter((set): set is PackageFileSet => set instanceof PackageFileSet),
    ...containedEntries.map(ref => ref.source),
  ]);

  /* A contained entry is located inside its package's location in the PnP
   * table; a loose one is looked up after the compile, in what it staged. */
  /* Where the bundle's PnP table, over exactly these packages, places each. */
  const layout = containedEntries.length === 0 ? undefined : pnpManifestOf(srcPackages);
  const containedSources = containedEntries.flatMap(ref =>
    /* Use ref.locate, not source.locate, so a literal entry naming nothing in
     * the package is reported as the written reference's error. */
    [...ref.locate()].map(([path, name]) => ({ path: `${layout!.mountOf(ref.source)}/${path}`, name }))
  );

  return context.applyProjections(looseSources).then(looseEntries => {
    const rootTree = FileSet.unionAll(...inputs.srcs.filter(set => !(set instanceof PackageFileSet)), ...looseEntries);
    /* Compile against both the packages in `srcs` (bundled in) and `deps`
     * (left as imports), with the source-mode flags from either list (see
     * buildWithInputs), which the compile reads from its deps. */
    /* Compile for the bundle's input target, which the packages in `srcs` were
     * built under, not for JS_TARGET as it is. */
    const srcFlags = inputs.srcs.filter((set): set is Flag => set instanceof Flag);
    return compileContents(context, rootTree, [...srcPackages, ...srcFlags, ...inputs.deps], {
      transpileJs: false,
      constraints: bundleInputTarget(inputs.jsTarget),
    }).then(built => {
      const code = FileSet.unionAll(built.compiled, built.passthrough);
      const entrySources: IBundleEntrySource[] = [
        ...looseEntries.flatMap(set => [...set].map(([name]) => ({ path: stagedEntry(code, name), name }))),
        ...containedSources,
      ];
      return stageBundle(inputs, srcPackages, code, built.css, entrySources);
    });
  });
}

/** The bundle's requirements, materialized. `entry` was read contained, so its
 * projections arrive pending for composeBundle to place. */
interface IBundleContents {
  srcs: FileSet[];
  entry: (FileSet | FileSetRef)[];
  deps: FileSet[];
}

function buildJsBundle(context: TargetContext, contents: IBundleContents): Computable<RuleResult> {
  return Computable.forAll(
    [context.getGlobalString("JS_TARGET"), context.getGlobalString("JS_BUNDLE_FORMAT"), context.getGlobalString("BUILD_TYPE")],
    (target, bundleFormat, buildType) =>
      buildWithInputs(context, parseJSTarget(target), toBundleFormat(bundleFormat), buildType, contents)
  );
}

function buildWithInputs(
  context: TargetContext,
  jsTarget: JSTarget,
  bundleFormat: BundleFormat,
  buildType: string,
  { srcs, entry, deps }: IBundleContents
): Computable<RuleResult> {
  /* The source-mode flags on this bundle, from `srcs` or `deps`. */
  const flags = [...srcs, ...deps].filter((set): set is Flag => set instanceof Flag);
  return Computable.forAll(
    [context.getGlobalRunnable("JS_BUNDLER"), context.getRewriteRules("output").then(makeRewrite), context.getMap("defines")],
    (bundler, rewrite, defineMap) => {
      /* `js/node_globals` provides node's globals in a browser bundle only: a
       * node bundle already has them. */
      const nodeGlobals = usesNodeGlobals(flags) && jsTarget.environment === "browser";
      const importMeta = bundleFormat === "cjs" && jsTarget.environment === "node";
      /* esbuild's `define` takes code text per identifier, and a map value is
       * that text as written. A sub-map is no code text, so `defines` is
       * flat. */
      const defines: Record<string, string> = Object.create(null);
      /* Seeded before the declared entries, so an explicit `defines` entry for
       * one of these replaces it. */
      if (nodeGlobals) {
        Object.assign(defines, NODE_GLOBAL_DEFINES);
      }
      if (importMeta) {
        Object.assign(defines, IMPORT_META_DEFINES);
      }
      for (const [key, value] of defineMap) {
        /* A map scalar is a string list; a sub-map / list of sub-maps is not code text.
         * `every` with a type-predicate narrows `value` to string[] for the join below. */
        if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === "string")) {
          throw mapEntryError(defineMap, key, `defines value '${key}' must be a scalar string (a define is esbuild code text)`);
        }
        defines[key] = value.join(" ");
      }
      return composeBundle(context, {
        jsTarget,
        bundleFormat,
        buildType,
        rewrite,
        defines,
        nodeGlobals,
        importMeta,
        entry,
        srcs,
        deps,
        bundler,
      });
    }
  );
}
