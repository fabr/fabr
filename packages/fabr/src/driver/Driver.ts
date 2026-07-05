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

import {
  BUILD_OPERATION,
  BuildCache,
  Computable,
  declPosn,
  defaultLog,
  DependencyFailedError,
  Diagnostic,
  ExecutionError,
  FileConflictError,
  formatTestSummary,
  getSourceFileSource,
  getTestReport,
  ISourcePosition,
  loadProject,
  Log,
  MultiError,
  renderProvenance,
  SourceRef,
  TestsFailedError,
} from "@fabr/core";
/* The whole of @fabr/core doubles as the api object injected into plugins:
 * handing plugins the host's own module instance keeps every class and
 * registry shared (a plugin must never load a second copy of the core). */
import * as pluginApi from "@fabr/core";
import { Options } from "./Command";
import { getSourceRoot, getBuildCacheRoot, PROJECT_FILENAME, SOURCE_CACHE_FILENAME } from "./Environment";

const DIAG_BUILD_COMPLETE = Diagnostic.Info<{ count: number }>("Built {count} target(s)");
const DIAG_UP_TO_DATE = Diagnostic.Info<Record<string, never>>("Already up to date");
const DIAG_BUILD_FAILED = Diagnostic.Error<Record<string, never>>("Build failed");
const DIAG_ERROR = Diagnostic.Error<{ message: string }>("{message}");
const DIAG_TARGET_FAILED = Diagnostic.Error<{ name: string; message: string; loc: ISourcePosition }>(
  "Failed to build {name}: {message}"
);
const DIAG_DEPENDENCY_FAILED = Diagnostic.Error<{ name: string; dependency: string; loc: ISourcePosition }>(
  "Cannot build {name}: dependency '{dependency}' failed"
);
const DIAG_TESTS_FAILED = Diagnostic.Error<{ name: string; message: string; loc: ISourcePosition }>("{name}: {message}");
const DIAG_TEST_RESULT = Diagnostic.Info<{ name: string; summary: string }>("{name}: {summary}");

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
      } else if (cause instanceof TestsFailedError) {
        /* Tests failed: the target built fine, so report the (pre-rendered)
         * test summary rather than a build failure */
        log.log(DIAG_TESTS_FAILED, { name: err.target.name, message: cause.message, loc: declPosn(err.target) });
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

  /* Both the success and failure paths exit explicitly; reaching a drained
   * event loop means some computation stalled without settling (i.e. a bug),
   * which should be loud rather than a silent exit. */
  process.on("beforeExit", () => {
    log.log(DIAG_ERROR, { message: "Internal error: the build stalled without completing" });
    process.exit(2);
  });

  const sourceRoot = await getSourceRoot();
  const buildCache = new BuildCache(getBuildCacheRoot());
  const sourceFileSource = await getSourceFileSource(sourceRoot, SOURCE_CACHE_FILENAME);

  /* The system include path defaults to the directories the loaded rule
   * packages registered (core + js via their imports; plugins later) */
  const load = loadProject(sourceFileSource, PROJECT_FILENAME, buildCache, log, pluginApi);

  return load
    .then(model => {
      /* The requested command is the BUILD_OPERATION constraint (explicit
       * -DBUILD_OPERATION=... takes precedence) */
      const config = model.getConfig({ [BUILD_OPERATION]: options.command, ...options.properties });
      const targets = options.targets.map(targetName => config.getTarget(targetName));
      return Computable.forAll(targets, (...results) => reportTestResults(log, options, results)).then(() => {
        if (buildCache.getBuildCount() === 0) {
          log.log(DIAG_UP_TO_DATE, {});
        } else {
          log.log(DIAG_BUILD_COMPLETE, { count: targets.length });
        }
        process.exit(0);
      });
    })
    .catch(err => {
      reportFailure(log, err, new Set());
      log.log(DIAG_BUILD_FAILED, {});
      process.exit(1);
    });
}

/**
 * For a test run, the interesting outcome is the tests, not the build: report
 * each target's result summary from its test report artifact (whether freshly
 * run or cached-green).
 */
function reportTestResults(log: Log, options: Options, results: SourceRef[][]): Computable<void> {
  if (options.command !== "test") {
    return Computable.resolve(undefined);
  }
  return Computable.forAll(
    results.map(sources => getTestReport(sources)),
    (...reports) => {
      reports.forEach((report, i) => {
        log.log(DIAG_TEST_RESULT, { name: options.targets[i], summary: report ? formatTestSummary(report) : "no tests" });
      });
    }
  );
}
