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
 * fabr's Playwright reporter, which the invocation's config names as its only
 * reporter: it writes the CTRF report when the run ends, and passes what the
 * tests print to this process's own output.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ITestResult } from "@fabr-build/core";
import { buildReport } from "../testRunner/Report";
import { IReportedError, IReportedResult, IReportedTest, reportedRunOf, toRunFailure, toTestResult } from "./PlaywrightRun";

/** The options the invocation's config gives the reporter. */
export interface IReporterOptions {
  /** Where to write the report. */
  report: string;
  /** The invocation's test files. An error outside any test is named for the
   * file where there is exactly one. */
  files: string[];
  /** Whether tests are selected by name, so that a run of none is no failure. */
  named: boolean;
  /** The invocation's test files no project of the config runs. */
  unmatched?: string[];
  /** Where to keep the files the tests' runs attached, if anywhere: each
   * result's attachments are then named within it. */
  artifacts?: string;
}

/** The root suite, as Playwright's reporter interface presents it. */
interface IReportedSuite {
  allTests(): IReportedTest[];
}

/** fabr's Playwright reporter. */
export default class FabrReporter {
  private suite?: IReportedSuite;
  private readonly errors: IReportedError[] = [];
  private readonly start = Date.now();
  /** How many attachments have been copied or written into the artifacts directory, naming each apart. */
  private placed = 0;

  constructor(private readonly options: IReporterOptions) {}

  /** @return true: the tests' output is passed through, so Playwright adds no reporter of its own. */
  public printsToStdio(): boolean {
    return true;
  }

  public onBegin(_config: unknown, suite: IReportedSuite): void {
    this.suite = suite;
  }

  public onStdOut(chunk: string | Buffer): void {
    process.stdout.write(chunk);
  }

  public onStdErr(chunk: string | Buffer): void {
    process.stderr.write(chunk);
  }

  public onError(error: IReportedError): void {
    this.errors.push(error);
  }

  /**
   * Write the report: a result per test, and a failure for each error raised
   * outside every test, for each file no project of the config runs, for each
   * file where the run registered no tests and none are selected by name, and
   * for a run that did not pass where nothing else failed.
   */
  public onEnd(result: { status: string }): void {
    const { files, named, unmatched = [] } = this.options;
    const file = files.length === 1 ? files[0] : undefined;
    const tests: ITestResult[] = (this.suite?.allTests() ?? []).map(test =>
      this.withAttachments(toTestResult(test), reportedRunOf(test))
    );
    tests.push(...this.errors.map(error => toRunFailure(error, file)));
    tests.push(...unmatched.map(each => toRunFailure({ message: "No project of the Playwright config runs this test file" }, each)));
    if (tests.length === 0 && !named) {
      tests.push(...files.map(each => toRunFailure({ message: "This test file registered no tests" }, each)));
    }
    if (result.status !== "passed" && !tests.some(test => test.status === "failed")) {
      tests.push(toRunFailure({ message: `The run ended ${result.status}` }, file));
    }
    fs.writeFileSync(this.options.report, JSON.stringify(buildReport(tests, this.start, Date.now()), undefined, 2));
  }

  /**
   * @return `result` with the attachments of `run` (the run it reports) kept
   * in the artifacts directory, each named within it: a file already there as
   * it is, a file elsewhere copied in, and one held in memory written there. A
   * file that no longer exists (Playwright removes what it does not retain) is
   * left out. Unchanged where there is no artifacts directory.
   */
  private withAttachments(result: ITestResult, run: IReportedResult | undefined): ITestResult {
    const dir = this.options.artifacts;
    if (dir === undefined || run?.attachments === undefined) {
      return result;
    }
    const attachments = run.attachments.flatMap(attachment => {
      const kept = this.keep(dir, attachment);
      return kept === undefined ? [] : [{ name: attachment.name, contentType: attachment.contentType, path: kept }];
    });
    return attachments.length === 0 ? result : { ...result, attachments };
  }

  /** Keep one attachment in `dir`. @return its path within `dir`, `/`-separated; undefined where its file is gone or it has no content. */
  private keep(dir: string, attachment: { name: string; path?: string; body?: Buffer }): string | undefined {
    if (attachment.path !== undefined) {
      if (!fs.existsSync(attachment.path)) {
        return undefined;
      }
      const within = path.relative(dir, attachment.path);
      if (!within.startsWith("..") && !path.isAbsolute(within)) {
        return within.split(path.sep).join("/");
      }
      const copied = path.join("attachments", `${this.placed++}-${path.basename(attachment.path)}`);
      fs.mkdirSync(path.join(dir, "attachments"), { recursive: true });
      fs.copyFileSync(attachment.path, path.join(dir, copied));
      return copied.split(path.sep).join("/");
    }
    if (attachment.body === undefined) {
      return undefined;
    }
    const written = path.join("attachments", `${this.placed++}-${attachment.name.replace(/[^\w.-]+/g, "_")}`);
    fs.mkdirSync(path.join(dir, "attachments"), { recursive: true });
    fs.writeFileSync(path.join(dir, written), attachment.body);
    return written.split(path.sep).join("/");
  }
}
