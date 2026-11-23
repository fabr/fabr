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
import type { IReportedTest } from "./PlaywrightRun";
import FabrReporter from "./Reporter";

/** A test that failed in one run, its screenshot attached from `attached`. */
function failedTest(attached: string): IReportedTest {
  return {
    titlePath: () => ["", "chromium", "a.spec.ts", "fails"],
    location: { file: path.join(process.cwd(), "a.spec.js") },
    outcome: () => "unexpected",
    results: [
      {
        status: "failed",
        duration: 1,
        errors: [{ message: "Error: expected 1" }],
        attachments: [{ name: "screenshot", contentType: "image/png", path: attached }],
      },
    ],
  };
}

describe("FabrReporter", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-reporter-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("reports the stop at maxFailures as no failure of its own, and keeps no worker's scratch directory", () => {
    const artifacts = path.join(dir, "artifacts");
    const scratch = path.join(artifacts, ".playwright-artifacts-0");
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(path.join(scratch, "shot.png"), "png");
    const report = path.join(dir, "report.json");
    const reporter = new FabrReporter({ report, files: [], named: true, artifacts });
    reporter.onBegin(undefined, { allTests: () => [failedTest(path.join(scratch, "shot.png"))] });
    reporter.onError({ message: "\u001b[31mTesting stopped early after 1 maximum allowed failures.\u001b[39m" });
    reporter.onEnd({ status: "failed" });
    const written = JSON.parse(fs.readFileSync(report, "utf8"));
    expect(written.results.summary).to.include({ tests: 1, failed: 1 });
    /* The screenshot is copied out of the scratch directory, which is then gone. */
    expect(written.results.tests[0].attachments).to.deep.equal([
      { name: "screenshot", contentType: "image/png", path: "attachments/0-shot.png" },
    ]);
    expect(fs.readdirSync(artifacts)).to.deep.equal(["attachments"]);
  });

  it("reports any other error outside a test as a failure", () => {
    const report = path.join(dir, "other.json");
    const reporter = new FabrReporter({ report, files: [], named: true });
    reporter.onBegin(undefined, { allTests: () => [] });
    reporter.onError({ message: "Error: globalSetup failed" });
    reporter.onEnd({ status: "failed" });
    expect(JSON.parse(fs.readFileSync(report, "utf8")).results.summary).to.include({ tests: 1, failed: 1 });
  });
});
