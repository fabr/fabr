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
import { importedPackage, importsOf } from "./Imports";

describe("finding a source's imports", () => {
  it("names the package a bare specifier imports", () => {
    expect(importedPackage("lodash/fp")).to.equal("lodash");
    expect(importedPackage("@scope/pkg/sub")).to.equal("@scope/pkg");
    for (const none of ["./a", "../b", "/c", "#internal", "node:fs", "fs", "@/alias", "~/alias"]) {
      expect(importedPackage(none)).to.equal(undefined);
    }
  });

  it("finds imports, requires, dynamic imports and a framework's module calls", () => {
    const text = [
      '/// <reference types="h" />',
      'import a from "a";',
      'import type { B } from "b";',
      'export * from "c";',
      'const d = require("d");',
      'await import("e");',
      'import "f";',
      'jest.mock("g");',
      'vi.importActual("i");',
      'import j = require("j");',
      'type K = import("k").K;',
      'import local from "./local";',
    ].join("\n");
    expect([...importsOf(text, "a.ts")].sort()).to.deep.equal(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"]);
  });

  it("reads JSX, and leaves out comments and strings", () => {
    const text = [
      'import React from "react";',
      '// import x from "commented";',
      '/* require("blocked") */',
      'const text = `import y from "templated"`;',
      'const s = "require(\'quoted\')";',
      'export const App = () => <div>{s}</div>;',
    ].join("\n");
    expect([...importsOf(text, "App.tsx")]).to.deep.equal(["react"]);
  });

  it("reads a file with type errors, and past a statement that doesn't parse", () => {
    const text = ['import a from "a";', "const n: number = 'not a number';", "const broken = ;", 'import b from "b";'].join("\n");
    expect([...importsOf(text, "a.ts")].sort()).to.deep.equal(["a", "b"]);
  });

  it("leaves out what the caller says is local", () => {
    expect([...importsOf('import x from "Models/User"; import y from "y";', "a.ts", specifier => specifier.startsWith("Models"))]).to.deep.equal(["y"]);
  });
});
