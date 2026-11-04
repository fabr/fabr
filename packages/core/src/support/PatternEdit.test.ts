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
import { applyPatternEdit, PatternEdit, PatternOperator, patternRegex } from "./PatternEdit";

function edited(value: string, operator: PatternOperator, pattern: string, replacement?: string): string {
  const edit: PatternEdit = replacement === undefined ? { operator, pattern } : { operator, pattern, replacement };
  return applyPatternEdit(value, edit);
}

describe("patternRegex", () => {
  it("matches a whole string against a bash pattern", () => {
    expect(patternRegex("a*").test("abc")).to.equal(true);
    expect(patternRegex("a*").test("bac")).to.equal(false);
    expect(patternRegex("a?c").test("abc")).to.equal(true);
    expect(patternRegex("a?c").test("abbc")).to.equal(false);
    /* `*` crosses a `/`, unlike a path glob. */
    expect(patternRegex("src*").test("src/a/b.ts")).to.equal(true);
  });

  it("reads bracket expressions as bash does", () => {
    expect(patternRegex("[abc]").test("b")).to.equal(true);
    expect(patternRegex("[!abc]").test("b")).to.equal(false);
    expect(patternRegex("[^abc]").test("d")).to.equal(true);
    expect(patternRegex("[a-c]x").test("bx")).to.equal(true);
    expect(patternRegex("[[:digit:]]*").test("9lives")).to.equal(true);
    /* A `]` first is a member; a `[` with no `]` is a literal. */
    expect(patternRegex("[]a]").test("]")).to.equal(true);
    expect(patternRegex("[ab").test("[ab")).to.equal(true);
    /* An escaped letter is that letter, not a regex class. */
    expect(patternRegex("[\\d]").test("d")).to.equal(true);
    expect(patternRegex("[\\d]").test("5")).to.equal(false);
  });

  it("takes everything else literally", () => {
    expect(patternRegex("a.b").test("axb")).to.equal(false);
    expect(patternRegex("(a)+").test("(a)+")).to.equal(true);
    expect(patternRegex("\\*").test("*")).to.equal(true);
    expect(patternRegex("\\*").test("x")).to.equal(false);
  });
});

describe("applyPatternEdit", () => {
  it("removes the shortest or longest matching prefix", () => {
    expect(edited("a/b/c", "#", "*/")).to.equal("b/c");
    expect(edited("a/b/c", "##", "*/")).to.equal("c");
    expect(edited("abc", "#", "x")).to.equal("abc");
  });

  it("removes the shortest or longest matching suffix", () => {
    expect(edited("aarch64-apple-darwin", "%", "-*")).to.equal("aarch64-apple");
    expect(edited("aarch64-apple-darwin", "%%", "-*")).to.equal("aarch64");
    expect(edited("file.tar.gz", "%", ".*")).to.equal("file.tar");
    expect(edited("abc", "%%", "x")).to.equal("abc");
  });

  it("replaces the longest match at the first place one starts", () => {
    expect(edited("aarch64-apple-darwin", "/", "-*", "-unknown-linux")).to.equal("aarch64-unknown-linux");
    expect(edited("x86_64-unknown-linux-gnu", "/", "-*", "-unknown-linux")).to.equal("x86_64-unknown-linux");
    expect(edited("a-b-c", "/", "-", "+")).to.equal("a+b-c");
    expect(edited("abc", "/", "x", "y")).to.equal("abc");
    /* No replacement removes the match. */
    expect(edited("abc", "/", "b", "")).to.equal("ac");
  });

  it("replaces every match", () => {
    expect(edited("a-b-c", "//", "-", "+")).to.equal("a+b+c");
    expect(edited("aaa", "//", "a", "bb")).to.equal("bbbbbb");
  });

  it("replaces a match anchored at either end", () => {
    expect(edited("abcabc", "/#", "abc", "x")).to.equal("xabc");
    expect(edited("abcabc", "/%", "abc", "x")).to.equal("abcx");
    expect(edited("xabc", "/#", "abc", "y")).to.equal("xabc");
    /* An empty pattern matches at the anchor, so these prepend and append. */
    expect(edited("abc", "/#", "", "x")).to.equal("xabc");
    expect(edited("abc", "/%", "", "x")).to.equal("abcx");
  });

  it("replaces nothing for an empty unanchored pattern", () => {
    expect(edited("abc", "/", "", "x")).to.equal("abc");
    expect(edited("abc", "//", "", "x")).to.equal("abc");
  });

  it("takes a replacement's escapes as the characters they quote", () => {
    expect(edited("a-b", "/", "-", "\\/\\}")).to.equal("a/}b");
    /* `&` is literal: bash's matched-text replacement is not supported. */
    expect(edited("a-b", "/", "-", "&")).to.equal("a&b");
  });
});
