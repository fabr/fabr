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
import { derivedFrom, describeProvenance, renderProvenance } from "./Provenance";

describe("derived provenance", () => {
  it("states the mapping when the step renamed its input", () => {
    /* Two inputs landing on one output makes no sense to a reader until the
     * production that renamed one of them is on the page. */
    const step = derivedFrom("a/Card.module.scss", "css_compile");
    expect(renderProvenance(step, { path: "a/Card.css" })).to.deep.equal([
      { message: "css_compile produced 'a/Card.css' from 'a/Card.module.scss'" },
    ]);
  });

  it("says only that it is an input when the step renamed nothing", () => {
    /* Restating one name as the source of itself is noise — it is simply an
     * input that happens to be called that. */
    const step = derivedFrom("a/Card.css", "css_compile");
    expect(renderProvenance(step, { path: "a/Card.css" })).to.deep.equal([
      { message: "'a/Card.css' is an input of css_compile" },
    ]);
  });

  it("says the same with no output named at all", () => {
    const step = derivedFrom("a/Card.css", "css_compile");
    expect(renderProvenance(step, {})).to.deep.equal([{ message: "'a/Card.css' is an input of css_compile" }]);
  });

  it("describes itself by the input, for one-line attribution", () => {
    expect(describeProvenance(derivedFrom("a/Card.module.scss", "css_compile"))).to.equal("a/Card.module.scss");
  });
});
