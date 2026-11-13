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
import { JDK_VERSIONS } from "./JdkVersion";

const { parseVersion, parseConstraint, satisfies, compare, exactVersion, versionToString } = JDK_VERSIONS;

/** @return the releases among `names` that `constraint` admits. */
function admitted(constraint: string, ...names: string[]): string[] {
  return names.filter(name => satisfies(parseVersion(name), parseConstraint(constraint)));
}

describe("JDK_VERSIONS", () => {
  it("reads every form of release name the API lists, keeping its spelling", () => {
    for (const name of ["21+35", "17.0.12+7", "21.0.12.1+1", "17.0.9+9.1", "8u302-b08", "8u422-b05.1"]) {
      expect(versionToString(parseVersion(name))).to.equal(name);
    }
    expect(() => parseVersion("17.0.12")).to.throw(/not a JDK release version/);
  });

  it("orders by version numbers, a missing one as 0, then build and rebuild", () => {
    const sorted = ["21.0.1+12", "8u422-b05.1", "21+35", "17.0.9+9.1", "8u422-b05", "17.0.9+9", "17.0.10+7", "21.0.0.1+1"]
      .map(parseVersion)
      .sort(compare)
      .map(versionToString);
    expect(sorted).to.deep.equal([
      "8u422-b05",
      "8u422-b05.1",
      "17.0.9+9",
      "17.0.9+9.1",
      "17.0.10+7",
      "21+35",
      "21.0.0.1+1",
      "21.0.1+12",
    ]);
  });

  it("reads a full release name as exact, and version numbers as a prefix", () => {
    expect(exactVersion?.("17.0.12+7")).to.not.equal(undefined);
    expect(exactVersion?.("17")).to.equal(undefined);
    expect(admitted("17.0.9+9", "17.0.9+9", "17.0.9+9.1")).to.deep.equal(["17.0.9+9"]);
    expect(admitted("21", "21+35", "21.0.1+12", "22+36", "8u422-b05")).to.deep.equal(["21+35", "21.0.1+12"]);
    expect(admitted("21.0", "21+35", "21.0.1+12")).to.deep.equal(["21+35", "21.0.1+12"]);
    expect(admitted("17.0.20", "17.0.20+8", "17.0.20.1+1", "17.0.2+8")).to.deep.equal(["17.0.20+8", "17.0.20.1+1"]);
    expect(admitted("8", "8u422-b05", "17.0.9+9")).to.deep.equal(["8u422-b05"]);
    expect(admitted("8u422", "8u422-b05", "8u422-b05.1", "8u432-b06")).to.deep.equal(["8u422-b05", "8u422-b05.1"]);
    expect(() => parseConstraint(">=17")).to.throw(/not a JDK release version/);
  });
});
