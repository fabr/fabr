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

import { Computable } from "../core/Computable";
import { FileSet } from "../core/FileSet";
import { contentOf, isPackage, Package, UsedFor } from "../core/PackageFileSet";
import { TargetRef } from "../core/TargetRef";
import {
  RepositoryCollection,
  isRepositoryReader,
  Repository,
  RepositoryPublishRef,
  RepositoryRef,
  SourceRef,
} from "../core/Repository";
import { ResolvedCollection, ResolvedMember } from "../resolver/Types";
import { FileSetRef } from "../core/FileSetRef";
import { Requirement } from "../resolver/Types";
import { describeProvenance } from "../core/Provenance";
import { FabrError, RequirementResolutionError } from "../core/Errors";
import type { Credential } from "../core/Credential";
import { isIncompleteRef } from "../core/NamespaceRef";
import { Name } from "../core/Name";
import { compareText } from "../support/Functional";
import type { Reference } from "../core/Reference";
import type { PartialRepositoryRef } from "../core/PartialRepositoryRef";
import { usedForOf } from "../context/CollectionPoint";
import { ResolutionSpec, ResolvedRequirements, TargetContext } from "../context/index";
import { BUILD_OVERRIDE } from "../model/Constraints";
import { declaredRequirement, knownAs } from "../resolver/PackageResolver";
import { RepositoryImplementation, RepositoryRegistration } from "./Types";

/**
 * A catalog entry: the reference written in `deps`, or the package node of a
 * target written there, unbuilt. A consumer that names the entry takes it from
 * the catalog's resolution, its requirements bound as that resolution bound
 * them.
 */
type CatalogEntry = RepositoryRef | Package;

/** The catalog's entries, by the name each is addressed as, and the collection
 * they were resolved in. */
interface ResolvedCatalog {
  readonly entries: ReadonlyMap<string, CatalogEntry>;
  readonly collection: ResolvedCollection;
}

/**
 * The repository a `catalog` declaration is: a named set of requirements (its
 * `deps`) resolved together, which every consumer takes its versions from.
 * `deps` are the catalog's requirements, read under `build` and resolved as a
 * target's are, once for each of a consumer's two collections (`build` and
 * `run`; once for both where they resolve alike).
 *
 * Each entry is addressed by its package name, or the name a written rename
 * gives it (`@npm:typescript:6.0.0-beta -> typescript-6`), so two versions of
 * one package may be entries under two names. A reference `@cat:pkg` names an
 * entry; the catalog fetches and builds nothing, and the consumer's collection
 * point takes the entry's node, with the catalog's selections, into its own
 * graph.
 */
export class CatalogRepository implements Repository, RepositoryCollection {
  constructor(
    private readonly catalogName: string,
    /* The operation of the configuration this instance was made in. */
    private readonly operation: string,
    /* The entries as each of a consumer's collections resolved them. */
    private readonly sides: ReadonlyMap<UsedFor, ResolvedCatalog>
  ) {}

  /** Get the entries as the collection `side` resolved them. */
  private resolved(side: UsedFor = "build"): Computable<ResolvedCatalog> {
    return Computable.resolve(this.sides.get(side)!);
  }

  /**
   * Look up the member `reference` names, in the catalog's resolution for a
   * consumer's collection resolved for `operation`. The result carries this
   * instance's operation, which says what the member is answered as (a
   * package, its files, or a program). Rejects as {@link entryFor} throws.
   */
  public member(reference: RepositoryRef, operation: string): Computable<ResolvedMember> {
    return this.resolved(usedForOf(operation)).then((catalog): ResolvedMember => ({
      collection: catalog.collection,
      entry: this.entryFor(reference, catalog),
      operation: this.operation,
    }));
  }

  /** Look up the entry `reference` names. Throws a RequirementResolutionError,
   *  naming the reference and listing the entries, where there is none. */
  private entryFor(reference: RepositoryRef, { entries }: ResolvedCatalog): CatalogEntry {
    const name = reference.name;
    const entry = entries.get(name);
    if (!entry) {
      throw new RequirementResolutionError(
        [reference],
        new FabrError(`Catalog ${this.catalogName} has no member '${name}'`).withHelp(
          entries.size > 0 ? `it pins: ${[...entries.keys()].sort().join(", ")}` : "the catalog pins nothing"
        )
      );
    }
    return entry;
  }

  /**
   * Get the requirement the member `ref` names was written with in `deps`, for
   * a manifest, not the version the catalog selected: for a registry
   * reference, what it states (`@npm:pkg:1.2.3`); for a target, as
   * {@link declaredRequirement} reads it. The member's address is set as the
   * requirement's `renameTo` where it differs from the package's name
   * (`@dep:typescript-6` is imported as `typescript-6`); a rename written on
   * `ref` itself is the caller's to apply over it.
   * @return the requirement, or undefined where `ref` names no member.
   */
  public declaredRequirement(ref: RepositoryRef): Computable<Requirement | undefined> {
    const name = ref.name;
    return this.resolved().then(({ entries }) => {
      const entry = entries.get(name);
      return entry === undefined
        ? Computable.resolve(undefined)
        : declaredRequirement(entry).then(requirement => (requirement === undefined ? undefined : knownAs(requirement, name)));
    });
  }

  /**
   * Vend the reference to a member. The member's address is the literal up to
   * the first `:`, so a `/` in a scoped name (`@types/node`) is part of it; a
   * `:tail` after it projects into the member. A `?` or `!` ending the address
   * is the reference's marker; after a projection it is part of the pattern.
   */
  public getRepositoryRef(name: Name): RepositoryRef {
    /* A projection: any `?` or `!` is the pattern's. */
    const lit = name.getLiteralPrefix();
    const colon = lit.indexOf(":");
    if (colon !== -1) {
      return new RepositoryRef(this, { name: lit.substring(0, colon), versionConstraint: undefined }).find(name.substring(colon + 1));
    }
    const override = name.getMarker();
    const member = name.withoutMarker();
    return new RepositoryRef(this, {
      name: member.toBaseString(),
      versionConstraint: undefined,
      renameTo: member.getRenameTo()?.toString(),
      ...(override === undefined ? {} : { override }),
    });
  }

  /** List the catalog's members by address, in code-unit order, fetching and
   *  building nothing. Rejects for any namespace but the whole catalog. */
  public children({ name: namespace }: PartialRepositoryRef): Computable<Map<string, Reference>> {
    if (namespace !== "") {
      return Computable.reject(new FabrError(`Catalog ${this.catalogName} has no namespace '${namespace}'`));
    }
    return this.resolved().then(
      ({ entries }) =>
        new Map(
          [...entries.keys()]
            .sort(compareText)
            .map((name): [string, Reference] => [name, new RepositoryRef(this, { name, versionConstraint: undefined })])
        )
    );
  }

  /** Throw: a catalog is no publish destination. */
  public getRepositoryPublishRef(name: Name): RepositoryPublishRef {
    throw new FabrError(`a catalog is not a publish destination (cannot sync to '${name.toString()}')`);
  }
}

/** The catalog's requirement each of a consumer's collections is answered from, by collection. */
const SIDE_REQUIREMENTS = new Map<UsedFor, string>([
  ["build", "deps"],
  ["run", "run_deps"],
]);

/**
 * State the catalog's requirements: its `deps`, read under `build` whatever
 * the catalog is consumed under, for each of a consumer's collections, each
 * entry checked as written first.
 */
function catalogRequirements(context: TargetContext): ResolutionSpec {
  const deps = context.getPackageProperty("deps", BUILD_OVERRIDE).then(read => {
    checkEntries(context, read.sources);
    return read;
  });
  return { build: { [SIDE_REQUIREMENTS.get("build")!]: deps }, run: { [SIDE_REQUIREMENTS.get("run")!]: deps } };
}

/**
 * Throw for an entry the catalog cannot hold, as written: one projecting into a
 * package, a reference to a repository that does not resolve versions or to
 * another catalog's member, and one naming no package (a fetch table).
 */
function checkEntries(context: TargetContext, sources: ReadonlyArray<SourceRef>): void {
  /* An entry projecting into a package (`@npm:pkg:1.0.0:lib/*`,
   * `mylib:build/*`) would be plain files, not a package. */
  const projectsInto = (what: string): Error =>
    new FabrError(`Catalog entry ${what} projects into a package`).withHelp(
      "a catalog pins whole packages — project at the point of use instead (`@catalog:pkg:path`)"
    );
  const projected = sources.find(
    (source): source is RepositoryRef | TargetRef =>
      (source instanceof RepositoryRef || source instanceof TargetRef) && source.projections.length > 0
  );
  if (projected) {
    throw projectsInto(`'${projected.toString()}'`);
  }
  const pendingLocal = sources.find((source): source is FileSetRef => source instanceof FileSetRef);
  if (pendingLocal) {
    throw projectsInto(isPackage(pendingLocal.source) ? `'${pendingLocal.source.packageName}'` : "of a local target");
  }
  /* A registry reference must be to a repository that resolves versions; a
   * member of another catalog is refused. */
  const references = sources.filter((source): source is RepositoryRef => source instanceof RepositoryRef);
  const unresolvable = references.find(reference => !isRepositoryReader(reference.source));
  if (unresolvable) {
    const entry = unresolvable.toString();
    throw new RequirementResolutionError(
      references.filter(reference => reference.source === unresolvable.source),
      unresolvable.source instanceof CatalogRepository
        ? new FabrError(`Catalog entry '${entry}' is a member of another catalog`).withHelp(
            "a catalog cannot pin another catalog's members — pin the package directly here, or reference the other catalog's member at the point of use"
          )
        : new FabrError(`Catalog entry '${entry}' comes from a repository that does not resolve package versions`).withHelp(
            "a catalog pins versions of registry packages; reference the repository's content directly instead"
          )
    );
  }
  /* Anything neither a requirement, a target nor a package (a fetch table)
   * names no package. */
  const inert = sources.find(
    source => !(source instanceof RepositoryRef) && !(source instanceof TargetRef) && !isIncompleteRef(source) && !isPackage(source)
  );
  if (inert) {
    throw new FabrError(`Catalog ${context.name} has an entry that names no packages`).withHelp(
      "each entry must name specific packages — an external requirement (`@npm:pkg:1.2.3`) or a built package target; a bare repository reference pins nothing"
    );
  }
}

/**
 * Key the entries of the catalog's requirement `requirement`, resolved, by the
 * name each is addressed as: its package name, or the alias a written rename
 * gives it. An entry is the reference written, or for a package built in the
 * project, the package as the collection holds it, unbuilt. An alternate
 * (`?`) is no entry, and one build written twice is one entry. Throws for an
 * entry that resolved to something other than a package.
 */
function catalogOf(catalogName: string, requirements: ResolvedRequirements, requirement: string): ResolvedCatalog {
  const collection = requirements.collectionOf(requirement);
  const references = requirements.references.get(requirement) ?? [];
  const entries = new Map<string, CatalogEntry>();
  (requirements.sources.get(requirement) ?? []).forEach((source, at) => {
    const reference = references[at];
    if (!isPackage(source)) {
      const from = source instanceof FileSet ? describeProvenance(source.origin) : undefined;
      throw new FabrError(`Catalog ${catalogName} has an entry with no name to address it by${from ? ` (${from})` : ""}`).withHelp(
        "a catalog entry is a package requirement (`@npm:pkg:1.2.3`) or a target, addressed by its name"
      );
    }
    entries.set(
      source.packageName,
      reference instanceof RepositoryRef ? reference : (collection.locals.get(contentOf(source).key) ?? source)
    );
  });
  return { entries, collection };
}

/** Make the catalog a `catalog` declaration is, from its resolved requirements. */
function createCatalog(
  context: TargetContext,
  _url: string | undefined,
  _credential: Credential | undefined,
  requirements: ResolvedRequirements
): Computable<Repository> {
  return Computable.resolve(undefined).then(
    () =>
      new CatalogRepository(
        context.name,
        context.operation,
        new Map([...SIDE_REQUIREMENTS].map(([side, requirement]) => [side, catalogOf(context.name, requirements, requirement)]))
      )
  );
}

export const catalogRepositoryRegistration: RepositoryRegistration = {
  type: "catalog",
  requirements: catalogRequirements,
  provider: createCatalog,
};

/** The implementation STD.fabr's `repository` declaration names. */
export default { requirements: catalogRequirements, provider: createCatalog } satisfies RepositoryImplementation;
