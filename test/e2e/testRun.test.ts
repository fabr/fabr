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

/* `fabr test` end to end: compile a package's tests and run them under fabr's
 * own runner (sourced from the installed @fabr-build/js-tools — no runner
 * configuration, no npm), proving both outcomes through the real CLI. The fixture asserts with
 * node:assert so it needs no downloaded assertion library; the stub tsc copies
 * the type-free test verbatim. A red run must fail the command AND render the
 * failure as a test outcome, not a build error. */
/* jest caps each test at `testTimeout` (30s); the fabr runner bounds tests
 * itself. Called as a BARE `jest`: under real jest the object is injected into
 * MODULE scope and is not on globalThis. `@types/jest` rides the e2e target's
 * deps, so the bare name type-checks under the fabr compile too. */
jest.setTimeout(90000);

/** Make a file outside the project for each test to record that it ran in,
 * which the runs share, and how to read it: the names recorded since the last
 * read, sorted. */
function runMarker(): { marker: string; ran(): string[] } {
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fabr-e2e-marker-")), "ran");
  return {
    marker,
    ran: () => {
      const lines = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").split("\n").filter(Boolean).sort() : [];
      fs.rmSync(marker, { force: true });
      return lines;
    },
  };
}

describe("e2e: fabr test (runner from @fabr-build/js)", () => {
  const project = (body: string): Record<string, string> => ({
    ...STUB_TSC,
    "PROJECT.fabr":
      "plugin @fabr-build/js;\n\n" + STUB_TSC_CONFIG + "\njs_package thing { srcs = src:**/*.ts; tests = src:**/*.test.ts; }\n",
    "src/thing.test.ts": `const assert = require("node:assert");\n${body}\n`,
  });

  it("fails the command and reports the failing test when a test fails", () => {
    const result = runFabr(project('describe("thing", () => { it("fails on purpose", () => { assert.equal(1, 2); }); });'), [
      "-DJS_TARGET=es2020",
      "test",
      "thing",
    ]);
    expect(result.status).to.not.equal(0);
    /* rendered as a test outcome (name + message), not a build failure */
    expect(result.stderr).to.contain("test failed");
    expect(result.stderr).to.contain("fails on purpose");
  });

  it("writes a failing run's results with --report, as CTRF or JUnit, and still fails the command", () => {
    const files = project(
      'describe("thing", () => { it("holds", () => {}); it("fails on purpose", () => { assert.equal(1, 2); }); });'
    );
    const ctrf = runFabr(files, ["-DJS_TARGET=es2020", "test", "--report", "out/report.json", "thing"], ["out/report.json"]);
    expect(ctrf.status).to.not.equal(0);
    expect(ctrf.stderr).to.contain("fails on purpose");
    const report = JSON.parse(ctrf.files?.["out/report.json"] ?? "{}");
    expect(report.results.summary).to.include({ tests: 2, passed: 1, failed: 1 });

    const junit = runFabr(
      files,
      ["-DJS_TARGET=es2020", "test", "--report=out/junit.xml", "--format", "junit", "thing"],
      ["out/junit.xml"]
    );
    expect(junit.status).to.not.equal(0);
    const xml = junit.files?.["out/junit.xml"] ?? "";
    expect(xml).to.match(/<testsuites [^>]*tests="2" failures="1"/);
    expect(xml).to.match(/<testcase name="[^"]*fails on purpose"[^>]*>\s*<failure/);
    expect(xml).to.match(/<testcase name="[^"]*holds"[^>]*\/>/);
  });

  it("copies out a failing run's report, since the report is the run's result", () => {
    const result = runFabr(
      project('describe("thing", () => { it("fails on purpose", () => { assert.equal(1, 2); }); });'),
      ["-DJS_TARGET=es2020", "cp", "thing<BUILD_OPERATION=test>:ctrf-report.json", "out"],
      ["out/ctrf-report.json"]
    );
    expect(result.status, result.stderr).to.equal(0);
    expect(JSON.parse(result.files?.["out/ctrf-report.json"] ?? "{}").results.summary.failed).to.equal(1);
  });

  it("keeps a red run as its result, reported from the cache until --retry-failed runs its failed files again", () => {
    /* Unique to this run, so the first run is a miss whatever the shared cache holds. */
    const { marker, ran } = runMarker();
    const files = {
      ...STUB_TSC,
      "PROJECT.fabr":
        "plugin @fabr-build/js;\n\n" +
        STUB_TSC_CONFIG +
        `\njs_package thing {\n  srcs = src:**/*.ts;\n  tests = src:**/*.test.ts;\n  test_env = { MARKER = "${marker}"; }\n}\n`,
      "src/red.test.ts":
        'const assert = require("node:assert");\nrequire("fs").appendFileSync(process.env.MARKER, "red\\n");\n' +
        `describe("red", () => { it("fails on purpose ${process.pid}-${Date.now()}", () => { assert.equal(1, 2); }); });\n`,
      "src/green.test.ts":
        'require("fs").appendFileSync(process.env.MARKER, "green\\n");\ndescribe("green", () => { it("holds", () => {}); });\n',
    };
    const first = runFabr(files, ["-DJS_TARGET=es2020", "test", "thing"]);
    expect(first.status).to.not.equal(0);
    expect(first.stderr).to.contain("fails on purpose");
    expect(first.stderr, "the run is announced").to.match(/Testing thing/);
    expect(ran()).to.deep.equal(["green", "red"]);

    const cached = runFabr(files, ["-DJS_TARGET=es2020", "test", "thing"]);
    expect(cached.status, "the cached failure still fails the command").to.not.equal(0);
    expect(cached.stderr).to.contain("fails on purpose");
    expect(cached.stderr, "nothing is run").to.not.match(/^.*Testing thing.*\(\d/m);
    expect(ran()).to.deep.equal([]);

    const retried = runFabr(files, ["-DJS_TARGET=es2020", "test", "--retry-failed", "thing"]);
    expect(retried.status).to.not.equal(0);
    expect(retried.stderr, "the run is performed again, and marked as failed").to.match(/✗ Testing thing.*\(\d/);
    expect(ran(), "only the file that failed").to.deep.equal(["red"]);
  });

  it("runs again only the test files a change reaches", () => {
    /* Each test records that it ran in a file outside the project, which the
     * runs share; the sources are unique to this run, so the first is a miss. */
    const { marker, ran } = runMarker();
    const unique = `${process.pid}-${Date.now()}`;
    const files = (a: string): Record<string, string> => ({
      ...STUB_TSC,
      "PROJECT.fabr":
        "plugin @fabr-build/js;\n\n" +
        STUB_TSC_CONFIG +
        `\njs_package thing {\n  srcs = src:**/*.ts;\n  tests = src:**/*.test.ts;\n  test_env = { MARKER = "${marker}"; }\n}\n`,
      "src/a.ts": `exports.a = "${a}";\n`,
      "src/b.ts": `exports.b = "${unique}";\n`,
      "src/a.test.ts":
        'const { a } = require("./a");\nrequire("fs").appendFileSync(process.env.MARKER, "a\\n");\ndescribe("a", () => { it("is", () => {}); });\n',
      "src/b.test.ts":
        'const { b } = require("./b");\nrequire("fs").appendFileSync(process.env.MARKER, "b\\n");\ndescribe("b", () => { it("is", () => {}); });\n',
      /* What a process it starts reads is beyond any record, so it runs on every change. */
      "src/c.test.ts":
        'require("child_process").execFileSync(process.execPath, ["-e", ""]);\nrequire("fs").appendFileSync(process.env.MARKER, "c\\n");\ndescribe("c", () => { it("is", () => {}); });\n',
    });

    const first = runFabr(files(unique), ["-DJS_TARGET=es2020", "test", "thing"]);
    expect(first.status, first.stderr).to.equal(0);
    expect(ran()).to.deep.equal(["a", "b", "c"]);

    const edited = runFabr(files(`${unique}-edited`), ["-DJS_TARGET=es2020", "test", "thing"]);
    expect(edited.status, edited.stderr).to.equal(0);
    expect(edited.stderr, "the report covers every file").to.contain("3 tests passed");
    expect(ran(), "the test that loads the edited source, and the one whose reads are unknown").to.deep.equal(["a", "c"]);

    const again = runFabr(files(`${unique}-edited`), ["-DJS_TARGET=es2020", "test", "thing"]);
    expect(again.status).to.equal(0);
    expect(ran(), "an unchanged run runs nothing").to.deep.equal([]);
  });

  it("resolves the tests' packages through a PnP table under layout/pnp", () => {
    const result = runFabr(
      {
        ...STUB_TSC,
        "PROJECT.fabr":
          "plugin @fabr-build/js;\n\n" +
          STUB_TSC_CONFIG +
          "\njs_package lib { srcs = libsrc:**/*.ts; }\n" +
          "js_package thing {\n  srcs = src:**/*.ts;\n  tests = src:**/*.test.ts;\n  deps = lib;\n  test_deps = layout/pnp;\n}\n",
        "libsrc/index.ts": 'exports.greeting = "hello";\n',
        "src/a.ts": 'exports.a = require("lib").greeting;\n',
        "src/a.test.ts":
          'const assert = require("node:assert");\n' +
          'describe("a", () => { it("loads its dependency and its own package by name", () => {\n' +
          '  assert.equal(require("./a").a, "hello");\n' +
          '  assert.equal(require("thing/a").a, "hello");\n' +
          '  assert.equal(require("lib"), require("lib/index.js"), "one file is one module, however it is named");\n' +
          "}); });\n",
      },
      ["-DJS_TARGET=es2020", "test", "thing"]
    );
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stderr).to.contain("1 test passed");
  });

  it("runs again under layout/pnp only the test file that read a changed package", () => {
    const { marker, ran } = runMarker();
    const unique = `${process.pid}-${Date.now()}`;
    const files = (greeting: string): Record<string, string> => ({
      ...STUB_TSC,
      "PROJECT.fabr":
        "plugin @fabr-build/js;\n\n" +
        STUB_TSC_CONFIG +
        "\njs_package lib { srcs = libsrc:**/*.ts; }\n" +
        `js_package thing {\n  srcs = src:**/*.ts;\n  tests = src:**/*.test.ts;\n  deps = lib;\n  test_deps = layout/pnp;\n  test_env = { MARKER = "${marker}"; }\n}\n`,
      "libsrc/index.ts": `exports.greeting = "${greeting}";\n`,
      "src/a.test.ts":
        'require("lib");\nrequire("fs").appendFileSync(process.env.MARKER, "a\\n");\ndescribe("a", () => { it("is", () => {}); });\n',
      "src/b.test.ts": 'require("fs").appendFileSync(process.env.MARKER, "b\\n");\ndescribe("b", () => { it("is", () => {}); });\n',
    });
    expect(runFabr(files(unique), ["-DJS_TARGET=es2020", "test", "thing"]).status).to.equal(0);
    expect(ran()).to.deep.equal(["a", "b"]);
    const changed = runFabr(files(`${unique}-changed`), ["-DJS_TARGET=es2020", "test", "thing"]);
    expect(changed.status, changed.stderr).to.equal(0);
    /* `b` never loaded `lib`: the packages are keyed on what each file read,
     * under a PnP table as under a node_modules tree. */
    expect(ran(), "the file that read the changed package").to.deep.equal(["a"]);
  });

  for (const layout of ["node_modules", "pnp"]) {
    it(`serves a test run from the cache when a dependency changes only in files no test read (layout/${layout})`, () => {
      const { marker, ran } = runMarker();
      const unique = `${process.pid}-${Date.now()}`;
      const files = (other: string): Record<string, string> => ({
        ...STUB_TSC,
        "PROJECT.fabr":
          "plugin @fabr-build/js;\n\n" +
          STUB_TSC_CONFIG +
          "\njs_package lib { srcs = libsrc:**/*.ts; }\n" +
          `js_package thing {\n  srcs = src:**/*.ts;\n  tests = src:**/*.test.ts;\n  deps = lib;\n  test_deps = layout/${layout};\n  test_env = { MARKER = "${marker}"; }\n}\n`,
        "libsrc/index.ts": `exports.greeting = "${unique}";\n`,
        "libsrc/other.ts": `exports.other = "${other}";\n`,
        "src/a.test.ts":
          'require("lib");\nrequire("fs").appendFileSync(process.env.MARKER, "a\\n");\ndescribe("a", () => { it("is", () => {}); });\n',
      });
      expect(runFabr(files(unique), ["-DJS_TARGET=es2020", "test", "thing"]).status).to.equal(0);
      expect(ran()).to.deep.equal(["a"]);
      /* The package changed, in a file the test never loaded: the run's key
       * names what was read, so the entry stands and nothing runs. */
      const changed = runFabr(files(`${unique}-changed`), ["-DJS_TARGET=es2020", "test", "thing"]);
      expect(changed.status, changed.stderr).to.equal(0);
      expect(ran(), "no test read the changed file").to.deep.equal([]);
      expect(changed.stderr).to.contain("1 test passed");
    });
  }

  for (const layout of ["node_modules", "pnp"]) {
    it(`runs again a test that looked for a package it did not find, once the package is there (layout/${layout})`, () => {
      const { marker, ran } = runMarker();
      const unique = `${process.pid}-${Date.now()}`;
      const files = (withOpt: boolean): Record<string, string> => ({
        ...STUB_TSC,
        "PROJECT.fabr":
          "plugin @fabr-build/js;\n\n" +
          STUB_TSC_CONFIG +
          "\njs_package lib { srcs = libsrc:**/*.ts; }\n" +
          (withOpt ? "js_package opt { srcs = optsrc:**/*.ts; }\n" : "") +
          `js_package thing {\n  srcs = src:**/*.ts;\n  tests = src:**/*.test.ts;\n  deps = lib${withOpt ? " opt" : ""};\n  test_deps = layout/${layout};\n  test_env = { MARKER = "${marker}"; }\n}\n`,
        "libsrc/index.ts": `exports.greeting = "${unique}";\n`,
        "optsrc/index.ts": 'exports.v = "opt";\n',
        "src/a.test.ts":
          'require("lib");\nlet v; try { v = require("opt").v; } catch { v = "none"; }\n' +
          'require("fs").appendFileSync(process.env.MARKER, "a:" + v + "\\n");\ndescribe("a", () => { it("is", () => {}); });\n',
      });
      expect(runFabr(files(false), ["-DJS_TARGET=es2020", "test", "thing"]).status).to.equal(0);
      expect(ran()).to.deep.equal(["a:none"]);
      /* The lookup that found nothing is a row of the key, absent; the package
       * appearing makes it present. */
      const added = runFabr(files(true), ["-DJS_TARGET=es2020", "test", "thing"]);
      expect(added.status, added.stderr).to.equal(0);
      expect(ran(), "the test looked for the package").to.deep.equal(["a:opt"]);
    });
  }

  it("runs again a test that probed the tree for a package, once the package is there (layout/node_modules)", () => {
    const { marker, ran } = runMarker();
    const unique = `${process.pid}-${Date.now()}`;
    const files = (withOpt: boolean): Record<string, string> => ({
      ...STUB_TSC,
      "PROJECT.fabr":
        "plugin @fabr-build/js;\n\n" +
        STUB_TSC_CONFIG +
        "\njs_package lib { srcs = libsrc:**/*.ts; }\n" +
        (withOpt ? "js_package opt { srcs = optsrc:**/*.ts; }\n" : "") +
        `js_package thing {\n  srcs = src:**/*.ts;\n  tests = src:**/*.test.ts;\n  deps = lib${withOpt ? " opt" : ""};\n  test_env = { MARKER = "${marker}"; }\n}\n`,
      "libsrc/index.ts": `exports.greeting = "${unique}";\n`,
      "optsrc/index.ts": 'exports.v = "opt";\n',
      "src/a.test.ts":
        'const fs = require("fs"); const path = require("path");\n' +
        'const dir = path.join(__dirname, "..", "node_modules", "opt");\n' +
        'const present = fs.existsSync(dir) + ":" + fs.existsSync(path.join(dir, "package.json"));\n' +
        'fs.appendFileSync(process.env.MARKER, "a:" + present + "\\n");\ndescribe("a", () => { it("is", () => {}); });\n',
    });
    expect(runFabr(files(false), ["-DJS_TARGET=es2020", "test", "thing"]).status).to.equal(0);
    expect(ran()).to.deep.equal(["a:false:false"]);
    /* The probe of the package's directory and of its manifest are both the
     * package's presence, a row the package's appearance flips. */
    const added = runFabr(files(true), ["-DJS_TARGET=es2020", "test", "thing"]);
    expect(added.status, added.stderr).to.equal(0);
    expect(ran(), "the test probed for the package").to.deep.equal(["a:true:true"]);
  });

  it("keys a test on the whole input where a package it loaded was found through the tree's hidden links (layout/node_modules)", () => {
    /* `lib` requires `other` without declaring it: the tree's hidden links
     * answer from the whole closure, which no row can pin, so the run is keyed
     * on everything and a change nothing read still reruns it. */
    const { marker, ran } = runMarker();
    const unique = `${process.pid}-${Date.now()}`;
    const files = (unread: string): Record<string, string> => ({
      ...STUB_TSC,
      "PROJECT.fabr":
        "plugin @fabr-build/js;\n\n" +
        STUB_TSC_CONFIG +
        "\njs_package other { srcs = othersrc:**/*.ts; }\n" +
        "js_package mid { srcs = midsrc:**/*.ts; deps = other; }\n" +
        "js_package lib { srcs = libsrc:**/*.ts; deps = mid; }\n" +
        `js_package thing {\n  srcs = src:**/*.ts;\n  tests = src:**/*.test.ts;\n  deps = lib;\n  test_env = { MARKER = "${marker}"; }\n}\n`,
      "othersrc/index.ts": `exports.v = "${unique}";\n`,
      "othersrc/unread.ts": `exports.unread = "${unread}";\n`,
      "midsrc/index.ts": 'exports.v = require("other").v;\n',
      "libsrc/index.ts": 'exports.v = require("other").v;\n',
      "src/a.test.ts":
        'require("lib");\nrequire("fs").appendFileSync(process.env.MARKER, "a\\n");\ndescribe("a", () => { it("is", () => {}); });\n',
    });
    expect(runFabr(files(unique), ["-DJS_TARGET=es2020", "test", "thing"]).status).to.equal(0);
    expect(ran()).to.deep.equal(["a"]);
    const changed = runFabr(files(`${unique}-changed`), ["-DJS_TARGET=es2020", "test", "thing"]);
    expect(changed.status, changed.stderr).to.equal(0);
    expect(ran(), "keyed on the whole input").to.deep.equal(["a"]);
  });

  it("runs again under layout/pnp a test whose own file changed, where a package has a file of its name", () => {
    /* `lib` ships a `build/index.js` and a `package.json`, names the install
     * of the package under test holds too: neither may stand in for the
     * other's in what changed. */
    const { marker, ran } = runMarker();
    const unique = `${process.pid}-${Date.now()}`;
    const files = (own: string): Record<string, string> => ({
      ...STUB_TSC,
      "PROJECT.fabr":
        "plugin @fabr-build/js;\n\n" +
        STUB_TSC_CONFIG +
        "\njs_package lib { srcs = libsrc:**/*.ts; }\n" +
        `js_package thing {\n  srcs = src:**/*.ts;\n  tests = src:**/*.test.ts;\n  deps = lib;\n  test_deps = layout/pnp;\n  test_env = { MARKER = "${marker}"; }\n}\n`,
      "libsrc/build/index.ts": `exports.lib = "${unique}";\n`,
      "src/index.ts": `exports.own = "${own}";\n`,
      "src/a.test.ts":
        'require("./index");\nrequire("fs").appendFileSync(process.env.MARKER, "a\\n");\ndescribe("a", () => { it("is", () => {}); });\n',
    });
    expect(runFabr(files(unique), ["-DJS_TARGET=es2020", "test", "thing"]).status).to.equal(0);
    expect(ran()).to.deep.equal(["a"]);
    const edited = runFabr(files(`${unique}-edited`), ["-DJS_TARGET=es2020", "test", "thing"]);
    expect(edited.status, edited.stderr).to.equal(0);
    expect(ran(), "the test that loads the edited file").to.deep.equal(["a"]);
  });

  it("runs again a test that loads a dependency whose package.json alone changed", () => {
    /* `lib` stops exporting `./a`, a file it still ships: node reads the
     * `exports` of a `package.json` through no `fs` function. */
    const unique = `${process.pid}-${Date.now()}`;
    const files = (exported: string): Record<string, string> => ({
      ...STUB_TSC,
      "PROJECT.fabr":
        "plugin @fabr-build/js;\n\n" +
        STUB_TSC_CONFIG +
        `\njs_package lib { srcs = libsrc:**/*.ts; exports = libsrc:${exported}.ts; }\n` +
        "js_package thing {\n  srcs = src:**/*.ts;\n  tests = src:**/*.test.ts;\n  deps = lib;\n}\n",
      "libsrc/a.ts": `exports.v = "${unique}";\n`,
      "libsrc/b.ts": "exports.v = 2;\n",
      "src/a.test.ts": `const assert = require("node:assert");\ndescribe("a", () => { it("loads lib/a", () => { assert.equal(require("lib/a").v, "${unique}"); }); });\n`,
    });
    const first = runFabr(files("a"), ["-DJS_TARGET=es2020", "test", "thing"]);
    expect(first.status, first.stderr).to.equal(0);
    const unexported = runFabr(files("b"), ["-DJS_TARGET=es2020", "test", "thing"]);
    expect(unexported.status, "lib/a is no longer exported").to.not.equal(0);
    expect(unexported.stderr).to.contain("loads lib/a");
  });

  it("runs the tests under node where dom is only among the compile_deps", () => {
    for (const type of ["js_package", "js_test"]) {
      const result = runFabr(
        {
          ...STUB_TSC,
          "PROJECT.fabr":
            "plugin @fabr-build/js;\n\n" +
            STUB_TSC_CONFIG +
            (type === "js_package"
              ? "\njs_package thing { srcs = src:**/*.ts; tests = src:**/*.test.ts; compile_deps = dom; }\n"
              : "\njs_test thing { tests = src:**/*.test.ts; compile_deps = dom; }\n"),
          "src/thing.test.ts":
            'const assert = require("node:assert");\ndescribe("thing", () => { it("has no DOM", () => { assert.equal(typeof document, "undefined"); }); });\n',
        },
        ["-DJS_TARGET=es2020", "test", "thing"]
      );
      expect(result.status, `${type}: ${result.stderr}`).to.equal(0);
      expect(result.stderr).to.contain("1 test passed");
    }
  });

  it("reports WHY a test file could not be loaded, not just that it failed", () => {
    /* A file that throws while loading registers no tests, so node:test reports
     * it with no diagnosis of its own — its `cause` is the bare string "test
     * failed" — and streams the real error to the child's stderr. The runner
     * captures that and attaches it, or the user is told only "test failed". */
    const result = runFabr(
      {
        ...STUB_TSC,
        "PROJECT.fabr":
          "plugin @fabr-build/js;\n\n" + STUB_TSC_CONFIG + "\njs_package thing { srcs = src:**/*.ts; tests = src:**/*.test.ts; }\n",
        "src/thing.test.ts": 'require("./nonexistent-module");\ndescribe("thing", () => { it("never runs", () => {}); });\n',
      },
      ["-DJS_TARGET=es2020", "test", "thing"]
    );
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.contain("Cannot find module");
    expect(result.stderr).to.contain("nonexistent-module");
  });

  it("passes cleanly when the tests pass", () => {
    const result = runFabr(project('describe("thing", () => { it("holds", () => { assert.equal(1, 1); }); });'), [
      "-DJS_TARGET=es2020",
      "test",
      "thing",
    ]);
    expect(result.status).to.equal(0);
    expect(result.stderr).to.contain("1 test passed");
  });

  it("runs only the tests whose full names match -t, and fails where none does", () => {
    /* The unmatched test would fail, so a green run shows it was not run; the
     * pattern spans the suite and test names, joined by a space. */
    const files = project(
      'describe("dates", () => { it("parse iso", () => {}); it("format", () => { assert.equal(1, 2); }); });\n' +
        'describe("other", () => { it("parse", () => { assert.equal(1, 2); }); });'
    );
    const matched = runFabr(files, ["-DJS_TARGET=es2020", "test", "-t", "dates parse", "thing"]);
    expect(matched.status, matched.stderr).to.equal(0);
    expect(matched.stderr).to.contain("1 test passed (filtered)");
    const none = runFabr(files, ["-DJS_TARGET=es2020", "test", "-t", "nothing like it", "thing"]);
    expect(none.status).to.not.equal(0);
    expect(none.stderr).to.contain("No test's name matches the pattern 'nothing like it'");
  });

  it("runs the tests with the declared environment, and nothing else", () => {
    /* One fixture, both targetdefs: a js_package's `test_env` and a js_test's
     * `env`. Nothing of fabr's own environment arrives. */
    const test = (expected: string): string =>
      'const assert = require("node:assert");\n' +
      'describe("env", () => { it("sees its target\'s variables only", () => {\n' +
      `  assert.equal(process.env.GREETING, "${expected}");\n` +
      '  assert.equal(process.env.NODE_OPTIONS, "--max-old-space-size=512 --no-warnings");\n' +
      "  assert.equal(process.env.PATH, undefined);\n" +
      "}); });\n";
    const files = {
      ...STUB_TSC,
      "PROJECT.fabr":
        "plugin @fabr-build/js;\n\n" +
        STUB_TSC_CONFIG +
        "\njs_package thing {\n  srcs = src:**/*.ts;\n  tests = src:**/*.test.ts;\n" +
        '  test_env = { GREETING = hello; NODE_OPTIONS = "--max-old-space-size=512 --no-warnings"; }\n}\n' +
        "js_test standalone {\n  tests = it:**/*.test.ts;\n" +
        '  env = { GREETING = howdy; NODE_OPTIONS = "--max-old-space-size=512 --no-warnings"; }\n}\n',
      "src/thing.test.ts": test("hello"),
      "it/alone.test.ts": test("howdy"),
    };
    const result = runFabr(files, ["-DJS_TARGET=es2020", "test", "thing", "standalone"]);
    expect(result.stderr).to.contain("thing: 1 test passed");
    expect(result.stderr).to.contain("standalone: 1 test passed");
    expect(result.status).to.equal(0);
  });

  it("reports an invalid environment variable name at its entry", () => {
    const result = runFabr(
      {
        ...STUB_TSC,
        "PROJECT.fabr":
          "plugin @fabr-build/js;\n\n" +
          STUB_TSC_CONFIG +
          "\njs_test standalone {\n  tests = it:**/*.test.ts;\n  env = { 'A=B' = x; }\n}\n",
        "it/alone.test.ts": 'describe("x", () => { it("y", () => {}); });\n',
      },
      ["-DJS_TARGET=es2020", "test", "standalone"]
    );
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.contain("'A=B' is not a valid environment variable name");
  });

  it("stages a non-package resource dep at the install root for a test to read", () => {
    /* A loose resource dep (a .json tsc reads but never emits) is carried into
     * the test install at the root — next to the compiled tests — while packages
     * mount under node_modules, as RunJSScript does. */
    const result = runFabr(
      {
        ...STUB_TSC,
        "PROJECT.fabr":
          "plugin @fabr-build/js;\n\n" +
          STUB_TSC_CONFIG +
          "\njs_package thing { srcs = src:**/*.ts; tests = src:**/*.test.ts; deps = data:config.json; }\n",
        "src/thing.test.ts":
          'const assert = require("node:assert");\nconst cfg = require("./config.json");\n' +
          'describe("thing", () => { it("reads its resource dep", () => { assert.equal(cfg.answer, 42); }); });',
        "data/config.json": '{ "answer": 42 }\n',
      },
      ["-DJS_TARGET=es2020", "test", "thing"]
    );
    expect(result.status).to.equal(0);
    expect(result.stderr).to.contain("1 test passed");
  });

  it("stages the package's own resources where it ships them, for its tests to read", () => {
    /* The tests run against the package as it ships: a file it ships as it is
     * sits beside its compiled code, so a test reads it relative to itself. */
    const result = runFabr(
      {
        ...STUB_TSC,
        "PROJECT.fabr":
          "plugin @fabr-build/js;\n\n" +
          STUB_TSC_CONFIG +
          "\njs_package thing { srcs = src:**/*.ts; tests = src:**/*.test.ts; resources = src:**/*.txt; }\n",
        "src/sub/thing.test.ts":
          'const assert = require("node:assert");\nconst fs = require("node:fs");\nconst path = require("node:path");\n' +
          'describe("thing", () => { it("reads its shipped resource", () => { ' +
          'assert.equal(fs.readFileSync(path.join(__dirname, "../notes/readme.txt"), "utf8"), "shipped\\n"); }); });',
        "src/notes/readme.txt": "shipped\n",
      },
      ["-DJS_TARGET=es2020", "test", "thing"]
    );
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stderr).to.contain("1 test passed");
  });

  it("runs tests against a test-support package that depends on the package it supports", () => {
    /* The build reads test_deps only for the source files it names, so the
     * support package's dependency on `thing` is an edge of the test alone. */
    const files = {
      ...STUB_TSC,
      "PROJECT.fabr":
        "plugin @fabr-build/js;\n\n" +
        STUB_TSC_CONFIG +
        "\njs_package thing { srcs = ./thing/src:**/*.ts; tests = ./thing/src:**/*.test.ts; test_deps = thing_support; }\n" +
        "js_package thing_support { srcs = ./support/src:**/*.ts; deps = thing; }\n",
      "thing/src/index.ts": "exports.value = 1;\n",
      "support/src/index.ts": 'const { value } = require("thing");\nexports.helper = () => value + 1;\n',
      "thing/src/thing.test.ts":
        'const assert = require("node:assert");\nconst { helper } = require("thing_support");\n' +
        'describe("thing", () => { it("is helped", () => { assert.equal(helper(), 2); }); });',
    };
    const built = runFabr(files, ["-DJS_TARGET=es2020", "build", "thing"]);
    expect(built.status, built.stderr).to.equal(0);
    const tested = runFabr(files, ["-DJS_TARGET=es2020", "test", "thing"]);
    expect(tested.status, tested.stderr).to.equal(0);
    expect(tested.stderr).to.contain("1 test passed");
  });

  it("stubs stylesheet and binary imports under the node framework", () => {
    /* A stylesheet in the install is parsed as JavaScript by node's loader,
     * and one NOT in the install (the image) does not resolve at all; the
     * runner's preload makes both yield their stubs instead. The real css
     * pipeline is not involved: the stylesheet rides as a resource. */
    const result = runFabr(
      {
        ...STUB_TSC,
        "PROJECT.fabr":
          "plugin @fabr-build/js;\n\n" +
          STUB_TSC_CONFIG +
          "\njs_package thing { srcs = src:**/*.ts; tests = src:**/*.test.ts; test_resources = src:theme.css; }\n",
        "src/thing.test.ts":
          'const assert = require("node:assert");\nconst styles = require("./theme.css");\nconst logo = require("./logo.png");\n' +
          'describe("assets", () => { it("yield their stubs", () => { assert.equal(styles.title, "title"); assert.equal(logo, "logo.png"); }); });',
        "src/theme.css": ".title { color: red }\n",
      },
      ["-DJS_TARGET=es2020", "test", "thing"]
    );
    expect(result.status).to.equal(0);
    expect(result.stderr).to.contain("1 test passed");
  });

  it("survives ill-behaved test code: leaked handles don't hang, spawned processes are reaped", async () => {
    /* Adversarial test code, both ways it can hurt: (1) it leaks live handles
     * (an interval, a child's pipes) — without the runner's forceExit the
     * test-file process would idle forever and hang `fabr test` at the
     * stream-close wait; (2) it spawns a long-lived process and never kills it
     * — without the action-boundary group sweep, an orphan. The fixture test
     * PASSES, so no timeout/failure path is involved: good behavior is simply
     * never relied upon. The straggler's pid goes to a fixed temp path (the
     * runner gives tests a clean env and a staged cwd, so the project dir is
     * unreachable from inside). */
    const pidPath = "/tmp/fabr-e2e-straggler.pid";
    fs.rmSync(pidPath, { force: true });
    const body =
      'describe("thing", () => { it("misbehaves after passing", () => {' +
      "setInterval(() => undefined, 1000);" +
      'const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });' +
      `require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));` +
      "assert.equal(1, 1);" +
      "}); });";
    try {
      const result = runFabr(project(body), ["-DJS_TARGET=es2020", "test", "thing"]);
      /* (1) completed at all — no hang (a regression trips runFabr's 180s
       * SIGKILL cap into status -1) — and green: the test itself passed. */
      expect(result.status).to.equal(0);
      expect(result.stderr).to.contain("1 test passed");
      /* (2) the spawned straggler did not outlive the run. */
      const pid = Number(fs.readFileSync(pidPath, "utf8"));
      const deadline = Date.now() + 8000;
      let alive = true;
      while (alive && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 200));
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
      }
      expect(alive).to.equal(false);
    } finally {
      fs.rmSync(pidPath, { force: true });
    }
  });
  it("loads a conventional setupTests script into every test process", () => {
    /* The convention's whole contract: a `setupTests` at the root of the source
     * tree runs before the test file, with the runner's globals already
     * installed. A polyfill is the usual content — a browser API the
     * environment lacks — so the fixture asserts on exactly that shape. */
    const result = runFabr(
      {
        ...STUB_TSC,
        "PROJECT.fabr":
          "plugin @fabr-build/js;\n\n" + STUB_TSC_CONFIG + "\njs_package thing { srcs = src:**/*.ts; tests = src:**/*.test.ts; }\n",
        /* `describe` proves the runner's own globals are installed first. */
        "src/setupTests.ts": "globalThis.ranSetup = typeof describe;\nglobalThis.Polyfilled = class {};\n",
        "src/thing.test.ts":
          'const assert = require("node:assert");\n' +
          'describe("setup", () => { it("ran before the test file", () => {\n' +
          '  assert.equal(globalThis.ranSetup, "function");\n' +
          '  assert.equal(typeof globalThis.Polyfilled, "function");\n' +
          "}); });\n",
      },
      ["-DJS_TARGET=es2020", "test", "thing"]
    );
    expect(result.stderr).to.contain("1 test passed");
    expect(result.status).to.equal(0);
  });

  it("does not treat a nested setupTests as suite-wide setup", () => {
    /* Rooted, so an ordinary source that happens to be named this stays an
     * ordinary source — it is compiled and importable, but never preloaded. */
    const result = runFabr(
      {
        ...STUB_TSC,
        "PROJECT.fabr":
          "plugin @fabr-build/js;\n\n" + STUB_TSC_CONFIG + "\njs_package thing { srcs = src:**/*.ts; tests = src:**/*.test.ts; }\n",
        "src/helpers/setupTests.ts": "globalThis.ranSetup = true;\n",
        "src/thing.test.ts":
          'const assert = require("node:assert");\n' +
          'describe("setup", () => { it("did not run", () => {\n' +
          "  assert.equal(globalThis.ranSetup, undefined);\n" +
          "}); });\n",
      },
      ["-DJS_TARGET=es2020", "test", "thing"]
    );
    expect(result.stderr).to.contain("1 test passed");
    expect(result.status).to.equal(0);
  });

  it("reads a test's files as its results, and refuses to build it", () => {
    const files = {
      ...STUB_TSC,
      "PROJECT.fabr": "plugin @fabr-build/js;\n\n" + STUB_TSC_CONFIG + "\njs_test standalone {\n  tests = it:**/*.test.ts;\n}\n",
      "it/alone.test.ts":
        'const assert = require("node:assert");\ndescribe("x", () => { it("passes", () => { assert.ok(true); }); });\n',
    };
    const listed = runFabr(files, ["-DJS_TARGET=es2020", "ls", "standalone"]);
    expect(listed.status, listed.stderr).to.equal(0);
    expect(listed.stdout.split("\n")).to.include("ctrf-report.json");
    const built = runFabr(files, ["-DJS_TARGET=es2020", "build", "standalone"]);
    expect(built.status).not.to.equal(0);
    expect(built.stderr).to.contain("try 'fabr test standalone'");
  });
});
