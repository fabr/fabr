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

import { Computable } from "../core/Computable";
import { Diagnostic, ErrorTrackingLog, IDiagnosticNote, ISourceSpan, LogLevel } from "../support/Log";
import { BuildFilesInvalidError } from "./Errors";
import { StringReader } from "../support/StringReader";
import { parseBuildFile } from "./Parser";
import { declPosn, IBuildFileContents, IIncludeDecl, IPluginDecl } from "./AST";
import { BuildModel } from "./BuildModel";
import { ExecutionContext } from "./ExecutionContext";
import { activatePlugin } from "./Plugin";
import { toBuildModel } from "./Sema";
import { PluginContribution } from "../rules/Types";
import { flagRule } from "../rules/FlagTarget";
import { defaultFilesRule } from "../rules/DefaultFilesRule";
import { scriptRunRule } from "../rules/RunScript";
import { serveRunRule } from "../rules/RunServe";
import { generateRule } from "../rules/BuildGenerate";
import { syncFilesRule, syncRule } from "../rules/BuildSync";
import { catalogRepositoryRegistration } from "../rules/CatalogRepository";
import { computableWorkList } from "../core/WorkList";
import { select } from "../support/Functional";

/** An `include`d file could not be found on disk, positioned at the offending
 * `include` decl so the report underlines it (with a `-->` back to the file that
 * wrote the include) rather than emitting a bare, unattributed path. */
const DIAG_INCLUDE_NOT_FOUND = new Diagnostic<{ filename: string; loc: ISourceSpan }>(
  LogLevel.Error,
  "Included file not found: {filename}"
);

/** A `plugin <name>;` whose activation failed (not installed, no `activate()`,
 * or `activate()` threw) — positioned at the declaration, with the underlying
 * reason as its detail. */
const DIAG_PLUGIN_ACTIVATION = new Diagnostic<{ detail: string; loc: ISourceSpan }>(
  LogLevel.Error,
  "{detail}"
);

/**
 * Core's own contribution to every build: the generic bootstrap rules (flag,
 * files, script[run], serve[run], generate) and STD.fabr, which is therefore **always present** —
 * no explicit `include STD.fabr;` needed. Seeds every load before any plugin.
 */
export function coreContribution(): PluginContribution {
  return {
    rules: [flagRule, defaultFilesRule, scriptRunRule, serveRunRule, generateRule, syncRule, syncFilesRule],
    repositories: [catalogRepositoryRegistration],
    includes: [packageLibFile("@fabr-build/core", "STD.fabr")],
  };
}

/**
 * @return the lib/ directory of an installed package, located next to the
 * package's ENTRY POINT — i.e. within the built package content, never the
 * source tree. The devchain copies lib/ into build/ beside the compiled
 * output (scripts/copylibs.js); a fabr-built package has its entry point and
 * lib/ together at the package root.
 */
export function packageLibDir(packageName: string): string {
  return path.join(path.dirname(require.resolve(packageName)), "lib");
}

/** @return the absolute path of a `.fabr` file in an installed package's lib/,
 * for a plugin (or core) to name in its contribution's `includes`. */
export function packageLibFile(packageName: string, file: string): string {
  return path.join(packageLibDir(packageName), file);
}

/* A work-list key is a bare file path: which source reads it rides on the name's
 * shape, per the naming contract — project files are named relative to the project
 * source's root (the entry file is, and file-relative include resolution keeps it
 * that way), while plugin/core lib files are absolute ({@link packageLibFile}). */

/** Resolve an include relative to its including file — join, not resolve, so a
 * relative (project) file's includes stay relative, anchored at the source root
 * rather than the process cwd. Absolute include paths are rejected at parse; a
 * project file's include is additionally confined to the project tree (a lib
 * file's includes resolve within its installed package, which activation
 * already vouches for). */
function resolveInclude(file: string, include: IIncludeDecl): string {
  const target = path.join(path.dirname(file), include.filename);
  if (!path.isAbsolute(file) && (target === ".." || target.startsWith(".." + path.sep))) {
    throw new Error(`Invalid include '${include.filename}' in ${file}: outside the project tree`);
  }
  return target;
}

/** The trail of `include`s that reached the file `site` lives in — one `note:`
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

/** One loaded build file: its parsed decls, the contribution of each plugin it
 * declares — carried on the value so collation gathers exactly the plugins that
 * are still declared by some reachable file — and its error count (parsing
 * recovers past errors rather than throwing, and a missing `include` target is
 * reported the same way, so the count rides on the value to flow through the
 * reactive graph: memoized per file, re-counted only when that file re-parses). */
interface LoadedFile {
  decls: IBuildFileContents;
  plugins: PluginContribution[];
  parseErrors: number;
}

/** The empty decl set for a file that failed to load (a missing include): it
 * contributes no decls, plugins, or further includes, only its logged error. */
const NO_DECLS: IBuildFileContents = {
  namespaces: [],
  targets: [],
  targetdefs: [],
  properties: [],
  defaults: [],
  includes: [],
  plugins: [],
};

/**
 * Load and collate the project's build files into a BuildModel. Core is always
 * present (its rules and STD.fabr); a `plugin <name>;` declaration activates the
 * plugin, auto-including its `.fabr` files and contributing its rules/repos. The
 * collected contributions become the model's rule tables, so rule selection is
 * per-model rather than process-global.
 */
export function loadProject(
  execution: ExecutionContext,
  startFile: string,
  /* The always-present base contribution — core's rules + STD.fabr. A parameter
   * (defaulting to the real thing) only so tests can substitute a stub whose
   * `includes` don't point at a real on-disk lib/ (unavailable under ts-jest,
   * where the package resolves to src/, not the built tree). */
  core: PluginContribution = coreContribution()
): Computable<BuildModel> {
  const contributions = new Map<string, PluginContribution>();
  const activate = (decl: IPluginDecl): PluginContribution => {
    let contribution = contributions.get(decl.name);
    if (contribution === undefined) {
      contribution = activatePlugin(decl);
      contributions.set(decl.name, contribution);
    }
    return contribution;
  };
  const libFiles = (contribution: PluginContribution): string[] => contribution.includes ?? [];
  /* The `include` decl that first pulled in each reached path, so a file that
   * fails to load can be attributed to the include that named it (the work-list
   * keys only on the path, losing the site otherwise). First writer wins — one
   * positioned diagnostic per missing file is enough. */
  const includeSites = new Map<string, IIncludeDecl>();

  return computableWorkList<string, LoadedFile>([startFile, ...libFiles(core)], file => {
    const fs = path.isAbsolute(file) ? execution.absFileSource : execution.sourceFileSource;
    return fs.get(file).then(f => {
      if (!f) {
        /* An include naming a missing file is a build-file error like any parse
         * failure: report it positioned at the include and count it (so the load
         * halts via BuildFilesInvalidError below), rather than a bare unattributed
         * path. A missing seed/plugin-lib file has no include site — that stays a
         * hard error (no project, or a broken installed plugin). */
        const site = includeSites.get(file);
        if (!site) {
          throw new Error("File not found: " + file);
        }
        execution.log.log(DIAG_INCLUDE_NOT_FOUND, {
          filename: site.filename,
          loc: declPosn(site),
          notes: includeChain(includeSites, site),
        });
        return { value: { decls: NO_DECLS, plugins: [], parseErrors: 1 }, next: [] };
      }
      return f.readString().then(content => {
        /* Parsing logs each error and recovers rather than throwing, so count
         * error diagnostics through a wrapper to know if this file parsed cleanly. */
        const parseLog = new ErrorTrackingLog(execution.log);
        const decls = parseBuildFile({ fs, file, reader: new StringReader(content) }, parseLog);
        /* Activation can fail (plugin not installed, no `activate()`, or it
         * threw); report it positioned at the declaration and drop the plugin,
         * counting it as a load error (halts the load like a parse error) rather
         * than letting a bare, unpositioned Error escape. */
        let pluginErrors = 0;
        const plugins = select(decls.plugins, decl => {
          try {
            return activate(decl);
          } catch (err) {
            execution.log.log(DIAG_PLUGIN_ACTIVATION, {
              detail: err instanceof Error ? err.message : String(err),
              loc: declPosn(decl),
            });
            pluginErrors++;
            return undefined;
          }
        });
        const includes = decls.includes.map(include => {
          const target = resolveInclude(file, include);
          if (!includeSites.has(target)) {
            includeSites.set(target, include);
          }
          return target;
        });
        return {
          value: { decls, plugins, parseErrors: parseLog.errorCount + pluginErrors },
          next: [...includes, ...plugins.flatMap(libFiles)],
        };
      });
    });
  }).then(loaded => {
    const files = [...loaded.values()];
    /* Identity-dedup suffices: activation memoized by name ⇒ one instance per plugin. */
    const plugins = [...new Set(files.flatMap(file => file.plugins))];
    /* Collation/validation likewise reports diagnostics rather than throwing;
     * count them too, then fail the load as a whole if the build files held any
     * error — a parse error in any file, or a sema/validation error here. The
     * model is not sound, so the run must stop rather than build against it (in
     * watch mode: leave the previous model resident). Every error has already
     * been reported to the log; the rejection just halts. */
    const modelLog = new ErrorTrackingLog(execution.log);
    const model = toBuildModel(files.map(file => file.decls), modelLog, [core, ...plugins]);
    const errorCount = files.reduce((total, file) => total + file.parseErrors, 0) + modelLog.errorCount;
    if (errorCount > 0) {
      throw new BuildFilesInvalidError(errorCount);
    }
    return model;
  });
}
