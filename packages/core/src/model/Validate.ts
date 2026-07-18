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
  declPosn,
  hasBlockValue,
  IMapItemDecl,
  IPropertyDecl,
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
  const seen = new Set();
  let isValid = true;
  /* A `* = TYPE` entry in the targetdef admits any further keys — a target of this
   * type may carry members not named in the schema (a `sync`'s reference-keyed
   * coordinates), each typed by the wildcard. Without it, an unrecognized key
   * (including a reference key) is an error. */
  const wildcard = targetDef.properties["*"];

  decl.properties.forEach(prop => {
    if (!(prop.name in targetDef.properties) && !wildcard) {
      isValid = false;
      log.log(DIAG_UNEXPECTED_PROPERTY, {
        loc: declPosn(prop),
        property: prop.name,
        type: decl.type,
        target: decl.name,
      });
    } else if (seen.has(prop.name)) {
      isValid = false;
      log.log(DIAG_DUPLICATE_PROPERTY, {
        loc: declPosn(prop),
        property: prop.name,
        type: decl.type,
        target: decl.name,
      });
    } else {
      seen.add(prop.name);
    }
  });
  Object.entries(targetDef.properties).forEach(([key, value]) => {
    if (key !== "*" && value.required && !seen.has(key)) {
      isValid = false;
      log.log(DIAG_MISSING_PROPERTY, {
        loc: declPosn(decl),
        property: key,
        type: decl.type,
        target: decl.name,
      });
    }
  });

  /* Per-value shape rules, checked here where the schema is known (a wildcard
   * member is typed by the `*` entry): block<->MAP agreement, then either the MAP
   * entry rules or the `sel -> tmpl` rename primitive (REWRITE / templated FILES). */
  decl.properties.forEach(prop => {
    const type = (targetDef.properties[prop.name] ?? wildcard)?.type;
    if (type === undefined) {
      return; /* already reported as unrecognized */
    }
    if (type === PropertyType.Map) {
      if (!validateMapProperty(prop, log)) {
        isValid = false;
      }
    } else if (!hasBlockValue(prop)) {
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
  });

  return isValid;
}

/** Validate a MAP property. Its value is either one `{ ... }` block or bare
 * reference(s) to other block-valued properties (`metadata = SHARED;`, resolved
 * at read time), never a mix; a list of blocks at the top level is reserved for
 * the deferred extension syntax. An inline block validates recursively via
 * {@link validateBlock}. */
function validateMapProperty(prop: IPropertyDecl, log: Log): boolean {
  if (!hasBlockValue(prop)) {
    return true; /* reference form */
  }
  if (prop.values.length > 1) {
    const detail = prop.values.every(value => value.entries !== undefined)
      ? "a MAP property takes a single `{ ... }` block (merging is by reference: `metadata = BASE;`)"
      : "a MAP property is a single `{ ... }` block or bare reference(s), not a mix";
    log.log(DIAG_INVALID_MAP, { detail, loc: declPosn(prop) });
    return false;
  }
  return validateBlock(prop.values[0].entries ?? [], log);
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
    if (keys.has(entry.name)) {
      isValid = fail(`duplicate map key '${entry.name}'`, entry);
    }
    keys.add(entry.name);
    const blocks = entry.values.filter(value => value.entries !== undefined);
    if (blocks.length > 0 && blocks.length < entry.values.length) {
      isValid = fail(`a map value is either strings or maps, not a mix (key '${entry.name}')`, entry);
    }
    entry.values.forEach(value => {
      if (value.entries !== undefined) {
        if (!validateBlock(value.entries, log)) {
          isValid = false;
        }
      } else if (value.value.getRenameTo()) {
        isValid = fail(`a map value cannot carry a rename ('-> ') (key '${entry.name}')`, entry);
      }
    });
  });
  return isValid;
}

/** Validate a single property value's rename facet (if any) against its
 * property type; returns false and logs on a violation. */
function validateRenameValue(prop: IPropertyDecl, value: IValue, type: PropertyType, log: Log): boolean {
  const name = value.value;
  const isRewrite = type === PropertyType.Rewrite;
  const renameTo = name.getRenameTo();

  const fail = (detail: string): boolean => {
    log.log(DIAG_INVALID_REWRITE, { detail, loc: declPosn(prop) });
    return false;
  };

  if (!renameTo) {
    /* A bare REWRITE value is a constant literal: a wildcard has no meaning
     * with no rename target to replay it into. Other property types ignore a
     * plain value here. */
    if (isRewrite && name.hasGlob()) {
      return fail("a bare REWRITE value must be a literal constant (no wildcards); add `-> template` to rename");
    }
    return true;
  }

  /* A REWRITE selector is a bare pattern (never a reference): no `:` and no
   * `<constraints>`. (A templated FILES value's selector is a real projection,
   * so its `:` and delta are fine.) */
  if (isRewrite && name.hasLevelSeparator()) {
    return fail("a REWRITE selector cannot contain ':'");
  }
  if (isRewrite && name.hasConstraints()) {
    return fail("a REWRITE selector cannot carry constraints");
  }
  /* A rename template is a name pattern, never a reference. */
  if (renameTo.hasLevelSeparator()) {
    return fail("a rename template cannot contain ':'");
  }
  /* Only `*`/`**` capture-and-replay (picomatch captures `?`/`[...]`
   * inconsistently), so both sides are restricted to them, and their counts
   * must match for positional replay. */
  const selectorUnits = name.getGlobUnits();
  const templateUnits = renameTo.getGlobUnits();
  for (const unit of [...selectorUnits, ...templateUnits]) {
    if (unit !== "*" && unit !== "**") {
      return fail(`rename wildcards must be '*' or '**' (found '${unit}')`);
    }
  }
  if (selectorUnits.length !== templateUnits.length) {
    return fail(
      `selector and template must have equal wildcard counts (${selectorUnits.length} vs ${templateUnits.length})`
    );
  }
  return true;
}
