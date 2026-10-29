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

import { Computable } from "../core/Computable";
import { FabrError } from "../core/Errors";
import { FileSet } from "../core/FileSet";
import { IProjection, Miss } from "../core/Reference";
import { Dependency, dependencyName, isPackage, NodeFields, PackageContent, PackageFileSet, Provided, ResolvedNode } from "../core/PackageFileSet";

import { Resolved, SourceRef } from "../core/Repository";
import { TargetNode } from "../core/TargetRef";
import { BUILD_OPERATION, isFilesOperation, shownConstraints } from "../model/Constraints";
import { ITargetOrigin, TARGET_PROVENANCE } from "../model/Target";
import { DEPENDENCIES_KEY, EXTENDS_KEY, OPTIONAL_PROVIDED_KEY, PROVIDED_KEY, ResolvedRequirements } from "./Collection";
import { NameLabel } from "../model/Errors";
import type { DeclaredTargetContext } from "./TargetContext";

/** What a target passes on to whatever requires it. */
interface Stated {
  version?: string;
  dependencies: ReadonlyArray<Dependency>;
  /** The names among `dependencies` that are provided requirements. */
  provided?: ReadonlyMap<string, Provided>;
}

/** A declared target's requirements and how to build it: what its node and
 * every copy of the node share. */
class TargetBuild {
  private materialized?: Computable<SourceRef[]>;
  /** The label on the build, made when the target is resolved: a cycle is
   * reported from the name on it asked for first. */
  private readonly label: NameLabel;

  constructor(
    public readonly context: DeclaredTargetContext,
    public readonly resolved: ResolvedRequirements,
    private readonly evaluate: () => Computable<SourceRef[]>
  ) {
    this.label = new NameLabel(context.name, context.target);
  }

  /** What the target requires, resolved, by name. */
  public get requirements(): ReadonlyMap<string, ReadonlyArray<Resolved>> {
    return this.resolved.sources;
  }

  /** Build the target and return its result. Built on first demand, once. */
  public materialize(): Computable<SourceRef[]> {
    return (this.materialized ??= Computable.detached(() => this.evaluate()).labelled(this.label));
  }

  /** Get what the target passes on to whatever requires it. */
  public stated(): Stated {
    /* The edges to the packages among a requirement: each the reference it
     * was resolved for, which every package a collection delivers has. */
    const carried = (name: string): Dependency[] => {
      const references = this.resolved.references.get(name) ?? [];
      return (this.requirements.get(name) ?? []).flatMap((source, at): Dependency[] => {
        if (!isPackage(source)) {
          return [];
        }
        const reference = references[at];
        if (reference === undefined) {
          throw new FabrError(`internal: '${source.packageId}' among '${name}' of '${this.context.name}' was resolved for no reference`);
        }
        return [{ reference, package: source }];
      });
    };
    const [only, ...others] = this.requirements.get(EXTENDS_KEY) ?? [];
    if (others.length === 0 && isPackage(only)) {
      return { version: only.version, dependencies: only.dependencies, provided: only.provided };
    }
    const provided = carried(PROVIDED_KEY);
    const optional = carried(OPTIONAL_PROVIDED_KEY);
    return {
      dependencies: [...carried(DEPENDENCIES_KEY), ...provided, ...optional],
      provided: new Map([
        ...provided.map((dep): [string, Provided] => [dependencyName(dep), "expected"]),
        ...optional.map((dep): [string, Provided] => [dependencyName(dep), "optional"]),
      ]),
    };
  }

  /**
   * Build the target for whatever requires it: the package it builds, or
   * where it builds none, its sources as they stand. A package requires only
   * what the target stated, since that is what was resolved with what
   * requires it.
   */
  public built(plain: boolean): Computable<PackageFileSet | SourceRef[]> {
    const name = this.context.name;
    return this.materialize().then((sources): PackageFileSet | SourceRef[] => {
      const pkg = sources.find((source): source is PackageFileSet => source instanceof PackageFileSet);
      if (pkg === undefined || plain) {
        return sources.map(source => (source instanceof PackageFileSet ? new FileSet(source, source.origin) : source));
      }
      /* What a rule yields wrongly is its target's own failure. */
      if (sources.length > 1) {
        throw this.context.failure(
          new FabrError(`'${name}' builds a package and other things beside it`).withHelp(
            "what a target builds is a package or it is files: a rule yields one package alone"
          )
        );
      }
      const stated = new Set(this.stated().dependencies.map(dependencyName));
      const unstated = pkg.dependencies.map(dependencyName).filter(dep => !stated.has(dep));
      if (unstated.length > 0) {
        throw this.context.failure(
          new FabrError(
            `'${name}' builds a package requiring ${unstated.map(dep => `'${dep}'`).join(", ")}, which its rule does not state`
          ).withHelp(
            "a rule states what its target's package requires in `requirements`, as `dependencies` and `provided` (or the package it is made from, as `extends`), so that what depends on the target is resolved with it"
          )
        );
      }
      return pkg;
    });
  }
}

/**
 * A target, resolved: a node of the graph of whatever requires it, named as
 * the target is with what it passes on, holding what its rule requires as its
 * collection point resolved it, and how to build it.
 */
export abstract class ResolvedTarget extends ResolvedNode implements TargetNode {
  /** What the target's rule requires, resolved: what the rule is evaluated
   * over, each requirement's sources aligned with the references they were
   * resolved for, and what conflicts among them. */
  public abstract readonly resolved: ResolvedRequirements;

  public abstract materialize(): Computable<SourceRef[]>;

  public abstract projectBuilt(sources: SourceRef[], projection: IProjection, miss: Miss | undefined): SourceRef[] | Computable<SourceRef[]>;
}

/**
 * A declared target, resolved: what it requires, every reference bound to a
 * selected version and nothing fetched or built, in the configuration it was
 * read in, and how to build it. Materializing it builds it.
 *
 * To whatever requires it, it is a node named as the target is, requiring
 * what its rule states as passed on: its `dependencies`, `provided` and
 * `optional_provided`, or
 * the version and requirements of the one package it `extends`, or nothing.
 * What it builds — a package, or files — is known when it is built.
 */
export class DeclaredResolvedTarget extends ResolvedTarget {
  private constructor(
    private readonly build: TargetBuild,
    fields: NodeFields
  ) {
    super(fields.content, fields.packageName, fields.version, fields.dependencies, fields.origin, fields.provided);
  }

  /**
   * Make the resolved target `context` names, whose requirements resolved to
   * `resolved` and which `evaluate` builds, in `context`'s configuration.
   */
  public static of(
    context: DeclaredTargetContext,
    resolved: ResolvedRequirements,
    evaluate: () => Computable<SourceRef[]>
  ): DeclaredResolvedTarget {
    const build = new TargetBuild(context, resolved, evaluate);
    const stated = build.stated();
    return new DeclaredResolvedTarget(build, {
      content: targetContent(context, plain => build.built(plain)),
      packageName: context.name,
      version: stated.version,
      dependencies: stated.dependencies,
      origin: targetOrigin(context),
      provided: stated.provided ?? new Map(),
    });
  }

  public get resolved(): ResolvedRequirements {
    return this.build.resolved;
  }

  public materialize(): Computable<SourceRef[]> {
    return this.build.materialize();
  }

  public projectBuilt(sources: SourceRef[], projection: IProjection, miss: Miss | undefined): SourceRef[] | Computable<SourceRef[]> {
    return this.build.context.projectSources(sources, projection, miss);
  }

  public override copy(changes: Partial<NodeFields>): DeclaredResolvedTarget {
    return new DeclaredResolvedTarget(this.build, { ...this.fields(), ...changes });
  }
}

/** Make the provenance of the node of the target `context` names. */
function targetOrigin(context: DeclaredTargetContext): ITargetOrigin {
  return { kind: TARGET_PROVENANCE, decl: context.target };
}

/**
 * Make the content of the node of the target `context` names, in its
 * configuration: what `built` builds, told whether the target is read for its
 * files alone.
 */
function targetContent(context: DeclaredTargetContext, built: (plain: boolean) => Computable<PackageFileSet | SourceRef[]>): PackageContent {
  const constraints = context.taskDescription().constraints;
  /* One target under two configurations is two nodes. */
  const configuration = [...constraints]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join(",");
  const plain = isFilesOperation(constraints.get(BUILD_OPERATION));
  const shown = shownConstraints(constraints)
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join(", ");
  return {
    key: `built ${context.scopedName} ${configuration}`,
    files: () => built(plain),
    builds: context.name,
    configuration: shown,
    ...(plain ? { plain } : {}),
  };
}

/**
 * The node of a target of a rule's block with its requirements left
 * unresolved: its edges the references among what it passes on, which the
 * collection that requires it resolves, and its build the target's own,
 * resolved where it is built (`target`).
 */
export class BlockTargetNode extends ResolvedNode implements TargetNode {
  private constructor(
    private readonly context: DeclaredTargetContext,
    private readonly target: () => Computable<ResolvedTarget>,
    fields: NodeFields
  ) {
    super(fields.content, fields.packageName, fields.version, fields.dependencies, fields.origin, fields.provided);
  }

  /** Make the node of the target `context` names, which passes on `dependencies`, those named in `provided` provided, and which `target` resolves to build. */
  public static of(
    context: DeclaredTargetContext,
    dependencies: ReadonlyArray<Dependency>,
    provided: ReadonlyMap<string, Provided>,
    target: () => Computable<ResolvedTarget>
  ): BlockTargetNode {
    return new BlockTargetNode(context, target, {
      content: targetContent(context, () => target().then(resolved => resolved.content.files() as Computable<PackageFileSet | SourceRef[]>)),
      packageName: context.name,
      dependencies,
      origin: targetOrigin(context),
      provided,
    });
  }

  public materialize(): Computable<SourceRef[]> {
    return this.target().then(resolved => resolved.materialize());
  }

  public projectBuilt(sources: SourceRef[], projection: IProjection, miss: Miss | undefined): SourceRef[] | Computable<SourceRef[]> {
    return this.context.projectSources(sources, projection, miss);
  }

  public override copy(changes: Partial<NodeFields>): BlockTargetNode {
    return new BlockTargetNode(this.context, this.target, { ...this.fields(), ...changes });
  }
}

/**
 * A target a rule written in `.fabr` builds: the node of what the rule's
 * result names, in every respect and built as it is, except that what it
 * requires (`resolved`) is what the rule's block resolves as one, shown as the
 * target's own requirements.
 */
export class BlockResolvedTarget extends ResolvedTarget {
  constructor(
    private readonly result: ResolvedTarget,
    public readonly resolved: ResolvedRequirements
  ) {
    super(result.content, result.packageName, result.version, result.dependencies, result.origin, result.provided);
  }

  public materialize(): Computable<SourceRef[]> {
    return this.result.materialize();
  }

  public projectBuilt(sources: SourceRef[], projection: IProjection, miss: Miss | undefined): SourceRef[] | Computable<SourceRef[]> {
    return this.result.projectBuilt(sources, projection, miss);
  }

  public override copy(changes: Partial<NodeFields>): BlockResolvedTarget {
    return new BlockResolvedTarget(this.result.copy(changes) as ResolvedTarget, this.resolved);
  }
}
