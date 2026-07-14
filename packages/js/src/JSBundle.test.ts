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
import { IFile, MemoryFile, PackageFileSet, RewriteFn } from "@fabr/core";
import { buildBundleOptions, computeBundleEntries, computeExternalNames } from "./JSBundle";
import { parseJSTarget } from "./JSPackage";

/** A package with a single index.js and the given (already-built) deps. */
function pkg(name: string, deps: PackageFileSet[] = []): PackageFileSet {
  return new PackageFileSet(new Map<string, IFile>([["index.js", MemoryFile.from(`// ${name}`)]]), name, "1.0.0", deps);
}

const sorted = (names: string[]): string[] => [...names].sort((x, y) => x.localeCompare(y));

/** A rewrite that renames by a single selector -> replacement, else no-match. */
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
});

describe("computeBundleEntries", () => {
  it("defaults each output to the entry with .ts/.tsx swapped for .js", () => {
    expect(computeBundleEntries(["src/index.ts", "vendor/lib.js"], noRewrite)).to.deep.equal([
      { in: "src/index.ts", out: "src/index" },
      { in: "vendor/lib.js", out: "vendor/lib" },
    ]);
  });

  it("applies the output rewrite to the default name", () => {
    const rewrite: RewriteFn = name => (name.endsWith(".entry.js") ? name.replace(/\.entry\.js$/, ".min.js") : undefined);
    expect(computeBundleEntries(["src/app.entry.ts"], rewrite)).to.deep.equal([
      { in: "src/app.entry.ts", out: "src/app.min" },
    ]);
  });

  it("rejects an output that does not end in .js", () => {
    const toCss: RewriteFn = () => "out.css";
    expect(() => computeBundleEntries(["src/index.ts"], toCss)).to.throw(/must end in '.js'/);
  });
});

describe("buildBundleOptions", () => {
  it("maps an esm browser target to esm/browser and debug to a linked sourcemap", () => {
    const options = buildBundleOptions(parseJSTarget("es2021-esm-browser"), "debug", [], []);
    expect(options.platform).to.equal("browser");
    expect(options.format).to.equal("esm");
    expect(options.target).to.equal("es2021");
    expect(options.minify).to.equal(false);
    expect(options.sourcemap).to.equal("linked");
  });

  it("uses iife for a non-esm browser bundle", () => {
    expect(buildBundleOptions(parseJSTarget("es6-commonjs-browser"), "debug", [], []).format).to.equal("iife");
  });

  it("uses cjs for a non-esm node bundle", () => {
    expect(buildBundleOptions(parseJSTarget("es2019-commonjs-node"), "debug", [], []).format).to.equal("cjs");
  });

  it("minifies and drops the sourcemap for a release build", () => {
    const options = buildBundleOptions(parseJSTarget("es2021-esm"), "release", [], []);
    expect(options.minify).to.equal(true);
    expect(options.sourcemap).to.equal(false);
  });

  it("minifies and keeps the sourcemap for relwithdebinfo", () => {
    const options = buildBundleOptions(parseJSTarget("es2021-esm"), "relwithdebinfo", [], []);
    expect(options.minify).to.equal(true);
    expect(options.sourcemap).to.equal("linked");
  });
});
