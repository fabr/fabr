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
import { contentsTriple } from "./BuildContainerImage";

describe("contentsTriple", () => {
  it("fills in the base's C library where OCI_TARGET states none, and musl where the base has none", () => {
    expect(contentsTriple("aarch64-unknown-linux", "gnu")).to.equal("aarch64-unknown-linux-gnu");
    expect(contentsTriple("aarch64-unknown-linux", undefined)).to.equal("aarch64-unknown-linux-musl");
  });

  it("takes an OCI_TARGET stating its C library as it is, refusing one the base does not have", () => {
    expect(contentsTriple("x86_64-unknown-linux-gnu", undefined)).to.equal("x86_64-unknown-linux-gnu");
    expect(contentsTriple("x86_64-unknown-linux-musl", "musl")).to.equal("x86_64-unknown-linux-musl");
    expect(() => contentsTriple("x86_64-unknown-linux-gnu", "musl")).to.throw(/states glibc, but the base image has musl/);
  });
});
