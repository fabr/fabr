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
import { readLockfile, readNpmLock, readPnpmLock, readYarnLock } from "./Lockfile";
import { writeProject } from "./TestProject";

const listed = (versions: Map<string, Set<string>>): Record<string, string[]> =>
  Object.fromEntries([...versions].map(([name, held]) => [name, [...held].sort()]));

describe("reading a lockfile", () => {
  it("reads pnpm 9's package keys, after a config dependencies document", () => {
    const text = [
      "---",
      "lockfileVersion: '9.0'",
      "importers:",
      "  .:",
      "    configDependencies: {}",
      "---",
      "lockfileVersion: '9.0'",
      "packages:",
      "  '@scope/a@1.2.3':",
      "    resolution: {integrity: sha512-x}",
      "  b@2.0.0:",
      "    resolution: {integrity: sha512-y}",
      "  b@3.1.0: {}",
      "snapshots:",
      "  b@2.0.0: {}",
    ].join("\n");
    expect(listed(readPnpmLock(text))).to.deep.equal({ "@scope/a": ["1.2.3"], b: ["2.0.0", "3.1.0"] });
  });

  it("reads pnpm 6's keys, peers stripped, and pnpm 5's", () => {
    const text = ["lockfileVersion: '6.0'", "packages:", "  /a@1.0.0(react@18.2.0):", "    dev: false", "  /b/2.0.0:", "    dev: true"].join("\n");
    expect(listed(readPnpmLock(text))).to.deep.equal({ a: ["1.0.0"], b: ["2.0.0"] });
  });

  it("reads yarn classic's entries, an alias by the package it names", () => {
    const text = [
      "# yarn lockfile v1",
      "",
      '"@scope/a@^1.0.0", "@scope/a@^1.2.0":',
      '  version "1.2.5"',
      '  resolved "https://registry.yarnpkg.com/@scope/a/-/a-1.2.5.tgz"',
      "",
      'wrap-ansi-cjs@npm:wrap-ansi@^7.0.0:',
      '  version "7.0.0"',
    ].join("\n");
    expect(listed(readYarnLock(text))).to.deep.equal({ "@scope/a": ["1.2.5"], "wrap-ansi": ["7.0.0"] });
  });

  it("reads yarn berry's resolutions, leaving out workspaces", () => {
    const text = [
      "__metadata:",
      "  version: 8",
      "",
      '"a@npm:^1.0.0":',
      "  version: 1.4.0",
      '  resolution: "a@npm:1.4.0"',
      "",
      '"app@workspace:.":',
      "  version: 0.0.0-use.local",
      '  resolution: "app@workspace:."',
    ].join("\n");
    expect(listed(readYarnLock(text))).to.deep.equal({ a: ["1.4.0"] });
  });

  it("reads npm's packages by install path, leaving out links", () => {
    const text = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "root" },
        "node_modules/a": { version: "1.0.0" },
        "node_modules/b/node_modules/a": { version: "2.0.0" },
        "node_modules/alias": { name: "real", version: "3.0.0" },
        "node_modules/member": { link: true, resolved: "packages/member" },
      },
    });
    expect(listed(readNpmLock(text))).to.deep.equal({ a: ["1.0.0", "2.0.0"], real: ["3.0.0"] });
  });

  it("reads npm 6's nested dependencies", () => {
    const text = JSON.stringify({ lockfileVersion: 1, dependencies: { a: { version: "1.0.0", dependencies: { b: { version: "npm:c@2.0.0" } } } } });
    expect(listed(readNpmLock(text))).to.deep.equal({ a: ["1.0.0"], c: ["2.0.0"] });
  });

  it("finds the project's lockfile, or none", () => {
    expect(readLockfile(writeProject({ "package.json": {} }))).to.equal(undefined);
    expect(readLockfile(writeProject({ "package-lock.json": { packages: {} } }))?.file).to.equal("package-lock.json");
  });
});
