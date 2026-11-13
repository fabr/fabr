/*
 * Copyright (c) 2022 Nathan Keynes <nkeynes@deadcoderemoval.net>
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

import * as path from "node:path";

import { Computable, ComputableSource } from "../core/Computable";
import { FileSource } from "../core/FileSet";
import { Name } from "../core/Name";
import { Diagnostic, ErrorTrackingLog, IDiagnosticNote, ISourceSpan, Log, LogLevel } from "../support/Log";
import { StringReader } from "../support/StringReader";
import { DIAG_FABR_PLACEMENT, parseBuildFile } from "./Parser";
import {
  DeclKind,
  declPosn,
  IBuildFileContents,
  IFabrDecl,
  IIncludeDecl,
  INameValue,
  isPropertyDecl,
  ISpliceDecl,
  ITargetDecl,
  optionalLibOf,
} from "./AST";
import { BuildModel } from "./BuildModel";
import { ModelBuilder } from "./ModelBuilder";
import { ExecutionContext } from "./ExecutionContext";
import { getCoreVersion, matchOptionalLibs, PluginResolution, resolvePlugin } from "./Plugin";
import { PluginContribution } from "../rules/Types";
import { computableWorkList } from "../core/WorkList";
import { FabrError } from "../core/Errors";
import { Constraints } from "./Constraints";

/** An `include` naming a file that does not exist, reported against the include. */
const DIAG_INCLUDE_NOT_FOUND = new Diagnostic<{ filename: string; loc: ISourceSpan }>(
  LogLevel.Error,
  "Included file not found: {filename}"
);

/** A project declaring a fabr release other than the one running. */
const DIAG_OTHER_FABR = new Diagnostic<{ declared: string; running: string; loc: ISourceSpan }>(
  LogLevel.Warn,
  "This project declares fabr {declared}, but this is fabr {running}"
);

/** An `include` pattern that matches no file. */
const DIAG_INCLUDE_NO_MATCH = new Diagnostic<{ filename: string; loc: ISourceSpan }>(
  LogLevel.Error,
  "Included files not found: {filename} matched nothing"
);

/** An `include` in a project file that resolves outside the project tree. */
const DIAG_INCLUDE_OUTSIDE = new Diagnostic<{ filename: string; loc: ISourceSpan }>(
  LogLevel.Error,
  "Included file not found: {filename} (outside the project tree)"
);

/** A splice in the body of a `fabr_plugin` target. */
const DIAG_PLUGIN_SPLICE = Diagnostic.Error<{ name: string; loc: ISourceSpan }>(
  "A plugin's body is read as written, before anything is built, so it cannot splice '{name}'"
);

/** A `fabr_plugin` target's `libs` value that is not a path or pattern beside it. */
const DIAG_PLUGIN_LIBS = new Diagnostic<{ loc: ISourceSpan }>(
  LogLevel.Error,
  "A plugin's libs are paths or patterns relative to the file declaring it, as an include's are"
);

/**
 * @return core's own contribution to every load: STD.fabr, which declares
 * core's rules and repository types and is read with the project's files, with
 * no `include`.
 */
export function coreContribution(): PluginContribution {
  /* This module is in model/, beside core's entry point. */
  return { includes: [getLibFile(path.dirname(__dirname), "STD.fabr")] };
}

/**
 * @return the path of `file` in the lib/ directory beside a package's entry
 * point, which is in `entryDir`. A plugin passes its entry module's
 * `__dirname`, so a plugin built in the project finds its own files, not an
 * installed copy's. The devchain copies lib/ into build/ beside the compiled
 * output (scripts/copylibs.js); a fabr-built package has its entry point and
 * lib/ together at the package root.
 */
export function getLibFile(entryDir: string, file: string): string {
  return path.join(entryDir, "lib", file);
}

/* A work-list key is a file path: relative to the project source's root for a
 * project file, absolute for a core or plugin lib file ({@link getLibFile}). A
 * relative key is read from the project source, an absolute one from the
 * absolute-path source. */

/** @return true if `target`, a path an include in `file` resolved to, lies
 * outside the project tree, otherwise false. Only a project file's includes are
 * checked; a lib file's always return false. */
function escapesTree(file: string, target: string): boolean {
  return !path.isAbsolute(file) && (target === ".." || target.startsWith(".." + path.sep));
}

/** An include's name resolved for matching against the source. */
interface ResolvedIncludeName {
  /** The pattern to match, re-rooted at the including file's directory. */
  pattern: Name;
  /** The one path a plain include names, if it is one. Keep only a match of
   * exactly this path: `find` expands a name that is a directory into every file
   * beneath it, none of which the include names. */
  exact?: string;
}

/**
 * Resolve an include's name relative to the directory of `file`, the including
 * file. A plain path is joined whole. A pattern's literal head is joined and its
 * glob tail kept, so the directory its search starts from is checked as a plain
 * path is. Paths are joined, not resolved, so a project file's includes stay
 * relative to the source root. (The parser refuses an absolute include path.)
 *
 * @return the name to match, or undefined where a project file's include
 * resolves outside the project tree; a lib file's includes are not checked.
 */
function resolveIncludeName(file: string, include: IIncludeDecl): ResolvedIncludeName | undefined {
  const dir = path.dirname(file);
  const plain = include.name.getSimpleName();
  if (plain !== undefined) {
    const target = path.join(dir, plain);
    return escapesTree(file, target) ? undefined : { pattern: Name.fromLiteral(target), exact: target };
  }
  const head = include.name.getLiteralPathPrefix();
  const base = path.join(dir, head);
  if (escapesTree(file, base)) {
    return undefined;
  }
  const tail = include.name.substring(head.length);
  return { pattern: base === "." ? tail : tail.withPrefix(base.endsWith("/") ? base : base + "/") };
}

/** Make one "included from here" note per include in the chain that reached
 * the file `site` is written in, from that file's include back to the project
 * file, reading each file's include from `sites`. The chain stops at a file
 * already noted, so an include cycle ends it. */
function includeChain(sites: ReadonlyMap<string, IIncludeDecl>, site: IIncludeDecl): IDiagnosticNote[] {
  const notes: IDiagnosticNote[] = [];
  const seen = new Set<string>();
  for (let parent = sites.get(site.source.file); parent && !seen.has(parent.source.file);) {
    seen.add(parent.source.file);
    notes.push({ message: "included from here", loc: declPosn(parent) });
    parent = sites.get(parent.source.file);
  }
  return notes;
}

/** The files one `include` decl names, and the number of errors reported resolving it. */
interface IncludedFiles {
  files: string[];
  errors: number;
}

/** One build file read: its parsed decls and the number of errors reported reading it. */
interface LoadedFile {
  /** The file's work-list key: relative to the project's root for a project file, absolute for a lib file. */
  file: string;
  decls: IBuildFileContents;
  /** The errors reported parsing it: where there are any, its declarations are not validated. */
  parseErrors: number;
  /** The errors reported resolving its includes. */
  includeErrors: number;
}

/** The decls of a file an include matched that was gone when it was read: none. */
const NO_DECLS: IBuildFileContents = {
  targets: [],
  targetdefs: [],
  properties: [],
  defaults: [],
  includes: [],
  plugins: [],
  rules: [],
  repositories: [],
};

/** What one include of a plugin's optional libs resolved to: the files it names, or why it names none. */
interface OptionalLibResolution {
  decl: IIncludeDecl;
  resolved: string[] | Error;
}

/**
 * One round of a load: the files it read, a plugin's where `fromPlugin`, and
 * what the plugins and the includes of optional libs they made ready resolved to.
 */
interface Round {
  files: LoadedFile[];
  fromPlugin: boolean;
  plugins: PluginResolution[];
  optionalLibs: OptionalLibResolution[];
}

/**
 * Reads a project's build files, and the files of the plugins they use, into a
 * model. What it reads is kept across loads, so a load made again under watch
 * neither re-reads nor re-reports a file that has not changed.
 */
class ProjectLoader {
  /** The first `include` decl that named each file reached, which tells a file
   * an include named from one it did not, and supplies the chain of includes
   * reported with a failure. */
  private readonly includeSites = new Map<string, IIncludeDecl>();
  /** Each file's load. */
  private readonly steps = new Map<string, ComputableSource<{ value: LoadedFile; next: string[] }>>();
  /** Each `fabr_plugin` target's `libs` and `optional_libs`, resolved, by its declaration and the property. */
  private readonly libs = new Map<ITargetDecl, Map<string, ComputableSource<IncludedFiles>>>();

  constructor(
    private readonly execution: ExecutionContext,
    private readonly startFile: string,
    private readonly core: PluginContribution,
    private readonly host: Constraints,
    private readonly options: ILoadOptions
  ) {}

  /**
   * Load the model: read the project's files and core's, then, each round,
   * resolve every plugin whose name's root is now declared, and every include
   * of the optional libs of a plugin now added, and read the files those add,
   * until a round resolves none.
   */
  public load(): Computable<BuildModel> {
    return this.round([], [this.startFile, ...(this.core.includes ?? [])], false);
  }

  /**
   * Read `roots`, a plugin's files where `fromPlugin`, after the rounds
   * `previous`, then resolve the plugins now ready and read what they add.
   * Each round makes its model afresh from the rounds before it, so a round
   * read again (a file of it changed, under watch) just goes on from there.
   */
  private round(previous: Round[], roots: string[], fromPlugin: boolean): Computable<BuildModel> {
    return this.walk(roots).then(files => {
      const rounds: Round[] = [...previous, { files, fromPlugin, plugins: [], optionalLibs: [] }];
      const model = this.modelOf(rounds);
      const ready = model.pendingPlugins().flatMap(decl => {
        const match = model.getPrefixMatch(decl.name, decl.source.file);
        return match === undefined ? [] : [{ decl, match }];
      });
      const optionalLibs = model.pendingOptionalLibs().flatMap(decl => this.optionalLibsOf(model, decl));
      if (ready.length === 0 && optionalLibs.length === 0) {
        this.forgetLibs(rounds);
        return model.finish();
      }
      return Computable.forAll(
        ready.map(({ decl, match }) =>
          resolvePlugin(model, decl, match, {
            execution: this.execution,
            host: this.host,
            libsOf: (target, property) => this.libsOf(target, property),
          })
        ),
        (...plugins: PluginResolution[]) => plugins
      ).then(plugins => {
        const added = [
          ...plugins.flatMap(({ resolved }) =>
            resolved instanceof Error
              ? []
              : [...resolved.files, ...(this.options.includeOptionalLibs ? resolved.optionalLibs.map(lib => lib.file) : [])]
          ),
          ...optionalLibs.flatMap(({ resolved }) => (resolved instanceof Error ? [] : resolved)),
        ];
        return this.round([...previous, { files, fromPlugin, plugins, optionalLibs }], [...new Set(added)], true);
      });
    });
  }

  /**
   * Resolve `decl`, an include of a plugin's optional libs, where `model` has
   * added that plugin, to the files it names: @return its resolution, or none
   * where the plugin is not yet added.
   */
  private optionalLibsOf(model: ModelBuilder, decl: IIncludeDecl): OptionalLibResolution[] {
    const lib = optionalLibOf(decl.name);
    const plugin = lib === undefined ? undefined : model.getPlugin(lib.plugin);
    if (lib === undefined || plugin === undefined) {
      return [];
    }
    const files = matchOptionalLibs(plugin, lib.path);
    if (files.length === 0) {
      const listed = plugin.optionalLibs.map(one => one.name).sort();
      const detail = `'${plugin.name}' has no optional lib ${lib.path.toString()}`;
      return [
        {
          decl,
          resolved: new FabrError(listed.length === 0 ? `${detail}, and lists none` : `${detail} (it lists ${listed.join(", ")})`),
        },
      ];
    }
    for (const file of files) {
      if (!this.includeSites.has(file)) {
        this.includeSites.set(file, decl);
      }
    }
    return [{ decl, resolved: files }];
  }

  /** Make the model of `rounds`: each round's files, a file reached again added once, then the plugins it resolved, in name order. */
  private modelOf(rounds: Round[]): ModelBuilder {
    const model = new ModelBuilder(this.execution.log, [this.core]);
    const read = new Set<string>();
    for (const { files, fromPlugin, plugins, optionalLibs } of rounds) {
      const fresh = files.filter(file => !read.has(file.file) && read.add(file.file));
      model.addFiles(
        fresh.map(file => file.decls),
        {
          fromPlugin,
          reported: fresh.reduce((total, file) => total + file.parseErrors + file.includeErrors, 0),
          unparsed: fresh.filter(file => file.parseErrors > 0).map(file => file.file),
        }
      );
      for (const { decl, resolved, reported } of plugins) {
        model.addPlugin(decl, resolved, reported);
      }
      for (const { decl, resolved } of optionalLibs) {
        model.addOptionalLibs(decl, resolved);
      }
    }
    return model;
  }

  /** Read the build files `roots` and the files they include. */
  private walk(roots: string[]): Computable<LoadedFile[]> {
    return computableWorkList<string, LoadedFile>(roots, file => this.loadFile(file)).then(loaded => [...loaded.values()]);
  }

  /** Read and parse `file`, once, with the files its includes name as the work-list's next. */
  private loadFile(file: string): ComputableSource<{ value: LoadedFile; next: string[] }> {
    const known = this.steps.get(file);
    if (known !== undefined) {
      return known;
    }
    const fs = path.isAbsolute(file) ? this.execution.absFileSource : this.execution.sourceFileSource;
    const step = fs.get(file).then(f => {
      if (!f) {
        /* An included file was matched by its include, so one missing here was
         * deleted since: it contributes nothing and reports nothing, and the
         * include's own match, re-run, reports it if it now names nothing. A
         * file no include named (the project file, a lib file) is an error. */
        if (!this.includeSites.has(file)) {
          throw new FabrError("File not found: " + file);
        }
        return { value: { file, decls: NO_DECLS, parseErrors: 0, includeErrors: 0 }, next: [] };
      }
      return f.readString().then(content => {
        /* Parsing logs each error and recovers; count them through a wrapping log. */
        const parseLog = new ErrorTrackingLog(this.execution.log);
        const decls = parseBuildFile({ fs, file, reader: new StringReader(content) }, parseLog);
        if (decls.fabr !== undefined) {
          this.checkFabr(file, decls.fabr, parseLog);
        }
        /* Each include resolves to the files it names: one path for a plain
         * include, every current match for a pattern. The match is live, so this
         * file's load re-runs when the set changes. An include of a plugin's
         * optional libs is resolved by the model's rounds instead. */
        const included = decls.includes
          .filter(include => optionalLibOf(include.name) === undefined)
          .map(include => this.includedFiles(fs, file, include));
        return Computable.forAll(included, (...resolved) => ({
          value: {
            file,
            decls,
            parseErrors: parseLog.errorCount,
            includeErrors: resolved.reduce((total, one) => total + one.errors, 0),
          },
          next: resolved.flatMap(one => one.files),
        }));
      });
    });
    this.steps.set(file, step);
    return step;
  }

  /**
   * Report `decl`, the `fabr <version>;` of `file`, to `log`: as an error
   * where `file` is not the project file (its parser saw only that it was the
   * first statement), and as a warning where it declares a release other than
   * the one running.
   */
  private checkFabr(file: string, decl: IFabrDecl, log: Log): void {
    if (file !== this.startFile) {
      log.log(DIAG_FABR_PLACEMENT, { loc: declPosn(decl) });
      return;
    }
    const running = getCoreVersion();
    if (running !== undefined && running !== decl.version) {
      log.log(DIAG_OTHER_FABR, { declared: decl.version, running, loc: declPosn(decl) });
    }
  }

  /**
   * Resolve one `include` decl in `file` to the build files it names, sorted: a
   * plain path's one file, or every file a pattern matches. An include must
   * name at least one file: a plain path that does not exist, a pattern that
   * matches nothing, and a project file's include outside the project tree are
   * each reported against the decl, resolving to no files and one error.
   *
   * The match is a live query over `fs`, so under watch a file appearing or
   * disappearing beneath a pattern re-runs the including file's load.
   */
  private includedFiles(fs: FileSource, file: string, include: IIncludeDecl): ComputableSource<IncludedFiles> {
    const resolved = resolveIncludeName(file, include);
    if (resolved === undefined) {
      /* An include outside the project tree is reported like a missing one. */
      return Computable.resolve(this.includeFailed(DIAG_INCLUDE_OUTSIDE, include));
    }
    /* Matches are named relative to the source's root, which is a project file's
     * key. A lib file's key is absolute and a FileSet name never is, so put back
     * the leading separator the absolute-path source leaves off. */
    const absolute = path.isAbsolute(file);
    return fs.find(resolved.pattern).then(matched => {
      const files = [...matched]
        .map(([name]) => (absolute ? path.sep + name : name))
        .filter(name => resolved.exact === undefined || name === resolved.exact)
        .sort();
      if (files.length === 0) {
        return this.includeFailed(resolved.exact === undefined ? DIAG_INCLUDE_NO_MATCH : DIAG_INCLUDE_NOT_FOUND, include);
      }
      for (const target of files) {
        if (!this.includeSites.has(target)) {
          this.includeSites.set(target, include);
        }
      }
      return { files, errors: 0 };
    });
  }

  /** Report `include` as naming no file, by `diagnostic`, with the chain of includes that reached it. */
  private includeFailed(diagnostic: Diagnostic<{ filename: string; loc: ISourceSpan }>, include: IIncludeDecl): IncludedFiles {
    this.execution.log.log(diagnostic, {
      filename: include.name.toString(),
      loc: declPosn(include),
      notes: includeChain(this.includeSites, include),
    });
    return { files: [], errors: 1 };
  }

  /** Forget the libs of each `fabr_plugin` target no file of `rounds`, a whole load's, declares. */
  private forgetLibs(rounds: Round[]): void {
    const declared = new Set<unknown>(
      rounds.flatMap(({ files }) => files.flatMap(({ decls }) => [...decls.targets, ...decls.defaults]))
    );
    for (const target of [...this.libs.keys()]) {
      if (!declared.has(target)) {
        this.libs.delete(target);
      }
    }
  }

  /**
   * Resolve the `property` (`libs` or `optional_libs`) of the `fabr_plugin`
   * target `target`, as includes of the file declaring it, once per target and
   * property. A value that substitutes or holds a `:` is reported, as is each
   * splice in the target's body, once per target.
   */
  private libsOf(target: ITargetDecl, property: string): ComputableSource<IncludedFiles> {
    let byProperty = this.libs.get(target);
    let spliced = 0;
    if (byProperty === undefined) {
      byProperty = new Map();
      this.libs.set(target, byProperty);
      /* Report each splice in the body: the body is read before anything is built. */
      const splices = target.properties.filter((item): item is ISpliceDecl => !isPropertyDecl(item));
      splices.forEach(splice => this.execution.log.log(DIAG_PLUGIN_SPLICE, { name: splice.ref.toString(), loc: declPosn(splice) }));
      spliced = splices.length;
    }
    let resolved = byProperty.get(property);
    if (resolved === undefined) {
      const values = target.properties
        .filter(isPropertyDecl)
        .filter(prop => prop.name.toBaseString() === property)
        .flatMap(prop => prop.values.filter((value): value is INameValue => value.kind === DeclKind.NameValue));
      resolved = Computable.forAll(
        [
          Computable.resolve({ files: [], errors: spliced }),
          ...values.map(value => {
            if (value.value.hasVarSubst() || value.value.hasLevelSeparator()) {
              this.execution.log.log(DIAG_PLUGIN_LIBS, { loc: declPosn(value) });
              return Computable.resolve({ files: [], errors: 1 });
            }
            return this.includedFiles(target.source.fs, target.source.file, { ...value, kind: DeclKind.Include, name: value.value });
          }),
        ],
        (...each: IncludedFiles[]) => ({
          files: each.flatMap(one => one.files),
          errors: each.reduce((total, one) => total + one.errors, 0),
        })
      );
      byProperty.set(property, resolved);
    }
    return resolved;
  }
}

/**
 * Load the project's build files, from `startFile`, into a BuildModel. The
 * model is made in rounds: the project's files and core's (`core`, STD.fabr by
 * default) first, then each round the `.fabr` files of the plugins the files
 * so far use. A `plugin <name>;` is resolved, as a reference in the model so
 * far, once the root of its name is declared there, and waits until it is. An
 * `include <package>:<path>;` of one of a plugin's `optional_libs` is resolved
 * once the plugin whose package it names is added. Loading ends with the round
 * that resolves none.
 *
 * A plugin's own files, its optional libs among them, may declare only
 * defaults, and no `fabr_plugin`. Loading builds nothing: a `fabr_plugin`'s
 * code is built, under `run` for `host`, the first time a rule or repository it
 * implements is used. Rejects as {@link ModelBuilder.finish} throws, where
 * anything read holds an error.
 */
export function loadProject(
  execution: ExecutionContext,
  startFile: string,
  /* Core's contribution. A test passes a stub: under ts-jest the package
   * resolves to src/, beside which there is no lib/. */
  core: PluginContribution = coreContribution(),
  host: Constraints = Constraints.of({}),
  options: ILoadOptions = {}
): Computable<BuildModel> {
  return new ProjectLoader(execution, startFile, core, host, options).load();
}

/** How {@link loadProject} reads a project. */
export interface ILoadOptions {
  /** Read every optional lib of each plugin the project uses, as though the
   * project included it. */
  includeOptionalLibs?: boolean;
}
