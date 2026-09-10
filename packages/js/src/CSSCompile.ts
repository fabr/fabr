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
 * Host-side (tool-independent) helpers behind the css_compile rule: the naming
 * policy for everything the step emits, and the options document handed to the
 * standalone CSS driver (see cssDriver/css-driver.ts — resolved as the
 * CSS_COMPILER runnable declared in JS.fabr). Everything here runs in the host
 * during evaluation; the Sass and postcss invocations are the driver's job.
 *
 * **The rule names, the driver writes.** Every output path in {@link ICssOptions}
 * is computed here, so a swapped driver produces the same tree without having to
 * reproduce a naming convention, and the compile edge ({@link cssImportRewrites})
 * is derived from the same functions that named the files.
 *
 * Kept apart from the driver so it can import @fabr-build/core and be
 * unit-tested under jest (the driver runs standalone in the css build step and
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
  PackageFileSet,
  TargetContext,
} from "@fabr-build/core";

/** The step named in a stylesheet's provenance — the targetdef a user would
 * recognise, not an internal label. */
const CSS_STEP = "css_compile";

/** Where the driver writes, and the rule collects, the compiled CSS from. */
export const CSS_OUTDIR = "out";

/** Where the styled sources are staged (the driver reads from here). */
export const CSS_SRC_ROOT = "src";

/**
 * One styled source and every name the step produces for it. The driver reads
 * this and writes exactly these paths — it derives none of them.
 */
export interface ICssSource {
  /** The styled source, relative to {@link CSS_SRC_ROOT}. */
  path: string;
  /** Where the lowered (and, for a module, scoped) CSS goes, relative to
   * {@link CSS_OUTDIR}. */
  css: string;
  /**
   * The suffix scoping appends to each local name — a css-module's scoped class
   * is `<local>_<scope>`. Absent for a plain stylesheet, whose names are global
   * and stay as written; its presence IS the module classification.
   */
  scope?: string;
  /** The JS shim carrying the class-name map (css-modules only). */
  shim?: string;
  /** Where the source map goes, relative to {@link CSS_OUTDIR}; absent when this
   * build does not carry maps, or when the source is a plain `.css` passing
   * through unchanged (nothing happened for a map to describe). */
  map?: string;
  /** The TypeScript declarations to write, each `declare`ing what an import of
   * the name it stands for yields. Empty for a source nothing can import. */
  declarations: string[];
}

/**
 * The options document fabr writes for the CSS driver — a plain, tool-free
 * description of the compile. Serialized to JSON, so it stays content-addressed
 * with no host paths.
 */
export interface ICssOptions {
  /** Every source to process, with its output names. */
  sources: ICssSource[];
  /** Root (relative to the working dir) the source files are staged under. */
  srcRoot: string;
  /** Sass load paths (relative to the working dir) — the mounted scss dep roots
   * against which `@use`/`@import` of shared partials resolve. */
  loadPaths: string[];
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
 * The plain-CSS name a styled source lowers to: `x.scss` → `x.css`, and
 * `x.module.scss` → `x.css` as well — scoping consumes the `.module.` marker,
 * which every bundler reads as "scope this", so a stylesheet whose names are
 * already final must not still carry it.
 *
 * Two sources can therefore lower to one name; see {@link cssOutputConflict}.
 */
export function loweredCssName(name: string): string {
  return name.replace(/\.module\.(css|scss|sass)$/i, ".css").replace(/\.(scss|sass)$/i, ".css");
}

/** The JS shim for a css-module: the lowered name with `.js` appended
 * (`x.module.scss` → `x.css.js`), so it can be named from the stylesheet alone. */
export function cssShimName(name: string): string {
  return `${loweredCssName(name)}.js`;
}

/**
 * TypeScript 5.0's `allowArbitraryExtensions` declaration name: for an import of
 * `{base}.{ext}`, tsc looks for `{base}.d.{ext}.ts`.
 *
 * Not the older `{base}.{ext}.d.ts` (the typed-css-modules convention), which
 * ESM resolution disables — see DESIGN-css-modules.md Part 3.
 */
export function assetDeclarationName(name: string): string {
  const dot = name.lastIndexOf(".");
  return `${name.substring(0, dot)}.d${name.substring(dot)}.ts`;
}

/**
 * The declarations to emit for a styled source: its own name, so what the author
 * imported typechecks, plus — for a module — the lowered name its shim imports.
 */
export function cssDeclarationNames(name: string): string[] {
  const own = assetDeclarationName(name);
  if (!isCssModule(name)) {
    return [own];
  }
  const lowered = assetDeclarationName(loweredCssName(name));
  return own === lowered ? [own] : [own, lowered];
}

/**
 * The scope suffix a css-module's local names take: a digest of the package name
 * and the package-relative path, so it is a function of the file rather than of
 * a bundle or of where the file was staged.
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
 * Every output name for one styled source, or undefined where it produces none
 * (a Sass partial, which exists only to be included).
 */
export function cssSourceOutputs(path: string, packageName: string, sourceMaps = false): ICssSource | undefined {
  if (isSassSource(path) && isSassPartial(path)) {
    return undefined;
  }
  const css = loweredCssName(path);
  /* A plain `.css` is copied verbatim, so there is no transform for a map to
   * describe — and an identity map that named the file as its own source would
   * be worse than none. */
  const mapped = sourceMaps && (isSassSource(path) || isCssModule(path));
  return {
    path,
    css,
    declarations: cssDeclarationNames(path),
    ...(mapped ? { map: `${css}.map` } : {}),
    ...(isCssModule(path) ? { scope: cssScopeDigest(packageName, path), shim: cssShimName(path) } : {}),
  };
}

/**
 * Lower (and scope) the classified stylesheet bucket by building the
 * `css_compile` sub-target. `deps` are the packages mounted for `@use`/`@import`
 * resolution (the Sass loadPaths analogue of node_modules); `packageName` is the
 * identity the scoped names are derived from. Builds under BUILD_OPERATION=build
 * — lowering is a build even for a test target. An empty bucket skips the
 * sub-target entirely, so a project with no stylesheets never resolves the CSS
 * toolchain.
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
  return context.subTarget(
    "css_compile",
    { srcs: css, deps, ...(packageName ? { package_name: packageName } : {}) },
    { label: "Compiling styles", constraints: BUILD_OVERRIDE }
  );
}

/** Every path one source causes the driver to write. */
function outputPathsOf(source: ICssSource): string[] {
  return [source.css, ...(source.shim ? [source.shim] : []), ...(source.map ? [source.map] : []), ...source.declarations];
}

/**
 * The first pair of sources that would write the same file, or undefined if none
 * do — `x.module.scss` alongside `x.scss`, both lowering to `x.css`.
 *
 * Nothing downstream catches this: the driver's writes silently overwrite, and
 * the step's output is collected as one tree, never unioned.
 */
export function cssOutputConflict(sources: ICssSource[]): ConflictError | undefined {
  const claimed = new Map<string, string>();
  for (const source of sources) {
    for (const path of outputPathsOf(source)) {
      const owner = claimed.get(path);
      if (owner !== undefined) {
        /* Each side carries the PRODUCTION that reached this name, not just the
         * input path: two stylesheets with different names colliding makes no
         * sense until the step that renamed one of them is on the page. No
         * parent chain — provenance belongs to the FileSet rather than to a
         * file, so the one both sides share could only name whichever `srcs`
         * entry the union happened to keep. */
        return new ConflictError(
          "stylesheet outputs",
          path,
          { provenance: derivedFrom(owner, CSS_STEP) },
          { provenance: derivedFrom(source.path, CSS_STEP) }
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
 * step can see. Reported rather than disambiguated: renumbering would make a
 * file's class names depend on its siblings.
 */
export function cssScopeCollision(sources: ICssSource[]): ConflictError | undefined {
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
 * does. The generic advice ("rename one of them") is the last line rather than
 * the whole of it: the reader's first question is why two files they wrote with
 * different names collide at all, and the answer is a rule they have not met.
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
 * Assemble the driver options from the styled source names: every source is
 * named here and written by the driver, read from {@link CSS_SRC_ROOT} and
 * written under {@link CSS_OUTDIR} — all working-dir-relative, so the document
 * stays content-addressed with no host paths.
 */
export function buildCssOptions(fileNames: string[], packageName: string, sourceMaps = false): ICssOptions {
  const sources = [...fileNames]
    .sort()
    .map(name => cssSourceOutputs(name, packageName, sourceMaps))
    .filter((source): source is ICssSource => source !== undefined);
  const conflict = cssOutputConflict(sources);
  if (conflict !== undefined) {
    throw attachHelp(conflict, outputConflictHelp(conflict));
  }
  const collision = cssScopeCollision(sources);
  if (collision !== undefined) {
    throw attachHelp(
      collision,
      "two stylesheets hashed to the same scope, so their identically-named classes would collide " +
        "— this is a chance event; renaming or moving either file resolves it"
    );
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
 * How the css step's outputs are split where a consumer needs them apart: the
 * **compile inputs** (the shims and declarations, which go into js_compile's
 * `srcs`) and the **content** (the stylesheets, which are delivered).
 *
 * Decided by extension over the step's whole output rather than remembered from
 * the naming above, because the caller holds a FileSet and not the source list —
 * and because the two sets must partition the output exactly, which a predicate
 * over it guarantees and two independently-derived lists do not.
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
 * a declaration shape and what an import resolving to it must be emitted as.
 * Constant, so the compile is told it once rather than once per stylesheet.
 *
 * Order matters, first match wins: `.module.d.scss.ts` also matches the plain
 * `*.d.scss.ts` shape. The two declarations of one stylesheet map to different
 * things — the source's own to the shim, the lowered twin to the stylesheet, so
 * the shim's own `import "./x.css"` does not rewrite back onto itself.
 */
export function cssImportRewrites(): Name[] {
  return CSS_ASSET_RULES.map(([selector, target]) => rule(selector, target));
}

/** `<selector> -> <target>`, as a rename over paths at any depth. `**\/` owns
 * its adjacent slash, so the pair is structure-preserving at the tree root too. */
function rule(selector: string, target: string): Name {
  const build = (suffix: string): Name =>
    new NameBuilder().appendGlobMetachars("**").appendLiteralString("/").appendGlobMetachars("*").appendLiteralString(suffix).name();
  return build(selector).withRenameTo(build(target));
}

/** The declaration suffix each stylesheet kind produces, paired with what an
 * import resolving to it must name in the emitted code. */
const CSS_ASSET_RULES: ReadonlyArray<readonly [string, string]> = [
  [".module.d.scss.ts", ".css.js"],
  [".module.d.sass.ts", ".css.js"],
  [".module.d.css.ts", ".css.js"],
  [".d.scss.ts", ".css"],
  [".d.sass.ts", ".css"],
  [".d.css.ts", ".css"],
];
