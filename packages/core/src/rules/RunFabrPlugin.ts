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
 * The `fabr_plugin` target as a program: its base package (`srcs`) installed
 * with its closure, for the host. This is what fabr loads the plugin's code
 * from.
 */

import { defineRule } from "./Types";

/** The `fabr_plugin` rule, under `run`. */
export default defineRule({
  evaluateResolved(context) {
    return context.getRunnableProperty("srcs");
  },
});
