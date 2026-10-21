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
import { contentOf, isPackage, Package, ResolvedNode } from "../core/PackageFileSet";
import { TargetRef, Unbuilt } from "../core/TargetRef";
import { RepositoryCollection, ProjectedPackage, isRepositoryReader, Repository, RepositoryPublishRef, RepositoryRef, SourceRef } from "../core/Repository";
import { ResolvedCollection, ResolvedMember, Resolution } from "../resolver/Types";
import { FileSetRef } from "../core/FileSetRef";
import { Requirement } from "../resolver/Types";
import { chainSteps, describeProvenance } from "../core/Provenance";
import { ConflictError, FabrError, IConflictSource, RequirementResolutionError } from "../core/Errors";
import { Name } from "../core/Name";
/* A catalog is a collection point of its own, the one outside context/, so it
 * takes these from the module rather than the package's API. */
import { consumeMarker, Markers, resolveCollection } from "../context/CollectionPoint";
import { TargetContext } from "../context/index";
import { BUILD_OVERRIDE } from "../model/Constraints";
import { declaredRequirement, knownAs } from "../resolver/PackageResolver";
import { RepositoryRegistration } from "./Types";

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
 * **table** rather than a registry. The joint resolution is the catalog's own
 * collection point (resolveCatalog, under `build`), and every consuming
 * reference rides the normal RepositoryRef path, grouped by this instance at
 * the consumer's collection point and answered from the table.
 */
export class CatalogRepository implements Repository, RepositoryCollection {
  constructor(
    private readonly catalogName: string,
    /* The operation of the configuration this instance was made in (interned
     * per BuildContext like any repository). */
    private readonly operation: string,
    /* The entries, resolved once and shared, each target among them held as
     * its node, unbuilt: declaring or consulting a catalog fetches no member
     * and builds nothing. */
    private readonly resolved: Computable<ResolvedCatalog>
  ) {}

  /**
   * Look up the ONE member `reference` names in the catalog's resolution, with
   * the operation of this instance's configuration, which says what it is
   * answered with. Whether what a consumer takes is acceptable is judged at
   * that consumer's collection point, over everything it uses together.
   */
  public member(reference: RepositoryRef): Computable<ResolvedMember> {
    return this.resolved.then(
      (catalog): ResolvedMember => ({
        collection: catalog.collection,
        entry: this.entryFor(reference, catalog),
        operation: this.operation,
      })
    );
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
    return this.resolved.then(({ entries }) => {
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
   * trailing `:tail` projects into the pinned package. A `?` or `!` marker is
   * the reference's own; one on a projection is refused.
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

  /** A catalog pins versions for reading; it is not a place content goes. */
  public getRepositoryPublishRef(name: Name): RepositoryPublishRef {
    throw new FabrError(`a catalog is not a publish destination (cannot sync to '${name.toString()}')`);
  }
}

/** The provenance + concrete detail attributing one catalog entry (for a
 * same-name conflict): a reference by what was written, a locally built
 * package by itself. */
function conflictSide(entry: CatalogEntry): IConflictSource {
  return isPackage(entry)
    ? { provenance: entry.origin, detail: entry.version }
    : { provenance: chainSteps(entry.steps, undefined), detail: entry.name };
}

/** Prepare the catalog's entries as sources to resolve: a target among
 * them as its node, resolved and not built, with its marker recorded in
 * `markers`. */
function entryNodes(sources: SourceRef[], markers: Markers): Computable<Array<SourceRef | Unbuilt>> {
  return Computable.forAll(
    sources.map(source =>
      source instanceof TargetRef
        ? source.nodes().then(nodes => consumeMarker(source, nodes, markers))
        : Computable.resolve<Array<SourceRef | Unbuilt>>([source])
    ),
    (...entries: Array<SourceRef | Unbuilt>[]) => entries.flat()
  );
}

/**
 * Resolve the catalog's `deps` jointly under `build`, whatever the catalog is
 * consumed under, and key each entry by the name it is delivered as. No member
 * is fetched and nothing is built: an entry that is a target is its node,
 * unbuilt, with what its rule states it passes on. Of entries claiming one
 * name, a forced one (`!`) is the member; otherwise they are a conflict.
 */
function resolveCatalog(context: TargetContext): Computable<ResolvedCatalog> {
  const markers: Markers = new Map();
  return context
    .getFileProperty("deps", BUILD_OVERRIDE)
    .then(sources => entryNodes(sources, markers))
    .then(sources => {
      const references = sources.filter((source): source is RepositoryRef => source instanceof RepositoryRef);
      /* A catalog pins whole packages: an entry projecting *into* one would
       * resolve to plain files, not a PackageFileSet — reject it outright (its
       * projected content is never computed just to fail), whether it is an
       * external requirement (`@npm:pkg:1.0.0:lib/*`, a projected reference) or
       * a built target (`mylib:build/*`, a projection-pending local entry). */
      const projectsInto = (what: string): Error =>
        new FabrError(`Catalog entry ${what} projects into a package`).withHelp(
          "a catalog pins whole packages — project at the point of use instead (`@catalog:pkg:path`)"
        );
      const projected = references.find(reference => reference.projections.length > 0);
      if (projected) {
        throw projectsInto(`'${projected.toString()}'`);
      }
      const pendingLocal = sources.find(
        (source): source is FileSetRef | ProjectedPackage => source instanceof FileSetRef || source instanceof ProjectedPackage
      );
      if (pendingLocal) {
        const base = pendingLocal instanceof ProjectedPackage ? pendingLocal.base : pendingLocal.source;
        throw projectsInto(isPackage(base) ? `'${base.packageName}'` : "of a local target");
      }
      /* Anything neither a requirement nor content pins nothing — a bare
       * repository name (`deps = @npm;`) or a fetch table. Silence here would
       * leave the catalog quietly empty of the entry. */
      const inert = sources.find(source => !(source instanceof RepositoryRef) && !(source instanceof FileSet) && !isPackage(source));
      if (inert) {
        throw new FabrError(`Catalog ${context.name} has an entry that names no packages`).withHelp(
          "each entry must name specific packages — an external requirement (`@npm:pkg:1.2.3`) or a built package target; a bare repository reference pins nothing"
        );
      }
      /* A catalog pins package VERSIONS, so its entries must come from a
       * repository that resolves them. A member of another catalog is rejected:
       * each catalog is its own joint resolution. */
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
      const local = sources
        .filter((source): source is FileSet | ResolvedNode => source instanceof FileSet || source instanceof ResolvedNode)
        .map((content): Package => {
          if (!isPackage(content)) {
            const from = describeProvenance(content.origin);
            throw new FabrError(`Catalog ${context.name} has an entry with no name to address it by${from ? ` (${from})` : ""}`).withHelp(
              "a catalog entry is a package requirement (`@npm:pkg:1.2.3`) or a target, addressed by its name"
            );
          }
          return content;
        });
      const collection = resolveCollection(context, [...references, ...local], undefined, undefined, markers);
      const written = new Set(references);
      /* A catalog is one collection point: every resolution is made before its
       * entries are keyed. */
      const builds = collection.builds === undefined ? [] : [collection.builds.resolution];
      return Computable.forAll(
        [...new Set([...collection.resolutions.values(), ...builds])].map(resolution => resolution()),
        (...resolutions: Resolution[]) => {
          /* Key the entries by the name each is delivered as: the references
           * the catalog wrote, found among a resolution's roots, and its
           * targets. The other roots are references its targets carry, and
           * name no member. Of entries under one name, a forced one (`!`)
           * wins, as in the resolution. An alternate (`?`) is no root, hence no
           * entry, and one build written twice is one entry. */
          const candidates = new Map<string, CatalogEntry[]>();
          const add = (name: string, entry: CatalogEntry): void => {
            const held = candidates.get(name) ?? [];
            if (!held.some(other => other === entry || (isPackage(other) && isPackage(entry) && contentOf(other).key === contentOf(entry).key))) {
              candidates.set(name, [...held, entry]);
            }
          };
          for (const resolution of resolutions) {
            for (const root of resolution.roots) {
              if (written.has(root.reference)) {
                add(root.name, root.reference);
              }
            }
          }
          local.forEach(pkg => add(pkg.packageName, pkg));
          const forced = (entry: CatalogEntry): boolean => (isPackage(entry) ? markers.get(entry) === "force" : entry.override === "force");
          const entries = new Map<string, CatalogEntry>();
          for (const [name, held] of candidates) {
            const [first, second] = held.some(forced) ? held.filter(forced) : held;
            if (second !== undefined) {
              throw new ConflictError("catalog entries", name, conflictSide(first), conflictSide(second));
            }
            entries.set(name, first);
          }
          return { entries, collection };
        }
      );
    });
}

function createCatalog(context: TargetContext): Computable<Repository> {
  return Computable.resolve(new CatalogRepository(context.name, context.operation, resolveCatalog(context)));
}

export const catalogRepositoryRegistration: RepositoryRegistration = { type: "catalog", provider: createCatalog };
