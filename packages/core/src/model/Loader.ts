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
import { Diagnostic, ErrorTrackingLog, IDiagnosticNote, ISourceSpan, LogLevel } from "../support/Log";
import { StringReader } from "../support/StringReader";
import { parseBuildFile } from "./Parser";
import { DeclKind, declPosn, IBuildFileContents, IIncludeDecl, INameValue, ITargetDecl } from "./AST";
import { BuildModel } from "./BuildModel";
import { ModelBuilder } from "./ModelBuilder";
import { ExecutionContext } from "./ExecutionContext";
import { PluginResolution, resolvePlugin } from "./Plugin";
import { PluginContribution } from "../rules/Types";
import { computableWorkList } from "../core/WorkList";
import { FabrError } from "../core/Errors";
import { Constraints } from "./Constraints";

/** An `include`d file could not be found on disk, positioned at the offending
 * `include` decl so the report underlines it (with a `-->` back to the file that
 * wrote the include) rather than emitting a bare, unattributed path. */
const DIAG_INCLUDE_NOT_FOUND = new Diagnostic<{ filename: string; loc: ISourceSpan }>(
  LogLevel.Error,
  "Included file not found: {filename}"
);

/** The pattern form of the same rule: an `include` must name at least one file,
 * so a pattern that currently matches none is an error against its decl. */
const DIAG_INCLUDE_NO_MATCH = new Diagnostic<{ filename: string; loc: ISourceSpan }>(
  LogLevel.Error,
  "Included files not found: {filename} matched nothing"
);

/** An `include` resolving outside the project tree, positioned at the offending
 * decl (with a `-->` back through the include chain that reached it). */
const DIAG_INCLUDE_OUTSIDE = new Diagnostic<{ filename: string; loc: ISourceSpan }>(
  LogLevel.Error,
  "Included file not found: {filename} (outside the project tree)"
);

/** A `fabr_plugin` target's `libs` value that is not a path or pattern beside it. */
const DIAG_PLUGIN_LIBS = new Diagnostic<{ loc: ISourceSpan }>(
  LogLevel.Error,
  "A plugin's libs are paths or patterns relative to the file declaring it, as an include's are"
);

/**
 * Core's own contribution to every build: STD.fabr, which is therefore **always
 * present** — no explicit `include STD.fabr;` needed — and which declares core's
 * rules and repository types. Seeds every load before any plugin.
 */
export function coreContribution(): PluginContribution {
  /* This module is in model/, beside core's entry point. */
  return { includes: [getLibFile(path.dirname(__dirname), "STD.fabr")] };
}

/**
 * @return the absolute path of `file` in the lib/ directory beside a package's
 * entry point, which is in `entryDir`: for a plugin to name its `.fabr` files
 * in its contribution's `includes`, passing its entry module's `__dirname`.
 * Found relative to the code asking, so a plugin built in the project finds
 * its own files, not an installed copy's. The devchain copies lib/ into
 * build/ beside the compiled output (scripts/copylibs.js); a fabr-built
 * package has its entry point and lib/ together at the package root.
 */
export function getLibFile(entryDir: string, file: string): string {
  return path.join(entryDir, "lib", file);
}

/* A work-list key is a bare file path: which source reads it rides on the name's
 * shape, per the naming contract — project files are named relative to the project
 * source's root (the entry file is, and file-relative include resolution keeps it
 * that way), while plugin/core lib files are absolute ({@link getLibFile}). */

/** @return true if a path an include resolved to has climbed out of the project
 * tree, otherwise false. A project file's includes are held to the tree; a lib
 * file's are not (they resolve within its installed package, which activation
 * vouches for). */
function escapesTree(file: string, target: string): boolean {
  return !path.isAbsolute(file) && (target === ".." || target.startsWith(".." + path.sep));
}

/** An include's name resolved for matching against the source. */
interface ResolvedIncludeName {
  /** The pattern to match, re-rooted at the including file's directory. */
  pattern: Name;
  /** The one path a plain include names, if it is one. `find` also expands a
   * non-glob name that turns out to be a *directory* into everything beneath it
   * — files an include must not swallow (it would parse them all as build
   * scripts), so a plain include keeps only its exact path and reports the
   * directory as the missing file it is. */
  exact?: string;
}

/**
 * Resolve an include's name relative to its including file — join, not resolve,
 * so a relative (project) file's includes stay relative, anchored at the source
 * root rather than the process cwd. A plain path joins whole; a pattern joins its
 * literal head and carries its glob tail along, which is what puts the *base* the
 * walk starts from under the same containment check the plain path faces.
 *
 * Absolute include paths are rejected at parse; a project file's include is
 * additionally confined to the project tree (a lib file's includes resolve within
 * its installed package, which activation already vouches for) — `undefined` for
 * one that climbs out, reported by the caller against the decl.
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

/** Render the trail of `include`s that reached the file `site` lives in — one `note:`
 * per hop, walking parent-to-root through the discovering-include map, so a
 * failure deep in an include chain (`A included from B included from C…`) shows
 * the whole path back to the project file, not just its immediate includer.
 * Cycle-guarded (an include cycle keeps every file on it present, but a missing
 * file reached *through* one could otherwise loop the walk). */
function includeChain(sites: ReadonlyMap<string, IIncludeDecl>, site: IIncludeDecl): IDiagnosticNote[] {
  const notes: IDiagnosticNote[] = [];
  const seen = new Set<string>();
  for (let parent = sites.get(site.source.file); parent && !seen.has(parent.source.file); ) {
    seen.add(parent.source.file);
    notes.push({ message: "included from here", loc: declPosn(parent) });
    parent = sites.get(parent.source.file);
  }
  return notes;
}

/** The files one `include` decl names, and the errors reporting it produced. */
interface IncludedFiles {
  files: string[];
  errors: number;
}

/** One loaded build file: its parsed decls and its error count (parsing
 * recovers past errors rather than throwing, and a missing `include` target is
 * reported the same way, so the count rides on the value to flow through the
 * reactive graph: memoized per file, re-counted only when that file re-parses). */
interface LoadedFile {
  /** The file's work-list key: relative to the project's root for a project file, absolute for a lib file. */
  file: string;
  decls: IBuildFileContents;
  parseErrors: number;
}

/** The empty decl set for a file an include matched but which was gone by the
 * time it was read: it contributes no decls, plugins, or further includes, and
 * logs nothing. */
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

/** One round of a load: the files it read, a plugin's where `fromPlugin`, and what the plugins they made ready resolved to. */
interface Round {
  files: LoadedFile[];
  fromPlugin: boolean;
  plugins: PluginResolution[];
}

/**
 * Reads a project's build files, and the files of the plugins they use, into a
 * model. What it reads is kept across loads, so a load made again under watch
 * neither re-reads nor re-reports a file that has not changed.
 */
class ProjectLoader {
  /** The `include` decl that first pulled in each reached path, so a file that
   * fails to load can be attributed to the include that named it (the work-list
   * keys only on the path, losing the site otherwise). First writer wins — one
   * positioned diagnostic per missing file is enough. */
  private readonly includeSites = new Map<string, IIncludeDecl>();
  /** Each file's load. */
  private readonly steps = new Map<string, ComputableSource<{ value: LoadedFile; next: string[] }>>();
  /** Each `fabr_plugin` target's `libs`, resolved, by its declaration. */
  private readonly libs = new Map<ITargetDecl, ComputableSource<IncludedFiles>>();

  constructor(
    private readonly execution: ExecutionContext,
    private readonly startFile: string,
    private readonly core: PluginContribution,
    private readonly host: Constraints
  ) {}

  /**
   * Load the model: read the project's files and core's, then, each round,
   * resolve every plugin whose name's root is now declared and read the files
   * those add, until a round resolves none.
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
      const model = this.modelOf([...previous, { files, fromPlugin, plugins: [] }]);
      const ready = model.pendingPlugins().flatMap(decl => {
        const match = model.getPrefixMatch(decl.name);
        return match === undefined ? [] : [{ decl, match }];
      });
      if (ready.length === 0) {
        return model.finish();
      }
      return Computable.forAll(
        ready.map(({ decl, match }) =>
          resolvePlugin(model, decl, match, { execution: this.execution, host: this.host, libsOf: target => this.libsOf(target) })
        ),
        (...plugins: PluginResolution[]) => plugins
      ).then(plugins => {
        const added = plugins.flatMap(({ resolved }) => (resolved instanceof Error ? [] : resolved.files));
        return this.round([...previous, { files, fromPlugin, plugins }], [...new Set(added)], true);
      });
    });
  }

  /** Make the model of `rounds`: each round's files, a file reached again added once, then the plugins it resolved, in name order. */
  private modelOf(rounds: Round[]): ModelBuilder {
    const model = new ModelBuilder(this.execution.log, [this.core]);
    const read = new Set<string>();
    for (const { files, fromPlugin, plugins } of rounds) {
      const fresh = files.filter(file => !read.has(file.file) && read.add(file.file));
      model.addFiles(
        fresh.map(file => file.decls),
        { fromPlugin, reported: fresh.reduce((total, file) => total + file.parseErrors, 0) }
      );
      for (const { decl, resolved, reported } of plugins) {
        model.addPlugin(decl, resolved, reported);
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
        /* Every included file got here by matching its include, which reports the
         * match naming nothing; a file gone by the time we read it is therefore a
         * race (deleted since), not a missing include — contribute nothing and stay
         * silent, leaving that include's own re-resolution to report if it now
         * names nothing at all. A seed/plugin-lib file has no include site — that
         * stays a hard error (no project, or a broken installed plugin). */
        if (!this.includeSites.has(file)) {
          throw new FabrError("File not found: " + file);
        }
        return { value: { file, decls: NO_DECLS, parseErrors: 0 }, next: [] };
      }
      return f.readString().then(content => {
        /* Parsing logs each error and recovers rather than throwing, so count
         * error diagnostics through a wrapper to know if this file parsed cleanly. */
        const parseLog = new ErrorTrackingLog(this.execution.log);
        const decls = parseBuildFile({ fs, file, reader: new StringReader(content) }, parseLog);
        /* Each include resolves to the files it names — one path for a plain
         * include, however many currently match for a pattern (a live query, so
         * this file's step re-resolves when the set changes). */
        const included = decls.includes.map(include => this.includedFiles(fs, file, include));
        return Computable.forAll(included, (...resolved) => ({
          value: { file, decls, parseErrors: parseLog.errorCount + resolved.reduce((total, one) => total + one.errors, 0) },
          next: resolved.flatMap(one => one.files),
        }));
      });
    });
    this.steps.set(file, step);
    return step;
  }

  /**
   * Resolve one `include` decl to the build files it names — the one place an
   * include's files are decided, plain path and pattern alike, since both are just
   * a match against the source.
   *
   * **An include must name at least one file**: a plain path that is not there and a
   * pattern that matches nothing are the same error, reported here (against the
   * decl, which is where the name was written) rather than at the read. So a file
   * that vanishes *between* this match and its read is nobody's error — the match is
   * already re-resolving, and reports again if it now names nothing.
   *
   * The match set is a **live query** over the source tree, so under watch a file
   * appearing or disappearing beneath a pattern re-resolves the including file's
   * step, and the work-list picks the file up (or drops it) exactly as if the
   * include had been edited to name it. Matches are returned in canonical order — a
   * build's meaning must not depend on the order a directory walk handed them back.
   */
  private includedFiles(fs: FileSource, file: string, include: IIncludeDecl): ComputableSource<IncludedFiles> {
    const resolved = resolveIncludeName(file, include);
    if (resolved === undefined) {
      /* An include climbing out of the project tree is dropped and reported
       * against its decl, like a missing one. */
      return Computable.resolve(this.includeFailed(DIAG_INCLUDE_OUTSIDE, include));
    }
    /* Matches come back named in the source's own namespace, which is the work-list's
     * key form for a project file. A lib file's key is its absolute path, and no
     * FileSet name can be absolute (they are canonicalized relative), so restore the
     * separator the "/"-rooted absolute source names its results without. */
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

  /** Resolve the `libs` of the `fabr_plugin` target `target`, as includes of the file declaring it. */
  private libsOf(target: ITargetDecl): ComputableSource<IncludedFiles> {
    let resolved = this.libs.get(target);
    if (resolved === undefined) {
      const values = target.properties
        .filter(prop => prop.name.toBaseString() === "libs")
        .flatMap(prop => prop.values.filter((value): value is INameValue => value.kind === DeclKind.NameValue));
      resolved = Computable.forAll(
        values.map(value => {
          if (value.value.hasVarSubst() || value.value.hasLevelSeparator()) {
            this.execution.log.log(DIAG_PLUGIN_LIBS, { loc: declPosn(value) });
            return Computable.resolve({ files: [], errors: 1 });
          }
          return this.includedFiles(target.source.fs, target.source.file, { ...value, kind: DeclKind.Include, name: value.value });
        }),
        (...each: IncludedFiles[]) => ({
          files: each.flatMap(one => one.files),
          errors: each.reduce((total, one) => total + one.errors, 0),
        })
      );
      this.libs.set(target, resolved);
    }
    return resolved;
  }
}

/**
 * Load and collate the project's build files into a BuildModel. Core is always
 * present (STD.fabr). The model is made in rounds: the project's files and
 * core's first, then, each round, the `.fabr` files of the plugins the files
 * so far use. A `plugin <name>;` is resolved as a reference in the model as it
 * stands once the root of its name is declared there, and waits for a later
 * round until it is; loading ends with the round that resolves none. A
 * plugin's own files may declare only defaults, and no `fabr_plugin`, so
 * nothing they add changes what an earlier round read. Nothing is built to load the model: a
 * `fabr_plugin`'s code is built, under `run` for `host`, the first time a rule
 * or repository it implements is used.
 */
export function loadProject(
  execution: ExecutionContext,
  startFile: string,
  /* The always-present base contribution — core's STD.fabr. A parameter
   * (defaulting to the real thing) only so tests can substitute a stub whose
   * `includes` don't point at a real on-disk lib/ (unavailable under ts-jest,
   * where the package resolves to src/, not the built tree). */
  core: PluginContribution = coreContribution(),
  host: Constraints = Constraints.of({})
): Computable<BuildModel> {
  return new ProjectLoader(execution, startFile, core, host).load();
}
