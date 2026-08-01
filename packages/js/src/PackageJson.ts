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
 * The package.json *document* — everything about generating, reading, and
 * rewriting one, in one place (the registry *wire* — packument, tarball, publish
 * PUT, platform gates — stays in NPMProtocol). package.json is open-ended by
 * design, so fabr's policy is a **denylist**: it owns the fields it generates,
 * strips the ones that would collide with what it generates (or are dead
 * dev-cruft), and passes everything else — descriptive fields and unknown user
 * extensions — through untouched.
 */

import {
  declPosn,
  FileSet,
  isJsonObject,
  mapEntryOrigin,
  MemoryFile,
  Name,
  NameResolutionError,
  PropertyMap,
  PropertyMapValue,
  Requirement,
} from "@fabr-build/core";
import { binByConvention, JSTarget } from "./JSPackage";
import { NpmPublishIdentity } from "./NPMProtocol";

/** Fields fabr computes from the target itself — a `metadata` key naming one is
 *  rejected (it would be silently overridden), and a seed copy is dropped (fabr
 *  recomputes it for the built layout, so the source's value would be wrong). */
const COMPUTED_FIELDS = new Set(["name", "version", "type", "main", "types", "bin", "dependencies", "peerDependencies"]);

/** Fields stripped from an imported package.json (and rejected in `metadata`):
 *  they collide with what fabr owns — the tarball contents (`files`,
 *  `bundle[d]Dependencies`), dependency resolution (`resolutions`, `overrides`),
 *  publishing (`private`, `publishConfig`) — or are dead build/dev-time cruft
 *  (`devDependencies`, `scripts` incl. the deprecated `postinstall`,
 *  `packageManager`, `workspaces`). Everything not listed here or in
 *  {@link COMPUTED_FIELDS} passes through — package.json is open-ended. */
const STRIPPED_FIELDS = new Set([
  "devDependencies",
  "scripts",
  "files",
  "private",
  "publishConfig",
  "packageManager",
  "workspaces",
  "resolutions",
  "overrides",
  "bundleDependencies",
  "bundledDependencies",
]);

/** package.json fields whose value is a JSON array of strings, so a scalar
 *  `metadata` entry (a string list) serializes as an array — `keywords = build`
 *  → `["build"]` — rather than the joined string other fields get. (os/cpu/libc
 *  are fabr's to compute under native support, but until then a declared value
 *  is carried, as an array.) */
const ARRAY_FIELDS = new Set(["keywords", "os", "cpu", "libc"]);

/**
 * A manifest dependency block (`dependencies`, `optionalDependencies`, …) as a
 * name→constraint map. npm normalizes away anything that isn't an object of
 * strings — `"dependencies": []` is published and means "none" — and so do we:
 * a block that isn't an object, and any entry whose constraint isn't a string,
 * contributes nothing. (Reading them positionally instead would manufacture
 * requirements on packages named `0`, `1`, … that no registry can resolve.)
 */
export function dependencyBlock(block: unknown): Map<string, string> {
  const entries = new Map<string, string>();
  if (isJsonObject(block)) {
    for (const [name, constraint] of Object.entries(block)) {
      if (typeof constraint === "string") {
        entries.set(name, constraint);
      }
    }
  }
  return entries;
}

/** The peers a `peerDependenciesMeta` block marks `optional: true`. */
export function optionalPeers(block: unknown): Set<string> {
  const names = new Set<string>();
  if (isJsonObject(block)) {
    for (const [name, flags] of Object.entries(block)) {
      if (isJsonObject(flags) && flags.optional === true) {
        names.add(name);
      }
    }
  }
  return names;
}

/** The error for a metadata key fabr reserves: attributed through the map's ghost
 *  origin to the written entry — even one that arrived through a shared map — with
 *  any splice/reference hops named in the message. */
function rejectedMetadataKey(key: string, metadata: PropertyMap, reason: string): Error {
  const message = `metadata key '${key}' ${reason}`;
  const origin = mapEntryOrigin(metadata, key);
  if (!origin) {
    return new Error(message);
  }
  const via = origin.via.map(hop => ` (via '${("ref" in hop ? hop.ref : hop.value).toString()}')`).join("");
  return new NameResolutionError(Name.fromLiteral(key), declPosn(origin.entry), undefined, message + via);
}

/** Encode a resolved metadata value as its package.json JSON shape: a scalar
 *  string list becomes an array for an {@link ARRAY_FIELDS} field, else the joined
 *  string; a sub-map becomes an object (`repository`); a list of sub-maps an array
 *  of objects (`maintainers`). Sub-map fields are always scalar strings (npm has no
 *  nested array-of-strings), so nested values join. */
function encodeMetadataValue(value: PropertyMapValue, arrayField: boolean): unknown {
  if (Array.isArray(value)) {
    if (value.every((entry): entry is string => typeof entry === "string")) {
      return arrayField ? [...value] : value.join(" ");
    }
    return (value as PropertyMap[]).map(encodeMap);
  }
  return encodeMap(value);
}

function encodeMap(map: PropertyMap): Record<string, unknown> {
  return Object.fromEntries([...map].map(([key, value]) => [key, encodeMetadataValue(value, false)]));
}

/**
 * Generate the package.json for the built package: the computed identity leads,
 * then the imported seed (minus the stripped/computed fields), then the declared
 * `metadata`, then the fields fabr computes — module type, entry points, the
 * direct package requirements from `deps` (`dependencies`) and `provided_deps`
 * (`peerDependencies`). Computed fields always win; metadata may name neither a
 * computed nor a stripped field.
 */
export function createPackageJson(
  files: FileSet,
  seed: Record<string, unknown> | undefined,
  name: string,
  version: string | undefined,
  declared: (Requirement | undefined)[],
  providedDeclared: (Requirement | undefined)[],
  jsTarget: JSTarget,
  metadata: PropertyMap
): MemoryFile {
  /* The identity leads (the conventional reading order — name, then version), so
   * it is placed before the seed and metadata are copied in; a key keeps its
   * first-placed position, while the computed assignments below still win on value. */
  const packageJson: Record<string, unknown> = Object.assign(Object.create(null), { name });
  if (version !== undefined) {
    packageJson.version = version;
  }
  for (const [key, value] of Object.entries(seed ?? {})) {
    /* Carry an imported field unless fabr owns it (computed, recomputed below) or
     * strips it (collides with what fabr generates, or is dev-only cruft). */
    if (!(key in packageJson) && !COMPUTED_FIELDS.has(key) && !STRIPPED_FIELDS.has(key)) {
      packageJson[key] = value;
    }
  }
  for (const [key, value] of metadata) {
    if (COMPUTED_FIELDS.has(key)) {
      throw rejectedMetadataKey(key, metadata, "is set by fabr and cannot be overridden");
    }
    if (STRIPPED_FIELDS.has(key)) {
      throw rejectedMetadataKey(key, metadata, "is not carried into a published package");
    }
    packageJson[key] = encodeMetadataValue(value, ARRAY_FIELDS.has(key));
  }
  packageJson.type = jsTarget.module === "esm" ? "module" : "commonjs";
  const names = new Set([...files].map(([filename]) => filename));
  if (names.has("index.js")) {
    packageJson.main = "index.js";
  }
  if (names.has("index.d.ts")) {
    packageJson.types = "index.d.ts";
  }

  const bin = binByConvention(files);
  if (bin.size > 0) {
    packageJson.bin = Object.fromEntries(bin);
  }

  const dependencies = packageDependencies(declared);
  if (Object.keys(dependencies).length > 0) {
    packageJson.dependencies = dependencies;
  }
  /* provided_deps → peerDependencies: the host supplies the one shared copy. */
  const peerDependencies = peerDependenciesOf(providedDeclared);
  if (Object.keys(peerDependencies).length > 0) {
    packageJson.peerDependencies = peerDependencies;
  }

  return MemoryFile.from(JSON.stringify(packageJson, undefined, 2) + "\n");
}

/**
 * The direct `dependencies` for the generated package.json — every declared
 * requirement, including `@types/*`. A `@types/*` dep can leak into the shipped
 * `.d.ts` (a node type in an exported signature emits `/// <reference
 * types="node" />`), making it part of the package's public type surface, so a
 * consumer type-checking against us needs it — DefinitelyTyped's own convention
 * (`@types/express` lists `@types/node` under `dependencies`). We don't yet scan
 * the emitted declarations to tell a leaked type dep from a compile-only one, so
 * the safe default is a plain `dependency` (harmless if unused: the consumer
 * dedupes it, and `@types/node` is near-ubiquitous). The version each states is
 * the declaration, not what fabr's joint resolution selected: a published
 * manifest says what the package *requires*, and the consumer resolves it.
 */
function packageDependencies(declared: (Requirement | undefined)[]): Record<string, string> {
  const dependencies: Record<string, string> = {};
  for (const req of declared) {
    if (req) {
      dependencies[req.pkg] = req.constraint;
    }
  }
  return dependencies;
}

/**
 * The `peerDependencies` for the generated package.json — the declared
 * requirements of `provided_deps`. Like `dependencies`, the version stated is the
 * declaration (what the package requires of its host), not what resolution pinned;
 * unlike `dependencies` there is no `@types/*` split — a peer is a runtime peer.
 */
function peerDependenciesOf(providedDeclared: (Requirement | undefined)[]): Record<string, string> {
  const peerDependencies: Record<string, string> = {};
  for (const req of providedDeclared) {
    if (req) {
      peerDependencies[req.pkg] = req.constraint;
    }
  }
  return peerDependencies;
}

/** The dependency-manifest fields whose entries can name a release co-member. */
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/* The manifest fields whose entries the consumer's install actually resolves —
 * where an unresolvable version is fatal. devDependencies deliberately excluded
 * (never installed from a published package). */
const INSTALLED_DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];

/**
 * Rewrite the built manifest for publication: assign the coordinate's name/version,
 * and rewrite any dependency that names a release co-member to that member's
 * assigned version. Returns a fresh object (never mutates the input).
 */
export function rewriteManifest(
  manifest: Record<string, unknown>,
  coordinate: NpmPublishIdentity,
  memberVersions: ReadonlyMap<string, string>
): Record<string, unknown> {
  /* The assigned identity leads (a versionless built manifest has no `version`
   * to overwrite in place — appending it last would read oddly). */
  const result: Record<string, unknown> = Object.assign(Object.create(null), {
    name: coordinate.name,
    version: coordinate.version,
  });
  for (const [key, value] of Object.entries(manifest)) {
    if (!(key in result)) {
      result[key] = value;
    }
  }
  for (const field of DEPENDENCY_FIELDS) {
    const deps = result[field];
    if (isJsonObject(deps)) {
      /* A peerDependency pins exact; the rest take a caret range (see
       * {@link rewriteCoMemberField}). */
      result[field] = rewriteCoMemberField(deps, memberVersions, field === "peerDependencies");
    }
  }
  return result;
}

/**
 * Rewrite one dependency block's co-member entries to the members' assigned
 * versions. A `peerDependencies` entry pins **exact**: a peer is singleton-by-
 * identity (a `provided_deps` peer), so the consumer must supply the EXACT
 * co-member instance the package was built against, not merely a semver-compatible
 * one — a range can't express "the same loaded module". Every other field takes a
 * caret range. (A stable inter-package ABI might later widen the others too; the
 * peer stays exact regardless, since identity-compat is strictly stronger than
 * API-compat.)
 */
function rewriteCoMemberField(
  deps: Record<string, unknown>,
  memberVersions: ReadonlyMap<string, string>,
  exact: boolean
): Record<string, unknown> {
  /* Entries fabr doesn't rewrite are passed through as published, whatever they
   * are — this rewrites a manifest, it doesn't validate one. */
  const rewritten: Record<string, unknown> = { ...deps };
  for (const dep of Object.keys(rewritten)) {
    const memberVersion = memberVersions.get(dep);
    if (memberVersion !== undefined) {
      rewritten[dep] = exact ? memberVersion : `^${memberVersion}`;
    }
  }
  return rewritten;
}

/** The release members this manifest depends on (for deps-first upload ordering). */
export function memberDependencies(manifest: Record<string, unknown>, memberNames: ReadonlySet<string>): string[] {
  const names = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    for (const dep of dependencyBlock(manifest[field]).keys()) {
      if (memberNames.has(dep)) {
        names.add(dep);
      }
    }
  }
  return [...names];
}

/**
 * The install-relevant dependencies of a rewritten manifest that remain
 * unresolvable — a `*` constraint after co-member rewriting. A built-but-versionless
 * dep declares `*` (its version exists only at publish); if the sync doesn't
 * publish it (or publishes it at several versions, so no single rewrite exists),
 * the `*` survives to here — and a published package with an unconstrained
 * dependency is broken for every consumer, so the caller must reject it.
 */
export function unresolvableDependencies(manifest: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const field of INSTALLED_DEPENDENCY_FIELDS) {
    for (const [dep, constraint] of dependencyBlock(manifest[field])) {
      if (constraint === "*") {
        names.push(dep);
      }
    }
  }
  return names;
}
