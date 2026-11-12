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

import {
  DeclKind,
  declName,
  declPosn,
  hasMapValue,
  IMapItemDecl,
  INameValue,
  IPropertyDecl,
  isCommandValue,
  isMapValue,
  isNameValue,
  isPropertyDecl,
  IValue,
  IRuleBlock,
  IRuleDecl,
  ISpliceDecl,
  ITargetDecl,
  ITargetDefDecl,
  parameterProperty,
  PropertyType,
} from "./AST";
import { Diagnostic, ISourcePosition, Log, LogLevel } from "../support/Log";
import { NamePartKind } from "../core/Name";

interface ITargetPropertyError {
  property: string;
  type: string;
  target: string;
  loc: ISourcePosition;
}

const DIAG_UNEXPECTED_PROPERTY = new Diagnostic<ITargetPropertyError>(
  LogLevel.Error,
  "Unrecognized property '{property}' in {type} target '{target}'"
);
const DIAG_DUPLICATE_PROPERTY = new Diagnostic<ITargetPropertyError>(
  LogLevel.Error,
  "Duplicate property '{property}' in {type} target '{target}'"
);
const DIAG_MISSING_PROPERTY = new Diagnostic<ITargetPropertyError>(
  LogLevel.Error,
  "Missing required property '{property}' in {type} target '{target}'"
);
const DIAG_UNKNOWN_TARGET_TYPE = Diagnostic.Error<{ type: string; loc: ISourcePosition }>("Unknown target type '{type}'");
const DIAG_RULE_LOCAL_DUPLICATE = Diagnostic.Error<{ name: string; loc: ISourcePosition }>(
  "'{name}' is declared twice in this rule's block"
);
const DIAG_RULE_LOCAL_PARAMETER = Diagnostic.Error<{ name: string; loc: ISourcePosition }>(
  "'{name}' is the rule's parameter, so the block cannot declare it"
);
const DIAG_RULE_PARAMETER_PROPERTY = Diagnostic.Error<{ param: string; property: string; type: string; loc: ISourcePosition }>(
  "'{param}.{property}' reads a property '{type}' does not declare"
);
const DIAG_INVALID_REWRITE = new Diagnostic<{ detail: string; loc: ISourcePosition }>(LogLevel.Error, "Invalid rename: {detail}");
const DIAG_INVALID_MAP = new Diagnostic<{ detail: string; loc: ISourcePosition }>(LogLevel.Error, "Invalid map property: {detail}");
const DIAG_INVALID_SPLICE = new Diagnostic<{ detail: string; loc: ISourcePosition }>(LogLevel.Error, "Invalid splice: {detail}");
const DIAG_INVALID_COMMAND = new Diagnostic<{ detail: string; loc: ISourcePosition }>(LogLevel.Error, "Invalid command: {detail}");

/**
 * Check a target decl against its targetdef: each property is one the schema
 * declares (or the schema has a `*` entry), no key is written twice (a
 * property may be written again under another guard), each required property
 * is declared, and each value suits its property's type
 * ({@link validatePropertyShape}).
 *
 * What a splice supplies is checked when it is looked up: a key written after
 * a splice is no duplicate of one before it, and a target that splices is not
 * checked for required properties.
 *
 * @return true if valid, otherwise false, the errors written to `log`.
 */
export function validateTarget(decl: ITargetDecl, targetDef: ITargetDefDecl, log: Log): boolean {
  /* The keys as written, guard included, which must be unique; and the
   * properties declared, under any guard, which satisfy `required`. */
  const seen = new Set<string>();
  const declared = new Set<string>();
  let isValid = true;
  /* A `* = TYPE` entry admits any key the schema does not name (a `sync`'s
   * coordinates), typed by it. */
  const wildcard = targetDef.properties.get("*");

  let spliced = false;
  decl.properties.forEach(item => {
    if (!isPropertyDecl(item)) {
      spliced = true;
      seen.clear();
      const shape = spliceShapeError(item);
      if (shape !== undefined) {
        isValid = false;
        log.log(DIAG_INVALID_SPLICE, { detail: shape, loc: declPosn(item) });
      }
      return;
    }
    const prop = item;
    if (!targetDef.properties.has(prop.name.toBaseString()) && !wildcard) {
      isValid = false;
      log.log(DIAG_UNEXPECTED_PROPERTY, {
        loc: declPosn(prop),
        property: prop.name.toBaseString(),
        type: decl.type,
        target: declName(decl),
      });
    } else if (seen.has(prop.name.toString())) {
      isValid = false;
      log.log(DIAG_DUPLICATE_PROPERTY, {
        loc: declPosn(prop),
        property: prop.name.toBaseString(),
        type: decl.type,
        target: declName(decl),
      });
    } else {
      seen.add(prop.name.toString());
      declared.add(prop.name.toBaseString());
    }
  });
  targetDef.properties.forEach((value, key) => {
    if (key !== "*" && value.required && !declared.has(key) && !spliced) {
      isValid = false;
      log.log(DIAG_MISSING_PROPERTY, {
        loc: declPosn(decl),
        property: key,
        type: decl.type,
        target: declName(decl),
      });
    }
  });

  /* Check each value against its property's type (a key the schema does not
   * name takes the `*` entry's). */
  decl.properties.filter(isPropertyDecl).forEach(prop => {
    const type = (targetDef.properties.get(prop.name.toBaseString()) ?? wildcard)?.type;
    if (type === undefined) {
      return; /* already reported as unrecognized */
    }
    if (!validatePropertyShape(prop, type, log)) {
      isValid = false;
    }
  });

  return isValid;
}

/**
 * Check one property's values against its type `type`: a pipeline only in a
 * COMMAND property, a COMMAND property not empty, a `{ ... }` block only in a
 * MAP property, a MAP property's own rules ({@link validateMapProperty}), and
 * the REWRITE rules ({@link validateRenameValue}).
 *
 * @return true if valid, otherwise false, the errors written to `log`.
 */
export function validatePropertyShape(prop: IPropertyDecl, type: PropertyType, log: Log): boolean {
  let isValid = true;
  if (prop.values.some(value => isCommandValue(value))) {
    /* A pipeline (`a | b > c`) is valid only in a COMMAND property. */
    if (type !== PropertyType.Command) {
      log.log(DIAG_INVALID_COMMAND, {
        detail: "pipeline operators ('|', '<', '>', '2>', '&>') are only valid in a COMMAND property",
        loc: declPosn(prop),
      });
      isValid = false;
    }
  } else if (type === PropertyType.Command) {
    /* A COMMAND property with no operators is a single-stage command
     * (`run = astro build`), which needs only a value. */
    if (prop.values.length === 0) {
      log.log(DIAG_INVALID_COMMAND, { detail: "a command is required", loc: declPosn(prop) });
      isValid = false;
    }
  } else if (type === PropertyType.Map) {
    if (!validateMapProperty(prop, log)) {
      isValid = false;
    }
  } else if (!hasMapValue(prop)) {
    prop.values.forEach(value => {
      if (!validateRenameValue(prop, value, type, log)) {
        isValid = false;
      }
    });
  } else {
    /* A `{ ... }` block written for a non-MAP property. */
    log.log(DIAG_INVALID_MAP, { detail: "a `{ ... }` block is only valid for a MAP property", loc: declPosn(prop) });
    isValid = false;
  }
  return isValid;
}

/**
 * Check each `default` in a targetdef's schema against its property's type, as
 * a written property is checked, whether or not any target takes it.
 *
 * @return true if valid, otherwise false, the errors written to `log`.
 */
export function validateTargetDef(decl: ITargetDefDecl, log: Log): boolean {
  let isValid = true;
  decl.properties.forEach(schema => {
    if (schema.default && !validatePropertyShape(schema.default, schema.type, log)) {
      isValid = false;
    }
  });
  return isValid;
}

/**
 * Check a property declared outside any target (a global or a `default`),
 * which has no type: only a `{ ... }` block is checked, as a MAP property's
 * ({@link validateMapProperty}). A command value is not checked here: it may be
 * referenced into a target's COMMAND property, and where it is read elsewhere
 * that is reported when it is resolved.
 *
 * @return true if valid, otherwise false, the errors written to `log`.
 */
export function validateProperty(prop: IPropertyDecl, log: Log): boolean {
  if (hasMapValue(prop)) {
    return validateMapProperty(prop, log);
  }
  return true;
}

/** Check a MAP property: its value is one `{ ... }` block, checked by
 * {@link validateBlock}, or bare references to other MAP properties
 * (`metadata = SHARED;`), never several blocks and never a mix. */
function validateMapProperty(prop: IPropertyDecl, log: Log): boolean {
  if (!hasMapValue(prop)) {
    return true; /* reference form */
  }
  if (prop.values.length > 1) {
    const detail = prop.values.every(isMapValue)
      ? "a MAP property takes a single `{ ... }` block (merging is by reference: `metadata = BASE;`)"
      : "a MAP property is a single `{ ... }` block or bare reference(s), not a mix";
    log.log(DIAG_INVALID_MAP, { detail, loc: declPosn(prop) });
    return false;
  }
  const block = prop.values[0];
  return validateBlock(isMapValue(block) ? block.entries : [], log);
}

/** @return why `splice`'s reference is not a plain property name (a
 * projection, constraints, a rename or a glob), or undefined where it is one. */
function spliceShapeError(splice: ISpliceDecl): string | undefined {
  const ref = splice.ref;
  return ref.hasLevelSeparator() || ref.hasConstraints() || ref.getRenameTo() || ref.hasGlob()
    ? `a map reference is a plain property name ('${ref.toString()}')`
    : undefined;
}

/** Check a `{ ... }` block and every block nested in it: each key written
 * once per level (a splice's keys are not checked, and a key may override one
 * a splice brings), each entry's values all blocks or all strings, no
 * pipeline, no rename on a string value, and each splice's reference a plain
 * property name (no projection, constraints, rename or glob).
 *
 * @return true if valid, otherwise false, the errors written to `log`. */
function validateBlock(entries: IMapItemDecl[], log: Log): boolean {
  const fail = (detail: string, at: IMapItemDecl): boolean => {
    log.log(DIAG_INVALID_MAP, { detail, loc: declPosn(at) });
    return false;
  };
  let isValid = true;
  const keys = new Set<string>();
  entries.forEach(entry => {
    if (entry.kind === DeclKind.Splice) {
      const shape = spliceShapeError(entry);
      if (shape !== undefined) {
        isValid = fail(shape, entry);
      }
      return;
    }
    const key = entry.name.toBaseString();
    if (keys.has(key)) {
      isValid = fail(`duplicate map key '${key}'`, entry);
    }
    keys.add(key);
    const blocks = entry.values.filter(isMapValue);
    if (blocks.length > 0 && blocks.length < entry.values.length) {
      isValid = fail(`a map value is either strings or maps, not a mix (key '${key}')`, entry);
    }
    entry.values.forEach(value => {
      if (isCommandValue(value)) {
        /* A map holds only strings and maps. */
        isValid = fail(`a command (pipeline operators) is not valid in a map block (key '${entry.name}')`, entry);
      } else if (isMapValue(value)) {
        if (!validateBlock(value.entries, log)) {
          isValid = false;
        }
      } else if (isNameValue(value) && value.value.getRenameTo()) {
        isValid = fail(`a map value cannot carry a rename ('-> ') (key '${entry.name}')`, entry);
      }
    });
  });
  return isValid;
}

/**
 * Check one value of a REWRITE property: a value with no rename is a literal,
 * with no wildcards; a rename's selector has no `:` and no constraints. Every
 * other value passes; the parser checks a rename's own rules (wildcards and
 * their counts, the template).
 *
 * @return true if valid, otherwise false, the error written to `log`.
 */
function validateRenameValue(prop: IPropertyDecl, value: IValue, type: PropertyType, log: Log): boolean {
  if (!isNameValue(value) || type !== PropertyType.Rewrite) {
    return true; /* only a REWRITE property's names are checked here */
  }
  const name = value.value;

  const fail = (detail: string): boolean => {
    log.log(DIAG_INVALID_REWRITE, { detail, loc: declPosn(prop) });
    return false;
  };

  if (!name.getRenameTo()) {
    /* A bare REWRITE value is a literal: with no template, a wildcard fills nothing. */
    if (name.hasGlob()) {
      return fail("a bare REWRITE value must be a literal constant (no wildcards); add `-> template` to rename");
    }
    return true;
  }
  /* A REWRITE selector is a pattern, never a reference: no `:` and no
   * `<constraints>`. (A FILES value's selector is a projection, which may have
   * both.) */
  if (name.hasLevelSeparator()) {
    return fail("a REWRITE selector cannot contain ':'");
  }
  if (name.hasConstraints()) {
    return fail("a REWRITE selector cannot carry constraints");
  }
  return true;
}

/**
 * Check a rule's block: each target against its targetdef (`targetDefOf`), each
 * property as one outside a target ({@link validateProperty}), each name
 * declared once (a property may be written again under another guard) and none
 * the parameter's, and, where the rule has a type, each `<param>.<property>` it
 * reads against the type's targetdef.
 *
 * @return true if valid, otherwise false, the errors written to `log`.
 */
export function validateRuleBlock(
  rule: IRuleDecl,
  block: IRuleBlock,
  targetDefOf: (type: string) => ITargetDefDecl | undefined,
  log: Log
): boolean {
  let isValid = true;
  const fail = (): void => {
    isValid = false;
  };
  const kinds = new Map<string, DeclKind>();
  const declare = (name: string, kind: DeclKind, loc: ISourcePosition): void => {
    if (name === rule.param) {
      log.log(DIAG_RULE_LOCAL_PARAMETER, { name, loc });
      fail();
    } else if (kinds.has(name) && (kind === DeclKind.Target || kinds.get(name) === DeclKind.Target)) {
      log.log(DIAG_RULE_LOCAL_DUPLICATE, { name, loc });
      fail();
    }
    kinds.set(name, kind);
  };
  for (const target of block.targets) {
    declare(declName(target), DeclKind.Target, declPosn(target));
    const targetDef = targetDefOf(target.type);
    if (targetDef === undefined) {
      log.log(DIAG_UNKNOWN_TARGET_TYPE, { type: target.type, loc: { ...target.source, offset: target.typeOffset } });
      fail();
    } else if (!validateTarget(target, targetDef, log)) {
      fail();
    }
  }
  for (const prop of block.properties) {
    declare(declName(prop), DeclKind.Property, declPosn(prop));
    if (!validateProperty(prop, log)) {
      fail();
    }
  }
  const schema = rule.type === undefined ? undefined : targetDefOf(rule.type);
  if (schema !== undefined) {
    /* A splice reads only what the matched target has, so writes no name of its own to check. */
    const values = [
      block.result,
      ...[...block.properties, ...block.targets.flatMap(target => target.properties.filter(isPropertyDecl))].flatMap(writtenNames),
    ];
    for (const value of values) {
      /* The value read whole (`pkg.x`), and each `${pkg.x}` within it. */
      const read = [
        parameterProperty(value.value, rule.param),
        ...value.value
          .getSubstitutions()
          .filter(part => part.kind === NamePartKind.VarSubst)
          .map(part => parameterProperty(part.value, rule.param)),
      ];
      for (const property of new Set(read)) {
        if (property !== undefined && !schema.properties.has(property) && !schema.properties.has("*")) {
          log.log(DIAG_RULE_PARAMETER_PROPERTY, { param: rule.param, property, type: rule.type!, loc: declPosn(value) });
          fail();
        }
      }
    }
  }
  return isValid;
}

/** @return the names written as `prop`'s values: its plain values, and each command stage's command and arguments. */
function writtenNames(prop: IPropertyDecl): INameValue[] {
  return prop.values.flatMap((value): INameValue[] => {
    if (isNameValue(value)) {
      return [value];
    }
    if (isCommandValue(value)) {
      return value.pipeline.flatMap(stage => [stage.command, ...stage.args]);
    }
    return [];
  });
}
