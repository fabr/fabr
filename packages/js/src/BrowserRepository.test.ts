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
import { Computable, dependenciesOn, parseName, PackageFileSet, SEMVER, SemverVersion } from "@fabr-build/core";
import { BROWSER_FORMAT, browserDataOf, BrowserRepository, browserQueryOf, type ICaniuseAgents } from "./BrowserRepository";

function settle<T>(value: Computable<T>): Promise<T> {
  return new Promise((resolve, reject) => value.then(resolve, reject));
}

const DATA = {
  browsers: new Map([
    ["safari", ["16.4", "17.2", "18.0"]],
    ["ios_saf", ["17.2", "18.5-18.7"]],
    ["chrome", ["119", "120", "121"]],
  ]),
  baseline: new Map([["2023", new Map([["safari", "17.2"], ["ios_saf", "17.2"], ["chrome", "120"]])]]),
};

describe("BROWSER_FORMAT", () => {
  it("orders versions newest first, so the greatest floor is the oldest browser supported", () => {
    const v = (text: string): SemverVersion => BROWSER_FORMAT.parseVersion(text);
    expect(BROWSER_FORMAT.compare(v("12"), v("17.2"))).to.be.greaterThan(0);
    /* Supporting Safari 17.2 and newer is satisfied by an oldest-supported 16.4 too. */
    const supports = BROWSER_FORMAT.parseConstraint("17.2");
    expect(BROWSER_FORMAT.satisfies(v("17.2"), supports)).to.equal(true);
    expect(BROWSER_FORMAT.satisfies(v("16.4"), supports)).to.equal(true);
    expect(BROWSER_FORMAT.satisfies(v("26.6"), supports)).to.equal(false);
    expect(BROWSER_FORMAT.versionToString(BROWSER_FORMAT.minimumOf(supports))).to.equal("17.2");
    expect(BROWSER_FORMAT.isFloorless(supports)).to.equal(false);
  });

  it("writes versions as Can I Use does", () => {
    expect(BROWSER_FORMAT.versionToString(BROWSER_FORMAT.parseVersion("120"))).to.equal("120");
    expect(BROWSER_FORMAT.versionToString(BROWSER_FORMAT.parseVersion("17.2"))).to.equal("17.2");
    /* A range of Can I Use's is its lower end. */
    expect(SEMVER.versionToString(BROWSER_FORMAT.parseVersion("18.5-18.7"))).to.equal("18.5.0");
  });

  it("splits a reference into the browser and its lowest version, and refuses one without a version", () => {
    expect(BROWSER_FORMAT.splitReference(parseName("safari:17.2"))).to.deep.include({ name: "safari", versionConstraint: "17.2" });
    expect(() => BROWSER_FORMAT.validateRequirement({ name: "safari", versionConstraint: undefined })).to.throw(/Missing version/);
    expect(() => BROWSER_FORMAT.validateRequirement({ name: "safari", versionConstraint: ">=15.4" })).to.throw(/not a browser version/);
    expect(() => BROWSER_FORMAT.splitReference(parseName("safari:17.2:lib/x.js"))).to.throw(/a browser has none/);
  });
});

describe("BrowserRepository", () => {
  const repository = new BrowserRepository({ name: "@browser", operation: "build" }, DATA, "test data");

  it("lists each browser's released, numbered versions", async () => {
    const versions = await settle(repository.availableVersions("safari"));
    expect(versions?.map(version => BROWSER_FORMAT.versionToString(version))).to.deep.equal(["16.4", "17.2", "18"]);
    /* First in the domain's order: the newest version the requirement admits. */
    expect(BROWSER_FORMAT.versionToString((await settle(repository.lowestAvailable("ios_saf", "18")))!)).to.equal("17.2");
    expect(BROWSER_FORMAT.versionToString((await settle(repository.lowestAvailable("safari", "17.2")))!)).to.equal("17.2");
  });

  it("gives a browser no requirements, and a Baseline year each core browser's version or later", async () => {
    expect(await settle(repository.getRequirements("safari", BROWSER_FORMAT.parseVersion("17.2")))).to.deep.equal([]);
    expect(await settle(repository.getRequirements("baseline", BROWSER_FORMAT.parseVersion("2023")))).to.deep.equal([
      { name: "chrome", versionConstraint: "120" },
      { name: "ios_saf", versionConstraint: "17.2" },
      { name: "safari", versionConstraint: "17.2" },
    ]);
  });

  it("refuses a version it does not have", async () => {
    let error: Error | undefined;
    await settle(repository.getRequirements("safari", BROWSER_FORMAT.parseVersion("15.0"))).catch((err: Error) => (error = err));
    expect(error?.message).to.match(/has no safari 15/);
  });
});

describe("browserQueryOf", () => {
  it("lists every browser a Baseline year reaches by its lowest version, leaving the year out", () => {
    const safari = new PackageFileSet(new Map(), "safari", "17.2");
    const chrome = new PackageFileSet(new Map(), "chrome", "120");
    const baseline = new PackageFileSet(new Map(), "baseline", "2023", dependenciesOn(safari, chrome));
    expect(browserQueryOf([baseline, new PackageFileSet(new Map(), "safari", "16.4")])).to.equal("chrome >= 120, safari >= 16.4");
    expect(browserQueryOf([])).to.equal("");
  });
});

describe("browserDataOf", () => {
  const agents: ICaniuseAgents = {
    safari: { release_date: { "16.4": 1679875200, "17.2": 1702252800, TP: null } },
    ios_saf: { release_date: { "17.2": 1702252800, "18.5-18.7": 1747008000 } },
  };

  it("lists each browser's released versions, and a Baseline year to the last release's", () => {
    const years: number[] = [];
    const data = browserDataOf(agents, year => {
      years.push(year);
      return [
        { browser: "safari", version: "17.2" },
        { browser: "safari_ios", version: "17.2" },
        /* Not a core browser: left out. */
        { browser: "samsunginternet_android", version: "25.0" },
      ];
    });
    expect([...data.browsers]).to.deep.equal([
      ["ios_saf", ["17.2", "18.5-18.7"]],
      ["safari", ["16.4", "17.2"]],
    ]);
    expect(years[0]).to.equal(2015);
    expect(years[years.length - 1]).to.equal(2025);
    expect([...data.baseline.get("2023")!]).to.deep.equal([
      ["safari", "17.2"],
      ["ios_saf", "17.2"],
    ]);
  });

  it("has no Baseline year the data gives no versions for", () => {
    const data = browserDataOf(agents, year => (year < 2024 ? [{ browser: "safari", version: "16.4" }] : []));
    expect(data.baseline.has("2023")).to.equal(true);
    expect(data.baseline.has("2024")).to.equal(false);
  });

  it("lists a version a Baseline year names among its browser's versions", () => {
    const android: ICaniuseAgents = { and_chr: { release_date: { "156": 1780000000 } } };
    const data = browserDataOf(android, () => [{ browser: "chrome_android", version: "120" }]);
    expect(data.browsers.get("and_chr")).to.deep.equal(["120", "156"]);
  });

  it("gives Baseline 2023 as Safari 17.2 and Chrome 120, from the pinned data", () => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const { agents: real } = require("caniuse-lite") as { agents: ICaniuseAgents };
    const mapping = require("baseline-browser-mapping") as {
      getCompatibleVersions(options: { targetYear: number; suppressWarnings: boolean }): Array<{ browser: string; version: string }>;
    };
    /* eslint-enable @typescript-eslint/no-var-requires */
    const data = browserDataOf(real, year => mapping.getCompatibleVersions({ targetYear: year, suppressWarnings: true }));
    expect(Object.fromEntries(data.baseline.get("2023")!)).to.include({ safari: "17.2", ios_saf: "17.2", chrome: "120", firefox: "121" });
    expect(data.browsers.get("safari")).to.include("17.2");
  });
});
