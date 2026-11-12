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
import picomatch from "picomatch";
import { parse as parseYaml } from "yaml";
import { FabrError, isJsonObject } from "@fabr-build/core";
import { Manifest, readManifest, stringEntries } from "./Manifest";

/** Directories never searched for packages or sources. */
export const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", ".yarn", ".pnpm-store"]);

/** A project as its package manager sees it. */
export interface Workspace {
  /** The project's root directory, absolute. */
  readonly root: string;
  readonly rootManifest: Manifest;
  /** The packages to build: the workspace's packages, or the root alone where
   * the project declares no workspace. */
  readonly packages: ReadonlyArray<Manifest>;
  /** pnpm's catalogs, by name (`default` for `catalog:`), each name -> spec. */
  readonly catalogs: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** The overrides, as written, from every place a package manager reads them. */
  readonly overrides: ReadonlyArray<Override>;
  /** The registry each npm scope is installed from, where it is not the default. */
  readonly scopeRegistries: ReadonlyMap<string, string>;
  /** The default registry, where the project names one other than npm's. */
  readonly registry?: string;
}

/** An override as a package manager states it: a key selecting the
 * requirements it replaces, and the spec it replaces them with. */
export interface Override {
  /** Where it was written (`pnpm-workspace.yaml`, `package.json resolutions`, …). */
  readonly source: string;
  /** The packages leading to the one overridden, outermost first; empty where
   * the override applies wherever the package is required. */
  readonly path: ReadonlyArray<string>;
  /** The package overridden. */
  readonly name: string;
  /** The range of the package's requirements it applies to, where the key states one. */
  readonly range?: string;
  readonly spec: string;
}

const NPM_REGISTRY = /^https?:\/\/registry\.(npmjs\.org|yarnpkg\.com)\/?$/;

/** Read the project rooted at `root`. */
export function readWorkspace(root: string): Workspace {
  if (!fs.existsSync(path.join(root, "package.json"))) {
    throw new FabrError(`${root} has no package.json`);
  }
  const rootManifest = readManifest(root, "");
  const pnpm = readYamlObject(path.join(root, "pnpm-workspace.yaml"));
  const patterns = packagePatterns(rootManifest, pnpm);
  const packages = patterns.length === 0 ? [rootManifest] : findPackages(root, patterns).map(dir => readManifest(root, dir));
  const { scopes, registry } = registries(root, pnpm);
  return {
    root,
    rootManifest,
    packages,
    catalogs: catalogsOf(pnpm, rootManifest),
    overrides: overridesOf(rootManifest, pnpm),
    scopeRegistries: scopes,
    ...(registry === undefined ? {} : { registry }),
  };
}

/** @return the YAML document in `file` where it is an object, otherwise undefined. */
function readYamlObject(file: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(file)) {
    return undefined;
  }
  const doc: unknown = parseYaml(fs.readFileSync(file, "utf8"));
  return isJsonObject(doc) ? doc : undefined;
}

/** @return the strings among `value` where it is an array, otherwise an empty array. */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : [];
}

/** @return the workspace package directory patterns the root manifest or pnpm-workspace.yaml state. */
function packagePatterns(rootManifest: Manifest, pnpm: Record<string, unknown> | undefined): string[] {
  const workspaces = rootManifest.json.workspaces;
  return [
    ...strings(workspaces),
    ...(isJsonObject(workspaces) ? strings(workspaces.packages) : []),
    ...(pnpm === undefined ? [] : strings(pnpm.packages)),
  ];
}

/** Find the directories under `root` holding a `package.json` that `patterns`
 * select (a `!` pattern excluding), sorted. */
function findPackages(root: string, patterns: string[]): string[] {
  const normalize = (pattern: string): string => pattern.replace(/^\.\//, "").replace(/\/$/, "");
  const included = patterns.filter(p => !p.startsWith("!")).map(p => picomatch(normalize(p), { dot: true }));
  const excluded = patterns.filter(p => p.startsWith("!")).map(p => picomatch(normalize(p.slice(1)), { dot: true }));
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (excluded.some(match => match(rel) || match(`${rel}/`))) {
        continue;
      }
      if (fs.existsSync(path.join(root, rel, "package.json")) && included.some(match => match(rel))) {
        found.push(rel);
      }
      walk(rel);
    }
  };
  walk("");
  return found.sort();
}

/** @return pnpm's catalogs: `catalog:` and `catalogs:` in pnpm-workspace.yaml
 * and in the root manifest's `pnpm` field, the manifest's replacing a catalog
 * of the same name. */
function catalogsOf(pnpm: Record<string, unknown> | undefined, rootManifest: Manifest): Map<string, ReadonlyMap<string, string>> {
  const catalogs = new Map<string, ReadonlyMap<string, string>>();
  for (const source of [pnpm, isJsonObject(rootManifest.json.pnpm) ? rootManifest.json.pnpm : undefined]) {
    if (source === undefined) {
      continue;
    }
    if (isJsonObject(source.catalog)) {
      catalogs.set("default", stringEntries(source.catalog));
    }
    if (isJsonObject(source.catalogs)) {
      for (const [name, entries] of Object.entries(source.catalogs)) {
        catalogs.set(name, stringEntries(entries));
      }
    }
  }
  return catalogs;
}

/** Split a written override key into the packages it is scoped through and
 * the one it overrides, with any range it is qualified by. `separator` is
 * the package manager's: pnpm's `>`, yarn's `/` (where `**` matches any
 * chain). */
export function parseOverrideKey(key: string, separator: ">" | "/"): { path: string[]; name: string; range?: string } {
  const names: string[] = [];
  const parts = separator === ">" ? key.split(/>(?=[@A-Za-z0-9])/) : key.split("/");
  for (let at = 0; at < parts.length; at++) {
    const part = parts[at];
    if (separator === "/" && part.startsWith("@") && at + 1 < parts.length && !part.slice(1).includes("@")) {
      names.push(`${part}/${parts[++at]}`);
    } else {
      names.push(part);
    }
  }
  const last = names.pop()!;
  /* A range follows the name's own `@` (never a scope's, which leads it). */
  const at = last.indexOf("@", 1);
  const name = at < 0 ? last : last.slice(0, at);
  const range = at < 0 ? undefined : last.slice(at + 1);
  return { path: names, name, ...(range === undefined || range === "" ? {} : { range }) };
}

/** Collect every override the project writes: pnpm's (pnpm-workspace.yaml or
 * the manifest's `pnpm.overrides`), yarn's `resolutions` and npm's `overrides`. */
function overridesOf(rootManifest: Manifest, pnpm: Record<string, unknown> | undefined): Override[] {
  const overrides: Override[] = [];
  const pnpmBlocks: Array<[string, unknown]> = [
    ["pnpm-workspace.yaml overrides", pnpm?.overrides],
    ["package.json pnpm.overrides", isJsonObject(rootManifest.json.pnpm) ? rootManifest.json.pnpm.overrides : undefined],
  ];
  for (const [source, block] of pnpmBlocks) {
    for (const [key, spec] of stringEntries(block)) {
      overrides.push({ source, ...parseOverrideKey(key, ">"), spec });
    }
  }
  for (const [key, spec] of stringEntries(rootManifest.json.resolutions)) {
    const parsed = parseOverrideKey(key, "/");
    /* `**` is any chain, so `**\/pkg` scopes nothing. */
    const chain = parsed.path.filter(each => each !== "**");
    overrides.push({ source: "package.json resolutions", ...parsed, path: chain, spec });
  }
  const npmOverrides = (block: unknown, path: string[]): void => {
    if (!isJsonObject(block)) {
      return;
    }
    for (const [key, value] of Object.entries(block)) {
      const parsed = parseOverrideKey(key, ">");
      if (typeof value === "string") {
        if (key === ".") {
          /* `"pkg": { ".": "1.0.0", … }` overrides pkg itself. */
          const owner = path[path.length - 1];
          if (owner !== undefined) {
            overrides.push({ source: "package.json overrides", path: path.slice(0, -1), name: owner, spec: value });
          }
        } else {
          overrides.push({
            source: "package.json overrides",
            path,
            name: parsed.name,
            ...(parsed.range ? { range: parsed.range } : {}),
            spec: value,
          });
        }
      } else {
        npmOverrides(value, [...path, parsed.name]);
      }
    }
  };
  npmOverrides(rootManifest.json.overrides, []);
  return overrides;
}

/** Read the registries the project installs from: `.npmrc`'s `registry` and
 * `@scope:registry`, pnpm-workspace.yaml's `registries`, and `.yarnrc.yml`'s
 * `npmRegistryServer` and `npmScopes`, each replacing what the ones before it
 * set. The default registry is left out where it is npm's. */
function registries(root: string, pnpm: Record<string, unknown> | undefined): { scopes: Map<string, string>; registry?: string } {
  const scopes = new Map<string, string>();
  let registry: string | undefined;
  const npmrc = path.join(root, ".npmrc");
  if (fs.existsSync(npmrc)) {
    for (const line of fs.readFileSync(npmrc, "utf8").split(/\r?\n/)) {
      const scoped = /^\s*(@[^:\s]+):registry\s*=\s*(\S+)\s*$/.exec(line);
      const plain = /^\s*registry\s*=\s*(\S+)\s*$/.exec(line);
      if (scoped) {
        scopes.set(scoped[1], scoped[2]);
      } else if (plain) {
        registry = plain[1];
      }
    }
  }
  for (const [key, url] of stringEntries(pnpm?.registries)) {
    if (key === "default") {
      registry = url;
    } else if (key.startsWith("@")) {
      scopes.set(key, url);
    }
  }
  const yarnrc = readYamlObject(path.join(root, ".yarnrc.yml"));
  if (typeof yarnrc?.npmRegistryServer === "string") {
    registry = yarnrc.npmRegistryServer;
  }
  if (isJsonObject(yarnrc?.npmScopes)) {
    for (const [scope, config] of Object.entries(yarnrc.npmScopes)) {
      if (isJsonObject(config) && typeof config.npmRegistryServer === "string") {
        scopes.set(`@${scope.replace(/^@/, "")}`, config.npmRegistryServer);
      }
    }
  }
  return { scopes, ...(registry === undefined || NPM_REGISTRY.test(registry) ? {} : { registry }) };
}
