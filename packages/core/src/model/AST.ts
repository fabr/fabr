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
  MapSplice,
  Rule,
  Repository,
}

interface IBaseDecl {
  source: IBuildFile;
  offset: number;
  /** End offset (exclusive) of the declaration's name/value where recorded,
   * so diagnostics can underline the extent rather than a single caret */
  endOffset?: number;
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
 * `plugin <name>;` — loads the named installed package as a rule plugin before
 * the requested targets are resolved. The name is resolved by module resolution
 * from the fabr installation (never built from source), and the package must
 * export a no-arg `activate()` returning its contribution (see Plugin.ts).
 */
export interface IPluginDecl extends IBaseDecl {
  kind: DeclKind.Plugin;
  /** The reference to the plugin, as written. */
  name: Name;
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
  /** The name the declaration gives the target, in guards on its properties. */
  param: string;
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
  targets: ITargetDecl[];
  targetdefs: ITargetDefDecl[];
  properties: IPropertyDecl[];
  defaults: IResolvableDecl[];
  includes: IIncludeDecl[];
  plugins: IPluginDecl[];
  rules: IRuleDecl[];
  repositories: IRepositoryDecl[];
}

export type IDecl = ITargetDecl | IPropertyDecl | IIncludeDecl | IPluginDecl | IValue;

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

/** A declaration named by a plain identifier path: it introduces a type rather
 * than something built, so there is no configuration for a name of its to vary
 * with. */
export type IPlainNamedDecl = ITargetDefDecl;

export type INamedDecl = IResolvableDecl | IPlainNamedDecl;

/** Get a declaration's name as a plain string, whichever kind it is — for the
 * namespace machinery, which indexes all four alike. A resolvable decl's facets
 * are left off ({@link Name.toBaseString}): they qualify the declaration, not
 * the name it goes under. */
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
    case DeclKind.MapSplice:
      return "splice";
    case DeclKind.Rule:
      return "rule";
    case DeclKind.Repository:
      return "repository";
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
  /* The merged decl carries no guard and takes the first contributor's
   * position, so an error about the property points there. A per-value error
   * carries its own value span. */
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
