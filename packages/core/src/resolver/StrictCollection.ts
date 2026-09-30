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
 * The strict (linked) check of a collection point: over everything a
 * consumer uses together — every delivery from every source — a package may
 * ship at one version only, unless each version it ships is sanctioned.
 *
 * A delivery records what it ships and how to explain it
 * ({@link IDeliveryFacts}, carried on its packages' resolution provenance);
 * the collection point gathers those records from what it was delivered and
 * checks them together. A violation recorded by a resolution counts only
 * where a version the consumer actually ships fails it — the resolution's
 * principal may belong to a member this consumer never reaches.
 */

import { Computable } from "../core/Computable";
import { attachHelp, MultiError, RequirementResolutionError } from "../core/Errors";
import { FileSetRef } from "../core/FileSetRef";
import { PackageFileSet } from "../core/PackageFileSet";
import { IProvenanceStep } from "../core/Provenance";
import type { RepositoryRef } from "../core/Repository";
import { requirementKey, violatedAmong } from "./Overrides";
import { ResolutionExplainer, ResolutionGraph } from "./ResolutionGraph";
import { PACKAGE_RESOLUTION_PROVENANCE, type IResolutionOrigin } from "./ResolutionProvenance";
import { conflictError, RefRenderer, sanctionHelp, suggestSanctions, SuggestSources } from "./ResolutionReport";
import { Requirement, ROOT_REQUIRER, Selected, VersionDomain, Violation } from "./Types";

/**
 * What one delivery ships and everything needed to explain it: the facts a
 * collection point judges, recorded by the resolution layer where they are at
 * hand. Runtime-only, like the provenance that carries it.
 */
export interface IDeliveryFacts<V = unknown, C = unknown> {
  /** The versions' domain — deliveries are judged together only within one. */
  readonly domain: VersionDomain<V, C>;
  /** The resolution the delivery was cut from. */
  readonly graph: ResolutionGraph<V>;
  /** The selections the delivery ships. */
  readonly needed: readonly Selected<V>[];
  /** The requirements the delivery was asked for, as written — `?`
   * alternates included. */
  readonly requested: readonly Requirement[];
  /** The versions written as sanctioned (`?`, or an exact pin), by package. */
  readonly written: ReadonlyMap<string, ReadonlySet<string>>;
  /** The delivery's requests, as its failure names them. */
  readonly roots: readonly string[];
  readonly refText: RefRenderer;
  /** The registry access a remedy is computed and verified with. */
  sources(): SuggestSources<V, C>;
}

/** The delivery facts a package was delivered with, found on its provenance
 * chain; none for a package no resolution delivered. */
export function deliveryFactsOf(pkg: PackageFileSet): IDeliveryFacts | undefined {
  for (let step: IProvenanceStep | undefined = pkg.origin; step !== undefined; step = step.parent) {
    if (step.kind === PACKAGE_RESOLUTION_PROVENANCE) {
      return (step as IResolutionOrigin<unknown>).delivery;
    }
  }
  return undefined;
}

/**
 * Judge a strict collection point: `delivered` is each written reference and
 * what it delivered. Rejects with the conflicts — attributed to the references
 * whose deliveries take part — or resolves when there are none.
 */
export function checkStrictCollection(delivered: ReadonlyMap<RepositoryRef, unknown>): Computable<void> {
  const culprits = factsByReference(delivered);
  const byDomain = new Map<VersionDomain<unknown, unknown>, IDeliveryFacts[]>();
  for (const facts of culprits.keys()) {
    byDomain.set(facts.domain, [...(byDomain.get(facts.domain) ?? []), facts]);
  }
  const judged = [...byDomain.values()].map(group => checkDomain(group, culprits));
  return Computable.forAll(judged, (...errors: Array<Error | undefined>) => {
    const failures = errors.filter((error): error is Error => error !== undefined);
    if (failures.length > 0) {
      throw MultiError.of(failures);
    }
    return Computable.resolve(undefined);
  });
}

/** Each delivery's facts, with the references whose delivered closures hold
 * it. */
function factsByReference(delivered: ReadonlyMap<RepositoryRef, unknown>): Map<IDeliveryFacts, Set<RepositoryRef>> {
  const culprits = new Map<IDeliveryFacts, Set<RepositoryRef>>();
  for (const [reference, value] of delivered) {
    const visited = new Set<PackageFileSet>();
    const pending: unknown[] = [value];
    while (pending.length > 0) {
      const next = pending.pop();
      const pkg = next instanceof FileSetRef ? next.source : next;
      if (!(pkg instanceof PackageFileSet) || visited.has(pkg)) {
        continue;
      }
      visited.add(pkg);
      const facts = deliveryFactsOf(pkg);
      if (facts !== undefined) {
        culprits.set(facts, (culprits.get(facts) ?? new Set()).add(reference));
      }
      pending.push(...pkg.dependencies);
    }
  }
  return culprits;
}

/** One version shipped, and the deliveries shipping it. */
interface IShipped<V> {
  readonly selection: Selected<V>;
  readonly by: IDeliveryFacts<V>[];
}

/** The judgment of the deliveries in one domain, as the error it fails with. */
function checkDomain<V, C>(
  group: IDeliveryFacts<V, C>[],
  culprits: ReadonlyMap<IDeliveryFacts, ReadonlySet<RepositoryRef>>
): Computable<Error | undefined> {
  const { domain } = group[0];
  /* Everything shipped, one entry per version of each package. */
  const shipped = new Map<string, Map<string, IShipped<V>>>();
  for (const facts of group) {
    for (const selection of facts.needed) {
      const versions = shipped.get(selection.pkg) ?? new Map<string, IShipped<V>>();
      shipped.set(selection.pkg, versions);
      const text = domain.versionToString(selection.version);
      const held = versions.get(text);
      versions.set(text, held === undefined ? { selection, by: [facts] } : { selection: held.selection, by: [...held.by, facts] });
    }
  }
  const written = new Map<string, Set<string>>();
  for (const facts of group) {
    for (const [pkg, versions] of facts.written) {
      written.set(pkg, new Set([...(written.get(pkg) ?? []), ...versions]));
    }
  }
  const sanctioned = (pkg: string): boolean => [...(shipped.get(pkg)?.keys() ?? [])].every(version => written.get(pkg)?.has(version) === true);
  const shippedOf = (pkg: string): Selected<V>[] => [...(shipped.get(pkg)?.values() ?? [])].map(entry => entry.selection);

  /* Each delivery's recorded violations in its own scope — its requested
   * roots, and the requirers it ships — that a version shipped here fails. */
  const violations = new Map<Violation<V>, IDeliveryFacts<V>>();
  for (const facts of group) {
    const requested = new Set(facts.requested.map(requirementKey));
    const recorded = [
      ...facts.graph.violationsOf(ROOT_REQUIRER).filter(violation => requested.has(requirementKey(violation))),
      ...facts.needed.flatMap(selection => facts.graph.violationsOf(facts.graph.id(selection))),
    ];
    for (const violation of recorded) {
      if (!violations.has(violation) && !sanctioned(violation.pkg) && violatedAmong(domain, shippedOf(violation.pkg), violation)) {
        violations.set(violation, facts);
      }
    }
  }
  const duplicates: Array<[string, V[]]> = [...shipped]
    .filter(([pkg, versions]) => versions.size > 1 && !sanctioned(pkg))
    .map(([pkg, versions]) => [pkg, [...versions.values()].map(entry => entry.selection.version).sort((a, b) => domain.compare(a, b))]);
  if (violations.size === 0 && duplicates.length === 0) {
    return Computable.resolve(undefined);
  }

  /* The deliveries taking part: those owning a violation, and those shipping a
   * version of a conflicted package. */
  const involved = new Set<IDeliveryFacts<V>>(violations.values());
  for (const [pkg] of duplicates) {
    for (const entry of shipped.get(pkg)!.values()) {
      entry.by.forEach(facts => involved.add(facts));
    }
  }
  const members = [...involved];
  const graphs = [...new Set(members.map(facts => facts.graph))];
  const root = [...new Set(members.flatMap(facts => facts.roots))].sort().join(", ");
  const needed = [...shipped.values()].flatMap(versions => [...versions.values()].map(entry => entry.selection));
  const outstanding = [...violations.keys()];
  const refText = members[0].refText;
  const explaining = graphs.length === 1 ? graphs[0] : combinedExplanation(graphs);
  /* One resolution behind every part of the conflict: its remedy is computed
   * and verified against it, as for a single delivery. Several resolutions
   * have no joint one to verify a pin against, so the remedy is the sanction
   * set — correct by construction, since each version shipped demonstrably
   * answers its own requirers. */
  const suggestion =
    graphs.length === 1
      ? suggestSanctions(outstanding, graphs[0], needed, members.flatMap(facts => facts.requested), written, members[0].sources())
      : Computable.resolve(sanctionHelp(conflictedSanctions(outstanding, duplicates, shipped, written, domain, refText)));
  return suggestion.then(help => {
    const error = conflictError(root, outstanding, duplicates, needed, explaining, refText, written, help);
    const references = [...new Set(members.flatMap(facts => [...(culprits.get(facts as IDeliveryFacts) ?? [])]))];
    return Computable.resolve<Error | undefined>(
      references.length > 0 ? attachHelp(new RequirementResolutionError(references, error), help.length > 0 ? help : helpOf(error)) : error
    );
  });
}

/** The help an error carries. */
function helpOf(error: Error): string | string[] {
  return (error as { help?: string | string[] }).help ?? [];
}

/** The `?` lines completing each conflicted package's sanction: every version
 * shipped, less those already written. */
function conflictedSanctions<V>(
  outstanding: readonly Violation<V>[],
  duplicates: ReadonlyArray<[string, V[]]>,
  shipped: ReadonlyMap<string, ReadonlyMap<string, IShipped<V>>>,
  written: ReadonlyMap<string, ReadonlySet<string>>,
  domain: VersionDomain<V, unknown>,
  refText: RefRenderer
): string[] {
  const conflicted = [...new Set([...outstanding.map(violation => violation.pkg), ...duplicates.map(([pkg]) => pkg)])].sort();
  return conflicted.flatMap(pkg => {
    const entries = [...(shipped.get(pkg)?.values() ?? [])]
      .map(entry => entry.selection.version)
      .sort((a, b) => domain.compare(a, b))
      .map(version => domain.versionToString(version))
      .filter(version => written.get(pkg)?.has(version) !== true)
      .map(version => refText(pkg, version, "?"));
    return entries.length > 0 ? [entries.join(" ")] : [];
  });
}

/** An explanation over several resolutions: a node is explained by the first
 * resolution holding it, and its path through that same resolution. */
function combinedExplanation<V>(graphs: readonly ResolutionGraph<V>[]): Pick<ResolutionGraph<V>, "versionToString" | "explainer"> {
  const explainers = graphs.map(graph => graph.explainer());
  const owners = new WeakMap<Selected<V>, ResolutionExplainer<V>>();
  const explainer: ResolutionExplainer<V> = {
    id: selection => (owners.get(selection) ?? explainers[0]).id(selection),
    find: id => {
      for (const candidate of explainers) {
        const found = candidate.find(id);
        if (found !== undefined) {
          owners.set(found, candidate);
          return found;
        }
      }
      return undefined;
    },
    pathTo: selection => (owners.get(selection) ?? explainers[0]).pathTo(selection),
  };
  return { versionToString: graphs[0].versionToString, explainer: () => explainer };
}
