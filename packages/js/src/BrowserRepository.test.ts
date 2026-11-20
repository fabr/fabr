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
import { compatibilityFormat, compatibilityReader, Computable, dependenciesOn, parseName, PackageFileSet } from "@fabr-build/core";
import { browserDataOf, BrowserRepository, browserQueryOf, type ICaniuseAgents } from "./BrowserRepository";
import { BROWSER_FORMAT, type BrowserVersion } from "./BrowserVersion";
import { chromePlatformOf, releaseBranchBuild, toChromeBuilds } from "./ChromeForTesting";

function settle<T>(value: Computable<T>): Promise<T> {
  return new Promise((resolve, reject) => value.then(resolve, reject));
}

const DATA = {
  browsers: new Map([
    ["safari", ["16.4", "17.2", "18.0"]],
    ["ios_saf", ["17.2", "18.5-18.7"]],
    ["chrome", ["119", "120", "121"]],
    ["op_mini", ["all"]],
  ]),
  baseline: new Map([
    [
      "2023",
      new Map([
        ["safari", "17.2"],
        ["ios_saf", "17.2"],
        ["chrome", "120"],
      ]),
    ],
  ]),
};

describe("BROWSER_FORMAT", () => {
  const v = (text: string): BrowserVersion => BROWSER_FORMAT.parseVersion(text);

  it("orders versions oldest first, part by part, and reads a version written in a reference as a prefix", () => {
    expect(BROWSER_FORMAT.compare(v("12"), v("17.2"))).to.be.lessThan(0);
    expect(BROWSER_FORMAT.compare(v("17"), v("17.0"))).to.equal(0);
    expect(BROWSER_FORMAT.compare(v("156.0.8078.4"), v("156.0.8078.80"))).to.be.lessThan(0);
    const milestone = BROWSER_FORMAT.parseConstraint("156");
    expect(BROWSER_FORMAT.satisfies(v("156.0.8078.4"), milestone)).to.equal(true);
    expect(BROWSER_FORMAT.satisfies(v("157.0.8103.78"), milestone)).to.equal(false);
    expect(BROWSER_FORMAT.satisfies(v("156.0.8078.4"), BROWSER_FORMAT.parseConstraint("156.0.8078.4"))).to.equal(true);
  });

  it("writes versions as they are written, ordering a range of Can I Use's by its lower end, and `all` lowest", () => {
    expect(BROWSER_FORMAT.versionToString(v("17.2"))).to.equal("17.2");
    expect(BROWSER_FORMAT.versionToString(v("18.5-18.7"))).to.equal("18.5-18.7");
    expect(BROWSER_FORMAT.compare(v("18.5-18.7"), v("18.5"))).to.equal(0);
    expect(BROWSER_FORMAT.compare(v("all"), v("1"))).to.be.lessThan(0);
  });

  it("splits a reference into the browser and its version, and refuses one without a version", () => {
    expect(BROWSER_FORMAT.splitReference(parseName("safari:17.2"))).to.deep.include({ name: "safari", versionConstraint: "17.2" });
    expect(() => BROWSER_FORMAT.validateRequirement({ name: "safari", versionConstraint: undefined })).to.throw(/Missing version/);
    expect(() => BROWSER_FORMAT.validateRequirement({ name: "safari", versionConstraint: ">=15.4" })).to.throw(
      /not a browser version/
    );
    expect(() => BROWSER_FORMAT.validateRequirement({ name: "op_mini", versionConstraint: "all" })).to.not.throw();
    expect(() => BROWSER_FORMAT.splitReference(parseName("safari:17.2:lib/x.js"))).to.throw(/a browser has none/);
  });

  it("read for compatibility, takes a version as a floor, satisfied by it and older, the lowest floor ordered greatest", () => {
    const compatibility = compatibilityFormat(BROWSER_FORMAT);
    const supports = compatibility.parseConstraint("17.2");
    expect(compatibility.satisfies(v("17.2"), supports)).to.equal(true);
    expect(compatibility.satisfies(v("16.4"), supports)).to.equal(true);
    expect(compatibility.satisfies(v("26.6"), supports)).to.equal(false);
    expect(compatibility.compare(v("12"), v("17.2"))).to.be.greaterThan(0);
    expect(compatibility.versionToString(compatibility.minimumOf(supports))).to.equal("17.2");
  });
});

describe("BrowserRepository", () => {
  const repository = new BrowserRepository({ name: "@browser", operation: "build" }, DATA, "test data");

  it("lists each browser's released, numbered versions", async () => {
    const versions = await settle(repository.availableVersions("safari"));
    expect(versions?.map(version => BROWSER_FORMAT.versionToString(version))).to.deep.equal(["16.4", "17.2", "18.0"]);
    expect(BROWSER_FORMAT.versionToString((await settle(repository.lowestAvailable("ios_saf", "18")))!)).to.equal("18.5-18.7");
    expect(BROWSER_FORMAT.versionToString((await settle(repository.lowestAvailable("safari", "17.2")))!)).to.equal("17.2");
    expect(BROWSER_FORMAT.versionToString((await settle(repository.lowestAvailable("op_mini", "all")))!)).to.equal("all");
  });

  it("read for compatibility, finds the newest version at or below a floor", async () => {
    const compatible = compatibilityReader(repository);
    expect(compatible.identity).to.equal("browser:test data compatibility");
    expect(BROWSER_FORMAT.versionToString((await settle(compatible.lowestAvailable!("ios_saf", "18")))!)).to.equal("17.2");
    expect((await settle(compatible.fetch("safari", BROWSER_FORMAT.parseVersion("17.2")))).size).to.equal(0);
  });

  it("gives a browser no requirements, and a Baseline year each core browser's version", async () => {
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

describe("Chrome for Testing", () => {
  const v = (text: string): BrowserVersion => BROWSER_FORMAT.parseVersion(text);
  const select = (versions: string[], written: string): string | undefined =>
    releaseBranchBuild(versions.map(v), BROWSER_FORMAT.parseConstraint(written), "@browser:chrome")?.text;
  const published = ["156.0.8060.0", "156.0.8060.2", "156.0.8078.0", "156.0.8078.3", "156.0.8078.4", "156.0.8078.80", "160.0.8172.0"];

  it("selects a milestone's first build on its release branch, and an exact build itself", () => {
    expect(select(published, "156")).to.equal("156.0.8078.0");
    expect(
      select(
        published.filter(text => text !== "156.0.8078.0"),
        "156"
      )
    ).to.equal("156.0.8078.3");
    expect(select(published, "156.0.8060.2")).to.equal("156.0.8060.2");
    expect(select(published, "160.0.8172.0")).to.equal("160.0.8172.0");
    expect(select(published, "157")).to.equal(undefined);
  });

  it("refuses a milestone with no release branch yet, naming an exact build", () => {
    expect(() => select(published, "160")).to.throw(/Chrome 160 has no release branch yet/);
  });

  it("reads each build's Chrome archive by platform, and names the platform for a target", () => {
    const builds = toChromeBuilds({
      versions: [
        { version: "156.0.8078.3", downloads: { chrome: [{ platform: "linux64", url: "https://example.test/linux64.zip" }] } },
        { version: "113.0.5672.0" },
      ],
    });
    expect(builds.get("156.0.8078.3")?.get("linux64")).to.equal("https://example.test/linux64.zip");
    expect(builds.get("113.0.5672.0")?.size).to.equal(0);
    expect(() => toChromeBuilds({ versions: [{ version: 156 }] })).to.throw(/expected a version/);
    expect(chromePlatformOf("aarch64-apple-darwin")).to.equal("mac-arm64");
    expect(chromePlatformOf("x86_64-unknown-linux-gnu")).to.equal("linux64");
    expect(chromePlatformOf("x86_64-pc-windows-msvc")).to.equal("win64");
    expect(chromePlatformOf("riscv64-unknown-linux-gnu")).to.equal(undefined);
  });
});

describe("browserQueryOf", () => {
  it("lists every browser a Baseline year reaches by its lowest version, leaving the year out", () => {
    const safari = new PackageFileSet(new Map(), "safari", "17.2");
    const chrome = new PackageFileSet(new Map(), "chrome", "120");
    const baseline = new PackageFileSet(new Map(), "baseline", "2023", dependenciesOn(safari, chrome));
    expect(browserQueryOf([baseline, new PackageFileSet(new Map(), "safari", "16.4")])).to.equal("chrome >= 120, safari >= 16.4");
    expect(browserQueryOf([new PackageFileSet(new Map(), "ios_saf", "18.5-18.7")])).to.equal("ios_saf >= 18.5");
    expect(browserQueryOf([])).to.equal("");
  });

  it("names a browser whose one version is Can I Use's `all` as browserslist does", () => {
    const opMini = new PackageFileSet(new Map(), "op_mini", "all");
    expect(browserQueryOf([opMini, new PackageFileSet(new Map(), "chrome", "109")])).to.equal("chrome >= 109, op_mini all");
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

  it("lists a browser whose one version is `all`", () => {
    const data = browserDataOf({ op_mini: { release_date: { all: 1426464000 } } }, () => []);
    expect(data.browsers.get("op_mini")).to.deep.equal(["all"]);
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
    expect(Object.fromEntries(data.baseline.get("2023")!)).to.include({
      safari: "17.2",
      ios_saf: "17.2",
      chrome: "120",
      firefox: "121",
    });
    expect(data.browsers.get("safari")).to.include("17.2");
  });
});
