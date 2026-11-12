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
 */

/**
 * The runner core of fabr's node:test flavour: parse the invocation fabr makes,
 * drive node:test over the test files with a given set of preloads, and write
 * the CTRF report.
 *
 * A node:test flavour is this core plus a preload, the module that installs in
 * each test process whatever the test files expect to find there (the native
 * runner's installs describe/it). The jest and vitest flavours drive their own
 * frameworks and take only the invocation parsing and the per-test timeout
 * from here.
 */

import { run } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readsRecordedIn, withPnpTable, writeReads } from "./Reads";
import type { ITestResult } from "@fabr-build/core";
import { buildReport, describeSnapshotFailure, IFailureDescription, reportPathOf, TEST_REPORT_FILENAME } from "./Report";

/** The fields read from node:test's test:pass and test:fail event data,
 * declared structurally to accept every supported node version's shape. */
interface ITestEvent {
  name: string;
  file?: string;
  skip?: boolean | string;
  todo?: boolean | string;
  details: {
    duration_ms?: number;
    /** 'suite' for a describe block's completion, which aggregates its children. */
    type?: string;
    error?: Error & { cause?: unknown };
  };
}

/** A parsed runner invocation (the runner contract's arguments). */
export interface IRunnerOptions {
  /** Where to write the CTRF report. */
  report: string;
  /** The environment the tests run in: `node` or `jsdom`. */
  env: string;
  /** Whether recorded snapshots are rewritten rather than checked. */
  update: boolean;
  /** The regular expression a test's full name (its suites' names and its own,
   * joined by spaces) must match for the test to run; every test runs where
   * there is none. */
  namePattern?: string;
  /** What every test process loads before any test file, in the order given: a
   * bare module name, or a `./`-prefixed path within the installation. */
  setup: string[];
  /** Where to write the reads document (see Reads.ts), if asked for. */
  reads?: string;
  /** The PnP table the test processes resolve modules through, where the
   * installation has one in place of a `node_modules` tree (see pnp/Runtime.ts). */
  pnp?: string;
  /** The test files to run. */
  files: string[];
}

/** Parse the runner contract's arguments. Throws on an option it does not
 * define. */
export function parseRunnerArgs(argv: string[]): IRunnerOptions {
  const options: IRunnerOptions = { report: TEST_REPORT_FILENAME, env: "node", update: false, setup: [], files: [] };
  for (const arg of argv) {
    if (arg.startsWith("--report=")) {
      options.report = arg.substring("--report=".length);
    } else if (arg.startsWith("--env=")) {
      options.env = arg.substring("--env=".length);
    } else if (arg === "--update-snapshots") {
      options.update = true;
    } else if (arg.startsWith("--name-pattern=")) {
      options.namePattern = arg.substring("--name-pattern=".length);
    } else if (arg.startsWith("--setup=")) {
      options.setup.push(arg.substring("--setup=".length));
    } else if (arg.startsWith("--reads=")) {
      options.reads = arg.substring("--reads=".length);
    } else if (arg.startsWith("--pnp=")) {
      options.pnp = path.resolve(arg.substring("--pnp=".length));
    } else if (arg.startsWith("-")) {
      /* Refuse an unknown option rather than taking it as a test file: it means
       * fabr and the runner disagree about the contract. */
      throw new Error(`Unknown test runner option '${arg}'`);
    } else {
      options.files.push(arg);
    }
  }
  return options;
}

/** The output each test file wrote to stderr, which supplies the trace of a
 * whole-file failure (see fileFailureDetail). */
class CapturedStderr {
  private readonly byFile = new Map<string, string>();

  public add(file: string | undefined, message: string | undefined): void {
    if (file !== undefined && message !== undefined) {
      this.byFile.set(file, (this.byFile.get(file) ?? "") + message);
    }
  }

  /** Get the last {@link STDERR_TAIL_LINES} lines `file` wrote, or undefined
   * where it wrote nothing but whitespace. */
  public tail(file: string | undefined): string | undefined {
    const captured = file === undefined ? undefined : this.byFile.get(file)?.trim();
    if (!captured) {
      return undefined;
    }
    const lines = captured.split("\n");
    return lines.length > STDERR_TAIL_LINES ? lines.slice(-STDERR_TAIL_LINES).join("\n") : captured;
  }
}

/** The number of lines of a failed file's stderr the report carries. */
const STDERR_TAIL_LINES = 40;

/** Add the result an outcome event reports to `results`, if it reports one:
 * a test's outcome, or a whole file's failure (a file that ran no test and
 * passed adds nothing). */
function record(results: ITestResult[], event: ITestEvent, kind: "pass" | "fail", stderr: CapturedStderr): void {
  if (event.details.type === "suite") {
    /* A suite's completion aggregates its children, which are recorded
     * themselves. */
    return;
  }
  if (kind === "pass" && isFileFailure(event)) {
    /* The file itself passing: it ran no test (none registered, or none its
     * name pattern selected), so it contributes no result. */
    return;
  }
  let status: ITestResult["status"] = kind === "fail" ? "failed" : "passed";
  if (kind === "pass" && event.skip) {
    status = "skipped";
  } else if (kind === "pass" && event.todo) {
    status = "pending";
  }
  const filePath = event.file ? reportPathOf(event.file) : undefined;
  const failure = kind === "fail" ? describeError(event.details.error) : undefined;
  results.push({
    /* node:test names a whole-file failure by the file's absolute path, inside
     * the step's work directory; name it by its report path instead. */
    name: isFileFailure(event) && filePath !== undefined ? filePath : event.name,
    filePath,
    status,
    duration: event.details.duration_ms ?? 0,
    message: failure?.message,
    trace: failure === undefined ? undefined : (fileFailureDetail(event, stderr) ?? failure.trace),
  });
}

/** Get the captured stderr to attach to a failure as its trace: the tail of
 * the file's stderr for a whole-file failure, otherwise undefined (a file's
 * stderr belongs to all its tests, so a test's failure gets none). */
function fileFailureDetail(event: ITestEvent, stderr: CapturedStderr): string | undefined {
  return isFileFailure(event) ? stderr.tail(event.file) : undefined;
}

/** @return true if this event is the whole file's outcome rather than a
 * test's, otherwise false. node:test names such an event after the file. */
function isFileFailure(event: ITestEvent): boolean {
  return event.file !== undefined && event.name === event.file;
}

/**
 * Describe a failure from node:test's error.
 *
 * A failed test's error is an ERR_TEST_FAILURE whose `cause` is the assertion
 * error: its message is the description, or describeSnapshotFailure's for a
 * failed snapshot assertion. Any other `cause` is described as its text, so a
 * file that threw while loading is described as `"test failed"` (its trace
 * comes from fileFailureDetail). With no `cause` the error's own message is
 * used, and with no error, `"failed"`.
 */
function describeError(error: (Error & { cause?: unknown }) | undefined): IFailureDescription {
  if (!error) {
    return { message: "failed" };
  }
  const cause = error.cause;
  if (cause instanceof Error) {
    return describeSnapshotFailure(cause) ?? { message: cause.message };
  }
  return { message: cause !== undefined ? String(cause) : error.message };
}

/** Write the report of `results` to `reportPath`, and set the exit code: 1
 * where any test failed, otherwise 0. */
function finish(results: ITestResult[], reportPath: string, start: number): void {
  const report = buildReport(results, start, Date.now());
  fs.writeFileSync(reportPath, JSON.stringify(report, undefined, 2));
  const failed = report.results.summary.failed;
  process.exitCode = failed > 0 ? 1 : 0;
}

/** The per-test timeout, in milliseconds, for every flavour: node:test takes it
 * for the run, the jest flavour hands it to circus and the vitest flavour to
 * vitest. Each enforces it per test and honours a test's own timeout. */
export const TEST_TIMEOUT_MS = 120_000;

/** Get node:test's `forceExit` option, which ends each test file's process once
 * its tests finish even where they left handles open (child pipes, watchers,
 * timers). Empty before node 20.14, which refuses the option. */
function forceExitOption(): { forceExit?: boolean } {
  return atLeastNode(20, 14) ? { forceExit: true } : {};
}

/** @return true if the running node is at least the given version, otherwise
 * false. */
export function atLeastNode(major: number, minor: number): boolean {
  const [runningMajor, runningMinor] = process.versions.node.split(".").map(Number);
  return runningMajor > major || (runningMajor === major && runningMinor >= minor);
}

/**
 * Get the run options that `--require` each of `preloads` into every test
 * process, through `run({ execArgv })`, which reaches only node:test's own
 * test processes and not the processes a test starts. `update` adds
 * `--test-update-snapshots`, so node:test rewrites recorded snapshots.
 *
 * Before node 22.10, which has no `execArgv` option, adds the preloads to
 * `NODE_OPTIONS` instead (reaching every process a test starts too) and
 * returns no options; `update` is then ignored, since `NODE_OPTIONS` refuses
 * its flag.
 */
function preloadOptions(preloads: string[], update: boolean): { execArgv?: string[] } {
  const args = preloads.flatMap(preload => ["--require", preload]);
  if (atLeastNode(22, 10)) {
    return { execArgv: [...args, ...(update ? ["--test-update-snapshots"] : [])] };
  }
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, ...args.map(arg => JSON.stringify(arg))].filter(Boolean).join(" ");
  return {};
}

/** @return node:test's option selecting the tests run by name, which it matches
 * against a test's full name (its suites' names and its own, joined by spaces),
 * as jest and vitest do. Throws for a pattern before node 22. */
function namePatternOption(pattern: string | undefined): { testNamePatterns?: string[] } {
  if (pattern === undefined) {
    return {};
  }
  if (!atLeastNode(22, 0)) {
    throw new Error(`Selecting tests by name needs node 22 or later (running ${process.versions.node})`);
  }
  return { testNamePatterns: [pattern] };
}

/** Resolve a setup entry to a preload path. A local entry is relative to the
 * installation (the runner's own cwd); a bare module name is left to node's
 * resolution, which finds it in the installation's node_modules. */
function resolveSetup(entry: string): string {
  return entry.startsWith("./") ? path.resolve(entry) : entry;
}

/**
 * Make the modules a runner's test processes load first, for the options that
 * need one: installing the PnP runtime (`--pnp`), then recording what each
 * process reads (`--reads`). They are generated into a temporary directory,
 * where each process also leaves its reads.
 *
 * `preloads` are the generated modules' paths, empty where neither option is
 * given. Call `finish` once the processes have exited: it writes the reads
 * document, if asked for, and removes the directory.
 */
export function childPreloads(options: IRunnerOptions): { preloads: string[]; finish(): void } {
  if (options.reads === undefined && options.pnp === undefined) {
    return { preloads: [], finish: () => undefined };
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-children-"));
  const preloads: string[] = [];
  const generate = (name: string, text: string): void => {
    preloads.push(path.join(directory, name));
    fs.writeFileSync(path.join(directory, name), text);
  };
  /* The PnP runtime first, so the recorder itself resolves through it. */
  if (options.pnp !== undefined) {
    generate(
      "pnp.cjs",
      `require(${JSON.stringify(path.join(__dirname, "..", "pnp", "Runtime.js"))}).installPnpRuntime(${JSON.stringify(options.pnp)});\n`
    );
  }
  if (options.reads !== undefined) {
    generate(
      "record.cjs",
      `require(${JSON.stringify(path.join(__dirname, "Reads.js"))}).recordReadsInto(${JSON.stringify(directory)});\n`
    );
  }
  return {
    preloads,
    finish: () => {
      if (options.reads !== undefined) {
        writeReads(options.reads, withPnpTable(readsRecordedIn(directory), options.pnp));
      }
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

/**
 * Run the invocation's test files under node:test, each in its own child
 * process, and write the report (and the reads document, where asked for).
 * Every child loads, in order: childPreloads' modules, `preloads` (absolute
 * paths, the flavour's own) and the invocation's setup entries. Sets
 * `process.exitCode` once the run ends: 1 if any test failed, otherwise 0.
 */
export function runTestFiles(options: IRunnerOptions, preloads: string[]): void {
  const children = childPreloads(options);
  const results: ITestResult[] = [];
  const stderr = new CapturedStderr();
  const start = Date.now();
  const stream = run({
    files: options.files.map(file => path.resolve(file)),
    timeout: TEST_TIMEOUT_MS,
    /* Setup entries load after the flavour's preloads, so the globals they
     * use are already installed (jest's `setupFilesAfterEnv` order). */
    ...preloadOptions([...children.preloads, ...preloads, ...options.setup.map(entry => resolveSetup(entry))], options.update),
    ...namePatternOption(options.namePattern),
    ...forceExitOption(),
  });
  /* Register before the outcome handlers, so a file's stderr is captured by the
   * time its failure is recorded. */
  stream.on("test:stderr", data => {
    const output = data as unknown as { file?: string; message?: string };
    stderr.add(output.file, output.message);
  });
  stream.on("test:pass", data => record(results, data as unknown as ITestEvent, "pass", stderr));
  stream.on("test:fail", data => record(results, data as unknown as ITestEvent, "fail", stderr));
  stream.once("end", () => {
    children.finish();
    finish(results, options.report, start);
  });
  /* The stream only ends once consumed. */
  stream.resume();
}
