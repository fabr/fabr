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
export class PnpResolver {
  /** Rows by locator, and their locations longest-first so a prefix match picks
   * the innermost package. */
  private readonly rows = new Map<LocatorKey, IPnpRow>();
  /** Rows by location prefix. `stored` marks a row that is a materialized
   * package (PnP's `HARD`) rather than a place in this build (`SOFT`: the
   * top-level sources, and the self row that names them as a package) — the
   * distinction the store-facing queries below turn on. */
  private readonly byLocation: Array<{ prefix: string; locator: LocatorKey; name: string | null; stored: boolean }> = [];
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
          this.byLocation.push({ prefix: withSeparator(location), locator: key, name, stored });
          /* A store entry is reached through the workspace's store-root
           * symlink, but a compiler that does not preserve symlinks reports the
           * files it resolved by their REAL path — so a row must be findable
           * under both spellings or every file inside a package would look like
           * it belonged to the top level. */
          const real = realpathOf(location);
          if (real !== location) {
            this.byLocation.push({ prefix: withSeparator(real), locator: key, name, stored });
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
    const prefix = directory + path.sep;
    const locator = this.byLocation.find(entry => prefix.startsWith(entry.prefix))?.locator ?? this.topLevel;
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
    /* Compared with a trailing separator on BOTH sides, so a path that is the
     * package root itself — the commonest one the declaration emitter writes —
     * matches its own location rather than falling just short of it. */
    const within = withSeparator(target);
    /* Longest-first, so the FIRST match is the innermost package — no scan of
     * the rest, which a declaration full of these would pay per specifier. */
    const innermost = this.byLocation.find(entry => entry.stored && entry.name !== null && within.startsWith(entry.prefix));
    if (innermost === undefined) {
      return undefined;
    }
    const sharing = this.byLocation.filter(entry => entry.name !== null && entry.prefix === innermost.prefix);
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
      exports === undefined || exports === null ? undefined : describing(location, () => exportedSubpath(exports, exportsSubpath(file), this.conditions));
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
    return [...new Set(this.byLocation.filter(entry => entry.stored).map(entry => withSeparator(path.dirname(entry.prefix))))];
  }

  /**
   * The directory `name` occupies as seen from `issuer`: the issuer's own
   * binding, else the fallback pool. Undefined means the table has no answer,
   * which is a resolution failure for the caller to report as one.
   */
  public locationOf(name: string, issuer: string): string | undefined {
    const locator = this.locatorOf(issuer);
    const from = this.rows.get(locator);
    /* The pool answers for a package that arrived from a repository, whose
     * undeclared imports are the ecosystem's to fix and not this build's. It
     * does not answer for anything this project produced — the sources, and the
     * packages the manifest excludes — because there the declared surface is
     * what this project wrote down, and an import missing from it is a bug with
     * an author. */
    const pooled = this.sources.has(locator) || this.excluded.has(locator) ? undefined : this.fallback.get(name);
    const bound = from?.dependencies.get(name) ?? pooled;
    return bound === undefined ? undefined : this.rows.get(bound)?.location;
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

/** A directory prefix that can only match at a path boundary. */
function withSeparator(location: string): string {
  return location.endsWith(path.sep) ? location : location + path.sep;
}
