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

import { Computable } from "../core/Computable";
import { FileSet, FileSource } from "../core/FileSet";
import { Repository } from "../core/Repository";
import { Constraints, RepositoryContext, TargetContext } from "../model/BuildContext";

export enum PropertyType {
  String,
  FileSet,
  StringList,
  FileSetList,
  OutputFileSet,
}

/**
 * The resolved inputs a build action's step sees: a manifestable bag.
 * Everything a step consumes arrives here — FileSets fully materialized
 * (inert references never cross this boundary), strings as values — so the
 * cache key (step id + version + canonical manifest of this bag) is sound by
 * construction. A rule that needs one action's output as another's input
 * builds the first as a sub-target (`ResolveContext.subTarget`) and passes
 * its resolved FileSet here; there is no action nesting.
 */
export type BuildActionInput = string | string[] | FileSet | FileSet[];
export type BuildActionInputs = Record<string, BuildActionInput>;

/**
 * The build step of a build action: a pure function from resolved inputs
 * to output content, run in a framework-provided work directory. This is the
 * only unit of build caching; `id` + `version` identify the step in every
 * cache key, so a behavior change is a version bump rather than a manual
 * cache flush.
 */
export interface IBuildActionDefinition {
  id: string;
  version: number;
  run(inputs: BuildActionInputs, workDir: string): Computable<FileSet>;
}

/**
 * A build action: a build step plus its concrete (already-resolved)
 * inputs — the cacheable leaf a rule yields, or that a sub-target's rule
 * yields to produce that target's output. Actions do not compose directly:
 * composition is via sub-targets (see ResolveContext.subTarget), so an
 * action's inputs are always plain data.
 */
export class BuildAction {
  constructor(
    public readonly step: IBuildActionDefinition,
    public readonly inputs: BuildActionInputs,
    public readonly label?: string
  ) {}

  /** @return a copy carrying the given display label */
  public withLabel(label: string): BuildAction {
    return new BuildAction(this.step, this.inputs, label);
  }
}

/**
 * What a rule's evaluate yields: either final content directly (a
 * FileSource — flags, an in-memory result, or a sub-target's output reshaped
 * by resolution), or a BuildAction the framework keys/caches/executes to
 * produce the target's content.
 */
export type RuleResult = FileSource | BuildAction;

/**
 * A rule: the knowledge of how to build targets of a type. A single evaluate
 * function — always run, per evaluation, as the in-memory Computable graph
 * (property/global lookups, materialization, layout, generated-file
 * computation, and composing sub-targets via `context.subTarget`) — that
 * yields a RuleResult. Evaluation is given no work directory and never executes
 * tools; all execution happens inside the build steps of the BuildActions
 * it (and the sub-targets it builds) yield. A rule cannot tell whether it is
 * building a declared or an anonymous target: it reads its properties through
 * the same `context` accessors either way (for an anonymous target they are
 * served from the caller-supplied inputs).
 */
export interface IRuleDefinition {
  constraints: Constraints;
  evaluate: (context: TargetContext) => Computable<RuleResult>;
}

/**
 * Repositories are not rule-built targets: a provider lazily constructs the
 * Repository instance for a declaration, per BuildContext (its configuration
 * resolves under that context's constraints).
 */
export type RepositoryProvider = (context: RepositoryContext) => Computable<Repository>;

/**
 * A rule contributed to a build (by core or a plugin): the knowledge of how to
 * build targets of a `type` under some constraints. Omit `type` for a *default*
 * rule — the type-dimension wildcard, selected for any target type that has no
 * more specific rule of its own. The BuildModel indexes these into its rule
 * tables; a future language surface for defining rules would contribute the same
 * shape.
 */
export interface RuleRegistration {
  /** Target type this rule builds; omitted → a default (all-types) rule. */
  type?: string;
  constraints: Constraints;
  evaluate: IRuleDefinition["evaluate"];
}

/** A repository type contributed to a build. */
export interface RepositoryRegistration {
  type: string;
  provider: RepositoryProvider;
}

/**
 * What core and each plugin contribute to a build: rules, repository types, and
 * `.fabr` library files. A plugin's `activate()` *returns* this — it performs no
 * global registration (see PLUGINS.md), so the build's rule tables are a pure
 * function of the active contribution set and are rebuilt per load. `includes`
 * are absolute paths to the plugin's own `.fabr` files, which a `plugin <name>;`
 * declaration auto-parses and merges into the model (no explicit `include`
 * needed); core's contribution auto-includes STD.fabr, so it is always present.
 * `rules` and `repositories` are tracked by the {@link BuildModel}.
 */
export interface PluginContribution {
  rules?: RuleRegistration[];
  repositories?: RepositoryRegistration[];
  includes?: string[];
}
