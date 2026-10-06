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
import { FabrError, RequirementResolutionError, toError } from "./Errors";
import { FileSetRef, IProjection } from "./FileSetRef";
import { FileSet, FileSource } from "./FileSet";
import {
  PackageFileSet,
  PackageGraphBuilder,
  packageNodeSignature,
  dependencyName,
  reachablePackages,
} from "./PackageFileSet";
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
import { checkStrictCollection } from "../resolver/StrictCollection";
import { constraintOf, markerOf } from "../resolver/Requirement";
import { instantiatePackage, materializePackages, resolvePackages } from "../resolver/PackageResolver";

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
   * caller (see materializeAll), which also judges what it was delivered (see
   * MaterializeOptions).
   */
  deliver(reference: RepositoryRef, options?: MaterializeOptions): Computable<FileSet>;

  /**
   * The files of what ONE reference names, with no dependency closure — see
   * {@link RepositoryReader.deliverFiles}. OPTIONAL: where absent,
   * {@link deliver}'s answer serves.
   */
  deliverFiles?(reference: RepositoryRef): Computable<FileSet>;

  /**
   * The requirement `ref` declares — package name + the version constraint as
   * WRITTEN — for a generated manifest (which records what a package *requires*,
   * not what fabr's joint resolution pinned, which a transitive constraint may
   * have bumped). Undefined if the reference declares no version to record.
   * OPTIONAL, and implemented only where the answer is the repository's own (a
   * catalog, whose refs carry no inline version, looks the member up and
   * delegates to *its* source): for a package registry the answer is pure
   * written-form parsing, so callers dispatch to the format instead (see
   * declaredRequirement in the resolution layer). Absent means nothing to record.
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
  /**
   * The files of the package one reference names, with no dependency closure
   * and no joint resolution: the version is the reference's own lower bound.
   * What a {@link fileRequests file request} is answered with, whatever
   * operation this instance was interned under.
   */
  deliverFiles(reference: RepositoryRef): Computable<FileSet>;
  /** Fetch one exact package version's content. */
  fetch(name: string, version: V): Computable<PackageFileSet>;
  /** The published-version list for repair suggestions; undefined when the
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
    typeof registry.deliverFiles === "function" &&
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
 * into the consumer's own module graph — so over everything the collection
 * point was delivered, from every source, a package shipped at more than one
 * version is an error (with its remedy suggested) unless each version is
 * sanctioned. The mode is structural — a fact
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
  /**
   * The packages this context was given already bound — a sub-target's
   * inputs, which its creator collected. One among the sources of a
   * collection here is delivered as it stands, like an
   * {@link instanceRequests instance}: its edges were resolved where it came
   * from, with requirements this context does not hold.
   */
  readonly given?: ReadonlySet<PackageFileSet>;
  getGlobalString(name: string): Computable<string>;
  memoize(tag: string, key: string, create: (targetDir: string) => Computable<FileSet>): Computable<FileSet>;
  runTask<T>(task: TaskDescription, run: (report: ITaskReport) => Computable<T>): Computable<T>;
}

/** What a {@link RepositoryRef} resolves against: a repository's read face —
 * resolving (references batched by the resolution layer) or lookup
 * (per-reference delivery from an already-fixed pin). */
export type RefSource = RepositoryLookup | RepositoryReader<unknown, unknown>;

/**
 * The references among `extracted` that ask for FILES rather than a package: a
 * projected reference whose consumer extracts the files it selects. Such a
 * reference names free-floating files — it is no requirement, so it joins no
 * resolution, pins nothing and brings no closure (see
 * {@link RepositoryReader.deliverFiles}). A reference also present in `kept` —
 * sources whose consumer takes the package behind the projection (a runnable's
 * entry, a contained part) — stays a package request.
 */
export function fileRequests(extracted: ReadonlyArray<SourceRef>, kept: ReadonlyArray<SourceRef> = []): ReadonlySet<RepositoryRef> {
  const packaged = new Set<SourceRef>(kept);
  return new Set(
    extracted.filter((source): source is RepositoryRef => source instanceof RepositoryRef && source.projections.length > 0 && !packaged.has(source))
  );
}

/**
 * The sources among `instantiated` that are taken as an INSTANCE of a package:
 * the package itself, as material to derive another from, rather than
 * something required. Nothing an instance requires is resolved here — its
 * edges are for the collection point the derived package reaches.
 *
 * - A reference joins no resolution and pins nothing, and is delivered as the
 *   package carrying the requirements it declares as references (see
 *   instantiatePackage in the resolution layer). A projected reference selects
 *   files, so it is a {@link fileRequests file request} instead.
 * - A package already in hand is delivered as it stands.
 */
export function instanceRequests(instantiated: ReadonlyArray<SourceRef>): ReadonlySet<RepositoryRef | PackageFileSet> {
  return new Set(
    instantiated.filter(
      (source): source is RepositoryRef | PackageFileSet =>
        source instanceof PackageFileSet || (source instanceof RepositoryRef && source.projections.length === 0)
    )
  );
}

/**
 * Resolve + deliver one repository's reference batch — the resolution layer's
 * dispatch: a package registry's references resolve jointly
 * (resolvePackages/materializePackages, the batch machinery); any other
 * repository delivers per reference. Repositories no longer carry batch
 * methods at all — batching IS this layer. A request for files is delivered
 * apart from the batch, as plain files. Given `resolution`, the batch is delivered
 * from that resolution — which must be of a batch these requests are among —
 * so that a subset keeps the joint selection.
 */
export function resolveAndMaterialize(
  context: ResolutionContext,
  source: RefSource,
  requests: ReadonlyArray<PackageRequest>,
  options?: MaterializeOptions,
  resolution?: () => Computable<Resolution>
): Computable<FileSet[]> {
  const packaged = requests.filter(request => !deliversApart(source, request));
  const position = new Map(packaged.map((request, index) => [request, index]));
  /* One shape for both kinds of source: every reference is delivered by its
   * repository. A registry additionally gets a thunk for its resolved closure —
   * ONE joint resolution for the batch, forced only by the references whose
   * delivery actually needs it (see ClosureThunk). */
  const closures = isRepositoryReader(source) && packaged.length > 0 ? assembleClosures(context, source, packaged, resolution) : undefined;
  return Computable.forAll(
    requests.map(request =>
      request.as === "instance"
        ? attributedTo(request.reference, () => deliverInstance(source, request))
        : deliversAsFiles(source, request)
        ? attributedTo(request.reference, () =>
            source.deliverFiles!(request.reference).then(delivered => new FileSet(delivered, delivered.origin))
          )
        : source.deliver(
            request.reference,
            options,
            closures && (() => closures().then(assembled => assembled[position.get(request)!]))
          )
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
  requests: ReadonlyArray<PackageRequest>,
  resolution: () => Computable<Resolution> = () => resolvePackages(context, source, requests)
): () => Computable<(PackageFileSet | undefined)[]> {
  let started: Computable<(PackageFileSet | undefined)[]> | undefined;
  return () => {
    if (!started) {
      started = resolution().then(resolved => materializePackages(context, source, requests, resolved));
    }
    return started;
  };
}

/**
 * A collection point's sources **resolved**: every reference they hold
 * or carry, as it is asked of its repository, and each registry's joint
 * resolution of its batch — computed when first wanted, once, and fetching
 * nothing. Any subset of the sources is delivered from it
 * ({@link materializeCollection}) under the one selection.
 */
export interface ResolvedCollection {
  readonly requests: ReadonlyMap<RepositoryRef, PackageRequest>;
  readonly resolutions: ReadonlyMap<RefSource, () => Computable<Resolution>>;
  /**
   * The collection's own packages by name: those built in the project that
   * its sources hold or reach, as distinct from any delivered for a reference. Each is the package of its
   * name throughout what the collection delivers — whatever a repository
   * selected for that name is left out (see {@link bindMembers}).
   */
  readonly members: ReadonlyMap<string, PackageFileSet>;
  /** The packages among the sources taken as {@link instanceRequests
   * instances}: delivered as they stand, and no member. */
  readonly instances: ReadonlySet<PackageFileSet>;
}

/**
 * Resolve `sources`: gather their references, and set up each registry's
 * resolution of its batch. The references in `files` are
 * {@link fileRequests file requests} and those in `instances`
 * {@link instanceRequests instance requests}, neither of which joins a
 * resolution.
 */
export function resolveCollection(
  context: ResolutionContext,
  sources: SourceRef[],
  files?: ReadonlySet<RepositoryRef>,
  instances?: ReadonlySet<RepositoryRef | PackageFileSet>
): ResolvedCollection {
  const held = new Set([...(instances ?? [])].filter((source): source is PackageFileSet => source instanceof PackageFileSet));
  const gathered = gatherRequirements(sources.filter(source => !(source instanceof PackageFileSet && held.has(source))));
  const { locals, own } = gathered;
  const requests = gathered.requests.map((request): PackageRequest =>
    files?.has(request.reference) === true
      ? { ...request, as: "files" }
      : instances?.has(request.reference) === true
      ? { ...request, as: "instance" }
      : request
  );
  const resolutions = new Map<RefSource, () => Computable<Resolution>>();
  for (const [source, batch] of groupRequests(requests)) {
    const packaged = batch.filter(request => !deliversApart(source, request));
    if (isRepositoryReader(source) && packaged.length > 0) {
      let started: Computable<Resolution> | undefined;
      resolutions.set(source, () => (started ??= resolvePackages(context, source, packaged, locals, own)));
    }
  }
  const members = new Map<string, PackageFileSet>();
  for (const local of locals) {
    if (!members.has(local.packageName)) {
      members.set(local.packageName, local);
    }
  }
  return { requests: new Map(requests.map(request => [request.reference, request])), resolutions, members, instances: held };
}

/**
 * Materialize `sources` — any of those `resolved` holds — from their resolutions: each
 * reference among them replaced by its delivery, and each package re-delivered
 * with the references it carries replaced likewise. Only what these sources
 * reach is fetched, and every edge named as one of the collection's
 * {@link ResolvedCollection.members members} is bound to that member. Provided
 * requirements are left for the consumer to bind, and projections for the
 * driver to finish (see {@link Materialized}).
 *
 * @return the delivered sources; what each reference was delivered as —
 * including the references of a member these sources reach without naming —
 * and, as `unbound`, the delivered sources before the members were bound, for
 * a caller accounting for what binding left out.
 */
export function materializeCollection(
  context: ResolutionContext,
  resolved: ResolvedCollection,
  sources: SourceRef[],
  options?: MaterializeOptions
): Computable<{ delivered: Materialized[]; finished: Map<RepositoryRef, Delivered>; unbound: Materialized[] }> {
  return deliverSources(context, resolved, sources, options).then(({ delivered, finished, rebuilt }) => {
    /* Each member as this delivery made it: what it was rebuilt as, or itself
     * where it had nothing to resolve. The same target reached by two routes
     * is two packages in hand and one member; either's delivered form is it. */
    const forms = new Map<string, PackageFileSet>();
    for (const [built, form] of rebuilt) {
      if (built.reference === undefined && !forms.has(built.packageName)) {
        forms.set(built.packageName, form);
      }
    }
    const own = new Map<string, PackageFileSet>();
    for (const [name, member] of resolved.members) {
      const form = forms.get(name) ?? (carriesReferences(member) ? undefined : member);
      if (form !== undefined) {
        own.set(name, form);
      }
    }
    /* A member these sources reach under its name, but did not deliver — one
     * a subset of the collection leaves out — is delivered with them: its own
     * requirements are part of what it brings. */
    const reached = new Set(reachablePackages(packagesAmong(delivered)).map(pkg => pkg.packageName));
    const unnamed = [...resolved.members].filter(([name]) => reached.has(name) && !own.has(name)).map(([, member]) => member);
    if (unnamed.length > 0) {
      return materializeCollection(context, resolved, [...sources, ...unnamed], options).then(all => ({
        delivered: all.delivered.slice(0, sources.length),
        finished: all.finished,
        unbound: all.unbound.slice(0, sources.length),
      }));
    }
    return { delivered: bindMembers(delivered, own), finished, unbound: delivered };
  });
}

/** The packages among delivered sources, a pending projection's base included. */
function packagesAmong(sources: ReadonlyArray<Materialized>): PackageFileSet[] {
  return sources.flatMap(source =>
    source instanceof PackageFileSet ? [source] : source instanceof FileSetRef && source.source instanceof PackageFileSet ? [source.source] : []
  );
}

/**
 * `delivered` with each of the collection's own packages — `members`, by name —
 * as the package of its name throughout: every edge to another package of a
 * member's name is bound to the member instead, whatever version that edge
 * asked for, and what it led to leaves the installation unless something else
 * holds it. The sources come back unchanged where no such edge exists.
 */
function bindMembers(delivered: Materialized[], members: ReadonlyMap<string, PackageFileSet>): Materialized[] {
  const displaced = (pkg: PackageFileSet): boolean => (members.get(pkg.packageName) ?? pkg) !== pkg;
  if (members.size === 0 || !reachablePackages(packagesAmong(delivered)).some(displaced)) {
    return delivered;
  }
  const builder = new PackageGraphBuilder();
  const copies = new Map<PackageFileSet, PackageFileSet>();
  const copy = (asked: PackageFileSet): PackageFileSet => {
    const pkg = members.get(asked.packageName) ?? asked;
    const held = copies.get(pkg);
    if (held !== undefined) {
      return held;
    }
    const node = builder.node(pkg, pkg.packageName, pkg.version, pkg.origin, pkg.reference);
    copies.set(pkg, node);
    builder.wire(
      node,
      pkg.dependencies.map(dep => (dep instanceof PackageFileSet ? copy(dep) : dep)),
      pkg.provided
    );
    return node;
  };
  const result = delivered.map((source): Materialized => {
    if (source instanceof PackageFileSet) {
      return copy(source);
    } else if (source instanceof FileSetRef && source.source instanceof PackageFileSet) {
      return new FileSetRef(copy(source.source), source.projections, source.miss);
    }
    return source;
  });
  builder.seal();
  return result;
}

/** {@link materializeCollection}, before the collection's members are bound. */
function deliverSources(
  context: ResolutionContext,
  resolved: ResolvedCollection,
  sources: SourceRef[],
  options?: MaterializeOptions
): Computable<{ delivered: Materialized[]; finished: Map<RepositoryRef, Delivered>; rebuilt: Map<PackageFileSet, PackageFileSet> }> {
  /* Each reference as it was resolved, so that it is found in its resolution
   * under the role it was resolved in. */
  const requests: PackageRequest[] = [];
  const taken = (source: SourceRef): boolean => source instanceof PackageFileSet && resolved.instances.has(source);
  for (const { reference } of gatherReferences(sources.filter(source => !taken(source)))) {
    const request = resolved.requests.get(reference);
    if (request === undefined) {
      return Computable.reject(new FabrError(`internal: '${reference.toString()}' was not resolved with the sources it is delivered among`));
    }
    requests.push(request);
  }
  return deliverRequests(context, requests, options, resolved.resolutions).then(finished => {
    const rebuilt = new Map<PackageFileSet, PackageFileSet>();
    const builder = new PackageGraphBuilder();
    const delivered = sources.map((source): Materialized => {
      if (source instanceof RepositoryRef) {
        return finished.get(source)!;
      } else if (taken(source)) {
        return source;
      } else if (source instanceof PackageFileSet) {
        return rebuildPackage(source, finished, rebuilt, builder);
      } else if (source instanceof FileSetRef && source.source instanceof PackageFileSet) {
        /* A pending projection over a PACKAGE participates in the collection
         * point like any other package (its carried refs were gathered), so
         * the base re-delivers and the projections stay pending over it.
         * Only a package base has anything to rebuild — every other ref
         * passes through untouched below. */
        return new FileSetRef(rebuildPackage(source.source, finished, rebuilt, builder), source.projections, source.miss);
      } else {
        return source;
      }
    });
    builder.seal();
    return { delivered, finished, rebuilt };
  });
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
  /** The package the address assigns, within {@link source}. */
  public readonly name: string;
  /** The exact version it assigns. */
  public readonly version: string;

  constructor(
    public readonly source: RepositoryWriter,
    coordinate: { readonly name: string; readonly version: string },
    /** The declared name of the destination repository in the build's
     *  namespace (`@npm`) — the destination cannot know what it was declared
     *  as, so the resolver attaches it at vend time. Display-only: completes
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
 * target resolution as inert values, so that the consuming target's collection
 * point can gather every reference that surfaces and resolve them together.
 *
 * Instances are immutable: provenance steps and projections accumulate into
 * new copies, so instances cached in shared property values are never affected
 * by any individual consumer.
 */
export class RepositoryRef implements Requirement {
  /** The package named, within {@link source}. */
  public readonly name: string;
  /** The version or range of it wanted, as written; absent where the
   *  repository's references state none (a catalog member). */
  public readonly versionConstraint: string | undefined;
  /** The override marker written on the version (`?` / `!`). */
  public readonly override?: "alternate" | "force";
  /** The name the package is delivered under instead of its own, where the
   *  reference was written with one (`@npm:pkg:1.0.0 -> other`). */
  public readonly renameTo?: string;

  constructor(
    public readonly source: RefSource,
    identity: Requirement,
    public readonly projections: ReadonlyArray<IProjection> = [],
    public readonly steps: ReadonlyArray<IProvenanceStep> = [],
    /** The name the repository was reached by, as written (`@deps`) — stamped
     *  where the reference resolves (the site that matched the declaration),
     *  like a publish ref's repositoryName. Display-only: how the resolution
     *  layer renders suggestions and progress in the user's own spelling. */
    public readonly repositoryName?: string
  ) {
    this.name = identity.name;
    this.versionConstraint = identity.versionConstraint;
    this.override = identity.override;
    this.renameTo = identity.renameTo;
  }

  /**
   * The reference a whole written name makes, in a repository whose
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

  /** The name the package is delivered under: the rename written on the
   *  reference, or the package's own. */
  public get deliveredName(): string {
    return this.renameTo ?? this.name;
  }

  /** The reference as written — the display form for messages. */
  public toString(): string {
    const identity =
      this.versionConstraint === undefined ? this.name : `${this.name}:${this.versionConstraint}${markerOf(this.override)}`;
    return this.renameTo === undefined ? identity : `${identity} -> ${this.renameTo}`;
  }

  /** @return a copy carrying the written repository name (see repositoryName). */
  public withRepositoryName(repositoryName: string): RepositoryRef {
    return new RepositoryRef(this.source, this, this.projections, this.steps, repositoryName);
  }

  /**
   * @return a copy carrying an additional provenance step (innermost first).
   */
  public withStep(step: IProvenanceStep): RepositoryRef {
    return new RepositoryRef(this.source, this, this.projections, [...this.steps, step], this.repositoryName);
  }

  /** @return a copy delivered under `renameTo` (see {@link renameTo}). */
  public withRenameTo(renameTo: string): RepositoryRef {
    return new RepositoryRef(this.source, { ...this.identity(), renameTo }, this.projections, this.steps, this.repositoryName);
  }

  private identity(): Requirement {
    return { name: this.name, versionConstraint: this.versionConstraint, override: this.override };
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
    return new RepositoryRef(this.source, this, [...this.projections, { pattern: name, prefix }], this.steps, this.repositoryName);
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
    const renameTo = this.renameTo;
    /* A package delivered whole is what this reference names: the graph is
     * built with its root saying so, and a collection point handed the package
     * asks for the reference again. */
    const stamped =
      base instanceof PackageFileSet && this.projections.length === 0 ? restampPackage(base, this.steps, this) : this.stampProvenance(base);
    /* A rename written on the reference's IDENTITY half is the package rename,
     * applied here because this is where an external package first exists; at a
     * projection the facet rides the projection instead (see find) and renames
     * the files it selects. The two never meet — a repository splits its
     * reference at the projection boundary, so the facet reaches exactly one. */
    const named = renameTo === undefined ? stamped : renamedDelivery(stamped, renameTo, this.toString());
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
export function renamedDelivery(source: FileSet, renameTo: string, written: string): FileSet;
export function renamedDelivery(source: SourceRef, renameTo: string, written: string): SourceRef;
export function renamedDelivery(source: SourceRef, renameTo: string, written: string): SourceRef {
  if (source instanceof PackageFileSet) {
    return source.withPackageName(renameTo);
  }
  if (source instanceof RepositoryRef && source.projections.length === 0) {
    return source.withRenameTo(renameTo);
  }
  throw new FabrError(`'${written}' does not deliver a package, so there is no name for '-> ' to rename`).withHelp(
    "a rename on a reference that delivers files must name what it selects ('ref:pattern -> template')"
  );
}

/**
 * Chain the reference's provenance steps onto a delivered package and its
 * carried package deps, recursively. The delivered graph may be **cyclic**
 * (complete edge bindings — see PackageFileSet), so each package is memoized
 * *before* its dependencies are restamped and the copies are wired through a
 * {@link PackageGraphBuilder}; carried references pass through. Given
 * `reference`, the copy of `pkg` is built as the package delivered for it.
 */
function restampPackage(pkg: PackageFileSet, steps: ReadonlyArray<IProvenanceStep>, reference?: RepositoryRef): PackageFileSet {
  const builder = new PackageGraphBuilder();
  const restamped = new Map<PackageFileSet, PackageFileSet>();
  const restamp = (source: PackageFileSet): PackageFileSet => {
    let copy = restamped.get(source);
    if (!copy) {
      copy = builder.node(source, source.packageName, source.version, chainSteps(steps, source.origin), source === pkg ? (reference ?? source.reference) : source.reference);
      restamped.set(source, copy);
      builder.wire(
        copy,
        source.dependencies.map(dep => (dep instanceof PackageFileSet ? restamp(dep) : dep)),
        source.provided
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
export type Materialized = FileSource | Repository | FileSetRef | RepositoryRef;

/**
 * What a reference was delivered as: content, a pending projection over it,
 * or — for a reference that demands nothing and delivers nothing of its own,
 * a `?` alternate — the reference itself, still the requirement it states.
 */
export type Delivered = FileSet | FileSetRef | RepositoryRef;

/**
 * A strict collection point's check of what it was delivered (see
 * StrictCollection); a permissive one — a sealed install — accepts it.
 */
function checkedCollection(
  finished: ReadonlyMap<RepositoryRef, unknown>,
  options?: MaterializeOptions,
  dropped?: (name: string, version: string) => boolean
): Computable<void> {
  return options?.resolutionMode === "permissive" ? Computable.resolve(undefined) : checkStrictCollection(finished, dropped);
}

/**
 * Which delivered packages binding left out of the installation: a `pkg` at
 * `version` the collection held before its members and its provided
 * requirements were bound and holds no longer — a package a member stands in
 * for, or an offer its consumer answered with something else. Undefined where
 * binding changed nothing.
 */
function droppedByBinding(before: Materialized[], after: Materialized[]): ((name: string, version: string) => boolean) | undefined {
  if (before === after) {
    return undefined;
  }
  const held = (sources: Materialized[]): Set<string> =>
    new Set(
      reachablePackages(
        sources.flatMap(source =>
          source instanceof PackageFileSet ? [source] : source instanceof FileSetRef && source.source instanceof PackageFileSet ? [source.source] : []
        )
      ).map(pkg => pkg.packageId)
    );
  const was = held(before);
  const is = held(after);
  return (pkg, version) => was.has(`${pkg}@${version}`) && !is.has(`${pkg}@${version}`);
}

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
  const finish = (finished: Map<RepositoryRef, Delivered>): Materialized[] =>
    sources.map((source): Materialized => (source instanceof RepositoryRef ? finished.get(source)! : source));
  if (references.length === 0) {
    return Computable.resolve(finish(new Map()));
  }
  return deliverRequests(context, references.map(packageRequest), options).then(finished =>
    checkedCollection(finished, options).then(() => finish(finished))
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
 * the driver to finish (see Materialized). The references in `files` are
 * {@link fileRequests file requests}, delivered as plain files outside the
 * joint resolution, and those in `instances` {@link instanceRequests instance
 * requests}, delivered as packages outside it.
 */
export function materializeAll(
  context: ResolutionContext,
  sources: SourceRef[],
  options?: MaterializeOptions,
  files?: ReadonlySet<RepositoryRef>,
  instances?: ReadonlySet<RepositoryRef | PackageFileSet>
): Computable<Materialized[]> {
  const given = context.given;
  const taken =
    given === undefined
      ? instances
      : new Set([...(instances ?? []), ...sources.filter((source): source is PackageFileSet => source instanceof PackageFileSet && given.has(source))]);
  return materializeCollection(context, resolveCollection(context, sources, files, taken), sources, options).then(({ delivered, finished, unbound }) => {
    /* Judged as bound: a package the collection's own member stands in for,
     * or an offer the consumer answered with something else, is not in the
     * installation, so it is not a version that ships. */
    const bound = bindProvided(delivered);
    return finished.size === 0 ? bound : checkedCollection(finished, options, droppedByBinding(unbound, bound)).then(() => bound);
  });
}

/**
 * The installation `sources` make up, with every delivered package's provided
 * requirements ({@link PackageFileSet.provided}) bound by its consumer. Each is
 * answered by the first of:
 *
 * - what its **dependent** binds for that name — a dependency of the
 *   dependent's own, or the dependent's own provided binding — and so on up the
 *   chain of dependents;
 * - the collection's own **direct member** of that name, which is the top of
 *   that chain (a renamed member supplies the name it is delivered under);
 * - what its resolution **offered**: the default the delivery wired, or, where
 *   it wired none, an instance of the offered version the installation holds;
 *
 * and is left unbound otherwise, as an installation without it leaves it. A
 * binding is an ordinary edge. A package reached through dependents that bind
 * it differently comes back as one node per binding; one reached the same way
 * everywhere is one node, so the result is the input's shape wherever nothing
 * above a package supplies what its resolution did not.
 *
 * The sources come back unchanged where no package has a provided requirement.
 * Where several instances hold one offered name and version, the one with the
 * lowest node signature is bound, so the choice does not follow input order.
 */
export function bindProvided(sources: Materialized[]): Materialized[] {
  const roots = sources.flatMap(source =>
    source instanceof PackageFileSet ? [source] : source instanceof FileSetRef && source.source instanceof PackageFileSet ? [source.source] : []
  );
  const packages = reachablePackages(roots);
  if (!packages.some(pkg => pkg.provided.size > 0)) {
    return sources;
  }
  const present = new Map<string, Array<{ pkg: PackageFileSet; signature: string }>>();
  for (const pkg of packages) {
    present.set(pkg.packageName, [...(present.get(pkg.packageName) ?? []), { pkg, signature: packageNodeSignature(pkg) }]);
  }
  /** The package the installation holds that answers `reference` under
   * `name` — of several, the one with the lowest node signature. */
  const answering = (name: string, reference: RepositoryRef): PackageFileSet | undefined =>
    (present.get(name) ?? [])
      .filter(({ pkg }) => answers(reference, pkg))
      .reduce<{ pkg: PackageFileSet; signature: string } | undefined>(
        (lowest, candidate) => (lowest === undefined || candidate.signature < lowest.signature ? candidate : lowest),
        undefined
      )?.pkg;
  const wanted = providedNamesBelow(packages);
  const ids = new Map<PackageFileSet, number>(packages.map((pkg, index) => [pkg, index]));

  /** What a name is supplied by: the package, and the scope its own provided
   * requirements are answered in. */
  interface ISupply {
    readonly pkg: PackageFileSet;
    readonly scope: IScope;
  }
  /** One dependent's bindings by name, over its own dependent's. */
  interface IScope {
    readonly id: number;
    readonly parent?: IScope;
    readonly bindings: Map<string, ISupply>;
  }
  const supplied = (scope: IScope | undefined, name: string): ISupply | undefined => {
    for (let at = scope; at !== undefined; at = at.parent) {
      const supply = at.bindings.get(name);
      if (supply !== undefined) {
        return supply;
      }
    }
    return undefined;
  };
  let scopes = 0;
  const top: IScope = { id: scopes++, bindings: new Map() };
  for (const root of roots) {
    top.bindings.set(root.packageName, { pkg: root, scope: top });
  }

  const builder = new PackageGraphBuilder();
  const copies = new Map<string, PackageFileSet>();
  /** `pkg` as its dependent's `scope` wires it: one node per distinct answer to
   * the names anything below it wants supplied. */
  const copy = (pkg: PackageFileSet, scope: IScope): PackageFileSet => {
    const answers = wanted.get(pkg)!.map(name => {
      const supply = supplied(scope, name);
      return supply === undefined ? "-" : `${ids.get(supply.pkg)}/${supply.scope.id}`;
    });
    const key = `${ids.get(pkg)}:${answers.join(",")}`;
    const held = copies.get(key);
    if (held !== undefined) {
      return held;
    }
    const node = builder.node(pkg, pkg.packageName, pkg.version, pkg.origin, pkg.reference);
    copies.set(key, node);
    const own: IScope = { id: scopes++, parent: scope, bindings: new Map() };
    /* Each edge with what supplies it: an ordinary one is supplied by what it
     * is bound to, here; a provided one is decided below. */
    const edges = pkg.dependencies.map(dep => {
      const provided = pkg.provided.has(dependencyName(dep));
      const supply: ISupply | undefined = !provided && dep instanceof PackageFileSet ? { pkg: dep, scope: own } : undefined;
      if (supply !== undefined) {
        own.bindings.set(supply.pkg.packageName, supply);
      }
      return { dep, provided, supply };
    });
    /* Every binding is decided before anything below is copied: how a
     * dependency is wired depends on all of them. */
    const bound = edges.map(({ dep, provided, supply }) => {
      if (!provided) {
        return { dep, supply };
      }
      const name = dependencyName(dep);
      const answer =
        supplied(scope, name) ??
        (dep instanceof PackageFileSet
          ? { pkg: dep, scope: own }
          : ((held): ISupply | undefined => held && { pkg: held, scope: top })(answering(name, dep)));
      if (answer !== undefined) {
        own.bindings.set(name, answer);
      }
      return { dep, supply: answer };
    });
    builder.wire(
      node,
      bound.map(({ dep, supply }) => (supply === undefined ? dep : copy(supply.pkg, supply.scope))),
      pkg.provided
    );
    return node;
  };
  const result = sources.map((source): Materialized => {
    if (source instanceof PackageFileSet) {
      return copy(source, top);
    } else if (source instanceof FileSetRef && source.source instanceof PackageFileSet) {
      return new FileSetRef(copy(source.source, top), source.projections, source.miss);
    }
    return source;
  });
  builder.seal();
  return result;
}

/**
 * For each package, the provided names anything it reaches asks to be supplied
 * — the names whose answers decide how its subtree is wired — sorted.
 */
function providedNamesBelow(packages: PackageFileSet[]): Map<PackageFileSet, string[]> {
  const names = new Map(packages.map(pkg => [pkg, new Set(pkg.provided.keys())]));
  for (let changed = true; changed; ) {
    changed = false;
    for (const pkg of packages) {
      const own = names.get(pkg)!;
      for (const dep of pkg.packages) {
        for (const name of names.get(dep) ?? []) {
          if (!own.has(name)) {
            own.add(name);
            changed = true;
          }
        }
      }
    }
  }
  return new Map([...names].map(([pkg, wanted]) => [pkg, [...wanted].sort()]));
}

/**
 * Materialize several gathered source-lists through ONE joint {@link materializeAll}
 * — so every reference across all of them resolves together — returning the
 * results partitioned back per input list. The shared core of the collection-point
 * accessors (`collect` / `getFileSetProperties`, and the apart tool resolutions
 * `getGlobalRunnable`/`getRunnableProperty`): each is just this plus its own
 * shaping (filter to FileSet / assert a runnable / key per name).
 *
 * `extracted` says, per list, whether its consumer extracts the files a
 * projection selects (so the list's projected references are
 * {@link fileRequests file requests}) rather than taking the package behind
 * it. Absent, no list is extracted. `instantiated` says, per list, whether its
 * consumer takes each package the list names as an
 * {@link instanceRequests instance}. Absent, no list is.
 */
export function materializeLists(
  context: ResolutionContext,
  lists: SourceRef[][],
  options?: MaterializeOptions,
  extracted?: ReadonlyArray<boolean>,
  instantiated?: ReadonlyArray<boolean>
): Computable<Materialized[][]> {
  const files =
    extracted === undefined
      ? undefined
      : fileRequests(
          lists.filter((_, index) => extracted[index]).flat(),
          lists.filter((_, index) => !extracted[index]).flat()
        );
  const instances = instantiated === undefined ? undefined : instanceRequests(lists.filter((_, index) => instantiated[index]).flat());
  return materializeAll(context, lists.flat(), options, files, instances).then(resolved => {
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
 * One reference a collection point resolves, and what is wanted of it:
 *
 * - `"package"` — the package it names, resolved jointly with the rest of its
 *   repository's batch: a requirement of the collection's own, so what is
 *   written on it — an exact pin, a `?`, a `!` — is the collection's;
 * - `"carried"` — the package a built package among the sources requires by
 *   it: an edge of that package's node in the resolution, bound like any
 *   package's requirement, with nothing written on it the collection's;
 * - `"files"` — the files its projection selects, on their own: it joins no
 *   resolution, pins nothing and brings no closure (see {@link fileRequests});
 * - `"instance"` — the package it names, on its own: it joins no resolution and
 *   pins nothing, and the package carries the requirements it declares as
 *   references to the same repository, for the collection point it reaches to
 *   resolve (see {@link instanceRequests}).
 */
export interface PackageRequest {
  readonly reference: RepositoryRef;
  readonly as: "package" | "carried" | "files" | "instance";
}

/** A request for the package `reference` names. */
export function packageRequest(reference: RepositoryRef): PackageRequest {
  return { reference, as: "package" };
}

/**
 * @return a request for every reference among the sources, plus those of the
 * packages among them: the reference a package was delivered for, or, for a
 * package nothing delivered, the references its edges hold — recursively,
 * and no further than a package that has one of its own. One per reference:
 * a source's own is the collection's requirement, whoever else carries it. A
 * carried reference is left out where it resolves nothing: an optional
 * provided requirement, a `?` — a permission its writer gave its own
 * collection point — and one with projections, which names files and so
 * binds no package.
 */
function gatherReferences(sources: SourceRef[]): PackageRequest[] {
  return gatherRequirements(sources).requests;
}

/**
 * {@link gatherReferences}, with the packages built in the project that the
 * sources hold or reach: each a node of every resolution here, the references
 * it carries being its own requirements.
 */
function gatherRequirements(sources: SourceRef[]): { requests: PackageRequest[]; locals: PackageFileSet[]; own: Set<PackageFileSet> } {
  const locals: PackageFileSet[] = [];
  /* Those of them the sources hold outright: the collection's own
   * requirements, as a reference among the sources is. */
  const own = new Set<PackageFileSet>();
  const references: RepositoryRef[] = [];
  const direct = new Set<RepositoryRef>();
  const visited = new Set<RepositoryRef | PackageFileSet>();
  const gather = (source: SourceRef | PackageFileSet, carried: boolean): void => {
    if (source instanceof RepositoryRef) {
      if (!carried) {
        direct.add(source);
      }
      if ((!carried || (source.projections.length === 0 && source.override !== "alternate")) && !visited.has(source)) {
        visited.add(source);
        references.push(source);
      }
    } else if (source instanceof PackageFileSet && source.reference !== undefined) {
      /* A package a repository delivered is its reference, asked for again:
       * the resolution follows it from there. */
      gather(source.reference, carried);
    } else if (source instanceof PackageFileSet && !visited.has(source)) {
      visited.add(source);
      locals.push(source);
      if (!carried) {
        own.add(source);
      }
      for (const dep of source.dependencies) {
        if (source.provided.get(dependencyName(dep)) !== "optional") {
          gather(dep, true);
        }
      }
    } else if (source instanceof FileSetRef) {
      /* A pending projection's base still carries its refs — they resolve at
       * this collection point like any package's. */
      gather(source.source, carried);
    }
  };
  sources.forEach(source => gather(source, false));
  const requests = references.map((reference): PackageRequest => ({ reference, as: direct.has(reference) ? "package" : "carried" }));
  return { requests, locals, own };
}

/** The requests of each repository, in the order first asked of it. */
function groupRequests(requests: ReadonlyArray<PackageRequest>): Map<RefSource, PackageRequest[]> {
  const groups = new Map<RefSource, PackageRequest[]>();
  for (const request of requests) {
    groups.set(request.reference.source, [...(groups.get(request.reference.source) ?? []), request]);
  }
  return groups;
}

/** Whether `request` is for a package its reference only permits (a `?`
 * alternate): it installs nothing, so what comes back is the requirement. */
function deliversNothing(request: PackageRequest): boolean {
  return request.reference.override === "alternate" && request.as === "package";
}

/** Whether `source` delivers `request` as plain files, apart from its batch:
 * the request asks for files, and the repository can deliver them. */
function deliversAsFiles(source: RefSource, request: PackageRequest): boolean {
  return request.as === "files" && source.deliverFiles !== undefined;
}

/** Whether `request` is delivered apart from its repository's batch. */
function deliversApart(source: RefSource, request: PackageRequest): boolean {
  return request.as === "instance" || deliversAsFiles(source, request);
}

/** The package `request` names, as an instance of `source`'s. */
function deliverInstance(source: RefSource, { reference }: PackageRequest): Computable<FileSet> {
  if (!isRepositoryReader(source)) {
    throw new FabrError(
      `'${reference.toString()}' names a package its repository pins rather than resolves, so its requirements are not that repository's to state`
    ).withHelp("name the package in the registry it comes from");
  }
  return instantiatePackage(source, reference);
}

/**
 * Deliver `requests` — each repository's as one batch, see
 * {@link resolveAndMaterialize} — and finish each reference's delivery
 * ({@link RepositoryRef.deliveredAs}). A repository with a resolution in
 * `resolutions` delivers its batch from it.
 */
function deliverRequests(
  context: ResolutionContext,
  requests: ReadonlyArray<PackageRequest>,
  options?: MaterializeOptions,
  resolutions?: ReadonlyMap<RefSource, () => Computable<Resolution>>
): Computable<Map<RepositoryRef, Delivered>> {
  const batches = [...groupRequests(requests)];
  return Computable.forAll(
    batches.map(([repository, batch]) => resolveAndMaterialize(context, repository, batch, options, resolutions?.get(repository))),
    (...results: FileSet[][]) => {
      const finished = new Map<RepositoryRef, Delivered>();
      batches.forEach(([, batch], batchIndex) =>
        batch.forEach((request, index) =>
          finished.set(request.reference, deliversNothing(request) ? request.reference : request.reference.deliveredAs(results[batchIndex][index]))
        )
      );
      return finished;
    }
  );
}

/**
 * Whether `pkg` is what `reference` names: a version its repository's format
 * accepts for the requirement the reference states. Asked of a package already
 * known by the name the reference is required under. A reference whose
 * repository resolves no versions is answered by nothing.
 */
function answers(reference: RepositoryRef, pkg: PackageFileSet): boolean {
  const source = reference.source;
  if (!isRepositoryReader(source) || pkg.version === undefined) {
    return false;
  }
  const { format } = source;
  try {
    return format.satisfies(format.parseVersion(pkg.version), constraintOf(format, reference.versionConstraint));
  } catch {
    return false;
  }
}

/**
 * Whether an edge of `pkg`, or of a package it reaches without passing one a
 * repository delivered, is one a collection point resolves: a reference, or a
 * package delivered for one. Only such a package needs rebuilding at a
 * collection point; any other subgraph — in particular the closure below a
 * delivered package, which may be cyclic — is returned as-is by
 * {@link rebuildPackage}.
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
    const followed = node.dependencies.filter(dep => node.provided.get(dependencyName(dep)) !== "optional");
    let carries = followed.some(dep => dep instanceof RepositoryRef || dep.reference !== undefined);
    let low = Infinity;
    for (const dep of followed) {
      if (carries) {
        break;
      }
      if (dep instanceof PackageFileSet) {
        const result = walk(dep, at + 1);
        carries = result.carries;
        low = Math.min(low, result.low);
      }
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
 * Re-deliver a package as this collection point resolved it: a package a
 * repository delivered is what its reference was delivered as here, and any
 * other has each edge that is a reference, or such a package, bound to what
 * was delivered for it — recursively. A reference that delivered no package
 * stays one. A package with nothing here to resolve passes through untouched;
 * what does get rebuilt is copied through the caller's
 * {@link PackageGraphBuilder}, memoized *before* its dependencies wire, so
 * even a cycle rebuilds rather than recursing forever.
 */
function rebuildPackage(
  pkg: PackageFileSet,
  finished: Map<RepositoryRef, Delivered>,
  rebuilt: Map<PackageFileSet, PackageFileSet>,
  builder: PackageGraphBuilder
): PackageFileSet {
  const delivered = pkg.reference && finished.get(pkg.reference);
  if (delivered instanceof PackageFileSet) {
    return delivered;
  }
  if (pkg.reference !== undefined) {
    return pkg;
  }
  if (!carriesReferences(pkg)) {
    rebuilt.set(pkg, pkg);
    return pkg;
  }
  let result = rebuilt.get(pkg);
  if (!result) {
    result = builder.node(pkg, pkg.packageName, pkg.version, pkg.origin);
    rebuilt.set(pkg, result);
    builder.wire(
      result,
      pkg.dependencies.map(dep => {
        if (pkg.provided.get(dependencyName(dep)) === "optional") {
          return dep;
        }
        if (dep instanceof PackageFileSet) {
          return rebuildPackage(dep, finished, rebuilt, builder);
        }
        const bound = finished.get(dep);
        return bound instanceof PackageFileSet ? bound : dep;
      }),
      pkg.provided
    );
  }
  return result;
}
