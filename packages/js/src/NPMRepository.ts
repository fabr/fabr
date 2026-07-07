import {
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
    const operation = this.context.getOperation();
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
   * PackageRegistry implementation: the requirements of pkg@version are the
   * "dependencies" declared in its package metadata.
   * Note: peerDependencies and optionalDependencies are currently ignored.
   */
  public getRequirements(pkg: string, version: SemverVersion): Computable<Requirement[]> {
    return this.getVersionMetadata(pkg, versionToString(version)).then(meta =>
      Object.entries(meta.dependencies ?? {}).map(([dep, constraint]) => ({ pkg: dep, constraint }))
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
    return this.context
      .memoize("npm:resolve:2", `${this.url} ${rootKeys.join(" ")}`, () => {
        /* A memo miss means real resolution work on behalf of the consumer */
        this.context.notifyProgress({ kind: "repository-resolve", repository: this.context.target, requirements: rootKeys });
        return resolveMVS(roots, SEMVER, this).then(resolution => {
          if (resolution.errors.length > 0) {
            throw new Error(`Unable to resolve ${rootKeys.join(", ")}:\n  ${resolution.errors.join("\n  ")}`);
          }
          const doc: IResolutionDoc = {
            roots,
            selections: resolution.selections.map(sel => ({
              pkg: sel.pkg,
              version: versionToString(sel.version),
              selectedBy: sel.selectedBy,
              reachedVia: sel.reachedVia,
              reachableFrom: sel.reachableFrom,
            })),
          };
          return new FileSet(new Map([[RESOLUTION_FILE, MemoryFile.from(JSON.stringify(doc, undefined, 2))]]));
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
   * Fetch the metadata document for an exact package version. The registry
   * contract is that these are immutable once published, so they are persisted
   * in the build cache and never refreshed.
   */
  private getVersionMetadata(pkg: string, version: string): Computable<INPMPackageMetadata> {
    const key = pkg + "/" + version;
    let result = this.metadataCache.get(key);
    if (!result) {
      result = this.context
        .fetch(`${this.url}/${key}`, "npm:metadata:1", content =>
          readStream(content).then(data => {
            const meta = parseMetadataResponse(data, key);
            return new FileSet(new Map([[METADATA_FILE, MemoryFile.from(JSON.stringify(meta))]]));
          })
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
        .fetch(meta.dist.tarball, "npm:tarball:1", (content, targetDir) => unpackStream(content, targetDir).then(stripArchiveRoot))
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
