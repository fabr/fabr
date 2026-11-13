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
 * `jdk-17.0.12+7`, `@jdk:8u302-b08` is `jdk8u302-b08`. A prefix of version
 * numbers names the lowest release starting with them (`@jdk:21`,
 * `@jdk:17.0.12`, `@jdk:8u302`). The release is the one for the target
 * platform, checked against the digest the API states.
 *
 * Under `run`, a release offers each command in its home's `bin/` by name
 * (`@jdk:17.0.12+7:javac`), wherever the home is (`Contents/Home/` on macOS),
 * and on Windows without its `.exe`.
 */

import {
  Computable,
  Distribution,
  FabrError,
  fetchDocument,
  IDownloadSource,
  parseJson,
  Repository,
  RepositoryImplementation,
  TargetContext,
  toJsonObject,
  tripleToNpm,
} from "@fabr-build/core";
import { JDK_VERSIONS, JdkConstraint, JdkVersion } from "./JdkVersion";

/** How many releases are asked for per page (the API may list fewer). */
const PAGE_SIZE = 50;
/** How many pages of releases are read before the listing is refused as too long. */
const MAX_PAGES = 100;

/** The query naming the JDK builds this repository serves, beside the platform. */
const BUILD_QUERY = "image_type=jdk&jvm_impl=hotspot&heap_size=normal&vendor=eclipse&project=jdk&release_type=ga";

/** Where a release keeps its commands, in the order looked for, within its archive's top directory. */
export const JDK_BIN_DIRECTORIES = ["Contents/Home/bin/", "bin/"];

/** A platform as the Adoptium API names it. */
interface IJdkPlatform {
  /** `mac`, `linux`, `alpine-linux` or `windows`. */
  readonly os: string;
  /** `x64` or `aarch64`. */
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

/** A `jdk_distribution` repository: the Temurin releases the Adoptium API at `url` publishes. */
export class JdkDistribution extends Distribution<JdkVersion, JdkConstraint> {
  protected readonly packageName = "jdk";
  protected readonly title = "JDK";
  protected readonly domain = JDK_VERSIONS;
  protected readonly archiveTag = "jdk:release:1";
  protected readonly unavailableHelp = "set JAVA and JAVAC to a JDK for this platform";
  protected readonly binDirectories = JDK_BIN_DIRECTORIES;

  constructor(context: TargetContext, url: string) {
    super(context, url);
  }

  /** List the releases published for `target`, page by page. */
  protected listVersions(target: string, revalidate: boolean): Computable<string[]> {
    return Computable.resolve(undefined).then(() => this.releasePages(this.platformQuery(target), revalidate, 0, []));
  }

  /** Find a release's archive for `target`, by the API's name for it. */
  protected findArchive(release: string, target: string): Computable<IDownloadSource> {
    return Computable.resolve(undefined).then(() => this.assets(release, target));
  }

  /** Find a release's archive for `target` in the API's assets document for it. */
  private assets(release: string, target: string): Computable<IDownloadSource> {
    const url = `${this.url}/v3/assets/release_name/eclipse/${encodeURIComponent(releaseNameOf(release))}?${this.platformQuery(target)}`;
    return fetchDocument(this.context, {
      url,
      file: "assets.json",
      tag: "jdk:assets:2",
      report: { resource: "release", role: "index" },
      convert: text => parseJson(text, `JDK ${release} release from ${this.url}`, toArchive),
    }).then(archive => {
      if (archive === undefined) {
        throw new FabrError(`JDK ${release} is not published for ${target}`).withHelp(
          "`fabr ls @jdk` lists the releases published for the target platform"
        );
      }
      return { url: archive.url, expected: { algorithm: "sha256", encoding: "hex", value: archive.sha256 } };
    });
  }

  /** Get the query naming `target` as the API does; throws {@link unavailable} where it publishes nothing for it. */
  private platformQuery(target: string): string {
    const platform = this.platformOf(target);
    if (platform === undefined) {
      throw this.unavailable(target);
    }
    return `os=${platform.os}&architecture=${platform.architecture}&${BUILD_QUERY}`;
  }

  /** @return the target platform as the Adoptium API names it (`mac`/`linux`/`alpine-linux`/`windows`, `x64`/`aarch64`), or undefined where it publishes none for it. */
  private platformOf(target: string): IJdkPlatform | undefined {
    const { os, cpu, libc } = tripleToNpm(target);
    const architecture = cpu === "x64" ? "x64" : cpu === "arm64" ? "aarch64" : undefined;
    const adoptiumOs =
      os === "darwin" ? "mac" : os === "linux" ? (libc === "musl" ? "alpine-linux" : "linux") : os === "win32" ? "windows" : undefined;
    return architecture === undefined || adoptiumOs === undefined ? undefined : { os: adoptiumOs, architecture };
  }

  /** List the releases from page `page` on, after `listed`; throws past {@link MAX_PAGES}. */
  private releasePages(query: string, revalidate: boolean, page: number, listed: string[]): Computable<string[]> {
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
      options: { immutable: false, forceRevalidate: revalidate },
    }).then(releases => {
      /* End at a missing or empty page, not a short one: the API may list fewer than PAGE_SIZE on a page. */
      return releases === undefined || releases.length === 0
        ? listed
        : this.releasePages(query, revalidate, page + 1, [...listed, ...releases]);
    });
  }
}

function createRepository(context: TargetContext): Computable<Repository> {
  return context.getRequiredString("url").then(url => new JdkDistribution(context, url.replace(/\/+$/, "")));
}

/** The implementation JAVA.fabr's `repository` declaration names. */
export default { provider: createRepository } satisfies RepositoryImplementation;
