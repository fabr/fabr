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

import {
  AMBIENT_CONSTRAINT_KEYS,
  BUILD_OPERATION,
  BuildEvent,
  BuildListener,
  Constraints,
  declName,
  Diagnostic,
  IFetchTask,
  Log,
  TaskDescription,
  TaskProgress,
  TaskState,
} from "@fabr-build/core";
import { IPaneContent, IPaneRow, TerminalStream } from "./Terminal";

const DIAG_TASK_START = Diagnostic.Info<{ what: string; chain: string }>("{what}{chain}");
const DIAG_TASK_DONE = Diagnostic.Info<{ mark: string; what: string; chain: string; duration: string }>(
  "{mark} {what}{chain} {duration}"
);
const DIAG_STEP_OUTPUT = Diagnostic.Info<{ prefix: string; line: string }>("{prefix} {line}");
const DIAG_BUILD_COMPLETE = Diagnostic.Info<{ targets: string }>("Built {targets}");
const DIAG_UP_TO_DATE = Diagnostic.Info<Record<string, never>>("Already up to date");

/** Progress verbs for the well-known operations; anything else renders as
 *  "Running <operation> on <target>". */
const OPERATION_VERBS = new Map([
  ["build", "Building"],
  ["test", "Testing"],
  ["run", "Running"],
]);

/** Marks a finished task in the log. The completion line repeats the
 *  start line's verb rather than restating it in the past tense: a sub-target's
 *  label is display text a rule author chose ("Compiling"), with no derivable
 *  past form ("Running" → "Ran"), and repeating it reads as the same item being
 *  checked off. */
const MARK_OK = "✓";
const MARK_FAILED = "✗";

/** The pane's heading, above the rows. */
const PANE_HEADING = "Running:";

/* SGR codes for the palette. Colour is decided once, by the driver (a tty and
 * no NO_COLOR), and applied here; the log formatter strips any that survive
 * when it isn't painting, so this can't leak escapes into a redirected log. */
const SGR_OK = "32";
const SGR_FAILED = "31";
const SGR_DIM = "2";
const SGR_BOLD = "1";

/**
 * @return a human duration: sub-second task in whole milliseconds (where the
 * difference between 30ms and 300ms is the interesting part), longer task in
 * tenths of a second.
 */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Decimal units, as a registry and a browser both report a download — the
 *  point of comparison is the origin's own figure, not the memory it occupies. */
const BYTE_UNITS = ["B", "kB", "MB", "GB", "TB"];

/**
 * @return a human size: whole bytes below a kilobyte, else one decimal place in
 * the largest unit that leaves a number under 1000.
 */
export function formatBytes(bytes: number): string {
  let size = bytes;
  let unit = 0;
  while (size >= 1000 && unit < BYTE_UNITS.length - 1) {
    size /= 1000;
    unit++;
  }
  return unit === 0 ? `${size} B` : `${size.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

/** A task in flight: what it is, when we first heard of it, what it is
 *  doing, and how far along it has last said it is. */
interface IRunningTask {
  task: TaskDescription;
  started: number;
  state: TaskState;
  progress?: TaskProgress;
}

/**
 * Renders the model's task events: a line when a task starts, a line
 * with its duration when it ends, and — on a terminal — a pane of what is in
 * flight right now.
 *
 * The two lines are the record; the pane is a derived view of the tasks that
 * have started and not yet ended. That is what makes it droppable: with no terminal
 * to paint on, the same events produce the same log.
 */
export class ProgressReporter {
  private readonly running = new Map<number, IRunningTask>();
  private readonly log: Log;
  private readonly terminal?: TerminalStream;
  /** Injected so tests are not at the mercy of the wall clock. */
  private readonly now: () => number;
  /** Paint text in an SGR colour, or leave it plain — decided once, here. */
  private readonly style: (code: string, text: string) => string;
  /**
   * Whether a task announces itself as it *starts*. With a pane, what
   * is running is already on screen, and the start line would only repeat it a
   * few hundred milliseconds before the completion line supersedes it; without
   * one it is the sole indication that anything is happening — *unless* the run
   * asked for quiet, which has no live display precisely because it wants none,
   * and must not be handed the start lines in its place. Asking for quiet can
   * only ever produce less.
   */
  private readonly announceStart: boolean;
  /** Whether cycle-end events render the status marker ("Built X" / "Already
   *  up to date") — the driver's per-verb policy. */
  private readonly markers: boolean;

  constructor(
    log: Log,
    options: { terminal?: TerminalStream; color?: boolean; quiet?: boolean; markers?: boolean; now?: () => number } = {}
  ) {
    this.log = log;
    this.terminal = options.terminal;
    this.now = options.now ?? ((): number => Date.now());
    this.style = options.color ? (code, text) => `\x1b[${code}m${text}\x1b[0m` : (_code, text) => text;
    this.announceStart = !(this.terminal?.hasPane ?? false) && !options.quiet;
    this.markers = options.markers ?? true;
    /* The pane is *pulled*: its rows carry elapsed times and download sizes,
     * which advance with the clock rather than with events, so it must be
     * rendered at paint time and not handed over as text. */
    this.terminal?.setPaneSource(budget => this.paneContent(budget));
  }

  public get buildListener(): BuildListener {
    return event => this.onBuildEvent(event);
  }

  private onBuildEvent(event: BuildEvent): void {
    switch (event.kind) {
      case "task-start":
        this.running.set(event.id, { task: event.task, started: this.now(), state: event.state });
        if (this.announceStart && !incidental(event.task)) {
          this.log.log(DIAG_TASK_START, { what: describe(event.task), chain: context(event.task) });
        }
        break;

      case "task-progress": {
        const running = this.running.get(event.id);
        if (!running) {
          return;
        }
        const stateChanged = running.state !== event.state;
        running.state = event.state;
        running.progress = event.progress;
        /* A state change re-rows the pane now; a measure-only update waits for
         * the tick — it fires per chunk of a download, and the ~100ms pull is
         * both a readable display rate and a bound on the work it can cause. */
        if (!stateChanged) {
          return;
        }
        break;
      }

      case "task-output":
        /* One output line, prefixed with the target it came from. The prefix is
         * attribution, not presentation, so it applies with or without a pane. */
        this.log.log(DIAG_STEP_OUTPUT, { prefix: this.style(SGR_DIM, attribution(event.task) + " |"), line: event.line });
        return;

      case "cycle-start":
        /* A boundary, not task: nothing to draw — the pane already shows what
         * is in flight, and the record arrives on the cycle-end. */
        return;

      case "cycle-end":
        /* The per-cycle status marker. A failed cycle renders none — the
         * driver's error path reports the failure itself. */
        if (this.markers && !event.failed) {
          if (event.built.length > 0) {
            this.log.log(DIAG_BUILD_COMPLETE, { targets: event.built.join(", ") });
          } else {
            this.log.log(DIAG_UP_TO_DATE, {});
          }
        }
        return;

      case "task-end": {
        /* The map supplies the one thing the event cannot: when we first saw
         * the task (durations are the observer's own measurement). */
        const started = this.running.get(event.id);
        this.running.delete(event.id);
        if (started && !incidental(event.task)) {
          this.log.log(DIAG_TASK_DONE, {
            mark: this.style(event.failed ? SGR_FAILED : SGR_OK, event.failed ? MARK_FAILED : MARK_OK),
            what: describe(event.task),
            /* Whichever line introduces the item carries its context: with a
             * pane there was no start line to have carried it. */
            chain: this.announceStart ? "" : context(event.task),
            duration: this.style(SGR_DIM, `(${formatDuration(this.now() - started.started)})`),
          });
        }
        break;
      }
    }
    this.terminal?.paneChanged();
  }

  /**
   * The pane, within the row budget the terminal allows: a row per task
   * actually running, in start order (so a row never moves while it is up), and
   * one line for the remainder.
   *
   * A wide graph starts every action at once, so on a big build most of what
   * has begun is queued rather than happening. Counting that rather than
   * listing it keeps the pane's size a function of the screen rather than of
   * the graph, while still saying how much is behind it: "30 waiting" is the
   * useful fact, a list of 30 target names is not.
   */
  private paneContent(budget: number): IPaneContent {
    const items = [...this.running.values()];
    /* Incidental task is never individually interesting — that is what makes it
     * incidental — and a resolution has a dozen in flight at once. One row per
     * kind says as much, in a tenth of the space. */
    const summaries = this.summaryRows(items.flatMap(item => (incidental(item.task) ? [{ task: item.task, started: item.started }] : [])));
    const own = items.filter(item => !incidental(item.task));
    const running = own.filter(item => item.state === "running");
    const waiting = own.length - running.length;

    const room = Math.max(0, budget - summaries.length);
    /* Reserve a row for the tail whenever there will be something to say. */
    const listed = running.length > room || waiting > 0 ? Math.max(0, room - 1) : room;
    const rows = running.slice(0, listed).map(item => this.row(item)).concat(summaries);
    const tail = this.remainder(running.length - listed, waiting);
    return { heading: this.style(SGR_BOLD, PANE_HEADING), rows: tail ? [...rows, tail] : rows };
  }

  /** The one line for what didn't get a row — or nothing at all when everything
   *  in flight is on screen. */
  private remainder(unlisted: number, waiting: number): IPaneRow | undefined {
    const parts = [
      [unlisted, "running"],
      [waiting, "waiting"],
    ]
      .filter(([count]) => (count as number) > 0)
      .map(([count, name]) => `${count} ${name}`);
    return parts.length === 0 ? undefined : { left: this.style(SGR_DIM, `  … ${parts.join(", ")}`), right: "" };
  }

  /** Incidental task — always a fetch (see {@link incidental}) — as one row per
   *  resource kind ("Fetching metadata (12)"), timed from the oldest still
   *  running: the group's age, which is what a reader watching for something
   *  stuck actually wants. */
  private summaryRows(items: Array<{ task: IFetchTask; started: number }>): IPaneRow[] {
    const kinds = new Map<string, number[]>();
    for (const { task, started } of items) {
      const kind = task.resource;
      const starts = kinds.get(kind);
      if (starts) {
        starts.push(started);
      } else {
        kinds.set(kind, [started]);
      }
    }
    return [...kinds].map(([kind, starts]) => ({
      left: `  Fetching ${kind} (${starts.length})`,
      right: this.style(SGR_DIM, formatDuration(this.now() - Math.min(...starts))),
    }));
  }

  /** A pane row: what the task is, and how it is going — a download's bytes
   *  where it has them, and always the elapsed time. */
  private row(item: IRunningTask): IPaneRow {
    const elapsed = formatDuration(this.now() - item.started);
    const progress = item.progress ? formatProgress(item.progress) + "  " : "";
    return { left: "  " + describe(item.task), right: this.style(SGR_DIM, progress + elapsed) };
  }
}

/**
 * How far along a task is, in whichever terms it measures itself: a
 * download in bytes, a test run in files done and what they found.
 */
function formatProgress(progress: TaskProgress): string {
  return progress.measure === "bytes"
    ? formatTransfer(progress.done, progress.total)
    : formatTestRun(progress.files, progress.totalFiles, progress.passed, progress.failed);
}

/**
 * A test run in flight: files finished of the total, and the outcomes they have
 * reported. The failures are named only when there are some — a green run says
 * nothing about failures, which is what makes a red one worth noticing.
 */
function formatTestRun(files: number, totalFiles: number, passed: number, failed: number): string {
  const outcomes = failed > 0 ? `${passed} passed, ${failed} failed` : `${passed} passed`;
  return `${files}/${totalFiles} files · ${outcomes}`;
}

/**
 * A download's progress: a bar, its percentage and the size it is heading for
 * where the origin declared one, else the bare bytes so far — a chunked
 * response has no total to be a fraction of (and so nothing to draw a bar
 * against), and "how much has arrived" is still worth seeing.
 */
export function formatTransfer(done: number, total?: number): string {
  if (total === undefined || total === 0) {
    return formatBytes(done);
  }
  const fraction = Math.min(1, done / total);
  return `${formatBar(fraction)} ${Math.round(fraction * 100)}% of ${formatBytes(total)}`;
}

/** Cells in a progress bar. Small: it shares a line with the task's name, and
 *  the eighths below give it eight times its width in resolution anyway. */
const BAR_WIDTH = 10;

/** Left-to-right partial blocks, for the cell the bar is part-way through. */
const BAR_EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

/**
 * A `fraction` (0..1) as a bar of {@link BAR_WIDTH} cells. The boundary cell is
 * drawn to the nearest eighth, so a slow download is visibly moving between
 * whole cells rather than appearing stalled for a tenth of its length.
 */
function formatBar(fraction: number): string {
  const eighths = Math.round(Math.max(0, Math.min(1, fraction)) * BAR_WIDTH * 8);
  const full = Math.floor(eighths / 8);
  const partial = BAR_EIGHTHS[eighths % 8];
  return `[${"█".repeat(full)}${partial}${" ".repeat(Math.max(0, BAR_WIDTH - full - (partial ? 1 : 0)))}]`;
}

/**
 * What a task IS, in one phrase — the same text in the start line, the
 * completion line and the pane row, so the three are recognizably one thing.
 * Deliberately free of the surrounding context (which required it, under what
 * constraints): that belongs on the start line alone, where it is read once.
 */
function describe(task: TaskDescription): string {
  switch (task.kind) {
    case "target-build": {
      /* A sub-target carries its action verb as `label` ("Compiling"); anything
       * else derives its verb from the operation — which is just the
       * BUILD_OPERATION constraint, defaulting to a plain build. */
      const operation = task.constraints.get(BUILD_OPERATION) ?? "build";
      const verb = task.label ?? OPERATION_VERBS.get(operation) ?? `Running ${operation} on`;
      return `${verb} ${declName(task.target)}`;
    }
    case "repository-resolve":
      /* Named by whose requirements they are, not by the requirements: the
       * batch is a list of package names of which only the first few would
       * fit, and which say nothing about what fabr is working on. */
      return `Resolving ${task.consumer} dependencies from ${task.repository}`;
    case "fetch":
      return `Fetching ${task.resource} ${task.url}`;
  }
}

/**
 * The CLI's policy for task that goes unrecorded in the log: a registry index
 * read is a step within task already being reported (a resolution makes dozens
 * of them), so it is shown in the pane while it runs — which is where a reader
 * wants it: what is taking the time, not what took it — and never logged. The
 * event states the fact (a fetch's `role`); this is the decision made from it.
 * Only a fetch is ever incidental, which the narrowing carries to the summary
 * rows.
 */
function incidental(task: TaskDescription): task is IFetchTask {
  return task.kind === "fetch" && task.role === "index";
}

/** The context a start line adds to {@link describe}: the explicit constraints
 *  the target builds under, and the chain of targets that required it. */
function context(task: TaskDescription): string {
  if (task.kind !== "target-build") {
    return "";
  }
  const requiredBy = task.requiredBy.length > 0 ? ` (required by ${task.requiredBy.map(declName).join(" < ")})` : "";
  return renderConstraints(task.constraints) + requiredBy;
}

/** How a step's output lines are attributed: the declared target the task
 *  belongs to. Not the sub-target label — two steps of one target are both that
 *  target's output, and the prefix is there to say *whose* line this is. */
function attribution(task: TaskDescription): string {
  switch (task.kind) {
    case "target-build":
      return declName(task.target);
    case "repository-resolve":
      return task.repository;
    case "fetch":
      return task.url;
  }
}

/**
 * @return a ` [k=v, ...]` annotation of the explicit constraints a target is
 * building under (the ambient keys elided), or "" when there are none — so a
 * default build shows none.
 */
function renderConstraints(constraints: Constraints): string {
  const shown = [...constraints].filter(([key]) => !AMBIENT_CONSTRAINT_KEYS.has(key));
  return shown.length > 0 ? ` [${shown.map(([key, value]) => key + "=" + value).join(", ")}]` : "";
}
