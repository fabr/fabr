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
  ConflictError,
  allSanctioned,
  canonicalRequirements,
  completeRepairSet,
  conflictError,
  edgeBinding,
  EMPTY_FILESET,
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
  MVSResolution,
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
  readStream,
  Repository,
  RepositoryContext,
  RepositoryRef,
  RepositoryRegistration,
  Requirement,
  requirementKey,
  RequirementResolutionError,
  Resolution,
  ResolutionWalkError,
  ResolvedRoot,
  resolveMVS,
  ROOT_REQUIRER,
  satisfiedByAnySelection,
  splitOverrideMarker,
  SuggestSources,
  suggestSanctions,
  unrepairableError,
  writtenVersions,
  RefRenderer,
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
  dependencyRequirement,
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
  /** Fork index (see resolver Selected.fork); absent for the principal */
  fork?: number;
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

/** Serialized declared requirements of one selected node — the resolution's
 * edges as their packages declared them, which is all a layout needs (see
 * {@link MVSResolution.requirements}) */
interface IRequirementsEntry {
  node: string;
  requires: Requirement[];
}

/** Serialized form of a persisted joint resolution (memo tag npm:resolve:16 —
 * per-name principals with fork selections and `!`-coerced edges; the split
 * subtrees of earlier versions are gone, repairs being selections of the one
 * tree) */
interface IResolutionDoc {
  roots: Requirement[];
  selections: IResolutionEntry[];
  violations: IViolationEntry[];
  /** Edges a `!` force override coerced (data — never judged) */
  coerced?: IViolationEntry[];
  raises: IRaiseEntry[];
  requirements: IRequirementsEntry[];
}


/** A selection's `pkg@version` node id — the resolver's node-id form, also the
 * id space of the transient edge map a permissive delivery is planned from. */
function selectionId(sel: Selected<SemverVersion>): string {
  return nodeId(SEMVER, sel.pkg, sel.version);
}

/** The written form of an npm reference, for pasteable suggestions. */
const npmRef: RefRenderer = (pkg, versionText, marker) => `@npm:${pkg}:${versionText}${marker ?? ""}`;

/** One root's planned delivery: its own node, and the tree mounted under it. */
interface PlannedClosure {
  rootId: string;
  mounts: PlannedMount[];
}

/**
 * The flat (hoisted) mount per name the closure asks for: every name an edge
 * between members uses — a package's own name, or the alias its requirer knows
 * it by — bound to the member that wins it. The root wins its own name (its
 * entry path must resolve there); otherwise the highest version, with the rest
 * nested privately by {@link planMounts}.
 *
 * Two *different packages* claiming one name cannot both be hoisted, and one
 * of them would silently lose its imports, so that is a conflict rather than a
 * pick. It takes an alias to reach: ordinary edges name their own package.
 */
export function flatWinners(
  /** The delivery this is the layout of, whose own name it holds. Absent for a
   * whole materialize BATCH, which has no single root — see the merged winners
   * in materialize: the reference point for judging what must nest privately,
   * since the consumer merges the batch's deliveries into one node_modules. */
  root: { id: string; name: string } | undefined,
  members: Map<string, Selected<SemverVersion>>,
  edges: EdgeMap
): Map<string, string> {
  const rootName = root?.name;
  const winners = new Map<string, string>(root ? [[root.name, root.id]] : []);
  for (const [fromId, deps] of edges) {
    if (!members.has(fromId)) {
      continue;
    }
    for (const [name, toId] of deps) {
      const selection = members.get(toId);
      const current = winners.get(name);
      if (!selection || current === toId || name === rootName) {
        continue;
      }
      if (current === undefined) {
        winners.set(name, toId);
        continue;
      }
      const held = members.get(current)!;
      if (held.pkg !== selection.pkg) {
        throw aliasCollision(name, held, selection);
      }
      if (SEMVER.compare(selection.version, held.version) > 0) {
        winners.set(name, toId);
      }
    }
  }
  return winners;
}

/**
 * The flat winners over a whole materialize batch — one layout question asked
 * once, because the consumer's collection point merges every delivery of the
 * batch into ONE node_modules. It is the reference point a delivery judges its
 * members' private copies against ({@link planMounts}), never the mount list of
 * any one delivery: a delivery mounts only what its own root reaches.
 */
export function mergedWinners(members: Map<string, Selected<SemverVersion>>, edges: EdgeMap): Map<string, string> {
  return flatWinners(undefined, members, edges);
}

/** The diagnostic for two packages claiming one install name (see
 * {@link flatWinners}) — always an alias, since nothing else renames. */
function aliasCollision(name: string, held: Selected<SemverVersion>, claimed: Selected<SemverVersion>): Error {
  return attachHelp(
    new ConflictError(
      "packages",
      name,
      { detail: nodeId(SEMVER, held.pkg, held.version) },
      { detail: nodeId(SEMVER, claimed.pkg, claimed.version) }
    ),
    `'${name}' is a dependency alias (npm:…) for two different packages in one closure, which cannot both be installed ` +
      "under that name — pin one of the requirers to a version that does not alias it"
  );
}

/** The id of the selection a requirement binds to, by the resolver's own edge
 * rule (the principal when it satisfies, else the repairing fork); undefined
 * when the edge leads nowhere (a gated optional pruned from the walk, or an
 * unparseable constraint already reported). */
function edgeTargetIn(selections: Selected<SemverVersion>[], req: Requirement): string | undefined {
  const target = edgeBinding(SEMVER, selections, req);
  return target && selectionId(target);
}

/** The tree + repairs of a deserialized resolution document. */
interface ResolvedRepairs {
  readonly selections: Selected<SemverVersion>[];
  readonly violations: Violation<SemverVersion>[];
  /** Edges a `!` force override coerced (see resolver MVSResolution.coerced) */
  readonly coerced: Violation<SemverVersion>[];
  readonly raises: RaisedFloor<SemverVersion>[];
  readonly requirements: Map<string, Requirement[]>;
}

/**
 * npm's private {@link Resolution}: the joint version selection + reachable
 * tree, the repairs recorded while resolving it (violations, raises, and the
 * fork selections repairing the violations — judged per delivery at
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
  /**
   * The `?` sanctions written in this collection's references: pkg → the exact
   * versions whose forks a strict delivery may accept (nested). Judgment-time
   * data carried OUTSIDE the persisted doc (the resolution outcome does not
   * depend on it, so neither does the memo key).
   */
  readonly alternates: ReadonlyMap<string, ReadonlySet<string>>;
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
      /* Alternates (`?`) are judgment-time sanctions, not demands: they join
       * neither the roots (a catalog's member table must not see them) nor the
       * resolution memo (the outcome is unchanged by them) — they ride the
       * in-memory resolution to the strict gate. A package both forced and
       * alternated is contradictory. */
      const alternates = new Map<string, Set<string>>();
      for (const req of requirements) {
        if (req.override === "alternate") {
          const versions = alternates.get(req.pkg) ?? new Set();
          alternates.set(req.pkg, versions.add(req.constraint));
        }
      }
      const contradicted = requirements.find(req => req.override === "force" && alternates.has(req.pkg));
      if (contradicted) {
        const culpable = references.filter((_, index) => requirements[index].pkg === contradicted.pkg);
        throw new RequirementResolutionError(
          culpable,
          new Error(`'${contradicted.pkg}' is both forced ('!') and permitted as an alternate ('?') — pick one`)
        );
      }
      /* Two forces at different versions are equally contradictory — the
       * resolver would have to pick one silently. */
      const forcedAt = new Map<string, string>();
      for (const req of requirements) {
        if (req.override !== "force") {
          continue;
        }
        const existing = forcedAt.get(req.pkg);
        if (existing !== undefined && existing !== req.constraint) {
          const culpable = references.filter((_, index) => requirements[index].pkg === req.pkg);
          throw new RequirementResolutionError(
            culpable,
            new Error(`'${req.pkg}' is forced ('!') at two different versions (${existing}, ${req.constraint}) — pick one`)
          );
        }
        forcedAt.set(req.pkg, req.constraint);
      }
      const roots: ResolvedRoot[] = references.flatMap((reference, index) =>
        requirements[index].override === "alternate" ? [] : [{ reference, name: requirements[index].pkg }]
      );
      if (operation === FILES_OPERATION) {
        return Computable.resolve<NpmResolution>({
          roots,
          operation,
          selections: [],
          rootIndex: new Map(),
          violations: [],
          coerced: [],
          raises: [],
          requirements: new Map(),
          alternates,
        });
      }
      /* Canonicalize the roots so the resolution (and its memo key, and the
       * reachableFrom indices) are independent of reference order. Alternates
       * ARE included: attach-last means a `?` can supply a floorless-only
       * package's version, so it is part of the resolution's identity (its
       * key carries the marker). It still joins neither `roots` above (a
       * catalog's member table must not see it) nor a delivery (it mounts
       * nothing of its own). */
      const { roots: rootReqs, keys: rootKeys } = canonicalRequirements(requirements);
      const rootIndex = new Map<string, number>(rootKeys.map((key, index) => [key, index]));
      return this.getJointResolution(rootReqs, rootKeys)
        .then(repairs => ({ roots, operation, rootIndex, alternates, ...repairs }) satisfies NpmResolution)
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
   * a sealed install by invariant) accepts the repaired closure, whose fork
   * selections the layout nests privately under their requirers; a strict
   * (linked) delivery with any repair in its reachable closure fails with the
   * repairs and their remedies. A violation nothing in the resolution
   * satisfies has no repairing fork and fails in EVERY mode — no delivery can
   * honor the constraint.
   */
  public materialize(references: RepositoryRef[], resolution: Resolution, options?: MaterializeOptions): Computable<FileSet[]> {
    const resolved = resolution as NpmResolution;
    if (resolved.operation === FILES_OPERATION) {
      return Computable.forAll(
        references.map(reference => attributedTo(reference, () => this.resolveBarePackage(reference))),
        (...delivered: FileSet[]) => delivered
      );
    }
    const { selections, rootIndex, operation, violations, alternates } = resolved;
    const permissive = options?.resolutionMode === "permissive" || operation === "run";
    const requirements = references.map(reference => this.parseRequirement(reference.name));
    /* An alternate (`?`) reference demands nothing and delivers nothing of its
     * own — the sanctioned fork arrives nested inside the canonical closure. */
    const demanded = requirements.filter(req => req.override !== "alternate");
    const requestedRoots = new Set(demanded.map(req => rootIndex.get(requirementKey(req))!));
    const requestedKeys = new Set(demanded.map(requirementKey));
    /* The selections reachable from the requested roots — the fetch set.
     * Forks are reachable exactly through the violated edges bound to them,
     * so a strict subset whose closure has no violations carries no forks. */
    const needed = selections.filter(sel => sel.reachableFrom?.some(root => requestedRoots.has(root)));
    const reachableIds = new Set(needed.map(selectionId));
    /* A violation is a property of an *edge*: in scope iff its requirer is in
     * the delivered closure (a root-requirement violation: iff that root is
     * among the requested). Raises are NOT judged here in any mode: a raised
     * floor is the constraint's plain meaning when its literal minimum was
     * never published — the request was for the range, and the first published
     * version meeting it answers the request. Coerced edges are not judged
     * either — suppressing them is what their `!` said to do. */
    const edgeInScope = (requiredBy: string, pkg: string, constraint: string): boolean =>
      requiredBy === ROOT_REQUIRER ? requestedKeys.has(`${pkg}:${constraint}`) : reachableIds.has(requiredBy);
    const scopedViolations = violations.filter(violation => edgeInScope(violation.requiredBy, violation.pkg, violation.constraint));
    const root = [...requestedKeys].sort().join(", ");
    /* The sanction rule is a set comparison: every version of a package this
     * delivery ships must be explicitly written — as a `?`, or as an exact
     * unmarked pin (the catalog form). See resolver/Overrides. */
    const written = writtenVersions(SEMVER, alternates, demanded);
    /* Plan the layout first: it is decided by the resolution alone (no content,
     * and — since the resolution carries its own edges — no metadata), so a
     * closure that cannot be laid out says so before anything is downloaded.
     * The judgment lives inside the chain too: a failing delivery computes its
     * fix suggestions (registry reads) before rejecting. */
    return Computable.resolve(undefined)
      .then(() => {
        /* A violated edge with NO repairing fork — nothing published
         * satisfies it — cannot be accepted in ANY mode, so it is judged
         * first: the strict error's remedies would be false advice for it. */
        const unrepaired = scopedViolations.filter(violation => !satisfiedByAnySelection(SEMVER, selections, violation));
        if (unrepaired.length > 0) {
          throw unrepairableError(root, unrepaired, selections, versionToString, npmRef);
        }
        if (!permissive) {
          const outstanding = scopedViolations.filter(violation => !allSanctioned(SEMVER, needed, written, violation.pkg));
          const duplicates = coexistingVersions(needed).filter(([pkg]) => !allSanctioned(SEMVER, needed, written, pkg));
          if (outstanding.length > 0 || duplicates.length > 0) {
            return suggestSanctions(outstanding, resolved, needed, requirements, this.suggestSources()).then(suggestion => {
              throw conflictError(root, outstanding, duplicates, needed, versionToString, npmRef, written, suggestion);
            });
          }
        }
        return Computable.resolve(undefined);
      })
      .then(() => {
        /* Sealed (or fully sanctioned): the forks repairing the reachable
         * violations are already in `needed`, nested by the layout plan.
         * Fetch each distinct pkg@version once (an alias may bind two edges
         * to one version — same version ⇒ same tarball ⇒ same content). */
        const delivered = needed;
        const toFetch = new Map<string, Selected<SemverVersion>>();
        for (const sel of delivered) {
          const id = selectionId(sel);
          if (!toFetch.has(id)) {
            toFetch.set(id, sel);
          }
        }
        const fetchIds = [...toFetch.keys()];
        const fetching = new Set(fetchIds);
        const edges = this.resolvedEdges(delivered, resolved);
        /* The winners over the WHOLE batch, computed once: a delivery is planned
         * against its own root's reach (it must stand alone), but whether one of
         * its members needs a private copy is a question about the layout the
         * CONSUMER ends up with — it merges these deliveries into one
         * node_modules. Judged per delivery, a member whose root cannot see a
         * higher version of what it requires looks non-divergent and records
         * nothing, and the merge then silently hands it the higher one. */
        const merged = mergedWinners(toFetch, edges);
        const plans = requirements.map(req =>
          req.override === "alternate"
            ? undefined
            : this.planClosure(req, rootIndex.get(requirementKey(req))!, selections, fetching, edges, merged)
        );
        return Computable.forAll(
          fetchIds.map(id => this.fetch(toFetch.get(id)!.pkg, toFetch.get(id)!.version)),
          (...fetched: PackageFileSet[]) => {
            const packages = new Map<string, PackageFileSet>(fetchIds.map((id, k) => [id, fetched[k]]));
            const assembled = requirements.map((req, index) => {
              const plan = plans[index];
              return plan === undefined ? undefined : this.buildClosure(req, plan, selections, packages);
            });
            return operation === "run"
              ? Computable.forAll(
                  assembled.map(pkg => (pkg === undefined ? Computable.resolve<FileSet>(EMPTY_FILESET) : this.makeRunnable(pkg))),
                  (...launched: FileSet[]) => launched
                )
              : Computable.resolve(assembled.map(pkg => pkg ?? EMPTY_FILESET));
          }
        );
      })
      .catch(err => this.attributeResolutionFailure(err, references, requirements));
  }

  /**
   * The resolved dependency edges of the delivery — transient planning data,
   * never carried on the delivered values: for every fetched node, each
   * declared requirement resolved to the id of the selection it binds — the
   * principal when it satisfies the range, else the repairing fork (the
   * resolver's own edge rule, {@link edgeBinding}, so a layout cannot disagree
   * with the resolution it came from). Keyed by the name the *requirer* uses,
   * so an aliased dependency is an edge to the aliased package under the
   * alias.
   *
   * The requirements come from the resolution itself (the walk collected them
   * to compute reachability, and they are persisted with it), so the layout of
   * a cached resolution needs no metadata at all — the same edges the walk
   * followed, not a second reading of them.
   */
  private resolvedEdges(delivered: Selected<SemverVersion>[], resolved: ResolvedRepairs): EdgeMap {
    const edges: EdgeMap = new Map();
    for (const node of delivered) {
      const fromId = selectionId(node);
      let from = edges.get(fromId);
      if (!from) {
        from = new Map();
        edges.set(fromId, from);
      }
      for (const req of resolved.requirements.get(fromId) ?? []) {
        const name = req.alias ?? req.pkg;
        if (from.has(name)) {
          continue;
        }
        const toId = edgeTargetIn(resolved.selections, req);
        if (toId) {
          from.set(name, toId);
        }
      }
    }
    return edges;
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
       * plain. A failure's remedy (a pin suggestion) rides as its help.
       * MultiError unwraps a sole failure. */
      throw MultiError.of(
        err.failures.map(failure => {
          const culpable = culpableFor(failure.rootPkg);
          const cause = new Error(failure.message);
          const wrapped = culpable.length > 0 ? new RequirementResolutionError(culpable, cause) : cause;
          return failure.help ? attachHelp(wrapped, failure.help) : wrapped;
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
   * Plan one root requirement's delivered tree — which node mounts where,
   * under which name, as ids. A statement about the resolution only: it reads
   * no content, so it settles before anything is fetched, and a closure with
   * no valid layout is reported without downloading the closure it can't lay
   * out.
   *
   * Layout follows the closure's **edges**, not its selections: a package is
   * mounted under each name something in the closure asks for it by, which is
   * its own name for an ordinary requirement and the alias for an aliased one
   * — so an aliased package appears only where its requirer's imports look for
   * it, and a package nothing requires under its own name is not mounted under
   * it. Per name the flat-mount winner (the root wins its own name, else the
   * highest version — the principal, forks always sitting below it), plus the
   * private version overrides {@link planMounts} nests under them. A strict
   * delivery has already been checked for violations and coexisting versions,
   * so its winners are its whole closure and nothing nests; the two regimes
   * need no separate planner.
   */
  private planClosure(
    req: Requirement,
    index: number,
    selections: Selected<SemverVersion>[],
    fetching: ReadonlySet<string>,
    edges: EdgeMap,
    /** The whole batch's winners — see {@link mergedWinners}. */
    merged: Map<string, string>
  ): PlannedClosure {
    const reachable = selections.filter(sel => sel.reachableFrom?.includes(index));
    /* The delivered root is what the root requirement BINDS to — normally the
     * principal, but a violated root requirement is answered by its fork. */
    const root = edgeBinding(SEMVER, reachable, req);
    if (!root) {
      /* Can't happen: a root requirement is always reachable from itself */
      throw new Error(`Resolution of ${requirementKey(req)} does not contain its own root package`);
    }
    const rootId = selectionId(root);
    /* Closure members and their flat-mount winners; the mount walk from rootId
     * only follows edges, so a member no edge reaches is inert here. */
    const members = new Map<string, Selected<SemverVersion>>();
    for (const sel of reachable) {
      const id = selectionId(sel);
      if (fetching.has(id) && !members.has(id)) {
        members.set(id, sel);
      }
    }
    const winners = flatWinners({ id: rootId, name: root.pkg }, members, edges);
    return { rootId, mounts: planMounts(rootId, root.pkg, winners, edges, new Set(members.keys()), merged) };
  }

  /** Realise a planned closure against the fetched packages, stamped with the
   * resolution's provenance. The delivered root carries the fork flag on the
   * same terms as any mount below it: a requirement answered by a fork (an
   * exact pin of a sanctioned second version — the catalog form) delivers a
   * package that must not claim a flat slot wherever it is merged with the
   * principal, and only the resolution can say so (see
   * {@link PackageFileSet.isNestedOverride}). A root remains flat where it is
   * *directly* named — the assembler's roots always hold their own name. */
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
    const forkIds = new Set(selections.filter(sel => sel.fork !== undefined).map(selectionId));
    const dependencies = buildMounts(plan.mounts, packages, origin, forkIds);
    return new PackageFileSet(
      rootFiles,
      rootFiles.packageName,
      rootFiles.version,
      dependencies,
      origin,
      forkIds.has(plan.rootId)
    );
  }

  /**
   * Deliver a single package's own files, resolved standalone — the `files`
   * operation's delivery (see resolve). A top-level root's minimal-version
   * selection is simply its constraint's lower bound (nothing else constrains
   * it), so this is exactly the version the joint path would give the root, but
   * reached without walking — or fetching — the dependency closure. The result
   * is a bare PackageFileSet (no carried dependencies); any projection stays
   * pending on the delivered ref (RepositoryRef.deliveredAs), finished by the
   * driving context.
   */
  private resolveBarePackage(reference: RepositoryRef): Computable<FileSet> {
    const req = this.parseRequirement(reference.name);
    const constraint = SEMVER.parseConstraint(req.constraint);
    if (SEMVER.isFloorless(constraint)) {
      throw new Error(
        `Cannot resolve the files of '${req.pkg}' without a version lower bound ('${req.constraint}'): ` +
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
    const { identifier: pkg, version: written } = split;
    /* Override markers ride the version slot: a trailing '?' (permitted
     * alternate) or '!' (forced version). Exact versions only — a ranged
     * override would reintroduce registry-time nondeterminism. */
    const { text: constraint, override } = splitOverrideMarker(written);
    if (override !== undefined) {
      if (SEMVER.exactVersion?.(constraint) === undefined) {
        throw attachHelp(
          new Error(`'${written}' is not a valid override for '${pkg}': the '${written.at(-1)}' marker needs an exact version`),
          "markers sanction one concrete version: '@npm:pkg:1.4.2?' permits a nested alternate, '@npm:pkg:2.0.0!' forces the version"
        );
      }
      return { pkg, constraint, override };
    }
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
   * a sealed-tool fork — npm's --legacy-peer-deps posture). An
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
        .map(([dep, spec]) => ({ ...dependencyRequirement(dep, spec), soft: true }));
      const required = [
        ...[...dependencyBlock(meta.dependencies)]
          .filter(([dep]) => !optionalDeps.has(dep))
          .map(([dep, spec]) => dependencyRequirement(dep, spec)),
        ...peers,
      ];
      const optional = [...optionalDeps].map(([dep, spec]) => dependencyRequirement(dep, spec));
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
   * What the generic repair suggester needs from this repository (see
   * resolver/ResolutionReport): the written reference form, the registry's
   * version list, and a memoized enrichment-free re-resolve.
   */
  private suggestSources(): SuggestSources<SemverVersion, SemverConstraint> {
    return {
      domain: SEMVER,
      refText: npmRef,
      availableVersions: pkg => this.publishedVersions(pkg, false),
      resolve: roots =>
        this.getJointResolution(
          roots,
          roots.map(req => requirementKey(req)),
          false
        ),
    };
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
      if (SEMVER.isFloorless(constraint)) {
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
   * the cache. Repairs (violations, raises, forks) are recorded in the doc as
   * data — enforcement is per delivery, at materialize.
   */
  private getJointResolution(roots: Requirement[], rootKeys: string[], enrich = true): Computable<ResolvedRepairs> {
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
        .memoize("npm:resolve:16", `${this.url} ${targetKey}\n${rootKeys.join("\n")}`, () => {
          /* A memo miss means real resolution work on behalf of the consumer */
          this.context.notifyProgress({ kind: "repository-resolve", repository: this.context.target, requirements: rootKeys });
          return resolveMVS(roots, SEMVER, this).then(result => {
            /* Hard errors (unparseable constraints, unconstrained-only
             * requirements) are not repairable in any mode. Grouped and
             * enriched with pin suggestions before throwing — typed + per-error
             * root attribution, so the resolve() catch can map each failure to
             * the written reference(s) that pulled its subtree in, instead of
             * blaming the whole collection point. */
            if (result.errors.length > 0) {
              if (!enrich) {
                throw new ResolutionWalkError(result.errors);
              }
              return completeRepairSet(result.errors, roots, this.suggestSources()).then(failures => {
                throw new ResolutionWalkError(failures);
              });
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
  private verifiedResolutionDoc(roots: Requirement[], result: MVSResolution<SemverVersion>, target: NpmPlatform): Computable<FileSet> {
    /* The platform gate stays hard in every mode — a package for another
     * platform can't run, sealed or not — and covers fork selections too
     * (they are ordinary selections of the one tree). */
    return Computable.forAll(
      result.selections.map(sel => this.getVersionMetadata(sel.pkg, versionToString(sel.version)).then(meta => ({ sel, meta }))),
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
          selections: result.selections.map(serializeSelection),
          violations: result.violations.map(serializeViolation),
          coerced: result.coerced.map(serializeViolation),
          raises: result.raises.map(serializeRaise),
          requirements: serializeRequirements(result.requirements),
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
    fork: sel.fork,
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

function serializeRequirements(requirements: Map<string, Requirement[]>): IRequirementsEntry[] {
  /* Already canonical: the resolver builds the map in its selections' order. */
  return [...requirements].map(([node, requires]) => ({ node, requires }));
}

function deserializeRequirements(entries: IRequirementsEntry[] | undefined): Map<string, Requirement[]> {
  return new Map((entries ?? []).map(entry => [entry.node, entry.requires]));
}

function deserializeSelection(entry: IResolutionEntry): Selected<SemverVersion> {
  return {
    pkg: entry.pkg,
    version: parseVersion(entry.version),
    selectedBy: entry.selectedBy,
    reachedVia: entry.reachedVia,
    reachableFrom: entry.reachableFrom,
    fork: entry.fork,
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
    coerced: (doc.coerced ?? []).map(deserializeViolation),
    raises: (doc.raises ?? []).map(deserializeRaise),
    requirements: deserializeRequirements(doc.requirements),
  };
}










function createRepository(context: RepositoryContext): Computable<NPMRepository> {
  return Computable.forAll(
    [context.getRequiredString("url"), context.getString("access")],
    (url, access) => new NPMRepository(url, context, toPublishAccess(access))
  );
}

export const npmRepositoryRegistration: RepositoryRegistration = { type: "npm_repository", provider: createRepository };
