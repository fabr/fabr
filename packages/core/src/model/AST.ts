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

import { Name, NAME_LEVEL_SEPARATOR, NameConstraint } from "../core/Name";
import { StringReader } from "../support/StringReader";
import { FileSource } from "../core/FileSet";
import { ISourceSpan } from "../support/Log";
import { FabrError } from "../core/Errors";

export enum DeclKind {
  NameValue,
  MapValue,
  CommandValue,
  Property,
  Target,
  TargetDef,
  Include,
  Plugin,
  Splice,
  Rule,
  Repository,
}

interface IBaseDecl {
  source: IBuildFile;
  offset: number;
  /** The end offset (exclusive) of the declaration's name or value, where
   * recorded: the extent a diagnostic underlines. */
  endOffset?: number;
}

export interface ITargetDecl extends IBaseDecl {
  kind: DeclKind.Target;
  type: string;
  typeOffset: number;
  name: Name;
  /** Whether it is written `private`: seen only by references written in its
   *  file, where it takes precedence over a public declaration of its name. */
  private?: boolean;
  /** The body, in written order: its property declarations, and in a target of
   * a rule's block, splices of the rule's parameter (`pkg;`). For each property,
   * the last item that supplies it is what the target has. */
  properties: IMapItemDecl[];
  /** The doc comment written above this target, its markers stripped, or
   * undefined if none. */
  docComment?: string;
}

export enum PropertyType {
  String,
  FileSet,
  /** A list of packages (`PACKAGES`): read as packages, or for its files. */
  Packages,
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
   * of the same name and resolved as one, its relative paths rooted at the file
   * declaring the targetdef. It supplies the property wherever a target, or a
   * sub-target, of this type writes none of its own. Never set with `required`.
   */
  default?: IPropertyDecl;
  /** The doc comment written above this property in the targetdef, its markers
   * stripped, or undefined if none. */
  docComment?: string;
}

export interface ITargetDefDecl extends IBaseDecl {
  kind: DeclKind.TargetDef;
  name: string;
  /** The targetdef this one extends (`targetdef derived extends base { … }`),
   * with where its name is written; undefined if it extends none. A targetdef
   * has every property of the one it extends, and its rules after its own. */
  extends?: { name: string; offset: number };
  /** The declared property schema, by property name (`*` for the wildcard). */
  properties: Map<string, IPropertySchema>;
  /** The doc comment written above this targetdef, its markers stripped, or
   * undefined if none. */
  docComment?: string;
}

interface IBaseValue extends IBaseDecl {
  /** The end offset (exclusive) of the written value. */
  endOffset: number;
}

/** A plain value — a reference/name (`srcs`, `@npm:pkg:1.2.3`, `*.ts`). */
export interface INameValue extends IBaseValue {
  kind: DeclKind.NameValue;
  value: Name;
}

/**
 * A `{ key = value; ... }` map block value; a value list of several blocks is
 * an array of maps. Each item is a property decl (its `name` the map key,
 * possibly dotted; its values names or nested blocks) or a `NAME;` splice
 * ({@link ISpliceDecl}). The parser reads every `{` in value position as a
 * block; Validate checks where blocks may appear (MAP properties only, not
 * mixed with names in one value list).
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
 * One stage of a command pipeline ({@link ICommandValue}), its redirections
 * applied left to right. `command`, `args` and `stdin` are references: the
 * command a runnable, each arg a literal or glob, `< stdin` a single file.
 * `stdout` and `stderr` are the output names their captured streams (`>`,
 * `2>`) are kept under. `mergedTo` is the stream both streams go to where they
 * are merged (`2>&1`, `1>&2`, `&>`). Each is an {@link INameValue}, whose span
 * locates an error at its token.
 */
export interface ICommandStage {
  command: INameValue;
  args: INameValue[];
  stdin?: INameValue;
  stdout?: INameValue;
  stderr?: INameValue;
  mergedTo?: StreamName;
}

/** One of the two output streams of a stage, the only ones `N>&M` may name. */
export type StreamName = "out" | "err";

/** A parsed command pipeline: an ordered list of {@link ICommandStage}s (the
 * stages of `a | b | c`), names still as written. */
export type CommandPipeline = ICommandStage[];

/**
 * A command pipeline as a value (`run = a --x | b > out`), its stages made by
 * the parser from the operators (`|`, `<`, `>`, `2>`, `&>`), a malformed one
 * being a parse error. A command is always the sole value of its property.
 */
export interface ICommandValue extends IBaseValue {
  kind: DeclKind.CommandValue;
  pipeline: CommandPipeline;
}

export interface IPropertyDecl extends IBaseDecl {
  kind: DeclKind.Property;
  name: Name;
  values: IValue[];
  /** Whether it is written `private`: seen only by references written in its
   *  file, where it takes precedence over a public declaration of its name. */
  private?: boolean;
  /** The doc comment written above this property, its markers stripped, or
   * undefined if none. */
  docComment?: string;
}

/** A `NAME;` splice: in a `{ … }` block, the entries of the map `NAME` names;
 * in the body of a target of a rule's block, the properties of the rule's
 * parameter. */
export interface ISpliceDecl extends IBaseDecl {
  kind: DeclKind.Splice;
  ref: Name;
  /** The end offset (exclusive) of the written reference. */
  endOffset: number;
}

/** One item of a `{ ... }` block or a target's body: a `key = value;` entry or a `NAME;` splice. */
export type IMapItemDecl = IPropertyDecl | ISpliceDecl;

/** @return true if `item` is a property declaration rather than a splice, otherwise false. */
export function isPropertyDecl(item: IMapItemDecl): item is IPropertyDecl {
  return item.kind === DeclKind.Property;
}

/** @return true if any of the property's values is a `{ ... }` map block, otherwise false. */
export function hasMapValue(prop: IPropertyDecl): boolean {
  return prop.values.some(isMapValue);
}

export interface IIncludeDecl extends IBaseDecl {
  kind: DeclKind.Include;
  /**
   * The included path, relative to the including file, either a simple filename
   * or a glob expression; or one of a plugin's `optional_libs`, written
   * `<package>:<path>` (see {@link optionalLibOf}). No variables or constraints.
   */
  name: Name;
}

/**
 * @return the package name and the path or pattern within it that an include
 * of `name` names where it includes one of a plugin's `optional_libs`
 * (`@fabr-build/java:lib/spring-boot.fabr`), otherwise undefined.
 */
export function optionalLibOf(name: Name): { plugin: string; path: Name } | undefined {
  const head = name.getLiteralPrefix();
  const colon = head.indexOf(NAME_LEVEL_SEPARATOR);
  return colon < 0 ? undefined : { plugin: head.substring(0, colon), path: name.substring(colon + 1) };
}

/**
 * A `plugin <name>;` declaration: the project uses the plugin `name` names,
 * resolved as a reference in the model as loaded so far, and reads its `.fabr`
 * files.
 */
export interface IPluginDecl extends IBaseDecl {
  kind: DeclKind.Plugin;
  /** The reference to the plugin, as written. */
  name: Name;
}

/**
 * The fabr release a project builds with: `fabr <version>;`, the first
 * statement of the project file. Its form is fixed (an exact version, written
 * literally), so it can be read without parsing the file.
 */
export interface IFabrDecl extends IBaseDecl {
  /** The release's exact version, as written. */
  version: string;
}

/**
 * A rule's implementation written in `.fabr`: `= <result> { <declarations> }`.
 * The target the rule matches is what `result` names, looked up among the
 * block's own targets and properties before the file's. The short form
 * `= <type> <name> { … }` is the block holding that one target, its result
 * the target's name.
 */
export interface IRuleBlock {
  /** The reference saying what the target is. */
  result: INameValue;
  /** The sub-targets the block declares. */
  targets: ITargetDecl[];
  /** The properties the block declares. */
  properties: IPropertyDecl[];
}

/**
 * Get the property of a rule's parameter `param` that a name in its block
 * reads: `srcs` for `pkg.srcs` or `pkg.srcs:**`. @return undefined where the
 * name's first part is not `<param>.<property>`.
 */
export function parameterProperty(name: Name | string, param: string): string | undefined {
  const first = (typeof name === "string" ? name : name.getLiteralPathPrefix()).split(/[:/]/)[0];
  return first.startsWith(param + ".") && first.length > param.length + 1 ? first.substring(param.length + 1) : undefined;
}

/** @return true if `implementation` is written in `.fabr`, otherwise false. */
export function isRuleBlock(implementation: INameValue | IRuleBlock): implementation is IRuleBlock {
  return "result" in implementation;
}

/**
 * A `rule` declaration: `rule <type> <param><guards> = <implementation>;`, or
 * `default rule <param><guards> = …;` for a rule of every type. The guards are
 * those on the configuration (`BUILD_OPERATION=build`) and those on the
 * target's own properties, written through the parameter
 * (`pkg.test_framework=jest`). The implementation is a reference to an entry
 * of a package (`@fabr-build/js:rules/BuildJSPackage`), or a block
 * ({@link IRuleBlock}).
 */
export interface IRuleDecl extends IBaseDecl {
  kind: DeclKind.Rule;
  /** The target type; undefined for a rule of every type. */
  type?: string;
  /** Where the target type is written; undefined where it is not. */
  typeOffset?: number;
  /** The name the declaration gives the target, in guards on its properties. */
  param: string;
  /** Where the parameter is written. */
  paramOffset: number;
  /** The guard on the configuration: property name → pattern. */
  properties: NameConstraint[];
  /** The guard on the target's own properties: property name → pattern. */
  targetProperties: NameConstraint[];
  implementation: INameValue | IRuleBlock;
}

/** A `repository` declaration: `repository <type> = <implementation>;`. */
export interface IRepositoryDecl extends IBaseDecl {
  kind: DeclKind.Repository;
  type: string;
  implementation: INameValue;
}

export interface IBuildFile {
  fs: FileSource;
  file: string;
  reader: StringReader;
}

/**
 * Make a value decl for a reference no parser read: one the invoker gives (a
 * name on fabr's command line), which then resolves as a written reference.
 *
 * `source` is the virtual file it counts as written in. Bare paths in the
 * reference are rooted at that file's directory (see `Name.relativeTo`), and
 * diagnostics name the file and excerpt its reader from `offset` to
 * `endOffset`, so `source` may hold the whole text the reference was read from
 * (a command line), with the offsets spanning this value.
 */
export function syntheticValue(value: Name, source: IBuildFile, offset: number, endOffset: number): INameValue {
  return { kind: DeclKind.NameValue, value, source, offset, endOffset };
}

export interface IBuildFileContents {
  targets: ITargetDecl[];
  targetdefs: ITargetDefDecl[];
  properties: IPropertyDecl[];
  defaults: IResolvableDecl[];
  includes: IIncludeDecl[];
  plugins: IPluginDecl[];
  rules: IRuleDecl[];
  repositories: IRepositoryDecl[];
  /** The fabr release the file declares, where its first statement declares one. */
  fabr?: IFabrDecl;
}

export type IDecl = ITargetDecl | IPropertyDecl | IIncludeDecl | IPluginDecl | IValue;

/**
 * A declaration a reference resolves to, which a configuration can vary: it
 * may be written `default` (used only where no ordinary declaration of the name
 * applies), and its `name` is a {@link Name} whose constraints guard it.
 */
export type IResolvableDecl = IPropertyDecl | ITargetDecl;

/** A declaration named by a plain identifier path, which introduces a type:
 * it is never guarded and never written `default`. */
export type IPlainNamedDecl = ITargetDefDecl;

export type INamedDecl = IResolvableDecl | IPlainNamedDecl;

/** Get a declaration's name as a plain string, whichever kind it is, as the
 * namespace indexes it: a resolvable decl's guard and rename are left off
 * ({@link Name.toBaseString}). */
export function declName(decl: INamedDecl): string {
  return typeof decl.name === "string" ? decl.name : decl.name.toBaseString();
}

export function getDeclKindName(kind: DeclKind): string {
  switch (kind) {
    case DeclKind.Include:
      return "include";
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
    case DeclKind.Splice:
      return "splice";
    case DeclKind.Rule:
      return "rule";
    case DeclKind.Repository:
      return "repository";
  }
}

/** @return the source-level keyword for a property's type, as written in a
 * targetdef (`FILES`, `PACKAGES`, `STRING`, `MAP`, `COMMAND`, `REWRITE`). */
export function propertyTypeName(schema: IPropertySchema): string {
  switch (schema.type) {
    case PropertyType.FileSet:
      return "FILES";
    case PropertyType.Packages:
      return "PACKAGES";
    case PropertyType.String:
      return "STRING";
    case PropertyType.Map:
      return "MAP";
    case PropertyType.Command:
      return "COMMAND";
    case PropertyType.Rewrite:
      return "REWRITE";
    default:
      return PropertyType[schema.type];
  }
}

/** Get the source span of a declaration: its position, plus the extent of its
 * name/value where the parser recorded one (rendered as an underline). */
export function declPosn(decl: IBaseDecl): ISourceSpan {
  return { ...decl.source, offset: decl.offset, endOffset: decl.endOffset };
}

/**
 * Merge the applicable declarations into one whose values are theirs
 * concatenated in written order, for a list-shaped read (FILES, REWRITE).
 */
export function mergedDecls(applicable: IPropertyDecl[]): IPropertyDecl | undefined {
  if (applicable.length <= 1) {
    return applicable[0];
  }
  /* The merged decl has no guard and the first declaration's position; each
   * value keeps its own span. */
  return {
    ...applicable[0],
    name: applicable[0].name.withConstraints([]),
    values: applicable.flatMap(decl => decl.values),
  };
}

/**
 * Get the single applicable declaration, for a scalar read (STRING, MAP,
 * COMMAND, a projection). Throw {@link ambiguousDeclsError} where more than
 * one applies.
 */
export function soleDecl(applicable: IPropertyDecl[]): IPropertyDecl | undefined {
  if (applicable.length > 1) {
    throw ambiguousDeclsError(applicable);
  }
  return applicable[0];
}

/** Render one declaration's guard as it was written (`<TARGET=*-linux-*, BUILD_TYPE=release>`),
 * or `unguarded` where it has none. */
export function guardText(decl: IPropertyDecl): string {
  const guard = decl.name.getConstraints();
  return guard.length === 0 ? "unguarded" : `<${guard.map(([key, value]) => `${key}=${value.toString()}`).join(", ")}>`;
}

/** Make the error for several guards admitting one configuration where only one
 * value is wanted, naming each guard. */
export function ambiguousDeclsError(chosen: IPropertyDecl[]): Error {
  const guards = chosen.map(guardText).join(" and ");
  return new FabrError(
    `'${chosen[0].name.toBaseString()}' is declared for this configuration by ${
      chosen.length
    } declarations (${guards}), but takes a single value`
  ).withHelp(
    "guards are never ranked against each other, so make them disjoint — a fallback belongs in a `default` (the targetdef's, or a `default` global)"
  );
}
