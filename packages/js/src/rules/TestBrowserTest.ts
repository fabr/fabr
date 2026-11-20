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
 * The browser_test[test] rule: compile the target's tests and run them in its
 * browser ({@link runBrowserTests}).
 */

import { defineRule } from "@fabr-build/core";
import { browserTestRequirements, runBrowserTests } from "../BrowserTest";
import { describeTests, testFramework } from "../TestPipeline";

/** The `browser_test[test]` rule. */
export default defineRule({
  requirements: browserTestRequirements,
  /* Describe the tests for an editor as the compile the run makes. */
  describe(context, requirements) {
    return testFramework(context, "framework", true).then(framework =>
      describeTests(context, framework, { envProperty: "env", stabilityProperty: "stability" }, requirements)
    );
  },
  evaluateMaterialized(context, collected) {
    return runBrowserTests(context, collected, false);
  },
});
