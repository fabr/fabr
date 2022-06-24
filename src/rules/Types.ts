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
import { Target } from "../model/Target";

export enum PropertyType {
  String,
  StringList,
  FileSet,
}

export interface IPropertySchema {
  required?: boolean;
  type: PropertyType;
}

export type ITargetSchema = Record<string, IPropertySchema>;

interface PropertyTypeMap {
  [PropertyType.String]: string;
  [PropertyType.StringList]: string[];
  [PropertyType.FileSet]: FileSet;
}
type MappedType<T extends IPropertySchema> = T["required"] extends true
  ? PropertyTypeMap[T["type"]]
  : PropertyTypeMap[T["type"]] | undefined;

export type ResolvedType<S extends ITargetSchema> = { [P in keyof S]: MappedType<S[P]> };

export interface ITargetTypeDefinition<S extends ITargetSchema> {
  schema: S;

  /**
   * Evaluation function. Note that the type of entity will be
   *   ResolvedType<S>
   * but Typescript currently doesn't seem to be able to track this through the interface.
   * @param entity
   */
  evaluate(entity: ResolvedType<S>): Computable<Target>;
}
