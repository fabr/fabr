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

/**
 * The `node_distribution` repository: Node.js itself, as nodejs.org publishes
 * it (`@node:24.22.1`). Each version is a package named `node` with no
 * requirements, whose files are the release for the target platform with its
 * top directory stripped (`bin/node`, `lib/`, `include/`). A version is
 * published where its `SHASUMS256.txt` is, and the archive is checked against
 * that file as it streams.
 */

import {
  Computable,
  FabrError,
  fetchArchive,
  fetchDocument,
  FileSet,
  IProjection,
  lowestSatisfying,
  markerOnProjection,
  Name,
  PackageFileSet,
  PackageFormat,
  parseJson,
  parseVersion,
  Repository,
  RepositoryPublishRef,
  RepositoryReader,
  RepositoryRef,
  RepositoryRegistration,
  Requirement,
  resolveBarePackage,
  MemoryCache,
  RunnableFileSet,
  SEMVER,
  SemverConstraint,
  SemverVersion,
  SymlinkFile,
  TARGET,
  TargetContext,
  toJsonObject,
  tripleToNpm,
  vendPackageRef,
  VersionNotFoundError,
  versionToString,
  NamespaceRef,
  stripArchiveRoot,
} from "@fabr-build/core";

/** Where the Node.js project publishes builds nodejs.org/dist does not carry
 *  (musl, before 22.23.3 / 24.20.0 / 26.8.0, and on arm64), in the same layout. */
export const NODE_UNOFFICIAL_URL = "https://unofficial-builds.nodejs.org/download/release";

/** The one package a node distribution holds. */
const NODE_PACKAGE = "node";

const SHASUMS_FILE = "SHASUMS256.txt";
const INDEX_FILE = "index.json";

/** The archive kinds a release is fetched as, best first. */
const ARCHIVE_SUFFIXES = [".tar.xz", ".tar.gz"];

/** Read a release's SHASUMS256.txt: each artifact's name → its hex sha256.
 *  Throws on a document with no entries, so an error page is never cached. */
function parseShasums(text: string, what: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([0-9a-f]{64}) [ *](\S+)$/.exec(line.trim());
    if (match) {
      sums.set(match[2], match[1]);
    }
  }
  if (sums.size === 0) {
    throw new FabrError(`${what} lists no artifacts`);
  }
  return sums;
}

/** Convert nodejs.org's `index.json` to the versions it lists (`v24.22.1` → `24.22.1`). */
function toNodeVersions(json: unknown): string[] {
  if (!Array.isArray(json)) {
    throw new FabrError("expected an array of releases");
  }
  return json.map(entry => {
    const version = toJsonObject(entry).version;
    if (typeof version !== "string" || !version.startsWith("v")) {
      throw new FabrError(`expected a release version like 'v24.22.1', got ${JSON.stringify(version)}`);
    }
    return version.substring(1);
  });
}

/**
 * Split `<version>[:<projection>]` (the reference after `@node:`): the version
 * runs to the first `:` or `/`, and the package is always `node`.
 */
function splitNodeReference(name: Name): Requirement & { projection?: IProjection } {
  const written = name.toBaseString();
  const colon = written.indexOf(":");
  const slash = written.indexOf("/");
  const boundary = colon === -1 ? slash : slash === -1 ? colon : Math.min(colon, slash);
  if (boundary === -1) {
    return { name: NODE_PACKAGE, versionConstraint: written === "" ? undefined : written };
  }
  const version = written.substring(0, boundary);
  if (version.endsWith("?") || version.endsWith("!")) {
    throw markerOnProjection(name);
  }
  const prefix = written[boundary] === "/" ? version + "/" : "";
  return { name: NODE_PACKAGE, versionConstraint: version, projection: { pattern: name.substring(boundary + 1), prefix } };
}

/** Check a node reference: it states a version or range, and an override marker an exact version. */
function validateNodeRequirement({ versionConstraint, override }: Requirement): void {
  if (versionConstraint === undefined) {
    throw new FabrError("Missing version in Node.js reference (expected '@node:<version-or-range>')");
  }
  if (override !== undefined && SEMVER.exactVersion?.(versionConstraint) === undefined) {
    throw new FabrError(`'${versionConstraint}' is not a valid override for Node.js: a marker needs an exact version`);
  }
  try {
    SEMVER.parseConstraint(versionConstraint);
  } catch {
    throw new FabrError(`'${versionConstraint}' is not a valid Node.js version or range`);
  }
}

/**
 * Make a node release runnable: the release itself is the install, launched
 * directly, its entry selected by path (`@node:24.22.1:bin/node`). The
 * release's own symlinks (`bin/npm`) stay in the install but are no entry:
 * a runnable reads a symlink on its surface as a bin, whose target is an
 * install path, where these are relative to the link.
 */
function makeNodeRunnable(pkg: PackageFileSet): Computable<RunnableFileSet> {
  const surface = new FileSet(new Map([...pkg].filter(([, file]) => !(file instanceof SymlinkFile))));
  return Computable.resolve(new RunnableFileSet(pkg, [], undefined, "", surface));
}

/** The format of a node distribution: semver versions of the one package `node`. */
export const NODE_FORMAT: PackageFormat<SemverVersion, SemverConstraint> = {
  ...SEMVER,
  resolutionTag: "node:resolve:1",
  splitReference: splitNodeReference,
  validateRequirement: validateNodeRequirement,
  parsePublishCoordinate: () => {
    throw new FabrError("Node.js releases cannot be published to");
  },
  readContentPackage: () => Computable.reject(new FabrError("content cannot be read as a Node.js release")),
  makeRunnable: makeNodeRunnable,
};

/**
 * The repository a `node_distribution` declaration builds: a
 * {@link RepositoryReader} over nodejs.org's release tree, falling back to
 * unofficial-builds for a platform nodejs.org does not publish.
 */
export class NodeDistribution implements Repository, RepositoryReader<SemverVersion, SemverConstraint> {
  public readonly format = NODE_FORMAT;
  /** Each release's SHASUMS256.txt from each source, as read this run. */
  private readonly shasums = new MemoryCache<string, Map<string, string> | undefined>();
  /** The published versions, as read this run. */
  private readonly versions = new MemoryCache<string, SemverVersion[]>();

  constructor(
    private readonly context: TargetContext,
    private readonly url: string,
    private readonly unofficialUrl = NODE_UNOFFICIAL_URL
  ) {}

  public get identity(): string {
    return this.url;
  }

  public get name(): string {
    return this.context.name;
  }

  public get operation(): string {
    return this.context.operation;
  }

  public getRepositoryRef(name: Name): RepositoryRef | NamespaceRef {
    return vendPackageRef(this, this.format, name);
  }

  public getRepositoryPublishRef(): RepositoryPublishRef {
    throw new FabrError(`${this.name} cannot be published to`);
  }

  /** Name the target platform, which decides the archive a version is fetched as. */
  public environmentKey(): Computable<string> {
    return this.platform();
  }

  /** Get the requirements of a release, which are none, once its SHASUMS256.txt
   *  shows it is published. */
  public getRequirements(_pkg: string, version: SemverVersion): Computable<Requirement[]> {
    const exact = versionToString(version);
    return this.releaseShasums(this.url, exact).then(sums => {
      if (sums === undefined) {
        throw new VersionNotFoundError(NODE_PACKAGE, exact, `Node.js ${exact} is not published at ${this.url}`);
      }
      return [];
    });
  }

  public lowestAvailable(_pkg: string, constraint: string): Computable<SemverVersion | undefined> {
    let parsed: SemverConstraint;
    try {
      parsed = SEMVER.parseConstraint(constraint);
    } catch {
      return Computable.resolve(undefined);
    }
    return this.publishedVersions().then(versions => lowestSatisfying(versions, parsed));
  }

  public availableVersions(): Computable<SemverVersion[] | undefined> {
    return this.publishedVersions();
  }

  public fetchFiles(reference: RepositoryRef): Computable<FileSet> {
    return Computable.resolve(undefined).then(() => resolveBarePackage(this, reference));
  }

  /** Fetch a release for the target platform, verified against its SHASUMS256.txt. */
  public fetch(_pkg: string, version: SemverVersion): Computable<PackageFileSet> {
    const exact = versionToString(version);
    return this.platform()
      .then(platform => this.artifact(exact, platform))
      .then(({ url, sha256 }) =>
        fetchArchive(this.context, {
          key: url,
          tag: "node:release:1",
          report: { resource: "Node.js", role: "content" },
          source: () => Computable.resolve({ url, expected: { algorithm: "sha256", encoding: "hex", value: sha256 } }),
          keep: stripArchiveRoot,
        })
      )
      .then(files => new PackageFileSet(files, NODE_PACKAGE, exact));
  }

  /** Name the target platform as node's release archives do: `darwin-arm64`, `linux-x64-musl`. */
  private platform(): Computable<string> {
    return this.context.getGlobalString(TARGET).then(triple => {
      const { os, cpu, libc } = tripleToNpm(triple);
      if ((os !== "darwin" && os !== "linux") || (cpu !== "x64" && cpu !== "arm64")) {
        throw new FabrError(`Node.js releases are not available for '${triple}'`).withHelp(
          "set NODE to a node binary for this platform"
        );
      }
      return libc === "musl" ? `${os}-${cpu}-musl` : `${os}-${cpu}`;
    });
  }

  /** Find a release's archive for `platform`: from nodejs.org where it lists
   *  one, else from unofficial-builds. */
  private artifact(version: string, platform: string): Computable<{ url: string; sha256: string }> {
    const find = (sums: Map<string, string> | undefined, base: string): { url: string; sha256: string } | undefined => {
      for (const suffix of ARCHIVE_SUFFIXES) {
        const file = `node-v${version}-${platform}${suffix}`;
        const sha256 = sums?.get(file);
        if (sha256 !== undefined) {
          return { url: `${base}/v${version}/${file}`, sha256 };
        }
      }
      return undefined;
    };
    return this.releaseShasums(this.url, version).then(sums => {
      if (sums === undefined) {
        throw new VersionNotFoundError(NODE_PACKAGE, version, `Node.js ${version} is not published at ${this.url}`);
      }
      return (
        find(sums, this.url) ??
        this.releaseShasums(this.unofficialUrl, version).then(unofficial => {
          const found = find(unofficial, this.unofficialUrl);
          if (found === undefined) {
            throw new FabrError(`Node.js ${version} is not published for ${platform}`).withHelp(
              "choose another version, or set NODE to a node binary for this platform"
            );
          }
          return found;
        })
      );
    });
  }

  /** Read a release's SHASUMS256.txt from `base`, or undefined where it has none (a 404). */
  private releaseShasums(base: string, version: string): Computable<Map<string, string> | undefined> {
    const url = `${base}/v${version}/${SHASUMS_FILE}`;
    return this.shasums.getOrCreate(url, () =>
      fetchDocument(this.context, {
        url,
        file: SHASUMS_FILE,
        tag: "node:shasums:1",
        report: { resource: "checksums", role: "index" },
        convert: text => parseShasums(text, url),
      })
    );
  }

  /** List the published versions, from nodejs.org's `index.json` (revalidated). */
  private publishedVersions(): Computable<SemverVersion[]> {
    const url = `${this.url}/${INDEX_FILE}`;
    return this.versions.getOrCreate(url, () =>
      fetchDocument(this.context, {
        url,
        file: INDEX_FILE,
        tag: "node:versions:1",
        report: { resource: "version list", role: "index" },
        convert: text => parseJson(text, `release list from ${this.url}`, toNodeVersions),
        options: { immutable: false },
      }).then(listed =>
        (listed ?? []).flatMap(text => {
          try {
            return [parseVersion(text)];
          } catch {
            return [];
          }
        })
      )
    );
  }
}

function createRepository(context: TargetContext): Computable<Repository> {
  return context.getRequiredString("url").then(url => new NodeDistribution(context, url.replace(/\/+$/, "")));
}

export const nodeDistributionRegistration: RepositoryRegistration = { type: "node_distribution", provider: createRepository };
