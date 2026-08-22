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
import { FileSet, MemoryFile, PropertyMap, Requirement } from "@fabr-build/core";
import { createPackageJson, dependencyBlock, dependencyRequirement, optionalPeers, requirementSpec } from "./PackageJson";
import { JSTarget } from "./JSPackage";

const JS_TARGET: JSTarget = { version: "esnext", module: "commonjs", environment: "node" };

/** Generate a package.json and parse it back, for the given seed + metadata. */
async function generate(
  seed: Record<string, unknown> | undefined,
  metadata: PropertyMap,
  declared: (Requirement | undefined)[] = []
): Promise<Record<string, unknown>> {
  const file = createPackageJson({
    files: new FileSet(new Map()),
    seed,
    name: "pkg",
    version: "1.0.0",
    declared,
    provided: [],
    jsTarget: JS_TARGET,
    metadata,
  });
  return JSON.parse(await file.readString());
}

/** Generate a package.json for a package whose built contents are `files`
 *  (name → anything; only the names are read) and whose declared entry points
 *  are the sources `exports`. */
async function generateExports(
  files: string[],
  exports: string[],
  module: JSTarget["module"] = "commonjs"
): Promise<Record<string, unknown>> {
  const file = createPackageJson({
    files: new FileSet(new Map(files.map(name => [name, MemoryFile.from("")]))),
    name: "pkg",
    version: "1.0.0",
    declared: [],
    provided: [],
    jsTarget: { ...JS_TARGET, module },
    metadata: new Map(),
    exports,
  });
  return JSON.parse(await file.readString());
}

/** A dual package's built contents for the given source stems: both formats of
 *  each, as the two compiles emit them. */
const dualFiles = (...stems: string[]): string[] =>
  stems.flatMap(stem => [`${stem}.js`, `${stem}.d.ts`, `${stem}.mjs`, `${stem}.d.mts`]);

describe("createPackageJson", () => {
  it("strips functional fields from an imported package.json but keeps descriptive + unknown ones", async () => {
    const pkg = await generate(
      {
        description: "a package",
        keywords: ["build"],
        eslintConfig: { root: true }, // unknown extension — kept
        devDependencies: { typescript: "^5" },
        scripts: { build: "tsc" },
        private: true,
        packageManager: "yarn@4",
        files: ["dist"],
      },
      new Map()
    );
    expect(pkg.description).to.equal("a package");
    expect(pkg.keywords).to.deep.equal(["build"]);
    expect(pkg.eslintConfig).to.deep.equal({ root: true });
    for (const stripped of ["devDependencies", "scripts", "private", "packageManager", "files"]) {
      expect(pkg, stripped).to.not.have.property(stripped);
    }
  });

  it("encodes a scalar metadata value per the field schema (array field vs string)", async () => {
    const pkg = await generate(
      undefined,
      new Map([
        ["keywords", ["build", "cli"]],
        ["description", ["a", "small", "tool"]],
      ])
    );
    /* keywords is an array field → the list stays an array; description is not → joined. */
    expect(pkg.keywords).to.deep.equal(["build", "cli"]);
    expect(pkg.description).to.equal("a small tool");
  });

  it("encodes a sub-map as an object and a list of sub-maps as an array of objects", async () => {
    const pkg = await generate(
      undefined,
      new Map<string, PropertyMap | PropertyMap[]>([
        [
          "repository",
          new Map([
            ["type", ["git"]],
            ["url", ["https://example.com/x.git"]],
          ]),
        ],
        ["maintainers", [new Map([["name", ["Alice"]]]), new Map([["name", ["Bob"]]])]],
      ]) as PropertyMap
    );
    expect(pkg.repository).to.deep.equal({ type: "git", url: "https://example.com/x.git" });
    expect(pkg.maintainers).to.deep.equal([{ name: "Alice" }, { name: "Bob" }]);
  });

  it("emits declared requirements as dependencies, keeping a name that shadows an Object member", async () => {
    const pkg = await generate(undefined, new Map(), [
      { pkg: "lodash", constraint: "^4.0.0" },
      undefined, // a dep with no external requirement (a built co-member)
      { pkg: "__proto__", constraint: "^1.0.0" },
    ]);
    const dependencies = pkg.dependencies as Record<string, string>;
    expect(dependencies.lodash).to.equal("^4.0.0");
    /* Own data property, not the inherited prototype accessor — a dep is a
     * user-chosen name, so the accumulator must not treat it as one. */
    expect(Object.getOwnPropertyDescriptor(dependencies, "__proto__")?.value).to.equal("^1.0.0");
    expect(JSON.stringify(dependencies)).to.contain('"__proto__":"^1.0.0"');
  });

  it("emits an aliased requirement under the name the shipped code imports", async () => {
    /* Two versions of one package, told apart by a written rename: the manifest
     * has to state both, each keyed by the name our own code requires. */
    const pkg = await generate(undefined, new Map(), [
      { pkg: "typescript", constraint: "5.4.5" },
      { pkg: "typescript", constraint: "6.0.0-beta", alias: "typescript-6" },
    ]);
    expect(pkg.dependencies).to.deep.equal({
      typescript: "5.4.5",
      "typescript-6": "npm:typescript@6.0.0-beta",
    });
  });

  it("emits provided_deps requirements as peerDependencies, omitting the block when empty", async () => {
    const provided: Requirement[] = [{ pkg: "@fabr-build/core", constraint: "^0.1.0" }];
    const file = createPackageJson({
      files: new FileSet(new Map()),
      name: "pkg",
      version: "1.0.0",
      declared: [],
      provided,
      jsTarget: JS_TARGET,
      metadata: new Map(),
    });
    const pkg = JSON.parse(await file.readString()) as Record<string, unknown>;
    expect(pkg.peerDependencies).to.deep.equal({ "@fabr-build/core": "^0.1.0" });
    expect(await generate(undefined, new Map())).to.not.have.property("dependencies");
  });

  it("rejects a metadata key fabr computes, and one it strips", async () => {
    const rejects = async (metadata: PropertyMap, pattern: RegExp): Promise<void> => {
      try {
        await generate(undefined, metadata);
        expect.fail("expected a rejection");
      } catch (err) {
        expect((err as Error).message).to.match(pattern);
      }
    };
    await rejects(new Map([["name", ["x"]]]), /set by fabr/);
    await rejects(new Map([["scripts", ["x"]]]), /not carried/);
  });

  it("publishes no exports map for a target declaring no entry points", async () => {
    const pkg = await generateExports(["index.js", "index.d.ts", "server.js"], []);
    expect(pkg).to.not.have.property("exports");
    /* The convention entry points are unaffected either way. */
    expect(pkg.main).to.equal("index.js");
    expect(pkg.types).to.equal("index.d.ts");
  });

  it("publishes each declared entry point at the subpath its emitted file sits at", async () => {
    const pkg = await generateExports(
      ["index.js", "index.d.ts", "server.js", "server.d.ts", "lib/api.js", "lib/api.d.ts", "internal.js"],
      ["index.ts", "server.ts", "lib/api.ts"]
    );
    expect(pkg.exports).to.deep.equal({
      ".": { types: "./index.d.ts", default: "./index.js" },
      "./lib/api": { types: "./lib/api.d.ts", default: "./lib/api.js" },
      "./server": { types: "./server.d.ts", default: "./server.js" },
      "./package.json": "./package.json",
    });
    /* Undeclared, so unreachable — that narrowing is what the map is for. */
    expect(Object.keys(pkg.exports as object)).to.not.contain("./internal");
    /* main/types stay by convention: node ignores them once a map exists, but
     * whatever reads a manifest without resolving one still needs them. */
    expect(pkg.main).to.equal("index.js");
  });

  it("renders an entry with no declarations as the bare target path", async () => {
    const pkg = await generateExports(["index.js", "helper.js"], ["helper.jsx"]);
    expect(pkg.exports).to.deep.equal({ "./helper": "./helper.js", "./package.json": "./package.json" });
  });

  it("publishes both formats of a dual package under nested conditions", async () => {
    const pkg = await generateExports(dualFiles("index", "server"), ["index.ts", "server.ts"], "dual");
    expect(pkg.exports).to.deep.equal({
      ".": {
        import: { types: "./index.d.mts", default: "./index.mjs" },
        require: { types: "./index.d.ts", default: "./index.js" },
      },
      "./server": {
        import: { types: "./server.d.mts", default: "./server.mjs" },
        require: { types: "./server.d.ts", default: "./server.js" },
      },
      "./package.json": "./package.json",
    });
    /* The CommonJS format is what `type`/`main`/`types` describe, so the legacy
     * fallback stays coherent for whatever cannot read the map. */
    expect(pkg.type).to.equal("commonjs");
    expect(pkg.main).to.equal("index.js");
    expect(pkg.types).to.equal("index.d.ts");
  });

  it("publishes only the format a format-pinned entry point has", async () => {
    /* An `.mts` source emits ES modules and nothing else, so there is no
     * CommonJS file for a `require` condition to name — and naming one that was
     * never emitted would be worse than not answering `require` at all. */
    const files = [...dualFiles("index"), "esm.mjs", "esm.d.mts"];
    const pkg = await generateExports(files, ["esm.mts"], "dual");
    expect((pkg.exports as Record<string, unknown>)["./esm"]).to.deep.equal({
      types: "./esm.d.mts",
      default: "./esm.mjs",
    });
  });

  it("publishes an exhaustive map for a dual package declaring no entry points", async () => {
    /* A dual package must have a map — conditions are the only way to choose a
     * format — so "declared nothing" has to be spelled out rather than omitted,
     * and it must still narrow nothing. */
    const files = [...dualFiles("index", "lib/index"), "styles.css", "index.js.map"];
    const pkg = await generateExports(files, [], "dual");
    const bothFormats = (stem: string): unknown => ({
      import: { types: `./${stem}.d.mts`, default: `./${stem}.mjs` },
      require: { types: `./${stem}.d.ts`, default: `./${stem}.js` },
    });
    expect(pkg.exports).to.deep.equal({
      /* The package root is not a subpath, so no pattern reaches it. */
      ".": bothFormats("index"),
      /* One wildcard per subpath shape node's own resolution publishes — which
       * between them cover `./index`, `./lib/index` and both their spellings. */
      "./*": bothFormats("*"),
      "./*.js": bothFormats("*"),
      "./*.mjs": bothFormats("*"),
      /* `pkg/lib` is what CommonJS directory resolution answers today, and a map
       * does no directory indexes — so it is named outright. */
      "./lib": bothFormats("lib/index"),
      /* No format accounts for an asset, so it is reachable under its own name. */
      "./styles.css": "./styles.css",
      "./package.json": "./package.json",
    });
  });

  it("publishes a delivered spelling the formats do not name, as itself", async () => {
    /* `foo.ts` and `foo.cts` side by side are two modules sharing a stem: the
     * formats bind `./foo` to the `.ts` pair, so the `.cjs` would go unnamed — and
     * `require("pkg/foo.cjs")`, which resolves in a single-format build, would
     * start failing. It is a different module, so it resolves to itself rather
     * than to the stem's conditions. */
    const pkg = await generateExports([...dualFiles("foo"), "foo.cjs", "foo.d.cts"], [], "dual");
    const exports = pkg.exports as Record<string, unknown>;
    expect(exports["./foo.cjs"]).to.equal("./foo.cjs");
    /* The `.js` spelling IS one of the formats, so it resolves to both of them —
     * `import "pkg/foo.js"` must reach the ES-module copy, not load the
     * CommonJS one alongside it. */
    expect(exports["./foo.js"]).to.deep.equal(exports["./foo"]);
    expect(exports["./foo.mjs"]).to.deep.equal(exports["./foo"]);
  });

  it("leaves a single-format package with no map when nothing is declared", async () => {
    /* Only a dual package needs one: with one format, every emitted file is
     * already reachable by path. */
    expect(await generateExports(["index.js", "index.d.ts"], [])).to.not.have.property("exports");
  });

  it("publishes a format-pinned entry point under the spelling it emitted", async () => {
    /* A `.cts` source emits `.cjs`/`.d.cts` — not the `.js` the format's first
     * spelling names — under a single-format target as much as a dual one. */
    const pkg = await generateExports(["legacy.cjs", "legacy.d.cts"], ["legacy.cts"]);
    expect((pkg.exports as Record<string, unknown>)["./legacy"]).to.deep.equal({
      types: "./legacy.d.cts",
      default: "./legacy.cjs",
    });
  });

  it("rejects an entry point that emits no JavaScript", async () => {
    for (const source of ["styles.scss", "data.json", "types.d.ts", "missing.ts"]) {
      try {
        await generateExports(["index.js", "styles.css", "data.json", "types.d.ts"], [source]);
        expect.fail(`expected '${source}' to be rejected`);
      } catch (err) {
        expect((err as Error).message).to.match(/named in exports, but produces no JavaScript/);
      }
    }
  });
});

describe("dependencyBlock", () => {
  it("reads a well-formed block as a name→constraint map", () => {
    expect([...dependencyBlock({ lodash: "^4.0.0", chai: "5.1.0" })]).to.deep.equal([
      ["lodash", "^4.0.0"],
      ["chai", "5.1.0"],
    ]);
  });

  it("reads a block that is not an object as no dependencies", () => {
    /* `"dependencies": []` is published and means "none"; reading it
     * positionally would manufacture a requirement on a package named `0`. */
    expect([...dependencyBlock([])]).to.deep.equal([]);
    expect([...dependencyBlock(["lodash"])]).to.deep.equal([]);
    expect([...dependencyBlock("lodash")]).to.deep.equal([]);
    expect([...dependencyBlock(undefined)]).to.deep.equal([]);
    expect([...dependencyBlock(null)]).to.deep.equal([]);
  });

  it("drops an entry whose constraint is not a string", () => {
    expect([...dependencyBlock({ lodash: "^4.0.0", chai: { version: "5.1.0" }, mocha: 10 })]).to.deep.equal([
      ["lodash", "^4.0.0"],
    ]);
  });
});

describe("dependencyRequirement", () => {
  it("reads an ordinary entry as a requirement on the entry's own name", () => {
    expect(dependencyRequirement("lodash", "^4.0.0")).to.deep.equal({ pkg: "lodash", constraint: "^4.0.0" });
  });

  it("reads an npm: alias as a requirement on the aliased package", () => {
    /* @isaacs/cliui's shape: the constraint applies to wrap-ansi, and the
     * entry name is what cliui's own code requires. */
    expect(dependencyRequirement("wrap-ansi-cjs", "npm:wrap-ansi@^7.0.0")).to.deep.equal({
      pkg: "wrap-ansi",
      constraint: "^7.0.0",
      alias: "wrap-ansi-cjs",
    });
  });

  it("reads an alias to a scoped package (the scope's @ is not the separator)", () => {
    expect(dependencyRequirement("types", "npm:@types/node@^20.1.0")).to.deep.equal({
      pkg: "@types/node",
      constraint: "^20.1.0",
      alias: "types",
    });
    expect(dependencyRequirement("types", "npm:@types/node")).to.deep.equal({
      pkg: "@types/node",
      constraint: "*",
      alias: "types",
    });
  });

  it("reads a versionless alias as unconstrained", () => {
    expect(dependencyRequirement("wa", "npm:wrap-ansi")).to.deep.equal({ pkg: "wrap-ansi", constraint: "*", alias: "wa" });
    expect(dependencyRequirement("wa", "npm:wrap-ansi@")).to.deep.equal({ pkg: "wrap-ansi", constraint: "*", alias: "wa" });
  });

  it("carries no alias when it renames nothing", () => {
    expect(dependencyRequirement("wrap-ansi", "npm:wrap-ansi@^7.0.0")).to.deep.equal({ pkg: "wrap-ansi", constraint: "^7.0.0" });
  });

  it("leaves a spec form it doesn't understand alone", () => {
    /* Rejected downstream as the unparseable constraint it is, rather than
     * mistaken for something fabr can resolve. */
    expect(dependencyRequirement("local", "file:../local")).to.deep.equal({ pkg: "local", constraint: "file:../local" });
  });
});

describe("requirementSpec", () => {
  it("states an ordinary requirement under the package's own name", () => {
    expect(requirementSpec({ pkg: "lodash", constraint: "^4.0.0" })).to.deep.equal({ name: "lodash", spec: "^4.0.0" });
  });

  it("states an aliased requirement in npm's alias form, keyed by the local name", () => {
    /* The entry name is what the shipped code imports — recording `typescript`
     * would install the package where nothing looks for it. */
    expect(requirementSpec({ pkg: "typescript", constraint: "6.0.0-beta", alias: "typescript-6" })).to.deep.equal({
      name: "typescript-6",
      spec: "npm:typescript@6.0.0-beta",
    });
  });

  it("round-trips whatever dependencyRequirement reads", () => {
    for (const [name, spec] of [
      ["lodash", "^4.0.0"],
      ["wrap-ansi-cjs", "npm:wrap-ansi@^7.0.0"],
      ["types", "npm:@types/node@^20.1.0"],
    ]) {
      expect(requirementSpec(dependencyRequirement(name, spec))).to.deep.equal({ name, spec });
    }
  });

  it("states an alias to the package's own name plainly (it renames nothing)", () => {
    expect(requirementSpec({ pkg: "wrap-ansi", constraint: "^7.0.0", alias: "wrap-ansi" })).to.deep.equal({
      name: "wrap-ansi",
      spec: "^7.0.0",
    });
  });
});

describe("optionalPeers", () => {
  it("collects the peers flagged optional", () => {
    expect([...optionalPeers({ react: { optional: true }, chai: { optional: false }, mocha: {} })]).to.deep.equal(["react"]);
  });

  it("reads a malformed block as no optional peers", () => {
    expect([...optionalPeers({ react: "optional", chai: null })]).to.deep.equal([]);
    expect([...optionalPeers(["react"])]).to.deep.equal([]);
    expect([...optionalPeers(undefined)]).to.deep.equal([]);
  });
});
