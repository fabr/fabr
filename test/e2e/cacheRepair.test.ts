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
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { removeTree, runFabrSequence, startFabrWatch, started, STUB_TSC, STUB_TSC_CONFIG, withShell } from "./harness";

/* A damaged cache: a blob an entry's manifest or a source index row names,
 * removed between runs. fabr trusts both without checking, so the run that
 * reads the blob finds it missing, repairs the record that named it, and
 * evaluates again; its result is the same as an intact cache's, and the run
 * after it is a plain hit. Each case owns its cache, to remove blobs from. */
const PROJECT =
  "script upper { entry = src:upper.sh; }\n" +
  "script wrap { entry = src:wrap.sh; }\n" +
  "generate gen { run = upper < input.txt > out.txt; }\n" +
  "generate twice { srcs = extra.txt; run = wrap < gen:out.txt > final.txt; }\n" +
  "script show { entry = src:show.sh; deps = gen:out.txt; }\n";
const FILES = {
  "PROJECT.fabr": PROJECT,
  "src/upper.sh": "tr a-z A-Z\n",
  "src/wrap.sh": "printf '[%s]\\n' \"$(cat)\"\n",
  "src/show.sh": 'cat "$(dirname "$0")/out.txt"\n',
  "input.txt": "hello\n",
  "extra.txt": "one\n",
};
const REPAIRED = "evaluating again";

/** @return the path in the pool at `cacheDir` of the blob holding `content`. */
function blobOf(cacheDir: string, content: string): string {
  return path.join(cacheDir, "blob", crypto.createHash("sha256").update(content).digest("hex"));
}

/** Remove the blob holding `content` from the pool at `cacheDir`, asserting it was there. */
function removeBlob(cacheDir: string, content: string): void {
  const blob = blobOf(cacheDir, content);
  expect(fs.existsSync(blob), `the blob of ${JSON.stringify(content)} is in the pool`).to.equal(true);
  fs.rmSync(blob, { force: true });
}

/* Many records damaged at once: twelve entries, and twelve sources, each read
 * by one step. Staging stops at the first missing blob, so a repair of only
 * the record that failed would take an evaluation per record. */
const COUNT = 12;
const indices = Array.from({ length: COUNT }, (_, index) => index + 1);
const MANY = {
  "PROJECT.fabr":
    "script emit { entry = src:emit.sh; }\n" +
    "script count { entry = src:count.sh; }\n" +
    indices.map(i => `generate g${i} { run = emit ${i} > o${i}.txt; }\n`).join("") +
    `generate entries { run = count < listing.txt > entries.txt; srcs = ${indices.map(i => `g${i}:o${i}.txt`).join(" ")}; }\n` +
    "generate sources { run = count < listing.txt > sources.txt; srcs = data/**; }\n",
  "src/emit.sh": 'echo "value $1"\n',
  "src/count.sh": "cat o*.txt data/*.txt 2>/dev/null | wc -l | tr -d ' '\n",
  "listing.txt": "\n",
  ...Object.fromEntries(indices.map(i => [`data/d${i}.txt`, `datum ${i}\n`])),
};

jest.setTimeout(90000);

describe("e2e: repairing a damaged cache", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-e2e-repair-cache-"));
    /* Stamp the daily trim done: its mark pass also deletes a manifest naming
     * a missing blob, which would repair the damage before the run under test. */
    fs.mkdirSync(path.join(cacheDir, "gc"));
    fs.writeFileSync(path.join(cacheDir, "gc", "last"), "");
  });

  afterEach(() => removeTree(cacheDir));

  withShell("rebuilds an entry whose blob is gone, reading it or staging it", () => {
    const env = { FABR_CACHE_DIR: cacheDir };
    const [cold, read, stage, after] = runFabrSequence(
      FILES,
      [
        ["build", "twice"],
        () => removeBlob(cacheDir, "[HELLO]\n"),
        ["cat", "twice:final.txt"],
        () => removeBlob(cacheDir, "HELLO\n"),
        /* Forced, `twice` stages gen's output, whose blob is gone. */
        ["-f", "build", "twice"],
        ["cat", "twice:final.txt"],
      ],
      undefined,
      env
    );
    expect(cold.status, cold.stderr).to.equal(0);
    expect(read.status, read.stderr).to.equal(0);
    expect(read.stdout).to.equal("[HELLO]\n");
    expect(read.stderr).to.contain(REPAIRED);
    expect(stage.status, stage.stderr).to.equal(0);
    expect(stage.stderr).to.contain(REPAIRED);
    expect(stage.stderr, "gen's entry was removed, so it is built again").to.match(started("Building gen"));
    expect(fs.existsSync(blobOf(cacheDir, "HELLO\n")), "and its blob is back").to.equal(true);
    expect(after.stdout).to.equal("[HELLO]\n");
    expect(after.stderr, "the repaired cache is intact").to.not.contain(REPAIRED);
  });

  withShell("reads a source file again whose snapshot's blob is gone", () => {
    const env = { FABR_CACHE_DIR: cacheDir };
    const [first, second, read, , stage, after] = runFabrSequence(
      FILES,
      [
        /* The first run records the source's row, the second verifies it, and
         * a verified row is served without reading the file. */
        ["build", "gen"],
        ["build", "gen"],
        () => removeBlob(cacheDir, "hello\n"),
        ["cat", "input.txt"],
        /* The row read again is verified by the next run. */
        ["build", "gen"],
        () => removeBlob(cacheDir, "hello\n"),
        ["-f", "build", "gen"],
        ["cat", "input.txt"],
      ],
      undefined,
      env
    );
    expect(first.status, first.stderr).to.equal(0);
    expect(second.status, second.stderr).to.equal(0);
    expect(read.status, read.stderr).to.equal(0);
    expect(read.stdout).to.equal("hello\n");
    expect(read.stderr).to.contain(REPAIRED);
    expect(stage.status, stage.stderr).to.equal(0);
    expect(stage.stderr).to.contain(REPAIRED);
    expect(after.stdout).to.equal("hello\n");
    expect(after.stderr).to.not.contain(REPAIRED);
  });

  withShell("rebuilds an entry `fabr run` stages a program from, after the evaluation", () => {
    const env = { FABR_CACHE_DIR: cacheDir };
    const [cold, run, after] = runFabrSequence(
      FILES,
      [
        ["run", "show"],
        () => {
          removeBlob(cacheDir, "HELLO\n");
          /* The program's kept install would serve the file without staging it. */
          for (const kept of fs.readdirSync(path.join(cacheDir, "work")).filter(name => name.includes("@"))) {
            fs.rmSync(path.join(cacheDir, "work", kept), { recursive: true, force: true });
          }
        },
        ["run", "show"],
        ["run", "show"],
      ],
      undefined,
      env
    );
    expect(cold.stdout, cold.stderr).to.equal("HELLO\n");
    expect(run.status, run.stderr).to.equal(0);
    expect(run.stdout).to.equal("HELLO\n");
    expect(run.stderr).to.contain(REPAIRED);
    expect(after.stdout).to.equal("HELLO\n");
    expect(after.stderr).to.not.contain(REPAIRED);
  });

  withShell("repairs many damaged entries, or sources, in one command", () => {
    const env = { FABR_CACHE_DIR: cacheDir };
    const [cold, verify, entries, sources, after] = runFabrSequence(
      MANY,
      [
        ["build", "entries", "sources"],
        /* Verifies the sources' rows, so they are served unread. */
        ["build", "entries", "sources"],
        () => indices.forEach(i => removeBlob(cacheDir, `value ${i}\n`)),
        ["-f", "build", "entries"],
        () => indices.forEach(i => removeBlob(cacheDir, `datum ${i}\n`)),
        ["-f", "build", "sources"],
        ["cat", "entries:entries.txt", "sources:sources.txt"],
      ],
      undefined,
      env
    );
    expect(cold.status, cold.stderr).to.equal(0);
    expect(verify.status, verify.stderr).to.equal(0);
    expect(entries.status, entries.stderr).to.equal(0);
    expect(entries.stderr).to.contain(REPAIRED);
    expect(sources.status, sources.stderr).to.equal(0);
    expect(sources.stderr).to.contain(REPAIRED);
    /* One repair found everything: each record is rebuilt or read once. */
    for (const i of indices) {
      expect(entries.stderr.match(started(`Building g${i}`))?.length ?? 0, `g${i} rebuilt once`).to.equal(1);
    }
    expect(after.stdout).to.equal(`${COUNT}\n${COUNT}\n`);
    expect(after.stderr).to.not.contain(REPAIRED);
  });

  it("reports a test run once, from the repaired evaluation, beside a damaged target", () => {
    const test = 'const assert = require("node:assert");\ndescribe("thing", () => { it("holds", () => { assert.equal(1, 1); }); });\n';
    const [first, second, damaged, after] = runFabrSequence(
      {
        ...STUB_TSC,
        "PROJECT.fabr":
          "plugin @fabr-build/js;\n\n" +
          STUB_TSC_CONFIG +
          "\njs_package thing { srcs = src:**/*.ts; tests = src:**/*.test.ts; }\n" +
          "js_package other { srcs = osrc:**/*.ts; tests = osrc:**/*.test.ts; }\n",
        "src/thing.test.ts": test,
        "osrc/other.test.ts": 'describe("other", () => { it("holds", () => {}); });\n',
      },
      [
        ["test", "thing", "other"],
        ["test", "thing", "other"],
        /* The test's source snapshot, and its compiled copy (the stub tsc copies it as it is). */
        () => removeBlob(cacheDir, test),
        ["-f", "test", "thing", "other"],
        ["test", "thing", "other"],
      ],
      undefined,
      { FABR_CACHE_DIR: cacheDir }
    );
    expect(first.status, first.stderr).to.equal(0);
    expect(second.status, second.stderr).to.equal(0);
    expect(damaged.status, damaged.stderr).to.equal(0);
    expect(damaged.stderr).to.contain(REPAIRED);
    /* `other` built in the damaged evaluation too, and is reported only from the repaired one. */
    expect(damaged.stderr.match(/other: 1 test passed/g)?.length ?? 0, "the summary is printed once").to.equal(1);
    expect(damaged.stderr.match(/thing: 1 test passed/g)?.length ?? 0).to.equal(1);
    expect(after.stderr).to.contain("thing: 1 test passed");
    expect(after.stderr).to.not.contain(REPAIRED);
  });

  withShell("repairs under watch, in the cycle that finds the damage", async () => {
    const session = startFabrWatch(FILES, ["build", "-w", "twice"], { FABR_CACHE_DIR: cacheDir });
    try {
      await session.waitFor("Watching for changes", { timeoutMs: 60000 });
      removeBlob(cacheDir, "HELLO\n");
      /* `twice` builds again, staging gen's output, whose blob is gone. */
      session.write("extra.txt", "two\n");
      await session.waitFor(REPAIRED, { timeoutMs: 60000 });
      await session.waitFor(started("Building gen"), { count: 2, timeoutMs: 60000 });
      await session.waitFor(/Built twice/, { count: 2, timeoutMs: 60000 });
      expect(session.stderr).to.not.contain("failed");
    } finally {
      await session.stop();
    }
  });
});
