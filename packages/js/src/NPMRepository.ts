import {
  BUILD_OPERATION,
  Computable,
  FileSet,
  IProjection,
  IRequirementEdge,
  IResolutionOrigin,
  MemoryFile,
  Name,
  PACKAGE_RESOLUTION_PROVENANCE,
  PackageFileSet,
  PackageRegistry,
  parseVersion,
  readStream,
  registerRepositoryProvider,
  Repository,
  RepositoryContext,
  RepositoryRef,
  Requirement,
  resolveMVS,
  Selected,
  SEMVER,
  SemverVersion,
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
   * process.platform / process.arch vocabulary; each is an allow-list, with a
   * leading `!` negating an entry. Absent/empty means "any". (npm's `libc`
   * gate — glibc/musl — is not yet honored; irrelevant to esbuild, whose Go
   * binary is statically linked, but it splits rollup/swc/sharp builds.)
   */
  os?: string[];
  cpu?: string[];
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

interface INPMPackageVersions {
  name: string;
  description: string;
  "dist-tags": Record<string, string>;
  versions: Record<string, INPMPackageMetadata>;
  license: string;
}

interface INPMError {
  code: string;
  message: string;
}

interface INPMError2 {
  error: string;
}

type INPMResponse = INPMError | INPMError2 | INPMPackageVersions | INPMPackageMetadata;

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

/**
 * Whether a package declaring these os/cpu gates in its own metadata may run on
 * the given host — the test that keeps only the host-matching native-binary
 * variants out of a package's full set of platform optional dependencies.
 */
export function matchesHostPlatform(meta: { os?: string[]; cpu?: string[] }, host: { os?: string; cpu?: string }): boolean {
  return platformGateAdmits(meta.os, host.os) && platformGateAdmits(meta.cpu, host.cpu);
}

/**
 * A human-readable reason a package declaring these os/cpu gates cannot run on
 * the given host, or undefined if it can. Optional dependencies are filtered
 * out silently before selection; this is for the other side of npm's contract —
 * a *non-optional* dependency (or a direct requirement) on a package built for
 * another platform, which npm rejects as EBADPLATFORM rather than mounting an
 * unusable install.
 */
export function unsupportedPlatformReason(
  meta: { os?: string[]; cpu?: string[] },
  host: { os?: string; cpu?: string }
): string | undefined {
  const parts: string[] = [];
  if (!platformGateAdmits(meta.os, host.os)) {
    parts.push(`os '${host.os ?? "(unknown)"}' is not in [${(meta.os ?? []).join(", ")}]`);
  }
  if (!platformGateAdmits(meta.cpu, host.cpu)) {
    parts.push(`cpu '${host.cpu ?? "(unknown)"}' is not in [${(meta.cpu ?? []).join(", ")}]`);
  }
  return parts.length === 0 ? undefined : parts.join("; ");
}

class NPMRepository implements Repository, PackageRegistry<SemverVersion> {
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
   * Resolve a batch of references jointly: one minimal-version-selection
   * instance over all of the root requirements together, so that shared
   * packages resolve to a single agreed version (and user overrides dominate
   * sibling dependencies' requirements, per the max-of-minimums rule).
   * Each reference receives its root as a PackageFileSet (files relative to
   * the package root), carrying the subset of the joint closure reachable from
   * that root as its resolved dependencies; laying the packages out (mounting)
   * is the consumer's decision.
   *
   * Only semver versions/ranges are accepted: dist-tags (e.g. 'latest') are
   * mutable pointers and would make the build non-deterministic, so they are
   * deliberately not supported. This also means every document we fetch from the
   * repository is immutable, and so cacheable indefinitely with no refresh policy.
   */
  public resolveAll(references: RepositoryRef[]): Computable<FileSet[]> {
    const requirements = references.map(reference => this.parseRequirement(reference.name));
    /* Canonicalize the roots so the resolution (and its memo key, and the
     * reachableFrom indices) are independent of reference order */
    const byKey = new Map(requirements.map(req => [requirementKey(req), req]));
    const rootKeys = [...byKey.keys()].sort();
    const roots = rootKeys.map(key => byKey.get(key)!);
    const rootIndex = new Map(rootKeys.map((key, index) => [key, index]));
    /* The operation is a property of this collection point, read from the
     * context (this instance is interned per BuildContext, so it reflects the
     * constraints these references were consumed under). Closure members are
     * always plain packages — only the requested roots take the run delivery. */
    const operation = this.context.getConstraint(BUILD_OPERATION) ?? "build";
    return this.getJointResolution(roots, rootKeys).then(selections => {
      checkSingleVersions(selections, rootKeys.join(", "));
      return Computable.forAll(
        selections.map(sel => this.fetch(sel.pkg, sel.version)),
        (...packages: PackageFileSet[]) =>
          Computable.forAll(
            requirements.map(req =>
              this.assembleClosure(req, rootIndex.get(requirementKey(req))!, selections, packages, operation)
            ),
            (...delivered: FileSet[]) => delivered
          )
      );
    });
  }

  /**
   * Assemble the delivery for one root requirement: its own package, carrying
   * the reachable members of the joint closure as resolved dependencies, all
   * stamped with the resolution's provenance.
   */
  private assembleClosure(
    req: Requirement,
    index: number,
    selections: Selected<SemverVersion>[],
    packages: PackageFileSet[],
    operation: string
  ): Computable<FileSet> {
    const origin: IResolutionOrigin<SemverVersion> = {
      kind: PACKAGE_RESOLUTION_PROVENANCE,
      repository: this.url,
      root: req,
      selections,
      versionToString,
      packageOfPath: npmPackageOfPath,
    };
    const reachable = selections.flatMap((sel, selIndex) =>
      sel.reachableFrom?.includes(index) ? [{ sel, files: packages[selIndex] }] : []
    );
    const root = reachable.find(entry => entry.sel.pkg === req.pkg);
    if (!root) {
      /* Can't happen: a root requirement is always reachable from itself */
      throw new Error(`Resolution of ${requirementKey(req)} does not contain its own root package`);
    }
    const dependencies = reachable.filter(entry => entry !== root).map(entry => entry.files.withOrigin(origin));
    const pkg = new PackageFileSet(root.files, root.files.packageName, root.files.version, dependencies, origin);
    /* Under `run`, hand back a runnable (the npm package's own bin, launched with
     * its closure mounted) — making a package runnable is this repository's own
     * npm-specific business. Everything else gets the plain package. */
    return operation === "run" ? makeNpmRunnable(pkg) : Computable.resolve(pkg);
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
      throw new Error(
        `'${constraint}' is not a valid version constraint for '${pkg}'` +
          " (note that dist-tags such as 'latest' are not supported: pin a version or range instead)"
      );
    }
    return { pkg, constraint };
  }

  /**
   * The host machine facts (Node's process.platform/process.arch vocabulary),
   * driver-injected as HOST_OS / HOST_CPU constraints and read off this
   * repository's (per-BuildContext-interned) context. Either component is
   * undefined if unset. Used to gate os/cpu-specific optional dependencies.
   */
  private hostPlatform(): { os?: string; cpu?: string } {
    return { os: this.context.getConstraint("HOST_OS"), cpu: this.context.getConstraint("HOST_CPU") };
  }

  /**
   * PackageRegistry implementation: the requirements of pkg@version are its
   * declared `dependencies`, plus the `optionalDependencies` that are installable
   * on this host. The dominant use of the latter is os/cpu-gated native binaries
   * (esbuild's @esbuild/<platform> engine): all variants are listed, and only the
   * host-matching one(s) are kept. peerDependencies remain ignored.
   */
  public getRequirements(pkg: string, version: SemverVersion): Computable<Requirement[]> {
    return this.getVersionMetadata(pkg, versionToString(version)).then(meta => {
      const required = Object.entries(meta.dependencies ?? {}).map(([dep, constraint]) => ({ pkg: dep, constraint }));
      const optional = Object.entries(meta.optionalDependencies ?? {}).map(([dep, constraint]) => ({ pkg: dep, constraint }));
      if (optional.length === 0) {
        return Computable.resolve(required);
      }
      /* The os/cpu gate is declared in the *dependency's* own metadata, so each
       * candidate must be probed. The match is version-stable (a package's target
       * platform doesn't change across releases), so probing the constraint's
       * minimum decides correctly whatever version selection ultimately picks. */
      const host = this.hostPlatform();
      return Computable.forAll(
        optional.map(req => this.keepIfHostMatches(req, host)),
        (...kept) => [...required, ...kept.filter((req): req is Requirement => req !== undefined)]
      );
    });
  }

  /**
   * Probe an optional dependency's os/cpu gates, returning it as a requirement
   * only if this host satisfies them (else undefined). A candidate that can't be
   * probed — unparseable pin, no version to probe, or an unreachable/unpublished
   * metadata document — is dropped non-fatally, per npm's optional-dependency
   * contract (a genuinely-needed absence surfaces at the consumer's own runtime
   * check, e.g. esbuild's "missing platform binary" error). A future refinement:
   * a matched-but-unfetchable probe deserves a diagnostic once the progress layer
   * carries warnings; a plain platform mismatch stays silent.
   */
  private keepIfHostMatches(req: Requirement, host: { os?: string; cpu?: string }): Computable<Requirement | undefined> {
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
      meta => (matchesHostPlatform(meta, host) ? req : undefined),
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
    /* The resolution now depends on the host platform (it filters os/cpu-gated
     * optional deps), so the memo key must carry it — otherwise a resolution
     * computed on one host would be served on another. */
    const host = this.hostPlatform();
    const hostKey = `${host.os ?? "?"}-${host.cpu ?? "?"}`;
    return this.context
      .memoize("npm:resolve:3", `${this.url} ${hostKey} ${rootKeys.join(" ")}`, () => {
        /* A memo miss means real resolution work on behalf of the consumer */
        this.context.notifyProgress({ kind: "repository-resolve", repository: this.context.target, requirements: rootKeys });
        return resolveMVS(roots, SEMVER, this).then(resolution => {
          if (resolution.errors.length > 0) {
            throw new Error(`Unable to resolve ${rootKeys.join(", ")}:\n  ${resolution.errors.join("\n  ")}`);
          }
          return this.verifiedResolutionDoc(roots, resolution.selections, host);
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
  }

  /**
   * Validate the resolved closure against the host platform, then serialize it.
   * Optional deps were already filtered to this host, so any os/cpu mismatch
   * remaining is a *non-optional* dependency (or a direct requirement) on a
   * package for another platform — npm's EBADPLATFORM — and is an error rather
   * than an unusable install. Each selection's metadata was fetched during the
   * resolution walk, so these are cache hits. (Override HOST_OS / HOST_CPU with
   * -D to resolve for a different platform.)
   */
  private verifiedResolutionDoc(
    roots: Requirement[],
    selections: Selected<SemverVersion>[],
    host: { os?: string; cpu?: string }
  ): Computable<FileSet> {
    return Computable.forAll(
      selections.map(sel => this.getVersionMetadata(sel.pkg, versionToString(sel.version)).then(meta => ({ sel, meta }))),
      (...entries) => {
        for (const { sel, meta } of entries) {
          const reason = unsupportedPlatformReason(meta, host);
          if (reason) {
            throw new Error(
              `${sel.pkg}@${versionToString(sel.version)} is not supported on this host (${reason}), ` +
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
        .then(data => JSON.parse(data) as INPMPackageMetadata);
      this.metadataCache.set(key, result);
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

/**
 * Validate a registry response as an exact-version metadata document, before it
 * gets anywhere near the cache (error responses must never be cached).
 */
function parseMetadataResponse(data: Buffer, key: string): INPMPackageMetadata {
  const response = JSON.parse(data.toString()) as INPMResponse;
  if ("error" in response) {
    if (response.error === "Not Found") {
      throw new Error(`${key} not found in NPM repository`);
    } else {
      throw new Error(`NPM repository error on '${key}': ${response.error}`);
    }
  } else if ("code" in response) {
    throw new Error(`NPM repository error on '${key}': ${response.message}`);
  } else if ("versions" in response) {
    throw new Error(`'${key}' does not identify a single package version`);
  } else {
    return response;
  }
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

registerRepositoryProvider("npm_repository", createRepository);
