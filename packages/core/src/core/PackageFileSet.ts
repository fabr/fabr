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

import { Computable } from "./Computable";
import { ConflictError, FabrError, TargetNotPackageError } from "./Errors";
import { FileSet, IFile } from "./FileSet";
import { hashString } from "./FSWrapper";
import { IProvenanceStep, rootedAt } from "./Provenance";
/* Type-only: RepositoryRef values are only ever constructed/inspected on the
 * Repository side; carrying the type here must not create a module cycle. */
import type { Reference } from "./Reference";
import type { RepositoryRef, SourceRef } from "./Repository";
import type { Requirement } from "../resolver/Types";

/** How strongly a provided requirement is expected (see Requirement.provided). */
export type Provided = NonNullable<Requirement["provided"]>;

const NOTHING_PROVIDED: ReadonlyMap<string, Provided> = new Map();

/**
 * A package, less its files: its name, its version, what each of its direct
 * edges is bound to, which of those are provided requirements, and where it
 * came from. A resolution produces it, and it is all that reading a package
 * graph needs. A {@link ResolvedNode} is this alone; a {@link PackageFileSet}
 * is this with the files.
 */
export interface PackageMetadata {
  readonly packageName: string;
  readonly version?: string;
  /** Its direct dependencies, each the reference that asked and what it is
   *  bound to. */
  readonly dependencies: ReadonlyArray<Dependency>;
  /** The names among `dependencies` that are provided requirements. */
  readonly provided: ReadonlyMap<string, Provided>;
  readonly origin?: IProvenanceStep;
  /** `name@version`, the package's identity. */
  readonly packageId: string;
  /** The packages its edges are bound to. */
  readonly packages: Package[];
}

/** A package at either level: resolved, or resolved and holding its files. */
export type Package = ResolvedNode | PackageFileSet;

/**
 * One of a package's direct dependencies: the reference that asked for it,
 * and the package it is bound to, where something has bound it. The edge is
 * named by its reference ({@link dependencyName}).
 */
export interface Dependency<P extends Package = Package> {
  readonly reference: Reference;
  readonly package?: P;
}

/** How a package's files are had, for one that does not hold them. */
export interface PackageContent {
  /** Names the files without reading them: one key, one set of files. */
  readonly key: string;
  /** Get the files, fetching or building them on first demand: one set, or,
   * where a target's build is no package, its sources as they stand. */
  files(): Computable<FileSet | ReadonlyArray<SourceRef>>;
  /**
   * The target whose build the files are, by name. What a target builds is
   * known when it is built: the node is a package where its build is one, and
   * plain files otherwise.
   */
  readonly builds?: string;
  /** The configuration the target is built under, as a message shows it
   * (`BUILD_TYPE=release`): empty where it is the ambient one. */
  readonly configuration?: string;
  /** Whether the build is known to be no package (the target was read for
   * its files). Such a node claims no name among packages. */
  readonly plain?: true;
}

/** What a {@link ResolvedNode} is made of. */
export interface NodeFields {
  readonly content: PackageContent;
  readonly packageName: string;
  readonly version?: string;
  readonly dependencies: ReadonlyArray<Dependency>;
  readonly origin?: IProvenanceStep;
  readonly provided: ReadonlyMap<string, Provided>;
}

/**
 * A node of a resolved graph: a name, a version where one is known, every
 * edge bound, and no files — only how to have them ({@link content}), which
 * {@link materializePackages} calls and nothing that reads the graph does. A
 * registry's node is a package. A target's node is whatever the target
 * builds, a package or plain files, which is known when it is built
 * ({@link PackageContent.builds}). The graph may be cyclic; build one with a
 * {@link PackageGraphBuilder}.
 */
export class ResolvedNode implements PackageMetadata {
  constructor(
    public readonly content: PackageContent,
    public readonly packageName: string,
    public readonly version?: string,
    public readonly dependencies: ReadonlyArray<Dependency> = [],
    public readonly origin?: IProvenanceStep,
    public readonly provided: ReadonlyMap<string, Provided> = NOTHING_PROVIDED
  ) {}

  public get packageId(): string {
    return `${this.packageName}@${this.version ?? "*"}`;
  }

  public get packages(): Package[] {
    return this.dependencies.flatMap(dep => (dep.package === undefined ? [] : [dep.package]));
  }

  public withOrigin(origin: IProvenanceStep): ResolvedNode {
    return this.copy({ origin });
  }

  /** Make a copy whose files are had as `content` says. */
  public withContent(content: PackageContent): ResolvedNode {
    return this.copy({ content });
  }

  /** See {@link PackageFileSet.withPackageName}. */
  public withPackageName(packageName: string): ResolvedNode {
    return this.copy({ packageName });
  }

  /** Make a copy with `changes` made, of the same kind as this node. */
  public copy(changes: Partial<NodeFields>): ResolvedNode {
    const fields = { ...this.fields(), ...changes };
    return new ResolvedNode(
      fields.content,
      fields.packageName,
      fields.version,
      fields.dependencies,
      fields.origin,
      fields.provided
    );
  }

  /** Get what this node is made of, for a copy. */
  protected fields(): NodeFields {
    return {
      content: this.content,
      packageName: this.packageName,
      version: this.version,
      dependencies: this.dependencies,
      origin: this.origin,
      provided: this.provided,
    };
  }

  public getDependency(name: string): Dependency | undefined {
    return this.dependencies.find(dep => dependencyName(dep) === name);
  }
}

export function isPackage(source: unknown): source is Package {
  return source instanceof ResolvedNode || source instanceof PackageFileSet;
}

/** Make the content of a package whose files are in hand. */
export function contentOf(pkg: Package): PackageContent {
  return pkg instanceof ResolvedNode ? pkg.content : { key: pkg.toManifestHash(), files: () => Computable.resolve(pkg) };
}

/**
 * A FileSet that is a package; adds package name, version, and dependencies.
 *
 * `dependencies` is **what each of the package's direct edges is bound to** —
 * a package, or the reference that requires one where nothing has bound it yet
 * — a fact about the resolution, never a layout decision (layout is the
 * consuming assembler's):
 *
 * - A **built** package's edges are its own: built deps as packages, external
 *   requirements as references or as the packages a collection point
 *   delivered for them. The local build graph is acyclic by construction.
 *
 * - A **delivered** external package carries, on every node, ALL of that
 *   node's edges, each bound to the instance the resolution chose
 *   ({@link edgeBinding}'s answer) — the adjacency list of the resolved
 *   graph, distributed across the nodes. The graph may be **cyclic**
 *   (constructed via {@link PackageGraphBuilder}), so walkers must be
 *   cycle-safe; hoisting and private nesting are computed by the assembler
 *   from these complete facts, not read out of the structure.
 *
 * An edge's *name* is its reference's local name ({@link dependencyName}):
 * the name its requirer knows it by, which a renamed dependency's instance
 * is restamped under too.
 * Content derivations (find/remap/minus/...) deliberately return plain
 * FileSets: once you reach inside a package, the result is just files.
 */
export class PackageFileSet extends FileSet {
  constructor(
    files: Iterable<[string, IFile]>,
    public readonly packageName: string,
    public readonly version?: string,
    public readonly dependencies: ReadonlyArray<Dependency<PackageFileSet>> = [],
    origin?: IProvenanceStep,

    /* The names among `dependencies` that are provided requirements, each with
     * how strongly it is expected. */
    public readonly provided: ReadonlyMap<string, Provided> = NOTHING_PROVIDED
  ) {
    /* An existing FileSet passes straight through — the base shares its content
     * (already canonical) rather than copying and rechecking every name, which
     * is the whole cost of a restamp/re-wrap. Any other iterable is new names. */
    super(files instanceof FileSet ? files : new Map(files), origin ?? (files instanceof FileSet ? files.origin : undefined));
  }

  /** A package's delivered name — the name its requirers' edges call it by,
   * which is what a discovered-deps walk follows. Unversioned: see
   * {@link FileSet.name}. */
  public override get name(): string {
    return this.packageName;
  }

  /** This package's semantic `name@version` id. Object identity means nothing,
   * since every delivery wraps its own instances. */
  public get packageId(): string {
    return `${this.packageName}@${this.version ?? "*"}`;
  }

  /** The packages this package's edges are bound to — the installation's
   * edges out of it, provided bindings included. */
  public get packages(): PackageFileSet[] {
    return this.dependencies.flatMap(dep => (dep.package === undefined ? [] : [dep.package]));
  }

  public withOrigin(origin: IProvenanceStep): PackageFileSet {
    return new PackageFileSet(this, this.packageName, this.version, this.dependencies, origin, this.provided);
  }

  /**
   * @return a copy delivered under `packageName` instead of its own — the
   * identity a consumer lays it out under, and all that a rename changes. The
   * content, version and closure are shared: the package still resolves its own
   * dependencies among themselves under their real names, exactly as an npm
   * dependency alias (`"stream": "npm:stream-browserify@^3"`) leaves everything
   * but the mount point alone.
   */
  public withPackageName(packageName: string): PackageFileSet {
    return new PackageFileSet(this, packageName, this.version, this.dependencies, this.origin, this.provided);
  }

  public getDependency(name: string): Dependency<PackageFileSet> | undefined {
    return this.dependencies.find(dep => dependencyName(dep) === name);
  }
}

/** Get the name an edge is required under: the one its reference gives. */
export function dependencyName(dep: Dependency): string {
  return dep.reference.localName;
}

/**
 * Flatten a FileSet list to everything it indirectly reaches: the given
 * members in order, then every further FileSet a package member's edges bind,
 * breadth-first, each instance once (an unbound edge has no files to add). Loose members are retained, and only package members have
 * edges to follow. The closure walk behind {@link reachablePackages};
 * cycle-safe, as a delivered graph is genuinely cyclic.
 */
export function flattenFileSetArray(sets: ReadonlyArray<FileSet>): FileSet[] {
  const seen = new Set<FileSet>(sets);
  const result = [...sets];
  for (let i = 0; i < result.length; i++) {
    const item = result[i];
    if (item instanceof PackageFileSet) {
      item.packages.forEach(dep => {
        if (!seen.has(dep)) {
          result.push(dep);
          seen.add(dep);
        }
      });
    }
  }
  return result;
}

/** Every package the given sets reach — the sets' package members and,
 * recursively, every package their edges bind — the package view of
 * {@link flattenFileSetArray}: breadth-first, each instance once. Consumers
 * must not key on the order (they sort at use, or read the set). */
export function reachablePackages(sets: ReadonlyArray<FileSet>): PackageFileSet[] {
  return flattenFileSetArray(sets).filter((set): set is PackageFileSet => set instanceof PackageFileSet);
}

/** Get each package `roots` are or reach, once, at either level. */
export function reachableNodes(roots: ReadonlyArray<Package>): Package[] {
  const seen = new Set<Package>(roots);
  const result = [...seen];
  for (let i = 0; i < result.length; i++) {
    for (const dep of result[i].packages) {
      if (!seen.has(dep)) {
        seen.add(dep);
        result.push(dep);
      }
    }
  }
  return result;
}

/**
 * Partition `packages` into classes of structural equality — the same package
 * wired the same way all the way down, cycles included — by refining a
 * coloring to a fixpoint: each node's class, as an opaque string.
 */
function structuralClasses(packages: ReadonlyArray<Package>): Map<Package, string> {
  const children = (pkg: Package): Package[] => pkg.packages;
  let color = new Map(packages.map(pkg => [pkg, `${pkg.packageId} ${contentOf(pkg).key}`]));
  let groups = new Set(color.values()).size;
  for (;;) {
    const refined = new Map(
      packages.map(pkg => [
        pkg,
        hashString(`${color.get(pkg)}|${children(pkg).map(dep => `${dep.packageName}=${color.get(dep)}`).sort().join(",")}`),
      ])
    );
    const refinedGroups = new Set(refined.values()).size;
    if (refinedGroups === groups) {
      return color;
    }
    color = refined;
    groups = refinedGroups;
  }
}

/**
 * Map each node the graph under `roots` holds to the one node of its
 * structural class ({@link nodeNaming}): itself where it is the first of its
 * class reached from the roots, in root order, and that first one otherwise.
 * Two nodes mapping to one are the same package wired the same way, which
 * one installation holds once.
 */
export function equalNodes(roots: ReadonlyArray<Package>): Map<Package, Package> {
  const packages = reachableNodes(roots);
  const color = structuralClasses(packages);
  const first = new Map<string, Package>();
  const canonical = new Map<Package, Package>();
  for (const pkg of packages) {
    const group = color.get(pkg)!;
    const held = first.get(group);
    if (held === undefined) {
      first.set(group, pkg);
    }
    canonical.set(pkg, held ?? pkg);
  }
  return canonical;
}

/**
 * One graph node's id-level line: identity, content key, edge targets by id.
 * It names a node exactly when no id in its installation is wired two ways —
 * the common case, and what {@link nodeNaming} answers with wherever that
 * holds.
 */
export function packageNodeSignature(pkg: Package): string {
  const edges = pkg.packages.map(dep => dep.packageId).sort();
  return `${pkg.packageId} ${contentOf(pkg).key} [${edges.join(",")}]`;
}

/**
 * The node names of one installation — the graph reachable from `sets` — as a
 * function of an instance: two instances get one name exactly when they are
 * the same package wired the same way all the way down (cycles included), so
 * an installation may hold one `packageId` wired several ways and each wiring
 * is its own node, as npm nests and Yarn virtualizes.
 *
 * Computed by partition refinement: instances start grouped by their own label
 * (id, content key) and a group splits wherever members' children,
 * by the name each is required under, fall in different groups — to the fixed
 * point, which is structural equality. Where an id ends in one group the name
 * is the id-level {@link packageNodeSignature}; an id wired several ways adds
 * a suffix that tells its wirings apart. Names are meaningful only within the
 * installation they were computed for.
 */
export function nodeNaming(sets: ReadonlyArray<FileSet | ResolvedNode>): (pkg: Package) => string {
  const packages = reachableNodes(sets.filter(isPackage));
  const color = structuralClasses(packages);
  /* An id is split when its instances ended in more than one group. */
  const groupsById = new Map<string, Set<string>>();
  for (const pkg of packages) {
    const held = groupsById.get(pkg.packageId) ?? new Set<string>();
    held.add(color.get(pkg)!);
    groupsById.set(pkg.packageId, held);
  }
  return pkg => {
    const line = packageNodeSignature(pkg);
    const group = color.get(pkg);
    return group !== undefined && groupsById.get(pkg.packageId)!.size > 1 ? `${line} ~${hashString(group).slice(0, 16)}` : line;
  };
}

/**
 * Assert that two instances delivered under one {@link PackageFileSet.packageId}
 * really are the same node — same bytes, same edge bindings.
 *
 * A resolution is per node, not per id, so it can hold two nodes under one
 * id; a physical install cannot, a tree giving a package one directory. So
 * this is the assemblers' precondition, and a conflict rather than a pick.
 */
export function assertSamePackageNode(held: PackageFileSet, arrived: PackageFileSet): void {
  if (packageNodeSignature(held) !== packageNodeSignature(arrived)) {
    throw packageConflict(held, arrived);
  }
}

/**
 * The error for two instances under one {@link PackageFileSet.packageId} that
 * are not one node, said in the terms that tell a reader what to do. Different
 * CONTENT is two packages claiming one identity. Same content wired to
 * different dependencies is one package delivered twice, and the dependency
 * that differs is the thing to look at: a version divergence below it.
 */
export function packageConflict(held: PackageFileSet, arrived: PackageFileSet): Error {
  const side = (pkg: PackageFileSet, detail: string): { provenance?: IProvenanceStep; detail: string } => ({
    provenance: pkg.origin,
    detail,
  });
  if (held.toManifestHash() !== arrived.toManifestHash()) {
    return new ConflictError(
      "packages",
      held.packageName,
      side(held, held.packageId),
      side(arrived, `${arrived.packageId}, different content`)
    ).withHelp(
      `two different packages both claim to be '${held.packageId}' — one installation holds one package per ` +
        "name and version; give them distinct versions, or align the two sources on one package"
    );
  }
  const differing = dependencyDifference(held, arrived);
  return new ConflictError(
    "packages",
    held.packageName,
    side(held, dependencyText(held)),
    side(arrived, dependencyText(arrived))
  ).withHelp(
    `'${held.packageId}' is delivered twice with different dependencies (${differing}), and this installation ` +
      "holds one copy of it — align the dependency that differs"
  );
}

/** `name@version`, and what it depends on, for a conflict's side. */
function dependencyText(pkg: PackageFileSet): string {
  const deps = packageDependencyIds(pkg);
  return `${pkg.packageId} depending on ${deps.length === 0 ? "nothing" : deps.join(", ")}`;
}

/** What differs between two instances' dependencies, by the name each is
 * required under. */
function dependencyDifference(a: PackageFileSet, b: PackageFileSet): string {
  const byName = (pkg: PackageFileSet): Map<string, string> =>
    new Map(pkg.packages.map(dep => [dep.packageName, dep.packageId]));
  const left = byName(a);
  const right = byName(b);
  const names = [...new Set([...left.keys(), ...right.keys()])].sort();
  const differences = names.flatMap(name => {
    const [x, y] = [left.get(name), right.get(name)];
    if (x === y) {
      return [];
    }
    return [x === undefined ? `${y} on one side only` : y === undefined ? `${x} on one side only` : `${x} against ${y}`];
  });
  return differences.join("; ") || "the same dependencies, bound to different copies of them";
}

function packageDependencyIds(pkg: PackageFileSet): string[] {
  return pkg.packages.map(dep => dep.packageId).sort();
}

/**
 * Two instances claiming one name where a consumer addresses its direct
 * dependencies by name — a `node_modules` entry, a module table's top level:
 * two versions of it, or — where the version is the same — the conflict
 * {@link packageConflict} explains.
 */
export function packageNameConflict(held: PackageFileSet, arrived: PackageFileSet): Error {
  if (held.packageId === arrived.packageId) {
    return packageConflict(held, arrived);
  }
  return new ConflictError(
    "packages",
    held.packageName,
    { provenance: held.origin, detail: held.packageId },
    { provenance: arrived.origin, detail: arrived.packageId }
  );
}

/**
 * Constructs a possibly-**cyclic** graph of immutable {@link PackageFileSet}s.
 *
 * A package's `dependencies` are the instances its edges bind to, and real
 * dependency graphs have cycles (same-version mutual deps are common in npm) —
 * which depth-first immutable construction cannot produce. The builder is the
 * two-phase answer: every node is created first (its dependency list empty but
 * *retained*), edges are wired once the nodes they point at exist, and
 * {@link seal} freezes every list. Immutability is thus a property of the
 * **published** graph — a value never escapes the constructing scope unwired —
 * rather than of every intermediate state.
 *
 * Each node may be wired exactly once; sealing an incompletely-wired graph is
 * fine (a leaf simply has no dependencies). The builder is single-use.
 */
export class PackageGraphBuilder {
  private readonly pending = new Map<Package, { dependencies: Array<Dependency>; provided: Map<string, Provided> }>();
  private readonly wired = new Set<Package>();
  private sealed = false;

  /** Create a node with empty (unwired) dependencies. */
  public node(files: Iterable<[string, IFile]>, packageName: string, version?: string, origin?: IProvenanceStep): PackageFileSet {
    if (this.sealed) {
      throw new FabrError("PackageGraphBuilder is sealed");
    }
    /* The constructor stores both by reference, which is exactly what lets
     * the builder fill them in after construction. */
    const dependencies: Array<Dependency<PackageFileSet>> = [];
    const provided = new Map<string, Provided>();
    const pkg = new PackageFileSet(files, packageName, version, dependencies, origin, provided);
    this.pending.set(pkg, { dependencies, provided });
    return pkg;
  }

  /** Create a node, as {@link node} does, for a package that does not hold its files. */
  public resolved(content: PackageContent, packageName: string, version?: string, origin?: IProvenanceStep): ResolvedNode {
    if (this.sealed) {
      throw new FabrError("PackageGraphBuilder is sealed");
    }
    const dependencies: Array<Dependency> = [];
    const provided = new Map<string, Provided>();
    const pkg = new ResolvedNode(content, packageName, version, dependencies, origin, provided);
    this.pending.set(pkg, { dependencies, provided });
    return pkg;
  }

  /** Copy `pkg` as an unwired resolved node: its identity, its origin and
   *  its content, and of its kind where it is a node (a target's stays a
   *  target's). What a pass that rewires a graph makes of each package. */
  public copy(pkg: Package, origin: IProvenanceStep | undefined = pkg.origin): ResolvedNode {
    if (!(pkg instanceof ResolvedNode)) {
      return this.resolved(contentOf(pkg), pkg.packageName, pkg.version, origin);
    }
    if (this.sealed) {
      throw new FabrError("PackageGraphBuilder is sealed");
    }
    const dependencies: Array<Dependency> = [];
    const provided = new Map<string, Provided>();
    const node = pkg.copy({ dependencies, provided, origin });
    this.pending.set(node, { dependencies, provided });
    return node;
  }

  /** Wire a node's dependencies, and which of them are provided requirements
   * (once — an empty wiring counts), to nodes of this or any graph. */
  public wire(
    pkg: Package,
    dependencies: ReadonlyArray<Dependency>,
    provided: ReadonlyMap<string, Provided> = NOTHING_PROVIDED
  ): void {
    const lists = this.pending.get(pkg);
    if (lists === undefined) {
      throw new FabrError(this.sealed ? "PackageGraphBuilder is sealed" : "not an unwired node of this builder");
    }
    if (this.wired.has(pkg)) {
      throw new FabrError(`${pkg.packageId} is already wired`);
    }
    this.wired.add(pkg);
    lists.dependencies.push(...dependencies);
    provided.forEach((expected, name) => lists.provided.set(name, expected));
  }

  /** Freeze every node's lists; the graph is now immutable. */
  public seal(): void {
    for (const { dependencies } of this.pending.values()) {
      Object.freeze(dependencies);
    }
    this.pending.clear();
    this.wired.clear();
    this.sealed = true;
  }
}

/**
 * Materialize the packages `roots` are and reach: each resolved node among
 * them is given its content, fetched or built here, and wired as the graph
 * is. A package already holding its files that reaches no node without them
 * comes back as itself, and a root whose content is no package (a target that
 * builds files, a program) as that content. Throw {@link TargetNotPackageError} where a package
 * requirement is bound to a target that builds no package. This is the one
 * step that turns a resolution into content.
 */
export function materializePackages(roots: ReadonlyArray<Package>): Computable<Array<PackageFileSet | ReadonlyArray<SourceRef>>>;
/** As above, for roots known to be packages: a registry's. */
export function materializePackages(roots: ReadonlyArray<Package>, packages: true): Computable<PackageFileSet[]>;
export function materializePackages(roots: ReadonlyArray<Package>): Computable<Array<PackageFileSet | ReadonlyArray<SourceRef>>> {
  const all = reachableNodes(roots);
  const nodes = all.filter((pkg): pkg is ResolvedNode => pkg instanceof ResolvedNode);
  if (nodes.length === 0) {
    return Computable.resolve(roots as PackageFileSet[]);
  }
  /* A package holding its files is rebuilt only where it reaches one that
   * does not; found by walking back from the nodes. */
  const dependents = new Map<Package, Package[]>();
  for (const pkg of all) {
    for (const dep of pkg.packages) {
      dependents.set(dep, [...(dependents.get(dep) ?? []), pkg]);
    }
  }
  const rebuilt = new Set<Package>(nodes);
  const queue: Package[] = [...nodes];
  for (let i = 0; i < queue.length; i++) {
    for (const dependent of dependents.get(queue[i]) ?? []) {
      if (!rebuilt.has(dependent)) {
        rebuilt.add(dependent);
        queue.push(dependent);
      }
    }
  }
  return Computable.forAll(
    nodes.map(node => node.content.files()),
    (...files: Array<FileSet | ReadonlyArray<SourceRef>>) => {
      const content = new Map<Package, FileSet | ReadonlyArray<SourceRef>>(nodes.map((node, index) => [node, files[index]]));
      const builder = new PackageGraphBuilder();
      const made = new Map<Package, PackageFileSet>();
      /* A node's content where that is no package (what a target built as
       * files, or a program): its sources, as they stand. */
      const plain = (pkg: Package): ReadonlyArray<SourceRef> | undefined => {
        const files = content.get(pkg);
        if (!(pkg instanceof ResolvedNode) || files === undefined || files instanceof PackageFileSet) {
          return undefined;
        }
        /* The node's origin stood in for the build: the built files' own
         * origin replaces its last step, under the steps added since. */
        return (files instanceof FileSet ? [files] : files).map(source => {
          const origin = source instanceof FileSet ? rootedAt(pkg.origin, source.origin) : undefined;
          return origin === undefined ? source : (source as FileSet).withOrigin(origin);
        });
      };
      const withFiles = (pkg: Package): PackageFileSet => {
        if (!rebuilt.has(pkg)) {
          return pkg as PackageFileSet;
        }
        let held = made.get(pkg);
        if (held === undefined) {
          const files = (content.get(pkg) ?? pkg) as FileSet;
          /* A package built in the project states no version before it is
           * built: it has the one its build gave it. */
          const version = pkg.version ?? (files instanceof PackageFileSet ? files.version : undefined);
          const builds = pkg instanceof ResolvedNode ? pkg.content.builds : undefined;
          held = builder.node(files, pkg.packageName, version, builds === undefined ? pkg.origin : rootedAt(pkg.origin, files.origin));
          made.set(pkg, held);
          builder.wire(
            held,
            pkg.dependencies.flatMap((dep): Array<Dependency<PackageFileSet>> => {
              const bound = dep.package;
              if (bound === undefined) {
                return [{ reference: dep.reference }];
              }
              if (plain(bound) === undefined) {
                return [{ reference: dep.reference, package: withFiles(bound) }];
              }
              /* What a package from elsewhere requires must be a package; so
               * must what a target requires by a reference to a repository's
               * package, while its reference to a target is answered by
               * whatever that builds. */
              if (builds === undefined) {
                throw new TargetNotPackageError(pkg, bound);
              }
              if (dep.reference.requiresPackage === true) {
                throw new TargetNotPackageError(dep.reference as RepositoryRef, bound);
              }
              return [];
            }),
            pkg.provided
          );
        }
        return held;
      };
      const result = roots.map(root => plain(root) ?? withFiles(root));
      builder.seal();
      return result;
    }
  );
}
