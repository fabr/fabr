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
  NameValue,
  MapValue,
  CommandValue,
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
  /** The doc-comment prose written above this target, marker-stripped, or
   * undefined if none. Runtime-only documentation metadata (read for docs of
   * config targets like the `flag` instances `ts/nostrict`). */
  docComment?: string;
}

export enum PropertyType {
  String,
  FileSet,
  StringList,
  FileSetList,
  OutputFileSet,
  Rewrite,
  Map,
  Command,
}

export interface IPropertySchema {
  required?: boolean;
  type: PropertyType;
  /** The doc-comment prose written above this property in the targetdef, marker-
   * stripped, or undefined if none. Runtime-only documentation metadata. */
  docComment?: string;
}

export interface ITargetDefDecl extends IBaseDecl {
  kind: DeclKind.TargetDef;
  name: string;
  properties: Record<string, IPropertySchema>;
  /** The doc-comment prose written above this targetdef, marker-stripped, or
   * undefined if none. Runtime-only documentation metadata. */
  docComment?: string;
}

interface IBaseValue extends IBaseDecl {
  /** End offset (exclusive) of the written value, for span underlines */
  endOffset: number;
}

/** A plain value — a reference/name (`srcs`, `@npm:pkg:1.2.3`, `*.ts`). */
export interface INameValue extends IBaseValue {
  kind: DeclKind.NameValue;
  value: Name;
}

/**
 * A `{ key = value; ... }` map block value — a value kind (so an entry can hold a
 * list of blocks: an array of maps). Each item is an ordinary property decl (its
 * `name` the possibly-dotted foreign map key, values names or nested blocks) or a
 * `NAME;` splice ({@link IMapSpliceDecl}). Parsing is schema-blind (a `{` in value
 * position always parses as a block); Validate enforces where blocks may appear
 * (MAP properties only, no mixing with names in one value list).
 */
export interface IMapValue extends IBaseValue {
  kind: DeclKind.MapValue;
  entries: IMapItemDecl[];
}

export type IValue = INameValue | IMapValue | ICommandValue;

export function isMapValue(value: IValue): value is IMapValue {
  return value.kind === DeclKind.MapValue;
}

export function isNameValue(value: IValue): value is INameValue {
  return value.kind === DeclKind.NameValue;
}

export function isCommandValue(value: IValue): value is ICommandValue {
  return value.kind === DeclKind.CommandValue;
}

/**
 * One stage of a command pipeline ({@link ICommandValue}): a command reference,
 * its args, and any stream redirects. `command`/`args`/`stdin` are fabr references
 * (the command a runnable, args literal-or-glob, `< stdin` a single-file source);
 * `stdout`/`stderr`/`both` are the output names their captured streams (`>`/`2>`/
 * `&>`) become content under. Each is an {@link INameValue} — the `Name` plus its
 * source span — so the rule can position a resolution error (an unresolvable
 * command, a failed glob) at the exact token in the `run = …` line.
 */
export interface ICommandStage {
  command: INameValue;
  args: INameValue[];
  stdin?: INameValue;
  stdout?: INameValue;
  stderr?: INameValue;
  both?: INameValue;
}

/** A parsed command pipeline: an ordered list of {@link ICommandStage}s (the
 * stages of `a | b | c`), names still as written. */
export type CommandPipeline = ICommandStage[];

/**
 * A parsed command pipeline as a value — `run = a --x | b > out`. Built at parse
 * time, where the operators (`|`, `<`, `>`, `2>`, `&>`) drive the structure and
 * well-formedness is a parse error; the rule then resolves each stage's command to
 * a runnable and wires the streams. A command is always the sole value of its
 * property (there is no syntax to mix it with other values).
 */
export interface ICommandValue extends IBaseValue {
  kind: DeclKind.CommandValue;
  pipeline: CommandPipeline;
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
  /** The doc-comment prose written above this property, marker-stripped, or
   * undefined if none. Runtime-only documentation metadata (read for docs of
   * global config properties like `BUILD_TYPE`, `JS_TARGET`). */
  docComment?: string;
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

/** @return true if any of the property's values is a `{ ... }` map block. */
export function hasMapValue(prop: IPropertyDecl): boolean {
  return prop.values.some(isMapValue);
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
    case DeclKind.NameValue:
      return "name";
    case DeclKind.MapValue:
      return "map";
    case DeclKind.CommandValue:
      return "command";
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
