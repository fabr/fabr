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
  IPropertyDecl,
  isCommandValue,
  isMapValue,
  isNameValue,
  IValue,
  ITargetDecl,
  ITargetDefDecl,
  PropertyType,
} from "./AST";
import { Diagnostic, ISourcePosition, Log, LogLevel } from "../support/Log";

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
const DIAG_INVALID_REWRITE = new Diagnostic<{ detail: string; loc: ISourcePosition }>(
  LogLevel.Error,
  "Invalid rename: {detail}"
);
const DIAG_INVALID_MAP = new Diagnostic<{ detail: string; loc: ISourcePosition }>(
  LogLevel.Error,
  "Invalid map property: {detail}"
);
const DIAG_INVALID_COMMAND = new Diagnostic<{ detail: string; loc: ISourcePosition }>(
  LogLevel.Error,
  "Invalid command: {detail}"
);

/**
 * Check that all properties in the target decl are
 *   a) known to the schema,
 *   b) do not have duplicates, and
 *   c) are not missing any required properties.
 *
 * Potentially value-range checks (if we have any) can also be done here iff the value is constant.
 *
 * @return true if validation succeeds, otherwise false (and errors are written to the log);
 */
export function validateTarget(decl: ITargetDecl, targetDef: ITargetDefDecl, log: Log): boolean {
  /* Keys as written — what must be unique — and the properties named at all,
   * which is what satisfies `required`. */
  const seen = new Set<string>();
  const declared = new Set<string>();
  let isValid = true;
  /* A `* = TYPE` entry in the targetdef admits any further keys — a target of this
   * type may carry members not named in the schema (a `sync`'s reference-keyed
   * coordinates), each typed by the wildcard. Without it, an unrecognized key
   * (including a reference key) is an error. */
  const wildcard = targetDef.properties.get("*");

  decl.properties.forEach(prop => {
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
      /* A property may be written more than once when its declarations are told
       * apart by their guards — so what must be unique is the key AS WRITTEN
       * (`toString`, guard included), while `required` is satisfied by any
       * declaration of the property (`toBaseString`): a guard makes a property
       * conditional, not absent. Hence the two sets. */
      seen.add(prop.name.toString());
      declared.add(prop.name.toBaseString());
    }
  });
  targetDef.properties.forEach((value, key) => {
    if (key !== "*" && value.required && !declared.has(key)) {
      isValid = false;
      log.log(DIAG_MISSING_PROPERTY, {
        loc: declPosn(decl),
        property: key,
        type: decl.type,
        target: declName(decl),
      });
    }
  });

  /* Per-value shape rules, checked here where the schema is known (a wildcard
   * member is typed by the `*` entry). */
  decl.properties.forEach(prop => {
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
 * The per-value shape rules for one property against its schema type — shared
 * by a written property ({@link validateTarget}) and a targetdef's own
 * `default` ({@link validateTargetDef}): block<->MAP agreement, command
 * placement, then either the MAP entry rules or the `sel -> tmpl` rename
 * primitive (REWRITE / templated FILES).
 */
function validatePropertyShape(prop: IPropertyDecl, type: PropertyType, log: Log): boolean {
  let isValid = true;
  if (prop.values.some(value => isCommandValue(value))) {
    /* A pipeline (`a | b > c`) parses to a command value (well-formedness
     * already a parse error). It is only meaningful in a COMMAND property — the
     * mirror of a `{...}` block being MAP-only. */
    if (type !== PropertyType.Command) {
      log.log(DIAG_INVALID_COMMAND, {
        detail: "pipeline operators ('|', '<', '>', '2>', '&>') are only valid in a COMMAND property",
        loc: declPosn(prop),
      });
      isValid = false;
    }
  } else if (type === PropertyType.Command) {
    /* A COMMAND property with no operators is a bare single-stage command
     * (`run = astro build`) — a non-empty value list is all it needs. */
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
 * Validate a targetdef's own schema: each property's `default` values are
 * checked against the declared type exactly as a written property's would be —
 * at load, whether or not any target ever takes the default (the same
 * discipline as a default target: declared ⇒ validated). Without this, a
 * malformed default surfaces only when some target omits the property, as a
 * resolution error far from the mistake.
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
 * Validate a schema-less property — a top-level/global or `default` property,
 * which has no targetdef to give it a type. Only the structural (type-independent)
 * rules apply: a `{ ... }` block validates as a map (its internals, and no
 * block/name mix). A plain name/reference list has nothing to check without a
 * schema — a rename's own rules read only the written name, so the parser has
 * already enforced them.
 *
 * A command value is deliberately NOT rejected here: a pipeline may be defined in
 * a standalone property and *referenced* into a target's COMMAND property (the
 * "chase"), so whether it lands in a COMMAND slot is only knowable at resolution
 * — an invalid placement is caught by the resolution-time backstop, not statically.
 *
 * @return true if validation succeeds, otherwise false (errors written to the log).
 */
export function validateProperty(prop: IPropertyDecl, log: Log): boolean {
  if (hasMapValue(prop)) {
    return validateMapProperty(prop, log);
  }
  return true;
}

/** Validate a MAP property. Its value is either one `{ ... }` block or bare
 * reference(s) to other block-valued properties (`metadata = SHARED;`, resolved
 * at read time), never a mix; a list of blocks at the top level is reserved for
 * the deferred extension syntax. An inline block validates recursively via
 * {@link validateBlock}. */
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

/** Recursively validate a `{ ... }` block: unique keys per level (literal
 * entries only — what a splice brings in is knowable only at read time, and
 * overriding a spliced key is the point); each entry's values homogeneous —
 * all blocks (a map, or a list of maps) or all strings — and string values
 * plain scalars (a rename facet is meaningless on a map value). A splice's
 * reference is a plain property name: no projection, constraints, rename, or
 * glob. Nested blocks validate to any depth. */
function validateBlock(entries: IMapItemDecl[], log: Log): boolean {
  const fail = (detail: string, at: IMapItemDecl): boolean => {
    log.log(DIAG_INVALID_MAP, { detail, loc: declPosn(at) });
    return false;
  };
  let isValid = true;
  const keys = new Set<string>();
  entries.forEach(entry => {
    if (entry.kind === DeclKind.MapSplice) {
      if (entry.ref.hasLevelSeparator() || entry.ref.hasConstraints() || entry.ref.getRenameTo() || entry.ref.hasGlob()) {
        isValid = fail(`a map reference is a plain property name ('${entry.ref.toString()}')`, entry);
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
        /* A `k = a | b;` inside a block parses to a command value; a map holds
         * only strings/maps, so pipeline operators are meaningless here. */
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
 * Validate a single property value's rename facet (if any) against its property
 * type; returns false and logs on a violation. Only the rules that NEED the
 * schema type live here — the rename's own well-formedness (`*`/`**` only and
 * equal wildcard counts unless the template is wildcard-free, no `:` in the
 * template) reads the written name alone and is enforced by the parser, for
 * every name including one no Validate pass sees.
 */
function validateRenameValue(prop: IPropertyDecl, value: IValue, type: PropertyType, log: Log): boolean {
  if (!isNameValue(value) || type !== PropertyType.Rewrite) {
    return true; /* a block is handled by the MAP path, never here */
  }
  const name = value.value;

  const fail = (detail: string): boolean => {
    log.log(DIAG_INVALID_REWRITE, { detail, loc: declPosn(prop) });
    return false;
  };

  if (!name.getRenameTo()) {
    /* A bare REWRITE value is a constant literal: a wildcard has no meaning
     * with no rename target to replay it into. */
    if (name.hasGlob()) {
      return fail("a bare REWRITE value must be a literal constant (no wildcards); add `-> template` to rename");
    }
    return true;
  }
  /* A REWRITE selector is a bare pattern (never a reference): no `:` and no
   * `<constraints>`. (A templated FILES value's selector is a real projection,
   * so its `:` and constraints are fine.) */
  if (name.hasLevelSeparator()) {
    return fail("a REWRITE selector cannot contain ':'");
  }
  if (name.hasConstraints()) {
    return fail("a REWRITE selector cannot carry constraints");
  }
  return true;
}
