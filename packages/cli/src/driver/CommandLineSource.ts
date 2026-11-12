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
  FileSource,
  INameValue,
  NAME_COMPONENT_SEPARATOR,
  parseName,
  StringReader,
  syntheticValue,
  WritableSourceTree,
} from "@fabr-build/core";

/**
 * Where the invocation was run, as a name given on its command line is resolved
 * there: the file sources it reads through and the directory its bare paths
 * root at. Supply it once the project has been located.
 */
export interface IInvocationSite {
  /** The project's source tree: what a relative name reads through, and what
   *  the driver writes refreshed test expectations and reports back into. */
  sourceFileSource: WritableSourceTree;
  /** The file source an absolute name reads through. */
  absFileSource: FileSource;
  /** The invocation's cwd within the source tree, `""` at its root. */
  invocationDir: string;
}

/** The program name the rendered command line starts with, whatever path
 * fabr was started by (`node …/build/index.js`, a `.bin` shim). */
const PROGRAM = "fabr";

/** The name of the virtual file a name given on the command line is written
 * in, as diagnostics show it. */
const COMMAND_LINE_FILE = "<command-line>";

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
   * what `./packages` written in a build file there means). An absolute name
   * reads through `site.absFileSource` instead, in `<command-line>` at the
   * root. A name the line does not contain spans the whole line.
   */
  public refFor(name: string, site: IInvocationSite): INameValue {
    const absolute = name.startsWith(NAME_COMPONENT_SEPARATOR);
    const dir = absolute ? "" : site.invocationDir;
    const [offset, endOffset] = this.spans.get(name) ?? [0, this.text.length];
    return syntheticValue(
      parseName(name),
      {
        fs: absolute ? site.absFileSource : site.sourceFileSource,
        file: dir === "" ? COMMAND_LINE_FILE : `${dir}${NAME_COMPONENT_SEPARATOR}${COMMAND_LINE_FILE}`,
        reader: this.reader,
      },
      offset,
      endOffset
    );
  }
}
