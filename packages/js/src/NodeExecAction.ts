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

import {
  ActionContext,
  BuildAction,
  toChangesDocument,
  Computable,
  BuildResult,
  configFiles,
  EXEC_ACTION,
  FileSet,
  DiscoveredDeps,
  EMPTY_FILESET,
  fileSetInput,
  IBuildActionDefinition,
  IChangedFiles,
  ITaskReport,
  MemoryFile,
  outputsConfig,
  readJsonFile,
  stringConfig,
  commandLineConfig,
  RunnableArgument,
  writeFileSet,
} from "@fabr-build/core";
import { layoutPackages, NodeLayout, NODE_MODULES, selfConfig } from "./Layout";
import { splitDepsPath, toRunReport } from "@fabr-build/js-tools";

/**
 * Make the table a tool names its sources by (staged name → source path): each
 * file of `files` that has a source path, by its staged name, and each of
 * `packages` by the directory it is staged at (`<dir>/` → the prefix its files'
 * source paths share) where one prefix names all its files, else file by file.
 * Rows are sorted by staged name.
 */
function sourcePathTable(files: FileSet, packages: ReadonlyMap<string, FileSet>): MemoryFile {
  const rows = [...files.sourcePaths];
  for (const [dir, pkg] of packages) {
    const prefix = pkg.sourcePathPrefix;
    if (prefix !== undefined) {
      rows.push([`${dir}/`, prefix]);
    } else {
      rows.push(...[...pkg.sourcePaths].map(([name, sourcePath]): [string, string] => [`${dir}/${name}`, sourcePath]));
    }
  }
  rows.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return MemoryFile.from(JSON.stringify(Object.fromEntries(rows)));
}

/**
 * The `js:exec` build step: lay out the action's `deps` as its `layout` config
 * says ({@link NodeLayout}: a `node_modules` tree at `mount`, or a PnP table over
 * the pool's trees), stage them with the action's files and config files, and
 * run core's `exec` step over the lot. Where the action's config names them, it
 * also stages the source-path table ({@link sourcePathTable}) and the last green
 * build's base ({@link prepareBase}), and collects the tool's reads report and
 * kept state ({@link withBookkeeping}).
 *
 * The packages are laid out only when the step runs, so a cache hit does no
 * filesystem work, and a layout conflict is reported on a miss. Each package's
 * `origin` gives the conflict its provenance.
 */
export const NODE_EXEC_ACTION: IBuildActionDefinition = {
  id: "js:exec",
  /* The exec step's version, plus this step's own: bump the `+ N` when what a
   * layout produces changes. A change to the shape of the action-key text (see
   * BuildAction.actionKey) needs no bump. */
  version: EXEC_ACTION.version + 10,
  run: (action: BuildAction, ctx: ActionContext, report: ITaskReport): Computable<BuildResult> => {
    const sourcePathsName = optionalConfig(action, "sourcePaths");
    /* The table, over the staged files (with `laid`, a layout staged with them)
     * and, where the rule asks, the packages where the layout puts them. */
    const sourcePaths = (laid: FileSet, packages: ReadonlyMap<string, FileSet> = new Map()): FileSet =>
      sourcePathsName === undefined
        ? EMPTY_FILESET
        : FileSet.layout({ [sourcePathsName]: sourcePathTable(FileSet.unionAll(fileSetInput(action, "files"), laid), packages) });
    const withPackages = optionalConfig(action, "packageSourcePaths") !== undefined;
    const files = FileSet.unionAll(fileSetInput(action, "files"), configFiles(action));
    const depsReportName = optionalConfig(action, "depsReport");
    const exec = (
      staged: FileSet,
      argv: readonly RunnableArgument[],
      incremental?: Incremental,
      handover?: Handover
    ): Computable<BuildResult> =>
      /* With a base, first write its files (the kept state and change lists, and
       * the previous outputs under the emit directory) into the work dir as
       * writable copies. Never stage them as inputs: a staged input is a
       * read-only hardlink into the blob pool, and the tool overwrites these in
       * place, which would corrupt the shared entry. The tool writes its output
       * over the previous outputs, so the collected tree is the whole result. */
      (handover === undefined
        ? Computable.resolve(undefined)
        : ctx.admit(report, () =>
            writeFileSet(
              ctx.workDir,
              handover.outputs === undefined ? handover.staged : FileSet.unionAll(handover.staged, handover.outputs),
              { copy: true }
            )
          )
      )
        .then(() =>
          EXEC_ACTION.run(new BuildAction(EXEC_ACTION, { files: staged }, { argv, outputs: outputsConfig(action) }), ctx, report)
        )
        .then(result =>
          depsReportName === undefined && incremental === undefined ? result : withBookkeeping(result, depsReportName, incremental)
        );
    const argv = commandLineConfig(action, "argv");
    /* The packages, laid out as the action's `layout` says: a `node_modules`
     * tree staged at the mount, or a PnP table staged beside the sources whose
     * rows name trees of the cache's pool. */
    const packages = layoutPackages(action, ctx.workDir, tree => ctx.ensureTree(tree), stringConfig(action, "mount"));
    const execLaid = (argv: readonly RunnableArgument[], incremental?: Incremental, handover?: Handover): Computable<BuildResult> =>
      packages.then(layout =>
        exec(
          /* Where the rule asks for package source paths, the table names a
           * `node_modules` tree's files among `layout.files`, and a PnP
           * layout's packages at the pool trees where they lie
           * (`layout.trees`). */
          FileSet.unionAll(
            files,
            layout.files,
            sourcePaths(withPackages ? layout.files : EMPTY_FILESET, withPackages ? layout.trees : undefined)
          ),
          argv,
          incremental,
          handover
        )
      );
    const stateDir = optionalConfig(action, "stateDir");
    const changes = optionalConfig(action, "changes");
    if (stateDir === undefined && changes === undefined) {
      return execLaid(argv);
    }
    /* An incremental run: the rule named a state directory, a changes file, or
     * both. Having a base changes only which files are staged, never the key,
     * the result or the argv. */
    return Computable.forAll([ctx.changedFiles(), ctx.incrementalState(), ctx.previousOutputs()], (changedFiles, state, previous) => {
      const staged = prepareBase(changedFiles, state, stateDir, changes);
      /* Stage the previous outputs only for a tool that kept state: one with
       * none cannot tell which of them went stale, so a stale output would
       * survive into the result. The kept files and change lists are staged
       * regardless. */
      const carries = (state?.size ?? 0) > 0;
      const outputs = carries && previous !== undefined ? baseOutputLayout(action, previous) : undefined;
      if (staged === undefined || (carries && previous !== undefined && outputs === undefined)) {
        /* No base, or one whose outputs have nowhere to go: a cold compile. */
        return execLaid(argv, { stateDir });
      }
      return execLaid(argv, { stateDir }, { staged, outputs });
    });
  },
};

/**
 * Make the `js:exec` action: stage `files`, lay out `deps` as `options.layout`
 * says (`node_modules` by default), run `argv`, and collect what `outputs`
 * selects.
 *
 * @param files everything the rule lays out itself (sources, the tool's own
 *   mount, generated manifests), named relative to the working directory.
 * @param deps the packages to lay out, as resolved (packages, flags and loose
 *   content).
 * @param argv the tool's command line.
 * @param outputs the pattern selecting what the run produced.
 * @param options.mount where a `node_modules` layout is staged
 *   (`node_modules` by default; its own directory for a tool with a private
 *   convention). Unused by `pnp`.
 * @param options.self the package identity the staged sources carry, so they
 *   can import their own name: a row of the table under `pnp`, a link at the
 *   mount under `node_modules`. Part of the action's config.
 * @param options.config file-shaped configuration the rule generated for the
 *   tool (a tsconfig, a rewrite table), staged at its names beside `files` but
 *   keyed as configuration, so each distinct config has its own target key and
 *   a config change is never a changed file in the base. Never content (see
 *   {@link ActionConfig}).
 *
 * `depsReport`, `stateDir` and `changes` name locations the rule has told the
 * tool about in `argv`; the step stages and collects at them and knows no flag
 * spelling. Each may be given without the others; a tool that needs a
 * combination checks for it itself.
 *
 * @param options.depsReport where the tool writes what it read. The packages
 *   are then the action's discoverable input, and the entry is keyed on what it
 *   read rather than on the whole deps input.
 * @param options.stateDir the directory whose contents the tool owns, staged
 *   back from the last green build of this target key and kept again after
 *   this one.
 * @param options.changes where the step writes what changed since that build
 *   (see {@link prepareBase}). The file is written only where there is such a
 *   build, so a tool takes its absence as a cold build.
 */
export function createNodeExecAction(
  files: FileSet,
  deps: FileSet[],
  argv: readonly RunnableArgument[],
  outputs: string,
  options: {
    mount?: string;
    layout?: NodeLayout;
    label?: string;
    self?: { name: string; location: string };
    config?: FileSet;
    depsReport?: string;
    stateDir?: string;
    changes?: string;
    /** Where to stage the table of the source path of each file in `files`
     * (see {@link sourcePathTable}). */
    sourcePaths?: string;
    /** Whether that table also names the packages' files, where the layout
     * puts them. */
    packageSourcePaths?: boolean;
  } = {}
): BuildAction {
  /* The packages are discoverable only where the tool reports what it read;
   * otherwise they are an ordinary input, keyed one line per package. */
  const reported = options.depsReport !== undefined;
  return new BuildAction(
    NODE_EXEC_ACTION,
    reported ? { files } : { files, deps },
    {
      argv,
      /* The report and the state directory are collected with the outputs
       * (collection removes everything it does not select), and the step
       * partitions them back out ({@link withBookkeeping}). The state directory's
       * pattern keeps its prefix, so its files cannot collide with an emitted
       * file of the same name. Keep the emit pattern last: {@link
       * baseOutputLayout} reads it back to find where to stage a base. */
      outputs: collectedWith(outputs, options.depsReport, options.stateDir),
      mount: options.mount ?? "node_modules",
      layout: options.layout ?? NODE_MODULES,
      ...selfConfig(options.self),
      ...(options.config ? { config: options.config } : {}),
      ...(options.depsReport ? { depsReport: options.depsReport } : {}),
      ...(options.stateDir ? { stateDir: options.stateDir } : {}),
      ...(options.changes ? { changes: options.changes } : {}),
      ...(options.sourcePaths ? { sourcePaths: options.sourcePaths } : {}),
      ...(options.packageSourcePaths ? { packageSourcePaths: "true" } : {}),
    },
    /* Where the tool reports its reads, `deps` is discoverable: it stays out of
     * the anchor, and the entry is keyed on the reported reads
     * ({@link selectionOf}), so a change to a dependency file the tool never
     * read changes no key. The mount and layout stay in the anchor. */
    {
      ...(reported ? { discoverable: { deps } } : {}),
      label: options.label,
      /* A tool given a state directory or a changes file works from the last
       * build, so the cache records what each build was made from. */
      trackChangedFiles: options.stateDir !== undefined || options.changes !== undefined,
      /* The table names `files` always, and the packages where the rule asks. */
      sourcePathInputs: options.sourcePaths === undefined ? [] : options.packageSourcePaths ? ["files", "deps"] : ["files"],
    }
  );
}

/** An incremental run's settings: the state directory the rule named, under
 * which the tool's kept files are collected; absent for a tool that keeps no
 * state. */
type Incremental = { stateDir?: string };

/**
 * Lay out the base for a run that has a last green build, at the work dir's
 * root: the tool's kept state under `stateDir` and the changes document
 * ({@link toChangesDocument}) at `changes`, each where the rule named it.
 * Deciding what a change reaches is the tool's own work.
 *
 * @return undefined where there is no build to diff against (`changed` is
 *   undefined): nothing is staged and the tool builds cold. Kept state is
 *   never staged without the change lists; the change lists are staged without
 *   kept state for a tool that keeps none.
 */
function prepareBase(
  changed: IChangedFiles | undefined,
  incrementalState: FileSet | undefined,
  stateDir: string | undefined,
  changes: string | undefined
): FileSet | undefined {
  if (changed === undefined) {
    return undefined;
  }
  return FileSet.layout({
    ...(stateDir === undefined ? {} : { [stateDir]: incrementalState }),
    ...(changes === undefined ? {} : { [changes]: MemoryFile.from(toChangesDocument(changed)) }),
  });
}

/** @return what a run's state directory left behind, or undefined where it left nothing. */
function keptState(state: FileSet): FileSet | undefined {
  return state.size === 0 ? undefined : state;
}

/** What a run with a base is given: the files {@link prepareBase} lays at the
 * work dir's root, and the previous build's outputs laid under the emit
 * directory ({@link baseOutputLayout}), absent for a tool that kept no state. */
type Handover = { staged: FileSet; outputs?: FileSet };

/** Read an optional string member of the action's config (such as the
 * locations {@link createNodeExecAction} takes), or undefined where it is not set. */
function optionalConfig(action: BuildAction, name: string): string | undefined {
  const value = action.config[name];
  return typeof value === "string" ? value : undefined;
}

/** Lay the previous build's outputs under the emit directory this action
 * collects: the `dir` of its `dir:glob` emit pattern, the last of the collected
 * patterns ({@link collectedWith}). Undefined where the emit pattern has no
 * directory, as there is then nowhere to stage them without conflict: the run
 * builds cold. */
function baseOutputLayout(action: BuildAction, outputs: FileSet): FileSet | undefined {
  const pattern = outputsConfig(action);
  const result = Array.isArray(pattern) ? pattern[pattern.length - 1] : pattern;
  const split = result.indexOf(":");
  const dir = split < 0 ? "" : result.slice(0, split);
  return dir === "" ? undefined : FileSet.layout({ [dir]: outputs });
}

/**
 * Split the run's bookkeeping out of its collected result: the reads report
 * named `report`, parsed into the selection the entry is keyed on
 * (`discoveredDeps`), and, for an incremental run, the files under its state
 * directory, returned as `incrementalState` under the names the tool gave them
 * (the state directory prefix removed). Either may be present without the
 * other. What remains is the step's `result`.
 *
 * Where the tool wrote no report, there is no `discoveredDeps`, and the entry
 * is keyed on the whole deps input.
 */
function withBookkeeping(result: BuildResult, report: string | undefined, incremental?: Incremental): Computable<BuildResult> {
  const collected = result.result;
  const written = report === undefined ? undefined : collected.getFile(report);
  /* The report and the state files leave the result whatever else happens,
   * so neither can ship in a package. */
  const statePrefix = incremental?.stateDir === undefined ? undefined : `${incremental.stateDir}/`;
  const { output = EMPTY_FILESET, state } = collected.partition(name =>
    name === report ? "report" : statePrefix !== undefined && name.startsWith(statePrefix) ? "state" : "output"
  );
  /* The tool's kept files, under the names it gave them. */
  const kept = (): FileSet => (state ?? EMPTY_FILESET).remap(name => name.slice(statePrefix?.length ?? 0));
  /* What the build was made from is recorded by the cache, not returned here. */
  const keeping = incremental === undefined ? {} : { incrementalState: keptState(kept()) };
  if (written === undefined) {
    /* Nothing reported (a stub compiler, or a tool that keeps state without
     * reporting): the entry is keyed on the whole deps input. */
    return Computable.resolve({ result: output, ...keeping });
  }
  /* The reads are returned as reported; the cache merges them with the last
   * build's, as an incremental compile reads fewer files than a full one. */
  return readJsonFile(written, toRunReport).then(({ reads }) => ({
    result: output,
    discoveredDeps: selectionOf(reads),
    ...keeping,
  }));
}

/**
 * Make the selection of the `deps` input from a run report's reads, each
 * already a dependency path in the resolver's naming
 * ({@link PnpResolver.pathNameOf}) and split here, not translated.
 */
function selectionOf(reads: Iterable<string>): DiscoveredDeps {
  return new Map([["deps", [...reads].map(read => splitDepsPath(read))]]);
}

/** List the patterns the run's work dir is collected by: the reads report and
 * the state directory where asked for, then the emit pattern, last (which
 * {@link baseOutputLayout} relies on); the emit pattern alone where neither is. */
function collectedWith(outputs: string, depsReport: string | undefined, stateDir: string | undefined): string | string[] {
  const bookkeeping = [...(depsReport ? [depsReport] : []), ...(stateDir ? [`${stateDir}/**`] : [])];
  return bookkeeping.length === 0 ? outputs : [...bookkeeping, outputs];
}
