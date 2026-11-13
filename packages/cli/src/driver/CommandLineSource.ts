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

import {
  COMMAND_LINE_FILE,
  INameValue,
  NAME_COMPONENT_SEPARATOR,
  parseName,
  StringReader,
  syntheticValue,
  WritableSourceTree,
} from "@fabr-build/core";
import * as path from "node:path";

/**
 * Where the invocation was run, as a name given on its command line is resolved
 * there: the source tree it reads through and the directory its bare paths
 * root at. Supply it once the project has been located.
 */
export interface IInvocationSite {
  /** The project's source tree: what a relative name reads through, and what
   *  the driver writes refreshed test expectations and reports back into. */
  sourceFileSource: WritableSourceTree;
  /** The invocation's cwd within the source tree, `""` at its root. */
  invocationDir: string;
}

/** The program name the rendered command line starts with, whatever path
 * fabr was started by (`node …/build/index.js`, a `.bin` shim). */
const PROGRAM = "fabr";

/** Arguments a shell would not read back as one word, which are rendered
 * single-quoted. */
const NEEDS_QUOTING = /^$|[\s'"\\|&;<>()$`*?[\]{}!#~]/;

/**
 * The command line as source text: the invocation rendered as one line, with
 * the span each argument occupies in it, so a diagnostic about a name given to
 * a verb underlines that argument in the command:
 *
 * ```
 * error: Unknown name 'packagez'
 *  --> <command-line>:1:9
 *   |
 * 1 | fabr ls packagez
 *   |         ^^^^^^^^
 * ```
 *
 * An argument is located by its text, at its first occurrence.
 */
export class CommandLineSource {
  private readonly text: string;
  private readonly reader: StringReader;
  /** Argument -> its [offset, endOffset) within {@link text}, the quotes (where
   * one is rendered quoted) excluded so the underline covers the value itself. */
  private readonly spans = new Map<string, [number, number]>();

  constructor(args: string[]) {
    const rendered: string[] = [];
    let offset = PROGRAM.length;
    for (const arg of args) {
      offset += 1; /* the separating space */
      const quoted = NEEDS_QUOTING.test(arg) ? `'${arg.replaceAll("'", `'\\''`)}'` : undefined;
      if (!this.spans.has(arg)) {
        const start = quoted ? offset + 1 : offset;
        this.spans.set(arg, [start, start + (quoted ? quoted.length - 2 : arg.length)]);
      }
      rendered.push(quoted ?? arg);
      offset += (quoted ?? arg).length;
    }
    this.text = [PROGRAM, ...rendered].join(" ");
    this.reader = new StringReader(this.text);
  }

  /**
   * Make the value `name`, an argument of this command line, is written as: its
   * span in this line, in a virtual file `<command-line>` in the invocation
   * directory, so its bare paths root at the cwd (`fabr ls ./packages` means
   * what `./packages` written in a build file there means); an absolute path
   * names no target, and resolving it is refused. On Windows each `\` in a
   * name outside its quotes is a path separator (`src\a.txt` is `src/a.txt`).
   * A name the line does not contain spans the whole line.
   */
  public refFor(name: string, site: IInvocationSite): INameValue {
    const written = path.sep === "\\" ? separatorsOutsideQuotes(name) : name;
    const dir = site.invocationDir;
    const [offset, endOffset] = this.spans.get(name) ?? [0, this.text.length];
    return syntheticValue(
      parseName(written),
      {
        fs: site.sourceFileSource,
        file: dir === "" ? COMMAND_LINE_FILE : `${dir}${NAME_COMPONENT_SEPARATOR}${COMMAND_LINE_FILE}`,
        reader: this.reader,
      },
      offset,
      endOffset
    );
  }
}

/**
 * @return `name` with each `\` outside its quotes made a `/`: on Windows a
 * `\` written on the command line is a path separator, and a character the
 * name grammar gives a meaning is written literally by quoting it. Within
 * `'…'` a `\` is literal and within `"…"` it escapes the next character, as
 * the grammar reads them, so both are left as written.
 */
function separatorsOutsideQuotes(name: string): string {
  let result = "";
  let quote: string | undefined;
  for (let at = 0; at < name.length; at++) {
    const ch = name[at];
    if (quote === undefined) {
      quote = ch === "'" || ch === '"' ? ch : undefined;
      result += ch === "\\" ? "/" : ch;
    } else if (quote === '"' && ch === "\\" && at + 1 < name.length) {
      result += ch + name[++at];
    } else {
      quote = ch === quote ? undefined : quote;
      result += ch;
    }
  }
  return result;
}
