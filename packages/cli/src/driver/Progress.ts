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
  BuildEvent,
  BuildListener,
  Constraints,
  declName,
  Diagnostic,
  CommandFailedError,
  errorSummary,
  IFetchTask,
  Log,
  operationOf,
  shownConstraints,
  TaskDescription,
  TaskProgress,
  TaskState,
} from "@fabr-build/core";
import { IPaneContent, IPaneRow, TerminalStream } from "./Terminal";

const DIAG_TASK_START = Diagnostic.Info<{ what: string; chain: string }>("{what}{chain}");
const DIAG_TASK_DONE = Diagnostic.Info<{ mark: string; what: string; chain: string; duration: string; reason: string }>(
  "{mark} {what}{chain} {duration}{reason}"
);
const DIAG_STEP_OUTPUT = Diagnostic.Info<{ prefix: string; line: string }>("{prefix} {line}");
const DIAG_BUILD_COMPLETE = Diagnostic.Info<{ targets: string; duration: string }>("Built {targets} {duration}");
const DIAG_UP_TO_DATE = Diagnostic.Info<{ duration: string }>("Already up to date {duration}");
const DIAG_CHANGES_DETECTED = Diagnostic.Info<Record<string, never>>("Changes detected, rebuilding");

/** The progress verbs of the well-known operations; any other renders as
 *  "Running <operation> on <target>". */
const OPERATION_VERBS = new Map([
  ["build", "Building"],
  ["test", "Testing"],
  ["run", "Running"],
]);

/** The marks of a finished task's line in the log, which repeats the start
 *  line's text after the mark. */
const MARK_OK = "✓";
const MARK_FAILED = "✗";

/** The shortest wait for a process slot a completion line reports. */
const SHOWN_WAIT_MS = 1000;

/** The pane's heading, above the rows. */
const PANE_HEADING = "Running:";

/* SGR codes for the palette, applied where the reporter is given `color`. */
const SGR_OK = "32";
const SGR_FAILED = "31";
const SGR_DIM = "2";
const SGR_BOLD = "1";

/**
 * @return `ms` as a human duration: whole milliseconds below a second, else
 * seconds to one decimal place.
 */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Decimal size units. */
const BYTE_UNITS = ["B", "kB", "MB", "GB", "TB"];

/**
 * @return `bytes` as a human size: whole bytes below a kilobyte, else one
 * decimal place in the largest unit that leaves a number under 1000.
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

/** One line of a step's output, as it will be logged. */
interface IOutputLine {
  prefix: string;
  line: string;
}

/** A task started and not yet ended, as the reporter saw it. */
interface IRunningTask {
  task: TaskDescription;
  /** When the reporter saw it start. */
  started: number;
  /** Its state, and when it entered it. */
  state: TaskState;
  since: number;
  /** The time it spent waiting before `since`. */
  waited: number;
  /** The last measure it reported. */
  progress?: TaskProgress;
  /** The output lines held until it ends, where output is held. */
  held: IOutputLine[];
}

/**
 * A build listener that renders the build events to the log and, given a
 * terminal with a pane, to the pane. It logs:
 * - a line as a task starts, where there is no pane and the run is not quiet;
 * - a line as a task ends, with its mark, how long it ran, how long it waited
 *   for a process slot where that was at least {@link SHOWN_WAIT_MS}, and a
 *   failure's one-line reason; the task's context (constraints and the targets
 *   that required it) is on this line where there was no start line;
 * - each line of a task's output, prefixed with whom it is attributed to and
 *   the stream it came on. With a pane, a task's lines are held until it ends
 *   and logged after its end line, or dropped where its error is a
 *   CommandFailedError, which carries them;
 * - where `markers` (the default), "Changes detected, rebuilding" as a cycle
 *   starts and "Built …" or "Already up to date" as a cycle ends without
 *   failing.
 *
 * Incidental tasks ({@link incidental}) log no start or end line.
 */
export class ProgressReporter {
  private readonly running = new Map<number, IRunningTask>();
  private readonly log: Log;
  private readonly terminal?: TerminalStream;
  /** The clock, in milliseconds; a test supplies its own. */
  private readonly now: () => number;
  /** Paint text in an SGR colour, or leave it plain. */
  private readonly style: (code: string, text: string) => string;
  /** Whether a task's start is logged: where there is no pane and the run is not quiet. */
  private readonly announceStart: boolean;
  /** Whether a task's output is held until it ends: where there is a pane. */
  private readonly holdOutput: boolean;
  /** Whether cycles log their start and outcome lines. */
  private readonly markers: boolean;
  /** When the current cycle began, as this reporter saw it: its construction
   *  for the first cycle, which has no cycle-start, else the cycle-start. */
  private cycleStarted: number;

  constructor(
    log: Log,
    options: { terminal?: TerminalStream; color?: boolean; quiet?: boolean; markers?: boolean; now?: () => number } = {}
  ) {
    this.log = log;
    this.terminal = options.terminal;
    this.now = options.now ?? ((): number => Date.now());
    this.style = options.color ? (code, text) => `\x1b[${code}m${text}\x1b[0m` : (_code, text) => text;
    this.announceStart = !(this.terminal?.hasPane ?? false) && !options.quiet;
    this.holdOutput = this.terminal?.hasPane ?? false;
    this.markers = options.markers ?? true;
    this.cycleStarted = this.now();
    /* The terminal asks for the pane's content at each paint. */
    this.terminal?.setPaneSource(budget => this.paneContent(budget));
  }

  /** The listener to subscribe to the run's build events. */
  public get buildListener(): BuildListener {
    return event => this.onBuildEvent(event);
  }

  private onBuildEvent(event: BuildEvent): void {
    switch (event.kind) {
      case "task-start": {
        const now = this.now();
        this.running.set(event.id, { task: event.task, started: now, state: event.state, since: now, waited: 0, held: [] });
        if (this.announceStart && !incidental(event.task)) {
          this.log.log(DIAG_TASK_START, { what: describe(event.task), chain: context(event.task) });
        }
        break;
      }

      case "task-progress": {
        const running = this.running.get(event.id);
        if (!running) {
          return;
        }
        const stateChanged = running.state !== event.state;
        if (stateChanged) {
          const now = this.now();
          running.waited = this.waitedBy(running, now);
          running.since = now;
        }
        running.state = event.state;
        running.progress = event.progress;
        /* Repaint now for a state change only: a measure arrives per chunk of
         * a download, and is shown at the terminal's next tick. */
        if (!stateChanged) {
          return;
        }
        break;
      }

      case "task-output": {
        /* Prefix the line with whom it is attributed to and the stream it
         * came on (`out` or `err`, both named alike), held or not. */
        const output = { prefix: this.style(SGR_DIM, `${attribution(event.task)} ${event.stream}|`), line: event.line };
        const running = this.holdOutput ? this.running.get(event.id) : undefined;
        if (running) {
          running.held.push(output);
        } else {
          this.log.log(DIAG_STEP_OUTPUT, output);
        }
        return;
      }

      case "cycle-start":
        this.cycleStarted = this.now();
        /* Only a watch run's later cycles have a cycle-start. */
        if (this.markers) {
          this.log.log(DIAG_CHANGES_DETECTED, {});
        }
        return;

      case "cycle-end":
        /* A failed cycle logs no marker: the driver reports the failure. */
        if (this.markers && !event.failed) {
          const duration = this.style(SGR_DIM, `(${formatDuration(this.now() - this.cycleStarted)})`);
          if (event.built.length > 0) {
            this.log.log(DIAG_BUILD_COMPLETE, { targets: event.built.join(", "), duration });
          } else {
            this.log.log(DIAG_UP_TO_DATE, { duration });
          }
        }
        return;

      case "task-end": {
        /* The task's times are measured from when the reporter saw it start. */
        const started = this.running.get(event.id);
        this.running.delete(event.id);
        if (started && !incidental(event.task)) {
          this.log.log(DIAG_TASK_DONE, {
            mark: this.style(event.failed ? SGR_FAILED : SGR_OK, event.failed ? MARK_FAILED : MARK_OK),
            what: describe(event.task),
            /* The context goes on whichever line is the task's first. */
            chain: this.announceStart ? "" : context(event.task),
            duration: this.style(SGR_DIM, `(${this.formatTimes(started)})`),
            reason: failureReason(event.error),
          });
        }
        if (started && !(event.error instanceof CommandFailedError)) {
          started.held.forEach(output => this.log.log(DIAG_STEP_OUTPUT, output));
        }
        break;
      }
    }
    this.terminal?.paneChanged();
  }

  /**
   * Make the pane's content within `budget` rows: a row per task in the
   * running state, in start order, as many as fit beside the others; a row per
   * kind of incidental task in flight; and a last row counting the running
   * tasks not listed and the tasks waiting for a slot, where there are any.
   */
  private paneContent(budget: number): IPaneContent {
    const items = [...this.running.values()];
    /* Incidental tasks get one row per kind of resource fetched. */
    const summaries = this.summaryRows(
      items.flatMap(item => (incidental(item.task) ? [{ task: item.task, started: item.started }] : []))
    );
    const own = items.filter(item => !incidental(item.task));
    const running = own.filter(item => item.state === "running");
    const waiting = own.length - running.length;

    const room = Math.max(0, budget - summaries.length);
    /* Reserve a row for the count where there will be one. */
    const listed = running.length > room || waiting > 0 ? Math.max(0, room - 1) : room;
    const rows = running
      .slice(0, listed)
      .map(item => this.row(item))
      .concat(summaries);
    const tail = this.remainder(running.length - listed, waiting);
    return { heading: this.style(SGR_BOLD, PANE_HEADING), rows: tail ? [...rows, tail] : rows };
  }

  /** Make the row counting the running tasks not listed and the tasks
   *  waiting, or undefined where there are none. */
  private remainder(unlisted: number, waiting: number): IPaneRow | undefined {
    const parts = [
      [unlisted, "running"],
      [waiting, "waiting"],
    ]
      .filter(([count]) => (count as number) > 0)
      .map(([count, name]) => `${count} ${name}`);
    return parts.length === 0 ? undefined : { left: this.style(SGR_DIM, `  … ${parts.join(", ")}`), right: "" };
  }

  /** Summarise incidental tasks, which are fetches, as one row per resource
   *  kind ("Fetching metadata (12)"), timed from the oldest still running. */
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

  /** Make a pane row: what the task is, and how it is going — its progress
   *  measure where it has one (a download's bytes, a test run's files and
   *  outcomes), and always the elapsed time. */
  private row(item: IRunningTask): IPaneRow {
    const elapsed = formatDuration(this.ranBy(item, this.now()));
    const progress = item.progress ? formatProgress(item.progress) + "  " : "";
    return { left: "  " + describe(item.task), right: this.style(SGR_DIM, progress + elapsed) };
  }

  /** @return how long the task has spent waiting for a slot, up to `now`. */
  private waitedBy(item: IRunningTask, now: number): number {
    return item.waited + (item.state === "waiting" ? now - item.since : 0);
  }

  /** @return how long the task has spent running, up to `now`. */
  private ranBy(item: IRunningTask, now: number): number {
    return now - item.started - this.waitedBy(item, now);
  }

  /** Format a finished task's times: how long it ran, and how long it waited
   *  for a slot where that was long enough to account for. */
  private formatTimes(item: IRunningTask): string {
    const now = this.now();
    const waited = this.waitedBy(item, now);
    const ran = formatDuration(this.ranBy(item, now));
    return waited >= SHOWN_WAIT_MS ? `${ran}, ${formatDuration(waited)} waiting` : ran;
  }
}

/**
 * Format how far along a task is, in the terms it measures itself in: a
 * download in bytes, a test run in files done and their outcomes.
 */
function formatProgress(progress: TaskProgress): string {
  return progress.measure === "bytes"
    ? formatTransfer(progress.done, progress.total)
    : formatTestRun(progress.files, progress.totalFiles, progress.passed, progress.failed);
}

/**
 * Format a test run in flight: files finished of the total, and the outcomes they have
 * reported. The failures are named only when there are some.
 */
function formatTestRun(files: number, totalFiles: number, passed: number, failed: number): string {
  const outcomes = failed > 0 ? `${passed} passed, ${failed} failed` : `${passed} passed`;
  return `${files}/${totalFiles} files · ${outcomes}`;
}

/**
 * Format a download's progress: a bar, its percentage and the total size
 * where `total` is known and non-zero, else the bytes so far.
 */
export function formatTransfer(done: number, total?: number): string {
  if (total === undefined || total === 0) {
    return formatBytes(done);
  }
  const fraction = Math.min(1, done / total);
  return `${formatBar(fraction)} ${Math.round(fraction * 100)}% of ${formatBytes(total)}`;
}

/** The cells in a progress bar. */
const BAR_WIDTH = 10;

/** Left-to-right partial blocks, for the cell the bar is part-way through. */
const BAR_EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

/**
 * Draw a `fraction` (0..1) as a bar of {@link BAR_WIDTH} cells, the cell it
 * ends in drawn to the nearest eighth.
 */
function formatBar(fraction: number): string {
  const eighths = Math.round(Math.max(0, Math.min(1, fraction)) * BAR_WIDTH * 8);
  const full = Math.floor(eighths / 8);
  const partial = BAR_EIGHTHS[eighths % 8];
  return `[${"█".repeat(full)}${partial}${" ".repeat(Math.max(0, BAR_WIDTH - full - (partial ? 1 : 0)))}]`;
}

/**
 * Describe a task in one phrase, the text of its start line, end line and
 * pane row ("Building app", "Compiling app", "Fetching metadata <url>"). The
 * constraints and the targets that required it are {@link context}'s.
 */
export function describe(task: TaskDescription): string {
  switch (task.kind) {
    case "target-build": {
      /* A sub-target's verb is its `label` ("Compiling"); any other's comes
       * from the operation. */
      const operation = operationOf(task.constraints);
      const verb = task.label ?? OPERATION_VERBS.get(operation) ?? `Running ${operation} on`;
      return `${verb} ${[...(task.subtargetNames ?? []), declName(task.target)].join(" for ")}`;
    }
    case "repository-resolve":
      /* Named by whose requirements they are: the consuming target, or the catalog. */
      return `Resolving ${task.consumer} dependencies from ${task.repository}`;
    case "fetch":
      return `Fetching ${task.resource} ${task.url}`;
    case "command-subst":
      /* A substitution belongs to no target: named by its command as written. */
      return `Running \`${task.command}\``;
    case "publish":
      return `Publishing ${task.destination}`;
  }
}

/**
 * @return true if the task is incidental, otherwise false: a fetch whose
 * `role` is `index` (a registry index read). An incidental task is summarised
 * in the pane and never logged.
 */
export function incidental(task: TaskDescription): task is IFetchTask {
  return task.kind === "fetch" && task.role === "index";
}

/** Render the context a task's first line adds to {@link describe}: the
 *  explicit constraints the target builds under, and the chain of targets that
 *  required it. */
export function context(task: TaskDescription): string {
  if (task.kind !== "target-build") {
    return "";
  }
  const requiredBy = task.requiredBy.length > 0 ? ` (required by ${task.requiredBy.map(declName).join(" < ")})` : "";
  return renderConstraints(task.constraints) + requiredBy;
}

/** Name whom a task's output lines are attributed to: for a target's task,
 *  the declared target, whichever of its sub-targets the task is for. */
function attribution(task: TaskDescription): string {
  switch (task.kind) {
    case "target-build":
      return declName(task.target);
    case "repository-resolve":
      return task.repository;
    case "fetch":
      return task.url;
    case "command-subst":
      return `\`${task.command}\``;
    case "publish":
      return task.destination;
  }
}

/** Render `: <why>` for a failed task's completion line, or "" when its error
 * says nothing on one line. */
function failureReason(error: Error | undefined): string {
  const summary = error === undefined ? undefined : errorSummary(error);
  return summary === undefined ? "" : `: ${summary}`;
}

/**
 * @return a ` [k=v, ...]` annotation of the explicit constraints a target is
 * building under ({@link shownConstraints}), or "" when there are none.
 */
function renderConstraints(constraints: Constraints): string {
  const shown = shownConstraints(constraints);
  return shown.length > 0 ? ` [${shown.map(([key, value]) => key + "=" + value).join(", ")}]` : "";
}
