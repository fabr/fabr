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
  ExecutionContext,
  ExecutionError,
  FileConflictError,
  FileSet,
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
/* An anonymous sub-target's failure, rendered against its declared target with
 * its action-verb label ("Compiling @fabr/core failed"); the detail (the
 * command and its output) follows the source excerpt, so it leads with a
 * newline. */
const DIAG_SUBTARGET_FAILED = Diagnostic.Error<{ verb: string; name: string; message: string; loc: ISourcePosition }>(
  "{verb} {name} failed:\n{message}"
);
const DIAG_DEPENDENCY_FAILED = Diagnostic.Error<{ name: string; dependency: string; loc: ISourcePosition }>(
  "Cannot build {name}: dependency '{dependency}' failed"
);
const DIAG_TESTS_FAILED = Diagnostic.Error<{ name: string; message: string; loc: ISourcePosition }>("{name}: {message}");
const DIAG_TEST_RESULT = Diagnostic.Info<{ name: string; summary: string }>("{name}: {summary}");
const DIAG_BUILDING = Diagnostic.Info<{ verb: string; name: string; chain: string }>("{verb} {name}{chain}");
const DIAG_RESOLVING = Diagnostic.Info<{ requirements: string; name: string }>("Resolving {requirements} from {name}");
const DIAG_FETCHING = Diagnostic.Info<{ url: string }>("Fetching {url}");

/** Progress verbs for the well-known operations; anything else renders as
 * "Running <operation> on <target>" */
const OPERATION_VERBS: Record<string, string> = { build: "Building", test: "Testing", run: "Running" };

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
        /* An anonymous sub-target (label set) is an implementation detail of
         * its declared target: skip the "dependency failed" hop and let its
         * own report ("Compiling X failed") stand for it. */
        if (!cause.label) {
          log.log(DIAG_DEPENDENCY_FAILED, { name: err.target.name, dependency: cause.target.name, loc: declPosn(err.target) });
        }
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
      /* Mechanical failures of the target's execution, reported once. An
       * anonymous sub-target (label set) reports against its declared target
       * with its verb ("Compiling X failed"); a declared target as "Failed to
       * build X". Either way `target` is the declared decl. */
      const message = describeCauses(execution);
      if (err.label) {
        log.log(DIAG_SUBTARGET_FAILED, { verb: err.label, name: err.target.name, message, loc: declPosn(err.target) });
      } else {
        log.log(DIAG_TARGET_FAILED, { name: err.target.name, message, loc: declPosn(err.target) });
      }
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
    /* The concrete file, so identical-provenance conflicts stay diagnosable */
    lines.push(`    at ${side.file.getDisplayName()}`);
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

  /* The run's fixed surroundings: the cache to build against, plus our
   * progress observer — a target is announced when (and only when) it
   * actually starts building (its first build-cache miss), attributed with
   * the chain of targets that required it */
  const execution = new ExecutionContext(buildCache);
  execution.onProgress(event => {
    switch (event.kind) {
      case "target-build": {
        const verb = OPERATION_VERBS[event.operation] ?? `Running ${event.operation} on`;
        const chain = event.requiredBy.length > 0 ? ` (required by ${event.requiredBy.map(decl => decl.name).join(" < ")})` : "";
        log.log(DIAG_BUILDING, { verb, name: event.target.name, chain });
        break;
      }
      case "sub-target-build":
        log.log(DIAG_BUILDING, { verb: event.label, name: event.declared.name, chain: "" });
        break;
      case "repository-resolve":
        log.log(DIAG_RESOLVING, { requirements: event.requirements.join(", "), name: event.repository.name });
        break;
      case "fetch":
        log.log(DIAG_FETCHING, { url: event.url });
        break;
    }
  });

  /* The system include path defaults to the directories the loaded rule
   * packages registered (core + js via their imports; plugins later) */
  const load = loadProject(sourceFileSource, PROJECT_FILENAME, log, pluginApi);

  return load
    .then(model => {
      /* The requested command is the BUILD_OPERATION constraint (explicit
       * -DBUILD_OPERATION=... takes precedence); `ls` is a driver verb, not
       * an operation — it builds and then lists */
      const operation = options.command === "ls" ? "build" : options.command;
      const config = model.getConfig({ [BUILD_OPERATION]: operation, ...options.properties }, execution);
      const targets = options.targets.map(targetName => config.getTarget(targetName));
      return Computable.forAll(targets, (...results) =>
        options.command === "ls" ? listTargets(options, results) : reportTestResults(log, options, results)
      ).then(() => {
        if (options.command === "ls") {
          /* The listing is the outcome; no build-status line */
        } else if (buildCache.getBuildCount() === 0) {
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
/**
 * For `fabr ls`, the listing is the outcome: print each built target's
 * contents (sorted by name), with a `target:` header when more than one
 * target was requested. A target is by definition a built thing, so its
 * results are FileSets already — union and enumerate them directly. Listing
 * output is the command's data, so it goes straight to stdout rather than
 * through the diagnostic log.
 */
function listTargets(options: Options, results: SourceRef[][]): Computable<void> {
  return Computable.forAll(
    results.map(sources =>
      renderListing(
        FileSet.unionAll(...sources.filter((source): source is FileSet => source instanceof FileSet)),
        options.longListing
      )
    ),
    (...listings) => {
      listings.forEach((lines, i) => {
        if (listings.length > 1) {
          console.log(`${i > 0 ? "\n" : ""}${options.targets[i]}:`);
        }
        lines.forEach(line => console.log(line));
      });
    }
  );
}

/**
 * @return the listing lines: names only, or `hash size name` for the long
 * form (hashes abbreviated, sizes right-aligned).
 */
function renderListing(files: FileSet, longListing: boolean): Computable<string[]> {
  const entries = [...files].sort(([a], [b]) => a.localeCompare(b));
  if (!longListing) {
    return Computable.resolve(entries.map(([name]) => name));
  }
  return Computable.forAll(
    entries.map(([, file]) => file.getBuffer()),
    (...buffers) => {
      const width = Math.max(1, ...buffers.map(buffer => String(buffer.byteLength).length));
      return entries.map(
        ([name, file], i) => `${file.hash.substring(0, 12)} ${String(buffers[i].byteLength).padStart(width)} ${name}`
      );
    }
  );
}

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
