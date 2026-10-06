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
import { parsePatchFile } from "./Patch";

const lines = (...text: string[]): string => text.join("\n") + "\n";

describe("parsePatchFile", () => {
  it("reads a git-style change, its names stripped of the a/ and b/ git writes", () => {
    const [change, ...rest] = parsePatchFile(
      lines("diff --git a/lib/x.js b/lib/x.js", "index 111..222 100644", "--- a/lib/x.js", "+++ b/lib/x.js", "@@ -1,2 +1,2 @@", " one", "-two", "+three"),
      "the patch"
    );
    expect(rest).to.deep.equal([]);
    expect([change.from, change.to, change.mode]).to.deep.equal(["lib/x.js", "lib/x.js", undefined]);
    expect(change.apply("one\ntwo\n")).to.equal("one\nthree\n");
  });

  it("reads a plain unified diff, with no git header", () => {
    const [change] = parsePatchFile(lines("--- old/x.txt\t2024-01-01", "+++ new/x.txt\t2024-01-02", "@@ -1 +1 @@", "-a", "+b"), "the patch");
    expect([change.from, change.to]).to.deep.equal(["x.txt", "x.txt"]);
    expect(change.apply("a\n")).to.equal("b\n");
  });

  it("strips as many leading components as asked", () => {
    const text = lines("--- a/pkg/lib/x.js", "+++ b/pkg/lib/x.js", "@@ -1 +1 @@", "-a", "+b");
    expect(parsePatchFile(text, "the patch", 0)[0].from).to.equal("a/pkg/lib/x.js");
    expect(parsePatchFile(text, "the patch", 2)[0].from).to.equal("lib/x.js");
    expect(() => parsePatchFile(text, "the patch", 4)).to.throw("names 'a/pkg/lib/x.js', which has no path left after stripping 4 leading components");
  });

  it("reads a created file, with the mode it is given", () => {
    const [change] = parsePatchFile(
      lines("diff --git a/bin/run b/bin/run", "new file mode 100755", "index 000..111", "--- /dev/null", "+++ b/bin/run", "@@ -0,0 +1 @@", "+#!/bin/sh"),
      "the patch"
    );
    expect([change.from, change.to, change.mode]).to.deep.equal([undefined, "bin/run", 0o755]);
    expect(change.apply("")).to.equal("#!/bin/sh\n");
  });

  it("reads a deleted file", () => {
    const [change] = parsePatchFile(
      lines("diff --git a/gone.txt b/gone.txt", "deleted file mode 100644", "index 111..000", "--- a/gone.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-x"),
      "the patch"
    );
    expect([change.from, change.to, change.mode]).to.deep.equal(["gone.txt", undefined, undefined]);
  });

  it("reads a rename, with or without a change to the content", () => {
    const [moved, edited] = parsePatchFile(
      lines(
        "diff --git a/a.txt b/b.txt",
        "similarity index 100%",
        "rename from a.txt",
        "rename to b.txt",
        "diff --git a/c.txt b/d.txt",
        "similarity index 50%",
        "rename from c.txt",
        "rename to d.txt",
        "--- a/c.txt",
        "+++ b/d.txt",
        "@@ -1 +1 @@",
        "-c",
        "+d"
      ),
      "the patch"
    );
    expect([moved.from, moved.to]).to.deep.equal(["a.txt", "b.txt"]);
    expect(moved.apply("same\n")).to.equal("same\n");
    expect([edited.from, edited.to]).to.deep.equal(["c.txt", "d.txt"]);
    expect(edited.apply("c\n")).to.equal("d\n");
  });

  it("reads a change of mode alone", () => {
    const [change] = parsePatchFile(lines("diff --git a/run.sh b/run.sh", "old mode 100644", "new mode 100755"), "the patch");
    expect([change.from, change.to, change.mode]).to.deep.equal(["run.sh", "run.sh", 0o755]);
    expect(change.apply("echo\n")).to.equal("echo\n");
  });

  it("applies a hunk where its context is found, not only at the line it states", () => {
    const [change] = parsePatchFile(lines("--- a/x", "+++ b/x", "@@ -1,2 +1,2 @@", " one", "-two", "+three"), "the patch");
    expect(change.apply("zero\none\ntwo\n")).to.equal("zero\none\nthree\n");
  });

  it("keeps the line endings of the file it is applied to", () => {
    const [change] = parsePatchFile(lines("--- a/x", "+++ b/x", "@@ -1,2 +1,2 @@", " one", "-two", "+three"), "the patch");
    expect(change.apply("one\r\ntwo\r\n")).to.equal("one\r\nthree\r\n");
  });

  it("carries control characters in a hunk as text", () => {
    const [change] = parsePatchFile(lines("--- /dev/null", "+++ b/.DS_Store", "@@ -0,0 +1 @@", "+\u0000\u0001Bud1�", "\\ No newline at end of file"), "the patch");
    expect(change.apply("")).to.equal("\u0000\u0001Bud1�");
  });

  it("names the hunks that do not match", () => {
    const [change] = parsePatchFile(
      lines("--- a/x", "+++ b/x", "@@ -1,2 +1,2 @@", " one", "-two", "+three", "@@ -9,2 +9,2 @@", " nine", "-ten", "+eleven"),
      "patch 'fix.patch'"
    );
    expect(() => change.apply("one\ntwo\n")).to.throw("patch 'fix.patch' does not apply to 'x': hunk @@ -9,2 +9,2 @@ does not match the file");
  });

  it("does not match a hunk whose context differs at all", () => {
    const [change] = parsePatchFile(lines("--- a/x", "+++ b/x", "@@ -1,3 +1,3 @@", " one", "-two", "+three", " four"), "the patch");
    expect(() => change.apply("one\ntwo\nfive\n")).to.throw("does not match the file");
  });

  it("refuses a binary change, naming the file", () => {
    const binary = lines("diff --git a/img.png b/img.png", "index 111..222 100644", "GIT binary patch", "literal 4", "Lc$~{{00000", "", "literal 0", "HcmV?d00001", "");
    expect(() => parsePatchFile(binary, "patch 'fix.patch'")).to.throw("patch 'fix.patch' changes a binary file, which a patch cannot carry (diff --git a/img.png b/img.png)");
    expect(() => parsePatchFile(lines("diff --git a/i.png b/i.png", "Binary files a/i.png and b/i.png differ"), "the patch")).to.throw("changes a binary file");
  });

  it("refuses a name that leaves the files it applies to", () => {
    const escaping = lines("--- a/../../etc/passwd", "+++ b/../../etc/passwd", "@@ -1 +1 @@", "-a", "+b");
    expect(() => parsePatchFile(escaping, "the patch")).to.throw("names 'a/../../etc/passwd', which is outside the files it applies to");
    expect(() => parsePatchFile(lines("--- /etc/passwd", "+++ /etc/passwd", "@@ -1 +1 @@", "-a", "+b"), "the patch", 0)).to.throw("outside the files it applies to");
  });

  it("refuses text that is no diff", () => {
    expect(() => parsePatchFile("just some notes\n", "the patch")).to.throw("the patch is not a unified diff: it changes no files");
  });
});
