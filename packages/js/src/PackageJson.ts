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
 * The package.json *document* — everything about generating, reading, and
 * rewriting one, in one place (the registry *wire* — packument, tarball, publish
 * PUT, platform gates — stays in NPMProtocol). package.json is open-ended by
 * design, so fabr's policy is a **denylist**: it owns the fields it generates,
 * strips the ones that would collide with what it generates (or are dead
 * dev-cruft), and passes everything else — descriptive fields and unknown user
 * extensions — through untouched.
 */

import {
  declPosn,
  FileSet,
  isJsonObject,
  mapEntryOrigin,
  MemoryFile,
  Name,
  NameResolutionError,
  PropertyMap,
  PropertyMapValue,
  Requirement,
} from "@fabr-build/core";
import {
  binByConvention,
  CJS_JS_EXTENSION,
  CJS_TYPE_EXTENSION,
  ESM_JS_EXTENSION,
  ESM_TYPE_EXTENSION,
  JS_EXTENSION,
  JSTarget,
  TYPE_EXTENSION,
} from "./JSPackage";
import { NpmPublishIdentity } from "./NPMProtocol";

/** Fields fabr computes from the target itself — a `metadata` key naming one is
 *  rejected (it would be silently overridden), and a seed copy is dropped (fabr
 *  recomputes it for the built layout, so the source's value would be wrong). */
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
]);

/** Fields stripped from an imported package.json (and rejected in `metadata`):
 *  they collide with what fabr owns — the tarball contents (`files`,
 *  `bundle[d]Dependencies`), dependency resolution (`resolutions`, `overrides`),
 *  publishing (`private`, `publishConfig`) — or are dead build/dev-time cruft
 *  (`devDependencies`, `scripts` incl. the deprecated `postinstall`,
 *  `packageManager`, `workspaces`). Everything not listed here or in
 *  {@link COMPUTED_FIELDS} passes through — package.json is open-ended. */
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

/** package.json fields whose value is a JSON array of strings, so a scalar
 *  `metadata` entry (a string list) serializes as an array — `keywords = build`
 *  → `["build"]` — rather than the joined string other fields get. (os/cpu/libc
 *  are fabr's to compute under native support, but until then a declared value
 *  is carried, as an array.) */
const ARRAY_FIELDS = new Set(["keywords", "os", "cpu", "libc"]);

/**
 * A manifest dependency block (`dependencies`, `optionalDependencies`, …) as a
 * name→constraint map. npm normalizes away anything that isn't an object of
 * strings — `"dependencies": []` is published and means "none" — and so do we:
 * a block that isn't an object, and any entry whose constraint isn't a string,
 * contributes nothing. (Reading them positionally instead would manufacture
 * requirements on packages named `0`, `1`, … that no registry can resolve.)
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
 * The requirement one dependency-block entry declares. Ordinarily the entry's
 * name IS the package and its value the constraint, but npm's **alias** form —
 * `"wrap-ansi-cjs": "npm:wrap-ansi@^7.0.0"` — names a different package, which
 * the requirer's own code then imports under the entry name (`@isaacs/cliui`
 * literally `require`s `'wrap-ansi-cjs'`). The alias rides on the requirement
 * as the local name; the constraint applies to the real package, so resolution
 * and version selection treat it as an ordinary requirement on `wrap-ansi`.
 *
 * An alias with no version (`npm:wrap-ansi`) is unconstrained, exactly as a
 * bare `*` would be — the resolver reports it as such if nothing else pins the
 * package. Spec forms fabr doesn't understand (`file:`, `git+`, `workspace:`)
 * are left alone, to be rejected as the unparseable constraints they are.
 */
export function dependencyRequirement(name: string, spec: string): Requirement {
  if (!spec.startsWith(ALIAS_PREFIX)) {
    return { pkg: name, constraint: spec };
  }
  const target = spec.substring(ALIAS_PREFIX.length);
  /* Scoped names start with their own `@`, so the version separator is the
   * last one — and only counts if something follows it. */
  const separator = target.lastIndexOf("@");
  const pkg = separator > 0 ? target.substring(0, separator) : target;
  const constraint = separator > 0 ? target.substring(separator + 1) : "";
  return {
    pkg,
    constraint: constraint === "" ? "*" : constraint,
    /* An alias to the package's own name renames nothing */
    ...(pkg === name ? {} : { alias: name }),
  };
}

/**
 * One dependency-block entry stating `requirement` — the inverse of
 * {@link dependencyRequirement}, and the only place a generated manifest writes
 * a dependency. A requirement carrying a local alias is stated in npm's alias
 * form (`"typescript-6": "npm:typescript@6.0.0-beta"`), because the entry name
 * is what the shipped code imports: recording the package's own name would
 * install it where nothing looks for it.
 */
export function requirementSpec(requirement: Requirement): { name: string; spec: string } {
  const { pkg, constraint, alias } = requirement;
  return alias === undefined || alias === pkg
    ? { name: pkg, spec: constraint }
    : { name: alias, spec: `${ALIAS_PREFIX}${pkg}@${constraint}` };
}

const ALIAS_PREFIX = "npm:";

/** The peers a `peerDependenciesMeta` block marks `optional: true`. */
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

/** The dependency-declaring fields of an npm manifest — the same shape in a
 * registry version-metadata document and a package.json. */
export interface IDependencyDecls {
  readonly dependencies?: unknown;
  readonly optionalDependencies?: unknown;
  readonly peerDependencies?: unknown;
  readonly peerDependenciesMeta?: unknown;
}

/**
 * The requirements a manifest declares, npm's reading: `required` is the
 * declared `dependencies` plus the non-optional `peerDependencies` (soft —
 * attach-first requirements, see NPMRepository.getRequirements for the peer
 * doctrine); `optional` is the `optionalDependencies` — which the caller
 * decides how to gate (their os/cpu conditions live in the *dependency's* own
 * metadata, so this fold cannot judge them). npm's rule: an entry in
 * optionalDependencies overrides the same name in dependencies, so a dep
 * listed in both is optional (os/cpu-gated, dropped if the target doesn't
 * match) — @parcel/watcher lists its per-platform native binaries in both. An
 * `optional: true` peer ("if present, must match") is never auto-installed,
 * npm parity; devDependencies stay ignored.
 */
export function declaredDependencies(manifest: IDependencyDecls): { required: Requirement[]; optional: Requirement[] } {
  const optionalDeps = dependencyBlock(manifest.optionalDependencies);
  const optionalPeerNames = optionalPeers(manifest.peerDependenciesMeta);
  const peers = [...dependencyBlock(manifest.peerDependencies)]
    .filter(([dep]) => !optionalDeps.has(dep))
    /* An `optional: true` peer is never installed, but it is still a
     * requirement: if the consumer provides the package, the requirer has to be
     * able to reach it. Dropping it entirely is what a hoisted tree could
     * afford — the requirer found the hoisted copy by walking up — and what a
     * dependency table cannot. */
    .map(([dep, spec]) => ({
      ...dependencyRequirement(dep, spec),
      soft: true,
      ...(optionalPeerNames.has(dep) ? { attachOnly: true } : {}),
    }));
  const required = [
    ...[...dependencyBlock(manifest.dependencies)]
      .filter(([dep]) => !optionalDeps.has(dep))
      .map(([dep, spec]) => dependencyRequirement(dep, spec)),
    ...peers,
  ];
  return { required, optional: [...optionalDeps].map(([dep, spec]) => dependencyRequirement(dep, spec)) };
}

/** The error for a metadata key fabr reserves: attributed through the map's ghost
 *  origin to the written entry — even one that arrived through a shared map — with
 *  any splice/reference hops named in the message. */
function rejectedMetadataKey(key: string, metadata: PropertyMap, reason: string): Error {
  const message = `metadata key '${key}' ${reason}`;
  const origin = mapEntryOrigin(metadata, key);
  if (!origin) {
    return new Error(message);
  }
  const via = origin.via.map(hop => ` (via '${("ref" in hop ? hop.ref : hop.value).toString()}')`).join("");
  return new NameResolutionError(Name.fromLiteral(key), declPosn(origin.entry), undefined, message + via);
}

/** Encode a resolved metadata value as its package.json JSON shape: a scalar
 *  string list becomes an array for an {@link ARRAY_FIELDS} field, else the joined
 *  string; a sub-map becomes an object (`repository`); a list of sub-maps an array
 *  of objects (`maintainers`). Sub-map fields are always scalar strings (npm has no
 *  nested array-of-strings), so nested values join. */
function encodeMetadataValue(value: PropertyMapValue, arrayField: boolean): unknown {
  if (Array.isArray(value)) {
    if (value.every((entry): entry is string => typeof entry === "string")) {
      return arrayField ? [...value] : value.join(" ");
    }
    return (value as PropertyMap[]).map(encodeMap);
  }
  return encodeMap(value);
}

function encodeMap(map: PropertyMap): Record<string, unknown> {
  return Object.fromEntries([...map].map(([key, value]) => [key, encodeMetadataValue(value, false)]));
}

/** A subpath's export conditions in the order node reads them, nesting where a
 *  condition resolves to further ones. `types` comes first because TypeScript
 *  applies it IN ADDITION to the runtime conditions, so a runtime entry listed
 *  ahead of it wins and hands the compiler the JavaScript; `default` comes last
 *  because it matches every world, making anything after it unreachable. */
type ExportConditions = Map<string, string | ExportConditions>;

/** A TypeScript declaration file, in any of its module flavours. */
const DECLARATION = /\.d\.[cm]?ts$/;

/** A JavaScript file's extension paired with the declaration beside it. */
type Spelling = readonly [js: string, types: string];

const PLAIN: Spelling = [JS_EXTENSION, TYPE_EXTENSION];
const PINNED_ESM: Spelling = [ESM_JS_EXTENSION, ESM_TYPE_EXTENSION];
const PINNED_CJS: Spelling = [CJS_JS_EXTENSION, CJS_TYPE_EXTENSION];

/**
 * One format a package publishes: the condition it answers, and the spellings a
 * file of that format can carry — the compile's own `.js`, plus the one a source
 * that pinned its own module format (`.mts`, `.cts`) emits under. First match
 * wins, so an entry point named as an `.mts` source resolves to the `.mjs` it
 * really emitted rather than a `.js` that was never written.
 *
 * A single-format package has one format answering `default`; a dual package has
 * two, told apart by how the consumer loaded the specifier.
 */
interface IExportFormat {
  condition: string;
  spellings: ReadonlyArray<Spelling>;
}

const SINGLE_FORMAT: ReadonlyArray<IExportFormat> = [{ condition: "default", spellings: [PLAIN, PINNED_ESM, PINNED_CJS] }];

/* `import` first by convention only — the two are mutually exclusive, so unlike
 * `types`-before-runtime nothing depends on the order. */
const DUAL_FORMATS: ReadonlyArray<IExportFormat> = [
  { condition: "import", spellings: [PINNED_ESM] },
  { condition: "require", spellings: [PLAIN, PINNED_CJS] },
];

/** The spellings a module can be delivered under, in the order a single-format
 *  build would have produced them: the name a consumer already writes when it
 *  names the file rather than the subpath. */
const DELIVERED_SPELLINGS: ReadonlyArray<string> = [JS_EXTENSION, CJS_JS_EXTENSION, ESM_JS_EXTENSION];

/** The stem the compile emits a source under — its name without the extension —
 *  or undefined for a source that emits no module of its own to name a subpath
 *  for: a declaration file, a stylesheet, a JSON resource. */
function emittedStem(name: string): string | undefined {
  if (DECLARATION.test(name)) {
    return undefined;
  }
  return /^(.*)\.[cm]?[jt]sx?$/.exec(name)?.[1];
}

/** A lone `default` renders as the bare target path npm's own manifests use;
 *  anything richer as the condition object, nested conditions and all. */
function renderConditions(conditions: ExportConditions): unknown {
  const sole = conditions.size === 1 ? conditions.get("default") : undefined;
  if (typeof sole === "string") {
    return sole;
  }
  return Object.fromEntries([...conditions].map(([condition, value]) => [condition, typeof value === "string" ? value : renderConditions(value)]));
}

/** The conditions one format answers a subpath with — its declarations where the
 *  compile emitted any, then its JavaScript — or undefined where this format has
 *  no file for the subpath at all. That happens for a source that pinned its own
 *  module format: an `.mts` entry point has an ES-module format and no CommonJS
 *  one, and publishing a `require` condition pointing at a file that was never
 *  emitted would be worse than not answering `require`. */
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

/** How a subpath is spelled for a stem: the package root for a root `index`,
 *  else the stem said explicitly. */
function subpathOf(stem: string): string {
  return stem === "index" ? "." : `./${stem}`;
}

/** The conditions every format that HAS a file for `stem` answers with, or
 *  undefined where no format does. One format publishes its conditions directly;
 *  several nest under the condition each answers. Flattening a dual entry to a
 *  single `types` beside `import`/`require` would be the commoner spelling and
 *  the wrong one — one declaration file cannot describe both formats, which is
 *  what a consumer's resolver reports as a module masquerading as the other
 *  kind. */
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
 * The generated `exports` map: one entry per source the target names in
 * `exports`, published at the subpath its emitted file already sits at —
 * `index.js` at the package root is `.`, anything else is `./` plus its path
 * without the extension.
 *
 * So declaring exports **narrows** rather than renames: every subpath is exactly
 * what path resolution reached before there was a map at all, and what the map
 * adds is that everything undeclared becomes private. That is what lets entry
 * points be declared in source terms — fabr owns the emit layout, so an author
 * naming target paths would be writing against a layout that is not theirs.
 *
 * `./package.json` is published unconditionally. Every other file is public only
 * if the author names its source; package.json has no source to name, being
 * generated here, and a file nobody is able to declare should not become
 * unreachable merely because the map exists. Consumers do reach for it by name
 * (version banners, plugin discovery), so the alternative is an
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` with no remedy available to either side.
 */
function exportsByConvention(files: FileSet, sources: string[], formats: ReadonlyArray<IExportFormat>): Record<string, unknown> | undefined {
  if (sources.length === 0) {
    return undefined;
  }
  const names = new Set([...files].map(([filename]) => filename));
  const entries = new Map<string, ExportConditions | string>();
  for (const source of sources) {
    const stem = emittedStem(source);
    const conditions = stem === undefined ? undefined : conditionsFor(names, stem, formats);
    if (stem === undefined || conditions === undefined) {
      throw new Error(`'${source}' is named in exports, but produces no JavaScript in the built package`);
    }
    entries.set(subpathOf(stem), conditions);
  }
  return renderExports(entries);
}

/**
 * The subpaths naming a stem's delivered files by their own names, each paired
 * with what it resolves to. Every spelling the package actually contains gets
 * one, since each was reachable under its own name before there was a map.
 *
 * A spelling the stem's formats already name resolves to the FACES, so
 * `import "pkg/foo.js"` reaches the ES-module copy rather than loading the
 * CommonJS one into an ES-module consumer — the dual-package hazard, two
 * instances of one module. A spelling they do not name — a `foo.cjs` from a
 * `.cts` source sitting beside a `foo.ts` — is a different module that happens
 * to share the stem, so it resolves to itself.
 */
function spellingSubpaths(names: ReadonlySet<string>, stem: string, conditions: ExportConditions): Array<[string, ExportConditions | string]> {
  const targets = conditionTargets(conditions);
  return DELIVERED_SPELLINGS.filter(spelling => names.has(`${stem}${spelling}`)).map(spelling => {
    const file = `./${stem}${spelling}`;
    return [file, targets.has(file) ? conditions : file];
  });
}

/** Every file path a subpath's conditions resolve to, at any nesting depth. */
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

/** The stem a delivered JavaScript file sits under, or undefined for anything
 *  that is not one — a declaration, a source map, an asset. */
function deliveredStem(name: string): string | undefined {
  if (DECLARATION.test(name)) {
    return undefined;
  }
  const spelling = DELIVERED_SPELLINGS.find(extension => name.endsWith(extension));
  return spelling === undefined ? undefined : name.slice(0, -spelling.length);
}

/** The subpath shapes the wildcards cover, as suffixes after the captured stem:
 *  `pkg/foo` (what CommonJS extension search reaches), and the two spellings
 *  naming a delivered file outright. */
const PATTERN_SUFFIXES: ReadonlyArray<string> = ["", JS_EXTENSION, ESM_JS_EXTENSION];

/** What the wildcards resolve a captured stem to: every format's own first
 *  spelling, declarations included — what an ordinary source emits under a dual
 *  build. A stem whose delivered files differ from this in any way is not covered
 *  by them and takes explicit keys instead. */
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

/** Whether two condition sets publish the same thing — compared as the manifest
 *  will carry them, since that is what a consumer resolves against. */
function sameConditions(a: ExportConditions, b: ExportConditions): boolean {
  return JSON.stringify(renderConditions(a)) === JSON.stringify(renderConditions(b));
}

/**
 * Whether the wildcards answer everything this stem delivers, so it needs no
 * explicit key. Both halves are needed: they must resolve it to the right files
 * (`sameConditions`), AND it must deliver no spelling they do not name — a
 * `foo.cjs` beside a `foo.ts` is a different module sharing the stem, and the
 * wildcards would send `pkg/foo.cjs` to a `foo.cjs.js` that does not exist.
 */
function coveredByPatterns(names: ReadonlySet<string>, stem: string, conditions: ExportConditions, formats: ReadonlyArray<IExportFormat>): boolean {
  const delivered = DELIVERED_SPELLINGS.filter(spelling => names.has(`${stem}${spelling}`));
  return delivered.every(spelling => PATTERN_SUFFIXES.includes(spelling)) && sameConditions(conditions, patternConditions(stem, formats));
}

/**
 * The `exports` map for a **dual** package whose target declares no entry points:
 * every subpath that resolves in a single-format build of the same sources. It
 * exists because a dual package must have a map — conditions are node's only
 * mechanism for choosing a format — while "declared nothing" has to go on meaning
 * "narrowed nothing".
 *
 * The regular case is three **wildcards**, one per subpath shape node's own
 * resolution publishes: `pkg/foo` (CommonJS extension search), `pkg/foo.js` (what
 * an ES-module consumer must write) and `pkg/foo.mjs`. One pattern could not do
 * this — it publishes a single shape — but three can, and because `*` substitutes
 * into the targets they supply the extension that a bare `"./*": "./*"` could
 * not. Node prefers the longest suffix after `*`, so the three never disagree.
 *
 * What a wildcard would answer WRONGLY keeps an explicit key, which node matches
 * ahead of any pattern: the package root (not a subpath a pattern can match), a
 * module whose delivered files are not the plain dual quartet (a format-pinned
 * `.cts`, a `resources` JavaScript with no declaration), `pkg/lib` for a
 * `lib/index` (patterns do no directory indexes), and every non-module file,
 * which resolves to itself.
 *
 * Declarations and source maps get no subpath of their own: nothing imports them
 * by name, and a declaration is already published as its format's `types`.
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
      /* The package root is not a subpath, so no pattern reaches it — while
       * `./index`, `./index.js` and `./index.mjs` are ordinary and are. */
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
  /* `pkg/lib` for a `lib/index`, as CommonJS directory resolution answers it —
   * unless the package also has a `lib.js`, which resolution prefers and which
   * has already claimed the subpath. */
  for (const [stem, conditions] of stems) {
    const directory = stem.slice(0, -"/index".length);
    if (stem.endsWith("/index") && !entries.has(`./${directory}`)) {
      entries.set(`./${directory}`, conditions);
    }
  }
  /* Anything no format accounts for — a stylesheet, a JSON resource, a template —
   * is reachable by its own name and nothing else, so it maps to itself. */
  for (const name of names) {
    if (isOpaqueContent(name)) {
      entries.set(`./${name}`, `./${name}`);
    }
  }
  return renderExports(entries);
}

/** Whether a delivered file is reachable only under its own name: not a module
 *  (so no format publishes it), and not one of the artifacts nothing ever imports
 *  by name — a declaration, a source map, or the manifest itself. */
function isOpaqueContent(name: string): boolean {
  return deliveredStem(name) === undefined && !name.endsWith(".map") && !DECLARATION.test(name) && name !== "package.json";
}

/** Render a subpath→conditions table as the manifest's `exports` object.
 *  Sorted, so the map does not carry a file set's iteration order into the
 *  manifest (its bytes are a cache input). `.` sorts first on its own — it is a
 *  prefix of every other subpath. Explicit subpaths are order-independent to
 *  node; only patterns are ordered, and there are none here. */
function renderExports(entries: Map<string, ExportConditions | string>): Record<string, unknown> {
  const map = new Map<string, unknown>(
    [...entries.keys()].sort().map(subpath => {
      const value = entries.get(subpath)!;
      return [subpath, typeof value === "string" ? value : renderConditions(value)];
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
  jsTarget: JSTarget;
  metadata: PropertyMap;
  /** The sources named in `exports`, by the name they compile under. Empty for a
   *  target declaring none, which publishes no map — `main`/`types` by convention
   *  and every emitted file reachable, exactly as before. */
  exports?: string[];
}

/**
 * Generate the package.json for the built package: the computed identity leads,
 * then the imported seed (minus the stripped/computed fields), then the declared
 * `metadata`, then the fields fabr computes — module type, entry points, the
 * direct package requirements from `deps` (`dependencies`) and `provided_deps`
 * (`peerDependencies`). Computed fields always win; metadata may name neither a
 * computed nor a stripped field.
 */
export function createPackageJson({
  files,
  seed,
  name,
  version,
  declared,
  provided,
  jsTarget,
  metadata,
  exports = [],
}: IPackageJsonInputs): MemoryFile {
  /* The identity leads (the conventional reading order — name, then version), so
   * it is placed before the seed and metadata are copied in; a key keeps its
   * first-placed position, while the computed assignments below still win on value. */
  const packageJson: Record<string, unknown> = Object.assign(Object.create(null), { name });
  if (version !== undefined) {
    packageJson.version = version;
  }
  for (const [key, value] of Object.entries(seed ?? {})) {
    /* Carry an imported field unless fabr owns it (computed, recomputed below) or
     * strips it (collides with what fabr generates, or is dev-only cruft). */
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
  /* `main`/`types` stay by convention alongside the map: node ignores them once
   * `exports` exists, and they remain the entry point for everything that reads
   * a manifest without resolving one (bundlers, older tooling). */
  /* A dual package always publishes a map, because conditions are node's only
   * mechanism for choosing a format; with nothing declared it publishes an
   * exhaustive one, so declaring nothing still narrows nothing. A single-format
   * package needs no map to be reachable, so it gets none. */
  const dual = jsTarget.module === "dual";
  const formats = dual ? DUAL_FORMATS : SINGLE_FORMAT;
  const exported = exports.length > 0 ? exportsByConvention(files, exports, formats) : dual ? exhaustiveExports(files, formats) : undefined;
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
  /* provided_deps → peerDependencies: the host supplies the one shared copy. */
  const peerDependencies = peerDependenciesOf(provided);
  if (peerDependencies.size > 0) {
    packageJson.peerDependencies = Object.fromEntries(peerDependencies);
  }

  return MemoryFile.from(JSON.stringify(packageJson, undefined, 2) + "\n");
}

/**
 * The direct `dependencies` for the generated package.json — every declared
 * requirement, including `@types/*`. A `@types/*` dep can leak into the shipped
 * `.d.ts` (a node type in an exported signature emits `/// <reference
 * types="node" />`), making it part of the package's public type surface, so a
 * consumer type-checking against us needs it — DefinitelyTyped's own convention
 * (`@types/express` lists `@types/node` under `dependencies`). We don't yet scan
 * the emitted declarations to tell a leaked type dep from a compile-only one, so
 * the safe default is a plain `dependency` (harmless if unused: the consumer
 * dedupes it, and `@types/node` is near-ubiquitous). The version each states is
 * the declaration, not what fabr's joint resolution selected: a published
 * manifest says what the package *requires*, and the consumer resolves it.
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
 * The `peerDependencies` for the generated package.json — the declared
 * requirements of `provided_deps`. Like `dependencies`, the version stated is the
 * declaration (what the package requires of its host), not what resolution pinned;
 * unlike `dependencies` there is no `@types/*` split — a peer is a runtime peer.
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

/** The dependency-manifest fields whose entries can name a release co-member. */
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/* The manifest fields whose entries the consumer's install actually resolves —
 * where an unresolvable version is fatal. devDependencies deliberately excluded
 * (never installed from a published package). */
const INSTALLED_DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];

/**
 * Rewrite the built manifest for publication: assign the coordinate's name/version,
 * and rewrite any dependency that names a release co-member to that member's
 * assigned version. Returns a fresh object (never mutates the input).
 */
export function rewriteManifest(
  manifest: Record<string, unknown>,
  coordinate: NpmPublishIdentity,
  memberVersions: ReadonlyMap<string, string>
): Record<string, unknown> {
  /* The assigned identity leads (a versionless built manifest has no `version`
   * to overwrite in place — appending it last would read oddly). */
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
      /* A peerDependency pins exact; the rest take a caret range (see
       * {@link rewriteCoMemberField}). */
      result[field] = rewriteCoMemberField(deps, memberVersions, field === "peerDependencies");
    }
  }
  return result;
}

/**
 * Rewrite one dependency block's co-member entries to the members' assigned
 * versions. A `peerDependencies` entry pins **exact**: a peer is singleton-by-
 * identity (a `provided_deps` peer), so the consumer must supply the EXACT
 * co-member instance the package was built against, not merely a semver-compatible
 * one — a range can't express "the same loaded module". Every other field takes a
 * caret range. (A stable inter-package ABI might later widen the others too; the
 * peer stays exact regardless, since identity-compat is strictly stronger than
 * API-compat.)
 */
function rewriteCoMemberField(
  deps: Record<string, unknown>,
  memberVersions: ReadonlyMap<string, string>,
  exact: boolean
): Record<string, unknown> {
  /* Entries fabr doesn't rewrite are passed through as published, whatever they
   * are — this rewrites a manifest, it doesn't validate one. */
  const rewritten: Record<string, unknown> = { ...deps };
  for (const dep of Object.keys(rewritten)) {
    const memberVersion = memberVersions.get(dep);
    if (memberVersion !== undefined) {
      rewritten[dep] = exact ? memberVersion : `^${memberVersion}`;
    }
  }
  return rewritten;
}

/** The release members this manifest depends on (for deps-first upload ordering). */
export function memberDependencies(manifest: Record<string, unknown>, memberNames: ReadonlySet<string>): string[] {
  const names = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    for (const dep of dependencyBlock(manifest[field]).keys()) {
      if (memberNames.has(dep)) {
        names.add(dep);
      }
    }
  }
  return [...names];
}

/**
 * The install-relevant dependencies of a rewritten manifest that remain
 * unresolvable — a `*` constraint after co-member rewriting. A built-but-versionless
 * dep declares `*` (its version exists only at publish); if the sync doesn't
 * publish it (or publishes it at several versions, so no single rewrite exists),
 * the `*` survives to here — and a published package with an unconstrained
 * dependency is broken for every consumer, so the caller must reject it.
 */
export function unresolvableDependencies(manifest: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const field of INSTALLED_DEPENDENCY_FIELDS) {
    for (const [dep, constraint] of dependencyBlock(manifest[field])) {
      if (constraint === "*") {
        names.push(dep);
      }
    }
  }
  return names;
}
