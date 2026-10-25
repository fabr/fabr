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
 * The strict (linked) check of a collection point: over everything a consumer
 * uses together, a package may ship at one version only, unless each version
 * it ships is sanctioned.
 *
 * It is made at the end of the collection point's resolution, from what the
 * collection resolves to (what ships) and the resolutions it was answered
 * from. A violation a resolution recorded counts only where a version the
 * consumer actually ships fails it: the resolution's principal may belong to a
 * member this consumer never reaches.
 */

import { Computable } from "../core/Computable";
import { MultiError, RequirementResolutionError } from "../core/Errors";
import { FileSetRef } from "../core/FileSetRef";
import { isPackage, Package } from "../core/PackageFileSet";
import { IProvenanceStep } from "../core/Provenance";
import { isRepositoryCollection, ProjectedPackage, RepositoryReader, RepositoryRef } from "../core/Repository";
import { PackageRequest, Resolution } from "./Types";
import { violatedAmong } from "./Overrides";
import { BUILDS_ALONE, violationKey, violationKeys } from "./Requirement";
import { ResolutionExplainer, MVSResolution } from "./MVSResolution";
import { conflictError, RefRenderer, sanctionHelp, suggestSanctions, SuggestSources } from "./ResolutionReport";
import { Requirement, ROOT_REQUIRER, Selected, VersionDomain, Violation } from "./Types";

/**
 * A resolution a collection was answered from, with what the collection asked
 * of it.
 */
export interface ResolvedBatch {
  /** The registry the batch was asked of; none for builds resolved alone. */
  readonly registry?: RepositoryReader<unknown, unknown>;
  readonly resolution: Resolution;
  /** The collection's requests the resolution answered. */
  readonly requests: ReadonlyArray<PackageRequest>;
  /** Whether the collection's own builds were resolved in it, their
   * requirements among its roots. */
  readonly builds: boolean;
}

/**
 * A resolution as the strict check reads it: made from a {@link
 * ResolvedBatch} when the collection is checked.
 */
export interface CheckedResolution<V = unknown, C = unknown> {
  /** The versions' domain, builds among them. */
  readonly domain: VersionDomain<V, C>;
  /** The format the resolution is of ({@link BUILDS_ALONE} for builds
   * alone): resolutions are checked together only within one. */
  readonly format: object;
  readonly graph: MVSResolution<V>;
  /** The requirements the collection made of it, as written: `?` alternates
   * included. */
  readonly requested: readonly Requirement[];
  /** The versions written as sanctioned (`?`, or an exact pin), by package. */
  readonly written: ReadonlyMap<string, ReadonlySet<string>>;
  readonly refText: RefRenderer;
  /** Find the selection of this resolution that `pkg` is, if it is one. */
  selectionOf(pkg: Package): Selected<V> | undefined;
  /** The provenance of the build a selection is, where it is one: where it
   * was required. */
  buildOrigin(selection: Selected<V>): IProvenanceStep | undefined;
  /** The registry access a remedy is computed and verified with. */
  sources(): SuggestSources<V, C>;
}

/** The versions that conflict in a collection. */
export class Conflicts {
  constructor(
    /** Each package shipping at versions that conflict, by name, with those
     * versions as its resolution writes them. */
    public readonly versions: ReadonlyMap<string, ReadonlySet<string>>,
    private readonly among: (pkg: Package) => boolean,
    private readonly refusal: () => Computable<Error | undefined>
  ) {}

  /** The number of packages that conflict. */
  public get size(): number {
    return this.versions.size;
  }

  /** @return true if `pkg` is one of the versions that conflict, otherwise
   * false. */
  public includes(pkg: Package): boolean {
    return this.among(pkg);
  }

  /** Make the error a strict collection is refused with, or undefined where
   * nothing conflicts. Made on the first call, once. */
  public error(): Computable<Error | undefined> {
    return this.refusal();
  }
}

/** The conflicts of a collection where nothing conflicts. */
export const NO_CONFLICTS = new Conflicts(new Map(), () => false, () => Computable.resolve(undefined));

/**
 * Find what conflicts in a collection. `resolutions` are the resolutions it
 * was answered from, `shipped` what it resolves to, and `finished` each
 * written reference with what it resolved to: a conflict is attributed to the
 * references whose closures hold a package taking part in it.
 */
export function findConflicts(
  resolutions: ReadonlyArray<CheckedResolution>,
  shipped: ReadonlyArray<unknown>,
  finished: ReadonlyMap<RepositoryRef, unknown>
): Conflicts {
  if (resolutions.length === 0) {
    return NO_CONFLICTS;
  }
  const byFormat = new Map<object, CheckedResolution[]>();
  for (const resolution of resolutions) {
    byFormat.set(resolution.format, [...(byFormat.get(resolution.format) ?? []), resolution]);
  }
  /* Builds alone belong to no format, and are checked with each. */
  const alone = byFormat.get(BUILDS_ALONE);
  if (alone !== undefined && byFormat.size > 1) {
    byFormat.delete(BUILDS_ALONE);
    for (const [format, group] of byFormat) {
      byFormat.set(format, [...group, ...alone]);
    }
  }
  const packages = closureOf(shipped);
  const found = [...byFormat.values()].map(group => checkDomain(group, packages));

  const conflicts = new Map<string, Set<string>>();
  for (const { conflicts: inDomain } of found) {
    for (const [name, versions] of inDomain) {
      conflicts.set(name, new Set([...(conflicts.get(name) ?? []), ...versions]));
    }
  }
  if (conflicts.size === 0) {
    return NO_CONFLICTS;
  }
  let reported: Computable<Error | undefined> | undefined;
  return new Conflicts(
    conflicts,
    pkg => found.some(domain => domain.conflicting(pkg)),
    () =>
      (reported ??= Computable.forAll(
        found.map(domain => domain.report(finished)),
        (...errors: Array<Error | undefined>) => {
          const failures = errors.filter((error): error is Error => error !== undefined);
          return failures.length === 0 ? undefined : MultiError.of(failures);
        }
      ))
  );
}

/** Get every package `sources` hold or reach, each once. A projection
 * pending over a package holds the package. */
function closureOf(sources: ReadonlyArray<unknown>): Package[] {
  const visited = new Set<Package>();
  const pending: unknown[] = [...sources];
  while (pending.length > 0) {
    const next = pending.pop();
    const pkg = next instanceof FileSetRef ? next.source : next instanceof ProjectedPackage ? next.base : next;
    if (!isPackage(pkg) || visited.has(pkg)) {
      continue;
    }
    visited.add(pkg);
    pending.push(...pkg.packages);
  }
  return [...visited];
}

/** One version shipped, and the resolutions it is a selection of. */
interface IShipped<V, C> {
  readonly selection: Selected<V>;
  readonly by: CheckedResolution<V, C>[];
}

/** What conflicts within one domain, and how to report it. */
interface DomainConflicts {
  readonly conflicts: ReadonlyMap<string, ReadonlySet<string>>;
  conflicting(pkg: Package): boolean;
  report(finished: ReadonlyMap<RepositoryRef, unknown>): Computable<Error | undefined>;
}

/** Find what conflicts among the resolutions of one domain, given what ships
 * (`packages`). */
function checkDomain<V, C>(group: CheckedResolution<V, C>[], packages: ReadonlyArray<Package>): DomainConflicts {
  const { domain } = group[0];
  /* Each resolution's selections that ship, in its own canonical order, and
   * everything shipped: one entry per version of each package. */
  const needed = new Map(
    group.map(resolution => {
      const shipping = new Set(packages.flatMap(pkg => resolution.selectionOf(pkg) ?? []));
      return [resolution, resolution.graph.ordered(shipping)] as const;
    })
  );
  const shipped = new Map<string, Map<string, IShipped<V, C>>>();
  for (const [resolution, selections] of needed) {
    for (const selection of selections) {
      const text = domain.versionToString(selection.version);
      const versions = shipped.get(selection.name) ?? new Map<string, IShipped<V, C>>();
      shipped.set(selection.name, versions);
      const held = versions.get(text);
      versions.set(text, held === undefined ? { selection, by: [resolution] } : { selection: held.selection, by: [...held.by, resolution] });
    }
  }
  const written = new Map<string, Set<string>>();
  for (const resolution of group) {
    for (const [pkg, versions] of resolution.written) {
      written.set(pkg, new Set([...(written.get(pkg) ?? []), ...versions]));
    }
  }
  const sanctioned = (pkg: string): boolean => [...(shipped.get(pkg)?.keys() ?? [])].every(version => written.get(pkg)?.has(version) === true);
  const shippedOf = (pkg: string): Selected<V>[] => [...(shipped.get(pkg)?.values() ?? [])].map(entry => entry.selection);

  /* Each resolution's recorded violations in its own scope — the roots the
   * collection asked of it, and the requirers it ships — that a version
   * shipped here fails. */
  const violations = new Map<Violation<V>, CheckedResolution<V, C>>();
  for (const resolution of group) {
    const { graph } = resolution;
    const requested = violationKeys(resolution.requested);
    const recorded = [
      ...graph.violationsOf(ROOT_REQUIRER).filter(violation => requested.has(violationKey(violation))),
      ...needed.get(resolution)!.flatMap(selection => graph.violationsOf(graph.id(selection))),
    ];
    for (const violation of recorded) {
      if (!violations.has(violation) && !sanctioned(violation.name) && violatedAmong(domain, shippedOf(violation.name), violation)) {
        violations.set(violation, resolution);
      }
    }
  }
  const duplicates: Array<[string, V[]]> = [...shipped]
    .filter(([pkg, versions]) => versions.size > 1 && !sanctioned(pkg))
    .map(([pkg, versions]) => [pkg, [...versions.values()].map(entry => entry.selection.version).sort((a, b) => domain.compare(a, b))]);
  const conflicted = new Set([...violations.keys()].map(violation => violation.name).concat(duplicates.map(([pkg]) => pkg)));
  const conflicts = new Map([...conflicted].map(pkg => [pkg, new Set(shipped.get(pkg)?.keys() ?? [])] as const));
  const conflicting = (pkg: Package): boolean =>
    group.some(resolution => {
      const selection = resolution.selectionOf(pkg);
      return selection !== undefined && conflicts.get(selection.name)?.has(domain.versionToString(selection.version)) === true;
    });
  if (conflicted.size === 0) {
    return { conflicts, conflicting, report: () => Computable.resolve(undefined) };
  }
  return {
    conflicts,
    conflicting,
    report: finished => {
      /* The resolutions taking part: those owning a violation, and those of
       * which a version of a conflicted package is a selection. */
      const involved = new Set<CheckedResolution<V, C>>(violations.values());
      for (const pkg of conflicted) {
        for (const entry of shipped.get(pkg)?.values() ?? []) {
          entry.by.forEach(resolution => involved.add(resolution));
        }
      }
      const members = [...involved];
      const graphs = [...new Set(members.map(resolution => resolution.graph))];
      const all = [...shipped.values()].flatMap(versions => [...versions.values()].map(entry => entry.selection));
      const outstanding = [...violations.keys()];
      const refText = members[0].refText;
      const explaining = graphs.length === 1 ? graphs[0] : combinedExplanation(graphs);
      /* One resolution behind every part of the conflict: its remedy is
       * computed and verified against it. Several resolutions have no joint one
       * to verify a pin against, so the remedy is the sanction set. */
      const suggestion =
        graphs.length === 1
          ? suggestSanctions(outstanding, graphs[0], all, members.flatMap(resolution => resolution.requested), written, members[0].sources())
          : Computable.resolve(sanctionHelp(conflictedSanctions(outstanding, duplicates, shipped, written, domain, refText)));
      return suggestion.then(help => {
        const error = conflictError(outstanding, duplicates, all, explaining, refText, written, help);
        /* A reference takes part where its closure holds a version of a
         * conflicted package, or the requirer of a violation. */
        const requirers = new Set(outstanding.map(violation => violation.requiredBy));
        const takesPart = (pkg: Package): boolean => conflicted.has(pkg.packageName) || requirers.has(pkg.packageId);
        const references = [...finished].filter(([, value]) => closureOf([value]).some(takesPart)).map(([reference]) => reference);
        /* A build takes part where it is a version of a conflicted package. */
        const builds = [
          ...new Set(
            [...conflicted].flatMap(pkg =>
              [...(shipped.get(pkg)?.values() ?? [])].flatMap(entry => entry.by.flatMap(resolution => resolution.buildOrigin(entry.selection) ?? []))
            )
          ),
        ];
        /* A catalog's member is attributed to the catalog's entry for it,
         * found on its origin: its reference does not name the entry. */
        const origins = new Map(
          references.flatMap(reference => {
            const value = finished.get(reference);
            return isRepositoryCollection(reference.source) && isPackage(value) && value.origin !== undefined
              ? [[reference, value.origin] as const]
              : [];
          })
        );
        return Computable.resolve<Error | undefined>(
          references.length > 0 || builds.length > 0 ? new RequirementResolutionError(references, error, builds, origins) : error
        );
      });
    },
  };
}

/** Write the `?` lines completing each conflicted package's sanction: every
 * version shipped, less those already written. */
function conflictedSanctions<V, C>(
  outstanding: readonly Violation<V>[],
  duplicates: ReadonlyArray<[string, V[]]>,
  shipped: ReadonlyMap<string, ReadonlyMap<string, IShipped<V, C>>>,
  written: ReadonlyMap<string, ReadonlySet<string>>,
  domain: VersionDomain<V, unknown>,
  refText: RefRenderer
): string[] {
  const conflicted = [...new Set([...outstanding.map(violation => violation.name), ...duplicates.map(([pkg]) => pkg)])].sort();
  return conflicted.flatMap(pkg => {
    const entries = [...(shipped.get(pkg)?.values() ?? [])]
      .map(entry => entry.selection)
      .sort((a, b) => domain.compare(a.version, b.version))
      .filter(sel => written.get(pkg)?.has(domain.versionToString(sel.version)) !== true)
      .map(sel => refText(sel, domain.versionToString(sel.version), "?"));
    return entries.length > 0 ? [entries.join(" ")] : [];
  });
}

/** Combine the explanations of several resolutions: a node is explained by
 * the first resolution holding it, and its path through that same
 * resolution. */
function combinedExplanation<V>(graphs: readonly MVSResolution<V>[]): Pick<MVSResolution<V>, "versionToString" | "explainer"> {
  const explainers = graphs.map(graph => graph.explainer());
  const owners = new Map<Selected<V>, ResolutionExplainer<V>>();
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
