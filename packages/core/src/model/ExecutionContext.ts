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

import { BuildCache } from "../core/BuildCache";
import { ITargetDecl } from "./AST";

/**
 * A target actually starting to build (a build-cache miss, as opposed to
 * being served from cache).
 */
export interface ITargetBuildEvent {
  kind: "target-build";
  target: ITargetDecl;
  /** The BUILD_OPERATION the evaluation is running under ('build', 'test', ...) */
  operation: string;
  /** The targets that required this one (nearest requester first; empty for
   * a target requested directly) */
  requiredBy: ITargetDecl[];
}

/**
 * A repository actually resolving a batch of requirements (as opposed to the
 * resolution being served from a memo). Emitted by the repository's own
 * implementation, since only it knows when real resolution work happens.
 */
export interface IRepositoryResolveEvent {
  kind: "repository-resolve";
  /** The repository target the requirements are resolved against */
  repository: ITargetDecl;
  /** The requirement keys of the joint batch */
  requirements: string[];
}

/**
 * A URL actually being fetched (as opposed to served from cache).
 */
export interface IFetchEvent {
  kind: "fetch";
  url: string;
  /** The target (usually a repository) on whose behalf the fetch happens */
  target: ITargetDecl;
}

/**
 * A specific build step of a declared target actually running (an anonymous
 * sub-target's cache miss), carrying the action-verb `label` its creator gave
 * it and the `declared` target it belongs to — the driver renders it as e.g.
 * "Compiling X" alongside the umbrella "Building X".
 */
export interface ISubTargetBuildEvent {
  kind: "sub-target-build";
  declared: ITargetDecl;
  label: string;
}

/**
 * Progress: work that is actually being performed, as opposed to being
 * served from cache — never emitted for a cache hit. The model and rules
 * only emit events — rendering them is the listener's (i.e. the driver's)
 * job.
 */
export type ProgressEvent = ITargetBuildEvent | ISubTargetBuildEvent | IRepositoryResolveEvent | IFetchEvent;

export type ProgressListener = (event: ProgressEvent) => void;

/**
 * The fixed runtime surroundings of a build run, as distinct from the model
 * (which is purely the declarations as written): the build cache to run
 * against and the driver's progress observers. Constructed by the driver and
 * threaded through getConfig(), so every BuildContext of a run — including
 * the constraint-override configs spawned during evaluation — shares the one
 * instance.
 */
export class ExecutionContext {
  public readonly buildCache: BuildCache;
  private progressListener?: ProgressListener;

  constructor(buildCache: BuildCache) {
    this.buildCache = buildCache;
  }

  /**
   * Install the progress listener notified as work is actually performed.
   */
  public onProgress(listener: ProgressListener): void {
    this.progressListener = listener;
  }

  public notifyProgress(event: ProgressEvent): void {
    this.progressListener?.(event);
  }
}
