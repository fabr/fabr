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

/**
 * Failures rendered as jest prints them, by `jest-message-util`: the matcher
 * diff, a code frame, and the stack without jest's frames or node's internals.
 * circus's `failureMessages` hold only the raw `error.stack`.
 *
 * Each frame naming a source by reference is first pointed at where the source
 * is staged, the file jest's code frame reads. The result drops jest's
 * `● suite › test` header and its body indent, which the report supplies.
 */

import { withStagedSources } from "../testRunner/Report";
import { jestLibrary } from "./Tools";

/** The fields of circus's assertion result the formatter reads.
 * `failureDetails` holds the error objects behind `failureMessages`, from which
 * a matcher's diff is rendered. */
export interface IFormattableResult {
  title: string;
  ancestorTitles: string[];
  failureMessages: string[];
  failureDetails?: unknown[];
}

/** An error circus reports against the file rather than a test in it (jest's
 * `SerializableError`): an unhandled rejection, a failed `afterAll`. Circus
 * leaves `message` empty and puts the errors' text in `stack`. */
export interface IExecError {
  message: string;
  stack?: string;
}

interface IMessageUtil {
  formatResultsErrors(results: unknown[], config: unknown, options: unknown, testPath?: string): string | null;
  formatExecError(error: unknown, config: unknown, options: unknown, testPath?: string): string;
}

/**
 * Format `test`'s failures as jest prints them, one entry per raw failure
 * message. A message the formatter declines (returns null) or throws on is
 * returned raw.
 */
export function formatFailures(test: IFormattableResult, projectConfig: unknown, globalConfig: unknown, testPath: string): string[] {
  const util = jestLibrary("jest-message-util") as IMessageUtil;
  return test.failureMessages.map((raw, index) => {
    /* One at a time: formatResultsErrors joins every failure it is given into
     * one string. */
    const single = { ...test, failureMessages: [withStagedSources(raw)], failureDetails: [test.failureDetails?.[index]] };
    try {
      const formatted = util.formatResultsErrors([single], projectConfig, globalConfig, testPath);
      return formatted === null ? raw : presentable(formatted);
    } catch {
      /* Keep the raw message. */
      return raw;
    }
  });
}

/**
 * Format an error raised outside any test as jest prints a suite's execution
 * error: the errors' text, then the stack without jest's frames. Where the
 * formatter throws or renders nothing, returns the error's stack, else its
 * message, else "Test suite failed to run".
 */
export function formatExecError(error: IExecError, projectConfig: unknown, globalConfig: unknown, testPath: string): string {
  const util = jestLibrary("jest-message-util") as IMessageUtil;
  const fallback = error.stack || error.message || "Test suite failed to run";
  try {
    const staged = { ...error, stack: error.stack === undefined ? undefined : withStagedSources(error.stack) };
    return presentable(util.formatExecError(staged, projectConfig, globalConfig, testPath)) || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Remove the `  ● suite › test` header, the common indent and trailing
 * whitespace from a failure jest rendered. Exported for tests.
 */
export function presentable(formatted: string): string {
  return dedent(withoutTitle(formatted));
}

/** Drop the `  ● suite › test` header and the blank line under it. */
function withoutTitle(formatted: string): string {
  const body = formatted.indexOf("\n\n");
  return body === -1 ? formatted : formatted.substring(body + 2);
}

/** Remove the indent common to every non-blank line, keeping deeper indents
 * (stack frames) relative to it, and trailing whitespace. */
function dedent(text: string): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  const indent = Math.min(...lines.filter(line => line.trim() !== "").map(line => /^ */.exec(line)?.[0].length ?? 0));
  return indent > 0 ? lines.map(line => line.substring(indent)).join("\n") : lines.join("\n");
}
