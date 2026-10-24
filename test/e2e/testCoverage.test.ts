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

import { expect } from "chai";
import { runFabr, STUB_TSC, STUB_TSC_CONFIG } from "./harness";

/*
 * `fabr test --coverage` end to end: the measured run's V8 coverage, the driver
 * that converts it, and the CLI merging what each target delivers into one
 * `coverage/lcov.info`.
 *
 * The fixture supplies its own coverage driver, as testExpectations' supplies
 * its own runner: it keeps the suite off the network (the real driver's
 * libraries are an npm download) and checks fabr's half of the arrangement —
 * what is measured, that the test processes record, and what becomes of the
 * report. It writes one line per measured file, run if the raw V8 data names
 * that file.
 */
jest.setTimeout(90000);

describe("e2e: test coverage", () => {
  const RUNNER = `const fs = require("fs"), path = require("path");
const args = process.argv.slice(2);
const report = args.find(a => a.startsWith("--report=")).slice("--report=".length);
for (const file of args.filter(a => !a.startsWith("-"))) require(path.resolve(file));
fs.writeFileSync(report, JSON.stringify({ results: { tool: { name: "fixture" }, summary:
  { tests: 1, passed: 1, failed: 0, pending: 0, skipped: 0, other: 0, start: 0, stop: 1 },
  tests: [{ name: "loads", status: "passed", duration: 1 }] } }));
`;

  const CONVERTER = `const fs = require("fs"), path = require("path"), { pathToFileURL } = require("url");
const manifest = process.argv.find(a => a.startsWith("--manifest=")).slice("--manifest=".length);
const options = JSON.parse(fs.readFileSync(manifest, "utf8"));
const raw = fs.existsSync(options.raw) ? fs.readdirSync(options.raw).map(f => fs.readFileSync(path.join(options.raw, f), "utf8")).join("\\n") : "";
const out = [];
for (const measured of options.measured) {
  const map = JSON.parse(fs.readFileSync(measured + ".map", "utf8"));
  const ran = raw.includes(JSON.stringify(pathToFileURL(fs.realpathSync(measured)).href)) ? 1 : 0;
  out.push("TN:", "SF:" + map.sources[0].slice("fabr:".length), "DA:1," + ran, "end_of_record");
}
fs.writeFileSync(options.output, out.join("\\n") + "\\n");
`;

  const PROJECT = {
    ...STUB_TSC,
    "PROJECT.fabr":
      "plugin @fabr-build/js;\n\n" +
      STUB_TSC_CONFIG +
      "js_script fixture_runner { deps = runner:**; entry = runner:run.js; }\n" +
      "JS_NODE_TEST_RUNNER = fixture_runner;\n" +
      "js_script fixture_coverage { deps = coverage_driver:**; entry = coverage_driver:convert.js; }\n" +
      "JS_COVERAGE_DRIVER = fixture_coverage;\n" +
      "js_package lib { srcs = lib_src:**/*.ts; }\n" +
      "js_package thing { srcs = src:**/*.ts; tests = src:**/*.test.ts; deps = lib; }\n" +
      "js_package other { srcs = other_src:**/*.ts; tests = other_src:**/*.test.ts; deps = lib; }\n",
    "runner/run.js": RUNNER,
    "coverage_driver/convert.js": CONVERTER,
    "lib_src/lib.ts": "exports.value = 1;\n",
    "src/thing.ts": "exports.value = 2;\n",
    "src/thing.test.ts": 'require("./thing");\n',
    "other_src/other.ts": "exports.value = 3;\n",
    "other_src/other.test.ts": 'require("./other");\n',
  };

  const LCOV = "coverage/lcov.info";

  it("measures each target's sources and the packages built for it, merged into one report", () => {
    const result = runFabr(PROJECT, ["-DJS_TARGET=es2020", "test", "--coverage", "thing", "other"], [LCOV]);
    expect(result.status, result.stderr).to.equal(0);
    const lcov = result.files?.[LCOV] ?? "";
    /* What the tests loaded ran; the dependency nothing loaded is measured at
     * zero, once however many targets measured it; the tests are not measured. */
    /* Each record's source and its line counts. */
    const records = lcov
      .split("end_of_record")
      .filter(record => record.includes("SF:"))
      .map(record => [/SF:(.*)/.exec(record)![1], [...record.matchAll(/DA:(.*)/g)].map(match => match[1])]);
    expect(records).to.deep.equal([
      ["lib_src/lib.ts", ["1,0"]],
      ["other_src/other.ts", ["1,1"]],
      ["src/thing.ts", ["1,1"]],
    ]);
    expect(result.stderr).to.contain("Coverage: lines 66.67% (2/3), functions n/a, branches n/a");
    expect(result.stderr).to.contain(`Coverage report written to ${LCOV}`);
  });

  it("measures nothing without --coverage", () => {
    const result = runFabr(PROJECT, ["-DJS_TARGET=es2020", "test", "thing"], [LCOV]);
    expect(result.status, result.stderr).to.equal(0);
    expect(result.files?.[LCOV]).to.equal(undefined);
    expect(result.stderr).to.not.contain("Coverage:");
  });
});
