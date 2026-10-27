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
import { FileSet } from "../core/FileSet";
import { RunnableFileSet } from "../core/RunnableFileSet";
import { Diagnostic, ISourcePosition, Log } from "../support/Log";
import { CORE_PACKAGE } from "../Constants";
import { FabrError, toError } from "../core/Errors";
import * as Module from "module";
import { pathToFileURL } from "url";
import { parseConstraint, parseVersion, SEMVER } from "../resolver/Semver";
import { parseJson, toJsonObject } from "../support/Json";
import type { LoadImplementation } from "./ModelBuilder";
import { Computable, ComputableSource } from "../core/Computable";

/**
 * The shape a plugin package's main module may export: `activate`, run once
 * when the plugin's code is first loaded (before its first rule or repository
 * implementation is). It reaches the host's facilities by importing
 * `@fabr-build/core` directly, which loads the host's own core (see
 * {@link bindHostCore}). The full plugin contract is documented in
 * docs/src/content/docs/developer/plugins.md.
 */
interface IFabrPluginModule {
  activate?: () => void;
}

/** The `package.json` field that marks a package as a fabr plugin, listing its `.fabr` files. */
export const PLUGIN_MANIFEST_FIELD = "@fabr-build/plugin";

/** Read the `@fabr-build/plugin` field of a `package.json`: its `.fabr` files, as paths within the package. */
export function toPluginLibs(json: unknown): string[] {
  const field = toJsonObject(json);
  const libs = typeof field.libs === "string" ? [field.libs] : field.libs ?? [];
  if (!Array.isArray(libs) || !libs.every((lib): lib is string => typeof lib === "string")) {
    throw new FabrError(`"${PLUGIN_MANIFEST_FIELD}".libs is not a path or a list of them`);
  }
  return libs;
}

/**
 * @return the copy of `pkg` that code in directory `from` would load, as a
 * realpath — so the workspace symlinks of a devchain install, and the two names
 * of a hoisted package, all read as the one copy they are. Undefined if `from`
 * resolves none.
 */
export function resolvePackageFrom(pkg: string, from: string): string | undefined {
  try {
    return fs.realpathSync(require.resolve(pkg, { paths: [from] }));
  } catch {
    return undefined;
  }
}

/**
 * Make a module resolve hook answering every request for core with `hostCore`,
 * and passing every other on: so code loaded into fabr's process (a plugin, or
 * what it loads), whether it `require`s core or `import`s it, shares fabr's
 * core, whatever copy its own install holds.
 */
export function hostCoreResolver(hostCore: string): Module.ResolveHook {
  const url = pathToFileURL(hostCore).href;
  return (specifier, context, nextResolve) =>
    specifier === CORE_PACKAGE ? { url, format: "commonjs", shortCircuit: true } : nextResolve(specifier, context);
}

let hostCoreBound = false;

/** Make every `require` or `import` of core in this process load the host's
 *  copy (see {@link hostCoreResolver}). Done once, when the first plugin is activated. */
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

/** Fail unless the plugin whose `package.json` reads `plugin` declares a range for core that includes the host's version. */
function checkCoreVersion(name: string, plugin: Record<string, unknown>): void {
  const hostFile = nearestManifestFile(__dirname, manifest => manifest.name === CORE_PACKAGE);
  const host = hostFile === undefined ? undefined : readManifest(hostFile);
  const peers = plugin.peerDependencies;
  const range = typeof peers === "object" && peers !== null ? (peers as Record<string, unknown>)[CORE_PACKAGE] : undefined;
  const err = coreVersionError(name, typeof range === "string" ? range : undefined, typeof host?.version === "string" ? host.version : undefined);
  if (err !== undefined) {
    throw err;
  }
}

/**
 * Read the plugin package `decl` uses, whose `package.json` is `manifest`: a
 * package that marks itself a plugin and lists its `.fabr` files. Runs none
 * of its code. The plugin loads the host's core whatever copy its own install
 * holds ({@link bindHostCore}), so its declared range for core must include
 * the host's version.
 */
function packagedPlugin(decl: IPluginDecl, manifest: string): PluginPackage {
  const json = readManifest(manifest);
  if (json[PLUGIN_MANIFEST_FIELD] === undefined) {
    throw new FabrError(`Package '${decl.name.toString()}' is not a fabr plugin: its package.json has no "${PLUGIN_MANIFEST_FIELD}"`).withHelp(
      "a plugin built in the project is named by its fabr_plugin target"
    );
  }
  if (typeof json.name !== "string") {
    throw new FabrError(`${manifest}: a plugin's package.json names it`);
  }
  checkCoreVersion(decl.name.toString(), json);
  let libs: string[];
  try {
    libs = toPluginLibs(json[PLUGIN_MANIFEST_FIELD]).map(lib => path.join(path.dirname(manifest), lib));
  } catch (err) {
    throw new FabrError(`${manifest}: ${toError(err).message}`);
  }
  const missing = libs.find(lib => !fs.existsSync(lib));
  if (missing !== undefined) {
    throw new FabrError(`${manifest}: "${PLUGIN_MANIFEST_FIELD}".libs lists ${missing}, which is not there`);
  }
  return { name: json.name, files: libs, code: () => Computable.resolve(manifest) };
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
 * name, for a project using `plugins`: how to get the `package.json` of each
 * plugin (built, for one built in the project), by its package's own name, so a
 * name means the copy in use whatever the project calls it; core is the host's own. An
 * implementation `pkg:entry` is the default export of `pkg/entry`, required
 * from within `pkg` so that its own `exports` resolve it.
 */
export function implementationLoader(plugins: ReadonlyMap<string, () => Computable<string>>): LoadImplementation {
  /* The plugins whose code has been loaded, by `package.json`. */
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
      const module = Module.createRequire(file)(`${String(readManifest(file).name)}/${written.substring(colon + 1)}`) as { default?: unknown };
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
  /** Get the `package.json` of its code, which `model` builds where it is a `fabr_plugin` target. */
  code: (model: BuildModel) => Computable<string>;
}

/** What one `plugin` declaration resolved to, and the errors reported resolving it. */
export interface PluginResolution {
  decl: IPluginDecl;
  resolved: PluginPackage | Error;
  reported: number;
}

/** An ordinary declaration in a plugin's `.fabr` files, which declare only defaults. */
const DIAG_PLUGIN_ORDINARY = Diagnostic.Error<{ loc: ISourcePosition }>(
  "A plugin's .fabr files declare only defaults: write this as a `default` declaration"
);

/** A `fabr_plugin` target in a plugin's `.fabr` files: only a project declares a plugin it builds. */
const DIAG_PLUGIN_DECLARES_PLUGIN = Diagnostic.Error<{ loc: ISourcePosition }>(
  "A plugin's .fabr files cannot declare a fabr_plugin: only a project declares a plugin it builds"
);

/**
 * Check a plugin's `.fabr` file `file`, reporting through `log` what it may not
 * declare: anything but defaults, and any `fabr_plugin`, so nothing it adds
 * changes what was read before it.
 */
export function checkPluginFile(file: IBuildFileContents, log: Log): void {
  [...file.properties, ...file.targets].forEach(decl => log.log(DIAG_PLUGIN_ORDINARY, { loc: declPosn(decl) }));
  file.defaults
    .filter(decl => decl.kind === DeclKind.Target && decl.type === FABR_PLUGIN)
    .forEach(decl => log.log(DIAG_PLUGIN_DECLARES_PLUGIN, { loc: declPosn(decl) }));
}

/**
 * Resolve `decl`, whose name's root `model` declares as `match`, to the plugin
 * package it names: a `fabr_plugin` target, adding its `libs` (resolved by
 * `libsOf`), its code built when it is first used; or, for any other
 * reference, a package marked a plugin, made now so its `package.json` can be
 * read. A plugin is made under `run` for `host`, within `execution`.
 */
export function resolvePlugin(
  model: BuildModel,
  decl: IPluginDecl,
  match: IPrefixMatch,
  { execution, host, libsOf }: { execution: ExecutionContext; host: Constraints; libsOf: (target: ITargetDecl) => ComputableSource<{ files: string[]; errors: number }> }
): Computable<PluginResolution> {
  const target = match.decl;
  if (target.kind === DeclKind.Target && target.type === FABR_PLUGIN && match.rest.isEmpty()) {
    return libsOf(target).then(({ files, errors }) => ({
      decl,
      resolved: { name: declName(target), files, code: (built: BuildModel) => pluginManifest(built, decl, execution, host) },
      reported: errors,
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
      const manifest = source instanceof FileSet ? source.getFile("package.json")?.getAbsPath() : undefined;
      if (manifest === undefined) {
        throw new FabrError(`Plugin '${decl.name.toString()}' names no package`);
      }
      return manifest;
    });
}
