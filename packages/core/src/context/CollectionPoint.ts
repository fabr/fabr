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
import { NamespaceRef } from "../core/NamespaceRef";
import {
  contentOf,
  Dependency,
  dependencyName,
  equalNodes,
  isPackage,
  materializePackages,
  Package,
  PackageFileSet,
  PackageGraphBuilder,
  packageNodeSignature,
  reachableNodes,
  ResolvedNode,
} from "../core/PackageFileSet";
import { isRepositoryCollection, isRepositoryReader, Materialized, PendingFiles, ProjectedPackage, RefSource, RepositoryCollection, RepositoryReader, RepositoryRef, Resolved, SourceRef } from "../core/Repository";
import { PackageRequest, Resolution, ResolutionContext, ResolvedCollection } from "../resolver/Types";
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
    extracted.filter((source): source is RepositoryRef => source instanceof RepositoryRef && source.projections.length > 0 && !packaged.has(source))
  );
}

/**
 * Select the sources among `instantiated` that are taken as an instance of a
 * package: the package itself, as material to derive another from, rather
 * than something required. Nothing an instance requires is resolved here. Its
 * edges are for the collection point the derived package reaches.
 *
 * - A reference joins no resolution and pins nothing, and is delivered as the
 *   package carrying the requirements it declares as references (see
 *   {@link instantiatePackage}). A projected reference selects files, so it is
 *   no instance request.
 * - A package already in hand is delivered as it stands.
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
    ? new TargetNotPackageError(err.requirer, err.dependency, requestedConstraint(err.requirer.getDependency(err.dependency.packageName)?.reference))
    : err;
}

/** Get what a node's content holds as one set of files. */
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

/**
 * Materialize resolved lists: give each package among them, and each it
 * reaches, its files, replace each target still unbuilt by what it builds to,
 * and fetch the files a projection selects from a repository. This is the one
 * place a collection fetches or builds. Each entry stays aligned with the
 * written reference it was resolved for (`references`, as
 * {@link resolveLists} gives them): an entry that materializes to several — a
 * target built as files — carries its reference to each.
 */
export function materializeLists(
  lists: ReadonlyArray<ReadonlyArray<Resolved>>,
  references: ReadonlyArray<ReadonlyArray<Reference | undefined>>
): Computable<{ lists: Materialized[][]; references: Array<Array<Reference | undefined>> }> {
  const referenceOf = (list: number, at: number): Reference | undefined => references[list]?.[at];
  const packages = lists.flatMap(packagesAmong);
  const targets = lists.flat().filter((source): source is TargetRef => source instanceof TargetRef);
  const pending = lists.flat().filter((source): source is PendingFiles => source instanceof PendingFiles);
  if (targets.length === 0 && pending.length === 0 && !reachableNodes(packages).some(pkg => pkg instanceof ResolvedNode)) {
    return Computable.resolve({
      lists: lists as Materialized[][],
      references: lists.map((list, index) => list.map((_, at) => referenceOf(index, at))),
    });
  }
  return Computable.forAll(
    [
      materializePackages(packages).catch(withConstraint),
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
      const delivered = new Map<TargetRef, SourceRef[]>(targets.map((target, index) => [target, built[index]]));
      const files = new Map<PendingFiles, FileSet | FileSetRef>(pending.map((request, index) => [request, fetched[index]]));
      const materialized = lists.map(list =>
        list.map((source): Materialized[] => {
          if (source instanceof TargetRef) {
            return delivered.get(source) as Materialized[];
          }
          if (source instanceof PendingFiles) {
            return [files.get(source)!];
          }
          const pkg = packageIn(source);
          const made = pkg === undefined ? undefined : held.get(pkg)!;
          if (made === undefined) {
            return [source as Materialized];
          }
          /* A target that built no package is its sources, each its own
           * entry; a projection over it selects from them together. */
          return made instanceof PackageFileSet
            ? [withPackage(source, made) as Materialized]
            : source === pkg
            ? (made as Materialized[])
            : [withPackage(source, asOneSet(made)) as Materialized];
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
 * Resolve one repository's batch of requests. A registry's references resolve
 * jointly ({@link resolvePackages}, then {@link packageClosure}), each
 * answered as the registry's {@link RepositoryReader.operation operation}
 * says: the node, the node of the program it is under `run`
 * ({@link runnableNode}), or its files {@link PendingFiles pending} under
 * `files`. A catalog answers each with its member ({@link resolveMember}),
 * and any other repository resolves each reference on its own. An instance
 * request, and a request for files, are answered apart from the batch; a
 * request for files is answered with its files, since what asks for it is
 * fetching them. Given `resolution`, the batch is resolved from it; it must be
 * the resolution of a batch these requests are among, so that a subset keeps
 * the joint selection.
 */
function resolveBatch(
  context: ResolutionContext,
  source: RefSource,
  requests: ReadonlyArray<PackageRequest>,
  resolution?: () => Computable<Resolution>
): Computable<Array<FileSet | ResolvedNode | PendingFiles>> {
  const operation = isRepositoryReader(source) ? source.operation : undefined;
  {
    const joint = isRepositoryReader(source) && !isFilesOperation(operation) ? requests.filter(request => !resolvedApart(request)) : [];
    const position = new Map(joint.map((request, index) => [request, index]));
    /* One joint resolution of the batch, which runs only when a request
     * among it is answered. */
    const closures = isRepositoryReader(source) && joint.length > 0 ? assembleClosures(context, source, joint, resolution) : undefined;
    return Computable.forAll(
      requests.map((request): Computable<FileSet | ResolvedNode | PendingFiles> => {
        const { reference } = request;
        if (request.as === "instance") {
          return attributedTo(reference, () => resolveInstance(source, request));
        }
        if (isRepositoryCollection(source)) {
          return resolveMember(context, source, request).labelled(new ProvenanceLabel(reference.steps));
        }
        if (isRepositoryReader(source)) {
          if (request.as === "files") {
            return attributedTo(reference, () => fetchFilesFor(source, reference, operation).then(files => new FileSet(files, files.origin)));
          }
          if (isFilesOperation(operation)) {
            return Computable.resolve(new PendingFiles(() => attributedTo(reference, () => fetchFilesFor(source, reference, operation))));
          }
          return closures!().then(assembled => {
            const pkg = assembled[position.get(request)!];
            return pkg === undefined ? EMPTY_FILESET : operation === "run" ? runnableNode(pkg, held => source.format.makeRunnable(held, context)) : pkg;
          });
        }
        return request.as === "files" && source.resolveFiles !== undefined
          ? attributedTo(reference, () => source.resolveFiles!(reference).then(files => new FileSet(files, files.origin)))
          : attributedTo(reference, () => source.resolve(reference));
      }),
      (...resolved: Array<FileSet | ResolvedNode | PendingFiles>) => resolved
    );
  }
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
function fetchFilesFor(source: RepositoryReader<unknown, unknown>, reference: RepositoryRef, operation: string | undefined): Computable<FileSet> {
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
 * Resolve the member of `source`'s collection that `request` names, from the
 * resolution `source` made: its package as resolved there, wired to that
 * selection, for the collection point that asked to materialize. Under the
 * `files` operation the member's files alone are pending, and under `run` it
 * is the node of the program. A request for files is answered with its files,
 * since what asks for it is fetching them.
 */
function resolveMember(
  context: ResolutionContext,
  source: RepositoryCollection,
  request: PackageRequest
): Computable<FileSet | ResolvedNode | PendingFiles> {
  const { reference } = request;
  return source.member(reference).then((member): FileSet | ResolvedNode | PendingFiles | Computable<FileSet | ResolvedNode> => {
    const { collection, entry } = member;
    const local = isPackage(entry);
    /* What a package of the project fails to build with is its own to report,
     * so only the repository's part is attributed to the reference. */
    const alone = (): Computable<FileSet> =>
      local ? contentOf(entry).files().then(asOneSet) : attributedTo(reference, () => pinnedFiles(collection, entry, member.operation));
    if (request.as === "files") {
      return alone().then(files => new FileSet(files, files.origin));
    }
    if (isFilesOperation(member.operation)) {
      return new PendingFiles(alone);
    }
    const resolved = (): Computable<Package> =>
      attributedTo(reference, () =>
        resolveSources(context, collection, [entry]).then(({ delivered: [pkg] }): Package => {
          if (!isPackage(pkg)) {
            throw new FabrError(`internal: '${reference.toString()}' resolved to no package`);
          }
          return pkg;
        })
      );
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
    return resolved().then(pkg => runnableNode(pkg, held => attributedTo(reference, () => runnableFrom(context, entry.source, held))));
  });
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
 * Make a thunk for the closures of `requests`, one per request, from one
 * resolution of the batch (`resolution`, or a fresh one). The resolution runs
 * at most once, when a delivery first forces it, and not at all where none
 * does.
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

/**
 * Resolve `sources`: gather their references, and set up each registry's
 * resolution of its batch, with the packages built in the project as
 * candidates of every one. The references in `files` are
 * {@link fileRequests file requests} and those in `instances`
 * {@link instanceRequests instance requests}, neither of which joins a
 * resolution.
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
  const requests = gathered.requests.map((request): PackageRequest =>
    files?.has(request.reference) === true
      ? { ...request, as: "files" }
      : instances?.has(request.reference) === true
      ? { ...request, as: "instance" }
      : request
  );
  /* The collection's own builds, each with its marker: an alternate is among
   * them though no source holds it, as a registry's `?` is a requirement of
   * the collection that delivers nothing. */
  const alternates = [...markers].filter(([, marker]) => marker === "alternate").map(([pkg]) => pkg);
  const locals = [...gathered.locals, ...alternates.filter(pkg => !gathered.locals.includes(pkg))];
  const own = new Map<Package, Requirement["override"]>([
    ...[...gathered.own].map((pkg): [Package, Requirement["override"]] => [pkg, markers.get(pkg)]),
    ...alternates.map((pkg): [Package, Requirement["override"]] => [pkg, "alternate"]),
  ]);
  const resolutions = new Map<RefSource, () => Computable<Resolution>>();
  /* The instances of one registry (one identity) resolve together, apart only
   * where their environment differs. Each reference is still delivered by its
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
  for (const group of registries.values()) {
    let started: Computable<Map<RefSource, Computable<Resolution>>> | undefined;
    const byEnvironment = (): Computable<Map<RefSource, Computable<Resolution>>> =>
      (started ??= Computable.forAll(
        group.map(([source]) => source.environmentKey()),
        (...environments: string[]) => {
          const shared = new Map<string, Array<[RepositoryReader<unknown, unknown>, PackageRequest[]]>>();
          group.forEach((member, index) => shared.set(environments[index], [...(shared.get(environments[index]) ?? []), member]));
          const resolved = new Map<RefSource, Computable<Resolution>>();
          for (const members of shared.values()) {
            const sources = new Set<RefSource>(members.map(([source]) => source));
            const resolution = resolvePackages(context, members[0][0], members.flatMap(([, batch]) => batch), locals, own, sources);
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
    members: membersOf([...gathered.own], markers),
    instances: held,
  };
}

/** Get {@link ResolvedCollection.members} from the builds the collection
 * requires outright. */
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
    ({ reference, as }) => as === "package" && reference.override === "force" && built.has(reference.localName) && resolutions.has(reference.source)
  );
  const source = forcing?.reference.source ?? resolutions.keys().next().value;
  if (source === undefined || !isRepositoryReader(source)) {
    let started: Computable<Resolution> | undefined;
    return { resolution: () => (started ??= resolveBuilds(locals, own)) };
  }
  return { registry: source, resolution: resolutions.get(source)! };
}

/**
 * Resolve `sources`, any of those `resolved` holds, and merge what each was
 * answered from into one graph ({@link mergeResolutions}). Nothing is fetched
 * or built. Provided requirements are left for the consumer to bind, and a
 * projection stays pending over its package.
 *
 * @return the sources as resolved (`delivered`, `counts` of them per source)
 * and what each reference resolved to (`finished`): the sources' own, and
 * those the collection's builds carry, which a build these sources reach
 * needs whether or not they hold it.
 */
export function resolveSources(
  context: ResolutionContext,
  resolved: ResolvedCollection,
  sources: Array<SourceRef | Unbuilt>
): Computable<{ delivered: Resolved[]; counts: number[]; finished: Map<RepositoryRef, Resolved | RepositoryRef> }> {
  /* Each reference as it was resolved, so that it is found in its resolution
   * under the role it was resolved in. */
  const requests: PackageRequest[] = [];
  const taken = (source: SourceRef | Unbuilt): boolean => isPackage(source) && resolved.instances.has(source);
  for (const { reference } of gatherReferences([...sources.filter(source => !taken(source)), ...resolved.locals.values()])) {
    const request = resolved.requests.get(reference);
    if (request === undefined) {
      return Computable.reject(new FabrError(`internal: '${reference.toString()}' was not resolved with the sources it is delivered among`));
    }
    requests.push(request);
  }
  const builds = resolved.builds;
  return Computable.forAll(
    [resolveRequests(context, requests, resolved.resolutions), builds === undefined ? Computable.resolve(undefined) : builds.resolution()] as const,
    (finished, resolution) => {
      const roots = sources.map((source): Resolved[] => {
        if (source instanceof RepositoryRef) {
          return resolvedAs(finished.get(source)!);
        } else if (source instanceof NamespaceRef) {
          throw source.refused();
        }
        return [source as Resolved];
      });
      const merged = mergeResolutions(
        roots.flat().flatMap(source => (taken(source as SourceRef) ? [] : packageIn(source) ?? [])),
        finished,
        resolved,
        builds === undefined || resolution === undefined
          ? undefined
          : (requirer: Package | undefined, dep: Package) => bindBuild(builds.registry, resolution, requirer, dep)
      );
      /* What two sources were answered with from two resolutions (a catalog's
       * member and a direct reference) is one node where it is one package
       * wired one way. */
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
 * ({@link equalNodes}) into one each, rewiring every edge that led to a
 * duplicate onto the one kept, and return how each root appears afterwards.
 * Copies only what changes: a node that is kept and leads to no duplicate is
 * itself.
 */
function foldEqualNodes(roots: ReadonlyArray<Package>): Map<Package, Package> {
  const canonical = equalNodes(roots);
  if ([...canonical].every(([pkg, one]) => pkg === one)) {
    return new Map(roots.map(root => [root, root]));
  }
  /* Which kept nodes change: one with an edge to a duplicate, and whatever
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
      one.dependencies.map((dep): Dependency => (dep.package === undefined ? dep : { reference: dep.reference, package: fold(dep.package) })),
      one.provided
    );
    return node;
  };
  const result = new Map<Package, Package>(roots.map(root => [root, fold(root)]));
  builder.seal();
  return result;
}

/**
 * Merge the graphs a collection's sources were answered from into one, and
 * return how each of `roots` (the packages among them) appears in it. The
 * rules, applied wherever a package is reached:
 *
 * - A package resolved for a reference is what that reference resolved to
 *   here (`finished`), where that is another package: a package in hand is
 *   asked for again.
 * - A package another collection resolved (a catalog's member and what it
 *   reaches) of a name one of this collection's own builds has is that build
 *   ({@link ResolvedCollection.members}).
 * - A build of this collection is one node however it is reached. Its edges
 *   to other builds lead where the builds' resolution leads them (`bind`; a
 *   `!` may give a build's name to another candidate), and a reference it
 *   carries is what that reference resolved to here. A root that is one of the
 *   collection's own builds is bound as the collection's requirement on it.
 * - Anything else is itself where nothing it reaches changes, and a copy with
 *   its edges merged where something does.
 *
 * What a reference resolved to, a root or a package asked for again, keeps
 * that reference whatever stands in its place. An optional provided edge is
 * left unbound where it is.
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
  /* What a catalog's members reach: packages another collection resolved. */
  const catalogued = [...finished].flatMap(([reference, value]) => (isRepositoryCollection(reference.source) ? packageIn(value) ?? [] : []));
  const asked = new Set(catalogued);
  const foreign = new Set(reachableNodes(catalogued).filter(pkg => !asked.has(pkg)));
  /** The build of this collection that stands for `pkg`, where another
   * collection resolved it under that build's name. */
  const member = (pkg: Package): Package | undefined => {
    const held = foreign.has(pkg) && !isBuildVersion(pkg) && !isPlainNode(pkg) ? collection.members.get(pkg.packageName) : undefined;
    return held === undefined ? undefined : rooted(held);
  };
  /** A root that is one of the collection's builds, as the collection's requirement on it binds it. */
  const rooted = (pkg: Package): Package => (bind !== undefined && isBuildVersion(pkg) ? bind(undefined, pkg).package : pkg);
  /** Where an edge of `requirer` leads before merging, where it leads
   * anywhere, and the reference the edge then carries where it changes: a
   * bound edge whose reference this collection answered leads to its answer;
   * one between builds leads where the builds' resolution binds it. */
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
    return bind !== undefined && isBuildVersion(requirer) && isBuildVersion(dep.package) ? bind(requirer, dep.package) : { package: dep.package };
  };

  /* Which packages the merge changes: one replaced, a build that is not its
   * name's one node or whose edges lead elsewhere, and whatever reaches one. */
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
      one.provided
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
 * the caller to finish.
 */
export function materializeShallow(
  context: ResolutionContext,
  sources: SourceRef[],
  options?: ResolutionOptions
): Computable<Materialized[]> {
  return materializeTargets(sources).then(built => {
    const held = (built as Array<Exclude<SourceRef, TargetRef>>).map(source => {
      if (source instanceof NamespaceRef) {
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
    return resolveRequests(context, references.map(packageRequest), collection.resolutions).then(finished =>
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
  /* What a catalog's members were answered from is the catalog's. */
  const members = [...finished.keys()].flatMap(reference => {
    const { source } = reference;
    const request = collection.requests.get(reference);
    return isRepositoryCollection(source) && request?.as !== "files"
      ? [
          source.member(reference).then(({ collection: catalog, entry, operation }) =>
            isFilesOperation(operation) ? [] : resolvedBatches(catalog, entry instanceof RepositoryRef ? [entry] : [])
          ),
        ]
      : [];
  });
  return Computable.forAll([resolvedBatches(collection, finished.keys()), ...members], (...found: ResolvedBatch[][]) => {
    const batches = mergedBatches(found.flat());
    return batches.length === 0 ? NO_CONFLICTS : findConflicts(batches.map(batch => checkedResolution(context, batch)), shipped, finished);
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
        : [builds.resolution().then((resolution): ResolvedBatch => ({ registry: builds.registry, resolution, requests: [], builds: true }))]),
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
          }
    );
  }
  return [...merged.values()];
}

/**
 * Resolve `lists` as one collection: every reference among them answered
 * from its repository's joint resolution, the collection's own packages bound
 * in and provided requirements bound by their consumers, nothing fetched or
 * built, and what conflicts in it found (`conflicts`).
 */
function resolveBuilt(
  context: ResolutionContext,
  lists: Array<SourceRef | Unbuilt>[],
  files?: ReadonlySet<RepositoryRef>,
  instances?: ReadonlySet<RepositoryRef | Package>,
  markers?: Markers
): Computable<{ resolved: Resolved[]; counts: number[]; conflicts: Conflicts; conflictsAmong: ResolvedLists["conflictsAmong"] }> {
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
      /* Checked as bound: an offer the consumer answered with something else is
       * not in the installation, so it is not a version that ships. */
      const bound = bindProvided(delivered, taken);
      return conflictsOf(context, collection, finished, bound).then(conflicts => ({
        resolved: bound,
        counts,
        conflicts,
        conflictsAmong: (shipped: ReadonlyArray<Resolved>) => conflictsOf(context, collection, finished, shipped),
      }));
    });
  });
}

/**
 * Refuse a list that requires one name twice: two of its requests delivered
 * under one name, whatever either resolves to. A `?` asks for nothing, so it
 * is no second request, and the same request written twice is one. A file
 * request, a projection, and what the collection takes as it stands (`taken`)
 * are no request for a package.
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
    return files?.has(source) === true || source.override === "alternate" || source.projections.length > 0 ? undefined : source.localName;
  }
  return isPackage(source) && taken?.has(source) !== true && !isPlainNode(source) ? source.packageName : undefined;
}

/** @return true if two requests of one name are the same request, otherwise false. */
function sameRequest(left: SourceRef | Unbuilt, right: SourceRef | Unbuilt): boolean {
  if (left instanceof RepositoryRef && right instanceof RepositoryRef) {
    const sameRegistry =
      left.source === right.source ||
      (isRepositoryReader(left.source) && isRepositoryReader(right.source) && left.source.identity === right.source.identity);
    return sameRegistry && left.name === right.name && left.versionConstraint === right.versionConstraint && left.override === right.override;
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
  return conflict.withHelp(
    `a target requires one package of each name: keep one, or allow the other alongside with '?'`
  );
}

/**
 * Bind every delivered package's provided requirements
 * ({@link PackageFileSet.provided}) among `sources` by its consumer, and return
 * the installation they make up. Each is answered by the first of:
 *
 * - what its **dependent** binds for that name — a dependency of the
 *   dependent's own, or the dependent's own provided binding — and so on up the
 *   chain of dependents;
 * - the collection's own **direct member** of that name, which is the top of
 *   that chain (a renamed member supplies the name it is delivered under);
 * - what its resolution **offered**: the default the delivery wired, or, where
 *   it wired none, an instance of the offered version the installation holds;
 *
 * and is left unbound otherwise, as an installation without it leaves it. A
 * binding is an ordinary edge. A package reached through dependents that bind
 * it differently comes back as one node per binding; one reached the same way
 * everywhere is one node, so the result is the input's shape wherever nothing
 * above a package supplies what its resolution did not.
 *
 * The sources come back unchanged where no package has a provided requirement.
 * Where several instances hold one offered name and version, the one with the
 * lowest node signature is bound, so the choice does not follow input order.
 */
export function bindProvided<S extends Resolved>(sources: S[], taken?: ReadonlySet<Package | RepositoryRef>): Resolved[] {
  const roots = packagesAmong(sources);
  const packages = reachableNodes(roots);
  if (!packages.some(pkg => pkg.provided.size > 0)) {
    return sources;
  }
  /* What the installation holds: everything reached by an edge other than an
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
    /* Each edge with what supplies it: an ordinary one is supplied by what it
     * is bound to, here; a provided one is decided below. */
    const edges = pkg.dependencies.map(dep => {
      const provided = pkg.provided.has(dependencyName(dep));
      const supply: ISupply | undefined = !provided && dep.package !== undefined ? { pkg: dep.package, scope: own } : undefined;
      if (supply !== undefined) {
        own.bindings.set(supply.pkg.packageName, supply);
      }
      return { dep, provided, supply };
    });
    /* Every binding is decided before anything below is copied: how a
     * dependency is wired depends on all of them. */
    const bound = edges.map(({ dep, provided, supply }) => {
      if (!provided) {
        return { dep, supply };
      }
      const name = dependencyName(dep);
      /* An optional one is never answered by the package on its edge (for a
       * built package, the copy it was compiled against): only by what the
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
      /* An edge nothing answers is its reference alone (an optional one would
       * otherwise keep the package it was built against). */
      bound.map(({ dep, supply }) =>
        supply === undefined ? { reference: dep.reference } : { reference: dep.reference, package: copy(supply.pkg, supply.scope) }
      ),
      pkg.provided
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
  for (let changed = true; changed; ) {
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
 * partitioned back per input list. For a collection made in one step, such as
 * a tool read to be run (`getGlobalRunnable`/`getRunnableProperty`, a command
 * stage), a command's `<` source, or `TargetContext.materializeSources`.
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
      : source.nodes().then(unbuilt =>
          (extracts && unbuilt.some(each => each instanceof ProjectedPackage) ? [source] : consumeMarker(source, unbuilt, markers)).map(
            (each): Opened => ({ source: each, reference: source })
          )
        );
  return Computable.forAll(
    lists.map((list, index) =>
      Computable.forAll(
        list.map(source => wired(source, extracted?.[index] === true, reads?.[index])),
        (...opened: Opened[][]) => opened.flat()
      )
    ),
    (...opened: Opened[][]) => opened
  ).then(opened => resolveBuiltLists(context, opened, extracted, instantiated, reads, markers));
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
}

/**
 * How a list is read where it is not for its packages: `"files"`, for the
 * files of what it names and nothing more. A target is no node and is built
 * for its files, a repository's reference is a
 * {@link fileRequests file request}, and a package in hand is taken as it
 * stands.
 */
type ListFiles = "files";

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
      : fileRequests(
          lists.filter((_, index) => extracted[index]).flat(),
          lists.filter((_, index) => !extracted[index]).flat()
        )),
    ...forFiles.filter((source): source is RepositoryRef => source instanceof RepositoryRef && !packaged.has(source)),
  ]);
  const instances = new Set<RepositoryRef | Package>([
    ...(instantiated === undefined ? [] : instanceRequests(lists.filter((_, index) => instantiated[index]).flat())),
    ...forFiles.filter(isPackage).filter(pkg => !packaged.has(pkg)),
  ]);
  return resolveBuilt(context, lists, files, instances, markers).then(({ resolved, counts, conflicts, conflictsAmong }) => {
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
    return { lists: partitioned, references, conflicts, conflictsAmong };
  });
}

/**
 * Gather a request for every reference among `sources`, and for those of the
 * packages among them: the reference a package was delivered for or, for a
 * package nothing delivered, the references its edges hold, recursively,
 * stopping at a package that has a reference of its own. There is one request
 * per reference, and a reference among the sources themselves is the
 * collection's requirement whoever else carries it. A carried reference that
 * resolves nothing is left out: an optional provided requirement, a `?` (a
 * permission its writer gave its own collection point), and one with
 * projections, which names files and so binds no package.
 */
function gatherReferences(sources: Array<SourceRef | Unbuilt>): PackageRequest[] {
  return gatherRequirements(sources).requests;
}

/**
 * Gather the requests {@link gatherReferences} does, with the packages built
 * in the project that the sources hold or reach (`locals`), each a node of
 * every resolution here whose carried references are its own requirements,
 * and those of them the sources hold outright (`own`).
 */
function gatherRequirements(sources: Array<SourceRef | Unbuilt>): {
  requests: PackageRequest[];
  locals: Package[];
  own: Set<Package>;
} {
  const locals: Package[] = [];

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
       * requirements. An edge bound to a repository's node — resolved
       * elsewhere, its files not yet had — is its reference, asked for again
       * here; one bound to a target's node or to a package in hand leads
       * into that; one bound to nothing is its reference. */
      visited.add(source);
      locals.push(source);
      if (!carried) {
        own.add(source);
      }
      for (const dep of source.dependencies) {
        if (source.provided.get(dependencyName(dep)) === "optional") {
          continue;
        }
        const bound = dep.package;
        gather(bound === undefined || (bound instanceof ResolvedNode && !isBuild(bound)) ? dep.reference : bound, true);
      }
    } else if (source instanceof FileSetRef) {
      /* A pending projection's base still carries its refs — they resolve at
       * this collection point like any package's. */
      gather(source.source, carried);
    } else if (source instanceof ProjectedPackage) {
      gather(source.base, carried);
    }
  };
  sources.forEach(source => gather(source, false));
  const requests = references.map((reference): PackageRequest => ({ reference, as: direct.has(reference) ? "package" : "carried" }));
  return { requests, locals, own };
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

/** Get what a delivery leaves among resolved sources: itself, or nothing for
 * a `?` alternate, which was a requirement of the resolution and installs
 * nothing. */
function resolvedAs(delivery: Resolved | RepositoryRef): Resolved[] {
  return delivery instanceof RepositoryRef ? [] : [delivery];
}

/** @return true if `request` is for a package its reference only permits (a
 * `?` alternate), otherwise false. Such a request installs nothing, so what
 * comes back is the requirement. */
function installsNothing(request: PackageRequest): boolean {
  return request.reference.override === "alternate" && request.as === "package";
}

/** @return true if `request` is answered apart from its registry's joint
 * batch (an instance, or a request for files), otherwise false. */
function resolvedApart(request: PackageRequest): boolean {
  return request.as === "instance" || request.as === "files";
}

/** Resolve the package `request` names as an {@link instanceRequests instance},
 * which only a registry can deliver. */
function resolveInstance(source: RefSource, { reference }: PackageRequest): Computable<FileSet | ResolvedNode> {
  if (!isRepositoryReader(source)) {
    throw new FabrError(
      `'${reference.toString()}' names a package its repository pins rather than resolves, so its requirements are not that repository's to state`
    ).withHelp("name the package in the registry it comes from");
  }
  return instantiatePackage(source, reference);
}

/**
 * Resolve `requests`, each repository's as one batch ({@link resolveBatch}),
 * and finish each reference's delivery ({@link RepositoryRef.applyTo}). A
 * `?` alternate is answered by its own reference. A repository with a resolution in
 * `resolutions` delivers its batch from it. A request for files joins no
 * resolution, so nothing here waits on it: it is answered {@link PendingFiles
 * pending}, fetched when the collection is given its content.
 */
function resolveRequests(
  context: ResolutionContext,
  requests: ReadonlyArray<PackageRequest>,
  resolutions?: ReadonlyMap<RefSource, () => Computable<Resolution>>
): Computable<Map<RepositoryRef, Resolved | RepositoryRef>> {
  const batches = [...groupRequests(requests.filter(request => request.as !== "files"))];
  return Computable.forAll(
    batches.map(([repository, batch]) => resolveBatch(context, repository, batch, resolutions?.get(repository))),
    (...results: Array<FileSet | ResolvedNode | PendingFiles>[]) => {
      const finished = new Map<RepositoryRef, Resolved | RepositoryRef>();
      const finish = (reference: RepositoryRef, resolved: FileSet | ResolvedNode | PendingFiles): Resolved | RepositoryRef =>
        resolved instanceof PendingFiles
          ? new PendingFiles(() => resolved.fetch().then(files => reference.applyTo(files as FileSet) as FileSet | FileSetRef))
          : reference.applyTo(resolved);
      batches.forEach(([, batch], batchIndex) =>
        batch.forEach((request, index) =>
          finished.set(request.reference, installsNothing(request) ? request.reference : finish(request.reference, results[batchIndex][index]))
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
                resolveBatch(context, source, [request], resolutions?.get(source)).then(
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
 * @return true if `pkg` is what `reference` names — a version its repository's
 * format accepts for the requirement the reference states — otherwise false.
 * Asked of a package already
 * known by the name the reference is required under. A reference whose
 * repository resolves no versions is answered by nothing.
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
 * How a collection point consumes what it materializes. **"strict"** (the
 * default): the closure is linked into the consumer's own module graph, so a
 * package shipped at more than one version, from any source, is an error unless
 * each version is sanctioned. **"permissive"**: the closure is a sealed program
 * that is executed, not linked against (a runnable's install), so coexisting
 * versions are accepted and nest. Given by the framework to a single-surface
 * collection (`collectLists`, `materializeShallow`); a rule's own requirements
 * say it with `permissive()`. Never a constraint.
 */
export interface ResolutionOptions {
  resolutionMode?: "strict" | "permissive";
}

/** The mode of every launch-bound materialization: the runnable accessors, a
 * command stage's tool, the `run` verb's own name. */
export const PERMISSIVE_RESOLUTION: ResolutionOptions = { resolutionMode: "permissive" };

/**
 * Run `deliver`, the work one reference asks of its repository, and attribute
 * any failure to the written reference (a {@link RequirementResolutionError}):
 * the ref's carried provenance lets the driver point back at the requirement as
 * written (`@npm:pkg:ver`, `@catalog:name`), not just at the consuming target.
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
