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
import { IPrefixMatch, IPropertyEntry, Namespace } from "./Namespace";
import { BuildContext } from "../context/index";
import { Constraints } from "./Constraints";
import { ExecutionContext } from "./ExecutionContext";
import { Name } from "../core/Name";
import { TargetRules, RepositoryImplementation, RuleDefinition, SelectableRule } from "../rules/Types";
import { Computable } from "../core/Computable";
import type { PluginPackage } from "./Plugin";

/**
 * The model of a project: the declarations its build files and its plugins'
 * make, read-only. It keeps the configurations made of it ({@link getConfig}).
 */
export interface BuildModel {
  /** Get the rules a target of `type` is selected from, by type: `type`'s
   * own, then those of each type it extends, nearest first. */
  getTargetRules(type: string): TargetRules[];

  /** Get the default (all-types) rules, consulted where no rule of the target's
   * own type applies. */
  getDefaultRules(): SelectableRule[];

  /** Get `rule` with its implementation: a declared rule's is loaded the first time. */
  getRuleDefinition(rule: SelectableRule): Computable<RuleDefinition>;

  /** @return true if `type` is a repository type, otherwise false. */
  hasRepositoryType(type: string): boolean;

  /** Get the implementation of the repository type `type`, if it is one: a declared type's is loaded the first time. */
  getRepositoryImplementation(type: string): Computable<RepositoryImplementation> | undefined;

  /** @return every declared targetdef, in declaration order (`fabr
   *  list-targetdefs`). */
  getTargetDefs(): ITargetDefDecl[];

  /** @return every buildable target declared in the project, with its
   *  fully-qualified name (`fabr list-targets`): repository declarations
   *  (`npm_repository @npm`, `catalog @dep`) are left out. */
  getTargets(): { name: string; decl: ITargetDecl }[];

  /** @return every declared target, repository declarations included, in
   *  declaration order (`fabr list-all`). */
  getDeclaredTargets(): { name: string; decl: ITargetDecl }[];

  /** @return every property declared in the project, a `default` included
   *  unless an ordinary declaration overrides it (`fabr list-targetdefs
   *  --json`). */
  getProperties(): { name: string; decl: IPropertyDecl }[];

  /** @return the operations (`build`, `test`, `run`, …) a rule of `type`, or
   *  of a type it extends, is guarded on; `"*"` for a rule guarded on none.
   *  The default (all-types) rules are left out. Sorted. */
  getOperations(type: string): string[];

  /** @return the configuration of the model under `constraints` (possibly
   *  empty), evaluating within `execution`: the same one for every equal
   *  constraint set and execution. */
  getConfig(constraints: Constraints, execution: ExecutionContext): BuildContext;

  /** Get the public declaration of exactly `name`, or undefined. */
  getDecl(name: string): IPropertyEntry | ITargetDecl | undefined;

  /** @return the namespace of the names the file `file` names declares
   *  privately, or undefined where it declares none. */
  getPrivateScope(file: string): Namespace | undefined;

  /** @return the names of the files that declare `name` privately, in name order. */
  getPrivateFiles(name: string): string[];

  /** @return the target `name` declares, or undefined if it names something
   *  else (a property, a namespace) or nothing. */
  getTargetDecl(name: string): ITargetDecl | undefined;

  /** Get the targetdef named `name`, or undefined. */
  getTargetDef(name: string): ITargetDefDecl | undefined;

  /** Look up the declaration a prefix of `name` names, as written in the file
   *  `file` names: the longest prefix declared, that file's private
   *  declaration of it before a public one. */
  getPrefixMatch(name: Name, file?: string): IPrefixMatch | undefined;

  /**
   * Look up the declared target a written reference names, by the prefix of
   * it that is declared, as resolution reads it: `pkg:bin/x.js` and
   * `pkg<BUILD_TYPE=release>` both name `pkg`. Undefined where it names no
   * declared target (an external requirement, a bare path, an unknown name).
   * The CLI's `-f` uses it.
   */
  getReferencedTarget(name: string): ITargetDecl | undefined;

  /** @return every plugin the project uses, in the order they were added. */
  getPlugins(): PluginPackage[];
}
