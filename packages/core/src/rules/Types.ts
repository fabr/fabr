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
import type { BuildAction } from "../core/BuildAction";
import { FileSource } from "../core/FileSet";
import { Name } from "../core/Name";
import { Repository } from "../core/Repository";
import { CommandValue, PropertyMap, TargetContext } from "../model/BuildContext";

export enum PropertyType {
  String,
  FileSet,
  StringList,
  FileSetList,
  OutputFileSet,
  Rewrite,
}

/**
 * A sub-target's inputs ({@link TargetContext.subTarget}). Distinct from a
 * {@link BuildAction}'s input bags because a sub-target is a **fully-fledged
 * target**, not an action: its rule's *evaluate* re-runs every build (it is not itself a
 * persistent-cache unit), reading these inputs through the anonymous
 * `TargetContext` exactly as a declared target reads its properties. So the bag
 * may carry the same un-reduced **model sources** a property holds — notably a
 * `Flag` (a `FileSource`) read back via `getFlags` — not only the plain,
 * manifestable data an action's bag is limited to. These inputs never form a
 * cache key directly; they reach one only through the action(s) evaluate yields
 * (e.g. js_compile reads its `mode` flags here and folds the resolved overlay
 * into the tsconfig *inside* the exec action's `files`). The manifestability
 * constraint is the action role's alone; a sub-target must instead satisfy the
 * ordinary target contract — its inputs make sense as properties on their own.
 */
export type SubTargetInput = string | string[] | Name | Name[] | FileSource | FileSource[] | PropertyMap | CommandValue;
export type SubTargetInputs = Record<string, SubTargetInput>;

/**
 * What a rule's evaluate yields: final content directly (a FileSource — flags,
 * an in-memory result, or a sub-target's output reshaped by resolution), a
 * BuildAction the framework keys/caches/executes to produce the target's
 * content, or a *list* of FileSources — a target whose result is a set of
 * things (a `sync`'s per-member publish carriers). Name resolution is
 * list-shaped everywhere (a target's output flows as `SourceRef[]`), so a
 * scalar result is just the one-element case; a list yields its elements as
 * the target's sources directly, each provenance-stamped. Only declared
 * targets may be plural: an anonymous sub-target's output composes 1:1 into
 * its owner's evaluation.
 */
export type RuleResult = FileSource | FileSource[] | BuildAction;

/**
 * Repositories are not rule-built targets: a provider lazily constructs the
 * instance for a declaration, per BuildContext (its configuration resolves
 * under that context's constraints). What it constructs is the declaration's
 * value as a source: a {@link Repository} (vending references the resolution
 * layer batches), or a plain {@link FileSource} for a declared namespace with
 * nothing to resolve (a `fetch` table).
 */
export type RepositoryProvider = (context: TargetContext) => Computable<Repository | FileSource>;

/**
 * A rule: the knowledge of how to build targets of a `type` where its guards
 * admit, contributed to a build by core or a plugin. Omit `type` for a *default*
 * rule — the type-dimension wildcard, selected for any target type that has no
 * more specific rule of its own. The BuildModel indexes these into its rule
 * tables.
 *
 * A rule is selected as a guarded declaration is: every pattern must match the
 * value of the property it names (a glob, as in `srcs<TARGET=*-linux-*>`), and
 * the configuration is read as properties, so a `default` or a declared global
 * counts the same as a `-D`. Two things differ from a property's guard: a key
 * with no value here — nothing declares it, or no declaration of it applies —
 * makes the rule inapplicable rather than being an error; and among the rules
 * that apply, the one naming the most keys (over both records) is selected, two
 * equally specific ones being an error.
 */
export interface RuleDefinition {
  /** Target type this rule builds; omitted → a default (all-types) rule. */
  type?: string;
  /** The guard over the build configuration: property name → pattern
   * (`{ [BUILD_OPERATION]: "test" }`). A plain record — a developer-authored
   * match pattern, not a user-keyed build config. */
  properties: Record<string, string>;
  /** The guard over the TARGET's own STRING properties: property name →
   * pattern. A property the target does not set makes the rule inapplicable.
   * For a rule with a `type`, each key must be a STRING property of that
   * type's targetdef. */
  targetProperties?: Record<string, string>;
  /**
   * The rule body — always run, per evaluation, as the in-memory Computable
   * graph (property/global lookups, materialization, layout, generated-file
   * computation, and composing sub-targets via `context.subTarget`). It is given
   * no work directory and never executes tools; all execution happens inside
   * the build steps of the BuildActions it (and the sub-targets it builds)
   * yield. It cannot tell whether it is building a declared or an anonymous
   * target: it reads its properties through the same `context` accessors either
   * way (for an anonymous target they are served from the caller-supplied
   * inputs).
   */
  evaluate: (context: TargetContext) => Computable<RuleResult>;
}

/** A repository type contributed to a build. */
export interface RepositoryRegistration {
  type: string;
  provider: RepositoryProvider;
  /**
   * A declaration of this type declares the NAMESPACE of its name, with the
   * repository as its fallback: a name under it that nothing declares resolves
   * through the repository. It merges with the namespace other declarations
   * imply (`fabr_home @fabr-build` beside `js_package @fabr-build/core`), where
   * an ordinary target of the namespace's name would conflict.
   */
  declaresNamespace?: boolean;
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
  rules?: RuleDefinition[];
  repositories?: RepositoryRegistration[];
  includes?: string[];
}
