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

import { PROJECT_FILENAME } from "./core/Constants";
import { BuildCache } from "./core/BuildCache";
import { Computable } from "./core/Computable";
import { FSFileSource } from "./core/FSFileSource";
import { IndexedFileSource } from "./core/IndexedFileSource";
import { FabrError } from "./core/Errors";
import { refuseNamespaces } from "./core/NamespaceRef";
import { Dependency, isPackage, Package, ResolvedNode } from "./core/PackageFileSet";
import { Reference } from "./core/Reference";
import { ProjectedPackage, Resolved, SourceRef } from "./core/Repository";
import { TargetRef } from "./core/TargetRef";
import { EXTENDS_KEY, ResolvedRequirements, ResolvedTarget } from "./context/index";
import { getSourceFileSource, SourceFileSource } from "./core/SourceFileSource";
import { WatchController } from "./core/WatchController";
import { BuildContext } from "./context/index";
import type { INameValue } from "./model/AST";
import { BuildModel } from "./model/BuildModel";
import { BuildCycle, ExecutionContext, hostFiles } from "./model/ExecutionContext";
import { reportFailure } from "./model/ErrorFormatter";
import { coreContribution, ILoadOptions, loadProject } from "./model/Loader";
import { Constraints } from "./model/Constraints";
import { builtInProject } from "./model/Target";
import { SyncSource } from "./rules/BuildSync";
import { Diagnostic, Log } from "./support/Log";
import { DESCRIBED_OPERATIONS, DESCRIPTION_FILE, type IDescription, toDescription } from "./context/Description";
import { readJsonFile } from "./support/Json";

const DIAG_WATCH_WARNING = Diagnostic.Warn<{ message: string }>("{message}");

/** The time, in milliseconds, a watched tree must be free of filesystem
 *  events before a rebuild starts; each event restarts it. */
export const WATCH_QUIET_MS = 100;

/** The options a {@link Fabr} run is made with. */
export interface IFabrOptions {
  /** Root of the project source tree (the directory holding PROJECT.fabr). */
  sourceRoot: string;
  /** The build cache directory. */
  cacheRoot: string;
  /** The run's diagnostic log, which the driver renders. */
  log: Log;
  /** Watch the source tree: filesystem changes become build cycles. */
  watch?: boolean;
  /** The machine fabr runs on (`HOST`), which a plugin built in the project is built for. */
  host?: Constraints;
  /** Read every optional lib of each plugin the project uses, as though the
   * project included it (see {@link ILoadOptions}). */
  includeOptionalLibs?: boolean;
  /** Revalidate every mutable fetched document once this run, whatever its
   * freshness (`--refresh`; see {@link BuildCache}). */
  refresh?: boolean;
}

/**
 * Make one fabr run: the interface a driver (the CLI, an IDE, an embedder)
 * runs the engine through. Construction opens the build cache at
 * `cacheRoot`, reads the project tree at `sourceRoot` and, with `watch`,
 * starts watching it, and makes the {@link ExecutionContext} every
 * configuration of the run shares.
 *
 * A driver then:
 * - subscribes to build events through `execution.onBuildEvent`, which carry
 *   all progress, the end of each build cycle included;
 * - calls {@link evaluate} with an operation (such as
 *   {@link buildOperation} or {@link testOperation}) over the loaded model,
 *   and renders its result and failures itself;
 * - when watching, shuts down by awaiting `controller.close()`, and otherwise
 *   awaits {@link maybeCollectGarbage} before it exits.
 *
 * At the end of each build cycle the run saves the source index (and, when
 * watching, then runs {@link maybeCollectGarbage}). Exit codes, signals and
 * the terminal are the driver's.
 */
export class Fabr {
  /** The context the run's configurations share: the cache, the log and the build-event stream. */
  public readonly execution: ExecutionContext;
  /** The project source tree, through which the driver writes files back into
   *  it (the execution holds it as a plain FileSource). */
  public readonly sourceFileSource: SourceFileSource;
  /** The host's files read in place, whose index this run keeps (see {@link ExecutionContext.hostFileSource}). */
  private readonly hostFileSource: IndexedFileSource;
  /** The machine fabr runs on, as a configuration (see {@link IFabrOptions.host}). */
  private readonly host: Constraints;
  /** How the project is read. */
  private readonly loadOptions: ILoadOptions;
  /** The watch controller, present when watching; the driver shuts the run down through {@link WatchController.close}. */
  public readonly controller?: WatchController;
  /** The run's build-cycle counter, which {@link maybeCollectGarbage} watches to stop early. */
  private readonly cycle: BuildCycle;

  constructor(options: IFabrOptions) {
    this.host = options.host ?? Constraints.of({});
    this.loadOptions = { includeOptionalLibs: options.includeOptionalLibs };
    const cache = new BuildCache(options.cacheRoot, options.log, undefined, options.refresh);
    /* The controller advances it per batch of changes applied; the execution
     * reads it to emit the cycle boundaries. */
    const cycle = new BuildCycle();
    this.cycle = cycle;
    /* Watcher errors are reported as failures; its notices are logged as warnings. */
    this.controller = options.watch
      ? new WatchController(
          WATCH_QUIET_MS,
          undefined,
          err => reportFailure(options.log, err),
          () => cycle.advance(),
          message => options.log.log(DIAG_WATCH_WARNING, { message })
        )
      : undefined;
    this.sourceFileSource = getSourceFileSource(options.sourceRoot, cache, this.controller);
    this.hostFileSource = hostFiles(cache, this.controller);
    this.execution = new ExecutionContext(
      cache,
      options.log,
      this.sourceFileSource,
      new FSFileSource("/"),
      cycle,
      this.hostFileSource
    );
    /* Save the source and host indexes at each cycle-end, which comes even
     * where no result changed (a file touched but not edited changes the
     * index's rows), and once more, unconditionally, when the watch controller
     * closes. Under watch, run the daily cache trim once the source index is
     * saved; a one-shot run's driver runs the trim itself. */
    this.execution.onBuildEvent(event => {
      if (event.kind === "cycle-end") {
        this.hostFileSource.persistIndex();
        const persisted = this.sourceFileSource.persistIndex();
        if (this.controller) {
          persisted.then(() => this.maybeCollectGarbage());
        }
      }
    });
    this.controller?.track(
      () =>
        new Promise<void>(resolve =>
          Computable.forAll([this.sourceFileSource.persistIndex(true), this.hostFileSource.persistIndex(true)], () => undefined).then(
            () => resolve(),
            () => resolve()
          )
        )
    );
  }

  /**
   * Load the project and evaluate `operation` over its model, as the run's
   * evaluation: each time the result settles (again, under watch) the current
   * build cycle ends, with a cycle-end build event saying whether it failed.
   *
   * The result is `operation`'s; it rejects where loading the project fails
   * or `operation`'s result does. Once it settles, the source and host
   * indexes are saved.
   */
  public evaluate<T>(operation: (model: BuildModel) => Computable<T>): Computable<T> {
    const evaluation = loadProject(this.execution, PROJECT_FILENAME, coreContribution(), this.host, this.loadOptions).then(operation);
    this.execution.observeEvaluation(evaluation);
    return evaluation.finally(() =>
      Computable.forAll([this.sourceFileSource.persistIndex(), this.hostFileSource.persistIndex()], () => undefined)
    );
  }

  /**
   * Trim the cache if its daily trim is due (see
   * {@link BuildCache.maybeCollectGarbage}); otherwise do nothing. The trim
   * stops early where a new build cycle starts. Under watch the run calls this
   * itself at each cycle-end; a one-shot driver calls it at the end of the run
   * (after the program exits, for `run` and `shell`) and awaits it before
   * exiting.
   */
  public maybeCollectGarbage(): Computable<void> {
    const startedAt = this.cycle.current;
    return this.execution.buildCache.maybeCollectGarbage({
      shouldAbort: () => this.cycle.current !== startedAt,
    });
  }
}

/**
 * Throw where any of `resolved` (what `ref` resolved to) is a selection of a
 * target's files rather than the whole target.
 */
export function requireWhole(ref: INameValue, resolved: ReadonlyArray<Resolved>): void {
  for (const source of resolved) {
    if (source instanceof ProjectedPackage && source.base instanceof ResolvedTarget) {
      const name = source.base.packageName;
      throw new FabrError(`'${ref.value.toString()}' selects files of '${name}'`).withHelp(`name it without the selection: '${name}'`);
    }
  }
}

/**
 * Build what each of `refs` names under `config`'s operation, by materializing
 * it. Each must be a name the project declares (a target, a global, a
 * repository), with any `<k=v>` on it. Each result rejects where any name is
 * a path, a pattern or a selection of a target's files, or not declared
 * (and then none is built), or where what it names is a namespace.
 */
function build(config: BuildContext, refs: INameValue[]): Computable<SourceRef[]>[] {
  const declared = Computable.forAll(
    refs.map(ref => requireDeclared(config, ref)),
    () => undefined
  );
  return refs.map(ref => declared.then(() => config.materialize(ref)).then(sources => refuseNamespaces(sources)));
}

/** Refuse `ref` where it is not a name the project declares. */
function requireDeclared(config: BuildContext, ref: INameValue): Computable<void> {
  return config.isDeclared(ref).then(declared => {
    if (declared) {
      return undefined;
    }
    /* Resolving it rejects a name that names nothing, with suggestions;
     * anything else is refused here, as a selection of a target's files or as
     * not declared. */
    return config.resolve(ref).then((resolved): void => {
      requireWhole(ref, resolved.denoted);
      throw new FabrError(`'${ref.value.toString()}' is not a name the project declares`).withHelp(
        "'build' and 'test' act on a declared target or global; read files with ls, cat or cp"
      );
    });
  });
}

/**
 * Build what each of `refs` names under `config`'s operation (the `build`
 * verb), and yield what each built, in order. Each must be a name the project
 * declares, with any `<k=v>` on it; a path, a pattern, a selection of a
 * target's files or an undeclared name is refused, and refusing any one
 * builds none. A `sync` target's build also packages every member it
 * publishes, publishing nothing. Rejects where any name is refused or any
 * build fails.
 */
export function buildOperation(config: BuildContext, refs: INameValue[]): Computable<SourceRef[][]> {
  return Computable.forAll(build(config, refs), (...results: SourceRef[][]) =>
    Computable.forAll(results.map(realiseNamespaces), () => results)
  );
}

/**
 * Build what each of `refs` names under `config`'s operation (the `test`
 * verb, which runs the tests), and yield what each built, in order, its test
 * report among it (`getTestReport` reads it). Names are refused as for
 * {@link buildOperation}. Rejects where any name is refused or any build
 * fails, a test run with failing tests included.
 */
export function testOperation(config: BuildContext, refs: INameValue[]): Computable<SourceRef[][]> {
  return Computable.forAll(build(config, refs), (...results: SourceRef[][]) => results);
}

/** A name as written, and what it resolved to. */
export interface ResolvedName {
  readonly title: string;
  readonly resolved: ResolvedRequirements;
}

/** A source among what a target requires, with where it was required. */
export interface RequiredSource {
  /** The target whose rule requires it: the target itself, or what its rule
   * builds under the target's own name. */
  readonly part: ResolvedTarget;
  /** The requirement it is among. */
  readonly requirement: string;
  readonly source: Resolved;
  /** The reference it was resolved for, where it was resolved for one. */
  readonly reference: Reference | undefined;
}

/**
 * List what `target` requires: the sources among its rule's requirements, and
 * among the requirements of what its rule builds under the target's own name
 * (a rule block's result, the target under another operation), which is part
 * of the target, not something it requires. `parts` are the targets walked,
 * `target` first. Each source is listed once: the copies of one node (each
 * part reads its own) by their content key, a reference to a target by what
 * it names.
 */
export function requiredSources(target: ResolvedTarget): { parts: ResolvedTarget[]; required: RequiredSource[] } {
  const parts: ResolvedTarget[] = [];
  const required: RequiredSource[] = [];
  const first = firstOfEach();
  const walk = (part: ResolvedTarget): void => {
    parts.push(part);
    for (const [requirement, sources] of part.resolved.sources) {
      const references = part.resolved.references.get(requirement) ?? [];
      sources.forEach((source, at) => {
        if (source instanceof ResolvedNode && source.content.builds === target.content.builds) {
          if (source instanceof ResolvedTarget && !parts.includes(source)) {
            walk(source);
          }
          return;
        }
        if (first(source)) {
          required.push({ part, requirement, source, reference: references[at] });
        }
      });
    }
  };
  walk(target);
  return { parts, required };
}

/**
 * List the sources among `resolved`, the requirements of a declaration that
 * is no target (a catalog's), each once, as {@link requiredSources} lists a
 * target's.
 */
export function declaredSources(resolved: ResolvedRequirements): Array<Omit<RequiredSource, "part">> {
  const first = firstOfEach();
  return [...resolved.sources].flatMap(([requirement, sources]) => {
    const references = resolved.references.get(requirement) ?? [];
    return sources.flatMap((source, at) => (first(source) ? [{ requirement, source, reference: references[at] }] : []));
  });
}

/** @return true if `resolved` is what a name denotes ({@link ResolvedRequirements.of}), otherwise false: it is a declaration's requirements. */
export function isDenoted(resolved: ResolvedRequirements): boolean {
  return resolved.sources.has("");
}

/** Make a test of whether a source is the first of its kind seen: the copies of one node by their content key, a reference to a target by what it names. */
function firstOfEach(): (source: Resolved) => boolean {
  const seen = new Set<unknown>();
  return source => {
    const identity =
      source instanceof TargetRef
        ? [source.toString(), ...source.projections.map(({ pattern, prefix }) => `${prefix} ${pattern.toString()}`)].join(":")
        : source instanceof ResolvedNode
          ? source.content.key
          : source;
    if (seen.has(identity)) {
      return false;
    }
    seen.add(identity);
    return true;
  };
}

/** List the edges to the packages among `sources`, each with the reference it
 * was resolved for (aligned with `sources`). */
export function edgesOf(sources: ReadonlyArray<Resolved>, references: ReadonlyArray<Reference | undefined>): Dependency[] {
  return sources.flatMap((source, at): Dependency[] => {
    const reference = references[at];
    return isPackage(source) && reference !== undefined ? [{ reference, package: source }] : [];
  });
}

/**
 * List the edges a name's dependencies start from: for one target, the
 * packages among what it requires ({@link requiredSources}); for a
 * declaration's requirements, the packages among them ({@link
 * declaredSources}); for anything else, the packages among what the name
 * denotes.
 */
export function rootEdges(resolved: ResolvedRequirements): Dependency[] {
  if (!isDenoted(resolved)) {
    const required = declaredSources(resolved);
    return edgesOf(
      required.map(each => each.source),
      required.map(each => each.reference)
    );
  }
  const [only] = resolved.denoted;
  if (resolved.denoted.length === 1 && only instanceof ResolvedTarget) {
    return requiredEdges(only);
  }
  return edgesOf(resolved.denoted, resolved.references.get("") ?? []);
}

/** List the edges to the packages among what `target` requires ({@link requiredSources}). */
export function requiredEdges(target: ResolvedTarget): Dependency[] {
  const { required } = requiredSources(target);
  return edgesOf(
    required.map(each => each.source),
    required.map(each => each.reference)
  );
}

/**
 * Resolve the edges to the targets `target` requires for their files: one per
 * {@link TargetRef} among {@link requiredSources}, its reference that one.
 * What they build becomes part of what `target` builds.
 */
export function targetsReadForFiles(target: ResolvedTarget): Computable<Dependency[]> {
  const refs = requiredSources(target).required.flatMap(({ source }) => (source instanceof TargetRef ? [source] : []));
  return Computable.forAll(
    refs.map(ref => ref.resolveTarget()),
    (...nodes: ResolvedNode[]) =>
      nodes.flatMap((node, at): Dependency[] => (node instanceof ResolvedTarget ? [{ reference: refs[at], package: node }] : []))
  );
}

/** An edge a walk of what a name's build is made of follows, and whether the
 * package it binds is wholly part of that build: a target whose files another
 * target takes in. */
export interface WalkedEdge {
  readonly edge: Dependency;
  readonly whole: boolean;
}

/**
 * List the edges a walk of what a name's build is made of follows from `pkg`:
 * where `whole`, everything it requires ({@link requiredEdges}), otherwise what
 * it passes on; then, for a target, the targets it reads for their files,
 * which `readFor` looks up ({@link walkReadingFiles}).
 */
export function walkedEdges(
  pkg: Package,
  whole: boolean,
  readFor: (target: ResolvedTarget) => ReadonlyArray<Dependency>
): WalkedEdge[] {
  const target = pkg instanceof ResolvedTarget ? pkg : undefined;
  return [
    ...(whole && target !== undefined ? requiredEdges(target) : pkg.dependencies).map(edge => ({ edge, whole: false })),
    ...(target === undefined ? [] : readFor(target)).map(edge => ({ edge, whole: true })),
  ];
}

/**
 * List the edges a walk of what the name that resolved to `resolved` is made
 * of starts from: for one target, everything it requires and the targets it
 * reads for their files; for anything else, the packages among what it denotes.
 */
export function nameEdges(
  resolved: ResolvedRequirements,
  readFor: (target: ResolvedTarget) => ReadonlyArray<Dependency>
): WalkedEdge[] {
  const [only] = resolved.denoted;
  return resolved.denoted.length === 1 && only instanceof ResolvedTarget
    ? walkedEdges(only, true, readFor)
    : rootEdges(resolved).map(edge => ({ edge, whole: false }));
}

/**
 * Resolve the targets each target the walk of what the name that resolved to
 * `resolved` is made of reaches reads for their files ({@link nameEdges},
 * {@link walkedEdges}), by the target that reads them.
 */
export function targetsReadWithin(resolved: ResolvedRequirements): Computable<ReadonlyMap<ResolvedTarget, ReadonlyArray<Dependency>>> {
  return walkReadingFiles(readFor => {
    const read = new Map<ResolvedTarget, ReadonlyArray<Dependency>>();
    const recorded = (target: ResolvedTarget): ReadonlyArray<Dependency> => {
      const edges = readFor(target);
      read.set(target, edges);
      return edges;
    };
    const seen = new Map<Package, Set<boolean>>();
    const visit = (edges: ReadonlyArray<WalkedEdge>): void => {
      for (const { edge, whole } of edges) {
        const pkg = edge.package;
        if (pkg === undefined || seen.get(pkg)?.has(whole)) {
          continue;
        }
        seen.set(pkg, (seen.get(pkg) ?? new Set<boolean>()).add(whole));
        visit(walkedEdges(pkg, whole, recorded));
      }
    };
    visit(nameEdges(resolved, recorded));
    return read;
  });
}

/**
 * Run `walk` over what has been resolved of the targets each target reads for
 * its files, looked up through the `readFor` it is given (none yet where a
 * target's are not resolved), and again with those it looked up resolved,
 * until it looks up none that are not: its last result.
 */
export function walkReadingFiles<T>(walk: (readFor: (target: ResolvedTarget) => ReadonlyArray<Dependency>) => T): Computable<T> {
  const attempt = (read: ReadonlyMap<ResolvedTarget, Dependency[]>): Computable<T> => {
    const unread = new Set<ResolvedTarget>();
    const result = walk(target => {
      const edges = read.get(target);
      if (edges === undefined) {
        unread.add(target);
      }
      return edges ?? [];
    });
    if (unread.size === 0) {
      return Computable.resolve(result);
    }
    const targets = [...unread];
    return Computable.forAll(targets.map(targetsReadForFiles), (...edges: Dependency[][]) =>
      attempt(new Map([...read, ...targets.map((target, at) => [target, edges[at]] as const)]))
    );
  };
  return attempt(new Map());
}

/**
 * @return the registry package the target `pkg` is made from, where it
 * `extends` exactly one, directly or through targets that each extend exactly
 * one, with the advisories those targets declare their builds fix; otherwise
 * undefined.
 */
export function madeFrom(pkg: Package): { readonly from: Package; readonly fixes: ReadonlyArray<string> } | undefined {
  if (!(pkg instanceof ResolvedTarget)) {
    return undefined;
  }
  const sources = pkg.resolved.sources.get(EXTENDS_KEY) ?? [];
  const [only] = sources;
  if (sources.length !== 1 || !isPackage(only)) {
    return undefined;
  }
  if (!builtInProject(only.origin)) {
    return { from: only, fixes: pkg.resolved.fixes };
  }
  const inner = madeFrom(only);
  return inner === undefined ? undefined : { from: inner.from, fixes: [...pkg.resolved.fixes, ...inner.fixes] };
}

/** A target of a project as it is described, under one of the operations it is described under. */
export interface IDescribingTarget {
  name: string;
  operation: string;
  /** Its description as it lies in the cache's tree pool, or undefined where
   * its rule describes nothing; a rejection where describing it failed. */
  described: Computable<IPooledDescription | undefined>;
}

/** A description put in the cache's tree pool: the description, and the directory its tree lies at. */
export interface IPooledDescription {
  directory: string;
  description: IDescription;
}

/** What {@link describeOperation} yields: each target as it is described, and their settling, all together. */
export interface IDescribing {
  targets: IDescribingTarget[];
  settled: Computable<void>;
}

/**
 * Describe every target the project's own files declare, under each of
 * `DESCRIBED_OPERATIONS` its type has a rule for, as that operation would
 * build it, and put each description in the cache's tree pool. `configOf`
 * makes an operation's configuration and `refFor` the reference naming a
 * target.
 *
 * Each target's `described` settles on its own, and again whenever its
 * description changes; it is undefined where the target's rule describes
 * nothing, and rejects where describing it fails. `settled` settles once
 * every target's has, whether or not it failed.
 */
export function describeOperation(
  model: BuildModel,
  configOf: (operation: string) => BuildContext,
  refFor: (name: string) => INameValue,
  execution: ExecutionContext
): IDescribing {
  const targets = model
    .getTargets()
    .filter(({ decl }) => decl.source.fs !== execution.absFileSource)
    .flatMap(({ name, decl }) =>
      DESCRIBED_OPERATIONS.filter(operation => model.getOperations(decl.type).includes(operation)).map(
        (operation): IDescribingTarget => ({
          name,
          operation,
          described: configOf(operation)
            .describe(refFor(name))
            .then(tree =>
              tree === undefined
                ? undefined
                : Computable.forAll([execution.buildCache.ensureTree(tree), tree.get(DESCRIPTION_FILE)], (directory, file) =>
                    file === undefined
                      ? undefined
                      : readJsonFile(file, toDescription).then(description => ({ directory, description }))
                  )
            ),
        })
      )
    );
  /* A target's failure is its own: `settled` waits for it and does not reject. */
  const settled = Computable.forAll(
    targets.map(({ described }) =>
      described.then(
        (): void => undefined,
        (): void => undefined
      )
    ),
    (): void => undefined
  );
  return { targets, settled };
}

/**
 * Mark the target each of `names` references to be rebuilt rather than
 * served from the cache (the driver's `-f`; see
 * {@link ExecutionContext.forceTarget}). A name that references no declared
 * target (`@npm:esbuild`) marks nothing.
 */
export function forceTargets(model: BuildModel, execution: ExecutionContext, names: string[]): void {
  for (const name of names) {
    const target = model.getReferencedTarget(name);
    if (target) {
      execution.forceTarget(target);
    }
  }
}

/**
 * Package every member of each `sync` result among `sources`, which packages a
 * member only when something names it, so that building a `sync` target
 * packages everything it would publish, without publishing it.
 */
function realiseNamespaces(sources: SourceRef[]): Computable<unknown> {
  return Computable.forAll(
    sources.filter((source): source is SyncSource => source instanceof SyncSource).map(release => release.members()),
    (...realised: unknown[]) => realised
  );
}
