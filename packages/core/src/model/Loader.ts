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

import * as path from "path";

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
import { BuildCache } from "../core/BuildCache";

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

const systemIncludeDirs: ISystemIncludeDir[] = [];

/**
 * Register a directory on the system include path. Called by each rule
 * package as it loads — the bootstrap packages on import, plugins on
 * activation — so registration order (= load order) is the search order.
 */
export function registerSystemIncludeDir(dir: string): void {
  if (!systemIncludeDirs.some(entry => entry.dir === dir)) {
    systemIncludeDirs.push({ dir, fs: new FSFileSource(dir) });
  }
}

/**
 * @return the lib/ directory of an installed package, located from the
 * package root so the result is independent of the package's build shape
 * (workspace symlink, npm installation, or fabr-built package).
 */
export function packageLibDir(packageName: string): string {
  return path.join(path.dirname(require.resolve(`${packageName}/package.json`)), "lib");
}

type BuildFiles = Record<string, IBuildFileContents>;
const loadBuildCache: Record<string, Computable<BuildFiles>> = {};

/** The ambient inputs threaded through the recursive build-file load */
interface ILoadContext {
  systemPath: ISystemIncludeDir[];
  pluginApi: unknown;
  log: Log;
}

/* FIXME: Detect cycles? */
function loadBuildFile(fs: FileSource, file: string, context: ILoadContext): Computable<BuildFiles> {
  if (!(file in loadBuildCache)) {
    loadBuildCache[file] = fs.get(file).then(f => {
      if (!f) {
        throw new Error("File not found: " + file);
      }
      return f.readString().then(content => {
        const source = { fs, file, reader: new StringReader(content) };
        const decls = parseBuildFile(source, context.log);
        /* Plugins activate before include resolution, so the include
         * directories they register are searchable immediately — including
         * by this very file's own includes */
        activatePlugins(decls.plugins, context.pluginApi);
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
  return loadBuildCache[file];
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
 * Load and collate the project's build files into a BuildModel. Declared
 * plugins are activated (with the given api object) as their declarations are
 * parsed, so plugin-registered rules and include directories are in effect
 * for the rest of the load and for target resolution.
 */
export function loadProject(
  fileSource: FileSource,
  startFile: string,
  buildCache: BuildCache,
  log: Log,
  pluginApi?: unknown,
  systemIncludePath: ISystemIncludeDir[] = systemIncludeDirs
): Computable<BuildModel> {
  return loadBuildFile(fileSource, startFile, { systemPath: systemIncludePath, pluginApi, log }).then(decls =>
    toBuildModel(Object.values(decls), buildCache, log)
  );
}
