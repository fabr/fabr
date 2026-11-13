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
 * it (`@node:24.22.1`, or `@node:22` for the lowest 22 release). Each version
 * is a package named `node` with no requirements, whose files are the release
 * for the target platform with its top directory stripped (`bin/node`, `lib/`,
 * `include/`; on Windows `node.exe` at the root). A version is published where its `SHASUMS256.txt` is, and the
 * archive is checked against that file as it streams.
 */

import {
  Computable,
  Distribution,
  FabrError,
  fetchDocument,
  IDownloadSource,
  MemoryCache,
  parseJson,
  Repository,
  RepositoryImplementation,
  SEMVER,
  SemverConstraint,
  SemverVersion,
  TargetContext,
  toJsonObject,
  tripleToNpm,
  VersionNotFoundError,
} from "@fabr-build/core";

/** The one package a node distribution holds. */
const NODE_PACKAGE = "node";

const SHASUMS_FILE = "SHASUMS256.txt";
const INDEX_FILE = "index.json";

/** The operating systems node publishes releases for, as its archives name them. */
const RELEASE_OSES = new Set(["darwin", "linux", "win", "aix"]);

/** Node's name in its archives for each npm cpu it publishes releases for. */
const RELEASE_CPUS = new Map([
  ["x64", "x64"],
  ["arm64", "arm64"],
  ["ia32", "x86"],
  ["arm", "armv7l"],
  ["ppc64", "ppc64"],
  ["s390x", "s390x"],
  ["riscv64", "riscv64"],
  ["loong64", "loong64"],
]);

/** The archive kinds a release is fetched as, best first. */
const ARCHIVE_SUFFIXES = [".tar.xz", ".tar.gz"];
/** The archive kind a Windows release is fetched as. */
const WINDOWS_ARCHIVE_SUFFIXES = [".zip"];

/** Read a release's SHASUMS256.txt: each artifact's hex sha256, by name.
 *  Throws for a document listing none, such as an error page. */
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
 * The repository a `node_distribution` declaration builds: release trees laid
 * out as nodejs.org/dist is, each tried in order for a release's archive (the
 * Node.js project's unofficial builds after nodejs.org), the first listing
 * the versions.
 */
export class NodeDistribution extends Distribution<SemverVersion, SemverConstraint> {
  protected readonly packageName = NODE_PACKAGE;
  protected readonly title = "Node.js";
  protected readonly domain = SEMVER;
  protected readonly archiveTag = "node:release:1";
  protected readonly unavailableHelp = "set NODE to a node binary for this platform";
  /** A Windows release keeps its commands at its root. */
  protected readonly binDirectories = ["bin/", ""];
  /** Each release's SHASUMS256.txt from each source, as read this run. */
  private readonly shasums = new MemoryCache<string, Map<string, string> | undefined>();

  constructor(
    context: TargetContext,
    /** The release trees, in the order a release's archive is looked for in them; the first lists the versions. */
    private readonly urls: readonly [string, ...string[]]
  ) {
    super(context, urls[0]);
  }

  /** List the published versions, from nodejs.org's `index.json`, which lists every platform's. */
  protected listVersions(_target: string, revalidate: boolean): Computable<string[]> {
    const url = `${this.url}/${INDEX_FILE}`;
    return fetchDocument(this.context, {
      url,
      file: INDEX_FILE,
      tag: "node:versions:1",
      report: { resource: "version list", role: "index" },
      convert: text => parseJson(text, `release list from ${this.url}`, toNodeVersions),
      options: { immutable: false, forceRevalidate: revalidate },
    }).then(listed => listed ?? []);
  }

  /** Find a release's archive for `target`: from the first release tree whose
   *  SHASUMS256.txt lists one. */
  protected findArchive(version: string, target: string): Computable<IDownloadSource> {
    const platform = this.platformOf(target);
    if (platform === undefined) {
      return Computable.reject(this.unavailable(target));
    }
    const suffixes = platform.startsWith("win-") ? WINDOWS_ARCHIVE_SUFFIXES : ARCHIVE_SUFFIXES;
    const find = (sums: Map<string, string> | undefined, base: string): IDownloadSource | undefined => {
      for (const suffix of suffixes) {
        const file = `node-v${version}-${platform}${suffix}`;
        const sha256 = sums?.get(file);
        if (sha256 !== undefined) {
          return { url: `${base}/v${version}/${file}`, expected: { algorithm: "sha256", encoding: "hex", value: sha256 } };
        }
      }
      return undefined;
    };
    /* Look in each tree from `at` on; `published` is whether one before it has the version at all. */
    const search = (at: number, published: boolean): Computable<IDownloadSource> => {
      if (at === this.urls.length) {
        return Computable.reject(
          published
            ? new FabrError(`Node.js ${version} is not published for ${target}`).withHelp(
                "choose another version, or set NODE to a node binary for this platform"
              )
            : new VersionNotFoundError(NODE_PACKAGE, version, `Node.js ${version} is not published at ${this.urls.join(" or ")}`)
        );
      }
      const base = this.urls[at];
      return this.releaseShasums(base, version).then(sums => find(sums, base) ?? search(at + 1, published || sums !== undefined));
    };
    return search(0, false);
  }

  /**
   * @return the target platform as node's release archives name it
   * (`darwin-arm64`, `linux-x64-musl`, `linux-ppc64le`, `win-x64`, `aix-ppc64`),
   * or undefined where node names no such platform. Whether a release is
   * published for it is its SHASUMS256.txt's to say.
   */
  private platformOf(target: string): string | undefined {
    const { os, cpu, libc } = tripleToNpm(target);
    const releaseOs = os === "win32" ? "win" : os;
    /* npm reads both byte orders of ppc64 as `ppc64`; node's archives tell them apart. */
    const releaseCpu =
      cpu === "ppc64" && /^(powerpc64le|ppc64le)$/.test(target.split("-")[0]) ? "ppc64le" : RELEASE_CPUS.get(cpu ?? "");
    if (releaseOs === undefined || !RELEASE_OSES.has(releaseOs) || releaseCpu === undefined) {
      return undefined;
    }
    return libc === "musl" ? `${releaseOs}-${releaseCpu}-musl` : `${releaseOs}-${releaseCpu}`;
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
}

function createRepository(context: TargetContext): Computable<Repository> {
  return context.getRequiredProperty("url").then(prop => {
    const [first, ...rest] = prop.getValues().map(url => url.replace(/\/+$/, ""));
    if (first === undefined) {
      throw new FabrError("Missing required property url");
    }
    return new NodeDistribution(context, [first, ...rest]);
  });
}

/** The implementation JS.fabr's `repository` declaration names. */
export default { provider: createRepository } satisfies RepositoryImplementation;
