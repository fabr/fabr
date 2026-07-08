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
import { FSFileSource } from "../core/FSFileSource";
import { StringReader } from "../support/StringReader";
import { parseBuildFile } from "./Parser";
import { IBuildFileContents, IIncludeDecl } from "./AST";
import { Log } from "../support/Log";
import { BuildModel } from "./BuildModel";
import { activatePlugins } from "./Plugin";
import { toBuildModel } from "./Sema";
import { FileSource } from "../core/FileSet";
import { PluginContribution } from "../rules/Types";
import { flagRule } from "../rules/FlagTarget";
import { defaultFilesRule } from "../rules/DefaultFilesRule";
import { scriptRunRule } from "../rules/RunScript";
import { runRule } from "../rules/BuildRun";

/**
 * A directory on the system include path: bare include names (`include
 * JS.fabr;` — no '/' in the name) resolve against these directories, in
 * order, before falling back to the including file's own directory.
 */
export interface ISystemIncludeDir {
  /** Absolute path of the directory (identity for caching and diagnostics) */
  dir: string;
  fs: FileSource;
}

/**
 * Core's own contribution to every build: the generic bootstrap rules (flag,
 * files, script[run], run) and core's lib/ (STD.fabr) on the system include
 * path. This seeds the registry and include path of every load, before any
 * plugin; plugins contribute the rest via their `activate()`.
 */
export function coreContribution(): PluginContribution {
  return {
    rules: [flagRule, defaultFilesRule, scriptRunRule, runRule],
    includeDirs: [packageLibDir("@fabr/core")],
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

type BuildFiles = Record<string, IBuildFileContents>;

/**
 * The ambient inputs threaded through the recursive build-file load. All mutable
 * state here is PER-LOAD, never process-global: `systemPath` and `contributions`
 * grow as plugins activate, and `loadCache` dedupes a file included from several
 * places within THIS load only — so each load re-parses and re-activates against
 * its own fresh registry (a plugin removed since the last load simply isn't
 * present).
 */
interface ILoadContext {
  systemPath: ISystemIncludeDir[];
  /** Contributions gathered so far — core first, then plugins in activation order. */
  contributions: PluginContribution[];
  /** Plugins already activated this load (a plugin declared from several files activates once). */
  activated: Set<string>;
  /** Per-load parse memo (dedupes a diamond include within one load). */
  loadCache: Record<string, Computable<BuildFiles>>;
  pluginApi: unknown;
  log: Log;
}

/* FIXME: Detect cycles? */
function loadBuildFile(fs: FileSource, file: string, context: ILoadContext): Computable<BuildFiles> {
  if (!(file in context.loadCache)) {
    context.loadCache[file] = fs.get(file).then(f => {
      if (!f) {
        throw new Error("File not found: " + file);
      }
      return f.readString().then(content => {
        const source = { fs, file, reader: new StringReader(content) };
        const decls = parseBuildFile(source, context.log);
        /* Plugins activate before include resolution: merge each newly-activated
         * plugin's contribution and add its include directories to the search
         * path, so this very file's own includes can resolve against them. */
        for (const contribution of activatePlugins(decls.plugins, context.pluginApi, context.activated)) {
          context.contributions.push(contribution);
          for (const dir of contribution.includeDirs ?? []) {
            if (!context.systemPath.some(entry => entry.dir === dir)) {
              context.systemPath.push({ dir, fs: new FSFileSource(dir) });
            }
          }
        }
        if (decls.includes.length === 0) {
          return { [file]: decls };
        }
        return Computable.forAll(
          decls.includes.map(include => resolveInclude(include, file, fs, context)),
          (...children) => {
            const result: BuildFiles = { [file]: decls };
            children.forEach(child => Object.assign(result, child));
            return result;
          }
        );
      });
    });
  }
  return context.loadCache[file];
}

/**
 * Resolve and load one include: a bare name tries the system include path
 * first and falls back to the including file's directory; a name containing a
 * path separator is relative to the including file only.
 */
function resolveInclude(include: IIncludeDecl, baseFile: string, baseFs: FileSource, context: ILoadContext): Computable<BuildFiles> {
  const relative = path.resolve(path.dirname(baseFile), include.filename);
  if (include.filename.includes("/")) {
    return loadBuildFile(baseFs, relative, context);
  }
  return findOnSystemPath(include.filename, context.systemPath, 0).then(found =>
    found ? loadBuildFile(found.fs, found.file, context) : loadBuildFile(baseFs, relative, context)
  );
}

/** Probe the system include directories in order for the given bare name */
function findOnSystemPath(
  filename: string,
  systemPath: ISystemIncludeDir[],
  index: number
): Computable<{ fs: FileSource; file: string } | undefined> {
  if (index >= systemPath.length) {
    return Computable.resolve(undefined);
  }
  const entry = systemPath[index];
  const file = path.join(entry.dir, filename);
  return entry.fs.get(file).then(
    found => (found ? { fs: entry.fs, file } : findOnSystemPath(filename, systemPath, index + 1)),
    /* A missing file may also surface as a rejection (e.g. FSFileSource) */
    () => findOnSystemPath(filename, systemPath, index + 1)
  );
}

/**
 * Load and collate the project's build files into a BuildModel. The load starts
 * from core's contribution (its rules + lib/ include dir); declared plugins are
 * activated (with the given api object) as their declarations are parsed, each
 * contributing its rules and include directories for the rest of the load. The
 * collected contributions become the model's rule tables, so rule selection is
 * per-model rather than process-global. `systemIncludePath` supplies any extra
 * include directories (for tests), searched after core's.
 */
export function loadProject(
  fileSource: FileSource,
  startFile: string,
  log: Log,
  pluginApi?: unknown,
  systemIncludePath?: ISystemIncludeDir[]
): Computable<BuildModel> {
  const core = coreContribution();
  /* The base include path is core's lib/ dir; a caller-supplied path replaces it
   * (tests), while core's RULES are contributed to the registry regardless.
   * Plugin include dirs are appended to whichever base as plugins activate. */
  const context: ILoadContext = {
    systemPath: systemIncludePath ?? (core.includeDirs ?? []).map(dir => ({ dir, fs: new FSFileSource(dir) })),
    contributions: [core],
    activated: new Set(),
    loadCache: {},
    pluginApi,
    log,
  };
  return loadBuildFile(fileSource, startFile, context).then(decls =>
    toBuildModel(Object.values(decls), log, context.contributions)
  );
}
