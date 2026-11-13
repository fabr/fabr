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

import { chainSteps } from "../core/Provenance";
import { ProvenanceLabel } from "../model/Errors";
import { Computable } from "../core/Computable";
import { ConflictError, FabrError, IConflictSource, RequirementResolutionError, TargetNotPackageError, toError } from "../core/Errors";
import { FileSetRef } from "../core/FileSetRef";
import { EMPTY_FILESET, FileSet } from "../core/FileSet";
import { RunnableFileSet } from "../core/RunnableFileSet";
import { materializeTargets, TargetRef, Unbuilt } from "../core/TargetRef";
import type { Reference } from "../core/Reference";
import { isIncompleteRef, refuseNamespaces } from "../core/NamespaceRef";
import {
  contentOf,
  Dependency,
  dependencyName,
  equalNodes,
  isPackage,
  describePackages,
  materializePackages,
  Package,
  PackageFileSet,
  PackageGraphBuilder,
  packageNodeSignature,
  reachableNodes,
  ResolvedNode,
  UsedFor,
} from "../core/PackageFileSet";
import {
  isRepositoryCollection,
  isRepositoryReader,
  Materialized,
  PendingFiles,
  ProjectedPackage,
  RefSource,
  RepositoryCollection,
  RepositoryLookup,
  RepositoryReader,
  RepositoryRef,
  Resolved,
  SourceRef,
} from "../core/Repository";
import { PackageRequest, Pin, Resolution, ResolutionContext, ResolvedCollection } from "../resolver/Types";
import { packageRequest } from "../resolver/PackageResolver";
import { DOC_OPERATION, isFilesOperation, SOURCES_OPERATION } from "../model/Constraints";
import { Conflicts, findConflicts, NO_CONFLICTS, ResolvedBatch } from "../resolver/StrictCollection";
import { constraintOf } from "../resolver/Requirement";
import type { Requirement } from "../resolver/Types";
import {
  bindBuild,
  Bound,
  checkedResolution,
  fetchPinnedPackage,
  resolvePublishedFor,
  instantiatePackage,
  isPlainNode,
  packageClosure,
  requestedConstraint,
  resolveBuilds,
  resolvePackages,
  runnableFrom,
} from "../resolver/PackageResolver";

/**
 * Select the references among `extracted` that ask for files rather than a
 * package: those with a projection, whose consumer extracts the files it
 * selects. Such a reference is no requirement. It joins no resolution, pins
 * nothing and brings no closure (see {@link RepositoryReader.fetchFiles}). A
 * reference also among `kept`, whose consumer takes the package behind the
 * projection (a runnable's entry, a contained part), stays a package request.
 */
function fileRequests(
  extracted: ReadonlyArray<SourceRef | Unbuilt>,
  kept: ReadonlyArray<SourceRef | Unbuilt> = []
): ReadonlySet<RepositoryRef> {
  const packaged = new Set<SourceRef | Unbuilt>(kept);
  return new Set(
    extracted.filter(
      (source): source is RepositoryRef => source instanceof RepositoryRef && source.projections.length > 0 && !packaged.has(source)
    )
  );
}

/**
 * Select the sources among `instantiated` taken as an instance of a package:
 * the package itself, as material to make another from, rather than a
 * requirement. What an instance requires is not resolved here; it stays on
 * the instance's dependencies, for whatever requires the package made from
 * it.
 *
 * - A reference with no projections joins no resolution and pins nothing. A
 *   registry answers it with the package carrying the requirements its
 *   version declares, as references ({@link instantiatePackage}); a catalog
 *   with the member as the catalog resolved it.
 * - A package already in hand is taken as it stands.
 */
function instanceRequests(instantiated: ReadonlyArray<SourceRef | Unbuilt>): ReadonlySet<RepositoryRef | Package> {
  return new Set(
    instantiated.filter(
      (source): source is RepositoryRef | Package =>
        isPackage(source) || (source instanceof RepositoryRef && source.projections.length === 0)
    )
  );
}

/** Get the package a resolved source is, or projects into. */
export function packageIn(source: Resolved | SourceRef | Unbuilt): Package | undefined {
  return isPackage(source)
    ? source
    : source instanceof ProjectedPackage
      ? source.base
      : source instanceof FileSetRef && source.source instanceof PackageFileSet
        ? source.source
        : undefined;
}

/** Replace the package of `source` with `pkg`, or with the files a target
 * built where it built no package. */
function withPackage(source: Resolved | SourceRef | Unbuilt, pkg: FileSet): Materialized;
function withPackage(source: Resolved | SourceRef | Unbuilt, pkg: Package | FileSet): Resolved;
function withPackage(source: Resolved | SourceRef | Unbuilt, pkg: Package | FileSet): Resolved {
  if (source instanceof ProjectedPackage || source instanceof FileSetRef) {
    return pkg instanceof FileSet
      ? new FileSetRef(pkg, source.projections, source.miss)
      : new ProjectedPackage(pkg, source.projections, source.miss);
  }
  return pkg;
}

/** Rethrow `err`, saying what a requirement bound to a target that built no
 * package asked for. */
function withConstraint(err: unknown): never {
  throw err instanceof TargetNotPackageError && isPackage(err.requirer) && err.constraint === undefined
    ? new TargetNotPackageError(
        err.requirer,
        err.dependency,
        requestedConstraint(err.requirer.getDependency(err.dependency.packageName)?.reference)
      )
    : err;
}

/** Get what a node's content holds as one set of files. Throws where it holds
 * something that is no set of files (a release's members). */
function asOneSet(content: FileSet | ReadonlyArray<SourceRef>): FileSet {
  if (content instanceof FileSet) {
    return content;
  }
  if (!content.every((source): source is FileSet => source instanceof FileSet)) {
    throw new FabrError("a selection here reaches something that is no set of files, such as a release's members").withHelp(
      "name what is inside it: a member, and the files of that"
    );
  }
  return FileSet.unionAll(...content);
}

/** List the packages among resolved sources, a pending projection's base included. */
function packagesAmong(sources: ReadonlyArray<Resolved>): Package[] {
  return sources.flatMap(source => packageIn(source) ?? []);
}

/** @return a resolved source that needs nothing fetched or built as content:
 * a projection pending over a package in hand selects from its files. */
function inHand(source: Resolved): Materialized {
  if (source instanceof ProjectedPackage && source.base instanceof PackageFileSet) {
    return withPackage(source, source.base);
  }
  if (
    source instanceof TargetRef ||
    source instanceof PendingFiles ||
    source instanceof ResolvedNode ||
    source instanceof ProjectedPackage
  ) {
    throw new FabrError("internal: a source that must be fetched or built was taken as content");
  }
  return source;
}

/** @return what `answers` holds for `key`, materialized beside it. */
function answerFor<K, V>(answers: ReadonlyMap<K, V>, key: K): V {
  const answer = answers.get(key);
  if (answer === undefined) {
    throw new FabrError("internal: a target or a file request was materialized with nothing for it");
  }
  return answer;
}

/** @return what a target built, as content: a build answers with no reference left to resolve. */
function builtContent(sources: ReadonlyArray<SourceRef>): Materialized[] {
  return refuseNamespaces(sources).map(source => {
    if (source instanceof RepositoryRef || source instanceof TargetRef) {
      throw new FabrError(`internal: a target's build answered with the reference '${source.toString()}'`);
    }
    return source;
  });
}

/**
 * Materialize resolved lists: fetch or build the files of each package among
 * them and of every package it reaches, build each target still unbuilt, and
 * fetch each pending file request. This is the one place a collection fetches
 * or builds. `references` holds, aligned with `lists`, the written reference
 * each entry was resolved for, as {@link resolveLists} returns them.
 *
 * @return the lists materialized, with their references aligned with them.
 * Each entry becomes:
 * - for a package, the package with its files, a projection pending over it
 *   kept pending over the package with files;
 * - for a target built as a package, that package; for a target that built
 *   files, each source it built as an entry of its own (a projection over it
 *   selects from them as one set);
 * - for a pending file request, its files;
 * - for anything already in hand, itself.
 *
 * An entry that becomes several carries its reference to each. Rejects with
 * a {@link TargetNotPackageError} where a target answering a registry's
 * reference, or bound to a package's requirement, built no package.
 */
export function materializeLists(
  lists: ReadonlyArray<ReadonlyArray<Resolved>>,
  references: ReadonlyArray<ReadonlyArray<Reference | undefined>>,
  /* Describe the packages a target builds, where its rule describes it (see describePackages). */
  describe = false
): Computable<{ lists: Materialized[][]; references: Array<Array<Reference | undefined>> }> {
  const referenceOf = (list: number, at: number): Reference | undefined => references[list]?.[at];
  const packages = lists.flatMap(packagesAmong);
  const targets = lists.flat().filter((source): source is TargetRef => source instanceof TargetRef);
  const pending = lists.flat().filter((source): source is PendingFiles => source instanceof PendingFiles);
  if (targets.length === 0 && pending.length === 0 && !reachableNodes(packages).some(pkg => pkg instanceof ResolvedNode)) {
    return Computable.resolve({
      lists: lists.map(list => list.map(inHand)),
      references: lists.map((list, index) => list.map((_, at) => referenceOf(index, at))),
    });
  }
  return Computable.forAll(
    [
      (describe ? describePackages(packages) : materializePackages(packages)).catch(withConstraint),
      Computable.forAll(
        targets.map(target => materializeTargets([target])),
        (...built: SourceRef[][]) => built
      ),
      Computable.forAll(
        pending.map(files => files.fetch()),
        (...fetched: Array<FileSet | FileSetRef>) => fetched
      ),
    ] as const,
    (withFiles, built, fetched) => {
      const held = new Map<Package, PackageFileSet | ReadonlyArray<SourceRef>>(packages.map((pkg, index) => [pkg, withFiles[index]]));
      /* A target that answers a registry's reference must build the package it names. */
      lists.forEach((list, index) =>
        list.forEach((source, at) => {
          const reference = referenceOf(index, at);
          const pkg = packageIn(source);
          if (reference?.requiresPackage === true && pkg !== undefined && isBuild(pkg) && !(held.get(pkg) instanceof PackageFileSet)) {
            throw new TargetNotPackageError(reference as RepositoryRef, pkg);
          }
        })
      );
      const delivered = new Map<TargetRef, Materialized[]>(targets.map((target, index) => [target, builtContent(built[index])]));
      const files = new Map<PendingFiles, FileSet | FileSetRef>(pending.map((request, index) => [request, fetched[index]]));
      const materialized = lists.map(list =>
        list.map((source): Materialized[] => {
          if (source instanceof TargetRef) {
            return answerFor(delivered, source);
          }
          if (source instanceof PendingFiles) {
            return [answerFor(files, source)];
          }
          const pkg = packageIn(source);
          const made = pkg === undefined ? undefined : held.get(pkg);
          if (made === undefined) {
            return [inHand(source)];
          }
          /* A target that built no package is its sources, each its own
           * entry; a projection over it selects from them together. */
          return made instanceof PackageFileSet
            ? [withPackage(source, made)]
            : source === pkg
              ? builtContent(made)
              : [withPackage(source, asOneSet(made))];
        })
      );
      return {
        lists: materialized.map(list => list.flat()),
        references: materialized.map((list, index) => list.flatMap((entries, at) => entries.map(() => referenceOf(index, at)))),
      };
    }
  );
}

/**
 * Resolve one repository's batch of requests, answering each, aligned with
 * `requests`, as its repository's kind says:
 *
 * - A registry resolves its package requests jointly
 *   ({@link resolvePackages}, then {@link packageClosure}), each answered as
 *   the registry's {@link RepositoryReader.operation operation} says: its
 *   node, or under `run` the node of the program it is ({@link runnableNode}),
 *   or an empty set where the resolution selects nothing for it. Under a
 *   `files` operation each is answered with its files {@link PendingFiles
 *   pending} instead, and nothing is resolved.
 * - A catalog answers each with its member ({@link resolveMember}).
 * - Any other repository answers each reference on its own
 *   ({@link resolveLookup}).
 *
 * Whatever the repository, an instance request is answered by
 * {@link resolveInstance}, and a request for files with its files, fetched
 * now. Given `resolution`, the batch is answered from it, and it must be the
 * resolution of a batch these requests are among, so that a subset keeps the
 * joint selection; absent, the batch is resolved afresh. `resolvedMembers`
 * holds each catalog member as resolved, made when first asked for.
 */
function resolveBatch(
  context: ResolutionContext,
  source: RefSource,
  requests: ReadonlyArray<PackageRequest>,
  resolution: (() => Computable<Resolution>) | undefined,
  resolvedMembers: Map<RepositoryRef, Computable<Package | undefined>>
): Computable<Array<FileSet | ResolvedNode | PendingFiles>> {
  const operation = isRepositoryReader(source) ? source.operation : undefined;
  {
    const joint =
      isRepositoryReader(source) && !isFilesOperation(operation) ? requests.filter(request => !resolvedApart(request)) : [];
    const position = new Map(joint.map((request, index) => [request, index]));
    /* One joint resolution of the batch, which runs only when a request
     * among it is answered. */
    const closures = isRepositoryReader(source) && joint.length > 0 ? assembleClosures(context, source, joint, resolution) : undefined;
    /* The joint answers, made once from the batch's closures, under `run`
     * each the node of the program it is. */
    const answered =
      closures === undefined || !isRepositoryReader(source)
        ? Computable.resolve<Array<FileSet | ResolvedNode>>([])
        : closures().then(assembled =>
            assembled.map((pkg): FileSet | ResolvedNode =>
              pkg === undefined
                ? EMPTY_FILESET
                : operation === "run"
                  ? runnableNode(pkg, held => source.format.makeRunnable(held, context))
                  : pkg
            )
          );
    const apart = requests.filter(request => !position.has(request));
    return Computable.forAll(
      [
        answered,
        ...apart.map((request): Computable<FileSet | ResolvedNode | PendingFiles> => {
          const { reference } = request;
          if (request.as === "instance") {
            return attributedTo(reference, () => resolveInstance(context, source, request, resolvedMembers));
          }
          if (isRepositoryCollection(source)) {
            return resolveMember(context, source, request, resolvedMembers).labelled(new ProvenanceLabel(reference.steps));
          }
          if (isRepositoryReader(source)) {
            if (request.as === "files") {
              return attributedTo(reference, () =>
                fetchFilesFor(source, reference, operation).then(files => new FileSet(files, files.origin))
              );
            }
            if (isFilesOperation(operation)) {
              return Computable.resolve(
                new PendingFiles(() => attributedTo(reference, () => fetchFilesFor(source, reference, operation)))
              );
            }
            throw new FabrError(`internal: '${reference.toString()}' is among the batch's joint requests`);
          }
          if (request.as === "files") {
            return source.resolveFiles !== undefined
              ? attributedTo(reference, () => source.resolveFiles!(reference).then(files => new FileSet(files, files.origin)))
              : resolveLookup(source, reference).then(answer =>
                  answer instanceof ResolvedNode ? (answer.content.files() as Computable<FileSet>) : answer
                );
          }
          return resolveLookup(source, reference);
        }),
      ] as const,
      (joint, ...resolved) => {
        const rest = resolved[Symbol.iterator]();
        return requests.map(request => (position.has(request) ? joint[position.get(request)!] : rest.next().value!));
      }
    );
  }
}

/**
 * Resolve `reference` through the lookup `source`: its files in hand, or a
 * node whose content is fetched when materialized. A failure, now or in that
 * later fetch, is attributed to the reference.
 */
function resolveLookup(source: RepositoryLookup, reference: RepositoryRef): Computable<FileSet | ResolvedNode> {
  return attributedTo(reference, () => source.resolve(reference)).then(answer =>
    answer instanceof ResolvedNode
      ? answer.withContent({ ...answer.content, files: () => attributedTo(reference, () => answer.content.files()) })
      : answer
  );
}

/**
 * @return the operation, `doc` or `sources`, under which a registry's reference
 * is answered with what its package's version publishes for it, or undefined
 * where the reference is answered with the package's own files.
 */
function publishedOperation(operation: string | undefined): string | undefined {
  return operation === DOC_OPERATION || operation === SOURCES_OPERATION ? operation : undefined;
}

/** Fetch the files `reference` names under `operation`: what its package
 * publishes for a {@link publishedOperation}, and its own files otherwise. */
function fetchFilesFor(
  source: RepositoryReader<unknown, unknown>,
  reference: RepositoryRef,
  operation: string | undefined
): Computable<FileSet> {
  const published = publishedOperation(operation);
  return published === undefined ? source.fetchFiles(reference) : resolvePublishedFor(source, reference, published);
}

/**
 * Make the node of the program `pkg` is: named and versioned as `pkg`, and
 * requiring nothing, since its closure is inside it. Materializing it gives
 * the package with its closure, made runnable by `runnable`.
 */
function runnableNode(pkg: Package, runnable: (pkg: PackageFileSet) => Computable<RunnableFileSet>): ResolvedNode {
  return new ResolvedNode(
    { key: `runnable ${contentOf(pkg).key}`, files: () => materializePackages([pkg], true).then(([held]) => runnable(held)) },
    pkg.packageName,
    pkg.version,
    [],
    pkg.origin
  );
}

/**
 * Resolve the member of the catalog `source` that `request` names, from the
 * resolution the catalog made. As the catalog's operation says: under a
 * `files` operation, the member's files alone, {@link PendingFiles pending};
 * under `run`, the node of the program it is; otherwise its package as the
 * catalog resolved it, its requirements bound as there
 * ({@link memberPackage}). A request for files is answered with the member's
 * files, fetched now.
 *
 * Rejects where a member built in the project is asked for under `run`. A
 * failure of the repository's part is attributed to the reference; a member
 * built in the project reports its own build's failure.
 */
function resolveMember(
  context: ResolutionContext,
  source: RepositoryCollection,
  request: PackageRequest,
  resolvedMembers: Map<RepositoryRef, Computable<Package | undefined>>
): Computable<FileSet | ResolvedNode | PendingFiles> {
  const { reference } = request;
  return source
    .member(reference, context.operation)
    .then((member): FileSet | ResolvedNode | PendingFiles | Computable<FileSet | ResolvedNode> => {
      const { collection, entry } = member;
      const local = isPackage(entry);
      /* Attribute only the repository's part to the reference: a package of
       * the project reports its own build failure. */
      const alone = (): Computable<FileSet> =>
        local
          ? contentOf(entry).files().then(asOneSet)
          : attributedTo(reference, () =>
              isRepositoryReader(entry.source)
                ? pinnedFiles(collection, entry, member.operation)
                : lookedUpFiles(context, collection, entry)
            );
      if (request.as === "files") {
        return alone().then(files => new FileSet(files, files.origin));
      }
      if (isFilesOperation(member.operation)) {
        return new PendingFiles(alone);
      }
      const resolved = (): Computable<Package> =>
        memberPackage(context, source, request, resolvedMembers).then(pkg => {
          if (pkg === undefined) {
            throw new FabrError(`internal: '${reference.toString()}' resolved to no package`);
          }
          return pkg;
        });
      if (member.operation !== "run") {
        return resolved();
      }
      if (local) {
        return attributedTo(reference, () => {
          const repository = reference.repositoryName ?? "its repository";
          throw new FabrError(
            `${repository} member '${reference.toString()}' is built in this project, which ${repository} cannot deliver as a runnable`
          ).withHelp(`run the target directly rather than through ${repository}`);
        });
      }
      return resolved().then(pkg =>
        runnableNode(pkg, held => attributedTo(reference, () => runnableFrom(context, entry.source, held)))
      );
    });
}

/**
 * Resolve the member of `source`'s collection that `request` names as the
 * collection did: its package, wired to that selection, made once per
 * reference (`resolvedMembers`). Undefined where the member is answered by
 * its files alone (the `files` operation).
 */
function memberPackage(
  context: ResolutionContext,
  source: RepositoryCollection,
  request: PackageRequest,
  resolvedMembers: Map<RepositoryRef, Computable<Package | undefined>>
): Computable<Package | undefined> {
  const { reference } = request;
  let held = resolvedMembers.get(reference);
  if (held === undefined) {
    held = source.member(reference, context.operation).then(({ collection, entry, operation }): Computable<Package | undefined> => {
      if (isFilesOperation(operation)) {
        return Computable.resolve(undefined);
      }
      return attributedTo(reference, () =>
        resolveSources(context, collection, [entry]).then(({ delivered: [pkg] }): Package => {
          if (!isPackage(pkg)) {
            throw new FabrError(`internal: '${reference.toString()}' resolved to no package`);
          }
          return pkg;
        })
      );
    });
    resolvedMembers.set(reference, held);
  }
  return held;
}

/** Fetch the files of the package `entry`, a lookup's reference, names, as `collection` resolved it. */
function lookedUpFiles(context: ResolutionContext, collection: ResolvedCollection, entry: RepositoryRef): Computable<FileSet> {
  return resolveSources(context, collection, [entry]).then(({ delivered: [answer] }) =>
    isPackage(answer) ? contentOf(answer).files().then(asOneSet) : (answer as FileSet)
  );
}

/** Fetch the package `entry` names, alone, at the version `collection` resolved it to, or what
 * that version publishes for a {@link publishedOperation} `operation`. */
function pinnedFiles(collection: ResolvedCollection, entry: RepositoryRef, operation: string): Computable<FileSet> {
  const source = entry.source;
  const resolution = collection.resolutions.get(source);
  if (!isRepositoryReader(source) || resolution === undefined) {
    throw new FabrError(`internal: '${entry.toString()}' has no resolution in its collection`);
  }
  return resolution()
    .then(resolved => fetchPinnedPackage(source, entry, resolved, publishedOperation(operation)))
    .then(files => entry.applyTo(files) as FileSet);
}

/**
 * Make a thunk for the closures of `requests`, one per request (undefined
 * where the resolution selects nothing), from one resolution of the batch
 * (`resolution`, or a fresh one). The resolution runs once, when the thunk is
 * first called, and not at all where it never is.
 */
function assembleClosures<V, C>(
  context: ResolutionContext,
  source: RepositoryReader<V, C>,
  requests: ReadonlyArray<PackageRequest>,
  resolution: () => Computable<Resolution> = () => resolvePackages(context, source, requests)
): () => Computable<(Package | undefined)[]> {
  let started: Computable<(Package | undefined)[]> | undefined;
  return () => {
    if (!started) {
      started = resolution().then(resolved => packageClosure(context, source, requests, resolved));
    }
    return started;
  };
}

/**
 * The markers a collection's own target references carry (`foo!`, `foo?`), by
 * the node each became: a resolution reads them as it reads a reference's.
 */
export type Markers = Map<Package, "force" | "alternate">;

/** Record `ref`'s marker in `markers` on the `nodes` it became, and return
 * the nodes the collection keeps: none for an alternate, which, like a
 * registry's `?`, resolves to no source. */
export function consumeMarker(ref: TargetRef, nodes: Unbuilt[], markers: Markers): Unbuilt[] {
  const override = ref.override;
  if (override === undefined) {
    return nodes;
  }
  nodes.filter((node): node is ResolvedNode => node instanceof ResolvedNode).forEach(node => markers.set(node, override));
  return override === "alternate" ? [] : nodes;
}

/** Get `context` as the {@link ResolutionContext} of a collection resolved for
 * `operation`: `context` itself where that is its own operation. */
export function withOperation(context: ResolutionContext, operation: string): ResolutionContext {
  return operation === context.operation
    ? context
    : {
        name: context.name,
        operation,
        given: context.given,
        getGlobalString: name => context.getGlobalString(name),
        launchedBy: (runnable, interpreter, interpreterArgs) => context.launchedBy(runnable, interpreter, interpreterArgs),
        memoize: (tag, key, create) => context.memoize(tag, key, create),
        runTask: (task, run) => context.runTask(task, run),
      };
}

/** @return the collection a resolution for `operation` is: the `build` one
 * for `build`, the `run` one for any other. */
export function usedForOf(operation: string): UsedFor {
  return operation === "build" ? "build" : "run";
}

/**
 * Remove, from the nodes among `sources` and the nodes they reach, the
 * requirements passed on only to the other collection than the one
 * `operation` resolves ({@link PackageMetadata.usedFor}; {@link usedForOf}).
 * Each node with such a requirement, or reaching one, is copied without them,
 * and a projection pending over such a node is made over its copy; `markers`
 * is moved onto the copies. Every other source, and every package in hand,
 * comes back as it is, and `sources` itself where nothing changes.
 */
export function sidedNodes<T extends SourceRef | Unbuilt>(sources: T[], operation: string, markers: Markers): T[] {
  const side = usedForOf(operation);
  /** @return the node `source` is, or the one a projection pends over. */
  const nodeOf = (source: T): ResolvedNode | undefined =>
    source instanceof ResolvedNode
      ? source
      : source instanceof ProjectedPackage && source.base instanceof ResolvedNode
        ? source.base
        : undefined;
  const leftOut = (pkg: Package, dep: Dependency): boolean => {
    const only = pkg.usedFor.get(dependencyName(dep));
    return only !== undefined && only !== side;
  };
  /* Which nodes change: one with a requirement left out, and whatever reaches one. */
  const reached = new Set<ResolvedNode>();
  const parents = new Map<ResolvedNode, ResolvedNode[]>();
  const pending = sources.map(nodeOf).filter((node): node is ResolvedNode => node !== undefined);
  const changed = new Set<ResolvedNode>();
  while (pending.length > 0) {
    const pkg = pending.pop()!;
    if (reached.has(pkg)) {
      continue;
    }
    reached.add(pkg);
    for (const dep of pkg.dependencies) {
      if (leftOut(pkg, dep)) {
        changed.add(pkg);
      } else if (dep.package instanceof ResolvedNode) {
        parents.set(dep.package, [...(parents.get(dep.package) ?? []), pkg]);
        pending.push(dep.package);
      }
    }
  }
  if (changed.size === 0) {
    return sources;
  }
  const spreading = [...changed];
  while (spreading.length > 0) {
    for (const parent of parents.get(spreading.pop()!) ?? []) {
      if (!changed.has(parent)) {
        changed.add(parent);
        spreading.push(parent);
      }
    }
  }
  const builder = new PackageGraphBuilder();
  const made = new Map<ResolvedNode, ResolvedNode>();
  const copy = (pkg: ResolvedNode): ResolvedNode => {
    const held = made.get(pkg);
    if (held !== undefined) {
      return held;
    }
    const node = builder.copy(pkg);
    made.set(pkg, node);
    const kept = pkg.dependencies.filter(dep => !leftOut(pkg, dep));
    builder.wire(
      node,
      kept.map((dep): Dependency =>
        dep.package instanceof ResolvedNode && changed.has(dep.package)
          ? { reference: dep.reference, package: copy(dep.package) }
          : dep
      ),
      pkg.provided,
      new Map([...pkg.usedFor].filter(([, only]) => only === side))
    );
    return node;
  };
  const result = sources.map((source): T => {
    const node = nodeOf(source);
    if (node === undefined || !changed.has(node)) {
      return source;
    }
    return (source instanceof ProjectedPackage
      ? new ProjectedPackage(copy(node), source.projections, source.miss)
      : copy(node)) as unknown as T;
  });
  builder.seal();
  for (const [pkg, node] of made) {
    const marker = markers.get(pkg);
    if (marker !== undefined) {
      markers.delete(pkg);
      markers.set(node, marker);
    }
  }
  return result;
}

/**
 * Set up the resolution of `sources` as one collection, resolving nothing yet:
 * gather a request for each reference among them and each reference their
 * packages carry ({@link gatherRequirements}), and make each registry's
 * resolution of its batch, run when first asked for, with the packages built
 * in the project as candidates of every one. The instances of one registry
 * (one `identity`) whose {@link RepositoryReader.environmentKey environments}
 * agree share one resolution. Each batch's resolution is given as pins the
 * registry's selections the sources' bound requirements lead to and those
 * each requested catalog member reaches, except on a name one of the
 * collection's builds answers for.
 *
 * The references in `files` are {@link fileRequests file requests}, and those
 * in `instances` {@link instanceRequests instance requests}; neither joins a
 * resolution, and a package among `instances` is taken as it stands.
 * `markers` holds the markers on the collection's own target references; a
 * build marked `?` is a candidate though no source holds it.
 *
 * @return the {@link ResolvedCollection}.
 */
export function resolveCollection(
  context: ResolutionContext,
  sources: Array<SourceRef | Unbuilt>,
  files?: ReadonlySet<RepositoryRef>,
  instances?: ReadonlySet<RepositoryRef | Package>,
  /** The markers the collection's own target references carried. */
  markers: Markers = new Map()
): ResolvedCollection {
  const held = new Set([...(instances ?? [])].filter(isPackage));
  const gathered = gatherRequirements(sources.filter(source => !(isPackage(source) && held.has(source))));
  const resolvedMembers = new Map<RepositoryRef, Computable<Package | undefined>>();
  const requests = gathered.requests.map((request): PackageRequest =>
    files?.has(request.reference) === true
      ? { ...request, as: "files" }
      : instances?.has(request.reference) === true
        ? { ...request, as: "instance" }
        : request
  );
  /* The collection's own builds, each with its marker. A build marked `?` is
   * among them though no source holds it: like a registry's `?`, it is a
   * requirement of the collection that resolves to no source. */
  const alternates = [...markers].filter(([, marker]) => marker === "alternate").map(([pkg]) => pkg);
  const locals = [...gathered.locals, ...alternates.filter(pkg => !gathered.locals.includes(pkg))];
  const own = new Map<Package, Requirement["override"]>([
    ...[...gathered.own].map((pkg): [Package, Requirement["override"]] => [pkg, markers.get(pkg)]),
    ...alternates.map((pkg): [Package, Requirement["override"]] => [pkg, "alternate"]),
  ]);
  const resolutions = new Map<RefSource, () => Computable<Resolution>>();
  /* The instances of one registry (one identity) resolve together, apart only
   * where their environment differs. Each reference is still answered by its
   * own instance. */
  const registries = new Map<string, Array<[RepositoryReader<unknown, unknown>, PackageRequest[]]>>();
  for (const [source, batch] of groupRequests(requests)) {
    /* A registry under the `files` operation resolves nothing: its
     * references are answered by their files, as a request for files is. */
    const packaged = batch.filter(request => !resolvedApart(request));
    if (isRepositoryReader(source) && !isFilesOperation(source.operation) && packaged.length > 0) {
      registries.set(source.identity, [...(registries.get(source.identity) ?? []), [source, packaged]]);
    }
  }
  /* The collection's builds answer for their names within what a catalog
   * resolved, so a catalog's selection of one of those names pins nothing. */
  const members = membersOf([...gathered.own], markers);
  const catalogued = requests.filter(request => isRepositoryCollection(request.reference.source) && request.as !== "files");
  /* The pins of the registry `identity`: the selections the sources reach
   * through bound requirements, and those each catalog member among the
   * requests reaches, as the catalog resolved it. Gather them only when a
   * registry's batch first resolves: a catalog's own resolution must not wait
   * on this one. */
  let gatheredPins: Computable<Pin[]> | undefined;
  const pinsFor = (identity: string): Computable<Pin[]> =>
    (gatheredPins ??= Computable.forAll(
      catalogued.map(request =>
        memberPackage(context, request.reference.source as RepositoryCollection, request, resolvedMembers).then(pkg =>
          pkg === undefined ? [] : pinsOf(pkg, request.reference)
        )
      ),
      (...found: Pin[][]) => [...gathered.pins, ...found.flat()]
    )).then(pins =>
      pins.filter(pin => pin.selection.registry === identity && !members.has(pin.selection.renameTo ?? pin.selection.name))
    );
  for (const [identity, group] of registries) {
    let started: Computable<Map<RefSource, Computable<Resolution>>> | undefined;
    const byEnvironment = (): Computable<Map<RefSource, Computable<Resolution>>> =>
      (started ??= Computable.forAll(
        [pinsFor(identity), ...group.map(([source]) => source.environmentKey(context.operation))] as const,
        (pins: Pin[], ...environments: string[]) => {
          const shared = new Map<string, Array<[RepositoryReader<unknown, unknown>, PackageRequest[]]>>();
          group.forEach((member, index) => shared.set(environments[index], [...(shared.get(environments[index]) ?? []), member]));
          const resolved = new Map<RefSource, Computable<Resolution>>();
          for (const members of shared.values()) {
            const sources = new Set<RefSource>(members.map(([source]) => source));
            const resolution = resolvePackages(
              context,
              members[0][0],
              members.flatMap(([, batch]) => batch),
              locals,
              own,
              sources,
              pins
            );
            members.forEach(([source]) => resolved.set(source, resolution));
          }
          return resolved;
        }
      ));
    for (const [source] of group) {
      resolutions.set(source, () => byEnvironment().then(resolved => resolved.get(source)!));
    }
  }
  return {
    requests: new Map(requests.map(request => [request.reference, request])),
    resolutions,
    ...(locals.length === 0 ? {} : { builds: buildsResolution(requests, resolutions, locals, own) }),
    locals: new Map(locals.map(pkg => [contentOf(pkg).key, pkg])),
    members,
    instances: held,
    resolvedMembers,
  };
}

/** Get {@link ResolvedCollection.members} from the builds the collection
 * requires outright: of each name, the first, unless a later one is forced
 * (`!`). */
function membersOf(own: ReadonlyArray<Package>, markers: Markers): Map<string, Package> {
  const members = new Map<string, Package>();
  for (const pkg of own) {
    if (!members.has(pkg.packageName) || markers.get(pkg) === "force") {
      members.set(pkg.packageName, pkg);
    }
  }
  return members;
}

/** Choose the resolution the builds are bound from: see {@link ResolvedCollection.builds}. */
function buildsResolution(
  requests: ReadonlyArray<PackageRequest>,
  resolutions: ReadonlyMap<RefSource, () => Computable<Resolution>>,
  locals: ReadonlyArray<Package>,
  own: ReadonlyMap<Package, Requirement["override"]>
): NonNullable<ResolvedCollection["builds"]> {
  const built = new Set(locals.map(pkg => pkg.packageName));
  const forcing = requests.find(
    ({ reference, as }) =>
      as === "package" && reference.override === "force" && built.has(reference.localName) && resolutions.has(reference.source)
  );
  const source = forcing?.reference.source ?? resolutions.keys().next().value;
  if (source === undefined || !isRepositoryReader(source)) {
    let started: Computable<Resolution> | undefined;
    return { resolution: () => (started ??= resolveBuilds(locals, own)) };
  }
  return { registry: source, resolution: resolutions.get(source)! };
}

/**
 * Resolve `sources`, which must be among those `resolved` was set up for,
 * merge the graphs they were answered from into one
 * ({@link mergeResolutions}), and fold the nodes that are one package wired
 * one way into one. Nothing is fetched or built; provided requirements are
 * left for the consumer to bind ({@link bindProvided}), and a projection
 * stays pending over its package.
 *
 * @return `delivered`, the sources as resolved, flat, with `counts` saying how
 * many entries each source became (none for a `?`); and `finished`, what each
 * reference resolved to: the sources' own, and those the collection's builds
 * carry, which a build these sources reach needs whether or not they hold it.
 * Rejects where a source is an incomplete reference, or a reference was not
 * set up in `resolved`.
 */
export function resolveSources(
  context: ResolutionContext,
  resolved: ResolvedCollection,
  sources: Array<SourceRef | Unbuilt>
): Computable<{ delivered: Resolved[]; counts: number[]; finished: Map<RepositoryRef, Resolved | RepositoryRef> }> {
  /* Each reference's request as the collection made it, so that it is
   * answered as the request its resolution was made with. */
  const requests: PackageRequest[] = [];
  const taken = (source: SourceRef | Unbuilt): boolean => isPackage(source) && resolved.instances.has(source);
  for (const { reference } of gatherReferences([...sources.filter(source => !taken(source)), ...resolved.locals.values()])) {
    const request = resolved.requests.get(reference);
    if (request === undefined) {
      return Computable.reject(
        new FabrError(`internal: '${reference.toString()}' was not resolved with the sources it is delivered among`)
      );
    }
    requests.push(request);
  }
  const builds = resolved.builds;
  return Computable.forAll(
    [
      resolveRequests(context, requests, resolved),
      builds === undefined ? Computable.resolve(undefined) : builds.resolution(),
    ] as const,
    (finished, resolution) => {
      const roots = sources.map((source): Resolved[] => {
        if (source instanceof RepositoryRef) {
          return resolvedAs(finished.get(source)!);
        } else if (isIncompleteRef(source)) {
          throw source.refused();
        }
        return [source as Resolved];
      });
      const merged = mergeResolutions(
        roots.flat().flatMap(source => (taken(source as SourceRef) ? [] : (packageIn(source) ?? []))),
        finished,
        resolved,
        builds === undefined || resolution === undefined
          ? undefined
          : (requirer: Package | undefined, dep: Package) => bindBuild(builds.registry, resolution, requirer, dep)
      );
      /* Fold what two resolutions answered with (a catalog's member and a
       * direct reference) into one node where it is one package wired one
       * way. */
      const folded = foldEqualNodes([...new Set(merged.values())]);
      const delivered = roots.map(entries =>
        entries.map(entry => {
          const pkg = packageIn(entry);
          const merge = pkg === undefined ? undefined : merged.get(pkg);
          return merge === undefined ? entry : withPackage(entry, folded.get(merge) ?? merge);
        })
      );
      return { delivered: delivered.flat(), counts: delivered.map(entries => entries.length), finished };
    }
  );
}

/**
 * Fold the nodes under `roots` that are structurally equal
 * ({@link equalNodes}) into one each, rewiring every dependency that led to a
 * duplicate onto the one kept, and return how each root appears afterwards.
 * Copies only what changes: a node that is kept and leads to no duplicate is
 * itself.
 */
function foldEqualNodes(roots: ReadonlyArray<Package>): Map<Package, Package> {
  const canonical = equalNodes(roots);
  if ([...canonical].every(([pkg, one]) => pkg === one)) {
    return new Map(roots.map(root => [root, root]));
  }
  /* Which kept nodes change: one with a dependency on a duplicate, and whatever
   * reaches one. */
  const parents = new Map<Package, Package[]>();
  const changed = new Set<Package>();
  for (const pkg of canonical.keys()) {
    for (const dep of pkg.packages) {
      parents.set(dep, [...(parents.get(dep) ?? []), pkg]);
      if (canonical.get(dep) !== dep) {
        changed.add(pkg);
      }
    }
  }
  const spreading = [...changed];
  for (let pkg = spreading.pop(); pkg !== undefined; pkg = spreading.pop()) {
    for (const parent of parents.get(pkg) ?? []) {
      if (!changed.has(parent)) {
        changed.add(parent);
        spreading.push(parent);
      }
    }
  }
  const builder = new PackageGraphBuilder();
  const made = new Map<Package, Package>();
  const fold = (pkg: Package): Package => {
    const one = canonical.get(pkg) ?? pkg;
    if (!changed.has(one)) {
      return one;
    }
    const held = made.get(one);
    if (held !== undefined) {
      return held;
    }
    const node = builder.copy(one);
    made.set(one, node);
    builder.wire(
      node,
      one.dependencies.map((dep): Dependency =>
        dep.package === undefined ? dep : { reference: dep.reference, package: fold(dep.package) }
      ),
      one.provided,
      one.usedFor
    );
    return node;
  };
  const result = new Map<Package, Package>(roots.map(root => [root, fold(root)]));
  builder.seal();
  return result;
}

/**
 * Merge the graphs a collection's sources were answered from into one, and
 * return how each of `roots` (the packages among the sources) appears in it.
 *
 * Each requirement of a package reached (a {@link Dependency}: its reference,
 * and the package it is bound to, if any) leads, by the first rule that
 * applies:
 * - for an optional provided requirement, to the package it is bound to, or
 *   nowhere where it is unbound;
 * - to the package its reference resolved to in this collection
 *   (`finished`), where that is a package;
 * - nowhere, where it is unbound;
 * - between two of the collection's builds, where the builds' resolution
 *   binds it (`bind`: the build itself, or the candidate a `!` gave the
 *   build's name to, the requirement then carrying an exact pin of that
 *   selection as its reference);
 * - otherwise, to the package it is bound to.
 *
 * A requirement keeps its reference unless `bind` gives it one. Wherever a
 * package is reached:
 * - A package another collection resolved (a catalog's member and what it
 *   reaches, or what a root reaches through bound requirements) is replaced
 *   by the build of its name that answers for it here
 *   ({@link ResolvedCollection.members}), unless this collection's own
 *   batches answered with it or reach it, or the collection names it itself
 *   as a catalog member.
 * - A build of this collection is one node however it is reached: the first
 *   reached of its content key.
 * - A root that is one of the collection's builds is bound as the
 *   collection's own requirement on it (`bind` with no requirer).
 * - Anything else is itself where nothing it reaches changes, and a copy with
 *   its requirements merged where something does.
 */
function mergeResolutions(
  roots: ReadonlyArray<Package>,
  finished: ReadonlyMap<RepositoryRef, Resolved | RepositoryRef>,
  collection: ResolvedCollection,
  bind?: (requirer: Package | undefined, dep: Package) => Bound
): Map<Package, Package> {
  const isBuildVersion = (pkg: Package): boolean => collection.locals.has(contentOf(pkg).key) && !isPlainNode(pkg);
  const answer = (reference: Reference): Package | undefined => {
    const resolved = reference instanceof RepositoryRef ? finished.get(reference) : undefined;
    return isPackage(resolved) ? resolved : undefined;
  };
  /* What a catalog's members reach, and what the roots reach through bound
   * requirements, less what this collection's own batches answered with and reach:
   * packages another collection resolved. */
  const catalogued = [...finished].flatMap(([reference, value]) =>
    isRepositoryCollection(reference.source) ? (packageIn(value) ?? []) : []
  );
  /* A member the collection itself names stands; one asked for a build's
   * carried reference is what another collection resolved, as its closure is. */
  const asked = new Set(
    [...finished].flatMap(([reference, value]) =>
      isRepositoryCollection(reference.source) && collection.requests.get(reference)?.as === "package" ? (packageIn(value) ?? []) : []
    )
  );
  const own = new Set(
    reachableNodes(
      [...finished].flatMap(([reference, value]) => (isRepositoryCollection(reference.source) ? [] : (packageIn(value) ?? [])))
    ).filter(pkg => !isBuildVersion(pkg))
  );
  const foreign = new Set(
    reachableNodes([...catalogued, ...roots]).filter(pkg => !asked.has(pkg) && !own.has(pkg) && !isBuildVersion(pkg))
  );
  /** The build of this collection that stands for `pkg`, where another
   * collection resolved it under that build's name. */
  const member = (pkg: Package): Package | undefined => {
    const held = foreign.has(pkg) && !isBuildVersion(pkg) && !isPlainNode(pkg) ? collection.members.get(pkg.packageName) : undefined;
    return held === undefined ? undefined : rooted(held);
  };
  /** A root that is one of the collection's builds, as the collection's requirement on it binds it. */
  const rooted = (pkg: Package): Package => (bind !== undefined && isBuildVersion(pkg) ? bind(undefined, pkg).package : pkg);
  /** Get where the requirement `dep` of `requirer` leads before merging, if
   * anywhere, and the reference it then carries where that changes. */
  const target = (requirer: Package, dep: Dependency): Bound | undefined => {
    if (requirer.provided.get(dependencyName(dep)) === "optional") {
      return dep.package === undefined ? undefined : { package: dep.package };
    }
    const here = answer(dep.reference);
    if (here !== undefined) {
      return { package: here };
    }
    if (dep.package === undefined) {
      return undefined;
    }
    return bind !== undefined && isBuildVersion(requirer) && isBuildVersion(dep.package)
      ? bind(requirer, dep.package)
      : { package: dep.package };
  };

  /* Which packages the merge changes: one replaced, a build that is not its
   * name's one node or whose requirements lead elsewhere, and whatever reaches one. */
  const canonical = new Map<string, Package>();
  const parents = new Map<Package, Package[]>();
  const changed = new Set<Package>();
  const seen = new Set<Package>();
  const pending = roots.map(root => rooted(root));
  for (let pkg = pending.pop(); pkg !== undefined; pkg = pending.pop()) {
    if (seen.has(pkg)) {
      continue;
    }
    seen.add(pkg);
    const instead = member(pkg);
    if (instead !== undefined) {
      changed.add(pkg);
      pending.push(instead);
      continue;
    }
    if (isBuildVersion(pkg)) {
      const key = contentOf(pkg).key;
      if (!canonical.has(key)) {
        canonical.set(key, pkg);
      } else if (canonical.get(key) !== pkg) {
        changed.add(pkg);
      }
    }
    for (const dep of pkg.dependencies) {
      const to = target(pkg, dep);
      if (to === undefined) {
        continue;
      }
      if (to.package !== dep.package || to.reference !== undefined) {
        changed.add(pkg);
      }
      parents.set(to.package, [...(parents.get(to.package) ?? []), pkg]);
      pending.push(to.package);
    }
  }
  const spreading = [...changed];
  for (let pkg = spreading.pop(); pkg !== undefined; pkg = spreading.pop()) {
    for (const parent of parents.get(pkg) ?? []) {
      if (!changed.has(parent)) {
        changed.add(parent);
        spreading.push(parent);
      }
    }
  }

  const builder = new PackageGraphBuilder();
  /* Each node made, by what it is made from. */
  const made = new Map<Package, Package>();
  const merge = (pkg: Package): Package => {
    const instead = member(pkg);
    if (instead !== undefined) {
      return merge(instead);
    }
    const one = isBuildVersion(pkg) ? (canonical.get(contentOf(pkg).key) ?? pkg) : pkg;
    if (!changed.has(one)) {
      return one;
    }
    const held = made.get(one);
    if (held !== undefined) {
      return held;
    }
    const node = builder.copy(one);
    made.set(one, node);
    builder.wire(
      node,
      one.dependencies.map((dep): Dependency => {
        const to = target(one, dep);
        return to === undefined ? dep : { reference: to.reference ?? dep.reference, package: merge(to.package) };
      }),
      one.provided,
      one.usedFor
    );
    return node;
  };
  const result = new Map<Package, Package>(roots.map(root => [root, merge(rooted(root))]));
  builder.seal();
  return result;
}

/**
 * Materialize what a name on the command line denotes, for
 * `BuildContext.materialize` (`fabr ls`/`cat`/`cp`/`run`): build each target
 * among `sources`, and resolve and fetch only the references among what they
 * hold, never those a package among them carries. Other sources pass through
 * untouched. A projected source comes back as a pending {@link FileSetRef} for
 * the caller to finish. Rejects where a source is an incomplete reference,
 * and where versions conflict among the references unless `options` is
 * permissive.
 */
export function materializeShallow(
  context: ResolutionContext,
  sources: SourceRef[],
  options?: ResolutionOptions
): Computable<Materialized[]> {
  return materializeTargets(sources).then(built => {
    const held = (built as Array<Exclude<SourceRef, TargetRef>>).map(source => {
      if (isIncompleteRef(source)) {
        throw source.refused();
      }
      return source;
    });
    const references = held.filter((source): source is RepositoryRef => source instanceof RepositoryRef);
    /* Each source as resolved, beside the reference it was resolved for. */
    interface IEntry {
      resolved: Resolved;
      reference: Reference | undefined;
    }
    const finish = (finished: Map<RepositoryRef, Resolved | RepositoryRef>): IEntry[] =>
      held.flatMap((source): IEntry[] =>
        source instanceof RepositoryRef
          ? resolvedAs(finished.get(source)!).map(resolved => ({ resolved, reference: source }))
          : [{ resolved: source, reference: undefined }]
      );
    if (references.length === 0) {
      return finish(new Map()).map(({ resolved }) => resolved) as Materialized[];
    }
    const collection = resolveCollection(context, references);
    return resolveRequests(context, references.map(packageRequest), collection).then(finished =>
      conflictsOf(context, collection, finished, [...finished.values()])
        .then(conflicts => checked(conflicts, options?.resolutionMode === "permissive"))
        .then(() => {
          const entries = finish(finished);
          return materializeLists([entries.map(({ resolved }) => resolved)], [entries.map(({ reference }) => reference)]);
        })
        .then(({ lists: [materialized] }) => materialized)
    );
  });
}

/** Reject where versions conflict in a collection, unless it is collected
 * `permissive`ly. */
export function checked(conflicts: Conflicts, permissive: boolean): Computable<void> {
  return permissive ? Computable.resolve(undefined) : refuse(conflicts);
}

/** Reject with the error a strict collection with `conflicts` is refused
 * with, if any. */
function refuse(conflicts: Conflicts): Computable<void> {
  return conflicts.error().then(error => {
    if (error !== undefined) {
      throw error;
    }
  });
}

/**
 * Find what conflicts in the collection `collection` resolved: `finished`
 * holds what each reference among it resolved to, and `shipped` what the
 * collection resolves to.
 */
function conflictsOf(
  context: ResolutionContext,
  collection: ResolvedCollection,
  finished: ReadonlyMap<RepositoryRef, Resolved | RepositoryRef>,
  shipped: ReadonlyArray<Resolved | RepositoryRef>
): Computable<Conflicts> {
  /* Each catalog member's resolutions, as batches of its catalog. */
  const members = [...finished.keys()].flatMap(reference => {
    const { source } = reference;
    const request = collection.requests.get(reference);
    return isRepositoryCollection(source) && request?.as !== "files"
      ? [
          source
            .member(reference, context.operation)
            .then(({ collection: catalog, entry, operation }) =>
              isFilesOperation(operation)
                ? []
                : resolvedBatches(catalog, entry instanceof RepositoryRef ? [entry] : []).then(batches =>
                    batches.map((batch): ResolvedBatch => ({ ...batch, catalog: true }))
                  )
            ),
        ]
      : [];
  });
  return Computable.forAll([resolvedBatches(collection, finished.keys()), ...members], (...found: ResolvedBatch[][]) => {
    const batches = mergedBatches(found.flat());
    return batches.length === 0
      ? NO_CONFLICTS
      : findConflicts(
          batches.map(batch => checkedResolution(context, batch)),
          shipped,
          finished
        );
  });
}

/**
 * Get the resolutions of `collection` that `references` were answered from,
 * each with the requests it answered, and the one the collection's builds
 * were resolved in. One resolution may come back more than once: see
 * {@link mergedBatches}.
 */
function resolvedBatches(collection: ResolvedCollection, references: Iterable<RepositoryRef>): Computable<ResolvedBatch[]> {
  const asked = new Map<RefSource, PackageRequest[]>();
  for (const reference of references) {
    const request = collection.requests.get(reference);
    if (request !== undefined && !resolvedApart(request) && collection.resolutions.has(reference.source)) {
      asked.set(reference.source, [...(asked.get(reference.source) ?? []), request]);
    }
  }
  const { builds } = collection;
  return Computable.forAll(
    [
      ...[...asked].map(([source, requests]) =>
        collection.resolutions.get(source)!().then((resolution): ResolvedBatch => ({
          registry: source as RepositoryReader<unknown, unknown>,
          resolution,
          requests,
          builds: false,
        }))
      ),
      ...(builds === undefined
        ? []
        : [
            builds
              .resolution()
              .then((resolution): ResolvedBatch => ({ registry: builds.registry, resolution, requests: [], builds: true })),
          ]),
    ],
    (...found: ResolvedBatch[]) => found
  );
}

/**
 * Merge `batches` into one per resolution: the instances of one registry
 * resolve together, and every member a catalog answers comes from its one
 * resolution.
 */
function mergedBatches(batches: ReadonlyArray<ResolvedBatch>): ResolvedBatch[] {
  const merged = new Map<Resolution, ResolvedBatch>();
  for (const batch of batches) {
    const held = merged.get(batch.resolution);
    merged.set(
      batch.resolution,
      held === undefined
        ? batch
        : {
            registry: held.registry ?? batch.registry,
            resolution: batch.resolution,
            requests: [...held.requests, ...batch.requests],
            builds: held.builds || batch.builds,
            catalog: held.catalog === true || batch.catalog === true,
          }
    );
  }
  return [...merged.values()];
}

/**
 * Resolve `lists` as one collection: every reference among them answered
 * from its repository's joint resolution, the packages built in the project
 * merged in, and provided requirements bound by their consumers
 * ({@link bindProvided}); nothing fetched or built. A package among the
 * sources that `context.given` holds is taken as it stands, as `instances`
 * are. Rejects where a list requires one name twice
 * ({@link refuseTwoOfOneName}).
 *
 * @return the sources resolved, flat (`resolved`, with `counts` per source as
 * {@link resolveSources} gives them), what conflicts among them
 * (`conflicts`), how to find what conflicts among a part of them
 * (`conflictsAmong`), and the collection.
 */
function resolveBuilt(
  context: ResolutionContext,
  lists: Array<SourceRef | Unbuilt>[],
  files?: ReadonlySet<RepositoryRef>,
  instances?: ReadonlySet<RepositoryRef | Package>,
  markers?: Markers
): Computable<{
  resolved: Resolved[];
  counts: number[];
  conflicts: Conflicts;
  conflictsAmong: ResolvedLists["conflictsAmong"];
  collection: ResolvedCollection;
}> {
  const sources = lists.flat();
  const given = context.given;
  const taken =
    given === undefined
      ? instances
      : new Set([
          ...(instances ?? []),
          ...sources.filter((source): source is PackageFileSet => source instanceof PackageFileSet && given.has(source)),
        ]);
  return Computable.resolve(undefined).then(() => {
    lists.forEach(list => refuseTwoOfOneName(list, files, taken));
    const collection = resolveCollection(context, sources, files, taken, markers);
    return resolveSources(context, collection, sources).then(({ delivered, counts, finished }) => {
      /* Find conflicts in what is bound: an offer the consumer replaced is not
       * installed, so it does not ship. */
      const bound = bindProvided(delivered, taken);
      return conflictsOf(context, collection, finished, bound).then(conflicts => ({
        resolved: bound,
        counts,
        conflicts,
        conflictsAmong: (shipped: ReadonlyArray<Resolved>) => conflictsOf(context, collection, finished, shipped),
        collection,
      }));
    });
  });
}

/**
 * Throw a {@link ConflictError} where a list requires one name twice: two of
 * its requests for a package under one name, whatever either resolves to. A
 * `?` asks for nothing, so it is no second request, and the same request
 * written twice is one. A file request, a projection, and what the collection
 * takes as it stands (`taken`) are no request for a package.
 */
function refuseTwoOfOneName(
  sources: ReadonlyArray<SourceRef | Unbuilt>,
  files?: ReadonlySet<RepositoryRef>,
  taken?: ReadonlySet<RepositoryRef | Package>
): void {
  const held = new Map<string, SourceRef | Unbuilt>();
  for (const source of sources) {
    const name = requestedName(source, files, taken);
    if (name === undefined) {
      continue;
    }
    const other = held.get(name);
    if (other === undefined) {
      held.set(name, source);
    } else if (!sameRequest(other, source)) {
      throw twoOfOneName(name, other, source);
    }
  }
}

/** Get the name `source` requests a package under, if it is a request for one. */
function requestedName(
  source: SourceRef | Unbuilt,
  files?: ReadonlySet<RepositoryRef>,
  taken?: ReadonlySet<RepositoryRef | Package>
): string | undefined {
  if (source instanceof RepositoryRef) {
    return files?.has(source) === true || source.override === "alternate" || source.projections.length > 0
      ? undefined
      : source.localName;
  }
  return isPackage(source) && taken?.has(source) !== true && !isPlainNode(source) ? source.packageName : undefined;
}

/** @return true if two requests of one name are the same request, otherwise false. */
function sameRequest(left: SourceRef | Unbuilt, right: SourceRef | Unbuilt): boolean {
  if (left instanceof RepositoryRef && right instanceof RepositoryRef) {
    const sameRegistry =
      left.source === right.source ||
      (isRepositoryReader(left.source) && isRepositoryReader(right.source) && left.source.identity === right.source.identity);
    return (
      sameRegistry &&
      left.name === right.name &&
      left.versionConstraint === right.versionConstraint &&
      left.override === right.override
    );
  }
  return isPackage(left) && isPackage(right) && contentOf(left).key === contentOf(right).key;
}

/** Make the error for two different packages a collection requires under `name`. */
function twoOfOneName(name: string, left: SourceRef | Unbuilt, right: SourceRef | Unbuilt): Error {
  const side = (source: SourceRef | Unbuilt): IConflictSource =>
    source instanceof RepositoryRef
      ? { provenance: chainSteps(source.steps, undefined) ?? undefined, detail: source.toString() }
      : { provenance: isPackage(source) ? source.origin : undefined, detail: name };
  /* Each side is named by where it was written; a detail is shown only where
   * there is nothing written to name it by. */
  const named = (source: SourceRef | Unbuilt): IConflictSource => {
    const each = side(source);
    return each.provenance === undefined ? each : { provenance: each.provenance };
  };
  const conflict = new ConflictError("packages", name, named(left), named(right));
  conflict.message = `'${name}' is required here as two different packages (from '${conflict.left.label}' and '${conflict.right.label}')`;
  return conflict.withHelp(`a target requires one package of each name: keep one, or allow the other alongside with '?'`);
}

/**
 * Bind the provided requirements ({@link PackageFileSet.provided}) of every
 * package among `sources`, and of every package they reach, each by the
 * package's consumer, and return the sources with their packages rewired. A
 * provided requirement is bound to the first of:
 *
 * - what its **dependent** binds for that name (one of the dependent's own
 *   dependencies, or the dependent's own provided binding), and so on up the
 *   chain of dependents;
 * - the collection's own **direct member** of that name, at the top of that
 *   chain: of several, the first, except that a repository's package stands
 *   before a target's, and a target known to build files is none. A renamed
 *   member answers for the name it is delivered under;
 * - for an expected (not optional) requirement, the package it is already
 *   bound to, as its resolution offered;
 * - a package the installation holds that its reference's format accepts
 *   for it ({@link answers}); of several, the one with the lowest node
 *   signature, so the choice does not follow input order. The installation
 *   is everything the sources reach other than through an optional provided
 *   requirement.
 *
 * A requirement none of these answers is left unbound, its reference alone.
 * A binding is an ordinary dependency. A package reached through dependents
 * that bind it differently comes back as one node per binding, and one bound
 * alike everywhere as one node. A package in `taken` keeps its bindings and is
 * not descended into. `sources` itself comes back where no package has a
 * provided requirement.
 */
export function bindProvided<S extends Resolved>(sources: S[], taken?: ReadonlySet<Package | RepositoryRef>): Resolved[] {
  const roots = packagesAmong(sources);
  const packages = reachableNodes(roots);
  if (!packages.some(pkg => pkg.provided.size > 0)) {
    return sources;
  }
  /* What the installation holds: everything reached by a dependency other than an
   * optional provided one, which installs nothing of its own. */
  const held = [...roots];
  const holding = new Set<Package>(held);
  for (let at = 0; at < held.length; at++) {
    for (const dep of held[at].dependencies) {
      if (dep.package !== undefined && held[at].provided.get(dependencyName(dep)) !== "optional" && !holding.has(dep.package)) {
        holding.add(dep.package);
        held.push(dep.package);
      }
    }
  }
  const present = new Map<string, Array<{ pkg: Package; signature: string }>>();
  for (const pkg of held) {
    present.set(pkg.packageName, [...(present.get(pkg.packageName) ?? []), { pkg, signature: packageNodeSignature(pkg) }]);
  }
  /** Find the package the installation holds that answers `reference` under
   * `name`: of several, the one with the lowest node signature. */
  const answering = (name: string, reference: RepositoryRef): Package | undefined =>
    (present.get(name) ?? [])
      .filter(({ pkg }) => answers(reference, pkg))
      .reduce<{ pkg: Package; signature: string } | undefined>(
        (lowest, candidate) => (lowest === undefined || candidate.signature < lowest.signature ? candidate : lowest),
        undefined
      )?.pkg;
  const wanted = providedNamesBelow(packages);
  const ids = new Map<Package, number>(packages.map((pkg, index) => [pkg, index]));

  /** What a name is supplied by: the package, and the scope its own provided
   * requirements are answered in. */
  interface ISupply {
    readonly pkg: Package;
    readonly scope: IScope;
  }
  /** One dependent's bindings by name, over its own dependent's. */
  interface IScope {
    readonly id: number;
    readonly parent?: IScope;
    readonly bindings: Map<string, ISupply>;
  }
  const supplied = (scope: IScope | undefined, name: string): ISupply | undefined => {
    for (let at = scope; at !== undefined; at = at.parent) {
      const supply = at.bindings.get(name);
      if (supply !== undefined) {
        return supply;
      }
    }
    return undefined;
  };
  let scopes = 0;
  const top: IScope = { id: scopes++, bindings: new Map() };
  /* A direct member answers for its name: the first of that name, except
   * that a repository's package stands before a target's, and a target known
   * to build files answers for none. */
  for (const root of roots) {
    const held = top.bindings.get(root.packageName)?.pkg;
    if (!isPlainNode(root) && (held === undefined || (contentOf(held).builds !== undefined && contentOf(root).builds === undefined))) {
      top.bindings.set(root.packageName, { pkg: root, scope: top });
    }
  }

  const builder = new PackageGraphBuilder();
  /** @return true if `pkg` is wired the same way in scopes `a` and `b`,
   * otherwise false: each name anything below it wants supplied is answered in
   * both by nothing, or by one package itself wired the same way in the two
   * scopes answering it. A pair
   * in `assumed` is one this comparison is already deciding, and counts as
   * alike — a package supplied by itself round a cycle is one wiring. */
  const wiredAlike = (pkg: Package, a: IScope, b: IScope, assumed: Set<string>): boolean => {
    const pair = `${ids.get(pkg)}:${a.id}:${b.id}`;
    if (a === b || assumed.has(pair)) {
      return true;
    }
    assumed.add(pair);
    return wanted.get(pkg)!.every(name => {
      const left = supplied(a, name);
      const right = supplied(b, name);
      return left === undefined || right === undefined
        ? left === right
        : left.pkg === right.pkg && wiredAlike(left.pkg, left.scope, right.scope, assumed);
    });
  };
  const copies = new Map<Package, Array<{ scope: IScope; node: Package }>>();
  /** Copy `pkg` as its dependent's `scope` wires it: one node per distinct
   * wiring ({@link wiredAlike}). */
  const copy = (pkg: Package, scope: IScope): Package => {
    /* A package the collection takes as it stands keeps its bindings. */
    if (taken?.has(pkg)) {
      return pkg;
    }
    const made = copies.get(pkg) ?? [];
    const held = made.find(other => wiredAlike(pkg, scope, other.scope, new Set()));
    if (held !== undefined) {
      return held.node;
    }
    const node = builder.copy(pkg);
    copies.set(pkg, [...made, { scope, node }]);
    const own: IScope = { id: scopes++, parent: scope, bindings: new Map() };
    /* Each dependency with what supplies it: an ordinary one is supplied by
     * what it is bound to, here; a provided one is decided below. */
    const edges = pkg.dependencies.map(dep => {
      const provided = pkg.provided.has(dependencyName(dep));
      const supply: ISupply | undefined = !provided && dep.package !== undefined ? { pkg: dep.package, scope: own } : undefined;
      if (supply !== undefined) {
        own.bindings.set(supply.pkg.packageName, supply);
      }
      return { dep, provided, supply };
    });
    /* Decide every binding before copying anything below: how a dependency
     * is wired depends on all of them. */
    const bound = edges.map(({ dep, provided, supply }) => {
      if (!provided) {
        return { dep, supply };
      }
      const name = dependencyName(dep);
      /* Never answer an optional one with the package it is bound to (for a
       * built package, the copy it was compiled against): only with what the
       * consumer supplies or its installation holds. */
      const optional = pkg.provided.get(name) === "optional";
      const answer =
        supplied(scope, name) ??
        (dep.package !== undefined && !optional
          ? { pkg: dep.package, scope: own }
          : dep.reference instanceof RepositoryRef
            ? ((held): ISupply | undefined => held && { pkg: held, scope: top })(answering(name, dep.reference))
            : undefined);
      if (answer !== undefined) {
        own.bindings.set(name, answer);
      }
      return { dep, supply: answer };
    });
    builder.wire(
      node,
      /* A requirement nothing answers keeps its reference alone, unbound (an
       * optional one would otherwise keep the package it was built
       * against). */
      bound.map(({ dep, supply }) =>
        supply === undefined ? { reference: dep.reference } : { reference: dep.reference, package: copy(supply.pkg, supply.scope) }
      ),
      pkg.provided,
      pkg.usedFor
    );
    return node;
  };
  const result = sources.map((source): Resolved => {
    const pkg = packageIn(source);
    return pkg === undefined ? source : withPackage(source, copy(pkg, top));
  });
  builder.seal();
  return result;
}

/**
 * Collect, for each package, the provided names that it or anything it
 * reaches asks to be supplied, sorted: the names whose answers decide how its
 * subtree is wired.
 */
function providedNamesBelow(packages: Package[]): Map<Package, string[]> {
  const names = new Map(packages.map(pkg => [pkg, new Set(pkg.provided.keys())]));
  for (let changed = true; changed;) {
    changed = false;
    for (const pkg of packages) {
      const own = names.get(pkg)!;
      for (const dep of pkg.packages) {
        for (const name of names.get(dep) ?? []) {
          if (!own.has(name)) {
            own.add(name);
            changed = true;
          }
        }
      }
    }
  }
  return new Map([...names].map(([pkg, wanted]) => [pkg, [...wanted].sort()]));
}

/**
 * Resolve several source lists as ONE collection, so every reference across
 * them resolves together, and materialize them, returning the results
 * partitioned back per input list. Rejects where versions conflict, unless
 * `options` is permissive. For a collection made in one step, such as a tool
 * read to be run (`getGlobalRunnable`/`getRunnableProperty`, a command stage),
 * a command's `<` source, or `TargetContext.materializeSources`.
 *
 * `extracted` says, per list, whether its consumer extracts the files a
 * projection selects (so the list's projected references are
 * {@link fileRequests file requests}) rather than taking the package behind
 * it. Absent, no list is extracted. `instantiated` says, per list, whether its
 * consumer takes each package the list names as an
 * {@link instanceRequests instance}. Absent, no list is.
 */
export function collectLists(
  context: ResolutionContext,
  lists: SourceRef[][],
  options?: ResolutionOptions,
  extracted?: ReadonlyArray<boolean>,
  instantiated?: ReadonlyArray<boolean>
): Computable<Materialized[][]> {
  return resolveLists(context, lists, extracted, instantiated).then(({ lists: resolved, references, conflicts }) =>
    checked(conflicts, options?.resolutionMode === "permissive")
      .then(() => materializeLists(resolved, references))
      .then(({ lists: materialized }) => materialized)
  );
}

/**
 * Resolve several source lists as one collection, as {@link collectLists}
 * does, without materializing them, and leave the strict check to the caller:
 * `conflicts` is what conflicts in what was resolved. For a collection checked
 * only when it is given its content, and for a reading not checked at all.
 */
export function resolveLists(
  context: ResolutionContext,
  lists: SourceRef[][],
  extracted?: ReadonlyArray<boolean>,
  instantiated?: ReadonlyArray<boolean>,
  /** The lists read for {@link ListFiles files} alone. */
  reads?: ReadonlyArray<ListFiles | undefined>
): Computable<ResolvedLists> {
  return resolveListsFor(context, [context.operation], lists, extracted, instantiated, reads).then(([resolved]) => resolved);
}

/**
 * Resolve the same source lists as {@link resolveLists} does, once for each
 * of `operations`, a collection per operation, aligned with them. Where two
 * operations resolve the lists alike ({@link resolvedAlike}), they share one
 * collection.
 */
export function resolveListsFor(
  context: ResolutionContext,
  operations: ReadonlyArray<string>,
  lists: SourceRef[][],
  extracted?: ReadonlyArray<boolean>,
  instantiated?: ReadonlyArray<boolean>,
  reads?: ReadonlyArray<ListFiles | undefined>
): Computable<ResolvedLists[]> {
  /* A target is wired in as a node, with what it passes on. One whose files
   * alone a list takes stays a reference: it joins no resolution, and is
   * built when the list is given its content. Each entry opened from a
   * written reference is resolved for that reference. */
  const markers: Markers = new Map();
  const wired = (source: SourceRef, extracts: boolean, read: ListFiles | undefined): Computable<Opened[]> =>
    !(source instanceof TargetRef)
      ? Computable.resolve([{ source, reference: source instanceof RepositoryRef ? source : undefined }])
      : read === "files"
        ? Computable.resolve([{ source, reference: source }])
        : source
            .nodes()
            .then(unbuilt =>
              (extracts && unbuilt.some(each => each instanceof ProjectedPackage)
                ? [source]
                : consumeMarker(source, unbuilt, markers)
              ).map((each): Opened => ({ source: each, reference: source }))
            );
  return Computable.forAll(
    lists.map((list, index) =>
      Computable.forAll(
        list.map(source => wired(source, extracted?.[index] === true, reads?.[index])),
        (...opened: Opened[][]) => opened.flat()
      )
    ),
    (...opened: Opened[][]) => opened
  ).then(opened => {
    const flat = opened.flat().map(({ source }) => source);
    /* The nodes as each operation's side reads them, each still resolved for its reference. */
    const sides = operations.map(operation => sidedNodes(flat, operation, markers));
    const resolve = (at: number): Computable<ResolvedLists> => {
      let index = 0;
      const sided = sides[at];
      return resolveBuiltLists(
        withOperation(context, operations[at]),
        opened.map(list => list.map(({ reference }) => ({ source: sided[index++], reference }))),
        extracted,
        instantiated,
        reads,
        markers
      );
    };
    const [first] = operations;
    const held = resolve(0);
    return Computable.forAll(
      operations.map((operation, at) =>
        at === 0
          ? held
          : sides[at] !== flat || sides[0] !== flat
            ? resolve(at)
            : resolvedAlike(flat, first, operation).then(alike => (alike ? held : resolve(at)))
      ),
      (...resolved: ResolvedLists[]) => resolved
    );
  });
}

/**
 * @return true if a collection of `sources`, which neither operation's side
 * changes ({@link sidedNodes}), resolves alike for operations `a` and `b`
 * (it asks no catalog for a member, and every registry its requests are
 * addressed to gives both one {@link RepositoryReader.environmentKey
 * environment}), otherwise false.
 */
function resolvedAlike(sources: Array<SourceRef | Unbuilt>, a: string, b: string): Computable<boolean> {
  const requests = gatherRequirements(sources).requests.filter(request => !resolvedApart(request));
  if (requests.some(({ reference }) => isRepositoryCollection(reference.source))) {
    return Computable.resolve(false);
  }
  const registries = [
    ...new Set(
      requests
        .map(({ reference }) => reference.source)
        .filter(
          (source): source is RepositoryReader<unknown, unknown> => isRepositoryReader(source) && !isFilesOperation(source.operation)
        )
    ),
  ];
  return Computable.forAll(
    registries.map(registry =>
      Computable.forAll([registry.environmentKey(a), registry.environmentKey(b)], (left: string, right: string) => left === right)
    ),
    (...agree: boolean[]) => agree.every(each => each)
  );
}

/** One source of a list as opened for resolution, and the written reference
 * it is resolved for: none where it is content in hand. */
interface Opened {
  readonly source: SourceRef | Unbuilt;
  readonly reference: Reference | undefined;
}

/**
 * Source lists resolved as one collection: each list's sources resolved, and
 * aligned with them the written reference each was resolved for — a
 * repository's or a target's, none for content in hand — and what conflicts
 * in the collection.
 */
export interface ResolvedLists {
  readonly lists: Resolved[][];
  readonly references: Array<Array<Reference | undefined>>;
  readonly conflicts: Conflicts;
  /** Find what conflicts among `shipped`, some of what the collection
   * resolved, used together without the rest. */
  conflictsAmong(shipped: ReadonlyArray<Resolved>): Computable<Conflicts>;
  /** The collection the lists were resolved as. */
  readonly collection: ResolvedCollection;
}

/**
 * How a list is read where it is not for its packages: `"files"`, for the
 * files of what it names and nothing more. A target is no node and is built
 * for its files, a repository's reference is a
 * {@link fileRequests file request}, and a package in hand is taken as it
 * stands.
 */
type ListFiles = "files";

/**
 * Resolve opened lists as one collection ({@link resolveBuilt}), and
 * partition the result back per list, each entry with the written reference
 * it was resolved for. File requests are the projected references of the
 * `extracted` lists and the references of the lists `reads` reads for files;
 * instances are the packages of the `instantiated` lists and the packages in
 * hand of the lists read for files. A source that another list reads for its
 * packages is neither.
 */
function resolveBuiltLists(
  context: ResolutionContext,
  opened: Opened[][],
  extracted?: ReadonlyArray<boolean>,
  instantiated?: ReadonlyArray<boolean>,
  reads?: ReadonlyArray<ListFiles | undefined>,
  markers?: Markers
): Computable<ResolvedLists> {
  const lists = opened.map(list => list.map(({ source }) => source));
  const forFiles = lists.filter((_, index) => reads?.[index] === "files").flat();
  const others = lists.filter((_, index) => reads?.[index] !== "files");
  const packaged = new Set<SourceRef | Unbuilt>(others.flat());
  const files = new Set<RepositoryRef>([
    ...(extracted === undefined
      ? []
      : fileRequests(lists.filter((_, index) => extracted[index]).flat(), lists.filter((_, index) => !extracted[index]).flat())),
    ...forFiles.filter((source): source is RepositoryRef => source instanceof RepositoryRef && !packaged.has(source)),
  ]);
  const instances = new Set<RepositoryRef | Package>([
    ...(instantiated === undefined ? [] : instanceRequests(lists.filter((_, index) => instantiated[index]).flat())),
    ...forFiles.filter(isPackage).filter(pkg => !packaged.has(pkg)),
  ]);
  return resolveBuilt(context, lists, files, instances, markers).then(
    ({ resolved, counts, conflicts, conflictsAmong, collection }) => {
      /* A source resolves to one entry, or to none: a `?` alternate. */
      const partitioned: Resolved[][] = [];
      const references: Array<Array<Reference | undefined>> = [];
      let source = 0;
      let index = 0;
      for (const list of opened) {
        const length = counts.slice(source, source + list.length).reduce((sum, count) => sum + count, 0);
        partitioned.push(resolved.slice(index, index + length));
        references.push(list.flatMap(({ reference }, at) => Array<Reference | undefined>(counts[source + at]).fill(reference)));
        source += list.length;
        index += length;
      }
      return { lists: partitioned, references, conflicts, conflictsAmong, collection };
    }
  );
}

/**
 * Gather a request for every reference among `sources` and every reference
 * the packages among them carry: a package's unbound requirement is its
 * reference, and one bound to a target's node or a package in hand is
 * followed into that package. There is one request per reference. One among
 * the sources themselves is the collection's own (`as: "package"`) whoever
 * else carries it; any other is `"carried"`.
 *
 * Left out: a carried reference with projections (it names files) or marked
 * `?` (its writer's collection point's); an optional provided requirement; a
 * requirement bound to a registry's selection (taken as bound, see
 * {@link gatherRequirements}); and a node known to build no package.
 */
function gatherReferences(sources: Array<SourceRef | Unbuilt>): PackageRequest[] {
  return gatherRequirements(sources).requests;
}

/**
 * Gather the requests {@link gatherReferences} does, and:
 * - `locals`: the packages the sources hold, and those reached through
 *   requirements bound to something other than a registry's selection: each
 *   a candidate of every resolution here, its carried references its own
 *   requirements;
 * - `own`: those of `locals` the sources hold outright;
 * - `pins`: the pins that requirements bound to a registry's selection make
 *   ({@link takenPins}).
 */
function gatherRequirements(sources: Array<SourceRef | Unbuilt>): {
  requests: PackageRequest[];
  locals: Package[];
  own: Set<Package>;
  /** The registries' selections the sources reach through bound requirements, taken
   * as they stand: each a pin of the registry's resolution here. */
  pins: Pin[];
} {
  const locals: Package[] = [];
  const pins: Pin[] = [];
  const pinned = new Set<Package>();

  /* Those of them the sources hold outright: the collection's own
   * requirements, as a reference among the sources is. */
  const own = new Set<Package>();
  const references: RepositoryRef[] = [];
  const direct = new Set<RepositoryRef>();
  const visited = new Set<RepositoryRef | Package>();
  const gather = (source: SourceRef | Unbuilt | Package | Reference, carried: boolean): void => {
    if (source instanceof RepositoryRef) {
      if (!carried) {
        direct.add(source);
      }
      if ((!carried || (source.projections.length === 0 && source.override !== "alternate")) && !visited.has(source)) {
        visited.add(source);
        references.push(source);
      }
    } else if (source instanceof ResolvedNode && source.content.plain === true) {
      /* Known to be no package: it claims no name and requires nothing. */
    } else if (isPackage(source) && !visited.has(source)) {
      /* A package held or built here: what it carries is its own
       * requirements. One bound to nothing is its reference, asked here; one
       * bound to a registry's selection is taken as bound; one bound to a
       * target's node or to a package in hand leads into that. */
      visited.add(source);
      locals.push(source);
      if (!carried) {
        own.add(source);
      }
      for (const dep of source.dependencies) {
        const provided = source.provided.get(dependencyName(dep));
        if (provided === "optional") {
          continue;
        }
        const bound = dep.package;
        if (bound === undefined) {
          gather(dep.reference, true);
        } else if (isSelection(bound)) {
          /* Bound to a registry's selection by whatever resolved this package:
           * taken as it stands, a pin of the batch — unless the requirement is a
           * provided requirement, whose binding is the offer the consumer may
           * replace, neither pinned nor asked again. */
          if (provided === undefined) {
            take(bound, source);
          }
        } else {
          gather(bound, true);
        }
      }
    } else if (source instanceof FileSetRef) {
      /* A pending projection's base carries its references, resolved here
       * like any package's. */
      gather(source.source, carried);
    } else if (source instanceof ProjectedPackage) {
      gather(source.base, carried);
    }
  };
  /* A node bound into a package here by another collection is taken as it
   * stands, with what it reaches through its dependencies: each registry's
   * selection among them a pin, reached through `via`. */
  const take = (node: Package, via: Package): void => takenPins(node, via, pins, pinned);
  sources.forEach(source => gather(source, false));
  const requests = references.map((reference): PackageRequest => ({ reference, as: direct.has(reference) ? "package" : "carried" }));
  return { requests, locals, own, pins };
}

/** @return true if `pkg` is a registry's selection (a node of a resolution,
 * no build), otherwise false. */
function isSelection(pkg: Package | undefined): pkg is ResolvedNode {
  return pkg instanceof ResolvedNode && pkg.content.selection !== undefined;
}

/**
 * Gather into `pins` the pins the package `pkg`, taken as another collection
 * bound it, makes for whatever reaches it through `via`: each registry's
 * selection among itself and what it reaches through bound dependencies,
 * other than provided ones, whose binding is the consumer's to make. `seen`
 * holds what was gathered already.
 */
function takenPins(pkg: Package, via: RepositoryRef | Package, pins: Pin[], seen: Set<Package>): void {
  if (seen.has(pkg)) {
    return;
  }
  seen.add(pkg);
  if (isSelection(pkg)) {
    pins.push({ selection: pkg.content.selection!, via });
  }
  for (const dep of pkg.dependencies) {
    if (pkg.provided.get(dependencyName(dep)) === undefined && dep.package !== undefined) {
      takenPins(dep.package, via, pins, seen);
    }
  }
}

/** Gather the pins a catalog's member `pkg`, resolved as the catalog did,
 * makes for the collection that reaches it through `via`. */
function pinsOf(pkg: Package, via: RepositoryRef): Pin[] {
  const pins: Pin[] = [];
  takenPins(pkg, via, pins, new Set());
  return pins;
}

/** @return true if `pkg` is a target's node — a package built in the project,
 * whose requirements are read off it — otherwise false. */
function isBuild(pkg: SourceRef | Unbuilt | Package | Reference): pkg is ResolvedNode {
  return pkg instanceof ResolvedNode && pkg.content.builds !== undefined;
}

/** Group `requests` by repository, in the order each was asked. */
function groupRequests(requests: ReadonlyArray<PackageRequest>): Map<RefSource, PackageRequest[]> {
  const groups = new Map<RefSource, PackageRequest[]>();
  for (const request of requests) {
    groups.set(request.reference.source, [...(groups.get(request.reference.source) ?? []), request]);
  }
  return groups;
}

/** Get the resolved sources an answer stands for: itself, or none for a `?`
 * alternate (answered by its own reference), which installs nothing. */
function resolvedAs(delivery: Resolved | RepositoryRef): Resolved[] {
  return delivery instanceof RepositoryRef ? [] : [delivery];
}

/** @return true if `request` is for a package its reference only permits (a
 * `?` alternate), otherwise false. Such a request installs nothing, and is
 * answered by its own reference. */
function installsNothing(request: PackageRequest): boolean {
  return request.reference.override === "alternate" && request.as === "package";
}

/** @return true if `request` is answered apart from its registry's joint
 * batch (an instance, or a request for files), otherwise false. */
function resolvedApart(request: PackageRequest): boolean {
  return request.as === "instance" || request.as === "files";
}

/**
 * Resolve the package `request` names as an {@link instanceRequests instance}:
 * a registry's at the reference's lower bound, carrying what that version
 * declares as references; a collection's as the member it resolved, its requirements
 * bound as the collection bound them; a lookup's as it holds it.
 */
function resolveInstance(
  context: ResolutionContext,
  source: RefSource,
  request: PackageRequest,
  resolvedMembers: Map<RepositoryRef, Computable<Package | undefined>>
): Computable<FileSet | ResolvedNode> {
  const { reference } = request;
  if (isRepositoryReader(source)) {
    return instantiatePackage(source, reference);
  }
  if (isRepositoryCollection(source)) {
    return memberPackage(context, source, request, resolvedMembers).then((pkg): Package => {
      if (pkg === undefined) {
        throw new FabrError(`internal: '${reference.toString()}' resolved to no package`);
      }
      return pkg;
    });
  }
  return resolveLookup(source, reference);
}

/**
 * Resolve `requests`, each repository's as one batch ({@link resolveBatch}),
 * and apply what each reference states to its answer
 * ({@link RepositoryRef.applyTo}). A `?` alternate is answered by its own
 * reference. A repository with a resolution in `collection` answers its batch
 * from it. A request for files joins no resolution, so nothing here waits on
 * it: it is answered {@link PendingFiles pending}, fetched when the
 * collection is given its content.
 *
 * @return what each reference resolved to, by reference.
 */
function resolveRequests(
  context: ResolutionContext,
  requests: ReadonlyArray<PackageRequest>,
  collection: Pick<ResolvedCollection, "resolutions" | "resolvedMembers">
): Computable<Map<RepositoryRef, Resolved | RepositoryRef>> {
  const { resolutions, resolvedMembers } = collection;
  const batches = [...groupRequests(requests.filter(request => request.as !== "files"))];
  return Computable.forAll(
    batches.map(([repository, batch]) => resolveBatch(context, repository, batch, resolutions.get(repository), resolvedMembers)),
    (...results: Array<FileSet | ResolvedNode | PendingFiles>[]) => {
      const finished = new Map<RepositoryRef, Resolved | RepositoryRef>();
      const finish = (reference: RepositoryRef, resolved: FileSet | ResolvedNode | PendingFiles): Resolved | RepositoryRef =>
        resolved instanceof PendingFiles
          ? new PendingFiles(() => resolved.fetch().then(files => reference.applyTo(files as FileSet) as FileSet | FileSetRef))
          : reference.applyTo(resolved);
      batches.forEach(([, batch], batchIndex) =>
        batch.forEach((request, index) =>
          finished.set(
            request.reference,
            installsNothing(request) ? request.reference : finish(request.reference, results[batchIndex][index])
          )
        )
      );
      for (const request of requests) {
        if (request.as === "files") {
          const { reference } = request;
          const source = reference.source;
          finished.set(
            reference,
            new PendingFiles(() =>
              attributedTo(reference, () =>
                resolveBatch(context, source, [request], resolutions.get(source), resolvedMembers).then(
                  ([files]) => reference.applyTo(files as FileSet) as FileSet | FileSetRef
                )
              )
            )
          );
        }
      }
      return finished;
    }
  );
}

/**
 * @return true if `pkg` is what `reference` names (a version its repository's
 * format accepts for the requirement the reference states, or a package with
 * no version), otherwise false. Asked of a package already known by the name
 * the reference is required under. A reference whose repository resolves no
 * versions is answered by nothing.
 */
function answers(reference: RepositoryRef, pkg: Package): boolean {
  const source = reference.source;
  if (!isRepositoryReader(source)) {
    return false;
  }
  if (pkg.version === undefined) {
    /* A package with no version is built in the project, and answers any
     * requirement on its name. */
    return true;
  }
  const { format } = source;
  try {
    return format.satisfies(format.parseVersion(pkg.version), constraintOf(format, reference.versionConstraint));
  } catch {
    return false;
  }
}

/**
 * How a collection point treats a package at several versions. `"strict"`
 * (the default): a package shipped at more than one version, from any source,
 * is refused unless each version is sanctioned ({@link findConflicts}).
 * `"permissive"`: several versions
 * are accepted, each nested where it is required; for a closure run as a
 * program (a runnable's install). The framework gives it to a single-surface
 * collection (`collectLists`, `materializeShallow`); a rule's own
 * requirements state it with `permissive` (`ResolutionSpec`).
 */
export interface ResolutionOptions {
  resolutionMode?: "strict" | "permissive";
}

/** The mode of every launch-bound materialization: the runnable accessors, a
 * command stage's tool, the `run` verb's own name. */
export const PERMISSIVE_RESOLUTION: ResolutionOptions = { resolutionMode: "permissive" };

/**
 * Run `deliver`, the work one reference asks of its repository, and attribute
 * any failure, thrown or rejected, to the written reference: it is thrown or
 * rejected in turn as a {@link RequirementResolutionError}, which the driver
 * reports at the requirement as written (`@npm:pkg:ver`, `@catalog:name`).
 */
export function attributedTo<T>(reference: RepositoryRef, deliver: () => Computable<T>): Computable<T> {
  try {
    return deliver().catch(err => {
      throw new RequirementResolutionError([reference], toError(err));
    });
  } catch (err) {
    throw new RequirementResolutionError([reference], toError(err));
  }
}
