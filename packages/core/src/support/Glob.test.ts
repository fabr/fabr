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

import { expect } from "chai";
import { globCaptureRegex, globMatcher, globPrefixRegex, isGlob } from "./Glob";

describe("isGlob", () => {
  it("recognises wildcards, classes and every extglob group", () => {
    for (const glob of ["*.ts", "a?c", "[ab].js", "src/!(gen)", "@(a|b)", "+(x)", "*(x)", "?(x)"]) {
      expect(isGlob(glob), glob).to.equal(true);
    }
    for (const literal of ["src/a.ts", "@npm:chai:5.0.0", "foo!", "a+b", "(x)"]) {
      expect(isGlob(literal), literal).to.equal(false);
    }
  });
});

describe("globMatcher", () => {
  it("matches dotfiles under a directory expansion", () => {
    /* `srcs = src` expands to `src/**` — it must reach `.eslintrc`-style files
     * (picomatch drops them by default). */
    const underSrc = globMatcher("src/**");
    expect(underSrc("src/.eslintrc")).to.equal(true);
    expect(underSrc("src/.config/settings.json")).to.equal(true);
    expect(underSrc("src/index.ts")).to.equal(true);
  });

  it("matches a leading dotfile against a bare wildcard", () => {
    const any = globMatcher("*");
    expect(any(".babelrc")).to.equal(true);
    expect(any("plain.txt")).to.equal(true);
  });

  it("still respects the pattern", () => {
    const tsOnly = globMatcher("**/*.ts");
    expect(tsOnly("src/.hidden/mod.ts")).to.equal(true);
    expect(tsOnly("src/mod.js")).to.equal(false);
  });
});

describe("globMatcher negation", () => {
  const matches = (glob: string, paths: string[]): Map<string, boolean> => {
    const matcher = globMatcher(glob);
    return new Map(paths.map(p => [p, matcher(p)]));
  };

  it("reads a POSIX class inside a group's bracket expression whole", () => {
    expect(matches("!([[:alpha:]|]).txt", ["a.txt", "|.txt", "1.txt"])).to.deep.equal(
      new Map([
        ["a.txt", false],
        ["|.txt", false],
        ["1.txt", true],
      ])
    );
  });

  it("subtracts a group spanning segments, wherever the globstars place it", () => {
    expect(matches("**/!(@shorthand/api)/**", ["a/@shorthand/api/x.js", "@shorthand/api/x.js", "@shorthand/ui/x.js", "a/b/c.js"])).to.deep.equal(
      new Map([
        ["a/@shorthand/api/x.js", false],
        ["@shorthand/api/x.js", false],
        ["@shorthand/ui/x.js", true],
        ["a/b/c.js", true],
      ])
    );
  });

  it("keeps to the segment boundaries the pattern's own slashes give", () => {
    const matcher = globMatcher("**/!(@shorthand/api)/**");
    expect(matcher("@shorthand/api-v2/x.js")).to.equal(true);
    expect(matcher("x/@shorthand/api/y/z.js")).to.equal(false);
  });

  it("makes each group a constraint of its own, all of which must hold", () => {
    const paths = ["src/x.js", "src/x.ts", "foo/bar/x.js", "a/foo/bar/b/c.js", "foo/barn/x.js", "foo/bar.ts", "foo/bar.js", "x.js"];
    expect(matches("**/!(foo/bar)/**/!(*.ts)", paths)).to.deep.equal(
      new Map([
        ["src/x.js", true],
        ["src/x.ts", false],
        ["foo/bar/x.js", false],
        ["a/foo/bar/b/c.js", false],
        ["foo/barn/x.js", true],
        ["foo/bar.ts", false],
        ["foo/bar.js", true],
        /* The literal `/` after the first group needs a directory, as `**\/*\/**\/*` does. */
        ["x.js", false],
      ])
    );
  });

  it("reads a group whose contents hold slashes as any text, slashes included", () => {
    const matcher = globMatcher("**!(/foo/bar/)**/*.ts");
    expect(matcher("src/x.ts")).to.equal(true);
    expect(matcher("a/b/c/x.ts")).to.equal(true);
    expect(matcher("a/foo/bar/x.ts")).to.equal(false);
    expect(matcher("foo/bar/b/x.ts")).to.equal(false);
    expect(matcher("foo/barn/x.ts")).to.equal(true);
  });

  it("keeps a group without slashes to one segment", () => {
    const tests = globMatcher("!(*.test).ts");
    expect(tests("foo.ts")).to.equal(true);
    expect(tests("foo.test.ts")).to.equal(false);
    expect(tests("src/foo.ts")).to.equal(false);
    const top = globMatcher("!(node_modules)/**");
    expect(top("node_modules/x.js")).to.equal(false);
    expect(top("a/node_modules/x.js")).to.equal(true);
    expect(top("src/x.js")).to.equal(true);
  });

  it("excludes only the segment named, not every segment beginning with it", () => {
    const matcher = globMatcher("src/!(generated)/**");
    expect(matcher("src/generated/x.ts")).to.equal(false);
    expect(matcher("src/generated-api/x.ts")).to.equal(true);
    expect(globMatcher("!(a|b)/*")("ab/x")).to.equal(true);
  });

  it("subtracts each alternative, including a nested group's", () => {
    const matcher = globMatcher("!(Validation|@(V3|api))/**");
    expect(matcher("Validation/f.ts")).to.equal(false);
    expect(matcher("V3/f.ts")).to.equal(false);
    expect(matcher("api/f.ts")).to.equal(false);
    expect(matcher("web/f.ts")).to.equal(true);
  });

  it("means what the group excludes, not some other text there (unlike bash)", () => {
    /* bash matches both, the group taking the empty string. */
    expect(globMatcher("!(a)*")("ab")).to.equal(false);
    expect(globMatcher("*!(a)")("a")).to.equal(false);
    expect(globMatcher("!(a)*")("ba")).to.equal(true);
  });

  it("leaves an escaped group literal", () => {
    expect(globMatcher("\\!\\(a\\)/*")("!(a)/x")).to.equal(true);
  });

  it("refuses a group inside another", () => {
    expect(() => globMatcher("@(!(a)|b)")).to.throw(/cannot be inside another group/);
  });
});

describe("globPrefixRegex", () => {
  it("anchors and strips a literal prefix", () => {
    const re = globPrefixRegex("src/");
    expect("src/foo.ts".replace(re, "")).to.equal("foo.ts");
  });

  it("strips a globbed prefix across dotfile directories", () => {
    /* Matches the search side's dotfile policy: a `*` segment covers `.hidden`. */
    const re = globPrefixRegex("packages/*/lib/");
    expect(re.test("packages/.hidden/lib/x.js")).to.equal(true);
    expect(re.test("packages/core/lib/x.js")).to.equal(true);
  });

  it("strips a negation group as the wildcard it stands for", () => {
    expect("web/lib/x.js".replace(globPrefixRegex("!(api)/lib/"), "")).to.equal("x.js");
  });
});

describe("globCaptureRegex", () => {
  const caps = (glob: string, path: string): (string | undefined)[] | null => {
    const m = globCaptureRegex(glob).exec(path);
    return m ? m.slice(1) : null;
  };

  it("captures one group per wildcard in order", () => {
    expect(caps("*.ts", "foo.ts")).to.deep.equal(["foo"]);
    expect(caps("*/*.ts", "a/foo.ts")).to.deep.equal(["a", "foo"]);
    expect(caps("*.min.js", "foo.min.js")).to.deep.equal(["foo"]);
  });

  it("leaves a zero-segment globstar group unmatched (String.replace substitutes it as '')", () => {
    expect(caps("**/*.ts", "a/b/foo.ts")).to.deep.equal(["a/b", "foo"]);
    expect(caps("**/*.ts", "foo.ts")).to.deep.equal([undefined, "foo"]);
    expect(caps("src/**", "src/a/b")).to.deep.equal(["a/b"]);
    expect(caps("src/**", "src")).to.deep.equal([undefined]);
    expect(caps("src/**/x.ts", "src/x.ts")).to.deep.equal([undefined]);
  });

  it("is anchored — null for a non-match", () => {
    expect(globCaptureRegex("*.ts").exec("foo.js")).to.equal(null);
  });

  it("matches dotfiles (same policy as globMatcher)", () => {
    expect(caps("**/*", "a/.hidden/x")).to.deep.equal(["a/.hidden", "x"]);
  });

  it("subtracts a negation group without capturing it", () => {
    expect(caps("**/!(*.test).ts", "a/foo.ts")).to.deep.equal(["a"]);
    expect(caps("**/!(*.test).ts", "a/foo.test.ts")).to.equal(null);
    expect("foo.ts".replace(globCaptureRegex("!(*.test).ts"), "out.txt")).to.equal("out.txt");
    expect(globCaptureRegex("!(*.test).ts").test("foo.test.ts")).to.equal(false);
  });
});
