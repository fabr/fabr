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
import { FabrError, RequirementResolutionError, toError } from "../core/Errors";
import { FileSet } from "../core/FileSet";
import { FileSetRef } from "../core/FileSetRef";
import { Materialized, RepositoryRef, SourceRef } from "../core/Repository";
import { checked, materializeLists, ResolvedLists, resolveLists, withOperation } from "./CollectionPoint";
import { Conflicts } from "../resolver/StrictCollection";
import { Builds, PackageFileSet, Dependency, ResolvedNode } from "../core/PackageFileSet";
import type { PackageFormat } from "../resolver/PackageFormat";
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
 * them are themselves. Where `format` is given, every package among them
 * whose format is known must be in it.
 */
export class PackageSources {
  /** Tells this from the other readings by type. */
  public readonly read = "packages";
  constructor(
    public readonly sources: SourceRef[],
    public readonly format?: PackageFormat<unknown, unknown>
  ) {}
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
/** As {@link DEPENDENCIES_KEY}, for the requirements passed on to what a
 * consumer runs with alone (its `run` collection): Maven's `runtime` scope,
 * Gradle's `runtimeOnly`. */
export const RUNTIME_KEY = "runtime";
/** As {@link DEPENDENCIES_KEY}, for the requirements passed on to what a
 * consumer compiles against alone (its `build` collection): Gradle's
 * `compileOnlyApi`. */
export const COMPILE_KEY = "compile";
/**
 * The package the target is made from: resolved on its own, as material and
 * not as a requirement. Where it is exactly one package, the target is a
 * package with that one's version and requirements.
 */
export const EXTENDS_KEY = "extends";
const TRANSITIVE_KEYS: ReadonlySet<string> = new Set([DEPENDENCIES_KEY, PROVIDED_KEY, OPTIONAL_PROVIDED_KEY, RUNTIME_KEY, COMPILE_KEY, EXTENDS_KEY]);

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
export type Read = SourceRef[] | PackageSources | ContainedSources | SyncSources;

/** One requirement as a rule states it: the sources a FILES or PACKAGES
 * property names, as its reader returned them. */
export type RequiredSources = Read | Computable<Read>;

/** What a rule's `requirements` returns: the sources its target requires, by
 * name. A Map where the names are the user's (a `sync`'s coordinates). */
export type Requirements = Record<string, RequiredSources> | ReadonlyMap<string, RequiredSources>;

/**
 * What resolution needs to know of a target, as its rule's `requirements`
 * returns it: the sources it requires, by name, as two collections — those it
 * compiles against or otherwise builds with (`build`), and those it installs
 * or runs (`run`), each resolved for that operation (a Maven package requires
 * its compile scope for the first and its runtime scope for the second);
 * whether they are collected permissively, so that a target built with them is
 * not refused for versions that conflict, as a sealed program install is not
 * (`permissive`); what the target builds, where the rule knows
 * (`result`); and the advisories its build fixes in the package it is made
 * from (`fixes`: ids as an advisory database names them, its aliases
 * included), which an audit reports as fixed by the target. A name is one requirement whichever collection holds it, so the
 * two hold different names.
 */
export interface ResolutionSpec<B extends Requirements = Requirements, R extends Requirements = NoRequirements> {
  readonly build?: B;
  readonly run?: R;
  readonly permissive?: boolean;
  readonly result?: Builds;
  readonly fixes?: ReadonlyArray<string>;
}

/** A collection of a {@link ResolutionSpec} that states nothing. */
export type NoRequirements = Record<never, never>;

/** The operations a {@link ResolutionSpec}'s collections are resolved for, by the field holding each. */
const SIDES = ["build", "run"] as const;

/** @return each requirement `spec` states, by name, with the operation its
 * collection is resolved for. Rejects a name stated in both collections. */
export function specEntries(spec: ResolutionSpec): Array<[string, RequiredSources, string]> {
  const entries = SIDES.flatMap(side => {
    const requirements = spec[side];
    return requirements === undefined
      ? []
      : requirementEntries(requirements).map(([name, value]): [string, RequiredSources, string] => [name, value, side]);
  });
  const names = new Set<string>();
  for (const [name] of entries) {
    if (names.has(name)) {
      throw new FabrError(`internal: the requirement '${name}' is stated for both build and run`).withHelp(
        "name the two requirements apart: a name is one requirement whichever collection holds it"
      );
    }
    names.add(name);
  }
  return entries;
}

/** How a requirement's sources are read: for their files alone, as packages,
 * as packages kept in their containers, or for publishing. */
type Reading = "files" | "packages" | "contained" | "sync";

/** One resolved requirement: its sources as the target's collection resolved
 * them, and how they are finished. */
interface ResolvedRequirement {
  readonly sources: Resolved[];
  /** The written reference each source was resolved for, aligned with
   * `sources`: none for content in hand. */
  readonly references: Array<Reference | undefined>;
  readonly reading: Reading;
  /** The collection that resolved it: its index among the requirements'
   * {@link ResolvedCollectionPart parts}. */
  readonly part: number;
}

/** One collection of a target's requirements, as it was resolved. */
interface ResolvedCollectionPart {
  /** The versions that conflict in the collection, found as it was resolved. */
  readonly conflicts: Conflicts;
  /** Find what conflicts among some of what the collection resolved, used
   * together without the rest. */
  readonly conflictsAmong: (shipped: ReadonlyArray<Resolved>) => Computable<Conflicts>;
}

/** A target's requirements, resolved, by name in the order stated. */
export class ResolvedRequirements {
  /** Each requirement's resolved sources. */
  public readonly sources: ReadonlyMap<string, ReadonlyArray<Resolved>>;
  /** The written reference each of a requirement's sources was resolved for,
   * aligned with {@link sources}: none for content in hand. */
  public readonly references: ReadonlyMap<string, ReadonlyArray<Reference | undefined>>;
  /** The versions that conflict in the collections the requirements were
   * resolved in. */
  public readonly conflicts: Conflicts;

  constructor(
    private readonly entries: ReadonlyMap<string, ResolvedRequirement>,
    /** The collections the requirements were resolved in. */
    private readonly parts: ReadonlyArray<ResolvedCollectionPart>,
    /** Whether the requirements are collected {@link ResolutionSpec.permissive permissively}. */
    public readonly permissive: boolean,
    /** What the target builds, as its rule declares it, where it does. */
    public readonly result?: Builds,
    /** The advisories the target's build fixes in the package it is made from, as its rule declares them ({@link ResolutionSpec.fixes}). */
    public readonly fixes: ReadonlyArray<string> = []
  ) {
    this.sources = new Map([...entries].map(([name, entry]) => [name, entry.sources]));
    this.references = new Map([...entries].map(([name, entry]) => [name, entry.references]));
    this.conflicts = Conflicts.union(parts.map(part => part.conflicts));
  }

  /** Make the requirements of one unnamed list: what a name denotes, resolved
   * as one collection. */
  public static of(sources: Resolved[], references: Array<Reference | undefined>, conflicts: Conflicts): ResolvedRequirements {
    return new ResolvedRequirements(
      new Map([["", { sources, references, reading: "packages", part: 0 }]]),
      [{ conflicts, conflictsAmong: () => Computable.resolve(conflicts) }],
      false
    );
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
    return new ResolvedRequirements(new Map(kept), this.parts, this.permissive, this.result, this.fixes);
  }

  /**
   * Get the requirements of the target `target` among these, each named
   * `<target>.<name>`, as requirements named `<name>`, collected strictly
   * unless `permissive`, of a target that builds what `result` says and fixes
   * the advisories `fixes` names, with what conflicts among their sources alone, in each collection that
   * resolved them.
   */
  public ofTarget(target: string, { permissive, result, fixes }: Pick<ResolutionSpec, "permissive" | "result" | "fixes">): Computable<ResolvedRequirements> {
    const kept = [...this.entries]
      .filter(([name]) => name.startsWith(`${target}.`))
      .map(([name, entry]): [string, ResolvedRequirement] => [name.substring(target.length + 1), entry]);
    return Computable.forAll(
      this.parts.map((part, index) => part.conflictsAmong(kept.flatMap(([, entry]) => (entry.part === index ? entry.sources : [])))),
      (...conflicts: Conflicts[]) =>
        new ResolvedRequirements(
          new Map(kept),
          this.parts.map((part, index) => ({ conflicts: conflicts[index], conflictsAmong: part.conflictsAmong })),
          permissive === true,
          result,
          fixes
        )
    );
  }

  /** Materialize every requirement and finish it into what a rule reads,
   * each source aligned with the reference it was resolved for. */
  public materialize(config: InternalBuildContext, describe = false): Computable<Map<string, Collected>> {
    const names = [...this.entries.keys()];
    const entries = [...this.entries.values()];
    return materializeLists(
      entries.map(({ sources }) => sources),
      entries.map(({ references }) => references),
      describe
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
  const kept = list.map((source, at) => ({ source, reference: references[at] }));
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
 * Run the resolve half of `target`'s collection point: every requirement read,
 * and each of the spec's collections resolved as ONE collection, for its
 * operation — every reference answered from its repository's joint
 * resolution, the graph wired — with nothing fetched and nothing built. The
 * strict check is left for when the requirements are materialized
 * ({@link ResolvedRequirements.check}).
 */
export function resolveRequirements(target: TargetContext, spec: ResolutionSpec): Computable<ResolvedRequirements> {
  let entries: Array<[string, RequiredSources, string]>;
  try {
    entries = specEntries(spec);
  } catch (err) {
    return Computable.reject(toError(err));
  }
  return Computable.forAll(
    entries.map(([, value]) => (value instanceof Computable ? value : Computable.resolve(value))),
    (...values: Read[]) => {
      const names = entries.map(([name]) => name);
      const lists = values.map((value): SourceRef[] => (Array.isArray(value) ? value : value.sources));
      const readings = values.map((value): Reading => (Array.isArray(value) ? "files" : value.read));
      /* What a target passes on is packages. */
      const misread = names.find((name, index) => TRANSITIVE_KEYS.has(requirementName(name)) && readings[index] === "files" && lists[index].length > 0);
      if (misread !== undefined) {
        throw new FabrError(`internal: the rule of '${target.name}' reads its '${misread}' requirement for files`).withHelp(
          "what a target passes on is packages: read it with getPackageProperty"
        );
      }
      const operations = [...new Set(entries.map(([, , operation]) => operation))];
      return Computable.forAll(
        operations.map(operation => {
          const at = names.flatMap((_, index) => (entries[index][2] === operation ? [index] : []));
          return resolveLists(
            withOperation(target, operation),
            at.map(index => lists[index]),
            at.map(index => readings[index] !== "contained"),
            at.map(index => requirementName(names[index]) === EXTENDS_KEY),
            at.map(index => (readings[index] === "files" || readings[index] === "sync" ? "files" : undefined))
          ).then(resolved => ({ at, resolved }));
        }),
        (...parts: Array<{ at: number[]; resolved: ResolvedLists }>) => {
          const resolvedEntries = new Map<number, ResolvedRequirement>();
          parts.forEach(({ at, resolved }, part) =>
            at.forEach((index, position) => {
              const value = values[index];
              const entry: ResolvedRequirement = {
                sources: resolved.lists[position],
                references: resolved.references[position],
                reading: readings[index],
                part,
              };
              if (value instanceof PackageSources && value.format !== undefined) {
                refuseOtherFormats(target, entry, value.format);
              }
              resolvedEntries.set(index, entry);
            })
          );
          return new ResolvedRequirements(
            new Map(names.map((name, index) => [name, resolvedEntries.get(index)!])),
            parts.map(({ resolved }) => ({ conflicts: resolved.conflicts, conflictsAmong: resolved.conflictsAmong })),
            spec.permissive === true,
            spec.result,
            spec.fixes
          );
        }
      );
    }
  );
}



/** Refuse a package among `entry`'s sources whose format is known and is not `format`, attributed to the reference it was resolved for. */
function refuseOtherFormats(target: TargetContext, { sources, references }: ResolvedRequirement, format: PackageFormat<unknown, unknown>): void {
  sources.forEach((source, at) => {
    const found = source instanceof ResolvedNode ? source.format : undefined;
    if (!(source instanceof ResolvedNode) || found === undefined || found === format) {
      return;
    }
    const reference = references[at];
    const written =
      reference === undefined ? source.packageName : reference instanceof RepositoryRef && reference.repositoryName !== undefined ? `${reference.repositoryName}:${reference.toString()}` : reference.toString();
    const error = new FabrError(`'${written}' is no ${format.name} package`).withHelp(
      `it is a package of ${found.name}, and '${target.name}' takes ${format.name} packages here`
    );
    throw reference === undefined ? error : new RequirementResolutionError([reference], error);
  });
}

/**
 * Get the requirement name `key` stands for: its last part, so that a name a
 * rule qualifies (`classes.extends`) is read as the name it qualifies, while
 * only the plain name is what the target itself passes on.
 */
function requirementName(key: string): string {
  return key.substring(key.lastIndexOf(".") + 1);
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
  /** The requirements as resolved, nothing materialized. */
  readonly resolved: ResolvedRequirements;
  /** Materialize every requirement as a description needs it (see
   * support/Description): a package a target builds, where its rule describes
   * it, is its description, a `DescribedPackage`, and not its build. Versions
   * that conflict are described as the resolution selected them, as `fabr deps`
   * shows them: only a build refuses them. Done on the first call, once. */
  describeAll(): Computable<MaterializedRequirements<P>>;
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
  let described: Computable<unknown> | undefined;
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
    resolved,
    materializeAll: () =>
      check().then(() => {
        const names = [...resolved.sources.keys()];
        return materialize(names).then(lists =>
          Object.assign(Object.create(null), Object.fromEntries(names.map((name, index) => [name, lists[index].sources])))
        );
      }) as Computable<MaterializedRequirements<Record<string, RequiredSources>>>,
    materialize: name => check().then(() => materialize([name]).then(([list]) => list.sources)) as Computable<FileSet[]>,
    packages: name => check().then(() => materialize([name]).then(([list]) => packageEdges(name, list))),
    describeAll: () =>
      (described ??= resolved
        .materialize(config, true)
        .then(lists =>
          Object.assign(Object.create(null), Object.fromEntries([...resolved.sources.keys()].map(name => [name, lists.get(name)?.sources ?? []])))
        )) as Computable<MaterializedRequirements<Record<string, RequiredSources>>>,
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

/** List a rule's requirements as pairs of name and sources, in the order written. */
function requirementEntries(requirements: Requirements): Array<[string, RequiredSources]> {
  return requirements instanceof Map ? [...requirements] : Object.entries(requirements);
}
