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

import { compareText, compareVersions, parseVersion, versionToString } from "@fabr-build/core";
import { Lockfile } from "./Lockfile";
import { DEPENDENCY_BLOCKS, Manifest } from "./Manifest";
import { Report } from "./Report";
import { constraintOf, floorOf, parseSpec, rangeText } from "./Spec";
import { Workspace } from "./Workspace";

/** The catalog the generated files declare. */
export const CATALOG = "@dep";

/** fabr's own name for the npm registry. */
export const NPM = "@npm";

/** An entry of the catalog: a registry package, addressed `@dep:<address>`. */
export interface CatalogEntry {
  /** The name packages write it under: the package's name, or the alias it is installed as. */
  readonly address: string;
  /** The repository it is resolved from. */
  readonly repository: string;
  /** The name the registry publishes it under. */
  readonly packageName: string;
  readonly range: string;
  /** Forced (`!`): every requirement on the package is answered by this version. */
  readonly forced?: boolean;
  /** Why the entry is what it is, where it is not what a manifest wrote. */
  readonly note?: string;
  /** For an entry no manifest declares, which kind of pin it is. */
  readonly pin?: Pin;
}

/** The pins a migration adds for a package no manifest declares: a raised
 * floor, or a version for a package required only without a lower bound. */
export type Pin = "raise" | "floorless";

/** The catalog of a project: its entries by address, and the versions of each
 * package a `?` sanctions. */
export class Catalog {
  public readonly entries = new Map<string, CatalogEntry>();
  /** Package name -> each version sanctioned. */
  public readonly alternates = new Map<string, Set<string>>();

  /**
   * @param scopeRegistries each npm scope's repository, where it is not {@link NPM}.
   */
  constructor(public readonly scopeRegistries: ReadonlyMap<string, string> = new Map()) {}

  /** @return the repository `packageName` is resolved from. */
  public repositoryOf(packageName: string): string {
    const scope = packageName.startsWith("@") ? packageName.slice(0, packageName.indexOf("/")) : undefined;
    return (scope === undefined ? undefined : this.scopeRegistries.get(scope)) ?? NPM;
  }

  /** Make `packageName`'s entry at least `version`, keeping a `~` the entry was
   * written with, and `note` it; add one, a `pin`, where the catalog has none.
   * A forced entry is left as it is.
   * @return true if the entry changed, otherwise false. */
  public raise(packageName: string, version: string, pin: Pin, note?: string): boolean {
    const held = this.entries.get(packageName);
    const prefix = held?.range.trim().startsWith("~") ? "~" : "^";
    if (held?.forced || held?.range === `${prefix}${version}`) {
      return false;
    }
    this.entries.set(packageName, {
      address: packageName,
      repository: held?.repository ?? this.repositoryOf(packageName),
      packageName,
      range: `${prefix}${version}`,
      ...(note === undefined ? {} : { note }),
      ...(held === undefined || held.pin !== undefined ? { pin } : {}),
    });
    return true;
  }

  /** Sanction `version` of `packageName` with a `?`.
   * @return true if it was not sanctioned already, otherwise false. */
  public sanction(packageName: string, version: string): boolean {
    const versions = this.alternates.get(packageName) ?? new Set<string>();
    this.alternates.set(packageName, versions);
    return versions.size !== versions.add(version).size;
  }
}

/** @return the reference `entry` is written as in the catalog's `deps`. */
export function entryReference(entry: CatalogEntry): string {
  const rename = entry.address === entry.packageName ? "" : ` -> ${entry.address}`;
  return `${entry.repository}:${entry.packageName}:${rangeText(entry.range)}${entry.forced ? "!" : ""}${rename}`;
}

/** @return "raise" where `incoming`'s floor is higher than `held`'s within one
 * major, "differ" where they are of different majors, and "" otherwise
 * (equal, lower, floorless, or a prerelease floor, which never wins). */
export function compareFloors(incoming: string, held: string): "raise" | "differ" | "" {
  const a = constraintOf(incoming);
  const b = constraintOf(held);
  if (a === undefined || b === undefined) {
    return "";
  }
  const fa = floorOf(a);
  const fb = floorOf(b);
  if (fa.prerelease.length > 0 || versionToString(fa) === "0.0.0") {
    return "";
  }
  if (versionToString(fb) === "0.0.0") {
    return "raise";
  }
  if (fa.major !== fb.major) {
    return "differ";
  }
  return compareVersions(fa, fb) > 0 ? "raise" : "";
}

/** @return the highest of `versions`. */
export function highest(versions: Iterable<string>): string | undefined {
  return [...versions].sort((a, b) => compareVersions(parseVersion(a), parseVersion(b))).pop();
}

/** @return the name a package writes a named pnpm catalog's version of `name`
 * under, where it differs from the default catalog's. */
function namedCatalogAddress(name: string, catalog: string): string {
  return `${name}-${catalog}`;
}

/** Where a package's dependency is found in the catalog. */
export interface CatalogAddress {
  readonly address: string;
}

/**
 * Build the catalog of `workspace` from what its manifests declare (the root's
 * first, then each workspace package's), its pnpm catalogs and its overrides, and say
 * where each package's registry dependencies are in it. `addressOf(manifest,
 * name)` is undefined for a dependency the catalog holds no entry for, which
 * is reported here.
 */
export function buildCatalog(
  workspace: Workspace,
  lockfile: Lockfile | undefined,
  report: Report
): { catalog: Catalog; addressOf: (manifest: Manifest, name: string) => CatalogAddress | undefined } {
  const repositories = new Map<string, string>();
  for (const scope of workspace.scopeRegistries.keys()) {
    repositories.set(scope, `${scope}-registry`);
  }
  const catalog = new Catalog(repositories);
  const addresses = new Map<string, CatalogAddress>();
  const packageNames = new Set(workspace.packages.flatMap(manifest => (manifest.name === undefined ? [] : [manifest.name])));
  const lockedRange = (packageName: string): string | undefined => {
    const version = highest(lockfile?.versions.get(packageName) ?? []);
    return version === undefined ? undefined : `^${version}`;
  };

  /* Record an entry a manifest states under its address, a higher floor in
   * one major replacing a lower. */
  const offer = (address: string, packageName: string, range: string, from: string): void => {
    const held = catalog.entries.get(address);
    if (held === undefined) {
      catalog.entries.set(address, { address, repository: catalog.repositoryOf(packageName), packageName, range });
      return;
    }
    if (held.packageName !== packageName) {
      report.add(
        "Dependencies written under one name for two packages (the first is kept)",
        `${address}: ${held.packageName} and ${packageName} (${from})`
      );
      return;
    }
    switch (compareFloors(range, held.range)) {
      case "raise":
        catalog.entries.set(address, { ...held, range });
        break;
      case "differ":
        report.add(
          "Majors the manifests disagree on (the catalog keeps the first; one address holds one version)",
          `${address}: ${held.range}, and ${range} in ${from}`
        );
        break;
    }
  };

  const keyOf = (manifest: Manifest, name: string): string => `${manifest.dir}\0${name}`;
  const manifests = [workspace.rootManifest, ...workspace.packages.filter(manifest => manifest !== workspace.rootManifest)];
  /* Peers state the range a consumer must supply, usually wide: they make an
   * entry only where nothing else names the package. */
  for (const peers of [false, true]) {
    for (const manifest of manifests) {
      const from = manifest.dir === "" ? "package.json" : `${manifest.dir}/package.json`;
      for (const block of DEPENDENCY_BLOCKS) {
        if ((block === "peerDependencies") !== peers) {
          continue;
        }
        for (const [name, text] of [...(manifest.blocks.get(block) ?? [])].sort(([a], [b]) => compareText(a, b))) {
          /* A workspace package's name is that package, however its spec is written: a
           * package manager links the workspace's own packages. */
          if (addresses.has(keyOf(manifest, name)) || packageNames.has(name)) {
            continue;
          }
          const spec = parseSpec(name, text);
          switch (spec.kind) {
            case "workspace":
              break;
            case "registry":
              if (spec.patched) {
                report.add("Patches not carried over (the package is used unpatched)", `${name} in ${from}`);
              }
              if (peers && catalog.entries.has(name)) {
                addresses.set(keyOf(manifest, name), { address: name });
                break;
              }
              offer(name, spec.packageName, spec.range, from);
              addresses.set(keyOf(manifest, name), { address: name });
              break;
            case "catalog": {
              const entries = workspace.catalogs.get(spec.catalog);
              const inner = entries?.get(name);
              const innerSpec = inner === undefined ? undefined : parseSpec(name, inner);
              if (innerSpec?.kind !== "registry") {
                report.add("Dependencies not converted", `${name}: '${text}' in ${from} (no such catalog entry)`);
                break;
              }
              const defaultSpec = workspace.catalogs.get("default")?.get(name);
              const address = spec.catalog === "default" || defaultSpec === inner ? name : namedCatalogAddress(name, spec.catalog);
              if (address !== name) {
                report.add(
                  "Named pnpm catalogs written as an alias (renamed back where used)",
                  `${address}: ${name} from catalog '${spec.catalog}'`
                );
              }
              offer(address, innerSpec.packageName, innerSpec.range, from);
              addresses.set(keyOf(manifest, name), { address });
              break;
            }
            case "tag": {
              const range = lockedRange(name);
              if (range === undefined) {
                report.add(
                  "Dependencies not converted",
                  `${name}: '${text}' in ${from} (a dist-tag, and the lockfile installs no version)`
                );
              } else {
                report.add("Dist-tags written as the version the lockfile installs", `${name}: '${text}' -> ${range} in ${from}`);
                offer(name, name, range, from);
                addresses.set(keyOf(manifest, name), { address: name });
              }
              break;
            }
            case "other":
              report.add("Dependencies not converted", `${name}: '${text}' in ${from} (not from a registry)`);
              break;
          }
        }
      }
    }
  }

  applyOverrides(workspace, catalog, report);
  return { catalog, addressOf: (manifest, name) => addresses.get(keyOf(manifest, name)) };
}

/**
 * Apply the project's overrides to `catalog`. An override is a substitution,
 * fabr's `!`, and is written as one where it says the same thing: it is not
 * scoped to a path or a range, its value is an exact version, and it is the
 * only override of its package. Any other is a floor on the package: its
 * entry where the catalog has none, else, unscoped, a raise of the entry's
 * floor; any other override is reported and left out.
 */
function applyOverrides(workspace: Workspace, catalog: Catalog, report: Report): void {
  const count = new Map<string, number>();
  workspace.overrides.forEach(override => count.set(override.name, (count.get(override.name) ?? 0) + 1));
  const rootSpecs = new Map(DEPENDENCY_BLOCKS.flatMap(block => [...(workspace.rootManifest.blocks.get(block) ?? [])]));
  for (const override of workspace.overrides) {
    const key = [...override.path, override.name].join(">") + (override.range === undefined ? "" : `@${override.range}`);
    const written = `${key}: '${override.spec}' (${override.source})`;
    /* npm's `$name` is the root's own spec for that name. */
    const value = override.spec.startsWith("$") ? rootSpecs.get(override.spec.slice(1)) : override.spec;
    const spec = value === undefined ? undefined : parseSpec(override.name, value);
    if (spec?.kind !== "registry" || spec.packageName !== override.name) {
      report.add("Overrides not converted", written);
      continue;
    }
    let exact = true;
    try {
      parseVersion(spec.range);
    } catch {
      exact = false;
    }
    if (override.path.length === 0 && override.range === undefined && exact && count.get(override.name) === 1) {
      catalog.entries.set(override.name, {
        address: override.name,
        repository: catalog.repositoryOf(override.name),
        packageName: override.name,
        range: spec.range,
        forced: true,
        note: `forced: an override in ${override.source}`,
      });
    } else if (!catalog.entries.has(override.name)) {
      catalog.entries.set(override.name, {
        address: override.name,
        repository: catalog.repositoryOf(override.name),
        packageName: override.name,
        range: spec.range,
        note: `a floor: '${key}' in ${override.source} is scoped, which fabr cannot write`,
      });
      report.add("Overrides written as a floor (a requirement it excludes is not substituted)", written);
    } else if (
      override.path.length === 0 &&
      override.range === undefined &&
      compareFloors(spec.range, catalog.entries.get(override.name)!.range) === "raise"
    ) {
      const held = catalog.entries.get(override.name)!;
      catalog.entries.set(override.name, { ...held, range: spec.range, note: `raised to an override's floor in ${override.source}` });
      report.add("Overrides written as a floor (a requirement it excludes is not substituted)", written);
    } else {
      report.add("Overrides not converted (the manifests' spec is kept)", written);
    }
  }
}
