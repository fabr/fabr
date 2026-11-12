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
 * The jest `snapshotResolver` naming where a test's snapshots are recorded.
 * Tests run under their compiled names (`Foo.test.js`) and a record is named
 * for the source (`__snapshots__/Foo.test.tsx.snap`), the source read from the
 * compiled file's `.js.map`, so a new record is source-named too. Without a
 * map, an existing record with the same stem is used, else the compiled name.
 *
 * jest-config loads this module by path: keep it plain CommonJS, with no
 * runtime dependency on fabr's core.
 */

import * as path from "node:path";
import { SNAPSHOT_EXT, snapshotPathOf } from "../testRunner/Report";

/** Get the snapshot file for the compiled test `testPath`. */
export function resolveSnapshotPath(testPath: string): string {
  return snapshotPathOf(testPath);
}

/** Get the test a snapshot file names: its name less `.snap`, in the directory
 * holding `__snapshots__`. Only a compiled-named record maps back to the
 * compiled test, which is all jest's consistency check needs. */
export function resolveTestPath(snapshotPath: string): string {
  const dir = path.dirname(path.dirname(snapshotPath));
  return path.join(dir, path.basename(snapshotPath, SNAPSHOT_EXT));
}

/** The sample jest round-trips through the two functions above. It names a
 * file with no map and no record, so it is named as compiled and maps back
 * exactly. */
export const testPathForConsistencyCheck = path.join("consistency", "check.test.js");

/* jest reads a custom resolver as `interopRequireDefault(module).default`. */
export default { resolveSnapshotPath, resolveTestPath, testPathForConsistencyCheck };
