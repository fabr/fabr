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

import { FabrError } from "../core/Errors";
import { parseJson, toJsonObject } from "./Json";

/**
 * Read the claims of `jwt`, its payload decoded without verifying its signature
 * (its recipient does that), naming the token as `what` in errors. An error
 * never quotes the token.
 */
export function jwtClaims(jwt: string, what: string): Record<string, unknown> {
  const payload = jwt.split(".")[1];
  if (payload === undefined) {
    throw new FabrError(`${what} is not a JWT`);
  }
  return parseJson(Buffer.from(payload, "base64url"), `payload of ${what}`, toJsonObject);
}
