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
 * The fabr projects the editor's TypeScript servers are to show, as the
 * extension records them: a registry naming one document per project. The
 * wrapper and the plugin shim run in one tsserver process and read the
 * registry through this module, so they share what it last read.
 */

import type { ITypeScriptUnit } from "@fabr-build/js-tools";
import * as fs from "fs";
import * as path from "path";
import type { Links } from "./Overlay";

/** The version of the registry and project documents this module reads. */
export const DOCUMENT_VERSION = 1;

/** A fabr project, as its editor's TypeScript server is shown it. */
export interface IProjectDocument {
  /** The project's root: every path below it is the project's. */
  root: string;
  /** Virtual path → real path, laid over the filesystem (see Overlay). */
  links: Links;
  /** The project's compilation units. */
  units: ITypeScriptUnit[];
  /** The module implementing the project's tsserver plugin, from the
   * project's own fabr. */
  plugin: string;
}

/** The registry as last read: its documents, every link they lay, and every unit's root. */
interface IRegistryState {
  projects: IProjectDocument[];
  links: Links;
  roots: string[];
}

let state: IRegistryState = { projects: [], links: new Map(), roots: [] };

/** The names tsserver finds a project's config by. */
const CONFIG_NAMES = new Set(["tsconfig.json", "jsconfig.json"]);

/**
 * @return true if `file` is a config a unit's own config masks: a real
 * `tsconfig.json` or `jsconfig.json` at or below a unit's root that no link
 * serves, otherwise false. The files beneath a unit's root are the unit's.
 */
export function isMaskedConfig(file: string): boolean {
  if (!CONFIG_NAMES.has(path.basename(file)) || state.links.has(file)) {
    return false;
  }
  const dir = path.dirname(file);
  return state.roots.some(root => dir === root || dir.startsWith(root + path.sep));
}

/** @return every link the registered projects lay. */
export function currentLinks(): Links {
  return state.links;
}

/** @return the registered projects. */
export function registeredProjects(): readonly IProjectDocument[] {
  return state.projects;
}

/** @return the project whose root holds `file`, the innermost where roots nest, or undefined if none does. */
export function projectOf(file: string): IProjectDocument | undefined {
  return state.projects
    .filter(project => file === project.root || file.startsWith(project.root + path.sep))
    .sort((a, b) => b.root.length - a.root.length)[0];
}

/**
 * Read the registry at `file` and the documents it names, replacing what was
 * read before. A document that cannot be read leaves its project out.
 *
 * @return the problems found, one line each.
 */
export function readRegistry(file: string): string[] {
  const problems: string[] = [];
  let names: string[] = [];
  try {
    names = toRegistry(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (err) {
    problems.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const projects: IProjectDocument[] = [];
  for (const name of names) {
    try {
      projects.push(toProjectDocument(JSON.parse(fs.readFileSync(name, "utf8"))));
    } catch (err) {
      problems.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  state = {
    projects,
    links: new Map(projects.flatMap(project => [...project.links])),
    roots: projects.flatMap(project => project.units.map(unit => unit.root)),
  };
  return problems;
}

/** How long a writer holds the registry's lock before another takes it as abandoned. */
const STALE_LOCK_MS = 10_000;
/** How long a writer waits for the registry's lock before writing without it. */
const LOCK_WAIT_MS = 2_000;

/** Write `text` to `file` whole: to a temporary beside it, renamed over it. */
export function writeAtomically(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text);
  fs.renameSync(temporary, file);
}

/** @return the documents the registry at `file` lists, or none where it is unreadable. */
export function registeredDocuments(file: string): string[] {
  try {
    const { projects } = JSON.parse(fs.readFileSync(file, "utf8")) as { projects?: unknown };
    return Array.isArray(projects) ? projects.filter((name): name is string => typeof name === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Rewrite the registry at `file` through `change` of the documents it lists,
 * one writer at a time across every window: under a lock file beside it,
 * created exclusively, the registry is read and written whole. A lock older
 * than {@link STALE_LOCK_MS} is taken as abandoned; one not had within
 * {@link LOCK_WAIT_MS} is written without.
 */
export function updateRegistry(file: string, change: (names: string[]) => string[]): void {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const held = acquireLock(lock);
  try {
    /* Rewritten even when unchanged: a changed document is announced by the registry changing. */
    writeAtomically(
      file,
      JSON.stringify({ version: DOCUMENT_VERSION, projects: change(registeredDocuments(file)), at: Date.now() }, null, 2)
    );
  } finally {
    if (held) {
      fs.rmSync(lock, { force: true });
    }
  }
}

/** Create the lock file `lock`, waiting for another writer's to go. @return true if it was created, otherwise false. */
function acquireLock(lock: string): boolean {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (const until = Date.now() + LOCK_WAIT_MS; ;) {
    try {
      fs.closeSync(fs.openSync(lock, "wx"));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        return false;
      }
    }
    const since = fs.statSync(lock, { throwIfNoEntry: false });
    if (since !== undefined && Date.now() - since.mtimeMs > STALE_LOCK_MS) {
      fs.rmSync(lock, { force: true });
      continue;
    }
    if (Date.now() >= until) {
      return false;
    }
    Atomics.wait(pause, 0, 0, 10);
  }
}

/** @return the document paths a registry names. */
export function toRegistry(json: unknown): string[] {
  const record = toVersioned(json, "registry");
  if (!Array.isArray(record.projects) || !record.projects.every(name => typeof name === "string")) {
    throw new Error("a registry's projects must be a list of document paths");
  }
  return record.projects;
}

/** @return `json`, a unit's import rewrite rules, each a pattern and its replacement. */
function toRewrites(json: unknown): Array<{ pattern: string; replacement: string }> {
  if (!Array.isArray(json)) {
    throw new Error("a unit's rewrites must be a list");
  }
  return json.map(rule => {
    const fields = (typeof rule === "object" && rule !== null ? rule : {}) as Record<string, unknown>;
    if (typeof fields.pattern !== "string" || typeof fields.replacement !== "string") {
      throw new Error("a unit's rewrite must have a pattern and a replacement");
    }
    return { pattern: fields.pattern, replacement: fields.replacement };
  });
}

/** @return `json`, `what`: a list of names. */
function toNames(json: unknown, what: string): string[] {
  if (!Array.isArray(json) || json.some(name => typeof name !== "string")) {
    throw new Error(`${what} must be a list of names`);
  }
  return json as string[];
}

/** @return the project a project document describes. */
export function toProjectDocument(json: unknown): IProjectDocument {
  const record = toVersioned(json, "project document");
  const text = (value: unknown, what: string): string => {
    if (typeof value !== "string" || !path.isAbsolute(value)) {
      throw new Error(`a project document's ${what} must be an absolute path`);
    }
    return value;
  };
  if (typeof record.links !== "object" || record.links === null || !Array.isArray(record.units)) {
    throw new Error("a project document must have links and units");
  }
  const links = new Map(
    Object.entries(record.links as Record<string, unknown>).map(([from, to]) => [text(from, "link"), text(to, "link target")])
  );
  const units = record.units.map((unit: unknown): ITypeScriptUnit => {
    const fields = (typeof unit === "object" && unit !== null ? unit : {}) as Record<string, unknown>;
    if (fields.package !== undefined && typeof fields.package !== "string") {
      throw new Error("a unit's package must be a name");
    }
    const rewrites = fields.rewrites === undefined ? undefined : toRewrites(fields.rewrites);
    const resources = fields.resources === undefined ? undefined : toNames(fields.resources, "a unit's resources");
    return {
      config: text(fields.config, "unit config"),
      root: text(fields.root, "unit root"),
      table: text(fields.table, "unit table"),
      ...(fields.package === undefined ? {} : { package: fields.package as string }),
      ...(rewrites === undefined ? {} : { rewrites }),
      ...(resources === undefined ? {} : { resources }),
    };
  });
  return { root: text(record.root, "root"), links, units, plugin: text(record.plugin, "plugin") };
}

/** @return `json` as a record, if it is one of this module's `version`. */
function toVersioned(json: unknown, what: string): Record<string, unknown> {
  if (typeof json !== "object" || json === null) {
    throw new Error(`a ${what} must be an object`);
  }
  const record = json as Record<string, unknown>;
  if (record.version !== DOCUMENT_VERSION) {
    throw new Error(`a ${what} of version ${String(record.version)}; this extension reads version ${DOCUMENT_VERSION}`);
  }
  return record;
}
