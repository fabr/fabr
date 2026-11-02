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
 * What an editor is told of a JavaScript target, as the target's rules
 * `describe` it: each compilation unit — its config over the real directory
 * the compile's sources come from, and its PnP table, the compile's own, with
 * its packages put in the tree pool, where the table locates them — and a
 * package's manifest, made from its declared entry points without building it.
 *
 * A unit's description is a tree of {@link UNIT_FILE}, {@link UNIT_CONFIG_FILE},
 * the table (`.pnp.data.json`) and, under {@link GENERATED_DIR}, the sources
 * no project file holds (a stylesheet's declaration shim). Its locations are
 * relative to the unit's root as the compile's are to its working directory:
 * a package at `.fabr-tree/<tree>/` is that tree of the cache's pool.
 */

import {
  ActionContext,
  BuildAction,
  BuildResult,
  Computable,
  DescribedPackage,
  DESCRIPTION_EXTENDS,
  DESCRIPTION_FILE,
  FileSet,
  IBuildActionDefinition,
  mapComputable,
  MemoryFile,
  PackageFileSet,
  RuleResult,
  TREE_MOUNT,
} from "@fabr-build/core";
import { PNP_DATA_FILE } from "@fabr-build/js-tools";
import { posix } from "path";
import { CJS_JS_EXTENSION, CJS_TYPE_EXTENSION, dualFormatOutputs, ESM_JS_EXTENSION, ESM_TYPE_EXTENSION, JSTarget } from "./JSPackage";
import { pnpManifestOf } from "./PnPManifest";
import type { ICompileSetup } from "./rules/BuildJSCompile";

/** The unit's summary in its description. */
export const UNIT_FILE = "unit.json";

/** The unit's config in its description. */
export const UNIT_CONFIG_FILE = "tsconfig.json";

/** Where the generated sources sit in a unit's description. */
export const GENERATED_DIR = "generated";

/** The `dataKind` of a JavaScript target's payload. */
export const TYPESCRIPT_DATA_KIND = "typescript";

/** Where a unit's description sits in its target's description, by the unit's name. */
export const UNITS_DIR = "units";

/** Where a package's manifest sits in its description. */
export const MANIFEST_FILE = "package.json";

/** The module an editor's TypeScript server loads the units through, resolved
 * from the fabr installation describing them. */
export const TSSERVER_PLUGIN = "@fabr-build/js-tools/tsserverPlugin/TsserverPlugin";

/** What {@link UNIT_FILE} holds. */
export interface IUnitSummary {
  /** The real directory holding every directory the compile's sources come
   * from, where its config is shown, `./<path>/` from the project root; absent
   * where a source is named otherwise, in which case the unit has no config
   * and is read through what it builds. */
  root?: string;
  /** The package the unit builds. */
  package?: string;
  /** The sources no project file holds, each by its path from {@link root}. */
  generated: string[];
  /** The compile's import rewrite rules (its `rewrite_imports` and the
   * stylesheet rules), as the tsc driver reads them. */
  rewrites: Array<{ pattern: string; replacement: string }>;
  /** The files the package ships that no step compiles, each by its path
   * from {@link root}: an import of one resolves. */
  resources: string[];
}

/** The `typescript` payload: the target's units, and its manifest where it is a package. */
export interface ITypeScriptPayload {
  /** Each unit's description directory within the target's, by unit name. */
  units: Record<string, string>;
  /** The package's manifest within the description. */
  manifest?: string;
  /** The tsserver plugin implementation, as a module specifier. */
  plugin: string;
}

/**
 * Lay out `units`, each a unit's description by its name, as a target's
 * description holds them: each under {@link UNITS_DIR}, and a unit whose
 * compile described nothing (a package of declarations or resources alone)
 * left out.
 *
 * @return the payload's `units`, and the files laid out.
 */
export function layOutUnits(units: ReadonlyMap<string, FileSet>): { units: Record<string, string>; files: FileSet } {
  const described = [...units].filter(([, unit]) => unit.getFile(UNIT_FILE) !== undefined);
  return {
    units: Object.fromEntries(described.map(([name]) => [name, `${UNITS_DIR}/${name}`])),
    files: FileSet.layout(Object.fromEntries(described.map(([name, unit]) => [`${UNITS_DIR}/${name}`, unit]))),
  };
}

/**
 * Make the description of the unit `setup` compiles: where its sources come
 * from, read off their source paths, its editor config, and its table, made
 * by a step that puts the unit's fetched packages in the tree pool and
 * locates each package described in place of its build (a
 * `DescribedPackage`) at its own unit's root.
 */
export function describeUnit(setup: ICompileSetup): RuleResult {
  const { root, rootDirs, generated } = sourceRoot(setup.srcs);
  const place = root === undefined ? (name: string) => name : placement([setup.srcs, setup.resources], root, rootDirs);
  const summary: IUnitSummary = {
    ...(root === undefined ? {} : { root }),
    ...(setup.packageName === undefined ? {} : { package: setup.packageName }),
    generated: generated.map(place).sort(),
    rewrites: setup.rewrites ?? [],
    resources: [...setup.resources].map(([name]) => place(name)).sort(),
  };
  const files = FileSet.layout({
    [UNIT_FILE]: MemoryFile.from(JSON.stringify(summary, null, 2) + "\n"),
    ...(root === undefined ? {} : { [UNIT_CONFIG_FILE]: MemoryFile.from(JSON.stringify(editorConfig(setup, rootDirs, place), null, 2) + "\n") }),
    ...(generated.length === 0
      ? {}
      : { [GENERATED_DIR]: new FileSet(new Map([...setup.srcs].filter(([name]) => generated.includes(name)).map(([name, file]) => [place(name), file]))) }),
  });
  return new BuildAction(
    DESCRIBE_UNIT_ACTION,
    { deps: setup.deps.filter(dep => dep instanceof PackageFileSet), files },
    { root: root ?? "", self: setup.packageName ?? "" },
    undefined,
    "describe"
  );
}

/**
 * @return where `srcs` come from: the real directories they are named from
 * (`rootDirs`), each project file at its own name beneath one of them, and the
 * directory holding them all (`root`) — none where a project file is not
 * named so — with the names of those no project file holds.
 */
export function sourceRoot(srcs: FileSet): { root?: string; rootDirs: string[]; generated: string[] } {
  const roots = new Set<string>();
  const generated: string[] = [];
  let unnamed = false;
  for (const [name] of srcs) {
    const sourcePath = srcs.sourcePathOf(name);
    if (sourcePath === undefined || !sourcePath.startsWith("./")) {
      generated.push(name);
    } else if (sourcePath === `./${name}`) {
      roots.add("./");
    } else if (sourcePath.endsWith(`/${name}`)) {
      roots.add(sourcePath.slice(0, sourcePath.length - name.length));
    } else {
      unnamed = true;
    }
  }
  const rootDirs = unnamed ? [] : [...roots].sort();
  return { ...(rootDirs.length === 0 ? {} : { root: commonDirectory(rootDirs) }), rootDirs, generated: generated.sort() };
}

/**
 * @return where each file of `sets` is shown, as a path from `root`: a project
 * file at its own path; one a step produced from a project file beside that
 * file; any other beneath the directory of `rootDirs` its directory's sources
 * come from, the nearest directory above it that has any, else beneath the
 * first.
 */
export function placement(sets: readonly FileSet[], root: string, rootDirs: readonly string[]): (name: string) => string {
  const fromRoot = (projectPath: string): string => projectPath.slice(root.length);
  const dirOf = new Map<string, string>();
  for (const set of sets) {
    for (const [name] of set) {
      const sourcePath = set.sourcePathOf(name);
      if (sourcePath !== undefined && sourcePath.startsWith(root) && sourcePath.endsWith(`/${name}`)) {
        dirOf.set(posix.dirname(name), sourcePath.slice(0, sourcePath.length - name.length));
      }
    }
  }
  return name => {
    const holder = sets.find(set => set.getFile(name) !== undefined);
    const sourcePath = holder?.sourcePathOf(name);
    if (sourcePath !== undefined && sourcePath.startsWith(root)) {
      return fromRoot(sourcePath);
    }
    const from = holder?.derivedFromOf(name);
    if (from !== undefined && from.startsWith(root)) {
      return posix.join(posix.dirname(fromRoot(from)), posix.basename(name));
    }
    let dir = posix.dirname(name);
    while (!dirOf.has(dir) && dir !== ".") {
      dir = posix.dirname(dir);
    }
    return posix.join(fromRoot(dirOf.get(dir) ?? rootDirs[0]), name);
  };
}

/** @return the deepest directory holding every one of `dirs`, each written `./<path>/`. */
function commonDirectory(dirs: readonly string[]): string {
  const parts = dirs.map(dir => dir.split("/").filter(part => part !== "" && part !== "."));
  const common: string[] = [];
  for (let index = 0; parts.every(dir => index < dir.length && dir[index] === parts[0][index]); index++) {
    common.push(parts[0][index]);
  }
  return common.length === 0 ? "./" : `./${common.join("/")}/`;
}

/**
 * @return the config the editor's TypeScript server is shown for the unit, at
 * its root: the compile's options, the files the compile compiles where
 * `place` shows them, the directories its sources are named from (`rootDirs`)
 * as one tree, and — where the unit is a package — a composite project whose
 * outputs lie where its package's manifest names them.
 */
export function editorConfig(setup: ICompileSetup, rootDirs: readonly string[], place: (name: string) => string): Record<string, unknown> {
  /* Each directory as a path from the unit's root. */
  const root = commonDirectory(rootDirs);
  const dirs = rootDirs.map(dir => `./${dir.slice(root.length)}`);
  const files = [...setup.srcs]
    .map(([name]) => name)
    .filter(name => COMPILED.test(name))
    .map(place)
    .sort();
  const compiled = setup.tsconfig.compilerOptions as Record<string, unknown>;
  /* What lays out a staged compile's emit, which the editor neither stages nor emits. */
  const dropped = new Set(["outDir", "rootDir", "sourceMap", "inlineSources", "pretty", "paths"]);
  const options = Object.fromEntries(Object.entries(compiled).filter(([key]) => !dropped.has(key)));
  return {
    compilerOptions: {
      ...options,
      rootDir: ".",
      /* The editor's compiler is VS Code's own, of TypeScript 6 or later, which
       * pairs `bundler` with either module format. */
      moduleResolution: "bundler",
      typeRoots: [],
      ...(dirs.length > 1 ? { rootDirs: dirs } : {}),
      ...(setup.packageName === undefined
        ? {}
        : {
            composite: true,
            outDir: ".",
            paths: selfPaths(setup.packageName, dirs, files),
          }),
    },
    files,
    /* Stated, as an `outDir` holding the sources would otherwise exclude them. */
    exclude: [],
    typeAcquisition: { enable: false },
  };
}

/**
 * @return the `paths` naming the package `name`'s own files, `files` placed in
 * `dirs`, as the package imports itself: a directory beneath the root by a
 * wildcard, and the root by each of its entries, a subdirectory by a wildcard
 * and a file by its name — a wildcard at the root would also name the
 * `node_modules` the plugin reaches packages through.
 */
function selfPaths(name: string, dirs: readonly string[], files: readonly string[]): Record<string, string[]> {
  const below = dirs.filter(dir => dir !== "./");
  const paths = new Map<string, string[]>([[name, dirs.map(dir => `${dir}index`)]]);
  if (below.length > 0) {
    paths.set(`${name}/*`, below.map(dir => `${dir}*`));
  }
  if (dirs.includes("./")) {
    const atRoot = files.filter(file => !below.some(dir => file.startsWith(dir.slice("./".length))));
    for (const entry of new Set(atRoot.map(file => file.split("/")[0]))) {
      const isDirectory = atRoot.some(file => file.startsWith(`${entry}/`));
      const stem = isDirectory ? `${entry}/*` : entry.replace(SOURCE_EXTENSION, "");
      if (entry !== "node_modules" && stem !== "index") {
        paths.set(`${name}/${stem}`, dirs.map(dir => `${dir}${stem}`));
      }
    }
  }
  return Object.fromEntries(paths);
}

/** A source's extension, which an import of it leaves out. */
const SOURCE_EXTENSION = /(?:\.d)?\.[cm]?[jt]sx?$/;

/** The sources a compile compiles, as its config's `include` names them; its others are no program's files. */
const COMPILED = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/;

/** Where a unit's table locates a tree of the cache's pool: `./.fabr-tree/<tree>/`, however a step reaches the pool. */
const POOL_LOCATION = "./.fabr-tree/";

/** Write a table's location of a pool tree, as a step's working directory reaches it, as a unit's table does. */
function inPool(location: string): string {
  return location.startsWith(`${TREE_MOUNT}/`) ? POOL_LOCATION + location.substring(TREE_MOUNT.length + 1) : location;
}

/** The step that puts a unit's fetched packages in the tree pool and makes its table. */
const DESCRIBE_UNIT_ACTION: IBuildActionDefinition = {
  id: "js:describe-unit",
  version: 4,
  run: (action: BuildAction, ctx: ActionContext): Computable<BuildResult> => {
    const deps = action.inputs.deps as FileSet[];
    const files = action.inputs.files as FileSet;
    const root = action.config.root as string;
    const self = action.config.self as string;
    const manifest = pnpManifestOf(deps, self === "" ? undefined : { name: self, location: "./" });
    const described = manifest.packages.filter((pkg): pkg is DescribedPackage => pkg instanceof DescribedPackage);
    const fetched = manifest.packages.filter(pkg => !(pkg instanceof DescribedPackage));
    return mapComputable(described, pkg => unitRootOf(pkg)).then(roots => {
      /* A described package with no unit of its own is put in the pool as its installed view. */
      const pooled = described.filter((_pkg, index) => roots[index] === undefined);
      return mapComputable(pooled, pkg => installedViewOf(pkg)).then(views =>
        mapComputable([...fetched, ...views], tree => ctx.ensureTree(tree)).then(() => {
          /* A mount and a row's location name one place in two spellings (`x`, `./x/`). */
          const place = (location: string): string => posix.normalize(location).replace(/\/$/, "");
          const located = new Map([
            ...described.flatMap((pkg, index): Array<[string, string]> => {
              const unit = roots[index];
              return unit === undefined ? [] : [[place(manifest.mountOf(pkg)), relativeLocation(root, unit)]];
            }),
            ...pooled.map((pkg, index): [string, string] => [place(manifest.mountOf(pkg)), `${POOL_LOCATION}${views[index].toManifestHash()}/`]),
          ]);
          for (const [, rows] of manifest.state.packageRegistryData) {
            for (const [, info] of rows) {
              info.packageLocation = located.get(place(info.packageLocation)) ?? inPool(info.packageLocation);
            }
          }
          return { result: FileSet.unionAll(files, FileSet.layout({ [PNP_DATA_FILE]: manifest.toFile() })) };
        })
      );
    });
  },
};

/** @return the JSON document `file` of `description`, or undefined if it holds none. */
function jsonOf(description: FileSet, file: string): Computable<Record<string, unknown> | undefined> {
  return description.get(file).then(found => (found === undefined ? undefined : found.getBuffer().then(buffer => JSON.parse(buffer.toString("utf8")))));
}

/**
 * @return the unit of the package `description` describes: its directory in
 * the description and its summary, the summary naming the package as the
 * description's target is named (whatever name the package is installed
 * under) — or undefined if no unit does.
 */
function ownUnitOf(description: FileSet): Computable<{ dir: string; summary: IUnitSummary } | undefined> {
  return jsonOf(description, DESCRIPTION_FILE).then(found => {
    const target = found?.target as { displayName?: string; data?: Partial<ITypeScriptPayload> } | undefined;
    const dirs = Object.values(target?.data?.units ?? {});
    return Computable.forAll(dirs.map(dir => jsonOf(description, `${dir}/${UNIT_FILE}`)), (...found) => {
      const summaries = found as Array<IUnitSummary | undefined>;
      const index = summaries.findIndex(summary => summary !== undefined && summary.package === target?.displayName);
      return index < 0 ? undefined : { dir: dirs[index], summary: summaries[index]! };
    });
  });
}

/**
 * @return the root of the unit of the package `description` describes, the
 * project's `./<path>/` — or, where it has none, the root of the unit of the
 * package it is made from (whose description is held under
 * `DESCRIPTION_EXTENDS`) — or undefined if neither has one.
 */
function unitRootOf(description: FileSet): Computable<string | undefined> {
  const prefix = `${DESCRIPTION_EXTENDS}/`;
  const extended = new FileSet(new Map([...description].filter(([file]) => file.startsWith(prefix)).map(([file, contents]) => [file.slice(prefix.length), contents])));
  return ownUnitOf(description).then(own =>
    own?.summary.root !== undefined || extended.isEmpty() ? own?.summary.root : unitRootOf(extended)
  );
}

/**
 * @return the package `description` describes as an editor installs it where
 * no unit of the project builds it: what it ships as it is, the generated
 * sources of its build unit at their names, and its manifest with each entry
 * point naming the source it is compiled from — the package read from
 * source, as a local one is.
 */
function installedViewOf(description: FileSet): Computable<FileSet> {
  return ownUnitOf(description).then(own => {
    const prefix = own === undefined ? undefined : `${own.dir}/${GENERATED_DIR}/`;
    const generated = new Map(
      [...description].filter(([file]) => prefix !== undefined && file.startsWith(prefix)).map(([file, contents]) => [file.slice(prefix!.length), contents])
    );
    const shipped = [...description].filter(
      ([file]) => file !== DESCRIPTION_FILE && file !== MANIFEST_FILE && !file.startsWith(`${UNITS_DIR}/`) && !file.startsWith(`${DESCRIPTION_EXTENDS}/`)
    );
    return jsonOf(description, MANIFEST_FILE).then(manifest => {
      const view = new Map([...shipped, ...generated]);
      if (manifest !== undefined) {
        view.set(MANIFEST_FILE, MemoryFile.from(JSON.stringify(sourceManifest(manifest, [...generated.keys()]), null, 2) + "\n"));
      }
      return new FileSet(view);
    });
  });
}

/**
 * @return `manifest` with each entry point it names (`main`, `types`,
 * `exports`, …), an emitted module or declaration, naming instead the one of
 * `sources` it is emitted from, where there is one; a wildcard target
 * (`./*.d.ts`) names the sources it matches where they share one extension.
 */
export function sourceManifest(manifest: Record<string, unknown>, sources: readonly string[]): Record<string, unknown> {
  const byStem = new Map(sources.filter(source => COMPILED.test(source)).map(source => [source.replace(SOURCE_EXTENSION, ""), source]));
  const compiled = sources.filter(source => COMPILED.test(source));
  const entry = (value: unknown): unknown => {
    if (typeof value === "string" && value.split("*").length === 2) {
      const [head, tail] = value.split("*");
      const extension = SOURCE_EXTENSION.exec(tail)?.[0];
      if (extension === undefined || extension !== tail) {
        return value;
      }
      const prefix = head.startsWith("./") ? head.slice(2) : head;
      const extensions = new Set(compiled.filter(source => source.startsWith(prefix)).map(source => SOURCE_EXTENSION.exec(source)![0]));
      return extensions.size === 1 ? `${head}*${[...extensions][0]}` : value;
    }
    if (typeof value === "string") {
      const relative = value.startsWith("./");
      const source = byStem.get((relative ? value.slice(2) : value).replace(SOURCE_EXTENSION, ""));
      return source === undefined || !SOURCE_EXTENSION.test(value) ? value : relative ? `./${source}` : source;
    }
    if (Array.isArray(value)) {
      return value.map(entry);
    }
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, entry(inner)]));
    }
    return value;
  };
  return Object.fromEntries(
    Object.entries(manifest).map(([key, value]) => [key, ENTRY_POINT_FIELDS.has(key) ? entry(value) : value])
  );
}

/** The manifest fields naming a package's entry points. */
const ENTRY_POINT_FIELDS = new Set(["main", "module", "types", "typings", "exports", "typesVersions"]);

/** @return `to`, a project path (`./<path>/`), as a table location from the unit at `from`. */
function relativeLocation(from: string, to: string): string {
  const text = posix.relative(from || ".", to);
  return text === "" ? "./" : `./${text}/`;
}

/**
 * @return the names a compile of `sources` emits for `target`, as empty files:
 * each module its JavaScript and its declarations, beside its stem, and
 * anything else as it is — what the package's manifest is made from.
 */
export function conventionalEmit(sources: FileSet, target: JSTarget): FileSet {
  const emit = (js: string, dts: string): FileSet => {
    const emitted = new Map<string, MemoryFile>();
    for (const [name] of sources) {
      const module = /^(.*?)(\.d)?\.(m|c)?(ts|tsx|js|jsx)$/.exec(name);
      if (module === null || module[2] !== undefined) {
        emitted.set(name, MemoryFile.from(""));
      } else if (module[3] === "m") {
        emitted.set(`${module[1]}${ESM_JS_EXTENSION}`, MemoryFile.from(""));
        emitted.set(`${module[1]}${ESM_TYPE_EXTENSION}`, MemoryFile.from(""));
      } else if (module[3] === "c") {
        emitted.set(`${module[1]}${CJS_JS_EXTENSION}`, MemoryFile.from(""));
        emitted.set(`${module[1]}${CJS_TYPE_EXTENSION}`, MemoryFile.from(""));
      } else {
        emitted.set(`${module[1]}${js}`, MemoryFile.from(""));
        emitted.set(`${module[1]}${dts}`, MemoryFile.from(""));
      }
    }
    return new FileSet(emitted);
  };
  /* A dual package's two formats as its build lays them out together. */
  return target.module === "dual"
    ? FileSet.unionAll(...dualFormatOutputs(emit(".js", ".d.ts"), emit(ESM_JS_EXTENSION, ESM_TYPE_EXTENSION)))
    : emit(".js", ".d.ts");
}
