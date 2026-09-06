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
  Computable,
  BuildResult,
  EXEC_ACTION,
  FileSet,
  DiscoveredDeps,
  EMPTY_FILESET,
  fileSetInput,
  IBuildActionDefinition,
  IChangedFiles,
  ITaskReport,
  MemoryFile,
  outputsInput,
  readJsonFile,
  stringInput,
  stringListInput,
  writeFileSet,
} from "@fabr-build/core";
import { assembleNodeModules, assembleScopedNodeModules } from "./JSPackage";
import { PNP_DATA_FILE, pnpManifestOf, TREE_MOUNT } from "./PnPManifest";
import { IChangeLists, splitDepsPath, toRunReport } from "./pnp/ReadSet";

/**
 * The JS ecosystem's build step, and the one place that owns **how a JS tool
 * reaches its dependencies**: make them reachable, then run it — core's generic
 * `exec` with the one thing every JS tool needs in front of it. Which
 * arrangement is the {@link PNP}/{@link FLAT}/{@link SCOPED} choice, and having
 * all three here is the point: one step owns the question, so a rule says which
 * answer it wants and nothing else.
 *
 * Doing it here rather than in the rule is what makes it free on a cache hit.
 * The rule hands the *packages* over as delivered; the key walks that graph
 * (see `manifestFileInput`) plus the layout token, and what this
 * step makes of them is a pure function of those — which is what lets the key
 * be computed without building anything. Evaluation therefore does no
 * filesystem work at all, and a hit does none either.
 *
 * A layout conflict therefore surfaces on the miss that would have produced it,
 * not during evaluation. That is the same set of runs: a hit is proof the same
 * inputs assembled cleanly, and anything that introduces a conflict changes an
 * input and so misses. The packages carry their `origin` in, so the diagnostic
 * keeps its provenance.
 */
export const NODE_EXEC_ACTION: IBuildActionDefinition = {
  id: "js:exec",
  /* Tracks the exec body this delegates to, plus this step's own layouts; add
   * a `+ N` when what a layout produces changes. A change to the action-key
   * text's shape (see BuildAction.actionKey) already invalidates mechanically
   * and needs no bump here. +7: the dependency-path vocabulary (flat
   * spelling, plain indexing), so a record written before it must not
   * half-match. */
  version: EXEC_ACTION.version + 7,
  run: (action: BuildAction, ctx: ActionContext, report: ITaskReport): Computable<BuildResult> => {
    const deps = depsInput(action);
    const files = fileSetInput(action, "files");
    const depsReportName = stringOption(action, "depsReport");
    const exec = (staged: FileSet, argv: string[], incremental?: Incremental, handover?: Handover): Computable<BuildResult> =>
      /* An incremental run with a base starts from the last green build's
       * output: the base entry's files are staged under the emit directory —
       * and the driver's own kept files back into its state directory — as
       * WRITABLE COPIES. A staged input is otherwise a read-only hardlink into
       * the blob pool, and a tool writing through one would corrupt the shared
       * entry; both of these are trees the tool overwrites in place, so both
       * come through here rather than through the input set. The tool emits its
       * delta over the outputs, correcting what its own state says went stale,
       * and the collected tree is then the whole result with nothing composed
       * after the fact. */
      (handover === undefined
        ? Computable.resolve(undefined)
        : ctx.admit(report, () =>
            writeFileSet(
              ctx.workDir,
              handover.outputs === undefined
                ? handover.staged
                : FileSet.unionAll(handover.staged, baseOutputLayout(action, handover.outputs)),
              { copy: true }
            )
          )
      )
        .then(() =>
          EXEC_ACTION.run(new BuildAction(EXEC_ACTION, { files: staged }, { argv, outputs: outputsInput(action) }), ctx, report)
        )
        .then(result =>
          depsReportName === undefined && incremental === undefined ? result : withBookkeeping(result, depsReportName, incremental)
        );
    const argv = stringListInput(action, "argv");
    const layout = stringInput(action, "layout");
    if (layout !== PNP) {
      const mount = stringInput(action, "mount");
      const mounted = layout === SCOPED ? assembleScopedNodeModules(deps) : assembleNodeModules(deps);
      return exec(FileSet.unionAll(files, FileSet.layout({ [mount]: mounted })), argv);
    }
    /* Nothing is laid out: the packages become trees in the cache's pool, and
     * what each of them SEES is a row in the table staged beside the sources.
     * Materializing them is this step's work like any other layout's — so a hit
     * touches the pool not at all, and a pool wiped between builds heals on the
     * next miss that needs it rather than on every evaluation. */
    const manifest = pnpManifestOf(deps, selfPackage(action));
    const execPnP = (argv: string[], incremental?: Incremental, handover?: Handover): Computable<BuildResult> =>
      Computable.forAll(
        manifest.packages.map(pkg => ctx.ensureTree(pkg)),
        (...trees: string[]) =>
          exec(
            FileSet.unionAll(
              files,
              FileSet.layout({
                [PNP_DATA_FILE]: manifest.toFile(),
                /* The pool itself, mounted once: the manifest addresses trees by
                 * name, so one mount serves every row, and a table with no rows
                 * needs no mount at all. */
                ...(trees.length > 0 ? { [TREE_MOUNT]: ctx.treePool } : {}),
              })
            ),
            argv,
            incremental,
            handover
          )
      );
    const stateDir = stringOption(action, "stateDir");
    const changes = stringOption(action, "changes");
    if (stateDir === undefined && changes === undefined) {
      return execPnP(argv);
    }
    /* The incremental treatment, where the rule named somewhere to keep state or
     * somewhere to be told what moved (pnp only; either alone is a coherent
     * ask, and reporting reads is a third capability neither implies). It
     * changes nothing about the key, the result or the argv — the rule composed
     * that, naming these same locations — so a run with a base and one without
     * are the same invocation, one of them faster: what differs is only whether
     * the files are there to be found. */
    return Computable.forAll(
      [ctx.changedFiles(), ctx.incrementalState(), ctx.previousOutputs()],
      (changedFiles, state, previous) => {
        const staged = prepareBase(changedFiles, state, stateDir, changes);
      /* The previous OUTPUTS go back only to a tool that kept state to correct
       * them with. Staging them is an invitation to emit a delta, and a tool
       * with no state of its own cannot tell which of them went stale — it
       * emits what it compiles now, and everything else it was handed survives
       * into the result as a file nothing produced. The rest of the base (the
       * kept files, the change lists) is handed over regardless: it is a
       * tool's own to ignore. */
        const carries = (state?.size ?? 0) > 0;
        const handover = staged === undefined ? undefined : { staged, outputs: carries ? previous : undefined };
        return execPnP(argv, { stateDir }, handover);
      }
    );
  },
};

/**
 * How a tool reaches its dependencies. Three peers, one choice per rule:
 *
 * - `pnp` — no tree at all: each package is materialized once in the cache's
 *   tree pool and a generated PnP table says what resolves to what. The
 *   strictest and by far the cheapest (a step stages only its own sources), and
 *   what every tool fabr can hand a manifest to uses.
 * - `flat` — every package hoisted at the mount point, transitives visible.
 *   What a tool that merely needs its inputs resolvable wants (a runnable
 *   install, a test install), and where the future `resolution/node_modules`
 *   flag will map a tool that must see a real tree.
 * - `scoped` — the consuming sources see only their DIRECT deps, the closure
 *   living in a hidden area they resolve through, so an undeclared transitive
 *   import fails. Strictness for a filesystem-resolving compiler; see
 *   {@link assembleScopedNodeModules} for what that costs and who must pay it.
 */
export const PNP = "pnp";
export const FLAT = "flat";
export const SCOPED = "scoped";

/** The layout tokens, for a caller that validates one. */
export type NodeLayout = typeof PNP | typeof FLAT | typeof SCOPED;

/**
 * @param files everything the rule lays out itself — sources, the tool's own
 *   mount, generated manifests — named relative to the working directory.
 * @param deps the packages to assemble, as delivered (packages, flags and
 *   loose content), NOT assembled.
 * @param mount where an ASSEMBLED layout goes (`node_modules` for anything node
 *   resolves through; its own directory for a tool with a private convention).
 *   Unused by `pnp`, which mounts nothing.
 * @param self under `pnp` only: the package identity the staged sources
 *   themselves carry, so they can resolve their own name. Its parts are
 *   ordinary inputs, so they key like everything else.
 * Three of these name LOCATIONS a tool was told about — `depsReport`,
 * `stateDir`, `changes`. The rule composes the argv that tells it, so it names
 * them here too and the step only stages and collects what it was given; no
 * flag spelling is this step's business (see {@link STATE_DIR_FLAG}). All three
 * are `pnp` only and INDEPENDENT: each is a capability a tool either has or
 * lacks, and a tool with one of them needs no other. A given driver may still
 * require a combination — fabr's own refuses a state directory without a report,
 * since its planner works in the read set's namespace — but that is the tool's
 * rule to state, not this step's to impose.
 *
 * @param depsReport where the tool writes what it read. The entry is then keyed
 *   on that selection rather than on the whole deps input.
 * @param stateDir the directory whose contents the tool owns, staged back from
 *   the last green build of this target key and kept again after this one.
 * @param changes where fabr writes what moved since that build (see
 *   {@link prepareBase}), for a tool that plans from fabr's diff rather than
 *   from state of its own. The file appears only when there IS a base, so a
 *   tool reads the location and takes its absence as a cold build.
 */
export function createNodeExecAction(
  files: FileSet,
  deps: FileSet[],
  argv: string[],
  outputs: string,
  options: {
    mount?: string;
    layout?: NodeLayout;
    label?: string;
    self?: { name: string; location: string };
    depsReport?: string;
    stateDir?: string;
    changes?: string;
  } = {}
): BuildAction {
  return new BuildAction(
    NODE_EXEC_ACTION,
    { files },
    {
      argv,
      /* The report and the state directory are collected with the outputs, not
       * read where the tool left them: collection sweeps the work dir of
       * everything it did not select. The step partitions both back out of the
       * result (see {@link withBookkeeping}).
       *
       * The state directory is selected by a PREFIX-RETAINING pattern, so its
       * files keep their staged names and cannot collide with an emitted file
       * of the same name. The emit pattern stays LAST: it is the one
       * {@link baseOutputLayout} reads back to find where to stage a base. */
      outputs: collectedWith(outputs, options.depsReport, options.stateDir),
      mount: options.mount ?? "node_modules",
      layout: options.layout ?? FLAT,
      ...(options.self ? { selfName: options.self.name, selfLocation: options.self.location } : {}),
      ...(options.depsReport ? { depsReport: options.depsReport } : {}),
      ...(options.stateDir ? { stateDir: options.stateDir } : {}),
      ...(options.changes ? { changes: options.changes } : {}),
    },
    /* The packages are the tool's **discoverable deps**: it is given the whole
     * closure and reads a handful of declaration files out of it, so `deps`
     * leaves the anchor and the entry is keyed on the run's reported reads —
     * translated back to the input packages (see {@link selectionOf}) — or on
     * the whole deps manifest where the tool reports nothing (see
     * {@link depsReport}). Editing a dependency a reporting compile never
     * opened then invalidates nothing; the mount and layout options stay in
     * the anchor and keep a scoped install apart from a classic one. Keying
     * needs no tree, so no closure is declined — a cross-generation version
     * cycle, which only PnP can deliver, keys like everything else. */
    { deps },
    options.label,
    /* A tool told where to keep state, or where to find what moved, is one that
     * diffs — so the cache is asked to record what this build was made from.
     * Nothing else pays for a record nothing reads. */
    options.stateDir !== undefined || options.changes !== undefined
  );
}

/** What an incremental run extends and keeps: what the last build was made from
 * — absent where there was none, which is a cold compile — and the state
 * directory the caller named, which is the prefix its kept files come back
 * under. No state directory is a tool that keeps nothing of its own and works
 * from fabr's diff alone. */
type Incremental = { stateDir?: string };

/**
 * The files to lay at the workspace root for a run that has a base: the
 * driver's own kept files back under `stateDir`, and what moved at `changes`,
 * both being the locations the caller told the tool about. All *planning* —
 * what a change reaches, what an addition re-binds, which outputs went stale —
 * is the driver's (tscDriver/Planning.ts): those are facts about the
 * compiler's graph, which fabr has no honest way to know.
 *
 * Undefined where there is no base at all, so the driver finds neither and
 * compiles cold — there is no full-compile branch to drift. The change lists
 * gate the whole handover: kept state without them is the one combination the
 * contract forbids (nothing would say what the state is still good for), and
 * with no base the honest lists are unknowable — which is also the migration
 * path for a record in a retired layout, at the price of one cold compile.
 * Change lists WITHOUT kept files ride fine: that is the honest record of a
 * tool that keeps none.
 *
 * The changes document is the TOOL's vocabulary ({@link IChangeLists}): an
 * added name folds into `changed` — both mean "compile against this", and
 * which of the two it was is derivable from the tool's own memo where it
 * matters (an addition is a name the memo has no line for).
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
  const lists: IChangeLists = {
    changed: [...changed.added, ...changed.changed].sort(),
    deleted: [...changed.deleted],
  };
  return FileSet.layout({
    ...(stateDir === undefined ? {} : { [stateDir]: incrementalState }),
    ...(changes === undefined ? {} : { [changes]: MemoryFile.from(`${JSON.stringify(lists, undefined, 2)}\n`) }),
  });
}

/** What a run's state directory left behind, or undefined where it left
 * nothing — a tool that keeps none is an honest record, not a missing one. */
function keptState(state: FileSet): FileSet | undefined {
  return state.size === 0 ? undefined : state;
}

/** What a run with a base is given: the files {@link prepareBase} lays at the
 * workspace root, and the previous build's outputs to emit the delta over —
 * absent for a tool that kept no state, which has nothing to tell it which of
 * them went stale. */
type Handover = { staged: FileSet; outputs?: FileSet };

/** One of the optional location options — where the rule told the tool to write
 * its report, keep its state, or find its change lists (see
 * {@link createNodeExecAction}) — absent unless the rule named one. */
function stringOption(action: BuildAction, name: string): string | undefined {
  const value = action.options[name];
  return typeof value === "string" ? value : undefined;
}

/** The base entry's files under the emit directory this action collects — the
 * `dir` of its `dir:glob` outputs pattern, which is the prefix collection
 * stripped from them. The emit pattern is the LAST of the collected patterns
 * (see {@link collectedWith}); the others are bookkeeping and name no emit
 * directory. An entry with no collection directory has nowhere conflict-free to
 * stage a base, so it gets none (a cold compile). */
function baseOutputLayout(action: BuildAction, outputs: FileSet): FileSet {
  const pattern = outputsInput(action);
  const result = Array.isArray(pattern) ? pattern[pattern.length - 1] : pattern;
  const split = result.indexOf(":");
  const dir = split < 0 ? "" : result.slice(0, split);
  return dir === "" ? outputs : FileSet.layout({ [dir]: outputs });
}

/**
 * The step's result paired with whatever bookkeeping this run was asked for:
 * what it reported reading — the selection the entry is keyed on, in the deps
 * input's own vocabulary — and the build state the next build of this target
 * key works from. The two are INDEPENDENT: a tool may report reads without
 * keeping state (keyed precisely, compiles cold), or keep state without
 * reporting (keyed on the whole deps manifest, and diffed against it too).
 *
 * The report and the state directory are COLLECTED rather than read from the
 * work dir, because collection sweeps away everything it did not select; both
 * are partitioned back out here, so what the step yields is the tool's output
 * and nothing of the bookkeeping. The state files come out under the staging
 * prefix the caller named and go back to the record under their own.
 */
function withBookkeeping(result: BuildResult, report: string | undefined, incremental?: Incremental): Computable<BuildResult> {
  const collected = result.result;
  const written = report === undefined ? undefined : collected.getFile(report);
  /* Both dropped whatever comes of it — bookkeeping, and shipping either in a
   * package because the tool reported nothing would be a silent leak. */
  const statePrefix = incremental?.stateDir === undefined ? undefined : `${incremental.stateDir}/`;
  const { output = EMPTY_FILESET, state } = collected.partition(name =>
    name === report ? "report" : statePrefix !== undefined && name.startsWith(statePrefix) ? "state" : "output"
  );
  /* The driver's own kept files, back under the names it gave them: the prefix
   * is fabr's staging, not something the tool called them. */
  const kept = (): FileSet => (state ?? EMPTY_FILESET).remap(name => name.slice(statePrefix?.length ?? 0));
  /* The state is the only thing the step still hands back: what the build was
   * made from is the CACHE's to record, from the key material it holds. */
  const keeping = incremental === undefined ? {} : { incrementalState: keptState(kept()) };
  if (written === undefined) {
    /* Nothing reported — a stub compiler, or a tool that keeps state and does
     * not report. Either way the entry keys on the whole deps manifest, which is
     * what an unreported run means, and the base widens to match. */
    return Computable.resolve({ result: output, ...keeping });
  }
  /* The reads go back RAW: keeping the selection from narrowing across a wave
   * (a wave opens fewer files than a full compile) is the cache's business,
   * merged where the record lives. */
  return readJsonFile(written, toRunReport).then(({ reads }) => ({
    result: output,
    discoveredDeps: selectionOf(reads),
    ...keeping,
  }));
}

/**
 * A run report as the selection it is: the reads ARE the paths, since the
 * resolver names what it read by the route it took ({@link PnpResolver.pathNameOf}).
 * Nothing is joined or translated here — one vocabulary, resolver to cache.
 */
function selectionOf(reads: Iterable<string>): DiscoveredDeps {
  return new Map([["deps", [...reads].map(read => splitDepsPath(read))]]);
}

/** The `self` options as the pnp arm reads them back: absent unless the rule
 * gave the sources a package identity. */
function selfPackage(action: BuildAction): { name: string; location: string } | undefined {
  const name = action.options.selfName;
  const location = action.options.selfLocation;
  return typeof name === "string" && typeof location === "string" ? { name, location } : undefined;
}

/** What the run's work dir is collected by, given the emit pattern and which
 * pieces of bookkeeping this action asked for. The emit pattern is last, which
 * {@link baseOutputLayout} relies on; a run collecting nothing but its output
 * keeps the plain single pattern it always had. */
function collectedWith(outputs: string, depsReport: string | undefined, stateDir: string | undefined): string | string[] {
  const bookkeeping = [...(depsReport ? [depsReport] : []), ...(stateDir ? [`${stateDir}/**`] : [])];
  return bookkeeping.length === 0 ? outputs : [...bookkeeping, outputs];
}

/** The discoverable `deps`: the direct deps as delivered, which the step
 * assembles. */
function depsInput(action: BuildAction): FileSet[] {
  const value = action.discoverable?.deps;
  if (!Array.isArray(value)) {
    throw new Error(`Input 'deps' must be a list of filesets`);
  }
  return value;
}
