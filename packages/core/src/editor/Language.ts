/*
 * Copyright (c) 2026 Nathan Keynes <nkeynes@deadcoderemoval.net>
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

/**
 * What an editor is told of a build file: the declarations it holds, what is
 * written at a place in it, where a name written there is declared, and the
 * documentation of what it names. A file's structure comes from its own parse
 * (its text as it stands, saved or not); what its names mean, from the loaded
 * model.
 */

import { posix } from "path";
import type { Name } from "../core/Name";
import { StringReader } from "../support/StringReader";
import type { ISourceSpan } from "../support/Log";
import { DeclKind, IBuildFile, IBuildFileContents, IIncludeDecl, IPluginDecl, INameValue, IPropertyDecl, ITargetDecl, ITargetDefDecl, IValue, propertyTypeName } from "../model/AST";
import { BuildModel } from "../model/BuildModel";
import { IPropertyEntry } from "../model/Namespace";

/** A span of a build file. */
export interface ISourceRange {
  source: IBuildFile;
  offset: number;
  endOffset: number;
}

/** A declaration a build file holds, as an outline lists it. */
export interface IBuildFileSymbol {
  /** The name it declares. */
  name: string;
  /** What it declares. */
  kind: "target" | "property" | "targetdef";
  /** A target's type. */
  detail?: string;
  /** The whole declaration. */
  range: ISourceRange;
  /** Its name. */
  selection: ISourceRange;
}

/** What is written at a place in a build file. */
export type Written =
  | { kind: "target-type"; target: ITargetDecl }
  | { kind: "target-name"; target: ITargetDecl }
  | { kind: "property-name"; property: IPropertyDecl; target?: ITargetDecl }
  | { kind: "value"; value: INameValue; property: IPropertyDecl; target?: ITargetDecl }
  | { kind: "include"; include: IIncludeDecl }
  | { kind: "plugin"; plugin: IPluginDecl }
  | { kind: "targetdef-name"; targetdef: ITargetDefDecl };

/** @return the declarations `contents` holds, in written order. */
export function symbolsOf(contents: IBuildFileContents): IBuildFileSymbol[] {
  const symbols: IBuildFileSymbol[] = [
    ...contents.targets.map(
      (target): IBuildFileSymbol => ({ name: target.name.toString(), kind: "target", detail: target.type, range: targetRange(target), selection: nameRange(target) })
    ),
    ...[...contents.properties, ...contents.defaults.filter((decl): decl is IPropertyDecl => decl.kind === DeclKind.Property)].map(
      (property): IBuildFileSymbol => ({ name: property.name.toString(), kind: "property", range: propertyRange(property), selection: nameRange(property) })
    ),
    ...contents.targetdefs.map(
      (targetdef): IBuildFileSymbol => ({ name: targetdef.name, kind: "targetdef", range: span(targetdef, targetdef.offset + targetdef.name.length), selection: span(targetdef, targetdef.offset + targetdef.name.length) })
    ),
  ];
  return symbols.sort((a, b) => a.range.offset - b.range.offset);
}

/** @return what is written at `offset` in `contents`, or undefined where it is nothing an editor asks about. */
export function writtenAt(contents: IBuildFileContents, offset: number): Written | undefined {
  const within = (start: number, end: number): boolean => offset >= start && offset <= end;
  const inProperty = (property: IPropertyDecl, target?: ITargetDecl): Written | undefined => {
    if (within(property.offset, nameRange(property).endOffset)) {
      return { kind: "property-name", property, ...(target === undefined ? {} : { target }) };
    }
    for (const value of valuesOf(property.values)) {
      if (value.kind === DeclKind.NameValue && within(value.offset, value.endOffset)) {
        return { kind: "value", value, property, ...(target === undefined ? {} : { target }) };
      }
    }
    return undefined;
  };
  for (const target of [...contents.targets, ...contents.defaults.filter((decl): decl is ITargetDecl => decl.kind === DeclKind.Target)]) {
    if (within(target.typeOffset, target.typeOffset + target.type.length)) {
      return { kind: "target-type", target };
    }
    if (within(target.offset, nameRange(target).endOffset)) {
      return { kind: "target-name", target };
    }
    for (const property of target.properties) {
      const found = inProperty(property, target);
      if (found !== undefined) {
        return found;
      }
    }
  }
  for (const property of [...contents.properties, ...contents.defaults.filter((decl): decl is IPropertyDecl => decl.kind === DeclKind.Property)]) {
    const found = inProperty(property);
    if (found !== undefined) {
      return found;
    }
  }
  const plugin = contents.plugins.find(decl => within(decl.offset, decl.endOffset ?? decl.offset + decl.name.toString().length));
  if (plugin !== undefined) {
    return { kind: "plugin", plugin };
  }
  const include = contents.includes.find(decl => within(decl.offset, decl.endOffset ?? decl.offset + decl.name.toString().length));
  if (include !== undefined) {
    return { kind: "include", include };
  }
  const targetdef = contents.targetdefs.find(decl => within(decl.offset, decl.offset + decl.name.length));
  return targetdef === undefined ? undefined : { kind: "targetdef-name", targetdef };
}

/** What documents a declaration, for an editor to present. */
export interface IDocumentation {
  /** What it is, as written in a build file (`holder lib`, `srcs: FILES`). */
  title?: string;
  /** The declaration it is part of, as written (`holder`, `catalog @dep`). */
  within?: string;
  /** Its declarations, as written in a build file. */
  source?: string;
  /** The comment written above it. */
  comment?: string;
}

/** What a place in a build file names: the span that names it, where it is declared, and its documentation. */
export interface INamed {
  /** The span of the file naming it. */
  origin: ISourceRange;
  declarations: ISourceSpan[];
  documentation?: IDocumentation;
}

/**
 * @return what is named at `offset`, where `written` is what is written
 * there: a reference's target or property, or the part of a reference into a
 * repository's own entries (`@dep:@sentry/cli`: the catalog for `@dep`, its
 * entry for `@sentry/cli`), the property a `${NAME}` substitution reads, a
 * property's schema in its target's type, a target's type, the file an
 * include names; undefined where nothing is.
 */
export function namedAt(model: BuildModel, written: Written, offset: number): INamed | undefined {
  switch (written.kind) {
    case "value":
      return referenceAt(model, written.value.source, written.value.offset, written.value.endOffset, written.value.value, offset);
    case "plugin": {
      const end = written.plugin.endOffset ?? written.plugin.offset + written.plugin.name.toString().length;
      return referenceAt(model, written.plugin.source, written.plugin.offset, end, written.plugin.name, offset);
    }
    case "property-name": {
      const range = nameRange(written.property);
      const substituted = substitutionAt(written.property.source, range.offset, range.endOffset, offset);
      if (substituted !== undefined) {
        return propertyNamed(model, substituted.name, substituted.origin);
      }
      if (written.target === undefined) {
        return propertyNamed(model, written.property.name.toBaseString(), range);
      }
      const targetdef = model.getTargetDef(written.target.type);
      const name = written.property.name.toBaseString();
      const schema = targetdef?.properties.get(name) ?? targetdef?.properties.get("*");
      return {
        origin: range,
        declarations: targetdef === undefined ? [] : [spanOf(targetdef)],
        ...(schema === undefined
          ? {}
          : {
              documentation: {
                title: `${name}: ${schema.required ? "REQUIRED " : ""}${propertyTypeName(schema)}`,
                within: written.target.type,
                ...(schema.docComment === undefined ? {} : { comment: schema.docComment }),
              },
            }),
      };
    }
    case "target-type": {
      const targetdef = model.getTargetDef(written.target.type);
      return {
        origin: { source: written.target.source, offset: written.target.typeOffset, endOffset: written.target.typeOffset + written.target.type.length },
        declarations: targetdef === undefined ? [] : [spanOf(targetdef)],
        ...(targetdef === undefined
          ? {}
          : { documentation: { title: `targetdef ${targetdef.name}`, ...(targetdef.docComment === undefined ? {} : { comment: targetdef.docComment }) } }),
      };
    }
    case "target-name":
      return { origin: nameRange(written.target), declarations: [spanOf(written.target)], documentation: describeTarget(written.target) };
    case "include": {
      const included = written.include.name.toString();
      const origin = span(written.include, written.include.endOffset ?? written.include.offset + included.length);
      if (/[*?[{]/.test(included) || included.includes(":")) {
        return { origin, declarations: [] };
      }
      const file = posix.join(posix.dirname(written.include.source.file), included);
      return { origin, declarations: [{ fs: written.include.source.fs, file, offset: 0, reader: new StringReader("") }] };
    }
    default:
      return undefined;
  }
}

/**
 * @return what the part of the reference `name`, written in `source` from
 * `start` to `end`, at `offset` names: a `${NAME}` substitution's property;
 * else what the reference's head names (the declaration it matches), or,
 * past the head, the repository's own entry its next part names, where the
 * head is a repository whose declaration writes one.
 */
function referenceAt(model: BuildModel, source: IBuildFile, start: number, end: number, name: Name, offset: number): INamed | undefined {
  const substituted = substitutionAt(source, start, end, offset);
  if (substituted !== undefined) {
    return propertyNamed(model, substituted.name, substituted.origin);
  }
  const match = model.getPrefixMatch(name);
  if (match === undefined) {
    return undefined;
  }
  const text = source.reader.substring(start, end);
  const split = text.startsWith(match.name) ? match.name.length : text.length;
  const head: INamed = {
    origin: { source, offset: start, endOffset: start + split },
    declarations: spansOf(match.decl),
    documentation: match.decl.kind === DeclKind.Target ? describeTarget(match.decl) : describeProperty(match.name, match.decl),
  };
  if (offset < start + split || split === text.length) {
    return head;
  }
  /* The part past the head's separator, up to the next. */
  const rest = text.slice(split).replace(/^[:/]/, "");
  const from = start + text.length - rest.length;
  const member = /^[^:]*/.exec(rest)![0];
  const entries = match.decl.kind === DeclKind.Target && member !== "" ? entriesNaming(match.decl, member) : [];
  if (entries.length === 0) {
    return { ...head, origin: { source, offset: from, endOffset: end } };
  }
  return {
    origin: { source, offset: from, endOffset: from + member.length },
    declarations: entries.map(entry => ({ ...entry.source, offset: entry.offset, endOffset: entry.endOffset })),
    documentation: {
      title: member,
      within: `${(match.decl as ITargetDecl).type} ${match.name}`,
      source: entries.map(entry => entry.source.reader.substring(entry.offset, entry.endOffset)).join("\n"),
    },
  };
}

/**
 * @return the values `decl` writes that name `member`: by its rename where it
 * has one (`-> <member>`), else by the name its reference gives after its
 * repository (`@npm:<member>:2.0.0`).
 */
function entriesNaming(decl: ITargetDecl, member: string): INameValue[] {
  const names = (value: INameValue): boolean => {
    const renamed = value.value.getRenameTo()?.toString();
    if (renamed !== undefined) {
      return renamed === member;
    }
    const named = value.value.toString().replace(/^[^:]*:/, "");
    return named === member || named.startsWith(`${member}:`);
  };
  return decl.properties.flatMap(property => valuesOf(property.values).filter((value): value is INameValue => value.kind === DeclKind.NameValue && names(value)));
}

/** @return what the global or target `name` is, as named at `origin`. */
function propertyNamed(model: BuildModel, name: string, origin: ISourceRange): INamed {
  const decl = model.getDecl(name);
  return { origin, declarations: decl === undefined ? [] : spansOf(decl), ...(decl === undefined ? {} : { documentation: describeProperty(name, decl) }) };
}

/** @return a target's documentation: its declaration, and the comment written above it. */
function describeTarget(target: ITargetDecl): IDocumentation {
  return { title: `${target.type} ${target.name.toString()}`, ...(target.docComment === undefined ? {} : { comment: target.docComment }) };
}

/** @return a property's documentation: its declarations as written, and the comment above the first. */
function describeProperty(name: string, entry: IPropertyEntry | ITargetDecl | undefined): IDocumentation | undefined {
  if (entry === undefined) {
    return undefined;
  }
  if (entry.kind === DeclKind.Target) {
    return describeTarget(entry);
  }
  const decls = [...entry.decls, ...entry.defaults];
  const written = decls.map(decl => `${entry.defaults.includes(decl) ? "default " : ""}${decl.name.toString()} = ${valueText(decl)};`);
  const comment = decls.find(decl => decl.docComment !== undefined)?.docComment;
  return { source: written.join("\n"), ...(comment === undefined ? {} : { comment }) };
}

/** @return where each declaration of `decl`, a target or a property's entry, is written. */
function spansOf(decl: ITargetDecl | IPropertyEntry): ISourceSpan[] {
  if (decl.kind === DeclKind.Target) {
    return [spanOf(decl)];
  }
  return [...decl.decls, ...decl.defaults, ...(decl.fallbackTarget === undefined ? [] : [decl.fallbackTarget])].map(spanOf);
}

/** @return where `decl`'s name is written. */
function spanOf(decl: ITargetDecl | IPropertyDecl | ITargetDefDecl): ISourceSpan {
  const range = decl.kind === DeclKind.TargetDef ? span(decl, decl.offset + decl.name.length) : nameRange(decl);
  return { ...range.source, offset: range.offset, endOffset: range.endOffset };
}

/** @return the `${NAME}` substitution written at `offset` in `source` between `from` and `end`, its name and span, or undefined if none is. */
function substitutionAt(source: IBuildFile, from: number, end: number, offset: number): { name: string; origin: ISourceRange } | undefined {
  const text = source.reader.substring(from, end);
  for (const match of text.matchAll(/\$\{([^}<]+)(?:<[^}]*>)?\}/g)) {
    const start = from + match.index!;
    if (offset >= start && offset <= start + match[0].length) {
      return { name: match[1].trim(), origin: { source, offset: start, endOffset: start + match[0].length } };
    }
  }
  return undefined;
}

/** @return `values` and the values written within their map blocks, at any depth. */
function valuesOf(values: readonly IValue[]): IValue[] {
  return values.flatMap(value =>
    value.kind === DeclKind.MapValue
      ? valuesOf(value.entries.flatMap(entry => (entry.kind === DeclKind.Property ? entry.values : [])))
      : [value]
  );
}

/** @return a property declaration's values as written. */
function valueText(decl: IPropertyDecl): string {
  const first = decl.values[0];
  const last = decl.values[decl.values.length - 1];
  return first === undefined ? "" : decl.source.reader.substring(first.offset, last.endOffset);
}

/** @return the span of `decl`'s name. */
function nameRange(decl: ITargetDecl | IPropertyDecl): ISourceRange {
  return span(decl, decl.offset + decl.name.toString().length);
}

/** @return the span of a target's declaration, from its type to its last value. */
function targetRange(target: ITargetDecl): ISourceRange {
  const ends = target.properties.map(property => propertyRange(property).endOffset);
  return { source: target.source, offset: target.typeOffset, endOffset: Math.max(nameRange(target).endOffset, ...ends) };
}

/** @return the span of a property's declaration, from its name to its last value. */
function propertyRange(property: IPropertyDecl): ISourceRange {
  const last = property.values[property.values.length - 1];
  return { source: property.source, offset: property.offset, endOffset: last?.endOffset ?? nameRange(property).endOffset };
}

/** @return the span of `decl` from its offset to `end`. */
function span(decl: { source: IBuildFile; offset: number }, end: number): ISourceRange {
  return { source: decl.source, offset: decl.offset, endOffset: end };
}

/** Something an editor may offer to complete what is typed. */
export interface ICompletion {
  label: string;
  /** What it names. */
  kind: "property" | "target" | "type" | "keyword";
  /** A target's type, a property's type. */
  detail?: string;
  /** The comment written above its declaration. */
  comment?: string;
}

/** The words that open a declaration that is not a target's. */
const KEYWORDS = ["targetdef", "rule", "repository", "plugin", "include", "default"];

/**
 * @return what may complete what is typed at `offset` in `text`, a build file
 * as the editor holds it: inside `${`, the project's globals; a property's name
 * in a target's body, the properties its type declares; after `=`, the
 * project's targets and globals; at the top level, the target types and the
 * keywords. What is typed so far is the editor's to match.
 */
export function completionsAt(model: BuildModel, text: string, offset: number): ICompletion[] {
  const context = typingContext(text, offset);
  const globals = (): ICompletion[] =>
    model.getProperties().map(({ name, decl }) => ({ label: name, kind: "property", ...(decl.docComment === undefined ? {} : { comment: decl.docComment }) }));
  const targets = (): ICompletion[] =>
    model.getTargets().map(({ name, decl }) => ({ label: name, kind: "target", detail: decl.type, ...(decl.docComment === undefined ? {} : { comment: decl.docComment }) }));
  switch (context.kind) {
    case "substitution":
      return globals();
    case "value":
      return [...targets(), ...globals()];
    case "property-name": {
      const targetdef = model.getTargetDef(context.type);
      return [...(targetdef?.properties ?? new Map())]
        .filter(([name]) => name !== "*")
        .map(([name, schema]) => ({
          label: name,
          kind: "property",
          detail: `${schema.required ? "REQUIRED " : ""}${propertyTypeName(schema)}`,
          ...(schema.docComment === undefined ? {} : { comment: schema.docComment }),
        }));
    }
    case "top-level":
      return [
        ...model.getTargetDefs().map((targetdef): ICompletion => ({ label: targetdef.name, kind: "type", ...(targetdef.docComment === undefined ? {} : { comment: targetdef.docComment }) })),
        ...KEYWORDS.map((keyword): ICompletion => ({ label: keyword, kind: "keyword" })),
      ];
    default:
      return [];
  }
}

/** Where in a build file's grammar a place is, as far as the text before it says. */
type TypingContext = { kind: "substitution" } | { kind: "value" } | { kind: "property-name"; type: string } | { kind: "top-level" } | { kind: "other" };

/** @return where in the grammar `offset` in `text` lies, read from the text before it, comments and strings skipped. */
function typingContext(text: string, offset: number): TypingContext {
  /* Each open brace's header: the text of its statement before it. */
  const headers: string[] = [];
  let statement = "";
  let substitution = false;
  for (let i = 0; i < offset; i++) {
    const char = text[i];
    if (char === "#") {
      const end = text.indexOf("\n", i);
      if (end < 0 || end >= offset) {
        return { kind: "other" };
      }
      i = end;
      continue;
    }
    if (char === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') {
        end += text[end] === "\\" ? 2 : 1;
      }
      if (end >= offset) {
        return { kind: "other" };
      }
      statement += text.slice(i, end + 1);
      i = end;
      continue;
    }
    if (char === "$" && text[i + 1] === "{") {
      substitution = true;
    } else if (char === "}" && substitution) {
      substitution = false;
    } else if (char === "{") {
      headers.push(statement.trim());
      statement = "";
      continue;
    } else if (char === "}") {
      headers.pop();
      statement = "";
      continue;
    } else if (char === ";") {
      statement = "";
      continue;
    }
    statement += char;
  }
  if (substitution) {
    return { kind: "substitution" };
  }
  if (/=/.test(statement)) {
    return { kind: "value" };
  }
  const header = headers[headers.length - 1];
  if (header === undefined) {
    return { kind: "top-level" };
  }
  /* A target's body: `<type> <name>`, perhaps guarded. */
  const target = /^(?:default\s+)?([A-Za-z_][\w-]*)\s+[^\s=]+$/.exec(header.replace(/<[^>]*>/g, ""));
  return target !== null && !KEYWORDS.includes(target[1]) ? { kind: "property-name", type: target[1] } : { kind: "other" };
}
