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
import { framesOf, IReportedError, IReportedModule, IReportedTest, toRunFailure, toTestResults, vitestOptions } from "./VitestRun";

const ROOT = path.join(path.sep, "work", "build");

describe("vitestOptions", () => {
  const reporter = {};
  const options = (extra: object = {}): Record<string, unknown> =>
    vitestOptions({ report: "r.json", env: "node", update: false, setup: [], files: ["a.test.js", "sub/b.test.js"], ...extra }, ROOT, reporter);

  it("runs exactly the given files, from no config file, on node's own loader", () => {
    const made = options();
    expect(made.config).to.equal(false);
    expect(made.root).to.equal(ROOT);
    expect(made.include).to.deep.equal(["a.test.js", "sub/b.test.js"]);
    expect(made.experimental).to.deep.equal({ viteModuleRunner: false });
    expect(made.reporters).to.deep.equal([reporter]);
  });

  it("checks recorded snapshots strictly, and rewrites them only when updating", () => {
    expect(options().update).to.equal("none");
    expect(options({ update: true }).update).to.equal("all");
  });

  it("passes the environment through", () => {
    expect(options({ env: "jsdom" }).environment).to.equal("jsdom");
  });

  it("resolves a staged setup file against the installation, and leaves a module name alone", () => {
    expect(options({ setup: ["./setupTests.js", "some-module"] }).setupFiles).to.deep.equal([path.join(ROOT, "setupTests.js"), "some-module"]);
  });

  it("records a test file's snapshots beside it, under __snapshots__", () => {
    const resolve = options().resolveSnapshotPath as (testPath: string) => string;
    expect(resolve(path.join(ROOT, "a.test.js"))).to.equal(path.join(ROOT, "__snapshots__", "a.test.js.snap"));
  });
});

describe("toTestResults", () => {
  function test(fullName: string, state: string, extra: { errors?: IReportedError[]; mode?: string; duration?: number } = {}): IReportedTest {
    return {
      fullName,
      options: { mode: extra.mode },
      result: () => ({ state, errors: extra.errors }),
      diagnostic: () => (extra.duration === undefined ? undefined : { duration: extra.duration }),
    };
  }
  /* A compiled file in the install's `build/` mount: the runner is invoked
   * with that mount as its working directory, and names a file by its path
   * under it. */
  const COMPILED = path.join(path.dirname(process.cwd()), "build", "a.test.js");
  function moduleOf(tests: IReportedTest[], errors: IReportedError[] = []): IReportedModule {
    return { moduleId: COMPILED, errors: () => errors, children: { allTests: () => tests } };
  }

  it("reports each test under its full name, with its outcome and duration", () => {
    const results = toTestResults(moduleOf([test("suite > passes", "passed", { duration: 12 }), test("suite > skipped", "skipped")]));
    expect(results).to.deep.equal([
      { name: "suite > passes", filePath: "a.test.js", status: "passed", duration: 12 },
      { name: "suite > skipped", filePath: "a.test.js", status: "skipped", duration: 0 },
    ]);
  });

  it("reports a todo as pending, and a state it does not know as other", () => {
    const results = toTestResults(moduleOf([test("later", "skipped", { mode: "todo" }), test("odd", "queued")]));
    expect(results.map(result => result.status)).to.deep.equal(["pending", "other"]);
  });

  it("splits a failure into its first line and the rest, the difference included", () => {
    const error = { message: "expected 'a' to be 'b'\nmore", diff: "- b\n+ a", stack: "Error: expected\n    at node:internal/x:1:2" };
    const [result] = toTestResults(moduleOf([test("fails", "failed", { errors: [error] })]));
    expect(result.message).to.equal("expected 'a' to be 'b'");
    expect(result.trace).to.equal("more\n- b\n+ a");
  });

  it("names fabr's flag as the way to accept a changed snapshot", () => {
    const [result] = toTestResults(moduleOf([test("snaps", "failed", { errors: [{ message: "Snapshot `snaps 1` mismatched" }] })]));
    expect(result.message).to.equal("Snapshot `snaps 1` mismatched. Run 'fabr test -u' to record the new value.");
  });

  it("reports a file that failed to load as one failure of the file", () => {
    const results = toTestResults(moduleOf([], [{ message: "boom at load" }]));
    expect(results).to.deep.equal([{ name: "a.test.js", filePath: "a.test.js", status: "failed", duration: 0, message: "boom at load", trace: undefined }]);
  });

  it("reports a file that registered no tests as a failure, in its own words", () => {
    for (const errors of [[], [{ message: "No test suite found in file /work/build/a.test.js" }]]) {
      expect(toTestResults(moduleOf([], errors))[0].message).to.equal("This test file registered no tests");
    }
  });

  it("reports an error outside any test as a failure of the run", () => {
    expect(toRunFailure({ message: "unhandled rejection" })).to.deep.include({ status: "failed", message: "unhandled rejection" });
  });
});

describe("framesOf", () => {
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-vitest-frames-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("keeps only the frames in the code under test", () => {
    const own = path.join(dir, "a.test.js");
    const stack = [
      "Error: expected",
      `    at <anonymous> (${own}:3:7)`,
      `    at run (${path.join(dir, "node_modules", "vitest", "dist", "run.js")}:10:5)`,
      "    at new Promise (<anonymous>)",
      "    at ModuleJob.run (node:internal/modules/esm/module_job:437:25)",
    ].join("\n");
    const frames = framesOf(stack)?.split("\n") ?? [];
    expect(frames).to.have.length(1);
    expect(frames[0]).to.match(/^at <anonymous> \(.*a\.test\.js:3:7\)$/);
  });

  it("names the source position a compiled frame came from, through its source map", () => {
    const compiled = path.join(dir, "a.test.js");
    /* One mapping: generated line 1, column 0 -> source line 5, column 2. */
    fs.writeFileSync(`${compiled}.map`, JSON.stringify({ version: 3, sources: ["a.test.ts"], names: [], mappings: "AAIE" }));
    expect(framesOf(`Error\n    at file://${compiled}:1:1`)).to.match(/^at \(.*a\.test\.ts:5:3\)$/);
  });

  it("has nothing to say of a stack with no frame of the code under test", () => {
    expect(framesOf("Error: x\n    at new Promise (<anonymous>)")).to.equal(undefined);
    expect(framesOf(undefined)).to.equal(undefined);
  });
});
