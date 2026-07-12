/*
 * Copyright (c) 2022 Nathan Keynes <nkeynes@deadcoderemoval.net>
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
import { jsxModeFor, makeTsConfig } from "./BuildJSCompile";
import { parseJSTarget } from "../JSPackage";

interface TsConfig {
  compilerOptions: { jsx?: string; jsxImportSource?: string; allowJs?: boolean; checkJs?: boolean };
  include: string[];
}

describe("makeTsConfig", () => {
  it("includes .tsx so a .tsx source isn't silently ignored", () => {
    const cfg = makeTsConfig(parseJSTarget("es2018-commonjs"), "es2018") as unknown as TsConfig;
    /* `.tsx` must be in `include` — a `.ts`-only glob never matches it, so a .tsx
     * source was silently ignored and the package built green with it missing. */
    expect(cfg.include).to.include("./src/**/*.tsx");
    expect(cfg.include).to.include("./src/**/*.ts");
  });

  it("includes .js/.jsx and enables allowJs (downlevel JS, importable from TS) without checkJs", () => {
    const cfg = makeTsConfig(parseJSTarget("es2018-commonjs"), "es2018") as unknown as TsConfig;
    expect(cfg.include).to.include("./src/**/*.js");
    expect(cfg.include).to.include("./src/**/*.jsx");
    /* allowJs routes .js through tsc's emit (downlevel to target); checkJs stays
     * off so untyped JS is transpiled, not typechecked, and can't fail the build. */
    expect(cfg.compilerOptions.allowJs).to.equal(true);
    expect(cfg.compilerOptions.checkJs).to.equal(false);
  });

  it("emits the jsx transform + import source when a runtime is given", () => {
    const cfg = makeTsConfig(parseJSTarget("es2018-commonjs"), "es2018", {
      mode: "react-jsxdev",
      importSource: "preact",
    }) as unknown as TsConfig;
    expect(cfg.compilerOptions.jsx).to.equal("react-jsxdev");
    expect(cfg.compilerOptions.jsxImportSource).to.equal("preact");
  });

  it("emits no jsx option when there's no runtime (JSX-free compile)", () => {
    const cfg = makeTsConfig(parseJSTarget("es2018-commonjs"), "es2018") as unknown as TsConfig;
    expect(cfg.compilerOptions.jsx).to.equal(undefined);
    expect(cfg.compilerOptions.jsxImportSource).to.equal(undefined);
  });
});

describe("jsxModeFor", () => {
  it("uses the dev runtime for a debug build, production otherwise", () => {
    expect(jsxModeFor("debug")).to.equal("react-jsxdev");
    expect(jsxModeFor("release")).to.equal("react-jsx");
    expect(jsxModeFor(undefined)).to.equal("react-jsx");
  });
});
