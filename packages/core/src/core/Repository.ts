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
import { attachHelp, RequirementResolutionError, toError } from "./Errors";
import { FileSetRef, IProjection } from "./FileSetRef";
import { FileSet, FileSource } from "./FileSet";
import { PackageFileSet, PackageGraphBuilder } from "./PackageFileSet";
import { chainSteps, IProvenanceStep } from "./Provenance";
import { Name } from "./Name";
import type { PublishableFileSet } from "./PublishableFileSet";
import type { Requirement, RequirementSource, Selected } from "../resolver/Types";
import type { PackageFormat } from "../resolver/PackageFormat";
import type { TaskDescription } from "../model/BuildEvents";
import type { ITaskReport } from "../support/Execute";
/* Value imports used only inside function bodies (the resolution-layer
 * dispatch below), so the module cycle with the resolver is init-safe:
 * neither module touches the other's bindings at load time. */
import { materializePackages, resolvePackages } from "../resolver/PackageResolver";

/**
 * One resolved root of a {@link Resolution}: the input reference and the name it
 * is *delivered* as — the one thing a caller can read out of an otherwise-opaque
 * Resolution, so it can key/address entries (a catalog keys its members by this)
 * *without* fetching them. `name` is the identity the repository addresses
 * entries by (npm: the package name), or — when the reference writes a rename —
 * the name that rename gives the delivery (see {@link renamedDelivery}), so an
 * addressing key and the package it addresses can never disagree.
 */
export interface ResolvedRoot {
  readonly reference: RepositoryRef;
  readonly name: string;
}

/**
 * The result of a repository's {@link Repository.resolve} phase: versions +
 * dependency tree, but nothing fetched. Opaque to everyone but the repository
 * that produced it (which hands it back to {@link Repository.materialize}),
 * *except* for `roots`. Ecosystem specifics (npm's version selection + reachable
 * tree) live in a private subtype; the generic surface is only `roots`.
 */
export interface Resolution {
  readonly roots: ReadonlyArray<ResolvedRoot>;
}

/**
 * A repository owns a namespace and vends references into it — the whole thing,
 * read and write faces alike (as distinct from a FileSource, which is a
 * container that can answer queries about files it already has). Capability is
 * discovered by asking: each vend method returns a ref carrying the matching
 * provider (a read face — {@link RepositoryReader} or {@link RepositoryLookup}
 * — or the write face, {@link RepositoryWriter}) or throws — a
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
   * nothing of the name left to interpret. Throws if this repository cannot be
   * read from, or the name is no valid identity.
   */
  getRepositoryRef(name: Name): RepositoryRef;

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
}

export function isRepository(source: SourceRef): source is Repository {
  return typeof (source as Partial<Repository>).getRepositoryRef === "function";
}

/**
 * Whether this source delivers content directly — a FileSet, or any other
 * FileSource that answers `find`/`get` on its own terms (a `fetch` table, a
 * release namespace). The complement is the deferred kinds, which promise
 * content but cannot yet serve it: a Repository (resolve first) and the pending
 * references (RepositoryRef, FileSetRef — a collection point applies them).
 */
export function isFileSource(source: SourceRef): source is FileSource {
  return !isRepository(source) && !(source instanceof RepositoryRef) && !(source instanceof FileSetRef);
}

/**
 * The LOOKUP read face of a repository: per-reference delivery from an
 * already-fixed resolution — a catalog's pinned-member lookup. The counterpart
 * of {@link RepositoryReader} (the resolving read face, whose references the
 * resolution layer batches for joint version selection): a repository carries
 * this face instead when every answer is already pinned, so delivery is
 * genuinely per-reference and there is nothing joint left to resolve.
 */
export interface RepositoryLookup {
  /**
   * Deliver what ONE reference names. Single-item by design: joint version
   * selection over a batch is the resolution layer's business (a resolving
   * registry never implements this face — the collection machinery dispatches
   * its references to resolvePackages/materializePackages instead), so what
   * remains here is a repository whose delivery is genuinely per-reference —
   * a catalog's pinned-member lookup.
   * Projections and provenance carried by the reference are applied by the
   * caller (see materializeAll); `options.resolutionMode` is the
   * delivery-shape judgment of resolution repairs (see MaterializeOptions),
   * for a repository (the catalog) whose members carry resolved closures.
   */
  deliver(reference: RepositoryRef, options?: MaterializeOptions): Computable<FileSet>;

  /**
   * The requirement `ref` declares — package name + the version constraint as
   * WRITTEN — for a generated manifest (which records what a package *requires*,
   * not what fabr's joint resolution pinned, which a transitive constraint may
   * have bumped). Undefined if the reference declares no version to record.
   * OPTIONAL, and implemented only where the answer is the repository's own (a
   * catalog, whose refs carry no inline version, looks the member up and
   * delegates to *its* source): for a package registry the answer is pure
   * written-form parsing, so callers dispatch to the format instead (see
   * {@link declaredRequirementFrom}). Absent means nothing to record.
   */
  declaredRequirement?(ref: RepositoryRef): Computable<Requirement | undefined>;
}

/**
 * The RESOLVING read face of a repository — a package registry as the
 * resolution layer (PackageResolver) drives one: a transport for one ecosystem
 * — everything that needs the url, the credentials, or the wire formats, and
 * nothing that orchestrates. References against this face resolve jointly (the
 * resolution layer batches them — see resolvePackages); the counterpart for a
 * repository whose answers are already pinned is the per-reference
 * {@link RepositoryLookup} face. `npm_repository` implements this directly; a
 * `repository_group` implements it by routing every call to the member the
 * name routes to; a content route's member derives every answer from its
 * manifest. The driver functions (resolvePackages / materializePackages) only
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
  /** Stable identity for the resolution memo key, and nothing else (npm: the
   * registry url; a group: its serialized route table). */
  readonly identity: string;
  /**
   * An opaque discriminator of what a resolution is computed *for* — anything
   * beyond the roots that shapes the graph (npm: the target platform, which
   * gates optional deps; a content member: its manifest's claims). Folded into
   * the resolution memo key.
   */
  environmentKey(): Computable<string>;
  /**
   * Deliver one reference in this repository's own shape — the same method a
   * {@link RepositoryLookup} implements, so both kinds of {@link RefSource}
   * answer a delivery the same way.
   *
   * `closure` yields the resolved package with its dependency closure assembled,
   * and is a THUNK because forcing it is itself the decision: a reader asked for
   * files alone (BUILD_OPERATION=files) must not resolve at all — a package whose
   * closure is unsatisfiable still has files, so resolving eagerly would fail a
   * delivery that should succeed. It yields `undefined` for a reference that
   * demands nothing of its own (a `?` alternate).
   *
   * The shape is the repository's business and no one else's: what varies by
   * operation is decided HERE, from the context this instance was interned
   * under, so nothing upstream has to carry the operation to reach this point.
   */
  deliver(reference: RepositoryRef, options?: MaterializeOptions, closure?: ClosureThunk): Computable<FileSet>;
  /** Fetch one exact package version's content. */
  fetch(pkg: string, version: V): Computable<PackageFileSet>;
  /** The published-version list for repair suggestions; undefined when the
   * registry has no such package. Reads a mutable document — failure-path
   * only, and optional: absence means no suggestions. */
  availableVersions?(pkg: string): Computable<V[] | undefined>;
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
 * Whether `source` is a package registry (structurally — the same move as
 * {@link isRepository}): what a `repository_group` requires of a route target,
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
  package(members: PublishMember[], release: readonly RepositoryPublishRef[]): Computable<PublishableFileSet[]>;

  /**
   * Upload one prior {@link package} result to this repository's `url` — the one
   * side effect: pure upload mechanics (envelope, credential, what counts as
   * already-published), nothing about the rest of the release. Authentication is
   * the repository's own business — it knows its registry and its ecosystem's
   * credential conventions — so no token is threaded in.
   */
  publish(artifact: PublishableFileSet): Computable<PublishStatus>;
}

/**
 * The resolved-and-assembled package behind one reference, deferred. Forcing it
 * runs the joint resolution (shared across the batch, memoized); not forcing it
 * runs none at all. `undefined` where the reference demands no delivery of its
 * own — a `?` alternate, whose sanctioned fork arrives nested inside somebody
 * else's closure.
 */
export type ClosureThunk = () => Computable<PackageFileSet | undefined>;

/**
 * How a collection point consumes what it materializes — the enforcement input
 * for resolution repairs (floor raises, coexisting versions, conflict splits).
 * **"permissive"**: the closure is assembled
 * into a sealed program that is executed, not linked against (a
 * runnable-definer's install, a run delivery) — repairs are accepted and the
 * install nests npm-style. **"strict"** (the default): the closure is linked
 * into the consumer's own module graph — any repair in the delivered closure
 * is an error (with its remedy suggested). The mode is structural — a fact
 * about what the consuming rule does with the delivery, set by rule code at
 * its collection point — deliberately not a constraint (no grammar surface).
 */
export interface MaterializeOptions {
  resolutionMode?: "strict" | "permissive";
}

/**
 * The judgment every launch-bound materialization makes: what is being resolved
 * IS the program, so nothing links against its closure and repairs nest inside
 * the install rather than failing. Shared by the code paths whose whole contract
 * is "resolve this to a runnable and launch it" (the runnable accessors, a
 * command stage's tool, the `run` verb's own name), so no rule of theirs has to
 * restate it.
 */
export const PERMISSIVE_RESOLUTION: MaterializeOptions = { resolutionMode: "permissive" };

/**
 * Run one reference's delivery, attributing any failure to the written
 * reference: the ref's carried provenance lets the driver point back at the
 * requirement as written (`@npm:pkg:ver`, `@catalog:name`), not just at the
 * consuming target. The shared per-reference attribution helper for repository
 * implementations (the batch-level analogue lives with each repository's
 * resolve, which knows its own root mapping).
 */
export function attributedTo(reference: RepositoryRef, deliver: () => Computable<FileSet>): Computable<FileSet> {
  try {
    return deliver().catch(err => {
      throw new RequirementResolutionError([reference], toError(err));
    });
  } catch (err) {
    throw new RequirementResolutionError([reference], toError(err));
  }
}

/**
 * What the resolution layer needs from the CONSUMING collection point — the
 * operation the references are consumed under (a global-config read), the
 * resolve-phase memo store, and progress reporting. Every TargetContext
 * satisfies it structurally; the repositories themselves contribute only
 * per-name answers (their captured contexts stay their own business, for
 * their own transports).
 */
export interface ResolutionContext {
  /** Whose collection point this is — the consuming target's name, or a
   *  catalog's. Reported as the subject of the resolution work. */
  readonly name: string;
  getGlobalString(name: string): Computable<string>;
  memoize(tag: string, key: string, create: (targetDir: string) => Computable<FileSet>): Computable<FileSet>;
  runTask<T>(task: TaskDescription, run: (report: ITaskReport) => Computable<T>): Computable<T>;
}

/** What a {@link RepositoryRef} resolves against: a repository's read face —
 * resolving (references batched by the resolution layer) or lookup
 * (per-reference delivery from an already-fixed pin). */
export type RefSource = RepositoryLookup | RepositoryReader<unknown, unknown>;

/**
 * Resolve + deliver one repository's reference batch — the resolution layer's
 * dispatch: a package registry's references resolve jointly
 * (resolvePackages/materializePackages, the batch machinery); any other
 * repository delivers per reference. Repositories no longer carry batch
 * methods at all — batching IS this layer.
 */
export function resolveAndMaterialize(
  context: ResolutionContext,
  source: RefSource,
  references: RepositoryRef[],
  options?: MaterializeOptions
): Computable<FileSet[]> {
  /* One shape for both kinds of source: every reference is delivered by its
   * repository. A registry additionally gets a thunk for its resolved closure —
   * ONE joint resolution for the batch, forced only by the references whose
   * delivery actually needs it (see ClosureThunk). */
  const closures = isRepositoryReader(source) ? assembleClosures(context, source, references, options) : undefined;
  return Computable.forAll(
    references.map((reference, index) =>
      source.deliver(reference, options, closures && (() => closures().then(assembled => assembled[index])))
    ),
    (...delivered: FileSet[]) => delivered
  );
}

/**
 * The batch's assembled closures, one per reference, computed at most once
 * however many references force it — memoized here rather than by the caller so
 * that a batch mixing shapes (a files delivery beside a build one) still runs a
 * single resolution, and a batch needing none runs zero.
 */
function assembleClosures<V, C>(
  context: ResolutionContext,
  source: RepositoryReader<V, C>,
  references: RepositoryRef[],
  options?: MaterializeOptions
): () => Computable<(PackageFileSet | undefined)[]> {
  let started: Computable<(PackageFileSet | undefined)[]> | undefined;
  return () => {
    if (!started) {
      started = resolvePackages(context, source, references).then(resolution =>
        materializePackages(context, source, references, resolution, options)
      );
    }
    return started;
  };
}

/** One member of a destination's publish batch: where the content goes (the
 *  vended publish ref) and the identityless built content to publish there. */
export interface PublishMember {
  readonly destination: RepositoryPublishRef;
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
  constructor(
    public readonly source: RepositoryWriter,
    /** The address as written (the remainder after the repository alias),
     *  uninterpreted — its syntax is the destination's own. */
    public readonly name: Name,
    /** The declared name of the destination repository in the build's
     *  namespace (`@npm`) — the destination cannot know what it was declared
     *  as, so the resolver attaches it at vend time. Display-only: completes
     *  the written coordinate (`@npm:name:version`), never parsed. */
    public readonly repositoryName?: string
  ) {}

  public withRepositoryName(repositoryName: string): RepositoryPublishRef {
    return new RepositoryPublishRef(this.source, this.name, repositoryName);
  }

  /** The display form for messages — the full written coordinate when the
   *  repository name is known. */
  public toString(): string {
    return this.repositoryName === undefined ? this.name.toString() : `${this.repositoryName}:${this.name.toString()}`;
  }
}

/**
 * A deferred reference to files from a Repository, possibly narrowed by
 * projections: "the thing we resolve", explicitly separate from the FileSet
 * content it eventually produces. References travel through property and
 * target resolution as inert values, so that the consuming target's collection
 * point can gather every reference that surfaces and resolve them together.
 *
 * Instances are immutable: provenance steps and projections accumulate into
 * new copies, so instances cached in shared property values are never affected
 * by any individual consumer.
 */
export class RepositoryRef {
  constructor(
    public readonly source: RefSource,
    /** The reference remainder written after the repository alias,
     *  uninterpreted — how it parses is the repository's own syntax, re-read
     *  wherever it is consumed (each phase parses afresh; a ref is carried
     *  currency, never a parsed struct). */
    public readonly name: Name,
    public readonly projections: ReadonlyArray<IProjection> = [],
    public readonly steps: ReadonlyArray<IProvenanceStep> = [],
    /** The alias the repository was reached by, as written (`@deps`) — stamped
     *  where the reference resolves (the site that matched the declaration),
     *  like a publish ref's repositoryName. Display-only: how the resolution
     *  layer renders suggestions and progress in the user's own spelling. */
    public readonly repositoryName?: string
  ) {}

  /** The name as written — the display form for messages. */
  public toString(): string {
    return this.name.toString();
  }

  /** @return a copy carrying the written repository alias (see repositoryName). */
  public withRepositoryName(repositoryName: string): RepositoryRef {
    return new RepositoryRef(this.source, this.name, this.projections, this.steps, repositoryName);
  }

  /**
   * @return a copy carrying an additional provenance step (innermost first).
   */
  public withStep(step: IProvenanceStep): RepositoryRef {
    return new RepositoryRef(this.source, this.name, this.projections, [...this.steps, step], this.repositoryName);
  }

  /**
   * Finding within a reference yields a narrower reference: once resolved,
   * only the files matching the given name remain (still resolved together
   * with everything else at the collection point), renamed under the given
   * prefix per the written-name rule. A rename projection rides as a facet on
   * `name` (`sel -> tmpl`), applied by find like any other. Note that a
   * RepositoryRef is deliberately NOT a FileSource — it cannot honestly promise
   * files, only a narrower reference.
   */
  public find(name: Name, prefix = ""): RepositoryRef {
    return new RepositoryRef(this.source, this.name, [...this.projections, { pattern: name, prefix }], this.steps, this.repositoryName);
  }

  /**
   * Chain this reference's provenance steps onto its resolved base — the
   * provenance half of finishing a delivery, kept separate from projection
   * application (the resolver's job — see BuildContext.manifest).
   */
  public stampProvenance(base: FileSet): FileSet {
    if (this.steps.length === 0) {
      return base;
    }
    if (base instanceof PackageFileSet) {
      /* The reference's provenance applies to the whole delivery: the root
       * package and every member of its resolved closure — including nested
       * version overrides — arrived via the same reference. (Carried
       * references stay as they are — they get their attribution when they
       * are themselves resolved.) */
      return restampPackage(base, this.steps);
    }
    const origin = chainSteps(this.steps, base.origin);
    return origin ? base.withOrigin(origin) : base;
  }

  /**
   * A delivered base as this reference's result: provenance stamped and, when
   * the reference carries projections, wrapped as a pending {@link FileSetRef}
   * — the suspended remainder of the walk, which the DRIVER (the layer that
   * asked for the collection, holding the run context) resumes
   * (BuildContext.manifest). The delivery machinery never applies projections
   * itself.
   */
  public deliveredAs(base: FileSet): FileSet | FileSetRef {
    const renameTo = this.name.getRenameTo();
    const stamped = this.stampProvenance(base);
    /* A rename written on the reference's IDENTITY half is the package rename,
     * applied here because this is where an external package first exists; at a
     * projection the facet rides the projection instead (see find) and renames
     * the files it selects. The two never meet — a repository splits its
     * reference at the projection boundary, so the facet reaches exactly one. */
    const named = renameTo === undefined ? stamped : renamedDelivery(stamped, renameTo, this.name.toString());
    return this.projections.length > 0 ? new FileSetRef(named, this.projections) : named;
  }
}

/**
 * Deliver `source` under the name a written `-> name` gave it — the package
 * rename, in one place because only the *moment* differs between the kinds of
 * package: an external one does not exist until its collection point (so the
 * facet rides its reference here, to {@link RepositoryRef.deliveredAs}), while
 * a built one is already in hand where it is referenced
 * (BuildContext.resolveFileSource). A still-deferred reference is renamed by
 * carrying the facet onward — its delivery reaches this same rule later.
 *
 * Only a package has an identity to rename. Anything else — a runnable, a plain
 * fileset — has no name a rename could be about, so it is an error rather than
 * a silent no-op. `written` names the reference the rename was written on.
 */
export function renamedDelivery(source: FileSet, renameTo: Name, written: string): FileSet;
export function renamedDelivery(source: SourceRef, renameTo: Name, written: string): SourceRef;
export function renamedDelivery(source: SourceRef, renameTo: Name, written: string): SourceRef {
  if (source instanceof PackageFileSet) {
    return source.withPackageName(renameTo.toString());
  }
  if (source instanceof RepositoryRef && source.projections.length === 0) {
    return new RepositoryRef(source.source, source.name.withRenameTo(renameTo), source.projections, source.steps, source.repositoryName);
  }
  throw attachHelp(
    new Error(`'${written}' does not deliver a package, so there is no name for '-> ' to rename`),
    "a rename on a reference that delivers files must name what it selects ('ref:pattern -> template')"
  );
}

/**
 * Chain the reference's provenance steps onto a delivered package and its
 * carried package deps, recursively. The delivered graph may be **cyclic**
 * (complete edge bindings — see PackageFileSet), so each package is memoized
 * *before* its dependencies are restamped and the copies are wired through a
 * {@link PackageGraphBuilder}; carried RepositoryRefs pass through.
 */
function restampPackage(pkg: PackageFileSet, steps: ReadonlyArray<IProvenanceStep>): PackageFileSet {
  const builder = new PackageGraphBuilder();
  const restamped = new Map<PackageFileSet, PackageFileSet>();
  const restamp = (source: PackageFileSet): PackageFileSet => {
    let copy = restamped.get(source);
    if (!copy) {
      copy = builder.node(source, source.packageName, source.version, chainSteps(steps, source.origin), source.isNestedOverride);
      restamped.set(source, copy);
      builder.wire(
        copy,
        source.dependencies.map(dep => (dep instanceof PackageFileSet ? restamp(dep) : dep))
      );
    }
    return copy;
  };
  const root = restamp(pkg);
  builder.seal();
  return root;
}


/**
 * A FileSource, Repository, deferred RepositoryRef, or projection-pending
 * FileSetRef: the currency of property and target resolution.
 */
export type SourceRef = FileSource | Repository | RepositoryRef | FileSetRef;

/** What the delivery machinery yields per source: resolved content, a
 * Repository (for config lookups), or — for any source whose reference carries
 * projections — a still-pending {@link FileSetRef}: the suspended remainder of
 * the walk. The machinery only delivers entities; the DRIVER (the model layer
 * that asked, holding the run context) resumes the walk — applying the pending
 * projections (BuildContext.finishDelivered), or handing the ref to a consumer
 * that reinterprets it (see TargetContext.getContainedFileProperty). */
export type Materialized = FileSource | Repository | FileSetRef;

/**
 * Shallow counterpart to {@link materializeAll} for the CLI verb entry points
 * (`fabr ls`/`cat`/`run` via `resolveName`): resolve only the top-level
 * references the name itself denotes — never the dependency closure a delivered
 * package carries. A verb wants the named entity's own content (its files, or
 * its runnable), not its mounted deps: recursing the closure here would
 * re-resolve a built package's carried externals pointlessly (ls/cat discard the
 * deps, reading only the delivered set's own files) and under the wrong
 * operation (those refs ride the repository instance they were built with, not
 * this `files` one), so it both wastes work and can fail on a requirement only
 * the original build context constrained. Non-reference sources (a built
 * package, a runnable) pass through untouched; a projected source comes back as
 * a pending {@link FileSetRef} for the caller to finish (see Materialized).
 */
export function materializeShallow(
  context: ResolutionContext,
  sources: SourceRef[],
  options?: MaterializeOptions
): Computable<Materialized[]> {
  const references = sources.filter((source): source is RepositoryRef => source instanceof RepositoryRef);
  const finish = (finished: Map<RepositoryRef, FileSet | FileSetRef>): Materialized[] =>
    sources.map((source): Materialized => (source instanceof RepositoryRef ? finished.get(source)! : source));
  if (references.length === 0) {
    return Computable.resolve(finish(new Map()));
  }
  const batches = [...groupByRepository(references).entries()];
  return Computable.forAll(
    batches.map(([repository, refs]) => resolveAndMaterialize(context, repository, refs, options)),
    (...results: FileSet[][]) => {
      const finished = new Map<RepositoryRef, FileSet | FileSetRef>();
      batches.forEach(([, refs], batchIndex) =>
        refs.forEach((ref, index) => finished.set(ref, ref.deliveredAs(results[batchIndex][index])))
      );
      return finish(finished);
    }
  );
}

/**
 * Resolve the RepositoryRefs among the given sources: this is the collection
 * point — because the caller's inputs are all settled by the time the sources
 * are in hand, the set of references is provably complete. The batch includes
 * the references CARRIED by packages among the sources (a built package's
 * direct external requirements, gathered recursively through its built-package
 * deps), so every requirement reachable from this collection point takes part
 * in one joint resolution per repository — resolved fresh here, in this
 * consumer's context. Provenance carried by the references is stamped onto the
 * results; packages are re-delivered with their carried references replaced by
 * the resolutions; other sources pass through unchanged. Projections are NOT
 * applied — a projected source comes back as a pending {@link FileSetRef} for
 * the driver to finish (see Materialized).
 */
export function materializeAll(context: ResolutionContext, sources: SourceRef[], options?: MaterializeOptions): Computable<Materialized[]> {
  const references = gatherReferences(sources);
  const finish = (finished: Map<RepositoryRef, FileSet | FileSetRef>): Materialized[] => {
    const rebuilt = new Map<PackageFileSet, PackageFileSet>();
    const builder = new PackageGraphBuilder();
    const resolved = sources.map((source): Materialized => {
      if (source instanceof RepositoryRef) {
        return finished.get(source)!;
      } else if (source instanceof PackageFileSet) {
        return rebuildPackage(source, finished, rebuilt, builder);
      } else if (source instanceof FileSetRef && source.source instanceof PackageFileSet) {
        /* A pending projection over a PACKAGE participates in the collection
         * point like any other package (its carried refs were gathered), so the
         * base re-delivers and the projections stay pending over it. Only a
         * package base has anything to rebuild — every other ref passes through
         * untouched below. */
        return new FileSetRef(rebuildPackage(source.source, finished, rebuilt, builder), source.projections, source.miss);
      } else {
        return source;
      }
    });
    builder.seal();
    return resolved;
  };
  if (references.length === 0) {
    /* No references present, so nothing to resolve */
    return Computable.resolve(finish(new Map()));
  }
  const batches = [...groupByRepository(references).entries()];
  return Computable.forAll(
    batches.map(([repository, refs]) => resolveAndMaterialize(context, repository, refs, options)),
    (...results: FileSet[][]) => {
      const finished = new Map<RepositoryRef, FileSet | FileSetRef>();
      batches.forEach(([, refs], batchIndex) =>
        refs.forEach((ref, index) => finished.set(ref, ref.deliveredAs(results[batchIndex][index])))
      );
      return finish(finished);
    }
  );
}

/**
 * Materialize several gathered source-lists through ONE joint {@link materializeAll}
 * — so every reference across all of them resolves together — returning the
 * results partitioned back per input list. The shared core of the collection-point
 * accessors (`collect` / `getFileSetProperties`, and the apart tool resolutions
 * `getGlobalRunnable`/`getRunnableProperty`): each is just this plus its own
 * shaping (filter to FileSet / assert a runnable / key per name).
 */
export function materializeLists(context: ResolutionContext, lists: SourceRef[][], options?: MaterializeOptions): Computable<Materialized[][]> {
  return materializeAll(context, lists.flat(), options).then(resolved => {
    const partitioned: Materialized[][] = [];
    let index = 0;
    for (const list of lists) {
      partitioned.push(resolved.slice(index, index + list.length));
      index += list.length;
    }
    return partitioned;
  });
}

/**
 * @return every reference among the sources, plus those carried by packages —
 * recursively through their built-package deps — deduplicated by identity.
 */
function gatherReferences(sources: SourceRef[]): RepositoryRef[] {
  const references: RepositoryRef[] = [];
  const visited = new Set<RepositoryRef | PackageFileSet>();
  const gather = (source: SourceRef | PackageFileSet): void => {
    if (source instanceof RepositoryRef && !visited.has(source)) {
      visited.add(source);
      references.push(source);
    } else if (source instanceof PackageFileSet && !visited.has(source)) {
      visited.add(source);
      source.dependencies.forEach(gather);
    } else if (source instanceof FileSetRef) {
      /* A pending projection's base still carries its refs — they resolve at
       * this collection point like any package's. */
      gather(source.source);
    }
  };
  sources.forEach(gather);
  return references;
}

export function groupByRepository(references: RepositoryRef[]): Map<RefSource, RepositoryRef[]> {
  const groups = new Map<RefSource, RepositoryRef[]>();
  for (const reference of references) {
    const group = groups.get(reference.source);
    if (group) {
      group.push(reference);
    } else {
      groups.set(reference.source, [reference]);
    }
  }
  return groups;
}

/**
 * Whether any inert RepositoryRef rides anywhere beneath `pkg`. Only such a
 * package needs rebuilding at a collection point; a ref-free subgraph — in
 * particular any *delivered external* closure, which may be cyclic — is
 * returned as-is by {@link rebuildPackage}.
 *
 * Cached globally (a published PackageFileSet's dependencies never change) —
 * but only where the answer is COMPLETE. On a cyclic graph, a node judged
 * while an ancestor is still on the walk stack has not seen every path out of
 * its strongly-connected component, so a "no" computed below an open
 * back-edge is provisional: caching it would poison the cache for a graph
 * that carries a ref into a cycle. A frame's answer is cached iff it found a
 * ref (a "yes" is complete the moment it is found) or no open back-edge below
 * it reaches *above* it (the SCC-root rule — track the shallowest back-edge
 * target, Tarjan's lowlink); a provisional "no" is simply recomputed by a
 * later caller, by which time its cycle's entry node is cached. No graph
 * shape yields a wrong answer, only at worst an uncached one.
 */
const CARRIES_REFS = new WeakMap<PackageFileSet, boolean>();
function carriesReferences(pkg: PackageFileSet): boolean {
  const depth = new Map<PackageFileSet, number>();
  /** The answer, plus the shallowest stack depth any open back-edge reached. */
  const walk = (node: PackageFileSet, at: number): { carries: boolean; low: number } => {
    const known = CARRIES_REFS.get(node);
    if (known !== undefined) {
      return { carries: known, low: Infinity };
    }
    const open = depth.get(node);
    if (open !== undefined) {
      return { carries: false, low: open };
    }
    depth.set(node, at);
    let carries = false;
    let low = Infinity;
    for (const dep of node.dependencies) {
      if (dep instanceof RepositoryRef) {
        carries = true;
        break;
      }
      const result = walk(dep, at + 1);
      if (result.carries) {
        carries = true;
        break;
      }
      low = Math.min(low, result.low);
    }
    depth.delete(node);
    if (carries || low >= at) {
      CARRIES_REFS.set(node, carries);
    }
    return { carries, low };
  };
  return walk(pkg, 0).carries;
}

/**
 * Re-deliver a package with its carried references replaced by their
 * resolutions (recursively); a reference that carries projections resolves to
 * files, not a package — it cannot be mounted, so it drops out of the
 * dependency list *unapplied* (its projected content is never computed just
 * to be discarded). A ref-free package — every delivered external subgraph,
 * which may be cyclic — passes through untouched; what does get rebuilt is
 * copied through the caller's {@link PackageGraphBuilder}, memoized *before*
 * its dependencies wire, so even a ref-carrying cycle rebuilds rather than
 * recursing forever.
 */
function rebuildPackage(
  pkg: PackageFileSet,
  finished: Map<RepositoryRef, FileSet | FileSetRef>,
  rebuilt: Map<PackageFileSet, PackageFileSet>,
  builder: PackageGraphBuilder
): PackageFileSet {
  if (!carriesReferences(pkg)) {
    return pkg;
  }
  let result = rebuilt.get(pkg);
  if (!result) {
    result = builder.node(pkg, pkg.packageName, pkg.version, pkg.origin, pkg.isNestedOverride);
    rebuilt.set(pkg, result);
    builder.wire(
      result,
      pkg.dependencies
        .map(dep => (dep instanceof RepositoryRef ? finished.get(dep)! : rebuildPackage(dep, finished, rebuilt, builder)))
        .filter((dep): dep is PackageFileSet => dep instanceof PackageFileSet)
    );
  }
  return result;
}
