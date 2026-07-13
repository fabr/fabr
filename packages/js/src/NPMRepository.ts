import {
  attachHelp,
  BUILD_OPERATION,
  Computable,
  FILES_OPERATION,
  FileSet,
  HttpStatusError,
  IProjection,
  IRequirementEdge,
  IResolutionOrigin,
  MemoryFile,
  MetadataFetchError,
  Name,
  NpmPlatform,
  PACKAGE_RESOLUTION_PROVENANCE,
  PackageFileSet,
  PackageRegistry,
  parseVersion,
  readStream,
  Repository,
  RepositoryContext,
  RepositoryRef,
  RepositoryRegistration,
  Requirement,
  RequirementResolutionError,
  Resolution,
  ResolvedRoot,
  resolveMVS,
  ROOT_REQUIRER,
  RunnableFileSet,
  Selected,
  SEMVER,
  SemverVersion,
  TARGET,
  tripleToNpm,
  unpackStream,
  versionToString,
} from "@fabr/core";
import { makeNpmRunnable } from "./JSPackage";

interface ISignature {
  keyid: string;
  sig: string;
}
interface INPMPackageMetadata {
  dependencies?: Record<string, string>;
  /**
   * Deps npm installs when they can be installed but tolerates the absence of.
   * The dominant use is os/cpu-gated native binaries (esbuild's @esbuild/<plat>,
   * rollup, swc, …): every platform variant is listed here, each self-gated by
   * its own package's `os`/`cpu`, and only the host-matching one(s) are kept.
   */
  optionalDependencies?: Record<string, string>;
  /**
   * Installability gates declared by a package on itself, in Node's
   * process.platform / process.arch vocabulary (plus glibc/musl for `libc`); each
   * is an allow-list, with a leading `!` negating an entry. Absent/empty means
   * "any". Gated against the TARGET platform (see targetPlatform). `libc` splits
   * rollup/swc/sharp native builds; it is irrelevant to esbuild, whose Go binary
   * is statically linked.
   */
  os?: string[];
  cpu?: string[];
  libc?: string[];
  dist: {
    fileCount?: number;
    integrity: string;
    "npm-signature"?: string;
    shasum: string;
    signatures: ISignature[];
    tarball: string;
    unpackedSize?: number;
  };
  name: string;
  version: string;
  license: string;
  typings?: string;
  types?: string;
  /* and potentially lots of other stuff that we don't need */
}

const METADATA_FILE = "metadata.json";
const RESOLUTION_FILE = "resolution.json";

/** Serialized form of one selection in a persisted resolution document */
interface IResolutionEntry {
  pkg: string;
  version: string;
  selectedBy?: IRequirementEdge;
  reachedVia?: IRequirementEdge;
  reachableFrom?: number[];
}

/** Serialized form of a persisted joint resolution */
interface IResolutionDoc {
  roots: Requirement[];
  selections: IResolutionEntry[];
}

function requirementKey(req: Requirement): string {
  return `${req.pkg}:${req.constraint}`;
}

/**
 * npm's os/cpu gate semantics: the list is an allow-list of process.platform /
 * process.arch values, an entry prefixed `!` negating it. An empty/absent list
 * imposes no constraint. A value is rejected if explicitly blocked (`!value`);
 * otherwise it must appear in the allow-list, unless the list is negations-only.
 * A gated package on a host whose fact is unknown cannot be confirmed to match.
 */
export function platformGateAdmits(gate: string[] | undefined, value: string | undefined): boolean {
  if (!gate || gate.length === 0) {
    return true;
  }
  if (value === undefined) {
    return false;
  }
  if (gate.some(entry => entry.startsWith("!") && entry.slice(1) === value)) {
    return false;
  }
  const allowed = gate.filter(entry => !entry.startsWith("!"));
  return allowed.length === 0 || allowed.includes(value);
}

type PlatformGates = { os?: string[]; cpu?: string[]; libc?: string[] };

/**
 * Whether a package declaring these os/cpu/libc gates in its own metadata may run
 * on the given target platform — the test that keeps only the target-matching
 * native-binary variants out of a package's full set of platform optional
 * dependencies.
 */
export function matchesTargetPlatform(meta: PlatformGates, target: NpmPlatform): boolean {
  return (
    platformGateAdmits(meta.os, target.os) &&
    platformGateAdmits(meta.cpu, target.cpu) &&
    platformGateAdmits(meta.libc, target.libc)
  );
}

/**
 * A human-readable reason a package declaring these os/cpu/libc gates cannot run
 * on the given target platform, or undefined if it can. Optional dependencies are
 * filtered out silently before selection; this is for the other side of npm's
 * contract — a *non-optional* dependency (or a direct requirement) on a package
 * built for another platform, which npm rejects as EBADPLATFORM rather than
 * mounting an unusable install.
 */
export function unsupportedPlatformReason(meta: PlatformGates, target: NpmPlatform): string | undefined {
  const parts: string[] = [];
  if (!platformGateAdmits(meta.os, target.os)) {
    parts.push(`os '${target.os ?? "(unknown)"}' is not in [${(meta.os ?? []).join(", ")}]`);
  }
  if (!platformGateAdmits(meta.cpu, target.cpu)) {
    parts.push(`cpu '${target.cpu ?? "(unknown)"}' is not in [${(meta.cpu ?? []).join(", ")}]`);
  }
  if (!platformGateAdmits(meta.libc, target.libc)) {
    parts.push(`libc '${target.libc ?? "(unknown)"}' is not in [${(meta.libc ?? []).join(", ")}]`);
  }
  return parts.length === 0 ? undefined : parts.join("; ");
}

/**
 * npm's private {@link Resolution}: the joint version selection + reachable tree,
 * plus the operation it was resolved under (so materialize delivers the same
 * package-vs-runnable shape without a second context read). `selections`/`rootIndex`
 * are empty under the `files` operation, where materialize fetches per-reference.
 */
interface NpmResolution extends Resolution {
  readonly roots: ResolvedRoot[];
  readonly operation: string;
  readonly selections: Selected<SemverVersion>[];
  /** requirementKey → index into the resolution's roots (the space `reachableFrom` indexes). */
  readonly rootIndex: Map<string, number>;
}

export class NPMRepository implements Repository, PackageRegistry<SemverVersion> {
  private readonly url: string;
  private readonly context: RepositoryContext;
  /* In-process memo over the persistent metadata cache, keyed by "pkg/version" */
  private readonly metadataCache: Map<string, Computable<INPMPackageMetadata>>;

  constructor(url: string, context: RepositoryContext) {
    this.url = url.replace(/\/+$/, "");
    this.context = context;
    this.metadataCache = new Map();
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
          throw new RequirementResolutionError([reference], asError(err));
        }
      });
      const roots: ResolvedRoot[] = references.map((reference, index) => ({ reference, name: requirements[index].pkg }));
      if (operation === FILES_OPERATION) {
        return Computable.resolve<NpmResolution>({ roots, operation, selections: [], rootIndex: new Map() });
      }
      /* Canonicalize the roots so the resolution (and its memo key, and the
       * reachableFrom indices) are independent of reference order */
      const byKey = new Map(requirements.map(req => [requirementKey(req), req]));
      const rootKeys = [...byKey.keys()].sort();
      const rootReqs = rootKeys.map(key => byKey.get(key)!);
      const rootIndex = new Map(rootKeys.map((key, index) => [key, index]));
      return this.getJointResolution(rootReqs, rootKeys)
        .then(selections => {
          checkSingleVersions(selections, rootKeys.join(", "));
          return { roots, operation, selections, rootIndex } satisfies NpmResolution;
        })
        .catch(err => this.attributeMetadataFailure(err, references, requirements));
    });
  }

  /**
   * Phase 2 — fetch + assemble the requested references (a subset of `resolution`).
   * Only the closure reachable from the requested roots is fetched, from the
   * pre-resolved tree — so a subset materialization keeps the joint pin. The
   * operation (captured in the resolution) decides the shape: run → each root
   * becomes a runnable, otherwise the plain packages.
   */
  public materialize(references: RepositoryRef[], resolution: Resolution): Computable<FileSet[]> {
    const resolved = resolution as NpmResolution;
    if (resolved.operation === FILES_OPERATION) {
      return Computable.forAll(
        references.map(reference => this.attributedTo(reference, () => this.resolveBarePackage(reference))),
        (...delivered: FileSet[]) => delivered
      );
    }
    const { selections, rootIndex, operation } = resolved;
    const requirements = references.map(reference => this.parseRequirement(reference.name));
    const requestedRoots = new Set(requirements.map(req => rootIndex.get(requirementKey(req))!));
    /* Fetch only the selections reachable from the requested roots (indexed by
     * their position in `selections`, so assembleClosure can pick each root's
     * reachable subset). */
    const needed = selections.flatMap((sel, selIndex) =>
      sel.reachableFrom?.some(root => requestedRoots.has(root)) ? [{ sel, selIndex }] : []
    );
    return Computable.forAll(
      needed.map(({ sel }) => this.fetch(sel.pkg, sel.version)),
      (...fetched: PackageFileSet[]) => {
        const packages = new Map<number, PackageFileSet>(needed.map(({ selIndex }, k) => [selIndex, fetched[k]]));
        const assembled = requirements.map(req =>
          this.assembleClosure(req, rootIndex.get(requirementKey(req))!, selections, packages)
        );
        return operation === "run"
          ? Computable.forAll(
              assembled.map(pkg => this.makeRunnable(pkg)),
              (...delivered: FileSet[]) => delivered
            )
          : assembled;
      }
    ).catch(err => this.attributeMetadataFailure(err, references, requirements));
  }

  /**
   * A metadata failure names the root package whose closure reached it (the
   * resolver's first-reacher chain): attribute it to the written reference(s)
   * requiring that root, whose carried provenance lets the driver point at the
   * requirement as written.
   */
  private attributeMetadataFailure(err: unknown, references: RepositoryRef[], requirements: Requirement[]): never {
    if (err instanceof MetadataFetchError) {
      const culpable = references.filter((_, index) => requirements[index].pkg === err.rootPkg);
      if (culpable.length > 0) {
        throw new RequirementResolutionError(culpable, err);
      }
    }
    throw asError(err);
  }

  /**
   * Run one reference's own delivery, attributing any failure to it (the
   * per-reference analogue of the batch attribution).
   */
  private attributedTo(reference: RepositoryRef, deliver: () => Computable<FileSet>): Computable<FileSet> {
    try {
      return deliver().catch(err => {
        throw new RequirementResolutionError([reference], asError(err));
      });
    } catch (err) {
      throw new RequirementResolutionError([reference], asError(err));
    }
  }

  /**
   * Assemble the delivery for one root requirement: its own package, carrying
   * the reachable members of the joint closure as resolved dependencies, all
   * stamped with the resolution's provenance.
   */
  /**
   * Make an already-resolved npm package launchable, keeping the exact closure
   * it carries (no re-resolution). Shared by this repository's own `run`
   * delivery and by a catalog delegating a jointly-pinned member.
   */
  public makeRunnable(pkg: PackageFileSet): Computable<RunnableFileSet> {
    return makeNpmRunnable(pkg);
  }

  private assembleClosure(
    req: Requirement,
    index: number,
    selections: Selected<SemverVersion>[],
    packages: Map<number, PackageFileSet>
  ): PackageFileSet {
    const origin: IResolutionOrigin<SemverVersion> = {
      kind: PACKAGE_RESOLUTION_PROVENANCE,
      repository: this.url,
      root: req,
      selections,
      versionToString,
      packageOfPath: npmPackageOfPath,
    };
    const reachable = selections.flatMap((sel, selIndex) =>
      sel.reachableFrom?.includes(index) ? [{ sel, files: packages.get(selIndex)! }] : []
    );
    const root = reachable.find(entry => entry.sel.pkg === req.pkg);
    if (!root) {
      /* Can't happen: a root requirement is always reachable from itself */
      throw new Error(`Resolution of ${requirementKey(req)} does not contain its own root package`);
    }
    const dependencies = reachable.filter(entry => entry !== root).map(entry => entry.files.withOrigin(origin));
    /* The plain resolved package with its joint closure carried; the operation's
     * delivery shape (a runnable under `run`) is applied upstream in `deliver`. */
    return new PackageFileSet(root.files, root.files.packageName, root.files.version, dependencies, origin);
  }

  /**
   * Deliver a single package's own files, resolved standalone — the `files`
   * operation's delivery (see resolveAll). A top-level root's minimal-version
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
    return this.fetch(req.pkg, version).then(pkg => new PackageFileSet(pkg, pkg.packageName, pkg.version, [], origin));
  }

  public splitReference(name: Name): { requirement: Name; projection?: IProjection } {
    return splitNpmReference(name);
  }

  private parseRequirement(name: Name): Requirement {
    const prefix = name.getLiteralPathPrefix();
    const idx = prefix.lastIndexOf(":");
    if (idx === -1) {
      throw new Error(`Missing version in package reference '${prefix}' (expected '<name>:<version-or-range>')`);
    }
    const pkg = prefix.substring(0, idx);
    const constraint = prefix.substring(idx + 1);
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
   * declared `dependencies`, plus the `optionalDependencies` that are installable
   * on the target. The dominant use of the latter is os/cpu-gated native binaries
   * (esbuild's @esbuild/<platform> engine): all variants are listed, and only the
   * target-matching one(s) are kept. peerDependencies remain ignored.
   */
  public getRequirements(pkg: string, version: SemverVersion): Computable<Requirement[]> {
    return this.getVersionMetadata(pkg, versionToString(version)).then(meta => {
      /* npm's rule: an entry in optionalDependencies overrides the same name in
       * dependencies, so a dep listed in both is optional (os/cpu-gated, dropped
       * if the target doesn't match). @parcel/watcher lists its per-platform native
       * binaries in both — treating them as required would reject the ones for
       * other platforms as EBADPLATFORM. */
      const optionalNames = new Set(Object.keys(meta.optionalDependencies ?? {}));
      const required = Object.entries(meta.dependencies ?? {})
        .filter(([dep]) => !optionalNames.has(dep))
        .map(([dep, constraint]) => ({ pkg: dep, constraint }));
      const optional = Object.entries(meta.optionalDependencies ?? {}).map(([dep, constraint]) => ({ pkg: dep, constraint }));
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
    return this.getVersionMetadata(req.pkg, probeVersion).then(
      meta => (matchesTargetPlatform(meta, target) ? req : undefined),
      () => undefined
    );
  }

  /**
   * Resolutions are persisted in the build cache: under minimal version selection
   * the result is a pure function of the (canonically ordered) root requirements
   * and the (immutable) declared metadata of the packages they reach, so a cached
   * resolution can only become wrong if a requirement itself changes — which
   * changes the cache key. Failed resolutions are not cached (the error
   * propagates before anything is written), so transient repository problems
   * don't poison the cache.
   */
  private getJointResolution(roots: Requirement[], rootKeys: string[]): Computable<Selected<SemverVersion>[]> {
    /* The resolution depends on the target platform (it filters os/cpu/libc-gated
     * optional deps), so the memo key must carry it — otherwise a resolution
     * computed for one target would be served for another. */
    return this.targetPlatform().then(target => {
      const targetKey = `${target.os ?? "?"}-${target.cpu ?? "?"}-${target.libc ?? "?"}`;
      return this.context
        .memoize("npm:resolve:4", `${this.url} ${targetKey} ${rootKeys.join(" ")}`, () => {
          /* A memo miss means real resolution work on behalf of the consumer */
          this.context.notifyProgress({ kind: "repository-resolve", repository: this.context.target, requirements: rootKeys });
          return resolveMVS(roots, SEMVER, this).then(resolution => {
            if (resolution.errors.length > 0) {
              throw new Error(`Unable to resolve ${rootKeys.join(", ")}:\n  ${resolution.errors.join("\n  ")}`);
            }
            return this.verifiedResolutionDoc(roots, resolution.selections, target);
          });
        })
        .then(files => files.readFile(RESOLUTION_FILE))
        .then(data => {
          const doc = JSON.parse(data) as IResolutionDoc;
          return doc.selections.map(entry => ({
            pkg: entry.pkg,
            version: parseVersion(entry.version),
            selectedBy: entry.selectedBy,
            reachedVia: entry.reachedVia,
            reachableFrom: entry.reachableFrom,
          }));
        });
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
    selections: Selected<SemverVersion>[],
    target: NpmPlatform
  ): Computable<FileSet> {
    return Computable.forAll(
      selections.map(sel => this.getVersionMetadata(sel.pkg, versionToString(sel.version)).then(meta => ({ sel, meta }))),
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
          selections: selections.map(sel => ({
            pkg: sel.pkg,
            version: versionToString(sel.version),
            selectedBy: sel.selectedBy,
            reachedVia: sel.reachedVia,
            reachableFrom: sel.reachableFrom,
          })),
        };
        return new FileSet(new Map([[RESOLUTION_FILE, MemoryFile.from(JSON.stringify(doc, undefined, 2))]]));
      }
    );
  }

  /**
   * Fetch the metadata document for an exact package version. The registry
   * contract is that these are immutable once published, so they are persisted
   * in the build cache and never refreshed.
   */
  private getVersionMetadata(pkg: string, version: string): Computable<INPMPackageMetadata> {
    const key = pkg + "/" + version;
    let result = this.metadataCache.get(key);
    if (!result) {
      result = this.context
        .fetch(
          `${this.url}/${key}`,
          "npm:metadata:1",
          content =>
            readStream(content).then(data => {
              const meta = parseMetadataResponse(data, key);
              return new FileSet(new Map([[METADATA_FILE, MemoryFile.from(JSON.stringify(meta))]]));
            }),
          "metadata"
        )
        .then(files => files.readFile(METADATA_FILE))
        .then(data => JSON.parse(data) as INPMPackageMetadata)
        .catch(err => {
          /* Translate the registry's HTTP 404 into the fact it means. */
          if (err instanceof HttpStatusError && err.statusCode === 404) {
            throw new Error(`NPM package ${pkg}@${version} not found at ${this.url}`);
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
      this.context
        .fetch(
          meta.dist.tarball,
          "npm:tarball:1",
          (content, targetDir) => unpackStream(content, targetDir).then(stripArchiveRoot),
          "package"
        )
        .then(files => new PackageFileSet(files, meta.name, meta.version))
    );
  }
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Interpret a registry response, before it gets anywhere near the cache (error
 * responses must never be cached). It's a three-way split — HTTP-level failures
 * (404, 5xx) are already surfaced upstream, so no error-body taxonomy is needed:
 *  - a single-version metadata document (the documented shape: `name` + `version`
 *    + `dist.tarball`) — the thing we asked for; return it;
 *  - a full packument (`versions`) — we resolved the wrong URL, a bug;
 *  - anything else (an error body, non-JSON, a truncated/HTML page) — unusable.
 */
export function parseMetadataResponse(data: Buffer, key: string): INPMPackageMetadata {
  const response = parseJsonObject(data);
  if (response && isVersionMetadata(response)) {
    return response;
  }
  if (response && "versions" in response) {
    throw new Error(`NPM repository returned a package document, not a single version, for '${key}' (wrong URL?)`);
  }
  throw new Error(`Invalid response from NPM repository for '${key}'`);
}

/** Parse a body as a JSON object, or undefined if it is not JSON / not an object. */
function parseJsonObject(data: Buffer): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(data.toString());
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a body is a single-version metadata document — `name` + `version` +
 * a `dist.tarball` (a full packument has none of the latter two). */
function isVersionMetadata(response: Record<string, unknown>): response is INPMPackageMetadata & Record<string, unknown> {
  const meta = response as unknown as INPMPackageMetadata;
  return (
    typeof meta.name === "string" &&
    typeof meta.version === "string" &&
    typeof meta.dist === "object" &&
    meta.dist !== null &&
    typeof meta.dist.tarball === "string"
  );
}

function isSemverConstraint(text: string): boolean {
  try {
    SEMVER.parseConstraint(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Consumers mount the resolved closure as a flat node_modules, which can only
 * host a single version of each package; check for multiple selected versions
 * (of different majors) and fail with something actionable rather than letting
 * the FileSet union report an opaque path conflict.
 */
function checkSingleVersions(selections: Selected<SemverVersion>[], root: string): void {
  const byPkg = new Map<string, SemverVersion[]>();
  for (const sel of selections) {
    byPkg.set(sel.pkg, [...(byPkg.get(sel.pkg) ?? []), sel.version]);
  }
  for (const [pkg, versions] of byPkg) {
    if (versions.length > 1) {
      throw new Error(
        `Unable to resolve ${root}: requires multiple versions of ${pkg} (${versions
          .map(versionToString)
          .join(", ")}), which the flat package layout cannot represent`
      );
    }
  }
}

/**
 * The package owning a path within a mounted closure, per the node_modules
 * naming convention consumers mount packages with ("@scope/name/..." or
 * "name/...").
 */
export function npmPackageOfPath(path: string): string {
  const parts = path.split("/");
  return parts[0].startsWith("@") && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0];
}

/**
 * Split an npm reference name into its identity (`name:version`) and an optional
 * projection into the resolved package. Since neither `:` nor `/` is legal in a
 * registry version, the identity ends at the first `:` or `/` after the
 * `name:version` separator; the remainder (plus any trailing glob) is the
 * projection, named per the written-name rule (`:` strips, `/` retains). A pure
 * parse — no resolution (see Repository.splitReference).
 */
export function splitNpmReference(name: Name): { requirement: Name; projection?: IProjection } {
  const lit = name.getLiteralPrefix();
  const firstColon = lit.indexOf(":");
  if (firstColon === -1) {
    return { requirement: name }; // no version — parseRequirement reports it
  }
  const nextColon = lit.indexOf(":", firstColon + 1);
  const nextSlash = lit.indexOf("/", firstColon + 1);
  const boundary = nextColon === -1 ? nextSlash : nextSlash === -1 ? nextColon : Math.min(nextColon, nextSlash);
  if (boundary === -1) {
    return { requirement: name }; // identity runs to the end; no projection
  }
  const prefix = lit[boundary] === "/" ? lit.substring(0, boundary) + "/" : "";
  return { requirement: Name.fromLiteral(lit.substring(0, boundary)), projection: { pattern: name.substring(boundary + 1), prefix } };
}

function createRepository(context: RepositoryContext): Computable<NPMRepository> {
  return context.getRequiredString("url").then(url => new NPMRepository(url, context));
}

/**
 * npm tarballs wrap the package contents in a single root directory
 * (conventionally "package/", but not reliably so); strip it, so the stored
 * package's files are named relative to the package root.
 */
function stripArchiveRoot(files: FileSet): FileSet {
  return files.remap(name => {
    const idx = name.indexOf("/");
    return idx === -1 ? undefined : name.substring(idx + 1);
  });
}

export const npmRepositoryRegistration: RepositoryRegistration = { type: "npm_repository", provider: createRepository };
