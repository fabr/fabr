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
import { coverageTotals, lcovOf, mergeCoverage, parseLcov } from "./Coverage";

const lcov = (source: string, lines: Array<[number, number]>, branches: Array<[string, number]> = [], fn = 1): string =>
  [
    "TN:",
    `SF:${source}`,
    "FN:1,f",
    `FNDA:${fn},f`,
    ...lines.map(([line, count]) => `DA:${line},${count}`),
    ...branches.map(([key, count]) => `BRDA:${key},${count}`),
    "end_of_record",
    "",
  ].join("\n");

describe("coverage merging", () => {
  it("sums lines and functions across documents, by source", () => {
    const coverage = mergeCoverage([
      parseLcov(lcov("./a.ts", [[1, 1], [2, 0]])),
      parseLcov(lcov("./a.ts", [[2, 3], [4, 0]], [], 2) + lcov("./b.ts", [[1, 0]], [], 0)),
    ]);
    const a = coverage.get("./a.ts")!;
    expect([...a.lines]).to.deep.equal([
      [1, 1],
      [2, 3],
      [4, 0],
    ]);
    expect([...a.functions.values()]).to.deep.equal([{ line: 1, name: "f", count: 3 }]);
    expect(coverageTotals(coverage.values())).to.deep.equal({
      lines: { covered: 2, total: 4 },
      functions: { covered: 1, total: 2 },
      branches: { covered: 0, total: 0 },
    });
  });

  it("sums branches numbered alike, and drops a source's branches numbered otherwise", () => {
    const alike = mergeCoverage([parseLcov(lcov("./a.ts", [[1, 1]], [["1,0,0", 1], ["1,0,1", 0]])), parseLcov(lcov("./a.ts", [[1, 1]], [["1,0,0", 0], ["1,0,1", 2]]))]);
    expect([...alike.get("./a.ts")!.branches!]).to.deep.equal([
      ["1,0,0", 1],
      ["1,0,1", 2],
    ]);
    const unlike = mergeCoverage([parseLcov(lcov("./a.ts", [[1, 1]], [["1,0,0", 1]])), parseLcov(lcov("./a.ts", [[1, 1]], [["3,0,0", 1]]))]);
    expect(unlike.get("./a.ts")!.branches).to.equal(undefined);
    expect(unlike.get("./a.ts")!.lines.get(1)).to.equal(2);
  });

  it("writes what it reads", () => {
    const text = lcov("./a.ts", [[1, 1], [2, 0]], [["1,0,0", 1], ["1,0,1", 0]]);
    expect(lcovOf(mergeCoverage([parseLcov(text)]).values())).to.equal(
      [
        "TN:",
        "SF:./a.ts",
        "FN:1,f",
        "FNF:1",
        "FNH:1",
        "FNDA:1,f",
        "DA:1,1",
        "DA:2,0",
        "LF:2",
        "LH:1",
        "BRDA:1,0,0,1",
        "BRDA:1,0,1,0",
        "BRF:2",
        "BRH:1",
        "end_of_record",
        "",
      ].join("\n")
    );
  });
});
