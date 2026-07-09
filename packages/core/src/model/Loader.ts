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
import { IBuildFileContents } from "./AST";
import { Log } from "../support/Log";
import { BuildModel } from "./BuildModel";
import { activatePlugin } from "./Plugin";
import { toBuildModel } from "./Sema";
import { FileSource } from "../core/FileSet";
import { PluginContribution } from "../rules/Types";
import { flagRule } from "../rules/FlagTarget";
import { defaultFilesRule } from "../rules/DefaultFilesRule";
import { scriptRunRule } from "../rules/RunScript";
import { runRule } from "../rules/BuildRun";

/**
 * Core's own contribution to every build: the generic bootstrap rules (flag,
 * files, script[run], run) and STD.fabr, which is therefore **always present** —
 * no explicit `include STD.fabr;` needed. Seeds every load before any plugin.
 */
export function coreContribution(): PluginContribution {
  return {
    rules: [flagRule, defaultFilesRule, scriptRunRule, runRule],
    includes: [packageLibFile("@fabr/core", "STD.fabr")],
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

type BuildFiles = Record<string, IBuildFileContents>;

/**
 * Ambient inputs threaded through the recursive load. The only state is the
 * per-load parse memo (dedupes a diamond include within one load); its persisted,
 * revalidating form is where incremental reparse-on-reload will live.
 */
interface ILoadContext {
  loadCache: Record<string, Computable<BuildFiles>>;
  pluginApi: unknown;
  log: Log;
}

/** A `.fabr` file to load, with the FileSource to read it from. */
interface FileRef {
  fs: FileSource;
  file: string;
}

/** A FileSource for reading absolute paths — plugin/core lib `.fabr` files, named
 * absolutely in a contribution's `includes` (project files use their own source).
 * `get(absPath)` resolves to `absPath` regardless of this root. */
const absFileSource = new FSFileSource(path.sep);

/**
 * Parse one build file and everything it pulls in via **explicit path-relative
 * `include`s only**. `plugin` decls are left in the parsed files — they no longer
 * affect parsing (there is no include search path), so they are resolved after
 * parsing (see {@link loadProject}). The result is a pure function of the files'
 * content, which is what lets this memoized Computable double as the parse cache:
 * a changed file re-settles only its own node, unchanged files stay valid.
 */
/* FIXME: Detect cycles? */
function loadBuildFile(fs: FileSource, file: string, context: ILoadContext): Computable<BuildFiles> {
  if (!(file in context.loadCache)) {
    context.loadCache[file] = fs.get(file).then(f => {
      if (!f) {
        throw new Error("File not found: " + file);
      }
      return f.readString().then(content => {
        const decls = parseBuildFile({ fs, file, reader: new StringReader(content) }, context.log);
        const result: BuildFiles = { [file]: decls };
        if (decls.includes.length === 0) {
          return result;
        }
        return Computable.forAll(
          decls.includes.map(include => loadBuildFile(fs, path.resolve(path.dirname(file), include.filename), context)),
          (...children) => {
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
 * Load `refs` (each following its explicit includes), then activate any plugin
 * they declare that isn't yet active, load that plugin's own `.fabr` files, and
 * repeat to a fixpoint — so a plugin declared by a plugin's library is resolved
 * too. Plugins are activated here, after parsing, because (with no include search
 * path) activation no longer affects how anything parses; activation is a pure
 * function returning the contribution, deduped by plugin name.
 */
function loadClosure(
  refs: FileRef[],
  files: BuildFiles,
  contributions: Record<string, PluginContribution>,
  context: ILoadContext
): Computable<{ files: BuildFiles; contributions: Record<string, PluginContribution> }> {
  return Computable.forAll(
    refs.map(ref => loadBuildFile(ref.fs, ref.file, context)),
    (...maps) => {
      /* Fresh copies, not mutation of the passed-in accumulators: a re-settle
       * (reload) re-runs this callback, and a mutated shared object would keep
       * stale entries from the previous run. */
      const nextFiles: BuildFiles = Object.assign({}, files, ...maps);
      const nextContributions = { ...contributions };
      const pluginFiles: FileRef[] = [];
      for (const decls of Object.values(nextFiles)) {
        for (const decl of decls.plugins) {
          if (decl.name in nextContributions) {
            continue;
          }
          const contribution = activatePlugin(decl, context.pluginApi);
          nextContributions[decl.name] = contribution;
          (contribution.includes ?? []).forEach(inc => pluginFiles.push({ fs: absFileSource, file: inc }));
        }
      }
      return pluginFiles.length === 0
        ? { files: nextFiles, contributions: nextContributions }
        : loadClosure(pluginFiles, nextFiles, nextContributions, context);
    }
  );
}

/**
 * Load and collate the project's build files into a BuildModel. Core is always
 * present (its rules and STD.fabr); a `plugin <name>;` declaration activates the
 * plugin, auto-including its `.fabr` files and contributing its rules/repos. The
 * collected contributions become the model's rule tables, so rule selection is
 * per-model rather than process-global.
 */
export function loadProject(
  fileSource: FileSource,
  startFile: string,
  log: Log,
  pluginApi?: unknown,
  /* The always-present base contribution — core's rules + STD.fabr. A parameter
   * (defaulting to the real thing) only so tests can substitute a stub whose
   * `includes` don't point at a real on-disk lib/ (unavailable under ts-jest,
   * where the package resolves to src/, not the built tree). */
  core: PluginContribution = coreContribution()
): Computable<BuildModel> {
  const context: ILoadContext = { loadCache: {}, pluginApi, log };
  /* The project entry, plus core's always-present includes (STD.fabr). */
  const seeds: FileRef[] = [
    { fs: fileSource, file: startFile },
    ...(core.includes ?? []).map(inc => ({ fs: absFileSource, file: inc })),
  ];
  return loadClosure(seeds, {}, {}, context).then(({ files, contributions }) =>
    toBuildModel(Object.values(files), log, [core, ...Object.values(contributions)])
  );
}
