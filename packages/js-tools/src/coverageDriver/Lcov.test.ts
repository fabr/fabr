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
import { IFileCoverageData, lcovOf, mergeRecord, recordOf, sourceOf } from "./Lcov";

const at = (line: number, column = 0): { start: { line: number; column: number }; end: { line: number; column: number } } => ({
  start: { line, column },
  end: { line, column: column + 1 },
});

const DATA: IFileCoverageData = {
  path: "/install/build/fabr:./src/a.ts",
  statementMap: { 0: at(2), 1: at(2, 10), 2: at(5) },
  s: { 0: 0, 1: 3, 2: 0 },
  fnMap: { 0: { name: "f", loc: at(1) } },
  f: { 0: 3 },
  branchMap: { 0: { loc: at(4), locations: [at(4), at(6)] } },
  b: { 0: [3, 0] },
};

describe("the coverage driver's lcov", () => {
  it("names a source by the fabr reference its map gives, joined onto the map's directory", () => {
    expect(sourceOf("/install/build/fabr:./src/a.ts", "/install/build")).to.equal("./src/a.ts");
    expect(sourceOf("/install/build/fabr:lib:x.css.ts", "/install/build/")).to.equal("lib:x.css.ts");
    expect(sourceOf("/install/src/plain.ts", "/install/build")).to.equal("/install/src/plain.ts");
  });

  it("counts a line as the highest of the statements starting on it", () => {
    const record = recordOf("./src/a.ts", DATA);
    expect([...record.lines]).to.deep.equal([
      [2, 3],
      [5, 0],
    ]);
    expect(record.functions).to.deep.equal([{ name: "f", line: 1, count: 3 }]);
    expect(record.branches).to.deep.equal([
      { line: 4, block: 0, arm: 0, count: 3 },
      { line: 4, block: 0, arm: 1, count: 0 },
    ]);
  });

  it("sums the counts of two records of one source", () => {
    const into = recordOf("./src/a.ts", DATA);
    mergeRecord(into, recordOf("./src/a.ts", { ...DATA, s: { 0: 0, 1: 1, 2: 2 }, f: { 0: 1 }, b: { 0: [0, 1] } }));
    expect(into.lines.get(2)).to.equal(4);
    expect(into.lines.get(5)).to.equal(2);
    expect(into.functions[0].count).to.equal(4);
    expect(into.branches.map(arm => arm.count)).to.deep.equal([3, 1]);
  });

  it("writes lcov's records, with their totals", () => {
    expect(lcovOf([recordOf("./src/a.ts", DATA)])).to.equal(
      [
        "TN:",
        "SF:./src/a.ts",
        "FN:1,f",
        "FNF:1",
        "FNH:1",
        "FNDA:3,f",
        "DA:2,3",
        "DA:5,0",
        "LF:2",
        "LH:1",
        "BRDA:4,0,0,3",
        "BRDA:4,0,1,0",
        "BRF:2",
        "BRH:1",
        "end_of_record",
        "",
      ].join("\n")
    );
    expect(lcovOf([])).to.equal("");
  });
});
