import { Computable } from "../../core/Computable";
import { readStream } from "../../core/Fetch";
import { FileSet, FileSource } from "../../core/FileSet";
import { MemoryFile } from "../../core/MemoryFS";
import { TargetContext } from "../../model/BuildContext";
import { Name } from "../../model/Name";
import { resolveMVS } from "../../resolver/MVSResolver";
import { IResolutionOrigin, PACKAGE_RESOLUTION_PROVENANCE } from "../../resolver/ResolutionProvenance";
import { parseVersion, SEMVER, SemverVersion, versionToString } from "../../resolver/Semver";
import { IRequirementEdge, PackageRegistry, Requirement, Selected } from "../../resolver/Types";
import { unpackStream } from "../../support/Unpack";
import { registerTargetRule } from "../Registry";

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
}

class NPMRepository implements FileSource, PackageRegistry<SemverVersion> {
  private url: string;
  private context: TargetContext;
  /* In-process memo over the persistent metadata cache, keyed by "pkg/version" */
  private metadataCache: Map<string, Computable<INPMPackageMetadata>>;

  constructor(url: string, context: TargetContext) {
    this.url = url.replace(/\/+$/, "");
    this.context = context;
    this.metadataCache = new Map();
  }

  /**
   * Resolve a package requirement of the form "<name>:<constraint>" to the full
   * transitive dependency closure (by minimal version selection), and return the
   * union of all resolved package contents laid out as "<name>/..." paths.
   *
   * Only semver versions/ranges are accepted: dist-tags (e.g. 'latest') are
   * mutable pointers and would make the build non-deterministic, so they are
   * deliberately not supported. This also means every document we fetch from the
   * repository is immutable, and so cacheable indefinitely with no refresh policy.
   */
  public find(name: Name): Computable<FileSet> {
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
    return this.getResolution(pkg, constraint).then(selections => {
      const origin: IResolutionOrigin<SemverVersion> = {
        kind: PACKAGE_RESOLUTION_PROVENANCE,
        repository: this.url,
        root: { pkg, constraint },
        selections,
        versionToString,
        packageOfPath: npmPackageOfPath,
      };
      return Computable.forAll(
        selections.map(sel => this.fetch(sel.pkg, sel.version)),
        (...sets: FileSet[]) => FileSet.unionAll(...sets).withOrigin(origin)
      );
    });
  }

  public get(name: string): Computable<undefined> {
    return Computable.resolve(undefined);
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
   * the result is a pure function of the root requirement and the (immutable)
   * declared metadata of the packages it reaches, so a cached resolution can only
   * become wrong if the requirement itself changes — which changes the cache key.
   * Failed resolutions are not cached (the error propagates before anything is
   * written), so transient repository problems don't poison the cache.
   */
  private getResolution(pkg: string, constraint: string): Computable<Selected<SemverVersion>[]> {
    return this.context
      .getCachedOrBuild(`fabr:resolve:npm ${this.url} ${pkg}:${constraint}`, () =>
        resolveMVS([{ pkg, constraint }], SEMVER, this).then(resolution => {
          if (resolution.errors.length > 0) {
            throw new Error(`Unable to resolve ${pkg}:${constraint}:\n  ${resolution.errors.join("\n  ")}`);
          }
          checkSingleVersions(resolution.selections, `${pkg}:${constraint}`);
          const doc: IResolutionEntry[] = resolution.selections.map(sel => ({
            pkg: sel.pkg,
            version: versionToString(sel.version),
            selectedBy: sel.selectedBy,
            reachedVia: sel.reachedVia,
          }));
          return new FileSet(new Map([[RESOLUTION_FILE, MemoryFile.from(JSON.stringify(doc, undefined, 2))]]));
        })
      )
      .then(files => files.readFile(RESOLUTION_FILE))
      .then(data => {
        const doc = JSON.parse(data) as IResolutionEntry[];
        return doc.map(entry => ({
          pkg: entry.pkg,
          version: parseVersion(entry.version),
          selectedBy: entry.selectedBy,
          reachedVia: entry.reachedVia,
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
        .getCachedOrFetch(`${this.url}/${key}`, content =>
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

  private fetch(pkg: string, version: SemverVersion): Computable<FileSet> {
    return this.getVersionMetadata(pkg, versionToString(version)).then(meta =>
      this.context.getCachedOrFetch(meta.dist.tarball, (content, targetDir) =>
        unpackStream(content, targetDir).then(fs => remapFilenames(fs, meta.name))
      )
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
 * The resolved closure is laid out as a flat node_modules, which can only host a
 * single version of each package; check for multiple selected versions (of
 * different majors) and fail with something actionable rather than letting the
 * FileSet union report an opaque path conflict.
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
 * The package owning a path within a resolved closure, per the node_modules
 * naming convention this repository lays files out with ("@scope/name/..." or
 * "name/...").
 */
export function npmPackageOfPath(path: string): string {
  const parts = path.split("/");
  return parts[0].startsWith("@") && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0];
}

function createRepository(context: TargetContext): Computable<NPMRepository> {
  return context.getRequiredString("url").then(url => new NPMRepository(url, context));
}

function remapFilenames(files: FileSet, packageName: string): FileSet {
  return files.remap(name => {
    const idx = name.indexOf("/");
    if (idx !== -1) {
      return packageName + name.substring(idx);
    } else {
      return undefined;
    }
  });
}

registerTargetRule("npm_repository", {}, createRepository);
