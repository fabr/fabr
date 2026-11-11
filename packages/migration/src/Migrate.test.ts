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
import * as path from "path";
import { migrate } from "./Migrate";
import { writeProject } from "./TestProject";

const options = { pins: false, cacheRoot: "", progress: () => undefined };

describe("migrating a project", () => {
  it("writes each file that is missing, and leaves one that exists as it is", async () => {
    const root = writeProject({
      "package.json": { workspaces: ["p/*"], devDependencies: { "@types/node": "^20.0.0" } },
      "p/a/package.json": { name: "a", dependencies: { lodash: "^4.0.0" } },
      "p/a/src/index.ts": "",
    });
    const first = await migrate(root, options);
    expect(
      fs
        .readdirSync(root)
        .filter(name => name.endsWith(".fabr"))
        .sort()
    ).to.deep.equal(["CATALOG.fabr", "PROJECT.fabr"]);
    expect(first.render().join("\n")).to.include("a: @types/node (ambient types)");

    fs.writeFileSync(path.join(root, "CATALOG.fabr"), "# mine\n");
    const second = (await migrate(root, options)).render().join("\n");
    expect(fs.readFileSync(path.join(root, "CATALOG.fabr"), "utf8")).to.equal("# mine\n");
    expect(second).to.include("CATALOG.fabr\n  PROJECT.fabr\n  p/a/BUILD.fabr");
    expect(second).to.not.include("ambient types");
  });
});
