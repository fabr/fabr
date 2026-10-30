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
import { FabrError } from "./Errors";
import { FileSetRef } from "./FileSetRef";
import { FileSet, FileSource } from "./FileSet";
import type { TargetRef } from "./TargetRef";
import type { NamespaceRef } from "./NamespaceRef";
import { Dependency, isPackage, Package, PackageFileSet, ResolvedNode } from "./PackageFileSet";
import { chainSteps } from "./Provenance";
import { Name } from "./Name";
import type { PublishableFileSet } from "./PublishableFileSet";
import type { Requirement, RequirementSource, ResolvedMember, Selected } from "../resolver/Types";
import type { PackageFormat } from "../resolver/PackageFormat";

import { markerOf, variantName } from "../resolver/Requirement";
import { IProjection, Miss, NO_REFERENCE_FIELDS, Reference, ReferenceFields } from "./Reference";

/**
 * A repository owns a namespace and vends references into it — the whole thing,
 * read and write faces alike (as distinct from a FileSource, which is a
 * container that can answer queries about files it already has). Capability is
 * discovered by asking: each vend method returns a ref carrying the matching
 * provider (a read face — {@link RepositoryReader}, {@link RepositoryLookup} or
 * {@link RepositoryCollection} — or the write face, {@link RepositoryWriter}) or throws — a
 * read-only repository (a catalog) refuses to vend publish refs, a write-only
 * one refuses read refs, and a vended ref IS the proof of capability, so no
 * consumer ever capability-tests or hits an unsupported operation. How a name
 * parses is the repository's own syntax, re-read from the ref's name wherever
 * it is consumed — a ref is carried currency, never a parsed struct.
 */
export interface Repository {
  /**
   * Vend a read reference for the whole written `name`: the repository claims
   * the identity portion it resolves (npm: `name:version`) and packs anything
   * left over into the ref as a projection *into* the resolved content (the
   * written-name rule rides on it) — so the caller holds one deferred ref, with
   * nothing of the name left to interpret. Where the name is a namespace of
   * the repository's names rather than one (a scope, `@fabr-build`), vend the
   * {@link NamespaceRef} naming it instead, for the name to go on from.
   * Throws if this repository cannot be read from, or the name is no valid
   * identity.
   */
  getRepositoryRef(name: Name): RepositoryRef | NamespaceRef;

  /**
   * Vend a publish ref: validate `name` as an address in this repository's
   * namespace to *write* (npm: `name:version` with an exact version; a file
   * destination: a contained relative path), throwing if it is malformed or
   * this repository is not a publish destination. Cheap, no content — the sync
   * rule vends every member's ref before anything builds, so a bad coordinate
   * fails fast, positioned. Unlike a read ref it admits no projection: you
   * cannot project into an address you are creating.
   */
  getRepositoryPublishRef(name: Name): RepositoryPublishRef;

  /**
   * List the children of the name `ref` names in this repository ({@link
   * NamespaceRef.name}, empty for the whole repository): each child's name
   * within it, in the order the repository lists them, mapped to the
   * reference that names the child. Names only — nothing is fetched or
   * resolved to list them. Rejects where it cannot be listed (a registry
   * cannot enumerate every package it holds). OPTIONAL: absent, nothing in the
   * repository can be listed.
   */
  children?(ref: NamespaceRef): Computable<Map<string, Reference>>;
}

export function isRepository(source: unknown): source is Repository {
  return typeof (source as Partial<Repository>).getRepositoryRef === "function";
}

/**
 * @return true if this source serves content directly — a FileSet, or any
 * other FileSource that answers `find`/`get` on its own terms (a `fetch`
 * table, a release namespace) — otherwise false. The complement is the deferred kinds, which promise
 * content but cannot yet serve it: the references (a {@link Reference} of any
 * kind) and a pending projection (FileSetRef — a collection point applies it).
 */
export function isFileSource(source: SourceRef): source is FileSource {
  return !(source instanceof Reference) && !(source instanceof FileSetRef);
}

/**
 * The LOOKUP read face of a repository: per-reference delivery (`fabr_home`).
 * The counterpart of {@link RepositoryReader} (the resolving read face, whose
 * references the resolution layer batches for joint version selection): a
 * repository carries this face instead when each reference is answered on its
 * own and there is nothing joint to resolve.
 */
export interface RepositoryLookup {
  /**
   * Resolve what ONE reference names: the package as the repository holds it,
   * its files in hand. Single-item by design: joint version selection over a
   * batch is the resolution layer's business (a resolving registry never
   * implements this face), so what remains here is a repository that answers
   * each reference on its own (`fabr_home`). Projections and provenance
   * carried by the reference are applied by the caller.
   */
  resolve(reference: RepositoryRef): Computable<FileSet>;

  /**
   * Resolve the files of what ONE reference names, with no dependency closure
   * (see {@link RepositoryReader.fetchFiles}). OPTIONAL: where absent,
   * {@link resolve}'s answer serves.
   */
  resolveFiles?(reference: RepositoryRef): Computable<FileSet>;

  /**
   * Get the requirement `ref` declares — package name + the version constraint as
   * WRITTEN — for a generated manifest (which records what a package *requires*,
   * not what fabr's joint resolution pinned, which a transitive constraint may
   * have bumped). Undefined if the reference declares no version to record.
   * OPTIONAL, and implemented only where the answer is the repository's own (as
   * a {@link RepositoryCollection} does): for a package registry the answer is pure
   * written-form parsing, so callers dispatch to the format instead (see
   * declaredRequirement in the resolution layer). Absent means nothing to record.
   */
  declaredRequirement?(ref: RepositoryRef): Computable<Requirement | undefined>;
}

/**
 * The COLLECTION read face of a repository: one that resolved a set of
 * requirements jointly, itself, and names the results — a catalog. It delivers
 * nothing: a reference against it is answered with the {@link ResolvedMember}
 * it names, and the collection point that asked delivers that member from the
 * repository's resolution, fetching and building only what it reaches.
 */
export interface RepositoryCollection {
  /** Look up the member `reference` names. Rejects, attributed to the reference,
   *  where it names none. */
  member(reference: RepositoryRef): Computable<ResolvedMember>;

  /** As {@link RepositoryLookup.declaredRequirement}. */
  declaredRequirement?(ref: RepositoryRef): Computable<Requirement | undefined>;
}

export function isRepositoryCollection(source: unknown): source is RepositoryCollection {
  return typeof (source as Partial<RepositoryCollection>).member === "function";
}

/**
 * The RESOLVING read face of a repository — a package registry as the
 * resolution layer (PackageResolver) drives one: a transport for one ecosystem
 * — everything that needs the url, the credentials, or the wire formats, and
 * nothing that orchestrates. References against this face resolve jointly (the
 * resolution layer batches them — see resolvePackages); the counterpart for a
 * repository that answers each reference on its own is the per-reference
 * {@link RepositoryLookup} face, and for one that resolved its own collection
 * the {@link RepositoryCollection} face. `npm_repository` implements this directly; a
 * `repository_group` implements it by routing every call to the member the
 * name routes to; a content route's member derives every answer from its
 * manifest. The driver functions (resolvePackages / packageClosure) only
 * ever ask per-name questions of the one registry they are given — which is
 * why a group's whole closure, transitive requirements included, flows through
 * the group and gets routed there.
 *
 * Reading only: a registry that is also a publish destination additionally
 * carries the repository write face ({@link RepositoryWriter}) — whether a
 * coordinate CAN publish is that surface's presence, judged where the
 * coordinate routes; the coordinate's *shape* is written-form knowledge,
 * parsed by {@link PackageFormat.parsePublishCoordinate}.
 */
export interface RepositoryReader<V, C> extends RequirementSource<V> {
  /** The shared per-ecosystem format (see {@link PackageFormat}): object
   * identity across registries is what admits them to one domain. */
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
   * An opaque discriminator of what a resolution is computed *for* — anything
   * beyond the roots that shapes the graph (npm: the target platform, which
   * gates optional deps; a content member: its manifest's claims). Folded into
   * the resolution memo key.
   */
  environmentKey(): Computable<string>;
  /** The operation of the configuration this instance was made in
   * (`BUILD_OPERATION`): a reference is answered with the package, with its
   * files alone under `files`, and with the program it is under `run`. */
  readonly operation: string;
  /**
   * Fetch the files of the package one reference names, with no dependency
   * closure and no joint resolution: the version is the reference's own lower
   * bound. What a {@link fileRequests file request} is answered with when it is
   * materialized, whatever operation this instance was interned under.
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
  /** Get the published-version list for repair suggestions; undefined when the
   * registry has no such package. Reads a mutable document — failure-path
   * only, and optional: absence means no suggestions. */
  availableVersions?(name: string): Computable<V[] | undefined>;
  /**
   * Post-resolution policy over the final selections (npm: EBADPLATFORM — a
   * non-optional dependency on a package for another platform), rejected to
   * fail the whole resolution. Called once per resolution, after the graph
   * converges, before it is persisted. Optional: most registries have no
   * policy.
   */
  validateSelections?(selections: Selected<V>[]): Computable<void>;
}

/**
 * @return true if `source` is a package registry (structurally — the same move
 * as {@link isRepository}), otherwise false: what a `repository_group` requires of a route target,
 * and how one ecosystem's publish packaging recognizes coordinates of its own
 * ecosystem in a release (by then comparing `format` for identity).
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
 * it vends. Packaging is **batch-shaped**, the write-side dual of `resolve`'s
 * per-repository joint batches: the sync partitions its members by destination
 * and each destination packages its whole batch jointly, so ecosystem packaging
 * policy — co-member dependency rewriting, unresolvable-dependency errors —
 * lives behind this interface, never in the generic rule. Release-level
 * orchestration is NOT here: the carriers announce what they reference
 * (`provides`/`dependsOn`, minted ecosystem-side, carried generically), and
 * ordering uploads deps-first / skipping the dependants of a failure is the
 * generic layer's job (the sync rule orders; the driver walks). The two halves
 * straddle the pure/side-effect line: `package` is a pure, cacheable transform
 * (building/`cat`-ing its result is the dry-run); `publish` is the one
 * non-idempotent, credentialed, never-cached network write, to this
 * repository's single `url`.
 */
export interface RepositoryWriter {
  /**
   * Package this destination's members into its wire form (npm: a
   * `package/`-rooted `.tgz` + the final manifest per member), jointly. `release`
   * is every coordinate the whole sync assigns — across ALL destinations — as
   * ecosystem-read context: npm rewrites a member's manifest dependency on a
   * release member to its assigned version, reading the coordinates addressed to
   * npm destinations (so a maintained-in-sync twin published to another registry
   * still rewrites, its own destination's assignments taking precedence over the
   * release-wide one) and ignoring addresses it doesn't understand. How to
   * rewrite, and that a dependency on a built but unpublished package is
   * unresolvable (an error), is this ecosystem's policy. Pure/cacheable — the
   * carriers' files ARE the wire artifact, returned parallel to `members`.
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
   * Upload one prior {@link package} result to this repository's `url` — the one
   * side effect: pure upload mechanics (envelope, credential, what counts as
   * already-published), nothing about the rest of the release. Authentication is
   * the repository's own business — it knows its registry and its ecosystem's
   * credential conventions — so no token is threaded in.
   */
  publish(artifact: PublishableFileSet): Computable<PublishStatus>;
}

/** A member a repository publishes beside one a sync declares ({@link RepositoryWriter.attachments}). */
export interface PublishAttachment {
  /** Its coordinate. */
  destination: RepositoryPublishRef;
  /** The operation its content is built under, from the declared member's content. */
  operation: string;
}

/** What a {@link RepositoryRef} resolves against: a repository's read face —
 * resolving (references batched by the resolution layer), lookup
 * (per-reference delivery) or collection (a member of what it resolved). */
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
   *  made it, with the edges that build bound (a {@link PackageFileSet});
   *  otherwise its files. */
  readonly content: FileSet;
}

/** A successful {@link RepositoryWriter.publish}'s report: whether the upload
 *  happened, or the coordinate already held the content (sync is declarative —
 *  already-there is success, reported distinctly). A failure is an ordinary
 *  rejection. */
export type PublishStatus = "published" | "already-synced";

/**
 * A vended write address: where a `sync` member's content goes — validated by
 * the destination at vend time ({@link Repository.getRepositoryPublishRef}), so holding one
 * proves the name is a well-formed, writable address. The write dual of
 * {@link RepositoryRef} (a name in a repository's namespace plus the provider
 * its operations need), minus projections (you cannot project into an address
 * you are creating) and provenance; it is never resolved — the destination
 * re-parses `name` in `package`/`publish`.
 */
export class RepositoryPublishRef {
  /** The package the address assigns, within {@link source}. */
  public readonly name: string;
  /** The exact version it assigns. */
  public readonly version: string;

  constructor(
    public readonly source: RepositoryWriter,
    coordinate: { readonly name: string; readonly version: string },
    /** The declared name of the destination repository in the build's
     *  namespace (`@npm`) — the destination cannot know what it was declared
     *  as, so lookup attaches it at vend time. Display-only: completes
     *  the written coordinate (`@npm:name:version`). */
    public readonly repositoryName?: string
  ) {
    this.name = coordinate.name;
    this.version = coordinate.version;
  }

  public withRepositoryName(repositoryName: string): RepositoryPublishRef {
    return new RepositoryPublishRef(this.source, this, repositoryName);
  }

  /** The display form for messages — the full written coordinate when the
   *  repository name is known. */
  public toString(): string {
    const coordinate = `${this.name}:${this.version}`;
    return this.repositoryName === undefined ? coordinate : `${this.repositoryName}:${coordinate}`;
  }
}

/**
 * A deferred reference to files from a Repository, possibly narrowed by
 * projections: "the thing we resolve", explicitly separate from the FileSet
 * content it eventually produces. References travel through property and
 * target lookup as inert values, so that the consuming target's collection
 * point can gather every reference that surfaces and resolve them together.
 *
 * Instances are immutable: provenance steps and projections accumulate into
 * new copies, so instances cached in shared property values are never affected
 * by any individual consumer.
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
    /** The name the repository was reached by, as written (`@deps`) — stamped
     *  where the reference is looked up (the site that matched the declaration),
     *  like a publish ref's repositoryName. Display-only: how the resolution
     *  layer renders suggestions and progress in the user's own spelling. */
    public readonly repositoryName?: string
  ) {
    super(fields);
    this.name = identity.name;
    this.versionConstraint = identity.versionConstraint;
    if (identity.variant !== undefined) {
      this.variant = identity.variant;
    }
  }

  /** The name what this reference names is delivered under: the rename
   * written on it, or its own, and for a variant, the variant's name under it. */
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
   * Chain this reference's provenance steps onto its resolved base — the
   * provenance half of finishing a delivery, kept separate from projection
   * application (the build context's applyProjections).
   */
  public stampProvenance<T extends FileSet | ResolvedNode>(base: T): T {
    /* A package's provenance is its resolution's: the steps of the reference
     * it is delivered for ride the entry that delivers it. */
    if (this.steps.length === 0 || isPackage(base)) {
      return base;
    }
    const origin = chainSteps(this.steps, base.origin);
    return origin ? (base.withOrigin(origin) as T) : base;
  }

  /**
   * Make a delivered base this reference's result: provenance stamped on
   * plain content, a package rename written on the reference applied, and,
   * where the reference carries projections, wrapped as a pending
   * {@link ProjectedPackage} (over a resolved node) or {@link FileSetRef}. The
   * delivery machinery never applies projections itself.
   */
  public applyTo(base: FileSet | ResolvedNode): FileSet | ResolvedNode | FileSetRef | ProjectedPackage {
    const renameTo = this.renameTo;
    const stamped = this.stampProvenance(base);
    /* A rename written on the reference's IDENTITY half is the package rename,
     * applied here because this is where an external package first exists; at a
     * projection the facet rides the projection instead (see find) and renames
     * the files it selects. The two never meet — a repository splits its
     * reference at the projection boundary, so the facet reaches exactly one. */
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
 * TEST SUPPORT. Make the edges to `deps`, each a package asked for by its own
 * name through a reference nothing vends: what a test writes where a
 * collection point would have delivered the edge.
 */
export function dependenciesOn<P extends Package>(...deps: P[]): Array<Dependency<P>> {
  return deps.map(dep => ({ reference: new RepositoryRef(NO_SOURCE, { name: dep.packageName, versionConstraint: undefined }), package: dep }));
}

/**
 * Deliver `source` under the name a written `-> name` gave it — the package
 * rename, in one place because only the *moment* differs between the kinds of
 * package: an external one does not exist until its collection point (so the
 * facet rides its reference here, to {@link RepositoryRef.applyTo}), and
 * a target's package does not exist until the target is resolved or built (so
 * it rides its {@link TargetRef}). A still-deferred reference is renamed by
 * carrying the facet onward, and what it resolves to reaches this same rule
 * later.
 *
 * Only a package has an identity to rename. Anything else — a runnable, a plain
 * fileset — has no name a rename could be about, so it is an error rather than
 * a silent no-op. `written` names the reference the rename was written on.
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
    /* What a target builds is known when it is built. Delivered under another
     * name it is a package of that name, a build apart from the target's own:
     * its key says so, and its files are the one build's. */
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
 * A FileSource, a NamespaceRef (a repository named on its own), a deferred
 * RepositoryRef, a projection-pending FileSetRef, or an unbuilt TargetRef: the
 * currency of looking up properties and targets.
 */
export type SourceRef = FileSource | NamespaceRef | RepositoryRef | FileSetRef | TargetRef;

/** A collection's source, materialized: content, or, where its reference
 * carries projections, a {@link FileSetRef}
 * with them still pending. The caller applies the pending projections
 * (`applyProjections`), or hands the ref to a consumer that reinterprets it
 * (see TargetContext.getContainedFileProperty). */
export type Materialized = FileSource | FileSetRef;

