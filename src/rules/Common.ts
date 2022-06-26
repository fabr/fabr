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

import { PropertyType } from "./Types";

/**
 * Common target interface that language processors are expected to recognize and handle.
 */

export const BaseLanguageSchema = {
  properties: {
    srcs: { required: true, type: PropertyType.FileSet },
    deps: { type: PropertyType.FileSet },
    version: { type: PropertyType.String },
  },
  globals: {},
} as const;

/**
 * Common target interface that dependency resolvers are expected to recognize and handle.
 */

export const BaseDependencySchema = {
  properties: {},
  globals: {},
};
