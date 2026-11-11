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
import * as path from "path";
import { importsLocalFile, readTsconfig } from "./Tsconfig";
import { writeProject } from "./TestProject";

describe("reading a tsconfig", () => {
  it("reads comments and trailing commas, never inside a string", () => {
    const root = writeProject({
      "tsconfig.json":
        '{ "compilerOptions": { "baseUrl": ".", // note\n /* block */ "paths": { "a,]/*": ["b,}/*", "c/*d*/e",], }, }, }',
    });
    const options = readTsconfig(path.join(root, "tsconfig.json"))!;
    expect(options.paths.get("a,]/*")).to.deep.equal([path.join(root, "b,}/*"), path.join(root, "c/*d*/e")]);
  });

  it("inherits options through a relative extends", () => {
    const root = writeProject({
      "tsconfig.base.json": '{ "compilerOptions": { "types": ["node"], "baseUrl": "." } }',
      "pkg/tsconfig.json": '{ "extends": "../tsconfig.base.json", "compilerOptions": { "paths": { "@lib/*": ["lib/*"] } } }',
    });
    const options = readTsconfig(path.join(root, "pkg/tsconfig.json"))!;
    expect(options.types).to.deep.equal(["node"]);
    expect(options.baseUrl).to.equal(root);
    expect(options.paths.get("@lib/*")).to.deep.equal([path.join(root, "lib/*")]);
  });

  it("says whether an import names the project's own file through baseUrl or paths", () => {
    const root = writeProject({ "src/Models/User.ts": "", "src/lib/a.ts": "", "node_modules/yjs/index.js": "" });
    const options = {
      baseUrl: path.join(root, "src"),
      paths: new Map([
        ["~lib/*", [path.join(root, "src/lib/*")]],
        ["yjs", [path.join(root, "node_modules/yjs")]],
      ]),
    };
    expect(importsLocalFile("Models/User", options)).to.equal(true);
    expect(importsLocalFile("~lib/a", options)).to.equal(true);
    expect(importsLocalFile("yjs", options)).to.equal(false);
    expect(importsLocalFile("react", options)).to.equal(false);
  });
});
