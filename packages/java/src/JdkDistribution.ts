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
 * The `jdk_distribution` repository: Eclipse Temurin JDKs, as the Adoptium
 * API publishes them. A reference names a release by the API's own name for
 * it, less its `jdk-` (or, for Java 8, `jdk`) prefix: `@jdk:17.0.12+7` is
 * `jdk-17.0.12+7`, `@jdk:8u302-b08` is `jdk8u302-b08`. It is looked up as
 * written: the release for the target platform, its top directory stripped,
 * checked against the digest the API states. Nothing is selected or
 * resolved; `@jdk` on its own lists the releases.
 *
 * Run, a release offers each command in its home's `bin/` by name
 * (`@jdk:17.0.12+7:javac`), wherever the home is (`Contents/Home/` on macOS),
 * and on Windows without its `.exe`.
 */

import {
  Computable,
  FabrError,
  fetchArchive,
  fetchDocument,
  FileSet,
  IFile,
  markerOnProjection,
  MemoryCache,
  Name,
  NamespaceRef,
  parseJson,
  Reference,
  Repository,
  RepositoryLookup,
  RepositoryPublishRef,
  RepositoryRef,
  RepositoryRegistration,
  RunnableFileSet,
  stripArchiveRoot,
  SymlinkFile,
  TARGET,
  TargetContext,
  toJsonObject,
  tripleToNpm,
} from "@fabr-build/core";

/** The one package a JDK distribution holds. */
const JDK_PACKAGE = "jdk";

/** What a reference may name a release with: no path or projection characters. */
const RELEASE_PATTERN = /^[0-9][0-9A-Za-z.+_-]*$/;

/** How many releases are asked for per page (the API may list fewer). */
const PAGE_SIZE = 50;
/** How many pages of releases are read before the listing is taken for runaway. */
const MAX_PAGES = 100;

/** The query naming the JDK builds this repository serves, beside the platform. */
const BUILD_QUERY = "image_type=jdk&jvm_impl=hotspot&heap_size=normal&vendor=eclipse&project=jdk&release_type=ga";

/** Where a release's home is, in the order looked for, within its archive's top directory. */
const HOMES = ["Contents/Home/", ""];
/** The suffix a Windows command carries, which the surface leaves off its name. */
const EXE = ".exe";

interface Platform {
  readonly os: string;
  readonly architecture: string;
}

/** @return the API's name for the release a reference names (`17.0.12+7` → `jdk-17.0.12+7`, `8u302-b08` → `jdk8u302-b08`). */
function releaseNameOf(release: string): string {
  return /^\d+u/.test(release) ? `jdk${release}` : `jdk-${release}`;
}

/** @return how a reference names the release the API calls `name`; the inverse of {@link releaseNameOf}. */
function releaseOf(name: string): string {
  return name.replace(/^jdk-?/, "");
}

/** Convert a page of the API's release names to the releases it lists. */
function toReleases(json: unknown): string[] {
  const releases = toJsonObject(json).releases;
  if (!Array.isArray(releases) || !releases.every((name): name is string => typeof name === "string" && name.startsWith("jdk"))) {
    throw new FabrError("expected a 'releases' array of names");
  }
  return releases.map(releaseOf);
}

/** Convert the API's assets for one release to the archive it offers: its url and sha256. */
function toArchive(json: unknown): { url: string; sha256: string } {
  const binaries = toJsonObject(json).binaries;
  if (!Array.isArray(binaries) || binaries.length === 0) {
    throw new FabrError("expected a release with a binary");
  }
  const pkg = toJsonObject(toJsonObject(binaries[0]).package);
  const { link, checksum } = pkg;
  if (typeof link !== "string" || typeof checksum !== "string" || !/^[0-9a-f]{64}$/.test(checksum)) {
    throw new FabrError("expected a package with a 'link' and a sha256 'checksum'");
  }
  if (!link.endsWith(".tar.gz") && !link.endsWith(".zip")) {
    throw new FabrError(`the release is published as ${link.substring(link.lastIndexOf("/") + 1)}, which fabr cannot unpack`);
  }
  return { url: link, sha256: checksum };
}

/**
 * Make a JDK runnable: the release is the install, and its surface offers
 * each command in its home's `bin/` by name (`javac`, for `javac.exe` too), as
 * well as every file by path. A command is an executable file there, or on
 * Windows, whose archives record no modes, an `.exe`.
 */
export function makeJdkRunnable(release: FileSet): RunnableFileSet {
  const bin = `${HOMES.find(prefix => release.getFile(`${prefix}bin/java`) !== undefined || release.getFile(`${prefix}bin/java${EXE}`) !== undefined) ?? ""}bin/`;
  const files = [...release].filter(([, file]) => !(file instanceof SymlinkFile));
  const commands = files
    .filter(([name, file]) => name.startsWith(bin) && !name.substring(bin.length).includes("/") && (name.endsWith(EXE) || (file.mode & 0o111) !== 0))
    .map(([name]): [string, IFile] => {
      const command = name.substring(bin.length);
      return [command.endsWith(EXE) ? command.slice(0, -EXE.length) : command, new SymlinkFile(name)];
    });
  return new RunnableFileSet(release, [], undefined, "", new FileSet(new Map([...files, ...commands])));
}

export class JdkDistribution implements Repository, RepositoryLookup {
  private readonly releases = new MemoryCache<string, string[]>();

  constructor(
    private readonly context: TargetContext,
    private readonly url: string
  ) {}

  private get name(): string {
    return this.context.name;
  }

  /** Vend the reference to the release `name` names (`17.0.12+7`), with any
   *  projection after it, or the namespace of every release. */
  public getRepositoryRef(name: Name): RepositoryRef | NamespaceRef {
    if (name.getMarker() !== undefined) {
      throw new FabrError(`'${name.toString()}' names a JDK release, which is looked up, not resolved, so an override marker means nothing on it`).withHelp(
        "write the reference without the marker"
      );
    }
    const written = name.toBaseString();
    if (written === "") {
      return new NamespaceRef(this, "");
    }
    const colon = written.indexOf(":");
    const slash = written.indexOf("/");
    const boundary = colon === -1 ? slash : slash === -1 ? colon : Math.min(colon, slash);
    if (boundary === -1) {
      return new RepositoryRef(this, { name: JDK_PACKAGE, versionConstraint: written });
    }
    const release = written.substring(0, boundary);
    if (release.endsWith("?") || release.endsWith("!")) {
      throw markerOnProjection(name);
    }
    const prefix = written[boundary] === "/" ? release + "/" : "";
    return new RepositoryRef(this, { name: JDK_PACKAGE, versionConstraint: release }).find(name.substring(boundary + 1), prefix);
  }

  public getRepositoryPublishRef(): RepositoryPublishRef {
    throw new FabrError(`${this.name} cannot be published to`);
  }

  /** List the releases published for the target platform, newest first, as the API orders them. */
  public children(): Computable<Map<string, Reference>> {
    return this.publishedReleases().then(
      releases => new Map(releases.map((release): [string, Reference] => [release, new RepositoryRef(this, { name: JDK_PACKAGE, versionConstraint: release })]))
    );
  }

  /** Fetch the release a reference names for the target platform: its runnable under `run`, else its files. */
  public resolve(reference: RepositoryRef): Computable<FileSet> {
    const release = reference.versionConstraint ?? "";
    if (!RELEASE_PATTERN.test(release)) {
      return Computable.reject(
        new FabrError(`'${release}' does not name a JDK release`).withHelp("name one as `fabr ls @jdk` lists them, as in '@jdk:21.0.12.1+1'")
      );
    }
    return this.platform()
      .then(platform =>
        fetchArchive(this.context, {
          key: `${this.url} ${release} ${platform.os}-${platform.architecture}`,
          tag: "jdk:release:1",
          report: { resource: "JDK", role: "content" },
          source: () =>
            this.archive(release, platform).then(({ url, sha256 }) => ({
              url,
              expected: { algorithm: "sha256", encoding: "hex" as const, value: sha256 },
            })),
          keep: stripArchiveRoot,
        })
      )
      .then(files => (this.context.operation === "run" ? makeJdkRunnable(files) : files));
  }

  /** Name the target platform as the Adoptium API does: `mac`/`linux`/`alpine-linux`/`windows`, `x64`/`aarch64`. */
  private platform(): Computable<Platform> {
    return this.context.getGlobalString(TARGET).then(triple => {
      const { os, cpu, libc } = tripleToNpm(triple);
      const architecture = cpu === "x64" ? "x64" : cpu === "arm64" ? "aarch64" : undefined;
      const adoptiumOs =
        os === "darwin" ? "mac" : os === "linux" ? (libc === "musl" ? "alpine-linux" : "linux") : os === "win32" ? "windows" : undefined;
      if (architecture === undefined || adoptiumOs === undefined) {
        throw new FabrError(`JDK releases are not available for '${triple}'`).withHelp("set JAVA and JAVAC to a JDK for this platform");
      }
      return { os: adoptiumOs, architecture };
    });
  }

  private platformQuery({ os, architecture }: Platform): string {
    return `os=${os}&architecture=${architecture}&${BUILD_QUERY}`;
  }

  /** Find a release's archive for `platform`, by the API's name for it. */
  private archive(release: string, platform: Platform): Computable<{ url: string; sha256: string }> {
    const url = `${this.url}/v3/assets/release_name/eclipse/${encodeURIComponent(releaseNameOf(release))}?${this.platformQuery(platform)}`;
    return fetchDocument(this.context, {
      url,
      file: "assets.json",
      tag: "jdk:assets:2",
      report: { resource: "release", role: "index" },
      convert: text => parseJson(text, `JDK ${release} release from ${this.url}`, toArchive),
    }).then(archive => {
      if (archive === undefined) {
        throw new FabrError(`JDK ${release} is not published for ${platform.os}-${platform.architecture}`).withHelp(
          "`fabr ls @jdk` lists the releases published for the target platform"
        );
      }
      return archive;
    });
  }

  /** List the releases published for the target platform, newest first, page by page (revalidated). */
  private publishedReleases(): Computable<string[]> {
    return this.platform().then(platform => {
      const query = this.platformQuery(platform);
      return this.releases.getOrCreate(query, () => this.releasePages(query, 0, []));
    });
  }

  private releasePages(query: string, page: number, listed: string[]): Computable<string[]> {
    if (page >= MAX_PAGES) {
      throw new FabrError(`${this.url} lists more than ${MAX_PAGES * PAGE_SIZE} JDK releases`);
    }
    const url = `${this.url}/v3/info/release_names?${query}&sort_order=DESC&page_size=${PAGE_SIZE}&page=${page}`;
    return fetchDocument(this.context, {
      url,
      file: "versions.json",
      tag: "jdk:releases:1",
      report: { resource: "version list", role: "index" },
      convert: text => parseJson(text, `JDK release list from ${this.url}`, toReleases),
      options: { immutable: false },
    }).then(releases => {
      /* The listing ends where a page is missing or empty: the API caps a page below what is asked. */
      return releases === undefined || releases.length === 0 ? listed : this.releasePages(query, page + 1, [...listed, ...releases]);
    });
  }
}

function createRepository(context: TargetContext): Computable<Repository> {
  return context.getRequiredString("url").then(url => new JdkDistribution(context, url.replace(/\/+$/, "")));
}

export const jdkDistributionRegistration: RepositoryRegistration = { type: "jdk_distribution", provider: createRepository };

/** The implementation JAVA.fabr's `repository` declaration names. */
export default createRepository;
