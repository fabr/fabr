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
import type { IFetchTask, IRepositoryResolveTask, TaskProgress, TaskState } from "../support/Tasks";

/**
 * An event reporting build progress, delivered to the listeners subscribed
 * with `ExecutionContext.onBuildEvent`. A run is a series of cycles, one at a
 * time; any number of tasks may be in flight within a cycle, told apart by
 * their `id`.
 */
export type BuildEvent = ICycleStartEvent | ICycleEndEvent | ITaskStartEvent | ITaskProgressEvent | ITaskOutputEvent | ITaskEndEvent;

/** A subscriber to the build-event stream. It must not throw. */
export type BuildListener = (event: BuildEvent) => void;

/**
 * Cycle started - fires when watch mode is about to apply a batch of changes;
 * the work that follows belongs to `cycle`. The first cycle (0) has no
 * cycle-start: the stream begins in it.
 */
export interface ICycleStartEvent {
  kind: "cycle-start";
  cycle: number;
}

/**
 * Cycle ended - fires when all builds within the cycle are settled (and before
 * any subsequent new cycle begins). Fires once per cycle, even where nothing
 * changed; a cycle superseded before it settles gets none.
 */
export interface ICycleEndEvent {
  kind: "cycle-end";
  cycle: number;
  /** True if the run's evaluation settled with an error. */
  failed: boolean;
  /** The directly requested targets that had a task performed for them this
   *  cycle (a dependency's task counts for the target that required it). */
  built: string[];
}

/**
 * The fields every task event carries.
 */
export interface ITaskEvent {
  /** The task's identity, unique within the run; two tasks may share a
   *  description. */
  id: number;
  task: TaskDescription;
}

/**
 * Task started - fires when work begins on a task: a build action on a cache
 * miss, a fetch, a resolve or a publish. `state` is always "running" here; a
 * task that then queues for an execution slot reports "waiting" in task-progress.
 */
export interface ITaskStartEvent extends ITaskEvent {
  kind: "task-start";
  state: TaskState;
}

/**
 * Task progress - fires whenever the task's state changes (running or
 * waiting), and whenever it reports a new progress measure (bytes fetched,
 * tests run). Each event carries both the state and the latest measure.
 */
export interface ITaskProgressEvent extends ITaskEvent {
  kind: "task-progress";
  state: TaskState;
  progress?: TaskProgress;
}

/**
 * Task output - fires per line of output from a task's processes; only when a
 * listener subscribed with `output: true`.
 */
export interface ITaskOutputEvent extends ITaskEvent {
  kind: "task-output";
  line: string;
  /** The process stream the line came from; not a severity. */
  stream: OutputStream;
}

/**
 * Task ended - fires when a task completes, successfully or not.
 */
export interface ITaskEndEvent extends ITaskEvent {
  kind: "task-end";
  /** True if the task's work rejected, or it reported a failure of its own (a
   *  red test run). */
  failed: boolean;
  /** The error that ended a failed task, for a one-line summary beside it;
   *  the failure itself is reported by the evaluation's rejection. */
  error?: Error;
}

/**
 * A target being built on a cache miss: a declared target or a sub-target of
 * one. Rendered as "Building X" for a declared target, or e.g. "Compiling X"
 * for a labelled sub-target.
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
  /** For a labelled sub-target, the participle to render it with
   *  ("Compiling"); absent otherwise. */
  label?: string;
  /** For a target of a rule's block, or one made for it: the name the block
   *  gives it and those of the block targets it is built for, innermost first
   *  (`["jar"]` for a rule's `jar` built for `shop`); absent otherwise. */
  subtargetNames?: readonly string[];
}

/**
 * A `` `cmd` `` substitution being run on a cache miss. It belongs to no
 * target (it may be written in a global), so it is named by its command.
 */
export interface ICommandSubstTask {
  kind: "command-subst";
  /** The command as written between the backticks. */
  command: string;
}

/**
 * A `sync` member being published to its destination (`fabr sync`).
 */
export interface IPublishTask {
  kind: "publish";
  /** The member's coordinate, as written (`@aws:s3:acme-site:v3/`). */
  destination: string;
}

/**
 * The description of a task: a target build, a repository resolution, a
 * download, a command substitution, or a publish.
 */
export type TaskDescription = ITargetBuildTask | IRepositoryResolveTask | IFetchTask | ICommandSubstTask | IPublishTask;
