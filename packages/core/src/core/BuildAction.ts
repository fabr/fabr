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

/**
 * The build action: a build step plus its concrete inputs, the keys it is named
 * by, and the run contract a step is handed and answers with.
 */

import { Computable } from "./Computable";
import { FileSet } from "./FileSet";
import { hashString } from "./FSWrapper";
import { PackageFileSet } from "./PackageFileSet";
import { RepositoryRef } from "./Repository";
import { ABSENT_PREFIX, ActionOptions, DiscoveredDeps, encodeName, manifestOptions } from "./Manifest";
import type { ActionContext } from "./BuildCache";
import type { ITargetDecl } from "../model/AST";
import type { ITaskReport } from "../support/Execute";
import { compareText } from "../support/Functional";

/** What a build step's `run` — and so a cache `create` callback — hands back. */
export interface BuildResult {
  result: FileSet;
  /** The selection this run read of its discoverable inputs, where it
   * discovers them; the entry's key and its discovered-deps record both derive
   * from it. */
  discoveredDeps?: DiscoveredDeps;
  /**
   * The tool's own kept files, stored as ordinary content, preserved across
   * runs. Fabr stores, pairs and stages them; it never reads inside.
   */
  incrementalState?: FileSet;
}

/**
 * The build step of a build action: a pure function from resolved inputs to
 * output content, run in a framework-provided {@link ActionContext}. This is
 * the only unit of build caching; `id` + `version` identify the step in every
 * cache key, so a behavior change is a version bump rather than a manual cache
 * flush.
 */
export interface IBuildActionDefinition {
  id: string;
  version: number;
  /**
   * Perform the step, answering its output content — plus, where the step
   * discovers which of its inputs it really used, the subset it read.
   *
   * The step receives the whole demanded {@link BuildAction}; its resolved
   * `inputs`/`options`/`discoverable` bags are what it consumes. `ctx` is what
   * the cache and the execution funnel give it; `report` is where its
   * executions announce output and funnel phases, already resolved against the
   * run's verbosity — a step makes no display decisions of its own beyond
   * withholding the output sink where its contract puts the output elsewhere
   * (the test runner's report).
   */
  run(action: BuildAction, ctx: ActionContext, report: ITaskReport): Computable<BuildResult>;
}

/**
 * A build action: a build step plus its concrete (already-resolved) inputs —
 * the cacheable leaf a rule yields. Actions do not compose directly;
 * composition is via sub-targets (see ResolveContext.subTarget), so an action's
 * inputs are always plain data.
 *
 * Every member must reduce to a stable manifest, since the key is a function of
 * exactly these fields. The per-field bags are developer-authored fixed-key
 * records, never user-controlled names.
 */
export class BuildAction {
  constructor(
    public readonly step: IBuildActionDefinition,
    /** Per-file material, manifested file-by-file into the action key. Carries
     * no unassembled packages — those belong in {@link discoverable}. */
    public readonly inputs: ActionFileInputs,
    /** Non-file key material: argv, patterns, switches, projections. All of it
     * is target-key identity ({@link optionsDigest}). */
    public readonly options: ActionOptions,
    /**
     * If present, input files that may or may not be used by the runner; the runner
     * may return a list of files from these inputs that it actually used, to provide
     * more precise dependencies for subsequent reruns.
     */
    public readonly discoverable?: ActionFileInputs,
    public readonly label?: string,
    /**
     * Ask the cache to track what moved between builds of this target key: it
     * records what this build was made from and serves the next build the
     * difference, as {@link ActionContext.changedFiles}.
     */
    public readonly trackChangedFiles: boolean = false
  ) {}

  /** @return a copy carrying the given display label */
  public withLabel(label: string): BuildAction {
    return new BuildAction(this.step, this.inputs, this.options, this.discoverable, label, this.trackChangedFiles);
  }

  /**
   * The durable cache key of a target's action — *whose build is this*.
   * Content-free (step id+version, decl identity, options digest), so it
   * survives every edit and the next build can find its base. A target running
   * two actions holds two of these, distinguished by their step.
   *
   * `owner` is the target's declaration; an anonymous sub-target takes its
   * OWNER's, not its label.
   */
  public targetKey(owner: ITargetDecl): string {
    return hashString(
      [`step ${this.step.id}:${this.step.version}`, `target ${declIdentity(owner)}`, `options ${optionsDigest(this)}`].join("\n")
    );
  }

  /**
   * The key material this action is demanded under: `rule:<id>:<version>`, then
   * the file-inputs section, then the options section, each under its own header
   * line with one `name=manifest` line per member, names sorted. Both sections
   * are always rendered, so an empty one cannot alias a shifted one.
   *
   * With no discoverable deps this is the complete key; with {@link discoverable}
   * it is the **anchor**, and the entry is stored under
   * {@link preciseActionKey} — never under a bare anchor.
   */
  public actionKey(): string {
    return `rule:${this.step.id}:${this.step.version}\n# inputs\n${manifestFileInputs(this.inputs)}\n# options\n${manifestOptions(
      this.options
    )}`;
  }
}

/* The action's reading face: what a build step's `run` uses to take a typed
 * member off the action it received. The option NAMES are each step's own
 * vocabulary, which is why these know none. */

/** The named per-file input, which must be a single FileSet. */
export function fileSetInput(action: BuildAction, name: string): FileSet {
  const value = action.inputs[name];
  if (!(value instanceof FileSet)) {
    throw new Error(`Input '${name}' must be a fileset`);
  }
  return value;
}

/** The named option, which must be a list of strings. */
export function stringListInput(action: BuildAction, name: string): string[] {
  const value = action.options[name];
  if (!Array.isArray(value) || value.some(element => typeof element !== "string")) {
    throw new Error(`Input '${name}' must be a list of strings`);
  }
  return value;
}

/** The named option, which must be a string (or absent, given a fallback). */
export function stringInput(action: BuildAction, name: string, fallback?: string): string {
  const value = action.options[name] ?? fallback;
  if (typeof value !== "string") {
    throw new Error(`Input '${name}' must be a string`);
  }
  return value;
}

/**
 * A declaration's identity as something that survives the process: the target's
 * name plus the file it was written in, as the loader named that file.
 */
export function declIdentity(decl: ITargetDecl): string {
  return `${decl.name.toString()}@${decl.source.file}`;
}

/**
 * The non-file half of an action's key: the manifest of `options`, whole.
 * Nothing of `inputs` participates, and the discoverable deps are not consulted.
 *
 * Note for rule authors: a whole-closure artifact passed as a string option
 * lands here, making every dependency change a fresh target key.
 */
export function optionsDigest(action: BuildAction): string {
  return hashString(manifestOptions(action.options));
}

/**
 * Per-file material handed to a build step: staged content, manifested
 * file-by-file into the action key. `PackageFileSet` members manifest as the
 * graph they form instead ({@link manifestGraph}). FileSets must be fully
 * materialized — inert references never cross.
 */
export type ActionFileInputs = Record<string, FileSet | FileSet[]>;

/**
 * The input set for the current run, narrowed to the discovered dependencies from a
 * previous run.
 *
 * Always a genuine selection: an input the selection never mentioned is
 * settled by `narrowDeps` to the selection a run that read EVERYTHING would
 * have reported, so nothing above that point can tell a non-reporting run
 * from a maximally-reporting one.
 */
export interface INarrowedInput {
  /** The files the selection's paths landed on, each named by the flat
   * spelling ({@link joinDepsPath}) of the path that found it. */
  readonly resolved: FileSet;
  /** The paths that landed on nothing, as flat spellings. Unordered:
   * {@link preciseActionKey} sorts. */
  readonly absent: ReadonlyArray<string>;
}

/**
 * The discoverable deps narrowed to a selection, keyed as they are.
 *
 * Total: every discoverable key is present — an unmentioned input arrives as
 * the everything-selection (see {@link INarrowedInput}) — so a consumer never
 * has to handle a missing entry.
 */
export type INarrowedDeps = Record<string, INarrowedInput>;

/**
 * @return the canonical manifest of an action's per-file inputs: keys in
 * sorted order, one `name=manifest` line each.
 */
export function manifestFileInputs(inputs: ActionFileInputs): string {
  return Object.keys(inputs)
    .sort()
    .map(name => `${name}=${manifestFileInput(inputs[name])}`)
    .join("\n");
}

/**
 * The key formula for a discovered-deps entry: the anchor (the HASH of
 * {@link BuildAction.actionKey}) followed by one section per discoverable
 * input — that input's manifest, then the paths that found nothing.
 */
export function preciseActionKey(anchor: string, used: INarrowedDeps): string {
  return [anchor, narrowedSections(used)].join("\n");
}


/** The per-input sections of {@link preciseActionKey}: that input's manifest,
 * then its absent paths. Sorts both the input names and each input's absences,
 * so the text is a function of what it was handed and not of arrival order. */
function narrowedSections(used: INarrowedDeps): string {
  return Object.keys(used)
    .sort()
    .map(name => {
      const { resolved, absent } = used[name];
      return [`${name}=${manifestFileInput(resolved)}`, ...[...absent].sort().map(path => `${ABSENT_PREFIX}${encodeName(path)}`)].join(
        "\n"
      );
    })
    .join("\n");
}

/**
 * One per-file input as key material: the loose members' file manifests, then
 * the package graph as {@link manifestGraph} walks it. List order does not
 * participate; how a package is REACHED does.
 */
function manifestFileInput(value: FileSet | ReadonlyArray<FileSet>): string {
  const members = [...new Set(Array.isArray(value) ? (value as FileSet[]) : [value as FileSet])];
  const loose = members
    .filter(member => !(member instanceof PackageFileSet))
    .map(member => `{\n${member.toManifest()}\n}`)
    .sort();
  return "{\n" + [...loose, ...manifestGraph(members)].join("\n") + "\n}";
}

/**
 * The package graph as key material, in the same path vocabulary as a
 * discovered-deps record: one line per root and one per edge, each holding the
 * path the node is reached by, its content hash, and the nested-override flag
 * that no path can express.
 *
 * A package's own edges are walked at its FIRST-SEEN path only, so the count is
 * one line per root plus one per edge rather than one per distinct route (which
 * is exponential in a shared graph). Every edge still appears — `a b c` is the
 * b→c edge whatever route reached b — so what a mount can depend on is covered:
 * the direct list (a length-one path), the bindings, and the contents.
 *
 * The walk is canonically ordered, roots and edges alike, since a first-seen
 * path is only well defined against a fixed order. Inert {@link RepositoryRef}
 * edges are omitted: an assembler cannot see through them.
 */
function manifestGraph(members: ReadonlyArray<FileSet>): string[] {
  const lines: string[] = [];
  walkPackages(members, (pkg, route) =>
    lines.push(`${route.join(" ")} ${pkg.toManifestHash()}${pkg.isNestedOverride ? " nested" : ""}`)
  );
  return lines;
}

/**
 * The canonical walk: every root, then every edge, each visited at its
 * first-seen path — so the count is one call per root plus one per edge rather
 * than one per distinct route, which a shared graph makes exponential. Roots and
 * edges are canonically ordered, a first-seen path being well defined only
 * against a fixed order.
 *
 * Exported for the recorded base (BuildCache): its rows must name a file
 * exactly as the key's graph lines name its package, and one walk is what
 * guarantees they cannot disagree.
 */
export function walkPackages(members: ReadonlyArray<FileSet>, reached: (pkg: PackageFileSet, route: string[]) => void): void {
  const firstSeen = new Map<PackageFileSet, string[]>();
  const queue: PackageFileSet[] = [];
  const reach = (pkg: PackageFileSet, route: string[]): void => {
    reached(pkg, route);
    if (!firstSeen.has(pkg)) {
      firstSeen.set(pkg, route);
      queue.push(pkg);
    }
  };
  for (const root of packageMembers(members)) {
    reach(root, [root.packageName]);
  }
  for (let i = 0; i < queue.length; i++) {
    const here = firstSeen.get(queue[i])!;
    for (const dep of packageMembers(queue[i].dependencies)) {
      reach(dep, [...here, dep.packageName]);
    }
  }
}

/** The package members of a list, in canonical order — by delivered name, then
 * by content, two instances of one name being distinct nodes. */
function packageMembers(members: ReadonlyArray<FileSet | RepositoryRef>): PackageFileSet[] {
  return members
    .filter((member): member is PackageFileSet => member instanceof PackageFileSet)
    .sort((a, b) => compareText(a.packageName, b.packageName) || compareText(a.toManifestHash(), b.toManifestHash()));
}
