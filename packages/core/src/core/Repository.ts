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

import { Computable } from "./Computable";
import type { ExpectedDigest } from "../support/Integrity";
import { FabrError } from "./Errors";
import { FileSetRef } from "./FileSetRef";
import { FileSet, FileSource } from "./FileSet";
import type { TargetRef } from "./TargetRef";
import type { PartialRepositoryRef } from "./PartialRepositoryRef";
import type { NamespaceRef } from "./NamespaceRef";
import { Dependency, isPackage, Package, PackageFileSet, ResolvedNode } from "./PackageFileSet";
import { chainSteps } from "./Provenance";
import { Name } from "./Name";
import type { PublishableFileSet } from "./PublishableFileSet";
import type { RunnableFileSet } from "./RunnableFileSet";
import type { ITaskReport } from "../support/Execute";
import type { Requirement, RequirementSource, ResolvedMember, Selected } from "../resolver/Types";
import type { PackageFormat } from "../resolver/PackageFormat";

import { markerOf, variantName } from "../resolver/Requirement";
import { IProjection, Miss, NO_REFERENCE_FIELDS, Reference, ReferenceFields } from "./Reference";

/**
 * A repository: a namespace of names it vends references into, for reading and
 * for publishing (as distinct from a FileSource, which answers for files it
 * already has). Each vend method returns a reference carrying the face that
 * answers it — a read face ({@link RepositoryReader}, {@link RepositoryLookup}
 * or {@link RepositoryCollection}) or the write face ({@link RepositoryWriter})
 * — or throws where the repository has no such face: a read-only repository (a
 * catalog) vends no publish refs, and a write-only one no read refs. How a name
 * parses is the repository's own syntax.
 */
export interface Repository {
  /**
   * Vend a read reference for the whole written `name`: the repository takes
   * the part of the name that says what it resolves (npm: `name:version`) and
   * keeps the rest as projections into what that resolves to, so the caller is
   * left nothing of the name to read. Where the name is not yet a complete
   * reference (a scope, `@fabr-build`), vend the {@link PartialRepositoryRef}
   * naming it instead, for a name written after it to complete. Throws where
   * this repository cannot be read from, or the name is no valid identity.
   */
  getRepositoryRef(name: Name): RepositoryRef | PartialRepositoryRef;

  /**
   * Vend a publish ref for `name`, an address in this repository to write (npm:
   * `name:version` with an exact version; a file destination: a relative path
   * within it). Throws where the address is malformed or this repository is no
   * publish destination. Reads no content: `sync` vends every member's ref
   * before anything is built. A publish ref takes no projection.
   */
  getRepositoryPublishRef(name: Name): RepositoryPublishRef;

  /**
   * List the children of the name `ref` names in this repository ({@link
   * PartialRepositoryRef.name}, empty for the whole repository): each child's name
   * within it, in the order the repository lists them, mapped to the
   * reference that names the child. Names only — nothing is fetched or
   * resolved to list them. Rejects where it cannot be listed (a registry
   * cannot list every package it holds). Absent, nothing in the repository can
   * be listed.
   */
  children?(ref: PartialRepositoryRef): Computable<Map<string, Reference>>;
}

/** @return true if `source` is a {@link Repository}, otherwise false. */
export function isRepository(source: unknown): source is Repository {
  return typeof (source as Partial<Repository>).getRepositoryRef === "function";
}

/**
 * @return true if `source` has its content now — a FileSet, or any other
 * FileSource that answers `find`/`get` itself (a `fetch` table, a release
 * namespace) — otherwise false: a {@link Reference} of any kind, or a
 * {@link FileSetRef} with projections pending.
 */
export function isFileSource(source: SourceRef): source is FileSource {
  return !(source instanceof Reference) && !(source instanceof FileSetRef);
}

/**
 * The lookup read face of a repository: each reference is answered on its own,
 * with nothing resolved together (`fabr_home`). A registry, whose references
 * are resolved together, carries {@link RepositoryReader} instead.
 */
export interface RepositoryLookup {
  /**
   * Resolve one reference: to the package as the repository holds it, its
   * files in hand, or to a {@link ResolvedNode} whose files are fetched only
   * when the collection that asked is materialized, so `fabr deps` downloads
   * nothing. A node that is no package is marked
   * {@link PackageContent.plain}, so it claims no name among the collection's
   * packages. The caller applies the reference's projections and provenance
   * steps.
   */
  resolve(reference: RepositoryRef): Computable<FileSet | ResolvedNode>;

  /**
   * Resolve the files of what one reference names, without its dependencies
   * (see {@link RepositoryReader.fetchFiles}). Absent, {@link resolve}'s
   * answer is used.
   */
  resolveFiles?(reference: RepositoryRef): Computable<FileSet>;

  /**
   * Make a package this repository resolved runnable, as {@link resolve}
   * answers a reference under `run`: what a catalog holding the package hands
   * a consumer under `run`. Absent, the package cannot be run through a
   * catalog.
   */
  makeRunnable?(pkg: PackageFileSet): Computable<RunnableFileSet>;

  /**
   * Get the requirement `ref` declares, for a generated manifest: the package
   * name and the version constraint as written, not the version the resolution
   * selected. Undefined where the reference states no version to record.
   * Implemented only where the answer is the repository's own (as a
   * {@link RepositoryCollection}'s is); a registry's is read from the written
   * reference by its format (`declaredRequirement` in the resolution layer).
   * Absent, there is nothing to record.
   */
  declaredRequirement?(ref: RepositoryRef): Computable<Requirement | undefined>;
}

/**
 * The collection read face of a repository: one that resolved a set of
 * requirements together, itself, and names the results (a catalog). It fetches
 * and builds nothing: a reference to it is answered with the
 * {@link ResolvedMember} it names, which the collection point that asked
 * resolves from the repository's resolution, fetching and building only what
 * it reaches.
 */
export interface RepositoryCollection {
  /** Look up the member `reference` names, as the collection resolved for
   *  `operation` asks for it. Rejects, attributed to the reference, where it
   *  names none. */
  member(reference: RepositoryRef, operation: string): Computable<ResolvedMember>;

  /** As {@link RepositoryLookup.declaredRequirement}. */
  declaredRequirement?(ref: RepositoryRef): Computable<Requirement | undefined>;
}

/** @return true if `source` is a {@link RepositoryCollection}, otherwise false. */
export function isRepositoryCollection(source: unknown): source is RepositoryCollection {
  return typeof (source as Partial<RepositoryCollection>).member === "function";
}

/** What a registry publishes about one exact package version besides its
 * files: the licence it declares, as the registry states it (an SPDX
 * expression, a licence's name), and the digests of its content. Read for a
 * bill of materials, never for a build. */
export interface IVersionMetadata {
  readonly licenses: ReadonlyArray<ILicense>;
  readonly hashes: ReadonlyArray<ExpectedDigest>;
}

/** A licence as a package declares it: its text (an SPDX id or expression, or a
 * name) and where it is published, where the package says. */
export interface ILicense {
  readonly text: string;
  readonly url?: string;
}

/**
 * The resolving read face of a repository: a package registry, as the
 * resolution layer (PackageResolver) uses one. It is one ecosystem's
 * transport: everything that needs the url, the credentials or the wire
 * formats, and nothing that orchestrates. References to it are resolved
 * together (see resolvePackages). `npm_repository` implements it directly, a
 * `repository_group` by routing each call to the member the package's name
 * routes to, and a content route's member answers from its manifest. The
 * resolution layer asks a registry questions about one package at a time, so
 * every requirement a group's packages reach, transitive ones included, is
 * routed through the group.
 *
 * A registry that is also a publish destination carries the write face
 * ({@link RepositoryWriter}) too, and a coordinate can be published to where
 * the repository it routes to has that face. A coordinate's shape is read by
 * {@link PackageFormat.parsePublishCoordinate}.
 */
export interface RepositoryReader<V, C> extends RequirementSource<V> {
  /** The ecosystem's format (see {@link PackageFormat}), one object shared by
   * its registries: registries with the same format object resolve in one
   * version domain. */
  readonly format: PackageFormat<V, C>;
  /** Stable identity of the registry (npm: the registry url; a group: its
   * serialized route table): keys its resolution memos and package fetches,
   * and makes instances of one registry resolve together. */
  readonly identity: string;
  /** The name the repository is declared as (`@npm`), by which each file of a
   * package it delivers has its source path: `@npm:react:18.2.0:<file>`.
   * Absent where it has none, and its files then have none. */
  readonly name?: string;
  /**
   * Get an opaque key for what, beside its roots, shapes a resolution for
   * `operation`, the `BUILD_OPERATION` it is for (see
   * {@link RequirementSource.getRequirements}): npm, the target platform,
   * which gates optional dependencies; a content route's member, its
   * manifest's claims; Maven, the JVM release and the usage `operation`
   * selects. Part of the resolution memo key: instances of one registry
   * resolve together only where their keys agree.
   */
  environmentKey(operation?: string): Computable<string>;
  /** The operation of the configuration this instance was made in
   * (`BUILD_OPERATION`): a reference is answered with the package, with its
   * files alone under `files`, and with the program it is under `run`. */
  readonly operation: string;
  /**
   * Fetch the files of the package one reference names, with no dependency
   * closure and no joint resolution: the version is the reference's own lower
   * bound. Answers a {@link fileRequests file request} when it is
   * materialized, whatever operation this instance was made under.
   */
  fetchFiles(reference: RepositoryRef): Computable<FileSet>;
  /** Fetch one exact package version's content. */
  fetch(name: string, version: V): Computable<PackageFileSet>;
  /**
   * Fetch what one exact package version publishes for `operation`, `doc` or
   * `sources`: its documentation, or its source tree. Optional: a registry
   * without it publishes neither.
   */
  fetchFor?(name: string, version: V, operation: string): Computable<FileSet>;
  /**
   * Fetch the content of the variant `variant` of one exact package version
   * (see {@link Requirement.variant}): a Maven classifier's jar. Optional: a
   * registry without it publishes no variants.
   */
  fetchVariant?(name: string, version: V, variant: string): Computable<FileSet>;
  /** Get the published versions of `name`, for suggesting a remedy;
   * undefined where the registry has no such package. Reads a document that
   * changes over time, so call it only on a failure. Optional: absent, no
   * remedy is suggested. */
  availableVersions?(name: string): Computable<V[] | undefined>;
  /**
   * Check a resolution's selections against the registry's policy (npm:
   * EBADPLATFORM, a non-optional dependency on a package for another
   * platform), rejecting to fail the whole resolution. Called once per
   * resolution, once its selections are settled and before it is persisted.
   * Optional: absent, there is no policy.
   */
  validateSelections?(selections: Selected<V>[]): Computable<void>;
  /**
   * Get what the registry publishes about one exact package version besides
   * its files (see {@link IVersionMetadata}), from its metadata alone: nothing
   * of the package is fetched. Optional: a registry without it states no
   * licences or digests.
   */
  getVersionMetadata?(name: string, version: V): Computable<IVersionMetadata>;
}

/**
 * @return true if `source` is a package registry (it has the
 * {@link RepositoryReader} members), otherwise false. A `repository_group`
 * requires it of a route's target; an ecosystem's publish packaging uses it,
 * then compares `format`, to find its own ecosystem's coordinates in a release.
 */
export function isRepositoryReader(source: unknown): source is RepositoryReader<unknown, unknown> {
  const registry = source as Partial<RepositoryReader<unknown, unknown>>;
  return (
    typeof registry === "object" &&
    registry !== null &&
    typeof registry.format === "object" &&
    typeof registry.getRequirements === "function" &&
    typeof registry.fetchFiles === "function" &&
    typeof registry.fetch === "function"
  );
}

/**
 * The write face of a repository, carried by every {@link RepositoryPublishRef}
 * it vends. A `sync` groups its members by destination, and each destination
 * packages its whole group at once ({@link package}), so the ecosystem's
 * packaging policy (rewriting a dependency on another member, refusing one
 * that cannot be resolved) is the destination's. The order of uploads
 * (dependencies first, skipping what depends on a failed upload) is not: the
 * sync rule orders them and the driver uploads them, by what each carrier
 * says it provides and depends on (`provides`/`dependsOn`). `package` is pure
 * and cached, so building or `cat`-ing its result is a dry run; `publish` is
 * the one upload, to this repository's `url`, and is never cached.
 */
export interface RepositoryWriter {
  /**
   * Package this destination's members, together, into its wire form (npm: a
   * `package/`-rooted `.tgz` and the final manifest per member), returned
   * parallel to `members`; each carrier's files are the artifact uploaded.
   * `release` is every coordinate the whole sync assigns, across all
   * destinations: npm rewrites a member's manifest dependency on a release
   * member to its assigned version, reading the coordinates addressed to npm
   * destinations (its own destination's taking precedence over another's)
   * and ignoring addresses it does not understand. How to rewrite, and whether
   * a dependency on a built but unpublished package is an error, is the
   * ecosystem's. Pure and cached.
   */
  package(
    members: PublishMember[],
    release: readonly RepositoryPublishRef[],
    /** The coordinates the whole release publishes each target of the project
     *  at, by the target's name, for a member whose dependency on a target is
     *  recorded as that target's coordinate. */
    targets: ReadonlyMap<string, readonly RepositoryPublishRef[]>
  ): Computable<PublishableFileSet[]>;

  /**
   * @return the members this repository publishes beside one published at
   * `destination` where the sync declares none at their coordinates: each its
   * coordinate and the operation its content is built under, from the declared
   * member's content (a Maven repository's `-sources.jar`, built under
   * `sources`). A member whose content is no target of a type with a rule for
   * that operation has none of it. Omitted, none.
   */
  attachments?(destination: RepositoryPublishRef): readonly PublishAttachment[];

  /**
   * Upload one {@link package} result to this repository's `url`: the
   * envelope, the credential, and what counts as already published, nothing
   * about the rest of the release. The repository finds its own credential; no
   * token is passed in. `report` is the upload's task, which may report its
   * progress.
   */
  publish(artifact: PublishableFileSet, report: ITaskReport): Computable<PublishStatus>;
}

/** A member a repository publishes beside one a sync declares ({@link RepositoryWriter.attachments}). */
export interface PublishAttachment {
  /** Its coordinate. */
  destination: RepositoryPublishRef;
  /** The operation its content is built under, from the declared member's content. */
  operation: string;
}

/** What a {@link RepositoryRef} resolves against: a repository's read face —
 * resolving (references resolved together by the resolution layer), lookup
 * (each reference answered on its own) or collection (a member of what it
 * resolved). */
export type RefSource = RepositoryLookup | RepositoryReader<unknown, unknown> | RepositoryCollection;

/**
 * A projection pending over a package of a collection, while the collection is
 * resolved: what a {@link FileSetRef} over a package is until the package has
 * its files.
 */
export class ProjectedPackage {
  constructor(
    public readonly base: Package,
    public readonly projections: ReadonlyArray<IProjection>,
    public readonly miss?: Miss
  ) {}
}

/**
 * The files a reference's projection selects, not yet fetched: what a
 * {@link fileRequests file request} resolves to. It names files, so it is no
 * part of any graph; the collection fetches it when it is given its content.
 */
export class PendingFiles {
  constructor(public readonly fetch: () => Computable<FileSet | FileSetRef>) {}
}

/**
 * A collection's source, resolved. It is as {@link Materialized}, except that
 * a package may be a {@link ResolvedNode} (resolved and wired, its files not
 * yet had) or a {@link ProjectedPackage}; a target whose files alone a list
 * extracts is still its {@link TargetRef}, not built; and the files a
 * projection selects from a repository are {@link PendingFiles}, not yet
 * fetched.
 */
export type Resolved = Materialized | ResolvedNode | ProjectedPackage | TargetRef | PendingFiles;

/** One member of a destination's publish batch: where the content goes (the
 *  vended publish ref) and the built content to publish there. */
export interface PublishMember {
  readonly destination: RepositoryPublishRef;
  /** The member's content: where it is one package, that package as its build
   *  made it, with the dependencies that build bound (a
   *  {@link PackageFileSet}); otherwise its files. */
  readonly content: FileSet;
}

/** The outcome of a successful {@link RepositoryWriter.publish}: uploaded, or
 *  the coordinate already held the content, which is also a success. A failure
 *  rejects. */
export type PublishStatus = "published" | "already-synced";

/**
 * A publish address: where a `sync` member's content goes, vended and so
 * validated by the destination ({@link Repository.getRepositoryPublishRef}).
 * The write counterpart of {@link RepositoryRef}, without projections or
 * provenance steps, and never resolved. A destination's address is its `name`
 * (a file destination's path); a package destination's coordinate adds the
 * version it assigns ({@link PackagePublishRef}).
 */
export class RepositoryPublishRef {
  /** The address, within {@link source}. */
  public readonly name: string;

  constructor(
    public readonly source: RepositoryWriter,
    coordinate: { readonly name: string },
    /** The name the destination repository is declared as (`@npm`), attached
     *  where the coordinate is looked up. Display only: it completes the
     *  written coordinate (`@npm:name:version`). */
    public readonly repositoryName?: string
  ) {
    this.name = coordinate.name;
  }

  /** @return a copy carrying `repositoryName`. */
  public withRepositoryName(repositoryName: string): RepositoryPublishRef {
    return new RepositoryPublishRef(this.source, this, repositoryName);
  }

  /** @return the coordinate as written, for a message, with the repository's
   *  name where it is known. */
  public toString(): string {
    return this.repositoryName === undefined ? this.coordinate() : `${this.repositoryName}:${this.coordinate()}`;
  }

  /** Render the coordinate as written within the repository. */
  protected coordinate(): string {
    return this.name;
  }
}

/** A package destination's publish coordinate: a package and the exact version it assigns. */
export class PackagePublishRef extends RepositoryPublishRef {
  /** The exact version it assigns. */
  public readonly version: string;

  constructor(source: RepositoryWriter, coordinate: { readonly name: string; readonly version: string }, repositoryName?: string) {
    super(source, coordinate, repositoryName);
    this.version = coordinate.version;
  }

  public override withRepositoryName(repositoryName: string): PackagePublishRef {
    return new PackagePublishRef(this.source, this, repositoryName);
  }

  protected override coordinate(): string {
    return `${this.name}:${this.version}`;
  }
}

/** @return the package coordinates among `refs`: those a package destination assigns. */
export function packageCoordinates(refs: ReadonlyArray<RepositoryPublishRef>): PackagePublishRef[] {
  return refs.filter((ref): ref is PackagePublishRef => ref instanceof PackagePublishRef);
}

/** Get `ref` as the package coordinate a package destination vended it as. Throws where it is no package coordinate. */
export function packageCoordinateOf(ref: RepositoryPublishRef): PackagePublishRef {
  if (!(ref instanceof PackagePublishRef)) {
    throw new FabrError(`internal: '${ref.toString()}' is not a package coordinate`);
  }
  return ref;
}

/**
 * A reference into a repository: a requirement addressed to its `source`,
 * possibly narrowed by projections, and not yet resolved. References are
 * carried unchanged through property and target lookup to the consuming
 * target's collection point, which resolves them together.
 */
export class RepositoryRef extends Reference implements Requirement {
  /** The package named, within {@link source}. */
  public readonly name: string;
  /** The version or range of it wanted, as written; absent where the
   *  repository's references state none (a catalog member). */
  public readonly versionConstraint: string | undefined;
  /** The variant of the selected version it names, where it names one (see {@link Requirement.variant}). */
  public readonly variant?: string;

  /**
   * Make the reference `identity` writes, addressed to `source`, made of
   * `fields` beside it; by default the override marker and rename `identity`
   * carries.
   */
  constructor(
    public readonly source: RefSource,
    identity: Requirement,
    fields: ReferenceFields = { ...NO_REFERENCE_FIELDS, override: identity.override, renameTo: identity.renameTo },
    /** The name the repository was reached by, as written (`@deps`), stamped
     *  where the reference is looked up. Display only: the resolution layer
     *  names the repository by it in suggestions and progress. */
    public readonly repositoryName?: string
  ) {
    super(fields);
    this.name = identity.name;
    this.versionConstraint = identity.versionConstraint;
    if (identity.variant !== undefined) {
      this.variant = identity.variant;
    }
  }

  /** The name what this reference names is required as: the rename written
   * on it, or its own, and for a variant, the variant's name under it. */
  public override get localName(): string {
    return this.variant === undefined ? super.localName : variantName(super.localName, this.variant);
  }

  /**
   * Make the reference a whole written name makes, in a repository whose
   * references state no version and project nowhere: the name's text, and the
   * rename written on it.
   */
  public static written(source: RefSource, name: Name): RepositoryRef {
    return new RepositoryRef(source, {
      name: name.toBaseString(),
      versionConstraint: undefined,
      renameTo: name.getRenameTo()?.toString(),
    });
  }

  /** Whether what answers this reference must be a package: it is addressed
   * to a registry, whose requirements name packages. */
  public get requiresPackage(): boolean {
    return isRepositoryReader(this.source);
  }

  /** The reference as written — the display form for messages. */
  public toString(): string {
    const name = this.variant === undefined ? this.name : variantName(this.name, this.variant);
    const identity = this.versionConstraint === undefined ? name : `${name}:${this.versionConstraint}${markerOf(this.override)}`;
    return this.renameTo === undefined ? identity : `${identity} -> ${this.renameTo}`;
  }

  /** @return a copy carrying the written repository name (see repositoryName). */
  public withRepositoryName(repositoryName: string): RepositoryRef {
    return new RepositoryRef(this.source, this, this.fields, repositoryName);
  }

  protected withFields(fields: ReferenceFields): this {
    return new RepositoryRef(this.source, this, fields, this.repositoryName) as this;
  }

  /**
   * Chain this reference's provenance steps onto `base`, what it resolved to,
   * where that is plain content. A package is returned as it is: its
   * provenance is its resolution's, which carries the reference's steps.
   */
  public stampProvenance<T extends FileSet | ResolvedNode>(base: T): T {
    if (this.steps.length === 0 || isPackage(base)) {
      return base;
    }
    const origin = chainSteps(this.steps, base.origin);
    return origin ? (base.withOrigin(origin) as T) : base;
  }

  /**
   * Make `base`, what this reference resolved to, its result: provenance
   * stamped on plain content, a package rename written on the reference
   * applied, and any projections left pending over it, as a
   * {@link ProjectedPackage} over a resolved node or a {@link FileSetRef} over
   * files. No projection is applied here.
   */
  public applyTo(base: FileSet | ResolvedNode): FileSet | ResolvedNode | FileSetRef | ProjectedPackage {
    const renameTo = this.renameTo;
    const stamped = this.stampProvenance(base);
    /* A rename written before any projection renames the package, here; one
     * written after a projection rides that projection (see find) and renames
     * the files it selects. The repository splits its reference before the
     * first projection, so a rename reaches only one of the two. */
    return renamedAndProjected(stamped, { renameTo, projections: this.projections }, this.toString());
  }
}

/**
 * Apply the rename and projections written on a reference to `base`, what it
 * resolved to, its provenance already stamped: the package renamed, then the
 * projections left pending over it, as a {@link ProjectedPackage} over a node
 * and a {@link FileSetRef} over files. `shown` names the reference in a
 * message, and `miss` is the error where the projections select nothing.
 */
export function renamedAndProjected(
  base: FileSet | ResolvedNode,
  fields: { renameTo?: string; projections: ReadonlyArray<IProjection>; miss?: Miss },
  shown: string
): FileSet | ResolvedNode | FileSetRef | ProjectedPackage {
  const named = fields.renameTo === undefined ? base : renamedAs(base, fields.renameTo, shown);
  if (fields.projections.length === 0) {
    return named;
  }
  return named instanceof ResolvedNode
    ? new ProjectedPackage(named, fields.projections, fields.miss)
    : new FileSetRef(named, fields.projections, fields.miss);
}

/** A source for a reference no repository vends: one made for a test. */
const NO_SOURCE: RepositoryLookup = {
  resolve(reference: RepositoryRef): Computable<FileSet> {
    throw new FabrError(`'${reference.name}' is a reference made for a test, and resolves nothing`);
  },
};

/**
 * TEST SUPPORT. Make a {@link Dependency} on each of `deps`, asked for by the
 * package's own name through a reference no repository vends, where a
 * collection point would have bound it.
 */
export function dependenciesOn<P extends Package>(...deps: P[]): Array<Dependency<P>> {
  return deps.map(dep => ({
    reference: new RepositoryRef(NO_SOURCE, { name: dep.packageName, versionConstraint: undefined }),
    package: dep,
  }));
}

/**
 * Rename `source` to `renameTo`, as a `-> name` written on a reference renames
 * what it resolves to:
 * - a package is renamed;
 * - a target's node takes the name, and its build must be a package: its
 *   files reject where it is not;
 * - a reference with no projection carries the rename, and what it resolves
 *   to is renamed when it is resolved ({@link RepositoryRef.applyTo},
 *   {@link TargetRef}).
 *
 * Throws for anything else (a runnable, plain files, a reference with a
 * projection), which has no name to rename. `written` names the reference
 * the rename was written on, for the error.
 */
export function renamedAs(source: FileSet, renameTo: string, written: string): FileSet;
export function renamedAs<T extends FileSet | ResolvedNode>(source: T, renameTo: string, written: string): T;
export function renamedAs(source: SourceRef, renameTo: string, written: string): SourceRef;
export function renamedAs(source: SourceRef | ResolvedNode, renameTo: string, written: string): SourceRef | ResolvedNode;
export function renamedAs(source: SourceRef | ResolvedNode, renameTo: string, written: string): SourceRef | ResolvedNode {
  const noPackage = (): Error =>
    new FabrError(`'${written}' does not deliver a package, so there is no name for '-> ' to rename`).withHelp(
      "a rename on a reference that delivers files must name what it selects ('ref:pattern -> template')"
    );
  if (source instanceof ResolvedNode && source.content.builds !== undefined) {
    /* Under another name the node is a package of that name, a build apart
     * from the target's own (its key says so), with the target's files. Whether
     * the build is a package is known only once it is built. */
    const renamed = source.withPackageName(renameTo);
    const { content } = renamed;
    return renamed.withContent({
      ...content,
      files: () =>
        content.files().then(files => {
          if (!(files instanceof PackageFileSet)) {
            throw noPackage();
          }
          return files;
        }),
    });
  }
  if (isPackage(source)) {
    return source.withPackageName(renameTo);
  }
  if (source instanceof Reference && source.projections.length === 0) {
    return source.withRenameTo(renameTo);
  }
  throw noPackage();
}

/**
 * A source as looking up a property or a target finds it: a FileSource, a
 * PartialRepositoryRef or NamespaceRef, a RepositoryRef, a FileSetRef with
 * projections pending, or a TargetRef, not built.
 */
export type SourceRef = FileSource | PartialRepositoryRef | NamespaceRef | RepositoryRef | FileSetRef | TargetRef;

/** A collection's source, materialized: content, or, where its reference
 * carries projections, a {@link FileSetRef} with them still pending, which the
 * caller applies (`applyProjections`) or hands to a consumer that reads them
 * itself (see TargetContext.getContainedFileProperty). */
export type Materialized = FileSource | FileSetRef;
