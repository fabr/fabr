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
import { BuildAction, Computable, FileSet, Flag, MemoryFile, Property, RunnableFileSet, TargetContext } from "@fabr-build/core";
import { jsCompileRule, jsxModeFor, makeTsConfig } from "./BuildJSCompile";
import { parseJSTarget } from "../JSPackage";

function toPromise<T>(computable: Computable<T>): Promise<T> {
  return new Promise((resolve, reject) => computable.then(resolve, reject));
}

/** A minimal TargetContext serving just what js_compile's evaluate reads, so the
 * rule can be driven to the tsconfig it generates. `deps` carries the source-mode
 * flags (read via getFlags) exactly as it does in a real build. */
function stubContext(flags: Flag[], packageName?: string): TargetContext {
  /* The one tool the rule mounts, answering with the argv its install would
   * launch. An empty install: the rule mounts it as a FileSet, so the stub has
   * to be a real one — only the argv is under test here. */
  const tool = (argv: string[]): RunnableFileSet =>
    Object.assign(new FileSet(new Map()), { toCommandLine: () => argv }) as unknown as RunnableFileSet;
  const tools: Record<string, RunnableFileSet> = {
    TSC_DRIVER: tool(["node", ".tools/tsc/tscDriver/tsc-driver.js"]),
  };
  return {
    getFileSetProperties: () =>
      Computable.resolve({ srcs: [new FileSet(new Map([["a.ts", MemoryFile.from("export const x = 1;")]]))], deps: [] }),
    getGlobalString: (name: string) =>
      Computable.resolve(name === "JS_TARGET" ? "es2021-commonjs" : "debug"),
    getGlobalRunnable: (name: string) => Computable.resolve(tools[name]),
    getFlags: () => Computable.resolve(flags),
    getProperty: () => Computable.resolve(packageName === undefined ? undefined : new Property([packageName])),
    /* Nothing reaches the store here (the stub declares no package deps), so a
     * cache that only knows where its store would be is enough. */
    execution: { buildCache: { storePath: "/store" } },
  } as unknown as TargetContext;
}

/** Drive the rule and answer the action it yielded. */
async function compileAction(): Promise<BuildAction> {
  const result = await toPromise(jsCompileRule.evaluate(stubContext([])));
  expect(result).to.be.instanceOf(BuildAction);
  return result as BuildAction;
}

/** Drive the rule and read back the tsconfig.json it stages into the action. */
async function generatedTsConfig(flags: Flag[], packageName?: string): Promise<TsConfig> {
  const result = await toPromise(jsCompileRule.evaluate(stubContext(flags, packageName)));
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
    baseUrl?: string;
    paths?: Record<string, string[]>;
    useDefineForClassFields?: boolean;
    resolveJsonModule?: boolean;
    esModuleInterop?: boolean;
    sourceMap?: boolean;
    inlineSources?: boolean;
    declaration?: boolean;
    declarationMap?: boolean;
    target?: string;
    lib?: string[];
    downlevelIteration?: boolean;
    experimentalDecorators?: boolean;
    emitDecoratorMetadata?: boolean;
  };
  include: string[];
}

describe("makeTsConfig", () => {
  it("states no moduleResolution, which only the driver can choose", () => {
    /* The right value depends on the compiler version — before TypeScript 6 a
     * CommonJS emit cannot pair with `bundler`, and from 6 `node10` is an
     * error — and the version is known only to the driver that loads it.
     * Re-stating one here compiles today and fails on whichever release the
     * project pins tomorrow. */
    for (const target of ["es2018-commonjs", "es2020-esm", "es2020-esm-browser"]) {
      const cfg = makeTsConfig(parseJSTarget(target)) as unknown as TsConfig;
      expect(cfg.compilerOptions, target).to.not.have.property("moduleResolution");
    }
  });

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

  /* The `dom` lib follows the SOURCE flag, not the emit target: whether a tree
   * uses the DOM is invariant across every build of it, while what it is emitted
   * for is the consumer's choice. A browser bundle of DOM-free sources gets no
   * dom lib, and node-emitted sources that use it do. */
  it("adds the dom lib when the sources declare it, not when the target is browser", () => {
    const browserNoDom = makeTsConfig(parseJSTarget("es2020-esm-browser")) as unknown as TsConfig;
    expect(browserNoDom.compilerOptions.lib).to.deep.equal(["es2020"]);

    const nodeWithDom = makeTsConfig(parseJSTarget("es2020-commonjs-node"), undefined, {}, undefined, undefined, undefined, true) as unknown as TsConfig;
    expect(nodeWithDom.compilerOptions.lib).to.deep.equal(["es2020", "dom"]);
  });

  it("emits the real iteration protocol below es2015", () => {
    /* tsc's default there is an index loop, which only works for arrays: a
     * Map/Set/generator is a compile error and a string is mis-iterated by
     * UTF-16 code unit. Derived from the target — no source wants that emit. */
    expect((makeTsConfig(parseJSTarget("es5-commonjs")) as unknown as TsConfig).compilerOptions.downlevelIteration).to.equal(true);
  });

  it("leaves downlevelIteration alone from es2015 up, es6 included", () => {
    /* es6 IS es2015 to tsc — the option would be inert there, and its presence
     * would say the emit is a downlevel one when it isn't. */
    for (const target of ["es6-commonjs", "es2015-commonjs", "es2021-esm"]) {
      expect((makeTsConfig(parseJSTarget(target)) as unknown as TsConfig).compilerOptions.downlevelIteration).to.equal(undefined);
    }
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

  it("lets ts/no_es_module_interop restore classic CJS interop via the overlay", () => {
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

describe("js_compile source ES level (es<level> flag)", () => {
  it("uses the declared source level as lib, independent of the emit target", async () => {
    /* lib is what the SOURCE may use; target is what is emitted. A target
     * declaring es2023 sources gets es2023 typings while still emitting es2021. */
    const cfg = await generatedTsConfig([new Flag("es2023", [])]);
    expect(cfg.compilerOptions.lib).to.deep.equal(["es2023"]);
    expect(cfg.compilerOptions.target).to.equal("es2021");
  });

  it("takes the highest level when several are declared", async () => {
    const cfg = await generatedTsConfig([new Flag("es2018", []), new Flag("es2022", [])]);
    expect(cfg.compilerOptions.lib).to.deep.equal(["es2022"]);
  });

  it("follows the emit target when no level is declared", async () => {
    const cfg = await generatedTsConfig([]);
    expect(cfg.compilerOptions.lib).to.deep.equal(["es2021"]);
    expect(cfg.compilerOptions.useDefineForClassFields).to.equal(undefined);
  });
});

describe("js_compile package self-reference", () => {
  it("maps the package's own name onto its sources when package_name is given", async () => {
    /* A source importing '@scope/pkg/sub' is importing THIS tree — which node
     * gives an installed package for free, but a tree being compiled has to be
     * told. Both the bare name and the subpath form map. */
    const cfg = await generatedTsConfig([], "@scope/pkg");
    expect(cfg.compilerOptions.paths).to.deep.equal({ "@scope/pkg": ["./src/index"], "@scope/pkg/*": ["./src/*"] });
  });

  it("sets no baseUrl, so bare root-relative imports stay unresolvable", async () => {
    /* baseUrl would additionally make `from "lib/thing"` resolve against the
     * source root — imports that work in the compile and fail at runtime. */
    const cfg = await generatedTsConfig([], "@scope/pkg");
    expect(cfg.compilerOptions.baseUrl).to.equal(undefined);
  });

  it("emits no paths at all for a target with no package identity", async () => {
    const cfg = await generatedTsConfig([]);
    expect(cfg.compilerOptions.paths).to.equal(undefined);
  });
});

describe("js_compile source-mode flags (through deps)", () => {
  it("recognizes a ts/no_strict flag carried in deps and relaxes the tsconfig", async () => {
    /* End-to-end wiring: the flag rides `deps`, js_compile reads it with
     * getFlags("deps") and folds the recognized overlay into the tsconfig it
     * stages — the path that replaced the old caller-resolved `mode` JSON. */
    const cfg = await generatedTsConfig([new Flag("ts/no_strict", [])]);
    expect(cfg.compilerOptions.strict).to.equal(false);
  });

  it("leaves the tsconfig strict when deps carry no source-mode flag", async () => {
    const cfg = await generatedTsConfig([]);
    expect(cfg.compilerOptions.strict).to.equal(true);
  });
});

describe("js_compile toolchain", () => {
  /* The regression this pins: the compiler's own `tsc` bin cannot be told where
   * packages are, so exec'ing it against a manifest layout resolved nothing —
   * every `types` entry unfound. What runs is always fabr's driver, over
   * whatever release ${TYPESCRIPT} pins. */
  it("execs the driver, never the pinned compiler's own bin", async () => {
    const argv = (await compileAction()).options.argv as string[];
    expect(argv).to.deep.equal(["node", ".tools/tsc/tscDriver/tsc-driver.js"]);
  });

});
