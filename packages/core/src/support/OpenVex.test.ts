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
import { decidingStatement, purlApplies, toVexStatements } from "./OpenVex";

describe("toVexStatements", () => {
  it("reads a 0.2 document: vulnerability objects with aliases, products with identifiers and subcomponents", () => {
    const [statement] = toVexStatements("vex.json")({
      "@context": "https://openvex.dev/ns/v0.2.0",
      timestamp: "2026-01-01T00:00:00Z",
      statements: [
        {
          vulnerability: {
            "@id": "https://nvd.nist.gov/vuln/detail/CVE-2021-23337",
            name: "CVE-2021-23337",
            aliases: ["GHSA-35jh-r3h4-6jhm"],
          },
          products: [
            {
              "@id": "https://example.com/app",
              identifiers: { purl: "pkg:npm/app@1.0.0" },
              subcomponents: [{ "@id": "pkg:npm/lodash@4.17.15" }],
            },
          ],
          status: "not_affected",
          justification: "vulnerable_code_not_in_execute_path",
          impact_statement: "template() is never called",
        },
      ],
    });
    expect(statement).to.deep.equal({
      vulnerability: ["CVE-2021-23337", "GHSA-35jh-r3h4-6jhm"],
      products: ["pkg:npm/app@1.0.0", "pkg:npm/lodash@4.17.15"],
      status: "not_affected",
      justification: "vulnerable_code_not_in_execute_path",
      impact: "template() is never called",
      timestamp: Date.parse("2026-01-01T00:00:00Z"),
      document: "vex.json",
    });
  });

  it("reads a 0.0 document: vulnerability names and products and subcomponents as purls", () => {
    const [statement] = toVexStatements("vex.json")({
      statements: [{ vulnerability: "CVE-1", products: ["pkg:npm/app"], subcomponents: ["pkg:npm/lodash"], status: "fixed" }],
    });
    expect(statement).to.deep.equal({
      vulnerability: ["CVE-1"],
      products: ["pkg:npm/app", "pkg:npm/lodash"],
      status: "fixed",
      document: "vex.json",
    });
  });

  it("refuses a document with no statements, a status OpenVEX does not define and a statement naming no vulnerability", () => {
    expect(() => toVexStatements("vex.json")({})).to.throw("expected an OpenVEX document with statements");
    expect(() => toVexStatements("vex.json")({ statements: [{ vulnerability: "CVE-1", status: "ignored" }] })).to.throw(
      "statement 1 has no status OpenVEX defines"
    );
    expect(() => toVexStatements("vex.json")({ statements: [{ status: "fixed" }] })).to.throw("statement 1 names no vulnerability");
  });
});

describe("purlApplies", () => {
  it("matches type, namespace and name, decoded, and the version only where the identifier states one", () => {
    expect(purlApplies("pkg:npm/%40babel/core", "pkg:npm/%40babel/core@7.0.0")).to.equal(true);
    expect(purlApplies("pkg:npm/@babel/core@7.0.0", "pkg:npm/%40babel/core@7.0.0")).to.equal(true);
    expect(purlApplies("pkg:npm/%40babel/core@7.0.1", "pkg:npm/%40babel/core@7.0.0")).to.equal(false);
    expect(purlApplies("pkg:maven/org.example/lib@1.0?type=jar", "pkg:maven/org.example/lib@1.0")).to.equal(true);
    expect(purlApplies("pkg:npm/lodash", "pkg:npm/lodash-es@4.17.15")).to.equal(false);
  });
});

describe("decidingStatement", () => {
  it("takes the latest statement naming the vulnerability, by id or alias, and the package, the last stated among equals", () => {
    const statements = toVexStatements("vex.json")({
      statements: [
        { vulnerability: "CVE-1", products: ["pkg:npm/a"], status: "not_affected", timestamp: "2026-01-02T00:00:00Z" },
        { vulnerability: "CVE-1", products: ["pkg:npm/a"], status: "affected", timestamp: "2026-01-01T00:00:00Z" },
        { vulnerability: "CVE-1", products: ["pkg:npm/a"], status: "under_investigation" },
        { vulnerability: "CVE-1", products: ["pkg:npm/b"], status: "fixed" },
        { vulnerability: "CVE-1", products: ["pkg:npm/b"], status: "affected" },
      ],
    });
    expect(decidingStatement(statements, ["GHSA-1", "CVE-1"], "pkg:npm/a@1.0.0")).to.equal(statements[0]);
    expect(decidingStatement(statements, ["CVE-1"], "pkg:npm/b@1.0.0")).to.equal(statements[4]);
    expect(decidingStatement(statements, ["CVE-2"], "pkg:npm/a@1.0.0")).to.equal(undefined);
  });
});
