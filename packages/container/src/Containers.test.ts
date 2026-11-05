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
import { ownerName } from "@fabr-build/core";
import { containerName, ownerHost, ownerOfContainer } from "./Containers";

describe("container names", () => {
  it("names a container for this process, which a later run reads its owner back from", () => {
    expect(ownerOfContainer(containerName())).to.equal(ownerName());
    expect(ownerOfContainer(`fabr-${ownerHost()}-4321-run`)).to.equal(`${ownerHost()}-4321`);
  });

  it("reads no owner from a name fabr did not give", () => {
    expect(ownerOfContainer("my-app")).to.equal(undefined);
    expect(ownerOfContainer("fabr-x")).to.equal(undefined);
  });
});
