/*
 * Copyright (c) 2022 Nathan Keynes <nkeynes@deadcoderemoval.net>
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

import type { Credential } from "../core/Credential";
import { Computable } from "../core/Computable";
import type { BuildAction } from "../core/BuildAction";
import { FileSource } from "../core/FileSet";
import { Name } from "../core/Name";
import { Repository } from "../core/Repository";
import type { Namespace } from "../core/NamespaceRef";
import type { IPropertyDecl, IRuleBlock, IRuleDecl, ITargetDecl } from "../model/AST";
import type { IPropertyEntry } from "../model/Namespace";
import {
  CommandValue,
  MaterializedRequirements,
  NoRequirements,
  ResolutionSpec,
  PropertyMap,
  RequiredSources,
  ResolvedRequirements,
  TargetContext,
  Unmaterialized,
} from "../context/index";

export enum PropertyType {
  String,
  FileSet,
  StringList,
  FileSetList,
  OutputFileSet,
  Rewrite,
}

/**
 * One input of a sub-target ({@link TargetContext.subTarget}), a value of one
 * of its type's properties, read by its rule through the same accessors a
 * declared target's properties are. It may be any source a property holds,
 * a `Flag` included (read back with `getFlags`). The inputs are not themselves
 * cache-key material: only the actions the sub-target's rule yields are keyed.
 */
export type SubTargetInput = string | string[] | Name | Name[] | FileSource | FileSource[] | PropertyMap | CommandValue;
/** A sub-target's inputs, by property name. */
export type SubTargetInputs = Record<string, SubTargetInput>;

/**
 * The result of a rule's `evaluate`, one of:
 * - a FileSource: the target's content as it stands (a flag, files made in
 *   memory, a sub-target's output reshaped);
 * - a BuildAction: a build step the framework looks up in the cache, or runs,
 *   its output (reshaped where the action has a `reshape`) being the content;
 * - a list of FileSources: each one of the target's sources (a `sync`'s
 *   carrier per member).
 *
 * Each FileSet among the content is stamped with the target's provenance. A
 * sub-target must yield exactly one FileSet: {@link TargetContext.subTarget}
 * rejects anything else.
 */
export type RuleResult = FileSource | FileSource[] | BuildAction;

/**
 * Make what a declaration of a repository type names, from the declaration's
 * `context` (its properties, read in its configuration). Called when the
 * declaration's name is first looked up in a configuration, or when a namespace
 * makes a member of the type. It returns:
 * - a {@link Repository}, which vends references to what it holds;
 * - a {@link Namespace}, whose members it makes on demand (an AWS account);
 * - or a plain {@link FileSource}, for a declaration with nothing to resolve
 *   (a `fetch` table).
 *
 * `url` and `credential` are given only to a repository a namespace makes
 * ({@link TargetContext.makeRepository}), each where the namespace has one; a
 * provider should prefer a `url` property the declaration writes over `url`,
 * and use `credential` ahead of any its ecosystem would find for itself.
 * `requirements` are what the type's {@link RepositoryImplementation.requirements}
 * state, resolved (empty where it states none).
 */
export type RepositoryProvider = (
  context: TargetContext,
  url: string | undefined,
  credential: Credential | undefined,
  requirements: ResolvedRequirements
) => Computable<Repository | Namespace | FileSource>;

/**
 * A rule: how to build targets of `type` where its guards match, with its
 * implementation. A rule without a `type` is a default rule, tried for a target
 * only where none of its own type's rules applies.
 *
 * A rule applies where every guard pattern matches the value of the property
 * it names (a glob, as in `srcs<TARGET=*-linux-*>`). The configuration is read
 * as properties, so a `default`, a declared global and a `-D` all count. A key
 * with no value (nothing declares it, or no declaration of it applies) makes
 * the rule inapplicable, where a property's guard would be an error. Among the
 * rules that apply, the one naming the most keys over both guard records is
 * selected; two naming equally many are an error.
 */
export interface RuleDefinition extends SelectableRule, RuleImplementation {}

/**
 * A rule written in `.fabr` (`rule <type> <param><guards> = <result> { … }`):
 * the target it matches is what its block's result reference names, the
 * block's targets and properties looked up before the file's, and
 * `<param>.<property>` reading the matched target's property.
 */
export interface RuleBlockDefinition extends SelectableRule {
  /** The declaration, whose implementation is the block. */
  readonly decl: IRuleDecl & { implementation: IRuleBlock };
  /** Look up what the block declares under `name`, if it declares it: a target, or a property's declarations. */
  local(name: string): ITargetDecl | IPropertyEntry | undefined;
  /** Look up the target the block declares under `name`, if it declares one. */
  localTarget(name: string): ITargetDecl | undefined;
  /** @return true if `target` is one the block declares, otherwise false. */
  declares(target: ITargetDecl): boolean;
  /** @return true if `prop` is one the block declares, otherwise false. */
  declaresProperty(prop: IPropertyDecl): boolean;
}

/**
 * A rule as selection reads it: the type it builds and its guards. A rule
 * declared in a `.fabr` file (`rule js_package pkg<BUILD_OPERATION=build> = …;`)
 * is selected from these alone, before its implementation is loaded.
 */
export interface SelectableRule {
  /** The target type this rule builds; omitted for a default (all-types) rule. */
  type?: string;
  /** The guard over the configuration: property name to pattern
   * (`{ [BUILD_OPERATION]: "test" }`). */
  properties: Record<string, string>;
  /** The guard over the target's own STRING properties (for a sub-target, its
   * inputs): property name to pattern. A property the target does not set
   * makes the rule inapplicable. For a rule with a `type`, each key must be a
   * STRING property of that type's targetdef. */
  targetProperties?: Record<string, string>;
}

/** The rules of one target type, which selection ranks against each other.
 * `type` names them in an ambiguity error. */
export interface TargetRules<R extends SelectableRule = SelectableRule> {
  type: string;
  rules: R[];
}

/**
 * How a rule builds a target. The module a `rule` declaration names
 * (`= <package>:<entry>`) default-exports one; its type and guards are the
 * declaration's. It is loaded when the rule is first selected.
 */
export interface RuleImplementation {
  /**
   * State what the target requires: the sources its FILES and PACKAGES
   * properties and globals name, read with `getFileProperty`,
   * `getPackageProperty` and the like and not materialized, under names of the
   * rule's choosing. Called when the target is resolved, which happens when a
   * reference to it is read, before anything is built. The framework resolves
   * each collection jointly and hands the result to {@link evaluate}. A STRING,
   * MAP or COMMAND property has nothing to resolve, and is read in `evaluate`;
   * so is a tool, which is resolved to be run.
   *
   * Six names mean something to the framework. `dependencies`, `provided`,
   * `optional_provided`, `runtime` and `compile` are what the target passes
   * on: requirements of whatever requires the target too. `provided` and
   * `optional_provided` are bound by that consumer (an optional one only to
   * what the consumer supplies or its installation holds); `runtime` goes to
   * the consumer's `run` collection alone, and `compile` to its `build` one
   * alone. `extends` is
   * the package the target is made from; where it is exactly one package,
   * the target passes on that package's version and requirements. Every
   * other name is private to the target's build. A name a rule qualifies
   * (`classes.extends`) is read as its last part is (here, as material), but
   * only a plain name is passed on.
   *
   * Returns a {@link ResolutionSpec}, or a Computable of one where it depends
   * on a value read first, with:
   * - `build`: the collection the target builds with (what it compiles
   *   against, what it passes on), resolved for the `build` operation;
   * - `run`: the collection it installs or runs, resolved for `run`;
   * - `permissive`: true where versions that conflict among the requirements do
   *   not refuse the target (a program's sealed install);
   * - `result`: what the target builds (a package of a name, format and
   *   version, or files), which whatever requires it sees before it is built,
   *   and which its build is checked against. Where it is not stated, what the
   *   target builds is known only once it is built;
   * - `fixes`: the advisory ids the target's build fixes in the package it is
   *   made from, which `fabr audit` reports as fixed.
   *
   * Optional: a rule without it requires nothing. What `evaluate` reads for
   * itself is not among the target's requirements: a cycle through it is
   * found only when the target is built, and `fabr deps` does not show it.
   */
  requirements?: (context: TargetContext) => ResolutionSpec | Computable<ResolutionSpec>;
  /**
   * Set where the target is a value with nothing to build (a flag): `evaluate`
   * runs where the target is resolved, and what it yields stands for the target
   * in the list that looked it up.
   */
  value?: true;
  /**
   * Build the target: yield its content, or the build action that makes it
   * ({@link RuleResult}). Called when the target is built, once per
   * configuration in a run, whether its actions are cached or not, and again
   * under watch when what it read changes; only the actions it yields are
   * cached. It reads properties and globals through
   * `context`, lays out files, and composes sub-targets (`context.subTarget`).
   * It has no work directory and runs no tools: everything it runs is in the
   * build steps of the actions it and its sub-targets yield. The same
   * accessors serve a declared target's properties and a sub-target's inputs.
   *
   * `requirements` are what {@link requirements} stated, resolved and without
   * content: call `materializeAll()`, `materialize(name)` for the ones needed,
   * or `packages(name)` for the packages among one. The first materialization
   * rejects where a collection is not permissive and ships a package at
   * conflicting versions. A rule written with {@link defineRule} states this as
   * `evaluateResolved`, or as `evaluateMaterialized` to be given every
   * requirement materialized.
   */
  evaluate: (context: TargetContext, requirements: Unmaterialized<Record<string, RequiredSources>>) => Computable<RuleResult>;
  /**
   * Describe the target as this rule would build it, for an editor or language
   * server, served over the Build Server Protocol. Given its requirements as
   * `evaluate` is, it yields the files of the description, or a build action
   * that makes them. Optional: a target whose rule has none is not described.
   */
  describe?: (context: TargetContext, requirements: Unmaterialized<Record<string, RequiredSources>>) => Computable<RuleResult>;
}

/** A collection's requirements as {@link defineRule} infers them: `any`, where
 * nothing could be inferred, is taken as no requirements. */
type Stated<T> = 0 extends 1 & T ? NoRequirements : T;

/** The evaluation a rule given to {@link defineRule} states, exactly one of the
 * two forms, given the requirements of both of its {@link ResolutionSpec}'s
 * collections. */
type RuleEvaluation<B, R> =
  | {
      /** Build the target from its requirements as {@link RuleImplementation.evaluate}
       * receives them: resolved, materialized when the rule asks. */
      evaluateResolved: (context: TargetContext, requirements: Unmaterialized<Stated<B> & Stated<R>>) => Computable<RuleResult>;
      evaluateMaterialized?: never;
    }
  | {
      /** Build the target from its requirements, every one materialized first. */
      evaluateMaterialized: (
        context: TargetContext,
        materialized: MaterializedRequirements<Stated<B>> & MaterializedRequirements<Stated<R>>
      ) => RuleResult | Computable<RuleResult>;
      evaluateResolved?: never;
    };

/**
 * Define a rule, its evaluation typed by the requirement names its
 * `requirements` returns. Given a type and guards, it makes a
 * {@link RuleDefinition}, for a contribution to list; given neither, a
 * {@link RuleImplementation}, the default export of a module a `rule`
 * declaration names. An `evaluateMaterialized` is called with every
 * requirement materialized first; an `evaluateResolved` is the plain
 * `evaluate`.
 */
export function defineRule<
  B extends Record<string, RequiredSources> = NoRequirements,
  R extends Record<string, RequiredSources> = NoRequirements,
>(
  rule: SelectableRule &
    Omit<RuleImplementation, "requirements" | "evaluate" | "describe"> & {
      requirements: (context: TargetContext) => ResolutionSpec<B, R> | Computable<ResolutionSpec<B, R>>;
      describe?: (context: TargetContext, requirements: Unmaterialized<Stated<B> & Stated<R>>) => Computable<RuleResult>;
    } & RuleEvaluation<B, R>
): RuleDefinition;
export function defineRule<
  B extends Record<string, RequiredSources> = NoRequirements,
  R extends Record<string, RequiredSources> = NoRequirements,
>(
  rule: Omit<RuleImplementation, "requirements" | "evaluate" | "describe"> & {
    requirements?: (context: TargetContext) => ResolutionSpec<B, R> | Computable<ResolutionSpec<B, R>>;
    describe?: (context: TargetContext, requirements: Unmaterialized<Stated<B> & Stated<R>>) => Computable<RuleResult>;
  } & RuleEvaluation<B, R>
): RuleImplementation;
export function defineRule<B extends Record<string, RequiredSources>, R extends Record<string, RequiredSources>>(
  rule: Partial<SelectableRule> &
    Omit<RuleImplementation, "requirements" | "evaluate" | "describe"> & {
      requirements?: (context: TargetContext) => ResolutionSpec<B, R> | Computable<ResolutionSpec<B, R>>;
      describe?: (context: TargetContext, requirements: Unmaterialized<Stated<B> & Stated<R>>) => Computable<RuleResult>;
    } & RuleEvaluation<B, R>
): RuleImplementation {
  const { evaluateResolved, evaluateMaterialized, describe, ...definition } = rule;
  const evaluate: (context: TargetContext, requirements: Unmaterialized<Stated<B> & Stated<R>>) => Computable<RuleResult> =
    evaluateMaterialized === undefined
      ? evaluateResolved
      : (context, requirements) =>
          requirements
            .materializeAll()
            .then(materialized =>
              evaluateMaterialized(context, materialized as MaterializedRequirements<Stated<B>> & MaterializedRequirements<Stated<R>>)
            );
  return {
    ...definition,
    evaluate: evaluate as RuleImplementation["evaluate"],
    ...(describe === undefined ? {} : { describe: describe as RuleImplementation["describe"] }),
  };
}

/**
 * The implementation of a repository type: the default export of the module a
 * `repository` declaration names.
 */
export interface RepositoryImplementation {
  /**
   * State what a declaration of the type requires, as a rule's `requirements`
   * does for a target: the property reads, not materialized. They are resolved,
   * one collection per side, and handed to {@link provider}. Optional: a type
   * without it requires nothing.
   */
  requirements?(context: TargetContext): ResolutionSpec;
  /** Make the repository a declaration names. */
  provider: RepositoryProvider;
}

/** A repository type contributed to a build. */
export interface RepositoryRegistration extends RepositoryImplementation {
  type: string;
}

/**
 * Rules, repository types and `.fabr` files given to a load in code, beside
 * those its `.fabr` files declare: core's contribution (STD.fabr, see
 * `coreContribution`), or what a test lists.
 */
export interface PluginContribution {
  rules?: RuleDefinition[];
  repositories?: RepositoryRegistration[];
  /** Absolute paths of `.fabr` files read with the project's, with no `include`. */
  includes?: string[];
}
