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
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { registeredDocuments, updateRegistry } from "./Registry";

describe("registry updates", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-registry-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("rewrites the documents the registry lists through a change, under a lock it then releases", () => {
    const file = path.join(dir, "registry.json");
    updateRegistry(file, names => [...names, "/a.json"]);
    updateRegistry(file, names => [...names, "/b.json"]);
    expect(registeredDocuments(file)).to.deep.equal(["/a.json", "/b.json"]);
    expect(fs.existsSync(`${file}.lock`)).to.equal(false);
  });

  it("takes a lock left by a writer long gone as abandoned", () => {
    const file = path.join(dir, "registry.json");
    fs.writeFileSync(`${file}.lock`, "");
    const long = (Date.now() - 60_000) / 1000;
    fs.utimesSync(`${file}.lock`, long, long);
    updateRegistry(file, () => ["/a.json"]);
    expect(registeredDocuments(file)).to.deep.equal(["/a.json"]);
    expect(fs.existsSync(`${file}.lock`)).to.equal(false);
  });
});
