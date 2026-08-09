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
import { Computable } from "./Computable";
import { FileSet } from "./FileSet";
import { Flag } from "./Flag";
import { Name } from "./Name";
import { materializeAll } from "./Repository";

function toPromise<T>(computable: Computable<T>): Promise<T> {
  return new Promise((resolve, reject) => computable.then(resolve, reject));
}

describe("Flag", () => {
  it("is an empty FileSet that carries its name and provides", async () => {
    const child = new Flag("ts/allow_implicit_any", []);
    const flag = new Flag("ts/no_strict", [child]);
    expect(flag).to.be.instanceOf(FileSet);
    expect(flag.name).to.equal("ts/no_strict");
    expect(flag.provides).to.deep.equal([child]);
    /* An empty file-set: it contributes no content wherever a FileSet is mounted. */
    const found = await toPromise(flag.find(Name.fromLiteral("**")));
    expect([...found]).to.have.lengthOf(0);
  });

  it("survives materialization as itself (so a rule reads it back with getFlags)", async () => {
    /* The point of Flag being a FileSet: it rides `deps` through the collection
     * point untouched (materializeAll's identity branch), keeping its Flag
     * identity, rather than collapsing to an anonymous empty set. */
    const flag = new Flag("ts/no_strict", []);
    const [materialized] = await toPromise(materializeAll([flag]));
    expect(materialized).to.equal(flag);
    expect(materialized).to.be.instanceOf(Flag);
  });

  it("keeps its identity through provenance stamping (withOrigin)", () => {
    const flag = new Flag("ts/no_strict", []);
    const stamped = flag.withOrigin({ kind: "target" } as never);
    expect(stamped).to.be.instanceOf(Flag);
    expect(stamped.name).to.equal("ts/no_strict");
    expect(stamped.origin).to.deep.equal({ kind: "target" });
  });
});
