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
 * The `exports`/`imports` half of module resolution: node's
 * PACKAGE_EXPORTS_RESOLVE and PACKAGE_IMPORTS_RESOLVE as pure functions of a
 * package's own manifest.
 *
 * The split this file marks: a specifier's PACKAGE is decided by the dependency
 * table (which is composition — who may see whom), and everything below the
 * package root is decided by the package itself. `exports` is where a package
 * writes that down, so it belongs on the resolver's side of the seam and not in
 * whatever compiler happens to be driven — a name that names nothing must fail
 * identically in tsc, in Sass and in esbuild.
 *
 * Pure and fs-free by construction: it takes the parsed manifest value and
 * answers with a package-relative path. Everything filesystem-shaped (finding
 * the manifest, extension probing, the read) stays with the caller.
 *
 * Deprecated trailing-slash keys (`"./features/": "./src/features/"`) are NOT
 * honored: node dropped them in v17 and TypeScript resolves them in no mode, so
 * a package relying on one neither loads nor typechecks anywhere else — and
 * resolving it here would compile something that cannot run.
 *
 * One deviation from node: an invalid map is answered with "no resolution"
 * rather than a thrown error, except for the one shape that is unambiguously a
 * mistake in the package rather than in the specifier (subpath keys mixed with
 * condition keys), which is reported.
 */

/** An `exports`/`imports` entry: a target path, an ordered fallback list, a
 * condition map, or `null` — which does not mean "absent" but "deliberately not
 * exposed", and so stops the search rather than falling through. */
export type ExportsValue = string | null | readonly ExportsValue[] | { readonly [key: string]: ExportsValue };

/** How a subpath is spelled in an `exports` map: `.` for the package itself,
 * `./x` for anything below it. */
export function exportsSubpath(rest: string): string {
  return rest === "" ? "." : `./${rest}`;
}

/**
 * The package-relative path `subpath` names, or undefined when the package does
 * not expose it. A package with no `exports` field at all has nothing to say and
 * is not this function's business — the caller resolves those against the
 * filesystem, as node does.
 *
 * `conditions` is a SET, not a preference order: the map's own key order decides
 * which condition wins, which is what lets a package state its own priorities
 * (`types` before `import` before `default`). `default` always matches.
 */
export function resolveExports(exports: ExportsValue, subpath: string, conditions: ReadonlySet<string>): string | undefined {
  return resolveExportsAll(exports, subpath, conditions)[0];
}

/**
 * Every file the map publishes for `subpath`, in the order the package prefers
 * them — its own key order. The first is what {@link resolveExports} answers and
 * what node would load; the rest are the ones it passed over.
 *
 * Why a caller would want the rest: a condition names an IMPLEMENTATION, and a
 * compiler is asking about DECLARATIONS. A package may describe its faces under
 * `import`/`require` and keep the only declaration file behind a `types` key
 * listed after them — bad practice, and common. Reading one answer and stopping
 * makes that package untyped; walking its preferences until one of them answers
 * the question actually asked is what the compiler itself does.
 *
 * This never widens what is RESOLVABLE: every candidate comes from a condition
 * this world already satisfies, so a package with nothing to offer here still
 * has nothing.
 */
export function resolveExportsAll(exports: ExportsValue, subpath: string, conditions: ReadonlySet<string>): string[] {
  const map = subpathMap(exports);
  const matched = matchSubpath(map, subpath);
  if (matched === undefined) {
    return [];
  }
  const found: string[] = [];
  collectTargets(matched.target, matched.wildcard, conditions, false, found);
  return [...new Set(found)];
}

/**
 * The target a `#`-prefixed specifier names in the issuing package's `imports`
 * map: a package-relative path (`./x`), or a BARE SPECIFIER when the entry
 * redirects to another package — which the caller must then resolve like any
 * other name, through the table. The two are told apart by the `./` prefix,
 * exactly as node tells them apart.
 */
export function resolveImports(imports: ExportsValue, specifier: string, conditions: ReadonlySet<string>): string | undefined {
  /* `#` alone names nothing. `#/x` is refused by the written specification and
   * accepted by node, and node is what decides whether the import will load. */
  if (!specifier.startsWith("#") || specifier === "#" || !isMap(imports)) {
    return undefined;
  }
  const matched = matchSubpath(new Map(Object.entries(imports)), specifier);
  if (matched === undefined) {
    return undefined;
  }
  return resolveTarget(matched.target, matched.wildcard, conditions, true);
}

/**
 * The reverse direction: which subpath a consumer would write to reach `file`
 * (`./dist/index.d.ts` → `./client`), or undefined when the package publishes no
 * name for it.
 *
 * Node has no such algorithm because node never asks the question — but anything
 * that WRITES a specifier does, and a path that happens to be inside a package
 * is not a name a consumer can use: `exports` is exactly the statement that most
 * of a package has no public name at all.
 *
 * Every answer is CHECKED before it is given: the candidate name is resolved
 * forwards, and kept only if it comes back to the file it was derived from. The
 * derivation alone is not enough, and each way it can lie is a shape that
 * occurs — a more specific key may intercept the name (`./aa*` shadowing what
 * `./a*` derived), a broader key may name a subpath a narrower `null` has
 * blocked, and a key with two wildcards expands to a name that matches nothing.
 * A name a consumer cannot resolve is worse than no name at all, because the
 * caller has an honest fallback and a shipped declaration does not.
 *
 * Keys are tried most-specific first, so among the names that do round-trip the
 * answer is the tightest one, and deterministic.
 */
export function exportedSubpath(exports: ExportsValue, file: string, conditions: ReadonlySet<string>): string | undefined {
  const map = subpathMap(exports);
  for (const key of [...map.keys()].sort(compareKeys)) {
    /* Every target the key can name, unexpanded — `wildcard: undefined` leaves
     * a pattern's `*` in place, which is exactly the shape to match the file
     * against, and leaves an ordinary key's target as the literal filename it
     * is. All of them, not the first: the file may be named by a condition the
     * package lists after the one that answers a forward lookup. */
    const targets: string[] = [];
    collectTargets(map.get(key)!, undefined, conditions, false, targets);
    for (const candidate of targets.map(target => nameFor(key, target, file))) {
      /* Against every file the name publishes, not merely the first: a package
       * may name its declarations under a condition it lists after the
       * implementation, and that name still reaches them — the consumer's
       * compiler walks the same candidates. */
      if (candidate !== undefined && resolveExportsAll(exports, candidate, conditions).includes(file)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/** The subpath `key` would have to be written as for its `target` to name
 * `file`, or undefined if it cannot name it at all. A pattern carries the
 * matched portion across; an ordinary key names one file and nothing else. */
function nameFor(key: string, target: string, file: string): string | undefined {
  if (!key.includes("*")) {
    return target === file ? key : undefined;
  }
  const wildcard = matchPattern(target, file);
  return wildcard === undefined ? undefined : key.replaceAll("*", wildcard);
}

/** What a plain object is, for the several shapes here that turn on it. */
function isMap(value: ExportsValue): value is { readonly [key: string]: ExportsValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The `exports` value as a subpath map. A value whose keys are all conditions
 * (or which is not a map at all) is sugar for the main entry: `"exports":
 * "./index.js"` and `"exports": { "import": … }` both describe `.` alone.
 *
 * Mixing the two is the one shape reported rather than declined: no reading of
 * it can be what the author meant, and answering "not exported" would send the
 * consumer looking for a mistake in their own import.
 */
function subpathMap(exports: ExportsValue): Map<string, ExportsValue> {
  if (isMap(exports)) {
    const keys = Object.keys(exports);
    const subpaths = keys.filter(key => key.startsWith("."));
    if (keys.length > 0 && subpaths.length === keys.length) {
      return new Map(Object.entries(exports));
    }
    if (subpaths.length > 0) {
      throw new Error(
        `invalid 'exports': subpath keys (${subpaths.join(", ")}) cannot be mixed with condition keys ` +
          `(${keys.filter(key => !key.startsWith(".")).join(", ")}) in one map`
      );
    }
  }
  return new Map([[".", exports]]);
}

/** A key matched against a subpath: the entry it points at, plus what the key's
 * wildcard stood for — undefined when the key is not a pattern, which is what
 * keeps a `*` in its target a literal character rather than a placeholder. */
interface IMatch {
  readonly target: ExportsValue;
  readonly wildcard: string | undefined;
}

/** The entry that answers `subpath`: its exact key if there is one, else the
 * most specific pattern key that covers it. A key that is neither — the
 * deprecated trailing-slash form — matches nothing, not even itself, so a
 * package relying on one is as unresolvable here as under node and under tsc. */
function matchSubpath(map: ReadonlyMap<string, ExportsValue>, subpath: string): IMatch | undefined {
  const exact = map.get(subpath);
  if (exact !== undefined && !subpath.includes("*") && !subpath.endsWith("/")) {
    return { target: exact, wildcard: undefined };
  }
  let best: (IMatch & { key: string }) | undefined;
  for (const [key, target] of map) {
    /* Only a pattern expands. A key without a `*` names one subpath and was
     * already offered above, so letting it through here would re-admit the
     * spellings that guard exists to refuse. */
    if (!key.includes("*")) {
      continue;
    }
    const wildcard = matchPattern(key, subpath);
    if (wildcard !== undefined && (best === undefined || compareKeys(key, best.key) < 0)) {
      best = { target, wildcard, key };
    }
  }
  return best;
}

/**
 * What `*` stood for when `pattern` matched `candidate`, or undefined if it did
 * not. A pattern holds at most one `*`; anything else never matches, which is
 * how an invalid key declines rather than throws.
 */
function matchPattern(pattern: string, candidate: string): string | undefined {
  const star = pattern.indexOf("*");
  if (star === -1) {
    return pattern === candidate ? "" : undefined;
  }
  const base = pattern.slice(0, star);
  const trailer = pattern.slice(star + 1);
  if (trailer.includes("*") || !candidate.startsWith(base) || candidate === base) {
    return undefined;
  }
  if (trailer !== "" && !(candidate.endsWith(trailer) && candidate.length >= pattern.length)) {
    return undefined;
  }
  return candidate.slice(base.length, candidate.length - trailer.length);
}

/**
 * Most specific first — node's PATTERN_KEY_COMPARE: the longer fixed prefix
 * wins, a pattern beats a plain key with the same prefix, and the longer key
 * breaks the remaining tie. A total order, so which key answers a subpath does
 * not depend on the order the manifest happens to list its keys in.
 */
function compareKeys(key: string, other: string): number {
  const base = (candidate: string): number => (candidate.includes("*") ? candidate.indexOf("*") + 1 : candidate.length);
  const pattern = (candidate: string): number => (candidate.includes("*") ? 0 : 1);
  return base(other) - base(key) || pattern(key) - pattern(other) || other.length - key.length || (key < other ? -1 : 1);
}

/**
 * A matched entry's target, with the wildcard substituted: the string itself, or
 * the first of a fallback list that resolves, or the first matching condition's.
 *
 * `null` and `undefined` are different answers and the difference is
 * load-bearing: `undefined` means "this candidate did not resolve, try the
 * next", `null` means the package blocked the subpath and no later candidate may
 * override it.
 *
 * @param external whether a target naming another package is allowed — true for
 * `imports` (whose whole point is redirecting a name elsewhere) and false for
 * `exports`, where a package may only publish its own files.
 */
function resolveTarget(
  target: ExportsValue,
  wildcard: string | undefined,
  conditions: ReadonlySet<string>,
  external: boolean
): string | undefined {
  const found: string[] = [];
  collectTargets(target, wildcard, conditions, external, found);
  return found[0];
}

/**
 * Append every file a matched entry can name, in preference order, and answer
 * whether the package REFUSED the subpath.
 *
 * One walk serves both questions, because node's own answer is simply the first
 * thing this finds: a condition map contributes its matching keys in the order
 * it lists them, and a fallback list contributes its entries in order.
 *
 * The three shapes refuse differently, and node's own behaviour is the guide:
 *
 * - A `null`, or a target that may not be named at all (one that would leave
 *   the package), is a refusal. Node throws for the second and returns null for
 *   the first; both stop the walk here, since what a package has taken away a
 *   later condition may not give back.
 * - A FALLBACK LIST absorbs both. An entry that refuses is skipped and the next
 *   is tried, and the list's own caller never learns of it — which is why
 *   `[null, "./b.js"]` resolves to `./b.js` rather than to nothing.
 * - A CONDITION MAP propagates a refusal, so a `null` under one condition is not
 *   undone by a `default` listed after it.
 */
function collectTargets(
  target: ExportsValue,
  wildcard: string | undefined,
  conditions: ReadonlySet<string>,
  external: boolean,
  found: string[]
): boolean {
  if (target === null) {
    return false;
  }
  if (typeof target === "string") {
    const expanded = expandTarget(target, wildcard, external);
    if (expanded === undefined) {
      return false;
    }
    found.push(expanded);
    return true;
  }
  if (Array.isArray(target)) {
    for (const entry of target) {
      collectTargets(entry, wildcard, conditions, external, found);
    }
    return true;
  }
  return matchingConditions(target, conditions).every(value => collectTargets(value, wildcard, conditions, external, found));
}

/** A condition map's values in the order it lists them, keeping only those this
 * world satisfies. `default` is satisfied by every world. */
function matchingConditions(target: ExportsValue, conditions: ReadonlySet<string>): ExportsValue[] {
  if (!isMap(target)) {
    return [];
  }
  return Object.entries(target)
    .filter(([condition]) => condition === "default" || conditions.has(condition))
    .map(([, value]) => value);
}

/**
 * A target string with its wildcard filled in, or undefined if what results is
 * not something the package may name.
 *
 * `wildcard` is undefined for a key that is not a pattern, and then no
 * substitution happens at all: a `*` in the target of an ordinary key is a
 * literal character of a filename, not a placeholder, so `{".": "./a*b.js"}`
 * names the file `a*b.js`.
 */
function expandTarget(target: string, wildcard: string | undefined, external: boolean): string | undefined {
  /* The wildcard comes from the SPECIFIER, so it is checked in its own right
   * and not merely as part of the result — a target that does not use it would
   * otherwise let any subpath through unexamined. */
  if (wildcard !== undefined && hasInvalidSegment(wildcard)) {
    return undefined;
  }
  const expanded = wildcard === undefined ? target : target.replaceAll("*", wildcard);
  if (expanded.startsWith("./")) {
    /* Past the leading `./`, which is the one `.` segment every target has. */
    return hasInvalidSegment(expanded.slice(2)) ? undefined : expanded;
  }
  /* A bare specifier is a redirection, which only `imports` may do; a rooted or
   * upward path is neither that nor a file of this package, so it is refused
   * either way. */
  return external && !expanded.startsWith("/") && !expanded.startsWith("../") ? expanded : undefined;
}

/**
 * Whether a path holds a segment no target may contain — an upward step, a
 * self-reference, or a `node_modules` hop out of the package.
 *
 * Spelled as loosely as node spells it, and for the same reason: the segment
 * this is guarding against arrives from the specifier, so it is only worth
 * refusing if every way of writing it is refused. A backslash separates on
 * Windows, `%2e` is a `.` once anything resolves the path as a URL, and a
 * case-insensitive filesystem reaches `node_modules` through `NODE_MODULES`.
 */
function hasInvalidSegment(path: string): boolean {
  return path
    .split(/[/\\]/)
    .some(segment => {
      const plain = segment.toLowerCase().replaceAll("%2e", ".");
      return plain === "." || plain === ".." || plain === "node_modules";
    });
}
