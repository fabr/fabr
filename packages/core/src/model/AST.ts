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

import { Name } from "../core/Name";
import { StringReader } from "../support/StringReader";
import { FileSource } from "../core/FileSet";
import { ISourceSpan } from "../support/Log";

export enum DeclKind {
  Value,
  Property,
  Target,
  TargetDef,
  Include,
  Namespace,
  Plugin,
  MapSplice,
}

interface IBaseDecl {
  source: IBuildFile;
  offset: number;
  /** End offset (exclusive) of the declaration's name/value where recorded,
   * so diagnostics can underline the extent rather than a single caret */
  endOffset?: number;
}

export interface INamespaceDecl extends IBaseDecl {
  kind: DeclKind.Namespace;
  name: string;

  namespaces: INamespaceDecl[];
  targets: ITargetDecl[];
  properties: IPropertyDecl[];
  defaults: IPropertyDecl[];
}

export interface ITargetDecl extends IBaseDecl {
  kind: DeclKind.Target;
  type: string;
  typeOffset: number;
  name: string;
  properties: IPropertyDecl[];
}

export enum PropertyType {
  String,
  FileSet,
  StringList,
  FileSetList,
  OutputFileSet,
  Rewrite,
  Map,
}

export interface IPropertySchema {
  required?: boolean;
  type: PropertyType;
}

export interface ITargetDefDecl extends IBaseDecl {
  kind: DeclKind.TargetDef;
  name: string;
  properties: Record<string, IPropertySchema>;
}

export interface IValue extends IBaseDecl {
  kind: DeclKind.Value;
  value: Name;
  /** End offset (exclusive) of the written value, for span underlines */
  endOffset: number;
  /**
   * The items when this value is a `{ key = value; ... }` block — a block is a
   * *value kind* (so an entry can hold a list of blocks: an array of maps).
   * Present (even if empty) iff a block was written; `value` is then an empty
   * placeholder Name, never read. Each item is an ordinary property decl — its
   * `name` the (possibly dotted, foreign) map key, its own values either
   * strings or nested blocks — or a `NAME;` splice ({@link IMapSpliceDecl}).
   * Parsing is schema-blind (a `{` in value position always parses as a
   * block); Validate enforces where blocks may appear (MAP properties only, no
   * mixing with strings in one value list).
   */
  entries?: IMapItemDecl[];
}

export interface IPropertyDecl extends IBaseDecl {
  kind: DeclKind.Property;
  name: string;
  /**
   * The property key parsed as a reference, when it was written as one rather than
   * a bare identifier (a `sync` member coordinate, `@npm:pkg:ver = srcs`). `name`
   * is then its canonical string. Absent for ordinary schema properties. Such
   * properties are enumerated by their rule (not looked up by name) and bypass the
   * targetdef schema check.
   */
  keyRef?: Name;
  values: IValue[];
}

/**
 * A bare `NAME;` statement inside a `{ ... }` block: splices the named
 * block-valued property's entries at that position (the in-block analogue of
 * the top-level `metadata = SHARED;` bare-reference chase). Entries and
 * splices apply in written order, later values winning — so an entry after a
 * splice overrides a same-named key the splice brought in.
 */
export interface IMapSpliceDecl extends IBaseDecl {
  kind: DeclKind.MapSplice;
  ref: Name;
  /** End offset (exclusive) of the written reference, for span underlines */
  endOffset: number;
}

/** One item of a `{ ... }` block: a `key = value;` entry or a `NAME;` splice. */
export type IMapItemDecl = IPropertyDecl | IMapSpliceDecl;

/** @return true if any of the property's values is a `{ ... }` block. */
export function hasBlockValue(prop: IPropertyDecl): boolean {
  return prop.values.some(value => value.entries !== undefined);
}

export interface IIncludeDecl extends IBaseDecl {
  kind: DeclKind.Include;
  filename: string;
}

/**
 * `plugin <name>;` — requests that the named target (typically a js_package)
 * be built and loaded into the host as a rule plugin before the requested
 * targets are resolved. The name must resolve to a target that yields a
 * package with an `activate(api)` entry point.
 */
export interface IPluginDecl extends IBaseDecl {
  kind: DeclKind.Plugin;
  name: string;
}

export interface IBuildFile {
  fs: FileSource;
  file: string;
  reader: StringReader;
}

export interface IBuildFileContents {
  namespaces: INamespaceDecl[];
  targets: ITargetDecl[];
  targetdefs: ITargetDefDecl[];
  properties: IPropertyDecl[];
  defaults: IPropertyDecl[];
  includes: IIncludeDecl[];
  plugins: IPluginDecl[];
}

export type IDecl = ITargetDecl | IPropertyDecl | INamespaceDecl | IIncludeDecl | IPluginDecl | IValue;

export type INamedDecl = ITargetDecl | IPropertyDecl | INamespaceDecl | ITargetDefDecl;

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
    case DeclKind.TargetDef:
      return "targetdef";
    case DeclKind.Value:
      return "value";
    case DeclKind.Plugin:
      return "plugin";
    case DeclKind.MapSplice:
      return "splice";
  }
}

/** The source span of a declaration: its position, plus the extent of its
 * name/value where the parser recorded one (rendered as an underline). */
export function declPosn(decl: IBaseDecl): ISourceSpan {
  return { ...decl.source, offset: decl.offset, endOffset: decl.endOffset };
}
