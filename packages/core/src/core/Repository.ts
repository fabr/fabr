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
import { FileSetRef, IProjection } from "./FileSetRef";
import { FileSet, FileSource } from "./FileSet";
import { PackageFileSet } from "./PackageFileSet";
import { RunnableFileSet } from "./RunnableFileSet";
import { chainSteps, IProvenanceStep } from "./Provenance";
import { Name } from "./Name";
import type { PublishableFileSet } from "./PublishableFileSet";
import type { Requirement } from "../resolver/Types";

/**
 * One resolved root of a {@link Resolution}: the input reference and the name
 * the repository resolved it to — the one thing a caller can read out of an
 * otherwise-opaque Resolution, so it can key/address entries (a catalog keys its
 * members by this) *without* fetching them. `name` is whatever identity the
 * repository addresses entries by (npm: the package name).
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
 * provider ({@link RepositoryReader} / {@link RepositoryWriter}) or throws — a
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
 * The read face of a repository, carried by every {@link RepositoryRef} it
 * vends: resolution of named requirements into file content. Resolution is a
 * domain (all references against it at one collection point resolve together,
 * e.g. joint minimal-version-selection), split into two phases so *fetching*
 * can be deferred past *resolving*: `resolve` fixes versions + the tree (cheap,
 * eager — the pin); `materialize` fetches + assembles a *subset* of that
 * resolution on demand. {@link resolveAndMaterialize} is just the two composed —
 * what a normal consumer, which needs all of its own references, uses.
 */
export interface RepositoryReader {
  /**
   * Phase 1 — resolve versions + dependency tree over the batch, WITHOUT
   * fetching. Returns an opaque, repository-specific Resolution the caller holds
   * and hands back to `materialize`; its `roots` name each resolved reference so
   * a caller (a catalog) can key by name without fetching.
   */
  resolve(references: RepositoryRef[]): Computable<Resolution>;

  /**
   * Phase 2 — materialize (fetch + assemble) the given references, a SUBSET of a
   * prior Resolution. Each reference's dependency closure comes from that
   * pre-resolved tree, never re-resolved, so a subset fetch preserves the joint
   * pin. The repository delivers the artifact its *operation* asks for — a plain
   * package for build/test, a runnable for run — reading it (and any global
   * config it selects on, e.g. a host platform) from its RepositoryContext,
   * interned per BuildContext. Projections and provenance carried by the
   * references are applied by the caller (see materializeAll).
   *
   * `options.resolutionMode` is the delivery-shape judgment of resolution
   * repairs (see MaterializeOptions): a permissive delivery accepts a repaired
   * closure (nested); a strict one (the default) errors on any repair in the
   * delivered closure. Run delivery is permissive implicitly (a runnable is a
   * sealed install by invariant).
   */
  materialize(references: RepositoryRef[], resolution: Resolution, options?: MaterializeOptions): Computable<FileSet[]>;

  /**
   * Repackage an already-resolved package (its closure carried) as a runnable,
   * **without re-resolving** — a pure, ecosystem-specific transform (for npm:
   * mount the closure as node_modules + a bin surface from package.json). It is
   * separate from `materialize`'s run delivery precisely so that a package
   * resolved in one place can be launched with the *exact* closure it was
   * resolved with: a catalog pins its members' versions jointly, then hands one
   * back here to be made runnable, keeping that joint closure rather than letting
   * a fresh resolution pick different (wrong) dependencies. The package must be
   * one this repository produced (a catalog delegates to its member's source).
   */
  makeRunnable(pkg: PackageFileSet): Computable<RunnableFileSet>;

  /**
   * The requirement `ref` declares — package name + the version constraint as
   * WRITTEN — for a generated manifest (which records what a package *requires*,
   * not what fabr's joint resolution pinned, which a transitive constraint may
   * have bumped). Undefined if the reference declares no version to record. npm
   * reads it off the reference's own name (`pkg:1.2.3`); a catalog, whose refs
   * carry no inline version, looks the member up and delegates to *its* source.
   */
  declaredRequirement(ref: RepositoryRef): Computable<Requirement | undefined>;
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
 * The eager one-shot: resolve a batch and immediately materialize the whole of
 * it — a normal consumer needs all of its own references, so it resolves and
 * fetches together. The collection point ({@link materializeAll}) uses this; a
 * catalog does NOT — it holds the Resolution and materializes members on demand.
 */
export function resolveAndMaterialize(
  reader: RepositoryReader,
  references: RepositoryRef[],
  options?: MaterializeOptions
): Computable<FileSet[]> {
  return reader.resolve(references).then(resolution => reader.materialize(references, resolution, options));
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
    public readonly source: RepositoryReader,
    /** The reference remainder written after the repository alias,
     *  uninterpreted — how it parses is the repository's own syntax, re-read
     *  wherever it is consumed (each phase parses afresh; a ref is carried
     *  currency, never a parsed struct). */
    public readonly name: Name,
    public readonly projections: ReadonlyArray<IProjection> = [],
    public readonly steps: ReadonlyArray<IProvenanceStep> = []
  ) {}

  /** The name as written — the display form for messages. */
  public toString(): string {
    return this.name.toString();
  }

  /**
   * @return a copy carrying an additional provenance step (innermost first).
   */
  public withStep(step: IProvenanceStep): RepositoryRef {
    return new RepositoryRef(this.source, this.name, this.projections, [...this.steps, step]);
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
    return new RepositoryRef(this.source, this.name, [...this.projections, { pattern: name, prefix }], this.steps);
  }

  /**
   * Chain this reference's provenance steps onto its resolved base — the
   * provenance half of finishing a delivery, kept separate from projection
   * application (whose single mechanism is {@link FileSetRef.manifest}).
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
   * Finish a delivery fully: provenance stamped, projections applied — each on
   * the artifact's own terms via polymorphic find (a runnable re-points its
   * launch entry; a fileset filters + prefixes, or renames per the facet). A
   * collection point that instead defers the projections (for a consumer that
   * reinterprets them) wraps {@link stampProvenance}'s result in a
   * {@link FileSetRef} itself.
   */
  public finishMaterialize(base: FileSet): Computable<FileSet> {
    return new FileSetRef(this.stampProvenance(base), this.projections).manifest();
  }
}

/**
 * Chain the reference's provenance steps onto a delivered package and its
 * carried package deps, recursively (the tree of members and their version
 * overrides is finite and acyclic; carried RepositoryRefs pass through).
 */
function restampPackage(pkg: PackageFileSet, steps: ReadonlyArray<IProvenanceStep>): PackageFileSet {
  const dependencies = pkg.dependencies.map(dep => (dep instanceof PackageFileSet ? restampPackage(dep, steps) : dep));
  return new PackageFileSet(pkg, pkg.packageName, pkg.version, dependencies, chainSteps(steps, pkg.origin));
}


/**
 * A FileSource, Repository, deferred RepositoryRef, or projection-pending
 * FileSetRef: the currency of property and target resolution.
 */
export type SourceRef = FileSource | Repository | RepositoryRef | FileSetRef;

/** What a collection point yields per source: resolved content, a Repository
 * (for config lookups), or — only under `keepProjected` — a still-pending
 * {@link FileSetRef} for a consumer that reinterprets its projections. */
export type Materialized = FileSource | Repository | FileSetRef;

/** Options for the collection-point materializers: the repository-facing
 * {@link MaterializeOptions}, plus `keepProjected` — deliver projection-pending
 * FileSetRefs unmanifested (js_script's package entry reinterprets them on the
 * runnable it builds); by default every ref manifests to its plain projected
 * files, so ordinary consumers never see one. */
export interface CollectionOptions extends MaterializeOptions {
  keepProjected?: boolean;
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
 * package, a runnable) pass through untouched.
 */
export function materializeShallow(sources: SourceRef[]): Computable<(FileSource | Repository)[]> {
  const references = sources.filter((source): source is RepositoryRef => source instanceof RepositoryRef);
  const finish = (finished: Map<RepositoryRef, Computable<FileSet>>): Computable<(FileSource | Repository)[]> => {
    const resolvedSources = sources.map((source): Computable<FileSource | Repository> => {
      if (source instanceof RepositoryRef) {
        return finished.get(source)!;
      } else if (source instanceof FileSetRef) {
        return source.manifest();
      }
      return Computable.resolve(source);
    });
    return Computable.forAll(resolvedSources, (...resolved: (FileSource | Repository)[]) => resolved);
  };
  if (references.length === 0) {
    return finish(new Map());
  }
  const batches = [...groupByRepository(references).entries()];
  return Computable.forAll(
    batches.map(([repository, refs]) => resolveAndMaterialize(repository, refs)),
    (...results: FileSet[][]) => {
      const finished = new Map<RepositoryRef, Computable<FileSet>>();
      batches.forEach(([, refs], batchIndex) =>
        refs.forEach((ref, index) => finished.set(ref, ref.finishMaterialize(results[batchIndex][index])))
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
 * consumer's context. Projections and provenance carried by the references are
 * applied to the results; packages are re-delivered with their carried
 * references replaced by the resolutions; other sources pass through
 * unchanged.
 */
export function materializeAll(sources: SourceRef[], options?: CollectionOptions): Computable<Materialized[]> {
  const references = gatherReferences(sources);
  const finish = (finished: Map<RepositoryRef, Computable<FileSetRef>>): Computable<Materialized[]> => {
    const rebuilt = new Map<PackageFileSet, Computable<PackageFileSet>>();
    const resolvedSources = sources.map((source): Computable<Materialized> => {
      if (source instanceof RepositoryRef) {
        return finished.get(source)!.then<Materialized>(pending =>
          options?.keepProjected && pending.projections.length > 0 ? pending : pending.manifest()
        );
      } else if (source instanceof PackageFileSet) {
        return rebuildPackage(source, finished, rebuilt);
      } else if (source instanceof FileSetRef) {
        /* The pending base participates in the collection point like any
         * package (its carried refs were gathered); the projections then
         * either manifest (the default — plain consumers see exactly the
         * projected files) or ride out to a consumer that reinterprets. */
        const base =
          source.source instanceof PackageFileSet
            ? rebuildPackage(source.source, finished, rebuilt)
            : Computable.resolve(source.source);
        return base.then<Materialized>(rebuiltBase => {
          const pending = new FileSetRef(rebuiltBase, source.projections, source.miss);
          return options?.keepProjected ? pending : pending.manifest();
        });
      } else {
        return Computable.resolve(source);
      }
    });
    return Computable.forAll(resolvedSources, (...resolved: Materialized[]) => resolved);
  };
  if (references.length === 0) {
    /* No references present, so nothing to resolve */
    return finish(new Map());
  }
  const batches = [...groupByRepository(references).entries()];
  return Computable.forAll(
    batches.map(([repository, refs]) => resolveAndMaterialize(repository, refs, options)),
    (...results: FileSet[][]) => {
      const finished = new Map<RepositoryRef, Computable<FileSetRef>>();
      batches.forEach(([, refs], batchIndex) =>
        refs.forEach((ref, index) =>
          /* Stamp here; projection application is the consumer side of the
           * pending form — manifested by default in finish(), kept for a
           * reinterpreting consumer under keepProjected. */
          finished.set(ref, Computable.resolve(new FileSetRef(ref.stampProvenance(results[batchIndex][index]), ref.projections)))
        )
      );
      return finish(finished);
    }
  );
}

/**
 * Materialize several gathered source-lists through ONE joint {@link materializeAll}
 * — so every reference across all of them resolves together — returning the
 * results partitioned back per input list. The shared core of the collection-point
 * accessors (`getFileSets`, `getGlobalTarget`, `collect`): each is just this plus
 * its own shaping (filter to FileSet / keep repositories / key per name).
 */
export function materializeLists(lists: SourceRef[][], options?: CollectionOptions): Computable<Materialized[][]> {
  return materializeAll(lists.flat(), options).then(resolved => {
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

export function groupByRepository(references: RepositoryRef[]): Map<RepositoryReader, RepositoryRef[]> {
  const groups = new Map<RepositoryReader, RepositoryRef[]>();
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
 * Re-deliver a package with its carried references replaced by their
 * resolutions (recursively through built-package deps); a reference that
 * resolved to something without package identity (e.g. a projection) cannot
 * be mounted and so drops out of the dependency list.
 */
function rebuildPackage(
  pkg: PackageFileSet,
  finished: Map<RepositoryRef, Computable<FileSetRef>>,
  rebuilt: Map<PackageFileSet, Computable<PackageFileSet>>
): Computable<PackageFileSet> {
  let result = rebuilt.get(pkg);
  if (!result) {
    if (pkg.dependencies.length === 0) {
      result = Computable.resolve(pkg);
    } else {
      result = Computable.forAll(
        pkg.dependencies.map(dep =>
          dep instanceof RepositoryRef ? finished.get(dep)!.then(pending => pending.manifest()) : rebuildPackage(dep, finished, rebuilt)
        ),
        (...deps) =>
          new PackageFileSet(
            pkg,
            pkg.packageName,
            pkg.version,
            deps.filter((dep): dep is PackageFileSet => dep instanceof PackageFileSet),
            pkg.origin
          )
      );
    }
    rebuilt.set(pkg, result);
  }
  return result;
}
