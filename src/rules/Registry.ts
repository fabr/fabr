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
import { FileSet } from "../core/FileSet";
import { BuildContext } from "../model/BuildContext";

import { ITargetSchema, ITargetTypeDefinition, ResolvedType } from "./Types";

const TARGET_REGISTRY: Record<string, ITargetTypeDefinition<any>> = {};

export function getTargetRule(name: string): ITargetTypeDefinition<any> | undefined {
  return TARGET_REGISTRY[name];
}

export function hasTargetType(type: string): boolean {
  return type in TARGET_REGISTRY;
}

export function registerTargetRule<S extends ITargetSchema>(
  name: string,
  schema: S,
  evaluate: (spec: ResolvedType<S>, config: BuildContext) => Computable<FileSet>
): void {
  TARGET_REGISTRY[name] = { schema, evaluate } as ITargetTypeDefinition<any>;
}
