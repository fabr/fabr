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
import { isJsonObject, parseJson, toJsonObject } from "@fabr-build/core";

/** The dependency blocks of a `package.json` this tool reads. */
export const DEPENDENCY_BLOCKS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
export type DependencyBlock = (typeof DEPENDENCY_BLOCKS)[number];

/** A `package.json` of the project: the root's or a workspace package's. */
export interface Manifest {
  /** The directory holding it, relative to the project root (`""` for the root). */
  readonly dir: string;
  readonly name?: string;
  readonly version?: string;
  /** Each dependency block, name -> spec as written. */
  readonly blocks: ReadonlyMap<DependencyBlock, ReadonlyMap<string, string>>;
  /** The peers `peerDependenciesMeta` marks optional. */
  readonly optionalPeers: ReadonlySet<string>;
  /** The document itself, for the fields a package manager reads off the root
   * (`workspaces`, `overrides`, `resolutions`, `pnpm`). */
  readonly json: Record<string, unknown>;
}

/** @return the string entries of `value` where it is an object, otherwise none. */
export function stringEntries(value: unknown): Map<string, string> {
  const entries = new Map<string, string>();
  if (isJsonObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === "string") {
        entries.set(key, entry);
      }
    }
  }
  return entries;
}

/** Read the `package.json` in `dir`, relative to `root`. */
export function readManifest(root: string, dir: string): Manifest {
  const file = path.join(root, dir, "package.json");
  const json = parseJson(fs.readFileSync(file, "utf8"), path.join(dir, "package.json"), toJsonObject);
  const blocks = new Map(DEPENDENCY_BLOCKS.map(block => [block, stringEntries(json[block])]));
  const meta = isJsonObject(json.peerDependenciesMeta) ? json.peerDependenciesMeta : {};
  const optionalPeers = new Set(
    Object.entries(meta)
      .filter(([, entry]) => isJsonObject(entry) && entry.optional === true)
      .map(([name]) => name)
  );
  return {
    dir,
    ...(typeof json.name === "string" ? { name: json.name } : {}),
    ...(typeof json.version === "string" ? { version: json.version } : {}),
    blocks,
    optionalPeers,
    json,
  };
}

/** @return every dependency `manifest` declares, name -> spec, a peer last. */
export function declaredDependencies(manifest: Manifest): Map<string, string> {
  const all = new Map<string, string>();
  for (const block of DEPENDENCY_BLOCKS) {
    for (const [name, spec] of manifest.blocks.get(block) ?? []) {
      if (!all.has(name)) {
        all.set(name, spec);
      }
    }
  }
  return all;
}
