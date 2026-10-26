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
import { compareMavenVersions, MAVEN_VERSIONS, parseMavenConstraint, parseMavenVersion } from "./MavenVersion";

const order = (a: string, b: string): number => Math.sign(compareMavenVersions(parseMavenVersion(a), parseMavenVersion(b)));

/** Check every version in `versions` orders strictly below every later one. */
function expectAscending(versions: string[]): void {
  for (let i = 0; i < versions.length; i++) {
    for (let j = i + 1; j < versions.length; j++) {
      expect(order(versions[i], versions[j]), `${versions[i]} < ${versions[j]}`).to.equal(-1);
      expect(order(versions[j], versions[i]), `${versions[j]} > ${versions[i]}`).to.equal(1);
    }
  }
}

describe("MavenVersion", () => {
  /* The orderings and equalities of Maven's own ComparableVersionTest. */
  it("orders qualifiers as Maven does", () => {
    expectAscending([
      "1-alpha2snapshot",
      "1-alpha2",
      "1-alpha-123",
      "1-beta-2",
      "1-beta123",
      "1-m2",
      "1-m11",
      "1-rc",
      "1-cr2",
      "1-rc123",
      "1-SNAPSHOT",
      "1",
      "1-sp",
      "1-sp2",
      "1-sp123",
      "1-abc",
      "1-def",
      "1-pom-1",
      "1-1-snapshot",
      "1-1",
      "1-2",
      "1-123",
    ]);
  });

  it("orders numbers as Maven does", () => {
    expectAscending(["2.0", "2.0.a", "2-1", "2.0.2", "2.0.123", "2.1.0", "2.1-a", "2.1b", "2.1-c", "2.1-1", "2.1.0.1", "2.2", "2.123"]);
    expectAscending(["11.a2", "11.a11", "11.b2", "11.b11", "11.m2", "11.m11", "11"]);
  });

  it("equates the spellings Maven equates", () => {
    for (const group of [
      ["1", "1.0", "1.0.0", "1-0", "1-ga", "1.ga", "1-final", "1.0.0-release"],
      ["1a1", "1-a1", "1alpha-1", "1-alpha-1", "1.alpha-1", "1-ALPHA-1"],
      ["1b2", "1-b2", "1-beta-2", "1-BETA2"],
      ["1m3", "1-milestone-3"],
      ["1rc", "1cr", "1-rc", "1-CR"],
      ["1x", "1-x", "1.0.0-x"],
    ]) {
      for (const other of group.slice(1)) {
        expect(order(group[0], other), `${group[0]} == ${other}`).to.equal(0);
      }
    }
  });

  it("keeps a version's text as its identity", () => {
    expect(MAVEN_VERSIONS.versionToString(parseMavenVersion("1.0"))).to.equal("1.0");
    expect(MAVEN_VERSIONS.versionToString(parseMavenVersion("1.0.0"))).to.equal("1.0.0");
  });

  it("refuses what is not a version", () => {
    expect(() => parseMavenVersion("${jackson.version}")).to.throw(/not a Maven version/);
    expect(() => parseMavenVersion("")).to.throw(/not a Maven version/);
  });
});

describe("MavenConstraint", () => {
  const satisfies = (version: string, constraint: string): boolean =>
    MAVEN_VERSIONS.satisfies(parseMavenVersion(version), parseMavenConstraint(constraint));

  it("reads a plain version as a floor with no cap", () => {
    expect(satisfies("1.2", "1.2")).to.equal(true);
    expect(satisfies("3.0", "1.2")).to.equal(true);
    expect(satisfies("1.1", "1.2")).to.equal(false);
    expect(MAVEN_VERSIONS.versionToString(MAVEN_VERSIONS.minimumOf(parseMavenConstraint("1.2")))).to.equal("1.2");
  });

  it("reads ranges and their unions", () => {
    expect(satisfies("1.5", "[1.0,2.0)")).to.equal(true);
    expect(satisfies("2.0", "[1.0,2.0)")).to.equal(false);
    expect(satisfies("1.0", "(1.0,2.0]")).to.equal(false);
    expect(satisfies("1.2", "[1.2]")).to.equal(true);
    expect(satisfies("1.2.1", "[1.2]")).to.equal(false);
    expect(satisfies("0.5", "(,1.0],[1.2,)")).to.equal(true);
    expect(satisfies("1.1", "(,1.0],[1.2,)")).to.equal(false);
    expect(satisfies("9", "(,1.0],[1.2,)")).to.equal(true);
  });

  it("takes the lowest lower bound as a range's floor, and an unbounded one as none", () => {
    expect(MAVEN_VERSIONS.versionToString(MAVEN_VERSIONS.minimumOf(parseMavenConstraint("[1.5,2),[1.2,1.3)")))).to.equal("1.2");
    expect(MAVEN_VERSIONS.isFloorless(parseMavenConstraint("(,1.0]"))).to.equal(true);
    expect(MAVEN_VERSIONS.isFloorless(parseMavenConstraint("[1.0,)"))).to.equal(false);
    expect(MAVEN_VERSIONS.isFloorless(MAVEN_VERSIONS.unconstrained)).to.equal(true);
  });

  it("names an exact version for a plain version or a one-version range", () => {
    expect(MAVEN_VERSIONS.exactVersion?.("1.2")?.text).to.equal("1.2");
    expect(MAVEN_VERSIONS.exactVersion?.("[1.2]")?.text).to.equal("1.2");
    expect(MAVEN_VERSIONS.exactVersion?.("[1.2,1.3)")).to.equal(undefined);
  });

  it("refuses a malformed range", () => {
    expect(() => parseMavenConstraint("[1.0,2.0")).to.throw(/not a Maven version range/);
    expect(() => parseMavenConstraint("(1.0)")).to.throw(/single version/);
  });

  it("tells stable releases from the rest", () => {
    expect(MAVEN_VERSIONS.isStable?.(parseMavenVersion("2.15.4"))).to.equal(true);
    expect(MAVEN_VERSIONS.isStable?.(parseMavenVersion("7.2.1.202505142326-r"))).to.equal(true);
    expect(MAVEN_VERSIONS.isStable?.(parseMavenVersion("3.0.0-M5"))).to.equal(false);
    expect(MAVEN_VERSIONS.isStable?.(parseMavenVersion("1.0-SNAPSHOT"))).to.equal(false);
    expect(MAVEN_VERSIONS.isStable?.(parseMavenVersion("6.0.0-RC1"))).to.equal(false);
  });
});
