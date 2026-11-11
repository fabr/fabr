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
 * target written there, unbuilt. Either is taken from the catalog's resolution
 * by the collection point that names it, with the references it carries bound
 * by that resolution.
 */
type CatalogEntry = RepositoryRef | Package;

/** The catalog's entries by the name each is delivered as, and the collection they
 * were resolved in. */
interface ResolvedCatalog {
  readonly entries: ReadonlyMap<string, CatalogEntry>;
  readonly collection: ResolvedCollection;
}

/**
 * A **catalog** is an explicit, named, opt-in shared collection point. It pins a
 * fixed set of requirements (its `deps` property) and resolves them **jointly
 * and once**, as the single minimal-version selection over all of the
 * catalog's roots. Each resolved root is exposed by the name it is delivered
 * as: its package name, or the name a written rename gives it
 * (`@npm:typescript:6.0.0-beta -> typescript-6`). The address must be unique,
 * not the package behind it, so two versions of one package can sit side by
 * side in a catalog. The catalog delivers nothing itself: a reference
 * `@cat:pkg` names a member, and the consumer's collection point takes its
 * node, wired to the catalog's selection, into its own graph, so every
 * consumer gets the same versions.
 *
 * Mechanically it is a {@link Repository} whose read face answers from a
 * **table** rather than a registry. Its `deps` are its requirements, resolved
 * as a target's are, under `build`, once for each of a consumer's collections
 * (`build` and `run`, as a rule's two collections are resolved apart; one
 * collection where the two resolve alike), and every consuming reference
 * rides the normal RepositoryRef path, grouped by this instance at the
 * consumer's collection point and answered from the table.
 */
export class CatalogRepository implements Repository, RepositoryCollection {
  constructor(
    private readonly catalogName: string,
    /* The operation of the configuration this instance was made in (interned
     * per BuildContext like any repository). */
    private readonly operation: string,
    /* The entries as each of a consumer's collections resolved them. */
    private readonly sides: ReadonlyMap<UsedFor, ResolvedCatalog>
  ) {}

  /** Get the entries as the collection `side` resolved them. */
  private resolved(side: UsedFor = "build"): Computable<ResolvedCatalog> {
    return Computable.resolve(this.sides.get(side)!);
  }

  /**
   * Look up the ONE member `reference` names in the catalog's resolution for
   * the consumer's collection resolved for `operation`, with the operation of
   * this instance's configuration, which says what it is answered with.
   * Whether what a consumer takes is acceptable is judged at that consumer's
   * collection point, over everything it uses together.
   */
  public member(reference: RepositoryRef, operation: string): Computable<ResolvedMember> {
    return this.resolved(usedForOf(operation)).then((catalog): ResolvedMember => ({
      collection: catalog.collection,
      entry: this.entryFor(reference, catalog),
      operation: this.operation,
    }));
  }

  /** Look up the entry a reference names. An unknown one is a resolution
   *  failure, as for any repository lacking a requirement, attributed to the
   *  reference that wrote it. */
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
   * Get the requirement a member was **declared** with in the catalog's `deps` — NOT
   * the version the joint resolution pinned it to. An external member's is
   * what its reference states (`@npm:pkg:1.2.3`); a member built in the project
   * states no version here, having none until it is built, and whoever holds
   * the built package supplies it.
   *
   * The **address** is the name the requirer knows it by — a member pinned under
   * another name (`@dep:typescript-6`) is imported under that name — so it is
   * recorded as the requirement's `renameTo` where it differs from the package's
   * own name. (A rename written on `ref` itself outranks it, applied by the caller.)
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
   * Vend the reference to a member. The member name is the whole literal up to
   * a projection `:` (versions live in the catalog, not the reference), so a `/`
   * inside a scoped name (`@types/node`) is part of the key, not a boundary. A
   * trailing `:tail` projects into the pinned package. A `?` or `!` ending the
   * alias is the reference's marker; after a projection it is part of the
   * pattern.
   */
  public getRepositoryRef(name: Name): RepositoryRef {
    /* A `?` or `!` ending the reference is a marker only on the alias alone;
     * after a projection it is the last character of the pattern. */
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

  /** List the catalog's members by the address each is pinned under, in
   *  code-unit order. Nothing is fetched or built: the catalog's resolution is
   *  all it reads. */
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

  /** Refuse a publish: a catalog pins versions for reading; it is not a place
   *  content goes. */
  public getRepositoryPublishRef(name: Name): RepositoryPublishRef {
    throw new FabrError(`a catalog is not a publish destination (cannot sync to '${name.toString()}')`);
  }
}

/** The requirement each of a consumer's collections is answered from. */
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
 * Refuse an entry the catalog cannot pin, as written: one projecting into a
 * package, one naming no package, and a reference to a repository that does
 * not resolve versions, or to another catalog's member.
 */
function checkEntries(context: TargetContext, sources: ReadonlyArray<SourceRef>): void {
  /* A catalog pins whole packages: an entry projecting *into* one would
   * resolve to plain files, not a package — reject it outright, whether it is
   * an external requirement (`@npm:pkg:1.0.0:lib/*`, a projected reference)
   * or a built target (`mylib:build/*`). */
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
  /* A catalog pins package VERSIONS, so its entries must come from a
   * repository that resolves them. A member of another catalog is rejected:
   * each catalog is its own joint resolution. */
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
  /* Anything neither a requirement nor a target nor a package pins nothing:
   * a fetch table, say. Silence here would leave the catalog quietly empty of
   * the entry. */
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
 * name each is delivered as: its package name, or the alias a written rename
 * gives it. An entry is the reference written, or for a package of the
 * project the package as the collection holds it, unbuilt. An alternate (`?`)
 * is no entry, and one build written twice is one entry.
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
