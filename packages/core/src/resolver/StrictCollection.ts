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
 * The strict check of a collection point: among everything a consumer uses
 * together, a package may ship at one version only, unless each version it
 * ships is sanctioned (written as a `?` or an exact pin).
 *
 * The check is made once the collection is resolved, from what it resolves to
 * (what ships) and the resolutions it was answered from. A violation a
 * resolution recorded counts only where a version the collection ships fails
 * it.
 */

import { Computable } from "../core/Computable";
import { MultiError, RequirementResolutionError } from "../core/Errors";
import { FileSetRef } from "../core/FileSetRef";
import { isPackage, Package } from "../core/PackageFileSet";
import { IProvenanceStep } from "../core/Provenance";
import { isRepositoryCollection, ProjectedPackage, RepositoryReader, RepositoryRef } from "../core/Repository";
import { PackageRequest, Resolution, Pin } from "./Types";
import { violatedAmong } from "./Overrides";
import { BUILDS_ALONE, exactConstraintOf, violationKey, violationKeys } from "./Requirement";
import { ResolutionExplainer, MVSResolution } from "./MVSResolution";
import { conflictError, RefRenderer, RootRenderer, sanctionHelp, suggestSanctions, SuggestSources } from "./ResolutionReport";
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
  /** Whether it is a catalog's resolution, reached through a member, rather
   * than one of the collection's own. */
  readonly catalog?: boolean;
}

/** A resolution as the strict check reads it, made from a {@link ResolvedBatch}. */
export interface CheckedResolution<V = unknown, C = unknown> {
  /** The versions' domain, builds among them. */
  readonly domain: VersionDomain<V, C>;
  /** The format the resolution is of ({@link BUILDS_ALONE} for builds
   * alone). Resolutions are checked together only within one format. */
  readonly format: object;
  readonly graph: MVSResolution<V>;
  /** The requirements the collection made of it: its requests, `?`
   * alternates included, its pins, and the collection's builds where they
   * were resolved in it. */
  readonly requested: readonly Requirement[];
  /** The catalog selections the collection pinned: exact roots of the
   * resolution that nothing wrote. */
  readonly pins: ReadonlyArray<Pin>;
  /** Whether it is a catalog's resolution rather than one of the
   * collection's own. A catalog's written versions sanction a package
   * together with the collection's own, never with another catalog's. */
  readonly catalog: boolean;
  /** The versions written as sanctioned (`?`, or an exact pin), by package. */
  readonly written: ReadonlyMap<string, ReadonlySet<string>>;
  /** The packages sanctioned at every version, by a `?` stating none. */
  readonly everyVersion: ReadonlySet<string>;
  readonly refText: RefRenderer;
  /** Find the selection of this resolution that `pkg` is, if it is one. */
  selectionOf(pkg: Package): Selected<V> | undefined;
  /** Get where the build `selection` was required, or undefined where it
   * is no build. */
  buildOrigin(selection: Selected<V>): IProvenanceStep | undefined;
  /** Get the registry access a remedy is computed and verified with. */
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
   * nothing conflicts. The error is made on the first call and shared by
   * later ones. */
  public error(): Computable<Error | undefined> {
    return this.refusal();
  }

  /** Make the conflicts of several collections used together: each package
   * that conflicts in any of them, refused with every one's error. */
  public static union(each: ReadonlyArray<Conflicts>): Conflicts {
    const found = each.filter(conflicts => conflicts.size > 0);
    if (found.length <= 1) {
      return found[0] ?? NO_CONFLICTS;
    }
    const versions = new Map<string, Set<string>>();
    for (const conflicts of found) {
      for (const [name, shipped] of conflicts.versions) {
        versions.set(name, new Set([...(versions.get(name) ?? []), ...shipped]));
      }
    }
    return new Conflicts(
      versions,
      pkg => found.some(conflicts => conflicts.includes(pkg)),
      refusalOf(() => found.map(conflicts => conflicts.error()))
    );
  }
}

/**
 * Make the refusal of a collection from the errors `errors` makes: those that
 * are errors, as one MultiError, or undefined where none is. `errors` is
 * called on the refusal's first call, and its result shared by later ones.
 */
function refusalOf(errors: () => ReadonlyArray<Computable<Error | undefined>>): () => Computable<Error | undefined> {
  let refused: Computable<Error | undefined> | undefined;
  return () =>
    (refused ??= Computable.forAll(errors(), (...found: Array<Error | undefined>) => {
      const failures = found.filter((error): error is Error => error !== undefined);
      return failures.length === 0 ? undefined : MultiError.of(failures);
    }));
}

/** The conflicts of a collection where nothing conflicts. */
export const NO_CONFLICTS = new Conflicts(
  new Map(),
  () => false,
  () => Computable.resolve(undefined)
);

/**
 * Make the {@link RootRenderer} that names a root requirement which is one of
 * `pins` by what the collection reached the pin through (`pinned by
 * '@dep:foo'`). A root is taken for a pin where its name and constraint are
 * the pin's name and `domain`'s exact constraint for its version, unless the
 * collection wrote that constraint itself (`ownWritten`).
 */
function pinText<V, C>(
  pins: ReadonlyArray<Pin>,
  ownWritten: ReadonlyMap<string, ReadonlySet<string>>,
  domain: VersionDomain<V, C>
): RootRenderer {
  return (name, versionConstraint) => {
    const pin = pins.find(
      ({ selection }) =>
        (selection.renameTo ?? selection.name) === name &&
        exactConstraintOf(domain, domain.parseVersion(selection.version)) === versionConstraint
    );
    if (pin === undefined || (versionConstraint !== undefined && ownWritten.get(name)?.has(versionConstraint) === true)) {
      return undefined;
    }
    const { via } = pin;
    const text =
      via instanceof RepositoryRef
        ? `${via.repositoryName === undefined ? "" : `${via.repositoryName}:`}${via.toString()}`
        : via.packageName;
    return `pinned by '${text}'`;
  };
}

/**
 * Find the versions that conflict among everything a collection ships. A
 * package conflicts where it ships at more than one version, or a version of
 * it that ships fails a requirement a resolution recorded as violated, unless
 * every version of it that ships is sanctioned ({@link checkDomain} has the
 * rules). Resolutions are judged together only within one format
 * (`CheckedResolution.format`); those of builds alone ({@link BUILDS_ALONE})
 * are judged with each format's, or alone where there is no other.
 *
 * - `resolutions`: the resolutions the collection was answered from: its own
 *   registries', its builds', and each catalog's it reached through a member.
 * - `shipped`: the sources the collection resolves to. Every package they
 *   hold or reach ships, including the package beneath a pending projection.
 * - `finished`: each written reference with what it resolved to, used only
 *   to attribute the error.
 *
 * Returns {@link NO_CONFLICTS} where `resolutions` is empty or nothing
 * conflicts. Otherwise, in the result:
 * - `versions` maps each conflicting package to every version of it that
 *   ships, as its resolution writes them;
 * - `includes(pkg)` is true for a package that is one of those versions;
 * - `error()` makes the error, once: each format's conflict report with a
 *   remedy (which may read registry metadata), as a MultiError where several
 *   formats conflict. Each report is wrapped in a RequirementResolutionError
 *   where references or builds take part: a reference whose closure holds a
 *   version of a conflicting package or the requirer of a violated
 *   requirement, and a build that is a version of a conflicting package.
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
  return new Conflicts(
    conflicts,
    pkg => found.some(domain => domain.conflicting(pkg)),
    refusalOf(() => found.map(domain => domain.report(finished)))
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
  /** Each conflicting package, with every version of it that ships. */
  readonly conflicts: ReadonlyMap<string, ReadonlySet<string>>;
  /** @return true if `pkg` is a version of a conflicting package, otherwise
   * false. */
  conflicting(pkg: Package): boolean;
  /** Make the error the conflicts are refused with, attributed to the
   * references in `finished` that take part, or undefined where nothing
   * conflicts. */
  report(finished: ReadonlyMap<RepositoryRef, unknown>): Computable<Error | undefined>;
}

/** @return the versions written as sanctioned for each package, across `resolutions`. */
function writtenAcross<V, C>(resolutions: ReadonlyArray<CheckedResolution<V, C>>): Map<string, Set<string>> {
  const written = new Map<string, Set<string>>();
  for (const resolution of resolutions) {
    for (const [pkg, versions] of resolution.written) {
      const held = written.get(pkg) ?? new Set<string>();
      written.set(pkg, held);
      versions.forEach(version => held.add(version));
    }
  }
  return written;
}

/**
 * Find what conflicts among `group`, the resolutions of one format, given the
 * packages that ship (`packages`). A version ships from a resolution where a
 * shipped package is one of its selections (`selectionOf`); versions are
 * compared by their text, so one version selected by two resolutions is one.
 *
 * A package conflicts where it is not sanctioned and either:
 * - it ships at more than one version; or
 * - a version of it that ships fails a violation a resolution in `group`
 *   recorded, either against one of the requirements the collection made of
 *   that resolution (`requested`, forced and `?` requirements excepted) or
 *   against a selection of that resolution that ships. A violation whose
 *   constraint does not parse counts as failed.
 *
 * A package is sanctioned where every version of it that ships is written
 * (`written`) by the collection's own resolutions, or by them together with
 * one catalog's; or where the collection's own resolutions or one catalog's
 * sanction it at every version (`everyVersion`). One catalog's written
 * versions never combine with another's.
 *
 * In the result, `conflicts` maps each conflicting package to every version
 * of it that ships, and `conflicting(pkg)` is true where `pkg` is a selection
 * in `group` at one of those versions. `report(finished)` resolves to
 * undefined where nothing conflicts, else to the conflict error
 * ({@link conflictError}) with a remedy: where one resolution is behind every
 * part of the conflict, a remedy computed and verified against it
 * ({@link suggestSanctions}); otherwise the `?` lines that sanction every
 * version shipped and not yet written. The error is wrapped in a
 * RequirementResolutionError where a reference in `finished` or a build takes
 * part (see {@link findConflicts}). It rejects where the remedy cannot be
 * computed.
 */
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
      versions.set(
        text,
        held === undefined ? { selection, by: [resolution] } : { selection: held.selection, by: [...held.by, resolution] }
      );
    }
  }
  const written = writtenAcross(group);
  /* A package shipped at several versions is sanctioned by the collection's
   * own written versions, together with at most one catalog's. */
  const own = group.filter(resolution => !resolution.catalog);
  const catalogs = group.filter(resolution => resolution.catalog);
  const ownWritten = writtenAcross(own);
  const ownEveryVersion = new Set(own.flatMap(resolution => [...resolution.everyVersion]));
  const coveredBy = (pkg: string, together?: CheckedResolution<V, C>): boolean =>
    ownEveryVersion.has(pkg) ||
    together?.everyVersion.has(pkg) === true ||
    [...(shipped.get(pkg)?.keys() ?? [])].every(
      version => ownWritten.get(pkg)?.has(version) === true || together?.written.get(pkg)?.has(version) === true
    );
  const sanctioned = (pkg: string): boolean => coveredBy(pkg) || catalogs.some(catalog => coveredBy(pkg, catalog));
  const shippedOf = (pkg: string): Selected<V>[] => [...(shipped.get(pkg)?.values() ?? [])].map(entry => entry.selection);

  /* Each resolution's recorded violations, against the roots the collection
   * asked of it or the selections of it that ship, that a version shipped
   * here fails, with the resolution that recorded each. */
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
    .map(([pkg, versions]) => [
      pkg,
      [...versions.values()].map(entry => entry.selection.version).sort((a, b) => domain.compare(a, b)),
    ]);
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
      /* Where one resolution is behind every part of the conflict, the remedy
       * is computed and verified against it; otherwise it is the `?` lines
       * completing each sanction. */
      const suggestion =
        graphs.length === 1
          ? suggestSanctions(
              outstanding,
              graphs[0],
              all,
              members.flatMap(resolution => resolution.requested),
              written,
              members[0].sources()
            )
          : Computable.resolve(sanctionHelp(conflictedSanctions(outstanding, duplicates, shipped, written, domain, refText)));
      return suggestion.then(help => {
        const error = conflictError(
          outstanding,
          duplicates,
          all,
          explaining,
          refText,
          written,
          help,
          pinText(
            members.flatMap(resolution => resolution.pins),
            ownWritten,
            domain
          )
        );
        /* A reference takes part where its closure holds a version of a
         * conflicted package, or the requirer of a violation. */
        const requirers = new Set(outstanding.map(violation => violation.requiredBy));
        const takesPart = (pkg: Package): boolean => conflicted.has(pkg.packageName) || requirers.has(pkg.packageId);
        const references = [...finished].filter(([, value]) => closureOf([value]).some(takesPart)).map(([reference]) => reference);
        /* A build takes part where it is a version of a conflicted package. */
        const builds = [
          ...new Set(
            [...conflicted].flatMap(pkg =>
              [...(shipped.get(pkg)?.values() ?? [])].flatMap(entry =>
                entry.by.flatMap(resolution => resolution.buildOrigin(entry.selection) ?? [])
              )
            )
          ),
        ];
        /* A catalog member is attributed to the catalog's entry for it, which
         * its origin names and its reference does not. */
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
