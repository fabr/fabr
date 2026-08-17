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
import { runFabr, startFabrWatch, started, STUB_TSC, STUB_TSC_CONFIG } from "./harness";

/** Start lines only — see {@link started}. */
const TESTING_THING = started("Testing thing");

/*
 * Recorded test expectations end to end: `TEST_EXPECTATIONS`, the runner's
 * `--update-snapshots` flag, and `fabr test -u` writing refreshed records back
 * into the source tree.
 *
 * The fixture supplies its OWN runner rather than using fabr's jest flavour.
 * That is deliberate on two counts: it keeps these tests off the network (the
 * jest flavour's libraries are a real npm download), and it tests what is
 * actually fabr's half of the arrangement — the runner contract is swappable by
 * design, so a runner that merely honours it must get the same treatment. What
 * the fixture runner does is exactly what a real one does: write a CTRF report,
 * and, when asked to update, rewrite the recorded file beside the test.
 */
/* jest caps each test at `testTimeout` (30s); the fabr runner bounds tests
 * itself. Called as a BARE `jest`: under real jest the object is injected into
 * MODULE scope and is not on globalThis, so reaching it through globalThis was a
 * silent no-op — these suites have been running at 30s and only passing because
 * they finished in time. `@types/jest` rides the e2e target's deps, so the bare
 * name type-checks under the fabr compile too. */
jest.setTimeout(90000);

describe("e2e: recorded test expectations", () => {
  /** A runner honouring the contract: `--report=<file> --env=<name>
   * [--update-snapshots] <test files…>`, writing a green report, and under
   * `--update-snapshots` (re)writing each test's `__snapshots__/<file>.snap`. */
  const RUNNER = `const fs = require("fs"), path = require("path");
const args = process.argv.slice(2);
const report = args.find(a => a.startsWith("--report=")).slice("--report=".length);
const update = args.includes("--update-snapshots");
const files = args.filter(a => !a.startsWith("-"));
for (const file of files) {
  const dir = path.join(path.dirname(file), "__snapshots__");
  /* Locate the record by STEM, as a real runner must: it sees the compiled
   * 'thing.test.js' while the checked-in file is named for the source. */
  const stem = path.basename(file).replace(/\\.[^.]+$/, "");
  const existing = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    .find(n => n.endsWith(".snap") && n.slice(0, -5).replace(/\\.[^.]+$/, "") === stem);
  const snap = path.join(dir, existing || path.basename(file) + ".snap");
  const recorded = existing ? fs.readFileSync(snap, "utf8") : "";
  if (update) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(snap, "recorded: " + require(path.resolve(file)).value + "\\n");
  } else if (recorded.trim() !== "recorded: " + require(path.resolve(file)).value) {
    console.error("expectation mismatch for " + file + " (had " + JSON.stringify(recorded) + ")");
    fs.writeFileSync(report, JSON.stringify(reportOf(1)));
    process.exit(1);
  }
}
fs.writeFileSync(report, JSON.stringify(reportOf(0)));
function reportOf(failed) {
  const status = failed ? "failed" : "passed";
  return { results: { tool: { name: "fixture" }, summary:
    { tests: 1, passed: failed ? 0 : 1, failed, pending: 0, skipped: 0, other: 0, start: 0, stop: 1 },
    tests: [{ name: "records a value", status, duration: 1 }] } };
}
`;

  const project = (value: string, extra: Record<string, string> = {}, globals = ""): Record<string, string> => ({
    ...STUB_TSC,
    "PROJECT.fabr":
      "plugin @fabr-build/js;\n\n" +
      STUB_TSC_CONFIG +
      globals +
      "js_script fixture_runner { deps = runner:**; entry = runner:run.js; }\n" +
      "js_package thing {\n" +
      "  srcs = src:**/*.ts;\n" +
      "  tests = src:**/*.test.ts;\n" +
      /* The records are `expectations`, not `srcs`: they are what the tests
       * compare against and the only inputs -u may rewrite — never package
       * content, which is what listing them as sources made them. */
      "  test_expectations = src:**/__snapshots__/*.snap;\n" +
      "  test_runner = fixture_runner;\n" +
      "}\n",
    "runner/run.js": RUNNER,
    "src/thing.test.ts": `exports.value = ${JSON.stringify(value)};\n`,
    ...extra,
  });

  const SNAP = "src/__snapshots__/thing.test.ts.snap";

  it("selects the target's own test_runner", () => {
    /* The `test_runner` property, not the JS_TEST_RUNNER global: if it were
     * ignored, fabr's own runner would run the file and report no tests. */
    const result = runFabr(project("one", { [SNAP]: "recorded: one\n" }), ["-DJS_TARGET=es2020", "test", "thing"]);
    expect(result.status).to.equal(0);
    expect(result.stderr).to.contain("1 test passed");
  });

  it("fails when the recorded expectation no longer matches", () => {
    const result = runFabr(project("two", { [SNAP]: "recorded: one\n" }), ["-DJS_TARGET=es2020", "test", "thing"]);
    expect(result.status).to.not.equal(0);
    /* Rendered as a test outcome, like any other red run */
    expect(result.stderr).to.contain("1 of 1 test failed");
    expect(result.stderr).to.contain("records a value");
  });

  it("writes nothing back to the source tree without -u", () => {
    /* Double-gated: a check run neither asks the runner to update nor collects
     * anything to write, so the stale record survives a failed run untouched. */
    const result = runFabr(project("two", { [SNAP]: "recorded: one\n" }), ["-DJS_TARGET=es2020", "test", "thing"], [SNAP]);
    expect(result.status).to.not.equal(0);
    expect(result.files?.[SNAP]).to.equal("recorded: one\n");
  });

  it("updates the recorded expectation in the source tree under -u", () => {
    const result = runFabr(project("two", { [SNAP]: "recorded: one\n" }), ["-DJS_TARGET=es2020", "test", "-u", "thing"], [SNAP]);
    expect(result.status).to.equal(0);
    expect(result.files?.[SNAP]).to.equal("recorded: two\n");
    /* Reported per file, project-relative */
    expect(result.stderr).to.contain(`Updated ${SNAP}`);
  });

  it("honours a DECLARED `TEST_EXPECTATIONS = update;` the same as -u", () => {
    /* The property is an ordinary global, so the build-file spelling must mean
     * what the flag means — the pipeline reads the model's value, and the
     * driver's gate is the candidates' existence, not a re-read of the CLI. */
    const result = runFabr(
      project("two", { [SNAP]: "recorded: one\n" }, "TEST_EXPECTATIONS = update;\n\n"),
      ["-DJS_TARGET=es2020", "test", "thing"],
      [SNAP]
    );
    expect(result.status).to.equal(0);
    expect(result.files?.[SNAP]).to.equal("recorded: two\n");
    expect(result.stderr).to.contain(`Updated ${SNAP}`);
  });

  it("creates a record that did not exist, named for the SOURCE file", () => {
    /* The runner works in compiled names (`thing.test.js`) and necessarily emits
     * a new record under one; the write-back mapping — which is the side that
     * knows about sources — puts it back as `thing.test.ts.snap`. */
    const result = runFabr(project("fresh"), ["-DJS_TARGET=es2020", "test", "-u", "thing"], [SNAP]);
    expect(result.status).to.equal(0);
    expect(result.files?.[SNAP]).to.equal("recorded: fresh\n");
  });

  it("reports nothing when an update run changes no bytes", () => {
    /* An update run whose records already match is green and idempotent: the
     * candidates are still produced (they reconstruct from the cached result),
     * and the driver's changed-bytes check drops them. */
    const result = runFabr(project("same", { [SNAP]: "recorded: same\n" }), ["-DJS_TARGET=es2020", "test", "-u", "thing"], [SNAP]);
    expect(result.status).to.equal(0);
    expect(result.files?.[SNAP]).to.equal("recorded: same\n");
    expect(result.stderr).to.not.contain("Updated");
  });

  it("rejects -u on a command it means nothing for", () => {
    const result = runFabr(project("one"), ["build", "-u", "thing"]);
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.contain("is not valid for the 'build' command");
  });

  /* Under watch, applying a write-back edits a file the build is WATCHING, so
   * the write is an input change like any other and would rebuild on its own —
   * a wasted test cycle whose only outcome is to write the identical bytes
   * again. The echo is suppressed instead (see SourceFileSource's expected
   * changes), and the point of the second half of this test is that suppressing
   * it is not the same as calling the file up to date: a later real edit must
   * still pick the refreshed record up. */
  describe("under watch", () => {
    it("does not re-test because of its own write-back, but still re-tests on a real change", async () => {
      const session = startFabrWatch(project("one"), ["-DJS_TARGET=es2020", "test", "-u", "-w", "thing"]);
      try {
        await session.waitFor(TESTING_THING, { timeoutMs: 60000 });
        await session.waitFor("Updated " + SNAP, { timeoutMs: 60000 });
        await session.waitFor("Watching for changes", { timeoutMs: 60000 });
        /* The write landed and the watcher is live. Nothing further must happen
         * of its own accord — so give the quiet window (and then some) a chance
         * to produce the echo rebuild, and require that it did not. */
        await session.waitFor(TESTING_THING, { count: 2, timeoutMs: 3000 }).then(
          () => {
            throw new Error("the write-back triggered a rebuild:\n" + session.stderr);
          },
          () => undefined
        );

        /* A real edit still rebuilds — and the refreshed record is picked up
         * with it, so the run is green rather than failing against a stale one. */
        session.write("src/thing.test.ts", 'exports.value = "two";\n');
        await session.waitFor(TESTING_THING, { count: 2, timeoutMs: 60000 });
        await session.waitFor("Updated " + SNAP, { count: 2, timeoutMs: 60000 });
      } finally {
        await session.stop();
      }
    });
  });
});
