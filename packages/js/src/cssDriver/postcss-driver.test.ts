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
 */

/* The integration half of this suite drives the REAL postcss + postcss-modules
 * (from test_deps / devDependencies, pinned to the same versions the JS.fabr
 * globals name): the css-modules dialect is the plugin set's, so what these
 * tests pin is what THAT set does with fabr's hooks — above all cross-file
 * `composes`, where every class must ship under its own file's scope. */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import postcss from "postcss";
import type { IPostcssOptions, IPostcssSource } from "../CSSCompile";
import { cssModuleShim, main, resolveComposePath, scopedNameOf, scopeFailure, scopeTableOf } from "./postcss-driver";
import { relocateCssSources } from "./Support";

describe("cssModuleShim", () => {
  it("imports its own stylesheet by basename and exports the map as a default", () => {
    const shim = cssModuleShim("a/b/Card.css", { card: "card_k3f1c", "header-bar": "header-bar_k3f1c" });
    /* The specifier is a SIBLING reference: the shim is written beside the css
     * it belongs to, so its own directory is the only thing it can name. */
    assert.match(shim, /^import "\.\/Card\.css";$/m);
    assert.match(shim, /^ {2}"card": "card_k3f1c",$/m);
    /* A name that is not a TS identifier survives, quoted. */
    assert.match(shim, /^ {2}"header-bar": "header-bar_k3f1c",$/m);
    assert.match(shim, /^export default styles;$/m);
  });

  it("orders its entries canonically, so the same map is the same bytes", () => {
    const one = cssModuleShim("x.css", { b: "b_1", a: "a_1" });
    const two = cssModuleShim("x.css", { a: "a_1", b: "b_1" });
    assert.equal(one, two);
  });
});

describe("relocateCssSources", () => {
  /* As the driver calls it for `a/Card.css`: inputs staged under `src`, the map
   * written next to its stylesheet under `out`. */
  const where = { root: "/work", srcRoot: "src", mapDir: "out/a" };
  const map = (...sources: string[]): { sources: string[] } => ({ sources });

  it("names a chained source as the target names it", () => {
    /* The entry arrives spelled relative to the output map's directory; it
     * resolves into the staged tree, and the staging root is fabr's word, not
     * the project's. */
    const out = relocateCssSources(map("../../src/a/Card.module.scss"), where);
    assert.deepEqual(out.sources, ["a/Card.module.scss"]);
  });

  it("renames the step's own input to the stylesheet it publishes, where the input is an intermediate", () => {
    /* Chained, postcss adds an entry for the content it was HANDED — the
     * lowered CSS, a name that never ships. */
    const out = relocateCssSources(map("../../src/a/Card.module.scss", "../../src/a/Card.module.css"), where, {
      path: "a/Card.module.css",
      rename: "a/Card.css",
    });
    assert.deepEqual(out.sources, ["a/Card.module.scss", "a/Card.css"]);
  });

  it("leaves an unchained run's own input named as the source it really is", () => {
    /* A `.module.css` never went near Sass, so postcss's input IS the source
     * and keeps its own name. */
    const out = relocateCssSources(map("../../src/a/Card.module.css"), where);
    assert.deepEqual(out.sources, ["a/Card.module.css"]);
  });

  it("carries no host path, whatever the file was", () => {
    /* The first design rule: nothing machine-specific may reach an artifact. A
     * dependency's stylesheet keeps its working-root-relative (and so
     * content-addressed) path. */
    const out = relocateCssSources(map("../../.fabr-tree/abc123/vendor/_mixins.scss"), where);
    assert.deepEqual(out.sources, [".fabr-tree/abc123/vendor/_mixins.scss"]);
    assert.equal(JSON.stringify(out).includes("/work"), false);
    /* A file outside the working root altogether keeps only its basename. */
    assert.deepEqual(relocateCssSources(map("file:///elsewhere/x.scss"), where).sources, ["x.scss"]);
  });
});

describe("scopeFailure", () => {
  it("attributes a positioned failure to the file being processed", () => {
    /* postcss's CssSyntaxError shape: a reason plus 1-based coordinates. */
    const err = { reason: "Unclosed block", line: 4, column: 2 };
    assert.equal(scopeFailure("a/Foo.module.css", err).message, "a/Foo.module.css:4:2: css-modules: Unclosed block");
  });
  it("attributes a positionless failure to the file alone", () => {
    assert.equal(
      scopeFailure("a/Foo.module.css", new Error("plugin blew up")).message,
      "a/Foo.module.css: css-modules: plugin blew up"
    );
  });
  it("names the origin where the input's own map supplies one", () => {
    /* Sass ran first: the error's `input` member is the position mapped
     * through the input's annotation — the file and line the author wrote. */
    const err = { reason: "Unclosed block", line: 9, column: 1, input: { file: "/work/src/a/Foo.module.scss", line: 4, column: 2 } };
    assert.equal(
      scopeFailure("a/Foo.module.css", err, { root: "/work", srcRoot: "src" }).message,
      "a/Foo.module.scss:4:2: css-modules: Unclosed block"
    );
  });
});

describe("the compose hooks", () => {
  const options: IPostcssOptions = {
    sources: [
      { path: "a/one.module.css", css: "a/one.css", scope: "s1", module: true },
      { path: "a/two.module.css", css: "a/two.css", scope: "s2", module: true },
      { path: "a/plain.css", css: "a/plain.css", scope: "sPlain", module: false },
    ],
    composable: [],
    srcRoot: "/work/src",
    depsDir: "/work/node_modules",
    outdir: "/work/out",
  };
  const table = scopeTableOf(options);

  it("scopes every class with its own file's scope, whichever file's run names it", () => {
    assert.equal(scopedNameOf(table, options.srcRoot, "card", "/work/src/a/one.module.css"), "card_s1");
    assert.equal(scopedNameOf(table, options.srcRoot, "base", "/work/src/a/two.module.css"), "base_s2");
  });

  it("scopes a global stylesheet's classes too, where a compose reaches them", () => {
    /* Its own output keeps `x` as written; this name is for the private copy
     * the importer inlines. */
    assert.equal(scopedNameOf(table, options.srcRoot, "x", "/work/src/a/plain.css"), "x_sPlain");
  });

  it("refuses to scope a file that is no stylesheet of the compilation", () => {
    assert.throws(
      () => scopedNameOf(table, options.srcRoot, "x", "/work/src/a/elsewhere.css"),
      /'a\/elsewhere\.css' is not a stylesheet of this compilation/
    );
  });

  it("maps a Sass-spelled compose specifier to the lowered input beside the importer", () => {
    /* The same source-name → lowered-name rule the sass step's delegating
     * declarations encode. */
    assert.equal(
      resolveComposePath(table, options.srcRoot, "./two.module.scss", "/work/src/a/one.module.css", options.depsDir),
      path.resolve("/work/src/a/two.module.css")
    );
    assert.equal(
      resolveComposePath(table, options.srcRoot, "./two.module.css", "/work/src/a/one.module.css", options.depsDir),
      path.resolve("/work/src/a/two.module.css")
    );
  });

  it("reaches a package dependency's stylesheet, mounted under the deps dir", () => {
    /* `pkg/base.css` is not relative, so it names a package rather than a
     * sibling — resolved under the mount the options name. */
    const withDep = scopeTableOf({ ...options, composable: [{ path: "/work/node_modules/ds/base.css", scope: "sDS" }] });
    assert.equal(
      resolveComposePath(withDep, options.srcRoot, "ds/base.css", "/work/src/a/one.module.css", options.depsDir),
      path.resolve("/work/node_modules/ds/base.css")
    );
    assert.equal(scopedNameOf(withDep, options.srcRoot, "base", "/work/node_modules/ds/base.css"), "base_sDS");
  });

  it("reaches a global stylesheet of the same step", () => {
    assert.equal(
      resolveComposePath(table, options.srcRoot, "./plain.css", "/work/src/a/one.module.css", options.depsDir),
      path.resolve("/work/src/a/plain.css")
    );
  });

  it("refuses a compose from anything this target can reach", () => {
    /* A Sass partial produces no stylesheet, and an unmounted package's file is
     * not here at all. One refusal, at the resolve seam — never a bare ENOENT,
     * and naming both legal sources. */
    assert.throws(
      () => resolveComposePath(table, options.srcRoot, "./_vars.module.scss", "/work/src/a/one.module.css", options.depsDir),
      /does not name a stylesheet this target can reach/
    );
    assert.throws(
      () => resolveComposePath(table, options.srcRoot, "absent/x.css", "/work/src/a/one.module.css", options.depsDir),
      /a class composes from a stylesheet of the same target, or one a package dependency delivers/
    );
  });
});

/* ------------------------------------------------------------------------- *
 * Integration: the real postcss + postcss-modules over staged fixtures.
 * ------------------------------------------------------------------------- */

describe("postcss-driver, over the real plugin set", () => {
  let work: string;

  beforeEach(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-postcss-"));
  });

  afterEach(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  /** Stage `files` under src/, run the driver over `sources`, and read back.
   * `deps` stages a package's delivered stylesheets under the deps dir, named
   * `<pkg>/<file>` exactly as a specifier spells them. */
  async function run(
    files: Record<string, string>,
    sources: IPostcssSource[],
    deps: Record<string, string> = {}
  ): Promise<(name: string) => string> {
    const srcRoot = path.join(work, "src");
    const outdir = path.join(work, "out");
    const depsDir = path.join(work, "node_modules");
    for (const [name, text] of Object.entries(deps)) {
      const dest = path.join(depsDir, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, text);
    }
    for (const [name, text] of Object.entries(files)) {
      const dest = path.join(srcRoot, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, text);
    }
    const manifest = path.join(work, "postcss-manifest.json");
    const composable = Object.keys(deps).map(name => ({ path: path.join(depsDir, name), scope: "sDep" }));
    const options: IPostcssOptions = { sources, composable, srcRoot, depsDir, outdir };
    fs.writeFileSync(manifest, JSON.stringify(options));
    await main([`--manifest=${manifest}`]);
    return name => fs.readFileSync(path.join(outdir, name), "utf8");
  }

  /** A module entry with every output named, the way the rule names them. */
  function module(stem: string, scope: string): IPostcssSource {
    return {
      path: `${stem}.module.css`,
      css: `${stem}.css`,
      scope,
      module: true,
      shim: `${stem}.css.ts`,
    };
  }

  it("scopes a module and writes the typed shim", async () => {
    const out = await run(
      { "a/card.module.css": ".card { color: red; }\n.header-bar { color: blue; }\n" },
      [module("a/card", "k3f1c")]
    );
    assert.match(out("a/card.css"), /\.card_k3f1c \{/);
    assert.match(out("a/card.css"), /\.header-bar_k3f1c \{/);
    /* The shim is TypeScript, and states the map's type as well as its values —
     * so tsc's declaration of it carries `readonly` and nothing restates the
     * map alongside. */
    const shim = out("a/card.css.ts");
    assert.match(shim, /^import "\.\/card\.css";$/m);
    assert.match(shim, /readonly "card": string;/);
    assert.match(shim, /"card": "card_k3f1c"/);
    /* Both spellings, literal and camelCase. */
    assert.match(shim, /"header-bar": "header-bar_k3f1c"/);
    assert.match(shim, /"headerBar": "header-bar_k3f1c"/);
  });

  it("composes across files, each class under its own file's scope", async () => {
    const out = await run(
      {
        "a.module.css": ".fancy { composes: base from './b.module.css'; color: red; }\n",
        "b.module.css": ".base { padding: 8px; }\n",
      },
      [module("a", "sA"), module("b", "sB")]
    );
    /* The composed token pairs a's own class with the name b actually
     * declares: each side is scoped by its OWN file, not the importer's. */
    assert.match(out("a.css.ts"), /"fancy": "fancy_sA base_sB"/);
    assert.match(out("b.css"), /\.base_sB \{/);
    /* `composes` never survives into emitted CSS; the reference plugin instead
     * INLINES the composed file's scoped rules ahead of the importer's own, so
     * the importer's stylesheet is self-sufficient — under the same scope b's
     * own output declares, so the duplicate is idempotent. */
    assert.equal(out("a.css").includes("composes"), false);
    assert.match(out("a.css"), /\.base_sB \{ padding: 8px; \}[\s\S]*\.fancy_sA \{/);
    /* Nothing staging-named rides along with the inline. */
    assert.equal(out("a.css").includes("sourceMappingURL"), false);
  });

  it("composes from a package dependency's stylesheet", async () => {
    /* `ds/base.css` is a delivered file of another package, mounted under the
     * deps dir — readable and composable, but no output of this step. */
    const out = await run(
      { "a.module.css": ".fancy { composes: base from 'ds/base.css'; color: red; }\n" },
      [module("a", "sA")],
      { "ds/base.css": ".base { padding: 8px; }\n" }
    );
    /* The dep ships its classes as written; what a compose takes is a scoped
     * PRIVATE copy, inlined into the importer, so the token names that copy. */
    assert.match(out("a.css.ts"), /"fancy": "fancy_sA base_sDep"/);
    assert.match(out("a.css"), /\.base_sDep \{ padding: 8px; \}[\s\S]*\.fancy_sA \{/);
    /* The dependency is an input, never an output: nothing of it is published
     * under its own name. */
    assert.equal(fs.existsSync(path.join(work, "out", "ds")), false);
  });

  it("composes from a Sass-spelled specifier, resolved to the lowered input", async () => {
    /* The author wrote `.scss`; by this step the file exists only lowered. */
    const out = await run(
      {
        "a.module.css": ".fancy { composes: base from './b.module.scss'; }\n",
        "b.module.css": ".base { padding: 8px; }\n",
      },
      [module("a", "sA"), module("b", "sB")]
    );
    assert.match(out("a.css.ts"), /"fancy": "fancy_sA base_sB"/);
  });

  it("carries a transitive compose chain through", async () => {
    const out = await run(
      {
        "a.module.css": ".top { composes: mid from './b.module.css'; }\n",
        "b.module.css": ".mid { composes: low from './c.module.css'; color: green; }\n",
        "c.module.css": ".low { padding: 1px; }\n",
      },
      [module("a", "sA"), module("b", "sB"), module("c", "sC")]
    );
    assert.match(out("a.css.ts"), /"top": "top_sA mid_sB low_sC"/);
    assert.match(out("b.css.ts"), /"mid": "mid_sB low_sC"/);
  });

  it("composes from a global stylesheet, which keeps its own names unscoped", async () => {
    /* The plugin INLINES the composed rules, so the scoped name the token
     * carries is declared in the importer's own output. The global stylesheet
     * is untouched by that — it still ships the names it was written with, for
     * everything that imports it directly. */
    const out = await run(
      {
        "a.module.css": ".fancy { composes: base from './plain.css'; color: blue; }\n",
        "plain.css": ".base { padding: 8px; }\n",
      },
      [module("a", "sA"), { path: "plain.css", css: "plain.css", scope: "sPlain", module: false }]
    );
    assert.match(out("a.css.ts"), /"fancy": "fancy_sA base_sPlain"/);
    assert.match(out("a.css"), /\.base_sPlain \{/);
    assert.equal(out("plain.css"), ".base { padding: 8px; }\n");
  });

  it("ships only the annotation it wrote, whatever its input carried", async () => {
    /* An input's annotation names ITS map, which is a different file from the
     * one this step publishes — `card.module.css.map` is an input here and is
     * never delivered. Reachable from an authored stylesheet, and from every
     * stylesheet once an earlier step annotates its own output. */
    const out = await run(
      { "card.module.css": ".card { color: red; }\n/*# sourceMappingURL=card.module.css.map */\n" },
      [{ path: "card.module.css", css: "card.css", map: "card.css.map", scope: "sC", module: true, shim: "card.css.ts" }]
    );
    const css = out("card.css");
    assert.equal(css.includes("card.module.css.map"), false);
    assert.equal(css.match(/sourceMappingURL/g)?.length, 1);
    assert.match(css, /sourceMappingURL=card\.css\.map/);
  });

  it("ships no annotation at all where it writes no map", async () => {
    /* A release build carries no maps, so an input's annotation would name a
     * file nothing delivers. */
    const out = await run(
      { "card.module.css": ".card { color: red; }\n/*# sourceMappingURL=card.module.css.map */\n" },
      [{ path: "card.module.css", css: "card.css", scope: "sC", module: true, shim: "card.css.ts" }]
    );
    assert.equal(out("card.css").includes("sourceMappingURL"), false);
  });

  it("drops a composed stylesheet's annotation, which rides in with its rules", async () => {
    /* `composes` inlines the composed file's rules as TEXT, so its annotation
     * arrives with them — mid-stylesheet, naming another file's map. */
    const out = await run(
      {
        "a.module.css": ".fancy { composes: base from './b.module.css'; }\n",
        "b.module.css": ".base { padding: 8px; }\n/*# sourceMappingURL=b.module.css.map */\n",
      },
      [
        { path: "a.module.css", css: "a.css", map: "a.css.map", scope: "sA", module: true, shim: "a.css.ts" },
        { path: "b.module.css", css: "b.css", map: "b.css.map", scope: "sB", module: true, shim: "b.css.ts" },
      ]
    );
    assert.equal(out("a.css").includes("b.module.css.map"), false);
    assert.match(out("a.css"), /sourceMappingURL=a\.css\.map/);
  });

  it("refuses a compose from a file the target cannot reach", async () => {
    await assert.rejects(
      run({ "a.module.css": ".fancy { composes: base from './missing.module.css'; }\n" }, [module("a", "sA")]),
      /composes: '\.\/missing\.module\.css' \(in 'a\.module\.css'\) does not name a stylesheet this target can reach/
    );
  });

  it("copies a plain stylesheet through unchanged", async () => {
    const text = ".a { color: red; }\n/* keep me */\n";
    const out = await run({ "b/plain.css": text }, [
      { path: "b/plain.css", css: "b/plain.css", scope: "sPlain", module: false },
    ]);
    assert.equal(out("b/plain.css"), text);
  });

  it("relocates and annotates the map carried beside a passthrough stylesheet", async () => {
    /* A lowered plain stylesheet with its map beside it. The published map
     * names its source the way a consumer resolves it — relative to the map —
     * so `w/theme.css.map` names the sibling `theme.scss`. */
    const out = await run(
      {
        "w/theme.css": ".page { margin: 0; }\n",
        "w/theme.css.map": JSON.stringify({ version: 3, sources: ["../../src/w/theme.scss"], mappings: "AAAA" }),
      },
      [{ path: "w/theme.css", css: "w/theme.css", map: "w/theme.css.map", scope: "sTheme", module: false }]
    );
    assert.match(out("w/theme.css"), /sourceMappingURL=theme\.css\.map/);
    assert.deepEqual((JSON.parse(out("w/theme.css.map")) as { sources: string[] }).sources, ["theme.scss"]);
  });

  it("chains the map through the input's own, back to the author's file", async () => {
    /* The intermediate as the sass step writes it: lowered CSS with its map
     * beside it, sources spelled relative to the map's own directory (out/w in
     * the sass step — which resolves identically from src/w here, the roots
     * mirroring depth for depth). A real postcss run supplies valid mappings
     * for the fixture. */
    const lowered = await postcss([]).process(".card { color: red; }\n", {
      from: "w/card.module.scss",
      to: "w/card.module.css",
      map: { inline: false, annotation: false },
    });
    const prev = lowered.map.toJSON();
    prev.sources = ["../../src/w/card.module.scss"];
    /* A rule the prev map does not cover — the residue Sass leaves unmapped
     * (closing braces), which is what makes postcss name its own input. */
    const unmapped = "\n.extra { margin: 0; }\n";
    const out = await run(
      {
        "w/card.module.css": `${lowered.css}${unmapped}`,
        "w/card.module.css.map": JSON.stringify(prev),
      },
      [{ ...module("w/card", "sW"), prev: "w/card.module.css.map", map: "w/card.css.map" }]
    );
    const shipped = JSON.parse(out("w/card.css.map")) as { sources: string[] };
    /* The chained source keeps the author's name; the step's own input — an
     * intermediate that never ships — is renamed to the stylesheet published. */
    assert.deepEqual([...shipped.sources].sort(), ["card.css", "card.module.scss"]);
    assert.equal(JSON.stringify(shipped).includes(work), false);
    assert.match(out("w/card.css"), /sourceMappingURL=card\.css\.map/);
  });

  it("names an unchained module's map source as the module itself", async () => {
    const out = await run({ "w/card.module.css": ".card { color: red; }\n" }, [
      { ...module("w/card", "sW"), map: "w/card.css.map" },
    ]);
    const shipped = JSON.parse(out("w/card.css.map")) as { sources: string[] };
    assert.deepEqual(shipped.sources, ["card.module.css"]);
  });
});
