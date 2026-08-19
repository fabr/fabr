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
import { exportedSubpath, type ExportsValue, resolveExports, resolveExportsAll, resolveImports } from "./PackageExports";

/** The conditions a typechecking compile satisfies, which is the set every
 * driver-shaped case here is about. */
const TYPES = new Set(["types", "import", "node"]);

describe("resolveExports", () => {
  it("reads a bare string or a condition map as the main entry alone", () => {
    expect(resolveExports("./index.js", ".", TYPES)).to.equal("./index.js");
    expect(resolveExports({ types: "./index.d.ts", default: "./index.js" }, ".", TYPES)).to.equal("./index.d.ts");
    /* Sugar describes `.` and nothing else — a subpath of it is not exported. */
    expect(resolveExports("./index.js", "./deep", TYPES)).to.equal(undefined);
  });

  it("takes the first condition the map lists that this world satisfies", () => {
    /* The map's own order is the priority, not the caller's: a package that
     * lists `types` first means types first. */
    const exports: ExportsValue = { types: "./index.d.ts", import: "./esm.js", require: "./cjs.js", default: "./fallback.js" };
    expect(resolveExports(exports, ".", TYPES)).to.equal("./index.d.ts");
    expect(resolveExports(exports, ".", new Set(["require"]))).to.equal("./cjs.js");
    /* A world satisfying nothing still gets `default`, which is what makes it
     * the ecosystem's universal escape hatch. */
    expect(resolveExports(exports, ".", new Set())).to.equal("./fallback.js");
  });

  it("resolves a declared subpath to the file the package names for it", () => {
    const exports: ExportsValue = { ".": "./dist/index.js", "./client": "./dist/client/index.js" };
    expect(resolveExports(exports, "./client", TYPES)).to.equal("./dist/client/index.js");
    /* The point of a map: what it does not list has no name, whatever the
     * package's directory happens to contain. */
    expect(resolveExports(exports, "./dist/client/index.js", TYPES)).to.equal(undefined);
    expect(resolveExports(exports, "./internal", TYPES)).to.equal(undefined);
  });

  it("substitutes a pattern's wildcard into every star of its target", () => {
    expect(resolveExports({ "./*": "./src/*.js" }, "./util/pad", TYPES)).to.equal("./src/util/pad.js");
    expect(resolveExports({ "./*": { types: "./types/*.d.ts", default: "./src/*.js" } }, "./a/b", TYPES)).to.equal("./types/a/b.d.ts");
    /* The star stands for the whole remainder, never nothing. */
    expect(resolveExports({ "./*": "./src/*.js" }, ".", TYPES)).to.equal(undefined);
  });

  it("prefers the most specific key, whatever order the map lists them in", () => {
    const exports: ExportsValue = { "./*": "./any/*.js", "./feature/*": "./feature/*.js", "./feature/known": "./feature/known.js" };
    expect(resolveExports(exports, "./feature/known", TYPES)).to.equal("./feature/known.js");
    expect(resolveExports(exports, "./feature/other", TYPES)).to.equal("./feature/other.js");
    expect(resolveExports(exports, "./elsewhere", TYPES)).to.equal("./any/elsewhere.js");
    /* The same map written in every order answers identically — the ranking is
       the key's shape, never the manifest's layout. */
    const reversed: ExportsValue = { "./feature/known": "./feature/known.js", "./feature/*": "./feature/*.js", "./*": "./any/*.js" };
    for (const subpath of ["./feature/known", "./feature/other", "./elsewhere"]) {
      expect(resolveExports(reversed, subpath, TYPES), subpath).to.equal(resolveExports(exports, subpath, TYPES));
    }
  });

  it("ranks a longer pattern base above a shorter one, and a pattern above a plain key", () => {
    /* Each tiebreak of PATTERN_KEY_COMPARE, separated so that dropping any one
       of them changes an answer. */
    expect(resolveExports({ "./a*": "./short/*.js", "./ab*": "./long/*.js" }, "./abc", TYPES)).to.equal("./long/c.js");
    expect(resolveExports({ "./a*": "./star.js", "./a": "./plain.js" }, "./a", TYPES)).to.equal("./plain.js");
    expect(resolveExports({ "./*": "./short/*.js", "./*.js": "./long/*.js" }, "./x.js", TYPES)).to.equal("./long/x.js");
  });

  it("takes the first entry of a fallback list that resolves", () => {
    expect(resolveExports({ ".": [{ browser: "./browser.js" }, "./index.js"] }, ".", TYPES)).to.equal("./index.js");
    /* A fallback list absorbs a refusal rather than propagating it: node skips a
       `null` entry and tries the next, and an entry naming something outside the
       package is skipped the same way. */
    expect(resolveExports({ ".": [null, "./index.js"] }, ".", TYPES)).to.equal("./index.js");
    expect(resolveExports({ ".": [{ import: null }, "./index.js"] }, ".", TYPES)).to.equal("./index.js");
    expect(resolveExports({ ".": ["../outside.js", "./index.js"] }, ".", TYPES)).to.equal("./index.js");
  });

  it("treats a null target as blocked rather than absent", () => {
    /* `null` is how a package carves a hole in a pattern it otherwise exports,
     * and a later condition must not fill it back in. */
    const exports: ExportsValue = { "./internal/*": null, "./*": "./src/*.js" };
    expect(resolveExports(exports, "./internal/secret", TYPES)).to.equal(undefined);
    expect(resolveExports(exports, "./public", TYPES)).to.equal("./src/public.js");
  });

  it("refuses a target that would leave the package", () => {
    expect(resolveExports({ ".": "../sibling/index.js" }, ".", TYPES)).to.equal(undefined);
    expect(resolveExports({ ".": "/etc/passwd" }, ".", TYPES)).to.equal(undefined);
    expect(resolveExports({ ".": "other-package" }, ".", TYPES)).to.equal(undefined);
    /* Including by way of a wildcard, which comes from the SPECIFIER and so is
     * the one part of a target a consumer controls. */
    expect(resolveExports({ "./*": "./src/*" }, "./../../etc/passwd", TYPES)).to.equal(undefined);
    expect(resolveExports({ "./*": "./src/*" }, "./node_modules/evil", TYPES)).to.equal(undefined);
  });

  it("does not honor a deprecated trailing-slash key, even against itself", () => {
    /* Node dropped these in v17 and tsc resolves them in no mode, so a package
     * relying on one neither loads nor typechecks anywhere else — resolving it
     * here would compile something that cannot run. Node refuses the bare key
     * too, which is why the exact-match path excludes it rather than only the
     * subpaths below it. */
    const exports: ExportsValue = { "./features/": "./src/features/" };
    expect(resolveExports(exports, "./features/a/b.js", TYPES)).to.equal(undefined);
    expect(resolveExports(exports, "./features/", TYPES)).to.equal(undefined);
  });

  it("leaves a `*` in a non-pattern key's target as the character it is", () => {
    /* Only a PATTERN substitutes. Elsewhere a `*` is an ordinary character of a
       filename, and node names the file `a*b.js`. */
    expect(resolveExports({ ".": "./a*b.js" }, ".", TYPES)).to.equal("./a*b.js");
    expect(resolveExports({ "./x": "./dist/*.js" }, "./x", TYPES)).to.equal("./dist/*.js");
    /* The degenerate case this protects: substituting the empty string would
       resolve the package's own directory. */
    expect(resolveExports({ ".": "./*" }, ".", TYPES)).to.equal("./*");
  });

  it("refuses a forbidden segment however it is spelled", () => {
    /* The wildcard comes from the specifier, so every spelling that reaches the
       same place has to be refused: a case-insensitive filesystem answers
       `NODE_MODULES`, a backslash separates on Windows, and `%2e` is a `.` to
       anything that resolves the result as a URL. */
    expect(resolveExports({ "./*": "./*" }, "./NODE_MODULES/evil.js", TYPES)).to.equal(undefined);
    expect(resolveExports({ "./*": "./dist/*" }, "./%2e%2e/evil.js", TYPES)).to.equal(undefined);
    expect(resolveExports({ "./*": "./dist/*" }, "./..\\..\\evil.js", TYPES)).to.equal(undefined);
    /* And in a literal target, which the package controls but may still get
       wrong. */
    expect(resolveExports({ ".": "./dist/NODE_MODULES/evil.js" }, ".", TYPES)).to.equal(undefined);
  });

  it("checks the wildcard even when the target never uses it", () => {
    /* Without this the subpath is never examined at all, and every name the
       package could be asked for resolves to the same file. */
    expect(resolveExports({ "./*": "./index.js" }, "./../../evil", TYPES)).to.equal(undefined);
    expect(resolveExports({ "./*": "./index.js" }, "./node_modules/evil", TYPES)).to.equal(undefined);
    expect(resolveExports({ "./*": "./index.js" }, "./ordinary", TYPES)).to.equal("./index.js");
  });

  it("treats a target it may not name as a refusal, not as a miss", () => {
    /* Node throws here. Falling through to the next condition would answer with
       a DIFFERENT file, which is neither what the package meant nor what any
       other resolver does. */
    expect(resolveExports({ ".": { import: "../../evil.js", default: "./ok.js" } }, ".", TYPES)).to.equal(undefined);
    expect(resolveExports({ ".": { import: "other-package", default: "./ok.js" } }, ".", TYPES)).to.equal(undefined);
  });

  it("reports a map that mixes subpath keys with condition keys", () => {
    expect(() => resolveExports({ ".": "./index.js", import: "./esm.js" }, ".", TYPES)).to.throw(/cannot be mixed/);
  });
});

describe("resolveExportsAll", () => {
  it("lists what the map publishes in the package's own order", () => {
    /* aws-jwt-verify's shape, and the reason this exists: the declaration file
     * is behind a key the package lists last, so the answer to "what runs" and
     * the answer to "what declares it" are different entries of one map. */
    const exports: ExportsValue = {
      "./https": { import: "./dist/esm/https.js", require: "./dist/cjs/https.js", types: "./https.d.ts" },
    };
    expect(resolveExportsAll(exports, "./https", new Set(["types", "require", "node"]))).to.deep.equal([
      "./dist/cjs/https.js",
      "./https.d.ts",
    ]);
    /* And the first of them is exactly what resolveExports answers — one walk,
     * two questions. */
    expect(resolveExports(exports, "./https", new Set(["types", "require", "node"]))).to.equal("./dist/cjs/https.js");
  });

  it("offers nothing a condition did not match, and nothing past a block", () => {
    const exports: ExportsValue = { "./x": { import: "./esm.js", types: "./x.d.ts" } };
    /* `import` is not this world's; only the types key answers. */
    expect(resolveExportsAll(exports, "./x", new Set(["types"]))).to.deep.equal(["./x.d.ts"]);
    /* A world matching neither gets nothing, so listing alternatives can never
     * make an unresolvable name resolvable. */
    expect(resolveExportsAll(exports, "./x", new Set(["require"]))).to.deep.equal([]);
    /* A `null` ends the walk: what a package took away, a later key may not
     * hand back. */
    expect(resolveExportsAll({ "./x": { require: null, types: "./x.d.ts" } }, "./x", new Set(["types", "require"]))).to.deep.equal([]);
  });
});

describe("resolveImports", () => {
  it("answers a private specifier from the map, file or redirection alike", () => {
    const imports: ExportsValue = { "#internal": "./src/internal.js", "#dep": "some-package/sub" };
    expect(resolveImports(imports, "#internal", TYPES)).to.equal("./src/internal.js");
    /* A bare target comes back as written: it names another package, which only
     * the table can resolve. */
    expect(resolveImports(imports, "#dep", TYPES)).to.equal("some-package/sub");
  });

  it("picks the condition, and patterns, as exports does", () => {
    expect(resolveImports({ "#env": { node: "./src/node.js", default: "./src/browser.js" } }, "#env", TYPES)).to.equal("./src/node.js");
    expect(resolveImports({ "#lib/*": "./src/lib/*.js" }, "#lib/pad", TYPES)).to.equal("./src/lib/pad.js");
  });

  it("declines anything that is not a private specifier", () => {
    expect(resolveImports({ "#a": "./a.js" }, "#missing", TYPES)).to.equal(undefined);
    expect(resolveImports({ "#a": "./a.js" }, "plain", TYPES)).to.equal(undefined);
    expect(resolveImports({ "#a": "./a.js" }, "#", TYPES)).to.equal(undefined);
    /* `#/x` is refused by the written specification and accepted by node — and
       node is what decides whether the import loads. */
    expect(resolveImports({ "#/x": "./x.js" }, "#/x", TYPES)).to.equal("./x.js");
  });
});

describe("exportedSubpath", () => {
  it("names the subpath a consumer would write to reach a file", () => {
    const exports: ExportsValue = { ".": "./dist/index.js", "./client": "./dist/client/index.js" };
    expect(exportedSubpath(exports, "./dist/index.js", TYPES)).to.equal(".");
    expect(exportedSubpath(exports, "./dist/client/index.js", TYPES)).to.equal("./client");
  });

  it("reverses a pattern, under every condition the name reaches", () => {
    const exports: ExportsValue = { "./*": { types: "./types/*.d.ts", default: "./src/*.js" } };
    /* One name, both files: `pkg/util/pad` publishes the declarations to a
       consumer resolving types and the implementation to one resolving code, so
       it is the right name for either. */
    expect(exportedSubpath(exports, "./types/util/pad.d.ts", TYPES)).to.equal("./util/pad");
    expect(exportedSubpath(exports, "./src/util/pad.js", TYPES)).to.equal("./util/pad");
    /* A world that satisfies no condition but `default` reaches only the one. */
    expect(exportedSubpath(exports, "./src/util/pad.js", new Set())).to.equal("./util/pad");
    expect(exportedSubpath(exports, "./types/util/pad.d.ts", new Set())).to.equal(undefined);
  });

  it("answers nothing for a file the package publishes no name for", () => {
    expect(exportedSubpath({ ".": "./dist/index.js" }, "./dist/internal/detail.d.ts", TYPES)).to.equal(undefined);
  });

  it("prefers the most specific key that reaches the file", () => {
    /* The two keys must reverse to DIFFERENT names, or the case cannot tell an
       ordered search from an unordered one. */
    const exports: ExportsValue = { "./*": "./dist/*.js", "./client": "./dist/other.js" };
    expect(exportedSubpath(exports, "./dist/other.js", TYPES)).to.equal("./client");
    expect(exportedSubpath(exports, "./dist/plain.js", TYPES)).to.equal("./plain");
  });

  it("never answers with a name that does not lead back to the file", () => {
    /* Each of these derives a plausible name that a forward lookup then resolves
       elsewhere or not at all — which is why the answer is checked rather than
       merely derived. A shipped declaration has no fallback; the caller does. */

    /* A more specific key intercepts the derived name. */
    expect(exportedSubpath({ "./aa*": "./z/*.js", "./a*": "./y/*.js" }, "./y/ab.js", TYPES)).to.equal(undefined);
    /* A broader key would name a subpath a narrower `null` has blocked. */
    expect(exportedSubpath({ "./internal/*": null, "./*": "./src/*" }, "./src/internal/secret.js", TYPES)).to.equal(undefined);
    /* A key with two wildcards expands to a name matching nothing. */
    expect(exportedSubpath({ "./*/*": "./s/*.js" }, "./s/foo.js", TYPES)).to.equal(undefined);
    /* A literal `*` in a target is not a wildcard in either direction. */
    expect(exportedSubpath({ ".": "./a*b.js" }, "./axb.js", TYPES)).to.equal(undefined);
    expect(exportedSubpath({ ".": "./a*b.js" }, "./a*b.js", TYPES)).to.equal(".");
  });

  it("names a file the package publishes under a condition listed later", () => {
    /* The writer side of the reason resolveExportsAll exists: `pkg` reaches
       these declarations, because the consumer's compiler walks the same
       candidates this one did. */
    const exports: ExportsValue = { ".": { import: "./esm.js", types: "./index.d.ts" } };
    expect(exportedSubpath(exports, "./index.d.ts", new Set(["import", "types"]))).to.equal(".");
    expect(exportedSubpath(exports, "./esm.js", new Set(["import", "types"]))).to.equal(".");
  });
});
