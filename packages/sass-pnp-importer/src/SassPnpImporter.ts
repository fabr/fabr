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
 * A Sass `Importer` that loads package stylesheets through a Plug'n'Play
 * dependency table (https://yarnpkg.com/advanced/pnp-spec), using only the
 * public PnP runtime API.
 *
 * A package load (`@use "pkg/colors"`, or `pkg:pkg/colors`) is resolved from
 * the file that wrote it: which package the name means is the table's answer
 * for that file, and what the subpath means follows dart-sass's own
 * `NodePackageImporter` — the package's `exports` under the `sass`/`style`
 * conditions as a first choice, then its `sass`/`style` fields for the root,
 * then Sass's ordinary partial/index/extension search inside the package.
 * Relative loads from a stylesheet this importer served come back to it and
 * are searched the same way.
 *
 * Files are named by the path the table locates them at — a PnP virtual path
 * where a package is wired more than one way — so a nested load resolves from
 * the right wiring; they are read at their physical path.
 *
 * The importer reads through node's `fs`, so under Yarn (whose runtime patches
 * `fs`) packages inside zip archives load too.
 */

import * as fs from "node:fs";
import Module from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** A PnP package locator; `name` is null for the top-level package. */
export interface IPnpLocator {
  name: string | null;
  reference: string | null;
}

/** As much of the PnP runtime API (Yarn's `pnpapi`) as the importer uses. */
export interface IPnpApi {
  findPackageLocator(location: string): IPnpLocator | null;
  getPackageInformation(locator: IPnpLocator): { packageLocation: string; linkType: string } | null;
  resolveToUnqualified(request: string, issuer: string | null, opts?: { considerBuiltins?: boolean }): string | null;
  resolveRequest(
    request: string,
    issuer: string | null,
    opts?: { considerBuiltins?: boolean; extensions?: string[]; conditions?: Set<string> }
  ): string | null;
  resolveVirtual?(path: string): string | null;
}

/** The context Sass canonicalizes a load in. */
export interface ISassCanonicalizeContext {
  fromImport: boolean;
  containingUrl: URL | null;
}

/** A stylesheet as the importer hands it to Sass. */
export interface ISassImporterResult {
  contents: string;
  syntax: "scss" | "indented" | "css";
  sourceMapUrl?: URL;
}

/** A synchronous Sass `Importer`, as `sass` and `sass-embedded` accept one. */
export interface ISassImporter {
  nonCanonicalScheme?: string | string[];
  canonicalize(url: string, context: ISassCanonicalizeContext): URL | null;
  load(canonicalUrl: URL): ISassImporterResult | null;
}

export interface ISassPnpImporterOptions {
  /** The table to resolve through. By default, the one governing each loading
   * file, as node's `module.findPnpApi` finds it — which exists only in a
   * process running under Yarn's PnP runtime; elsewhere, pass one. */
  pnpApi?: IPnpApi;
  /** Where a load with no containing file (a compiled string) is resolved
   * from. Defaults to the working directory. */
  entryPointDirectory?: string;
}

/** The conditions a stylesheet load resolves `exports` under. */
const CONDITIONS = new Set(["sass", "style"]);

/** The package fields naming a stylesheet entry point, in dart-sass's order. */
const FIELDS = ["sass", "style"];

const EXTENSIONS = [".scss", ".sass", ".css"];

export function sassPnpImporter(options: ISassPnpImporterOptions = {}): ISassImporter {
  const apiFor = (file: string): IPnpApi | null => options.pnpApi ?? findPnpApi(file);
  const entry = withSeparator(path.resolve(options.entryPointDirectory ?? process.cwd()));
  return {
    /* Declared so that Sass hands a `pkg:` load the file that wrote it. */
    nonCanonicalScheme: "pkg",
    canonicalize(url: string, context: ISassCanonicalizeContext): URL | null {
      if (url.startsWith("file:")) {
        const file = fileURLToPath(url);
        const api = apiFor(file);
        if (api === null || !inPackage(api, file)) {
          return null;
        }
        const found = resolveImportPath(api, file, context.fromImport);
        return found === null ? null : pathToFileURL(found);
      }
      const specifier = url.startsWith("pkg:") ? url.slice("pkg:".length) : url;
      if (specifier.startsWith("~")) {
        throw new Error(
          `'${url}' uses the webpack '~' prefix, which Sass does not define — write the package name directly ('${specifier.slice(1)}')`
        );
      }
      const split = splitSpecifier(specifier);
      if (split === undefined) {
        return null;
      }
      const issuer = context.containingUrl?.protocol === "file:" ? fileURLToPath(context.containingUrl) : entry;
      const api = apiFor(issuer);
      if (api === null) {
        return null;
      }
      const found = resolvePackageLoad(api, split, issuer, context.fromImport);
      return found === null ? null : pathToFileURL(found);
    },

    load(canonicalUrl: URL): ISassImporterResult | null {
      const file = fileURLToPath(canonicalUrl);
      const api = apiFor(file);
      const physical = api === null ? file : physicalPath(api, file);
      return { contents: fs.readFileSync(physical, "utf8"), syntax: syntaxOf(file), sourceMapUrl: pathToFileURL(physical) };
    },
  };
}

/** The PnP API node's runtime has registered for `file`, or null outside PnP. */
function findPnpApi(file: string): IPnpApi | null {
  const find = (Module as unknown as { findPnpApi?: (lookup: string) => IPnpApi | null }).findPnpApi;
  return find === undefined ? null : find(file);
}

/**
 * A bare package specifier split into the package it names and the subpath
 * within it — one segment deeper for a scoped name. Anything else (a relative
 * or rooted path, a URL with another scheme) names no package.
 */
function splitSpecifier(specifier: string): { name: string; subpath: string } | undefined {
  if (specifier === "" || specifier.startsWith(".") || specifier.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(specifier)) {
    return undefined;
  }
  const segments = specifier.split("/");
  const depth = specifier.startsWith("@") ? 2 : 1;
  if (segments.length < depth || segments.slice(0, depth).some(segment => segment === "")) {
    return undefined;
  }
  return { name: segments.slice(0, depth).join("/"), subpath: segments.slice(depth).join("/") };
}

/** Whether `file` lies in an installed package, rather than in the project's
 * own (soft-linked) sources, which Sass loads for itself. */
function inPackage(api: IPnpApi, file: string): boolean {
  const locator = api.findPackageLocator(file);
  return locator !== null && api.getPackageInformation(locator)?.linkType === "HARD";
}

/**
 * The stylesheet a package load names, or null when `issuer` cannot see the
 * package (so the load is left to Sass's load paths).
 */
function resolvePackageLoad(
  api: IPnpApi,
  { name, subpath }: { name: string; subpath: string },
  issuer: string,
  fromImport: boolean
): string | null {
  let location: string | null;
  try {
    location = api.resolveToUnqualified(name, issuer, { considerBuiltins: false });
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "MODULE_NOT_FOUND") {
      return null;
    }
    throw err;
  }
  if (location === null) {
    return null;
  }
  const manifest = readManifest(physicalPath(api, path.join(location, "package.json")));
  if (manifest?.exports !== undefined && manifest.exports !== null) {
    const published = resolveThroughExports(api, name, subpath, issuer);
    if (published !== null) {
      return published;
    }
  }
  if (subpath === "") {
    for (const field of FIELDS) {
      const value = manifest?.[field];
      const found = typeof value === "string" ? resolveImportPath(api, path.join(location, value), fromImport) : null;
      if (found !== null) {
        return found;
      }
    }
  }
  return resolveImportPath(api, subpath === "" ? location : path.join(location, subpath), fromImport);
}

/**
 * The file a package's `exports` map publishes for a stylesheet subpath, as
 * dart-sass tries it: the subpath and its extension and partial variants, then
 * the same for an `index` beneath it — at most one match per round. Null when
 * the map publishes none of them, which leaves the load to the package's
 * directory: for a stylesheet the map is a first choice, not a boundary.
 */
function resolveThroughExports(api: IPnpApi, name: string, subpath: string, issuer: string): string | null {
  const rounds = [subpath === "" ? ["."] : exportVariants(subpath), exportVariants(subpath === "" ? "index" : `${subpath}/index`)];
  for (const candidates of rounds) {
    const matches = [...new Set(candidates.flatMap(candidate => published(api, candidate === "." ? name : `${name}/${candidate}`, issuer)))];
    if (matches.length > 1) {
      throw new Error(`Unable to determine which of multiple potential resolutions found for '${subpath}' in ${name} should be used:\n${list(matches)}`);
    }
    if (matches.length === 1) {
      return matches[0];
    }
  }
  return null;
}

/** The subpaths an exports lookup tries for `subpath`: itself, with each
 * stylesheet extension unless it has one, and each of those as a partial. */
function exportVariants(subpath: string): string[] {
  const plain = EXTENSIONS.includes(path.posix.extname(subpath)) ? [subpath] : [subpath, ...EXTENSIONS.map(extension => `${subpath}${extension}`)];
  if (path.posix.basename(subpath).startsWith("_")) {
    return plain;
  }
  return [...plain, ...plain.map(variant => path.posix.join(path.posix.dirname(variant), `_${path.posix.basename(variant)}`))];
}

/** The file `exports` publishes for `request`, or none where it publishes
 * nothing (or names a file that is not there). */
function published(api: IPnpApi, request: string, issuer: string): string[] {
  try {
    const found = api.resolveRequest(request, issuer, { conditions: CONDITIONS, extensions: [], considerBuiltins: false });
    return found === null ? [] : [found];
  } catch (err: unknown) {
    const { pnpCode, code } = err as { pnpCode?: string; code?: string };
    if (
      (pnpCode === "EXPORTS_RESOLUTION_FAILED" && code === "ERR_PACKAGE_PATH_NOT_EXPORTED") ||
      pnpCode === "QUALIFIED_PATH_RESOLUTION_FAILED"
    ) {
      return [];
    }
    throw err;
  }
}

/**
 * Sass's file search for a load path: an import-only file first under
 * `@import`, then the path with its extension (or each stylesheet extension)
 * and as a partial, then as a directory's `index` — at most one match per
 * step, as Sass requires.
 */
function resolveImportPath(api: IPnpApi, file: string, fromImport: boolean): string | null {
  const extension = path.extname(file);
  if (EXTENSIONS.includes(extension)) {
    const withoutExtension = file.slice(0, -extension.length);
    return (fromImport ? exactlyOne(tryPath(api, `${withoutExtension}.import${extension}`)) : null) ?? exactlyOne(tryPath(api, file));
  }
  return (
    (fromImport ? exactlyOne(tryPathWithExtensions(api, `${file}.import`)) : null) ??
    exactlyOne(tryPathWithExtensions(api, file)) ??
    tryPathAsDirectory(api, file, fromImport)
  );
}

function tryPathWithExtensions(api: IPnpApi, file: string): string[] {
  const found = [...tryPath(api, `${file}.sass`), ...tryPath(api, `${file}.scss`)];
  return found.length > 0 ? found : tryPath(api, `${file}.css`);
}

function tryPath(api: IPnpApi, file: string): string[] {
  return [partial(file), file].filter(candidate => isFile(api, candidate));
}

function tryPathAsDirectory(api: IPnpApi, directory: string, fromImport: boolean): string | null {
  if (!isDirectory(api, directory)) {
    return null;
  }
  return (
    (fromImport ? exactlyOne(tryPathWithExtensions(api, path.join(directory, "index.import"))) : null) ??
    exactlyOne(tryPathWithExtensions(api, path.join(directory, "index")))
  );
}

function exactlyOne(found: string[]): string | null {
  if (found.length > 1) {
    throw new Error(`It's not clear which file to import. Found:\n${list(found)}`);
  }
  return found[0] ?? null;
}

/** `file` as a partial: its name prefixed with `_`. */
function partial(file: string): string {
  return path.join(path.dirname(file), `_${path.basename(file)}`);
}

function list(files: string[]): string {
  return files.map(file => `  ${file}`).join("\n");
}

function isFile(api: IPnpApi, file: string): boolean {
  return statOf(api, file)?.isFile() === true;
}

function isDirectory(api: IPnpApi, directory: string): boolean {
  return statOf(api, directory)?.isDirectory() === true;
}

function statOf(api: IPnpApi, file: string): fs.Stats | undefined {
  try {
    return fs.statSync(physicalPath(api, file));
  } catch {
    return undefined;
  }
}

/** Where a (possibly virtual) path's bytes are. */
function physicalPath(api: IPnpApi, file: string): string {
  return api.resolveVirtual?.(file) ?? file;
}

/** A package's manifest, or null for one that has none or cannot be read —
 * whoever built the package is the one to report that. */
function readManifest(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function syntaxOf(file: string): ISassImporterResult["syntax"] {
  const extension = path.extname(file);
  return extension === ".sass" ? "indented" : extension === ".css" ? "css" : "scss";
}

function withSeparator(directory: string): string {
  return directory.endsWith(path.sep) ? directory : `${directory}${path.sep}`;
}
