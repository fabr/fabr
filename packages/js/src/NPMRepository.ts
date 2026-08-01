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

import {
  attachHelp,
  attributedTo,
  BUILD_OPERATION,
  Computable,
  coexistingVersions,
  compareVersions,
  edgeBinding,
  FILES_OPERATION,
  FileSet,
  HttpStatusError,
  IRequirementEdge,
  IResolutionOrigin,
  IFile,
  isJsonObject,
  lowestSatisfying,
  MaterializeOptions,
  MemoryFile,
  MetadataFetchError,
  MultiError,
  Name,
  nodeId,
  NpmPlatform,
  PACKAGE_RESOLUTION_PROVENANCE,
  PackageFileSet,
  packToTarball,
  PackageRegistry,
  parseJson,
  parseVersion,
  readJsonFile,
  PublishableFileSet,
  RaisedFloor,
  RepositoryPublishRef,
  RepositoryReader,
  RepositoryWriter,
  PublishMember,
  PublishStatus,
  reachableSplits,
  readStream,
  RepairableResolution,
  Repository,
  RepositoryContext,
  RepositoryRef,
  RepositoryRegistration,
  Requirement,
  RequirementResolutionError,
  Resolution,
  ResolutionWalkError,
  ResolvedRoot,
  resolveWithRepairs,
  ROOT_REQUIRER,
  RunnableFileSet,
  Selected,
  SEMVER,
  SemverConstraint,
  SemverVersion,
  TARGET,
  toError,
  toJsonObject,
  tripleToNpm,
  unpackStream,
  VersionNotFoundError,
  select,
  versionToString,
  Violation,
} from "@fabr-build/core";
import { buildMounts, EdgeMap, makeNpmRunnable, planMounts, PlannedMount } from "./JSPackage";
import {
  INPMPackageMetadata,
  isSemverConstraint,
  matchesTargetPlatform,
  NpmPublishIdentity,
  npmPackageOfPath,
  parseMetadataResponse,
  PublishAccess,
  publishToRegistry,
  toPublishAccess,
  splitNameVersion,
  splitNpmReference,
  stripArchiveRoot,
  tarballBasename,
  unsupportedPlatformReason,
  verifyTarballStream,
} from "./NPMProtocol";
import {
  dependencyBlock,
  memberDependencies,
  optionalPeers,
  rewriteManifest,
  unresolvableDependencies,
} from "./PackageJson";
import { NPMAuth } from "./NPMAuth";
import { jsPluginContext } from "./JSPluginContext";

const METADATA_FILE = "metadata.json";
const RESOLUTION_FILE = "resolution.json";
const VERSIONS_FILE = "versions.json";

/** Serialized form of one selection in a persisted resolution document */
interface IResolutionEntry {
  pkg: string;
  version: string;
  selectedBy?: IRequirementEdge;
  reachedVia?: IRequirementEdge;
  reachableFrom?: number[];
}

/** Serialized upper-bound violation (see resolver Violation) */
interface IViolationEntry {
  pkg: string;
  constraint: string;
  requiredBy: string;
  selected: string;
}

/** Serialized floor raise (see resolver RaisedFloor) */
interface IRaiseEntry {
  pkg: string;
  constraint: string;
  declared: string;
  raised: string;
  requiredBy: string;
}

/** Serialized private split subtree repairing one violated requirement */
interface ISplitEntry {
  pkg: string;
  constraint: string;
  selections: IResolutionEntry[];
  violations: IViolationEntry[];
  raises: IRaiseEntry[];
}

/** Serialized form of a persisted joint resolution (memo tag npm:resolve:11) */
interface IResolutionDoc {
  roots: Requirement[];
  selections: IResolutionEntry[];
  violations: IViolationEntry[];
  raises: IRaiseEntry[];
  splits: ISplitEntry[];
}

function requirementKey(req: Requirement): string {
  return `${req.pkg}:${req.constraint}`;
}

/** A selection's `pkg@version` node id — the resolver's node-id form, also the
 * id space of the transient edge map a permissive delivery is planned from. */
function selectionId(sel: Selected<SemverVersion>): string {
  return nodeId(SEMVER, sel.pkg, sel.version);
}

/** One root's planned delivery: its own node, and the tree mounted under it. */
interface PlannedClosure {
  rootId: string;
  mounts: PlannedMount[];
}

/** The id of the scope's selection an (unviolated) requirement binds to, by
 * the resolver's own edge rule; undefined when the edge leads nowhere (a gated
 * optional pruned from the walk, or an unparseable constraint already
 * reported). */
function edgeTargetIn(selections: Selected<SemverVersion>[], req: Requirement): string | undefined {
  const target = edgeBinding(SEMVER, selections, req);
  return target && selectionId(target);
}

/** One deserialized split subtree (the runtime form of ISplitEntry). */
interface NpmSplit {
  readonly pkg: string;
  readonly constraint: string;
  readonly selections: Selected<SemverVersion>[];
  readonly violations: Violation<SemverVersion>[];
  readonly raises: RaisedFloor<SemverVersion>[];
}

/** The main tree + repairs of a deserialized resolution document. */
interface ResolvedRepairs {
  readonly selections: Selected<SemverVersion>[];
  readonly violations: Violation<SemverVersion>[];
  readonly raises: RaisedFloor<SemverVersion>[];
  readonly splits: NpmSplit[];
}

/**
 * npm's private {@link Resolution}: the joint version selection + reachable
 * tree, the repairs recorded while resolving it (violations, raises, and the
 * private split subtrees repairing the violations — judged per delivery at
 * materialize), plus the operation it was resolved under (so materialize
 * delivers the same package-vs-runnable shape without a second context read).
 * `selections`/`rootIndex` are empty under the `files` operation, where
 * materialize fetches per-reference.
 */
interface NpmResolution extends Resolution, ResolvedRepairs {
  readonly roots: ResolvedRoot[];
  readonly operation: string;
  /** requirementKey → index into the resolution's roots (the space `reachableFrom` indexes). */
  readonly rootIndex: Map<string, number>;
}

/** name → version for the names `assignments` assign exactly one distinct
 *  version — the names a manifest dependency can be unambiguously rewritten to. */
function uniqueAssignments(assignments: readonly NpmPublishIdentity[]): Map<string, string> {
  const byName = new Map<string, Set<string>>();
  for (const { name, version } of assignments) {
    byName.set(name, (byName.get(name) ?? new Set()).add(version));
  }
  return new Map(select([...byName], ([name, versions]) => (versions.size === 1 ? ([name, [...versions][0]] as const) : undefined)));
}

/** The version names a packument lists — the only thing fabr reads one for.
 *  A document with no `versions` map is not a packument (an error body, or the
 *  wrong URL), and says nothing about what is published. */
function toPublishedVersions(json: unknown): string[] {
  if (!isJsonObject(json) || !isJsonObject(json.versions)) {
    throw new Error("no versions");
  }
  return Object.keys(json.versions);
}

/**
 * A package name as ONE registry path segment: npm percent-encodes the `/` of a
 * scoped name (`@types/node` → `@types%2fnode`) on every read. npmjs also
 * accepts the raw slash, but a registry or proxy routing on path segments reads
 * that as a package `@types` with a sub-resource, and answers 404.
 */
function packagePath(pkg: string): string {
  return pkg.replace(/\//g, "%2f");
}

export class NPMRepository implements Repository, RepositoryReader, RepositoryWriter, PackageRegistry<SemverVersion> {
  private readonly url: string;
  private readonly context: RepositoryContext;
  /** The access level this repository's publishes request (see {@link PublishAccess}). */
  private readonly access: PublishAccess;
  /* In-process memo over the persistent metadata cache, keyed by "pkg/version" */
  private readonly metadataCache: Map<string, Computable<INPMPackageMetadata>>;

  constructor(url: string, context: RepositoryContext, access: PublishAccess = null) {
    this.url = url.replace(/\/+$/, "");
    this.context = context;
    this.access = access;
    this.metadataCache = new Map();
  }

  /* The run's registry-auth authority (the combined project + user `.npmrc`,
   * plus the per-registry second-factor sessions), loaded once per run and
   * shared across every NPMRepository instance (held on the ExecutionContext
   * via the js plugin context, not per instance); the project `.npmrc` is read
   * through the source FS, so it re-settles if it changes in watch mode. */
  private npmAuth(): Computable<NPMAuth> {
    return jsPluginContext(this.context.execution).npmAuth();
  }

  /**
   * The `Authorization` header for a request to `url`, from the combined `.npmrc`
   * — used for both reads (private packages / a private registry) and the publish
   * write. Auth is keyed per registry (longest-prefix match), so a request to a
   * host with no configured credential — a public registry, or a tarball CDN whose
   * url came from registry metadata — is anonymous, with no risk of leaking a
   * credential off-registry.
   */
  private authHeadersFor(url: string): Computable<Record<string, string>> {
    return this.npmAuth().then(auth => auth.getHeadersFor(url));
  }

  public getRepositoryRef(name: Name): RepositoryRef {
    const { requirement, projection } = splitNpmReference(name);
    const ref = new RepositoryRef(this, requirement);
    return projection ? ref.find(projection.pattern, projection.prefix) : ref;
  }

  public getRepositoryPublishRef(name: Name): RepositoryPublishRef {
    this.coordinateIdentity(name); /* validate the address shape up front */
    return new RepositoryPublishRef(this, name);
  }

  /** The name + exact version a publish coordinate assigns, re-parsed from the
   *  written name (an address is carried as its Name; each consumer parses
   *  afresh, as the read side does with reference names). */
  private coordinateIdentity(ref: Name): NpmPublishIdentity {
    const split = splitNameVersion(ref);
    if (!split) {
      const literal = ref.toString();
      throw new Error(`publish coordinate '${literal}' must name a version (e.g. ${literal}:1.0.0)`);
    }
    const { identifier: name, version } = split;
    /* A coordinate pins an exact version (unlike a read requirement's range). */
    try {
      parseVersion(version);
    } catch {
      throw new Error(`publish coordinate '${name}' must pin an exact version, got '${version}'`);
    }
    return { name, version };
  }

  /**
   * Package this registry's members into the npm wire form (pure — the dry-run
   * artifacts), jointly. Each member's built `package.json` is the final
   * manifest: rewritten with its assigned name/version and, for any dependency
   * naming a release member, that member's assigned version. The rewrite map
   * prefers **this destination's own assignments** — a dependant published
   * alongside one line of a package that the release assigns different versions
   * at different registries declares *its* registry's line, since that is what
   * its consumers will resolve — falling back to the release-wide assignment for
   * names this batch doesn't cover (the maintained-in-sync twin published
   * elsewhere). At either scope a name only rewrites when assigned a single
   * distinct version; any install-relevant dependency still versionless after
   * rewriting (a built package this sync does not publish, or one it publishes
   * at conflicting versions with none at this destination) is unresolvable for
   * every consumer, so packaging fails. Each member's files are laid out under
   * `package/` and gzip-tarred; its carrier holds that `.tgz` plus the rewritten
   * manifest as a sidecar (sans `dist`, which `publish` injects) and the
   * co-member dependency names for deps-first upload ordering.
   */
  public package(members: PublishMember[], release: readonly RepositoryPublishRef[]): Computable<PublishableFileSet[]> {
    /* The npm-shaped slice of the release: coordinates addressed to ANY npm
     * destination (so a cross-registry npm twin participates in the rewrite),
     * their identities re-parsed from the written name; an address in some other
     * ecosystem's namespace (a file path, say) has no name/version and is
     * ignored. */
    const npmRelease = release
      .filter(coordinate => coordinate.source instanceof NPMRepository)
      .map(coordinate => this.coordinateIdentity(coordinate.name));
    /* Later entries win the merge: own-batch assignments over release-wide. (A
     * name can't be batch-unique but release-ambiguous *and missing* from the
     * batch map — own coordinates are a subset of the release's.) */
    const memberVersions = new Map([
      ...uniqueAssignments(npmRelease),
      ...uniqueAssignments(members.map(member => this.coordinateIdentity(member.destination.name))),
    ]);
    const memberNames = new Set(npmRelease.map(identity => identity.name));
    return Computable.forAll(
      members.map(member => this.packageMember(member, memberVersions, memberNames)),
      (...carriers: PublishableFileSet[]) => carriers
    );
  }

  private packageMember(
    member: PublishMember,
    memberVersions: ReadonlyMap<string, string>,
    memberNames: ReadonlySet<string>
  ): Computable<PublishableFileSet> {
    const identity = this.coordinateIdentity(member.destination.name);
    const { content } = member;
    return content.get("package.json").then(manifestFile => {
      if (!manifestFile) {
        throw new Error(`cannot publish ${identity.name}: the built package has no package.json`);
      }
      return readJsonFile(manifestFile, toJsonObject).then(built => {
        const manifest = rewriteManifest(built, identity, memberVersions);
        const dangling = unresolvableDependencies(manifest);
        if (dangling.length > 0) {
          throw new Error(
            `cannot publish ${identity.name}: no version to record for ${dangling
              .map(dep => `'${dep}'`)
              .join(", ")} — a dependency built here must be published by this sync (at a single version) for its ` +
              `dependants to be resolvable`
          );
        }
        const manifestJson = JSON.stringify(manifest, undefined, 2) + "\n";
        const rooted = new Map<string, IFile>();
        for (const [name, file] of content) {
          if (name !== "package.json") {
            rooted.set(`package/${name}`, file);
          }
        }
        rooted.set("package/package.json", MemoryFile.from(manifestJson));
        return packToTarball(new FileSet(rooted)).then(tgz => {
          const files = new Map<string, IFile>([
            [tarballBasename(identity.name, identity.version), new MemoryFile(tgz)],
            ["package.json", MemoryFile.from(manifestJson)],
          ]);
          /* provides = the package name (what a co-member's dependsOn references). */
          return new PublishableFileSet(files, member.destination, identity.name, memberDependencies(manifest, memberNames));
        });
      });
    });
  }

  /**
   * Upload a packaged artifact to this registry (the one side effect): reads the
   * sidecar manifest, hashes the tarball for `dist.integrity`/`shasum`, builds
   * the `libnpmpublish` packument envelope, and PUTs it to the escaped package
   * name; a 409 (version already present) is the already-synced status. Pure
   * upload mechanics — release orchestration (ordering, skipping) is the generic
   * layer's. The credential is resolved here — the repository owns its own
   * authentication — from the environment or the per-registry `.npmrc`.
   */
  public publish(artifact: PublishableFileSet): Computable<PublishStatus> {
    const identity = this.coordinateIdentity(artifact.destination.name);
    const { name, version } = identity;
    const tgzFile = artifact.get(tarballBasename(name, version));
    const manifestFile = artifact.get("package.json");
    return Computable.forAll([tgzFile, manifestFile, this.npmAuth()], (tgz, manifest, auth) => {
      if (!tgz || !manifest) {
        throw new Error(`internal error: publish artifact for ${name}@${version} is missing its tarball or manifest`);
      }
      return Computable.forAll([tgz.getBuffer(), manifest.readString()], (data, manifestJson) => ({ data, manifestJson, auth }));
    }).then(({ data, manifestJson, auth }) =>
      publishToRegistry(
        this.url,
        identity,
        data,
        JSON.parse(manifestJson),
        auth.getHeadersFor(this.url),
        this.access,
        auth.otpProvider(this.url, this.context.execution.interaction)
      )
    );
  }

  /**
   * Phase 1 — resolve a batch of references jointly (one minimal-version-selection
   * over all root requirements, so shared packages agree on a version and user
   * overrides dominate per max-of-minimums) WITHOUT fetching. Returns the
   * selection tree; `materialize` fetches a subset of it on demand.
   *
   * Under `files` the consumer wants each package's own files standalone — no
   * closure, no joint resolution — so resolution is a no-op that just records the
   * root names (fetch happens per-reference in materialize). This is what lets
   * `fabr cat @npm:pkg:ver:file` succeed when the closure is unresolvable here.
   *
   * Only semver versions/ranges are accepted: dist-tags (e.g. 'latest') are
   * mutable pointers and would make the build non-deterministic, so they are
   * deliberately not supported — every document we fetch is immutable, cacheable
   * indefinitely with no refresh policy.
   */
  public resolve(references: RepositoryRef[]): Computable<Resolution> {
    /* The operation is a property of this collection point, read from the context
     * (this instance is interned per BuildContext, so it reflects the config these
     * references were consumed under). */
    return this.context.getGlobalString(BUILD_OPERATION).then(operation => {
      const requirements = references.map(reference => {
        try {
          return this.parseRequirement(reference.name);
        } catch (err) {
          throw new RequirementResolutionError([reference], toError(err));
        }
      });
      const roots: ResolvedRoot[] = references.map((reference, index) => ({ reference, name: requirements[index].pkg }));
      if (operation === FILES_OPERATION) {
        return Computable.resolve<NpmResolution>({
          roots,
          operation,
          selections: [],
          rootIndex: new Map(),
          violations: [],
          raises: [],
          splits: [],
        });
      }
      /* Canonicalize the roots so the resolution (and its memo key, and the
       * reachableFrom indices) are independent of reference order */
      const byKey = new Map(requirements.map(req => [requirementKey(req), req]));
      const rootKeys = [...byKey.keys()].sort();
      const rootReqs = rootKeys.map(key => byKey.get(key)!);
      const rootIndex = new Map(rootKeys.map((key, index) => [key, index]));
      return this.getJointResolution(rootReqs, rootKeys)
        .then(repairs => ({ roots, operation, rootIndex, ...repairs }) satisfies NpmResolution)
        .catch(err => this.attributeResolutionFailure(err, references, requirements));
    });
  }

  /**
   * Phase 2 — fetch + assemble the requested references (a subset of `resolution`).
   * Only the closure reachable from the requested roots is fetched, from the
   * pre-resolved tree — so a subset materialization keeps the joint pin. The
   * operation (captured in the resolution) decides the shape: run → each root
   * becomes a runnable, otherwise the plain packages.
   *
   * Enforcement of resolution repairs happens here, per delivery: a
   * **permissive** delivery (`options.resolutionMode`, or run — a runnable is
   * a sealed install by invariant) accepts the repaired closure, additionally
   * fetching the split subtrees repairing the reachable violations and
   * computing the dependency-edge table the nested assembly needs; a strict
   * (linked) delivery with any repair in its reachable closure fails with the
   * repairs and their remedies.
   */
  public materialize(references: RepositoryRef[], resolution: Resolution, options?: MaterializeOptions): Computable<FileSet[]> {
    const resolved = resolution as NpmResolution;
    if (resolved.operation === FILES_OPERATION) {
      return Computable.forAll(
        references.map(reference => attributedTo(reference, () => this.resolveBarePackage(reference))),
        (...delivered: FileSet[]) => delivered
      );
    }
    const { selections, rootIndex, operation, violations, raises, splits } = resolved;
    const permissive = options?.resolutionMode === "permissive" || operation === "run";
    const requirements = references.map(reference => this.parseRequirement(reference.name));
    const requestedRoots = new Set(requirements.map(req => rootIndex.get(requirementKey(req))!));
    const requestedKeys = new Set(requirements.map(requirementKey));
    /* The selections reachable from the requested roots — the fetch set. */
    const needed = selections.filter(sel => sel.reachableFrom?.some(root => requestedRoots.has(root)));
    const reachableIds = new Set(needed.map(selectionId));
    /* A violation is a property of an *edge*: in scope iff its requirer is in
     * the delivered closure (a root-requirement violation: iff that root is
     * among the requested). A raise is a property of a *selection* — its
     * demander may be a superseded node kept for attribution — so it is in
     * scope iff the raised version itself is being delivered. */
    const edgeInScope = (requiredBy: string, pkg: string, constraint: string): boolean =>
      requiredBy === ROOT_REQUIRER ? requestedKeys.has(`${pkg}:${constraint}`) : reachableIds.has(requiredBy);
    const scopedViolations = violations.filter(violation => edgeInScope(violation.requiredBy, violation.pkg, violation.constraint));
    const scopedRaises = raises.filter(raise =>
      needed.some(sel => sel.pkg === raise.pkg && compareVersions(sel.version, raise.raised) === 0)
    );
    if (!permissive) {
      const duplicates = coexistingVersions(needed);
      if (scopedViolations.length > 0 || scopedRaises.length > 0 || duplicates.length > 0) {
        throw strictRepairError([...requestedKeys].sort().join(", "), scopedViolations, scopedRaises, duplicates);
      }
    }
    /* Sealed: include the splits repairing the reachable violations, and the
     * splits repairing theirs, recursively. */
    const includedSplits = permissive ? reachableSplits(scopedViolations, splits) : [];
    /* Fetch each distinct pkg@version once — main tree and splits share
     * instances (same version ⇒ same tarball ⇒ same content). */
    const toFetch = new Map<string, Selected<SemverVersion>>();
    for (const sel of [...needed, ...includedSplits.flatMap(split => split.selections)]) {
      const id = selectionId(sel);
      if (!toFetch.has(id)) {
        toFetch.set(id, sel);
      }
    }
    const fetchIds = [...toFetch.keys()];
    const fetching = new Set(fetchIds);
    /* Plan the layout first: it is decided by the resolution alone, so a
     * closure that cannot be laid out says so before anything is downloaded. */
    const edges = permissive
      ? this.resolvedEdges(needed, selections, scopedViolations, includedSplits)
      : Computable.resolve<EdgeMap | undefined>(undefined);
    return edges
      .then(edgeMap =>
        requirements.map(req =>
          this.planClosure(req, rootIndex.get(requirementKey(req))!, selections, fetching, includedSplits, edgeMap)
        )
      )
      .then(plans =>
        Computable.forAll(
          fetchIds.map(id => this.fetch(toFetch.get(id)!.pkg, toFetch.get(id)!.version)),
          (...fetched: PackageFileSet[]) => {
            const packages = new Map<string, PackageFileSet>(fetchIds.map((id, k) => [id, fetched[k]]));
            const assembled = requirements.map((req, index) => this.buildClosure(req, plans[index], selections, packages));
            return operation === "run"
              ? Computable.forAll(
                  assembled.map(pkg => this.makeRunnable(pkg)),
                  (...delivered: FileSet[]) => delivered
                )
              : Computable.resolve(assembled);
          }
        )
      )
      .catch(err => this.attributeResolutionFailure(err, references, requirements));
  }

  /**
   * The resolved dependency edges of a permissive delivery — transient
   * planning data, never carried on the delivered values: for every fetched
   * node (main tree and splits), each declared requirement resolved to the id
   * satisfying it — a violated edge to its split's root, an ordinary edge to
   * its scope's selection under the requirement's resolution key, an
   * unconstrained edge to the scope's highest selection. Requirements come
   * from the (cached) per-version metadata, gated exactly as during the walk.
   * The main scope is computed first and wins a shared version's entries (a
   * version shared between scopes keeps the main tree's choices — either
   * choice satisfies the declared range, since surviving edges are never
   * violations).
   */
  private resolvedEdges(
    needed: Selected<SemverVersion>[],
    mainSelections: Selected<SemverVersion>[],
    mainViolations: Violation<SemverVersion>[],
    includedSplits: NpmSplit[]
  ): Computable<EdgeMap> {
    const splitRootId = new Map<string, string>();
    for (const split of includedSplits) {
      const root = split.selections.find(sel => sel.pkg === split.pkg);
      if (root) {
        splitRootId.set(`${split.pkg}:${split.constraint}`, selectionId(root));
      }
    }
    const scopes = [
      { nodes: needed, selections: mainSelections, violations: mainViolations },
      ...includedSplits.map(split => ({ nodes: split.selections, selections: split.selections, violations: split.violations })),
    ];
    const jobs = scopes.flatMap(scope =>
      scope.nodes.map(node => this.getRequirements(node.pkg, node.version).then(reqs => ({ scope, node, reqs })))
    );
    return Computable.forAll(jobs, (...entries) => {
      const edges: EdgeMap = new Map();
      for (const { scope, node, reqs } of entries) {
        const fromId = selectionId(node);
        let from = edges.get(fromId);
        if (!from) {
          from = new Map();
          edges.set(fromId, from);
        }
        for (const req of reqs) {
          if (from.has(req.pkg)) {
            continue; /* main scope came first and wins */
          }
          const violated = scope.violations.some(
            violation => violation.requiredBy === fromId && violation.pkg === req.pkg && violation.constraint === req.constraint
          );
          const toId = violated
            ? splitRootId.get(`${req.pkg}:${req.constraint}`)
            : edgeTargetIn(scope.selections, req);
          if (toId) {
            from.set(req.pkg, toId);
          }
        }
      }
      return edges;
    });
  }

  /**
   * Attribute a batch resolution failure to the written reference(s) whose
   * requirement pulled it in, via the root package each failure names — a
   * MetadataFetchError's first-reacher chain, or each of a ResolutionWalkError's
   * per-error roots. The refs' carried provenance lets the driver point at the
   * requirement as written.
   */
  private attributeResolutionFailure(err: unknown, references: RepositoryRef[], requirements: Requirement[]): never {
    const culpableFor = (rootPkg: string): RepositoryRef[] => references.filter((_, index) => requirements[index].pkg === rootPkg);
    if (err instanceof MetadataFetchError) {
      const culpable = culpableFor(err.rootPkg);
      if (culpable.length > 0) {
        throw new RequirementResolutionError(culpable, err);
      }
    }
    if (err instanceof ResolutionWalkError) {
      /* Each walk failure attributes independently (they may sit under
       * different roots); one without a matching written reference reports
       * plain. MultiError unwraps a sole failure. */
      throw MultiError.of(
        err.failures.map(failure => {
          const culpable = culpableFor(failure.rootPkg);
          const cause = new Error(failure.message);
          return culpable.length > 0 ? new RequirementResolutionError(culpable, cause) : cause;
        })
      );
    }
    throw toError(err);
  }


  /**
   * Make an already-resolved npm package launchable, keeping the exact closure
   * it carries (no re-resolution). Shared by this repository's own `run`
   * delivery and by a catalog delegating a jointly-pinned member.
   */
  public makeRunnable(pkg: PackageFileSet): Computable<RunnableFileSet> {
    return makeNpmRunnable(pkg);
  }

  /**
   * Plan one root requirement's delivered tree — which node mounts where, as
   * ids. A statement about the resolution only: it reads no content, so it
   * settles before anything is fetched, and a closure with no valid layout is
   * reported without downloading the closure it can't lay out.
   *
   * **Strict** (no edge map): the reachable members of the joint closure, flat
   * — enforcement has already guaranteed one version per name, so flat
   * mounting needs no more.
   *
   * **Permissive**: the closure's flat-mount WINNERS (one per name — the root
   * wins its own name, else the highest version) plus the private version
   * overrides {@link planMounts} nests under them.
   */
  private planClosure(
    req: Requirement,
    index: number,
    selections: Selected<SemverVersion>[],
    fetching: ReadonlySet<string>,
    includedSplits: NpmSplit[],
    edges: EdgeMap | undefined
  ): PlannedClosure {
    const reachable = selections.filter(sel => sel.reachableFrom?.includes(index));
    const root = reachable.find(sel => sel.pkg === req.pkg);
    if (!root) {
      /* Can't happen: a root requirement is always reachable from itself */
      throw new Error(`Resolution of ${requirementKey(req)} does not contain its own root package`);
    }
    const rootId = selectionId(root);
    if (edges === undefined) {
      const flat = reachable.map(selectionId).filter(id => id !== rootId && fetching.has(id));
      return { rootId, mounts: flat.map(id => ({ id, overrides: [] })) };
    }
    /* Closure members (main tree + splits) and their flat-mount winners. */
    const members = new Map<string, Selected<SemverVersion>>();
    for (const sel of [...reachable, ...includedSplits.flatMap(split => split.selections)]) {
      const id = selectionId(sel);
      if (fetching.has(id) && !members.has(id)) {
        members.set(id, sel);
      }
    }
    const winners = new Map<string, string>();
    winners.set(root.pkg, rootId);
    for (const [id, sel] of members) {
      const current = winners.get(sel.pkg);
      if (current === undefined) {
        winners.set(sel.pkg, id);
      } else if (current !== rootId && current !== id) {
        const currentSel = members.get(current);
        if (currentSel && SEMVER.compare(sel.version, currentSel.version) > 0) {
          winners.set(sel.pkg, id);
        }
      }
    }
    return { rootId, mounts: planMounts(rootId, winners, edges, new Set(members.keys())) };
  }

  /** Realise a planned closure against the fetched packages, stamped with the
   * resolution's provenance. */
  private buildClosure(req: Requirement, plan: PlannedClosure, selections: Selected<SemverVersion>[], packages: Map<string, PackageFileSet>): PackageFileSet {
    const origin: IResolutionOrigin<SemverVersion> = {
      kind: PACKAGE_RESOLUTION_PROVENANCE,
      repository: this.url,
      root: req,
      selections,
      versionToString,
      packageOfPath: npmPackageOfPath,
    };
    const rootFiles = packages.get(plan.rootId)!;
    const dependencies = buildMounts(plan.mounts, packages, origin);
    return new PackageFileSet(rootFiles, rootFiles.packageName, rootFiles.version, dependencies, origin);
  }

  /**
   * Deliver a single package's own files, resolved standalone — the `files`
   * operation's delivery (see resolve). A top-level root's minimal-version
   * selection is simply its constraint's lower bound (nothing else constrains
   * it), so this is exactly the version the joint path would give the root, but
   * reached without walking — or fetching — the dependency closure. The result
   * is a bare PackageFileSet (no carried dependencies); any projection is
   * applied afterwards by the collection point (RepositoryRef.finishMaterialize).
   */
  private resolveBarePackage(reference: RepositoryRef): Computable<FileSet> {
    const req = this.parseRequirement(reference.name);
    const constraint = SEMVER.parseConstraint(req.constraint);
    if (SEMVER.isUnconstrained(constraint)) {
      throw new Error(
        `Cannot resolve the files of '${req.pkg}' from an unconstrained version ('${req.constraint}'): ` +
          "pin a version or range to project into a package"
      );
    }
    const version = SEMVER.minimumOf(constraint);
    const edge: IRequirementEdge = { requiredBy: ROOT_REQUIRER, constraint: req.constraint };
    const selection: Selected<SemverVersion> = { pkg: req.pkg, version, selectedBy: edge, reachedVia: edge, reachableFrom: [0] };
    const origin: IResolutionOrigin<SemverVersion> = {
      kind: PACKAGE_RESOLUTION_PROVENANCE,
      repository: this.url,
      root: req,
      selections: [selection],
      versionToString,
      packageOfPath: npmPackageOfPath,
    };
    return this.fetch(req.pkg, version)
      .then(pkg => new PackageFileSet(pkg, pkg.packageName, pkg.version, [], origin))
      .catch(err => {
        /* The written minimum was never published. The joint (build/test) path
         * would floor-raise here; the standalone files path stays exact by
         * design, but the error should name the raise the build would take. */
        if (err instanceof VersionNotFoundError) {
          return this.lowestAvailable(req.pkg, req.constraint).then(raised => {
            throw raised
              ? attachHelp(
                  err,
                  `the lowest published version satisfying '${req.constraint}' is ${versionToString(raised)} — ` +
                    `pin '${req.pkg}:${versionToString(raised)}' (a build resolves this automatically via a floor raise)`
                )
              : err;
          });
        }
        throw err;
      });
  }

  /** The requirement a reference declares, read straight off its own `name:version`
   *  (a manifest records the declared constraint). Undefined for a versionless ref. */
  public declaredRequirement(ref: RepositoryRef): Computable<Requirement | undefined> {
    const split = splitNameVersion(ref.name);
    return Computable.resolve(split ? { pkg: split.identifier, constraint: split.version } : undefined);
  }

  private parseRequirement(name: Name): Requirement {
    const split = splitNameVersion(name);
    if (!split) {
      throw new Error(
        `Missing version in package reference '${name.getLiteralPathPrefix()}' (expected '<name>:<version-or-range>')`
      );
    }
    const { identifier: pkg, version: constraint } = split;
    if (!isSemverConstraint(constraint)) {
      throw attachHelp(
        new Error(`'${constraint}' is not a valid version constraint for '${pkg}'`),
        "dist-tags such as 'latest' are not supported: pin a version or range instead"
      );
    }
    return { pkg, constraint };
  }

  /**
   * The platform we are building for, projected to npm's {os, cpu, libc}
   * vocabulary — read off the TARGET property (a clang/LLVM triple; `default
   * TARGET = ${HOST}`) via the same property surface every rule sees, then run
   * through core's lossy `tripleToNpm`. Native selection consumes the triple
   * verbatim; this projection is only what the npm os/cpu/libc gate matches on.
   */
  private targetPlatform(): Computable<NpmPlatform> {
    return this.context.getGlobalString(TARGET).then(triple => tripleToNpm(triple));
  }

  /**
   * PackageRegistry implementation: the requirements of pkg@version are its
   * declared `dependencies` and (non-optional) `peerDependencies`, plus the
   * `optionalDependencies` that are installable on the target. The dominant use
   * of the latter is os/cpu-gated native binaries (esbuild's @esbuild/<platform>
   * engine): all variants are listed, and only the target-matching one(s) are
   * kept. Peers are **soft** (attach-first) requirements:
   * satisfied by any selection in range whatever its resolution key — a wide
   * multi-major peer range must not spawn its floor as a coexisting major —
   * demanding their minimum only when the converged tree selects nothing for
   * the package. "Shared, one instance" holds by construction in a strict
   * closure (one version per name, flat mount) — the peer/regular distinction
   * only exists to work around duplicate-tolerant regular deps, which fabr
   * doesn't have. A violated peer surfaces as an ordinary violation (strict error, or
   * a sealed-tool split — npm's --legacy-peer-deps posture). An
   * `optional: true` peer ("if present, must match") is never auto-installed,
   * npm parity; devDependencies stay ignored.
   */
  public getRequirements(pkg: string, version: SemverVersion): Computable<Requirement[]> {
    return this.getVersionMetadata(pkg, versionToString(version)).then(meta => {
      /* npm's rule: an entry in optionalDependencies overrides the same name in
       * dependencies, so a dep listed in both is optional (os/cpu-gated, dropped
       * if the target doesn't match). @parcel/watcher lists its per-platform native
       * binaries in both — treating them as required would reject the ones for
       * other platforms as EBADPLATFORM. */
      const optionalDeps = dependencyBlock(meta.optionalDependencies);
      const optionalPeerNames = optionalPeers(meta.peerDependenciesMeta);
      const peers = [...dependencyBlock(meta.peerDependencies)]
        .filter(([dep]) => !optionalPeerNames.has(dep) && !optionalDeps.has(dep))
        .map(([dep, constraint]) => ({ pkg: dep, constraint, soft: true }));
      const required = [
        ...[...dependencyBlock(meta.dependencies)]
          .filter(([dep]) => !optionalDeps.has(dep))
          .map(([dep, constraint]) => ({ pkg: dep, constraint })),
        ...peers,
      ];
      const optional = [...optionalDeps].map(([dep, constraint]) => ({ pkg: dep, constraint }));
      if (optional.length === 0) {
        return Computable.resolve(required);
      }
      /* The os/cpu gate is declared in the *dependency's* own metadata, so each
       * candidate must be probed. The match is version-stable (a package's target
       * platform doesn't change across releases), so probing the constraint's
       * minimum decides correctly whatever version selection ultimately picks. */
      return this.targetPlatform().then(target =>
        Computable.forAll(
          optional.map(req => this.keepIfTargetMatches(req, target)),
          (...kept) => [...required, ...kept.filter((req): req is Requirement => req !== undefined)]
        )
      );
    });
  }

  /**
   * The floor-raise hook (see PackageRegistry): the lowest *published* version
   * of `pkg` satisfying `constraint`, consulted only when the constraint's own
   * minimum turned out unpublished. Reads the **packument** — the registry's
   * mutable per-package version list — through the mutable-fetch TTL cache
   * (origin-derived freshness, revalidated when stale, never frozen); if the
   * cached list satisfies nothing, that is evidence it may be stale, so it is
   * force-revalidated once before giving up. Deterministic modulo registry
   * append — the one sanctioned relaxation, confined to this repair path.
   *
   * A package the registry has never heard of (a typo'd name) has no published
   * versions at all, which is a definite answer rather than a stale one: it
   * skips the revalidation and reports no raise, leaving the caller's original
   * "not found" the failure the resolver reports.
   */
  public lowestAvailable(pkg: string, constraint: string): Computable<SemverVersion | undefined> {
    let parsed: SemverConstraint;
    try {
      parsed = SEMVER.parseConstraint(constraint);
    } catch {
      return Computable.resolve(undefined);
    }
    /* npm-consistent candidates: no prerelease unless the constraint opts in
     * (lowestSatisfying) — the raise must never silently pin an -rc. */
    const pick = (versions: SemverVersion[] | undefined): SemverVersion | undefined =>
      versions && lowestSatisfying(versions, parsed);
    return this.publishedVersions(pkg, false).then(versions => {
      const found = pick(versions);
      if (found || versions === undefined) {
        return Computable.resolve<SemverVersion | undefined>(found);
      }
      return this.publishedVersions(pkg, true).then(pick);
    });
  }

  /** The package's published version list, from its packument (a mutable
   * pointer document — fetched with a freshness lifetime, not frozen), or
   * undefined if the registry has no such package (its 404 for the packument —
   * the package-level counterpart of getVersionMetadata's VersionNotFoundError,
   * and no more an error here than an empty list would be). Unparseable version
   * strings are skipped. */
  private publishedVersions(pkg: string, forceRevalidate: boolean): Computable<SemverVersion[] | undefined> {
    const url = `${this.url}/${packagePath(pkg)}`;
    return this.authHeadersFor(url)
      .then(headers =>
        this.context.fetch(
          url,
          "npm:packument:1",
          content =>
            readStream(content).then(data => {
              /* The reader throws on anything unusable, so an invalid document
               * is never cached. */
              const versions = parseJson(data, `package document for ${pkg} from ${this.url}`, toPublishedVersions);
              return new FileSet(new Map([[VERSIONS_FILE, MemoryFile.from(JSON.stringify(versions))]]));
            }),
          "version list",
          headers,
          forceRevalidate ? { immutable: false, forceRevalidate: true } : { immutable: false }
        )
      )
      .then(files => files.readFile(VERSIONS_FILE))
      .then(
        data =>
          (JSON.parse(data) as string[]).flatMap(text => {
            try {
              return [parseVersion(text)];
            } catch {
              return [];
            }
          }),
        err => {
          if (err instanceof HttpStatusError && err.statusCode === 404) {
            return undefined;
          }
          throw err;
        }
      );
  }

  /**
   * Probe an optional dependency's os/cpu/libc gates, returning it as a requirement
   * only if the target satisfies them (else undefined). A candidate that can't be
   * probed — unparseable pin, no version to probe, or an unreachable/unpublished
   * metadata document — is dropped non-fatally, per npm's optional-dependency
   * contract (a genuinely-needed absence surfaces at the consumer's own runtime
   * check, e.g. esbuild's "missing platform binary" error). A future refinement:
   * a matched-but-unfetchable probe deserves a diagnostic once the progress layer
   * carries warnings; a plain platform mismatch stays silent.
   */
  private keepIfTargetMatches(req: Requirement, target: NpmPlatform): Computable<Requirement | undefined> {
    let probeVersion: string;
    try {
      const constraint = SEMVER.parseConstraint(req.constraint);
      if (SEMVER.isUnconstrained(constraint)) {
        return Computable.resolve(undefined);
      }
      probeVersion = versionToString(SEMVER.minimumOf(constraint));
    } catch {
      return Computable.resolve(undefined);
    }
    /* Catch rather than a rejection handler: a probe that cannot be evaluated
     * (malformed gates in a fetched document) is as non-fatal as one that could
     * not be fetched, and a handler passed to then() does not see the success
     * callback's own throw. */
    return this.getVersionMetadata(req.pkg, probeVersion)
      .then(meta => (matchesTargetPlatform(meta, target) ? req : undefined))
      .catch(() => undefined);
  }

  /**
   * Resolutions are persisted in the build cache: under minimal version selection
   * the result is a pure function of the (canonically ordered) root requirements
   * and the (immutable) declared metadata of the packages they reach, so a cached
   * resolution can only become wrong if a requirement itself changes — which
   * changes the cache key. (The one exception is a floor raise, which consults
   * the mutable version list — deterministic modulo registry append, and only on
   * the repair path.) Failed resolutions are not cached (the error propagates
   * before anything is written), so transient repository problems don't poison
   * the cache. Repairs (violations, raises, splits) are recorded in the doc as
   * data — enforcement is per delivery, at materialize.
   */
  private getJointResolution(roots: Requirement[], rootKeys: string[]): Computable<ResolvedRepairs> {
    /* The resolution depends on the target platform (it filters os/cpu/libc-gated
     * optional deps), so the memo key must carry it — otherwise a resolution
     * computed for one target would be served for another. */
    return this.targetPlatform().then(target => {
      const targetKey = `${target.os ?? "?"}-${target.cpu ?? "?"}-${target.libc ?? "?"}`;
      return this.context
        /* Newline-join the roots: a semver constraint may contain spaces (a quoted
         * hyphen range, `1.2.3 - 2.3.4`), so a space delimiter isn't obviously
         * injective — a newline can appear in neither a package name nor a
         * constraint, matching how file deps are already newline-separated. */
        .memoize("npm:resolve:11", `${this.url} ${targetKey}\n${rootKeys.join("\n")}`, () => {
          /* A memo miss means real resolution work on behalf of the consumer */
          this.context.notifyProgress({ kind: "repository-resolve", repository: this.context.target, requirements: rootKeys });
          return resolveWithRepairs(roots, SEMVER, this).then(result => {
            /* Hard errors (unparseable constraints, unconstrained-only
             * requirements) on any tree are not repairable in any mode. */
            const errors = [...result.tree.errors, ...result.splits.flatMap(split => split.tree.errors)];
            if (errors.length > 0) {
              /* Typed + per-error root attribution, so the resolve() catch can
               * map each failure to the written reference(s) that pulled its
               * subtree in, instead of blaming the whole collection point. */
              throw new ResolutionWalkError(errors);
            }
            return this.verifiedResolutionDoc(roots, result, target);
          });
        })
        .then(files => files.readFile(RESOLUTION_FILE))
        .then(data => deserializeResolutionDoc(JSON.parse(data) as IResolutionDoc));
    });
  }

  /**
   * Validate the resolved closure against the target platform, then serialize it.
   * Optional deps were already filtered to the target, so any os/cpu/libc mismatch
   * remaining is a *non-optional* dependency (or a direct requirement) on a
   * package for another platform — npm's EBADPLATFORM — and is an error rather
   * than an unusable install. Each selection's metadata was fetched during the
   * resolution walk, so these are cache hits. (Override TARGET with -D to resolve
   * for a different platform.)
   */
  private verifiedResolutionDoc(
    roots: Requirement[],
    result: RepairableResolution<SemverVersion>,
    target: NpmPlatform
  ): Computable<FileSet> {
    /* The platform gate stays hard in every mode — a package for another
     * platform can't run, sealed or not — and covers split subtrees too. */
    const allSelections = [...result.tree.selections, ...result.splits.flatMap(split => split.tree.selections)];
    return Computable.forAll(
      allSelections.map(sel => this.getVersionMetadata(sel.pkg, versionToString(sel.version)).then(meta => ({ sel, meta }))),
      (...entries) => {
        for (const { sel, meta } of entries) {
          const reason = unsupportedPlatformReason(meta, target);
          if (reason) {
            throw new Error(
              `${sel.pkg}@${versionToString(sel.version)} is not supported for the target platform (${reason}), ` +
                `required by ${sel.reachedVia?.requiredBy ?? "a direct requirement"}`
            );
          }
        }
        const doc: IResolutionDoc = {
          roots,
          selections: result.tree.selections.map(serializeSelection),
          violations: result.tree.violations.map(serializeViolation),
          raises: result.tree.raises.map(serializeRaise),
          splits: result.splits.map(split => ({
            pkg: split.pkg,
            constraint: split.constraint,
            selections: split.tree.selections.map(serializeSelection),
            violations: split.tree.violations.map(serializeViolation),
            raises: split.tree.raises.map(serializeRaise),
          })),
        };
        return new FileSet(new Map([[RESOLUTION_FILE, MemoryFile.from(JSON.stringify(doc, undefined, 2))]]));
      }
    );
  }

  /**
   * Fetch the metadata document for an exact package version, persisted in the
   * build cache and never refreshed. Note the immutability here is a *content*
   * contract fabr asserts, not an HTTP one: npmjs serves version docs with only
   * `max-age=300` (unlike tarballs, which it marks `cache-control: immutable`
   * for a year), because a version doc has exactly one mutable field —
   * `deprecated`. The dependency-relevant fields can never change (a version
   * number is never republished), and fabr reads nothing else; if deprecation
   * warnings are ever surfaced, that read must go through the non-immutable
   * fetch path (like the packument), not this cache-forever one.
   */
  private getVersionMetadata(pkg: string, version: string): Computable<INPMPackageMetadata> {
    const key = pkg + "/" + version;
    let result = this.metadataCache.get(key);
    if (!result) {
      const metadataUrl = `${this.url}/${packagePath(pkg)}/${version}`;
      result = this.authHeadersFor(metadataUrl)
        .then(headers =>
          this.context.fetch(
            metadataUrl,
            "npm:metadata:1",
            content =>
              readStream(content).then(data => {
                const meta = parseMetadataResponse(data, key);
                return new FileSet(new Map([[METADATA_FILE, MemoryFile.from(JSON.stringify(meta))]]));
              }),
            "metadata",
            headers
          )
        )
        .then(files => files.readFile(METADATA_FILE))
        /* Re-validated on the way out, not asserted: the cache entry is the
         * document as fetched, so it is judged by the same reader whether it
         * arrives from the registry or from disk — one place decides what a
         * usable metadata document is. */
        .then(data => parseMetadataResponse(data, key))
        .catch(err => {
          /* Translate the registry's HTTP 404 into the fact it means — typed,
           * so the resolver can distinguish an unpublished version (raisable)
           * from an unreachable registry. */
          if (err instanceof HttpStatusError && err.statusCode === 404) {
            throw new VersionNotFoundError(pkg, version, `NPM package ${pkg}@${version} not found at ${this.url}`);
          }
          throw err;
        });
      this.metadataCache.set(key, result);
      /* Evict the memo on failure so a transient transport error (dropped
       * connection, timeout) is retried, not cached for the whole run. This is a
       * deliberate side-effect observer: `.catch` returns a *new*, discarded
       * computable — the returned `result` is unchanged and still rejects for
       * callers; only the map entry is dropped. It is attached *after* set() on
       * purpose — a synchronous rejection would otherwise run before set() and
       * evict nothing, leaving set() to cache the failure. */
      result.catch(() => this.metadataCache.delete(key));
    }
    return result;
  }

  private fetch(pkg: string, version: SemverVersion): Computable<PackageFileSet> {
    return this.getVersionMetadata(pkg, versionToString(version)).then(meta =>
      this.authHeadersFor(meta.dist.tarball)
        .then(headers =>
          this.context.fetch(
            meta.dist.tarball,
            "npm:tarball:1",
            (content, { createOutput }) => {
              /* Verify the tarball against the registry's promised digest as it
               * streams: a mismatch throws before the entry commits, so tampered
               * or truncated-but-valid content never enters the immutable cache. */
              const { hashing, verify } = verifyTarballStream(meta.dist, meta.dist.tarball);
              content.on("error", err => hashing.destroy(err instanceof Error ? err : new Error(String(err))));
              content.pipe(hashing);
              return unpackStream(hashing, createOutput).then(files => {
                verify();
                return stripArchiveRoot(files);
              });
            },
            "package",
            headers
          )
        )
        .then(files => new PackageFileSet(files, meta.name, meta.version))
    );
  }
}


function serializeSelection(sel: Selected<SemverVersion>): IResolutionEntry {
  return {
    pkg: sel.pkg,
    version: versionToString(sel.version),
    selectedBy: sel.selectedBy,
    reachedVia: sel.reachedVia,
    reachableFrom: sel.reachableFrom,
  };
}

function serializeViolation(violation: Violation<SemverVersion>): IViolationEntry {
  return { pkg: violation.pkg, constraint: violation.constraint, requiredBy: violation.requiredBy, selected: versionToString(violation.selected) };
}

function serializeRaise(raise: RaisedFloor<SemverVersion>): IRaiseEntry {
  return {
    pkg: raise.pkg,
    constraint: raise.constraint,
    declared: versionToString(raise.declared),
    raised: versionToString(raise.raised),
    requiredBy: raise.requiredBy,
  };
}

function deserializeSelection(entry: IResolutionEntry): Selected<SemverVersion> {
  return {
    pkg: entry.pkg,
    version: parseVersion(entry.version),
    selectedBy: entry.selectedBy,
    reachedVia: entry.reachedVia,
    reachableFrom: entry.reachableFrom,
  };
}

function deserializeViolation(entry: IViolationEntry): Violation<SemverVersion> {
  return { pkg: entry.pkg, constraint: entry.constraint, requiredBy: entry.requiredBy, selected: parseVersion(entry.selected) };
}

function deserializeRaise(entry: IRaiseEntry): RaisedFloor<SemverVersion> {
  return {
    pkg: entry.pkg,
    constraint: entry.constraint,
    declared: parseVersion(entry.declared),
    raised: parseVersion(entry.raised),
    requiredBy: entry.requiredBy,
  };
}

function deserializeResolutionDoc(doc: IResolutionDoc): ResolvedRepairs {
  return {
    selections: doc.selections.map(deserializeSelection),
    violations: (doc.violations ?? []).map(deserializeViolation),
    raises: (doc.raises ?? []).map(deserializeRaise),
    splits: (doc.splits ?? []).map(entry => ({
      pkg: entry.pkg,
      constraint: entry.constraint,
      selections: entry.selections.map(deserializeSelection),
      violations: entry.violations.map(deserializeViolation),
      raises: entry.raises.map(deserializeRaise),
    })),
  };
}

/** pkg → its selected versions, for the packages selected at more than one
 * version — representable only by a nested (sealed) install. */

/**
 * The strict (linked) delivery's judgment of a repaired closure: every repair
 * reachable from the requested roots, reported together — floor raises with
 * their pin remedy, violations and coexisting versions as the structural facts
 * they are — rather than one build-fail-pin iteration each.
 */
export function strictRepairError(
  root: string,
  violations: Violation<SemverVersion>[],
  raises: RaisedFloor<SemverVersion>[],
  duplicates: Array<[string, SemverVersion[]]>
): Error {
  const lines: string[] = [];
  for (const raise of raises) {
    lines.push(
      `${raise.pkg}@${versionToString(raise.declared)} (the floor of '${raise.constraint}', required by ${raise.requiredBy}) ` +
        `was never published; the lowest published satisfying version is ${versionToString(raise.raised)} — ` +
        `pin '@npm:${raise.pkg}:${versionToString(raise.raised)}' to accept it`
    );
  }
  for (const violation of violations) {
    lines.push(
      `${violation.pkg}@${versionToString(violation.selected)} does not satisfy '${violation.constraint}' ` +
        `required by ${violation.requiredBy} — jointly unsatisfiable with the other requirements on ${violation.pkg}`
    );
  }
  for (const [pkg, versions] of duplicates) {
    lines.push(
      `requires multiple versions of ${pkg} (${versions.map(versionToString).join(", ")}), ` +
        `which the flat package layout cannot represent`
    );
  }
  /* The complete-fix pin set, when one exists: raises are the only repair a
   * pin can fix (pins are floors — they cannot bring a selection back under a
   * violated upper bound, nor unify coexisting majors), so the set is offered
   * as the fix exactly when raises are the only repairs present. */
  const pins = raises.map(raise => `@npm:${raise.pkg}:${versionToString(raise.raised)}`).join(" ");
  const help =
    raises.length > 0 && violations.length === 0 && duplicates.length === 0
      ? `pinning ${pins} alongside the existing requirements makes this resolution repair-free`
      : "a sealed tool install (js_script deps, fabr run) accepts these by nesting; linked deps need the pins above";
  return attachHelp(new Error(`Unable to resolve ${root}:\n  ${lines.join("\n  ")}`), help);
}

function createRepository(context: RepositoryContext): Computable<NPMRepository> {
  return Computable.forAll(
    [context.getRequiredString("url"), context.getString("access")],
    (url, access) => new NPMRepository(url, context, toPublishAccess(access))
  );
}

export const npmRepositoryRegistration: RepositoryRegistration = { type: "npm_repository", provider: createRepository };
