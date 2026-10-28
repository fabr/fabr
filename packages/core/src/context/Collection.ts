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

import { Reference } from "../core/Reference";
import { Computable } from "../core/Computable";
import { FabrError } from "../core/Errors";
import { FileSet } from "../core/FileSet";
import { FileSetRef } from "../core/FileSetRef";
import { Materialized, RepositoryRef, SourceRef } from "../core/Repository";
import { checked, materializeLists, packageIn, resolveLists } from "./CollectionPoint";
import type { Conflicts } from "../resolver/StrictCollection";
import { PackageFileSet, ResolvedNode, Dependency } from "../core/PackageFileSet";
import { Resolved } from "../core/Repository";
import type { InternalBuildContext } from "./BuildContext";
import type { TargetContext } from "./TargetContext";

/**
 * A property's sources, read contained: the collection point materializes them
 * with their projections still pending, for a consumer that places the
 * container and locates within it ({@link FileSetRef.locate}) rather than
 * extracting the files.
 */
export class ContainedSources {
  /** Tells this from the other readings by type: they are the same shape. */
  public readonly read = "contained";
  constructor(public readonly sources: SourceRef[]) {}
}

/**
 * A property's sources, read as packages: a target among them is the package
 * of its name, and a repository's reference a requirement, all resolved
 * together with the target's other packages. Loose files and flags among
 * them are themselves.
 */
export class PackageSources {
  /** Tells this from the other readings by type. */
  public readonly read = "packages";
  constructor(public readonly sources: SourceRef[]) {}
}

/**
 * A property's sources, read for the loose files among them: what is no
 * package's. A repository's reference is left out unresolved, a target is
 * built and left out where it builds a package, and so is a package or a
 * selection from one; nothing among them joins the target's resolution.
 */
export class LooseSources {
  /** Tells this from the other readings by type. */
  public readonly read = "loose";
  constructor(public readonly sources: SourceRef[]) {}
}

/**
 * A property's sources, read for publishing: as the `files` reading reads
 * them, a target built for its files and nothing joining the target's
 * resolution, except that a package keeps its identity and the edges its own
 * build bound, which a publish writes into the package's manifest. For `sync`
 * alone.
 */
export class SyncSources {
  /** Tells this from the other readings by type. */
  public readonly read = "sync";
  constructor(public readonly sources: SourceRef[]) {}
}

/**
 * The requirement keys the framework reads a meaning from: what a target
 * states under them it passes on, as requirements of whatever requires the
 * target too. Every other key is private to the target's build.
 */
export const DEPENDENCIES_KEY = "dependencies";
/** As {@link DEPENDENCIES_KEY}, for the requirements the package's consumer
 * supplies (its provided requirements). */
export const PROVIDED_KEY = "provided";
/** As {@link PROVIDED_KEY}, for the provided requirements the consumer may
 * leave out: the target is built against them, and a consumer binds each only
 * to what it supplies or its installation already holds. */
export const OPTIONAL_PROVIDED_KEY = "optional_provided";
/**
 * The package the target is made from: resolved on its own, as material and
 * not as a requirement. Where it is exactly one package, the target is a
 * package with that one's version and requirements.
 */
export const EXTENDS_KEY = "extends";
const TRANSITIVE_KEYS: ReadonlySet<string> = new Set([DEPENDENCIES_KEY, PROVIDED_KEY, OPTIONAL_PROVIDED_KEY, EXTENDS_KEY]);

/**
 * What a requirement settles to once materialized: one read
 * {@link ContainedSources contained} keeps its projections pending, and every
 * other is plain content.
 */
export type MaterializedRequirements<P> = {
  [K in keyof P]: P[K] extends ContainedSources | Computable<ContainedSources> ? (FileSet | FileSetRef)[] : FileSet[];
};

/** One requirement's sources as its reader returned them: bare, they are read
 * for their files alone. */
type Read = SourceRef[] | PackageSources | ContainedSources | LooseSources | SyncSources;

/** One requirement as a rule states it: the sources a FILES or PACKAGES
 * property names, as its reader returned them. */
export type RequiredSources = Read | Computable<Read>;

/** What a rule's `requirements` returns: the sources its target requires, by
 * name. A Map where the names are the user's (a `sync`'s coordinates). */
export type Requirements = Record<string, RequiredSources> | ReadonlyMap<string, RequiredSources>;

/**
 * Requirements collected permissively: a target built with them is not
 * refused for versions that conflict, as a sealed program install is not.
 * Made with {@link permissive}.
 */
export class Permissive<P extends Requirements = Requirements> {
  constructor(public readonly requirements: P) {}
}

/** Mark `requirements` as collected permissively: see {@link Permissive}. */
export function permissive<P extends Requirements>(requirements: P): Permissive<P> {
  return new Permissive(requirements);
}

/** How a requirement's sources are read: for their files alone, as packages,
 * as packages kept in their containers, for the loose files among them, or for
 * publishing. */
type Reading = "files" | "packages" | "contained" | "loose" | "sync";

/** One resolved requirement: its sources as the target's collection resolved
 * them, and how they are finished. */
interface ResolvedRequirement {
  readonly sources: Resolved[];
  /** The written reference each source was resolved for, aligned with
   * `sources`: none for content in hand. */
  readonly references: Array<Reference | undefined>;
  readonly reading: Reading;
}

/** A target's requirements, resolved, by name in the order stated. */
export class ResolvedRequirements {
  /** Each requirement's resolved sources. */
  public readonly sources: ReadonlyMap<string, ReadonlyArray<Resolved>>;
  /** The written reference each of a requirement's sources was resolved for,
   * aligned with {@link sources}: none for content in hand. */
  public readonly references: ReadonlyMap<string, ReadonlyArray<Reference | undefined>>;

  constructor(
    private readonly entries: ReadonlyMap<string, ResolvedRequirement>,
    /** The versions that conflict in the collection, found as it was resolved. */
    public readonly conflicts: Conflicts,
    /** Whether the requirements are collected {@link Permissive permissively}. */
    public readonly permissive: boolean
  ) {
    this.sources = new Map([...entries].map(([name, entry]) => [name, entry.sources]));
    this.references = new Map([...entries].map(([name, entry]) => [name, entry.references]));
  }

  /** Make the requirements of one unnamed list: what a name denotes, resolved
   * as one collection. */
  public static of(sources: Resolved[], references: Array<Reference | undefined>, conflicts: Conflicts): ResolvedRequirements {
    return new ResolvedRequirements(new Map([["", { sources, references, reading: "packages" }]]), conflicts, false);
  }

  /** The sources of the one unnamed requirement, where the requirements are
   * what a name denotes ({@link of}). */
  public get denoted(): ReadonlyArray<Resolved> {
    return this.sources.get("") ?? [];
  }

  /** Check that the target may be built with what the collection resolved:
   * rejects where it collects strictly and versions conflict. */
  public check(): Computable<void> {
    return checked(this.conflicts, this.permissive);
  }

  /** Narrow to the requirements `names`. */
  public only(...names: string[]): ResolvedRequirements {
    const kept = names.map((name): [string, ResolvedRequirement] => {
      const entry = this.entries.get(name);
      if (entry === undefined) {
        throw new FabrError(`'${name}' is not one of the rule's requirements`);
      }
      return [name, entry];
    });
    return new ResolvedRequirements(new Map(kept), this.conflicts, this.permissive);
  }

  /** Materialize every requirement and finish it into what a rule reads,
   * each source aligned with the reference it was resolved for. */
  public materialize(config: InternalBuildContext): Computable<Map<string, Collected>> {
    const names = [...this.entries.keys()];
    const entries = [...this.entries.values()];
    return materializeLists(
      entries.map(({ sources }) => sources),
      entries.map(({ references }) => references)
    ).then(({ lists, references }) =>
      Computable.forAll(
        lists.map((list, index) => finish(config, list, references[index], entries[index].reading)),
        (...finished: Collected[]) => new Map(finished.map((collected, index) => [names[index], collected]))
      )
    );
  }
}

/** One requirement as a rule reads it: its content, and aligned with it the
 * written reference each piece was resolved for. */
export interface Collected {
  readonly sources: CollectedSource[];
  readonly references: Array<Reference | undefined>;
}

/** Finish one materialized requirement: apply its pending projections unless
 * it is read contained, and keep the content. Read for files, a package is
 * its files. */
function finish(
  config: InternalBuildContext,
  list: Materialized[],
  references: ReadonlyArray<Reference | undefined>,
  reading: Reading
): Computable<Collected> {
  /* Read for loose files, a package and a selection from one are left out
   * before a projection makes either plain files. */
  const entries = list.map((source, at) => ({ source, reference: references[at] }));
  const kept = reading === "loose" ? entries.filter(({ source }) => packageIn(source) === undefined) : entries;
  const settled: Computable<ReadonlyArray<unknown>> =
    reading === "contained" ? Computable.resolve(kept.map(({ source }) => source)) : config.applyProjections(kept.map(({ source }) => source));
  return settled.then(sources => {
    const finished = sources.flatMap((source, at) =>
      source instanceof FileSet || source instanceof FileSetRef
        ? [{ source: reading === "files" && source instanceof PackageFileSet ? new FileSet(source, source.origin) : source, reference: kept[at].reference }]
        : []
    );
    return { sources: finished.map(({ source }) => source), references: finished.map(({ reference }) => reference) };
  });
}

/** What a requirement's source settles to: content, or a pending projection
 * where it was read contained. */
type CollectedSource = FileSet | FileSetRef;

/*
 * A target's collection point, as the framework runs it. A rule does not call
 * these: it states what its target requires and is handed the result.
 */

/**
 * Reduce a package to material to make another from: the package alone, each
 * requirement it has bound to a repository's package put back as the
 * reference that asked for it. What is made from it is resolved again by
 * whatever requires that, so nothing this package's own resolution selected
 * is fetched for it.
 */
function asMaterial(source: Resolved): Resolved {
  return source instanceof ResolvedNode
    ? new ResolvedNode(
        source.content,
        source.packageName,
        source.version,
        source.dependencies.map(dep => (dep.package !== undefined && dep.reference instanceof RepositoryRef ? { reference: dep.reference } : dep)),
        source.origin,
        source.provided
      )
    : source;
}

/**
 * Run the resolve half of `target`'s collection point: every requirement read
 * and the lot resolved as ONE collection — every reference answered from its
 * repository's joint resolution, the graph wired — with nothing fetched and
 * nothing built. The strict check is left for when the requirements are
 * materialized ({@link ResolvedRequirements.check}).
 */
export function resolveRequirements(target: TargetContext, required: Requirements | Permissive): Computable<ResolvedRequirements> {
  const entries = requirementEntries(required instanceof Permissive ? required.requirements : required);
  return Computable.forAll(
    entries.map(([, value]) => (value instanceof Computable ? value : Computable.resolve(value))),
    (...values: Read[]) => {
      const names = entries.map(([name]) => name);
      const lists = values.map((value): SourceRef[] => (Array.isArray(value) ? value : value.sources));
      const readings = values.map((value): Reading => (Array.isArray(value) ? "files" : value.read));
      /* What a target passes on is packages. */
      const misread = names.find((name, index) => TRANSITIVE_KEYS.has(name) && readings[index] === "files" && lists[index].length > 0);
      if (misread !== undefined) {
        throw new FabrError(`internal: the rule of '${target.name}' reads its '${misread}' requirement for files`).withHelp(
          "what a target passes on is packages: read it with getPackageProperty"
        );
      }
      return resolveLists(
        target,
        /* A reference to a repository names a package: read for loose
         * files, it is left out unresolved. */
        lists.map((list, index) => (readings[index] === "loose" ? list.filter(source => !(source instanceof RepositoryRef)) : list)),
        readings.map(reading => reading !== "contained"),
        names.map(name => name === EXTENDS_KEY),
        readings.map(reading => (reading === "files" || reading === "loose" || reading === "sync" ? "files" : undefined))
      ).then(
        ({ lists: resolved, references, conflicts }) =>
          new ResolvedRequirements(
            new Map(
              names.map((name, index) => [
                name,
                {
                  sources: name === EXTENDS_KEY ? resolved[index].map(asMaterial) : resolved[index],
                  references: references[index],
                  reading: readings[index],
                },
              ])
            ),
            conflicts,
            required instanceof Permissive
          )
      );
    }
  );
}

/**
 * A target's requirements as its rule's `evaluate` receives them: resolved,
 * and given their content when the rule asks. Nothing is fetched or built
 * until it does. Where they are collected strictly and versions conflict,
 * materializing any of them fails.
 */
export interface Unmaterialized<P> {
  /** Materialize every requirement, by name. Done on the first call, once. */
  materializeAll(): Computable<MaterializedRequirements<P>>;
  /** Materialize one requirement and leave the others as they are. Done on
   * the first call for that name, once. */
  materialize<K extends keyof P & string>(name: K): Computable<MaterializedRequirements<P>[K]>;
  /** Materialize one requirement read as packages and return the packages
   * among it as the edges the target has to them: each with the reference
   * it was resolved for. Loose files among the requirement are left out. */
  packages<K extends keyof P & string>(name: K): Computable<Array<Dependency<PackageFileSet>>>;
}

/** Make `resolved` what a rule receives: see {@link Unmaterialized}. */
export function unmaterialized(
  config: InternalBuildContext,
  resolved: ResolvedRequirements
): Unmaterialized<Record<string, RequiredSources>> {
  let held: Computable<void> | undefined;
  const check = (): Computable<void> => (held ??= resolved.check());
  /* One memo per requirement, which every form reads, so what one call gave
   * content no other materializes again. The names a call finds
   * unmaterialized are materialized together, as one collection. */
  const each = new Map<string, Computable<Collected>>();
  const materialize = (names: string[]): Computable<Collected[]> => {
    const pending = names.filter(name => !each.has(name));
    if (pending.length > 0) {
      const collected = resolved.only(...pending).materialize(config);
      for (const name of pending) {
        each.set(
          name,
          collected.then(lists => lists.get(name) ?? { sources: [], references: [] })
        );
      }
    }
    return Computable.forAll(
      names.map(name => each.get(name)!),
      (...lists: Collected[]) => lists
    );
  };
  return {
    materializeAll: () =>
      check().then(() => {
        const names = [...resolved.sources.keys()];
        return materialize(names).then(lists =>
          Object.assign(Object.create(null), Object.fromEntries(names.map((name, index) => [name, lists[index].sources])))
        );
      }) as Computable<MaterializedRequirements<Record<string, RequiredSources>>>,
    materialize: name => check().then(() => materialize([name]).then(([list]) => list.sources)) as Computable<FileSet[]>,
    packages: name => check().then(() => materialize([name]).then(([list]) => packageEdges(name, list))),
  };
}

/** List the packages among a collected requirement as the edges to them. A
 * package among it with no reference — one a sub-target was handed in hand,
 * which no reference asked for — has no edge and is refused: such a
 * requirement is read with `materialize`. */
function packageEdges(name: string, collected: Collected): Array<Dependency<PackageFileSet>> {
  return collected.sources.flatMap((source, at): Array<Dependency<PackageFileSet>> => {
    if (!(source instanceof PackageFileSet)) {
      return [];
    }
    const reference = collected.references[at];
    if (reference === undefined) {
      throw new FabrError(`'${source.packageId}' among '${name}' was handed over as a package, not resolved for a reference, so it is no edge`).withHelp(
        `read '${name}' materialized where its packages were given rather than written`
      );
    }
    return [{ reference, package: source }];
  });
}

/** List a rule's requirements as entries, in the order written. */
function requirementEntries(requirements: Requirements): Array<[string, RequiredSources]> {
  return requirements instanceof Map ? [...requirements] : Object.entries(requirements);
}
