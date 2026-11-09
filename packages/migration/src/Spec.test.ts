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
import { isFloorless, parseSpec, rangeText } from "./Spec";

describe("reading a dependency spec", () => {
  it("reads a range as the package's", () => {
    expect(parseSpec("a", "^1.2.0")).to.deep.equal({ kind: "registry", packageName: "a", range: "^1.2.0" });
  });

  it("reads an alias as the package it names", () => {
    expect(parseSpec("ts6", "npm:typescript@^6.0.0")).to.deep.equal({ kind: "registry", packageName: "typescript", range: "^6.0.0" });
    expect(parseSpec("@s/x", "npm:@s/y@1.0.0")).to.deep.equal({ kind: "registry", packageName: "@s/y", range: "1.0.0" });
    expect(parseSpec("a", "npm:^2.0.0")).to.deep.equal({ kind: "registry", packageName: "a", range: "^2.0.0" });
  });

  it("reads workspace, catalog, tag and non-registry specs", () => {
    expect(parseSpec("a", "workspace:^")).to.deep.equal({ kind: "workspace" });
    expect(parseSpec("a", "catalog:")).to.deep.equal({ kind: "catalog", catalog: "default" });
    expect(parseSpec("a", "catalog:react17")).to.deep.equal({ kind: "catalog", catalog: "react17" });
    expect(parseSpec("a", "latest")).to.deep.equal({ kind: "tag", tag: "latest" });
    expect(parseSpec("a", "")).to.deep.equal({ kind: "tag", tag: "latest" });
    for (const other of ["file:../a", "link:../a", "git+https://x/y.git", "https://x/y.tgz", "user/repo"]) {
      expect(parseSpec("a", other)).to.deep.equal({ kind: "other" });
    }
  });

  it("reads yarn's patch spec as the package it patches", () => {
    expect(parseSpec("a", "patch:a@npm%3A1.2.3#./patches/a.patch")).to.deep.equal({ kind: "registry", packageName: "a", range: "1.2.3", patched: true });
  });

  it("says which ranges have no floor", () => {
    expect(isFloorless("*")).to.equal(true);
    expect(isFloorless("<4.1.0")).to.equal(true);
    expect(isFloorless("^0.0.1")).to.equal(false);
  });

  it("quotes a range only where the reference grammar would read it", () => {
    expect(rangeText("^1.2.3")).to.equal("^1.2.3");
    expect(rangeText("1.x")).to.equal("1.x");
    expect(rangeText(">=1.0.0 <2")).to.equal('">=1.0.0 <2"');
  });
});
