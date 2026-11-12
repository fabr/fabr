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
 * A project's TypeScript view, composed from the targets its server describes:
 * the project document the tsserver wrapper reads (see tsserver/Registry), and
 * the files it names. Each `typescript` payload names its units; a unit's
 * table locates a fetched package as its compile does — a pool tree at
 * `./.fabr-tree/<tree>/`, rewritten here to be located from the unit's real
 * root — and a package another unit builds at that unit's root, which the
 * unit's config then references, so the editor reads it from source.
 */

import type { ITypeScriptUnit } from "@fabr-build/js-tools";
import * as path from "path";
import { DOCUMENT_VERSION } from "./tsserver/Registry";

/** A described target, as the server serves it. */
export interface IServedTarget {
  id: { uri: string };
  dataKind?: string;
  data?: unknown;
  /** The directory its description's files are in, and the operation it is described under. */
  fabr?: { description?: string; operation?: string };
}

/** fabr's build operation, under which a package's own target is described. */
const BUILD_OPERATION = "build";

/** What a `typescript` payload holds (`@fabr-build/js`'s `ITypeScriptPayload`). */
interface ITypeScriptPayload {
  units: Record<string, string>;
  manifest?: string;
  plugin: string;
}

/** What a unit's `unit.json` holds (`@fabr-build/js`'s `IUnitSummary`). */
interface IUnitSummary {
  root?: string;
  rewrites?: Array<{ pattern: string; replacement: string }>;
  resources?: string[];
  package?: string;
  generated: string[];
}

/** The part of a unit's `.pnp.data.json` composing reads and rewrites; the rest is kept as it is. */
interface IPnpTable {
  packageRegistryData: Array<[string | null, Array<[string | null, { packageLocation: string }]>]>;
}

/** Convert a target's `typescript` data. */
function toTypeScriptPayload(json: unknown): ITypeScriptPayload {
  const payload = toObject(json, "the target's data");
  const { units, manifest, plugin } = payload;
  if (!isObject(units) || Object.values(units).some(dir => typeof dir !== "string")) {
    throw new Error("the target's data names no units");
  }
  if (typeof plugin !== "string" || (manifest !== undefined && typeof manifest !== "string")) {
    throw new Error("the target's data names no plugin");
  }
  return { units: units as Record<string, string>, plugin, ...(manifest === undefined ? {} : { manifest }) };
}

/** Convert a unit's `unit.json`. */
function toUnitSummary(json: unknown): IUnitSummary {
  const { root, rewrites, resources, package: name, generated } = toObject(json, "unit.json");
  const optionalString = (value: unknown): value is string | undefined => value === undefined || typeof value === "string";
  if (
    !optionalString(root) ||
    !optionalString(name) ||
    !isStrings(generated) ||
    (resources !== undefined && !isStrings(resources)) ||
    (rewrites !== undefined &&
      (!Array.isArray(rewrites) ||
        rewrites.some(
          rewrite => !isObject(rewrite) || typeof rewrite.pattern !== "string" || typeof rewrite.replacement !== "string"
        )))
  ) {
    throw new Error("unit.json is not a unit's summary");
  }
  return {
    ...(root === undefined ? {} : { root }),
    ...(rewrites === undefined ? {} : { rewrites: rewrites as IUnitSummary["rewrites"] }),
    ...(resources === undefined ? {} : { resources }),
    ...(name === undefined ? {} : { package: name }),
    generated,
  };
}

/** Convert a unit's `.pnp.data.json`, checking the rows composing reads. */
function toPnpTable(json: unknown): IPnpTable {
  const table = toObject(json, ".pnp.data.json");
  const nameOrNull = (value: unknown): boolean => value === null || typeof value === "string";
  const rows = table.packageRegistryData;
  if (
    !Array.isArray(rows) ||
    rows.some(
      row =>
        !Array.isArray(row) ||
        !nameOrNull(row[0]) ||
        !Array.isArray(row[1]) ||
        row[1].some(
          (entry: unknown) =>
            !Array.isArray(entry) || !nameOrNull(entry[0]) || !isObject(entry[1]) || typeof entry[1].packageLocation !== "string"
        )
    )
  ) {
    throw new Error(".pnp.data.json holds no package registry");
  }
  return table as unknown as IPnpTable;
}

/** Convert a document that must be a JSON object, named `what` in an error. */
function toObject(json: unknown, what: string): Record<string, unknown> {
  if (!isObject(json)) {
    throw new Error(`${what} is not a JSON object`);
  }
  return json;
}

/** @return true if `value` is a JSON object, otherwise false. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @return true if `value` is a list of strings, otherwise false. */
function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

/** The prefix of a pool tree's location, as a unit's table writes it. */
const POOL_PREFIX = "./.fabr-tree/";

/** A unit, read from its description. */
interface IUnit {
  /** Unique within the project: `<target>/<unit>`. */
  key: string;
  name: string;
  /** The operation its target is described under. */
  operation?: string;
  root: string;
  package?: string;
  description: string;
  pool: string;
  summary: IUnitSummary;
  config: Record<string, unknown>;
  table: IPnpTable;
  manifest?: string;
  plugin: string;
}

/** The project document and the files it names, keyed by absolute path. */
export interface IComposedProject {
  document: Record<string, unknown>;
  files: Map<string, string>;
  /** What could not be composed, one line each. */
  problems: string[];
}

/**
 * Compose the TypeScript view of the project at `root` from `targets`, its
 * files written under `storage`; a payload's plugin is resolved from
 * `installation` by `resolve`.
 */
export function composeProject(input: {
  root: string;
  installation: string;
  storage: string;
  targets: readonly IServedTarget[];
  readFile: (file: string) => string;
  resolve: (specifier: string, from: string) => string;
}): IComposedProject {
  const problems: string[] = [];
  const units: IUnit[] = [];
  for (const target of input.targets) {
    const description = target.fabr?.description;
    if (target.dataKind !== "typescript" || description === undefined) {
      continue;
    }
    let payload: ITypeScriptPayload;
    try {
      payload = toTypeScriptPayload(target.data);
    } catch (err) {
      problems.push(`${target.id.uri}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const [name, dir] of Object.entries(payload.units)) {
      const base = path.join(description, dir);
      try {
        const summary = toUnitSummary(JSON.parse(input.readFile(path.join(base, "unit.json"))));
        if (summary.root === undefined) {
          continue;
        }
        units.push({
          key: `${target.id.uri}/${name}`,
          name,
          ...(target.fabr?.operation === undefined ? {} : { operation: target.fabr.operation }),
          root: path.join(input.root, summary.root).replace(/\/$/, ""),
          ...(summary.package === undefined ? {} : { package: summary.package }),
          description: base,
          pool: path.dirname(description),
          summary,
          config: toObject(JSON.parse(input.readFile(path.join(base, "tsconfig.json"))), "tsconfig.json"),
          table: toPnpTable(JSON.parse(input.readFile(path.join(base, ".pnp.data.json")))),
          ...(payload.manifest === undefined ? {} : { manifest: path.join(description, payload.manifest) }),
          plugin: payload.plugin,
        });
      } catch (err) {
        problems.push(`${target.id.uri} ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  /* A package's own unit is the one its target is described with under the build operation. */
  const locals = new Map<string, IUnit>();
  for (const unit of units) {
    if (unit.package !== undefined && unit.operation === BUILD_OPERATION) {
      locals.set(unit.package, unit);
    }
  }
  const files = new Map<string, string>();
  const links = new Map<string, string>();
  const documentUnits: ITypeScriptUnit[] = [];
  /* The units at each root, a build unit first: where several share a root,
   * a solution config there references them, and tsserver gives a file the
   * first that holds it, so a source is judged as its build judges it. */
  const byRoot = new Map<string, IUnit[]>();
  for (const unit of units) {
    byRoot.set(unit.root, [...(byRoot.get(unit.root) ?? []), unit]);
  }
  let index = 0;
  for (const [root, here] of [...byRoot].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    here.sort((a, b) => Number(b.operation === BUILD_OPERATION) - Number(a.operation === BUILD_OPERATION));
    const shared = here.length > 1;
    const configs = here.map((_unit, i) => path.join(root, shared ? `tsconfig.fabr-${i}.json` : "tsconfig.json"));
    if (shared) {
      const solution = path.join(input.storage, "solutions", String(index), "tsconfig.json");
      files.set(
        solution,
        JSON.stringify({ files: [], references: configs.map(config => ({ path: `./${path.basename(config)}` })) }, null, 2) + "\n"
      );
      links.set(path.join(root, "tsconfig.json"), solution);
    }
    here.forEach((unit, i) => {
      const own = path.join(input.storage, String(index++));
      composeUnit(unit, configs[i], own, locals, files, links);
      documentUnits.push({
        config: configs[i],
        root: unit.root,
        table: path.join(own, ".pnp.data.json"),
        ...(unit.package === undefined ? {} : { package: unit.package }),
        ...(unit.summary.rewrites === undefined || unit.summary.rewrites.length === 0 ? {} : { rewrites: unit.summary.rewrites }),
        ...(unit.summary.resources === undefined || unit.summary.resources.length === 0 ? {} : { resources: unit.summary.resources }),
      });
    });
  }
  const specifiers = [...new Set(units.map(unit => unit.plugin))];
  let plugin = "";
  if (specifiers.length > 1) {
    problems.push(`the project's units name different tsserver plugins: ${specifiers.join(", ")}`);
  }
  if (specifiers.length > 0) {
    try {
      plugin = input.resolve(specifiers[0], input.installation);
    } catch (err) {
      problems.push(`cannot resolve ${specifiers[0]} from ${input.installation}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return {
    document: {
      version: DOCUMENT_VERSION,
      root: input.root,
      links: Object.fromEntries([...links].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
      units: documentUnits,
      plugin: plugin || path.join(input.installation, "missing-tsserver-plugin.js"),
    },
    files,
    problems,
  };
}

/**
 * Compose `unit`, shown at `config`, into `files` under `own` and `links`: its
 * table located from its root, a package another unit builds at that unit's
 * root (referenced from its config), its config, its package's manifest and its
 * generated sources linked in.
 */
function composeUnit(
  unit: IUnit,
  config: string,
  own: string,
  locals: ReadonlyMap<string, IUnit>,
  files: Map<string, string>,
  links: Map<string, string>
): void {
  const relative = (to: string): string => {
    const text = path.relative(unit.root, to).split(path.sep).join("/");
    return text === "" ? "./" : `./${text}/`;
  };
  /* A package another unit builds is located at that unit's root already, and
   * is referenced from the unit's config; a pool tree is located from here. */
  const referenced = new Set<string>();
  for (const [name, rows] of unit.table.packageRegistryData) {
    for (const [reference, info] of rows) {
      const local = name === null || reference === "self" ? undefined : locals.get(name);
      if (local !== undefined && local.root !== unit.root) {
        referenced.add(local.root);
      } else if (info.packageLocation.startsWith(POOL_PREFIX)) {
        info.packageLocation = relative(path.join(unit.pool, info.packageLocation.slice(POOL_PREFIX.length)));
      }
    }
  }
  const composed = {
    ...unit.config,
    ...(referenced.size === 0 ? {} : { references: [...referenced].sort().map(root => ({ path: path.relative(unit.root, root) })) }),
  };
  files.set(path.join(own, "tsconfig.json"), JSON.stringify(composed, null, 2) + "\n");
  files.set(path.join(own, ".pnp.data.json"), JSON.stringify(unit.table));
  links.set(config, path.join(own, "tsconfig.json"));
  if (unit.package !== undefined && unit.manifest !== undefined && locals.get(unit.package) === unit) {
    links.set(path.join(unit.root, "package.json"), unit.manifest);
  }
  for (const generated of unit.summary.generated) {
    links.set(path.join(unit.root, generated), path.join(unit.description, "generated", generated));
  }
}
