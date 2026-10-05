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

/*
 * Package extensions: additive repairs to third-party npm manifests — a
 * dependency, peer or peer-optionality a published package uses but does not
 * declare (`reactcss` requiring `react`). The curated list is Yarn's
 * `@yarnpkg/extensions` (the one pnpm also applies), converted to JSON at build
 * time and shipped beside this plugin's entry point.
 */

import * as fs from "fs";
import {
  FabrError,
  hashString,
  isJsonObject,
  packageLibFile,
  parseConstraint,
  parseJson,
  SEMVER,
  SemverConstraint,
  SemverVersion,
} from "@fabr-build/core";
import { dependencyBlock, IDependencyDecls } from "./PackageJson";

/** The shipped list's file name, in this plugin's `lib/`. */
export const PACKAGE_EXTENSIONS_FILE = "package-extensions.json";

/** One repair: the packages it applies to, and what it adds to their manifest. */
interface IPackageExtension {
  readonly name: string;
  readonly range: SemverConstraint;
  readonly dependencies: ReadonlyMap<string, string>;
  readonly peerDependencies: ReadonlyMap<string, string>;
  /** Peers the repair marks optional (`peerDependenciesMeta: {x: {optional: true}}`). */
  readonly optionalPeers: ReadonlySet<string>;
}

/** The fields a repair may carry — the ones Yarn's `PackageExtensionData` defines. */
const EXTENSION_FIELDS = new Set(["dependencies", "peerDependencies", "peerDependenciesMeta"]);

/**
 * A list of package extensions, and the digest that identifies it: what an npm
 * resolution folds into its memo key, so a different list never reuses a
 * resolution computed under another.
 */
export class PackageExtensions {
  constructor(
    private readonly entries: ReadonlyArray<IPackageExtension>,
    public readonly digest: string
  ) {}

  /**
   * `decls` with every repair selecting `name@version` applied. Additive only:
   * a repair supplies a dependency or peer the manifest declares under no
   * field at all and never replaces one it states, and an optional-peer mark is
   * added only where the manifest gives that peer no metadata of its own.
   */
  public extend(name: string | undefined, version: SemverVersion, decls: IDependencyDecls): IDependencyDecls {
    const matching = name === undefined ? [] : this.entries.filter(e => e.name === name && SEMVER.satisfies(version, e.range));
    if (matching.length === 0) {
      return decls;
    }
    const dependencies = dependencyBlock(decls.dependencies);
    const peerDependencies = dependencyBlock(decls.peerDependencies);
    const meta = new Map(Object.entries(isJsonObject(decls.peerDependenciesMeta) ? decls.peerDependenciesMeta : {}));
    const declared = new Set([...dependencies.keys(), ...peerDependencies.keys(), ...dependencyBlock(decls.optionalDependencies).keys()]);
    for (const extension of matching) {
      for (const [dep, spec] of extension.dependencies) {
        if (!declared.has(dep)) {
          declared.add(dep);
          dependencies.set(dep, spec);
        }
      }
      for (const [dep, spec] of extension.peerDependencies) {
        if (!declared.has(dep)) {
          declared.add(dep);
          peerDependencies.set(dep, spec);
        }
      }
      for (const dep of extension.optionalPeers) {
        if (!meta.has(dep)) {
          meta.set(dep, { optional: true });
        }
      }
    }
    return {
      ...decls,
      dependencies: Object.fromEntries(dependencies),
      peerDependencies: Object.fromEntries(peerDependencies),
      peerDependenciesMeta: Object.fromEntries(meta),
    };
  }
}

/** No repairs at all. */
export const NO_PACKAGE_EXTENSIONS = new PackageExtensions([], "none");

/**
 * The extension document — Yarn's `packageExtensions` array of `[selector,
 * data]` pairs, the selector `name@range` — as the repairs it lists. Throws on
 * any shape it does not know, a field included: a repair half-applied would be
 * a silently different resolution.
 */
export function toPackageExtensions(json: unknown): IPackageExtension[] {
  if (!Array.isArray(json)) {
    throw new FabrError("expected an array of [selector, extension] pairs");
  }
  return json.map((entry: unknown) => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || !isJsonObject(entry[1])) {
      throw new FabrError(`expected a [selector, extension] pair, got ${JSON.stringify(entry)}`);
    }
    const [selector, data] = entry as [string, Record<string, unknown>];
    /* A scoped name starts with its own `@`, so the range separator is the last one. */
    const at = selector.lastIndexOf("@");
    if (at <= 0 || at === selector.length - 1) {
      throw new FabrError(`'${selector}' is not a name@range selector`);
    }
    for (const field of Object.keys(data)) {
      if (!EXTENSION_FIELDS.has(field)) {
        throw new FabrError(`'${selector}' extends unknown field '${field}'`);
      }
    }
    let range: SemverConstraint;
    try {
      range = parseConstraint(selector.substring(at + 1));
    } catch (err) {
      throw new FabrError(`'${selector}' has an invalid range: ${(err as Error).message}`);
    }
    const peerMeta = data.peerDependenciesMeta ?? {};
    if (!isJsonObject(peerMeta)) {
      throw new FabrError(`'${selector}' has a malformed peerDependenciesMeta`);
    }
    return {
      name: selector.substring(0, at),
      range,
      dependencies: dependencyBlock(data.dependencies),
      peerDependencies: dependencyBlock(data.peerDependencies),
      optionalPeers: new Set(
        Object.entries(peerMeta)
          .filter(([, flags]) => isJsonObject(flags) && flags.optional === true)
          .map(([dep]) => dep)
      ),
    };
  });
}

/** The list this plugin installation ships, read once. */
let installed: PackageExtensions | undefined;

/**
 * Stand in for the shipped list in this process. For a test running the plugin
 * from its sources, where no list is shipped; production never calls it.
 */
export function useInstalledPackageExtensions(extensions: PackageExtensions): void {
  installed = extensions;
}

export function installedPackageExtensions(): PackageExtensions {
  if (installed === undefined) {
    const file = packageLibFile("@fabr-build/js", PACKAGE_EXTENSIONS_FILE);
    const text = fs.readFileSync(file, "utf8");
    installed = new PackageExtensions(parseJson(text, file, toPackageExtensions), hashString(text));
  }
  return installed;
}
