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

import * as fs from "fs";
import * as path from "path";
import { parseAllDocuments, parse as parseYaml } from "yaml";
import { isJsonObject, parseJson, parseVersion } from "@fabr-build/core";
import { parseSpec } from "./Spec";

/** What a lockfile records: the versions installed of each package, by the
 * name the registry publishes it under. */
export interface Lockfile {
  /** The lockfile's name, relative to the project root. */
  readonly file: string;
  readonly versions: ReadonlyMap<string, ReadonlySet<string>>;
}

/** The lockfiles read, in the order they are looked for. */
const LOCKFILES: ReadonlyArray<[string, (text: string) => Map<string, Set<string>>]> = [
  ["pnpm-lock.yaml", readPnpmLock],
  ["yarn.lock", readYarnLock],
  ["package-lock.json", readNpmLock],
  ["npm-shrinkwrap.json", readNpmLock],
];

/** Read the project's lockfile, or undefined where it has none. */
export function readLockfile(root: string): Lockfile | undefined {
  for (const [file, read] of LOCKFILES) {
    const location = path.join(root, file);
    if (fs.existsSync(location)) {
      return { file, versions: read(fs.readFileSync(location, "utf8")) };
    }
  }
  return undefined;
}

/** Record `version` of `name`, where it is a semver version. */
function record(versions: Map<string, Set<string>>, name: string, version: string): void {
  try {
    parseVersion(version);
  } catch {
    return;
  }
  const held = versions.get(name) ?? new Set();
  versions.set(name, held.add(version));
}

/** Split `name@version` at the version's `@` (never a scope's). */
function splitAtVersion(key: string): [string, string] | undefined {
  const at = key.lastIndexOf("@");
  return at > 0 ? [key.slice(0, at), key.slice(at + 1)] : undefined;
}

/**
 * Read a pnpm lockfile: each `packages` key names a package and its version —
 * `name@1.2.3` (v9), `/name@1.2.3(peer@2.0.0)` (v6-v8), `/name/1.2.3_peer@2.0.0` (v5).
 * pnpm 10 writes its config dependencies as a document of their own before
 * the lockfile's.
 */
export function readPnpmLock(text: string): Map<string, Set<string>> {
  const versions = new Map<string, Set<string>>();
  for (const document of parseAllDocuments(text)) {
    const doc: unknown = "toJS" in document ? document.toJS() : undefined;
    if (!isJsonObject(doc) || !isJsonObject(doc.packages)) {
      continue;
    }
    for (const key of Object.keys(doc.packages)) {
      const bare = key.replace(/^\//, "").replace(/\(.*$/, "");
      /* v5's `name/1.2.3`, its peers after a `_` (`foo/1.2.3_bar@2.0.0`). */
      const v5 = /^((?:@[^/]+\/)?[^/@]+)\/([^/_]+)(?:_.*)?$/.exec(bare);
      const split = v5 !== null ? ([v5[1], v5[2]] as [string, string]) : splitAtVersion(bare);
      if (split !== undefined) {
        record(versions, ...split);
      }
    }
  }
  return versions;
}

/** Read a yarn lockfile, berry's (YAML, with `__metadata`) or classic's. */
export function readYarnLock(text: string): Map<string, Set<string>> {
  return /^__metadata:/m.test(text) ? readBerryLock(text) : readClassicYarnLock(text);
}

/** Read yarn berry's lockfile: each entry's `resolution` is `name@npm:1.2.3`, or a patch of one (`name@patch:name@npm%3A1.2.3#…`). */
function readBerryLock(text: string): Map<string, Set<string>> {
  const versions = new Map<string, Set<string>>();
  const doc: unknown = parseYaml(text);
  if (!isJsonObject(doc)) {
    return versions;
  }
  for (const [key, entry] of Object.entries(doc)) {
    if (key === "__metadata" || !isJsonObject(entry) || typeof entry.resolution !== "string") {
      continue;
    }
    const patch = entry.resolution.indexOf("@patch:", 1);
    if (patch > 0) {
      const patched = parseSpec(entry.resolution.slice(0, patch), entry.resolution.slice(patch + 1));
      if (patched.kind === "registry") {
        record(versions, patched.packageName, patched.range);
      }
      continue;
    }
    const at = entry.resolution.lastIndexOf("@npm:");
    if (at > 0) {
      record(versions, entry.resolution.slice(0, at), entry.resolution.slice(at + "@npm:".length));
    }
  }
  return versions;
}

/**
 * Read yarn classic's lockfile: an unindented header lists the specs an entry
 * answers (`"a@^1.0.0", a@^1.2.0:`), and its indented `version` line the
 * version installed. An aliased spec (`alias@npm:real@^1`) names the real
 * package after `npm:`.
 */
function readClassicYarnLock(text: string): Map<string, Set<string>> {
  const versions = new Map<string, Set<string>>();
  let name: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.length > 0 && !/^[\s#]/.test(line) && line.endsWith(":")) {
      const first = line.slice(0, -1).split(/,\s*/)[0].replace(/^"|"$/g, "");
      const alias = first.indexOf("@npm:");
      const spec = alias > 0 ? first.slice(alias + "@npm:".length) : first;
      name = splitAtVersion(spec)?.[0];
    } else if (name !== undefined) {
      const version = /^\s+version:?\s+"?([^"\s]+)"?\s*$/.exec(line);
      if (version) {
        record(versions, name, version[1]);
        name = undefined;
      }
    }
  }
  return versions;
}

/** Read an npm lockfile: `packages` (v2, v3), keyed by install path, or the
 * nested `dependencies` of v1. A link (a workspace package) records nothing. */
export function readNpmLock(text: string): Map<string, Set<string>> {
  const versions = new Map<string, Set<string>>();
  const doc = parseJson(text, "package-lock.json", json => json);
  if (!isJsonObject(doc)) {
    return versions;
  }
  if (isJsonObject(doc.packages)) {
    for (const [key, entry] of Object.entries(doc.packages)) {
      const at = key.lastIndexOf("node_modules/");
      if (at < 0 || !isJsonObject(entry) || entry.link === true || typeof entry.version !== "string") {
        continue;
      }
      record(versions, typeof entry.name === "string" ? entry.name : key.slice(at + "node_modules/".length), entry.version);
    }
    return versions;
  }
  const walk = (dependencies: unknown): void => {
    if (!isJsonObject(dependencies)) {
      return;
    }
    for (const [name, entry] of Object.entries(dependencies)) {
      if (isJsonObject(entry) && typeof entry.version === "string") {
        const alias = /^npm:(.+)$/.exec(entry.version);
        const split = alias ? splitAtVersion(alias[1]) : undefined;
        record(versions, split?.[0] ?? name, split?.[1] ?? entry.version);
        walk(entry.dependencies);
      }
    }
  };
  walk(doc.dependencies);
  return versions;
}
