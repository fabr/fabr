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
 */

import { expect } from "chai";
import { derivedFrom, FileSet, MemoryFile } from "@fabr-build/core";
import { conventionalEmit, placement, sourceManifest } from "./Description";
import { parseJSTarget } from "./JSPackage";

describe("placement", () => {
  it("places a file a step produced from a project file beside that file", () => {
    /* The unit's root holds a file of its own, so a directory with no compiled
     * sources would otherwise be placed beneath the root. */
    const resources = new FileSet(new Map([["Styles/app.css", MemoryFile.from("")]])).withStep(
      derivedFrom("./app/src/Styles/app.scss", "sass_compile")
    );
    const place = placement([new FileSet(new Map()), resources], "./app/", ["./app/", "./app/src/"]);
    expect(place("Styles/app.css")).to.equal("src/Styles/app.css");
  });
});

describe("conventionalEmit", () => {
  it("lays a dual package's two formats out as its build does, a bin in the primary format alone", () => {
    const sources = new FileSet(new Map([["index.ts", MemoryFile.from("")], ["bin/tool.ts", MemoryFile.from("")]]));
    const emitted = [...conventionalEmit(sources, parseJSTarget("es2022-dual-node"))].map(([name]) => name).sort();
    expect(emitted).to.deep.equal(["bin/tool.d.ts", "bin/tool.js", "index.d.mts", "index.d.ts", "index.js", "index.mjs"]);
  });
});

describe("sourceManifest", () => {
  it("names the sources a manifest's entry points are emitted from, a wildcard's where they share an extension", () => {
    const manifest = {
      name: "made",
      types: "index.d.ts",
      exports: { ".": { types: "./index.d.ts", default: "./index.js" }, "./*": { types: "./*.d.ts", default: "./*.js" }, "./data.json": "./data.json" },
    };
    expect(sourceManifest(manifest, ["index.ts", "sub.ts", "data.json"])).to.deep.equal({
      name: "made",
      types: "index.ts",
      exports: { ".": { types: "./index.ts", default: "./index.ts" }, "./*": { types: "./*.ts", default: "./*.ts" }, "./data.json": "./data.json" },
    });
    /* Sources of two extensions: no one wildcard names them. */
    expect(sourceManifest({ exports: { "./*": "./*.js" } }, ["a.ts", "b.tsx"])).to.deep.equal({ exports: { "./*": "./*.js" } });
  });
});
