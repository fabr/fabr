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
import {
  Computable,
  ConflictError,
  FileSet,
  Flag,
  IFile,
  MemoryFile,
  PackageFileSet,
  PackageGraphBuilder,
  SymlinkFile,
} from "@fabr-build/core";
import {
  binByConvention,
  binOf,
  canonicalEsLevel,
  classifySourceByExt,
  classifySources,
  compileInputs,
  dualFormatOutputs,
  esLevelOrder,
  hasPackageExport,
  makeNpmRunnable,
  parseJSTarget,
  passthroughFiles,
  resolveJsxImportSource,
  resolveSourceMode,
  resolveSourceVersion,
  usesDom,
  usesNodeGlobals,
  withBinShebangs,
} from "./JSPackage";

/** Snapshot a FileSet's entries into a plain map for synchronous inspection. */
function entries(set: FileSet): Map<string, IFile> {
  return new Map(set);
}

/** A package that provides (or not) the JSX runtime — the map publishing the
 * subpath AND the file it names, since providing it takes both. */
function jsxPkg(name: string, providesJsxRuntime: boolean): PackageFileSet {
  const json = JSON.stringify({
    name,
    exports: providesJsxRuntime ? { ".": "./index.js", "./jsx-runtime": "./jsx-runtime.js" } : { ".": "./index.js" },
  });
  const files: Array<[string, IFile]> = [["package.json", MemoryFile.from(json)], ["index.js", MemoryFile.from("")]];
  if (providesJsxRuntime) {
    files.push(["jsx-runtime.js", MemoryFile.from("")]);
  }
  return new PackageFileSet(new Map<string, IFile>(files), name);
}

function settle<T>(c: Computable<T>): Promise<T> {
  return new Promise((resolve, reject) => c.then(resolve, reject));
}
async function rejectionMessage<T>(c: Computable<T>): Promise<string> {
  try {
    await settle(c);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a rejection");
}

describe("hasPackageExport", () => {
  /** A package with the given manifest, holding `files` (empty content — only
   * their presence is ever asked about). */
  const pkg = (manifest: string, ...files: string[]): PackageFileSet =>
    new PackageFileSet(
      new Map<string, IFile>([
        ["package.json", MemoryFile.from(manifest)],
        ...files.map((name): [string, IFile] => [name, MemoryFile.from("")]),
      ]),
      "probe"
    );

  it("detects a declared subpath whose file the package holds", async () => {
    const react = pkg(JSON.stringify({ exports: { ".": "./index.js", "./jsx-runtime": "./jsx-runtime.js" } }), "jsx-runtime.js");
    expect(await settle(hasPackageExport(react, "./jsx-runtime"))).to.equal(true);
    expect(await settle(hasPackageExport(react, "./missing"))).to.equal(false);
  });

  it("resolves the subpath as a consumer would, not as a literal key", async () => {
    /* A package that publishes the subpath through a pattern exposes it just as
       much as one that names it outright — the consumer's import is identical. */
    const patterned = pkg(JSON.stringify({ exports: { "./*": "./src/*.js" } }), "src/jsx-runtime.js");
    expect(await settle(hasPackageExport(patterned, "./jsx-runtime"))).to.equal(true);
    /* And a hole punched in that pattern closes it again. */
    const blocked = pkg(JSON.stringify({ exports: { "./jsx-runtime": null, "./*": "./src/*.js" } }), "src/jsx-runtime.js");
    expect(await settle(hasPackageExport(blocked, "./jsx-runtime"))).to.equal(false);
  });

  it("is not answered by a catch-all pattern that lands on nothing", async () => {
    /* markdown-it's map, and the fortawesome icon packs'. A wildcard says a
       subpath maps SOMEWHERE, not that anything is there — read as a capability
       it would claim the package provides a JSX runtime, a JSON parser, and
       whatever else one thought to ask for. It published 16 targets' worth of
       "multiple JSX runtimes" before the file was looked for. */
    const catchAll = pkg(JSON.stringify({ exports: { ".": "./index.js", "./*": { require: "./*", import: "./*" } } }), "index.js", "lib/token.js");
    expect(await settle(hasPackageExport(catchAll, "./jsx-runtime"))).to.equal(false);
    /* The same map still answers for what the package really holds. */
    expect(await settle(hasPackageExport(catchAll, "./lib/token.js"))).to.equal(true);
  });

  it("answers no when the map publishes a file the package does not hold", async () => {
    const missing = pkg(JSON.stringify({ exports: { "./jsx-runtime": "./jsx-runtime.js" } }));
    expect(await settle(hasPackageExport(missing, "./jsx-runtime"))).to.equal(false);
  });

  it("answers no without an exports map, or for an unreadable manifest", async () => {
    /* A question *about a dependency*: a manifest fabr can't read exposes no
       subpath — whoever builds that dependency is the one to report it. */
    expect(await settle(hasPackageExport(pkg(JSON.stringify({ main: "index.js" }), "jsx-runtime.js"), "./jsx-runtime"))).to.equal(false);
    expect(await settle(hasPackageExport(pkg(JSON.stringify({ exports: "./index.js" }), "jsx-runtime.js"), "./jsx-runtime"))).to.equal(false);
    expect(await settle(hasPackageExport(pkg("not json"), "./jsx-runtime"))).to.equal(false);
    expect(await settle(hasPackageExport(pkg("[]"), "./jsx-runtime"))).to.equal(false);
  });
});

describe("resolveJsxImportSource", () => {
  const react = jsxPkg("react", true);
  const preact = jsxPkg("preact", true);
  const lodash = jsxPkg("lodash", false);
  /* Has the jsx-runtime export, but @types never names the runtime. */
  const reactTypes = jsxPkg("@types/react", true);

  it("names the runtime package (from package.json exports './jsx-runtime')", async () => {
    expect(await settle(resolveJsxImportSource([react]))).to.equal("react");
    expect(await settle(resolveJsxImportSource([preact]))).to.equal("preact");
  });

  it("picks the first provider in dependency order, skipping non-runtimes", async () => {
    expect(await settle(resolveJsxImportSource([lodash, react]))).to.equal("react");
  });

  it("never treats a @types package as the runtime", async () => {
    expect(await settle(resolveJsxImportSource([reactTypes, react]))).to.equal("react");
    expect(await rejectionMessage(resolveJsxImportSource([reactTypes]))).to.match(/No JSX runtime/);
  });

  it("errors when no dependency provides a JSX runtime", async () => {
    expect(await rejectionMessage(resolveJsxImportSource([lodash]))).to.match(/No JSX runtime specified in dependencies/);
  });

  it("errors when several dependencies provide one (ambiguous)", async () => {
    expect(await rejectionMessage(resolveJsxImportSource([react, preact]))).to.match(/Multiple JSX runtimes.*react.*preact/);
  });
});

describe("parseJSTarget", () => {
  it("parses valid triples into version/module/environment", () => {
    expect(parseJSTarget("es2018-commonjs")).to.deep.equal({ version: "es2018", module: "commonjs", environment: "node" });
    expect(parseJSTarget("es2021-esm")).to.deep.equal({ version: "es2021", module: "esm", environment: "node" });
    expect(parseJSTarget("esnext-esm-browser")).to.deep.equal({ version: "esnext", module: "esm", environment: "browser" });
    expect(parseJSTarget("es2020")).to.deep.equal({ version: "es2020", module: "commonjs", environment: "node" });
  });

  it("rejects a malformed triple rather than silently mis-parsing it to the defaults", () => {
    /* 'browser' in the module slot — the old parser silently produced commonjs/node. */
    expect(() => parseJSTarget("es2020-browser")).to.throw(/module must be/);
    expect(() => parseJSTarget("es2018-esmm")).to.throw(/module must be/);
    expect(() => parseJSTarget("es2018-esm-nodejs")).to.throw(/environment must be/);
    expect(() => parseJSTarget("es2018-esm-node-extra")).to.throw(/expected/);
    expect(() => parseJSTarget("es20x8-esm")).to.throw(/ECMAScript version/);
  });
});

describe("dualFormatOutputs", () => {
  /** The two compiles of a dual package: the same names emitted twice, plus
   *  whatever each format alone produces. */
  const compiled = (...names: string[]): FileSet => new FileSet(new Map(names.map(name => [name, MemoryFile.from("")])));
  const partition = (commonjs: string[], esm: string[]): string[][] =>
    dualFormatOutputs(compiled(...commonjs), compiled(...esm)).map(format => [...format].map(([name]) => name).sort());

  it("takes the .mjs family from the ES-module compile and everything else from the CommonJS one", () => {
    const [primary, secondary] = partition(
      ["index.js", "index.d.ts", "index.js.map", "index.mjs", "index.d.mts"],
      ["index.js", "index.d.ts", "index.mjs", "index.d.mts", "index.mjs.map"]
    );
    expect(primary).to.deep.equal(["index.d.ts", "index.js", "index.js.map"]);
    expect(secondary).to.deep.equal(["index.d.mts", "index.mjs", "index.mjs.map"]);
  });

  it("keeps a format-pinned source's output from the compile whose format it pinned", () => {
    /* `.mts`/`.cts` emit under their own names from BOTH compiles; only the one
     * whose module setting agrees with the pin has the right syntax — and the
     * right sibling specifiers. */
    const [primary, secondary] = partition(["legacy.cjs", "legacy.d.cts", "modern.mjs"], ["legacy.cjs", "modern.mjs", "modern.d.mts"]);
    expect(primary).to.deep.equal(["legacy.cjs", "legacy.d.cts"]);
    expect(secondary).to.deep.equal(["modern.d.mts", "modern.mjs"]);
  });

  it("drops the ES-module copy of a bin the CommonJS format delivers", () => {
    /* A bin is the package as a program: one format, no condition to select on. */
    const [primary, secondary] = partition(["bin/tool.js", "bin/tool.mjs"], ["bin/tool.js", "bin/tool.mjs", "bin/tool.d.mts"]);
    expect(primary).to.deep.equal(["bin/tool.js"]);
    expect(secondary).to.deep.equal([]);
  });

  it("keeps a bin that has no CommonJS format at all", () => {
    /* A bin compiled from an `.mts` emits only `.mjs`, which the CommonJS format
     * discards as ES-module output. Dropping it from the other format too would
     * leave the package with no bin and no error — the regression this guards. */
    const [primary, secondary] = partition(["bin/tool.mjs"], ["bin/tool.mjs", "bin/tool.d.mts"]);
    expect(primary).to.deep.equal([]);
    expect(secondary).to.deep.equal(["bin/tool.d.mts", "bin/tool.mjs"]);
  });
});

describe("resolveSourceMode", () => {
  it("is empty (default strict) with no flags", () => {
    expect(resolveSourceMode([])).to.deep.equal({});
  });

  it("ignores unrecognized flags (they may address other rules)", () => {
    expect(resolveSourceMode([new Flag("some/other-flag", [])])).to.deep.equal({});
  });

  it("maps a recognized flag to its compilerOptions fragment", () => {
    expect(resolveSourceMode([new Flag("ts/no_strict", [])])).to.deep.equal({ strict: false });
    expect(resolveSourceMode([new Flag("ts/allow_implicit_any", [])])).to.deep.equal({ noImplicitAny: false });
    expect(resolveSourceMode([new Flag("ts/no_es_module_interop", [])])).to.deep.equal({ esModuleInterop: false });
  });

  it("merges several flags into one overlay", () => {
    expect(resolveSourceMode([new Flag("ts/allow_implicit_any", []), new Flag("ts/no_strict_null_checks", [])])).to.deep.equal({
      noImplicitAny: false,
      strictNullChecks: false,
    });
  });

  it("walks a composite flag's provides closure", () => {
    const composite = new Flag("my/relaxed", [new Flag("ts/no_strict", []), new Flag("ts/allow_implicit_any", [])]);
    expect(resolveSourceMode([composite])).to.deep.equal({ strict: false, noImplicitAny: false });
  });

  it("relaxes one member of the strict family per flag", () => {
    expect(resolveSourceMode([new Flag("ts/allow_implicit_this", [])])).to.deep.equal({ noImplicitThis: false });
    expect(resolveSourceMode([new Flag("ts/no_use_unknown_in_catch_variables", [])])).to.deep.equal({ useUnknownInCatchVariables: false });
    expect(resolveSourceMode([new Flag("ts/no_strict_function_types", [])])).to.deep.equal({ strictFunctionTypes: false });
    expect(resolveSourceMode([new Flag("ts/no_strict_bind_call_apply", [])])).to.deep.equal({ strictBindCallApply: false });
  });

  it("keeps class fields on assignment semantics for legacy decorators", () => {
    /* A property decorator installs a prototype accessor, which the instance
     * field emitted at es2022+ shadows — so the decorator silently does nothing
     * unless the two travel together. */
    expect(resolveSourceMode([new Flag("ts/experimental_decorators", [])])).to.deep.equal({
      experimentalDecorators: true,
      useDefineForClassFields: false,
    });
  });

  it("expands ts/emit_decorator_metadata through its provides (tsc rejects it on its own)", () => {
    const metadata = new Flag("ts/emit_decorator_metadata", [new Flag("ts/experimental_decorators", [])]);
    expect(resolveSourceMode([metadata])).to.deep.equal({
      emitDecoratorMetadata: true,
      experimentalDecorators: true,
      useDefineForClassFields: false,
    });
  });
});

describe("esLevelOrder", () => {
  it("orders ES levels, with esnext highest", () => {
    expect(esLevelOrder("es5")).to.be.lessThan(esLevelOrder("es2015"));
    expect(esLevelOrder("es2021")).to.be.lessThan(esLevelOrder("es2022"));
    expect(esLevelOrder("es2023")).to.be.lessThan(esLevelOrder("esnext"));
  });

  it("orders es6 as es2015, tsc's alias for it", () => {
    /* Numerically es6 is 6, i.e. just above es5 — which would put the default
     * JS_TARGET below every version rule keyed on a year. */
    expect(esLevelOrder("es6")).to.equal(esLevelOrder("es2015"));
  });
});

describe("canonicalEsLevel", () => {
  it("normalizes es6 to es2015 and leaves every other level alone", () => {
    expect(canonicalEsLevel("es6")).to.equal("es2015");
    for (const level of ["es5", "es2015", "es2022", "esnext"]) {
      expect(canonicalEsLevel(level)).to.equal(level);
    }
  });

  it("canonicalizes a parsed target, so es6 and es2015 builds share one tsconfig", () => {
    expect(parseJSTarget("es6-esm-browser").version).to.equal("es2015");
    expect(parseJSTarget("es2015-esm-browser").version).to.equal("es2015");
  });

  it("canonicalizes a declared source level too", () => {
    expect(resolveSourceVersion([new Flag("es6", [])])).to.equal("es2015");
  });

  it("orders an unparseable name lowest, so it can never win a max", () => {
    expect(esLevelOrder("nonsense")).to.be.lessThan(esLevelOrder("es5"));
  });
});

describe("usesDom", () => {
  it("reads the declared flag, not the emit target", () => {
    expect(usesDom([new Flag("dom", [])])).to.equal(true);
    expect(usesDom([new Flag("es2020", [])])).to.equal(false);
    expect(usesDom([])).to.equal(false);
  });

  /* Walked through `provides` like every other source-mode flag, so a composite
   * flag ("this is a browser widget") can supply it. */
  it("finds it through a composite flag's provides", () => {
    expect(usesDom([new Flag("widget", [new Flag("dom", [])])])).to.equal(true);
  });
});

describe("usesNodeGlobals", () => {
  it("reads the declared flag by its full namespaced name", () => {
    expect(usesNodeGlobals([new Flag("js/node_globals", [])])).to.equal(true);
    expect(usesNodeGlobals([new Flag("dom", [])])).to.equal(false);
    expect(usesNodeGlobals([])).to.equal(false);
  });

  it("finds it through a composite flag's provides", () => {
    expect(usesNodeGlobals([new Flag("legacy_app", [new Flag("js/node_globals", [])])])).to.equal(true);
  });
});

describe("makeNpmRunnable", () => {
  it("makes a delivered graph runnable, its root reached through the top-level link", async () => {
    /* A back-edge into the root (a cycle) and a root edge to a version other
     * than the one its dependency uses. */
    const builder = new PackageGraphBuilder();
    const tool = builder.node(
      new Map<string, IFile>([
        ["package.json", MemoryFile.from(JSON.stringify({ name: "tool", version: "1.0.0", bin: { tool: "bin/tool.js" } }))],
        ["bin/tool.js", MemoryFile.from("#!/usr/bin/env node\n")],
      ]),
      "tool",
      "1.0.0"
    );
    const helper1 = builder.node(new Map<string, IFile>([["index.js", MemoryFile.from("// helper@1.0.0")]]), "helper", "1.0.0");
    const helper2 = builder.node(new Map<string, IFile>([["index.js", MemoryFile.from("// helper@2.0.0")]]), "helper", "2.0.0");
    const other = builder.node(new Map<string, IFile>([["index.js", MemoryFile.from("// other@1.0.0")]]), "other", "1.0.0");
    builder.wire(tool, [helper1, other]);
    builder.wire(other, [helper2, tool]);
    builder.seal();

    const install = new Map(await settle(makeNpmRunnable(tool)));
    const target = (name: string): string => (install.get(name) as SymlinkFile).target;
    expect(target("node_modules/tool")).to.equal(".fabr/tool@1.0.0/node_modules/tool");
    expect(install.has("node_modules/.fabr/tool@1.0.0/node_modules/tool/bin/tool.js")).to.equal(true);
    expect(target("node_modules/.fabr/tool@1.0.0/node_modules/helper")).to.equal("../../helper@1.0.0/node_modules/helper");
    expect(target("node_modules/.fabr/other@1.0.0/node_modules/helper")).to.equal("../../helper@2.0.0/node_modules/helper");
    expect(target("node_modules/.fabr/other@1.0.0/node_modules/tool")).to.equal("../../tool@1.0.0/node_modules/tool");
  });

  it("normalizes a './'-prefixed package.json bin path in the surface symlink", async () => {
    const json = JSON.stringify({ name: "typescript", version: "5.4.5", bin: { tsc: "./bin/tsc" } });
    const pkg = new PackageFileSet(
      new Map<string, IFile>([
        ["package.json", MemoryFile.from(json)],
        ["bin/tsc", MemoryFile.from("#!/usr/bin/env node\n")],
      ]),
      "typescript",
      "5.4.5"
    );
    const runnable = await settle(makeNpmRunnable(pkg));
    /* The bin command 'tsc' resolves to a SymlinkFile whose target has no stray
     * '/./' — otherwise the same-install-path dedup at launch sees two entries. */
    const link = new Map(runnable.surface).get("tsc");
    expect(link).to.be.instanceOf(SymlinkFile);
    expect((link as SymlinkFile).target).to.equal("node_modules/typescript/bin/tsc");
  });
});

describe("withBinShebangs", () => {
  async function shebang(files: Record<string, string>): Promise<Map<string, IFile>> {
    const set = new FileSet(new Map(Object.entries(files).map(([name, body]) => [name, MemoryFile.from(body)])));
    return entries(await settle(withBinShebangs(set)));
  }
  const body = (file: IFile | undefined): Promise<string> => settle(file!.readString());

  it("prepends a node shebang to a convention bin that lacks one", async () => {
    const out = await shebang({ "bin/fabr.js": "require('../index');\n" });
    expect(await body(out.get("bin/fabr.js"))).to.equal("#!/usr/bin/env node\nrequire('../index');\n");
  });

  it("leaves a bin that already has a shebang untouched (no double)", async () => {
    const original = "#!/usr/bin/env node\nrun();\n";
    const out = await shebang({ "bin/fabr.js": original });
    expect(await body(out.get("bin/fabr.js"))).to.equal(original);
  });

  it("respects a bundled bin's own interpreter line", async () => {
    const original = "#!/bin/sh\necho hi\n";
    const out = await shebang({ "bin/tool.sh": original });
    expect(await body(out.get("bin/tool.sh"))).to.equal(original);
  });

  it("touches only files under bin/, and skips .d.ts / .map siblings", async () => {
    const out = await shebang({
      "bin/cli.js": "x\n",
      "bin/cli.d.ts": "export {};\n",
      "bin/cli.js.map": "{}\n",
      "index.js": "y\n",
    });
    expect(await body(out.get("bin/cli.js"))).to.equal("#!/usr/bin/env node\nx\n");
    expect(await body(out.get("bin/cli.d.ts"))).to.equal("export {};\n");
    expect(await body(out.get("bin/cli.js.map"))).to.equal("{}\n");
    expect(await body(out.get("index.js"))).to.equal("y\n");
  });
});

describe("binOf", () => {
  /* package.json is untrusted content from an arbitrary package: bin commands
   * and targets must never carry path structure out of the package. */
  function pkgWithBin(bin: unknown): PackageFileSet {
    const json = JSON.stringify({ name: "tool", version: "1.0.0", bin });
    return new PackageFileSet(new Map<string, IFile>([["package.json", MemoryFile.from(json)]]), "tool", "1.0.0");
  }

  it("uses only the basename of a bin command key (npm's rule)", async () => {
    const bins = await settle(binOf(pkgWithBin({ "nested/dir/tool-cli": "lib/cli.js" })));
    expect([...bins]).to.deep.equal([["tool-cli", "lib/cli.js"]]);
  });

  it("reads a bin of any other shape as no bin (npm normalizes those away)", async () => {
    expect([...(await settle(binOf(pkgWithBin(["lib/cli.js"]))))]).to.deep.equal([]);
    expect([...(await settle(binOf(pkgWithBin(42))))]).to.deep.equal([]);
    expect([...(await settle(binOf(pkgWithBin(undefined))))]).to.deep.equal([]);
  });

  it("rejects a bin target that is not a string", async () => {
    expect(await rejectionMessage(binOf(pkgWithBin({ tool: { path: "lib/cli.js" } })))).to.match(/invalid bin target/);
  });

  it("rejects a bin command that reduces to no name", async () => {
    expect(await rejectionMessage(binOf(pkgWithBin({ "..": "lib/cli.js" })))).to.match(/invalid bin name/);
  });

  it("rejects a bin target escaping the package", async () => {
    /* Judged by the canonical-name rule, but with error-not-flatten semantics:
     * a repaired escape would silently re-point the bin inside the package. */
    expect(await rejectionMessage(binOf(pkgWithBin({ tool: "../../outside.js" })))).to.match(/invalid bin target/);
    expect(await rejectionMessage(binOf(pkgWithBin({ tool: "/etc/passwd" })))).to.match(/invalid bin target/);
  });
});

describe("classifySourceByExt", () => {
  it("compiles the module-flavoured TypeScript spellings", () => {
    /* Routed to js_compile, not shipped verbatim as a resource. */
    expect(classifySourceByExt("src/a.mts")).to.equal("ts");
    expect(classifySourceByExt("src/a.cts")).to.equal("ts");
    expect(classifySourceByExt("src/a.mjs")).to.equal("js");
    expect(classifySourceByExt("src/a.cjs")).to.equal("js");
  });

  it("treats their declaration forms as declarations", () => {
    expect(classifySourceByExt("src/a.d.mts")).to.equal("dts");
    expect(classifySourceByExt("src/a.d.cts")).to.equal("dts");
  });

  it("still copies anything tsc neither compiles nor emits", () => {
    expect(classifySourceByExt("src/run.sh")).to.equal("copy");
    expect(classifySourceByExt("src/logo.png")).to.equal("copy");
  });

  /* JSON is a compile input as well as a resource: js_compile sets
   * resolveJsonModule, so tsc types `import cfg from "./x.json"` from the real
   * document — which it can only do if the document is in the compile tree. */
  it("gives json its own kind, so it both compiles and ships", () => {
    expect(classifySourceByExt("src/data.json")).to.equal("json");
    const sources = classifySources(new FileSet(new Map<string, IFile>([["src/data.json", MemoryFile.from("{}")]])));
    expect([...compileInputs(sources)].map(([name]) => name)).to.deep.equal(["src/data.json"]);
    expect([...passthroughFiles(sources)].map(([name]) => name)).to.deep.equal(["src/data.json"]);
  });
});

describe("binByConvention", () => {
  const contents = (...names: string[]): FileSet =>
    new FileSet(new Map<string, IFile>(names.map(name => [name, MemoryFile.from(`// ${name}`)])));

  it("names each bin after its file (extension stripped), ignoring anything outside bin/", () => {
    expect([...binByConvention(contents("bin/fabr.js", "bin/tool.sh", "lib/x.js"))]).to.deep.equal([
      ["fabr", "bin/fabr.js"],
      ["tool", "bin/tool.sh"],
    ]);
  });

  it("skips the emitted declaration and map siblings", () => {
    expect([...binByConvention(contents("bin/fabr.js", "bin/fabr.d.ts", "bin/fabr.js.map"))]).to.deep.equal([
      ["fabr", "bin/fabr.js"],
    ]);
  });

  it("reports two bins claiming one command as a conflict, naming both files", () => {
    let caught: ConflictError | undefined;
    try {
      binByConvention(contents("bin/x.js", "bin/x.sh"));
    } catch (err) {
      caught = err as ConflictError;
    }
    expect(caught).to.be.instanceOf(ConflictError);
    expect(caught!.key).to.equal("x");
    expect([caught!.left.detail, caught!.right.detail]).to.deep.equal(["bin/x.js", "bin/x.sh"]);
  });
});
