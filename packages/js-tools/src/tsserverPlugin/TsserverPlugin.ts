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
 * The tsserver plugin's language service for the projects of one fabr project,
 * showing the editor's TypeScript server each compilation unit as its compile
 * sees it: a unit's imports resolve through the unit's PnP table with the tsc
 * driver's own resolution. Every other tsserver project is left as it is.
 *
 * The editor's plugin calls {@link createLanguageService} from its `create`,
 * with the units of the fabr project the tsserver project lies in. Nothing here
 * reads the editor's own settings or files.
 */

import * as path from "path";
import { PnpResolver, splitSpecifier } from "../pnp/PnPResolver";
import type { IPnpSerializedState } from "../pnp/PnPState";
import { realpathKeepingVirtual } from "../pnp/VirtualPath";
import { DECLARATION_EXTENSION } from "../tscDriver/Planning";
import {
  type CompilerOptions,
  DECLARATION_FILE,
  type IImportRewrite,
  type IInstalledResolution,
  type IResolutionHost,
  type ITypeScript,
  configHost,
  conditionsOf,
  installResolution,
} from "../tscDriver/tsc-driver";
import { toPosix } from "../support/Paths";

/** A compilation unit, as the editor's TypeScript server is shown it. */
export interface ITypeScriptUnit {
  /** The path the unit's config is served at, which names the tsserver
   * project of the unit. */
  config: string;
  /** The directory the unit's PnP table locates its packages from, holding
   * the unit's sources. */
  root: string;
  /** The unit's PnP table (`.pnp.data.json`). */
  table: string;
  /** The package the unit builds, where other units import it. */
  package?: string;
  /** The compile's import rewrite rules. */
  rewrites?: IImportRewrite[];
  /** The files the unit's package ships that no step compiles, by their paths from its config. */
  resources?: string[];
}

/* The parts of the tsserver API used here, typed structurally, as the driver
 * types the compiler's. */

/** The compiler as tsserver loads it, with the members the server adds. */
export interface IServerTypeScript extends ITypeScript {
  LanguageServiceMode: { PartialSemantic: number };
}

interface IProgram {
  getSourceFile(fileName: string): unknown;
  isSourceOfProjectReferenceRedirect(fileName: string): boolean;
}

interface ICompletionEntry {
  name: string;
  source?: string;
  data?: { fileName?: string; moduleSpecifier?: string };
}

interface ICompletions {
  entries: ICompletionEntry[];
}

interface ICodeFix {
  fixName: string;
  changes: ReadonlyArray<{ textChanges: ReadonlyArray<{ newText: string }> }>;
}

export interface ILanguageService {
  getProgram(): IProgram | undefined;
  getSemanticDiagnostics(fileName: string): readonly unknown[];
  getCompletionsAtPosition(fileName: string, ...rest: unknown[]): ICompletions | undefined;
  getCodeFixesAtPosition(fileName: string, ...rest: unknown[]): readonly ICodeFix[];
}

/** A tsserver project's language service host. */
export interface ILanguageServiceHost extends IResolutionHost {
  /** Changes whenever the project's files may have. */
  getProjectVersion?(): string;
  fileExists(fileName: string): boolean;
  readFile(fileName: string, encoding?: string): string | undefined;
  realpath?: (path: string) => string;
}

/** A tsserver project. */
export interface IProject {
  getProjectName(): string;
  projectService: { serverMode: number; logger: { info(text: string): void } };
  getPackageJsonAutoImportProvider?: () => unknown;
}

/** What tsserver hands a plugin's `create`. */
export interface IPluginCreateInfo {
  project: IProject;
  languageService: ILanguageService;
  languageServiceHost: ILanguageServiceHost;
}

/** The extensions a TypeScript source file of a unit may have, in the order
 * the compiler looks for them. */
const TYPESCRIPT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

/** Matches the name of a module's file, as the compiler reads one; any other
 * file is a resource. */
const MODULE_EXTENSION = /\.(?:[cm]?[jt]sx?|json)$/;

/** The resolution hooks a unit installs. */
const RESOLUTION_HOOKS = ["resolveModuleNameLiterals", "resolveTypeReferenceDirectiveReferences", "resolveLibrary"] as const;

/**
 * Make the language service tsserver is to use for `info`'s project, given the
 * units of the fabr project it lies in: a unit's project is shown as its
 * compile sees it ({@link decorateUnitProject}), the syntax server's inferred
 * project resolves each import by its importer's unit
 * ({@link resolveByImporter}), and any other project is left as it is.
 */
export function createLanguageService(
  ts: IServerTypeScript,
  info: IPluginCreateInfo,
  units: readonly ITypeScriptUnit[]
): ILanguageService {
  const unit = unitOf(info.project, units);
  if (unit !== undefined) {
    return decorateUnitProject(ts, info, unit, units);
  }
  if (info.project.projectService.serverMode === ts.LanguageServiceMode.PartialSemantic) {
    resolveByImporter(ts, info, units);
  }
  return info.languageService;
}

/**
 * @return the unit whose config names `project`, or undefined if `project` is
 * none of `units`.
 */
function unitOf(project: IProject, units: readonly ITypeScriptUnit[]): ITypeScriptUnit | undefined {
  const name = project.getProjectName();
  return units.find(unit => unit.config === name);
}

/**
 * Show `info`'s project, the tsserver project of `unit`, as the unit's compile
 * sees it: its imports resolved through the unit's table, the declarations
 * another unit of the project would output present where their sources are (so
 * that tsserver reads that unit from source), and auto-import offering only
 * what the unit can import.
 *
 * @return the language service tsserver is to use for the project.
 */
function decorateUnitProject(
  ts: IServerTypeScript,
  info: IPluginCreateInfo,
  unit: ITypeScriptUnit,
  units: readonly ITypeScriptUnit[]
): ILanguageService {
  const host = info.languageServiceHost;
  const table = readTable(ts, unit, info.project);
  if (table === undefined) {
    return info.languageService;
  }
  const configs = parsedConfigs(ts, units);
  const links = new Map<string, string>();
  const { resolution, installed } = unitResolution(
    ts,
    host,
    unit,
    table,
    configs.get(unit)!.options,
    localLayouts(units, configs),
    links
  );
  for (const hook of RESOLUTION_HOOKS) {
    if (resolution[hook] !== undefined) {
      (host as unknown as Record<string, unknown>)[hook] = resolution[hook];
    }
  }
  answerLinks(host, links);
  /* Give tsserver no auto-import provider, so it makes no auto-import project:
   * that project resolves the dependencies of the manifests above a file with
   * stock resolution, which in a unit reaches only what lies outside it. */
  info.project.getPackageJsonAutoImportProvider = () => undefined;
  info.project.projectService.logger.info(`fabr: ${unit.config} resolves through ${unit.table}`);
  return withFinishedDiagnostics(scopedAutoImports(info.languageService), installed);
}

/**
 * @return `service`, its semantic diagnostics finished as the compile finishes
 * them (`installed`'s `finishDiagnostics`): a resource's side-effect import
 * that is there is no error, and an import of a missing file the compiler let
 * through is one.
 */
function withFinishedDiagnostics(service: ILanguageService, installed: IInstalledResolution): ILanguageService {
  return new Proxy(service, {
    get(target, property, receiver) {
      if (property === "getSemanticDiagnostics") {
        return (fileName: string) => {
          const diagnostics = target.getSemanticDiagnostics(fileName);
          const file = target.getProgram()?.getSourceFile(fileName);
          return file === undefined ? diagnostics : installed.finishDiagnostics(diagnostics, file);
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

/**
 * Resolve each import in the syntax server's inferred project by the unit of
 * the importing file — one whose config lists it, else the innermost whose
 * root holds it, else the first whose table locates it (a file of a package
 * the unit installs) — under that unit's options, leaving an import from any
 * other file to the resolution `info`'s host already has.
 */
function resolveByImporter(ts: IServerTypeScript, info: IPluginCreateInfo, units: readonly ITypeScriptUnit[]): void {
  const host = info.languageServiceHost;
  const links = new Map<string, string>();
  const configs = parsedConfigs(ts, units);
  const layouts = localLayouts(units, configs);
  const byRoot = units
    .flatMap(unit => {
      const table = readTable(ts, unit, info.project);
      if (table === undefined) {
        return [];
      }
      const { options, fileNames } = configs.get(unit)!;
      const { resolution, resolver } = unitResolution(ts, host, unit, table, options, layouts, links);
      return [{ root: `${tsPathOf(unit.root)}/`, files: new Set(fileNames.map(tsPathOf)), options, resolution, resolver }];
    })
    .sort((a, b) => b.root.length - a.root.length);
  type Unit = (typeof byRoot)[number];
  /* The unit whose table locates each importing file outside every unit, by the file. */
  const locating = new Map<string, Unit | undefined>();
  const locatedBy = (from: string): Unit | undefined => {
    if (!locating.has(from)) {
      locating.set(
        from,
        byRoot.find(candidate => locates(candidate.resolver, from))
      );
    }
    return locating.get(from);
  };
  type Hook = (items: readonly unknown[], from: string, redirected: unknown, options: CompilerOptions, ...rest: unknown[]) => unknown;
  const hooks = host as unknown as Record<string, Hook | undefined>;
  for (const hook of ["resolveModuleNameLiterals", "resolveTypeReferenceDirectiveReferences"]) {
    const previous = hooks[hook];
    hooks[hook] = (items, from, redirected, options, ...rest) => {
      const importer = tsPathOf(from);
      const owner =
        byRoot.find(candidate => candidate.files.has(importer)) ??
        byRoot.find(candidate => importer.startsWith(candidate.root)) ??
        locatedBy(from);
      const own = owner && (owner.resolution as unknown as Record<string, Hook | undefined>)[hook];
      return own !== undefined
        ? own(items, from, redirected, owner!.options, ...rest)
        : previous?.call(host, items, from, redirected, options, ...rest);
    };
  }
  answerLinks(host, links);
  info.project.projectService.logger.info(`fabr: syntax server resolves by importer across ${units.length} units`);
}

/**
 * @return `file`, a path as the host or TypeScript spells it, absolute and as
 * this plugin holds and compares every path: `/`-separated, a Windows drive
 * kept in lower case (`c:/x`), since VS Code and `path.resolve` disagree on
 * its case.
 */
function tsPathOf(file: string): string {
  return toPosix(path.resolve(file)).replace(/^[A-Z](?=:)/, drive => drive.toLowerCase());
}

/** How a unit that builds a package lays its outputs out, with the package's name. */
interface ILocalLayout extends IOutputLayout {
  package: string;
}

/**
 * @return the output layout of every unit of `units` that builds a package,
 * by its config as `configs` holds it. Every unit's resolution takes them all,
 * the package's own included: a package may import itself by name, and its
 * tests import it as the package does.
 */
function localLayouts(units: readonly ITypeScriptUnit[], configs: ReadonlyMap<ITypeScriptUnit, IUnitConfig>): ILocalLayout[] {
  return units.flatMap(unit =>
    unit.package === undefined ? [] : [{ package: unit.package, ...outputLayout(configs.get(unit)!.options, unit) }]
  );
}

/**
 * @return `unit`'s PnP table, or undefined where it cannot be read, which is
 * logged to `project`'s server log: the unit's project is then left as
 * tsserver has it.
 */
function readTable(ts: IServerTypeScript, unit: ITypeScriptUnit, project: IProject): IPnpSerializedState | undefined {
  const text = ts.sys.readFile(unit.table);
  if (text === undefined) {
    project.projectService.logger.info(`fabr: ${unit.config} has no PnP table at ${unit.table}; it resolves as tsserver resolves it`);
    return undefined;
  }
  try {
    return JSON.parse(text) as IPnpSerializedState;
  } catch (err) {
    project.projectService.logger.info(
      `fabr: ${unit.table} is not a PnP table (${err instanceof Error ? err.message : String(err)}); ${unit.config} resolves as tsserver resolves it`
    );
    return undefined;
  }
}

/**
 * Make `unit`'s resolution over `host`: the driver's, through the unit's table,
 * with the output declarations of the units in `layouts` answering as present
 * wherever their sources are, as do the files their packages ship that no step
 * compiles. (tsserver holds a referenced project's outputs as present only in
 * its program's own host, not the project's host the resolution reads.) Each
 * import of a package from the unit's own files is stated as reached through
 * `<unit root>/node_modules/<name>`, the link recorded in `links`.
 */
function unitResolution(
  ts: IServerTypeScript,
  host: ILanguageServiceHost,
  unit: ITypeScriptUnit,
  table: IPnpSerializedState,
  options: CompilerOptions,
  layouts: readonly ILocalLayout[],
  links: Map<string, string>
): { resolution: IResolutionHost; installed: IInstalledResolution; resolver: PnpResolver } {
  const locals = layouts.map(layout => ({ ...layout, own: layout.package === unit.package }));
  const unitRoot = `${tsPathOf(unit.root)}/`;
  const isLocalOutput = (file: string): boolean =>
    locals.some(layout =>
      layout.sourcesOf(file).some(source => TYPESCRIPT_EXTENSIONS.some(extension => host.fileExists(source + extension)))
    );
  /* A file no step compiles (a stylesheet a package ships as it is) is at its
   * name in the package where one of the package's directories holds it. */
  const isLocalResource = (file: string): boolean =>
    !MODULE_EXTENSION.test(file) && locals.some(layout => layout.filesOf(file).some(candidate => host.fileExists(candidate)));
  /* The compiler maps a referenced project's output to its source only where
   * the output is named by the project's `rootDir`. For a package whose
   * sources come from several directories, answer with the declaration beside
   * the source instead, or for the unit's own package with the source itself. */
  const redirected = (file: string): string | undefined => {
    for (const layout of locals.filter(local => local.rootDirs > 1)) {
      for (const source of layout.sourcesOf(file)) {
        const extension = TYPESCRIPT_EXTENSIONS.find(candidate => host.fileExists(source + candidate));
        if (extension !== undefined) {
          return layout.own ? source + extension : source + DECLARATION_EXTENSION.get(extension)!;
        }
      }
    }
    return undefined;
  };
  const canonical = ts.sys.useCaseSensitiveFileNames ? (name: string) => name : (name: string) => name.toLowerCase();
  const resolution: IResolutionHost = {
    fileExists: file => host.fileExists(file) || isLocalOutput(file) || isLocalResource(file),
    readFile: file => host.readFile(file),
    getCanonicalFileName: canonical,
  };
  const resolver = new PnpResolver(table, unit.root, conditionsOf(ts, options), { validateExports: false });
  const installed = installResolution(ts, resolution, options, resolver, unit.root, unit.rewrites, unit.resources);
  /* State a package import from the unit's own files as reached through
   * `<unit>/node_modules/<name>`, a link to the package's directory, as the
   * resolution's original path: tsserver names a module by its package only
   * where it reached it through node_modules. Leave a resolution to JavaScript
   * as it is: the compiler loads it as a package's module only where its
   * resolved path says it was found in node_modules, or it has no original
   * path, and otherwise reads it as the project's own source. */
  const resolveLiterals = resolution.resolveModuleNameLiterals!;
  resolution.resolveModuleNameLiterals = (literals, from, ...rest) =>
    resolveLiterals(literals, from, ...rest).map((answer, i) => {
      const resolved = answer.resolvedModule;
      const target = resolved && redirected(resolved.resolvedFileName);
      if (resolved && target !== undefined) {
        const extension = DECLARATION_FILE.exec(target)?.[0] ?? path.extname(target);
        return {
          ...answer,
          resolvedModule: {
            ...resolved,
            resolvedFileName: target,
            extension,
            isExternalLibraryImport: false,
            originalPath: undefined,
          },
        };
      }
      const split = splitSpecifier(literals[i].text);
      const unpacked =
        resolved && split && tsPathOf(from).startsWith(unitRoot) ? packageDirectory(resolver, split.name, from) : undefined;
      const directory = unpacked === undefined ? undefined : tsPathOf(unpacked);
      if (
        !resolved ||
        isJavaScript(resolved.extension) ||
        !split ||
        !directory ||
        !tsPathOf(resolved.resolvedFileName).startsWith(`${directory}/`)
      ) {
        return answer;
      }
      const link = tsPathOf(path.join(unit.root, "node_modules", split.name));
      links.set(link, directory);
      const originalPath = path.posix.join(link, path.posix.relative(directory, tsPathOf(resolved.resolvedFileName)));
      return { ...answer, resolvedModule: { ...resolved, originalPath } };
    });
  /* Forget earlier lookups whenever the project version changes: a file
   * created since can answer one that failed. */
  let version: string | undefined;
  for (const hook of RESOLUTION_HOOKS) {
    const resolve = resolution[hook] as ((...args: unknown[]) => unknown) | undefined;
    if (resolve !== undefined) {
      (resolution as unknown as Record<string, unknown>)[hook] = (...args: unknown[]): unknown => {
        const current = host.getProjectVersion?.();
        if (current !== version) {
          version = current;
          installed.invalidate();
        }
        return resolve.apply(resolution, args);
      };
    }
  }
  return { resolution, installed, resolver };
}

/** @return true if `extension`, a resolution's, is a JavaScript module's, otherwise false. */
function isJavaScript(extension: string | undefined): boolean {
  return extension !== undefined && /^\.[cm]?jsx?$/.test(extension);
}

/**
 * @return true if `resolver`'s table locates `file` in a package it installs,
 * otherwise false: a file outside the table, or one it names only virtually,
 * is not located.
 */
function locates(resolver: PnpResolver, file: string): boolean {
  try {
    return resolver.findPackageLocator(file) !== null;
  } catch {
    return false;
  }
}

/**
 * @return the directory of the package `name` an import of it from `from`
 * reaches, or undefined where the importer does not declare it.
 */
function packageDirectory(resolver: PnpResolver, name: string, from: string): string | undefined {
  try {
    return resolver.resolveToUnqualified(name, from) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Answer `links`' paths on `host` as symlinks to their targets would be
 * answered: a file beneath a link exists and reads as its target's file, and
 * realpaths to it; a PnP virtual path keeps its name.
 */
function answerLinks(host: ILanguageServiceHost, links: ReadonlyMap<string, string>): void {
  const target = (file: string): string => {
    /* A trailing separator (a directory) is kept, which tsPathOf drops. */
    const named = tsPathOf(file) + (/[\\/]$/.test(file) ? "/" : "");
    for (const [link, real] of links) {
      if (named === link || named.startsWith(`${link}/`)) {
        return real + named.slice(link.length);
      }
    }
    return file;
  };
  const { fileExists, readFile, realpath } = host;
  host.fileExists = file => fileExists.call(host, target(file));
  host.readFile = (file, encoding) => readFile.call(host, target(file), encoding);
  if (realpath !== undefined) {
    host.realpath = file => realpathKeepingVirtual(target(file), real => realpath.call(host, real));
  }
}

/** How a compile lays its outputs out; see {@link outputLayout}. */
interface IOutputLayout {
  /** The number of directories the compile names its sources from. */
  rootDirs: number;
  /** Get the sources (each less its extension) an output declaration could be
   * emitted from. */
  sourcesOf(file: string): string[];
  /** Get where a file of the package under the output directory may lie. */
  filesOf(file: string): string[];
}

/**
 * @return how the compile of `unit`, with `options`, lays its declarations
 * out: `sourcesOf` an output (`<outDir>/x.d.ts`) gives the sources (`x`, less
 * its extension) it could be emitted from, one beneath each of the
 * directories its sources are named from (its `rootDirs`, else its
 * `rootDir`) that the output does not itself lie beneath; `filesOf` a file
 * of the package (`<outDir>/x.scss`) likewise gives where it may lie, at its
 * name beneath each; `rootDirs`, how many such directories there are.
 */
function outputLayout(options: CompilerOptions, unit: ITypeScriptUnit): IOutputLayout {
  const base = path.dirname(unit.config);
  const outDir = tsPathOf(path.resolve(base, typeof options.outDir === "string" ? options.outDir : "."));
  const rootDirs = (
    Array.isArray(options.rootDirs) && options.rootDirs.length > 0
      ? (options.rootDirs as string[])
      : [typeof options.rootDir === "string" ? options.rootDir : "."]
  ).map(dir => tsPathOf(path.resolve(base, dir)));
  const filesOf = (written: string): string[] => {
    const file = tsPathOf(written);
    return file.startsWith(`${outDir}/`)
      ? rootDirs.filter(dir => !file.startsWith(`${dir}/`)).map(dir => path.posix.join(dir, path.posix.relative(outDir, file)))
      : [];
  };
  return {
    rootDirs: rootDirs.length,
    sourcesOf: file => {
      const match = DECLARATION_FILE.exec(file);
      return match === null ? [] : filesOf(file.slice(0, match.index));
    },
    filesOf,
  };
}

/** A unit config's compiler options and the files it lists. */
interface IUnitConfig {
  options: CompilerOptions;
  fileNames: readonly string[];
}

/** Each unit config as parsed, by the config's path, with the text it was parsed from. */
const configCache = new Map<string, { text: string; config: IUnitConfig }>();

/** @return each of `units`' configs as the compiler parses it, each config read once. */
function parsedConfigs(ts: IServerTypeScript, units: readonly ITypeScriptUnit[]): Map<ITypeScriptUnit, IUnitConfig> {
  return new Map(units.map(unit => [unit, parsedConfig(ts, unit)]));
}

/**
 * @return `unit`'s config as the compiler parses it: parsed again, from the
 * text read here, only where that text has changed since it was last parsed.
 */
function parsedConfig(ts: IServerTypeScript, unit: ITypeScriptUnit): IUnitConfig {
  const text = ts.sys.readFile(unit.config);
  const held = configCache.get(unit.config);
  if (held !== undefined && held.text === text) {
    return held.config;
  }
  const host = configHost(ts) as { readFile(file: string, encoding?: string): string | undefined };
  const parsed = ts.getParsedCommandLineOfConfigFile(
    unit.config,
    {},
    {
      ...host,
      readFile: (file: string, encoding?: string) => (file === unit.config ? text : host.readFile(file, encoding)),
    }
  );
  const config = { options: parsed?.options ?? {}, fileNames: parsed?.fileNames ?? [] };
  if (text !== undefined) {
    configCache.set(unit.config, { text, config });
  }
  return config;
}

/**
 * Wrap `service` so that auto-import, by completion or quick fix, offers only
 * imports the unit can make: from a file of the unit's program, and by a
 * relative path only to the unit's own files, not to another unit's sources
 * (in the program as a referenced project's), whose package the compile stages
 * instead.
 */
function scopedAutoImports(service: ILanguageService): ILanguageService {
  const intoReference = (program: IProgram, file: string, specifier: string): boolean => {
    if (!specifier.startsWith(".")) {
      return false;
    }
    const base = path.resolve(path.dirname(file), specifier);
    const target = ["", ...TYPESCRIPT_EXTENSIONS, ".d.ts", ...TYPESCRIPT_EXTENSIONS.map(extension => "/index" + extension)]
      .map(suffix => base + suffix)
      .find(candidate => program.getSourceFile(candidate) !== undefined);
    return target !== undefined && program.isSourceOfProjectReferenceRedirect(target);
  };
  const decorated: ILanguageService = Object.create(service);
  decorated.getCompletionsAtPosition = (fileName, ...rest) => {
    const completions = service.getCompletionsAtPosition(fileName, ...rest);
    const program = service.getProgram();
    if (completions === undefined || program === undefined) {
      return completions;
    }
    const importable = (entry: ICompletionEntry): boolean => {
      const from = entry.data?.fileName;
      if (from === undefined) {
        return true;
      }
      return (
        program.getSourceFile(from) !== undefined &&
        !intoReference(program, fileName, entry.data?.moduleSpecifier ?? entry.source ?? "")
      );
    };
    return { ...completions, entries: completions.entries.filter(importable) };
  };
  decorated.getCodeFixesAtPosition = (fileName, ...rest) => {
    const fixes = service.getCodeFixesAtPosition(fileName, ...rest);
    const program = service.getProgram();
    if (program === undefined) {
      return fixes;
    }
    const writesInto = (fix: ICodeFix): boolean =>
      fix.changes.some(change =>
        change.textChanges.some(text =>
          [...text.newText.matchAll(/(?:from\s+|require\(\s*|import\(\s*)["']([^"']+)["']/g)].some(match =>
            intoReference(program, fileName, match[1])
          )
        )
      );
    return fixes.filter(fix => fix.fixName !== "import" || !writesInto(fix));
  };
  return decorated;
}
