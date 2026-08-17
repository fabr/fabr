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
import {
  BuildEvent,
  Constraints,
  ITargetBuildTask,
  ITargetDecl,
  LogFormatter,
  LogLevel,
  TaskDescription,
} from "@fabr-build/core";
import { formatBytes, formatDuration, formatTransfer, ProgressReporter } from "./Progress";
import { IPaneContent, TerminalStream } from "./Terminal";

/* The reporter reads only a decl's name, so a partial stub suffices (hence the
 * cast — the AST decl type isn't constructible from here). */
const target = (name: string): ITargetDecl => ({ name } as unknown as ITargetDecl);

function building(name: string, label?: string): ITargetBuildTask {
  return {
    kind: "target-build",
    target: target(name),
    constraints: Constraints.of({}),
    requiredBy: [],
    label,
  };
}

/** Drive a reporter over a scripted event/clock sequence and collect its log. */
function report(): { lines: string[]; reporter: ProgressReporter; tick: (ms: number) => void } {
  const lines: string[] = [];
  const log = new LogFormatter(LogLevel.Info, line => lines.push(line));
  let clock = 0;
  const reporter = new ProgressReporter(log, { now: () => clock });
  return { lines, reporter, tick: ms => (clock += ms) };
}

function send(reporter: ProgressReporter, event: BuildEvent): void {
  reporter.buildListener(event);
}

describe("ProgressReporter", () => {
  it("logs a line when task starts and a marked, timed line when it ends", () => {
    const { lines, reporter, tick } = report();
    const task = building("//pkg");
    send(reporter, { kind: "task-start", id: 1, task, state: "running" });
    tick(1200);
    send(reporter, { kind: "task-end", id: 1, task, failed: false });
    /* The completion line repeats the start line's verb rather than restating
     * it in the past tense — the same item, checked off. */
    expect(lines).to.deep.equal(["info:Building //pkg", "info:✓ Building //pkg (1.2s)"]);
  });

  it("marks failed task distinctly, and still reports its duration", () => {
    const { lines, reporter, tick } = report();
    const task = building("//pkg");
    send(reporter, { kind: "task-start", id: 1, task, state: "running" });
    tick(40);
    send(reporter, { kind: "task-end", id: 1, task, failed: true });
    expect(lines[1]).to.equal("info:✗ Building //pkg (40ms)");
  });

  it("uses a sub-target's label as the verb", () => {
    const { lines, reporter } = report();
    send(reporter, { kind: "task-start", id: 1, task: building("//pkg", "Compiling"), state: "running" });
    expect(lines[0]).to.equal("info:Compiling //pkg");
  });

  it("names the requiring chain and explicit constraints on the start line only", () => {
    const { lines, reporter, tick } = report();
    const task: ITargetBuildTask = {
      ...building("//lib"),
      constraints: Constraints.of({ BUILD_TYPE: "release" }),
      requiredBy: [target("//app")],
    };
    send(reporter, { kind: "task-start", id: 1, task, state: "running" });
    tick(5);
    send(reporter, { kind: "task-end", id: 1, task, failed: false });
    expect(lines[0]).to.equal("info:Building //lib [BUILD_TYPE=release] (required by //app)");
    /* Read once, where it is useful; the completion line is the outcome. */
    expect(lines[1]).to.equal("info:✓ Building //lib (5ms)");
  });

  it("renders a resolve and a fetch as the task they are", () => {
    const { lines, reporter } = report();
    send(reporter, {
      kind: "task-start",
      id: 1,
      state: "running",
      task: { kind: "repository-resolve", repository: "@npm", consumer: "//app", requirements: ["chai", "typescript"] },
    });
    send(reporter, {
      kind: "task-start",
      id: 2,
      state: "running",
      task: { kind: "fetch", url: "https://example.test/x.tgz", target: target("@npm"), resource: "package", role: "content" },
    });
    expect(lines).to.deep.equal([
      "info:Resolving //app dependencies from @npm",
      "info:Fetching package https://example.test/x.tgz",
    ]);
  });

  it("ignores an end with no start (nothing to time — the duration is ours to measure)", () => {
    const { lines, reporter } = report();
    send(reporter, { kind: "task-end", id: 99, task: building("//pkg"), failed: false });
    expect(lines).to.deep.equal([]);
  });

  it("prefixes an output line with the target it names — no start required", () => {
    const { lines, reporter } = report();
    /* Every task event is self-describing: output is interpretable alone. The
     * declared target, not the sub-target label: two steps of one target are
     * both that target's output, and the prefix says whose line this is. */
    send(reporter, { kind: "task-output", id: 1, task: building("//pkg", "Compiling"), line: "src/a.ts(1,1): error TS2322" });
    expect(lines).to.deep.equal(["info://pkg | src/a.ts(1,1): error TS2322"]);
  });

  it("renders a cycle opening as nothing — the record arrives on the cycle-end", () => {
    const { lines, reporter } = report();
    send(reporter, { kind: "cycle-start", cycle: 1 });
    expect(lines).to.deep.equal([]);
  });

  it("renders the cycle's record: what was built, or that nothing needed to be", () => {
    const { lines, reporter } = report();
    send(reporter, { kind: "cycle-end", cycle: 0, failed: false, built: ["app", "lib"] });
    send(reporter, { kind: "cycle-end", cycle: 1, failed: false, built: [] });
    expect(lines).to.deep.equal(["info:Built app, lib", "info:Already up to date"]);
  });

  it("renders no marker for a failed cycle — the error path reports the failure", () => {
    const { lines, reporter } = report();
    send(reporter, { kind: "cycle-end", cycle: 0, failed: true, built: ["app"] });
    expect(lines).to.deep.equal([]);
  });

  it("renders no marker when the verb's policy says none — the event still arrives", () => {
    /* A query verb's outcome is its own output (ls's listing, cat's bytes); the
     * driver turns markers off rather than the event being suppressed. */
    const lines: string[] = [];
    const log = new LogFormatter(LogLevel.Info, line => lines.push(line));
    const reporter = new ProgressReporter(log, { markers: false, now: () => 0 });
    send(reporter, { kind: "cycle-end", cycle: 0, failed: false, built: ["app"] });
    expect(lines).to.deep.equal([]);
  });

  it("under quiet, reports only completions — no pane means no start lines in its place", () => {
    const lines: string[] = [];
    const log = new LogFormatter(LogLevel.Info, line => lines.push(line));
    let clock = 0;
    /* `-q` turns the pane off, and the start line must not come back to fill
     * the gap: asking for quiet can only ever produce less output, never more. */
    const reporter = new ProgressReporter(log, { quiet: true, now: () => clock });
    const task = building("//pkg");
    send(reporter, { kind: "task-start", id: 1, task, state: "running" });
    expect(lines).to.deep.equal([]);
    clock = 900;
    send(reporter, { kind: "task-end", id: 1, task, failed: false });
    expect(lines).to.deep.equal(["info:✓ Building //pkg (900ms)"]);
  });

  describe("with a live pane", () => {
    /** As {@link report}, but against a terminal that paints a pane. */
    function paned(): {
      lines: string[];
      reporter: ProgressReporter;
      rows: () => string[];
      heading: () => string;
      tick: (ms: number) => void;
    } {
      const lines: string[] = [];
      const log = new LogFormatter(LogLevel.Info, line => lines.push(line));
      let clock = 0;
      /* A real TerminalStream writing nowhere: the reporter reads `hasPane` off
       * it, and its pane source is what we sample. */
      let content: IPaneContent = { heading: "", rows: [] };
      /* The terminal hands the source a row budget; six is what a normal
       * screen allows (see TerminalStream.rowBudget). */
      const BUDGET = 6;
      const terminal = {
        hasPane: true,
        setPaneSource: (source: (rows: number) => IPaneContent) => (sample = source),
        paneChanged: () => undefined,
      } as unknown as TerminalStream;
      let sample: (rows: number) => IPaneContent = () => content;
      const reporter = new ProgressReporter(log, { terminal, now: () => clock });
      return {
        lines,
        reporter,
        rows: () => ((content = sample(BUDGET)), content.rows.map(row => `${row.left}|${row.right}`)),
        heading: () => ((content = sample(BUDGET)), content.heading),
        tick: ms => (clock += ms),
      };
    }

    it("logs only the completion line — the pane already shows what is running", () => {
      const { lines, reporter, tick } = paned();
      const task = building("//pkg");
      send(reporter, { kind: "task-start", id: 1, task, state: "running" });
      expect(lines).to.deep.equal([]);
      tick(1200);
      send(reporter, { kind: "task-end", id: 1, task, failed: false });
      expect(lines).to.deep.equal(["info:✓ Building //pkg (1.2s)"]);
    });

    it("moves the context onto the completion line, there being no start line to carry it", () => {
      const { lines, reporter } = paned();
      const task: ITargetBuildTask = { ...building("//lib"), requiredBy: [target("//app")] };
      send(reporter, { kind: "task-start", id: 1, task, state: "running" });
      send(reporter, { kind: "task-end", id: 1, task, failed: false });
      expect(lines).to.deep.equal(["info:✓ Building //lib (required by //app) (0ms)"]);
    });

    it("shows tasks in flight as rows, in start order, and drops them as they end", () => {
      const { reporter, rows, tick } = paned();
      const first = building("//a");
      send(reporter, { kind: "task-start", id: 1, task: first, state: "running" });
      tick(500);
      send(reporter, { kind: "task-start", id: 2, task: building("//b"), state: "running" });
      expect(rows()).to.deep.equal(["  Building //a|500ms", "  Building //b|0ms"]);
      send(reporter, { kind: "task-end", id: 1, task: first, failed: false });
      expect(rows()).to.deep.equal(["  Building //b|0ms"]);
    });

    it("shows a download's progress against its declared size", () => {
      const { reporter, rows } = paned();
      const task: TaskDescription = { kind: "fetch", url: "https://example.test/x.tgz", target: target("@npm"), resource: "package", role: "content" };
      send(reporter, { kind: "task-start", id: 1, task, state: "running" });
      send(reporter, { kind: "task-progress", id: 1, task, state: "running", progress: { measure: "bytes", done: 4_200_000, total: 12_000_000 } });
      expect(rows()).to.deep.equal(["  Fetching package https://example.test/x.tgz|[███▌      ] 35% of 12.0 MB  0ms"]);
    });

    it("shows a test run's files and outcomes as they land", () => {
      const { reporter, rows } = paned();
      const task: TaskDescription = { ...building("//pkg"), constraints: Constraints.of({ BUILD_OPERATION: "test" }) };
      send(reporter, { kind: "task-start", id: 1, task, state: "running" });
      send(reporter, {
        kind: "task-progress",
        id: 1,
        task,
        state: "running",
        progress: { measure: "tests", files: 12, totalFiles: 40, passed: 340, failed: 2 },
      });
      expect(rows()).to.deep.equal(["  Testing //pkg|12/40 files · 340 passed, 2 failed  0ms"]);
    });

    it("says nothing about failures while there are none", () => {
      const { reporter, rows } = paned();
      const task: TaskDescription = { ...building("//pkg"), constraints: Constraints.of({ BUILD_OPERATION: "test" }) };
      send(reporter, { kind: "task-start", id: 1, task, state: "running" });
      send(reporter, {
        kind: "task-progress",
        id: 1,
        task,
        state: "running",
        progress: { measure: "tests", files: 5, totalFiles: 5, passed: 120, failed: 0 },
      });
      /* A green run saying "0 failed" is noise; a red one is what must stand out. */
      expect(rows()).to.deep.equal(["  Testing //pkg|5/5 files · 120 passed  0ms"]);
    });

    it("shows bare bytes for a download whose size the origin never declared", () => {
      const { reporter, rows } = paned();
      const task: TaskDescription = { kind: "fetch", url: "https://example.test/x.tgz", target: target("@npm"), resource: "package", role: "content" };
      send(reporter, { kind: "task-start", id: 1, task, state: "running" });
      send(reporter, { kind: "task-progress", id: 1, task, state: "running", progress: { measure: "bytes", done: 4_200_000 } });
      expect(rows()).to.deep.equal(["  Fetching package https://example.test/x.tgz|4.2 MB  0ms"]);
    });

    it("shows incidental task in the pane but keeps it out of the log", () => {
      const { lines, reporter, rows } = paned();
      /* A resolution reads one of these per package it walks: worth seeing
       * while it happens, not worth a line each in the record. */
      const task: TaskDescription = {
        kind: "fetch",
        url: "https://example.test/meta",
        target: target("@npm"),
        resource: "metadata",
        role: "index",
      };
      const second = { ...task, url: "https://example.test/meta2" };
      send(reporter, { kind: "task-start", id: 1, task, state: "running" });
      send(reporter, { kind: "task-start", id: 2, task: second, state: "running" });
      /* Summarised, not listed: a resolution has a dozen of these in flight and
       * none of them is individually interesting. */
      expect(rows()).to.deep.equal(["  Fetching metadata (2)|0ms"]);
      send(reporter, { kind: "task-end", id: 1, task, failed: false });
      send(reporter, { kind: "task-end", id: 2, task: second, failed: false });
      expect(lines).to.deep.equal([]);
      expect(rows()).to.deep.equal([]);
    });

    it("counts task queued for the machine's funnel instead of listing it as running", () => {
      const { reporter, rows } = paned();
      const [a, b, c] = [building("//a"), building("//b"), building("//c")];
      send(reporter, { kind: "task-start", id: 1, task: a, state: "running" });
      send(reporter, { kind: "task-start", id: 2, task: b, state: "running" });
      send(reporter, { kind: "task-start", id: 3, task: c, state: "running" });
      /* A wide graph passes its cache-miss check for every action at once, so
       * without this the pane is a display of the queue, not of the task. */
      send(reporter, { kind: "task-progress", id: 1, task: a, state: "running" });
      send(reporter, { kind: "task-progress", id: 2, task: b, state: "waiting" });
      send(reporter, { kind: "task-progress", id: 3, task: c, state: "waiting" });
      expect(rows()).to.deep.equal(["  Building //a|0ms", "  … 2 waiting|"]);
    });

    it("keeps task that holds no slot on screen — a download is running too", () => {
      const { reporter, rows } = paned();
      /* Only task blocked on the funnel is counted away. A fetch is bounded by
       * its own connection pool and takes no slot at all; it is not waiting. */
      const task: TaskDescription = { kind: "fetch", url: "https://example.test/x.tgz", target: target("@npm"), resource: "package", role: "content" };
      send(reporter, { kind: "task-start", id: 1, task, state: "running" });
      expect(rows()).to.deep.equal(["  Fetching package https://example.test/x.tgz|0ms"]);
    });

    it("spends its row budget on the task, and counts the rest by state", () => {
      const { reporter, rows } = paned();
      for (let id = 1; id <= 11; id++) {
        send(reporter, { kind: "task-start", id, task: building(`//t${id}`), state: "running" });
      }
      send(reporter, { kind: "task-progress", id: 1, task: building("//t1"), state: "running" });
      send(reporter, { kind: "task-progress", id: 11, task: building("//t11"), state: "waiting" });
      /* Rows go to running task, and one line carries the remainder. A list of
       * ten target names says less than "+N running, N waiting" and costs the
       * whole screen. */
      const shown = rows();
      expect(shown).to.have.length(6);
      expect(shown[0]).to.equal("  Building //t1|0ms");
      expect(shown[5]).to.equal("  … 5 running, 1 waiting|");
    });
  });
});

describe("formatTransfer", () => {
  it("draws a bar with the percentage and the size being fetched", () => {
    expect(formatTransfer(3_000_000, 12_000_000)).to.equal("[██▌       ] 25% of 12.0 MB");
  });

  it("fills and empties completely at the ends", () => {
    expect(formatTransfer(0, 100)).to.equal("[          ] 0% of 100 B");
    expect(formatTransfer(100, 100)).to.equal("[██████████] 100% of 100 B");
  });

  it("marks progress within a cell, so a slow download still visibly moves", () => {
    /* An eighth of a cell — a whole-cell bar would look stalled here. */
    expect(formatTransfer(1, 80)).to.contain("▏");
  });

  it("reports bare bytes when the origin declared no size to fetch against", () => {
    expect(formatTransfer(4_200_000)).to.equal("4.2 MB");
  });

  it("never overruns its width on a body longer than the declared size", () => {
    expect(formatTransfer(200, 100)).to.equal("[██████████] 100% of 100 B");
  });
});

describe("formatBytes", () => {
  it("reports whole bytes below a kilobyte", () => {
    expect(formatBytes(0)).to.equal("0 B");
    expect(formatBytes(999)).to.equal("999 B");
  });

  it("scales to the largest unit leaving a number under 1000", () => {
    expect(formatBytes(1000)).to.equal("1.0 kB");
    expect(formatBytes(4_200_000)).to.equal("4.2 MB");
    expect(formatBytes(3_500_000_000)).to.equal("3.5 GB");
  });
});

describe("formatDuration", () => {
  it("reports sub-second task in milliseconds", () => {
    expect(formatDuration(0)).to.equal("0ms");
    expect(formatDuration(999)).to.equal("999ms");
  });

  it("reports longer task in tenths of a second", () => {
    expect(formatDuration(1000)).to.equal("1.0s");
    expect(formatDuration(94500)).to.equal("94.5s");
  });
});
