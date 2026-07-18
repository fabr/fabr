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
import { StringReader } from "../support/StringReader";
import { parseBuildFile } from "./Parser";
import { IBuildFileContents, IIncludeDecl, IPluginDecl } from "./AST";
import { BuildModel } from "./BuildModel";
import { ExecutionContext } from "./ExecutionContext";
import { activatePlugin } from "./Plugin";
import { toBuildModel } from "./Sema";
import { PluginContribution } from "../rules/Types";
import { flagRule } from "../rules/FlagTarget";
import { defaultFilesRule } from "../rules/DefaultFilesRule";
import { scriptRunRule } from "../rules/RunScript";
import { runRule } from "../rules/BuildRun";
import { syncFilesRule, syncRule } from "../rules/BuildSync";
import { catalogRepositoryRegistration } from "../rules/CatalogRepository";
import { computableWorkList } from "../core/WorkList";

/**
 * Core's own contribution to every build: the generic bootstrap rules (flag,
 * files, script[run], run) and STD.fabr, which is therefore **always present** —
 * no explicit `include STD.fabr;` needed. Seeds every load before any plugin.
 */
export function coreContribution(): PluginContribution {
  return {
    rules: [flagRule, defaultFilesRule, scriptRunRule, runRule, syncRule, syncFilesRule],
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

/** One loaded build file: its parsed decls, plus the contribution of each plugin
 * it declares — carried on the value so collation gathers exactly the plugins
 * that are still declared by some reachable file. */
interface LoadedFile {
  decls: IBuildFileContents;
  plugins: PluginContribution[];
}

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
  pluginApi?: unknown,
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
      contribution = activatePlugin(decl, pluginApi);
      contributions.set(decl.name, contribution);
    }
    return contribution;
  };
  const libFiles = (contribution: PluginContribution): string[] => contribution.includes ?? [];

  return computableWorkList<string, LoadedFile>([startFile, ...libFiles(core)], file => {
    const fs = path.isAbsolute(file) ? execution.absFileSource : execution.sourceFileSource;
    return fs.get(file).then(f => {
      if (!f) {
        throw new Error("File not found: " + file);
      }
      return f.readString().then(content => {
        const decls = parseBuildFile({ fs, file, reader: new StringReader(content) }, execution.log);
        const plugins = decls.plugins.map(activate);
        return {
          value: { decls, plugins },
          next: [...decls.includes.map(include => resolveInclude(file, include)), ...plugins.flatMap(libFiles)],
        };
      });
    });
  }).then(loaded => {
    const files = [...loaded.values()];
    /* Identity-dedup suffices: activation memoized by name ⇒ one instance per plugin. */
    const plugins = [...new Set(files.flatMap(file => file.plugins))];
    return toBuildModel(files.map(file => file.decls), execution.log, [core, ...plugins]);
  });
}
