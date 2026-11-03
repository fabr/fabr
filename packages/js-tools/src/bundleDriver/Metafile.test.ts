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
import { renameMetafilePaths } from "./Metafile";

describe("renameMetafilePaths", () => {
  const names = new Map([
    ["src/index.js", "./app/src/index.tsx"],
    ["src/Route.js", "./app/src/Route.tsx"],
    ["../.fabr-tree/aa/index.js", "@npm:ms:2.1.3:index.js"],
    ["../.fabr-tree/__virtual__/1/0/aa/index.js", "@npm:ms:2.1.3:index.js"],
  ]);
  const inputName = (staged: string): string => names.get(staged) ?? staged;

  it("names inputs by reference and outputs relative to the output directory", () => {
    const renamed = renameMetafilePaths(
      {
        inputs: {
          "src/index.js": { bytes: 10, imports: [{ path: "src/Route.js", kind: "dynamic-import" }, { path: "react", kind: "import-statement", external: true }] },
          "src/Route.js": { bytes: 5, imports: [] },
        },
        outputs: {
          "bundle-out/index.js": {
            bytes: 20,
            entryPoint: "src/index.js",
            inputs: { "src/index.js": { bytesInOutput: 9 } },
            imports: [{ path: "bundle-out/chunks/Route-AB12.js", kind: "dynamic-import" }],
            cssBundle: "bundle-out/index.css",
          },
          "bundle-out/chunks/Route-AB12.js": { bytes: 6, entryPoint: "src/Route.js", inputs: { "src/Route.js": { bytesInOutput: 5 } }, imports: [] },
        },
      },
      "bundle-out",
      inputName
    );
    expect(Object.keys(renamed.inputs)).to.deep.equal(["./app/src/index.tsx", "./app/src/Route.tsx"]);
    expect(renamed.inputs["./app/src/index.tsx"].imports).to.deep.equal([
      { path: "./app/src/Route.tsx", kind: "dynamic-import" },
      { path: "react", kind: "import-statement", external: true },
    ]);
    expect(Object.keys(renamed.outputs)).to.deep.equal(["index.js", "chunks/Route-AB12.js"]);
    const entry = renamed.outputs["index.js"];
    expect([entry.entryPoint, entry.cssBundle]).to.deep.equal(["./app/src/index.tsx", "index.css"]);
    expect(entry.imports).to.deep.equal([{ path: "chunks/Route-AB12.js", kind: "dynamic-import" }]);
    expect(Object.keys(entry.inputs ?? {})).to.deep.equal(["./app/src/index.tsx"]);
  });

  it("makes two wirings of one file one input, summing what each put in an output", () => {
    const renamed = renameMetafilePaths(
      {
        inputs: { "../.fabr-tree/aa/index.js": { bytes: 3 }, "../.fabr-tree/__virtual__/1/0/aa/index.js": { bytes: 3 } },
        outputs: {
          "out/a.js": { inputs: { "../.fabr-tree/aa/index.js": { bytesInOutput: 2 }, "../.fabr-tree/__virtual__/1/0/aa/index.js": { bytesInOutput: 2 } } },
        },
      },
      "out",
      inputName
    );
    expect(Object.keys(renamed.inputs)).to.deep.equal(["@npm:ms:2.1.3:index.js"]);
    expect(renamed.outputs["a.js"].inputs).to.deep.equal({ "@npm:ms:2.1.3:index.js": { bytesInOutput: 4 } });
  });
});
