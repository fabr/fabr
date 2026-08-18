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
import { buildCssOptions, CSS_OUTDIR, CSS_SRC_ROOT } from "./CSSCompile";

describe("buildCssOptions", () => {
  it("names every source and points at the src root and outdir", () => {
    const options = buildCssOptions(["a/Foo.module.scss", "b.scss", "c.css"]);
    expect(options.srcRoot).to.equal(CSS_SRC_ROOT);
    expect(options.outdir).to.equal(CSS_OUTDIR);
    /* No load paths: a package load is the importer's to answer from the
     * dependency table, and nothing is mounted for one to point at. */
    expect(options.loadPaths).to.deep.equal([]);
    expect(options.files).to.include.members(["a/Foo.module.scss", "b.scss", "c.css"]);
  });

  it("sorts the file list so the options document (and cache key) is deterministic", () => {
    /* The manifest is content-addressed; the same sources in any order must
     * produce an identical document. */
    const a = buildCssOptions(["z.scss", "a.scss", "m/x.module.scss"]);
    const b = buildCssOptions(["m/x.module.scss", "z.scss", "a.scss"]);
    expect(a.files).to.deep.equal(b.files);
    expect(a.files).to.deep.equal(["a.scss", "m/x.module.scss", "z.scss"]);
  });
});
