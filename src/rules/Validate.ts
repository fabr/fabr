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

import { declPosn, ITargetDecl, ITargetDefDecl } from "../model/AST";
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
  "Missing required property '{property} in {type} ttarget '{target}'"
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

  decl.properties.forEach(prop => {
    if (!(prop.name in targetDef.properties)) {
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
    if (value.required && !seen.has(key)) {
      isValid = false;
      log.log(DIAG_MISSING_PROPERTY, {
        loc: declPosn(decl),
        property: key,
        type: decl.type,
        target: decl.name,
      });
    }
  });
  return isValid;
}
