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
import { BuildAction, Computable, FileSet, Flag, MemoryFile, RunnableFileSet, TargetContext } from "@fabr-build/core";
import { jsCompileRule, jsxModeFor, makeTsConfig } from "./BuildJSCompile";
import { parseJSTarget } from "../JSPackage";

function toPromise<T>(computable: Computable<T>): Promise<T> {
  return new Promise((resolve, reject) => computable.then(resolve, reject));
}

/** A minimal TargetContext serving just what js_compile's evaluate reads, so the
 * rule can be driven to the tsconfig it generates. `deps` carries the source-mode
 * flags (read via getFlags) exactly as it does in a real build. */
function stubContext(flags: Flag[]): TargetContext {
  const tsc = { toCommandLine: () => ["node", "tsc"] } as unknown as RunnableFileSet;
  return {
    getFileSetProperties: () =>
      Computable.resolve({ srcs: [new FileSet(new Map([["a.ts", MemoryFile.from("export const x = 1;")]]))], deps: [] }),
    getGlobalString: (name: string) => Computable.resolve(name === "JS_TARGET" ? "es2021-commonjs" : "debug"),
    getGlobalRunnable: () => Computable.resolve(tsc),
    getFlags: () => Computable.resolve(flags),
  } as unknown as TargetContext;
}

/** Drive the rule and read back the tsconfig.json it stages into the action. */
async function generatedTsConfig(flags: Flag[]): Promise<TsConfig> {
  const result = await toPromise(jsCompileRule.evaluate(stubContext(flags)));
  expect(result).to.be.instanceOf(BuildAction);
  const files = (result as BuildAction).inputs.files as FileSet;
  const file = await toPromise(files.get("tsconfig.json"));
  return JSON.parse(await toPromise(file!.readString())) as TsConfig;
}

interface TsConfig {
  compilerOptions: {
    jsx?: string;
    jsxImportSource?: string;
    allowJs?: boolean;
    checkJs?: boolean;
    strict?: boolean;
    noImplicitAny?: boolean;
    skipLibCheck?: boolean;
    resolveJsonModule?: boolean;
    esModuleInterop?: boolean;
    sourceMap?: boolean;
    inlineSources?: boolean;
    declaration?: boolean;
    declarationMap?: boolean;
    target?: string;
    lib?: string[];
  };
  include: string[];
}

describe("makeTsConfig", () => {
  it("includes .tsx so a .tsx source isn't silently ignored", () => {
    const cfg = makeTsConfig(parseJSTarget("es2018-commonjs")) as unknown as TsConfig;
    /* `.tsx` must be in `include` — a `.ts`-only glob never matches it, so a .tsx
     * source was silently ignored and the package built green with it missing. */
    expect(cfg.include).to.include("./src/**/*.tsx");
    expect(cfg.include).to.include("./src/**/*.ts");
  });

  it("includes .js/.jsx and enables allowJs (downlevel JS, importable from TS) without checkJs", () => {
    const cfg = makeTsConfig(parseJSTarget("es2018-commonjs")) as unknown as TsConfig;
    expect(cfg.include).to.include("./src/**/*.js");
    expect(cfg.include).to.include("./src/**/*.jsx");
    /* allowJs routes .js through tsc's emit (downlevel to target); checkJs stays
     * off so untyped JS is transpiled, not typechecked, and can't fail the build. */
    expect(cfg.compilerOptions.allowJs).to.equal(true);
    expect(cfg.compilerOptions.checkJs).to.equal(false);
  });

  it("emits the jsx transform + import source when a runtime is given", () => {
    const cfg = makeTsConfig(parseJSTarget("es2018-commonjs"), {
      mode: "react-jsxdev",
      importSource: "preact",
    }) as unknown as TsConfig;
    expect(cfg.compilerOptions.jsx).to.equal("react-jsxdev");
    expect(cfg.compilerOptions.jsxImportSource).to.equal("preact");
  });

  it("emits no jsx option when there's no runtime (JSX-free compile)", () => {
    const cfg = makeTsConfig(parseJSTarget("es2018-commonjs")) as unknown as TsConfig;
    expect(cfg.compilerOptions.jsx).to.equal(undefined);
    expect(cfg.compilerOptions.jsxImportSource).to.equal(undefined);
  });

  it("derives lib from the target version (node env: no dom lib)", () => {
    const cfg = makeTsConfig(parseJSTarget("es2018-commonjs")) as unknown as TsConfig;
    expect(cfg.compilerOptions.target).to.equal("es2018");
    expect(cfg.compilerOptions.lib).to.deep.equal(["es2018"]);
  });

  it("adds the dom lib for a browser target", () => {
    const cfg = makeTsConfig(parseJSTarget("es2020-esm-browser")) as unknown as TsConfig;
    expect(cfg.compilerOptions.lib).to.deep.equal(["es2020", "dom"]);
  });

  it("is strict by default", () => {
    const cfg = makeTsConfig(parseJSTarget("es2018-commonjs")) as unknown as TsConfig;
    expect(cfg.compilerOptions.strict).to.equal(true);
  });

  it("lets a source-mode overlay override the strict defaults", () => {
    const cfg = makeTsConfig(parseJSTarget("es2018-commonjs"), undefined, {
      strict: false,
      noImplicitAny: false,
    }) as unknown as TsConfig;
    expect(cfg.compilerOptions.strict).to.equal(false);
    expect(cfg.compilerOptions.noImplicitAny).to.equal(false);
  });

  it("enables the ecosystem-baseline options", () => {
    const cfg = makeTsConfig(parseJSTarget("es2018-commonjs")) as unknown as TsConfig;
    expect(cfg.compilerOptions.skipLibCheck).to.equal(true);
    expect(cfg.compilerOptions.resolveJsonModule).to.equal(true);
    expect(cfg.compilerOptions.esModuleInterop).to.equal(true);
  });

  it("lets ts/no_esmodule_interop restore classic CJS interop via the overlay", () => {
    const cfg = makeTsConfig(parseJSTarget("es2018-commonjs"), undefined, {
      esModuleInterop: false,
    }) as unknown as TsConfig;
    expect(cfg.compilerOptions.esModuleInterop).to.equal(false);
  });

  it("emits self-contained JS source maps for debug and relwithdebinfo, not release", () => {
    const cfg = (bt?: string): TsConfig =>
      makeTsConfig(parseJSTarget("es2018-commonjs"), undefined, {}, bt) as unknown as TsConfig;
    /* debug/relwithdebinfo: sourceMap + inlineSources (the source is embedded in
     * the map, so it's debuggable without shipping a src/ tree). */
    for (const bt of ["debug", "relwithdebinfo"]) {
      expect(cfg(bt).compilerOptions.sourceMap).to.equal(true);
      expect(cfg(bt).compilerOptions.inlineSources).to.equal(true);
    }
    expect(cfg("release").compilerOptions.sourceMap).to.equal(undefined);
    expect(cfg("release").compilerOptions.inlineSources).to.equal(undefined);
  });

  it("ships declarations but never a declaration map (it would dangle without a src/ tree)", () => {
    const cfg = (bt?: string): TsConfig =>
      makeTsConfig(parseJSTarget("es2018-commonjs"), undefined, {}, bt) as unknown as TsConfig;
    for (const bt of ["debug", "relwithdebinfo", "release", undefined]) {
      expect(cfg(bt).compilerOptions.declaration).to.equal(true);
      expect(cfg(bt).compilerOptions.declarationMap).to.equal(undefined);
    }
  });
});

describe("jsxModeFor", () => {
  it("uses the dev runtime for a debug build, production otherwise", () => {
    expect(jsxModeFor("debug")).to.equal("react-jsxdev");
    expect(jsxModeFor("release")).to.equal("react-jsx");
    expect(jsxModeFor(undefined)).to.equal("react-jsx");
  });
});

describe("js_compile source-mode flags (through deps)", () => {
  it("recognizes a ts/nostrict flag carried in deps and relaxes the tsconfig", async () => {
    /* End-to-end wiring: the flag rides `deps`, js_compile reads it with
     * getFlags("deps") and folds the recognized overlay into the tsconfig it
     * stages — the path that replaced the old caller-resolved `mode` JSON. */
    const cfg = await generatedTsConfig([new Flag("ts/nostrict", [])]);
    expect(cfg.compilerOptions.strict).to.equal(false);
  });

  it("leaves the tsconfig strict when deps carry no source-mode flag", async () => {
    const cfg = await generatedTsConfig([]);
    expect(cfg.compilerOptions.strict).to.equal(true);
  });
});
