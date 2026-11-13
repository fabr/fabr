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
 */

/**
 * PnP resolution: a specifier and its issuer to the file or directory it names.
 * The PnP table decides which package a name means to the issuer; the package's
 * own `exports`/`imports` map ({@link PackageExports}) decides what a subpath
 * within it means. Extensions, `main` and index files are left to the caller
 * (the tsc driver hands them to the compiler), or to
 * {@link PnpResolver.resolveUnqualified} for a caller of the PnP API.
 *
 * Runs in the drivers' build-step processes, so it depends on nothing but node.
 */

import * as fs from "node:fs";
import Module, { isBuiltin } from "node:module";
import * as path from "node:path";
import { parseJson, toJsonObject } from "../support/Json";
import type { IPnpSerializedState, PnpDependencyTarget } from "./PnPState";
import {
  exportedSubpath,
  exportsSubpath,
  type ExportsValue,
  type IConditionSet,
  resolveExportsAll,
  resolveImports,
  resolveImportsAll,
  toExportsValue,
} from "./PackageExports";
import {
  type IPackageInformation,
  type IPhysicalPackageLocator,
  type IPnpApi,
  type IResolveToUnqualifiedOptions,
  type IResolveUnqualifiedOptions,
  type ITopLevelPackageLocator,
  type PackageLocator,
  pnpError,
  type ResolveRequestOptions,
} from "./PnPApi";
import { IResolutionEdge, joinDepsPath } from "./ReadSet";
import { realpathKeepingVirtual, resolveVirtual } from "./VirtualPath";
import { toPosix } from "../support/Paths";

/** The PnP table's file name (Yarn's), as fabr stages it and the drivers load it. */
export const PNP_DATA_FILE = ".pnp.data.json";

/** A package's row: where its files are, and each name it may resolve, bound
 * to the locator of the row that answers it. */
interface IPnpRow {
  readonly location: string;
  readonly dependencies: Map<string, string>;
}

/** A locator as `name\0reference`, the key rows are held by (one name may have
 * several references). The top-level row's is `\0`. */
type LocatorKey = string;

function locatorKey(name: string | null, reference: PnpDependencyTarget): LocatorKey {
  return `${name ?? ""}\0${typeof reference === "string" ? reference : ""}`;
}

/** @return the `@types` package that supplies typings for `name`, in npm's
 * mangled spelling (`@scope/pkg` → `@types/scope__pkg`). */
export function typesPackageName(name: string): string {
  return name.startsWith("@") ? `@types/${name.substring(1).replace("/", "__")}` : `@types/${name}`;
}

/**
 * Split a bare specifier into the package it names and the subpath within it —
 * `three/examples/x` → `three` + `examples/x`, one segment deeper for a scoped
 * name. A relative or rooted specifier is not a package reference at all and is
 * rejected here (the caller resolves those against the filesystem).
 */
export function splitSpecifier(specifier: string): { name: string; subpath: string } | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#") || path.isAbsolute(specifier)) {
    return undefined;
  }
  const segments = specifier.split("/");
  const depth = specifier.startsWith("@") ? 2 : 1;
  if (segments.length < depth || segments[0] === "") {
    return undefined;
  }
  return { name: segments.slice(0, depth).join("/"), subpath: segments.slice(depth).join("/") };
}

/** A row as the location index holds it. `prefix` is its directory with a
 * trailing separator, so a prefix test cannot match a sibling whose name starts
 * the same. `stored` is true for a materialized package (`HARD`), false for a
 * source row (`SOFT`). `reference` is the row's PnP reference, where it has
 * one. */
interface ILocationEntry {
  prefix: string;
  locator: LocatorKey;
  name: string | null;
  stored: boolean;
  reference?: string;
}

/**
 * A PnP table loaded to answer lookups, through Yarn's PnP runtime API
 * ({@link IPnpApi}) and fabr's own queries.
 *
 * A lookup finds which package is asking from the issuer's path (the row with
 * the innermost containing location, else the top level), then reads that
 * row's dependencies. A name the row does not declare is answered by the
 * fallback pool (the compilation's own direct dependencies), except for a
 * source row or a row the table excludes from the pool.
 *
 * A resolver resolves under the conditions it was made with;
 * {@link resolveAll} and `resolveRequest` take others per lookup. It records
 * the package lookups and manifest reads it makes, for the run's report
 * ({@link edges}, {@link manifestsConsulted}, {@link readSetOf}).
 */
export class PnpResolver implements IPnpApi {
  public readonly VERSIONS = { std: 3, resolveVirtual: 1, getAllLocators: 1 };
  public readonly topLevel: ITopLevelPackageLocator = { name: null, reference: null };
  /** The directory the manifest's relative locations resolve against. */
  private readonly root: string;
  /** The table's rows as written, for the {@link IPnpApi} methods: name →
   * reference → information. */
  private readonly registry = new Map<string | null, Map<string | null, IPackageInformation>>();
  private readonly dependencyTreeRoots: IPhysicalPackageLocator[];
  private readonly topLevelFallback: boolean;
  /** The paths, relative to the root, that belong to no package of the table:
   * a file there is resolved as node would resolve it (Yarn's `ignorePattern`). */
  private readonly ignored: RegExp | undefined;
  private readonly fallbackPool = new Map<string, PnpDependencyTarget>();
  private readonly fallbackExclusions = new Map<string, Set<string>>();
  /** Rows by locator. */
  private readonly rows = new Map<LocatorKey, IPnpRow>();
  /** Every row not marked `discardFromLookup`, under its location and, where
   * different, its realpath; longest prefix first. */
  private readonly byLocation: ILocationEntry[] = [];
  /** The same entries by the directory they name, each list last-registered
   * first ({@link innermostAt}). */
  private readonly byDirectory = new Map<string, ILocationEntry[]>();
  /** The physical directory behind each virtual location, as written and as
   * its realpath. No row is located there ({@link owning}). */
  private readonly virtualized: string[] = [];
  /** {@link treeRoots}, computed on first use. */
  private cachedTreeRoots: ReadonlyArray<string> | undefined;
  /** {@link instanceNameOf} by resolved path, memoized. */
  private readonly instanceNames = new Map<string, string | undefined>();
  /** {@link pathNameOf} by resolved path, memoized. */
  private readonly pathNames = new Map<string, string | undefined>();
  /** {@link routes}, computed on first use. */
  private cachedRoutes: Map<LocatorKey, string[]> | undefined;
  /** The fallback pool, name → locator; empty unless the table enables it. */
  private readonly fallback = new Map<string, string>();
  private readonly topLevelKey: LocatorKey;
  /** The source rows (`SOFT`): the top-level row, and the self row naming the
   * build's sources as a package. The fallback pool does not answer for them
   * ({@link locationOf}). */
  private readonly sources = new Set<LocatorKey>();
  /** The rows the table excludes from the fallback pool (the packages this
   * build produced); each still answers the names it declares. */
  private readonly excluded = new Set<LocatorKey>();
  /** {@link locatorOf} by the file's directory, memoized. */
  private readonly locatorByDirectory = new Map<string, LocatorKey>();
  /** Each package's `exports`/`imports` by location, read once, a package with
   * no manifest included. */
  private readonly manifests = new Map<string, IPackageManifest>();
  /** The conditions this resolver resolves under unless a lookup gives others. */
  private readonly conditions: ReadonlySet<string>;
  /** Whether an invalid `exports`/`imports` map is refused, as node refuses
   * it, or read as the TypeScript compiler reads it. */
  private readonly validate: boolean;
  /** {@link manifestsConsulted}. */
  private readonly consultedManifests = new Set<string>();
  /** Every package lookup made, by `<requirer>\0<name>`, each recorded once. */
  private readonly resolutions = new Map<string, IResolutionEdge>();

  /**
   * @param root the directory the table's relative locations resolve against
   * (the staged workspace).
   * @param conditions the export conditions this resolver satisfies, e.g.
   * `types`/`import` for a compiler. `default` is always satisfied.
   */
  constructor(state: IPnpSerializedState, root: string, conditions: Iterable<string>, options: IPnpResolverOptions = {}) {
    this.ignored =
      state.ignorePatternData === null || state.ignorePatternData === undefined ? undefined : new RegExp(state.ignorePatternData);
    this.conditions = new Set(conditions);
    this.validate = options.validateExports ?? true;
    this.root = canonicalPath(root);
    this.topLevelKey = locatorKey(null, null);
    this.dependencyTreeRoots = state.dependencyTreeRoots.map(({ name, reference }) => ({ name, reference }));
    this.topLevelFallback = state.enableTopLevelFallback;
    for (const [name, target] of state.fallbackPool) {
      this.fallbackPool.set(name, target);
    }
    for (const [name, references] of state.fallbackExclusionList) {
      this.fallbackExclusions.set(name, new Set(references));
    }
    for (const [name, references] of state.packageRegistryData) {
      const store = this.registry.get(name) ?? new Map<string | null, IPackageInformation>();
      this.registry.set(name, store);
      for (const [reference, info] of references) {
        store.set(reference === null ? null : String(reference), {
          packageLocation: path.join(this.root, info.packageLocation),
          packageDependencies: new Map(info.packageDependencies),
          packagePeers: new Set(info.packagePeers ?? []),
          linkType: info.linkType,
          discardFromLookup: info.discardFromLookup ?? false,
        });
        const key = locatorKey(name, reference);
        const location = path.resolve(this.root, info.packageLocation);
        this.rows.set(key, { location, dependencies: dependencyMap(info.packageDependencies) });
        if (info.linkType === "SOFT") {
          this.sources.add(key);
        }
        if (info.discardFromLookup !== true) {
          const stored = info.linkType !== "SOFT";
          const held = typeof reference === "string" ? reference : undefined;
          this.byLocation.push({ prefix: withSeparator(location), locator: key, name, stored, reference: held });
          /* Index the row under its realpath too: a package is reached through
           * the workspace's link to the tree pool, and a compiler that does not
           * preserve symlinks reports files by their real path. */
          const real = realpathOf(location);
          if (real !== location) {
            this.byLocation.push({ prefix: withSeparator(real), locator: key, name, stored, reference: held });
          }
          const physical = resolveVirtual(location);
          if (physical !== location) {
            this.virtualized.push(withSeparator(physical), withSeparator(realpathOf(physical)));
          }
        }
      }
    }
    for (const [name, references] of state.fallbackExclusionList) {
      for (const reference of references) {
        this.excluded.add(locatorKey(name, reference));
      }
    }
    if (state.enableTopLevelFallback) {
      for (const [name, target] of state.fallbackPool) {
        const key = targetKey(name, target);
        if (key !== undefined) {
          this.fallback.set(name, key);
        }
      }
    }
    /* Longest first: a package's location can sit inside another's (bundled
     * content), and the innermost answers. */
    this.byLocation.sort((left, right) => right.prefix.length - left.prefix.length);
    for (const entry of this.byLocation) {
      const at = entry.prefix.slice(0, -1);
      const held = this.byDirectory.get(at) ?? [];
      this.byDirectory.set(at, held);
      /* Rows sharing a location answer for it last-registered first, as Yarn's
       * runtime does. */
      held.unshift(entry);
    }
    this.mergeSharedLocations();
  }

  /**
   * Give rows that share a location the union of their dependencies, each row's
   * own bindings kept, and a name several others bind taken from the first in
   * table order. Rows share a location where one content is resolved under two
   * names (an alias beside the package); the table gives each wiring of a
   * content its own virtual location, so such rows differ only in the name each
   * resolves itself by.
   */
  private mergeSharedLocations(): void {
    const byLocation = new Map<string, LocatorKey[]>();
    for (const [key, row] of this.rows) {
      byLocation.set(row.location, [...(byLocation.get(row.location) ?? []), key]);
    }
    for (const keys of byLocation.values()) {
      if (keys.length < 2) {
        continue;
      }
      /* Snapshot before merging, so a row contributes only what it declared. */
      const declared = keys.map(key => [...this.rows.get(key)!.dependencies] as Array<[string, string]>);
      for (const key of keys) {
        const own = this.rows.get(key)!;
        for (const [name, target] of declared.flat()) {
          if (!own.dependencies.has(name)) {
            own.dependencies.set(name, target);
          }
        }
      }
    }
  }

  /** Load `.pnp.data.json` from `root`, or return undefined where there is none
   * (a `node_modules` layout). */
  public static load(root: string, conditions: Iterable<string>, options: IPnpResolverOptions = {}): PnpResolver | undefined {
    const manifest = path.join(root, PNP_DATA_FILE);
    if (!fs.existsSync(manifest)) {
      return undefined;
    }
    return new PnpResolver(JSON.parse(fs.readFileSync(manifest, "utf8")) as IPnpSerializedState, root, conditions, options);
  }

  /**
   * @return the innermost entry whose directory is `target` or an ancestor of
   * it and that `admits` accepts, or undefined if none. Walks upward from
   * `target`, past directories whose entries `admits` rejects.
   */
  private innermostAt(target: string, admits: (entry: ILocationEntry) => boolean): ILocationEntry | undefined {
    let at = target;
    for (;;) {
      for (const entry of this.byDirectory.get(at) ?? []) {
        if (admits(entry)) {
          return entry;
        }
      }
      const up = path.dirname(at);
      if (up === at) {
        return undefined;
      }
      at = up;
    }
  }

  /**
   * @return `found`, the entry answering for `target`; throws where `target`
   * lies in the physical directory of a package the table locates only
   * virtually, since no row is located there.
   */
  private owning(target: string, found: ILocationEntry | undefined): ILocationEntry | undefined {
    const inside = withSeparator(target);
    if (this.virtualized.some(tree => inside.startsWith(tree))) {
      throw new Error(
        `pnp: '${target}' is the physical path of a package the manifest locates virtually; no package is located there`
      );
    }
    return found;
  }

  /**
   * Look up which row a file belongs to: the one whose location most closely
   * contains its directory, else the top level. Of rows sharing a location, the
   * last registered; their dependencies are merged
   * ({@link mergeSharedLocations}). Throws as {@link owning} does.
   */
  public locatorOf(file: string): LocatorKey {
    const directory = path.dirname(canonicalPath(file));
    const known = this.locatorByDirectory.get(directory);
    if (known !== undefined) {
      return known;
    }
    const locator =
      this.owning(
        directory,
        this.innermostAt(directory, () => true)
      )?.locator ?? this.topLevelKey;
    this.locatorByDirectory.set(directory, locator);
    return locator;
  }

  /**
   * Look up the package name and subpath a consumer would write to reach
   * `file`, the reverse of {@link locationOf}, or undefined where no
   * materialized package contains it (the source rows never answer).
   *
   * The name is the first, in code-unit order, of the rows located at the
   * package's directory. The subpath is the one the package's `exports` map
   * publishes for the file ({@link exportedSubpath}), else the file's path
   * within the package; `""` for the package itself. Throws as {@link owning}
   * does, or where the `exports` map is invalid.
   */
  public packageOf(file: string): { name: string; subpath: string } | undefined {
    const target = canonicalPath(file);
    /* Start at the path itself, so a package root matches its own location. */
    const innermost = this.owning(
      target,
      this.innermostAt(target, entry => entry.stored && entry.name !== null)
    );
    if (innermost === undefined) {
      return undefined;
    }
    /* The rows sharing a location are that directory's list in the index. */
    const sharing = (this.byDirectory.get(innermost.prefix.slice(0, -1)) ?? []).filter(entry => entry.name !== null);
    const relative = toPosix(path.relative(innermost.prefix, target));
    return {
      name: sharing.map(entry => entry.name!).sort()[0],
      /* Read through the row's location, not the matched prefix (which may be
       * its realpath), so each package has one manifest cache entry. */
      subpath: this.publishedAs(this.rows.get(innermost.locator)!.location, relative),
    };
  }

  /** @return the subpath a consumer writes to reach the package-relative
   * `file`: its published name where the package's `exports` map gives it one,
   * else the file itself. */
  private publishedAs(location: string, file: string): string {
    const exports = this.manifestAt(location).exports;
    const published =
      exports === undefined || exports === null
        ? undefined
        : describing(location, () => exportedSubpath(exports, exportsSubpath(file), this.conditions, this.validate));
    if (published === undefined) {
      return file;
    }
    return published === "." ? "" : published.slice(2);
  }

  /**
   * @return the directories holding this table's materialized packages, each
   * with a trailing separator, as located and as realpaths, virtual locations
   * mapped to their physical directory. A path under one names the build's
   * layout.
   */
  public get treeRoots(): ReadonlyArray<string> {
    this.cachedTreeRoots ??= [
      ...new Set(
        this.byLocation
          .filter(entry => entry.stored)
          .map(entry => withSeparator(path.dirname(resolveVirtual(entry.prefix.slice(0, -1)))))
      ),
    ];
    return this.cachedTreeRoots;
  }

  /**
   * @return the directory of the package `name` binds to from `issuer`: by the
   * issuer's row, else by the fallback pool unless the issuer is a source row
   * or excluded from the pool; undefined where neither answers. Records the
   * lookup ({@link edges}).
   */
  public locationOf(name: string, issuer: string): string | undefined {
    const locator = this.locatorOf(issuer);
    const from = this.rows.get(locator);
    const instance = this.sources.has(locator) ? undefined : instanceOfLocator(locator);
    const barred = this.sources.has(locator) || this.excluded.has(locator);
    const own = from?.dependencies.get(name);
    const bound = own ?? (barred ? undefined : this.fallback.get(name));
    this.recordResolution(instance ?? "", name, bound, own !== undefined);
    return bound === undefined ? undefined : this.rows.get(bound)?.location;
  }

  /**
   * Record that `requirer` (an instance name, `""` for the compilation) looked
   * `name` up and got the row `bound`, by its own row or not. A lookup nothing
   * answered is recorded as `absent`; one a source row answered is not
   * recorded.
   */
  private recordResolution(requirer: string, name: string, bound: string | undefined, own: boolean): void {
    if (bound === undefined) {
      this.resolutions.set(`${requirer}\0${name}`, { from: requirer, name, to: "", via: "absent" });
    } else if (!this.sources.has(bound)) {
      this.resolutions.set(`${requirer}\0${name}`, {
        from: requirer,
        name,
        to: instanceOfLocator(bound),
        via: own ? "own" : "fallback",
      });
    }
  }

  /**
   * @return the location of the source row `name` binds to by `issuer`'s row
   * (the self row, naming the build's sources as a package), or undefined where
   * it binds to anything else or nothing. Records nothing.
   */
  public sourceLocationOf(name: string, issuer: string): string | undefined {
    const bound = this.rows.get(this.locatorOf(issuer))?.dependencies.get(name);
    return bound !== undefined && this.sources.has(bound) ? this.rows.get(bound)?.location : undefined;
  }

  /** @return every package lookup this resolver has made, except those a source
   * row answered. */
  public edges(): ReadonlyArray<IResolutionEdge> {
    return [...this.resolutions.values()];
  }

  /** @return the package locations whose `package.json` this resolver has
   * consulted for its `exports` or `imports`. */
  public manifestsConsulted(): ReadonlyArray<string> {
    return [...this.consultedManifests];
  }

  /**
   * Get the path names ({@link pathNameOf}) of what a run read of the
   * materialized packages, for its report: each of `files` (files outside every
   * package are left out), the `package.json` of each package whose manifest
   * this resolver consulted, and for each package lookup it made, the
   * requirer's route, the name, then `package.json`. A lookup the requirer's
   * own row did not answer (the fallback pool did, or nothing) adds
   * `<name> package.json` too.
   */
  public readSetOf(files: Iterable<string>): string[] {
    const names = new Set<string>();
    const add = (file: string): void => {
      const name = this.pathNameOf(file);
      if (name !== undefined) {
        names.add(name);
      }
    };
    for (const file of files) {
      add(file);
    }
    for (const location of this.consultedManifests) {
      add(path.join(location, "package.json"));
    }
    for (const edge of this.resolutions.values()) {
      const at = this.routeOf(edge.from);
      if (at !== undefined) {
        names.add(joinDepsPath([...at, edge.name, "package.json"]));
      }
      if (edge.via !== "own") {
        names.add(joinDepsPath([edge.name, "package.json"]));
      }
    }
    return [...names];
  }

  /**
   * @return the instance name of a resolved file: `<name>#<reference>`, then
   * `/<path within the package>` unless it is the package's own directory; or
   * undefined for anything outside a materialized package (the sources, the
   * tool's own install, the compiler's libs). The reference is the row's
   * locator reference, so the name holds no path of this machine. Throws as
   * {@link owning} does.
   */
  public instanceNameOf(file: string): string | undefined {
    const target = canonicalPath(file);
    const known = this.instanceNames.get(target);
    if (known !== undefined || this.instanceNames.has(target)) {
      return known;
    }
    const innermost = this.owning(
      target,
      this.innermostAt(target, entry => entry.stored && entry.name !== null)
    );
    const name = innermost?.reference === undefined ? undefined : instanceName(innermost, target);
    this.instanceNames.set(target, name);
    return name;
  }

  /**
   * @return the path name of a resolved file: its package's canonical route
   * ({@link routes}), then the file within the package, in the flat spelling
   * (`@types/jest expect index.d.ts`), as the step's key, recorded base and
   * change lists name it. Undefined for anything outside a materialized package,
   * as {@link instanceNameOf}, or in a package no route reaches.
   */
  public pathNameOf(file: string): string | undefined {
    const target = canonicalPath(file);
    const known = this.pathNames.get(target);
    if (known !== undefined || this.pathNames.has(target)) {
      return known;
    }
    const innermost = this.owning(
      target,
      this.innermostAt(target, entry => entry.stored && entry.name !== null)
    );
    const route = innermost === undefined ? undefined : this.routes().get(innermost.locator);
    const relative = innermost === undefined ? "" : toPosix(path.relative(innermost.prefix, target));
    const name = route === undefined ? undefined : joinDepsPath([...route, ...(relative === "" ? [] : [relative])]);
    this.pathNames.set(target, name);
    return name;
  }

  /**
   * @return the path name {@link readSetOf} reports a bare specifier's failed
   * package lookup from `issuer` under: the issuer's route, the package name,
   * then `package.json`. Undefined where that lookup succeeded, was never
   * made, or the specifier names no package. Answered from the lookups already
   * recorded; makes none.
   */
  public failedLookupOf(specifier: string, issuer: string): string | undefined {
    const split = splitSpecifier(specifier);
    if (split === undefined) {
      return undefined;
    }
    const locator = this.locatorOf(issuer);
    const requirer = this.sources.has(locator) ? "" : instanceOfLocator(locator);
    const recorded = this.resolutions.get(`${requirer}\0${split.name}`);
    if (recorded === undefined || recorded.via !== "absent") {
      return undefined;
    }
    const route = this.routeOf(requirer);
    return route === undefined ? undefined : joinDepsPath([...route, split.name, "package.json"]);
  }

  /** @return the canonical route to the package with instance name `instance`,
   * `[]` for `""` (the top level), or undefined where no route reaches it. */
  public routeOf(instance: string): string[] | undefined {
    if (instance === "") {
      return [];
    }
    const split = instance.lastIndexOf("#");
    const locator = split < 0 ? undefined : locatorKey(instance.slice(0, split), instance.slice(split + 1));
    return locator === undefined ? undefined : this.routes().get(locator);
  }

  /**
   * @return each package's canonical route: the names along the shortest chain
   * of dependencies from the top-level row, breadth-first, the first found in
   * table order winning a tie. Source rows get no route and are not walked
   * through. Computed on first use.
   */
  private routes(): Map<LocatorKey, string[]> {
    if (this.cachedRoutes !== undefined) {
      return this.cachedRoutes;
    }
    const routes = new Map<LocatorKey, string[]>();
    let frontier = [...(this.rows.get(this.topLevelKey)?.dependencies ?? [])].map(([name, locator]) => ({ locator, route: [name] }));
    while (frontier.length > 0) {
      const next: Array<{ locator: LocatorKey; route: string[] }> = [];
      for (const { locator, route } of frontier) {
        if (routes.has(locator) || this.sources.has(locator)) {
          continue;
        }
        routes.set(locator, route);
        for (const [name, dep] of this.rows.get(locator)?.dependencies ?? []) {
          next.push({ locator: dep, route: [...route, name] });
        }
      }
      frontier = next;
    }
    this.cachedRoutes = routes;
    return routes;
  }

  /**
   * Resolve a bare or `#` specifier from `issuer`: to the file the package's
   * `exports` map gives the subpath, or, for a package with no `exports`, to its
   * directory joined with the subpath, for the caller to probe. A `#` specifier
   * resolves through the issuing package's `imports` map, which may redirect to
   * another package resolved from `issuer`.
   *
   * Undefined where no row answers the package name, or where the package's map
   * does not expose the subpath; do not probe the filesystem in the second case.
   * Throws where the map is invalid ({@link PackageExports}). Records the lookup.
   */
  public resolveSpecifier(specifier: string, issuer: string): string | undefined {
    return this.resolveAll(specifier, issuer)[0];
  }

  /**
   * @return every file the specifier may name, in the order the map lists them
   * ({@link resolveExportsAll}): {@link resolveSpecifier}'s answer first, then
   * the rest, which a compiler looking for declarations walks. Empty where
   * {@link resolveSpecifier} is undefined.
   *
   * `conditions` replaces the resolver's own for this lookup (an import written
   * for the other module system, TypeScript's `resolution-mode`).
   */
  public resolveAll(specifier: string, issuer: string, conditions: IConditionSet = this.conditions): string[] {
    if (specifier.startsWith("#")) {
      return this.resolveSubpathImport(specifier, issuer, conditions);
    }
    const split = splitSpecifier(specifier);
    const location = split && this.locationOf(split.name, issuer);
    if (location === undefined || split === undefined) {
      return [];
    }
    /* A subpath with a trailing slash names a directory, which a package with
     * `exports` does not publish. `pkg/` names the package itself. */
    if (specifier.endsWith("/") && split.subpath !== "" && this.manifestAt(location).exports != null) {
      return [];
    }
    return this.within(location, exportsSubpath(split.subpath), conditions);
  }

  /** @return the files the package at `location` gives `subpath` by its
   * `exports` map, or, with no map, the one path for the caller to probe. */
  private within(location: string, subpath: string, conditions: IConditionSet): string[] {
    const exports = this.manifestAt(location).exports;
    /* Node reads `"exports": null` as no map, falling back to `main`. */
    if (exports === undefined || exports === null) {
      return [subpath === "." ? location : path.join(location, subpath.slice(2))];
    }
    const targets = describing(location, () => resolveExportsAll(exports, subpath, conditions, this.validate));
    return targets.map(target => path.join(location, target.slice(2)));
  }

  /** @return true if the package `name` binds to from `issuer` has an `exports`
   * map, otherwise false. Records the lookup. */
  public hasExportsMap(name: string, issuer: string): boolean {
    const location = this.locationOf(name, issuer);
    return location !== undefined && this.manifestAt(location).exports != null;
  }

  /** Resolve a `#name` specifier through the `imports` map of `issuer`'s
   * package scope, to a file of that package, or to another package's name
   * resolved from `issuer`. */
  private resolveSubpathImport(specifier: string, issuer: string, conditions: IConditionSet): string[] {
    const scope = this.scopeOf(issuer);
    const imports = scope && this.manifestAt(scope).imports;
    if (scope === undefined || imports === undefined || imports === null) {
      return [];
    }
    const targets = describing(scope, () => resolveImportsAll(imports, specifier, conditions, this.validate));
    const found = targets.flatMap(target =>
      target.startsWith("./") ? [path.join(scope, target.slice(2))] : this.resolveAll(target, issuer, conditions)
    );
    return [...new Set(found)];
  }

  /**
   * @return the package scope of `file`, as node, Yarn and the compiler find
   * it: the nearest directory holding a `package.json`, at or above the file's
   * directory (a nested `dist/package.json` included) and no higher than the
   * workspace root; undefined where there is none. A `file` ending in `/` is a
   * directory, and its own `package.json` counts.
   */
  private scopeOf(file: string): string | undefined {
    const root = this.root;
    for (let dir = isDirectory(file) ? canonicalPath(file) : path.dirname(canonicalPath(file)); ; dir = path.dirname(dir)) {
      if (fs.existsSync(path.join(resolveVirtual(dir), "package.json"))) {
        return dir;
      }
      if (dir === root || !dir.startsWith(root + path.sep)) {
        return undefined;
      }
    }
  }

  /** @return the `exports`/`imports` of the package at `location`, empty where
   * it declares neither or has no readable manifest. Records `location` in
   * {@link manifestsConsulted}. */
  private manifestAt(location: string): IPackageManifest {
    /* Record every consultation, cached or not. */
    this.consultedManifests.add(location);
    const held = this.manifests.get(location);
    if (held !== undefined) {
      return held;
    }
    const read = readExportMaps(location);
    this.manifests.set(location, read);
    return read;
  }

  /* ---- The PnP runtime API ({@link IPnpApi}), answered as Yarn's runtime
   * answers it. Its lookups are recorded as the methods above record theirs.
   * ---- */

  public getLocator(name: string, referencish: string | [string, string]): IPhysicalPackageLocator {
    return Array.isArray(referencish) ? { name: referencish[0], reference: referencish[1] } : { name, reference: referencish };
  }

  public getDependencyTreeRoots(): IPhysicalPackageLocator[] {
    return [...this.dependencyTreeRoots];
  }

  public getAllLocators(): IPhysicalPackageLocator[] {
    return [...this.registry].flatMap(([name, store]) =>
      name === null ? [] : [...store.keys()].flatMap(reference => (reference === null ? [] : [{ name, reference }]))
    );
  }

  public getPackageInformation(locator: PackageLocator): IPackageInformation | null {
    return this.registry.get(locator.name)?.get(locator.reference) ?? null;
  }

  /** @return the package whose location most closely contains `location` (or
   * its realpath), or null for a path the table's ignore pattern matches or no
   * row contains. */
  public findPackageLocator(location: string): PackageLocator | null {
    const target = canonicalPath(location);
    if (this.ignored !== undefined && this.ignored.test(toPosix(path.relative(this.root, target)))) {
      return null;
    }
    const entry = this.owning(
      target,
      this.innermostAt(target, () => true)
    );
    if (entry === undefined) {
      return null;
    }
    const split = entry.locator.indexOf("\0");
    const name = entry.locator.slice(0, split);
    return entry.name === null ? this.topLevel : { name, reference: entry.locator.slice(split + 1) };
  }

  public resolveVirtual(file: string): string | null {
    const physical = resolveVirtual(file);
    return physical === file ? null : physical;
  }

  public resolveToUnqualified(request: string, issuer: string | null, opts: IResolveToUnqualifiedOptions = {}): string | null {
    const considerBuiltins = opts.considerBuiltins ?? true;
    if (request.startsWith("#")) {
      throw new Error("resolveToUnqualified can not handle private import mappings");
    }
    if (request === "pnpapi") {
      throw pnpError("UNSUPPORTED", "pnp: fabr's manifests have no runtime module to resolve 'pnpapi' to", { request });
    }
    if (considerBuiltins && isBuiltin(request)) {
      return null;
    }
    const named = PACKAGE_REQUEST.exec(request);
    if (named === null) {
      if (path.isAbsolute(request)) {
        return path.normalize(request);
      }
      const from = requireIssuer(request, issuer);
      return path.normalize(path.join(isDirectory(from) ? canonicalPath(from) : path.dirname(canonicalPath(from)), request));
    }
    const from = requireIssuer(request, issuer);
    const [, dependencyName, subpath] = named;
    const issuerLocator = this.findPackageLocator(from);
    if (issuerLocator === null) {
      throw pnpError("BUILTIN_NODE_RESOLUTION_FAILED", `pnp: '${from}' is outside the dependency tree`, { request, issuer: from });
    }
    const issuerInformation = this.informationOf(issuerLocator);
    const issuerKey = locatorKey(issuerLocator.name, issuerLocator.reference);
    const requirer = this.sources.has(issuerKey) ? "" : instanceOfLocator(issuerKey);
    let bound = issuerInformation.packageDependencies.get(dependencyName);
    const own = bound !== undefined && bound !== null;
    let fallback: PnpDependencyTarget = null;
    if (bound === undefined || bound === null) {
      const excluded = issuerLocator.name !== null && this.fallbackExclusions.get(issuerLocator.name)?.has(issuerLocator.reference);
      if (issuerLocator.name !== null && !excluded && this.topLevelFallback) {
        const fromTop = this.informationOf(this.topLevel).packageDependencies.get(dependencyName);
        if (fromTop !== undefined && fromTop !== null) {
          bound = fromTop;
        } else {
          fallback = this.fallbackPool.get(dependencyName) ?? null;
        }
      }
    }
    if (bound === undefined || bound === null) {
      if (fallback === null) {
        this.recordResolution(requirer, dependencyName, undefined, false);
        const who = issuerLocator.name === null ? "your application" : issuerLocator.name;
        throw bound === null
          ? pnpError(
              "MISSING_PEER_DEPENDENCY",
              `pnp: ${who} tried to access ${dependencyName} (a peer dependency), which nothing provides`,
              {
                request,
                issuer: from,
                dependencyName,
              }
            )
          : pnpError(
              "UNDECLARED_DEPENDENCY",
              `pnp: ${who} tried to access ${dependencyName}, but it isn't declared in its dependencies`,
              {
                request,
                issuer: from,
                dependencyName,
              }
            );
      }
      bound = fallback;
    }
    const dependency = this.getLocator(dependencyName, bound);
    this.recordResolution(requirer, dependencyName, locatorKey(dependency.name, dependency.reference), own);
    const location = this.informationOf(dependency).packageLocation;
    if (!location) {
      throw pnpError("MISSING_DEPENDENCY", `pnp: ${dependency.name}@${dependency.reference} has no location`, {
        request,
        issuer: from,
      });
    }
    return path.normalize(subpath ? path.join(location, subpath) : location);
  }

  public resolveUnqualified(unqualified: string, opts: IResolveUnqualifiedOptions = {}): string {
    const extensions = opts.extensions ?? Object.keys((Module as unknown as { _extensions: Record<string, unknown> })._extensions);
    const candidates: string[] = [];
    const found = qualify(unqualified, candidates, extensions);
    if (found === null) {
      throw pnpError("QUALIFIED_PATH_RESOLUTION_FAILED", `pnp: none of these could be accessed: ${candidates.join(", ")}`, {
        unqualifiedPath: unqualified,
        extensions,
      });
    }
    return path.normalize(found);
  }

  public resolveRequest(request: string, issuer: string | null, opts: ResolveRequestOptions = {}): string | null {
    const conditions = opts.conditions ?? DEFAULT_CONDITIONS;
    if (request.startsWith("#")) {
      return this.resolvePrivateRequest(request, requireIssuer(request, issuer), conditions, opts);
    }
    const unqualified = this.resolveToUnqualified(request, issuer, opts);
    if (unqualified === null) {
      return null;
    }
    const remapped =
      opts.considerBuiltins === false || !isBuiltin(request) ? this.applyExports(request, unqualified, conditions) : unqualified;
    return this.resolveUnqualified(remapped, { extensions: opts.extensions });
  }

  /** @return a locator's information, which the table must hold. */
  private informationOf(locator: PackageLocator): IPackageInformation {
    const information = this.getPackageInformation(locator);
    if (information === null) {
      throw pnpError("INTERNAL", `pnp: no entry for ${locator.name ?? "<top level>"}@${locator.reference ?? ""}`);
    }
    return information;
  }

  /** Map `unqualified` through its package's `exports` map, where the request
   * is not a path and the package has a map; anything else unchanged. Throws
   * EXPORTS_RESOLUTION_FAILED where the map is invalid or does not export the
   * subpath. */
  private applyExports(request: string, unqualified: string, conditions: ReadonlySet<string>): string {
    if (STRICT_REQUEST.test(request) || path.isAbsolute(request)) {
      return unqualified;
    }
    const owner = this.findPackageLocator(path.join(unqualified, "internal.js"));
    if (owner === null) {
      throw pnpError("INTERNAL", `pnp: no package holds '${unqualified}'`);
    }
    const location = this.informationOf(owner).packageLocation;
    const exports = this.manifestAt(location).exports;
    if (exports === undefined || exports === null) {
      return unqualified;
    }
    const relative = toPosix(path.relative(location, unqualified));
    const subpath = relative === "" ? "." : `./${relative}`;
    let target: string[];
    try {
      target = resolveExportsAll(exports, subpath, conditions, this.validate);
    } catch (err: unknown) {
      throw pnpError(
        "EXPORTS_RESOLUTION_FAILED",
        err instanceof Error ? err.message : String(err),
        { subpath },
        "ERR_INVALID_PACKAGE_CONFIG"
      );
    }
    if (target.length === 0) {
      throw pnpError(
        "EXPORTS_RESOLUTION_FAILED",
        `pnp: ${subpath} is not exported by ${path.join(location, "package.json")}`,
        { subpath },
        "ERR_PACKAGE_PATH_NOT_EXPORTED"
      );
    }
    return path.join(location, target[0].slice(2));
  }

  /** Resolve a `#name` request through the `imports` map of the issuer's
   * package scope. Throws with code `ERR_PACKAGE_IMPORT_NOT_DEFINED` where the
   * map does not define it, and throws where it maps to another `#` import. */
  private resolvePrivateRequest(
    request: string,
    issuer: string,
    conditions: ReadonlySet<string>,
    opts: ResolveRequestOptions
  ): string | null {
    const location = this.scopeOf(issuer);
    const imports = location === undefined ? undefined : this.manifestAt(location).imports;
    const target = imports === undefined || imports === null ? undefined : resolveImports(imports, request, conditions, this.validate);
    if (target === undefined || location === undefined) {
      throw Object.assign(new Error(`pnp: '${request}' is not defined by the imports of the package holding '${issuer}'`), {
        code: "ERR_PACKAGE_IMPORT_NOT_DEFINED",
      });
    }
    if (target.startsWith("./")) {
      return this.resolveUnqualified(path.join(location, target.slice(2)), { extensions: opts.extensions });
    }
    if (target.startsWith("#")) {
      throw new Error("Mapping from one private import to another isn't allowed");
    }
    return this.resolveRequest(target, issuer, opts);
  }
}

/** The conditions a {@link PnpResolver.resolveRequest} satisfies when its
 * caller names none: node's CommonJS world. */
const DEFAULT_CONDITIONS: ReadonlySet<string> = new Set(["node", "require"]);

/** A request naming a package: its name (optionally `node:`-prefixed, scoped),
 * then any subpath. Anything else is a path. */
const PACKAGE_REQUEST = /^(?![a-zA-Z]:[\\/]|\\\\|\.{0,2}(?:\/|$))((?:node:)?(?:@[^/]+\/)?[^/]+)\/*(.*|)$/;

/** A request that is a path: rooted, or `.`/`..` relative. */
const STRICT_REQUEST = /^(\/|\.{1,2}(\/|$))/;

/**
 * Resolve `file`, a path as the host or a tool spells it, as the resolver
 * compares paths: absolute, with a Windows drive letter in upper case, since
 * Windows reads `c:\x` and `C:\x` as one path and callers spell it either way.
 */
function canonicalPath(file: string): string {
  return path.resolve(file).replace(/^[a-z](?=:)/, drive => drive.toUpperCase());
}

/** @return true if `file` names a directory, by ending in a separator, otherwise false. */
function isDirectory(file: string): boolean {
  return file.endsWith("/") || file.endsWith(path.sep);
}

/** @return the issuer a non-absolute request needs, throwing where there is
 * none. */
function requireIssuer(request: string, issuer: string | null): string {
  if (!issuer) {
    throw pnpError("API_ERROR", "pnp: an issuer is required when the request is neither a builtin nor absolute", { request });
  }
  return issuer;
}

/**
 * Resolve an unqualified path as node resolves a file: the file itself, a
 * directory's `main`, the path with each extension, a directory's `index` with
 * each; null where none exists. Each candidate tried is appended to
 * `candidates`. The filesystem is asked by physical path; the answer keeps the
 * virtual path it was asked by.
 */
function qualify(unqualified: string, candidates: string[], extensions: string[]): string | null {
  candidates.push(unqualified);
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(resolveVirtual(unqualified));
  } catch {
    stat = undefined;
  }
  if (stat !== undefined && !stat.isDirectory()) {
    return realpathKeepingVirtual(unqualified);
  }
  if (stat?.isDirectory() === true) {
    const main = readManifest(unqualified)?.main;
    const next = typeof main === "string" && main !== "" ? path.resolve(unqualified, main) : undefined;
    if (next !== undefined && next !== unqualified) {
      const found = qualify(next, candidates, extensions);
      if (found !== null) {
        return found;
      }
    }
  }
  for (const extension of extensions) {
    const candidate = `${unqualified}${extension}`;
    candidates.push(candidate);
    if (fs.existsSync(resolveVirtual(candidate))) {
      return candidate;
    }
  }
  if (stat?.isDirectory() === true) {
    for (const extension of extensions) {
      const candidate = path.join(unqualified, `index${extension}`);
      candidates.push(candidate);
      if (fs.existsSync(resolveVirtual(candidate))) {
        return candidate;
      }
    }
  }
  return null;
}

/** How a resolver judges what it reads. */
export interface IPnpResolverOptions {
  /** False to read an invalid `exports`/`imports` map as the TypeScript compiler
   * does, rather than refuse it as node does. Defaults to true. */
  validateExports?: boolean;
}

/** The fields of a `package.json` resolution reads. */
interface IPackageManifest {
  readonly exports?: ExportsValue;
  readonly imports?: ExportsValue;
}

/** @return the `package.json` of the package directory `location` (virtual
 * or physical), or undefined where there is none, it cannot be read, or it is
 * not a JSON object. */
export function readManifest(location: string): Record<string, unknown> | undefined {
  try {
    const text = fs.readFileSync(path.join(resolveVirtual(location), "package.json"), "utf8");
    return parseJson(text, `${location}/package.json`, toJsonObject);
  } catch {
    return undefined;
  }
}

/** @return the `exports` and `imports` of the package at `location`, empty
 * where it declares neither or has no manifest to read. */
function readExportMaps(location: string): IPackageManifest {
  const manifest = readManifest(location);
  return {
    ...(manifest?.exports === undefined ? {} : { exports: toExportsValue(manifest.exports) }),
    ...(manifest?.imports === undefined ? {} : { imports: toExportsValue(manifest.imports) }),
  };
}

/** Run a lookup over the manifest at `location`, prefixing an error it throws
 * with the manifest's path. */
function describing<T>(location: string, lookup: () => T): T {
  try {
    return lookup();
  } catch (err: unknown) {
    throw new Error(`${path.join(location, "package.json")}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** @return a row's dependency entries as name → locator. A `null` target (a
 * peer nothing satisfied) is left out, so the fallback pool may answer it. */
function dependencyMap(entries: Array<[string, PnpDependencyTarget]>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [name, target] of entries) {
    const key = targetKey(name, target);
    if (key !== undefined) {
      map.set(name, key);
    }
  }
  return map;
}

/** @return the locator a dependency entry points at, or undefined for `null`:
 * a bare reference is of the package `name`, a `[name, reference]` tuple names
 * the package behind an alias. */
function targetKey(name: string, target: PnpDependencyTarget): LocatorKey | undefined {
  if (target === null) {
    return undefined;
  }
  return Array.isArray(target) ? locatorKey(target[0], target[1]) : locatorKey(name, target);
}

/** @return the location with every symlink in it resolved, a virtual location
 * staying virtual, or the location itself where it cannot be read. */
function realpathOf(location: string): string {
  try {
    return realpathKeepingVirtual(location);
  } catch {
    return location;
  }
}

/** @return a locator key's instance name, `<name>#<reference>`; meaningful only
 * for a materialized package's row. */
function instanceOfLocator(locator: LocatorKey): string {
  const split = locator.indexOf("\0");
  return `${locator.slice(0, split)}#${locator.slice(split + 1)}`;
}

/** @return a file's instance name: its holding row's instance, then its path
 * within that row. */
function instanceName(entry: ILocationEntry, target: string): string {
  const relative = toPosix(path.relative(entry.prefix, target));
  const at = `${entry.name}#${entry.reference}`;
  return relative === "" ? at : `${at}/${relative}`;
}

function withSeparator(location: string): string {
  return location.endsWith(path.sep) ? location : location + path.sep;
}
