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

/*
 * The descriptions and measures of the tasks the engine's lower layers start
 * and report: what a producer of the build-event stream (model/BuildEvents)
 * says of a task that belongs to no target.
 */

/**
 * Task-specific progress, in whichever terms the task measures itself: a
 * download in bytes (total absent when the origin declared no size), a test
 * run in files completed and test outcomes so far.
 */
export type TaskProgress =
  | { measure: "bytes"; done: number; total?: number }
  | { measure: "tests"; files: number; totalFiles: number; passed: number; failed: number; latest?: ITestFileRun };

/** A test file's run as its report states it: the file, the run's wall-clock
 *  start and stop (epoch milliseconds, the runner's own timing) and its
 *  outcomes. Carried on the tests measure for the invocation just finished. */
export interface ITestFileRun {
  file: string;
  start: number;
  stop: number;
  passed: number;
  failed: number;
}

/** Whether the task is actively doing anything, or queued waiting for
 *  execution resources. */
export type TaskState = "running" | "waiting";

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
  /** A human noun for what is being fetched (e.g. "metadata", "package", a
   *  file's path); the URL alone is opaque. */
  resource: string;
  /** Whether the fetch delivers content the build consumes, or reads the
   *  registry's index (a packument, per-version metadata). */
  role: "content" | "index";
}

/** How a fetch describes itself (see {@link IFetchTask}). Its role also
 *  decides the request's admission; nothing here reaches the cache key. */
export type IFetchReport = Pick<IFetchTask, "resource" | "role">;
