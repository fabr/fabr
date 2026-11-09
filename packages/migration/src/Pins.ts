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

import {
  auditedPackages,
  BUILD_OPERATION,
  Computable,
  Constraints,
  Fabr,
  HOST,
  hostTriple,
  LogFormatter,
  LogLevel,
  MultiError,
  parseName,
  parseVersion,
  compareVersions,
  reportFailure,
  ResolutionWalkError,
  ResolvedRequirements,
  ResolvedTarget,
  StringReader,
  syntheticValue,
  FabrError,
  BuildContext,
  INameValue,
  isIncompleteRef,
  FILES_OPERATION,
} from "@fabr-build/core";
import { Catalog } from "./Catalog";
import { Lockfile } from "./Lockfile";

/** What fabr's resolution of a project's targets says, read as the facts the pins answer. */
export interface Observation {
  /** Each registry package the targets reach, by published name, with each version selected. */
  readonly selected: ReadonlyMap<string, ReadonlySet<string>>;
  /** Each package shipping at versions that conflict, with those versions. */
  readonly conflicts: ReadonlyMap<string, ReadonlySet<string>>;
  /** The packages required only without a lower bound, by published name. */
  readonly floorless: ReadonlySet<string>;
  /** Every other failure, rendered as fabr reports it. */
  readonly failures: ReadonlyArray<string>;
  /** The targets that did not resolve. */
  readonly failed: ReadonlyArray<string>;
}

/** @return the package name and version an npm purl names, or undefined for another format's. */
export function npmPurl(purl: string): { name: string; version: string } | undefined {
  const match = /^pkg:npm\/(.+)@([^@]+)$/.exec(purl);
  return match === null ? undefined : { name: decodeURIComponent(match[1]), version: decodeURIComponent(match[2]) };
}

/** Collect into `found` the floorless-required packages a resolution failure carries.
 * @return true if it carries any other failure, otherwise false. */
function floorlessOf(err: unknown, found: Set<string>): boolean {
  if (err instanceof MultiError) {
    return err.errors.map(each => floorlessOf(each, found)).some(Boolean);
  }
  if (err instanceof ResolutionWalkError) {
    let other = false;
    for (const failure of err.failures) {
      const named = failure.floorless ?? (failure.name === undefined ? [] : [{ name: failure.name, publishedName: failure.publishedName }]);
      named.forEach(pkg => found.add(pkg.publishedName ?? pkg.name));
      other ||= named.length === 0;
    }
    return other;
  }
  if (err instanceof FabrError && err.cause !== undefined) {
    return floorlessOf(err.cause, found);
  }
  return true;
}

/**
 * Load the project at `root` and evaluate `operation` against its
 * configuration under the build operation `buildOperation`, handing it the
 * reference each name is written as.
 */
function evaluate<T>(
  root: string,
  cacheRoot: string,
  buildOperation: string,
  operation: (config: BuildContext, reference: (name: string) => INameValue) => Computable<T>
): Promise<T> {
  const log = new LogFormatter(LogLevel.Warn, line => process.stderr.write(`${line}\n`));
  const fabr = new Fabr({ sourceRoot: root, cacheRoot, log });
  const reference = (name: string): INameValue =>
    syntheticValue(parseName(name), { fs: fabr.sourceFileSource, file: "<fabr-migrate>", reader: new StringReader(name) }, 0, name.length);
  const evaluation = fabr.evaluate(model =>
    operation(model.getConfig(Constraints.of({ [HOST]: hostTriple(), [BUILD_OPERATION]: buildOperation }), fabr.execution), reference)
  );
  return new Promise((resolve, reject) => evaluation.then(resolve, reject));
}

/**
 * Resolve each of `targets` in the project at `root` as `fabr deps` does:
 * under `build`, nothing fetched or built.
 */
export function observe(root: string, cacheRoot: string, targets: ReadonlyArray<string>): Promise<Observation> {
  const selected = new Map<string, Set<string>>();
  const conflicts = new Map<string, Set<string>>();
  const floorless = new Set<string>();
  const failures = new Set<string>();
  const failed: string[] = [];
  const take = (title: string, resolved: ResolvedRequirements): void => {
    for (const pkg of auditedPackages([{ title, resolved }])) {
      const named = npmPurl(pkg.purl);
      if (named !== undefined) {
        selected.set(named.name, (selected.get(named.name) ?? new Set()).add(named.version));
      }
    }
    for (const denoted of resolved.denoted) {
      if (denoted instanceof ResolvedTarget) {
        for (const [name, versions] of denoted.resolved.conflicts.versions) {
          const held = conflicts.get(name) ?? new Set();
          versions.forEach(version => held.add(version));
          conflicts.set(name, held);
        }
      }
    }
  };
  const fail = (err: unknown): void => {
    if (floorlessOf(err, floorless)) {
      const lines: string[] = [];
      reportFailure(new LogFormatter(LogLevel.Info, line => lines.push(line)), err as Error);
      failures.add(lines.join("\n"));
    }
  };
  const observed = (): Observation => ({ selected, conflicts, floorless, failures: [...failures], failed: failed.sort() });
  return evaluate(root, cacheRoot, "build", (config, reference) =>
    Computable.forAll(
      targets.map(target =>
        config.resolve(reference(target)).then(
          resolved => take(target, resolved),
          err => {
            failed.push(target);
            fail(err);
          }
        )
      ),
      () => undefined
    )
  ).then(observed, err => {
    fail(err);
    return observed();
  });
}

/**
 * Look up the newest version published without a prerelease tag of each
 * package in `packages` (package name -> the repository it is resolved
 * from), as `fabr ls` lists a package's versions. A package whose versions
 * cannot be listed is left out.
 */
export function latestPublished(root: string, cacheRoot: string, packages: ReadonlyMap<string, string>): Promise<Map<string, string>> {
  const latest = new Map<string, string>();
  return evaluate(root, cacheRoot, FILES_OPERATION, (config, reference) =>
    Computable.forAll(
      [...packages].map(([name, repository]) =>
        config.materialize(reference(`${repository}:${name}`)).then(
          ([found]) =>
            isIncompleteRef(found)
              ? found.children().then(
                  children => {
                    const version = [...children.keys()].find(each => !each.includes("-"));
                    if (version !== undefined) {
                      latest.set(name, version);
                    }
                  },
                  () => undefined
                )
              : undefined,
          () => undefined
        )
      ),
      () => latest
    )
  ).catch(() => latest);
}

/** @return true if `a` and `b` are versions a caret range starting at the lower admits both of. */
function caretCompatible(a: string, b: string): boolean {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  return va.major === vb.major && (va.major > 0 || va.minor === vb.minor);
}

const byVersion = (a: string, b: string): number => compareVersions(parseVersion(a), parseVersion(b));

/** The pins an observation calls for, and what it found that no pin answers. */
export interface Proposal {
  /** How many pins were added to the catalog. */
  readonly added: number;
  /** Each fact the lockfile gives no answer to, as a line of the report, by heading. */
  readonly unanswered: ReadonlyArray<[string, string]>;
}

/**
 * Add to `catalog` the pins `observation` calls for, against what `lockfile`
 * records as installed:
 *  - a floorless-required package is pinned at the highest version the lockfile
 *    installs, or where it installs none, at `latest`'s version of it;
 *  - where the resolution selects a package lower than every version the
 *    lockfile installs in the same caret range, it is raised to the lowest of
 *    those (or, where the lockfile installs the package at one version, to it);
 *  - where versions of a package conflict and the lockfile installs it at more
 *    than one version too, each conflicting version is sanctioned with a `?`.
 */
export function proposePins(
  catalog: Catalog,
  observation: Observation,
  lockfile: Lockfile | undefined,
  latest: ReadonlyMap<string, string> = new Map()
): Proposal {
  const unanswered: Array<[string, string]> = [];
  const file = lockfile?.file ?? "the lockfile";
  let added = 0;
  for (const name of [...observation.floorless].sort()) {
    const locked = [...(lockfile?.versions.get(name) ?? [])].sort(byVersion).pop();
    const version = locked ?? latest.get(name);
    if (version === undefined) {
      unanswered.push(["Packages required only without a lower bound, with no version to pin (add an entry)", name]);
      continue;
    }
    const note = locked === undefined ? `${file} does not install it: the latest published` : undefined;
    if (locked === undefined) {
      unanswered.push([`Packages required only without a lower bound, which ${file} does not install (pinned at the latest published)`, `${name}@${version}`]);
    }
    if (catalog.raise(name, version, "floorless", note)) {
      added++;
    }
  }
  for (const [name, versions] of [...observation.selected].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const installed = [...(lockfile?.versions.get(name) ?? [])];
    const sorted = [...versions].sort(byVersion);
    const principal = sorted[sorted.length - 1];
    for (const version of sorted) {
      /* The installed versions a raise could take: those in the selection's
       * caret range, or the one version installed, which satisfied every
       * requirer on the package whatever its major. */
      const caret = installed.filter(each => caretCompatible(each, version)).sort(byVersion);
      const compatible = caret.length === 0 && installed.length === 1 && sorted.length === 1 ? installed : caret;
      if (compatible.length === 0 || byVersion(compatible[0], version) <= 0) {
        continue;
      }
      if (version === principal) {
        const note = catalog.entries.has(name) ? `raised: the declared floor gives ${version}, where ${file} installs ${compatible[0]}` : undefined;
        if (catalog.raise(name, compatible[0], "raise", note)) {
          added++;
        }
      } else {
        unanswered.push([
          `Versions selected below what ${file} installs, which a catalog entry cannot raise (a second version of the package)`,
          `${name}@${version} (${file} installs ${compatible.join(", ")})`,
        ]);
      }
    }
  }
  for (const [name, versions] of [...observation.conflicts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const installed = lockfile?.versions.get(name)?.size ?? 0;
    if (installed < 2) {
      unanswered.push([
        `Version conflicts ${file} does not share (it installs one version: fix the requirements, or sanction the versions with '?')`,
        `${name}: ${[...versions].sort(byVersion).join(", ")}`,
      ]);
      continue;
    }
    for (const version of versions) {
      if (catalog.sanction(name, version)) {
        added++;
      }
    }
  }
  return { added, unanswered };
}
