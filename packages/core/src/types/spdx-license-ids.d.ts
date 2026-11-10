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

/* Declarations for spdx-license-ids, which publishes the SPDX licence list's
 * identifiers as JSON arrays and no types. */
declare module "spdx-license-ids/index.json" {
  /** The current licence identifiers. */
  const ids: string[];
  export = ids;
}

declare module "spdx-license-ids/deprecated.json" {
  /** The identifiers the list deprecates, which remain valid identifiers. */
  const ids: string[];
  export = ids;
}
