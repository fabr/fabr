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

/*
 * The sass_compile and css_postcss rules' computations, run in fabr's process:
 * the names of everything the two steps write, and the options documents given
 * to their drivers (SASS_DRIVER and POSTCSS_DRIVER, js-tools' `cssDriver/`),
 * which run Sass and postcss. Every output path in {@link ISassOptions} and
 * {@link IPostcssOptions} is named here, and {@link cssImportRewrites} is made
 * from the same naming. The drivers must not import this module: they run
 * without @fabr-build/core.
 */

import { createHash } from "node:crypto";
import {
  BUILD_OVERRIDE,
  derivedFrom,
  describeProvenance,
  Computable,
  ConflictError,
  EMPTY_FILESET,
  FabrError,
  FileSet,
  Name,
  NameBuilder,
  compareText,
  PackageFileSet,
  TargetContext,
} from "@fabr-build/core";
import {
  type IPostcssOptions,
  type IPostcssSource,
  isSassSource,
  type ISassOptions,
  type ISassSource,
  sassLoweredName,
} from "@fabr-build/js-tools";

/** Where the drivers write, and the rules collect, the compiled CSS from. */
export const CSS_OUTDIR = "out";

/** Where the stylesheet inputs are staged (the drivers read from here). */
export const CSS_SRC_ROOT = "src";

/** Where the CSS tools and driver are mounted, apart from the stylesheets so
 * that the tools' dependencies neither collide with nor are visible to them. */
export const CSS_TOOL_DIR = ".fabr-css";

/** @return true if a stylesheet is a Sass partial (`_foo.scss`), otherwise
 * false. A partial is only included by other stylesheets, and produces no
 * output of its own. */
export function isSassPartial(name: string): boolean {
  return name.split("/").pop()?.startsWith("_") === true;
}

/** @return true if a stylesheet is a css-module (named `*.module.css`,
 * `.scss` or `.sass`), whose local names are scoped and exported to the
 * importing JavaScript, otherwise false. */
export function isCssModule(name: string): boolean {
  return /\.module\.(css|scss|sass)$/i.test(name);
}

/**
 * Name the stylesheet the postcss step writes for its input: `x.module.css`
 * becomes `x.css`, since its names are scoped and a bundler would scope a
 * `.module.` stylesheet again. Any other name is kept.
 */
export function scopedCssName(name: string): string {
  return name.replace(/\.module\.css$/i, ".css");
}

/**
 * Name the CSS a stylesheet ends as after both steps: `x.scss` and
 * `x.module.scss` both become `x.css`. Two stylesheets can therefore end as
 * one name; see {@link cssOutputConflict}.
 */
export function loweredCssName(name: string): string {
  return scopedCssName(sassLoweredName(name));
}

/**
 * Compute the scope suffix a css-module's local names take: a digest, about
 * 48 bits, of the package name and the package-relative path of the postcss
 * step's input (`a/x.module.css`, whether the author wrote `.scss` or `.css`;
 * see {@link sassLoweredName}). Two files can share a suffix by chance:
 * {@link cssScopeCollision} finds that within a package, and nothing finds it
 * across packages.
 */
export function cssScopeDigest(packageName: string, path: string): string {
  const digest = createHash("sha256").update(`${packageName}\0${path}`).digest("hex");
  /* Reduce from 64 bits of the digest, not 48, to keep the modulo bias to one
   * part in 84,000. */
  let value = BigInt(`0x${digest.substring(0, 16)}`) % BigInt(SCOPE_ALPHABET.length) ** BigInt(SCOPE_LENGTH);
  const radix = BigInt(SCOPE_ALPHABET.length);
  let scope = "";
  for (let digit = 0; digit < SCOPE_LENGTH; digit++) {
    scope = SCOPE_ALPHABET[Number(value % radix)] + scope;
    value /= radix;
  }
  return scope;
}

/**
 * The alphabet and width a scope is written in: base62 in 8 characters, about
 * 47.6 bits. Every character is legal in a CSS identifier, and the suffix
 * follows `<local>_`, so it may start with a digit. Mixed case relies on class
 * names matching case-sensitively, as they do outside quirks mode.
 */
const SCOPE_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const SCOPE_LENGTH = 8;

/**
 * Name every output the sass step writes for one Sass source: its CSS, and
 * with `sourceMaps` its map. Undefined for a Sass partial, which has none.
 */
export function sassSourceOutputs(path: string, sourceMaps = false): ISassSource | undefined {
  if (isSassPartial(path)) {
    return undefined;
  }
  const css = sassLoweredName(path);
  return { path, css, ...(sourceMaps ? { map: `${css}.map` } : {}) };
}

/**
 * Name every output the postcss step writes for one stylesheet input, and its
 * scope: its CSS, for a css-module the `.ts` module exporting its class names
 * (`shim`), and with `sourceMaps` its map. `carriedMaps` is the step's map
 * inputs: an input with a map beside it (a lowered Sass source) names it as
 * `prev`, the map its own map is composed onto.
 */
export function postcssSourceOutputs(
  path: string,
  packageName: string,
  sourceMaps = false,
  carriedMaps?: ReadonlySet<string>
): IPostcssSource {
  const scope = cssScopeDigest(packageName, path);
  if (isCssModule(path)) {
    const css = scopedCssName(path);
    return {
      path,
      css,
      scope,
      module: true,
      shim: `${css}.ts`,
      ...(carriedMaps?.has(`${path}.map`) ? { prev: `${path}.map` } : {}),
      ...(sourceMaps ? { map: `${css}.map` } : {}),
    };
  }
  return {
    path,
    css: path,
    scope,
    module: false,
    ...(carriedMaps?.has(`${path}.map`) ? { prev: `${path}.map` } : {}),
    ...(sourceMaps ? { map: `${path}.map` } : {}),
  };
}

/**
 * Compile a target's stylesheets `css` to plain CSS: the `sass_compile`
 * sub-target compiles the Sass sources (partials staged, never listed), then
 * the `css_postcss` sub-target runs postcss over its output and the plain CSS,
 * scoping the css-modules and prefixing every stylesheet for
 * `BROWSER_TARGET`. Both are built under BUILD_OPERATION=build.
 *
 * `deps` are the packages a Sass `@use` or `@import`, or a `composes`, may
 * load from; `packageName` is what the scopes are digested from. Empty `css`
 * builds neither sub-target, so no CSS tool is resolved. Each output file
 * carries a `derived` step naming the stylesheet it came from. Throws, before
 * building anything, where two stylesheets would end as one output name
 * (`x.module.scss` beside `x.css`) or two css-modules share a scope, naming the
 * stylesheets as the author wrote them.
 */
export function compileCssSources(
  context: TargetContext,
  css: FileSet,
  deps: PackageFileSet[],
  packageName?: string
): Computable<FileSet> {
  if (css.isEmpty()) {
    return Computable.resolve(EMPTY_FILESET);
  }
  assertCssOutputsDisjoint(
    [...css].map(([name]) => name),
    packageName ?? ""
  );
  const groups = css.partition(name => (isSassSource(name) ? "sass" : "plain"));
  const plain = groups.plain ?? EMPTY_FILESET;
  const sassSrcs = groups.sass ?? EMPTY_FILESET;
  const lowered = sassSrcs.isEmpty()
    ? Computable.resolve(EMPTY_FILESET)
    : context.subTarget("sass_compile", { srcs: sassSrcs, deps }, { label: "Compiling styles", constraints: BUILD_OVERRIDE });
  return lowered.then(sassOut => {
    /* The sass step writes only stylesheets and maps, all of them postcss
     * inputs, so its `.module.css` outputs never reach the result. */
    const inputs = FileSet.unionAll(sassOut, plain);
    if (inputs.isEmpty()) {
      return Computable.resolve(EMPTY_FILESET);
    }
    return context
      .subTarget(
        "css_postcss",
        { srcs: inputs, deps, ...(packageName ? { package_name: packageName } : {}) },
        { label: "Postprocessing styles", constraints: BUILD_OVERRIDE }
      )
      .then(output => withDerivations(output, css, packageName ?? ""));
  });
}

/**
 * @return `output`, the pipeline's, with each file stating the stylesheet of
 * `sources` it was produced from (a `derived` step, naming the stylesheet by
 * its source path where it has one).
 */
export function withDerivations(output: FileSet, sources: FileSet, packageName: string): FileSet {
  const names = [...sources].map(([name]) => name);
  /* Each produced file by the index of its source in `names`. */
  const producedFrom = new Map<string, number>();
  names.forEach((name, index) => {
    const outputs = cssPipelineOutputs(name, packageName);
    for (const produced of outputs === undefined ? [] : outputPathsOf(outputs)) {
      producedFrom.set(produced, index);
    }
  });
  const bySource = output.partition(name => String(producedFrom.get(name) ?? "none"));
  return FileSet.unionAll(
    ...Object.entries(bySource).map(([index, files]) => {
      const source = names[Number(index)];
      return source === undefined
        ? files
        : files.withStep(derivedFrom(sources.sourcePathOf(source) ?? source, isSassSource(source) ? "sass_compile" : "css_postcss"));
    })
  );
}

/**
 * Name the outputs of one stylesheet across both steps, and its scope, under
 * the name the author wrote: the two steps' naming functions composed.
 * Undefined for a Sass partial, which produces nothing.
 */
function cssPipelineOutputs(path: string, packageName: string): IPostcssSource | undefined {
  if (!isSassSource(path)) {
    return postcssSourceOutputs(path, packageName);
  }
  const sass = sassSourceOutputs(path);
  if (sass === undefined) {
    return undefined;
  }
  return { ...postcssSourceOutputs(sass.css, packageName), path };
}

/** Check, over the stylesheets as the author named them, that no two end as
 * one output name and no two css-modules share a scope, throwing where they
 * do. */
function assertCssOutputsDisjoint(fileNames: string[], packageName: string): void {
  const sources = [...fileNames]
    .sort()
    .map(name => cssPipelineOutputs(name, packageName))
    .filter((source): source is IPostcssSource => source !== undefined);
  const conflict = cssOutputConflict(sources, "css_postcss");
  if (conflict !== undefined) {
    throw conflict.withHelp(outputConflictHelp(conflict));
  }
  const collision = cssScopeCollision(sources);
  if (collision !== undefined) {
    throw collision.withHelp(SCOPE_COLLISION_HELP);
  }
}

const SCOPE_COLLISION_HELP =
  "two stylesheets hashed to the same scope, so their identically-named classes would collide " +
  "— this is a chance event; renaming or moving either file resolves it";

/** The fields of a step's source entry the conflict checks read, which
 * {@link ISassSource} and {@link IPostcssSource} both have. */
export interface ICssStepSource {
  path: string;
  css: string;
  shim?: string;
  map?: string;
}

/** List every path one source causes a driver to write. */
function outputPathsOf(source: ICssStepSource): string[] {
  return [source.css, ...(source.shim ? [source.shim] : []), ...(source.map ? [source.map] : [])];
}

/**
 * Find the first pair of sources that would write the same file
 * (`x.module.scss` beside `x.scss`, both ending as `x.css`), or undefined if
 * none do. `step` is the targetdef each side is attributed to. Check this
 * before the driver runs: it overwrites a file it has written.
 */
export function cssOutputConflict(sources: ICssStepSource[], step: string): ConflictError | undefined {
  const claimed = new Map<string, string>();
  for (const source of sources) {
    for (const path of outputPathsOf(source)) {
      const owner = claimed.get(path);
      if (owner !== undefined) {
        /* Give each side a `derived` step, so the report shows the step that
         * renamed each stylesheet. */
        return new ConflictError(
          "stylesheet outputs",
          path,
          { provenance: derivedFrom(owner, step) },
          { provenance: derivedFrom(source.path, step) }
        );
      }
      claimed.set(path, source.path);
    }
  }
  return undefined;
}

/**
 * Find the first pair of css-modules whose scopes are the same, which would
 * give their same-named local names one class, or undefined if none do. A
 * step passes only one package's stylesheets.
 */
export function cssScopeCollision(sources: Array<{ path: string; scope?: string }>): ConflictError | undefined {
  const claimed = new Map<string, string>();
  for (const source of sources) {
    if (source.scope === undefined) {
      continue;
    }
    const owner = claimed.get(source.scope);
    if (owner !== undefined) {
      return new ConflictError("css-module scope", source.scope, { detail: owner }, { detail: source.path });
    }
    claimed.set(source.scope, source.path);
  }
  return undefined;
}

/**
 * Make the help for two stylesheets producing one file: where one is a
 * css-module, why it ends at that name; then to rename either.
 */
function outputConflictHelp(conflict: ConflictError): string[] {
  const sides = [conflict.left, conflict.right]
    .map(side => describeProvenance(side.provenance))
    .filter((path): path is string => path !== undefined);
  const module = sides.find(isCssModule);
  if (module === undefined) {
    return [`two stylesheets both produce '${conflict.key}' — rename either of them`];
  }
  /* Name each by its file name: both are in one directory, and the message
   * already gives the full paths. */
  const name = (path: string): string => path.split("/").pop() ?? path;
  return [
    `'${name(module)}' is a css-module, and scoping consumes its '.module' marker — so it lowers to ` +
      `'${name(conflict.key)}', which the plain stylesheet beside it already produces`,
    "rename either stylesheet",
  ];
}

/**
 * Assemble the Sass driver's options from the step's source names: each
 * source's outputs ({@link sassSourceOutputs}), read from {@link CSS_SRC_ROOT}
 * and written under {@link CSS_OUTDIR}, every path relative to the working
 * directory. Throws for a source that is not Sass, or two writing one file.
 */
export function buildSassOptions(fileNames: string[], sourceMaps = false): ISassOptions {
  const stray = fileNames.find(name => !isSassSource(name));
  if (stray !== undefined) {
    throw new FabrError(`'${stray}' is not a Sass source — plain CSS enters at css_postcss`);
  }
  const sources = [...fileNames]
    .sort()
    .map(name => sassSourceOutputs(name, sourceMaps))
    .filter((source): source is ISassSource => source !== undefined);
  const conflict = cssOutputConflict(sources, "sass_compile");
  if (conflict !== undefined) {
    throw conflict.withHelp(outputConflictHelp(conflict));
  }
  return {
    sources,
    srcRoot: CSS_SRC_ROOT,
    /* None: the driver's importer reads the dependencies from a table, and
     * searches no directories. */
    loadPaths: [],
    outdir: CSS_OUTDIR,
  };
}

/**
 * Assemble the postcss driver's options from the step's input names: each
 * stylesheet's outputs ({@link postcssSourceOutputs}), a `.map` input being
 * the map of the stylesheet it names, not a source; the stylesheets `deps`
 * hold, for `composes`; and `browsers` (`BROWSER_TARGET`), what every
 * stylesheet is prefixed for. Throws for a Sass source, two sources writing
 * one file, or two css-modules sharing a scope.
 */
export function buildPostcssOptions(
  fileNames: string[],
  packageName: string,
  browsers: string,
  sourceMaps = false,
  deps: PackageFileSet[] = []
): IPostcssOptions {
  const stray = fileNames.find(isSassSource);
  if (stray !== undefined) {
    throw new FabrError(`'${stray}' is a Sass source — it enters at sass_compile, which lowers it to plain CSS`);
  }
  const names = [...fileNames].sort();
  const carriedMaps: ReadonlySet<string> = new Set(names.filter(name => name.endsWith(".map")));
  const sources = names
    .filter(name => !name.endsWith(".map"))
    .map(name => postcssSourceOutputs(name, packageName, sourceMaps, carriedMaps));
  const conflict = cssOutputConflict(sources, "css_postcss");
  if (conflict !== undefined) {
    throw conflict.withHelp(outputConflictHelp(conflict));
  }
  const collision = cssScopeCollision(sources);
  if (collision !== undefined) {
    throw collision.withHelp(SCOPE_COLLISION_HELP);
  }
  return { sources, composable: composableStylesheets(deps), srcRoot: CSS_SRC_ROOT, outdir: CSS_OUTDIR, browsers };
}

/**
 * List the `.css` stylesheets each dependency holds, as a `composes` names
 * them: by the name the package is bound under and the path within it, each
 * with a scope digested from the package's name and that path, sorted.
 */
function composableStylesheets(deps: PackageFileSet[]): IPostcssOptions["composable"] {
  return deps
    .flatMap(dep =>
      [...dep]
        .map(([name]) => name)
        .filter(name => name.toLowerCase().endsWith(".css"))
        .map(name => ({ package: dep.name, path: name, scope: cssScopeDigest(dep.packageName, name) }))
    )
    .sort((left, right) => compareText(`${left.package}/${left.path}`, `${right.package}/${right.path}`));
}

/**
 * Split the css step's outputs by extension: the compile inputs (`.js` and
 * `.ts` files, the css-modules' class-name modules, which go into js_compile's
 * `srcs`) and the content (everything else, the stylesheets and maps the build
 * outputs).
 */
export function partitionCssOutput(output: FileSet): { compileInputs: FileSet; content: FileSet } {
  const groups = output.partition(name => (/\.(js|ts)$/i.test(name) ? "compileInputs" : "content"));
  return {
    compileInputs: groups.compileInputs ?? EMPTY_FILESET,
    content: groups.content ?? EMPTY_FILESET,
  };
}

/**
 * Make the `rewrite_imports` rules for stylesheet imports, the same for every
 * target: each renames a stylesheet specifier as an author writes it to the
 * file it names after the css step. A css-module's specifier names its
 * class-name module (`x.module.scss` → `x.css.js`); a Sass stylesheet's names
 * the CSS written for it (`x.scss` → `x.css`), which the compile types
 * through the `resources` fallback. A plain `.css` needs no rule.
 *
 * The first matching rule applies, so the css-module rules come first:
 * `**\/*.scss` also matches `x.module.scss`.
 */
export function cssImportRewrites(): Name[] {
  return CSS_REWRITE_RULES.map(([selector, target]) => rule(selector, target));
}

/** Make `**\/*<selector> -> **\/*<target>`, a rename over paths at any depth,
 * the tree root included. */
function rule(selector: string, target: string): Name {
  const build = (suffix: string): Name =>
    new NameBuilder().appendGlobMetachars("**").appendLiteralString("/").appendGlobMetachars("*").appendLiteralString(suffix).name();
  return build(selector).withRenameTo(build(target));
}

/** Each stylesheet suffix an author may import, paired with the suffix of the
 * file it names after the css step, in the order the rules are tried. */

const CSS_REWRITE_RULES: ReadonlyArray<readonly [string, string]> = [
  [".module.scss", ".css.js"],
  [".module.sass", ".css.js"],
  [".module.css", ".css.js"],
  [".scss", ".css"],
  [".sass", ".css"],
];
