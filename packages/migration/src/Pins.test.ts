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
import { Catalog, entryReference } from "./Catalog";
import { Lockfile } from "./Lockfile";
import { npmPurl, Observation, proposePins } from "./Pins";

const lockfile = (versions: Record<string, string[]>): Lockfile => ({
  file: "pnpm-lock.yaml",
  versions: new Map(Object.entries(versions).map(([name, held]) => [name, new Set(held)])),
});

const observation = (facts: Partial<Record<"selected" | "conflicts", Record<string, string[]>>> & { floorless?: string[] }): Observation => ({
  selected: new Map(Object.entries(facts.selected ?? {}).map(([name, held]) => [name, new Set(held)])),
  conflicts: new Map(Object.entries(facts.conflicts ?? {}).map(([name, held]) => [name, new Set(held)])),
  floorless: new Set(facts.floorless ?? []),
  failures: [],
  failed: [],
});

const written = (catalog: Catalog): string[] => [...catalog.entries.values()].map(entryReference).sort();

describe("proposing pins", () => {
  it("raises a selection below what the lockfile installs in its caret range", () => {
    const catalog = new Catalog();
    const proposal = proposePins(catalog, observation({ selected: { chalk: ["4.0.0"], ms: ["2.1.3"], z: ["0.3.1"] } }), lockfile({ chalk: ["4.1.2", "5.0.0"], ms: ["2.1.3"], z: ["0.4.0", "0.3.5"] }));
    expect(proposal.added).to.equal(2);
    expect(written(catalog)).to.deep.equal(["@npm:chalk:^4.1.2", "@npm:z:^0.3.5"]);
  });

  it("raises across a major where the lockfile installs the package at one version", () => {
    const catalog = new Catalog();
    proposePins(catalog, observation({ selected: { unicode: ["0.3.1"] } }), lockfile({ unicode: ["14.0.0"] }));
    expect(written(catalog)).to.deep.equal(["@npm:unicode:^14.0.0"]);
  });

  it("reports a second version below the lockfile's, which no entry can raise", () => {
    const catalog = new Catalog();
    const proposal = proposePins(catalog, observation({ selected: { a: ["1.0.0", "2.1.0"] } }), lockfile({ a: ["1.2.0", "2.1.0"] }));
    expect(proposal.added).to.equal(0);
    expect(proposal.unanswered.map(([, line]) => line)).to.deep.equal(["a@1.0.0 (pnpm-lock.yaml installs 1.2.0)"]);
  });

  it("pins a floorless package at what the lockfile installs, else the latest published", () => {
    const catalog = new Catalog();
    const proposal = proposePins(
      catalog,
      observation({ floorless: ["@types/a", "b", "c"] }),
      lockfile({ "@types/a": ["1.0.0", "1.1.0"] }),
      new Map([["b", "0.0.1"]])
    );
    expect(written(catalog)).to.deep.equal(["@npm:@types/a:^1.1.0", "@npm:b:^0.0.1"]);
    expect(catalog.entries.get("b")?.note).to.include("the latest published");
    expect(proposal.unanswered.map(([, line]) => line).sort()).to.deep.equal(["b@0.0.1", "c"]);
  });

  it("sanctions conflicting versions where the lockfile installs several, and reports the rest", () => {
    const catalog = new Catalog();
    const proposal = proposePins(catalog, observation({ conflicts: { ms: ["2.0.0", "2.1.3"], one: ["1.0.0", "2.0.0"] } }), lockfile({ ms: ["2.0.0", "2.1.3"], one: ["2.0.0"] }));
    expect([...catalog.alternates]).to.deep.equal([["ms", new Set(["2.0.0", "2.1.3"])]]);
    expect(proposal.unanswered.map(([, line]) => line)).to.deep.equal(["one: 1.0.0, 2.0.0"]);
    expect(proposePins(catalog, observation({ conflicts: { ms: ["2.0.0", "2.1.3"] } }), lockfile({ ms: ["2.0.0", "2.1.3"] })).added).to.equal(0);
  });

  it("reads an npm purl", () => {
    expect(npmPurl("pkg:npm/%40scope/name@1.2.3")).to.deep.equal({ name: "@scope/name", version: "1.2.3" });
    expect(npmPurl("pkg:maven/g/a@1.0")).to.equal(undefined);
  });
});
