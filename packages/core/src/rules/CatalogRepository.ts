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
import { FileSet, FileSource } from "../core/FileSet";
import { PackageFileSet } from "../core/PackageFileSet";
import { RunnableFileSet } from "../core/RunnableFileSet";
import {
  attributedTo,
  groupByRepository,
  MaterializeOptions,
  Repository,
  RepositoryPublishRef,
  RepositoryReader,
  RepositoryRef,
  Resolution,
} from "../core/Repository";
import { FileSetRef } from "../core/FileSetRef";
import { Requirement } from "../resolver/Types";
import { chainSteps } from "../core/Provenance";
import { attachHelp, ConflictError, IConflictSource } from "../core/Errors";
import { Name } from "../core/Name";
import { RepositoryContext } from "../model/BuildContext";
import { BUILD_OPERATION, BUILD_OVERRIDE } from "../model/Constraints";
import { RepositoryRegistration } from "./Types";

/**
 * A **catalog** is an explicit, named, opt-in shared collection point: it pins a
 * fixed set of requirements (its `deps` property), resolves them **jointly and
 * once** — the single minimal-version-selection over all of the catalog's roots —
 * and exposes each resolved root by its package name. A reference `@cat:pkg`
 * therefore delivers an *already-resolved* package (carrying its co-resolved
 * closure), so every consumer gets the same versions and does no resolution of
 * its own.
 *
 * Mechanically it is just a {@link Repository} whose read face answers from a
 * **table** rather than a registry: the joint resolution is the catalog's own
 * collection point (resolveDeps, forced to build), and every consuming
 * reference rides the normal RepositoryRef path — grouped by this instance at
 * the consumer's collection point and answered from the table.
 *
 * This is a deliberate, sanctioned exception to "the resolution boundary is the
 * consuming target, never a context-global fixpoint": the catalog IS a shared
 * boundary, but a user-declared and named one, not an implicit global fixpoint.
 */
/**
 * One pinned entry. A **repository** entry is not fetched yet: it holds its
 * source repository, its own reference, and the shared {@link Resolution} that
 * repository produced — so it is materialized on demand (and only if named).
 * A **local** entry is an already-built target's package (evaluated during
 * resolution, so eager).
 */
type CatalogMember =
  | { readonly kind: "repository"; readonly source: RepositoryReader; readonly reference: RepositoryRef; readonly resolution: Resolution }
  | { readonly kind: "local"; readonly pkg: PackageFileSet };

export class CatalogRepository implements Repository, RepositoryReader {
  constructor(
    private readonly catalogName: string,
    /* The operation (BUILD_OPERATION) this instance is consumed under: the
     * catalog is interned per BuildContext like any repository, so its operation
     * is fixed and settled once — it decides package-vs-runnable delivery. */
    private readonly operation: Computable<string>,
    /* name -> its pinned member; the version pin is resolved once (a single
     * memoized Computable) and shared, but a member's package is fetched only
     * when materialize names it. */
    private readonly pinned: Computable<Map<string, CatalogMember>>
  ) {}

  /**
   * Phase 1 — the members are already version-resolved (at construction), so
   * this just names each requested reference; the fetch is deferred to
   * materialize.
   */
  public resolve(references: RepositoryRef[]): Computable<Resolution> {
    return Computable.resolve({ roots: references.map(reference => ({ reference, name: reference.name.getLiteralPrefix() })) });
  }

  /**
   * Phase 2 — deliver the named members, fetching each on demand from its pinned
   * resolution (a member never named is never fetched). Under `run` the member
   * is made runnable, delegated to its source repository so the catalog's joint
   * closure is kept — never a fresh resolution.
   *
   * The catalog resolves once (forced build) but is judged per delivery: the
   * consumer's `options.resolutionMode` — and run delivery, permissive by the
   * sealed-runnable invariant — is forwarded to the member's source
   * materialize, so one pinned tree can serve a permissive tool member
   * (repairs nested) and a strict linked member (repairs erroring) side by
   * side.
   */
  public materialize(references: RepositoryRef[], _resolution: Resolution, options?: MaterializeOptions): Computable<FileSet[]> {
    return this.operation.then(operation =>
      this.pinned.then(table =>
        Computable.forAll(
          references.map(reference =>
            attributedTo(reference, () => this.deliver(reference.name.getLiteralPrefix(), table, operation, options))
          ),
          (...delivered: FileSet[]) => delivered
        )
      )
    );
  }


  private deliver(alias: string, table: Map<string, CatalogMember>, operation: string, options?: MaterializeOptions): Computable<FileSet> {
    const member = table.get(alias);
    if (!member) {
      /* Just a resolution failure — like any repository not having a requirement;
       * attributedTo wraps it in a RequirementResolutionError for the driver. */
      throw attachHelp(
        new Error(`Catalog ${this.catalogName} has no member '${alias}'`),
        table.size > 0 ? `it pins: ${[...table.keys()].sort().join(", ")}` : "the catalog pins nothing"
      );
    }
    /* Run delivery is permissive by the sealed-runnable invariant; otherwise
     * the consumer's judgment. */
    const mode = operation === "run" ? ({ resolutionMode: "permissive" } as MaterializeOptions) : options;
    const pkg = this.materializePackage(member, mode);
    return operation === "run" ? pkg.then(p => this.toRunnable(alias, member, p)) : pkg;
  }

  /**
   * Fetch + assemble a member's package on demand: for a repository entry, from
   * its pinned resolution (keeping the joint closure), with the *underlying*
   * reference's provenance stamped (`@npm:pkg` as written in the catalog's deps);
   * for a local entry, the already-built package.
   */
  private materializePackage(member: CatalogMember, options?: MaterializeOptions): Computable<PackageFileSet> {
    if (member.kind === "local") {
      return Computable.resolve(member.pkg);
    }
    /* Stamping only: a catalog entry never carries projections (rejected at
     * resolveDeps), so there is no pending remainder to finish here. */
    return member.source
      .materialize([member.reference], member.resolution, options)
      .then(([base]) => member.reference.stampProvenance(base) as PackageFileSet);
  }

  private toRunnable(alias: string, member: CatalogMember, pkg: PackageFileSet): Computable<RunnableFileSet> {
    if (member.kind === "local") {
      throw attachHelp(
        new Error(`Catalog ${this.catalogName} member '${alias}' is a locally-built target, which the catalog cannot deliver as a runnable`),
        "run the target directly rather than through the catalog"
      );
    }
    return member.source.makeRunnable(pkg);
  }

  /**
   * Make a pinned member runnable — for a parent catalog chaining onto this one
   * (`catalog @a { deps = @b:x }` running `@a:x` delegates here). The package is
   * one of ours, looked up by name; its own source does the ecosystem-specific
   * work.
   */
  public makeRunnable(pkg: PackageFileSet): Computable<RunnableFileSet> {
    return this.pinned.then(table => {
      const member = table.get(pkg.packageName);
      if (!member) {
        /* Can't happen: a parent catalog only delegates a member it got from us. */
        throw new Error(`internal: catalog ${this.catalogName} has no member '${pkg.packageName}' to make runnable`);
      }
      return this.toRunnable(pkg.packageName, member, pkg);
    });
  }

  /**
   * The requirement a member was **declared** with in the catalog's `deps` — NOT
   * the version the joint resolution pinned it to. A locally-built member is
   * versionless (its version is assigned at publish), contributing `*`; an external
   * member delegates to its own source repository (which reads the declaration off
   * `@npm:pkg:1.2.3`), so the catalog parses no version syntax itself.
   */
  public declaredRequirement(ref: RepositoryRef): Computable<Requirement | undefined> {
    const name = ref.name.toString();
    return this.pinned.then(table => {
      const member = table.get(name);
      if (!member) {
        return Computable.resolve(undefined);
      }
      return member.kind === "local"
        ? Computable.resolve<Requirement | undefined>({ pkg: name, constraint: member.pkg.version ?? "*" })
        : member.reference.source.declaredRequirement(member.reference);
    });
  }

  /**
   * The alias is the whole literal up to a projection `:` — there is no
   * `name:version` to peel (versions live in the catalog, not the reference), so
   * a `/` inside a scoped alias (`@types/node`) is part of the key, not a
   * boundary. A trailing `:tail` projects into the pinned package.
   */
  public getRepositoryRef(name: Name): RepositoryRef {
    const lit = name.getLiteralPrefix();
    const colon = lit.indexOf(":");
    if (colon === -1) {
      return new RepositoryRef(this, name);
    }
    return new RepositoryRef(this, Name.fromLiteral(lit.substring(0, colon))).find(name.substring(colon + 1));
  }

  /** A catalog pins versions for reading; it is not a place content goes. */
  public getRepositoryPublishRef(name: Name): RepositoryPublishRef {
    throw new Error(`a catalog is not a publish destination (cannot sync to '${name.toString()}')`);
  }
}

/** The provenance + concrete detail attributing one catalog entry (for a
 * same-name conflict). A repository entry is attributed by its written reference
 * (no version yet — unfetched); a local entry by its built package. */
function conflictSide(member: CatalogMember): IConflictSource {
  return member.kind === "local"
    ? { provenance: member.pkg.origin, detail: member.pkg.version }
    : { provenance: chainSteps(member.reference.steps, undefined), detail: member.reference.name.getLiteralPrefix() };
}

/** The catalog's `deps` resolved but NOT fetched: one {@link Resolution} per
 * repository the entries came from (members materialize on demand from these),
 * plus any already-built local entries. */
interface ResolvedPackageSet {
  readonly resolutions: ReadonlyArray<{ source: RepositoryReader; resolution: Resolution }>;
  readonly local: ReadonlyArray<FileSource>;
}

/**
 * Resolve the catalog's `deps` to per-repository resolutions WITHOUT fetching,
 * forcing build (members are wanted as mountable packages regardless of how the
 * catalog is consumed). External refs group by repository and `resolve` jointly —
 * versions fixed, nothing fetched; a local target reference is evaluated (built)
 * during resolution and comes back as an eager `local` entry.
 */
function resolveDeps(context: RepositoryContext): Computable<ResolvedPackageSet> {
  return context.getFileProperty("deps", BUILD_OVERRIDE).then(sources => {
    const references = sources.filter((source): source is RepositoryRef => source instanceof RepositoryRef);
    /* A catalog pins whole packages: an entry projecting *into* one would
     * resolve to plain files, not a PackageFileSet — reject it outright (its
     * projected content is never computed just to fail), whether it is an
     * external requirement (`@npm:pkg:1.0.0:lib/*`, a projected reference) or
     * a built target (`mylib:build/*`, a projection-pending local entry). */
    const projectsInto = (what: string): Error =>
      attachHelp(
        new Error(`Catalog entry ${what} projects into a package`),
        "a catalog pins whole packages — project at the point of use instead (`@catalog:pkg:path`)"
      );
    const projected = references.find(reference => reference.projections.length > 0);
    if (projected) {
      throw projectsInto(`'${projected.name.toString()}'`);
    }
    const pendingLocal = sources.find((source): source is FileSetRef => source instanceof FileSetRef);
    if (pendingLocal) {
      const base = pendingLocal.source;
      throw projectsInto(base instanceof PackageFileSet ? `'${base.packageName}'` : "of a local target");
    }
    const local = sources.filter((source): source is FileSource => source instanceof FileSet);
    return Computable.forAll(
      [...groupByRepository(references).entries()].map(([source, refs]) =>
        source.resolve(refs).then(resolution => ({ source, resolution }))
      ),
      (...resolutions: { source: RepositoryReader; resolution: Resolution }[]) => ({ resolutions, local })
    );
  });
}

/**
 * Build the catalog's lookup table from its resolved-but-unfetched package set:
 * each repository's resolution names its roots (keyed without fetching), plus
 * any already-built local entries. Two entries claiming one package name from
 * different sources are a conflict; a non-package local entry is rejected.
 */
function buildCatalog(catalogName: string, set: ResolvedPackageSet): Map<string, CatalogMember> {
  const table = new Map<string, CatalogMember>();
  const add = (name: string, member: CatalogMember): void => {
    const existing = table.get(name);
    if (existing) {
      throw new ConflictError("catalog entries", name, conflictSide(existing), conflictSide(member));
    }
    table.set(name, member);
  };
  for (const { source, resolution } of set.resolutions) {
    for (const root of resolution.roots) {
      add(root.name, { kind: "repository", source, reference: root.reference, resolution });
    }
  }
  for (const content of set.local) {
    if (!(content instanceof PackageFileSet)) {
      throw attachHelp(
        new Error(`Catalog ${catalogName} has an entry that does not resolve to a package`),
        "every catalog entry must be a package — an @npm requirement or a built package target"
      );
    }
    add(content.packageName, { kind: "local", pkg: content });
  }
  return table;
}

function createCatalog(context: RepositoryContext): Computable<Repository> {
  const name = context.target.name;
  const pinned = resolveDeps(context).then(set => buildCatalog(name, set));
  return Computable.resolve(new CatalogRepository(name, context.getGlobalString(BUILD_OPERATION), pinned));
}

export const catalogRepositoryRegistration: RepositoryRegistration = { type: "catalog", provider: createCatalog };
