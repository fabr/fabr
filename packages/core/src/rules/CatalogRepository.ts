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
import { PackageFileSet } from "../core/PackageFileSet";
import { RunnableFileSet } from "../core/RunnableFileSet";
import {
  ResolvedCollection,
  materializeCollection,
  resolveCollection,
  isRepositoryReader,
  Repository,
  RepositoryPublishRef,
  RepositoryLookup,
  RepositoryRef,
  Resolution,
  ResolutionContext,
} from "../core/Repository";
import { FileSetRef } from "../core/FileSetRef";
import { Requirement } from "../resolver/Types";
import { chainSteps, describeProvenance } from "../core/Provenance";
import { ConflictError, FabrError, IConflictSource, RequirementResolutionError, toError } from "../core/Errors";
import { Name } from "../core/Name";
import { TargetContext } from "../model/BuildContext";
import { BUILD_OPERATION, BUILD_OVERRIDE, FILES_OPERATION } from "../model/Constraints";
import { declaredRequirement, fetchPinnedPackage, knownAs, runnableFrom } from "../resolver/PackageResolver";
import { RepositoryRegistration } from "./Types";

/**
 * A **catalog** is an explicit, named, opt-in shared collection point: it pins a
 * fixed set of requirements (its `deps` property), resolves them **jointly and
 * once** — the single minimal-version-selection over all of the catalog's roots —
 * and exposes each resolved root by the name it is delivered as — its package
 * name, or the name a written rename gives it (`@npm:typescript:6.0.0-beta ->
 * typescript-6`), which is what lets two versions of one package sit side by
 * side in a catalog: it is the address that must be unique, not the package
 * behind it. A reference `@cat:pkg` therefore delivers an *already-resolved*
 * package (carrying its co-resolved closure), so every consumer gets the same
 * versions and does no resolution of its own.
 *
 * Mechanically it is just a {@link Repository} whose read face answers from a
 * **table** rather than a registry: the joint resolution is the catalog's own
 * collection point (resolveCatalog, forced to build), and every consuming
 * reference rides the normal RepositoryRef path — grouped by this instance at
 * the consumer's collection point and answered from the table.
 *
 * This is a deliberate, sanctioned exception to "the resolution boundary is the
 * consuming target, never a context-global fixpoint": the catalog IS a shared
 * boundary, but a user-declared and named one, not an implicit global fixpoint.
 */
/**
 * A catalog entry: the reference written in `deps`, or the package a locally
 * built entry was evaluated to. Either is delivered from the catalog's resolution, a
 * package with the references it carries bound by it.
 */
type CatalogEntry = RepositoryRef | PackageFileSet;

/** The catalog's entries by the name each is delivered as, and the collection they
 * were resolved in. */
interface ResolvedCatalog {
  readonly entries: ReadonlyMap<string, CatalogEntry>;
  readonly collection: ResolvedCollection;
}

export class CatalogRepository implements Repository, RepositoryLookup {
  constructor(
    private readonly catalogName: string,
    /* The narrow consuming-side surface of the context this instance was
     * declared under (interned per BuildContext like any repository): the
     * operation it is consumed under — which decides package-vs-runnable
     * delivery — and what the resolution layer needs when a member's pinned
     * closure is materialized through it. */
    private readonly context: ResolutionContext,
    /* The entries are resolved once and shared, but a member's package is
     * fetched only when a delivery names it. */
    private readonly resolved: Computable<ResolvedCatalog>
  ) {}

  /**
   * Deliver the ONE named member, fetched on demand from its resolution (a member
   * never named is never fetched): only what it reaches is materialized, under
   * the catalog's joint selection — never a fresh one. A locally built member
   * is delivered with the references it carries bound by the same resolution. Under
   * `run` the member is made runnable via its source's format, keeping that
   * same closure; under `files` the member is delivered alone (see
   * {@link deliverFiles}).
   *
   * The catalog resolves once (forced build); whether what a consumer takes
   * from it is acceptable is judged at that consumer's collection point, over
   * everything it uses together — so one pinned tree can serve a sealed tool
   * member (repairs nested) and a strict linked member side by side.
   */
  public deliver(reference: RepositoryRef): Computable<FileSet> {
    return this.context.getGlobalString(BUILD_OPERATION).then(operation =>
      this.resolved.then(catalog => {
        if (operation === FILES_OPERATION) {
          return this.deliverFiles(reference);
        }
        const entry = this.entryFor(reference, catalog);
        return materializeCollection(this.context, catalog.collection, [entry])
          .then(({ delivered: [pkg] }) => {
            if (!(pkg instanceof PackageFileSet)) {
              throw new FabrError(`internal: catalog member '${reference.toString()}' resolved to no package`);
            }
            return operation === "run" ? this.toRunnable(reference.name, entry, pkg) : Computable.resolve<FileSet>(pkg);
          })
          .catch(err => {
            throw new RequirementResolutionError([reference], toError(err));
          });
      })
    );
  }

  /** The named member alone at its pinned version, named as the catalog
   *  delivers it: its closure is neither fetched nor assembled. */
  public deliverFiles(reference: RepositoryRef): Computable<FileSet> {
    return this.resolved.then(catalog => {
      const entry = this.entryFor(reference, catalog);
      if (entry instanceof PackageFileSet) {
        return Computable.resolve<FileSet>(entry);
      }
      const source = entry.source;
      const resolution = catalog.collection.resolutions.get(source);
      if (!isRepositoryReader(source) || resolution === undefined) {
        /* resolveCatalog admits only entries a registry resolves. */
        throw new FabrError(`internal: catalog member '${reference.toString()}' has no resolution`);
      }
      return resolution()
        .then(resolved => fetchPinnedPackage(source, entry, resolved))
        .then(files => entry.deliveredAs(files) as FileSet)
        .catch(err => {
          throw new RequirementResolutionError([reference], toError(err));
        });
    });
  }

  /** The entry a reference names. An unknown one is just a resolution
   *  failure — like any repository not having a requirement — attributed to the
   *  reference that wrote it. */
  private entryFor(reference: RepositoryRef, { entries }: ResolvedCatalog): CatalogEntry {
    const name = memberNameOf(reference);
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

  private toRunnable(name: string, entry: CatalogEntry, pkg: PackageFileSet): Computable<RunnableFileSet> {
    if (entry instanceof PackageFileSet) {
      throw new FabrError(
        `Catalog ${this.catalogName} member '${name}' is a locally-built target, which the catalog cannot deliver as a runnable`
      ).withHelp("run the target directly rather than through the catalog");
    }
    return runnableFrom(entry.source, pkg);
  }

  /**
   * The requirement a member was **declared** with in the catalog's `deps` — NOT
   * the version the joint resolution pinned it to. A locally-built member
   * declares its own version, if it has one; an external member's is what its
   * reference states (`@npm:pkg:1.2.3`).
   *
   * The **address** is the name the requirer knows it by — a member pinned under
   * another name (`@dep:typescript-6`) is imported under that name — so it is
   * recorded as the requirement's `renameTo` where it differs from the package's
   * own name. (A rename written on `ref` itself outranks it, applied by the caller.)
   */
  public declaredRequirement(ref: RepositoryRef): Computable<Requirement | undefined> {
    const name = memberNameOf(ref);
    return this.resolved.then(({ entries }) => {
      const entry = entries.get(name);
      return entry === undefined
        ? Computable.resolve(undefined)
        : declaredRequirement(entry).then(requirement => (requirement === undefined ? undefined : knownAs(requirement, name)));
    });
  }

  /**
   * The member name is the whole literal up to a projection `:` — there is no
   * `name:version` to peel (versions live in the catalog, not the reference), so
   * a `/` inside a scoped name (`@types/node`) is part of the key, not a
   * boundary. A trailing `:tail` projects into the pinned package.
   */
  public getRepositoryRef(name: Name): RepositoryRef {
    const lit = name.getLiteralPrefix();
    const colon = lit.indexOf(":");
    if (colon === -1) {
      return RepositoryRef.written(this, name);
    }
    return new RepositoryRef(this, { name: lit.substring(0, colon), versionConstraint: undefined }).find(name.substring(colon + 1));
  }

  /** A catalog pins versions for reading; it is not a place content goes. */
  public getRepositoryPublishRef(name: Name): RepositoryPublishRef {
    throw new FabrError(`a catalog is not a publish destination (cannot sync to '${name.toString()}')`);
  }
}

/** The member name a consumer's reference asks for: the literal up to a
 * projection `:`, with the facets left off — a `-> ` written HERE renames what
 * the catalog delivers (applied where every delivery is finished) and names no
 * member. Every table lookup goes through this, so they cannot disagree about
 * what a reference addresses. */
function memberNameOf(reference: RepositoryRef): string {
  return reference.name;
}

/** The provenance + concrete detail attributing one catalog entry (for a
 * same-name conflict): a reference by what was written, a locally built
 * package by itself. */
function conflictSide(entry: CatalogEntry): IConflictSource {
  return entry instanceof PackageFileSet
    ? { provenance: entry.origin, detail: entry.version }
    : { provenance: chainSteps(entry.steps, undefined), detail: entry.name };
}

/**
 * Resolve the catalog's `deps` — NOT fetched — forcing build (members are
 * wanted as mountable packages regardless of how the catalog is consumed), and
 * key each entry by the name it is delivered as. A reference is resolved
 * jointly with every other in its registry; a local target reference is
 * evaluated (built) where it is read, and the references its package carries
 * are resolved with the rest, as at any collection point. Two entries claiming
 * one name are a conflict.
 */
function resolveCatalog(context: TargetContext): Computable<ResolvedCatalog> {
  return context.getFileProperty("deps", BUILD_OVERRIDE).then(sources => {
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
    const pendingLocal = sources.find((source): source is FileSetRef => source instanceof FileSetRef);
    if (pendingLocal) {
      const base = pendingLocal.source;
      throw projectsInto(base instanceof PackageFileSet ? `'${base.packageName}'` : "of a local target");
    }
    /* Anything neither a requirement nor content pins nothing — a bare
     * repository name (`deps = @npm;`) or a fetch table. Silence here would
     * leave the catalog quietly empty of the entry. */
    const inert = sources.find(source => !(source instanceof RepositoryRef) && !(source instanceof FileSet));
    if (inert) {
      throw new FabrError(`Catalog ${context.name} has an entry that names no packages`).withHelp(
        "each entry must name specific packages — an external requirement (`@npm:pkg:1.2.3`) or a built package target; a bare repository reference pins nothing"
      );
    }
    /* A catalog pins package VERSIONS, so its entries must come from a
     * repository that resolves them. The one non-resolving source a reference
     * can carry today is another catalog — deliberately rejected: each catalog
     * is its own joint resolution, and chaining would nest one inside another. */
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
      .filter((source): source is FileSet => source instanceof FileSet)
      .map(content => {
        if (!(content instanceof PackageFileSet)) {
          const from = describeProvenance(content.origin);
          throw new FabrError(
            `Catalog ${context.name} has an entry that does not resolve to a package${from ? ` (${from})` : ""}`
          ).withHelp("every catalog entry must be a package — an @npm requirement or a built package target");
        }
        return content;
      });
    const collection = resolveCollection(context, [...references, ...local]);
    const written = new Set(references);
    /* A catalog is one collection point: every registry's batch is resolved before any
     * entry is delivered. */
    return Computable.forAll(
      [...collection.resolutions.values()].map(resolution => resolution()),
      (...resolutions: Resolution[]) => {
        const entries = new Map<string, CatalogEntry>();
        const add = (name: string, entry: CatalogEntry): void => {
          const existing = entries.get(name);
          if (existing) {
            throw new ConflictError("catalog entries", name, conflictSide(existing), conflictSide(entry));
          }
          entries.set(name, entry);
        };
        /* A resolution names its roots as they will be delivered. Those the
         * catalog wrote are its members: the rest are references its local
         * entries carry, which are resolved but name no member. */
        for (const resolution of resolutions) {
          for (const root of resolution.roots) {
            if (written.has(root.reference)) {
              add(root.name, root.reference);
            }
          }
        }
        local.forEach(pkg => add(pkg.packageName, pkg));
        return { entries, collection };
      }
    );
  });
}

function createCatalog(context: TargetContext): Computable<Repository> {
  return Computable.resolve(new CatalogRepository(context.name, context, resolveCatalog(context)));
}

export const catalogRepositoryRegistration: RepositoryRegistration = { type: "catalog", provider: createCatalog };
