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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { referenceOfEntry, SOURCE_PATHS_FLAG, stagedReferences, withReferencedSources } from "./SourceMap";

describe("withReferencedSources", () => {
  const root = path.resolve("/work");
  const rewrite = (map: object, referenceOf: (staged: string) => string | undefined): Record<string, unknown> =>
    JSON.parse(withReferencedSources(JSON.stringify(map), path.join(root, "build/a/b.js.map"), root, referenceOf)) as Record<string, unknown>;

  it("names a relative entry by the reference its staged path has", () => {
    const map = rewrite({ version: 3, sources: ["../../src/a/b.ts"] }, staged => (staged === "src/a/b.ts" ? "./pkg/src/a/b.ts" : undefined));
    expect(map.sources).to.deep.equal(["fabr:./pkg/src/a/b.ts"]);
  });

  it("resolves through sourceRoot, and drops it", () => {
    const map = rewrite({ version: 3, sourceRoot: "../../src", sources: ["a/b.ts"] }, () => "gen:a/b.ts");
    expect(map.sources).to.deep.equal(["fabr:gen:a/b.ts"]);
    expect(map).to.not.have.property("sourceRoot");
  });

  it("keeps an absolute entry, and a relative one nothing names", () => {
    const map = rewrite({ version: 3, sources: ["fabr:./x.ts", "webpack://lib/./y.js", "../../src/z.ts"] }, () => undefined);
    expect(map.sources).to.deep.equal(["fabr:./x.ts", "webpack://lib/./y.js", "../../src/z.ts"]);
  });
});

describe("referenceOfEntry", () => {
  it("is the reference a fabr entry names, and nothing for any other", () => {
    expect(referenceOfEntry("fabr:./pkg/a.ts")).to.equal("./pkg/a.ts");
    expect(referenceOfEntry("../src/a.ts")).to.equal(undefined);
  });
});

describe("stagedReferences", () => {
  const table = {
    "src/a.ts": "./app/src/a.ts",
    ".fabr-tree/h1/lib/x.js": "@npm:pkg:1.0.0:lib/x.js",
    ".fabr-tree/h2/": "@npm:other:2.0.0:",
    ".fabr-tree/h2/vendor/": "@npm:inner:3.0.0:",
  };
  const named = (withinPackages: boolean): ((staged: string) => string | undefined) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-sourcemap-"));
    fs.writeFileSync(path.join(dir, "paths.json"), JSON.stringify(table));
    const referenceOf = stagedReferences([SOURCE_PATHS_FLAG, "paths.json"], dir, { withinPackages });
    fs.rmSync(dir, { recursive: true, force: true });
    return staged => referenceOf!(staged);
  };

  it("names a listed file by the table, and nothing else", () => {
    expect(named(false)("src/a.ts")).to.equal("./app/src/a.ts");
    expect(named(false)(".fabr-tree/h1/src/x.ts")).to.equal(undefined);
  });

  it("names a file under a listed directory by its prefix, the innermost directory first", () => {
    expect(named(false)(".fabr-tree/h2/lib/y.js")).to.equal("@npm:other:2.0.0:lib/y.js");
    expect(named(false)(".fabr-tree/h2/vendor/z.js")).to.equal("@npm:inner:3.0.0:z.js");
  });

  it("names a file a listed package does not ship by the package, where asked to", () => {
    expect(named(true)(".fabr-tree/h1/src/x.ts")).to.equal("@npm:pkg:1.0.0:src/x.ts");
    /* A project file gives no package. */
    expect(named(true)("src/b.ts")).to.equal(undefined);
  });
});
