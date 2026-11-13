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
 * `include/`). A version is published where its `SHASUMS256.txt` is, and the
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

/** Where the Node.js project publishes builds nodejs.org/dist does not carry
 *  (musl, before 22.23.3 / 24.20.0 / 26.8.0, and on arm64), in the same layout. */
export const NODE_UNOFFICIAL_URL = "https://unofficial-builds.nodejs.org/download/release";

/** The one package a node distribution holds. */
const NODE_PACKAGE = "node";

const SHASUMS_FILE = "SHASUMS256.txt";
const INDEX_FILE = "index.json";

/** The archive kinds a release is fetched as, best first. */
const ARCHIVE_SUFFIXES = [".tar.xz", ".tar.gz"];

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
 * The repository a `node_distribution` declaration builds: nodejs.org's
 * release tree, falling back to unofficial-builds for a platform nodejs.org
 * does not publish.
 */
export class NodeDistribution extends Distribution<SemverVersion, SemverConstraint> {
  protected readonly packageName = NODE_PACKAGE;
  protected readonly title = "Node.js";
  protected readonly domain = SEMVER;
  protected readonly archiveTag = "node:release:1";
  protected readonly unavailableHelp = "set NODE to a node binary for this platform";
  protected readonly binDirectories = ["bin/"];
  /** Each release's SHASUMS256.txt from each source, as read this run. */
  private readonly shasums = new MemoryCache<string, Map<string, string> | undefined>();

  constructor(
    context: TargetContext,
    url: string,
    private readonly unofficialUrl = NODE_UNOFFICIAL_URL
  ) {
    super(context, url);
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

  /** Find a release's archive for `target`: from nodejs.org where its
   *  SHASUMS256.txt lists one, else from unofficial-builds. */
  protected findArchive(version: string, target: string): Computable<IDownloadSource> {
    const platform = this.platformOf(target);
    if (platform === undefined) {
      return Computable.reject(this.unavailable(target));
    }
    const find = (sums: Map<string, string> | undefined, base: string): IDownloadSource | undefined => {
      for (const suffix of ARCHIVE_SUFFIXES) {
        const file = `node-v${version}-${platform}${suffix}`;
        const sha256 = sums?.get(file);
        if (sha256 !== undefined) {
          return { url: `${base}/v${version}/${file}`, expected: { algorithm: "sha256", encoding: "hex", value: sha256 } };
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
            throw new FabrError(`Node.js ${version} is not published for ${target}`).withHelp(
              "choose another version, or set NODE to a node binary for this platform"
            );
          }
          return found;
        })
      );
    });
  }

  /** @return the target platform as node's release archives name it (`darwin-arm64`, `linux-x64-musl`), or undefined where nodejs.org publishes none for it. */
  private platformOf(target: string): string | undefined {
    const { os, cpu, libc } = tripleToNpm(target);
    if ((os !== "darwin" && os !== "linux") || (cpu !== "x64" && cpu !== "arm64")) {
      return undefined;
    }
    return libc === "musl" ? `${os}-${cpu}-musl` : `${os}-${cpu}`;
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
  return context.getRequiredString("url").then(url => new NodeDistribution(context, url.replace(/\/+$/, "")));
}

/** The implementation JS.fabr's `repository` declaration names. */
export default { provider: createRepository } satisfies RepositoryImplementation;
