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
 * The native runner's preload, required into every test process: installs
 * node:test's describe/it family as globals (with jest's beforeAll/afterAll
 * names for before/after), typed by test-globals.d.ts, without replacing a
 * global already defined. Tests import their assertion libraries themselves.
 *
 * Also places node:test's recorded snapshots (`t.assert.snapshot`) at
 * snapshotPathOf's path, and makes stylesheet and binary imports yield their
 * stubs (see Assets).
 */

import * as nodeTest from "node:test";
import { installAssetHooks } from "./Assets";
import { snapshotPathOf } from "./Report";

installAssetHooks();

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

/* `snapshot` is absent before node 22.3, which has no snapshot assertions. */
(
  nodeTest as { snapshot?: { setResolveSnapshotPath(fn: (testPath: string | undefined) => string | undefined): void } }
).snapshot?.setResolveSnapshotPath(testPath => (testPath === undefined ? undefined : snapshotPathOf(testPath)));
