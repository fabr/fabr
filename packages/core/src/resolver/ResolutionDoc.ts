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

import { ResolutionGraph } from "./ResolutionGraph";
import { IRequirementEdge, MVSResolution, Requirement, Selected, Violation } from "./Types";

/** Serialized form of one selection in a persisted resolution document */
interface IResolutionEntry {
  pkg: string;
  version: string;
  selectedBy?: IRequirementEdge;
  reachedVia?: IRequirementEdge;
  /** Fork index (see resolver Selected.fork); absent for the principal */
  fork?: number;
}

/** Serialized upper-bound violation (see resolver Violation) */
interface IViolationEntry {
  pkg: string;
  constraint: string;
  requiredBy: string;
  selected: string;
}

/** Serialized floor raise (see resolver RaisedFloor) */
interface IRaiseEntry {
  pkg: string;
  constraint: string;
  declared: string;
  raised: string;
  requiredBy: string;
}

/** Serialized declared requirements of one selected node — the resolution's
 * edges as their packages declared them, which is all a layout needs (see
 * {@link MVSResolution.requirements}) */
interface IRequirementsEntry {
  node: string;
  requires: Requirement[];
}

/** Serialized form of a persisted joint resolution: per-name principals with
 * fork selections and `!`-coerced edges. Version strings are in the owning
 * ecosystem's canonical form; everything else is ecosystem-free. */
export interface IResolutionDoc {
  /** Self-description for anyone reading the cache file — deserialization
   * never reads it (the memo key already fixes the roots). */
  roots: Requirement[];
  selections: IResolutionEntry[];
  violations: IViolationEntry[];
  /** Edges a `!` force override coerced (data — never judged) */
  coerced?: IViolationEntry[];
  raises: IRaiseEntry[];
  requirements: IRequirementsEntry[];
  /**
   * The resolved edges (see {@link MVSResolution.edges}), positionally: entry
   * `i` belongs to `selections[i]`, and each `[name, target]` pair names the
   * *index* of the selection it binds to. Indices rather than `pkg@version`
   * strings because there is one entry per edge in the whole graph — the
   * document would otherwise grow by more than the selections it describes.
   */
  edges: [string, number][][];
  /** Per root (see {@link MVSResolution.rootBindings}), the index of the
   * selection it binds to; `null` for a root that selects nothing. */
  rootBindings: (number | null)[];
}

export function serializeResolutionDoc<V>(
  roots: Requirement[],
  result: MVSResolution<V>,
  versionToString: (version: V) => string
): IResolutionDoc {
  const violation = (entry: Violation<V>): IViolationEntry => ({
    pkg: entry.pkg,
    constraint: entry.constraint,
    requiredBy: entry.requiredBy,
    selected: versionToString(entry.selected),
  });
  /* Edge targets are stored by position, so the id→index map is built once. */
  const index = new Map<string, number>(result.selections.map((sel, at) => [nodeKey(sel, versionToString), at]));
  return {
    roots,
    selections: result.selections.map(sel => ({
      pkg: sel.pkg,
      version: versionToString(sel.version),
      selectedBy: sel.selectedBy,
      reachedVia: sel.reachedVia,
      fork: sel.fork,
    })),
    violations: result.violations.map(violation),
    coerced: result.coerced.map(violation),
    raises: result.raises.map(raise => ({
      pkg: raise.pkg,
      constraint: raise.constraint,
      declared: versionToString(raise.declared),
      raised: versionToString(raise.raised),
      requiredBy: raise.requiredBy,
    })),
    /* Already canonical: the resolver builds the map in its selections' order. */
    requirements: [...result.requirements].map(([node, requires]) => ({ node, requires })),
    edges: result.selections.map(sel => {
      const from = result.edges.get(nodeKey(sel, versionToString)) ?? new Map<string, string>();
      return [...from].map(([name, target]): [string, number] => [name, index.get(target)!]);
    }),
    rootBindings: result.rootBindings.map(target => target ?? null),
  };
}

/** `pkg@version` — the id every per-node table in a resolution is joined by
 * (the resolver's own {@link nodeId}, restated here to keep this module free of
 * the domain). */
function nodeKey<V>(selection: Selected<V>, versionToString: (version: V) => string): string {
  return `${selection.pkg}@${versionToString(selection.version)}`;
}

/** Deserialize a resolution document into the loaded resolution — a
 * {@link ResolutionGraph}, indexed and ready to deliver from. `domain` is any
 * carrier of the version codec (a PackageFormat serves). */
export function deserializeResolutionDoc<V>(
  doc: IResolutionDoc,
  domain: { parseVersion(text: string): V; versionToString(version: V): string }
): ResolutionGraph<V> {
  const parseVersion = (text: string): V => domain.parseVersion(text);
  /* Edge targets are positional (see IResolutionDoc.edges); the ids they mean
   * are read straight off the serialized selections, no version parsing. */
  const ids = doc.selections.map(entry => `${entry.pkg}@${entry.version}`);
  const violation = (entry: IViolationEntry): Violation<V> => ({
    pkg: entry.pkg,
    constraint: entry.constraint,
    requiredBy: entry.requiredBy,
    selected: parseVersion(entry.selected),
  });
  return new ResolutionGraph(version => domain.versionToString(version), {
    selections: doc.selections.map(entry => ({
      pkg: entry.pkg,
      version: parseVersion(entry.version),
      selectedBy: entry.selectedBy,
      reachedVia: entry.reachedVia,
      fork: entry.fork,
    })),
    violations: (doc.violations ?? []).map(violation),
    coerced: (doc.coerced ?? []).map(violation),
    raises: (doc.raises ?? []).map(entry => ({
      pkg: entry.pkg,
      constraint: entry.constraint,
      declared: parseVersion(entry.declared),
      raised: parseVersion(entry.raised),
      requiredBy: entry.requiredBy,
    })),
    requirements: new Map((doc.requirements ?? []).map(entry => [entry.node, entry.requires])),
    edges: new Map(
      (doc.edges ?? []).map((from, at) => [
        ids[at],
        new Map(from.map(([name, target]): [string, string] => [name, ids[target]])),
      ])
    ),
    rootBindings: (doc.rootBindings ?? []).map(target => target ?? undefined),
  });
}
