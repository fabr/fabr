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
import FabrReporter from "./Reporter";
import { projectConfiguration } from "./runner";
import {
  DEFAULT_TEST_MATCH,
  describeErrors,
  FilePattern,
  IInvocation,
  IReportedTest,
  toTestResult,
  withReportedFile,
  wrapConfig,
} from "./PlaywrightRun";

const root = path.resolve("/work/build");
const at = (name: string): string => path.join(root, name);

/** A stand-in for Playwright's matcher: a regular expression as it is, its
 * default glob, and `**`/`*` globs over `/`-separated paths. */
function matcher(patterns: FilePattern): (file: string) => boolean {
  const list = (Array.isArray(patterns) ? patterns : [patterns]) as Array<string | RegExp>;
  const res = list.map(pattern => {
    if (pattern instanceof RegExp) {
      return pattern;
    }
    if (pattern === DEFAULT_TEST_MATCH) {
      return /\.(spec|test)\.[cm]?[jt]sx?$/;
    }
    const glob = pattern
      .replace(/^\*\*\//, "")
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*\//g, "(.*/)?")
      .replace(/\*/g, "[^/]*");
    return new RegExp(`(^|/)${glob}$`);
  });
  return file => res.some(re => re.test(file.split(path.sep).join("/")));
}

/** Make an invocation of `files`, the compiled tree holding `present`. */
function invocation(files: string[], present: string[] = files, extra: Partial<IInvocation> = {}): IInvocation {
  return {
    configDir: root,
    files: files.map(at),
    /* The sources are TypeScript, beside where they compiled to. */
    sourceOf: file => file.replace(/\.js$/, ".ts"),
    matcher,
    exists: file => present.map(at).includes(file),
    outputDir: "/work/.fabr-playwright/r",
    update: false,
    retries: 0,
    reporter: ["/runner/Reporter.js", { report: "r.json" }],
    ...extra,
  };
}

describe("wrapConfig", () => {
  const desktop = { name: "desktop", browser: "chromium", executable: "/pool/chrome150/chrome", use: {} };

  it("runs the invocation's files the config selects, matched as their sources, in one project", () => {
    const config = wrapConfig(
      { testDir: "./tests", testIgnore: "**/api/**" },
      invocation(["tests/ui/home.spec.js", "tests/api/x.spec.js"], undefined, { configuration: desktop })
    );
    expect(config.projects?.map(project => project.name)).to.deep.equal(["desktop"]);
    expect(config.projects?.[0].testMatch).to.deep.equal([
      new RegExp(`^${at("tests/ui/home.spec.js").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
    ]);
    expect(config.projects?.[0].testDir).to.equal(at("tests"));
    /* The config's own worker count stands: Playwright schedules the run's files across its workers. */
    expect(config.workers).to.equal(undefined);
    expect(config.reporter).to.deep.equal([["/runner/Reporter.js", { report: "r.json", unmatched: [at("tests/api/x.spec.js")] }]]);
    expect(config.updateSnapshots).to.equal("none");
  });

  it("runs no project where the config selects none of the files", () => {
    const config = wrapConfig({ testIgnore: "**/skip.spec.ts" }, invocation(["tests/skip.spec.js"]));
    expect(config.projects).to.deep.equal([]);
    expect(config.reporter).to.deep.equal([["/runner/Reporter.js", { report: "r.json", unmatched: [at("tests/skip.spec.js")] }]]);
  });

  it("makes its project of the browser configuration, its executable the browser fabr fetched", () => {
    const config = wrapConfig(
      { use: { launchOptions: { slowMo: 5 } } },
      invocation(["a.spec.js"], undefined, {
        configuration: {
          name: "mobile",
          browser: "webkit",
          executable: "/pool/webkit/run",
          use: { viewport: { width: 390, height: 844 }, isMobile: true },
        },
      })
    );
    expect(config.projects?.[0].use).to.deep.equal({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      browserName: "webkit",
      launchOptions: { slowMo: 5, executablePath: "/pool/webkit/run" },
    });
    /* The config's own `use` is left as written. */
    expect(config.use).to.deep.equal({ launchOptions: { slowMo: 5 } });
  });

  it("refuses a config defining projects of its own", () => {
    expect(() =>
      wrapConfig({ projects: [{ name: "setup" }] }, invocation(["a.spec.js"], undefined, { configuration: desktop }))
    ).to.throw(/The Playwright config defines projects, and a browser_test is one/);
  });

  it("sets the URL, retries and snapshot updating, and no grep of its own", () => {
    const config = wrapConfig(
      { use: { trace: "on" }, retries: 3 },
      invocation(["a.spec.js"], undefined, { baseURL: "https://example.test", update: true, retries: 2, configuration: desktop })
    );
    expect(config.use).to.deep.equal({ trace: "on", baseURL: "https://example.test" });
    expect(config.projects?.[0].use?.baseURL).to.equal("https://example.test");
    /* A name pattern is Playwright's command-line `--grep`. */
    expect(config.grep).to.equal(undefined);
    expect([config.retries, config.projects?.[0].retries]).to.deep.equal([2, 2]);
    expect(config.updateSnapshots).to.equal("changed");
  });

  it("keeps the config's own reporters and snapshot updating for an invocation with no reporter of fabr's", () => {
    const config = wrapConfig(
      { reporter: "html", updateSnapshots: "all" },
      invocation(["a.spec.js"], undefined, { reporter: undefined, update: undefined, configuration: desktop })
    );
    expect([config.reporter, config.updateSnapshots]).to.deep.equal(["html", "all"]);
    expect(config.projects?.map(project => project.name)).to.deep.equal(["desktop"]);
  });

  it("starts the invocation's workers where the config sets none, and the config's where it does", () => {
    expect(wrapConfig({}, invocation(["a.spec.js"], undefined, { workers: 3 })).workers).to.equal(3);
    expect(wrapConfig({ workers: "50%" }, invocation(["a.spec.js"], undefined, { workers: 3 })).workers).to.equal("50%");
  });

  it("starts at most the invocation's maxWorkers, whatever the config or the invocation's default says", () => {
    const capped = (workers: number | string | undefined, extra: Partial<IInvocation> = {}): number | string | undefined =>
      wrapConfig(workers === undefined ? {} : { workers }, invocation(["a.spec.js"], undefined, { maxWorkers: 2, ...extra })).workers;
    expect(capped(8)).to.equal(2);
    expect(capped(1)).to.equal(1);
    expect(capped(`${os.cpus().length * 300}%`), "a percentage, read as Playwright reads it").to.equal(2);
    expect(capped("1%"), "a percentage within the limit stays as written").to.equal("1%");
    expect(capped(undefined, { workers: 5 })).to.equal(2);
    expect(capped(undefined)).to.equal(undefined);
    expect(capped("many"), "a setting Playwright refuses stays for Playwright to report").to.equal("many");
  });

  it("forbids focused tests where the invocation says, whatever the config says", () => {
    expect(wrapConfig({ forbidOnly: false }, invocation(["a.spec.js"], undefined, { forbidOnly: true })).forbidOnly).to.equal(true);
    expect(wrapConfig({}, invocation(["a.spec.js"])).forbidOnly).to.equal(undefined);
  });

  it("applies no globalTimeout, whatever the config says", () => {
    expect(wrapConfig({ globalTimeout: 60_000 }, invocation(["a.spec.js"])).globalTimeout).to.equal(0);
  });

  it("makes the suite's setup module the run's globalSetup, and refuses it beside the config's own", () => {
    const setup = { globalSetup: at(".fabr-playwright-setup.cjs") };
    expect(wrapConfig({}, invocation(["a.spec.js"], undefined, setup)).globalSetup).to.equal(at(".fabr-playwright-setup.cjs"));
    expect(() => wrapConfig({ globalSetup: "./auth.setup.ts" }, invocation(["a.spec.js"], undefined, setup))).to.throw(
      /names a globalSetup, and the suite has a setupTests file/
    );
  });

  it("names a global setup's compiled file where the config names its TypeScript source", () => {
    const config = wrapConfig(
      { globalSetup: "./utils/GlobalSetup.ts", globalTeardown: ["./teardown.js", "some-package"] },
      invocation(["a.spec.js"], ["a.spec.js", "utils/GlobalSetup.js", "teardown.js"])
    );
    expect(config.globalSetup).to.equal(at("utils/GlobalSetup.js"));
    expect(config.globalTeardown).to.deep.equal(["./teardown.js", "some-package"]);
  });
});

describe("toTestResult", () => {
  const test = (outcome: string, results: IReportedTest["results"], project = "chromium"): IReportedTest => ({
    titlePath: () => ["", project, "tests/a.spec.ts", "suite", "does a thing"],
    location: { file: at("tests/a.spec.js") },
    outcome: () => outcome,
    results,
  });

  it("names the file by the source reference Playwright reports it at", () => {
    const reported = {
      ...test("expected", [{ status: "passed", duration: 1, errors: [] }]),
      location: { file: at("tests/fabr:./tests/a.spec.ts") },
    };
    expect(toTestResult(reported).filePath).to.equal("tests/a.spec.ts");
  });

  it("names a test by its suites and title, its project being the target's", () => {
    expect(toTestResult(test("expected", [{ status: "passed", duration: 5, errors: [] }], "desktop")).name).to.equal(
      "suite › does a thing"
    );
  });

  it("reads each outcome", () => {
    expect(toTestResult(test("expected", [{ status: "passed", duration: 5, errors: [] }])).status).to.equal("passed");
    expect(toTestResult(test("expected", [{ status: "failed", duration: 5, errors: [] }])).status).to.equal("passed");
    expect(toTestResult(test("expected", [{ status: "skipped", duration: 0, errors: [] }])).status).to.equal("skipped");
    expect(toTestResult(test("skipped", [])).status).to.equal("skipped");
    const flaky = toTestResult(
      test("flaky", [
        { status: "failed", duration: 5, errors: [{ message: "boom" }] },
        { status: "passed", duration: 6, errors: [] },
      ])
    );
    expect(flaky).to.include({ status: "passed", flaky: true, retries: 1, duration: 11 });
    const failed = toTestResult(
      test("unexpected", [{ status: "failed", duration: 5, errors: [{ message: "\u001b[31mexpected\u001b[39m 1\nreceived 2" }] }])
    );
    expect(failed).to.include({ status: "failed", message: "expected 1", trace: "received 2" });
  });
});

describe("describeErrors", () => {
  it("adds fabr's remedy to a missing or mismatched record", () => {
    expect(
      describeErrors([{ message: `Error: A snapshot doesn't exist at ${path.join(process.cwd(), "a.spec.js-snapshots", "x.png")}.` }])
        .message
    ).to.equal("Error: A snapshot doesn't exist at a.spec.js-snapshots/x.png. Run 'fabr test -u' to record the new value.");
    expect(describeErrors([{ message: "Screenshot comparison failed:" }]).message).to.match(
      /Run 'fabr test -u' to record the new value\.$/
    );
  });
});

describe("FabrReporter", () => {
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-playwright-reporter-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** Run a reporter over `tests` to its end, and @return the statuses and messages it reported. */
  function reported(options: { named?: boolean; unmatched?: string[] }, tests: IReportedTest[] = [], status = "passed"): string[] {
    const report = path.join(dir, "report.json");
    const reporter = new FabrReporter({
      report,
      files: [at("a.spec.js")],
      named: options.named ?? false,
      unmatched: options.unmatched,
    });
    reporter.onBegin(undefined, { allTests: () => tests });
    reporter.onEnd({ status });
    const written = JSON.parse(fs.readFileSync(report, "utf8")) as { results: { tests: Array<{ status: string; message?: string }> } };
    return written.results.tests.map(test => `${test.status}: ${test.message ?? ""}`);
  }

  it("keeps a test's attachments in the artifacts directory, each named within it", () => {
    const artifacts = path.join(dir, "artifacts");
    fs.mkdirSync(path.join(artifacts, "t-chromium"), { recursive: true });
    fs.writeFileSync(path.join(artifacts, "t-chromium", "trace.zip"), "trace");
    const outside = path.join(dir, "expected.png");
    fs.writeFileSync(outside, "png");
    const report = path.join(dir, "report.json");
    const reporter = new FabrReporter({ report, files: [at("a.spec.js")], named: false, artifacts });
    const failing: IReportedTest = {
      titlePath: () => ["", "chromium", "a.spec.ts", "fails"],
      location: { file: at("a.spec.js") },
      outcome: () => "unexpected",
      results: [
        {
          status: "failed",
          duration: 1,
          errors: [{ message: "boom" }],
          attachments: [
            { name: "trace", contentType: "application/zip", path: path.join(artifacts, "t-chromium", "trace.zip") },
            { name: "expected", contentType: "image/png", path: outside },
            { name: "notes", contentType: "text/plain", body: Buffer.from("noted") },
            { name: "video", contentType: "video/webm", path: path.join(artifacts, "gone.webm") },
          ],
        },
      ],
    };
    reporter.onBegin(undefined, { allTests: () => [failing] });
    reporter.onEnd({ status: "failed" });
    const written = JSON.parse(fs.readFileSync(report, "utf8")) as {
      results: { tests: Array<{ attachments?: Array<{ path: string }> }> };
    };
    const paths = (written.results.tests[0].attachments ?? []).map(attachment => attachment.path);
    expect(paths[0]).to.equal("t-chromium/trace.zip");
    expect(paths).to.have.length(3);
    expect(fs.readFileSync(path.join(artifacts, paths[1]), "utf8")).to.equal("png");
    expect(fs.readFileSync(path.join(artifacts, paths[2]), "utf8")).to.equal("noted");
  });

  it("fails a file that registered no tests, unless tests were selected by name", () => {
    expect(reported({})).to.deep.equal(["failed: This test file registered no tests"]);
    expect(reported({ named: true })).to.deep.equal([]);
  });

  it("fails a file no project runs", () => {
    expect(reported({ unmatched: [at("a.spec.js")] })).to.deep.equal([
      "failed: No project of the Playwright config runs this test file",
    ]);
  });

  it("fails a run that ended otherwise than passed with no failed test", () => {
    const passed: IReportedTest = {
      titlePath: () => ["", "", "a.spec.ts", "works"],
      location: { file: at("a.spec.js") },
      outcome: () => "expected",
      results: [{ status: "passed", duration: 1, errors: [] }],
    };
    expect(reported({}, [passed], "timedout")).to.deep.equal(["passed: ", "failed: The run ended timedout"]);
  });
});

describe("projectConfiguration", () => {
  const devices = (): Record<string, Record<string, unknown>> => ({
    "iPhone 15": { viewport: { width: 393, height: 659 }, isMobile: true, defaultBrowserType: "webkit" },
  });

  it("makes the project's use of its device's descriptor, then its viewport and user agent", () => {
    expect(
      projectConfiguration(
        { name: "mobile", browser: "webkit", device: "iPhone 15", viewport: { width: 400, height: 800 }, userAgent: "UA" },
        devices
      )
    ).to.deep.equal({
      name: "mobile",
      browser: "webkit",
      use: { viewport: { width: 400, height: 800 }, isMobile: true, defaultBrowserType: "webkit", userAgent: "UA" },
    });
  });

  it("refuses a device Playwright does not know", () => {
    expect(() => projectConfiguration({ name: "x", browser: "chromium", device: "Nokia 3310" }, devices)).to.throw(
      /Playwright knows no device 'Nokia 3310'/
    );
  });
});

describe("withReportedFile", () => {
  it("names the test's file in the error context's test info by the report's name", () => {
    const context = [
      "# Test info",
      "",
      "- Name: sub/page.spec.js >> suite >> fails",
      "- Location: ../src/sub/page.spec.ts:2:5",
      "",
      "# Error details",
      "- Location: elsewhere.ts:1:1",
    ].join("\n");
    expect(withReportedFile(context, "e2e/sub/page.spec.ts").split("\n").slice(2, 4)).to.deep.equal([
      "- Name: e2e/sub/page.spec.ts >> suite >> fails",
      "- Location: e2e/sub/page.spec.ts:2:5",
    ]);
  });
});
