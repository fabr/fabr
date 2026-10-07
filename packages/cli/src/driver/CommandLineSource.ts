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

import { FileSource, INameValue, NAME_COMPONENT_SEPARATOR, parseName, StringReader, syntheticValue, WritableSourceTree } from "@fabr-build/core";

/**
 * Where the invocation was run, as a reference given there needs to know it: the
 * file sources it may read through, and the directory (in the source tree's own
 * namespace, `""` at its root) its bare paths root at. Known only once the
 * project has been located, so it is supplied at use rather than at parse.
 */
export interface IInvocationSite {
  /**
   * The source tree, as something writable rather than as the bare `FileSource`
   * interface: it is both what a bare path resolves through and what the driver
   * writes refreshed test expectations back into, and the write belongs to the
   * owner of the tree (see {@link WritableSourceTree}). The source knows its
   * own root, and containment against it is its own invariant.
   */
  sourceFileSource: WritableSourceTree;
  absFileSource: FileSource;
  invocationDir: string;
}

/** How the invocation names itself in the excerpt: fabr was reached by some
 * path (`node …/build/index.js`, a `.bin` shim), none of which is what the user
 * typed or would recognize. */
const PROGRAM = "fabr";

/** The virtual file a name given on the command line counts as written in —
 * how it names itself in diagnostics. */
const COMMAND_LINE_FILE = "<command-line>";

/** Arguments that would not survive being read back as one word: rendered
 * single-quoted, as a shell would need them written. */
const NEEDS_QUOTING = /^$|[\s'"\\|&;<>()$`*?[\]{}!#~]/;

/**
 * The command line as fabr's own source text: the invocation rendered as one
 * line, with the span each argument occupies in it. It is what lets a name
 * given to a verb be reported like any other written reference — the offending
 * argument underlined in the command that gave it:
 *
 * ```
 * error: Unknown name 'packagez'
 *  --> <command-line>:1:9
 *   |
 * 1 | fabr ls packagez
 *   |         ^^^^^^^^
 * ```
 *
 * An argument is located by its text (the first occurrence: two identical
 * arguments render indistinguishably), not by an argv index.
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
   * The decl a name typed on the command line is written in: this line as its
   * file, `<command-line>` *located in the invocation directory*. A reference's
   * bare paths root at the directory of the file it is written in, so
   * `fabr ls ./packages` means what `./packages` written in a build file there
   * means.
   *
   * An absolute name has no directory to root at, and reads through the absolute
   * file source instead — as the loader reads a lib path.
   *
   * A name this line does not contain (nothing produces one today) falls back to
   * the whole line.
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
