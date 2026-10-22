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
 * A failed test, as jest would print it.
 *
 * Circus reports a failure twice over: `failureMessages` is the RAW
 * `error.stack`, and the presentable form — matcher diff, code frame, and a
 * stack with jest's own frames and node's internals removed — is produced
 * separately by `jest-message-util`, which jest's own reporters call. Taking the
 * raw one gets a wall of jestAdapterInit frames around the one line that
 * matters, so fabr calls the same formatter jest does.
 *
 * Two adjustments, both because the surrounding report is fabr's and not jest's:
 * the `● suite › test` header is dropped (the report already names the test on
 * the line above), and jest's own four-space body indent is removed (the report
 * indents the detail itself, and two indents read as one deep one).
 */

import { jestLibrary } from "./Tools";

/** What the formatter reads off an assertion result. Circus supplies all of it;
 * `failureDetails` carries the live error objects behind `failureMessages`,
 * which is how a matcher's structured diff survives to be rendered. */
export interface IFormattableResult {
  title: string;
  ancestorTitles: string[];
  failureMessages: string[];
  failureDetails?: unknown[];
}

interface IMessageUtil {
  formatResultsErrors(results: unknown[], config: unknown, options: unknown, testPath?: string): string | null;
}

/**
 * `test`'s failures as presentable text, one entry per raw failure message —
 * so the caller keeps the same shape it had, only readable. A message the
 * formatter declines to handle is passed through as it arrived.
 */
export function formatFailures(test: IFormattableResult, projectConfig: unknown, globalConfig: unknown, testPath: string): string[] {
  const util = jestLibrary("jest-message-util") as IMessageUtil;
  return test.failureMessages.map((raw, index) => {
    /* One at a time: formatResultsErrors renders every failure it is given into
     * a single string, and these have to stay separable. */
    const single = { ...test, failureMessages: [raw], failureDetails: [test.failureDetails?.[index]] };
    try {
      const formatted = util.formatResultsErrors([single], projectConfig, globalConfig, testPath);
      return formatted === null ? raw : presentable(formatted);
    } catch {
      /* The formatter is jest's, over a result shape jest built — but it is not
       * worth losing a failure over, and the raw message still says what broke. */
      return raw;
    }
  });
}

/**
 * Jest's rendered failure as the report should carry it: without the
 * `  ● suite › test` header (the report names the test itself) and without
 * jest's own body indent (the report indents the detail, and two indents read
 * as one deep one). Exported for its own tests — the rest of this module needs
 * jest present to say anything at all.
 */
export function presentable(formatted: string): string {
  return dedent(withoutTitle(formatted));
}

/** Drop the `  ● suite › test` header and the blank line under it. */
function withoutTitle(formatted: string): string {
  const body = formatted.indexOf("\n\n");
  return body === -1 ? formatted : formatted.substring(body + 2);
}

/** Remove the indent jest's own console rendering adds, so the report's indent
 * is the only one. Uniform across the whole block, so relative structure (the
 * deeper indent on stack frames) is preserved. */
function dedent(text: string): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  const indent = Math.min(...lines.filter(line => line.trim() !== "").map(line => /^ */.exec(line)?.[0].length ?? 0));
  return indent > 0 ? lines.map(line => line.substring(indent)).join("\n") : lines.join("\n");
}
