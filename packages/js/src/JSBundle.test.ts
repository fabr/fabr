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
import { IFile, makeRewrite, MemoryFile, PackageFileSet, parseName, RefSource, RepositoryRef, RewriteFn, dependenciesOn } from "@fabr-build/core";
import { buildBundleOptions, compiledName, computeAssetNames, computeBundleEntries, computeChunkNames, computeExternalNames, IBundleEntrySource, toBundleFormat } from "./JSBundle";
import { parseJSTarget } from "./JSPackage";

/** A package with a single index.js and the given (already-built) deps. */
function pkg(name: string, deps: PackageFileSet[] = []): PackageFileSet {
  return new PackageFileSet(new Map<string, IFile>([["index.js", MemoryFile.from(`// ${name}`)]]), name, "1.0.0", dependenciesOn(...deps));
}

const sorted = (names: string[]): string[] => [...names].sort((x, y) => x.localeCompare(y));

/** A rewrite that matches nothing. */
const noRewrite: RewriteFn = () => undefined;

describe("computeExternalNames", () => {
  it("externalizes a plain dep and its closure not present in srcs", () => {
    const dep = pkg("d", [pkg("tslib")]);
    expect(sorted(computeExternalNames([], [dep]))).to.deep.equal(["d", "tslib"]);
  });

  it("externalizes a transitive-src package that is a DIRECT dep (deps-wins)", () => {
    /* p is only transitively in srcs (via host) but directly declared in deps. */
    const shared = pkg("p");
    const host = pkg("host", [shared]);
    expect(computeExternalNames([host], [shared])).to.deep.equal(["p"]);
  });

  it("bundles a package that is DIRECT in both srcs and deps", () => {
    const p = pkg("p");
    expect(computeExternalNames([p], [p])).to.deep.equal([]);
  });

  it("bundles a package that is TRANSITIVE in both srcs and deps", () => {
    const shared = pkg("p");
    const srcHost = pkg("srcHost", [shared]);
    const depHost = pkg("depHost", [shared]);
    /* p is transitive on both sides → bundled; only the direct dep depHost externalizes. */
    expect(sorted(computeExternalNames([srcHost], [depHost]))).to.deep.equal(["depHost"]);
  });

  it("bundles a DIRECT-src package even when it is a TRANSITIVE dep", () => {
    const shared = pkg("p");
    const depHost = pkg("depHost", [shared]);
    /* p direct in srcs, only transitive in deps → src wins, bundled. */
    expect(computeExternalNames([shared], [depHost])).to.deep.equal(["depHost"]);
  });

  it("externalizes an unbound renamed edge under the name the code imports it by", () => {
    /* A dep still carried as a reference, written `@npm:wrap-ansi:^7 -> wrap-ansi-cjs`:
     * the host's code requires the local name, so that is what must stay external. */
    const renamed = new RepositoryRef({} as RefSource, { name: "wrap-ansi", versionConstraint: "^7.0.0", renameTo: "wrap-ansi-cjs" });
    const host = new PackageFileSet(
      new Map<string, IFile>([["index.js", MemoryFile.from("// host")]]),
      "host",
      "1.0.0",
      [{ reference: renamed }]
    );
    expect(sorted(computeExternalNames([], [host]))).to.deep.equal(["host", "wrap-ansi-cjs"]);
  });
});

describe("computeBundleEntries", () => {
  /* A loose entry: staged at the root under its compiled name, so path and name
   * agree modulo the .ts→.js swap. */
  const source = (name: string): IBundleEntrySource => ({ path: name.replace(/\.tsx?$/i, ".js"), name });

  it("names both sides by the COMPILED entry — the rule compiles before esbuild links — and the output by its content", () => {
    expect(computeBundleEntries([source("src/index.ts"), source("vendor/lib.js")], noRewrite)).to.deep.equal({
      entries: [
        { in: "src/index.js", out: "src/index-" },
        { in: "vendor/lib.js", out: "vendor/lib-" },
      ],
      entryNames: "[dir]/[name][hash]",
    });
  });

  it("applies the output rewrite to the default name, which may drop the hash", () => {
    const rewrite: RewriteFn = name => (name.endsWith(".entry-[hash].js") ? name.replace(/\.entry-\[hash\]\.js$/, ".min.js") : undefined);
    expect(computeBundleEntries([source("src/app.entry.ts")], rewrite)).to.deep.equal({
      entries: [{ in: "src/app.entry.js", out: "src/app.min" }],
      entryNames: "[dir]/[name]",
    });
  });

  it("writes the hash where the rewrite keeps it, for every entry alike", () => {
    const rewrite: RewriteFn = name => name.replace(/^src\/(.*)\.entry-\[hash\]\.js$/, "$1.[hash].min.js");
    expect(computeBundleEntries([source("src/story.entry.ts"), source("src/head.entry.ts")], rewrite)).to.deep.equal({
      entries: [
        { in: "src/story.entry.js", out: "story." },
        { in: "src/head.entry.js", out: "head." },
      ],
      entryNames: "[dir]/[name][hash].min",
    });
  });

  it("refuses entries that need more than one pattern, and a hash named twice", () => {
    const some: RewriteFn = name => (name.startsWith("src/a") ? "a.js" : undefined);
    expect(() => computeBundleEntries([source("src/a.ts"), source("src/b.ts")], some)).to.throw(/one pattern.*'a\.js' and 'src\/b-\[hash\]\.js' differ/);
    const tails: RewriteFn = name => (name.startsWith("src/a") ? "a.[hash].min.js" : "b.[hash].js");
    expect(() => computeBundleEntries([source("src/a.ts"), source("src/b.ts")], tails)).to.throw(/one pattern/);
    const twice: RewriteFn = () => "x.[hash].[hash].js";
    expect(() => computeBundleEntries([source("src/a.ts")], twice)).to.throw(/hash twice/);
  });

  it("defaults every compiled/linked entry spelling to a .js bundle name", () => {
    /* The staged path keeps the compile's module flavour (.mts → .mjs); the
     * OUTPUT is a fresh bundle, always .js. */
    const entries: IBundleEntrySource[] = [
      { path: "src/app.js", name: "src/app.jsx" },
      { path: "src/main.mjs", name: "src/main.mts" },
      { path: "src/task.cjs", name: "src/task.cts" },
      { path: "src/util.mjs", name: "src/util.mjs" },
      { path: "src/legacy.cjs", name: "src/legacy.cjs" },
    ];
    expect(computeBundleEntries(entries, noRewrite).entries).to.deep.equal([
      { in: "src/app.js", out: "src/app-" },
      { in: "src/main.mjs", out: "src/main-" },
      { in: "src/task.cjs", out: "src/task-" },
      { in: "src/util.mjs", out: "src/util-" },
      { in: "src/legacy.cjs", out: "src/legacy-" },
    ]);
  });

  it("rejects an output that does not end in .js, naming the 'output' rewrite escape hatch", () => {
    const toCss: RewriteFn = () => "out.css";
    expect(() => computeBundleEntries([source("src/index.ts")], toCss)).to.throw(/must end in '.js'.*'output' rewrite/);
    /* A genuinely non-JS entry gets the same actionable message, not a bare
     * complaint about its own extension. */
    expect(() => computeBundleEntries([{ path: "logo.svg", name: "logo.svg" }], noRewrite)).to.throw(/'output' rewrite/);
  });
});

describe("compiledName", () => {
  it("maps compile inputs and module-flavoured JS to .js", () => {
    expect(compiledName("a/x.ts")).to.equal("a/x.js");
    expect(compiledName("a/x.tsx")).to.equal("a/x.js");
    expect(compiledName("a/x.jsx")).to.equal("a/x.js");
    expect(compiledName("a/x.mts")).to.equal("a/x.js");
    expect(compiledName("a/x.cts")).to.equal("a/x.js");
    expect(compiledName("a/x.mjs")).to.equal("a/x.js");
    expect(compiledName("a/x.cjs")).to.equal("a/x.js");
  });
  it("leaves .js and non-JS names alone", () => {
    expect(compiledName("a/x.js")).to.equal("a/x.js");
    expect(compiledName("logo.svg")).to.equal("logo.svg");
    /* Extension-only, never a substring match. */
    expect(compiledName("a/x.mts.txt")).to.equal("a/x.mts.txt");
  });
});

describe("computeChunkNames", () => {
  /** The `output` rewrite a build file would write, as written there. */
  const output = (...rules: string[]): RewriteFn => makeRewrite(rules.map(rule => parseName(rule)));

  it("names chunks by the fixed pattern where no rewrite renames it", () => {
    expect(computeChunkNames(noRewrite)).to.equal("chunks/[name]-[hash]");
    expect(computeChunkNames(output("*.js -> *.min.js"))).to.equal("chunks/[name]-[hash]");
  });

  it("renames the pattern by the output rewrite, each wildcard capturing a placeholder whole", () => {
    expect(computeChunkNames(output("chunks/*-*.js -> splits/$2-$1.js"))).to.equal("splits/[hash]-[name]");
    expect(computeChunkNames(output("**/*.js -> **/*.min.js"))).to.equal("chunks/[name]-[hash].min");
  });

  it("refuses a rename that leaves the chunks without a .js name", () => {
    expect(() => computeChunkNames(output("chunks/*-*.js -> $1.css"))).to.throw("must end in '.js'");
  });

  it("renames the assets' pattern the same way, keeping their own extension", () => {
    expect(computeAssetNames(noRewrite)).to.equal("[name]-[hash]");
    expect(computeAssetNames(output("*.js -> *.min.js", "chunks/*-*.js -> js/$1.js"))).to.equal("[name]-[hash]");
    expect(computeAssetNames(output("*-*.* -> assets/$1-$2.$3"))).to.equal("assets/[name]-[hash]");
    expect(() => computeAssetNames(output("*-*.* -> assets/$1.png"))).to.throw("must end in '.[ext]'");
  });
});

describe("toBundleFormat", () => {
  it("takes the four bundle formats and refuses anything else", () => {
    for (const format of ["iife", "cjs", "esm", "esm-split"]) {
      expect(toBundleFormat(format)).to.equal(format);
    }
    expect(() => toBundleFormat("commonjs")).to.throw("JS_BUNDLE_FORMAT must be 'iife', 'cjs', 'esm' or 'esm-split', not 'commonjs'");
  });
});

describe("buildBundleOptions", () => {
  const NO_ENTRIES = { entries: [], entryNames: "[dir]/[name]" };
  it("maps an esm browser target to esm/browser and debug to a linked sourcemap", () => {
    const options = buildBundleOptions(parseJSTarget("es2021-esm-browser"), "esm", "debug", NO_ENTRIES, [], {});
    expect(options.platform).to.equal("browser");
    expect(options.format).to.equal("esm");
    expect(options.target).to.equal("es2021");
    expect(options.minify).to.equal(false);
    expect(options.sourcemap).to.equal("linked");
  });

  it("writes the format it is given, splitting only for esm-split", () => {
    expect(buildBundleOptions(parseJSTarget("es2021-esm-browser"), "esm", "debug", NO_ENTRIES, [], {}).splitting).to.equal(false);
    const split = buildBundleOptions(parseJSTarget("es2021-esm-browser"), "esm-split", "debug", NO_ENTRIES, [], {});
    expect([split.format, split.splitting]).to.deep.equal(["esm", true]);
    /* The format is the bundle's own: a node target can still be written as a script. */
    expect(buildBundleOptions(parseJSTarget("es2019-commonjs-node"), "iife", "debug", NO_ENTRIES, [], {}).format).to.equal("iife");
  });

  it("uses iife for a non-esm browser bundle", () => {
    expect(buildBundleOptions(parseJSTarget("es6-commonjs-browser"), "iife", "debug", NO_ENTRIES, [], {}).format).to.equal("iife");
  });

  it("uses cjs for a non-esm node bundle", () => {
    expect(buildBundleOptions(parseJSTarget("es2019-commonjs-node"), "cjs", "debug", NO_ENTRIES, [], {}).format).to.equal("cjs");
  });

  it("minifies and drops the sourcemap for a release build", () => {
    const options = buildBundleOptions(parseJSTarget("es2021-esm"), "esm", "release", NO_ENTRIES, [], {});
    expect(options.minify).to.equal(true);
    expect(options.sourcemap).to.equal(false);
  });

  it("minifies and keeps the sourcemap for relwithdebinfo", () => {
    const options = buildBundleOptions(parseJSTarget("es2021-esm"), "esm", "relwithdebinfo", NO_ENTRIES, [], {});
    expect(options.minify).to.equal(true);
    expect(options.sourcemap).to.equal("linked");
  });

  it("passes defines through as esbuild `define`, omitting the key when empty", () => {
    const defines = { "process.env.NODE_ENV": '"production"', DEBUG: "false" };
    expect(buildBundleOptions(parseJSTarget("es2021-esm"), "esm", "debug", NO_ENTRIES, [], defines).define).to.deep.equal(defines);
    expect(buildBundleOptions(parseJSTarget("es2021-esm"), "esm", "debug", NO_ENTRIES, [], {})).to.not.have.property("define");
  });

  it("passes inject through as esbuild `inject`, omitting the key when nothing is injected", () => {
    const inject = [".fabr-node-globals.js"];
    expect(buildBundleOptions(parseJSTarget("es2021-esm"), "esm", "debug", NO_ENTRIES, [], {}, inject).inject).to.deep.equal(inject);
    expect(buildBundleOptions(parseJSTarget("es2021-esm"), "esm", "debug", NO_ENTRIES, [], {}, [])).to.not.have.property("inject");
    expect(buildBundleOptions(parseJSTarget("es2021-esm"), "esm", "debug", NO_ENTRIES, [], {})).to.not.have.property("inject");
  });
});
