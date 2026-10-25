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
 * Where a test's recorded snapshots live: jest's own `snapshotResolver` hook, a
 * documented config option.
 *
 * The run works in COMPILED names (`Foo.test.js`) while the checked-in record
 * is named for the SOURCE (`Foo.test.tsx.snap`, jest's own convention). The
 * compiled file's own `.js.map` says which source it came from, so the record
 * is named from that — a NEW record is created source-named too, not just an
 * existing one matched.
 *
 * Without a map (a release build emits none) it falls back to finding an
 * existing record by **stem** — one readdir — and failing that to the compiled
 * name, which still matches on the next run.
 *
 * Loaded by jest-config from a path, so it must be a plain CommonJS module with
 * no dependency on fabr's *core* at runtime — another runner module is fine
 * (this one imports ../testRunner/Report).
 */

import * as path from "node:path";
import { SNAPSHOT_EXT, snapshotPathOf } from "../testRunner/Report";

/** Name the record for `testPath` for the SOURCE it was compiled from. */
export function resolveSnapshotPath(testPath: string): string {
  return snapshotPathOf(testPath);
}

/** Map a record back to the test it names — the record's name less `.snap`,
 * beside `__snapshots__` — for jest's consistency check. Only a compiled-named
 * record (the consistency check's sample) maps back to the compiled file. */
export function resolveTestPath(snapshotPath: string): string {
  const dir = path.dirname(path.dirname(snapshotPath));
  return path.join(dir, path.basename(snapshotPath, SNAPSHOT_EXT));
}

/** jest verifies the two functions above are mutual inverses using this sample.
 * It must therefore round-trip exactly, so it names a file with no record on
 * disk — the compiled-name branch, which is the invertible one. */
export const testPathForConsistencyCheck = path.join("consistency", "check.test.js");

/* jest reads a custom resolver as `interopRequireDefault(module).default`, so
 * the three members have to be reachable as a default export, not only as named
 * ones. */
export default { resolveSnapshotPath, resolveTestPath, testPathForConsistencyCheck };
