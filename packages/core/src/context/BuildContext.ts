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

import type { BuildAction, BuildResult } from "../core/BuildAction";
import type { ActionContext, ICreateOptions } from "../core/BuildCache";
import type { Computable } from "../core/Computable";
import type { FileSet, FileSource } from "../core/FileSet";
import type { IProjection, Miss } from "../core/Reference";
import type { NamespaceRef } from "../core/NamespaceRef";
import type { Name } from "../core/Name";
import type { Materialized, SourceRef } from "../core/Repository";
import type { Unbuilt } from "../core/TargetRef";
import type { ResolvedTarget } from "./ResolvedTarget";
import type { ResolvedRequirements } from "./Collection";
import type { IDecl, INameValue, IPropertyDecl, ITargetDecl } from "../model/AST";
import type { IPropertyEntry } from "../model/Namespace";
import type { Constraints } from "../model/Constraints";
import type { ExecutionContext } from "../model/ExecutionContext";
import type { Property } from "../model/Property";
import type { SubTargetInputs } from "../rules/Types";
import type { ICommandStageLookup } from "./Commands";
import type { PropertyMap } from "./PropertyMap";
import type { IDependencyStack } from "./Stack";
import type { TargetContext } from "./TargetContext";

/**
 * A configuration of the build model: the model under one set of constraints,
 * in one run. `BuildModel.getConfig` makes them, one per constraint set.
 *
 * Each method takes a written reference: a name as it would appear in a build
 * file, with where it was written. For a driver that is an argument on the
 * command line. The siting roots a bare path and positions a diagnostic.
 */
export interface BuildContext {
  /**
   * Get the configuration a program is resolved in to run it on this machine:
   * this one with {@link InternalBuildContext.runOverrides} applied, as a
   * rule's tool is.
   */
  getRunContext(): BuildContext;

  /**
   * Resolve what `ref` names, fetching and building nothing. A target comes
   * back as its node ({@link ResolvedTarget}, which holds what it requires by
   * name), or as a projection over it where the reference selects its files;
   * an external requirement or a catalog member as its package, with its
   * dependencies bound.
   */
  resolve(ref: INameValue): Computable<ResolvedRequirements>;

  /**
   * Materialize what `ref` names: build every target it reaches and fetch
   * every external reference, and return the content. A delivered package comes back as that
   * package's own files, without its dependency closure. A namespace (a
   * repository named on its own, or a namespace of one such as `@npm:glob`)
   * has no content and comes back as it stands: a caller wanting content
   * refuses it ({@link refuseNamespaces}), and one listing names lists its
   * children. Under `BUILD_OPERATION=run` the name is a program to launch,
   * and what it requires is resolved permissively.
   */
  materialize(ref: INameValue): Computable<Array<FileSource | NamespaceRef>>;

  /**
   * @return true if `ref` is a name the project declares — a target, a global
   * or a repository — or one this configuration was given a value for, once its
   * `${NAME}` parts are substituted and any `<k=v>` on it set aside, otherwise
   * false. A declared target's name with a `?` or `!` marker counts. A path, a
   * pattern and a selection of a target's files do not.
   */
  isDeclared(ref: INameValue): Computable<boolean>;

  /**
   * Get the build action that the rule of the target `ref` names yields,
   * without running it. The rule is evaluated to yield it, so whatever
   * requirements it materializes are built. Undefined where the rule yields
   * content and no action.
   */
  getAction(ref: INameValue): Computable<BuildAction | undefined>;

  /**
   * Get a constraint's value as this configuration was given it, or undefined.
   * Declarations are not consulted, so a `default` property is not seen: use
   * {@link InternalBuildContext.getProperty} for a value that a declaration
   * may supply.
   */
  getConstraint(name: string): string | undefined;

  /** Get the constraints this configuration was given. */
  getConstraints(): Constraints;

  /**
   * Get the constraint overrides for resolving a target to run it:
   * BUILD_OPERATION=run, with TARGET pinned to HOST so that a tool is its host
   * build even in a cross-build, and COVERAGE pinned off so that a tool is
   * never measured, and then `extra`. Where HOST is unset, TARGET is left as it
   * is; where COVERAGE is unconstrained, it is left to its default.
   */
  runOverrides(extra?: Constraints): Constraints;

}

/**
 * A configuration as the framework's own code holds it: what a target's
 * context looks its properties up through, and resolves and builds other
 * targets through. Not exported from the package.
 *
 * Where a method takes a `stack`, it is the chain of requesters that led to
 * the call, used to say what required a piece of work.
 * Where it takes `callerOverrides`, they are constraints the caller imposes,
 * which outrank a `<k=v>` written on a property's value.
 */
export interface InternalBuildContext extends BuildContext {
  /** Get the target `name` names in this configuration, resolved. */
  resolvedTarget(name: string): Computable<ResolvedTarget>;

  /**
   * @return the operations the type of the target declared as `name` has
   * rules for (`build`, `doc`; `*` for a rule of any operation), or none where
   * `name` declares no target.
   */
  getTargetOperations(name: string): string[];

  /** The run this configuration belongs to: its cache, log and event listeners. */
  readonly execution: ExecutionContext;

  /**
   * Get the configuration of these constraints with `overrides` applied. With
   * no overrides that is this one: configurations are interned by constraint set.
   */
  getContextWithOverrides(overrides?: Constraints): InternalBuildContext;

  /**
   * Get the configuration of exactly `constraints` in which the same names are
   * looked up as in this one: a rule's block's own names in a configuration
   * of its block, the file's elsewhere.
   */
  inConfiguration(constraints: Constraints): InternalBuildContext;

  /** Substitute every `${NAME}` and command in `name`, as a value's are. */
  substituteName(name: Name, stack?: IDependencyStack): Computable<Name>;

  /**
   * Get the declarations of a property that apply in this configuration: those
   * whose guard admits it, taken from the ordinary declarations if any of them
   * apply, else from the `default` ones. Empty means the property is unwritten
   * here. Several may apply, and combining them is the reader's business
   * (`mergedDecls` for a list, `soleDecl` for a scalar).
   *
   * Call it on the configuration the read happens in: for a read under an
   * override, on `getContextWithOverrides(overrides)`.
   */
  getAvailableDecls(entry: IPropertyEntry | undefined, stack?: IDependencyStack, owner?: ITargetDecl): Computable<IPropertyDecl[]>;

  /**
   * Get the value of the global STRING property `name`. A name that is a target,
   * or that nothing declares and no constraint supplies, is an error.
   */
  getProperty(name: string, stack?: IDependencyStack, callerOverrides?: Constraints): Computable<Property>;

  /**
   * Look up a property's values as names, substituted. A value is not looked
   * up as a reference: this is for STRING and REWRITE values, which name nothing.
   */
  lookupNameProperty(
    prop: IPropertyDecl,
    target?: ITargetDecl,
    stack?: IDependencyStack,
    callerOverrides?: Constraints
  ): Computable<Name[]>;

  /** Look up a STRING property's values, substituted. */
  lookupStringProperty(
    prop: IPropertyDecl,
    target?: ITargetDecl,
    stack?: IDependencyStack,
    callerOverrides?: Constraints
  ): Computable<Property>;

  /**
   * Look up a MAP property's value, keys in declaration order. The value is one
   * `{ key = value; }` block, or references to other block-valued properties,
   * merged in written order with a later entry replacing an earlier one. An
   * entry holds strings, a nested map, or a list of nested maps. An empty
   * property yields an empty map.
   */
  lookupMap(
    prop: IPropertyDecl,
    target?: ITargetDecl,
    stack?: IDependencyStack,
    callerOverrides?: Constraints
  ): Computable<PropertyMap>;

  /**
   * Look up a projection property's one selector, substituted. Undefined
   * where the property is unwritten. More than one value is an error.
   */
  lookupProjection(
    prop: IPropertyDecl,
    target?: ITargetDecl,
    stack?: IDependencyStack,
    callerOverrides?: Constraints
  ): Computable<Name | undefined>;

  /**
   * Look up a target's wildcard properties: of `props`, the declarations
   * whose guard admits this configuration under `callerOverrides`, each with
   * its key substituted. A member's guard decides whether it exists here;
   * members are never combined.
   */
  lookupWildcardProperties(
    props: IPropertyDecl[],
    stack?: IDependencyStack,
    callerOverrides?: Constraints
  ): Computable<{ key: Name; decl: IPropertyDecl }[]>;

  /**
   * Look up a COMMAND property's stages, with every name in them substituted
   * and none yet materialized as a runnable or matched against sources. A value
   * that is the bare name of another COMMAND property yields that property's stages.
   */
  lookupCommand(prop: IPropertyDecl, target?: ITargetDecl, stack?: IDependencyStack): Computable<ICommandStageLookup[]>;

  /**
   * Look up the sources a FILES property's values name. Each records the
   * written value and the constraints it was read under in its provenance. Targets
   * among them are resolved and not built (see {@link resolveTarget}).
   */
  lookupFileProperty(
    prop: IPropertyDecl,
    target?: ITargetDecl,
    stack?: IDependencyStack,
    callerOverrides?: Constraints
  ): Computable<SourceRef[]>;

  /**
   * Look up the sources one written reference names: target prefix, `:` projection,
   * glob or bare path, under the reference's own `<k=v>` and any
   * `callerOverrides`. `relativeTo` is the declaration whose file a bare path
   * is rooted at. With `provenance`, each source records the written value,
   * and a failure of a target it names is attributed to that value.
   */
  lookupFileValue(
    name: Name,
    stack: IDependencyStack | undefined,
    options?: {
      callerOverrides?: Constraints;
      relativeTo?: IDecl;
      provenance?: { value: INameValue; property: IPropertyDecl; target?: ITargetDecl };
    }
  ): Computable<SourceRef[]>;

  /**
   * Find the declared name that is the longest literal prefix of `name`, if
   * there is one, and return what it resolves to (`target`), the declared `name`, the `rest` of
   * the written name, and the written prefix that result names keep
   * (`mylib/lib/*` keeps `mylib/`; `mylib:lib/*` keeps nothing). A glob is
   * never part of the prefix.
   */
  getPrefixTargetIfExists(
    name: Name,
    stack?: IDependencyStack
  ): { target: Computable<SourceRef[]>; rest: Name; name: string; retainedPrefix: string } | undefined;

  /**
   * Resolve the declared name `name`, building nothing.
   *
   * - A **target** resolves to a {@link TargetRef}: its rule is selected and
   *   its requirements are read and resolved, so a dependency cycle or a
   *   version conflict is reported here. It is built when something holding
   *   the reference materializes it. A target that is a value (a flag) resolves
   *   to that value.
   * - A **property** resolves to the sources its value names, the targets
   *   among them resolved in the same way.
   * - A **repository** resolves to a {@link NamespaceRef} over it, and a
   *   plain FileSource a provider makes (`fetch`) to that source.
   *
   * `name` is a whole declared name, with no projection and no `<k=v>`. One
   * that nothing declares and no constraint supplies throws. The result is
   * memoised per configuration.
   */
  resolveTarget(name: string, stack?: IDependencyStack, callerOverrides?: Constraints): Computable<SourceRef[]>;

  /**
   * Build an anonymous target of `type` from `inputs`, for `owner`: how a rule
   * composes one build from others. The sub-target's rule is selected and run
   * as a declared target's is, under `owner`'s configuration with
   * `options.constraints` applied, and reads `inputs` as its properties.
   * `options.label` names the step in progress reports and failures; without
   * one the work is reported as `owner`'s own.
   */
  buildSubTarget(
    owner: TargetContext,
    type: string,
    inputs: SubTargetInputs,
    options?: { label?: string; constraints?: Constraints }
  ): Computable<SourceRef[]>;

  /**
   * Apply every projection still pending on materialized sources: each
   * {@link FileSetRef} becomes the files it selects from its base, descending
   * into an archive where a projection crosses one, and anything else is
   * returned as it is. A literal projection that selects nothing rejects.
   */
  applyProjections(sources: ReadonlyArray<Materialized>): Computable<Array<FileSource | FileSet>>;

  /**
   * Apply `projection` to `sources`, the sources one name reached: a reference
   * or a package is narrowed, a node gets the projection pending over it, and
   * a container is projected now, descending into archives. `miss` is the
   * error for a literal that selects nothing, judged over all the containers
   * together and only where no reference might still supply the name.
   */
  projectSources(
    sources: Array<SourceRef | Unbuilt>,
    projection: IProjection,
    miss: Miss | undefined
  ): Array<SourceRef | Unbuilt> | Computable<Array<SourceRef | Unbuilt>>;

  /**
   * Get the entry the build cache holds under `manifest`, making it with
   * `create` if it is not there. `create` is handed the run's process funnel
   * (`ActionContext.processLimit`) for any work it admits.
   */
  getCachedOrBuild(
    manifest: string,
    create: (ctx: ActionContext) => Computable<BuildResult>,
    options?: ICreateOptions
  ): Computable<FileSet>;
}
