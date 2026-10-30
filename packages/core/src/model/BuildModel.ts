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

import { IPropertyDecl, ITargetDecl, ITargetDefDecl } from "./AST";
import { IPrefixMatch, IPropertyEntry } from "./Namespace";
import { BuildContext } from "../context/index";
import { Constraints } from "./Constraints";
import { ExecutionContext } from "./ExecutionContext";
import { Name } from "../core/Name";
import { RepositoryProvider, RuleDefinition, SelectableRule } from "../rules/Types";
import { Computable } from "../core/Computable";

/**
 * The model of a project: the declarations its build files and its plugins'
 * make, read-only. It keeps the configurations made of it ({@link getConfig}).
 */
export interface BuildModel {
  /** Get the rules registered for `type` — the candidates selection tries first. */
  getTargetRules(type: string): SelectableRule[];

  /** Get the default (all-types) rules, consulted where no rule of the target's
   * own type applies. */
  getDefaultRules(): SelectableRule[];

  /** Get `rule` with its implementation: a declared rule's is loaded the first time. */
  getRuleDefinition(rule: SelectableRule): Computable<RuleDefinition>;

  getRepositoryProvider(type: string): RepositoryProvider | undefined;

  /** @return every declared targetdef (the build vocabulary), in declaration
   * order — for diagnostic listing (`fabr list-targetdefs`). */
  getTargetDefs(): ITargetDefDecl[];

  /** @return every buildable target declared in the project, with its
   * fully-qualified name — for diagnostic listing (`fabr list-targets`).
   * Repository instances (`npm_repository @npm`, `catalog @dep`) share the
   * target-decl shape but are not buildable targets, so they are excluded (a
   * type is a repository iff it has a registered provider). */
  getTargets(): { name: string; decl: ITargetDecl }[];

  /** @return every declared target — repository instances (`npm_repository
   * @npm`, `catalog @dep`) included — in declaration order. For the docs listing
   * (`fabr list-all`), which documents repositories alongside ordinary lib
   * targets; {@link getTargets} excludes them as not buildable. */
  getDeclaredTargets(): { name: string; decl: ITargetDecl }[];

  /** @return every property declared in the project (effective set — a `default`
   * counts unless overridden), for documenting the configuration surface
   * (`fabr list-targetdefs --json` emits the documented ones). */
  getProperties(): { name: string; decl: IPropertyDecl }[];

  /** @return the BUILD_OPERATION values for which a type-specific rule is
   * registered for `type` — the operations that type supports (`build`,
   * `test`, `run`, …). A rule that constrains no operation is a wildcard,
   * reported as `"*"` (it applies to any operation). Default (all-types)
   * rules are excluded: they apply everywhere and so say nothing about a
   * particular type. */
  getOperations(type: string): string[];

  /**
   * @return the build configuration under the given (possibly empty set of)
   * constraints, evaluating within the given execution context. The model
   * itself is purely the declarations as written; everything runtime (the
   * build cache, progress observers) rides in the ExecutionContext.
   */
  getConfig(constraints: Constraints, execution: ExecutionContext): BuildContext;

  getDecl(name: string): IPropertyEntry | ITargetDecl | undefined;

  /** @return the target this name declares, or undefined if it names something
   * else (a property, a namespace) or nothing at all — for a caller that needs
   * a target's *type* (and so what can be done with it) before asking for it. */
  getTargetDecl(name: string): ITargetDecl | undefined;

  getTargetDef(name: string): ITargetDefDecl | undefined;

  getPrefixMatch(name: Name): IPrefixMatch | undefined;

  /**
   * Look up the declared target a written reference builds — its literal
   * prefix, read exactly as resolution reads it, so `pkg:bin/x.js` and
   * `pkg<BUILD_TYPE=release>` both name `pkg`. Undefined when the reference names no declared target at
   * all (an external requirement, a bare path, an unknown name).
   *
   * This is for a caller holding a name it was *given* and needing to say
   * something about the target behind it before building — the CLI's `-f`,
   * which marks what the command line named.
   */
  getReferencedTarget(name: string): ITargetDecl | undefined;
}
