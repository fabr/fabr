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

import { join } from "path";
import type { Reference } from "./Reference";
import { Computable } from "./Computable";
import { FileSet } from "./FileSet";
import { hashString, symlink } from "./FSWrapper";
import { PackageFileSet } from "./PackageFileSet";
import { ABSENT_PREFIX, DiscoveredDeps, encodeName } from "./Manifest";
import { Name } from "./Name";
import type { ActionContext } from "./BuildCache";
import type { ITargetDecl } from "../model/AST";
import type { ITaskReport, StageSpec } from "../support/Execute";
import { compareText, mapComputable } from "../support/Functional";
import { FabrError } from "./Errors";
import { manifestArguments, type RunnableArgument } from "./RunnableFileSet";

/**
 * A member of a build step's configuration: how the build is performed, where
 * `inputs` are what it is performed on. A string (a pattern, a switch), a
 * command line (a list of {@link RunnableArgument}s, keyed by
 * {@link manifestArguments}), a `Name` for a projection the step applies (with
 * `makeProjector`), or file-shaped configuration (a generated tsconfig) as a
 * FileSet, staged for the tool to read.
 *
 * The whole of an action's config is in its target key ({@link configDigest}),
 * so a change to it starts a new build-state record, and its files are never
 * part of the recorded base. Put content in `inputs`: a config member that
 * varies with source content makes every edit a new target key.
 */
export type ActionConfigValue = string | readonly RunnableArgument[] | Name | FileSet;
export type ActionConfig = Record<string, ActionConfigValue>;

/** What a build step's `run`, and so a cache `create` callback, returns. */
export interface BuildResult {
  result: FileSet;
  /** What this run read of its discoverable inputs, where the step reports
   * it; the entry's key and its discovered-deps record are made from it. */
  discoveredDeps?: DiscoveredDeps;
  /** The tool's own files, kept for its next run. Fabr stores and stages
   * them and never reads them. */
  incrementalState?: FileSet;
}

/**
 * A build step: a function from a build action's inputs to its output content,
 * run in an {@link ActionContext}. `id` and `version` name the step in every
 * cache key; bump `version` whenever the step's behaviour changes.
 */
export interface IBuildActionDefinition {
  id: string;
  version: number;
  /**
   * Perform the step on `action`'s `inputs`, `config` and `discoverable` bags
   * and return its output, with what it read of its discoverable inputs where
   * it reports that.
   *
   * `ctx` holds what the cache and the execution funnel provide. `report`
   * takes its executions' output and funnel phases, already set for the run's
   * verbosity: a step makes no display decisions, beyond leaving out the
   * output sink where its contract puts the output elsewhere (the test
   * runner's report).
   */
  run(action: BuildAction, ctx: ActionContext, report: ITaskReport): Computable<BuildResult>;
  /**
   * Stage the step's working directory into `dir` as {@link run} would, without running
   * anything, and describe what it would run there: what `fabr shell` opens. Absent
   * where the step runs nothing that can be reproduced by hand. `ensureTree` puts a
   * file set in the cache's tree pool, as {@link ActionContext.ensureTree} does for
   * {@link run}.
   */
  stage?(action: BuildAction, dir: string, ensureTree: (files: FileSet) => Computable<string>): Computable<IStagedStep>;
}

/** One command a staged step would run: a pipeline of stages, each its argv
 * (the executable first) and the streams it captures, and the file its first
 * stage reads as its standard input, relative to where the command runs. */
export interface IStagedCommand {
  stages: StageSpec[];
  stdin?: string;
}

/** What a step would run in the directory it was staged into (see {@link IBuildActionDefinition.stage}). */
export interface IStagedStep {
  /** Where the commands run, relative to the staged directory. */
  cwd: string;
  /** The commands, each a pipeline of one or more stages. */
  commands: IStagedCommand[];
  /** The environment the commands run with: their whole environment. */
  env: ReadonlyMap<string, string>;
}

/** The optional parts of a {@link BuildAction}. */
export interface IBuildActionOptions {
  /**
   * Input files the step's tool may or may not read; the step reports those it
   * did, and the entry is keyed on them.
   */
  discoverable?: ActionFileInputs;
  /** A display label (see {@link BuildAction.withLabel}). */
  label?: string;
  /**
   * Ask the cache to track what moved between builds of this target key: it
   * records what this build was made from and serves the next build the
   * difference, as {@link ActionContext.changedFiles}.
   */
  trackChangedFiles?: boolean;
  /**
   * Give the step's output the shape the target yields: a package with its
   * identity, or a report with its write-back partition. Applied to the output
   * on every evaluation, whether the step ran or its entry was served.
   *
   * It is not in the action's key, so take content only from the files it is
   * given.
   */
  reshape?: (output: FileSet) => FileSet | Computable<FileSet>;
  /**
   * The inputs (of {@link BuildAction.inputs} or {@link discoverable}) whose
   * files' source paths the step hands its tool. Only these carry source paths
   * into the key and the recorded base.
   */
  sourcePathInputs?: ReadonlyArray<string>;
  /**
   * Installs the step links into its work directory from the tree pool
   * ({@link ActionContext.ensureTree}) instead of staging them file by file (a
   * tool's own install, a test runner's), by the name each is linked at. In
   * the key by manifest hash alone (the `# links` section), no part of the
   * recorded base, and linked by {@link linkTrees}.
   */
  links?: Readonly<Record<string, FileSet>>;
}

/**
 * A build action: a build step and the content and configuration it runs on,
 * the unit of build caching a rule yields. Actions do not nest; rules compose
 * through sub-targets (see TargetContext.subTarget), so an action's inputs are
 * always content in hand.
 *
 * The bags' keys are each step's own fixed names, never user-controlled.
 */
export class BuildAction {
  public readonly discoverable?: ActionFileInputs;
  public readonly label?: string;
  public readonly trackChangedFiles: boolean;
  public readonly reshape?: (output: FileSet) => FileSet | Computable<FileSet>;
  public readonly sourcePathInputs: ReadonlyArray<string>;
  public readonly links: Readonly<Record<string, FileSet>>;

  constructor(
    public readonly step: IBuildActionDefinition,
    /** Per-file content, in the action key file by file, or as the package
     * graph for its PackageFileSet members ({@link manifestGraph}). */
    public readonly inputs: ActionFileInputs,
    /** The step's configuration, all of it in the target key
     * ({@link configDigest}); its FileSet members are staged with the inputs. */
    public readonly config: ActionConfig,
    options: IBuildActionOptions = {}
  ) {
    this.discoverable = options.discoverable;
    this.label = options.label;
    this.trackChangedFiles = options.trackChangedFiles ?? false;
    this.reshape = options.reshape;
    this.sourcePathInputs = options.sourcePathInputs ?? [];
    this.links = options.links ?? {};
  }

  /** @return the options this action was made with. */
  private options(): IBuildActionOptions {
    return {
      discoverable: this.discoverable,
      label: this.label,
      trackChangedFiles: this.trackChangedFiles,
      reshape: this.reshape,
      sourcePathInputs: this.sourcePathInputs,
      links: this.links,
    };
  }

  /** @return a copy carrying the given display label */
  public withLabel(label: string): BuildAction {
    return new BuildAction(this.step, this.inputs, this.config, { ...this.options(), label });
  }

  /** @return a copy whose output `reshape` gives the shape the target yields. */
  public withReshape(reshape: (output: FileSet) => FileSet | Computable<FileSet>): BuildAction {
    return new BuildAction(this.step, this.inputs, this.config, { ...this.options(), reshape });
  }

  /**
   * Make the target key of this action: the key its build-state record is kept
   * under. It is a hash of the step's id and version, `owner`'s identity
   * ({@link declIdentity}), `label` and the config digest, and of no content,
   * so it stays the same across edits and the next build finds its base. Each
   * configuration of a target has its own, and a target running two actions
   * has one per step.
   *
   * `owner` is the target's declaration (for an anonymous sub-target, its
   * declared owner's), and `label` the sub-target's label, absent for a
   * declared target or an unlabelled sub-target. Renaming a label leaves its
   * records behind, so the next build is cold.
   */
  public targetKey(owner: ITargetDecl, label?: string): string {
    return hashString(
      [
        `step ${this.step.id}:${this.step.version}`,
        `target ${declIdentity(owner)}`,
        `label ${label ?? ""}`,
        `config ${configDigest(this)}`,
      ].join("\n")
    );
  }

  /**
   * Render this action's key: `rule:<id>:<version>`, then the file-inputs
   * section, the config section and the links section (each linked install by
   * its hash), each under its own header line with one `name=…` line per
   * member, names sorted. Every section is rendered even when empty, so an
   * empty section cannot be mistaken for a shifted one.
   *
   * With no {@link discoverable} inputs this is the entry's whole key. With
   * them it is the anchor: the entry is stored under {@link preciseActionKey},
   * made from the anchor's hash and what the run read, never under the anchor
   * alone.
   */
  public actionKey(): string {
    const links = Object.keys(this.links)
      .sort(compareText)
      .map(name => `${name}=${this.links[name].toManifestHash()}`)
      .join("\n");
    return `rule:${this.step.id}:${this.step.version}\n# inputs\n${manifestFileInputs(this.inputs, this.sourcePathInputs)}\n# config\n${manifestConfig(
      this.config
    )}\n# links\n${links}`;
  }
}

/**
 * Link each of the action's {@link IBuildActionOptions.links} into `dir`, at
 * its name, to the tree the pool holds it as, ensuring the tree first. A link
 * points at the tree's path on this machine.
 */
export function linkTrees(action: BuildAction, dir: string, ensureTree: (files: FileSet) => Computable<string>): Computable<void> {
  return mapComputable(Object.keys(action.links).sort(compareText), name =>
    ensureTree(action.links[name]).then(path => symlink(path, join(dir, name)))
  ).then(() => undefined);
}

/* Readers a build step's `run` uses to take a typed member off its action,
 * by the member's name (each step's own). */

/** Take the named per-file input, which must be a single FileSet. */
export function fileSetInput(action: BuildAction, name: string): FileSet {
  const value = action.inputs[name];
  if (!(value instanceof FileSet)) {
    throw new FabrError(`Input '${name}' must be a fileset`);
  }
  return value;
}

/** Take the named config member, which must be a list of strings. */
export function stringListConfig(action: BuildAction, name: string): string[] {
  const value = action.config[name];
  if (!Array.isArray(value) || value.some(element => typeof element !== "string")) {
    throw new FabrError(`Config '${name}' must be a list of strings`);
  }
  return value as string[];
}

/** Take the named config member, which must be a command line. */
export function commandLineConfig(action: BuildAction, name: string): readonly RunnableArgument[] {
  const value = action.config[name];
  if (!Array.isArray(value)) {
    throw new FabrError(`Config '${name}' must be a command line`);
  }
  return value as readonly RunnableArgument[];
}

/** Take the named config member, which must be a string (or absent, given a fallback). */
export function stringConfig(action: BuildAction, name: string, fallback?: string): string {
  const value = action.config[name] ?? fallback;
  if (typeof value !== "string") {
    throw new FabrError(`Config '${name}' must be a string`);
  }
  return value;
}

/** Union the FileSet members of the action's config: what an exec step
 * stages into the work dir beside the inputs. Two members naming one path for
 * different files conflict (a ConflictError). */
export function configFiles(action: BuildAction): FileSet {
  return FileSet.unionAll(...Object.values(action.config).filter((value): value is FileSet => value instanceof FileSet));
}

/**
 * Name a declaration by an identity that survives the process: the target's
 * name plus the file it was written in, as the loader named that file.
 */
export function declIdentity(decl: ITargetDecl): string {
  return `${decl.name.toString()}@${decl.source.file}`;
}

/**
 * Digest the configuration half of an action's key: the manifest of its whole
 * `config`, and nothing of its inputs or discoverable inputs. Content passed
 * as config makes every change to it a new target key.
 */
export function configDigest(action: BuildAction): string {
  return hashString(manifestConfig(action.config));
}

/** Render the config section of an action key: keys in sorted order, one
 * `name=manifest` line each (a FileSet member's manifest is a multi-line
 * block, as in the inputs section). */
export function manifestConfig(config: ActionConfig): string {
  return Object.keys(config)
    .sort()
    .map(name => `${name}=${manifestConfigValue(config[name])}`)
    .join("\n");
}

/** Render one config member as key material. Render a `Name` by
 * `toGlobString`: `toString` renders a quoted `'*'` and a wildcard `*` alike,
 * which would give two different projections one key. */
function manifestConfigValue(value: ActionConfigValue): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (value instanceof FileSet) {
    return manifestFileInput(value, false);
  }
  if (value instanceof Name) {
    return JSON.stringify(value.toGlobString());
  }
  return manifestArguments(value);
}

/**
 * Per-file content handed to a build step, staged for it and in the action
 * key file by file; `PackageFileSet` members are in the key as the graph they
 * form ({@link manifestGraph}). Hold only content in hand, never a reference.
 */
export type ActionFileInputs = Record<string, FileSet | FileSet[]>;

/**
 * One discoverable input narrowed to a selection of what was read: a recorded
 * selection at lookup, or the run's own at commit. An input the selection
 * does not mention is narrowed by `narrowDeps` to what a run that read
 * everything would report.
 */
export interface INarrowedInput {
  /** The files the selection's paths landed on, each named by the flat
   * spelling ({@link joinDepsPath}) of the path that found it. */
  readonly resolved: FileSet;
  /** The {@link FileSet.sourcePathsDigest} of each set `resolved`'s files were
   * read from, where it is not empty, by the flat spelling of the route that
   * reached it (a read's path less its file; empty for a loose member). */
  readonly sourcePathsDigests: ReadonlyMap<string, string>;
  /** The paths that landed on nothing, as flat spellings. Unordered:
   * {@link preciseActionKey} sorts. */
  readonly absent: ReadonlyArray<string>;
}

/** The discoverable inputs narrowed to a selection, by input name; every
 * discoverable input is present (see {@link INarrowedInput}). */
export type INarrowedDeps = Record<string, INarrowedInput>;

/**
 * @return the canonical manifest of an action's per-file inputs: keys in
 * sorted order, one `name=manifest` line each, those named in
 * `sourcePathInputs` with their source paths.
 */
export function manifestFileInputs(inputs: ActionFileInputs, sourcePathInputs: ReadonlyArray<string> = []): string {
  return Object.keys(inputs)
    .sort()
    .map(name => `${name}=${manifestFileInput(inputs[name], sourcePathInputs.includes(name))}`)
    .join("\n");
}

/**
 * Render the key of a discovered-deps entry: the anchor (the HASH of
 * {@link BuildAction.actionKey}) followed by one section per discoverable
 * input — that input's manifest, the source-path digest of each route read,
 * then the paths that found nothing.
 */
export function preciseActionKey(anchor: string, used: INarrowedDeps): string {
  return [anchor, narrowedSections(used)].join("\n");
}

/** Render the per-input sections of {@link preciseActionKey}: that input's
 * manifest, its source-path digest lines, then its absent paths. Sorts the
 * input names and each input's digests and absences, so the text does not
 * depend on arrival order. */
function narrowedSections(used: INarrowedDeps): string {
  return Object.keys(used)
    .sort()
    .map(name => {
      const { resolved, sourcePathsDigests, absent } = used[name];
      const digests = [...sourcePathsDigests].map(([route, digest]) => `${SOURCE_PATHS_PREFIX}${route} ${digest}`).sort();
      return [
        `${name}=${manifestFileInput(resolved, false)}`,
        ...digests,
        ...[...absent].sort().map(path => `${ABSENT_PREFIX}${encodeName(path)}`),
      ].join("\n");
    })
    .join("\n");
}

/** The line kind recording, in a precise key, what names the files read
 * through one route. */
const SOURCE_PATHS_PREFIX = "# source-paths ";

/**
 * Render one per-file input as key material: the loose members' file
 * manifests, sorted, then the package graph as {@link manifestGraph} renders
 * it, each with its {@link FileSet.sourcePathsDigest} where `sourcePaths`.
 * The members' order does not change it; the path a package is reached by
 * does.
 */
function manifestFileInput(value: FileSet | ReadonlyArray<FileSet>, sourcePaths: boolean): string {
  const members = [...new Set(Array.isArray(value) ? (value as FileSet[]) : [value as FileSet])];
  const digest = (member: FileSet): string => (!sourcePaths || member.sourcePathsDigest === "" ? "" : ` ${member.sourcePathsDigest}`);
  const loose = members
    .filter(member => !(member instanceof PackageFileSet))
    .map(member => `{\n${member.toManifest()}\n}${digest(member)}`)
    .sort();
  return "{\n" + [...loose, ...manifestGraph(members, digest)].join("\n") + "\n}";
}

/**
 * Render the package graph among `members` as key material, in the path
 * vocabulary of a discovered-deps record: a line for each call
 * {@link walkPackages} makes, holding the path of package names the package
 * is reached by, its content hash, and what `digest` gives it (its
 * {@link FileSet.sourcePathsDigest}, or nothing). `a b c` is the dependency
 * of `b` on `c`, whatever path reached `b`.
 */
function manifestGraph(members: ReadonlyArray<FileSet>, digest: (pkg: FileSet) => string): string[] {
  const lines: string[] = [];
  walkPackages(members, (pkg, route) => lines.push(`${route.join(" ")} ${pkg.toManifestHash()}${digest(pkg)}`));
  return lines;
}

/**
 * Walk the package graph among `members`, calling `reached` with each
 * package and the path of package names it is reached by: once for each root
 * package, then once for each dependency of each package reached. A package's
 * dependencies are walked from the first path that reaches it only, so the
 * calls number the roots plus the dependencies, not every route. Roots and
 * each package's dependencies are taken in {@link packageMembers} order, which
 * fixes which path is first. A dependency not yet bound to a package is
 * skipped.
 *
 * BuildCache's recorded base names packages through this walk too, so its
 * rows match the key's graph lines.
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
    for (const dep of packageMembers(queue[i].packages)) {
      reach(dep, [...here, dep.packageName]);
    }
  }
}

/** Pick the package members of a list, in canonical order — by delivered name, then
 * by content, two instances of one name being distinct nodes. */
function packageMembers(members: ReadonlyArray<FileSet | Reference>): PackageFileSet[] {
  return members
    .filter((member): member is PackageFileSet => member instanceof PackageFileSet)
    .sort((a, b) => compareText(a.packageName, b.packageName) || compareText(a.toManifestHash(), b.toManifestHash()));
}
