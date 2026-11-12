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
 * The package.json document: generating, reading and rewriting one. The
 * registry protocol (packument, tarball, publish request, platform gates) is
 * in NPMProtocol. A generated manifest has the fields fabr computes
 * ({@link COMPUTED_FIELDS}), drops the fields in {@link STRIPPED_FIELDS}, and
 * carries every other field of a seed manifest or `metadata` as it is.
 */

import {
  FabrError,
  FileSet,
  isJsonObject,
  mapEntryError,
  MemoryFile,
  Name,
  PropertyMap,
  PropertyMapValue,
  Requirement,
} from "@fabr-build/core";
import {
  binByConvention,
  CJS_JS_EXTENSION,
  CJS_TYPE_EXTENSION,
  DECLARATION_FILE,
  ESM_JS_EXTENSION,
  ESM_TYPE_EXTENSION,
  JS_EXTENSION,
  JSTarget,
  TYPE_EXTENSION,
} from "./JSPackage";
import { isSemverConstraint, NpmPublishIdentity } from "./NPMProtocol";
import { encodeTargetPath } from "@fabr-build/js-tools";

/** Fields fabr computes from the target itself: a `metadata` key naming one is
 *  rejected, and a seed manifest's value is dropped. */
const COMPUTED_FIELDS = new Set([
  "name",
  "version",
  "type",
  "main",
  "types",
  "exports",
  "bin",
  "dependencies",
  "peerDependencies",
  "peerDependenciesMeta",
]);

/** Fields dropped from a seed manifest and rejected in `metadata`: those
 *  about the tarball's contents, dependency resolution, publishing, and the
 *  development checkout. Every field not here or in {@link COMPUTED_FIELDS} is
 *  carried. */
const STRIPPED_FIELDS = new Set([
  "devDependencies",
  "scripts",
  "files",
  "private",
  "publishConfig",
  "packageManager",
  "workspaces",
  "resolutions",
  "overrides",
  "bundleDependencies",
  "bundledDependencies",
]);

/** package.json fields whose value is an array of strings: a `metadata` entry
 *  for one is written as an array (`keywords = build` → `["build"]`), where any
 *  other field's string list is joined into one string. */
const ARRAY_FIELDS = new Set(["keywords", "os", "cpu", "libc"]);

/**
 * Read a manifest dependency block (`dependencies`, `optionalDependencies`, …)
 * as a name→spec map. As npm does, a block that is not an object (such as the
 * published `"dependencies": []`) is empty, and an entry whose spec is not a
 * string is left out.
 */
export function dependencyBlock(block: unknown): Map<string, string> {
  const entries = new Map<string, string>();
  if (isJsonObject(block)) {
    for (const [name, constraint] of Object.entries(block)) {
      if (typeof constraint === "string") {
        entries.set(name, constraint);
      }
    }
  }
  return entries;
}

/**
 * Read the requirement one dependency-block entry declares: ordinarily on the
 * package the entry names, constrained by its spec. npm's alias form
 * (`"wrap-ansi-cjs": "npm:wrap-ansi@^7.0.0"`) requires the package after
 * `npm:` instead, with the entry name as its `renameTo` (the name the
 * requirer's code imports it by); an alias naming the entry's own package sets
 * no `renameTo`.
 *
 * An alias with no version (`npm:wrap-ansi`) and a dist-tag (`latest`, `next`)
 * are read as `*`. Any other spec (`file:`, `git+`, `workspace:`) is returned
 * unchanged as the constraint, for whoever parses it to reject.
 */
export function dependencyRequirement(name: string, spec: string): Requirement {
  if (!spec.startsWith(ALIAS_PREFIX)) {
    return { name: name, versionConstraint: constraintOfSpec(spec) };
  }
  const target = spec.substring(ALIAS_PREFIX.length);
  /* Scoped names start with their own `@`, so the version separator is the
   * last one — and only counts if something follows it. */
  const separator = target.lastIndexOf("@");
  const pkg = separator > 0 ? target.substring(0, separator) : target;
  const constraint = separator > 0 ? target.substring(separator + 1) : "";
  return {
    name: pkg,
    versionConstraint: constraint === "" ? "*" : constraintOfSpec(constraint),
    /* An alias to the package's own name renames nothing */
    ...(pkg === name ? {} : { renameTo: name }),
  };
}

/** @return the constraint a dependency's version spec states: `*` for a dist-tag, otherwise the spec. */
function constraintOfSpec(spec: string): string {
  return DIST_TAG.test(spec) && !isSemverConstraint(spec) ? "*" : spec;
}

/** A dist-tag's spelling: a name, which a version range never is. */
const DIST_TAG = /^[A-Za-z][A-Za-z0-9._-]*$/;

/**
 * Write the dependency-block entry stating `requirement`, the inverse of
 * {@link dependencyRequirement}. A requirement with a `renameTo` is written in
 * npm's alias form under that name (`"typescript-6": "npm:typescript@6.0.0-beta"`),
 * and one stating no version as `*`. Every dependency a generated manifest
 * writes is written by this.
 */
export function requirementSpec(requirement: Requirement): { name: string; spec: string } {
  const { name: pkg, versionConstraint: constraint = "*", renameTo: alias } = requirement;
  return alias === undefined || alias === pkg
    ? { name: pkg, spec: constraint }
    : { name: alias, spec: `${ALIAS_PREFIX}${pkg}@${constraint}` };
}

const ALIAS_PREFIX = "npm:";

/** Read the peers a `peerDependenciesMeta` block marks `optional: true`. */
export function optionalPeers(block: unknown): Set<string> {
  const names = new Set<string>();
  if (isJsonObject(block)) {
    for (const [name, flags] of Object.entries(block)) {
      if (isJsonObject(flags) && flags.optional === true) {
        names.add(name);
      }
    }
  }
  return names;
}

/** The dependency-declaring fields of an npm manifest, the same in a registry
 * version-metadata document and a package.json. */
export interface IDependencyDecls {
  readonly dependencies?: unknown;
  readonly optionalDependencies?: unknown;
  readonly peerDependencies?: unknown;
  readonly peerDependenciesMeta?: unknown;
}

/**
 * Read the requirements a manifest declares, as npm reads them.
 *
 * - `required`: the `dependencies`, then the peers, each peer with `provided`
 *   set: `"optional"` for one `peerDependenciesMeta` marks `optional: true`,
 *   else `"expected"`. A peer named only in `peerDependenciesMeta` (marked
 *   optional, and in neither `peerDependencies` nor `dependencies`) is read as
 *   `*`, as Yarn and pnpm read it.
 * - `optional`: the `optionalDependencies`, for the caller to gate (the
 *   platform conditions that decide one are in that dependency's own
 *   metadata). A name listed here and in `dependencies` or `peerDependencies`
 *   is optional only (@parcel/watcher lists its per-platform binaries in both).
 *
 * `devDependencies` are ignored.
 */
export function declaredDependencies(manifest: IDependencyDecls): { required: Requirement[]; optional: Requirement[] } {
  const optionalDeps = dependencyBlock(manifest.optionalDependencies);
  const optionalPeerNames = optionalPeers(manifest.peerDependenciesMeta);
  const dependencies = dependencyBlock(manifest.dependencies);
  const declaredPeers = dependencyBlock(manifest.peerDependencies);
  /* An optional peer named only in `peerDependenciesMeta` is one with no
   * version bound, unless the manifest declares the name as a dependency. */
  const unboundPeers = [...optionalPeerNames]
    .filter(dep => !declaredPeers.has(dep) && !dependencies.has(dep))
    .map(dep => [dep, "*"] as const);
  const peers = [...declaredPeers, ...unboundPeers]
    .filter(([dep]) => !optionalDeps.has(dep))
    /* Keep an optional peer as a requirement: where the consumer supplies the
     * package, the requirer must reach it through its own dependencies. */
    .map(([dep, spec]) => ({
      ...dependencyRequirement(dep, spec),
      provided: optionalPeerNames.has(dep) ? ("optional" as const) : ("expected" as const),
    }));
  const required = [
    ...[...dependencies].filter(([dep]) => !optionalDeps.has(dep)).map(([dep, spec]) => dependencyRequirement(dep, spec)),
    ...peers,
  ];
  return { required, optional: [...optionalDeps].map(([dep, spec]) => dependencyRequirement(dep, spec)) };
}

/** Make the error for a metadata key fabr reserves, attributed to the entry as
 *  written ({@link mapEntryError}), even one spliced in from another map. */
function rejectedMetadataKey(key: string, metadata: PropertyMap, reason: string): Error {
  return mapEntryError(metadata, key, `metadata key '${key}' ${reason}`);
}

/** Encode a resolved metadata value as package.json JSON: a string list as an
 *  array where `arrayField`, else as the joined string; a sub-map as an object
 *  (`repository`); a list of sub-maps as an array of objects (`maintainers`). A
 *  sub-map's string lists are always joined. */
function encodeMetadataValue(value: PropertyMapValue, arrayField: boolean): unknown {
  if (Array.isArray(value)) {
    if (value.every((entry): entry is string => typeof entry === "string")) {
      return arrayField ? [...value] : value.join(" ");
    }
    return (value as PropertyMap[]).map(encodeMap);
  }
  return encodeMap(value);
}

/** Encode a sub-map as a JSON object, its string lists joined. */
function encodeMap(map: PropertyMap): Record<string, unknown> {
  return Object.fromEntries([...map].map(([key, value]) => [key, encodeMetadataValue(value, false)]));
}

/** A subpath's export conditions in the order node reads them, a condition
 *  mapping to a file or to further conditions. Insert `types` first and
 *  `default` last: TypeScript matches the runtime conditions too, so one listed
 *  before `types` hands it the JavaScript, and nothing after `default` is ever
 *  reached. */
type ExportConditions = Map<string, string | ExportConditions>;

/** A JavaScript file's extension paired with the declaration beside it. */
type Spelling = readonly [js: string, types: string];

const PLAIN: Spelling = [JS_EXTENSION, TYPE_EXTENSION];
const PINNED_ESM: Spelling = [ESM_JS_EXTENSION, ESM_TYPE_EXTENSION];
const PINNED_CJS: Spelling = [CJS_JS_EXTENSION, CJS_TYPE_EXTENSION];

/**
 * One module format a package publishes: the export condition it answers, and
 * the spellings a file of that format can have, tried in order: the
 * compile's plain one first, then the one a source that pins its own module
 * format (`.mts`, `.cts`) emits under. An entry point from an `.mts` source
 * thus resolves to the `.mjs` it emitted.
 *
 * A single-format package has one format, answering `default`; a dual package
 * has two, answering `import` and `require`.
 */
interface IExportFormat {
  condition: string;
  spellings: ReadonlyArray<Spelling>;
}

const SINGLE_FORMAT: ReadonlyArray<IExportFormat> = [{ condition: "default", spellings: [PLAIN, PINNED_ESM, PINNED_CJS] }];

/* `import` before `require` is convention only: the two never both match. */
const DUAL_FORMATS: ReadonlyArray<IExportFormat> = [
  { condition: "import", spellings: [PINNED_ESM] },
  { condition: "require", spellings: [PLAIN, PINNED_CJS] },
];

/** The extensions a built JavaScript module file can have, the plain `.js`
 *  first. */
const DELIVERED_SPELLINGS: ReadonlyArray<string> = [JS_EXTENSION, CJS_JS_EXTENSION, ESM_JS_EXTENSION];

/** Find the stem the compile emits a source under (its name without the
 *  extension), or undefined for a source that emits no module of its own: a
 *  declaration file, a stylesheet, a JSON resource. */
function emittedStem(name: string): string | undefined {
  if (DECLARATION_FILE.test(name)) {
    return undefined;
  }
  return /^(.*)\.[cm]?[jt]sx?$/.exec(name)?.[1];
}

/** Render conditions for the manifest: a lone `default` as the bare target
 *  path, anything else as the condition object, nested conditions and all. */
function renderConditions(conditions: ExportConditions): unknown {
  const sole = conditions.size === 1 ? conditions.get("default") : undefined;
  if (typeof sole === "string") {
    return encodeTargetPath(sole);
  }
  return Object.fromEntries(
    [...conditions].map(([condition, value]) => [
      condition,
      typeof value === "string" ? encodeTargetPath(value) : renderConditions(value),
    ])
  );
}

/** Find the conditions one format answers a stem with (`types` where the
 *  declaration beside its file exists, then `default`), or undefined where the
 *  format has no file for the stem: an `.mts` entry point has an ES-module file
 *  and no CommonJS one. */
function formatConditions(names: ReadonlySet<string>, stem: string, format: IExportFormat): ExportConditions | undefined {
  const spelling = format.spellings.find(([js]) => names.has(`${stem}${js}`));
  if (spelling === undefined) {
    return undefined;
  }
  const [js, types] = spelling;
  const conditions: ExportConditions = new Map();
  if (names.has(`${stem}${types}`)) {
    conditions.set("types", `./${stem}${types}`);
  }
  conditions.set("default", `./${stem}${js}`);
  return conditions;
}

/** Spell the subpath for a stem: `.` for the root `index`, else `./<stem>`. */
function subpathOf(stem: string): string {
  return stem === "index" ? "." : `./${stem}`;
}

/** Find the conditions for `stem` from every format that has a file for it, or
 *  undefined where none does. One format's conditions stand alone; several
 *  nest, each under the condition its format answers. Keep them nested, each
 *  with its own `types`: one declaration file cannot describe both formats. */
function conditionsFor(names: ReadonlySet<string>, stem: string, formats: ReadonlyArray<IExportFormat>): ExportConditions | undefined {
  const published = formats
    .map(format => [format, formatConditions(names, stem, format)] as const)
    .filter((entry): entry is readonly [IExportFormat, ExportConditions] => entry[1] !== undefined);
  if (published.length === 0) {
    return undefined;
  }
  return published.length === 1 ? published[0][1] : new Map(published.map(([format, answer]) => [format.condition, answer]));
}

/**
 * Make the `exports` map for the sources a target names in `exports`, or
 * undefined where it names none. Each source is published at the subpath its
 * built file has without a map, so the map only makes the files it leaves out
 * private.
 *
 * - A source's built name is the first of the compile's `rewrites` that
 *   matches it, else its own name (`foo.module.scss` → `foo.css.js`).
 * - A built JavaScript module is published at its stem: `.` for the root
 *   `index`, else `./<stem>`, with each format's conditions
 *   ({@link conditionsFor}).
 * - Where the stem is itself a built file (a css module's `foo.css.js` beside
 *   the stylesheet `foo.css`), `./<stem>` maps to that file, and the module is
 *   published under each spelling it has (`./foo.css.js`).
 * - A source whose built file is no module, declaration, map or manifest (a
 *   stylesheet, a JSON resource) maps that file to itself.
 * - `./package.json` is always published.
 *
 * Throws where a source builds to nothing the package can publish.
 */
function exportsByConvention(
  files: FileSet,
  sources: string[],
  formats: ReadonlyArray<IExportFormat>,
  rewrites: ReadonlyArray<Name>
): Record<string, unknown> | undefined {
  if (sources.length === 0) {
    return undefined;
  }
  const names = new Set([...files].map(([filename]) => filename));
  const projections = rewrites.map(rule => rule.makeProjector());
  const deliveredNameOf = (source: string): string => {
    for (const project of projections) {
      const renamed = project(source);
      if (renamed !== undefined) {
        return renamed;
      }
    }
    return source;
  };
  const entries = new Map<string, ExportConditions | string>();
  for (const source of sources) {
    const delivered = deliveredNameOf(source);
    const stem = emittedStem(delivered);
    const conditions = stem === undefined ? undefined : conditionsFor(names, stem, formats);
    if (stem !== undefined && conditions !== undefined) {
      if (names.has(stem)) {
        entries.set(`./${stem}`, `./${stem}`);
        for (const [subpath, target] of spellingSubpaths(names, stem, conditions)) {
          entries.set(subpath, target);
        }
      } else {
        entries.set(subpathOf(stem), conditions);
      }
    } else if (names.has(delivered) && isOpaqueContent(delivered)) {
      entries.set(`./${delivered}`, `./${delivered}`);
    } else {
      throw new FabrError(`'${source}' is named in exports, but produces nothing importable in the built package`);
    }
  }
  return renderExports(entries);
}

/**
 * List a subpath for each spelling of `stem` the package has
 * ({@link DELIVERED_SPELLINGS}), each with what it resolves to. A file the
 * stem's conditions name resolves to the conditions, so `import "pkg/foo.js"`
 * in an ES-module consumer reaches the ES-module file. A file they do not name
 * (a `foo.cjs` from a `.cts` source beside a `foo.ts`) is a different module,
 * and resolves to itself.
 */
function spellingSubpaths(
  names: ReadonlySet<string>,
  stem: string,
  conditions: ExportConditions
): Array<[string, ExportConditions | string]> {
  const targets = conditionTargets(conditions);
  return DELIVERED_SPELLINGS.filter(spelling => names.has(`${stem}${spelling}`)).map(spelling => {
    const file = `./${stem}${spelling}`;
    return [file, targets.has(file) ? conditions : file];
  });
}

/** Collect every file path a subpath's conditions resolve to, at any nesting
 * depth. */
function conditionTargets(conditions: ExportConditions, into = new Set<string>()): Set<string> {
  for (const value of conditions.values()) {
    if (typeof value === "string") {
      into.add(value);
    } else {
      conditionTargets(value, into);
    }
  }
  return into;
}

/** Find the stem a built JavaScript file sits under, or undefined for anything
 *  that is not one — a declaration, a source map, an asset. */
function deliveredStem(name: string): string | undefined {
  if (DECLARATION_FILE.test(name)) {
    return undefined;
  }
  const spelling = DELIVERED_SPELLINGS.find(extension => name.endsWith(extension));
  return spelling === undefined ? undefined : name.slice(0, -spelling.length);
}

/** The suffixes after `*` of the wildcard subpaths {@link exhaustiveExports}
 *  writes: `pkg/foo` (what CommonJS extension search reaches), `pkg/foo.js` and
 *  `pkg/foo.mjs`. */
const PATTERN_SUFFIXES: ReadonlyArray<string> = ["", JS_EXTENSION, ESM_JS_EXTENSION];

/** Make the conditions the wildcards resolve `stem` to: each format's first
 *  spelling, with its declaration, as an ordinary source emits them. */
function patternConditions(stem: string, formats: ReadonlyArray<IExportFormat>): ExportConditions {
  const answer = (format: IExportFormat): ExportConditions => {
    const [js, types] = format.spellings[0];
    return new Map<string, string | ExportConditions>([
      ["types", `./${stem}${types}`],
      ["default", `./${stem}${js}`],
    ]);
  };
  return formats.length === 1 ? answer(formats[0]) : new Map(formats.map(format => [format.condition, answer(format)]));
}

/** @return true if two condition sets render the same in the manifest,
 *  otherwise false. */
function sameConditions(a: ExportConditions, b: ExportConditions): boolean {
  return JSON.stringify(renderConditions(a)) === JSON.stringify(renderConditions(b));
}

/**
 * @return true if the wildcards answer every file this stem has, so it needs no
 * explicit key, otherwise false: the stem's conditions are what the wildcards
 * give it, and it has no spelling the wildcards do not name (for a `foo.cjs`
 * beside a `foo.ts`, `pkg/foo.cjs` would go to a `foo.cjs.js` that does not
 * exist).
 */
function coveredByPatterns(
  names: ReadonlySet<string>,
  stem: string,
  conditions: ExportConditions,
  formats: ReadonlyArray<IExportFormat>
): boolean {
  const delivered = DELIVERED_SPELLINGS.filter(spelling => names.has(`${stem}${spelling}`));
  return (
    delivered.every(spelling => PATTERN_SUFFIXES.includes(spelling)) && sameConditions(conditions, patternConditions(stem, formats))
  );
}

/**
 * Make the `exports` map for a dual package whose target names no `exports`:
 * every subpath node would resolve for these files with no map at all
 * resolves to the same module, the format chosen by the consumer's condition.
 *
 * - Where any module's files are covered ({@link coveredByPatterns}), three
 *   wildcards: `./*` (`pkg/foo`, as CommonJS extension search finds it),
 *   `./*.js` and `./*.mjs`, each resolving to {@link patternConditions}.
 * - An explicit key, which node matches before any wildcard, for: the package
 *   root `.` (no wildcard matches it); each module the wildcards do not cover
 *   (a format-pinned `.cts`, a `resources` JavaScript with no declaration),
 *   at its stem and at each spelling it has; `./lib` for a `lib/index` where
 *   the package has no `lib` module (one would own the subpath); and every
 *   file that is no module, declaration, map or manifest, mapping to itself.
 * - `./package.json`, always.
 *
 * Declarations and source maps get no subpath of their own.
 */
function exhaustiveExports(files: FileSet, formats: ReadonlyArray<IExportFormat>): Record<string, unknown> {
  const names = new Set([...files].map(([filename]) => filename));
  const entries = new Map<string, ExportConditions | string>();
  const stems = new Map<string, ExportConditions>();
  let patterned = false;
  for (const stem of new Set([...names].map(deliveredStem))) {
    const conditions = stem === undefined ? undefined : conditionsFor(names, stem, formats);
    if (stem === undefined || conditions === undefined) {
      continue;
    }
    stems.set(stem, conditions);
    if (coveredByPatterns(names, stem, conditions, formats)) {
      patterned = true;
      /* No wildcard matches the package root; `./index` and its spellings it does. */
      if (stem === "index") {
        entries.set(".", conditions);
      }
    } else {
      entries.set(subpathOf(stem), conditions);
      for (const [subpath, target] of spellingSubpaths(names, stem, conditions)) {
        entries.set(subpath, target);
      }
    }
  }
  if (patterned) {
    for (const suffix of PATTERN_SUFFIXES) {
      entries.set(`./*${suffix}`, patternConditions("*", formats));
    }
  }
  /* `pkg/lib` for a `lib/index`, as CommonJS directory resolution finds it,
   * unless the package has a `lib` module: node loads that first without a map,
   * so it keeps the subpath, by explicit key or through the wildcards. */
  for (const [stem, conditions] of stems) {
    const directory = stem.slice(0, -"/index".length);
    if (stem.endsWith("/index") && !stems.has(directory) && !entries.has(`./${directory}`)) {
      entries.set(`./${directory}`, conditions);
    }
  }
  /* A file no format publishes (a stylesheet, a JSON resource, a template) maps to itself. */
  for (const name of names) {
    if (isOpaqueContent(name)) {
      entries.set(`./${name}`, `./${name}`);
    }
  }
  return renderExports(entries);
}

/** @return true if a built file is published only under its own name,
 *  otherwise false: it is not a JavaScript module, a declaration, a source map
 *  or the manifest. */
function isOpaqueContent(name: string): boolean {
  return deliveredStem(name) === undefined && !name.endsWith(".map") && !DECLARATION_FILE.test(name) && name !== "package.json";
}

/** Render a subpath→conditions table as the manifest's `exports` object, with
 *  `./package.json` added. Each target is written as the URL-relative path node
 *  reads it as ({@link encodeTargetPath}); keys are written as they are. Keys
 *  are sorted in code-unit order (`.` first), so the manifest's bytes do not
 *  depend on a file set's order. */
function renderExports(entries: Map<string, ExportConditions | string>): Record<string, unknown> {
  const map = new Map<string, unknown>(
    [...entries.keys()].sort().map(subpath => {
      const value = entries.get(subpath)!;
      return [subpath, typeof value === "string" ? encodeTargetPath(value) : renderConditions(value)];
    })
  );
  map.set("./package.json", "./package.json");
  return Object.fromEntries(map);
}

/** Everything the generated manifest is computed from. */
export interface IPackageJsonInputs {
  /** The package's built contents — where the entry points are found. */
  files: FileSet;
  /** An imported source package.json, whose descriptive fields are carried over. */
  seed?: Record<string, unknown>;
  name: string;
  version?: string;
  /** Declared requirements from `deps` → `dependencies`. */
  declared: (Requirement | undefined)[];
  /** Declared requirements from `provided_deps` → `peerDependencies`. */
  provided: (Requirement | undefined)[];
  /** Declared requirements from `optional_provided_deps` → `peerDependencies`,
   * each marked optional in `peerDependenciesMeta`. */
  optionalProvided?: (Requirement | undefined)[];
  jsTarget: JSTarget;
  metadata: PropertyMap;
  /** The sources named in `exports`, by the name they compile under. Empty for
   *  a target naming none: a single-format package then gets no map, and a dual
   *  one the map {@link exhaustiveExports} makes. */
  exports?: string[];
  /** The rewrite rules the compile applied (`ICompiledContents.rewrites`), each
   *  pairing a source name with the built file that answers it. */
  rewrites?: ReadonlyArray<Name>;
}

/**
 * Make the package.json for a built package. Its fields, in order:
 * - `name`, and `version` where given.
 * - The seed manifest's fields, less {@link COMPUTED_FIELDS} and
 *   {@link STRIPPED_FIELDS}.
 * - The `metadata` entries, each replacing a seed field of its name in place,
 *   else added.
 * - The computed fields: `type` from the JS target's module format; `main` and
 *   `types` where `index.js` and `index.d.ts` exist; `exports`
 *   ({@link exportsByConvention} for named exports, {@link exhaustiveExports}
 *   for a dual package naming none, else none); `bin` ({@link binByConvention});
 *   `dependencies` from `declared`; `peerDependencies` from `provided` and
 *   `optionalProvided`, the latter also marked optional in
 *   `peerDependenciesMeta`.
 *
 * Each requirement is written as declared ({@link requirementSpec}), not as
 * resolved. Throws where a `metadata` key names a computed or stripped field,
 * a command two bins claim, or an `exports` source building to nothing.
 */
export function createPackageJson({
  files,
  seed,
  name,
  version,
  declared,
  provided,
  optionalProvided,
  jsTarget,
  metadata,
  exports = [],
  rewrites = [],
}: IPackageJsonInputs): MemoryFile {
  /* Place the identity first: a key keeps the position it is first given, and
   * later assignments change only its value. */
  const packageJson: Record<string, unknown> = Object.assign(Object.create(null), { name });
  if (version !== undefined) {
    packageJson.version = version;
  }
  for (const [key, value] of Object.entries(seed ?? {})) {
    if (!(key in packageJson) && !COMPUTED_FIELDS.has(key) && !STRIPPED_FIELDS.has(key)) {
      packageJson[key] = value;
    }
  }
  for (const [key, value] of metadata) {
    if (COMPUTED_FIELDS.has(key)) {
      throw rejectedMetadataKey(key, metadata, "is set by fabr and cannot be overridden");
    }
    if (STRIPPED_FIELDS.has(key)) {
      throw rejectedMetadataKey(key, metadata, "is not carried into a published package");
    }
    packageJson[key] = encodeMetadataValue(value, ARRAY_FIELDS.has(key));
  }
  packageJson.type = jsTarget.module === "esm" ? "module" : "commonjs";
  const names = new Set([...files].map(([filename]) => filename));
  if (names.has("index.js")) {
    packageJson.main = "index.js";
  }
  if (names.has("index.d.ts")) {
    packageJson.types = "index.d.ts";
  }
  /* `main` and `types` are written beside any map, for tools that read a
   * manifest without resolving `exports`. */
  const dual = jsTarget.module === "dual";
  const formats = dual ? DUAL_FORMATS : SINGLE_FORMAT;
  const exported =
    exports.length > 0 ? exportsByConvention(files, exports, formats, rewrites) : dual ? exhaustiveExports(files, formats) : undefined;
  if (exported !== undefined) {
    packageJson.exports = exported;
  }

  const bin = binByConvention(files);
  if (bin.size > 0) {
    packageJson.bin = Object.fromEntries(bin);
  }

  const dependencies = packageDependencies(declared);
  if (dependencies.size > 0) {
    packageJson.dependencies = Object.fromEntries(dependencies);
  }
  const peerDependencies = peerDependenciesOf(provided);
  const optionalPeers = peerDependenciesOf(optionalProvided ?? []);
  if (peerDependencies.size + optionalPeers.size > 0) {
    packageJson.peerDependencies = Object.fromEntries([...peerDependencies, ...optionalPeers]);
  }
  if (optionalPeers.size > 0) {
    packageJson.peerDependenciesMeta = Object.fromEntries([...optionalPeers.keys()].map(name => [name, { optional: true }]));
  }

  return MemoryFile.from(JSON.stringify(packageJson, undefined, 2) + "\n");
}

/**
 * List the `dependencies` entries for the generated package.json: one per
 * declared requirement, `@types/*` included, each as declared rather than as
 * resolved ({@link requirementSpec}).
 */
function packageDependencies(declared: (Requirement | undefined)[]): Map<string, string> {
  const dependencies = new Map<string, string>();
  for (const req of declared) {
    if (req) {
      const { name, spec } = requirementSpec(req);
      dependencies.set(name, spec);
    }
  }
  return dependencies;
}

/**
 * List the `peerDependencies` entries for the generated package.json: one per
 * declared requirement, each as declared rather than as resolved
 * ({@link requirementSpec}).
 */
function peerDependenciesOf(providedDeclared: (Requirement | undefined)[]): Map<string, string> {
  const peerDependencies = new Map<string, string>();
  for (const req of providedDeclared) {
    if (req) {
      const { name, spec } = requirementSpec(req);
      peerDependencies.set(name, spec);
    }
  }
  return peerDependencies;
}

/** The manifest fields whose entries can name another package the same sync
 *  publishes (a co-member). */
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/* The manifest fields whose entries a consumer's install resolves. */
const INSTALLED_DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];

/**
 * Rewrite a built manifest for publication, returning a new object: `name` and
 * `version` from `coordinate`, first, and each dependency entry (in any of
 * {@link DEPENDENCY_FIELDS}) on a package `members` holds rewritten to that
 * member's coordinate ({@link rewriteCoMemberField}). An entry is written in
 * npm's alias form where the member is published under another name, so the
 * code still imports the name it was built against.
 */
export function rewriteManifest(
  manifest: Record<string, unknown>,
  coordinate: NpmPublishIdentity,
  members: ReadonlyMap<string, NpmPublishIdentity>
): Record<string, unknown> {
  /* Place the identity first; a versionless manifest has no `version` to replace. */
  const result: Record<string, unknown> = Object.assign(Object.create(null), {
    name: coordinate.name,
    version: coordinate.version,
  });
  for (const [key, value] of Object.entries(manifest)) {
    if (!(key in result)) {
      result[key] = value;
    }
  }
  for (const field of DEPENDENCY_FIELDS) {
    const deps = result[field];
    if (isJsonObject(deps)) {
      result[field] = rewriteCoMemberField(deps, members, field === "peerDependencies");
    }
  }
  return result;
}

/**
 * Rewrite one dependency block's co-member entries, found by the package each
 * names (its key, or the package an alias names), to the member's coordinate:
 * its version exactly where `exact` (a `peerDependencies` block), else as a
 * caret range, in npm's alias form where it is published under a name other
 * than the entry's. Every other entry is copied as it is.
 */
function rewriteCoMemberField(
  deps: Record<string, unknown>,
  members: ReadonlyMap<string, NpmPublishIdentity>,
  exact: boolean
): Record<string, unknown> {
  const rewritten: Record<string, unknown> = { ...deps };
  for (const [dep, spec] of Object.entries(rewritten)) {
    const member = typeof spec === "string" ? members.get(dependencyRequirement(dep, spec).name) : undefined;
    if (member !== undefined) {
      const range = exact ? member.version : `^${member.version}`;
      rewritten[dep] = requirementSpec({ name: member.name, versionConstraint: range, renameTo: dep }).spec;
    }
  }
  return rewritten;
}

/** List the members this manifest depends on, by the names they are
 * published under, given each name a dependency may name one by. Used to
 * publish a member's dependencies before it. */
export function memberDependencies(manifest: Record<string, unknown>, memberNames: ReadonlyMap<string, string>): string[] {
  const names = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    for (const [dep, spec] of dependencyBlock(manifest[field])) {
      const published = memberNames.get(dependencyRequirement(dep, spec).name);
      if (published !== undefined) {
        names.add(published);
      }
    }
  }
  return [...names];
}

/**
 * List the entries of a rewritten manifest's installed dependency fields
 * that still require `*`, as the entry's own spec or an alias's, for the
 * caller to refuse. A dependency on a versionless built package is written
 * `*`, and stays so where the sync did not publish that package (or published
 * it at several versions).
 */
export function unresolvableDependencies(manifest: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const field of INSTALLED_DEPENDENCY_FIELDS) {
    for (const [dep, spec] of dependencyBlock(manifest[field])) {
      /* `*`, or an alias to a package at `*` (`npm:@acme/core@*`). */
      if (dependencyRequirement(dep, spec).versionConstraint === "*") {
        names.push(dep);
      }
    }
  }
  return names;
}
