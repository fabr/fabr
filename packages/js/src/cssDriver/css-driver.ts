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
 */

/**
 * Fabr's CSS driver: the runtime executed (standalone, under node) inside a
 * css_compile build step. It reads the options document fabr staged (see
 * CSSCompile.ts / ICssOptions) and lowers styled sources to plain CSS, owning
 * ALL the CSS transforms end-to-end:
 *
 *  - **sass** (sass-embedded) — .scss/.sass → plain CSS, one warm compiler,
 *    loadPaths = the mounted scss deps. `loadedUrls` is captured (the depfile
 *    hook for future discovered-deps) but unused for now.
 *  - **css-modules** (lightningcss) — .module.* → scoped CSS + a value map; the
 *    proxy .js (a dual JS-value + CSS-side-effect module) is synthesized here.
 *  - **post** (lightningcss) — vendor prefix / minify over the emitted output —
 *    NOT wired yet (a later graph position).
 *
 * Usage: node css-driver.js --manifest=<path-to-manifest.json>
 *
 * Like the bundle driver, this file runs in the *build* process, not in fabr:
 * it `require`s sass-embedded + lightningcss from its own staged node_modules
 * and must not depend on @fabr-build/core at runtime (the ICssOptions import is
 * type-only, erased at compile). The tools are required lazily inside {@link
 * main} so the pure helpers stay importable (for the unit tests) without them
 * installed.
 *
 * The bundler stays dumb about CSS: this driver produces plain CSS + proxy
 * modules; esbuild concatenates/orders/splits them via the JS import graph. The
 * driver never concatenates or orders CSS.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ICssOptions } from "../CSSCompile";

/* Minimal structural typing for the slices of the tool APIs we use — neither
 * tool is a fabr dependency (both are fetched at build time), so their own
 * types are not available here; these mirror the documented shapes. */
interface ISassResult {
  css: string;
  loadedUrls: Array<{ pathname?: string; href?: string }>;
  /** Present when compiled with sourceMap; used to report a downstream
   * css-modules failure against the scss the user wrote. */
  sourceMap?: ISourceMap;
}
interface ISassCompiler {
  compileAsync(path: string, options?: { loadPaths?: string[]; sourceMap?: boolean }): Promise<ISassResult>;
  dispose(): Promise<void>;
}
interface ISass {
  initAsyncCompiler(): Promise<ISassCompiler>;
}
/** lightningcss css-modules export: a local name maps to its scoped name (plus
 * compose chain, unused here). */
interface ILightningExport {
  name: string;
}
interface ILightningResult {
  code: Uint8Array;
  exports?: Record<string, ILightningExport>;
}
interface ILightning {
  transform(options: { filename: string; code: Uint8Array; cssModules?: boolean }): ILightningResult;
}

/** Whether a source is a CSS-module (scoped): `<name>.module.{scss,sass,css}`. */
export function isModule(name: string): boolean {
  return /\.module\.(scss|sass|css)$/i.test(name);
}

/** Whether a source is Sass (needs the sass compile before anything else). */
export function isSass(name: string): boolean {
  return /\.(scss|sass)$/i.test(name);
}

/** The scoped-CSS output name for a module source — the full source name plus
 * `.css` (`x.module.scss` → `x.module.scss.css`). Crucially it must NOT end in
 * `.module.css`, or esbuild would treat this already-scoped output as its *own*
 * CSS module and re-mangle the class names (breaking the match with the proxy's
 * value map); appending `.css` makes it a plain stylesheet to esbuild. The proxy
 * imports it for its side effect; the name is internal (never emitted). */
export function moduleCssName(name: string): string {
  return name + ".css";
}

/** The proxy-module output name for a module source (`x.module.scss` →
 * `x.module.js`) — what the `.module.*` import resolves to (option B). */
export function moduleJsName(name: string): string {
  return name.replace(/\.module\.(scss|sass|css)$/i, ".module.js");
}

/** The plain-CSS output name for a non-module Sass source (`x.scss` → `x.css`). */
export function plainCssName(name: string): string {
  return name.replace(/\.(scss|sass)$/i, ".css");
}

/** Kebab → camel, matching css-modules `localsConvention: camelCase`
 * (`header-bar` → `headerBar`). */
export function camelCase(key: string): string {
  return key.replace(/-([a-z0-9])/gi, (_, c: string) => c.toUpperCase());
}

/**
 * Adapt lightningcss's css-modules `exports` — nested, kebab-cased
 * `{ "header-bar": { name, composes, … } }` — to the flat, camelCased value map
 * dylan-style consumers expect: `{ headerBar: "<scoped>" }`. `composes` is
 * unused (0 across dylan's modules); the compose chain would prepend classes
 * here if it were.
 */
export function adaptExports(exports: Record<string, ILightningExport> | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [local, info] of Object.entries(exports ?? {})) {
    map[camelCase(local)] = info.name;
  }
  return map;
}

/**
 * The proxy module for a css-module import: a side-effect import of the scoped
 * CSS (so esbuild concatenates it, in graph order) plus the value map as the
 * default export (the class-name bindings). `cssImport` is the sibling scoped
 * CSS by relative name (`./x.module.css`).
 */
export function proxyModule(cssImport: string, valueMap: Record<string, string>): string {
  return `import ${JSON.stringify(cssImport)};\nexport default ${JSON.stringify(valueMap)};\n`;
}

/** Write a file, creating parent directories as needed. */
function writeOut(outdir: string, rel: string, contents: string | Uint8Array): void {
  const dest = path.join(outdir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, contents);
}

/**
 * Attribute a tool failure to the file being lowered. The driver processes
 * every styled source in one run, and neither sass nor lightningcss names the
 * input in the error it throws — so an unattributed failure leaves the reader
 * bisecting by hand (and reading whichever file the last *warning* happened to
 * mention, which is worse than nothing). Where the tool reported a position
 * inside the file, keep it.
 */
interface ISourceMap {
  mappings: string;
  sources: string[];
}

const VLQ_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * The original position for a generated one, from a source map's `mappings`.
 * Decoding is a few lines of base64-VLQ, which beats taking a dependency into
 * the driver's staged install for one lookup. Segments are
 * `[genCol, sourceIndex, origLine, origCol]` (deltas), grouped by generated
 * line with `;` and by segment with `,`; the nearest segment at or before the
 * generated column wins. Returns undefined when the line has no mapping.
 */
function originalPosition(map: ISourceMap, line: number, column: number): { source: string; line: number; column: number } | undefined {
  const state = { source: 0, origLine: 0, origCol: 0 };
  const lines = map.mappings.split(";");
  let found: { source: string; line: number; column: number } | undefined;
  for (let generated = 0; generated < lines.length && generated < line; generated++) {
    let genCol = 0;
    for (const segment of lines[generated].split(",").filter(Boolean)) {
      const fields: number[] = [];
      let value = 0;
      let shift = 0;
      for (const ch of segment) {
        const digit = VLQ_CHARS.indexOf(ch);
        value += (digit & 31) << shift;
        if (digit & 32) {
          shift += 5;
          continue;
        }
        fields.push(value & 1 ? -(value >> 1) : value >> 1);
        value = 0;
        shift = 0;
      }
      genCol += fields[0] ?? 0;
      if (fields.length >= 4) {
        state.source += fields[1];
        state.origLine += fields[2];
        state.origCol += fields[3];
        /* Generated lines are 0-based here, the reported one 1-based. */
        if (generated === line - 1 && genCol <= column) {
          found = { source: map.sources[state.source] ?? "", line: state.origLine + 1, column: state.origCol + 1 };
        }
      }
    }
  }
  return found;
}

function stageFailure(rel: string, stage: string, err: unknown, sourceMap?: ISourceMap): Error {
  const reported = err as { message?: string; loc?: { line?: number; column?: number } };
  const line = reported?.loc?.line;
  /* lightningcss reports against the CSS it was handed, which for a scss input
   * is sass's output — so map back before showing a position the reader could
   * otherwise not find in their file. */
  const original = line !== undefined && sourceMap ? originalPosition(sourceMap, line, reported.loc?.column ?? 0) : undefined;
  const at =
    original !== undefined
      ? `${rel}:${original.line}:${original.column}`
      : line === undefined
        ? rel
        : `${rel}:${line}:${reported.loc?.column ?? 0} (in the generated CSS)`;
  return new Error(`${at}: ${stage}: ${reported?.message ?? String(err)}`);
}

/**
 * Lower one styled source to its output(s), co-located at the source's relative
 * path under `outdir`. Sass leads (lightningcss can't read scss); a module is
 * then scoped and gets its proxy; a plain .css passes through.
 */
async function lowerFile(
  rel: string,
  options: ICssOptions,
  compiler: ISassCompiler,
  lightningcss: ILightning
): Promise<void> {
  const inputPath = path.join(options.srcRoot, rel);

  // Stage 1 — sass (or read a plain .css verbatim). loadedUrls is available on
  // `result` for future discovered-deps; intentionally unused for now.
  let css: Uint8Array;
  /* Kept so a css-modules failure can be reported against the SCSS the user
   * wrote rather than the CSS sass produced from it. */
  let sourceMap: ISourceMap | undefined;
  if (isSass(rel)) {
    try {
      const result = await compiler.compileAsync(inputPath, { loadPaths: options.loadPaths, sourceMap: true });
      css = Buffer.from(result.css, "utf8");
      sourceMap = result.sourceMap;
    } catch (err) {
      throw stageFailure(rel, "sass", err);
    }
  } else {
    css = fs.readFileSync(inputPath);
  }

  if (!isModule(rel)) {
    // Plain stylesheet: sass output (or passthrough .css) is the result.
    writeOut(options.outdir, isSass(rel) ? plainCssName(rel) : rel, css);
    return;
  }

  // Stage 2 — css-modules scope. One lightningcss call yields scoped CSS + the
  // exports map (they agree by construction). The proxy carries both the scoped
  // CSS (side-effect) and the value map (default export).
  let scoped: ILightningResult;
  try {
    scoped = lightningcss.transform({ filename: rel, code: css, cssModules: true });
  } catch (err) {
    throw stageFailure(rel, "css-modules", err, sourceMap);
  }
  const cssRel = moduleCssName(rel);
  writeOut(options.outdir, cssRel, scoped.code);
  const valueMap = adaptExports(scoped.exports);
  writeOut(options.outdir, moduleJsName(rel), proxyModule("./" + path.basename(cssRel), valueMap));
}

function parseManifestPath(argv: string[]): string {
  const flag = argv.find(arg => arg.startsWith("--manifest="));
  if (!flag) {
    throw new Error("css-driver: missing --manifest=<path>");
  }
  return flag.substring("--manifest=".length);
}

export async function main(argv: string[]): Promise<void> {
  // Both tools are fetched at build time and mounted in this step's
  // node_modules, so they are required (not imported) — their types are not
  // available to compile.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sass = require("sass-embedded") as ISass;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const lightningcss = require("lightningcss") as ILightning;

  const options = JSON.parse(fs.readFileSync(parseManifestPath(argv), "utf8")) as ICssOptions;
  const compiler = await sass.initAsyncCompiler();
  try {
    // Sequential for now — correctness first; the warm compiler already
    // amortizes startup. Concurrency is a later throughput tweak.
    for (const rel of options.files) {
      await lowerFile(rel, options, compiler, lightningcss);
    }
  } finally {
    await compiler.dispose();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
