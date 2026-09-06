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
 * PnP resolution: specifier + issuer → the file or directory it names.
 *
 * Two questions, answered by two different authorities. Which PACKAGE a name
 * means is the dependency table's — composition, who may see whom. What a
 * subpath means WITHIN that package is the package's own, and `exports` is where
 * it says so; that half lives in {@link PackageExports}. What is left over —
 * extensions, `main`/`types`, index files — is ordinary filesystem work, which
 * the caller hands to the compiler it drives.
 *
 * Runs standalone inside a build step (the tsc driver's process), so it depends
 * on nothing but node — the manifest type import is erased at compile.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { IPnpSerializedState, PnpDependencyTarget } from "../PnPManifest";
import { exportedSubpath, exportsSubpath, type ExportsValue, resolveExportsAll, resolveImports } from "./PackageExports";
import { IResolutionEdge, joinDepsPath } from "./ReadSet";

/**
 * The manifest's file name. Yarn's standard, known independently on both sides
 * of the process boundary (fabr writes it as `PnPManifest.PNP_DATA_FILE`):
 * driver code must not import fabr's own modules at runtime, and an ecosystem
 * constant is not a fabr decision to share.
 */
export const PNP_DATA_FILE = ".pnp.data.json";

/** A package as the table records it: where its files are, and every name it
 * may resolve, each bound to the row that answers it. */
interface IPnpRow {
  readonly location: string;
  readonly dependencies: Map<string, string>;
}

/** A locator as `name\0reference` — the pair rows are keyed by, since one name
 * may have several references (two deliveries of one package) and a reference
 * belongs to exactly one name. */
type LocatorKey = string;

function locatorKey(name: string | null, reference: PnpDependencyTarget): LocatorKey {
  return `${name ?? ""}\0${typeof reference === "string" ? reference : ""}`;
}

/** The `@types` package that supplies typings for `name`, in npm's mangled
 * spelling (`@scope/pkg` → `@types/scope__pkg`). */
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

/**
 * The manifest, ready to answer resolutions.
 *
 * Two lookups make up PnP's `resolveToUnqualified`: the issuer's file path
 * decides *which* package is asking (locations are prefixes), and that package's
 * own table decides what a name means to it. A name the issuer never declared
 * falls back to the pool — the compilation's own declared surface — which is
 * what keeps a dependency's typings resolvable when they import a peer the
 * package failed to declare and the consumer did.
 *
 * A resolver carries the CONDITIONS it resolves under, because they are a
 * property of the consumer rather than of any one lookup: a driver resolves for
 * exactly one world (tsc for `types`, Sass for `sass`) for its whole run, and
 * threading the set through every call would only invite two lookups in one
 * process to disagree about which files a package has.
 */
/** A row as the location index holds it: the directory it occupies (with a
 * trailing separator, so a prefix test cannot match a sibling whose name starts
 * the same), and what the store-facing queries need to judge it by. `reference`
 * is the row's PnP reference — the half of the instance name the path does not
 * carry. */
interface ILocationEntry {
  prefix: string;
  locator: LocatorKey;
  name: string | null;
  stored: boolean;
  reference?: string;
}

export class PnpResolver {
  /** Rows by locator, and their locations longest-first so a prefix match picks
   * the innermost package. */
  private readonly rows = new Map<LocatorKey, IPnpRow>();
  /** Rows by location prefix. `stored` marks a row that is a materialized
   * package (PnP's `HARD`) rather than a place in this build (`SOFT`: the
   * top-level sources, and the self row that names them as a package) — the
   * distinction the store-facing queries below turn on. */
  private readonly byLocation: ILocationEntry[] = [];
  /** The same entries keyed by the directory they name, each list in
   * `byLocation`'s order. This is the index behind every which-package-holds-
   * this-path question ({@link innermostAt}): a compile asks hundreds of
   * thousands of times over a table of a few thousand rows, so a scan per
   * question is O(files x packages) and dominates an incremental compile. */
  private readonly byDirectory = new Map<string, ILocationEntry[]>();
  /** {@link treeRoots}, derived once. The table is fixed after construction, so
   * every answer this resolver gives is a pure function of it. */
  private cachedTreeRoots: ReadonlyArray<string> | undefined;
  /** {@link instanceNameOf} by resolved path. The read set asks the same file
   * repeatedly — once per edge that named it — and the answer cannot move. */
  private readonly instanceNames = new Map<string, string | undefined>();
  /** {@link pathNameOf} by resolved path, memoized for the same reason. */
  private readonly pathNames = new Map<string, string | undefined>();
  /** {@link routes}, derived once — the table is fixed after construction. */
  private cachedRoutes: Map<LocatorKey, string[]> | undefined;
  private readonly fallback = new Map<string, string>();
  private readonly topLevel: LocatorKey;
  /** The rows that stand for the SOURCES rather than for a delivered package —
   * PnP's `SOFT` link type, which is the top-level row and the self row naming
   * the same files as a package. They are the one thing in the table this build
   * can fix, so they resolve strictly (see {@link locationOf}). */
  private readonly sources = new Set<LocatorKey>();
  /** Rows the manifest bars from the pool — the packages this build produced,
   * which are held to their declared surface for the same reason the sources
   * are. Kept as locators, so an excluded package's own row still answers
   * everything it did declare. */
  private readonly excluded = new Set<LocatorKey>();
  /** Which package each DIRECTORY belongs to. The locator of a file is a
   * property of the directory holding it, and a compile asks tens of thousands
   * of times over a few thousand directories — without this, every question
   * rescans every row. */
  private readonly locatorByDirectory = new Map<string, LocatorKey>();
  /** Each package's `exports`/`imports`, read once per location. A compile asks
   * about a few hundred packages tens of thousands of times; the miss is
   * recorded too, so a package without a manifest is stat-ed once and not once
   * per import. */
  private readonly manifests = new Map<string, IPackageManifest>();
  /** The world this resolver answers for — see the class comment. */
  private readonly conditions: ReadonlySet<string>;
  /** The package locations whose `package.json` this resolver has read — see
   * {@link manifestsConsulted}. */
  private readonly consultedManifests = new Set<string>();
  /** Every resolution performed, keyed by requirer + specifier — the pair whose
   * answer the fixed table makes constant, so a compile asking it ten thousand
   * times records one edge. */
  private readonly resolutions = new Map<string, IResolutionEdge>();

  /**
   * @param root the directory the manifest's relative locations resolve against
   * (the staged workspace).
   * @param conditions the export conditions this consumer satisfies, e.g.
   * `types`/`import` for a compiler, `sass` for a stylesheet compiler.
   * `default` is always satisfied and need not be given.
   */
  constructor(state: IPnpSerializedState, root: string, conditions: Iterable<string>) {
    this.conditions = new Set(conditions);
    this.topLevel = locatorKey(null, null);
    for (const [name, references] of state.packageRegistryData) {
      for (const [reference, info] of references) {
        const key = locatorKey(name, reference);
        const location = path.resolve(root, info.packageLocation);
        this.rows.set(key, { location, dependencies: dependencyMap(info.packageDependencies) });
        if (info.linkType === "SOFT") {
          this.sources.add(key);
        }
        if (info.discardFromLookup !== true) {
          const stored = info.linkType !== "SOFT";
          const held = typeof reference === "string" ? reference : undefined;
          this.byLocation.push({ prefix: withSeparator(location), locator: key, name, stored, reference: held });
          /* A store entry is reached through the workspace's store-root
           * symlink, but a compiler that does not preserve symlinks reports the
           * files it resolved by their REAL path — so a row must be findable
           * under both spellings or every file inside a package would look like
           * it belonged to the top level. */
          const real = realpathOf(location);
          if (real !== location) {
            this.byLocation.push({ prefix: withSeparator(real), locator: key, name, stored, reference: held });
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
     * content), and the innermost is the one asking. */
    this.byLocation.sort((left, right) => right.prefix.length - left.prefix.length);
    /* Built from the sorted array so each directory's own list keeps that
     * order, which is what makes the index answer exactly as the scan did where
     * rows share a location. */
    for (const entry of this.byLocation) {
      const at = entry.prefix.slice(0, -1);
      const held = this.byDirectory.get(at) ?? [];
      this.byDirectory.set(at, held);
      held.push(entry);
    }
    this.mergeSharedLocations();
  }

  /**
   * Rows that share a location see the union of their tables.
   *
   * Several rows CAN share one: the same content resolved under two names (an
   * alias beside the real package) is one directory, and a file inside it
   * cannot say which row it belongs to — the location→row map is not injective,
   * which is the one place this design still meets the couples-environment-to-
   * location problem. Merging is the honest answer for the case that occurs:
   * such rows are the same package, so they differ only in the name each
   * resolves itself by, and inside the shared directory both names should work.
   * Own bindings win; the manifest's rows are sorted, so the result is
   * deterministic. (Rows that share a location AND disagree on a dependency —
   * only possible across two deliveries of one content with different
   * environments — resolve to whichever row sorts first. Yarn buys injectivity
   * with virtual paths; fabr does not, and duplicating an entry per environment
   * is precisely what the table exists to avoid.)
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
      /* Snapshotted before anything is merged in, so a row contributes what it
       * declared and never what it just inherited. */
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

  /** Load `.pnp.data.json` from `root`, or undefined if this compilation has no
   * manifest (the classic node_modules layout, where the compiler resolves for
   * itself). */
  public static load(root: string, conditions: Iterable<string>): PnpResolver | undefined {
    const manifest = path.join(root, PNP_DATA_FILE);
    if (!fs.existsSync(manifest)) {
      return undefined;
    }
    return new PnpResolver(JSON.parse(fs.readFileSync(manifest, "utf8")) as IPnpSerializedState, root, conditions);
  }

  /**
   * The innermost entry containing `target` that `admits` accepts — the one
   * primitive under every containing-package question here.
   *
   * Answers by walking the path UPWARD rather than by scanning the table: an
   * entry contains `target` exactly when its directory is `target` or an
   * ancestor of it, so the walk meets the candidates innermost-first and stops
   * at the first acceptable one. That is the same answer the longest-prefix-
   * first scan gave — including its continuing outward where the innermost
   * directory holds nothing the caller accepts (a store path inside the
   * sources' own tree) — at O(depth) rather than O(table).
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
   * Which package a file belongs to: the row whose location is its longest
   * containing prefix, else the top-level package (the sources being compiled,
   * whose location is the root itself).
   *
   * Several rows may share a location — the same content resolved under two
   * names, an alias beside the real package — in which case their tables are
   * merged by {@link dependenciesOf}. They agree except on their own names,
   * which is exactly the answer wanted inside a shared directory.
   */
  public locatorOf(file: string): LocatorKey {
    const directory = path.dirname(path.resolve(file));
    const known = this.locatorByDirectory.get(directory);
    if (known !== undefined) {
      return known;
    }
    const locator = this.innermostAt(directory, () => true)?.locator ?? this.topLevel;
    this.locatorByDirectory.set(directory, locator);
    return locator;
  }

  /**
   * Which package a path inside the store belongs to, and where within it —
   * the reverse of {@link locationOf}, for turning a resolved location back
   * into something a consumer can resolve for itself.
   *
   * A store entry IS the package root, so the remainder maps to a subpath one
   * for one. Rows sharing a location (an alias beside the real package) are
   * interchangeable here — the names resolve to the same files — so the
   * lexicographically first is taken, deterministically.
   *
   * Only MATERIALIZED packages answer: a path inside the sources being compiled
   * belongs to this build, not to a package a consumer could resolve, so the
   * self row is deliberately not a candidate.
   *
   * The subpath is the one the package PUBLISHES for that file when it has an
   * `exports` map, which is not generally its location within the package: a
   * consumer can only write names the map answers. A file the map publishes
   * under no name at all falls back to its path, which is honest — the file is
   * genuinely unnameable, and a path at least says which one it was.
   */
  public packageOf(file: string): { name: string; subpath: string } | undefined {
    const target = path.resolve(file);
    /* The walk starts at the path itself, so a path that IS a package root —
     * the commonest one the declaration emitter writes — matches its own
     * location rather than only its parent's. */
    const innermost = this.innermostAt(target, entry => entry.stored && entry.name !== null);
    if (innermost === undefined) {
      return undefined;
    }
    /* Read out of the index rather than by filtering the table: rows sharing a
     * location are exactly one directory's list, and this runs per specifier a
     * declaration names. */
    const sharing = (this.byDirectory.get(innermost.prefix.slice(0, -1)) ?? []).filter(entry => entry.name !== null);
    const relative = path.relative(innermost.prefix, target).split(path.sep).join("/");
    return {
      name: sharing.map(entry => entry.name!).sort()[0],
      /* Read through the ROW's location rather than the matched prefix, which
       * may be the realpath spelling of it — same directory either way, and
       * this keeps one manifest cache entry per package. */
      subpath: this.publishedAs(this.rows.get(innermost.locator)!.location, relative),
    };
  }

  /** The subpath a consumer writes to reach the package-relative `file`: its
   * published name where the package's `exports` map gives it one, else the file
   * itself. */
  private publishedAs(location: string, file: string): string {
    const exports = this.manifestAt(location).exports;
    const published =
      exports === undefined || exports === null
        ? undefined
        : describing(location, () => exportedSubpath(exports, exportsSubpath(file), this.conditions));
    if (published === undefined) {
      return file;
    }
    return published === "." ? "" : published.slice(2);
  }

  /**
   * The directories this compilation's packages live in, in every spelling a
   * resolved path can carry — the store as this compilation sees it. What it is
   * for: recognizing a path that names the BUILD's layout rather than a
   * package, wherever one might otherwise be written down.
   */
  public get treeRoots(): ReadonlyArray<string> {
    /* Derived once: something reads this per file, and rebuilding the set each
     * time cost 1.5s of a full-program run. */
    this.cachedTreeRoots ??= [
      ...new Set(this.byLocation.filter(entry => entry.stored).map(entry => withSeparator(path.dirname(entry.prefix)))),
    ];
    return this.cachedTreeRoots;
  }

  /**
   * The directory `name` occupies as seen from `issuer`: the issuer's own
   * binding, else the fallback pool. Undefined means the table has no answer,
   * which is a resolution failure for the caller to report as one.
   */
  public locationOf(name: string, issuer: string): string | undefined {
    const locator = this.locatorOf(issuer);
    const from = this.rows.get(locator);
    /* Consulting a table is a READ of it, recorded as the EDGE below — who
     * asked, for what, and what they got: what a specifier binds to can change
     * with no file the compile read changing at all (a dependency added,
     * removed, or re-aliased), so a consumer keying on its reads has to see
     * the lookups it made as well as the files it got. */
    const instance = this.sources.has(locator) ? undefined : instanceOfLocator(locator);
    /* The pool answers for a package that arrived from a repository, whose
     * undeclared imports are the ecosystem's to fix and not this build's. It
     * does not answer for anything this project produced — the sources, and the
     * packages the manifest excludes — because there the declared surface is
     * what this project wrote down, and an import missing from it is a bug with
     * an author. */
    const barred = this.sources.has(locator) || this.excluded.has(locator);
    const own = from?.dependencies.get(name);
    const bound = own ?? (barred ? undefined : this.fallback.get(name));
    const requirer = instance ?? "";
    if (bound === undefined) {
      /* A name nothing answers is recorded too, and is not merely an error
       * waiting to happen: a caller given no answer may ask for something else
       * instead (tsc settling for `@types/thing`), so the compilation's result
       * can depend on this name having been unresolvable. */
      this.resolutions.set(`${requirer}\0${name}`, { from: requirer, name, to: "", via: "absent" });
    } else if (!this.sources.has(bound)) {
      this.resolutions.set(`${requirer}\0${name}`, {
        from: requirer,
        name,
        to: instanceOfLocator(bound),
        via: own === undefined ? "fallback" : "own",
      });
    }
    return bound === undefined ? undefined : this.rows.get(bound)?.location;
  }

  /**
   * Every resolution this run performed — the edges the step chains into walks
   * (see {@link IResolutionEdge}).
   *
   * A resolution answered by the SOURCES is left out: they are the
   * compilation's own files, which no walk over the delivered graph names and
   * which the anchor covers whole.
   */
  public edges(): ReadonlyArray<IResolutionEdge> {
    return [...this.resolutions.values()];
  }

  /**
   * The package locations whose `package.json` this resolver read — the half a
   * file listing cannot supply: resolution consults a package's `exports` map
   * to decide which file a specifier names, so an `exports` edit moves the
   * answer without touching the file that used to be the answer.
   */
  public manifestsConsulted(): ReadonlyArray<string> {
    return [...this.consultedManifests];
  }

  /**
   * The **instance name** of a resolved file: `<name>#<reference>/<path within
   * it>` — which exact node of the delivered graph was read, and where in it —
   * or undefined for anything outside a materialized package (the sources being
   * compiled, the tool's own install, the compiler's libs).
   *
   * Store-free on purpose: the reference is the row's own locator reference,
   * already in the table, so the name says nothing about this machine. Distinct
   * from {@link packageOf}, which answers the subpath a package *publishes* for
   * a file: that is what a consumer would have to WRITE to reach it, whereas
   * this is where it lives.
   */
  public instanceNameOf(file: string): string | undefined {
    const target = path.resolve(file);
    const known = this.instanceNames.get(target);
    if (known !== undefined || this.instanceNames.has(target)) {
      return known;
    }
    const innermost = this.innermostAt(target, entry => entry.stored && entry.name !== null);
    const name = innermost?.reference === undefined ? undefined : instanceName(innermost, target);
    this.instanceNames.set(target, name);
    return name;
  }

  /**
   * The **path name** of a resolved file: the names an edge chain calls its
   * package by, then the file within it — `@types/jest expect index.d.ts`. This
   * is what fabr calls a dependency's file everywhere (its key material, its
   * recorded base, its change lists), so a driver reporting these names and
   * reading them back needs no translation in either direction.
   *
   * One canonical route per package — the first the walk reaches it by — so the
   * name is one-to-one with the file. A route is not the only way in; it is the
   * one everything agrees to use.
   *
   * Undefined for anything outside a materialized package (the sources being
   * compiled, the tool's own install, the compiler's libs), exactly as
   * {@link instanceNameOf} is.
   */
  public pathNameOf(file: string): string | undefined {
    const target = path.resolve(file);
    const known = this.pathNames.get(target);
    if (known !== undefined || this.pathNames.has(target)) {
      return known;
    }
    const innermost = this.innermostAt(target, entry => entry.stored && entry.name !== null);
    const route = innermost === undefined ? undefined : this.routes().get(innermost.locator);
    const relative = innermost === undefined ? "" : path.relative(innermost.prefix, target).split(path.sep).join("/");
    const name = route === undefined ? undefined : joinDepsPath([...route, ...(relative === "" ? [] : [relative])]);
    this.pathNames.set(target, name);
    return name;
  }

  /**
   * The path name of a bare specifier's FAILED package lookup, as seen from
   * `issuer` — `thing package.json`, the route the lookup took ending at the
   * manifest every package carries — or undefined where the lookup succeeded
   * (or was never made, or the specifier names no package). The same name the
   * read set reports the absence under, so a consumer recording it needs no
   * translation against a later change list.
   *
   * Answered from the resolutions this run already performed, never by looking
   * anything up: asking about a lookup is not making one.
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

  /**
   * The canonical route to the package an INSTANCE name calls out, or to the
   * top level for the empty name — what a route out of {@link edges} hangs off.
   * Undefined for an instance the table does not place.
   */
  public routeOf(instance: string): string[] | undefined {
    if (instance === "") {
      return [];
    }
    const split = instance.lastIndexOf("#");
    const locator = split < 0 ? undefined : locatorKey(instance.slice(0, split), instance.slice(split + 1));
    return locator === undefined ? undefined : this.routes().get(locator);
  }

  /**
   * Each package's canonical route from the top-level row: breadth-first, so
   * the shortest wins and a repeat within a level is dropped. The table is fixed
   * after construction, so this is computed once.
   *
   * The source rows are not packages and are skipped — a route through them
   * would name the compilation itself, which is no dependency of anything.
   */
  private routes(): Map<LocatorKey, string[]> {
    if (this.cachedRoutes !== undefined) {
      return this.cachedRoutes;
    }
    const routes = new Map<LocatorKey, string[]>();
    let frontier = [...(this.rows.get(this.topLevel)?.dependencies ?? [])].map(([name, locator]) => ({ locator, route: [name] }));
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
   * What a specifier names as seen from `issuer`, both halves answered: the
   * FILE a package's `exports` map publishes for the subpath, or — for a package
   * that declares no `exports` — the directory-plus-subpath the caller then
   * probes for itself, which is the classic behavior and all node ever did
   * before `exports` existed.
   *
   * Undefined is a resolution failure and covers both of its reasons: no row for
   * the package (not declared here), and a package that declares `exports` and
   * does not publish this subpath (declared, but private). The second is not a
   * near miss to be retried against the filesystem — the whole point of an
   * `exports` map is that what it omits has no name — so the caller must not
   * fall back to probing.
   *
   * A `#`-prefixed specifier is the same question asked inward: it is answered
   * from the ISSUING package's own `imports` map, and may redirect to another
   * package, which resolves from here like any other name.
   */
  public resolveSpecifier(specifier: string, issuer: string): string | undefined {
    return this.resolveAll(specifier, issuer)[0];
  }

  /**
   * Every file the specifier may name, in the order the package prefers them —
   * {@link resolveSpecifier}'s answer first, then the ones it passed over.
   *
   * For a caller whose question a condition does not directly answer. A
   * condition names an implementation; a compiler wants declarations, and a
   * package may keep its only declaration file behind a `types` key listed after
   * the `import`/`require` ones. Such a caller walks these in order and takes
   * the first that answers it, which is what the compiler does with a
   * `node_modules` tree.
   *
   * Resolvability is not affected: an empty list here is exactly an undefined
   * {@link resolveSpecifier}, and every entry comes from a condition this
   * resolver's world already satisfies.
   */
  public resolveAll(specifier: string, issuer: string): string[] {
    if (specifier.startsWith("#")) {
      const found = this.resolveSubpathImport(specifier, issuer);
      return found === undefined ? [] : [found];
    }
    const split = splitSpecifier(specifier);
    const location = split && this.locationOf(split.name, issuer);
    return location === undefined || split === undefined ? [] : this.within(location, exportsSubpath(split.subpath));
  }

  /** Where a subpath of the package at `location` may live, honoring its
   * `exports` map when it has one. A package that publishes no map offers one
   * answer, the path itself, for the caller to probe. */
  private within(location: string, subpath: string): string[] {
    const exports = this.manifestAt(location).exports;
    /* `null` is not a map that publishes nothing — node reads it as no map at
     * all and falls back to `main`, so a package spelling it that way must stay
     * as resolvable here as it is there. */
    if (exports === undefined || exports === null) {
      return [subpath === "." ? location : path.join(location, subpath.slice(2))];
    }
    const targets = describing(location, () => resolveExportsAll(exports, subpath, this.conditions));
    return targets.map(target => path.join(location, target.slice(2)));
  }

  /** A `#name` specifier through the issuing package's `imports` map — a file of
   * that package, or another package's name, which resolves from the same
   * issuer so the redirection sees exactly what the package that wrote it may
   * see. */
  private resolveSubpathImport(specifier: string, issuer: string): string | undefined {
    const from = this.rows.get(this.locatorOf(issuer));
    const imports = from && this.manifestAt(from.location).imports;
    if (from === undefined || imports === undefined || imports === null) {
      return undefined;
    }
    const target = describing(from.location, () => resolveImports(imports, specifier, this.conditions));
    if (target === undefined) {
      return undefined;
    }
    return target.startsWith("./") ? path.join(from.location, target.slice(2)) : this.resolveSpecifier(target, issuer);
  }

  /** The `exports`/`imports` of the package at `location`, empty for one that
   * declares neither or has no readable manifest at all (a location this
   * compilation never materialized). */
  private manifestAt(location: string): IPackageManifest {
    /* Recorded on every consultation, not only on the read that filled the
     * cache: what a consumer keying on reads needs is which packages' manifests
     * this resolution DEPENDED on, and caching one is an accident of this
     * process. */
    this.consultedManifests.add(location);
    const held = this.manifests.get(location);
    if (held !== undefined) {
      return held;
    }
    const read = readManifest(location);
    this.manifests.set(location, read);
    return read;
  }
}

/** As much of a `package.json` as resolution reads: what the package publishes,
 * and what it resolves for itself. */
interface IPackageManifest {
  readonly exports?: ExportsValue;
  readonly imports?: ExportsValue;
}

/** The manifest at `location`, empty when there is none to read. An unreadable
 * or unparseable one is the same answer as none: whoever BUILT that package
 * reports what is wrong with it, and a resolver that threw here would fail every
 * compile that merely has the package in its table. */
function readManifest(location: string): IPackageManifest {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(location, "package.json"), "utf8")) as IPackageManifest;
    return { exports: json.exports, imports: json.imports };
  } catch {
    return {};
  }
}

/** Run a manifest-driven lookup, naming the package in anything it reports: an
 * invalid `exports` map is a fault in a package, and the report is unactionable
 * without saying which one. */
function describing<T>(location: string, lookup: () => T): T {
  try {
    return lookup();
  } catch (err: unknown) {
    throw new Error(`${path.join(location, "package.json")}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** A row's dependency entries as name → locator. A `null` target is an
 * unsatisfied peer: recorded as absent, so it falls back like any other
 * undeclared name rather than resolving to nothing. */
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

/** The row a dependency entry points at: a bare reference names the package
 * under the requirer's own spelling of it, a `[name, reference]` tuple names
 * another package under an alias. */
function targetKey(name: string, target: PnpDependencyTarget): LocatorKey | undefined {
  if (target === null) {
    return undefined;
  }
  return Array.isArray(target) ? locatorKey(target[0], target[1]) : locatorKey(name, target);
}

/** The location with every symlink in it resolved, or the location itself when
 * it cannot be read (a row for a package this compilation never materializes). */
function realpathOf(location: string): string {
  try {
    return fs.realpathSync(location);
  } catch {
    return location;
  }
}

/** A locator key's instance name: `<name>#<reference>`. Only meaningful for a
 * stored, named row (a source row has no reference to name). */
function instanceOfLocator(locator: LocatorKey): string {
  const split = locator.indexOf("\0");
  return `${locator.slice(0, split)}#${locator.slice(split + 1)}`;
}

/** A file's instance name: its holding row's instance, then its path within
 * that row. */
function instanceName(entry: ILocationEntry, target: string): string {
  const relative = path.relative(entry.prefix, target).split(path.sep).join("/");
  const at = `${entry.name}#${entry.reference}`;
  return relative === "" ? at : `${at}/${relative}`;
}

function withSeparator(location: string): string {
  return location.endsWith(path.sep) ? location : location + path.sep;
}
