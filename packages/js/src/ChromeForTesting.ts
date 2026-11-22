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
 * Chrome as Chrome for Testing publishes it (`@browser:chrome:156`, the
 * first build of Chrome 156's release branch, or an exact build,
 * `@browser:chrome:156.0.8078.4`): each build a package named `chrome` with no
 * requirements, its files the build for the target platform with its top
 * directory stripped, and under `run` the browser as a program.
 */

import {
  Computable,
  Distribution,
  FabrError,
  fetchDocument,
  FileSet,
  IDownloadSource,
  MemoryCache,
  PackageFileSet,
  parseJson,
  RunnableFileSet,
  SecureString,
  shownUrl,
  SymlinkFile,
  TargetContext,
  toJsonObject,
  tripleToNpm,
  urlJoin,
  VersionNotFoundError,
} from "@fabr-build/core";
import { BROWSER_FORMAT, BrowserConstraint, BrowserVersion } from "./BrowserVersion";

/** The one package Chrome for Testing holds. */
const CHROME = "chrome";

/** The document listing every build with its downloads. */
const VERSIONS_FILE = "known-good-versions-with-downloads.json";

/** Where the executable is within a build, by the platforms it is built for. */
const EXECUTABLES = ["Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", "chrome", "chrome.exe"];

/** Each build's Chrome archive url, by version, then by Chrome for Testing's platform name (`mac-arm64`). */
export type ChromeBuilds = Map<string, Map<string, string>>;

/** Convert Chrome for Testing's version list to each build's Chrome archive url by platform. */
export function toChromeBuilds(json: unknown): ChromeBuilds {
  const versions = toJsonObject(json).versions;
  if (!Array.isArray(versions)) {
    throw new FabrError("expected a list of versions");
  }
  return new Map(
    versions.map((entry): [string, Map<string, string>] => {
      const { version, downloads } = toJsonObject(entry);
      if (typeof version !== "string") {
        throw new FabrError(`expected a version like '156.0.8078.4', got ${JSON.stringify(version)}`);
      }
      const chrome = downloads === undefined ? [] : (toJsonObject(downloads).chrome ?? []);
      if (!Array.isArray(chrome)) {
        throw new FabrError(`expected ${version}'s Chrome downloads as a list`);
      }
      return [
        version,
        new Map(
          chrome.map((download): [string, string] => {
            const { platform, url } = toJsonObject(download);
            if (typeof platform !== "string" || typeof url !== "string") {
              throw new FabrError(`expected each of ${version}'s Chrome downloads to name its platform and url`);
            }
            return [platform, url];
          })
        ),
      ];
    })
  );
}

/**
 * @return the target platform as Chrome for Testing names it (`mac-arm64`,
 * `mac-x64`, `linux64`, `linux-arm64`, `win64`, `win32`), or undefined where it
 * builds for no such platform.
 */
export function chromePlatformOf(target: string): string | undefined {
  const { os, cpu } = tripleToNpm(target);
  if (os === "darwin") {
    return cpu === "arm64" ? "mac-arm64" : cpu === "x64" ? "mac-x64" : undefined;
  }
  if (os === "linux") {
    return cpu === "x64" ? "linux64" : cpu === "arm64" ? "linux-arm64" : undefined;
  }
  if (os === "win32") {
    return cpu === "x64" ? "win64" : cpu === "ia32" ? "win32" : undefined;
  }
  return undefined;
}

/**
 * Select the build `constraint` names from `versions`: an exact build (four
 * parts) itself; otherwise the lowest build, among those it names, on the
 * release branch of the newest (its third part, `8078` for Chrome 156), so
 * `156` selects the first build of Chrome 156's branch. Throws for a milestone
 * not yet branched, whose newest build is a trunk build (its last part 0),
 * naming the browser as `written`. Undefined where it names none.
 */
export function releaseBranchBuild(
  versions: BrowserVersion[],
  constraint: BrowserConstraint,
  written: string
): BrowserVersion | undefined {
  const named = versions.filter(version => BROWSER_FORMAT.satisfies(version, constraint)).sort(BROWSER_FORMAT.compare);
  if (constraint.prefix.length >= 4 || named.length === 0) {
    return named[0];
  }
  const newest = named[named.length - 1];
  if (newest.parts[3] === 0) {
    throw new FabrError(`Chrome ${constraint.prefix.join(".")} has no release branch yet`).withHelp(
      `name an exact build, as in '${written}:${newest.text}'; \`fabr ls ${written}\` lists them`
    );
  }
  return named.find(version => version.parts[2] === newest.parts[2]);
}

/**
 * The Chrome builds Chrome for Testing publishes under `url`, its version list
 * read from `<url>/known-good-versions-with-downloads.json`, which names each
 * build's archive.
 */
export class ChromeForTesting extends Distribution<BrowserVersion, BrowserConstraint> {
  protected readonly packageName = CHROME;
  protected readonly title = "Chrome for Testing";
  protected readonly domain = BROWSER_FORMAT;
  protected readonly archiveTag = "chrome-for-testing:build:1";
  protected readonly unavailableHelp = "Chrome for Testing builds for macOS, Linux and Windows on x64, and macOS and Linux on arm64";
  protected readonly binDirectories = [];
  /** The version list, by whether it was re-read, as read this run. */
  private readonly lists = new MemoryCache<string, ChromeBuilds>();

  constructor(
    context: TargetContext,
    url: SecureString,
    /** The name the browser is written as (`@browser:chrome`). */
    private readonly written: string
  ) {
    super(context, url);
  }

  protected override get name(): string {
    return this.written;
  }

  protected listVersions(target: string, revalidate: boolean): Computable<string[]> {
    const platform = chromePlatformOf(target);
    if (platform === undefined) {
      return Computable.reject(this.unavailable(target));
    }
    return this.builds(revalidate).then(builds =>
      [...builds].filter(([, downloads]) => downloads.has(platform)).map(([version]) => version)
    );
  }

  protected findArchive(version: string, target: string): Computable<IDownloadSource> {
    const platform = chromePlatformOf(target);
    if (platform === undefined) {
      return Computable.reject(this.unavailable(target));
    }
    const find = (builds: ChromeBuilds): IDownloadSource | undefined => {
      const url = builds.get(version)?.get(platform);
      return url === undefined ? undefined : { url: SecureString.of(url), expected: undefined };
    };
    return this.builds(false).then(
      held =>
        find(held) ??
        this.builds(true).then(listed => {
          const found = find(listed);
          if (found !== undefined) {
            return found;
          }
          throw listed.has(version)
            ? new FabrError(`Chrome for Testing ${version} is not built for ${target}`).withHelp("choose another version")
            : new VersionNotFoundError(CHROME, version, `Chrome for Testing has no build ${version}`);
        })
    );
  }

  protected override selectFrom(versions: BrowserVersion[], constraint: BrowserConstraint): BrowserVersion | undefined {
    return releaseBranchBuild(versions, constraint, this.name);
  }

  /** Make a build runnable: the build is the install, its executable the one entry, run as `chrome`. */
  public override makeRunnable(pkg: PackageFileSet): Computable<RunnableFileSet> {
    const entry = EXECUTABLES.find(name => pkg.getFile(name) !== undefined);
    if (entry === undefined) {
      return Computable.reject(new FabrError(`Chrome for Testing ${pkg.version ?? ""} holds no Chrome executable`));
    }
    return Computable.resolve(new RunnableFileSet(pkg, [], undefined, "", new FileSet(new Map([[CHROME, new SymlinkFile(entry)]]))));
  }

  /** Read the version list, once a run each way. */
  private builds(revalidate: boolean): Computable<ChromeBuilds> {
    return this.lists.getOrCreate(String(revalidate), () =>
      fetchDocument(this.context, {
        url: urlJoin(this.url, VERSIONS_FILE),
        file: VERSIONS_FILE,
        tag: "chrome-for-testing:versions:1",
        report: { resource: "version list", role: "index" },
        convert: text => parseJson(text, `Chrome for Testing's version list from ${shownUrl(this.url)}`, toChromeBuilds),
        options: { immutable: false, forceRevalidate: revalidate },
      }).then(builds => builds ?? new Map())
    );
  }
}
