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

import { Name } from "./Name";
import { StringReader } from "../support/StringReader";
import { FileSet } from "../core/FileSet";
import { ISourcePosition } from "../support/Log";

export enum DeclKind {
  Value,
  Property,
  Target,
  Include,
  Namespace,
}

interface IBaseDecl {
  source: IBuildFile;
  offset: number;
}

export interface INamespaceDecl extends IBaseDecl {
  kind: DeclKind.Namespace;
  name: string;

  namespaces: INamespaceDecl[];
  targets: ITargetDecl[];
  properties: IPropertyDecl[];
}

export interface ITargetDecl extends IBaseDecl {
  kind: DeclKind.Target;
  type: string;
  typeOffset: number;
  name: string;
  properties: IPropertyDecl[];
}

export interface IValue extends IBaseDecl {
  kind: DeclKind.Value;
  value: Name;
}

export interface IPropertyDecl extends IBaseDecl {
  kind: DeclKind.Property;
  name: string;
  values: IValue[];
}

export interface IIncludeDecl extends IBaseDecl {
  kind: DeclKind.Include;
  filename: string;
}

export interface IBuildFile {
  fs: FileSet;
  filename: string;
  reader: StringReader;
}

export interface IBuildFileContents {
  namespaces: INamespaceDecl[];
  targets: ITargetDecl[];
  properties: IPropertyDecl[];
  includes: IIncludeDecl[];
}

export type IDecl = ITargetDecl | IPropertyDecl | INamespaceDecl | IIncludeDecl | IValue;

export type INamedDecl = ITargetDecl | IPropertyDecl | INamespaceDecl;

export type IScope = INamespaceDecl | IBuildFileContents;

export function getDeclKindName(kind: DeclKind): string {
  switch (kind) {
    case DeclKind.Include:
      return "include";
    case DeclKind.Namespace:
      return "namespace";
    case DeclKind.Property:
      return "property";
    case DeclKind.Target:
      return "target";
    case DeclKind.Value:
      return "value";
  }
}

export function declPosn(decl: IBaseDecl): ISourcePosition {
  return { ...decl.source, offset: decl.offset };
}
