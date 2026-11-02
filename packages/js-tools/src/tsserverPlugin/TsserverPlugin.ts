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
 * The editor's TypeScript server shown a fabr project's compilation units as
 * their compiles see them: what an editor plugin loads into tsserver for the
 * projects of one fabr project. Each unit's imports resolve through the unit's
 * PnP table with the tsc driver's own resolution; every other tsserver project
 * is left as it is.
 *
 * The editor's plugin calls {@link createLanguageService} from its `create`,
 * with the units of the fabr project the tsserver project lies in. Nothing here
 * reads the editor's own settings or files: the units are handed in.
 */

import * as path from "path";
import { PnpResolver, splitSpecifier } from "../pnp/PnPResolver";
import { realpathKeepingVirtual } from "../pnp/VirtualPath";
import {
  type CompilerOptions,
  type IImportRewrite,
  type IInstalledResolution,
  type IResolutionHost,
  type ITypeScript,
  configHost,
  conditionsOf,
  installResolution,
} from "../tscDriver/tsc-driver";

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
  /** The files the unit's package delivers but no step compiles, by their paths from its config. */
  resources?: string[];
}

/* Structural typing for the tsserver API used here, as the driver types the
 * compiler's. */

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

export interface ILanguageServiceHost extends IResolutionHost {
  /** Changes whenever the project's files may have. */
  getProjectVersion?(): string;
  fileExists(fileName: string): boolean;
  readFile(fileName: string, encoding?: string): string | undefined;
  realpath?: (path: string) => string;
}

export interface IProject {
  getProjectName(): string;
  projectService: { serverMode: number; logger: { info(text: string): void } };
  getPackageJsonAutoImportProvider?: () => unknown;
}

export interface IPluginCreateInfo {
  project: IProject;
  languageService: ILanguageService;
  languageServiceHost: ILanguageServiceHost;
}

/** The extensions a source file of a unit may have, in the order the compiler
 * looks for them. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

/** A module's file, as the compiler reads one: the others are resources. */
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
export function createLanguageService(ts: IServerTypeScript, info: IPluginCreateInfo, units: readonly ITypeScriptUnit[]): ILanguageService {
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
export function unitOf(project: IProject, units: readonly ITypeScriptUnit[]): ITypeScriptUnit | undefined {
  const name = project.getProjectName();
  return units.find(unit => unit.config === name);
}

/**
 * Show `info`'s project, the tsserver project of `unit`, as the unit's compile
 * sees it: its imports resolved through the unit's table, the declarations a
 * local unit would output present where their sources are (so that tsserver
 * reads that unit from source), and auto-import offering only what the unit
 * can import.
 *
 * @return the language service tsserver is to use for the project.
 */
export function decorateUnitProject(
  ts: IServerTypeScript,
  info: IPluginCreateInfo,
  unit: ITypeScriptUnit,
  units: readonly ITypeScriptUnit[]
): ILanguageService {
  const host = info.languageServiceHost;
  const options = parsedOptions(ts, unit);
  const links = new Map<string, string>();
  const { resolution, installed } = unitResolution(ts, host, unit, options, units, links);
  for (const hook of RESOLUTION_HOOKS) {
    if (resolution[hook] !== undefined) {
      (host as unknown as Record<string, unknown>)[hook] = resolution[hook];
    }
  }
  answerLinks(host, links);
  /* tsserver's auto-import project resolves the dependencies the manifests
   * above a file list with stock resolution: in a unit it can reach only what
   * lies outside the unit. tsserver reads its absence as there being none. */
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
 * root holds it — under that unit's options, leaving an import from any other
 * file to the resolution `info`'s host already has.
 */
export function resolveByImporter(ts: IServerTypeScript, info: IPluginCreateInfo, units: readonly ITypeScriptUnit[]): void {
  const host = info.languageServiceHost;
  const links = new Map<string, string>();
  const byRoot = units
    .map(unit => {
      const parsed = ts.getParsedCommandLineOfConfigFile(unit.config, {}, configHost(ts));
      const options = parsed?.options ?? {};
      return {
        root: unit.root + path.sep,
        files: new Set((parsed?.fileNames ?? []).map(file => path.resolve(file))),
        options,
        resolution: unitResolution(ts, host, unit, options, units, links).resolution,
      };
    })
    .sort((a, b) => b.root.length - a.root.length);
  type Hook = (items: readonly unknown[], from: string, redirected: unknown, options: CompilerOptions, ...rest: unknown[]) => unknown;
  const hooks = host as unknown as Record<string, Hook | undefined>;
  for (const hook of ["resolveModuleNameLiterals", "resolveTypeReferenceDirectiveReferences"]) {
    const previous = hooks[hook];
    hooks[hook] = (items, from, redirected, options, ...rest) => {
      const owner = byRoot.find(candidate => candidate.files.has(path.resolve(from))) ?? byRoot.find(candidate => from.startsWith(candidate.root));
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
 * Make `unit`'s resolution over `host`: the driver's, through the unit's table,
 * with a local unit's output declarations answering as present wherever their
 * sources are — tsserver holds a referenced project's outputs as present only
 * in its program's own host, and the resolution reads the project's.
 */
function unitResolution(
  ts: IServerTypeScript,
  host: ILanguageServiceHost,
  unit: ITypeScriptUnit,
  options: CompilerOptions,
  units: readonly ITypeScriptUnit[],
  links: Map<string, string>
): { resolution: IResolutionHost; installed: IInstalledResolution } {
  /* Every unit's package, the unit's own among them: a package may import
   * itself by name, and a package's tests import it as the package does. */
  const locals = units
    .filter(other => other.package !== undefined)
    .map(other => ({ own: other.package === unit.package, ...outputLayout(parsedOptions(ts, other), other) }));
  const isLocalOutput = (file: string): boolean =>
    locals.some(layout => layout.sourcesOf(file).some(source => SOURCE_EXTENSIONS.some(extension => host.fileExists(source + extension))));
  /* A file no step compiles (a stylesheet a package ships as it is) is at its
   * name in the package where one of the package's directories holds it. */
  const isLocalResource = (file: string): boolean =>
    !MODULE_EXTENSION.test(file) && locals.some(layout => layout.filesOf(file).some(candidate => host.fileExists(candidate)));
  /* The compiler takes a referenced project's output for its source, under
   * that project's own options, where it names the output as the project lays
   * it out: by its `rootDir`. Where a package's sources come from several
   * directories the package names its outputs otherwise, and the plugin answers
   * with the output the project lays out beside the source; the unit's own
   * package, with the source itself. */
  const redirected = (file: string): string | undefined => {
    for (const layout of locals.filter(local => local.rootDirs > 1)) {
      for (const source of layout.sourcesOf(file)) {
        const extension = SOURCE_EXTENSIONS.find(candidate => host.fileExists(source + candidate));
        if (extension !== undefined) {
          return layout.own ? source + extension : source + declarationExtension(extension);
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
  const resolver = new PnpResolver(JSON.parse(ts.sys.readFile(unit.table) ?? "null"), unit.root, conditionsOf(ts, options), {
    validateExports: false,
  });
  const installed = installResolution(ts, resolution, options, resolver, unit.root, unit.rewrites, unit.resources);
  /* A package import is stated as reached through `<unit>/node_modules/<name>`,
   * a link to the package's directory: tsserver names a module by its package
   * only where it reached it through node_modules, which it learns from a
   * resolution's original path. Only the unit's own imports are stated so: a
   * package's own imports are its own business. A resolution to JavaScript is left as it is:
   * the compiler loads a module of a package only where its resolved path, or
   * the absence of an original path, says it was found in node_modules, and
   * otherwise reads it as the project's own source. */
  const resolveLiterals = resolution.resolveModuleNameLiterals!;
  resolution.resolveModuleNameLiterals = (literals, from, ...rest) =>
    resolveLiterals(literals, from, ...rest).map((answer, i) => {
      const resolved = answer.resolvedModule;
      const target = resolved && redirected(resolved.resolvedFileName);
      if (resolved && target !== undefined) {
        const extension = /\.d\.[cm]?ts$/.exec(target)?.[0] ?? path.extname(target);
        return {
          ...answer,
          resolvedModule: { ...resolved, resolvedFileName: target, extension, isExternalLibraryImport: false, originalPath: undefined },
        };
      }
      const split = splitSpecifier(literals[i].text);
      const directory = resolved && split && from.startsWith(unit.root + path.sep) ? packageDirectory(resolver, split.name, from) : undefined;
      if (!resolved || isJavaScript(resolved.extension) || !split || !directory || !resolved.resolvedFileName.startsWith(path.join(directory, path.sep))) {
        return answer;
      }
      const link = path.join(unit.root, "node_modules", split.name);
      links.set(link, path.resolve(directory));
      const originalPath = path.join(link, path.relative(directory, resolved.resolvedFileName));
      return { ...answer, resolvedModule: { ...resolved, originalPath } };
    });
  /* Each program asks its lookups afresh: a file created since the last can
   * answer one that failed then. */
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
  return { resolution, installed };
}

/** @return the extension of the declaration a source of `extension` is compiled to. */
function declarationExtension(extension: string): string {
  return extension === ".mts" ? ".d.mts" : extension === ".cts" ? ".d.cts" : ".d.ts";
}

/** @return true if `extension`, a resolution's, is a JavaScript module's, otherwise false. */
function isJavaScript(extension: string | undefined): boolean {
  return extension !== undefined && /^\.[cm]?jsx?$/.test(extension);
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
    for (const [link, real] of links) {
      if (file === link || file.startsWith(link + path.sep)) {
        return real + file.slice(link.length);
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

/**
 * @return how the compile of `unit`, with `options`, lays its declarations
 * out: `sourcesOf` an output (`<outDir>/x.d.ts`) gives the sources (`x`, less
 * its extension) it could be emitted from, one beneath each of the
 * directories its sources are named from (its `rootDirs`, else its
 * `rootDir`) that the output does not itself lie beneath; `filesOf` a file
 * of the package (`<outDir>/x.scss`) likewise gives where it may lie, at its
 * name beneath each; `rootDirs`, how many such directories there are.
 */
function outputLayout(
  options: CompilerOptions,
  unit: ITypeScriptUnit
): { rootDirs: number; sourcesOf(file: string): string[]; filesOf(file: string): string[] } {
  const base = path.dirname(unit.config);
  const outDir = path.resolve(base, typeof options.outDir === "string" ? options.outDir : ".");
  const rootDirs = (Array.isArray(options.rootDirs) && options.rootDirs.length > 0 ? (options.rootDirs as string[]) : [typeof options.rootDir === "string" ? options.rootDir : "."]).map(
    dir => path.resolve(base, dir)
  );
  const filesOf = (file: string): string[] =>
    file.startsWith(outDir + path.sep) ? rootDirs.filter(dir => !file.startsWith(dir + path.sep)).map(dir => path.join(dir, path.relative(outDir, file))) : [];
  return {
    rootDirs: rootDirs.length,
    sourcesOf: file => {
      const match = /\.d\.([cm]?)ts$/.exec(file);
      return match === null ? [] : filesOf(file.slice(0, match.index));
    },
    filesOf,
  };
}

/** @return `unit`'s compiler options, as its config states them. */
function parsedOptions(ts: IServerTypeScript, unit: ITypeScriptUnit): CompilerOptions {
  return ts.getParsedCommandLineOfConfigFile(unit.config, {}, configHost(ts))?.options ?? {};
}

/**
 * Wrap `service` so that auto-import, by completion or quick fix, offers only
 * imports the unit can make: from a file of the unit's program, and by a
 * relative path only to the unit's own files — another unit's sources are in
 * the program as a referenced project's, and its compile stages that unit's
 * package, not its sources.
 */
function scopedAutoImports(service: ILanguageService): ILanguageService {
  const intoReference = (program: IProgram, file: string, specifier: string): boolean => {
    if (!specifier.startsWith(".")) {
      return false;
    }
    const base = path.resolve(path.dirname(file), specifier);
    const target = ["", ...SOURCE_EXTENSIONS, ".d.ts", ...SOURCE_EXTENSIONS.map(extension => "/index" + extension)]
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
