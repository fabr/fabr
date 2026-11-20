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
import * as path from "node:path";
import * as vm from "node:vm";
import { describeError, ICypressResult, supportSource, supportFileOf, toTestResults } from "./CypressRun";

const spec = path.resolve("/work/build/a.cy.js");

describe("toTestResults", () => {
  const result: ICypressResult = {
    runs: [
      {
        spec: { absolute: spec },
        tests: [
          { title: ["page", "clicks"], state: "passed", duration: 12, attempts: [{ state: "passed" }] },
          { title: ["page", "retries"], state: "passed", duration: 5, attempts: [{ state: "failed" }, { state: "passed" }] },
          {
            title: ["page", "fails"],
            state: "failed",
            duration: 7,
            displayError: "AssertionError: expected 'a' to equal 'b'\n    at Context.eval (webpack:///./a.cy.ts:3:4)",
          },
          { title: ["page", "later"], state: "pending" },
        ],
      },
    ],
  };

  it("names each test by its suites and title, and reads each outcome", () => {
    const tests = toTestResults(result, [spec]);
    expect(tests.map(test => [test.name, test.status])).to.deep.equal([
      ["page › clicks", "passed"],
      ["page › retries", "passed"],
      ["page › fails", "failed"],
      ["page › later", "pending"],
    ]);
    expect(tests[1]).to.include({ flaky: true, retries: 1 });
    expect(tests[2].message).to.equal("AssertionError: expected 'a' to equal 'b'");
  });

  it("fails a spec that could not run, and every file of a run that could not start", () => {
    const failed = toTestResults({ runs: [{ spec: { absolute: spec }, tests: [], error: "Webpack Compilation Error" }] }, [spec]);
    expect(failed.map(test => [test.status, test.message])).to.deep.equal([["failed", "Webpack Compilation Error"]]);
    const unstarted = toTestResults({ status: "failed", message: "Could not find Cypress test run results" }, [spec, spec]);
    expect(unstarted.map(test => test.status)).to.deep.equal(["failed", "failed"]);
  });
});

describe("describeError", () => {
  it("takes the first line as the message and the rest as the trace, without colour codes", () => {
    expect(describeError("\u001b[31mError: boom\u001b[39m\nmore detail")).to.deep.equal({
      message: "Error: boom",
      trace: "more detail",
    });
    expect(describeError("Error: alone")).to.deep.equal({ message: "Error: alone" });
  });
});

describe("supportSource", () => {
  /** Run the filter over stand-in test globals, defining `suite`, and return the full names of the tests it registers. */
  function registered(pattern: string, suite: string): string[] {
    const names: string[] = [];
    const titles: string[] = [];
    const define = (title: string, body: () => void): void => {
      titles.push(title);
      body();
      titles.pop();
    };
    const test = (title: string): void => {
      names.push([...titles, title].join(" "));
    };
    const context = vm.createContext({});
    Object.assign(context, {
      describe: Object.assign(define, { only: define, skip: define }),
      context: Object.assign(define, { only: define, skip: define }),
      it: Object.assign(test, { only: test, skip: () => undefined }),
      specify: Object.assign(test, { only: test, skip: () => undefined }),
    });
    vm.runInContext(supportSource([], pattern), context);
    vm.runInContext(suite, context);
    return names;
  }

  const suite = `
    describe("page", () => {
      it("clicks", () => {});
      context("nested", () => { it("reads", () => {}); });
    });
    describe("other", () => { specify("waits", () => {}); });
  `;

  it("registers only the tests whose full name the regular expression matches", () => {
    expect(registered("page nested", suite)).to.deep.equal(["page nested reads"]);
    expect(registered("clicks|waits", suite)).to.deep.equal(["page clicks", "other waits"]);
    expect(registered("^nothing$", suite)).to.deep.equal([]);
  });

  it("loads the suite's own support file and its setup files first, in order", () => {
    const lines = supportSource(["/work/build/cypress/support/e2e.js", "/work/build/setupTests.js"], "x").split("\n");
    expect(lines.slice(1, 3)).to.deep.equal([
      'require("/work/build/cypress/support/e2e.js");',
      'require("/work/build/setupTests.js");',
    ]);
    /* With no pattern, it loads them and filters nothing. */
    expect(supportSource(["/work/build/setupTests.js"], undefined)).to.equal(
      '/* Written by fabr. */\nrequire("/work/build/setupTests.js");\n'
    );
  });
});

describe("supportFileOf", () => {
  const root = path.resolve("/work/build");
  const present =
    (...files: string[]): ((file: string) => boolean) =>
    file =>
      files.map(each => path.resolve(root, each)).includes(file);

  it("finds the compiled file of a TypeScript source the config names", () => {
    expect(supportFileOf(root, "cypress/support/e2e.ts", present("cypress/support/e2e.js"))).to.equal(
      path.resolve(root, "cypress/support/e2e.js")
    );
  });

  it("finds Cypress's default where the config names none, and none where it is false", () => {
    expect(supportFileOf(root, undefined, present("cypress/support/e2e.js"))).to.equal(path.resolve(root, "cypress/support/e2e.js"));
    expect(supportFileOf(root, undefined, present())).to.equal(undefined);
    expect(supportFileOf(root, false, present("cypress/support/e2e.js"))).to.equal(undefined);
  });
});
