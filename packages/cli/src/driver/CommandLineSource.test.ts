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

import { expect } from "chai";
import { EMPTY_FILESET, FileSet, INameValue } from "@fabr-build/core";
import { CommandLineSource, IInvocationSite } from "./CommandLineSource";

const ABS_FILES = new FileSet(new Map());

/** An invocation run in `invocationDir` of a project whose source tree is empty. */
function siteAt(invocationDir: string): IInvocationSite {
  return { sourceFileSource: EMPTY_FILESET, absFileSource: ABS_FILES, invocationDir };
}

/** Where the decl says it is: file, and the excerpt its span covers. */
function locate(decl: INameValue): { file: string; line: string; span: string } {
  const pos = decl.source.reader.resolvePosition(decl.offset)!;
  return {
    file: decl.source.file,
    line: pos.lineText,
    span: pos.lineText.substring(pos.column - 1, pos.column - 1 + (decl.endOffset! - decl.offset)),
  };
}

describe("CommandLineSource", () => {
  it("spans each argument within the whole rendered invocation", () => {
    /* The reader holds the command, not the one name — so a diagnostic excerpts
     * what was run and underlines the argument in it. */
    const source = new CommandLineSource(["cat", "files:a.txt", "srcc"]);
    const located = locate(source.refFor("srcc", siteAt("")));
    expect(located.line).to.equal("fabr cat files:a.txt srcc");
    expect(located.span).to.equal("srcc");
    expect(located.file).to.equal("<command-line>");
    /* Every argument, not just the last. */
    expect(locate(source.refFor("files:a.txt", siteAt(""))).span).to.equal("files:a.txt");
  });

  it("renders an argument needing quotes as quoted, spanning the value inside", () => {
    /* The shell's quotes are gone by the time fabr sees argv; a glob rendered
     * bare would read as one the shell had expanded. Quoting it back keeps the
     * excerpt honest — and the underline stays on the value. */
    const source = new CommandLineSource(["cat", "docs:*.nope", "srcc"]);
    const quoted = locate(source.refFor("docs:*.nope", siteAt("")));
    expect(quoted.line).to.equal("fabr cat 'docs:*.nope' srcc");
    expect(quoted.span).to.equal("docs:*.nope");
    /* And the arguments after it are still located correctly. */
    expect(locate(source.refFor("srcc", siteAt(""))).span).to.equal("srcc");
  });

  it("sites the virtual file in the invocation directory", () => {
    /* Which is what roots the reference's bare paths there — as a build file's
     * own directory roots the references written in it. */
    const source = new CommandLineSource(["ls", "./a.txt"]);
    const decl = source.refFor("./a.txt", siteAt("packages/js"));
    expect(decl.source.file).to.equal("packages/js/<command-line>");
    expect(decl.source.fs).to.equal(EMPTY_FILESET);
  });

  it("reads an absolute name through the absolute file source, rooted nowhere", () => {
    const source = new CommandLineSource(["ls", "/etc/hosts"]);
    const decl = source.refFor("/etc/hosts", siteAt("docs"));
    expect(decl.source.file).to.equal("<command-line>");
    expect(decl.source.fs).to.equal(ABS_FILES);
  });

  it("falls back to the whole line for a name the invocation does not contain", () => {
    /* Nothing produces one today (every name comes from argv), so the fallback
     * only has to be honest rather than a caret in the wrong place. */
    const source = new CommandLineSource(["ls", "a"]);
    const located = locate(source.refFor("b", siteAt("")));
    expect(located.span).to.equal("fabr ls a");
  });
});
