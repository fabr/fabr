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

import { compareVersions, lowestSatisfying, parseVersion, SEMVER, versionToString } from "./Semver";
import { expect } from "chai";

function minimumOf(constraint: string): string {
  return versionToString(SEMVER.minimumOf(SEMVER.parseConstraint(constraint)));
}

function satisfies(version: string, constraint: string): boolean {
  return SEMVER.satisfies(parseVersion(version), SEMVER.parseConstraint(constraint));
}

function resolutionKey(pkg: string, constraint: string): string {
  return SEMVER.resolutionKey(pkg, SEMVER.parseConstraint(constraint));
}

describe("Semver", () => {
  it("parses versions", () => {
    expect(parseVersion("1.2.3")).to.deep.equal({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseVersion("v10.0.1")).to.deep.equal({ major: 10, minor: 0, patch: 1, prerelease: [] });
    expect(parseVersion("1.2.3-alpha.1")).to.deep.equal({ major: 1, minor: 2, patch: 3, prerelease: ["alpha", 1] });
    expect(parseVersion("1.2.3+build.5")).to.deep.equal({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(() => parseVersion("1.2")).to.throw();
    expect(() => parseVersion("latest")).to.throw();
  });

  it("orders versions", () => {
    const ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0", "1.0.1", "1.2.0", "1.2.10", "2.0.0"];
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(compareVersions(parseVersion(ordered[i]), parseVersion(ordered[i + 1]))).to.be.lessThan(0);
      expect(compareVersions(parseVersion(ordered[i + 1]), parseVersion(ordered[i]))).to.be.greaterThan(0);
    }
    expect(compareVersions(parseVersion("1.2.3"), parseVersion("1.2.3"))).to.equal(0);
  });

  it("computes constraint minimums", () => {
    expect(minimumOf("1.2.3")).to.equal("1.2.3");
    expect(minimumOf("^1.2.3")).to.equal("1.2.3");
    expect(minimumOf("~1.2")).to.equal("1.2.0");
    expect(minimumOf(">=2.1")).to.equal("2.1.0");
    expect(minimumOf("1.x")).to.equal("1.0.0");
    expect(minimumOf("1")).to.equal("1.0.0");
    expect(minimumOf("*")).to.equal("0.0.0");
    expect(minimumOf("")).to.equal("0.0.0");
    expect(minimumOf("^1.5.0 || ^2.0.0")).to.equal("1.5.0");
    expect(minimumOf(">1.2.3")).to.equal("1.2.4");
    expect(minimumOf(">=1.2.3 <2.0.0")).to.equal("1.2.3");
    expect(minimumOf(">= 2.1.2 < 3.0.0")).to.equal("2.1.2");
    /* Excluding a prerelease leaves the rest of that triple admissible, so the
     * floor is its immediate successor, not the next patch. */
    expect(minimumOf(">1.2.3-rc.1")).to.equal("1.2.3-rc.1.0");
    expect(satisfies("1.2.3-rc.2", ">1.2.3-rc.1")).to.equal(true);
  });

  it("reads '~>' as the tilde range npm does", () => {
    expect(minimumOf("~>1.2.3")).to.equal("1.2.3");
    expect(minimumOf("~> 1.2.3")).to.equal("1.2.3");
    expect(satisfies("1.2.9", "~>1.2.3")).to.equal(true);
    expect(satisfies("1.3.0", "~>1.2.3")).to.equal(false);
  });

  it("checks constraint satisfaction", () => {
    expect(satisfies("1.2.3", "1.2.3")).to.equal(true);
    expect(satisfies("1.2.4", "1.2.3")).to.equal(false);

    expect(satisfies("1.9.9", "^1.2.3")).to.equal(true);
    expect(satisfies("1.2.2", "^1.2.3")).to.equal(false);
    expect(satisfies("2.0.0", "^1.2.3")).to.equal(false);

    /* Caret on 0.x pins the minor; on 0.0.x pins the patch */
    expect(satisfies("0.2.9", "^0.2.3")).to.equal(true);
    expect(satisfies("0.3.0", "^0.2.3")).to.equal(false);
    expect(satisfies("0.0.3", "^0.0.3")).to.equal(true);
    expect(satisfies("0.0.4", "^0.0.3")).to.equal(false);

    expect(satisfies("1.2.9", "~1.2.3")).to.equal(true);
    expect(satisfies("1.3.0", "~1.2.3")).to.equal(false);
    expect(satisfies("1.9.0", "~1")).to.equal(true);
    expect(satisfies("2.0.0", "~1")).to.equal(false);

    expect(satisfies("1.2.3", ">=1.2.3 <2")).to.equal(true);
    expect(satisfies("1.9.9", ">=1.2.3 <2")).to.equal(true);
    expect(satisfies("2.0.0", ">=1.2.3 <2")).to.equal(false);
    expect(satisfies("1.2.3", ">1.2.3")).to.equal(false);
    expect(satisfies("1.2.4", ">1.2.3")).to.equal(true);
    expect(satisfies("1.3.0", "<=1.2")).to.equal(false);
    expect(satisfies("1.2.9", "<=1.2")).to.equal(true);

    expect(satisfies("1.5.0", "1.x")).to.equal(true);
    expect(satisfies("2.0.0", "1.x")).to.equal(false);
    expect(satisfies("1.2.9", "1.2")).to.equal(true);
    expect(satisfies("1.3.0", "1.2")).to.equal(false);
    expect(satisfies("99.0.0", "*")).to.equal(true);

    expect(satisfies("1.5.0", "^1.5.0 || ^2.0.0")).to.equal(true);
    expect(satisfies("2.3.0", "^1.5.0 || ^2.0.0")).to.equal(true);
    expect(satisfies("3.0.0", "^1.5.0 || ^2.0.0")).to.equal(false);

    /* Prereleases sort below the corresponding release */
    expect(satisfies("1.0.0-alpha", ">=1.0.0")).to.equal(false);
    expect(satisfies("1.0.0", ">=1.0.0-alpha")).to.equal(true);

    /* Whitespace between operator and version (iconv-lite's '>= 2.1.2 < 3.0.0') */
    expect(satisfies("2.1.2", ">= 2.1.2 < 3.0.0")).to.equal(true);
    expect(satisfies("2.9.9", ">= 2.1.2 < 3.0.0")).to.equal(true);
    expect(satisfies("3.0.0", ">= 2.1.2 < 3.0.0")).to.equal(false);
    expect(satisfies("1.2.9", "~ 1.2.3")).to.equal(true);
    expect(satisfies("1.9.9", "^ 1.2.3")).to.equal(true);
  });

  it("assigns resolution keys per compatibility unit", () => {
    expect(resolutionKey("foo", "^1.2.3")).to.equal("foo@1");
    expect(resolutionKey("foo", "2.0.0")).to.equal("foo@2");
    expect(resolutionKey("foo", "^0.2.3")).to.equal("foo@0.2");
    expect(resolutionKey("@scope/foo", "~3.1.0")).to.equal("@scope/foo@3");
  });

  it("parses hyphen ranges per npm ('A - B', partials widening the right bound)", () => {
    expect(satisfies("1.2.3", "1.2.3 - 2.3.4")).to.equal(true);
    expect(satisfies("2.3.4", "1.2.3 - 2.3.4")).to.equal(true);
    expect(satisfies("1.2.2", "1.2.3 - 2.3.4")).to.equal(false);
    expect(satisfies("2.3.5", "1.2.3 - 2.3.4")).to.equal(false);
    expect(minimumOf("1.2.3 - 2.3.4")).to.equal("1.2.3");

    /* A partial right bound admits its whole prefix (the '<=' partial rule);
     * a partial left bound zero-fills. */
    expect(satisfies("2.3.9", "1.2.3 - 2.3")).to.equal(true);
    expect(satisfies("2.4.0", "1.2.3 - 2.3")).to.equal(false);
    expect(satisfies("2.9.9", "1.2 - 2")).to.equal(true);
    expect(satisfies("3.0.0", "1.2 - 2")).to.equal(false);
    expect(minimumOf("1.2 - 2")).to.equal("1.2.0");

    /* Composes with disjunctions and conjunctions. */
    expect(satisfies("3.5.0", "1.2.3 - 2.0.0 || 3.x")).to.equal(true);
    expect(satisfies("2.5.0", "1.2.3 - 2.0.0 || 3.x")).to.equal(false);

    /* The spaces are load-bearing: an unspaced hyphen is a prerelease. */
    expect(satisfies("1.2.3-rc", "1.2.3-rc")).to.equal(true);
    expect(() => SEMVER.parseConstraint("1.2.3 -")).to.throw(/hyphen range/);
    expect(() => SEMVER.parseConstraint("- 2.0.0")).to.throw(/hyphen range/);
  });

  it("rejects unsupported constraint syntax", () => {
    expect(() => SEMVER.parseConstraint("latest")).to.throw();
    expect(() => SEMVER.parseConstraint("workspace:*")).to.throw();
  });

  it("lowestSatisfying never invents a prerelease the constraint didn't opt into", () => {
    const pick = (versions: string[], constraint: string): string | undefined => {
      const found = lowestSatisfying(versions.map(parseVersion), SEMVER.parseConstraint(constraint));
      return found && versionToString(found);
    };
    /* A prerelease sorts BELOW its release, so a naive lowest-satisfying pick
     * would prefer the rc over the available release — npm's contract is that
     * '^4.0.0' admits no prerelease at all. */
    expect(pick(["4.0.1-rc.0", "4.0.1", "4.1.0"], "^4.0.0")).to.equal("4.0.1");
    /* No release in range: nothing, rather than a silent rc (npm makes
     * prereleases opt-in; the remedy is pinning it explicitly). */
    expect(pick(["4.0.1-rc.0"], "^4.0.0")).to.equal(undefined);
    /* A constraint mentioning a prerelease opts in. */
    expect(pick(["1.2.3-beta.5", "1.2.4"], "^1.2.3-beta.4")).to.equal("1.2.3-beta.5");
    expect(pick(["1.0.1", "1.2.0"], "^1.0.0")).to.equal("1.0.1");
  });

  it("classifies floorless requirements", () => {
    const floorless = (text: string): boolean => SEMVER.isFloorless(SEMVER.parseConstraint(text));
    expect(floorless("*")).to.equal(true);
    expect(floorless("x")).to.equal(true);
    expect(floorless(">=0.0.0")).to.equal(true);
    expect(floorless("* || ^1.0.0")).to.equal(true);
    /* An upper-bound-only range floors at a fabricated 0.0.0 — it expresses no
     * lower bound, so it must contribute no demand (the zero floor is a version
     * nothing asked for — see @google-cloud/storage's '<4.1.0'). */
    expect(floorless("<4.1.0")).to.equal(true);
    expect(floorless("<=2")).to.equal(true);
    expect(floorless("<4.1.0 || >=5.0.0")).to.equal(true);
    expect(floorless("^1.0.0")).to.equal(false);
    expect(floorless(">=1.0.0")).to.equal(false);
    expect(floorless("1.x")).to.equal(false);
    /* An exact zero names that very version — a real floored demand. */
    expect(floorless("0.0.0")).to.equal(false);
  });
});
