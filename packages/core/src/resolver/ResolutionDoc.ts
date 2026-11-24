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

import { FabrError } from "../core/Errors";
import { isJsonObject, toStringList } from "../support/Json";
import { MVSResolution, nodeIdOf } from "./MVSResolution";
import { isBuildVersion } from "./Requirement";
import { IRequirementEdge, Requirement, Selected, Violation } from "./Types";

/** One selection (`Selected`) in a persisted resolution document. */
interface IResolutionEntry {
  name: string;
  /** See `Selected.publishedName`; absent where it is `name`. */
  publishedName?: string;
  version: string;
  selectedBy?: IRequirementEdge;
  reachedVia?: IRequirementEdge;
  /** See `Selected.fork`; absent for a selection that is no fork. */
  fork?: number;
}

/** One `Violation` in a persisted resolution document. */
interface IViolationEntry {
  name: string;
  versionConstraint: string;
  requiredBy: string;
  selected: string;
}

/** One raised lower bound (`RaisedFloor`) in a persisted resolution document. */
interface IRaiseEntry {
  name: string;
  versionConstraint: string;
  declared: string;
  raised: string;
  requiredBy: string;
}

/** The requirements one selection declared (see
 * {@link MVSResolution.requirements}). */
interface IRequirementsEntry {
  node: string;
  requires: Requirement[];
}

/** A persisted resolution: the fields of an {@link MVSResolution} but
 * `errors`, with versions written by the domain's `versionToString`. */
export interface IResolutionDoc {
  /** The root requirements resolved, for a reader of the file; reading the
   * document back ignores them. */
  roots: Requirement[];
  selections: IResolutionEntry[];
  violations: IViolationEntry[];
  /** See {@link MVSResolution.coerced}. */
  coerced?: IViolationEntry[];
  /** See {@link MVSResolution.shared}. */
  shared?: IViolationEntry[];
  raises: IRaiseEntry[];
  requirements: IRequirementsEntry[];
  /**
   * {@link MVSResolution.edges} by position: entry `i` is `selections[i]`'s,
   * and each `[name, target]` pair gives the index in `selections` of the
   * selection the dependency `name` binds to.
   */
  edges: [string, number][][];
  /** {@link MVSResolution.rootBindings}, with `null` for a root that binds to
   * nothing. */
  rootBindings: (number | null)[];
}

/** Write `result`, resolved from `roots`, as a resolution document. Throws
 * where one of its edges names no selection. */
export function serializeResolutionDoc<V>(
  roots: Requirement[],
  result: MVSResolution<V>,
  versionToString: (version: V) => string
): IResolutionDoc {
  const violation = (entry: Violation<V>): IViolationEntry => ({
    name: entry.name,
    versionConstraint: entry.versionConstraint,
    requiredBy: entry.requiredBy,
    selected: versionToString(entry.selected),
  });
  /* The index in `selections` of each selection, by node id. */
  const index = new Map<string, number>(result.selections.map((sel, at) => [nodeKey(sel, versionToString), at]));
  return {
    roots,
    selections: result.selections.map(sel => ({
      name: sel.name,
      ...(sel.publishedName === undefined ? {} : { publishedName: sel.publishedName }),
      version: versionToString(sel.version),
      selectedBy: sel.selectedBy,
      reachedVia: sel.reachedVia,
      fork: sel.fork,
    })),
    violations: result.violations.map(violation),
    coerced: result.coerced.map(violation),
    shared: result.shared.map(violation),
    raises: result.raises.map(raise => ({
      name: raise.name,
      versionConstraint: raise.versionConstraint,
      declared: versionToString(raise.declared),
      raised: versionToString(raise.raised),
      requiredBy: raise.requiredBy,
    })),
    /* In the map's order, which is the order of `selections`. */
    requirements: [...result.requirements].map(([node, requires]) => ({ node, requires })),
    edges: result.selections.map(sel => {
      const from = result.edges.get(nodeKey(sel, versionToString)) ?? new Map<string, string>();
      return [...from].map(([name, target]): [string, number] => {
        const at = index.get(target);
        if (at === undefined) {
          throw new Error(`resolution edge ${nodeKey(sel, versionToString)} -> ${target} names no selection`);
        }
        return [name, at];
      });
    }),
    rootBindings: result.rootBindings.map(target => target ?? null),
  };
}

/**
 * Make a copy of `doc` with every build version in it renamed by `rename`:
 * wherever a selection's version, a constraint, a selected, declared or
 * raised version, or the version in a node id is a build's key. Registry
 * versions and the positional tables (`edges`, `rootBindings`) are kept.
 */
export function renameBuildVersions(doc: IResolutionDoc, rename: (build: string) => string): IResolutionDoc {
  const version = (text: string): string => (isBuildVersion(text) ? rename(text) : text);
  const constraint = (text: string | undefined): string | undefined => (text === undefined ? undefined : version(text));
  /* A node id is `<name>@<version>`, and a package name holds an `@` only as
   * its first character. */
  const id = (node: string): string => {
    const at = node.indexOf("@", 1);
    return at < 0 ? node : `${node.slice(0, at + 1)}${version(node.slice(at + 1))}`;
  };
  const edge = (entry: IRequirementEdge | undefined): IRequirementEdge | undefined =>
    entry === undefined ? undefined : { requiredBy: id(entry.requiredBy), versionConstraint: constraint(entry.versionConstraint) };
  const requirement = (req: Requirement): Requirement => ({ ...req, versionConstraint: constraint(req.versionConstraint) });
  const violation = (entry: IViolationEntry): IViolationEntry => ({
    name: entry.name,
    versionConstraint: version(entry.versionConstraint),
    requiredBy: id(entry.requiredBy),
    selected: version(entry.selected),
  });
  return {
    roots: doc.roots.map(requirement),
    selections: doc.selections.map(entry => ({
      ...entry,
      version: version(entry.version),
      ...optional("selectedBy", edge(entry.selectedBy)),
      ...optional("reachedVia", edge(entry.reachedVia)),
    })),
    violations: doc.violations.map(violation),
    ...optional("coerced", doc.coerced?.map(violation)),
    ...optional("shared", doc.shared?.map(violation)),
    raises: doc.raises.map(entry => ({
      name: entry.name,
      versionConstraint: version(entry.versionConstraint),
      declared: version(entry.declared),
      raised: version(entry.raised),
      requiredBy: id(entry.requiredBy),
    })),
    requirements: doc.requirements.map(entry => ({ node: id(entry.node), requires: entry.requires.map(requirement) })),
    edges: doc.edges,
    rootBindings: doc.rootBindings,
  };
}

/** Make the id every per-node table in a resolution is joined by, for `selection`. */
function nodeKey<V>(selection: Selected<V>, versionToString: (version: V) => string): string {
  return nodeIdOf(selection.name, versionToString(selection.version));
}

/** Convert a persisted resolution document, refusing one that is damaged or of another shape. */
export function toResolutionDoc(json: unknown): IResolutionDoc {
  const doc = objectOf(json, "the document");
  const optionalList = <T>(field: string, convert: (item: unknown, what: string) => T): T[] | undefined =>
    doc[field] === undefined ? undefined : listOf(doc[field], field, convert);
  const converted: IResolutionDoc = {
    roots: listOf(doc.roots, "roots", toRequirement),
    selections: listOf(doc.selections, "selections", toResolutionEntry),
    violations: listOf(doc.violations ?? [], "violations", toViolationEntry),
    ...optional("coerced", optionalList("coerced", toViolationEntry)),
    ...optional("shared", optionalList("shared", toViolationEntry)),
    raises: listOf(doc.raises ?? [], "raises", (item, what) => {
      const raise = objectOf(item, what);
      return {
        name: stringOf(raise.name, `${what}.name`),
        versionConstraint: stringOf(raise.versionConstraint, `${what}.versionConstraint`),
        declared: stringOf(raise.declared, `${what}.declared`),
        raised: stringOf(raise.raised, `${what}.raised`),
        requiredBy: stringOf(raise.requiredBy, `${what}.requiredBy`),
      };
    }),
    requirements: listOf(doc.requirements ?? [], "requirements", (item, what) => {
      const entry = objectOf(item, what);
      return { node: stringOf(entry.node, `${what}.node`), requires: listOf(entry.requires, `${what}.requires`, toRequirement) };
    }),
    edges: listOf(doc.edges ?? [], "edges", (from, what) =>
      listOf(from, what, (pair, at): [string, number] => {
        if (!Array.isArray(pair) || pair.length !== 2) {
          throw new FabrError(`${at} is not a [name, index] pair`);
        }
        return [stringOf(pair[0], `${at}[0]`), indexOf(pair[1], `${at}[1]`)];
      })
    ),
    rootBindings: listOf(doc.rootBindings ?? [], "rootBindings", (item, what) => (item === null ? null : indexOf(item, what))),
  };
  const selected = (at: number | null, what: string): void => {
    if (at !== null && at >= converted.selections.length) {
      throw new FabrError(`${what} names selection ${at}, of ${converted.selections.length}`);
    }
  };
  if (converted.edges.length > converted.selections.length) {
    throw new FabrError(`edges has ${converted.edges.length} entries, for ${converted.selections.length} selections`);
  }
  converted.edges.forEach((from, at) => from.forEach(([, target], index) => selected(target, `edges[${at}][${index}]`)));
  converted.rootBindings.forEach((target, at) => selected(target, `rootBindings[${at}]`));
  return converted;
}

function toResolutionEntry(json: unknown, what: string): IResolutionEntry {
  const entry = objectOf(json, what);
  return {
    name: stringOf(entry.name, `${what}.name`),
    ...optional("publishedName", optionalString(entry.publishedName, `${what}.publishedName`)),
    version: stringOf(entry.version, `${what}.version`),
    ...optional("selectedBy", entry.selectedBy === undefined ? undefined : toRequirementEdge(entry.selectedBy, `${what}.selectedBy`)),
    ...optional("reachedVia", entry.reachedVia === undefined ? undefined : toRequirementEdge(entry.reachedVia, `${what}.reachedVia`)),
    ...optional("fork", entry.fork === undefined ? undefined : indexOf(entry.fork, `${what}.fork`)),
  };
}

function toRequirementEdge(json: unknown, what: string): IRequirementEdge {
  const edge = objectOf(json, what);
  return {
    requiredBy: stringOf(edge.requiredBy, `${what}.requiredBy`),
    versionConstraint: optionalString(edge.versionConstraint, `${what}.versionConstraint`),
  };
}

function toViolationEntry(json: unknown, what: string): IViolationEntry {
  const entry = objectOf(json, what);
  return {
    name: stringOf(entry.name, `${what}.name`),
    versionConstraint: stringOf(entry.versionConstraint, `${what}.versionConstraint`),
    requiredBy: stringOf(entry.requiredBy, `${what}.requiredBy`),
    selected: stringOf(entry.selected, `${what}.selected`),
  };
}

function toRequirement(json: unknown, what: string): Requirement {
  const req = objectOf(json, what);
  const oneOf = <T extends string>(value: unknown, field: string, allowed: readonly T[]): T | undefined => {
    if (value === undefined || allowed.includes(value as T)) {
      return value as T | undefined;
    }
    throw new FabrError(`${what}.${field} is not one of ${allowed.join(", ")}`);
  };
  if (req.bom !== undefined && req.bom !== true) {
    throw new FabrError(`${what}.bom is not true`);
  }
  return {
    name: stringOf(req.name, `${what}.name`),
    versionConstraint: optionalString(req.versionConstraint, `${what}.versionConstraint`),
    ...optional("override", oneOf(req.override, "override", ["alternate", "force"] as const)),
    ...optional("renameTo", optionalString(req.renameTo, `${what}.renameTo`)),
    ...optional("variant", optionalString(req.variant, `${what}.variant`)),
    ...optional("excludes", req.excludes === undefined ? undefined : toStringList(req.excludes)),
    ...optional("provided", oneOf(req.provided, "provided", ["expected", "optional"] as const)),
    ...optional("bom", req.bom === true ? (true as const) : undefined),
  };
}

/** @return `{ [field]: value }`, or nothing where `value` is undefined. */
function optional<K extends string, T>(field: K, value: T | undefined): { [P in K]?: T } {
  return (value === undefined ? {} : { [field]: value }) as { [P in K]?: T };
}

function objectOf(json: unknown, what: string): Record<string, unknown> {
  if (!isJsonObject(json)) {
    throw new FabrError(`${what} is not an object`);
  }
  return json;
}

function listOf<T>(json: unknown, what: string, convert: (item: unknown, what: string) => T): T[] {
  if (!Array.isArray(json)) {
    throw new FabrError(`${what} is not a list`);
  }
  return json.map((item, at) => convert(item, `${what}[${at}]`));
}

function stringOf(json: unknown, what: string): string {
  if (typeof json !== "string") {
    throw new FabrError(`${what} is not a string`);
  }
  return json;
}

function optionalString(json: unknown, what: string): string | undefined {
  return json === undefined ? undefined : stringOf(json, what);
}

function indexOf(json: unknown, what: string): number {
  if (typeof json !== "number" || !Number.isInteger(json) || json < 0) {
    throw new FabrError(`${what} is not an index`);
  }
  return json;
}

/** Read a resolution document back as an {@link MVSResolution}, with no
 * `errors`, parsing its versions with `domain` (a PackageFormat serves). */
export function deserializeResolutionDoc<V>(
  doc: IResolutionDoc,
  domain: { parseVersion(text: string): V; versionToString(version: V): string }
): MVSResolution<V> {
  const parseVersion = (text: string): V => domain.parseVersion(text);
  /* The node id of each selection, by its index, from the version text as
   * written. */
  const ids = doc.selections.map(entry => nodeIdOf(entry.name, entry.version));
  const violation = (entry: IViolationEntry): Violation<V> => ({
    name: entry.name,
    versionConstraint: entry.versionConstraint,
    requiredBy: entry.requiredBy,
    selected: parseVersion(entry.selected),
  });
  return new MVSResolution(version => domain.versionToString(version), {
    selections: doc.selections.map(entry => ({
      name: entry.name,
      ...(entry.publishedName === undefined ? {} : { publishedName: entry.publishedName }),
      version: parseVersion(entry.version),
      selectedBy: entry.selectedBy,
      reachedVia: entry.reachedVia,
      fork: entry.fork,
    })),
    errors: [],
    violations: (doc.violations ?? []).map(violation),
    coerced: (doc.coerced ?? []).map(violation),
    shared: (doc.shared ?? []).map(violation),
    raises: (doc.raises ?? []).map(entry => ({
      name: entry.name,
      versionConstraint: entry.versionConstraint,
      declared: parseVersion(entry.declared),
      raised: parseVersion(entry.raised),
      requiredBy: entry.requiredBy,
    })),
    requirements: new Map((doc.requirements ?? []).map(entry => [entry.node, entry.requires])),
    edges: new Map(
      (doc.edges ?? []).map((from, at) => [ids[at], new Map(from.map(([name, target]): [string, string] => [name, ids[target]]))])
    ),
    rootBindings: (doc.rootBindings ?? []).map(target => target ?? undefined),
  });
}
