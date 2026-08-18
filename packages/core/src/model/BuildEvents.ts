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

import type { OutputStream } from "../support/Execute";
import { ITargetDecl } from "./AST";
import { Constraints } from "./Constraints";

/**
 * A BuildEvent generated to report build progress.
 *
 * Event types:
 *   - cycle-start - The beginning of a build cycle. For one-shot builds, there
 *      will be exactly one cycle; For watched builds, a new cycle is initiated
 *      when changes are detected (but note only one cycle will ever be active
 *      at a time.
 *   - task-start - The beginning of an individual build task, which may be
 *      an execution, a fetch, or a resolve step. Any number of tasks may be
 *      in flight at once, and can be distinguished by the task id.
 *   - task-progress - An update to the state of an individual build task.
 *   - task-output - Output text reported from the build task
 *   - task-end - The completion of an individual build task (successfully or not)
 *   - cycle-end - The end of a build cycle once all tasks have settled.
 *
 */
export type BuildEvent =
  | ICycleStartEvent
  | ICycleEndEvent
  | ITaskStartEvent
  | ITaskProgressEvent
  | ITaskOutputEvent
  | ITaskEndEvent;

export type BuildListener = (event: BuildEvent) => void;

/**
 * A new build cycle opening: Either the initial graph build on startup
 * (cycle 0) or the watch controller is about to apply a batch of
 * changes, and the work that follows belongs to cycle `cycle`.
 */
export interface ICycleStartEvent {
  kind: "cycle-start";
  cycle: number;
}

/**
 * Cycle ended - fires when all builds within the cycle are settled (and before
 * any subsequent new cycle begins)
 */
export interface ICycleEndEvent {
  kind: "cycle-end";
  cycle: number;
  failed: boolean;
  built: string[];
}

/**
 * Base task event.
 */
export interface ITaskEvent {
  id: number;
  task: TaskDescription;
}

/**
 * Task started - fired when a task first becomes runnable (ie its dependencies are
 * satisfied and it needs to rerun). Initial state may be either "running" if it's
 * starting immediately or "waiting" if it's queued waiting on resources.
 */
export interface ITaskStartEvent extends ITaskEvent {
  kind: "task-start";
  state: TaskState;
}

/**
 * Task state update - fired either when a task transitions from waiting to running,
 * or when a task-specific update is available (bytes fetched, tests run)
 */
export interface ITaskProgressEvent extends ITaskEvent {
  kind: "task-progress";
  state: TaskState;
  progress?: TaskProgress;
}

/**
 * Task output - fired when a task generates text output (typically from execution).
 */
export interface ITaskOutputEvent extends ITaskEvent {
  kind: "task-output";
  line: string;
  /** Which of the child's streams it came from. Carried because only the child
   *  can say, and nothing downstream can recover it — never as a severity (see
   *  {@link OutputStream}). */
  stream: OutputStream;
}

/**
 * Task ended - fired when a task completes and its results have been collected.
 */
export interface ITaskEndEvent extends ITaskEvent {
  kind: "task-end";
  failed: boolean;
}

/**
 * Task-specific progress, in whichever terms the task measures itself: a
 * download in bytes (total absent when the origin declared no size), a test
 * run in files completed and test outcomes so far.
 */
export type TaskProgress =
  | { measure: "bytes"; done: number; total?: number }
  | { measure: "tests"; files: number; totalFiles: number; passed: number; failed: number };

/** Whether the task is actively doing anything, or queued waiting for
 *  execution resources. */
export type TaskState = "running" | "waiting";

/**
 * A target being built (on a build-cache miss) — either a declared target or
 * an anonymous sub-target of one. Rendered as "Building X" for a declared
 * target, or e.g. "Compiling X" for a labelled sub-target.
 */
export interface ITargetBuildTask {
  kind: "target-build";
  target: ITargetDecl;
  /** The full constraint set the target builds under, including the operation
   *  (the BUILD_OPERATION constraint; absent ⇒ build). */
  constraints: Constraints;
  /** The targets that required this one, nearest requester first; empty for a
   *  directly-requested target. */
  requiredBy: ITargetDecl[];
  /** For an anonymous sub-target: the action verb used as its display verb
   *  ("Compiling"); absent for a declared target. */
  label?: string;
}

/**
 * A repository resolving a batch of requirements (on a memo miss).
 */
export interface IRepositoryResolveTask {
  kind: "repository-resolve";
  /** The repository resolved against, as the references wrote it (the
   *  declared alias). */
  repository: string;
  /** Whose requirements these are: the consuming target at whose collection
   *  point they resolve jointly — for a catalog, the catalog itself. */
  consumer: string;
  /** The requirement keys of the joint batch. */
  requirements: string[];
}

/**
 * A URL being fetched (on a cache miss).
 */
export interface IFetchTask {
  kind: "fetch";
  url: string;
  /** The target (usually a repository) on whose behalf the fetch happens. */
  target: ITargetDecl;
  /** A human noun for what is being fetched (e.g. "metadata", "package", a
   *  file's path); the URL alone is opaque. */
  resource: string;
  /** Whether the fetch delivers content the build consumes, or reads the
   *  registry's index (a packument, per-version metadata). */
  role: "content" | "index";
}

/** How a fetch describes itself (see {@link IFetchTask}) — display only:
 *  nothing here reaches the cache key or the request. */
export type IFetchReport = Pick<IFetchTask, "resource" | "role">;

/**
 * What a task *is*: a build action, a repository resolution, or a download.
 */
export type TaskDescription = ITargetBuildTask | IRepositoryResolveTask | IFetchTask;

