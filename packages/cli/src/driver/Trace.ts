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

import * as fs from "fs";
import * as path from "path";
import { BuildEvent, BuildListener, ITestFileRun, TaskDescription, TaskState, toError } from "@fabr-build/core";
import { context, describe as describeTask } from "./Progress";

/**
 * One event of the trace-event format (Perfetto, `chrome://tracing`): a
 * complete span (`X`, with a duration), an instant (`i`), the beginning or end
 * of an async span (`b`/`e`, paired by `id`), or metadata (`M`). Times are
 * microseconds.
 */
interface ITraceEvent {
  name: string;
  cat: string;
  ph: "X" | "i" | "b" | "e" | "M";
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  id?: string;
  s?: "g";
  args?: Record<string, unknown>;
}

/** A task seen started and not yet ended. */
interface IOpenTask {
  task: TaskDescription;
  /** The track the task's span is drawn on. */
  lane: number;
  /** When the task started and when it entered its current state, in the writer's clock. */
  started: number;
  state: TaskState;
  since: number;
  /** Time spent waiting for a funnel slot so far. */
  waited: number;
}

/** The one process every event belongs to. */
const PID = 1;
/** The track the cycle boundaries are drawn on; tasks take the tracks above it. */
const CYCLE_TID = 0;

/**
 * A build listener that writes a run's work to a file as a trace: one span per
 * task from its start to its end as this writer received them, the stretches
 * it waited for an execution slot as spans within it, each test file's run as
 * an async span placed by the runner's own timing, and each cycle's start and
 * end as instants. Concurrent tasks take distinct tracks, the lowest free one
 * first. The file is the trace-event JSON array, each cycle's events appended
 * at its end and the array closed by {@link write}; until then the file lacks
 * its closing `]`, which the format allows.
 */
export class TraceWriter {
  /** The events not yet written. */
  private events: ITraceEvent[] = [];
  /** Whether the file has been begun, and whether an event has been written to it. */
  private begun = false;
  private written = false;
  /** Whether writing the file failed, after which nothing more is written. */
  private failed = false;
  /** The tasks started and not yet ended, by id. */
  private readonly open = new Map<number, IOpenTask>();
  /** Each track's task, by lane; undefined where the track is free. */
  private readonly lanes: Array<number | undefined> = [];
  private readonly now: () => number;
  /** What to add to a time of this writer's clock for the epoch time it was. */
  private readonly epochOffset: number;
  /** The number of test-file runs drawn, which numbers the next one's async id. */
  private fileRuns = 0;

  private readonly onError: (err: Error) => void;

  /** `now` is a millisecond clock, `epoch` the epoch time it reads as now: both
   *  for a test; the defaults are the process's monotonic clock and `Date.now`.
   *  `onError` is told, once, that writing the file failed. */
  constructor(
    private readonly file: string,
    options: { now?: () => number; epoch?: () => number; onError?: (err: Error) => void } = {}
  ) {
    this.onError = options.onError ?? ((): void => {});
    this.now = options.now ?? ((): number => performance.now());
    this.epochOffset = (options.epoch ?? ((): number => Date.now()))() - this.now();
    this.events.push({ name: "process_name", cat: "__metadata", ph: "M", ts: 0, pid: PID, tid: CYCLE_TID, args: { name: "fabr" } });
    this.events.push({ name: "thread_name", cat: "__metadata", ph: "M", ts: 0, pid: PID, tid: CYCLE_TID, args: { name: "cycles" } });
  }

  /** The listener to subscribe to the run's build events. */
  public get buildListener(): BuildListener {
    return event => this.onBuildEvent(event);
  }

  /** Finish the trace: write the events not yet written, and each task still
   *  open as a span to now, marked unfinished, and close the array. */
  public write(): void {
    const now = this.now();
    const unfinished = [...this.open.entries()].map(([id, open]) => this.taskSpan(id, open, now, { unfinished: true }));
    this.events.push(...unfinished);
    this.flush();
    this.writing(() => fs.appendFileSync(this.file, "\n]\n"));
  }

  /** Write the events not yet written after those that were, beginning the file the first time. */
  private flush(): void {
    const text = this.events.map(event => JSON.stringify(event)).join(",\n");
    const any = this.events.length > 0;
    this.events = [];
    this.writing(() => {
      if (!this.begun) {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, `[\n${text}`);
        this.begun = true;
        this.written = any;
      } else if (any) {
        fs.appendFileSync(this.file, `${this.written ? ",\n" : ""}${text}`);
        this.written = true;
      }
    });
  }

  /** Write to the file with `write`, unless writing has failed. Never throw (a
   *  build listener must not): a failure is reported to `onError` and stops
   *  all further writing. */
  private writing(write: () => void): void {
    if (this.failed) {
      return;
    }
    try {
      write();
    } catch (err) {
      this.failed = true;
      this.onError(toError(err));
    }
  }

  private onBuildEvent(event: BuildEvent): void {
    switch (event.kind) {
      case "task-start": {
        const now = this.now();
        this.open.set(event.id, {
          task: event.task,
          lane: this.claimLane(event.id),
          started: now,
          state: event.state,
          since: now,
          waited: 0,
        });
        return;
      }
      case "task-progress": {
        const open = this.open.get(event.id);
        if (open === undefined) {
          return;
        }
        if (open.state !== event.state) {
          this.leaveState(open, this.now());
          open.state = event.state;
        }
        if (event.progress?.measure === "tests" && event.progress.latest !== undefined) {
          this.fileRun(open, event.progress.latest);
        }
        return;
      }
      case "task-end": {
        const open = this.open.get(event.id);
        if (open === undefined) {
          return;
        }
        this.open.delete(event.id);
        const now = this.now();
        this.leaveState(open, now);
        this.events.push(
          this.taskSpan(event.id, open, now, {
            failed: event.failed,
            ...(event.error === undefined ? {} : { error: event.error.message }),
          })
        );
        this.lanes[open.lane] = undefined;
        return;
      }
      case "cycle-start":
        this.events.push(this.instant(`cycle ${event.cycle} start`, {}));
        return;
      case "cycle-end":
        this.events.push(this.instant(`cycle ${event.cycle} end`, { failed: event.failed, built: event.built }));
        this.flush();
        return;
      case "task-output":
        return;
    }
  }

  /** Take the lowest free track for task `id`, naming a track the first time it is used. */
  private claimLane(id: number): number {
    let lane = this.lanes.findIndex(holder => holder === undefined);
    if (lane < 0) {
      lane = this.lanes.length;
      this.events.push({
        name: "thread_name",
        cat: "__metadata",
        ph: "M",
        ts: 0,
        pid: PID,
        tid: lane + 1,
        args: { name: `task ${lane + 1}` },
      });
    }
    this.lanes[lane] = id;
    return lane;
  }

  /** Close the task's current state at `now`: a wait becomes a span within the task's. */
  private leaveState(open: IOpenTask, now: number): void {
    if (open.state === "waiting") {
      open.waited += now - open.since;
      this.events.push(this.span("waiting", "wait", open.since, now, open.lane + 1));
    }
    open.since = now;
  }

  /** Make the span of task `id` from its start to `end`, its args `args` beside its context and time waited. */
  private taskSpan(id: number, open: IOpenTask, end: number, args: Record<string, unknown>): ITraceEvent {
    return this.span(
      describeTask(open.task),
      open.task.kind === "fetch" ? `fetch:${open.task.role}` : open.task.kind,
      open.started,
      end,
      open.lane + 1,
      {
        id,
        context: context(open.task),
        waited: Math.round(open.waited),
        ...args,
      }
    );
  }

  /** Draw a test file's run, placed by the runner's own clock, as an async span
   *  on the task's track. Use an async span: several files run at once, and
   *  plain spans on one track must not overlap. */
  private fileRun(open: IOpenTask, run: ITestFileRun): void {
    const id = `${open.lane + 1}:${this.fileRuns++}`;
    const start = run.start - this.epochOffset;
    const stop = Math.max(run.stop, run.start) - this.epochOffset;
    const base = { name: run.file, cat: "test-file", pid: PID, tid: open.lane + 1, id };
    this.events.push({ ...base, ph: "b", ts: micros(start), args: { passed: run.passed, failed: run.failed } });
    this.events.push({ ...base, ph: "e", ts: micros(stop) });
  }

  private span(name: string, cat: string, start: number, end: number, tid: number, args?: Record<string, unknown>): ITraceEvent {
    return {
      name,
      cat,
      ph: "X",
      ts: micros(start),
      dur: micros(end) - micros(start),
      pid: PID,
      tid,
      ...(args === undefined ? {} : { args }),
    };
  }

  private instant(name: string, args: Record<string, unknown>): ITraceEvent {
    return { name, cat: "cycle", ph: "i", s: "g", ts: micros(this.now()), pid: PID, tid: CYCLE_TID, args };
  }
}

/** Convert the writer's milliseconds to the format's whole microseconds. */
function micros(ms: number): number {
  return Math.round(ms * 1000);
}
