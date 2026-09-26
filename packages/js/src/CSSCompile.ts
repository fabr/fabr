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
 * Host-side (tool-independent) helpers behind the sass_compile and css_postcss
 * rules: the naming policy for everything the two steps emit, and the options
 * documents handed to the standalone drivers (see cssDriver/sass-driver.ts and
 * cssDriver/postcss-driver.ts — resolved as the SASS_DRIVER and POSTCSS_DRIVER
 * runnables declared in JS.fabr). Everything here runs in the host during
 * evaluation; the Sass and postcss invocations are the drivers' job.
 *
 * **The rule names, the driver writes.** Every output path in
 * {@link ISassOptions} and {@link IPostcssOptions} is computed here, so a
 * swapped driver produces the same tree without having to reproduce a naming
 * convention, and the compile edge ({@link cssImportRewrites}) is derived from
 * the same functions that named the files.
 *
 * Kept apart from the drivers so it can import @fabr-build/core and be
 * unit-tested under jest (the drivers run standalone in the css build steps and
 * must not depend on core at runtime).
 */

import { createHash } from "node:crypto";
import {
  attachHelp,
  BUILD_OVERRIDE,
  derivedFrom,
  describeProvenance,
  Computable,
  ConflictError,
  EMPTY_FILESET,
  FileSet,
  Name,
  NameBuilder,
  compareText,
  PackageFileSet,
  TargetContext,
} from "@fabr-build/core";

/** Where the drivers write, and the rules collect, the compiled CSS from. */
export const CSS_OUTDIR = "out";

/** Where the stylesheet inputs are staged (the drivers read from here). */
export const CSS_SRC_ROOT = "src";

/** Where a dependency's files mount, for the compose loader to read. Node's
 * own convention, so a package specifier is the path below it. */
export const CSS_DEPS_DIR = "node_modules";

/** Where the CSS toolchain + driver mount — disjoint from the styled tree so
 * the tools' deps neither collide with nor are visible to the sources. */
export const CSS_TOOL_DIR = ".fabr-css";

/**
 * One Sass source and every name the sass step produces for it. The driver
 * reads this and writes exactly these paths — it derives none of them.
 */
export interface ISassSource {
  /** The styled source, relative to {@link CSS_SRC_ROOT}. */
  path: string;
  /** Where the lowered CSS goes, relative to {@link CSS_OUTDIR} — the
   * {@link sassLoweredName}, `.module.` marker intact. */
  css: string;
  /** Where the source map goes, relative to {@link CSS_OUTDIR}; absent when
   * this build does not carry maps. */
  map?: string;
}

/**
 * The options document fabr writes for the Sass driver — a plain, tool-free
 * description of the lowering. Serialized to JSON, so it stays
 * content-addressed with no host paths.
 */
export interface ISassOptions {
  /** Every source to lower, with its output names. Partials are staged but
   * never listed. */
  sources: ISassSource[];
  /** Root (relative to the working dir) the source files are staged under. */
  srcRoot: string;
  /** Sass load paths (relative to the working dir) — the mounted scss dep roots
   * against which `@use`/`@import` of shared partials resolve. */
  loadPaths: string[];
  /** Where the driver writes outputs, relative to the working dir. */
  outdir: string;
}

/**
 * One stylesheet input and every name the postcss step produces for it. The
 * driver reads this and writes exactly these paths — it derives none of them.
 */
export interface IPostcssSource {
  /** The stylesheet input, relative to {@link CSS_SRC_ROOT} — plain CSS: a
   * lowered Sass source (`.module.` marker intact) or an authored `.css`. */
  path: string;
  /** Where the published CSS goes, relative to {@link CSS_OUTDIR} — the
   * {@link scopedCssName}, marker consumed. */
  css: string;
  /**
   * The suffix a local name takes when it is scoped — `<local>_<scope>`. Every
   * stylesheet has one, including a plain one: its own output keeps its names
   * as written ({@link module} is what decides that), but a css-module
   * composing from it gets a scoped private copy of its rules, and those
   * classes are named with this.
   */
  scope: string;
  /** Whether this stylesheet's OWN output is scoped and carries a class map —
   * the `.module.` marker, read once here rather than from the name again. */
  module: boolean;
  /** The JS shim carrying the class-name map (css-modules only). */
  shim?: string;
  /** The map the input ARRIVED with (relative to {@link CSS_SRC_ROOT}), for a
   * module's output map to chain through; absent for an authored stylesheet. */
  prev?: string;
  /** Where the source map goes, relative to {@link CSS_OUTDIR}: chained through
   * {@link prev} for a module, carried through beside a plain stylesheet that
   * arrived with one, absent otherwise. */
  map?: string;
}

/**
 * The options document fabr writes for the postcss driver. Serialized to JSON,
 * so it stays content-addressed with no host paths.
 */
export interface IPostcssOptions {
  /** Every stylesheet to process, with its output names. */
  sources: IPostcssSource[];
  /**
   * A dependency's stylesheets — readable, composable, never published by this
   * step. Named relative to the working dir (under {@link CSS_DEPS_DIR}, so a
   * package specifier is the path below it) and carrying the scope their
   * classes take in the private copy a compose inlines.
   */
  composable: Array<{ path: string; scope: string }>;
  /** Root (relative to the working dir) the inputs are staged under. */
  srcRoot: string;
  /** Where a dependency's files are mounted, which a package-shaped compose
   * specifier is resolved against. */
  depsDir: string;
  /** Where the driver writes outputs, relative to the working dir. */
  outdir: string;
}

/** Whether a name is a Sass source (the ones the driver compiles; a plain
 * `.css` passes through). */
export function isSassSource(name: string): boolean {
  return /\.(scss|sass)$/i.test(name);
}

/** Whether a styled source is a Sass PARTIAL (`_foo.scss`) — included by another
 * stylesheet rather than compiled in its own right, so it produces nothing. */
export function isSassPartial(name: string): boolean {
  return name.split("/").pop()?.startsWith("_") === true;
}

/** Whether a styled source is a **css-module** — the `.module.` infix — so its
 * local names are scoped and exported to the importing JavaScript. */
export function isCssModule(name: string): boolean {
  return /\.module\.(css|scss|sass)$/i.test(name);
}

/**
 * The name a Sass source takes when the *sass step* lowers it: the extension
 * becomes `.css`, the `.module.` marker rides through — the marker means
 * "scope me", and lowering does not scope. Identity on a plain `.css`.
 */
export function sassLoweredName(name: string): string {
  return name.replace(/\.(scss|sass)$/i, ".css");
}

/**
 * The name the *scoping step* publishes a stylesheet under: it consumes the
 * `.module.` marker — which every bundler reads as "scope this", so a
 * stylesheet whose names are already final must not still carry it. Identity on
 * a plain stylesheet, whose names were never anything but final.
 */
export function scopedCssName(name: string): string {
  return name.replace(/\.module\.css$/i, ".css");
}

/**
 * The plain-CSS name a styled source lowers to end-to-end: `x.scss` → `x.css`,
 * and `x.module.scss` → `x.css` as well — the sass step's lowering followed by
 * the scoping step's marker consumption.
 *
 * Two sources can therefore lower to one name; see {@link cssOutputConflict}.
 */
export function loweredCssName(name: string): string {
  return scopedCssName(sassLoweredName(name));
}

/**
 * The scope suffix a css-module's local names take: a digest of the package name
 * and the package-relative path of the *scoping step's input* (the
 * {@link sassLoweredName} — `a/x.module.css` whether the author wrote `.scss` or
 * `.css`), so it is a function of the file rather than of a bundle or of where
 * the file was staged.
 *
 * Distinctness across files rests on the digest rather than on construction, at
 * ~48 bits; {@link cssScopeCollision} catches the residue within a package, and
 * nothing can catch it across packages.
 */
export function cssScopeDigest(packageName: string, path: string): string {
  const digest = createHash("sha256").update(`${packageName}\0${path}`).digest("hex");
  /* Reduced from 64 bits rather than from the 48 being kept, so the modulo bias
   * is one part in 84,000 rather than one in three. */
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
 * The alphabet and width a scope is rendered in: base62 in 8 characters, ~47.6
 * bits. Every character is legal in a CSS identifier, and the suffix follows
 * `<local>_` so a leading digit is fine. Mixed case needs class matching to be
 * case-sensitive, which holds outside quirks mode.
 */
const SCOPE_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const SCOPE_LENGTH = 8;

/**
 * Every output name the sass step produces for one Sass source, or undefined
 * where it produces none (a Sass partial, which exists only to be included).
 */
export function sassSourceOutputs(path: string, sourceMaps = false): ISassSource | undefined {
  if (isSassPartial(path)) {
    return undefined;
  }
  const css = sassLoweredName(path);
  return { path, css, ...(sourceMaps ? { map: `${css}.map` } : {}) };
}

/**
 * Every output name the postcss step produces for one stylesheet input.
 * `carriedMaps` is the step's map inputs: a plain stylesheet that arrived with
 * one (a lowered Sass source) carries it through; one that arrived without (an
 * authored `.css`, copied verbatim) has no transform for a map to describe.
 */
export function postcssSourceOutputs(path: string, packageName: string, sourceMaps = false, carriedMaps?: ReadonlySet<string>): IPostcssSource {
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
    ...(carriedMaps?.has(`${path}.map`) ? { map: `${path}.map` } : {}),
  };
}

/**
 * Lower (and scope) the classified stylesheet bucket: the `sass_compile`
 * sub-target lowers the Sass sources (partials staged, never listed), then the
 * `css_postcss` sub-target runs the postcss chain over the lowered tree plus
 * the authored plain CSS — scoping the css-modules, publishing everything.
 * `deps` are the packages mounted for Sass `@use`/`@import` resolution (the
 * loadPaths analogue of node_modules); `packageName` is the identity scoped
 * names are derived from. Builds under BUILD_OPERATION=build — lowering is a
 * build even for a test target. An empty bucket skips both sub-targets, so a
 * project with no stylesheets never resolves the CSS toolchain.
 *
 * The end-to-end conflict checks run here, over the author's own names — the
 * per-step checks in each rule see only that step's inputs, and a collision
 * across the seam (`x.module.scss` beside `x.css`) is better reported against
 * the files the author wrote.
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
  assertCssOutputsDisjoint([...css].map(([name]) => name), packageName ?? "");
  const groups = css.partition(name => (isSassSource(name) ? "sass" : "plain"));
  const plain = groups.plain ?? EMPTY_FILESET;
  const sassSrcs = groups.sass ?? EMPTY_FILESET;
  const lowered = sassSrcs.isEmpty()
    ? Computable.resolve(EMPTY_FILESET)
    : context.subTarget("sass_compile", { srcs: sassSrcs, deps }, { label: "Lowering styles", constraints: BUILD_OVERRIDE });
  return lowered.then(sassOut => {
    /* The sass step's whole output is the postcss step's input — it emits
     * stylesheets and their maps and nothing else, so nothing crosses the
     * postcss step to reach the delivery and the lowered `.module.css`
     * intermediate has no path out. */
    const inputs = FileSet.unionAll(sassOut, plain);
    if (inputs.isEmpty()) {
      return Computable.resolve(EMPTY_FILESET);
    }
    return context.subTarget(
      "css_postcss",
      { srcs: inputs, deps, ...(packageName ? { package_name: packageName } : {}) },
      { label: "Scoping styles", constraints: BUILD_OVERRIDE }
    );
  });
}

/**
 * The whole-pipeline view of one styled source's outputs, for the end-to-end
 * conflict checks: the two steps' own naming functions composed. Every name
 * either step emits for the source, and the scope its locals take, keyed by the
 * name the AUTHOR wrote; undefined for a Sass partial, which produces nothing.
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

/** The end-to-end output-name and scope checks, over the author's own names. */
function assertCssOutputsDisjoint(fileNames: string[], packageName: string): void {
  const sources = [...fileNames]
    .sort()
    .map(name => cssPipelineOutputs(name, packageName))
    .filter((source): source is IPostcssSource => source !== undefined);
  const conflict = cssOutputConflict(sources, "css_postcss");
  if (conflict !== undefined) {
    throw attachHelp(conflict, outputConflictHelp(conflict));
  }
  const collision = cssScopeCollision(sources);
  if (collision !== undefined) {
    throw attachHelp(collision, SCOPE_COLLISION_HELP);
  }
}

const SCOPE_COLLISION_HELP =
  "two stylesheets hashed to the same scope, so their identically-named classes would collide " +
  "— this is a chance event; renaming or moving either file resolves it";

/** The slice of a step source the conflict checks read — both steps' source
 * shapes satisfy it, as does the whole-pipeline view. */
export interface ICssStepSource {
  path: string;
  css: string;
  shim?: string;
  map?: string;
}

/** Every path one source causes a driver to write. */
function outputPathsOf(source: ICssStepSource): string[] {
  return [source.css, ...(source.shim ? [source.shim] : []), ...(source.map ? [source.map] : [])];
}

/**
 * The first pair of sources that would write the same file, or undefined if none
 * do — `x.module.scss` alongside `x.scss`, both lowering to `x.css`. `step` is
 * the targetdef the conflict is attributed to.
 *
 * Nothing downstream catches this: the driver's writes silently overwrite, and
 * the step's output is collected as one tree, never unioned.
 */
export function cssOutputConflict(sources: ICssStepSource[], step: string): ConflictError | undefined {
  const claimed = new Map<string, string>();
  for (const source of sources) {
    for (const path of outputPathsOf(source)) {
      const owner = claimed.get(path);
      if (owner !== undefined) {
        /* Each side carries the PRODUCTION that reached this name, not just
         * the input path: two stylesheets with different names colliding makes
         * no sense until the step that renamed one of them is on the page. */
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
 * The first pair of css-modules whose scope digests collide, or undefined if
 * none do — which would let two files' identically-named locals scope to one
 * class and bleed. Chance only, and only within a package, which is all one css
 * step can see. A collision is reported, never disambiguated: a file's scope is
 * a function of its own name alone.
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
 * What to do about two stylesheets producing one file, said in terms of THESE
 * two — which of them is the css-module, and why that makes it land where it
 * does — ending with the generic "rename either of them".
 */
function outputConflictHelp(conflict: ConflictError): string[] {
  const sides = [conflict.left, conflict.right].map(side => describeProvenance(side.provenance)).filter((path): path is string => path !== undefined);
  const module = sides.find(isCssModule);
  if (module === undefined) {
    return [`two stylesheets both produce '${conflict.key}' — rename either of them`];
  }
  /* By basename: the two always sit in one directory (they collide on an output
   * name, which keeps its source's directory), and the full paths are in the
   * message already. */
  const name = (path: string): string => path.split("/").pop() ?? path;
  return [
    `'${name(module)}' is a css-module, and scoping consumes its '.module' marker — so it lowers to ` +
      `'${name(conflict.key)}', which the plain stylesheet beside it already produces`,
    "rename either stylesheet",
  ];
}

/**
 * Assemble the Sass driver's options from the step's source names: every
 * output is named here and written by the driver, read from
 * {@link CSS_SRC_ROOT} and written under {@link CSS_OUTDIR} — all
 * working-dir-relative, so the document stays content-addressed with no host
 * paths. A non-Sass source is refused: plain CSS enters at css_postcss.
 */
export function buildSassOptions(fileNames: string[], sourceMaps = false): ISassOptions {
  const stray = fileNames.find(name => !isSassSource(name));
  if (stray !== undefined) {
    throw new Error(`'${stray}' is not a Sass source — plain CSS enters at css_postcss`);
  }
  const sources = [...fileNames]
    .sort()
    .map(name => sassSourceOutputs(name, sourceMaps))
    .filter((source): source is ISassSource => source !== undefined);
  const conflict = cssOutputConflict(sources, "sass_compile");
  if (conflict !== undefined) {
    throw attachHelp(conflict, outputConflictHelp(conflict));
  }
  return {
    sources,
    srcRoot: CSS_SRC_ROOT,
    /* None: the dependencies are a table the driver's importer reads, not a
     * tree with roots to search. The field stays because it is the driver
     * contract's, and a swapped driver may still be handed load paths. */
    loadPaths: [],
    outdir: CSS_OUTDIR,
  };
}

/**
 * Assemble the postcss driver's options from the step's input names — the
 * stylesheets, with any `.map` beside them carried as map inputs rather than
 * listed as sources. A Sass source is refused: it enters at sass_compile, and
 * arrives here lowered.
 */
export function buildPostcssOptions(
  fileNames: string[],
  packageName: string,
  sourceMaps = false,
  deps: PackageFileSet[] = []
): IPostcssOptions {
  const stray = fileNames.find(isSassSource);
  if (stray !== undefined) {
    throw new Error(`'${stray}' is a Sass source — it enters at sass_compile, which lowers it to plain CSS`);
  }
  const names = [...fileNames].sort();
  const carriedMaps: ReadonlySet<string> = new Set(names.filter(name => name.endsWith(".map")));
  const sources = names.filter(name => !name.endsWith(".map")).map(name => postcssSourceOutputs(name, packageName, sourceMaps, carriedMaps));
  const conflict = cssOutputConflict(sources, "css_postcss");
  if (conflict !== undefined) {
    throw attachHelp(conflict, outputConflictHelp(conflict));
  }
  const collision = cssScopeCollision(sources);
  if (collision !== undefined) {
    throw attachHelp(collision, SCOPE_COLLISION_HELP);
  }
  return { sources, composable: composableStylesheets(deps), srcRoot: CSS_SRC_ROOT, depsDir: CSS_DEPS_DIR, outdir: CSS_OUTDIR };
}

/**
 * The stylesheets a dependency delivers, as the compose loader will find them:
 * mounted under {@link CSS_DEPS_DIR} by package name, each with a scope of its
 * own so two of them cannot name one class alike.
 *
 * Scoped by DELIVERED name rather than by whatever the dependency's own build
 * scoped it as — a compose takes a private copy, so the name only has to be
 * distinct here, and the published one is unknowable from the file anyway.
 */
function composableStylesheets(deps: PackageFileSet[]): Array<{ path: string; scope: string }> {
  return deps
    .flatMap(dep =>
      [...dep]
        .map(([name]) => name)
        .filter(name => name.toLowerCase().endsWith(".css"))
        .map(name => ({ path: `${CSS_DEPS_DIR}/${dep.packageName}/${name}`, scope: cssScopeDigest(dep.packageName, name) }))
    )
    .sort((left, right) => compareText(left.path, right.path));
}

/**
 * How the css step's outputs are split where a consumer needs them apart: the
 * **compile inputs** (the shims and declarations, which go into js_compile's
 * `srcs`) and the **content** (the stylesheets, which are delivered).
 *
 * Decided by extension over the step's whole output rather than remembered from
 * the naming above: the caller holds a FileSet and not the source list, and the
 * two sets must partition the output exactly.
 */
export function partitionCssOutput(output: FileSet): { compileInputs: FileSet; content: FileSet } {
  const groups = output.partition(name => (/\.(js|ts)$/i.test(name) ? "compileInputs" : "content"));
  return {
    compileInputs: groups.compileInputs ?? EMPTY_FILESET,
    content: groups.content ?? EMPTY_FILESET,
  };
}

/**
 * The compile's whole knowledge of stylesheets, as `rewrite_imports` rules: each
 * a stylesheet specifier as an author writes it, paired with the file it really
 * names. Constant, so the compile is told it once rather than once per
 * stylesheet.
 *
 * A module names its shim, the module that really carries the class map — so
 * the type comes from a source the pipeline compiles rather than a declaration
 * asserted beside it. A plain stylesheet names the published stylesheet, which
 * the compile types through the `resources` fallback — an `import "./x.css"`
 * exports nothing but must still resolve. A plain `.css` needs no entry: it
 * already names the published stylesheet.
 *
 * Selectors are written against the specifier rather than the declaration it
 * resolves to, the two stylesheet kinds reaching one declaration shape.
 *
 * Order matters, first match wins: `**\/*.scss` also matches `x.module.scss`.
 */
export function cssImportRewrites(): Name[] {
  return CSS_REWRITE_RULES.map(([selector, target]) => rule(selector, target));
}

/** `<selector> -> <target>`, as a rename over paths at any depth. `**\/` owns
 * its adjacent slash, so the pair is structure-preserving at the tree root too. */
function rule(selector: string, target: string): Name {
  const build = (suffix: string): Name =>
    new NameBuilder().appendGlobMetachars("**").appendLiteralString("/").appendGlobMetachars("*").appendLiteralString(suffix).name();
  return build(selector).withRenameTo(build(target));
}

/** Each stylesheet specifier an author may write, paired with the file it
 * really names. A plain `.css` needs no entry: it already names the published
 * stylesheet. */
const CSS_REWRITE_RULES: ReadonlyArray<readonly [string, string]> = [
  [".module.scss", ".css.js"],
  [".module.sass", ".css.js"],
  [".module.css", ".css.js"],
  [".scss", ".css"],
  [".sass", ".css"],
];
