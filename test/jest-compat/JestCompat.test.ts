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
 * jest compatibility: the probe project in `fixture/` run under real jest with jest-environment-jsdom (`jest_side`) and
 * under fabr's jest runner (`fabr_side`), by the built CLI. Each test must end
 * as it does under jest, and each observation a probe records (a `PROBE <id>
 * <json>` line) must equal jest's, bar the differences {@link EXPECTED} lists.
 * Downloads jest and jsdom.
 */

import { expect } from "chai";
import * as fs from "node:fs";
import * as path from "node:path";
import { runFabrSequence } from "../e2e/harness";

/** The differences fabr documents, by probe: the fields that may differ (all,
 * where none are listed) and why. */
const EXPECTED = new Map<string, { fields?: string[]; why: string }>([
  ["dom.location", { why: "window.location can be redefined" }],
  ["dom.realms", { fields: ["bufferIsUint8Array", "nodeError", "utilEncoderIsUint8Array"], why: "one realm" }],
  ["globals", { fields: ["jest"], why: "jest is a global" }],
  ["node-env.globals", { fields: ["jest"], why: "jest is a global" }],
  ["modules.self", { fields: ["dirname"], why: "the installation's layout" }],
]);

/** The fabr report and jest results file, as far as they are read here. */
interface ICtrfTest {
  name: string;
  status: string;
  filePath?: string;
}
interface IJestFile {
  name: string;
  message?: string;
  assertionResults: { ancestorTitles: string[]; title: string; status: string }[];
}

/** The probe project. */
const FIXTURE = path.join(__dirname, "fixture");

/** Read the probe project's files, by path within it. */
function projectFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(path.join(FIXTURE, dir), { withFileTypes: true })) {
      const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(rel);
      } else {
        files[rel] = fs.readFileSync(path.join(FIXTURE, rel), "utf8");
      }
    }
  };
  walk("");
  return files;
}

/** Read each `PROBE <id> <json>` line of `text`, by id. */
function observations(text: string): Map<string, unknown> {
  const found = new Map<string, unknown>();
  for (const line of text.split("\n")) {
    const match = /PROBE (\S+) (.*)$/.exec(line);
    if (match) {
      found.set(match[1], JSON.parse(match[2]));
    }
  }
  return found;
}

/** A test's outcome, as both sides spell it. */
const outcome = (status: string): string => (status === "pending" || status === "todo" ? "skipped" : status);

const [jestResults, jestProbes, fabrRun, fabrReport] = runFabrSequence(
  projectFiles(),
  [
    ["cat", "jest_side:results.json"],
    ["cat", "jest_side:probes.txt"],
    ["test", "--no-progress", "--report", "fabr-report.json", "fabr_side"],
    ["cat", "fabr-report.json"],
  ],
  900_000
);

/* Each test's outcome under jest, by file name and full name. */
const jestOutcomes = new Map<string, string>();
for (const file of (JSON.parse(jestResults.stdout || "{}") as { testResults?: IJestFile[] }).testResults ?? []) {
  for (const test of file.assertionResults) {
    jestOutcomes.set(`${path.basename(file.name)} › ${[...test.ancestorTitles, test.title].join(" › ")}`, outcome(test.status));
  }
}
const fabrOutcomes = new Map<string, string>();
for (const test of (JSON.parse(fabrReport.stdout || "{}") as { results?: { tests?: ICtrfTest[] } }).results?.tests ?? []) {
  fabrOutcomes.set(`${path.basename(test.filePath ?? "")} › ${test.name}`, outcome(test.status));
}
const jestSeen = observations(jestProbes.stdout);
/* What the probes write is fabr_side's output, which fabr logs with its own lines on stderr. */
const fabrSeen = observations(fabrRun.stderr);

describe("jest compatibility", () => {
  it("runs the probes under real jest and under fabr", () => {
    expect(jestResults.status, jestResults.stderr).to.equal(0);
    expect(jestProbes.status, jestProbes.stderr).to.equal(0);
    expect(fabrReport.status, `${fabrRun.stdout}${fabrRun.stderr}`).to.equal(0);
    expect(jestOutcomes.size).to.be.greaterThan(0);
    expect([...fabrOutcomes.keys()].sort()).to.deep.equal([...jestOutcomes.keys()].sort());
  });

  describe("ends each test as jest does", () => {
    it.each([...jestOutcomes.keys()].sort())("%s", name => {
      expect(fabrOutcomes.get(name)).to.equal(jestOutcomes.get(name));
    });
  });

  describe("observes what jest observes", () => {
    it.each([...new Set([...jestSeen.keys(), ...fabrSeen.keys()])].sort())("%s", id => {
      const jest = jestSeen.get(id);
      const fabr = fabrSeen.get(id);
      const expected = EXPECTED.get(id);
      if (expected === undefined) {
        expect(fabr).to.deep.equal(jest);
        return;
      }
      const differing =
        typeof jest === "object" && jest !== null && typeof fabr === "object" && fabr !== null
          ? [...new Set([...Object.keys(jest), ...Object.keys(fabr)])].filter(
              key => JSON.stringify((jest as Record<string, unknown>)[key]) !== JSON.stringify((fabr as Record<string, unknown>)[key])
            )
          : JSON.stringify(jest) === JSON.stringify(fabr)
            ? []
            : ["(value)"];
      expect(differing, `${id} now matches jest: remove it from EXPECTED`).to.not.deep.equal([]);
      if (expected.fields !== undefined) {
        expect(
          differing.filter(key => !expected.fields?.includes(key)),
          `${id} differs beyond ${expected.why}`
        ).to.deep.equal([]);
      }
    });
  });
});
