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
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BuildEvent, Constraints, ITargetBuildTask, ITargetDecl } from "@fabr-build/core";
import { TraceWriter } from "./Trace";

const target = (name: string): ITargetDecl => ({ name } as unknown as ITargetDecl);

function building(name: string, label?: string): ITargetBuildTask {
  return { kind: "target-build", target: target(name), constraints: Constraints.of({}), requiredBy: [], label };
}

interface ITraced {
  name: string;
  cat: string;
  ph: string;
  ts: number;
  dur?: number;
  tid: number;
  id?: string;
  args?: Record<string, unknown>;
}

/** A writer over a scripted clock, writing into a temp directory. */
function tracer(): { writer: TraceWriter; tick: (ms: number) => void; read: () => ITraced[]; send: (event: BuildEvent) => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-trace-"));
  const file = path.join(dir, "trace", "fabr-trace.json");
  let clock = 1000;
  /* The clock reads 1000 as epoch 2_000_000, so a runner's epoch time t lands at t - 1_999_000. */
  const writer = new TraceWriter(file, { now: () => clock, epoch: () => 2_000_000 });
  return {
    writer,
    tick: ms => (clock += ms),
    /* A trace not yet finished lacks its closing `]`, as the format allows. */
    read: () => {
      const text = fs.readFileSync(file, "utf8").trimEnd();
      return (JSON.parse(text.endsWith("]") ? text : `${text}\n]`) as ITraced[]).filter(event => event.ph !== "M");
    },
    send: event => writer.buildListener(event),
  };
}

describe("TraceWriter", () => {
  it("writes each task as a span on its own track, with its waits within it", () => {
    const { tick, read, send, writer } = tracer();
    const a = building("a", "Compiling");
    const b = building("b");
    send({ kind: "task-start", id: 1, task: a, state: "running" });
    tick(10);
    send({ kind: "task-start", id: 2, task: b, state: "running" });
    send({ kind: "task-progress", id: 1, task: a, state: "waiting" });
    tick(30);
    send({ kind: "task-progress", id: 1, task: a, state: "running" });
    tick(60);
    send({ kind: "task-end", id: 1, task: a, failed: false });
    tick(5);
    send({ kind: "task-end", id: 2, task: b, failed: true, error: new Error("boom") });
    writer.write();
    const spans = read().filter(event => event.ph === "X");
    expect(spans.map(span => [span.name, span.cat, span.tid, span.ts, span.dur])).to.deep.equal([
      ["waiting", "wait", 1, 1_010_000, 30_000],
      ["Compiling a", "target-build", 1, 1_000_000, 100_000],
      ["Building b", "target-build", 2, 1_010_000, 95_000],
    ]);
    expect(spans[1].args).to.include({ id: 1, waited: 30, failed: false });
    expect(spans[2].args).to.include({ failed: true, error: "boom" });
  });

  it("reuses a track once its task has ended", () => {
    const { tick, read, send, writer } = tracer();
    send({ kind: "task-start", id: 1, task: building("a"), state: "running" });
    tick(1);
    send({ kind: "task-end", id: 1, task: building("a"), failed: false });
    send({ kind: "task-start", id: 2, task: building("b"), state: "running" });
    send({ kind: "task-start", id: 3, task: building("c"), state: "running" });
    tick(1);
    send({ kind: "task-end", id: 2, task: building("b"), failed: false });
    send({ kind: "task-end", id: 3, task: building("c"), failed: false });
    writer.write();
    expect(read().filter(event => event.ph === "X").map(span => `${span.name}@${span.tid}`)).to.deep.equal(["Building a@1", "Building b@1", "Building c@2"]);
  });

  it("places a test file's run by the runner's own clock, as an async span on the task's track", () => {
    const { read, send } = tracer();
    const task = building("t");
    send({ kind: "task-start", id: 1, task, state: "running" });
    send({
      kind: "task-progress",
      id: 1,
      task,
      state: "running",
      progress: { measure: "tests", files: 1, totalFiles: 2, passed: 3, failed: 1, latest: { file: "build/a.test.js", start: 2_000_250, stop: 2_000_750, passed: 3, failed: 1 } },
    });
    send({ kind: "task-end", id: 1, task, failed: false });
    send({ kind: "cycle-end", cycle: 0, failed: false, built: ["t"] });
    const events = read();
    const run = events.filter(event => event.cat === "test-file");
    expect(run.map(event => [event.ph, event.name, event.tid, event.ts, event.id])).to.deep.equal([
      ["b", "build/a.test.js", 1, 1_250_000, "1:0"],
      ["e", "build/a.test.js", 1, 1_750_000, "1:0"],
    ]);
    expect(run[0].args).to.deep.equal({ passed: 3, failed: 1 });
    /* The cycle's end wrote the file, and is in it as an instant. */
    expect(events.filter(event => event.ph === "i").map(event => event.name)).to.deep.equal(["cycle 0 end"]);
  });

  it("appends each cycle's events at its end, and closes the array when finished", () => {
    const { tick, read, send, writer } = tracer();
    send({ kind: "task-start", id: 1, task: building("a"), state: "running" });
    tick(1);
    send({ kind: "task-end", id: 1, task: building("a"), failed: false });
    send({ kind: "cycle-end", cycle: 0, failed: false, built: ["a"] });
    expect(read().map(event => event.name)).to.deep.equal(["Building a", "cycle 0 end"]);
    send({ kind: "cycle-start", cycle: 1 });
    send({ kind: "task-start", id: 2, task: building("b"), state: "running" });
    tick(1);
    send({ kind: "task-end", id: 2, task: building("b"), failed: false });
    send({ kind: "cycle-end", cycle: 1, failed: false, built: ["b"] });
    expect(read().map(event => event.name)).to.deep.equal(["Building a", "cycle 0 end", "cycle 1 start", "Building b", "cycle 1 end"]);
    writer.write();
    expect(read()).to.have.lengthOf(5);
  });

  it("writes a task still open as an unfinished span to now", () => {
    const { tick, read, send, writer } = tracer();
    send({ kind: "task-start", id: 1, task: building("a"), state: "running" });
    tick(7);
    writer.write();
    const [span] = read().filter(event => event.ph === "X");
    expect(span.name).to.equal("Building a");
    expect(span.dur).to.equal(7_000);
    expect(span.args).to.include({ unfinished: true });
  });
});
