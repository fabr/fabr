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
  FileSet,
  StringList,
  FileSetList,
}

export interface IPropertySchema {
  required?: boolean;
  type: PropertyType;
}

export interface ITargetSchema {
  /**
   * Target-specific properties that are declared within the target body.
   */
  properties: Record<string, IPropertySchema>;
  /**
   * Global named properties that the target rules also depend on.
   */
  globals: Record<string, PropertyType.String | PropertyType.StringList>;
}

interface PropertyTypeMap {
  [PropertyType.String]: string;
  [PropertyType.FileSet]: FileSet;
  [PropertyType.StringList]: string[];
  [PropertyType.FileSetList]: FileSet[];
}
type MappedType<T extends IPropertySchema> = T["required"] extends true
  ? PropertyTypeMap[T["type"]]
  : PropertyTypeMap[T["type"]] | undefined;

type ResolvedTargetType<S extends ITargetSchema> = { [P in keyof S["properties"]]: MappedType<S["properties"][P]> };
type ResolvedGlobalType<S extends ITargetSchema> = { [P in keyof S["globals"]]: PropertyTypeMap[S["globals"][P]] };

export type ResolvedType<S extends ITargetSchema> = ResolvedTargetType<S> & ResolvedGlobalType<S>;

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
