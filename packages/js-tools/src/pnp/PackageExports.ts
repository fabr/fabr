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
 * Node's PACKAGE_EXPORTS_RESOLVE and PACKAGE_IMPORTS_RESOLVE as pure functions
 * of a package's parsed manifest: given the `exports` or `imports` value and a
 * subpath, they answer with package-relative paths. Finding the manifest,
 * probing extensions and reading files are the caller's.
 *
 * Trailing-slash folder keys (`"./features/": "./src/features/"`), which node
 * removed in v17, are not honoured unless the caller passes `validate: false`,
 * which honours them as the TypeScript compiler and esbuild do (see
 * {@link matchSubpath}).
 *
 * Differs from node in one way: an invalid map or target resolves nothing
 * rather than throwing, except for two shapes, which throw: subpath keys mixed
 * with condition keys, and a numeric condition key. With `validate: false`
 * those two are read as the TypeScript compiler reads them instead (see
 * {@link subpathMap}, {@link matchingConditions}).
 */

/** An `exports`/`imports` entry: a target path, an ordered fallback list, a
 * condition map, or `null`, which refuses the subpath and stops the search. */
export type ExportsValue = string | null | readonly ExportsValue[] | { readonly [key: string]: ExportsValue };

/** Convert a manifest's `exports` or `imports` field. A value of any other JSON
 * type (node refuses it as an invalid target) is read as `null`, so a whole
 * field of such a type reads as `null`. */
export function toExportsValue(json: unknown): ExportsValue {
  if (typeof json === "string" || json === null) {
    return json;
  }
  if (Array.isArray(json)) {
    return json.map(toExportsValue);
  }
  if (typeof json === "object") {
    return Object.fromEntries(Object.entries(json).map(([key, value]) => [key, toExportsValue(value)]));
  }
  return null;
}

/** @return `rest` spelled as an `exports` map spells a subpath: `.` for the
 * package itself, `./x` for anything below it. */
export function exportsSubpath(rest: string): string {
  return rest === "" ? "." : `./${rest}`;
}

/**
 * The conditions a resolution satisfies, asked one key at a time. A
 * `Set<string>` is one; a caller with its own rule for some keys (TypeScript's
 * versioned `types@<range>` keys) supplies its own `has`.
 */
export interface IConditionSet {
  has(condition: string): boolean;
}

/**
 * @return the package-relative path (`./x`) the `exports` map gives `subpath`
 * (`.` or `./x`), or undefined where the map does not expose it. A package with
 * no `exports` field is the caller's to resolve against the filesystem.
 *
 * `conditions` is a set, not a preference order: of the conditions it holds,
 * the first a condition map lists wins. `default` always matches. Throws for
 * the invalid maps the module doc lists.
 */
export function resolveExports(
  exports: ExportsValue,
  subpath: string,
  conditions: IConditionSet,
  validate = true
): string | undefined {
  return resolveExportsAll(exports, subpath, conditions, validate)[0];
}

/**
 * @return every file the `exports` map gives `subpath` under `conditions`, in
 * the order the map lists them, without duplicates. The first is what
 * {@link resolveExports} answers and what node would load. A compiler looking
 * for declarations walks the rest, since a package may list its only `types`
 * key after `import`/`require`. Empty where the map does not expose `subpath`.
 */
export function resolveExportsAll(exports: ExportsValue, subpath: string, conditions: IConditionSet, validate = true): string[] {
  const map = subpathMap(exports, validate);
  const matched = matchSubpath(map, subpath, !validate);
  if (matched === undefined) {
    return [];
  }
  const found: string[] = [];
  collectTargets(matched.target, matched.wildcard, conditions, false, found, validate, matched.folder === true);
  return [...new Set(found)];
}

/**
 * @return the target a `#`-prefixed specifier names in the issuing package's
 * `imports` map: a package-relative path (`./x`), or a bare specifier where the
 * entry redirects to another package, which the caller resolves like any other
 * package name. Undefined where the map does not define `specifier`.
 */
export function resolveImports(
  imports: ExportsValue,
  specifier: string,
  conditions: IConditionSet,
  validate = true
): string | undefined {
  return resolveImportsAll(imports, specifier, conditions, validate)[0];
}

/**
 * @return every target the `imports` entry for `specifier` names, in the order
 * the map lists them, as {@link resolveExportsAll} does for `exports`.
 */
export function resolveImportsAll(imports: ExportsValue, specifier: string, conditions: IConditionSet, validate = true): string[] {
  /* `#` alone names nothing. `#/x` is accepted, as node accepts it, though the
   * written specification refuses it. */
  if (!specifier.startsWith("#") || specifier === "#" || !isMap(imports)) {
    return [];
  }
  const matched = matchSubpath(new Map(Object.entries(imports)), specifier);
  if (matched === undefined) {
    return [];
  }
  const found: string[] = [];
  collectTargets(matched.target, matched.wildcard, conditions, true, found, validate, false);
  return [...new Set(found)];
}

/**
 * Look up, in reverse, the subpath a consumer would write to reach the
 * package-relative `file` (`./dist/index.d.ts` → `./client`), or undefined
 * where the `exports` map gives it no name. Node has no such step.
 *
 * Keys are tried most specific first, each target under `conditions` in turn,
 * and the first candidate name whose forward resolution
 * ({@link resolveExportsAll}) includes `file` is the answer. The forward check
 * rejects a name a more specific key intercepts (`./aa*` shadowing what `./a*`
 * derived), one a narrower `null` blocks, and one a key with two wildcards
 * expands to.
 */
export function exportedSubpath(exports: ExportsValue, file: string, conditions: IConditionSet, validate = true): string | undefined {
  const map = subpathMap(exports, validate);
  for (const key of [...map.keys()].sort(compareKeys)) {
    /* Every target the key can name, not only the first, unexpanded: with
     * `wildcard: undefined` a pattern's `*` stays in place to match the file
     * against. */
    const targets: string[] = [];
    collectTargets(map.get(key)!, undefined, conditions, false, targets, validate, false);
    for (const candidate of targets.map(target => nameFor(key, target, file))) {
      /* Check against every file the name resolves to, not only the first, as
       * a compiler looking for declarations walks them all. */
      if (candidate !== undefined && resolveExportsAll(exports, candidate, conditions, validate).includes(file)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/** @return the subpath `key` would have to be written as for its `target` to
 * name `file`, or undefined if it cannot: a pattern key with what the target's
 * `*` matched in `file` substituted for its `*`, or an ordinary key where its
 * target is `file`. */
function nameFor(key: string, target: string, file: string): string | undefined {
  if (!key.includes("*")) {
    return target === file ? key : undefined;
  }
  const wildcard = matchPattern(target, file);
  return wildcard === undefined ? undefined : key.replaceAll("*", wildcard);
}

/** @return true if `value` is a plain object (a map), otherwise false. */
function isMap(value: ExportsValue): value is { readonly [key: string]: ExportsValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @return the `exports` value as a subpath map. A value that is not a map, or a
 * map with no keys starting `.`, is the entry for `.` alone:
 * `"exports": "./index.js"` and `"exports": { "import": … }` both describe `.`.
 *
 * A map mixing subpath and condition keys throws; unvalidated, it is read as
 * the TypeScript compiler reads it: its `"."` entry answers for `.`, and no
 * other subpath resolves.
 */
function subpathMap(exports: ExportsValue, validate: boolean): Map<string, ExportsValue> {
  if (isMap(exports)) {
    const keys = Object.keys(exports);
    const subpaths = keys.filter(key => key.startsWith("."));
    if (keys.length > 0 && subpaths.length === keys.length) {
      return new Map(Object.entries(exports));
    }
    if (subpaths.length > 0 && !validate) {
      return "." in exports ? new Map([[".", exports["."]]]) : new Map();
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

/** A key matched against a subpath: its entry, and what the key's `*` matched,
 * undefined where the key is not a pattern (a `*` in its target is then a
 * literal character). */
interface IMatch {
  readonly target: ExportsValue;
  readonly wildcard: string | undefined;
  /** Matched by a folder key: `wildcard` is the remainder, appended to a target
   * that names a directory rather than substituted for a `*`. */
  readonly folder?: boolean;
}

/** @return the entry that answers `subpath`: its exact key if there is one,
 * else the most specific pattern key that matches it. A trailing-slash folder
 * key matches nothing, not even itself, as the specification has it, unless
 * `folders`: then it matches every subpath beneath it, ranked among the
 * pattern keys by its length, as the TypeScript compiler ranks it. */
function matchSubpath(map: ReadonlyMap<string, ExportsValue>, subpath: string, folders = false): IMatch | undefined {
  const exact = map.get(subpath);
  if (exact !== undefined && !subpath.includes("*") && !subpath.endsWith("/")) {
    return { target: exact, wildcard: undefined };
  }
  let best: (IMatch & { key: string }) | undefined;
  for (const [key, target] of map) {
    /* A key without a `*` matches only exactly, checked above. */
    if (!key.includes("*")) {
      if (folders && key.endsWith("/") && subpath.length > key.length && subpath.startsWith(key)) {
        if (best === undefined || compareKeys(key, best.key) < 0) {
          best = { target, wildcard: subpath.slice(key.length), key, folder: true };
        }
      }
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
 * @return what `*` matched when `pattern` matched `candidate`, `""` for a
 * pattern with no `*` equal to `candidate`, or undefined if it did not match.
 * A pattern with more than one `*` matches nothing.
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
 * Compare two keys most specific first, as node's PATTERN_KEY_COMPARE does: the
 * longer prefix before the `*` first, then a pattern before a plain key, then
 * the longer key, then code-unit order, so the order is total.
 */
function compareKeys(key: string, other: string): number {
  const base = (candidate: string): number => (candidate.includes("*") ? candidate.indexOf("*") + 1 : candidate.length);
  const pattern = (candidate: string): number => (candidate.includes("*") ? 0 : 1);
  return base(other) - base(key) || pattern(key) - pattern(other) || other.length - key.length || (key < other ? -1 : 1);
}

/**
 * Append to `found` every file the matched entry `target` names under
 * `conditions`, in the order the entry lists them, with `wildcard` substituted
 * ({@link expandTarget}). Return false if the entry refuses the subpath,
 * otherwise true. The first file found is node's answer.
 *
 * - A `null`, or a target that may not be named (one leaving the package), is
 *   a refusal. Node returns null for the first and throws for the second.
 * - A fallback list skips an entry that refuses and tries the next, so
 *   `[null, "./b.js"]` resolves to `./b.js`. The list refuses where it is
 *   empty, or an entry refused and none answered; one whose entries matched no
 *   condition does not refuse.
 * - A condition map stops at the first matching condition that refuses, and
 *   refuses itself, so a `null` under one condition is not undone by a
 *   `default` listed after it. Files found under earlier conditions stay in
 *   `found`.
 *
 * @param external true if a target may name another package (`imports`),
 * false where it may name only the package's own files (`exports`).
 * @param folder true if the entry was matched by a folder key: `wildcard` is
 * appended to a target ending in `/`.
 */
function collectTargets(
  target: ExportsValue,
  wildcard: string | undefined,
  conditions: IConditionSet,
  external: boolean,
  found: string[],
  validate: boolean,
  folder: boolean
): boolean {
  if (target === null) {
    return false;
  }
  if (typeof target === "string") {
    const expanded = expandTarget(target, wildcard, external, folder);
    if (expanded === undefined) {
      return false;
    }
    found.push(expanded);
    return true;
  }
  if (Array.isArray(target)) {
    const before = found.length;
    let refused = target.length === 0;
    for (const entry of target) {
      refused = !collectTargets(entry, wildcard, conditions, external, found, validate, folder) || refused;
    }
    return found.length > before || !refused;
  }
  return matchingConditions(target, conditions, validate).every(value =>
    collectTargets(value, wildcard, conditions, external, found, validate, folder)
  );
}

/** @return a condition map's values in the order it lists them, keeping those
 * whose condition is in `conditions` or is `default`; empty for a value that is
 * not a map. A key that is an array index throws (JavaScript enumerates such
 * keys first, whatever order the manifest wrote them in); unvalidated, the
 * keys are taken in JavaScript's order, as the TypeScript compiler takes them. */
function matchingConditions(target: ExportsValue, conditions: IConditionSet, validate: boolean): ExportsValue[] {
  if (!isMap(target)) {
    return [];
  }
  const index = validate ? Object.keys(target).find(isArrayIndex) : undefined;
  if (index !== undefined) {
    throw new Error(`invalid "exports"/"imports": condition key '${index}' is a numeric property key`);
  }
  return Object.entries(target)
    .filter(([condition]) => condition === "default" || conditions.has(condition))
    .map(([, value]) => value);
}

/**
 * @return a target string with its wildcard filled in and decoded
 * ({@link decodeTargetPath}), or undefined if the result is not something the
 * entry may name: a path with an invalid segment ({@link hasInvalidSegment}),
 * or, unless `external`, anything not starting `./`. A rooted or `../` path is
 * refused even when `external`.
 *
 * `wildcard` is undefined for a key that is not a pattern, and then nothing is
 * substituted: `{".": "./a*b.js"}` names the file `a*b.js`.
 */
function expandTarget(target: string, wildcard: string | undefined, external: boolean, folder = false): string | undefined {
  /* Check the wildcard on its own too: a target that does not use it would
   * otherwise let any subpath through unchecked. */
  if (wildcard !== undefined && hasInvalidSegment(decodeTargetPath(wildcard))) {
    return undefined;
  }
  if (folder && !target.endsWith("/")) {
    return undefined;
  }
  const expanded = wildcard === undefined ? target : folder ? target + wildcard : target.replaceAll("*", wildcard);
  if (expanded.startsWith("./")) {
    /* Past the leading `./`, which is the one `.` segment every target has. */
    const file = decodeTargetPath(expanded.slice(2));
    return file === undefined || hasInvalidSegment(file) ? undefined : `./${file}`;
  }
  /* A bare specifier redirects to another package, which only `imports` may
   * do. */
  return external && !expanded.startsWith("/") && !expanded.startsWith("../") ? expanded : undefined;
}

/**
 * @return true if a decoded path is undefined or holds a segment no target may
 * contain (`.`, `..` or `node_modules`, in any case, split at `/` or `\`),
 * otherwise false.
 */
function hasInvalidSegment(path: string | undefined): boolean {
  return (
    path === undefined ||
    path.split(/[/\\]/).some(segment => {
      const plain = segment.toLowerCase();
      return plain === "." || plain === ".." || plain === "node_modules";
    })
  );
}

/**
 * @return a target path as the file it names, percent-decoded as node decodes
 * a target resolved against the package's URL (`a%20b.js` names `a b.js`).
 * Undefined for what node refuses: a malformed escape, or an encoded separator
 * (`%2F`, `%5C`).
 */
function decodeTargetPath(path: string): string | undefined {
  if (/%2f|%5c/i.test(path)) {
    return undefined;
  }
  try {
    return decodeURIComponent(path);
  } catch {
    return undefined;
  }
}

/**
 * @return a package-relative file name spelled as a target, the inverse of
 * {@link decodeTargetPath}: `%`, `#` and `?` are percent-escaped, everything
 * else (`*` and `/` included) is written as it is.
 */
export function encodeTargetPath(path: string): string {
  return path.replace(/[%#?]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/** @return true if a key is an array index (ECMA-262 §6.1.7) — a canonical
 * non-negative integer below 2³² − 1 — otherwise false. */
function isArrayIndex(key: string): boolean {
  return /^(0|[1-9]\d*)$/.test(key) && Number(key) < 4294967295;
}
