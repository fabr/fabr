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

import * as fs from "fs";
import * as path from "path";

import { DeclKind, declName, declPosn, IBuildFileContents, IPluginDecl, ITargetDecl, syntheticValue } from "./AST";
import type { BuildModel } from "./BuildModel";
import type { ExecutionContext } from "./ExecutionContext";
import { IPrefixMatch } from "./Namespace";
import { BUILD_OPERATION, Constraints } from "./Constraints";
import { FileSet, IFile } from "../core/FileSet";
import { MemoryFile } from "../core/MemoryFS";
import { RunnableFileSet } from "../core/RunnableFileSet";
import { IProvenanceStep, registerProvenanceDescriber, registerProvenanceRenderer } from "../core/Provenance";
import { Diagnostic, ISourcePosition, Log } from "../support/Log";
import { CORE_PACKAGE } from "../core/Constants";
import { FabrError, toError } from "../core/Errors";
import * as Module from "module";
import { pathToFileURL } from "url";
import { parseConstraint, parseVersion, SEMVER } from "../resolver/Semver";
import { parseJson, toJsonObject } from "../support/Json";
import { globMatcher } from "../support/Glob";
import { Name } from "../core/Name";
import type { LoadImplementation } from "./ModelBuilder";
import { Computable, ComputableSource } from "../core/Computable";

/** The provenance kind of an {@link IFabrHomeOrigin}. */
export const FABR_HOME_PROVENANCE = "fabr-home";

/** The provenance step of a package read from fabr's installation: where it is installed. */
export interface IFabrHomeOrigin extends IProvenanceStep {
  kind: typeof FABR_HOME_PROVENANCE;
  directory: string;
}

registerProvenanceRenderer<IFabrHomeOrigin>(FABR_HOME_PROVENANCE, step => [{ message: `installed with fabr, at ${step.directory}` }]);
registerProvenanceDescriber<IFabrHomeOrigin>(FABR_HOME_PROVENANCE, step => step.directory);

/** @return the directory the package `files` is installed at, where it was read from fabr's
 *  installation, otherwise undefined. Its files are copies in the blob pool; this is where
 *  the installed package itself lies, for a caller using it in place (a plugin's code). */
export function installedDirectoryOf(files: FileSet): string | undefined {
  for (let step = files.origin; step !== undefined; step = step.parent) {
    if (step.kind === FABR_HOME_PROVENANCE) {
      return (step as IFabrHomeOrigin).directory;
    }
  }
  return undefined;
}

/**
 * What a plugin package's main module may export: `activate`, run once when
 * the plugin's code is first loaded, before its first rule or repository
 * implementation. The plugin contract is documented in
 * docs/src/content/docs/developer/plugins.md.
 */
interface IFabrPluginModule {
  activate?: () => void;
}

/** A package's manifest. */
export const MANIFEST = "package.json";

/** The `package.json` field that marks a package as a fabr plugin, listing its `.fabr` files. */
const PLUGIN_MANIFEST_FIELD = "@fabr-build/plugin";

/** A plugin's `.fabr` files, as paths within its package. */
export interface PluginLibs {
  /** The files every project using the plugin reads. */
  libs: string[];
  /** The files a project reads only where it includes them, `include <package>:<path>;`. */
  optionalLibs: string[];
}

/** Read the `@fabr-build/plugin` field of a `package.json`: its `.fabr` files, as paths within the package. */
export function toPluginLibs(json: unknown): PluginLibs {
  const field = toJsonObject(json);
  const listOf = (key: string): string[] => {
    const value = field[key];
    const list = typeof value === "string" ? [value] : (value ?? []);
    if (!Array.isArray(list) || !list.every((lib): lib is string => typeof lib === "string")) {
      throw new FabrError(`"${PLUGIN_MANIFEST_FIELD}".${key} is not a path or a list of them`);
    }
    return list;
  };
  return { libs: listOf("libs"), optionalLibs: listOf("optional_libs") };
}

/**
 * @return the realpath of the entry of `pkg` that code in directory `from`
 * would load, so every name of one installed copy (a workspace symlink, a
 * hoisted package) reads alike. Undefined if `from` resolves none.
 */
export function resolvePackageFrom(pkg: string, from: string): string | undefined {
  try {
    return fs.realpathSync(require.resolve(pkg, { paths: [from] }));
  } catch {
    return undefined;
  }
}

/**
 * Make a module resolve hook answering every request for core, `require` or
 * `import`, with the file `hostCore`, and passing every other request on.
 */
export function hostCoreResolver(hostCore: string): Module.ResolveHook {
  const url = pathToFileURL(hostCore).href;
  return (specifier, context, nextResolve) =>
    specifier === CORE_PACKAGE ? { url, format: "commonjs", shortCircuit: true } : nextResolve(specifier, context);
}

/** True once {@link bindHostCore} has registered its hook. */
let hostCoreBound = false;

/** Make every `require` or `import` of core in this process load the host's
 *  copy (see {@link hostCoreResolver}), whatever copy a plugin's install
 *  holds. Registers the hook once; later calls do nothing. */
function bindHostCore(): void {
  const hostCore = resolvePackageFrom(CORE_PACKAGE, __dirname);
  if (hostCoreBound || hostCore === undefined) {
    return;
  }
  hostCoreBound = true;
  Module.registerHooks({ resolve: hostCoreResolver(hostCore) });
}

/** @return the path of the nearest `package.json` at or above `dir` that `matches`, or undefined where there is none. */
function nearestManifestFile(dir: string, matches: (manifest: Record<string, unknown>) => boolean = () => true): string | undefined {
  for (let at = dir; ; at = path.dirname(at)) {
    const file = path.join(at, "package.json");
    if (fs.existsSync(file) && matches(readManifest(file))) {
      return file;
    }
    if (path.dirname(at) === at) {
      return undefined;
    }
  }
}

/** Read the `package.json` `file` as a JSON object. */
function readManifest(file: string): Record<string, unknown> {
  return parseJson(fs.readFileSync(file), file, toJsonObject);
}

/**
 * @return the error for a plugin whose declared range for core (`range`, its
 * `peerDependencies`) does not include the host's `version`, or undefined
 * where it does, or either is unstated or unreadable.
 */
export function coreVersionError(name: string, range?: string, version?: string): Error | undefined {
  if (range === undefined || version === undefined) {
    return undefined;
  }
  try {
    if (SEMVER.satisfies(parseVersion(version), parseConstraint(range))) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return new FabrError(`Plugin '${name}' requires ${CORE_PACKAGE} ${range}, but this fabr's is ${version}`).withHelp(
    "install a version of the plugin made for this fabr"
  );
}

/** Throw {@link coreVersionError}'s error for the plugin `name`, whose `package.json` reads `plugin`, against the host core's version. */
function checkCoreVersion(name: string, plugin: Record<string, unknown>): void {
  const hostFile = nearestManifestFile(__dirname, manifest => manifest.name === CORE_PACKAGE);
  const host = hostFile === undefined ? undefined : readManifest(hostFile);
  const peers = plugin.peerDependencies;
  const range = typeof peers === "object" && peers !== null ? (peers as Record<string, unknown>)[CORE_PACKAGE] : undefined;
  const err = coreVersionError(
    name,
    typeof range === "string" ? range : undefined,
    typeof host?.version === "string" ? host.version : undefined
  );
  if (err !== undefined) {
    throw err;
  }
}

/**
 * Read the plugin package `decl` uses, whose `package.json` is `manifest`,
 * running none of its code. Throws where the package is not marked a plugin,
 * has no name, declares a range for core excluding the host's version, or
 * lists a `.fabr` file that is not there.
 */
function packagedPlugin(decl: IPluginDecl, manifest: string): PluginPackage {
  const json = readManifest(manifest);
  if (json[PLUGIN_MANIFEST_FIELD] === undefined) {
    throw new FabrError(
      `Package '${decl.name.toString()}' is not a fabr plugin: its package.json has no "${PLUGIN_MANIFEST_FIELD}"`
    ).withHelp("a plugin built in the project is named by its fabr_plugin target");
  }
  if (typeof json.name !== "string") {
    throw new FabrError(`${manifest}: a plugin's package.json names it`);
  }
  checkCoreVersion(decl.name.toString(), json);
  let listed: PluginLibs;
  try {
    listed = toPluginLibs(json[PLUGIN_MANIFEST_FIELD]);
  } catch (err) {
    throw new FabrError(`${manifest}: ${toError(err).message}`);
  }
  const directory = path.dirname(manifest);
  const missing = [...listed.libs, ...listed.optionalLibs].find(lib => !fs.existsSync(path.join(directory, lib)));
  if (missing !== undefined) {
    throw new FabrError(`${manifest}: "${PLUGIN_MANIFEST_FIELD}" lists ${path.join(directory, missing)}, which is not there`);
  }
  return {
    name: json.name,
    files: listed.libs.map(lib => path.join(directory, lib)),
    optionalLibs: listed.optionalLibs.map(lib => ({ name: path.posix.normalize(lib), file: path.join(directory, lib) })),
    code: () => Computable.resolve(manifest),
  };
}

/** @return the path of the `package.json` of fabr's own core. */
function coreManifestFile(): string {
  const file = nearestManifestFile(__dirname, manifest => manifest.name === CORE_PACKAGE);
  if (file === undefined) {
    throw new FabrError(`Internal error: no package.json of ${CORE_PACKAGE} above ${__dirname}`);
  }
  return file;
}

/**
 * Make the loader of the implementations `rule` and `repository` declarations
 * name, for a project using `plugins`: by each plugin's package's own name,
 * how to get its `package.json` (built first, for one built in the project).
 * An implementation `pkg:entry` is the default export of `pkg/entry`, required
 * from within `pkg` so its own `exports` resolve it; `pkg` is core (the host's
 * own) or one of `plugins`. Before a plugin's first implementation is loaded,
 * its main module's `activate` is run. Rejects where `pkg` is neither, or the
 * module has no default export.
 */
export function implementationLoader(plugins: ReadonlyMap<string, () => Computable<string>>): LoadImplementation {
  /* The `package.json` files of the plugins whose code has been loaded. */
  const started = new Set<string>();
  /** Run the startup hook of the plugin whose `package.json` is `file`, once: its main module's `activate`. */
  const start = (file: string): void => {
    if (started.has(file)) {
      return;
    }
    started.add(file);
    const json = readManifest(file);
    const exportsMain = typeof json.exports === "object" && json.exports !== null && "." in json.exports;
    if (json.main !== undefined || exportsMain) {
      const plugin = Module.createRequire(file)(String(json.name)) as IFabrPluginModule;
      plugin.activate?.();
    }
  };
  return implementation => {
    const written = implementation.value.toString();
    const colon = written.indexOf(":");
    const name = written.substring(0, colon);
    const manifest = name === CORE_PACKAGE ? Computable.resolve(undefined).then(coreManifestFile) : plugins.get(name)?.();
    if (manifest === undefined) {
      return Computable.reject(new FabrError(`'${name}' is neither ${CORE_PACKAGE} nor a plugin this project uses`));
    }
    return manifest.then(file => {
      bindHostCore();
      if (name !== CORE_PACKAGE) {
        start(file);
      }
      const module = Module.createRequire(file)(`${String(readManifest(file).name)}/${written.substring(colon + 1)}`) as {
        default?: unknown;
      };
      if (module.default === undefined) {
        throw new FabrError(`'${written}' has no default export`);
      }
      return module.default;
    });
  };
}

/** The target type of a plugin built in the project. */
export const FABR_PLUGIN = "fabr_plugin";

/** A plugin package a `plugin <name>;` declaration resolved to. */
export interface PluginPackage {
  /** The package's own name: a `fabr_plugin` target's, or what its `package.json` says. */
  name: string;
  /** The `.fabr` files it adds. */
  files: string[];
  /** The `.fabr` files it adds where a project includes them. */
  optionalLibs: OptionalLib[];
  /** Get the `package.json` of its code, which `model` builds where it is a `fabr_plugin` target. */
  code: (model: BuildModel) => Computable<string>;
}

/** One of a plugin's `optional_libs`. */
export interface OptionalLib {
  /** Its path within the plugin's package, which an include names it by. */
  name: string;
  /** The file to read: absolute for an installed plugin, relative to the project's root for one built in it. */
  file: string;
}

/**
 * @return the files of `plugin`'s optional libs that `pattern`, a path or
 * pattern within its package, names, in canonical order.
 */
export function matchOptionalLibs(plugin: PluginPackage, pattern: Name): string[] {
  const plain = pattern.getSimpleName();
  const matches = plain !== undefined ? (name: string) => name === path.posix.normalize(plain) : globMatcher(pattern.toGlobString());
  return plugin.optionalLibs
    .filter(lib => matches(lib.name))
    .map(lib => lib.file)
    .sort();
}

/** What one `plugin` declaration resolved to, and the number of errors reported resolving it. */
export interface PluginResolution {
  decl: IPluginDecl;
  resolved: PluginPackage | Error;
  reported: number;
}

/** An ordinary declaration in a plugin's `.fabr` files, which declare only defaults. */
const DIAG_PLUGIN_ORDINARY = Diagnostic.Error<{ loc: ISourcePosition }>(
  "A plugin's .fabr files declare only defaults: write this as a `default` declaration"
);

/** A `fabr_plugin` target in a plugin's `.fabr` files. */
const DIAG_PLUGIN_DECLARES_PLUGIN = Diagnostic.Error<{ loc: ISourcePosition }>(
  "A plugin's .fabr files cannot declare a fabr_plugin: only a project declares a plugin it builds"
);

/**
 * Check a plugin's `.fabr` file `file`, reporting through `log` what it may not
 * declare: an ordinary public property or target (only `default` and private
 * declarations are allowed), and any `fabr_plugin`.
 */
export function checkPluginFile(file: IBuildFileContents, log: Log): void {
  [...file.properties, ...file.targets]
    .filter(decl => !decl.private)
    .forEach(decl => log.log(DIAG_PLUGIN_ORDINARY, { loc: declPosn(decl) }));
  [...file.defaults, ...file.targets.filter(target => target.private)]
    .filter(decl => decl.kind === DeclKind.Target && decl.type === FABR_PLUGIN)
    .forEach(decl => log.log(DIAG_PLUGIN_DECLARES_PLUGIN, { loc: declPosn(decl) }));
}

/**
 * Resolve `decl`, whose name's root `model` declares as `match`, to the plugin
 * package it names. A `fabr_plugin` target adds its `libs` and `optional_libs`
 * (resolved by `libsOf`), its code built when first used. Any other reference
 * is made now, so its `package.json` can be read. A plugin is made under `run`
 * for `host`, within `execution`. A failure to make the package is returned
 * as the resolution's `resolved`; a package that is not a usable plugin
 * (`packagedPlugin`'s errors) rejects.
 */
export function resolvePlugin(
  model: BuildModel,
  decl: IPluginDecl,
  match: IPrefixMatch,
  {
    execution,
    host,
    libsOf,
  }: {
    execution: ExecutionContext;
    host: Constraints;
    libsOf: (target: ITargetDecl, property: "libs" | "optional_libs") => ComputableSource<{ files: string[]; errors: number }>;
  }
): Computable<PluginResolution> {
  const target = match.decl;
  if (target.kind === DeclKind.Target && target.type === FABR_PLUGIN && match.rest.isEmpty()) {
    const directory = path.dirname(target.source.file);
    return Computable.forAll([libsOf(target, "libs"), libsOf(target, "optional_libs")], (libs, optional) => ({
      decl,
      resolved: {
        name: declName(target),
        files: libs.files,
        optionalLibs: optional.files.map(file => ({ name: path.relative(directory, file).split(path.sep).join("/"), file })),
        code: (built: BuildModel) => pluginManifest(built, decl, execution, host),
      },
      reported: libs.errors + optional.errors,
    }));
  }
  return pluginManifest(model, decl, execution, host).then(
    (manifest): PluginResolution => ({ decl, resolved: packagedPlugin(decl, manifest), reported: 0 }),
    (err): PluginResolution => ({ decl, resolved: toError(err), reported: 0 })
  );
}

/**
 * Make `decl`'s plugin under `run` for `host`, in `model`, and @return the path
 * of its code's `package.json`: a program is written to the tree pool, and an
 * installed package is used where it is installed.
 */
function pluginManifest(model: BuildModel, decl: IPluginDecl, execution: ExecutionContext, host: Constraints): Computable<string> {
  const reference = syntheticValue(decl.name, decl.source, decl.offset, decl.endOffset ?? decl.offset);
  return model
    .getConfig(host.with(Constraints.of({ [BUILD_OPERATION]: "run" })), execution)
    .materialize(reference)
    .then(sources => {
      if (sources.length !== 1) {
        throw new FabrError(`Plugin '${decl.name.toString()}' names ${sources.length === 0 ? "nothing" : "more than one package"}`);
      }
      const [source] = sources;
      if (source instanceof RunnableFileSet) {
        return execution.buildCache.ensureTree(source).then(tree => path.join(tree, source.root, "package.json"));
      }
      const directory =
        source instanceof FileSet && source.getFile("package.json") !== undefined ? installedDirectoryOf(source) : undefined;
      if (directory === undefined) {
        throw new FabrError(`Plugin '${decl.name.toString()}' names no package`);
      }
      return path.join(directory, "package.json");
    });
}

/** @return the `.fabr` files a `fabr_plugin` lists, by their names in its package: `libs` and `optionalLibs`, each in canonical order. */
export function pluginLibsOf(libs: FileSet[], optionalLibs: FileSet[]): PluginLibs {
  const namesOf = (sets: FileSet[]): string[] => [...FileSet.unionAll(...sets)].map(([name]) => name).sort();
  return { libs: namesOf(libs), optionalLibs: namesOf(optionalLibs) };
}

/**
 * Make the plugin `name`'s `package.json` from its base package's, `base`:
 * named `name`, listing `libs` and `optionalLibs` as the plugin's `.fabr` files.
 */
export function pluginPackageJson(base: IFile | undefined, name: string, { libs, optionalLibs }: PluginLibs): Computable<IFile> {
  if (base === undefined) {
    throw new FabrError(`the package fabr_plugin '${name}' builds has no ${MANIFEST}`);
  }
  return base.readString().then(text => {
    const manifest = {
      ...parseJson(text, MANIFEST, toJsonObject),
      name,
      [PLUGIN_MANIFEST_FIELD]: { libs, ...(optionalLibs.length > 0 ? { optional_libs: optionalLibs } : {}) },
    };
    return MemoryFile.from(JSON.stringify(manifest, undefined, 2) + "\n");
  });
}
