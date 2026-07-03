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

import { compareVersions, parseVersion, SEMVER, versionToString } from "./Semver";

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
    expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseVersion("v10.0.1")).toEqual({ major: 10, minor: 0, patch: 1, prerelease: [] });
    expect(parseVersion("1.2.3-alpha.1")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: ["alpha", 1] });
    expect(parseVersion("1.2.3+build.5")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(() => parseVersion("1.2")).toThrow();
    expect(() => parseVersion("latest")).toThrow();
  });

  it("orders versions", () => {
    const ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0", "1.0.1", "1.2.0", "1.2.10", "2.0.0"];
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(compareVersions(parseVersion(ordered[i]), parseVersion(ordered[i + 1]))).toBeLessThan(0);
      expect(compareVersions(parseVersion(ordered[i + 1]), parseVersion(ordered[i]))).toBeGreaterThan(0);
    }
    expect(compareVersions(parseVersion("1.2.3"), parseVersion("1.2.3"))).toBe(0);
  });

  it("computes constraint minimums", () => {
    expect(minimumOf("1.2.3")).toBe("1.2.3");
    expect(minimumOf("^1.2.3")).toBe("1.2.3");
    expect(minimumOf("~1.2")).toBe("1.2.0");
    expect(minimumOf(">=2.1")).toBe("2.1.0");
    expect(minimumOf("1.x")).toBe("1.0.0");
    expect(minimumOf("1")).toBe("1.0.0");
    expect(minimumOf("*")).toBe("0.0.0");
    expect(minimumOf("")).toBe("0.0.0");
    expect(minimumOf("^1.5.0 || ^2.0.0")).toBe("1.5.0");
    expect(minimumOf(">1.2.3")).toBe("1.2.4");
    expect(minimumOf(">=1.2.3 <2.0.0")).toBe("1.2.3");
  });

  it("checks constraint satisfaction", () => {
    expect(satisfies("1.2.3", "1.2.3")).toBe(true);
    expect(satisfies("1.2.4", "1.2.3")).toBe(false);

    expect(satisfies("1.9.9", "^1.2.3")).toBe(true);
    expect(satisfies("1.2.2", "^1.2.3")).toBe(false);
    expect(satisfies("2.0.0", "^1.2.3")).toBe(false);

    /* Caret on 0.x pins the minor; on 0.0.x pins the patch */
    expect(satisfies("0.2.9", "^0.2.3")).toBe(true);
    expect(satisfies("0.3.0", "^0.2.3")).toBe(false);
    expect(satisfies("0.0.3", "^0.0.3")).toBe(true);
    expect(satisfies("0.0.4", "^0.0.3")).toBe(false);

    expect(satisfies("1.2.9", "~1.2.3")).toBe(true);
    expect(satisfies("1.3.0", "~1.2.3")).toBe(false);
    expect(satisfies("1.9.0", "~1")).toBe(true);
    expect(satisfies("2.0.0", "~1")).toBe(false);

    expect(satisfies("1.2.3", ">=1.2.3 <2")).toBe(true);
    expect(satisfies("1.9.9", ">=1.2.3 <2")).toBe(true);
    expect(satisfies("2.0.0", ">=1.2.3 <2")).toBe(false);
    expect(satisfies("1.2.3", ">1.2.3")).toBe(false);
    expect(satisfies("1.2.4", ">1.2.3")).toBe(true);
    expect(satisfies("1.3.0", "<=1.2")).toBe(false);
    expect(satisfies("1.2.9", "<=1.2")).toBe(true);

    expect(satisfies("1.5.0", "1.x")).toBe(true);
    expect(satisfies("2.0.0", "1.x")).toBe(false);
    expect(satisfies("1.2.9", "1.2")).toBe(true);
    expect(satisfies("1.3.0", "1.2")).toBe(false);
    expect(satisfies("99.0.0", "*")).toBe(true);

    expect(satisfies("1.5.0", "^1.5.0 || ^2.0.0")).toBe(true);
    expect(satisfies("2.3.0", "^1.5.0 || ^2.0.0")).toBe(true);
    expect(satisfies("3.0.0", "^1.5.0 || ^2.0.0")).toBe(false);

    /* Prereleases sort below the corresponding release */
    expect(satisfies("1.0.0-alpha", ">=1.0.0")).toBe(false);
    expect(satisfies("1.0.0", ">=1.0.0-alpha")).toBe(true);
  });

  it("assigns resolution keys per compatibility unit", () => {
    expect(resolutionKey("foo", "^1.2.3")).toBe("foo@1");
    expect(resolutionKey("foo", "2.0.0")).toBe("foo@2");
    expect(resolutionKey("foo", "^0.2.3")).toBe("foo@0.2");
    expect(resolutionKey("@scope/foo", "~3.1.0")).toBe("@scope/foo@3");
  });

  it("rejects unsupported constraint syntax", () => {
    expect(() => SEMVER.parseConstraint("1.2.3 - 2.0.0")).toThrow();
    expect(() => SEMVER.parseConstraint("latest")).toThrow();
    expect(() => SEMVER.parseConstraint("workspace:*")).toThrow();
  });
});
