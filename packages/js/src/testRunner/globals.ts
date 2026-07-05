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
 * Test-globals shim, preloaded (--require) into every test process by the
 * runner: exposes node:test's describe/it family under the conventional
 * global names (including the jest-style beforeAll/afterAll aliases), typed
 * by test-globals.d.ts. Assertion libraries are not provided here — tests
 * import them explicitly from their test_deps. Tests that import describe/it
 * from node:test directly are unaffected (their imports shadow the globals).
 */

import * as nodeTest from "node:test";

const globals = globalThis as Record<string, unknown>;

globals.describe ??= nodeTest.describe;
globals.it ??= nodeTest.it;
globals.test ??= nodeTest.test;
globals.before ??= nodeTest.before;
globals.after ??= nodeTest.after;
globals.beforeEach ??= nodeTest.beforeEach;
globals.afterEach ??= nodeTest.afterEach;
globals.beforeAll ??= nodeTest.before;
globals.afterAll ??= nodeTest.after;
