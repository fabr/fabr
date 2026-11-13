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
import type { Name, NameConstraint } from "../core/Name";
import { StringReader } from "../support/StringReader";
import type { ISourceSpan } from "../support/Log";
import {
  declName,
  DeclKind,
  hasMapValue,
  IBuildFile,
  IBuildFileContents,
  IIncludeDecl,
  IPluginDecl,
  INameValue,
  IPropertyDecl,
  IRuleDecl,
  isPropertyDecl,
  isRuleBlock,
  ISpliceDecl,
  ITargetDecl,
  ITargetDefDecl,
  IValue,
  parameterProperty,
  propertyTypeName,
} from "../model/AST";
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
  kind: "target" | "property" | "targetdef" | "rule";
  /** A target's type; a rule's guards. */
  detail?: string;
  /** The whole declaration. */
  range: ISourceRange;
  /** Its name. */
  selection: ISourceRange;
  /** What a rule's block declares, in written order. */
  children?: IBuildFileSymbol[];
}

/** What is written at a place in a build file. */
export type Written =
  | { kind: "target-type"; target: ITargetDecl; rule?: IRuleDecl }
  | { kind: "target-name"; target: ITargetDecl; rule?: IRuleDecl }
  | { kind: "property-name"; property: IPropertyDecl; target?: ITargetDecl; rule?: IRuleDecl }
  /* A value of a property, or a rule's implementation (`property` undefined). */
  | { kind: "value"; value: INameValue; property?: IPropertyDecl; target?: ITargetDecl; rule?: IRuleDecl }
  | { kind: "splice"; splice: ISpliceDecl; target: ITargetDecl; rule?: IRuleDecl }
  | { kind: "rule-type"; rule: IRuleDecl }
  | { kind: "rule-parameter"; rule: IRuleDecl }
  | { kind: "include"; include: IIncludeDecl }
  | { kind: "plugin"; plugin: IPluginDecl }
  | { kind: "targetdef-name"; targetdef: ITargetDefDecl }
  | { kind: "targetdef-base"; targetdef: ITargetDefDecl };

/** @return the declarations `contents` holds, in written order. */
export function symbolsOf(contents: IBuildFileContents): IBuildFileSymbol[] {
  const symbols: IBuildFileSymbol[] = [
    ...[...contents.targets, ...contents.defaults.filter((decl): decl is ITargetDecl => decl.kind === DeclKind.Target)].map(
      targetSymbol
    ),
    ...[...contents.properties, ...contents.defaults.filter((decl): decl is IPropertyDecl => decl.kind === DeclKind.Property)].map(
      propertySymbol
    ),
    ...contents.targetdefs.map((targetdef): IBuildFileSymbol => ({
      name: targetdef.name,
      kind: "targetdef",
      range: span(targetdef, targetdef.offset + targetdef.name.length),
      selection: span(targetdef, targetdef.offset + targetdef.name.length),
    })),
    ...contents.rules.map(ruleSymbol),
  ];
  return symbols.sort((a, b) => a.range.offset - b.range.offset);
}

/** @return a rule's symbol: named by its type, or `default rule`, its guards the detail, and what its block declares beneath it. */
function ruleSymbol(rule: IRuleDecl): IBuildFileSymbol {
  const guards = [
    ...rule.properties,
    ...rule.targetProperties.map(([key, pattern]): NameConstraint => [`${rule.param}.${key}`, pattern]),
  ];
  const block = isRuleBlock(rule.implementation) ? rule.implementation : undefined;
  const children =
    block === undefined
      ? []
      : [...block.targets.map(targetSymbol), ...block.properties.map(propertySymbol)].sort((a, b) => a.range.offset - b.range.offset);
  const selection =
    rule.type === undefined || rule.typeOffset === undefined
      ? { source: rule.source, offset: rule.paramOffset, endOffset: rule.paramOffset + rule.param.length }
      : { source: rule.source, offset: rule.typeOffset, endOffset: rule.typeOffset + rule.type.length };
  return {
    name: rule.type ?? "default rule",
    kind: "rule",
    ...(guards.length === 0 ? {} : { detail: guards.map(([key, pattern]) => `${key}=${pattern.toString()}`).join(", ") }),
    range: {
      source: rule.source,
      offset: rule.offset,
      endOffset: Math.max(selection.endOffset, ...children.map(child => child.range.endOffset), ruleImplementationEnd(rule)),
    },
    selection,
    ...(children.length === 0 ? {} : { children }),
  };
}

/** @return a target's symbol. */
function targetSymbol(target: ITargetDecl): IBuildFileSymbol {
  return {
    name: target.name.toString(),
    kind: "target",
    detail: target.type,
    range: targetRange(target),
    selection: nameRange(target),
  };
}

/** @return a property's symbol. */
function propertySymbol(property: IPropertyDecl): IBuildFileSymbol {
  return { name: property.name.toString(), kind: "property", range: propertyRange(property), selection: nameRange(property) };
}

/** @return where a rule's implementation, or its block's result, ends. */
function ruleImplementationEnd(rule: IRuleDecl): number {
  return isRuleBlock(rule.implementation) ? rule.implementation.result.endOffset : rule.implementation.endOffset;
}

/** @return what is written at `offset` in `contents`, or undefined where it is nothing an editor asks about. */
export function writtenAt(contents: IBuildFileContents, offset: number): Written | undefined {
  const within = (start: number, end: number): boolean => offset >= start && offset <= end;
  const inProperty = (property: IPropertyDecl, target?: ITargetDecl, rule?: IRuleDecl): Written | undefined => {
    const where = { ...(target === undefined ? {} : { target }), ...(rule === undefined ? {} : { rule }) };
    if (within(property.offset, nameRange(property).endOffset)) {
      return { kind: "property-name", property, ...where };
    }
    for (const value of valuesOf(property.values)) {
      if (value.kind === DeclKind.NameValue && within(value.offset, value.endOffset)) {
        return { kind: "value", value, property, ...where };
      }
    }
    return undefined;
  };
  const inTarget = (target: ITargetDecl, rule?: IRuleDecl): Written | undefined => {
    const where = rule === undefined ? {} : { rule };
    if (within(target.typeOffset, target.typeOffset + target.type.length)) {
      return { kind: "target-type", target, ...where };
    }
    if (within(target.offset, nameRange(target).endOffset)) {
      return { kind: "target-name", target, ...where };
    }
    for (const item of target.properties) {
      const found = isPropertyDecl(item)
        ? inProperty(item, target, rule)
        : within(item.offset, item.endOffset)
          ? ({ kind: "splice", splice: item, target, ...where } as const)
          : undefined;
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  };
  for (const target of [
    ...contents.targets,
    ...contents.defaults.filter((decl): decl is ITargetDecl => decl.kind === DeclKind.Target),
  ]) {
    const found = inTarget(target);
    if (found !== undefined) {
      return found;
    }
  }
  for (const rule of contents.rules) {
    if (rule.type !== undefined && rule.typeOffset !== undefined && within(rule.typeOffset, rule.typeOffset + rule.type.length)) {
      return { kind: "rule-type", rule };
    }
    if (within(rule.paramOffset, rule.paramOffset + rule.param.length)) {
      return { kind: "rule-parameter", rule };
    }
    const { implementation } = rule;
    if (!isRuleBlock(implementation)) {
      if (within(implementation.offset, implementation.endOffset)) {
        return { kind: "value", value: implementation, rule };
      }
      continue;
    }
    for (const found of [
      ...implementation.targets.map(target => inTarget(target, rule)),
      ...implementation.properties.map(property => inProperty(property, undefined, rule)),
    ]) {
      if (found !== undefined) {
        return found;
      }
    }
    if (within(implementation.result.offset, implementation.result.endOffset)) {
      return { kind: "value", value: implementation.result, rule };
    }
  }
  for (const property of [
    ...contents.properties,
    ...contents.defaults.filter((decl): decl is IPropertyDecl => decl.kind === DeclKind.Property),
  ]) {
    const found = inProperty(property);
    if (found !== undefined) {
      return found;
    }
  }
  const repository = contents.repositories.find(decl => within(decl.implementation.offset, decl.implementation.endOffset));
  if (repository !== undefined) {
    return { kind: "value", value: repository.implementation };
  }
  const plugin = contents.plugins.find(decl => within(decl.offset, decl.endOffset ?? decl.offset + decl.name.toString().length));
  if (plugin !== undefined) {
    return { kind: "plugin", plugin };
  }
  const include = contents.includes.find(decl => within(decl.offset, decl.endOffset ?? decl.offset + decl.name.toString().length));
  if (include !== undefined) {
    return { kind: "include", include };
  }
  const extending = contents.targetdefs.find(
    decl => decl.extends !== undefined && within(decl.extends.offset, decl.extends.offset + decl.extends.name.length)
  );
  if (extending !== undefined) {
    return { kind: "targetdef-base", targetdef: extending };
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
      return written.rule === undefined
        ? referenceAt(model, written.value.source, written.value.offset, written.value.endOffset, written.value.value, offset)
        : scopedReferenceAt(
            model,
            written.rule,
            written.value.source,
            written.value.offset,
            written.value.endOffset,
            written.value.value,
            offset
          );
    case "splice":
      return written.rule === undefined
        ? referenceAt(model, written.splice.source, written.splice.offset, written.splice.endOffset, written.splice.ref, offset)
        : scopedReferenceAt(
            model,
            written.rule,
            written.splice.source,
            written.splice.offset,
            written.splice.endOffset,
            written.splice.ref,
            offset
          );
    case "rule-type": {
      const { rule } = written;
      return typeNamed(model, rule.type!, {
        source: rule.source,
        offset: rule.typeOffset!,
        endOffset: rule.typeOffset! + rule.type!.length,
      });
    }
    case "rule-parameter":
      return parameterNamed(model, written.rule, {
        source: written.rule.source,
        offset: written.rule.paramOffset,
        endOffset: written.rule.paramOffset + written.rule.param.length,
      });
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
      if (written.target === undefined && written.rule !== undefined) {
        /* A property of a rule's block is declared where it is. */
        return {
          origin: range,
          declarations: [spanOf(written.property)],
          documentation: describeProperty(written.property.name.toBaseString(), {
            kind: DeclKind.Property,
            decls: [written.property],
            defaults: [],
          }),
        };
      }
      if (written.target === undefined) {
        return propertyNamed(model, written.property.name.toBaseString(), range);
      }
      return schemaNamed(model, written.target.type, written.property.name.toBaseString(), range);
    }
    case "targetdef-base": {
      const base = written.targetdef.extends!;
      return typeNamed(model, base.name, {
        source: written.targetdef.source,
        offset: base.offset,
        endOffset: base.offset + base.name.length,
      });
    }
    case "target-type":
      return typeNamed(model, written.target.type, {
        source: written.target.source,
        offset: written.target.typeOffset,
        endOffset: written.target.typeOffset + written.target.type.length,
      });
    case "target-name":
      return {
        origin: nameRange(written.target),
        declarations: [spanOf(written.target)],
        documentation: describeTarget(written.target),
      };
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
function referenceAt(
  model: BuildModel,
  source: IBuildFile,
  start: number,
  end: number,
  name: Name,
  offset: number
): INamed | undefined {
  const substituted = substitutionAt(source, start, end, offset);
  if (substituted !== undefined) {
    return propertyNamed(model, substituted.name, substituted.origin);
  }
  const match = model.getPrefixMatch(name, source.file);
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
 * @return what the part of the reference `name`, written in a rule's
 * declaration `rule` from `start` to `end`, at `offset` names, as the rule's
 * block looks it up: the rule's parameter its type, a property read through it
 * (`pkg.srcs`) that property of its type, a name the block declares that
 * declaration; anything else as the file's names do (see {@link referenceAt}).
 */
function scopedReferenceAt(
  model: BuildModel,
  rule: IRuleDecl,
  source: IBuildFile,
  start: number,
  end: number,
  name: Name,
  offset: number
): INamed | undefined {
  const block = isRuleBlock(rule.implementation) ? rule.implementation : undefined;
  const substituted = substitutionAt(source, start, end, offset);
  const local = (head: string, origin: ISourceRange): INamed | undefined => {
    if (head === rule.param) {
      return parameterNamed(model, rule, origin);
    }
    const property = parameterProperty(head, rule.param);
    if (property !== undefined) {
      return rule.type === undefined ? { origin, declarations: [] } : schemaNamed(model, rule.type, property, origin);
    }
    const target = block?.targets.find(decl => declName(decl) === head);
    if (target !== undefined) {
      return { origin, declarations: [spanOf(target)], documentation: describeTarget(target) };
    }
    const properties = block?.properties.filter(decl => decl.name.toBaseString() === head) ?? [];
    return properties.length === 0
      ? undefined
      : {
          origin,
          declarations: properties.map(spanOf),
          documentation: describeProperty(head, { kind: DeclKind.Property, decls: properties, defaults: [] }),
        };
  };
  if (substituted !== undefined) {
    return local(substituted.name, substituted.origin) ?? propertyNamed(model, substituted.name, substituted.origin);
  }
  const text = source.reader.substring(start, end);
  const head = /^[^:/<]*/.exec(text)![0];
  return (
    local(head, { source, offset: start, endOffset: start + head.length }) ?? referenceAt(model, source, start, end, name, offset)
  );
}

/** @return the target type `type`, as named at `origin`. */
function typeNamed(model: BuildModel, type: string, origin: ISourceRange): INamed {
  const targetdef = model.getTargetDef(type);
  return {
    origin,
    declarations: targetdef === undefined ? [] : [spanOf(targetdef)],
    ...(targetdef === undefined
      ? {}
      : {
          documentation: {
            title: `targetdef ${targetdef.name}`,
            ...(targetdef.docComment === undefined ? {} : { comment: targetdef.docComment }),
          },
        }),
  };
}

/** @return a rule's parameter, as named at `origin`: the target the rule builds, a target of its type. */
function parameterNamed(model: BuildModel, rule: IRuleDecl, origin: ISourceRange): INamed {
  const of = rule.type === undefined ? undefined : model.getTargetDef(rule.type);
  return {
    origin,
    declarations: [{ ...rule.source, offset: rule.paramOffset, endOffset: rule.paramOffset + rule.param.length }],
    documentation: {
      title: `${rule.param}: the ${rule.type ?? "target"} the rule builds`,
      ...(of?.docComment === undefined ? {} : { comment: of.docComment }),
    },
  };
}

/** @return the property `name` of the target type `type`, as named at `origin`: its schema, where the type is declared. */
function schemaNamed(model: BuildModel, type: string, name: string, origin: ISourceRange): INamed {
  const targetdef = model.getTargetDef(type);
  const key = targetdef?.properties.has(name) ? name : "*";
  const schema = targetdef?.properties.get(key);
  /* The targetdef that declares it: up the bases while each has it as inherited. */
  let declaring = targetdef;
  for (const visited = new Set<ITargetDefDecl>(); declaring?.extends !== undefined && schema !== undefined;) {
    visited.add(declaring);
    const base = model.getTargetDef(declaring.extends.name);
    if (base === undefined || visited.has(base) || base.properties.get(key) !== declaring.properties.get(key)) {
      break;
    }
    declaring = base;
  }
  return {
    origin,
    declarations: declaring === undefined ? [] : [spanOf(declaring)],
    ...(schema === undefined
      ? {}
      : {
          documentation: {
            title: `${name}: ${schema.required ? "REQUIRED " : ""}${propertyTypeName(schema)}`,
            within: type,
            ...(schema.docComment === undefined ? {} : { comment: schema.docComment }),
          },
        }),
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
  /* A splice writes no value of its own. */
  return decl.properties
    .filter(isPropertyDecl)
    .flatMap(property =>
      valuesOf(property.values).filter((value): value is INameValue => value.kind === DeclKind.NameValue && names(value))
    );
}

/** @return what the global or target `name` is, as named at `origin`. */
function propertyNamed(model: BuildModel, name: string, origin: ISourceRange): INamed {
  const decl = model.getPrivateScope(origin.source.file)?.getDecl(name) ?? model.getDecl(name);
  return {
    origin,
    declarations: decl === undefined ? [] : spansOf(decl),
    ...(decl === undefined ? {} : { documentation: describeProperty(name, decl) }),
  };
}

/** @return a target's documentation: its declaration, and the comment written above it. */
function describeTarget(target: ITargetDecl): IDocumentation {
  return {
    title: `${target.type} ${target.name.toString()}`,
    ...(target.docComment === undefined ? {} : { comment: target.docComment }),
  };
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
function substitutionAt(
  source: IBuildFile,
  from: number,
  end: number,
  offset: number
): { name: string; origin: ISourceRange } | undefined {
  const text = source.reader.substring(from, end);
  /* The name, a requirement on it, and an edit after it (`#p`, `%p`, `/a/b`), a backslash quoting a character of the edit. */
  for (const match of text.matchAll(/\$\{\s*([^\s}<#%/]+)\s*(?:<[^}]*>)?\s*(?:[#%/](?:\\.|[^}\\])*)?\}/g)) {
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

/** @return the span of `decl`'s name as written: to the end the parser
 * recorded, else to the end of its key, a `<…>` guard on it included. */
function nameRange(decl: ITargetDecl | IPropertyDecl): ISourceRange {
  if (decl.endOffset !== undefined) {
    return span(decl, decl.endOffset);
  }
  const { reader } = decl.source;
  let end = decl.offset;
  for (let depth = 0; ; end++) {
    const char = reader.substring(end, end + 1);
    if (char === "") {
      break;
    } else if (char === "<") {
      depth++;
    } else if (char === ">" && depth > 0) {
      depth--;
    } else if (depth === 0 && (char === "=" || /\s/.test(char))) {
      break;
    }
  }
  return span(decl, Math.max(end, decl.offset + 1));
}

/** @return the span of a target's declaration, from its type to its last value. */
function targetRange(target: ITargetDecl): ISourceRange {
  const ends = target.properties.map(item => (isPropertyDecl(item) ? propertyRange(item).endOffset : item.endOffset));
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

/** @return a rule's parameter, the target being built, and each property of its type read through it (`pkg.srcs`). */
function parameterCompletions(model: BuildModel, rule: RuleScope): ICompletion[] {
  const targetdef = rule.type === undefined ? undefined : model.getTargetDef(rule.type);
  return [
    { label: rule.parameter, kind: "target", detail: "the target being built" },
    ...[...(targetdef?.properties ?? new Map())]
      .filter(([name]) => name !== "*")
      .map(([name, schema]): ICompletion => ({
        label: `${rule.parameter}.${name}`,
        kind: "property",
        detail: propertyTypeName(schema),
        ...(schema.docComment === undefined ? {} : { comment: schema.docComment }),
      })),
  ];
}

/** The words that open a declaration that is not a target's. */
const KEYWORDS = ["fabr", "targetdef", "rule", "repository", "plugin", "include", "default", "private"];

/**
 * @return what may complete what is typed at `offset` in `text`, the build
 * file `file` names as the editor holds it, whose private names it sees:
 * inside `${`, the project's globals; a property's name
 * in a target's body, the properties its type declares and what it can
 * splice (the project's map properties, and in a rule's block the rule's
 * parameter); after `=`, the
 * project's targets and globals; at the top level, the target types and the
 * keywords. What is typed so far is the editor's to match.
 */
export function completionsAt(model: BuildModel, text: string, offset: number, file?: string): ICompletion[] {
  const context = typingContext(text, offset);
  /* The file's own private names, and the public names they do not hide. */
  const own = file === undefined ? undefined : model.getPrivateScope(file);
  const visible = <T>(
    own: Array<{ name: string; decl: T }>,
    all: Array<{ name: string; decl: T }>
  ): Array<{ name: string; decl: T }> => [...own, ...all.filter(({ name }) => !own.some(mine => mine.name === name))];
  const globals = (): ICompletion[] =>
    visible(own?.getProperties() ?? [], model.getProperties()).map(({ name, decl }) => ({
      label: name,
      kind: "property",
      ...(decl.docComment === undefined ? {} : { comment: decl.docComment }),
    }));
  const targets = (): ICompletion[] =>
    visible(own?.getTargets() ?? [], model.getTargets()).map(({ name, decl }) => ({
      label: name,
      kind: "target",
      detail: decl.type,
      ...(decl.docComment === undefined ? {} : { comment: decl.docComment }),
    }));
  switch (context.kind) {
    case "substitution":
      return globals();
    case "value":
      return [...targets(), ...globals(), ...(context.rule === undefined ? [] : parameterCompletions(model, context.rule))];
    case "property-name": {
      const targetdef = model.getTargetDef(context.type);
      const properties = [...(targetdef?.properties ?? new Map())]
        .filter(([name]) => name !== "*")
        .map(([name, schema]): ICompletion => ({
          label: name,
          kind: "property",
          detail: `${schema.required ? "REQUIRED " : ""}${propertyTypeName(schema)}`,
          ...(schema.docComment === undefined ? {} : { comment: schema.docComment }),
        }));
      const maps = visible(own?.getProperties() ?? [], model.getProperties())
        .filter(({ decl }) => hasMapValue(decl))
        .map(({ name, decl }): ICompletion => ({
          label: name,
          kind: "property",
          detail: "MAP",
          ...(decl.docComment === undefined ? {} : { comment: decl.docComment }),
        }));
      const parameter: ICompletion[] =
        context.rule === undefined ? [] : [{ label: context.rule.parameter, kind: "target", detail: "the target being built" }];
      return [...properties, ...maps, ...parameter];
    }
    case "top-level":
      return [
        ...model.getTargetDefs().map((targetdef): ICompletion => ({
          label: targetdef.name,
          kind: "type",
          ...(targetdef.docComment === undefined ? {} : { comment: targetdef.docComment }),
        })),
        ...KEYWORDS.map((keyword): ICompletion => ({ label: keyword, kind: "keyword" })),
      ];
    default:
      return [];
  }
}

/** The rule whose block a place is in: its parameter, and the type it is for, if it is for one. */
type RuleScope = { parameter: string; type?: string };

/** Where in a build file's grammar a place is, as far as the text before it says. */
type TypingContext =
  | { kind: "substitution" }
  | { kind: "value"; rule?: RuleScope }
  | { kind: "property-name"; type: string; rule?: RuleScope }
  | { kind: "top-level" }
  | { kind: "other" };

/** @return where in the grammar `offset` in `text` lies, read from the text before it, comments, strings and command substitutions skipped. */
function typingContext(text: string, offset: number): TypingContext {
  /* Each open brace's header: the text of its statement before it. */
  const headers: string[] = [];
  let statement = "";
  /* Skip from `i`, an opening character, past the run it opens up to `close`;
   * returns where it ends, or undefined where that is at or past `offset`. */
  const skipTo = (i: number, close: string, escapes: boolean): number | undefined => {
    let end = i + 1;
    while (end < text.length && text[end] !== close) {
      end += escapes && text[end] === "\\" ? 2 : 1;
    }
    return end >= offset ? undefined : end;
  };
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
    if (char === '"' || char === "'" || char === "`") {
      /* A single-quoted string has no escapes. */
      const end = skipTo(i, char, char !== "'");
      if (end === undefined) {
        return { kind: "other" };
      }
      statement += text.slice(i, end + 1);
      i = end;
      continue;
    }
    if (char === "$" && text[i + 1] === "{") {
      /* A substitution's name, then perhaps a requirement and an edit (`#p`,
       * `%p`, `/a/b`); a `#` in it starts no comment. */
      const end = skipTo(i + 1, "}", true);
      if (end === undefined) {
        return /^\s*[\w.-]*$/.test(text.slice(i + 2, offset)) ? { kind: "substitution" } : { kind: "other" };
      }
      statement += text.slice(i, end + 1);
      i = end;
      continue;
    }
    if (char === "{") {
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
  /* Within a rule's block, its parameter (`rule <type> <param>`, `default rule <param>`). */
  const unguarded = (text: string): string => text.replace(/<[^>]*>/g, "");
  const rule = headers
    .map((written): RuleScope | undefined => {
      const typed = /^rule\s+([A-Za-z_][\w-]*)\s+([A-Za-z_][\w-]*)/.exec(unguarded(written));
      const every = /^default\s+rule\s+([A-Za-z_][\w-]*)/.exec(unguarded(written));
      return typed !== null ? { parameter: typed[2], type: typed[1] } : every !== null ? { parameter: every[1] } : undefined;
    })
    .find(scope => scope !== undefined);
  const inRule = rule === undefined ? {} : { rule };
  if (/=/.test(statement)) {
    return { kind: "value", ...inRule };
  }
  const header = headers[headers.length - 1];
  if (header === undefined) {
    return { kind: "top-level" };
  }
  /* A target's body: `<type> <name>`, perhaps guarded, or the short form of a
   * rule's block, `rule … = <type> <name>`. */
  const target =
    /^(?:(?:default|private)\s+)?([A-Za-z_][\w-]*)\s+[^\s=]+$/.exec(unguarded(header)) ??
    /=\s*([A-Za-z_][\w-]*)\s+[^\s=]+$/.exec(unguarded(header));
  return target !== null && !KEYWORDS.includes(target[1]) ? { kind: "property-name", type: target[1], ...inRule } : { kind: "other" };
}
