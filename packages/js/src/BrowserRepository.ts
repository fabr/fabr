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
 * The `browser_repository` repository: web browsers as packages, so a target
 * says which browsers its output must run in by requiring them
 * (`@browser:safari:17.2` — Safari 17.2 and newer). Each browser is a package
 * named by its Can I Use id (`safari`, `ios_saf`, `chrome`, `and_chr`), its
 * versions the ones released, and none has files or requirements. `baseline`
 * is a package too: its version `2023` requires the version of each core
 * browser that supports every feature Baseline by the end of 2023.
 */

import {
  Computable,
  FabrError,
  FileSet,
  IProjection,
  Name,
  PartialRepositoryRef,
  PackageFileSet,
  PackageFormat,
  Repository,
  RepositoryPublishRef,
  RepositoryReader,
  RepositoryRef,
  Requirement,
  resolveBarePackage,
  parseJson,
  SEMVER,
  SemverConstraint,
  SemverVersion,
  TargetContext,
  toJsonObject,
  vendPackageRef,
  VersionNotFoundError,
} from "@fabr-build/core";
import * as path from "path";

/** The package whose versions are Baseline's years. */
const BASELINE = "baseline";

/** The packages of a `browser_repository`'s `data`: Can I Use's browser releases, and Baseline's versions by year. */
const CANIUSE = "caniuse-lite";
const BASELINE_MAPPING = "baseline-browser-mapping";

/** Each browser by its Can I Use id (`safari`, `ios_saf`, `and_chr`), and each Baseline year. */
export interface IBrowserData {
  /** Each browser's released versions, oldest first, spelled as Can I Use spells them (`17.2`, `18.5-18.7`). */
  browsers: Map<string, string[]>;
  /** Each Baseline year (`2023`): the lowest version of each core browser supporting every feature Baseline by then. */
  baseline: Map<string, Map<string, string>>;
}

/** The core browsers as baseline-browser-mapping names them, by their Can I Use ids. */
const CORE_BROWSERS = new Map<string, string>([
  ["chrome", "chrome"],
  ["chrome_android", "and_chr"],
  ["edge", "edge"],
  ["firefox", "firefox"],
  ["firefox_android", "and_ff"],
  ["safari", "safari"],
  ["safari_ios", "ios_saf"],
]);

/** The first year Baseline has a set of browser versions for. */
const FIRST_BASELINE_YEAR = 2015;

/** The part of caniuse-lite read: each browser's versions, with their release dates (null for one not released). */
export type ICaniuseAgents = Record<string, { release_date: Record<string, number | null> }>;

/** baseline-browser-mapping's answer for a year: a version of each browser. */
export type IBaselineVersions = (year: number) => Array<{ browser: string; version: string }>;

/** Order Can I Use versions (`17.2`, `18.5-18.7`) oldest first, by their numbered parts. */
function compareCaniuse(a: string, b: string): number {
  return SEMVER.compare(SEMVER.parseVersion(semverOf(a)), SEMVER.parseVersion(semverOf(b)));
}

/**
 * Make the browser data from Can I Use's `agents` and Baseline's versions by
 * year: every released, numbered version of each browser, and each year from
 * 2015 to the last year a browser release falls in that Baseline gives
 * versions for. A version a Baseline year names is a version of its browser,
 * whether or not Can I Use lists it (Can I Use lists only the current Android
 * releases).
 */
export function browserDataOf(agents: ICaniuseAgents, baselineVersions: IBaselineVersions): IBrowserData {
  const browsers = new Map<string, string[]>();
  let lastRelease = 0;
  for (const id of Object.keys(agents).sort()) {
    const released = Object.entries(agents[id].release_date).filter(
      (entry): entry is [string, number] => entry[1] !== null && isVersionOrRange(entry[0])
    );
    browsers.set(id, released.map(([version]) => version));
    lastRelease = Math.max(lastRelease, ...released.map(([, date]) => date));
  }
  const baseline = new Map<string, Map<string, string>>();
  const lastYear = new Date(lastRelease * 1000).getUTCFullYear();
  for (let year = FIRST_BASELINE_YEAR; year <= lastYear; year++) {
    const floors = new Map<string, string>();
    for (const { browser, version } of baselineVersions(year)) {
      const id = CORE_BROWSERS.get(browser);
      if (id !== undefined) {
        floors.set(id, version);
        const known = browsers.get(id) ?? [];
        if (!known.includes(version)) {
          browsers.set(id, [...known, version].sort(compareCaniuse));
        }
      }
    }
    /* A year the data has no versions for is no Baseline year of it. */
    if (floors.size > 0) {
      baseline.set(String(year), floors);
    }
  }
  return { browsers, baseline };
}

/**
 * The one version Can I Use lists for a browser it does not number (Opera Mini): a browser's
 * only version, so the lowest, held as version 0. No numbered browser has a version 0.
 */
const ALL = "all";

/** @return true if `text` is a version as Can I Use writes one (`17`, `17.2`, `4.4.3`, `all`), otherwise false. */
function isBareVersion(text: string): boolean {
  return text === ALL || /^\d+(\.\d+){0,2}$/.test(text);
}

/** Write a Can I Use version (`17.2`, a range's lower end, `18.5-18.7`, or `all`) as semver (`17.2.0`, `0.0.0`). */
function semverOf(text: string): string {
  if (text === ALL) {
    return "0.0.0";
  }
  const parts = text.split("-")[0].split(".");
  while (parts.length < 3) {
    parts.push("0");
  }
  return parts.join(".");
}

/** Write a semver version as Can I Use does, its zero minor and patch dropped (`17.2.0` → `17.2`, `120.0.0` → `120`, `0.0.0` → `all`). */
function caniuseOf(text: string): string {
  const written = text.replace(/(\.0)+$/, "");
  return written === "" || written === "0" ? ALL : written;
}

/** @return the newest version a semver constraint admits, or undefined where it admits ever newer ones. */
function newestOf(constraint: SemverConstraint): SemverVersion | undefined {
  let newest: SemverVersion | undefined;
  for (const range of constraint.ranges) {
    if (range.max === undefined) {
      return undefined;
    }
    if (newest === undefined || SEMVER.compare(range.max, newest) > 0) {
      newest = range.max;
    }
  }
  return newest;
}

/** A version newer than any browser's: what a constraint admitting ever newer versions has as its newest. */
const NEWEST = SEMVER.parseVersion(`${Number.MAX_SAFE_INTEGER}.0.0`);

/**
 * The format of browser references: `<browser>:<version>`, a claim that the
 * output must run on that version and everything newer. A browser's selected
 * version is the OLDEST the output must run on, so the domain orders versions
 * newest first: a claim is a floor in that order (`safari:12` is satisfied by
 * any oldest-supported version at or below 12), and a resolution's selection —
 * the greatest of the floors — is the oldest of the claims. `baseline:2023`
 * and `safari:12` together select Safari 12.
 *
 * Versions are semver underneath, written as Can I Use writes them.
 */
export const BROWSER_FORMAT: PackageFormat<SemverVersion, SemverConstraint> = {
  ...SEMVER,
  resolutionTag: "browser:resolve:2",
  parseVersion: text => SEMVER.parseVersion(semverOf(text)),
  versionToString: version => caniuseOf(SEMVER.versionToString(version)),
  compare: (a, b) => SEMVER.compare(b, a),
  parseConstraint: text => {
    if (!isBareVersion(text)) {
      throw new FabrError(`'${text}' is not a browser version (expected one like '17.2')`);
    }
    return SEMVER.parseConstraint(`<=${semverOf(text)}`);
  },
  minimumOf: constraint => newestOf(constraint) ?? NEWEST,
  isFloorless: constraint => newestOf(constraint) === undefined,
  exactVersion: text => (isBareVersion(text) ? SEMVER.parseVersion(semverOf(text)) : undefined),
  splitReference: splitBrowserReference,
  validateRequirement: validateBrowserRequirement,
  parsePublishCoordinate: () => {
    throw new FabrError("browsers cannot be published to");
  },
  readContentPackage: () => Computable.reject(new FabrError("content cannot be read as a browser")),
  makeRunnable: () => Computable.reject(new FabrError("a browser is not a program fabr can run")),
};

/** Split `<browser>:<version>` (the reference after `@browser:`). A browser has no files, so nothing selects from it. */
function splitBrowserReference(name: Name): Requirement & { projection?: IProjection } {
  const written = name.toBaseString();
  const colon = written.indexOf(":");
  if (colon === -1) {
    return { name: written, versionConstraint: undefined };
  }
  if (written.indexOf(":", colon + 1) !== -1 || written.includes("/")) {
    throw new FabrError(`'${written}' selects files, and a browser has none (expected '@browser:<browser>:<version>')`);
  }
  return { name: written.substring(0, colon), versionConstraint: written.substring(colon + 1) };
}

/** Check a browser reference: it states the oldest version supported. */
function validateBrowserRequirement({ name, versionConstraint }: Requirement): void {
  if (versionConstraint === undefined) {
    throw new FabrError(`Missing version in a browser reference (expected '@browser:${name}:<version>', that version and newer)`);
  }
  if (!isBareVersion(versionConstraint)) {
    throw new FabrError(`'${versionConstraint}' is not a browser version (expected one like '@browser:${name}:17.2', that version and newer)`);
  }
}

/**
 * Write the browsers `packages` reach as a browserslist query, sorted, each by
 * the lowest version selected for it (`safari >= 17.2, chrome >= 120`), or as
 * `op_mini all` where that version is Can I Use's `all`; `baseline` names no
 * browser and is left out.
 */
export function browserQueryOf(packages: ReadonlyArray<PackageFileSet>): string {
  const lowest = new Map<string, string>();
  const seen = new Set<PackageFileSet>();
  const visit = (pkg: PackageFileSet): void => {
    if (seen.has(pkg)) {
      return;
    }
    seen.add(pkg);
    if (pkg.packageName !== BASELINE && pkg.version !== undefined) {
      const version = caniuseOf(semverOf(pkg.version));
      const known = lowest.get(pkg.packageName);
      if (known === undefined || SEMVER.compare(SEMVER.parseVersion(semverOf(version)), SEMVER.parseVersion(semverOf(known))) < 0) {
        lowest.set(pkg.packageName, version);
      }
    }
    pkg.packages.forEach(visit);
  };
  packages.forEach(visit);
  return [...lowest]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([browser, version]) => (version === ALL ? `${browser} ${ALL}` : `${browser} >= ${version}`))
    .join(", ");
}

/**
 * The repository a `browser_repository` declaration builds: a
 * {@link RepositoryReader} over its browser data document.
 */
export class BrowserRepository implements Repository, RepositoryReader<SemverVersion, SemverConstraint> {
  public readonly format = BROWSER_FORMAT;
  /** Each package's versions, oldest first. */
  private readonly versions = new Map<string, SemverVersion[]>();

  /**
   * @param data the browsers and Baseline years it holds.
   * @param dataVersion what names the data: a resolution made from other data
   *   is not reused for this.
   */
  constructor(
    private readonly context: Pick<TargetContext, "name" | "operation">,
    private readonly data: IBrowserData,
    private readonly dataVersion: string
  ) {
    for (const [browser, written] of data.browsers) {
      this.versions.set(
        browser,
        written.map(version => BROWSER_FORMAT.parseVersion(version))
      );
    }
    this.versions.set(
      BASELINE,
      [...data.baseline.keys()].map(year => BROWSER_FORMAT.parseVersion(year))
    );
  }

  public get identity(): string {
    return `browser:${this.dataVersion}`;
  }

  public get name(): string {
    return this.context.name;
  }

  public get operation(): string {
    return this.context.operation;
  }

  public getRepositoryRef(name: Name): RepositoryRef | PartialRepositoryRef {
    return vendPackageRef(this, this.format, name);
  }

  public getRepositoryPublishRef(): RepositoryPublishRef {
    throw new FabrError(`${this.name} cannot be published to`);
  }

  /** @return the empty key: a browser is the same whatever the build's platform. */
  public environmentKey(): Computable<string> {
    return Computable.resolve("");
  }

  /** Get the requirements of a version: none for a browser, and for a Baseline
   *  year the version of each core browser it names, supported and newer. */
  public getRequirements(pkg: string, version: SemverVersion): Computable<Requirement[]> {
    const written = BROWSER_FORMAT.versionToString(version);
    if (!this.publishes(pkg, version)) {
      return Computable.reject(new VersionNotFoundError(pkg, written, `${this.name} has no ${pkg} ${written}`));
    }
    if (pkg !== BASELINE) {
      return Computable.resolve([]);
    }
    const floors = this.data.baseline.get(written) ?? new Map<string, string>();
    return Computable.resolve(
      [...floors.keys()].sort().map(browser => ({ name: browser, versionConstraint: floors.get(browser)! }))
    );
  }

  public lowestAvailable(pkg: string, constraint: string): Computable<SemverVersion | undefined> {
    let parsed: SemverConstraint;
    try {
      parsed = BROWSER_FORMAT.parseConstraint(constraint);
    } catch {
      return Computable.resolve(undefined);
    }
    /* Lowest in the domain's order: the newest version that satisfies it. */
    const satisfying = (this.versions.get(pkg) ?? []).filter(version => BROWSER_FORMAT.satisfies(version, parsed));
    return Computable.resolve(satisfying.length === 0 ? undefined : satisfying.reduce((a, b) => (BROWSER_FORMAT.compare(a, b) <= 0 ? a : b)));
  }

  public availableVersions(pkg: string): Computable<SemverVersion[] | undefined> {
    return Computable.resolve(this.versions.get(pkg));
  }

  public fetchFiles(reference: RepositoryRef): Computable<FileSet> {
    return Computable.resolve(undefined).then(() => resolveBarePackage(this, reference));
  }

  /** Fetch a version: a package with no files. */
  public fetch(pkg: string, version: SemverVersion): Computable<PackageFileSet> {
    return Computable.resolve(new PackageFileSet(new Map(), pkg, BROWSER_FORMAT.versionToString(version)));
  }

  /** @return true if `pkg` has a version `version`, otherwise false. */
  private publishes(pkg: string, version: SemverVersion): boolean {
    return (this.versions.get(pkg) ?? []).some(known => SEMVER.compare(known, version) === 0);
  }
}

/** @return true if Can I Use's `text` is a version: numbered, a range, or `all` (not `TP`), otherwise false. */
function isVersionOrRange(text: string): boolean {
  return text === ALL || /^\d+(\.\d+){0,2}(-\d+(\.\d+){0,2})?$/.test(text);
}

/**
 * Make a `browser_repository` from its `data`, the browser data packages: each
 * is written to the tree pool and loaded from there, Can I Use's for its
 * browsers' releases and baseline-browser-mapping's for the Baseline years.
 */
function createRepository(context: TargetContext): Computable<Repository> {
  return context
    .getFileProperty("data")
    .then(sources => context.materializeSources(sources))
    .then(delivered =>
      Computable.forAll(
        delivered.filter((set): set is FileSet => set instanceof FileSet).map(files => namedPackage(files)),
        (...packages: Array<{ name: string; version: string; files: FileSet }>) => packages
      )
    )
    .then(packages => {
      const byName = new Map(packages.map(pkg => [pkg.name, pkg]));
      const missing = [CANIUSE, BASELINE_MAPPING].filter(name => !byName.has(name));
      if (missing.length > 0) {
        throw new FabrError(`${context.name}'s data has no ${missing.join(" or ")}`);
      }
      const [caniuse, mapping] = [byName.get(CANIUSE)!, byName.get(BASELINE_MAPPING)!];
      return Computable.forAll(
        [context.execution.buildCache.ensureTree(caniuse.files), context.execution.buildCache.ensureTree(mapping.files)],
        (caniuseDir: string, mappingDir: string) => {
          /* Loaded from where the pool holds them: the data packages the
           * project pins, not a copy installed with fabr. Only the agents
           * table's own module: the package's index also loads every feature's
           * data, which the repository does not read. */
          /* eslint-disable @typescript-eslint/no-var-requires */
          const { agents } = require(path.resolve(caniuseDir, "dist/unpacker/agents")) as { agents: ICaniuseAgents };
          const { getCompatibleVersions } = require(path.resolve(mappingDir)) as {
            getCompatibleVersions(options: { targetYear: number; suppressWarnings: boolean }): Array<{ browser: string; version: string }>;
          };
          /* eslint-enable @typescript-eslint/no-var-requires */
          const data = browserDataOf(agents, year => getCompatibleVersions({ targetYear: year, suppressWarnings: true }));
          return new BrowserRepository(context, data, `${CANIUSE}@${caniuse.version} ${BASELINE_MAPPING}@${mapping.version}`);
        }
      );
    });
}

/** Read the name and version a package's files give it, from its `package.json`. */
function namedPackage(files: FileSet): Computable<{ name: string; version: string; files: FileSet }> {
  const manifest = files.getFile("package.json");
  if (manifest === undefined) {
    return Computable.reject(new FabrError("browser data must be packages, each with a package.json"));
  }
  return manifest.readString().then(text => {
    const { name, version } = parseJson(text, "package.json", toJsonObject);
    if (typeof name !== "string" || typeof version !== "string") {
      throw new FabrError("a browser data package's package.json names no name and version");
    }
    return { name, version, files };
  });
}

/** The implementation JS.fabr's `repository` declaration names. */
export default createRepository;
