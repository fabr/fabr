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

/* Run real jest over the probes in the working directory, in band, always exiting 0. */
const { runCLI } = require("jest");
const root = process.cwd();
/* As jest's command line does. */
process.env.NODE_ENV ??= "test";
process.env.PROBE_FILE = require("path").join(root, "probes.txt");
require("fs").writeFileSync(process.env.PROBE_FILE, "");
const config = { rootDir: root, testEnvironment: "jsdom", testMatch: ["**/*.test.js"], testPathIgnorePatterns: ["/node_modules/"] };
runCLI(
  { _: [], $0: "jest", ci: true, json: true, outputFile: "results.json", runInBand: true, watchman: false, cache: false,
    config: JSON.stringify(config) },
  [root]
).then(
  () => exitAfterFlush(),
  error => { console.error(error); exitAfterFlush(); }
);
/* Exit once stdout, a pipe, has written everything. */
function exitAfterFlush() { process.stdout.write("END\n", () => process.exit(0)); }
