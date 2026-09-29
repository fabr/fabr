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
import {
  buildPostcssOptions,
  buildSassOptions,
  cssImportRewrites,
  cssScopeCollision,
  cssScopeDigest,
  CSS_OUTDIR,
  CSS_SRC_ROOT,
  isCssModule,
  loweredCssName,
  partitionCssOutput,
  postcssSourceOutputs,
  sassSourceOutputs,
  scopedCssName,
} from "./CSSCompile";
import { sassLoweredName } from "./cssDriver/Support";

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

  it("keeps the '.module' marker through the sass step, whose lowering does not scope", () => {
    expect(sassLoweredName("a/Foo.module.scss")).to.equal("a/Foo.module.css");
    expect(sassLoweredName("a/Foo.module.sass")).to.equal("a/Foo.module.css");
    expect(sassLoweredName("a/Foo.scss")).to.equal("a/Foo.css");
    /* Identity on plain CSS, which the sass step never transforms. */
    expect(sassLoweredName("a/Foo.module.css")).to.equal("a/Foo.module.css");
    expect(sassLoweredName("a/Foo.css")).to.equal("a/Foo.css");
  });

  it("consumes the marker at the scoping step, and only there", () => {
    expect(scopedCssName("a/Foo.module.css")).to.equal("a/Foo.css");
    expect(scopedCssName("a/Foo.css")).to.equal("a/Foo.css");
    /* The scoping step's input is always `.css` — a `.module.scss` reaching it
     * unlowered stays untouched rather than being half-consumed. */
    expect(scopedCssName("a/Foo.module.scss")).to.equal("a/Foo.module.scss");
  });

  it("composes the two steps into the end-to-end name", () => {
    expect(scopedCssName(sassLoweredName("a/Foo.module.scss"))).to.equal(loweredCssName("a/Foo.module.scss"));
    expect(scopedCssName(sassLoweredName("a/Foo.scss"))).to.equal(loweredCssName("a/Foo.scss"));
    expect(scopedCssName(sassLoweredName("a/Foo.module.css"))).to.equal(loweredCssName("a/Foo.module.css"));
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
  const source = (path: string, scope: string): { path: string; scope?: string } => ({ path, scope });

  it("reports two modules that hashed to one scope", () => {
    /* Chance, not misuse — but it has to be loud: identically-named locals in
     * the two files would scope to the same class and bleed. */
    const found = cssScopeCollision([source("a/One.module.scss", "aaa"), source("b/Two.module.scss", "aaa")]);
    expect(found?.message).to.match(/a\/One\.module\.scss.*b\/Two\.module\.scss/);
  });

  it("ignores plain stylesheets, which have no scope", () => {
    expect(cssScopeCollision([{ path: "a.scss" }, { path: "b.scss" }])).to.equal(undefined);
  });
});

describe("sassSourceOutputs", () => {
  it("keeps the module marker on the lowered name", () => {
    expect(sassSourceOutputs("a/Foo.module.scss")?.css).to.equal("a/Foo.module.css");
  });

  it("gives a plain stylesheet its lowered name", () => {
    expect(sassSourceOutputs("a/Foo.scss")?.css).to.equal("a/Foo.css");
  });

  it("names the stylesheet and its map, and nothing else", () => {
    /* Shims and declarations are named after the stylesheets css_postcss
     * publishes, so the lowering step emits none — which is what leaves the
     * `.module.css` intermediate no route into a delivery. */
    expect(Object.keys(sassSourceOutputs("a/Foo.module.scss", true) ?? {}).sort()).to.deep.equal(["css", "map", "path"]);
  });

  it("names a source map only where the build carries them", () => {
    expect(sassSourceOutputs("a/Foo.module.scss")?.map).to.equal(undefined);
    expect(sassSourceOutputs("a/Foo.module.scss", true)?.map).to.equal("a/Foo.module.css.map");
    expect(sassSourceOutputs("a/Foo.scss", true)?.map).to.equal("a/Foo.css.map");
  });

  it("names nothing for a Sass partial", () => {
    /* A partial exists to be `@use`d; compiled alone it fails on whatever its
     * importer was supposed to define first. */
    expect(sassSourceOutputs("a/_shared.scss")).to.equal(undefined);
    expect(sassSourceOutputs("_shared.sass")).to.equal(undefined);
    /* The underscore has to be on the FILE, not an ancestor directory. */
    expect(sassSourceOutputs("_dir/Foo.scss")).to.not.equal(undefined);
  });
});

describe("postcssSourceOutputs", () => {
  it("gives a module its final name, a scope and a shim", () => {
    const outputs = postcssSourceOutputs("a/Foo.module.css", "pkg");
    expect(outputs.css).to.equal("a/Foo.css");
    expect(outputs.shim).to.equal("a/Foo.css.ts");
    /* The digest input is this step's own input name — the lowered
     * `.module.css` — so a `.scss` and a `.css` spelling of one module scope
     * identically, and the step that applies the scope computes it from a name
     * it sees. */
    expect(outputs.scope).to.equal(cssScopeDigest("pkg", "a/Foo.module.css"));
  });

  it("names a module's map only where the build carries them", () => {
    expect(postcssSourceOutputs("a/Foo.module.css", "pkg").map).to.equal(undefined);
    expect(postcssSourceOutputs("a/Foo.module.css", "pkg", true).map).to.equal("a/Foo.css.map");
  });

  it("copies a plain stylesheet through under its own name, carrying a map it arrived with", () => {
    const bare = postcssSourceOutputs("a/Foo.css", "pkg", true);
    expect(bare.css).to.equal("a/Foo.css");
    /* Not a module, so its own output keeps its names and it gets no shim —
     * but it still carries a scope, for the private copy a css-module
     * composing from it inlines. */
    expect(bare.module).to.equal(false);
    expect(bare.shim).to.equal(undefined);
    expect(bare.scope).to.equal(cssScopeDigest("pkg", "a/Foo.css"));
    /* An authored `.css` arrives with no map, and nothing happened for one to
     * describe. */
    expect(bare.map).to.equal(undefined);
    /* A lowered Sass stylesheet arrives with one, and it rides through. */
    const carried = postcssSourceOutputs("a/Foo.css", "pkg", true, new Set(["a/Foo.css.map"]));
    expect(carried.map).to.equal("a/Foo.css.map");
  });
});

describe("buildSassOptions", () => {
  it("names every source and points at the src root and outdir", () => {
    const options = buildSassOptions(["a/Foo.module.scss", "b.scss"]);
    expect(options.srcRoot).to.equal(CSS_SRC_ROOT);
    expect(options.outdir).to.equal(CSS_OUTDIR);
    /* No load paths: a package load is the importer's to answer from the
     * dependency table, and nothing is mounted for one to point at. */
    expect(options.loadPaths).to.deep.equal([]);
    expect(options.sources.map(source => source.path)).to.deep.equal(["a/Foo.module.scss", "b.scss"]);
  });

  it("sorts the source list so the options document (and cache key) is deterministic", () => {
    /* The manifest is content-addressed; the same sources in any order must
     * produce an identical document. */
    const a = buildSassOptions(["z.scss", "a.scss", "m/x.module.scss"]);
    const b = buildSassOptions(["m/x.module.scss", "z.scss", "a.scss"]);
    expect(a).to.deep.equal(b);
    expect(a.sources.map(source => source.path)).to.deep.equal(["a.scss", "m/x.module.scss", "z.scss"]);
  });

  it("drops partials, which produce nothing", () => {
    const options = buildSassOptions(["_vars.scss", "a.scss"]);
    expect(options.sources.map(source => source.path)).to.deep.equal(["a.scss"]);
  });

  it("refuses two sources that would write the same file", () => {
    /* `x.module.scss` and `x.module.sass` both lower to `x.module.css`.
     * Nothing downstream would catch it — the driver writes each output with a
     * plain write, so the second silently replaces the first. */
    expect(() => buildSassOptions(["a/Foo.module.scss", "a/Foo.module.sass"])).to.throw(/a\/Foo\.module\.css/);
  });

  it("refuses a non-Sass source, which enters at css_postcss", () => {
    expect(() => buildSassOptions(["a/Foo.css"])).to.throw(/'a\/Foo\.css' is not a Sass source/);
  });
});

describe("buildPostcssOptions", () => {
  it("names every stylesheet, carrying the maps beside them rather than listing them", () => {
    const options = buildPostcssOptions(["a/Foo.module.css", "a/Foo.module.css.map", "b.css", "b.css.map"], "pkg", true);
    expect(options.srcRoot).to.equal(CSS_SRC_ROOT);
    expect(options.outdir).to.equal(CSS_OUTDIR);
    expect(options.sources.map(source => source.path)).to.deep.equal(["a/Foo.module.css", "b.css"]);
    /* A module's carried map is its chain input; a passthrough's rides through
     * under its own name. */
    expect(options.sources[0].prev).to.equal("a/Foo.module.css.map");
    expect(options.sources[0].map).to.equal("a/Foo.css.map");
    expect(options.sources[1].map).to.equal("b.css.map");
  });

  it("explains the clash in terms of the two files, not just that there is one", () => {
    /* The reader's first question is why two files they gave different names
     * collide at all — the answer is the '.module' rule, which they may never
     * have met. */
    try {
      buildPostcssOptions(["a/Nav.module.css", "a/Nav.css"], "pkg");
      expect.fail("expected a conflict");
    } catch (err) {
      const help = (err as { help?: string[] }).help ?? [];
      expect(help[0]).to.contain("'Nav.module.css' is a css-module");
      expect(help[0]).to.contain("'.module' marker");
      expect(help[0]).to.contain("'Nav.css'");
      /* By basename: both always sit in one directory, and the full paths are
       * in the message already. */
      expect(help[0]).to.not.contain("a/Nav");
    }
  });

  it("allows stylesheets that merely share a stem across directories", () => {
    expect(() => buildPostcssOptions(["a/Foo.module.css", "b/Foo.css"], "pkg")).to.not.throw();
  });

  it("refuses a Sass source, which enters at sass_compile", () => {
    expect(() => buildPostcssOptions(["a/Foo.scss"], "pkg")).to.throw(/'a\/Foo\.scss' is a Sass source/);
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

  it("points a module's specifier at the shim, and a plain stylesheet's at the stylesheet", () => {
    /* The `.scss` and `.css` spellings of a module answer alike, and neither
     * answers as the plain stylesheet beside them does. */
    expect(apply("a/Foo.module.scss")).to.equal("a/Foo.css.js");
    expect(apply("a/Foo.module.css")).to.equal("a/Foo.css.js");
    expect(apply("a/Foo.scss")).to.equal("a/Foo.css");
  });

  it("leaves a plain .css specifier alone, it already naming the published stylesheet", () => {
    expect(apply("a/Foo.css")).to.equal(undefined);
    /* And the shim's own `import "./Foo.css"` therefore cannot loop back onto
     * the shim. */
    expect(apply("Foo.css")).to.equal(undefined);
  });

  it("puts the module rules first, since a module also matches the plain shape", () => {
    /* `Foo.module.scss` matches `**\/*.scss` too — order decides. */
    expect(apply("Foo.module.scss")).to.equal("Foo.css.js");
  });

  it("applies at the tree root as well as at depth", () => {
    /* `**\/` owns its adjacent slash, so nothing is left with a leading one. */
    expect(apply("Foo.module.scss")).to.equal("Foo.css.js");
    expect(apply("a/b/c/Foo.module.scss")).to.equal("a/b/c/Foo.css.js");
  });

  it("names nothing for a specifier that is not a stylesheet", () => {
    expect(apply("a/Foo.ts")).to.equal(undefined);
    expect(apply("a/Foo.d.ts")).to.equal(undefined);
    expect(apply("a/Foo.json")).to.equal(undefined);
  });

  it("is constant, so a stylesheet added or renamed does not move it", () => {
    /* The point of rules over resolved pairs: this document is action key
     * material, and per-file entries would rebuild the package's whole compile
     * whenever any stylesheet appeared. */
    expect(cssImportRewrites().map(String)).to.deep.equal(cssImportRewrites().map(String));
    expect(cssImportRewrites()).to.have.lengthOf(5);
  });
});
