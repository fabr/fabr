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
import { runFabr, STUB_TSC, STUB_TSC_CONFIG } from "./harness";

/* `fabr audit` reads the trees `fabr deps` prints and asks the advisory
 * database `ADVISORIES_URL` names about each registry package among them. The
 * fixture's packages are all built in the project, which have no published
 * version to ask about, so the database is never contacted: the address given
 * here answers nothing. */
const PROJECT =
  "plugin @fabr-build/js;\n\n" +
  STUB_TSC_CONFIG +
  "\njs_package audit_lib { srcs = lib:**; }\n" +
  "js_package audit_app { srcs = app:**; deps = audit_lib; }\n";
const FILES = {
  ...STUB_TSC,
  "lib/index.ts": 'exports.lib = "audit e2e lib";\n',
  "app/index.ts": 'exports.app = "audit e2e app";\n',
};

function fabrAudit(...args: string[]): { stdout: string; stderr: string; status: number } {
  return runFabr({ "PROJECT.fabr": PROJECT, ...FILES }, [
    "-DJS_TARGET=es2020",
    "-DADVISORIES_URL=http://127.0.0.1:9/",
    "audit",
    ...args,
  ]);
}

describe("e2e: fabr audit", () => {
  it("resolves the trees without building, and reports nothing to audit where every package is built in the project", () => {
    const result = fabrAudit("audit_app");
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stdout).to.equal("No packages to audit\n");
    expect(result.stderr).to.not.contain("Compiling");
  });

  it("writes the report as SARIF with --format sarif", () => {
    for (const result of [fabrAudit("--format", "sarif", "audit_app"), fabrAudit("--format=sarif", "audit_app")]) {
      expect(result.status, result.stderr).to.equal(0);
      const log = JSON.parse(result.stdout);
      expect(log.version).to.equal("2.1.0");
      expect(log.runs[0].tool.driver.name).to.equal("fabr");
      expect(log.runs[0].tool.driver.rules).to.deep.equal([]);
      expect(log.runs[0].results).to.deep.equal([]);
      expect(log.runs[0].properties).to.deep.equal({ packagesChecked: 0 });
    }
  });

  it("reads the OpenVEX documents ADVISORIES_SUPPRESSION_FILE names, and reports one it cannot read", () => {
    const run = (vex: string): { stdout: string; stderr: string; status: number } =>
      runFabr({ "PROJECT.fabr": PROJECT + "ADVISORIES_SUPPRESSION_FILE = ./vex.json;\n", ...FILES, "vex.json": vex }, [
        "-DJS_TARGET=es2020",
        "-DADVISORIES_URL=http://127.0.0.1:9/",
        "audit",
        "audit_app",
      ]);
    const valid = run(
      JSON.stringify({ statements: [{ vulnerability: "CVE-1", products: ["pkg:npm/lodash"], status: "not_affected" }] })
    );
    expect(valid.status, valid.stderr).to.equal(0);
    expect(valid.stdout).to.equal("No packages to audit\n");
    const invalid = run(JSON.stringify({ statements: [{ vulnerability: "CVE-1", status: "ignored" }] }));
    expect(invalid.status).to.not.equal(0);
    expect(invalid.stderr).to.contain("vex.json");
    expect(invalid.stderr).to.contain("statement 1 has no status OpenVEX defines");
  });

  it("refuses a reference that selects files, as deps does", () => {
    const result = fabrAudit("audit_app:build/*.js");
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.match(/name the target|selects/i);
    expect(result.stderr).to.contain("Audit failed");
    expect(result.stderr).to.not.contain("Build failed");
  });
});
