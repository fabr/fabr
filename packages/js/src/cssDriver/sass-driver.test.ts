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

/* The unit tests pin the shape of what the driver writes beside the lowered
 * CSS. The driver tests run its real main(): the REAL compiler (sass-embedded)
 * and the real importer (@fabr-build/sass-pnp-importer), resolving through the
 * driver's own PnpResolver over a manifest fabr itself writes — the importer's
 * own package tests cover it against Yarn's runtime; these cover it against
 * fabr's. */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileSet, IFile, MemoryFile, PackageFileSet } from "@fabr-build/core";
import type { ISassOptions } from "../CSSCompile";
import { PNP_DATA_FILE } from "../pnp/PnPResolver";
import { pnpManifestOf, TREE_MOUNT, treeMountOf } from "../PnPManifest";
import { relativeToMap, relocateCssSources, sourceMapComment } from "./Support";
import { main, sassFailure } from "./sass-driver";

describe("sassFailure", () => {
  it("attributes a positioned failure 1-based from the exception's 0-based span", () => {
    /* The shape sass-embedded's Exception carries: span.start is a 0-based
     * SourceLocation. */
    const err = { message: "Undefined variable.", span: { start: { offset: 41, line: 2, column: 9 } } };
    assert.equal(sassFailure("a/Foo.scss", err).message, "a/Foo.scss:3:10: sass: Undefined variable.");
  });
  it("attributes a spanless failure to the file alone", () => {
    assert.equal(sassFailure("a/Foo.scss", new Error("compiler exited")).message, "a/Foo.scss: sass: compiler exited");
  });
  it("stringifies a non-Error throw", () => {
    assert.equal(sassFailure("Foo.scss", "boom").message, "Foo.scss: sass: boom");
  });
});

describe("relativeToMap", () => {
  it("spells each source the way a consumer of the map resolves it", () => {
    /* A map is read relative to ITSELF, so a map at `a/Card.css.map` names its
     * sibling source as `Card.module.scss` — a root-relative name there would
     * resolve to `a/a/...`. */
    const out = relativeToMap({ sources: ["a/Card.module.scss", "b/_vars.scss"] }, "a/Card.css.map");
    assert.deepEqual(out.sources, ["Card.module.scss", "../b/_vars.scss"]);
  });
  it("leaves postcss's unattributable placeholder alone", () => {
    assert.deepEqual(relativeToMap({ sources: ["<no source>"] }, "a/x.css.map").sources, ["<no source>"]);
  });
});

describe("a lowered map's sources", () => {
  it("names them as the target names them, not as the staging layout does", () => {
    /* Sass reports absolute `file://` URLs. What this step writes is the name
     * the target uses, so its output is a deliverable tree in its own right
     * rather than a form only the next step can read. */
    const map = { sources: ["file:///work/src/a/Card.module.scss", "file:///work/.fabr-tree/abc/vendor/_mixins.scss"] };
    const out = relocateCssSources(map, { root: "/work", srcRoot: "src", mapDir: "out/a" });
    assert.deepEqual(out.sources, ["a/Card.module.scss", ".fabr-tree/abc/vendor/_mixins.scss"]);
  });
});

describe("sourceMapComment", () => {
  it("names the map by basename, since it sits beside the stylesheet", () => {
    assert.equal(sourceMapComment("a/b/Card.css.map"), "\n/*# sourceMappingURL=Card.css.map */\n");
  });
});


describe("the Sass driver, resolving package loads through fabr's table", () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fabr-sassdriver-")));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  const files = (entries: Record<string, string>): Map<string, IFile> =>
    new Map(Object.entries(entries).map(([name, text]) => [name, MemoryFile.from(text)]));
  const pkg = (name: string, version: string, entries: Record<string, string>, deps: PackageFileSet[] = []): PackageFileSet =>
    new PackageFileSet(files({ "package.json": JSON.stringify({ name, version }), ...entries }), name, version, deps);

  /**
   * Stage a workspace as the step does — the pool mounted as one link, each
   * content's tree once, the manifest beside the sources — then lower `source`
   * and answer the CSS and its map's sources.
   */
  async function lower(deps: PackageFileSet[], source: string): Promise<{ css: string; sources: string[] }> {
    const manifest = pnpManifestOf(deps);
    const store = path.join(root, "store");
    fs.mkdirSync(store);
    fs.symlinkSync(store, path.join(root, TREE_MOUNT));
    for (const each of manifest.packages) {
      for (const [name, file] of each as FileSet) {
        const target = path.join(store, path.basename(treeMountOf(each)), name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, (file as MemoryFile).getBuffer().value as Buffer);
      }
    }
    fs.writeFileSync(path.join(root, PNP_DATA_FILE), manifest.toFile().getBuffer().value as Buffer);
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "app.scss"), source);
    const options: ISassOptions = { sources: [{ path: "app.scss", css: "app.css", map: "app.css.map" }], srcRoot: "src", loadPaths: [], outdir: "out" };
    fs.writeFileSync(path.join(root, "options.json"), JSON.stringify(options));
    const cwd = process.cwd();
    try {
      process.chdir(root);
      await main(["--manifest=options.json"]);
    } finally {
      process.chdir(cwd);
    }
    const map = JSON.parse(fs.readFileSync(path.join(root, "out", "app.css.map"), "utf8")) as { sources: string[] };
    return { css: fs.readFileSync(path.join(root, "out", "app.css"), "utf8"), sources: map.sources };
  }

  it("resolves a package's own loads from the wiring that loaded it", async () => {
    /* `theme` is one content wired two ways — each binding `tokens` to a
     * different package — so the manifest locates each wiring virtually over
     * one tree. Its nested `@use "tokens"` must resolve per wiring. */
    const theme = files({
      "package.json": JSON.stringify({ name: "theme", version: "1.0.0" }),
      "_index.scss": '@forward "./parts/palette";\n',
      "parts/_palette.scss": '@use "tokens";\n.palette-#{tokens.$value} { v: tokens.$value; }\n',
    });
    const tokens = (value: string, version: string): PackageFileSet => pkg("tokens", version, { "_index.scss": `$value: "${value}";\n` });
    const left = pkg("left", "1.0.0", { "_index.scss": '@forward "theme";\n' }, [
      new PackageFileSet(theme, "theme", "1.0.0", [tokens("one", "1.0.0")]),
    ]);
    const right = pkg("right", "1.0.0", { "_index.scss": '@forward "theme";\n' }, [
      new PackageFileSet(theme, "theme", "1.0.0", [tokens("two", "2.0.0")]),
    ]);
    const { css } = await lower([left, right], '@use "left";\n@use "right";\n');
    assert.match(css, /v: "one"/);
    assert.match(css, /v: "two"/);
  });

  it("takes the stylesheet a package's exports map publishes under the sass condition", async () => {
    const design = pkg("design", "1.0.0", {
      "package.json": JSON.stringify({ name: "design", version: "1.0.0", exports: { ".": { sass: "./scss/_main.scss", default: "./index.js" } } }),
      "scss/_main.scss": ".design { v: main; }\n",
      "index.js": "",
    });
    const { css } = await lower([design], '@use "design";\n');
    assert.match(css, /\.design/);
  });

  it("names the real files in the map, never a virtual location", async () => {
    const shared = files({ "package.json": "{}", "_index.scss": '@use "dep";\n.shared { v: dep.$v; }\n' });
    const dep = (version: string): PackageFileSet => pkg("dep", version, { "_index.scss": `$v: "${version}";\n` });
    const a = pkg("a", "1.0.0", { "_index.scss": '@forward "shared";\n' }, [new PackageFileSet(shared, "shared", "1.0.0", [dep("1.0.0")])]);
    const b = pkg("b", "1.0.0", { "_index.scss": '@forward "shared";\n' }, [new PackageFileSet(shared, "shared", "1.0.0", [dep("2.0.0")])]);
    const { sources } = await lower([a, b], '@use "a";\n@use "b";\n.app { v: 1; }\n');
    assert.ok(sources.includes("app.scss"), `the source itself is named as the target names it: ${sources.join(", ")}`);
    assert.ok(
      sources.every(source => !source.includes("__virtual__")),
      `no virtual location reaches the map: ${sources.join(", ")}`
    );
    assert.ok(
      sources.some(source => source.startsWith(`${TREE_MOUNT}/`) && source.endsWith("/_index.scss")),
      `a package's file is named by its tree: ${sources.join(", ")}`
    );
  });
});
