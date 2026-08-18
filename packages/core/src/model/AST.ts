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
  defaults: IResolvableDecl[];
}

export interface ITargetDecl extends IBaseDecl {
  kind: DeclKind.Target;
  type: string;
  typeOffset: number;
  name: Name;
  properties: IPropertyDecl[];
  /** The doc-comment prose written above this target, marker-stripped, or
   * undefined if none. Runtime-only documentation metadata (read for docs of
   * config targets like the `flag` instances `ts/no_strict`). */
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
  /**
   * The value written after `default` in the targetdef, held as a property decl
   * of the same name so it resolves through the ordinary property machinery —
   * with the full value grammar (references, globs, `${...}`, MAP blocks) and
   * relative paths rooted at the file declaring the targetdef, not the file
   * using it. Supplies the property wherever the target — or a sub-target of
   * this type — writes none of its own; mutually exclusive with `required`.
   */
  default?: IPropertyDecl;
  /** The doc-comment prose written above this property in the targetdef, marker-
   * stripped, or undefined if none. Runtime-only documentation metadata. */
  docComment?: string;
}

export interface ITargetDefDecl extends IBaseDecl {
  kind: DeclKind.TargetDef;
  name: string;
  /** The declared property schema, keyed by property name (plus `*` for the
   * wildcard) */
  properties: Map<string, IPropertySchema>;
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
 * its args, and the destinations of its streams. `command`/`args`/`stdin` are fabr
 * references (the command a runnable, args literal-or-glob, `< stdin` a single-file
 * source); `stdout`/`stderr` are the output names their captured streams (`>`/`2>`)
 * become content under. Each is an {@link INameValue} — the `Name` plus its source
 * span — so the rule can position a resolution error (an unresolvable command, a
 * failed glob) at the exact token in the `run = …` line.
 *
 * This is the *flattened* result of applying the stage's redirects left to right
 * (see the parser's `StageFds`).
 */
export interface ICommandStage {
  command: INameValue;
  args: INameValue[];
  stdin?: INameValue;
  stdout?: INameValue;
  stderr?: INameValue;
  mergedTo?: StreamName;
}

/** One of the two output streams a stage has, as a destination — fabr's process
 * model has no other fds, which is what bounds `N>&M` to these two. */
export type StreamName = "out" | "err";

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
  name: Name;
  values: IValue[];
  /** The doc-comment prose written above this property, marker-stripped, or
   * undefined if none. Runtime-only documentation metadata (read for docs of
   * global config properties like `BUILD_TYPE`, `JS_TARGET`). */
  docComment?: string;
}

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
  /**
   * The included path, relative to the including file, either an simple filename
   * or a glob expression (No variables or constraints)
   */
  name: Name;
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

/**
 * A value decl for a reference that no parser produced — one given by the
 * invoker (a name on fabr's own command line), so that it resolves as the
 * written reference it is rather than through a path of its own.
 *
 * `source` is the virtual file it counts as written in, and carries the two
 * things a real one would: bare paths within the reference root at the file's
 * directory (see `Name.relativeTo`), so the caller names it for where those
 * paths should resolve from; and diagnostics name it and excerpt its reader at
 * `offset`, so the caller may give the whole text the reference was read from
 * (a command line) and span the part that is this value.
 */
export function syntheticValue(value: Name, source: IBuildFile, offset: number, endOffset: number): INameValue {
  return { kind: DeclKind.NameValue, value, source, offset, endOffset };
}

export interface IBuildFileContents {
  namespaces: INamespaceDecl[];
  targets: ITargetDecl[];
  targetdefs: ITargetDefDecl[];
  properties: IPropertyDecl[];
  defaults: IResolvableDecl[];
  includes: IIncludeDecl[];
  plugins: IPluginDecl[];
}

export type IDecl = ITargetDecl | IPropertyDecl | INamespaceDecl | IIncludeDecl | IPluginDecl | IValue;

/**
 * A declaration that a reference **resolves to** — hence one a configuration can
 * vary. Both consequences follow from that and from nothing else: it may be
 * written `default` (used only where no ordinary declaration of the name
 * applies), and its `name` is a {@link Name} whose constraint facet guards it.
 *
 * The complement ({@link IPlainNamedDecl}) is structure and vocabulary, which
 * neither varies nor is referred to by value.
 */
export type IResolvableDecl = IPropertyDecl | ITargetDecl;

/** A declaration named by a plain identifier path: it introduces a scope or a
 * type rather than something built, so there is no configuration for a name of
 * its to vary with. (The two are otherwise unrelated — a namespace shares the
 * value index with targets and properties, while a targetdef has an index of its
 * own; what unites them here is only the shape of the name.) */
export type IPlainNamedDecl = INamespaceDecl | ITargetDefDecl;

export type INamedDecl = IResolvableDecl | IPlainNamedDecl;

/** A declaration's name as a plain string, whichever kind it is — for the
 * namespace machinery, which indexes all four alike. A resolvable decl's facets
 * are left off ({@link Name.toBaseString}): they qualify the declaration, not
 * the name it goes under. */
export function declName(decl: INamedDecl): string {
  return typeof decl.name === "string" ? decl.name : decl.name.toBaseString();
}

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
