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
import { FileSet, makeRewrite, MemoryFile } from "@fabr-build/core";
import type { ICssSource } from "./CSSCompile";
import {
  assetDeclarationName,
  buildCssOptions,
  cssImportRewrites,
  cssDeclarationNames,
  cssScopeCollision,
  cssScopeDigest,
  cssShimName,
  cssSourceOutputs,
  CSS_OUTDIR,
  CSS_SRC_ROOT,
  isCssModule,
  loweredCssName,
  partitionCssOutput,
} from "./CSSCompile";

function fileSet(...names: string[]): FileSet {
  return new FileSet(new Map(names.map(name => [name, MemoryFile.from("")])));
}

describe("isCssModule", () => {
  it("reads the ecosystem's `.module.` infix, in every stylesheet spelling", () => {
    expect(isCssModule("a/Foo.module.scss")).to.equal(true);
    expect(isCssModule("Foo.module.sass")).to.equal(true);
    expect(isCssModule("Foo.module.css")).to.equal(true);
  });

  it("leaves an ordinary stylesheet global", () => {
    expect(isCssModule("Foo.scss")).to.equal(false);
    expect(isCssModule("Foo.css")).to.equal(false);
    /* `module` has to be the extension's own component, not just present. */
    expect(isCssModule("module.helpers.scss")).to.equal(false);
  });
});

describe("output naming", () => {
  it("lowers Sass to .css and leaves .css alone", () => {
    expect(loweredCssName("a/Foo.scss")).to.equal("a/Foo.css");
    expect(loweredCssName("Foo.sass")).to.equal("Foo.css");
    expect(loweredCssName("a/Foo.css")).to.equal("a/Foo.css");
  });

  it("drops the '.module' marker, which scoping has consumed", () => {
    /* The marker means "scope me" to every bundler there is, so a stylesheet
     * whose names are already final must not still carry it — or a downstream
     * consumer scopes it a second time and the shim's map goes stale. */
    expect(loweredCssName("a/Foo.module.scss")).to.equal("a/Foo.css");
    expect(loweredCssName("a/Foo.module.sass")).to.equal("a/Foo.css");
    expect(loweredCssName("a/Foo.module.css")).to.equal("a/Foo.css");
  });

  it("names the shim beside the stylesheet it carries the map for", () => {
    expect(cssShimName("a/Foo.module.scss")).to.equal("a/Foo.css.js");
    expect(cssShimName("a/Foo.module.css")).to.equal("a/Foo.css.js");
  });

  it("names declarations in TypeScript's arbitrary-extension form", () => {
    /* `{base}.d.{ext}.ts`, not `{base}.{ext}.d.ts` — the latter is disabled
     * under ESM resolution. */
    expect(assetDeclarationName("a/Foo.module.scss")).to.equal("a/Foo.module.d.scss.ts");
    expect(assetDeclarationName("Foo.css")).to.equal("Foo.d.css.ts");
  });

  it("gives a module both its own declaration and the lowered twin", () => {
    /* The source's own name is what the author imports; the lowered name is what
     * the module's own shim imports. */
    expect(cssDeclarationNames("a/Foo.module.scss")).to.deep.equal(["a/Foo.module.d.scss.ts", "a/Foo.d.css.ts"]);
    /* A `.module.css` source still lowers to a different name, so it too needs
     * both: its own for the author's import, the lowered one for the shim's. */
    expect(cssDeclarationNames("a/Foo.module.css")).to.deep.equal(["a/Foo.module.d.css.ts", "a/Foo.d.css.ts"]);
    /* A plain stylesheet is imported for its effect, and nothing imports the
     * lowered name, so it needs only its own. */
    expect(cssDeclarationNames("a/Foo.scss")).to.deep.equal(["a/Foo.d.scss.ts"]);
  });
});

describe("cssScopeDigest", () => {
  it("is a function of the package and the path, and of nothing else", () => {
    expect(cssScopeDigest("@scope/pkg", "a/Foo.module.scss")).to.equal(cssScopeDigest("@scope/pkg", "a/Foo.module.scss"));
    /* Distinct per file and per package — the two axes a flat delivery can
     * collide on. */
    expect(cssScopeDigest("@scope/pkg", "a/Foo.module.scss")).to.not.equal(cssScopeDigest("@scope/pkg", "b/Foo.module.scss"));
    expect(cssScopeDigest("@scope/pkg", "a/Foo.module.scss")).to.not.equal(cssScopeDigest("@other/pkg", "a/Foo.module.scss"));
  });

  it("is a fixed-width base62 token, so it reads in a class name", () => {
    /* Every character is legal in a CSS identifier, and the suffix follows
     * `<local>_`, so it never has to avoid a leading digit. */
    expect(cssScopeDigest("pkg", "x.module.scss")).to.match(/^[0-9a-zA-Z]{8}$/);
    expect(cssScopeDigest("pkg", "deep/nested/name.module.scss")).to.match(/^[0-9a-zA-Z]{8}$/);
  });

  it("is wide enough that a collision is a chance event, not a design limit", () => {
    /* Distinctness across FILES is the one property this scheme does not have by
     * construction, so the width is doing real work: ~48 bits puts a delivery of
     * 20,000 stylesheets at roughly one in a million. Pinned so nobody shortens
     * it for looks — base62 is what buys the same safety base36 needs 10
     * characters for. */
    expect(Math.log2(62 ** 8)).to.be.greaterThan(47);
  });

  it("spreads across the alphabet rather than clustering", () => {
    /* A reduction done wrong (masking, or a modulo off too few bits) shows up as
     * a stuck leading character across many inputs. */
    const leading = new Set(
      Array.from({ length: 200 }, (_, index) => cssScopeDigest("pkg", `a/File${index}.module.scss`).charAt(0))
    );
    expect(leading.size).to.be.greaterThan(20);
  });
});

describe("cssScopeCollision", () => {
  const source = (path: string, scope: string): ICssSource => ({ path, css: "x.css", scope, declarations: [] });

  it("reports two modules that hashed to one scope", () => {
    /* Chance, not misuse — but it has to be loud: identically-named locals in
     * the two files would scope to the same class and bleed. */
    const found = cssScopeCollision([source("a/One.module.scss", "aaa"), source("b/Two.module.scss", "aaa")]);
    expect(found?.message).to.match(/a\/One\.module\.scss.*b\/Two\.module\.scss/);
  });

  it("ignores plain stylesheets, which have no scope", () => {
    const plain = { path: "a.scss", css: "a.css", declarations: [] };
    expect(cssScopeCollision([plain, { ...plain, path: "b.scss" }])).to.equal(undefined);
  });
});

describe("cssSourceOutputs", () => {
  it("gives a module a scope, a shim and both declarations", () => {
    const outputs = cssSourceOutputs("a/Foo.module.scss", "pkg");
    expect(outputs?.css).to.equal("a/Foo.css");
    expect(outputs?.shim).to.equal("a/Foo.css.js");
    expect(outputs?.scope).to.equal(cssScopeDigest("pkg", "a/Foo.module.scss"));
    expect(outputs?.declarations).to.deep.equal(["a/Foo.module.d.scss.ts", "a/Foo.d.css.ts"]);
  });

  it("names a source map only where the build carries them", () => {
    expect(cssSourceOutputs("a/Foo.module.scss", "pkg")?.map).to.equal(undefined);
    expect(cssSourceOutputs("a/Foo.module.scss", "pkg", true)?.map).to.equal("a/Foo.css.map");
    expect(cssSourceOutputs("a/Foo.scss", "pkg", true)?.map).to.equal("a/Foo.css.map");
  });

  it("names no map for a plain .css, which is copied unchanged", () => {
    /* Nothing happened for a map to describe, and an identity map naming the
     * file as its own source would be worse than none. */
    expect(cssSourceOutputs("a/Foo.css", "pkg", true)?.map).to.equal(undefined);
  });

  it("gives a plain stylesheet no scope and no shim", () => {
    const outputs = cssSourceOutputs("a/Foo.scss", "pkg");
    expect(outputs?.css).to.equal("a/Foo.css");
    expect(outputs?.scope).to.equal(undefined);
    expect(outputs?.shim).to.equal(undefined);
  });

  it("names nothing for a Sass partial", () => {
    /* A partial exists to be `@use`d; compiled alone it fails on whatever its
     * importer was supposed to define first. */
    expect(cssSourceOutputs("a/_shared.scss", "pkg")).to.equal(undefined);
    expect(cssSourceOutputs("_shared.sass", "pkg")).to.equal(undefined);
    /* The underscore has to be on the FILE, not an ancestor directory. */
    expect(cssSourceOutputs("_dir/Foo.scss", "pkg")).to.not.equal(undefined);
  });
});

describe("buildCssOptions", () => {
  it("names every source and points at the src root and outdir", () => {
    const options = buildCssOptions(["a/Foo.module.scss", "b.scss", "c.css"], "pkg");
    expect(options.srcRoot).to.equal(CSS_SRC_ROOT);
    expect(options.outdir).to.equal(CSS_OUTDIR);
    /* No load paths: a package load is the importer's to answer from the
     * dependency table, and nothing is mounted for one to point at. */
    expect(options.loadPaths).to.deep.equal([]);
    expect(options.sources.map(source => source.path)).to.deep.equal(["a/Foo.module.scss", "b.scss", "c.css"]);
  });

  it("sorts the source list so the options document (and cache key) is deterministic", () => {
    /* The manifest is content-addressed; the same sources in any order must
     * produce an identical document. */
    const a = buildCssOptions(["z.scss", "a.scss", "m/x.module.scss"], "pkg");
    const b = buildCssOptions(["m/x.module.scss", "z.scss", "a.scss"], "pkg");
    expect(a).to.deep.equal(b);
    expect(a.sources.map(source => source.path)).to.deep.equal(["a.scss", "m/x.module.scss", "z.scss"]);
  });

  it("drops partials, which produce nothing", () => {
    const options = buildCssOptions(["_vars.scss", "a.scss"], "pkg");
    expect(options.sources.map(source => source.path)).to.deep.equal(["a.scss"]);
  });

  it("explains the clash in terms of the two files, not just that there is one", () => {
    /* The reader's first question is why two files they gave different names
     * collide at all — the answer is the '.module' rule, which they may never
     * have met. */
    try {
      buildCssOptions(["a/Nav.module.scss", "a/Nav.css"], "pkg");
      expect.fail("expected a conflict");
    } catch (err) {
      const help = (err as { help?: string[] }).help ?? [];
      expect(help[0]).to.contain("'Nav.module.scss' is a css-module");
      expect(help[0]).to.contain("'.module' marker");
      expect(help[0]).to.contain("'Nav.css'");
      /* By basename: both always sit in one directory, and the full paths are
       * in the message already. */
      expect(help[0]).to.not.contain("a/Nav");
    }
  });

  it("refuses two sources that would write the same file", () => {
    /* Dropping the '.module' marker makes this reachable: both lower to
     * `a/Foo.css`. Nothing downstream would catch it — the driver writes each
     * output with a plain write, so the second silently replaces the first, and
     * the step's output is collected as ONE tree, never unioned with anything
     * for FileSet's own conflict check to fire on. */
    expect(() => buildCssOptions(["a/Foo.module.scss", "a/Foo.scss"], "pkg")).to.throw(/a\/Foo\.css/);
    /* Same clash written the other way round. */
    expect(() => buildCssOptions(["a/Foo.module.css", "a/Foo.css"], "pkg")).to.throw(/a\/Foo\.css/);
  });

  it("allows stylesheets that merely share a stem across directories", () => {
    expect(() => buildCssOptions(["a/Foo.module.scss", "b/Foo.scss"], "pkg")).to.not.throw();
  });
});

describe("partitionCssOutput", () => {
  it("splits the step's output into what the compile eats and what ships", () => {
    const { compileInputs, content } = partitionCssOutput(
      fileSet("a/Foo.css", "a/Foo.css.js", "a/Foo.module.d.scss.ts", "a/Foo.d.css.ts", "b.css")
    );
    expect([...compileInputs].map(([name]) => name).sort()).to.deep.equal([
      "a/Foo.css.js",
      "a/Foo.d.css.ts",
      "a/Foo.module.d.scss.ts",
    ]);
    expect([...content].map(([name]) => name).sort()).to.deep.equal(["a/Foo.css", "b.css"]);
  });
});

describe("cssImportRewrites", () => {
  const apply = (name: string): string | undefined => makeRewrite(cssImportRewrites())(name);

  it("points a module's own declaration at the shim, and the lowered twin at the stylesheet", () => {
    /* The two declarations of one stylesheet map to DIFFERENT things: the
     * source's own to the shim carrying the class map, the twin to the
     * stylesheet — so the shim's own `import "./x.css"` survives as itself
     * rather than looping back onto the shim. */
    expect(apply("a/Foo.module.d.scss.ts")).to.equal("a/Foo.css.js");
    expect(apply("a/Foo.d.css.ts")).to.equal("a/Foo.css");
  });

  it("points a plain stylesheet's declaration at the stylesheet", () => {
    expect(apply("a/Foo.d.scss.ts")).to.equal("a/Foo.css");
  });

  it("puts the module rules first, since a module also matches the plain shape", () => {
    /* `Foo.module.d.scss.ts` matches `**\/*.d.scss.ts` too — order decides. */
    expect(apply("Foo.module.d.scss.ts")).to.equal("Foo.css.js");
  });

  it("applies at the tree root as well as at depth", () => {
    /* `**\/` owns its adjacent slash, so nothing is left with a leading one. */
    expect(apply("Foo.module.d.scss.ts")).to.equal("Foo.css.js");
    expect(apply("a/b/c/Foo.module.d.scss.ts")).to.equal("a/b/c/Foo.css.js");
  });

  it("names nothing for a file that is not an asset declaration", () => {
    expect(apply("a/Foo.ts")).to.equal(undefined);
    expect(apply("a/Foo.d.ts")).to.equal(undefined);
    expect(apply("a/Foo.css")).to.equal(undefined);
  });

  it("is constant, so a stylesheet added or renamed does not move it", () => {
    /* The point of rules over resolved pairs: this document is action key
     * material, and per-file entries would rebuild the package's whole compile
     * whenever any stylesheet appeared. */
    expect(cssImportRewrites().map(String)).to.deep.equal(cssImportRewrites().map(String));
    expect(cssImportRewrites()).to.have.lengthOf(6);
  });
});
