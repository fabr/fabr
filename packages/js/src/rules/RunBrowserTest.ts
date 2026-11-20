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
 * The browser_test[run] rule: compile the target's tests and make the program
 * that runs them under the framework's own interactive run, in the target's
 * browser ({@link runBrowserTests}): `fabr run <target> [args…]` runs
 * `playwright test <args…>` or `cypress open <args…>` over the tests.
 */

import { defineRule } from "@fabr-build/core";
import { browserTestRequirements, runBrowserTests } from "../BrowserTest";

/** The `browser_test[run]` rule. */
export default defineRule({
  requirements: browserTestRequirements,
  evaluateMaterialized(context, collected) {
    return runBrowserTests(context, collected, true);
  },
});
