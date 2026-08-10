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
 * Where a test's recorded snapshots live. This is jest's own `snapshotResolver`
 * hook — a documented config option — which is exactly the seam fabr needs, so
 * the one wrinkle of compiling before running costs a config entry rather than
 * a patch.
 *
 * The wrinkle: the run works in COMPILED names (`Foo.test.js`) while the
 * checked-in record is named for the SOURCE (`Foo.test.tsx.snap`, jest's own
 * convention, ported untouched from an existing suite). The compiled file's own
 * `.js.map` says which source it came from, so the record is named from that —
 * a NEW record is created source-named too, not just an existing one matched.
 * That makes the name a function of the inputs rather than of what happens to be
 * on disk, and it is what lets everything downstream treat records as ordinary
 * source-named files.
 *
 * Without a map (a release build emits none) it falls back to finding an
 * existing record by **stem** — one readdir — and failing that to the compiled
 * name, which is the best available and still matches on the next run.
 *
 * Loaded by jest-config from a path, so it must be a plain CommonJS module with
 * no dependency on fabr's *core* at runtime — a sibling runner module is fine,
 * and is how runner.ts already reaches Report.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { sourcePathOf } from "../testRunner/Report";

/** Jest's fixed snapshot directory, beside the test file. */
const SNAPSHOT_DIR = "__snapshots__";
const SNAPSHOT_EXT = ".snap";

/** The record for `testPath`, named for the SOURCE it was compiled from. */
export function resolveSnapshotPath(testPath: string): string {
  const dir = path.join(path.dirname(testPath), SNAPSHOT_DIR);
  const source = sourcePathOf(testPath);
  if (source !== undefined) {
    return path.join(dir, path.basename(source) + SNAPSHOT_EXT);
  }
  /* No map to say what the source was called: an existing record still
   * identifies itself by stem, and a new one can only take the compiled name. */
  const stem = stemOf(path.basename(testPath));
  const existing = readdir(dir).find(name => name.endsWith(SNAPSHOT_EXT) && stemOf(name.slice(0, -SNAPSHOT_EXT.length)) === stem);
  return path.join(dir, existing ?? path.basename(testPath) + SNAPSHOT_EXT);
}

/** The inverse, which jest uses for its consistency check. The compiled name is
 * the one that always exists, so it is what we hand back. */
export function resolveTestPath(snapshotPath: string): string {
  const dir = path.dirname(path.dirname(snapshotPath));
  return path.join(dir, path.basename(snapshotPath, SNAPSHOT_EXT));
}

/** jest verifies the two functions above are mutual inverses using this sample.
 * It must therefore round-trip exactly, so it names a file with no record on
 * disk — the compiled-name branch, which is the invertible one. */
export const testPathForConsistencyCheck = path.join("consistency", "check.test.js");

/** A file's name with its final extension removed. */
function stemOf(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

function readdir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    /* No records for this file yet — the ordinary first-run case. */
    return [];
  }
}

/* jest reads a custom resolver as `interopRequireDefault(module).default`, so
 * the three members have to be reachable as a default export, not only as named
 * ones. */
export default { resolveSnapshotPath, resolveTestPath, testPathForConsistencyCheck };
