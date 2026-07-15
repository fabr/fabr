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
 *    NOT wired yet (a later graph position; see DESIGN-css-pipeline.md).
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
}
interface ISassCompiler {
  compileAsync(path: string, options?: { loadPaths?: string[] }): Promise<ISassResult>;
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
  if (isSass(rel)) {
    const result = await compiler.compileAsync(inputPath, { loadPaths: options.loadPaths });
    css = Buffer.from(result.css, "utf8");
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
  const scoped = lightningcss.transform({ filename: rel, code: css, cssModules: true });
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

  // TEMP DEBUG
  try {
    process.stderr.write("DEBUG tool node_modules: " + fs.readdirSync(path.join(__dirname, "node_modules")).join(", ") + "\n");
  } catch (e) {
    process.stderr.write("DEBUG no tool node_modules: " + String(e) + "\n");
  }

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
