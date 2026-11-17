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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
 * report. The module it prepares records the measured files a process loaded
 * (from `require.cache`), and it converts one line per measured file, run if
 * any process recorded it.
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

  const CONVERTER = `const fs = require("fs"), path = require("path");
const manifest = process.argv.find(a => a.startsWith("--manifest=")).slice("--manifest=".length);
const options = JSON.parse(fs.readFileSync(manifest, "utf8"));
const real = file => { try { return fs.realpathSync(file); } catch { return file; } };
if (options.kind === "prepare") {
  const table = path.resolve(options.table);
  fs.writeFileSync(table, JSON.stringify(Object.fromEntries([...options.measured].sort().reverse().map(f => [real(path.resolve(f)), f]))));
  fs.writeFileSync(options.preload, \`const fs = require("fs"), path = require("path");
process.on("exit", () => {
  const names = new Map(Object.entries(JSON.parse(fs.readFileSync(\${JSON.stringify(table)}, "utf8"))));
  const real = file => { try { return fs.realpathSync(file); } catch { return file; } };
  const result = Object.keys(require.cache).map(real).filter(f => names.has(f)).map(f => ({ url: names.get(f), functions: [] }));
  const dir = process.env.FABR_COVERAGE_DIR;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "coverage-" + process.pid + ".json"), JSON.stringify({ result }));
});
\`);
} else {
  const loaded = new Set(options.raw.filter(d => fs.existsSync(d))
    .flatMap(d => fs.readdirSync(d, { recursive: true }).filter(f => f.endsWith(".json")).map(f => path.join(d, f)))
    .flatMap(f => JSON.parse(fs.readFileSync(f, "utf8")).result)
    .map(script => script.url));
  const out = [];
  for (const measured of options.measured) {
    const map = JSON.parse(fs.readFileSync(real(path.resolve(measured)) + ".map", "utf8"));
    out.push("TN:", "SF:" + map.sources[0].slice("fabr:".length), "DA:1," + (loaded.has(measured) ? 1 : 0), "end_of_record");
  }
  fs.writeFileSync(options.output, out.join("\\n") + "\\n");
}
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
    expect(result.stderr).to.contain(`Coverage report written to ${path.join(LCOV)}`);
  });

  it("measures the packages built for a target under layout/pnp", () => {
    /* The node runner, which resolves through the PnP table; the fixture
     * runner does not. */
    const result = runFabr(
      {
        ...STUB_TSC,
        "PROJECT.fabr":
          "plugin @fabr-build/js;\n\n" +
          STUB_TSC_CONFIG +
          "js_script fixture_coverage { deps = coverage_driver:**; entry = coverage_driver:convert.js; }\n" +
          "JS_COVERAGE_DRIVER = fixture_coverage;\n" +
          "js_package lib { srcs = lib_src:**/*.ts; }\n" +
          "js_package thing { srcs = src:**/*.ts; tests = src:**/*.test.ts; deps = lib; test_deps = layout/pnp; }\n",
        "coverage_driver/convert.js": CONVERTER,
        "lib_src/index.ts": "exports.value = 1;\n",
        "lib_src/unused.ts": "exports.value = 0;\n",
        "src/thing.ts": 'exports.value = require("lib").value + 1;\n',
        "src/thing.test.ts": 'describe("thing", () => { it("loads", () => { require("./thing"); }); });\n',
      },
      ["-DJS_TARGET=es2020", "test", "--coverage", "thing"],
      [LCOV]
    );
    expect(result.status, result.stderr).to.equal(0);
    const records = (result.files?.[LCOV] ?? "")
      .split("end_of_record")
      .filter(record => record.includes("SF:"))
      .map(record => [/SF:(.*)/.exec(record)![1], [...record.matchAll(/DA:(.*)/g)].map(match => match[1])]);
    expect(records).to.deep.equal([
      ["lib_src/index.ts", ["1,1"]],
      ["lib_src/unused.ts", ["1,0"]],
      ["src/thing.ts", ["1,1"]],
    ]);
  });

  it("keeps a source a target generated under its source path", () => {
    const project = {
      ...PROJECT,
      "PROJECT.fabr":
        PROJECT["PROJECT.fabr"] +
        "js_script gen_tool { entry = ./gen.js; }\n" +
        "generate gen { run = gen_tool > made.ts; }\n" +
        "js_package made_thing { srcs = src:**/*.ts gen:made.ts; tests = src:**/*.test.ts; deps = lib; }\n",
      "gen.js": 'console.log("exports.made = 1;");\n',
    };
    const result = runFabr(project, ["-DJS_TARGET=es2020", "test", "--coverage", "made_thing"], [LCOV]);
    expect(result.status, result.stderr).to.equal(0);
    const sources = [...(result.files?.[LCOV] ?? "").matchAll(/SF:(.*)/g)].map(match => match[1]);
    expect(sources).to.deep.equal(["gen:made.ts", "lib_src/lib.ts", "src/thing.ts"]);
    expect(result.stderr).to.not.contain("out of the coverage report");
  });

  it("reports the coverage kept for the test files a measured run does not run again", () => {
    /* The node runner, which says what each test file read. Each test records
     * that it ran in a file outside the project; the sources are unique to
     * this run, so the first is a miss. */
    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fabr-e2e-coverage-")), "ran");
    const ran = (): string[] => {
      const lines = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").split("\n").filter(Boolean).sort() : [];
      fs.rmSync(marker, { force: true });
      return lines;
    };
    const unique = `${process.pid}-${Date.now()}`;
    const files = (a: string): Record<string, string> => ({
      ...STUB_TSC,
      "PROJECT.fabr":
        "plugin @fabr-build/js;\n\n" +
        STUB_TSC_CONFIG +
        "js_script fixture_coverage { deps = coverage_driver:**; entry = coverage_driver:convert.js; }\n" +
        "JS_COVERAGE_DRIVER = fixture_coverage;\n" +
        `js_package pair { srcs = src:**/*.ts; tests = src:**/*.test.ts; test_env = { MARKER = '${marker}'; } }\n`,
      "coverage_driver/convert.js": CONVERTER,
      "src/a.ts": `exports.a = "${a}";\n`,
      "src/b.ts": `exports.b = "${unique}";\n`,
      "src/a.test.ts":
        'require("./a");\nrequire("fs").appendFileSync(process.env.MARKER, "a\\n");\ndescribe("a", () => { it("is", () => {}); });\n',
      "src/b.test.ts":
        'require("./b");\nrequire("fs").appendFileSync(process.env.MARKER, "b\\n");\ndescribe("b", () => { it("is", () => {}); });\n',
    });
    const records = (lcov: string): string[][] =>
      lcov
        .split("end_of_record")
        .filter(record => record.includes("SF:"))
        .map(record => [/SF:(.*)/.exec(record)![1], ...[...record.matchAll(/DA:(.*)/g)].map(match => match[1])]);

    const first = runFabr(files(unique), ["-DJS_TARGET=es2020", "test", "--coverage", "pair"], [LCOV]);
    expect(first.status, first.stderr).to.equal(0);
    expect(ran()).to.deep.equal(["a", "b"]);
    expect(records(first.files?.[LCOV] ?? "")).to.deep.equal([
      ["src/a.ts", "1,1"],
      ["src/b.ts", "1,1"],
    ]);

    const edited = runFabr(files(`${unique}-edited`), ["-DJS_TARGET=es2020", "test", "--coverage", "pair"], [LCOV]);
    expect(edited.status, edited.stderr).to.equal(0);
    expect(ran(), "only the test that loads the edited source").to.deep.equal(["a"]);
    expect(records(edited.files?.[LCOV] ?? ""), "b's coverage is its kept run's").to.deep.equal([
      ["src/a.ts", "1,1"],
      ["src/b.ts", "1,1"],
    ]);
  });

  it("measures nothing without --coverage", () => {
    const result = runFabr(PROJECT, ["-DJS_TARGET=es2020", "test", "thing"], [LCOV]);
    expect(result.status, result.stderr).to.equal(0);
    expect(result.files?.[LCOV]).to.equal(undefined);
    expect(result.stderr).to.not.contain("Coverage:");
  });
});
