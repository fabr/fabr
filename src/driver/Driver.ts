/*
 * Copyright (c) 2022 Nathan Keynes <nkeynes@deadcoderemoval.net>
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
import { Computable } from "../core/Computable";
import { MultiError } from "../core/MultiError";
import { FileConflictError, renderProvenance } from "../core/Provenance";
import { ExecutionError } from "../support/Execute";
import { getSourceFileSource } from "../core/SourceFileSource";
import { declPosn } from "../model/AST";
import { DependencyFailedError } from "../model/BuildContext";
import { loadProject } from "../model/Loader";
import { defaultLog, Diagnostic, ISourcePosition, Log } from "../support/Log";
import { Options } from "./Command";
import { getSourceRoot, getBuildCacheRoot, PROJECT_FILENAME, SOURCE_CACHE_FILENAME } from "./Environment";

const DIAG_BUILD_COMPLETE = Diagnostic.Info<{ count: number }>("Built {count} target(s)");
const DIAG_BUILD_FAILED = Diagnostic.Error<Record<string, never>>("Build failed");
const DIAG_ERROR = Diagnostic.Error<{ message: string }>("{message}");
const DIAG_TARGET_FAILED = Diagnostic.Error<{ name: string; message: string; loc: ISourcePosition }>(
  "Failed to build {name}: {message}"
);
const DIAG_DEPENDENCY_FAILED = Diagnostic.Error<{ name: string; dependency: string; loc: ISourcePosition }>(
  "Cannot build {name}: dependency '{dependency}' failed"
);

/**
 * Render a build failure tree: each failed target is reported once, against its
 * own declaration; targets that failed only because a dependency failed get a
 * terse one-liner rather than a repeat of the root cause.
 */
function reportFailure(log: Log, err: Error, reported: Set<Error>): void {
  if (reported.has(err)) {
    return;
  }
  reported.add(err);
  if (err instanceof MultiError) {
    err.errors.forEach(cause => reportFailure(log, cause, reported));
  } else if (err instanceof DependencyFailedError) {
    const causes = err.cause instanceof MultiError ? err.cause.errors : [err.cause];
    const execution: Error[] = [];
    for (const cause of causes) {
      if (cause instanceof DependencyFailedError) {
        log.log(DIAG_DEPENDENCY_FAILED, { name: err.target.name, dependency: cause.target.name, loc: declPosn(err.target) });
        reportFailure(log, cause, reported);
      } else if (cause instanceof ExecutionError) {
        execution.push(cause);
      } else {
        /* Semantic diagnostics (conflicts, resolution failures, ...) each get
         * their own report, with any provenance detail attached */
        const message =
          cause instanceof FileConflictError ? `${cause.message}\n${renderConflictDetail(cause)}` : cause.message;
        log.log(DIAG_TARGET_FAILED, { name: err.target.name, message, loc: declPosn(err.target) });
      }
    }
    if (execution.length > 0) {
      /* Mechanical failures of the target's execution are reported once,
       * grouped under the target */
      log.log(DIAG_TARGET_FAILED, { name: err.target.name, message: describeCauses(execution), loc: declPosn(err.target) });
    }
  } else {
    log.log(DIAG_ERROR, { message: err.message });
  }
}

/**
 * Format the execution errors of a target as a single message: one error
 * inline, several as an indented list.
 */
function describeCauses(causes: Error[]): string {
  if (causes.length === 1) {
    return causes[0].message;
  }
  return `${causes.length} errors:\n` + causes.map(cause => "  " + cause.message.split("\n").join("\n  ")).join("\n");
}

/**
 * Expand both sides of a file conflict into an indented explanation, by
 * rendering each side's provenance chain (model references, target
 * evaluations, repository resolutions, ...).
 */
function renderConflictDetail(err: FileConflictError): string {
  const lines: string[] = [];
  for (const side of [err.left, err.right]) {
    const provenance = renderProvenance(side.provenance, { path: err.path });
    if (provenance.length > 0) {
      /* The chain's first line is its own position-prefixed header */
      lines.push("  " + provenance[0]);
      provenance.slice(1).forEach(line => lines.push("    " + line));
    } else {
      lines.push(`  from '${side.label}' (no origin information)`);
    }
  }
  return lines.join("\n");
}

export async function runFabr(options: Options): Promise<void> {
  const log = defaultLog;

  const sourceRoot = await getSourceRoot();
  const buildCache = new BuildCache(getBuildCacheRoot());
  const sourceFileSource = await getSourceFileSource(sourceRoot, SOURCE_CACHE_FILENAME);

  const load = loadProject(sourceFileSource, PROJECT_FILENAME, buildCache, log);

  return load
    .then(model => {
      const config = model.getConfig(options.properties);
      const targets = options.targets.map(targetName => config.getTarget(targetName));
      return Computable.forAll(targets, () => {
        log.log(DIAG_BUILD_COMPLETE, { count: targets.length });
        process.exit(0);
      });
    })
    .catch(err => {
      reportFailure(log, err, new Set());
      log.log(DIAG_BUILD_FAILED, {});
      process.exit(1);
    });
}
