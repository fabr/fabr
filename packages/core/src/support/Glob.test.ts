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
import { globMatcher, globPrefixRegex, globScan } from "./Glob";

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
});

describe("globScan", () => {
  it("extracts the static base and glob-ness of a pattern", () => {
    const globbed = globScan("packages/core/src/**/*.ts");
    expect(globbed.base).to.equal("packages/core/src");
    expect(globbed.isGlob).to.equal(true);

    const literal = globScan("src/foo.ts");
    expect(literal.base).to.equal("src/foo.ts");
    expect(literal.isGlob).to.equal(false);
  });
});
