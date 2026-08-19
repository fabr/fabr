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

/* The single-variant cases below drive the REAL esbuild, which is a test
 * dependency of this package for exactly that reason (as typescript is for the
 * tsc driver's): the rule they check is a claim about what esbuild does with a
 * package's export conditions, and a stub asked to confirm it would only
 * confirm itself. Pinned to the version `ESBUILD` names, in both the catalog
 * and package.json, so the claim is about the bundler fabr actually runs and
 * cannot hold under one test runner and fail under the other. Importing the
 * driver module is still safe either way — esbuild is required lazily inside
 * main(), not at load. */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isBareSpecifier, main, packageOf, rewriteStyledImport, unresolvedHelp } from "./bundle-driver";

describe("packageOf", () => {
  it("takes the first segment of an unscoped specifier", () => {
    assert.equal(packageOf("lodash"), "lodash");
    assert.equal(packageOf("lodash/fp/merge"), "lodash");
  });

  it("takes the first two segments of a scoped specifier", () => {
    assert.equal(packageOf("@aws-sdk/client-s3"), "@aws-sdk/client-s3");
    assert.equal(packageOf("@aws-sdk/client-s3/dist/index.js"), "@aws-sdk/client-s3");
  });
});

describe("isBareSpecifier", () => {
  it("treats package names as bare", () => {
    assert.equal(isBareSpecifier("react"), true);
    assert.equal(isBareSpecifier("@scope/pkg"), true);
  });

  it("treats relative and absolute paths as not bare", () => {
    assert.equal(isBareSpecifier("./local"), false);
    assert.equal(isBareSpecifier("../up"), false);
    assert.equal(isBareSpecifier("/abs/path"), false);
  });
});

describe("rewriteStyledImport", () => {
  it("maps a Sass css-module import to its lowered .module.css", () => {
    /* The stylesheet itself, not a proxy: esbuild's local-css loader scopes it
     * and hands the importing JS the class-name map, so nothing needs to be
     * synthesized in between. */
    assert.equal(rewriteStyledImport("./Foo.module.scss"), "./Foo.module.css");
    assert.equal(rewriteStyledImport("../a/Foo.module.sass"), "../a/Foo.module.css");
  });

  it("maps a plain Sass import to its compiled .css", () => {
    assert.equal(rewriteStyledImport("./styles.scss"), "./styles.css");
    assert.equal(rewriteStyledImport("./styles.sass"), "./styles.css");
  });

  it("leaves plain .css (incl. an already-lowered .module.css) unchanged", () => {
    assert.equal(rewriteStyledImport("./Foo.module.css"), "./Foo.module.css");
    assert.equal(rewriteStyledImport("./app.css"), "./app.css");
  });

  it("leaves non-styled specifiers unchanged", () => {
    assert.equal(rewriteStyledImport("./util.js"), "./util.js");
    assert.equal(rewriteStyledImport("react"), "react");
  });
});

describe("unresolvedHelp", () => {
  it("adds the srcs/deps guidance for a specifier esbuild reported", () => {
    const message = 'Could not resolve "left-pad"';
    const helped = unresolvedHelp(message, ["left-pad"]);
    assert.ok(helped.startsWith(message));
    assert.ok(helped.includes("fabr: 'left-pad' is neither bundled"));
  });

  it("says nothing about one esbuild tolerated", () => {
    /* An optional require inside a try/catch is declined by the plugin and then
     * allowed by esbuild, so it never reaches the report — and must not be
     * advised about, or every such probe would read as a missing dependency. */
    const helped = unresolvedHelp('Could not resolve "left-pad"', ["left-pad", "@emotion/is-prop-valid"]);
    assert.ok(!helped.includes("is-prop-valid"));
  });

  it("leaves a failure of its own unchanged", () => {
    const message = 'Could not resolve "./missing.css"';
    assert.equal(unresolvedHelp(message, ["left-pad"]), message);
  });
});

/**
 * One bundle over a package that publishes a different file per condition,
 * imported both ways.
 *
 * The dual-package hazard is what this is about: node's conditions let one
 * package resolve to two different files in one program, and a bundler that
 * honours the importer's kind per site will inline BOTH — two module instances,
 * separate state, `instanceof` failing across the seam, and a bug that appears
 * only once some transitive dependency happens to require what another
 * imported. The driver's answer is to normalize every bare specifier to the
 * bundle's own format and reuse that answer, so the choice cannot depend on who
 * is asking.
 */
describe("the bundle driver's single-variant rule, over real esbuild", () => {
  let work: string;

  beforeEach(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-variant-"));
    /* One package reached two ways: an ESM importer and a CJS importer of the
     * same name, in one graph. Each face carries a marker, so which of them the
     * bundle ended up holding is readable in the output. */
    fs.mkdirSync(path.join(work, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(work, "viaImport.mjs"), 'import { face } from "dualpkg";\nexport const fromImport = face;\n');
    fs.writeFileSync(path.join(work, "viaRequire.cjs"), 'const { face } = require("dualpkg");\nmodule.exports.fromRequire = face;\n');
    /* Both values are USED, or tree-shaking would decide the question. */
    fs.writeFileSync(
      path.join(work, "entry.mjs"),
      'import { fromImport } from "./viaImport.mjs";\nimport mod from "./viaRequire.cjs";\nconsole.log(fromImport, mod.fromRequire);\n'
    );
  });

  afterEach(() => {
    fs.rmSync(work, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  /** Install `dualpkg` with the given `exports` map, both faces present. */
  function publishing(exports: unknown): void {
    const pkg = path.join(work, "node_modules/dualpkg");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "dualpkg", version: "1.0.0", exports }));
    fs.writeFileSync(path.join(pkg, "esm.mjs"), 'export const face = "ESM_COPY";\n');
    fs.writeFileSync(path.join(pkg, "cjs.cjs"), 'module.exports = { face: "CJS_COPY" };\n');
  }

  /** Bundle in `format` and answer which faces of the package came out. */
  async function facesIn(format: "cjs" | "esm"): Promise<string[]> {
    const options = {
      entries: [{ in: "entry.mjs", out: `bundle-${format}` }],
      external: [],
      platform: "node",
      format,
      target: "es2021",
      minify: false,
      sourcemap: false,
      outdir: `out-${format}`,
    };
    fs.writeFileSync(path.join(work, `options-${format}.json`), JSON.stringify(options));
    const cwd = process.cwd();
    try {
      process.chdir(work);
      await main([`--options=options-${format}.json`]);
    } finally {
      process.chdir(cwd);
    }
    assert.equal(process.exitCode ?? 0, 0, "the bundle should have succeeded");
    const bundled = fs.readFileSync(path.join(work, `out-${format}`, `bundle-${format}.js`), "utf8");
    return ["ESM_COPY", "CJS_COPY"].filter(marker => bundled.includes(marker));
  }

  it("inlines one variant however its importers spell the import", async () => {
    publishing({ ".": { import: "./esm.mjs", require: "./cjs.cjs" } });
    /* The bundle's own format decides, and decides once: the `import` site does
     * not get its own copy just for asking differently. */
    assert.deepEqual(await facesIn("cjs"), ["CJS_COPY"]);
    assert.deepEqual(await facesIn("esm"), ["ESM_COPY"]);
  });

  it("stays single when the package publishes a synchronously-loadable entry", async () => {
    /* `module-sync` is the ecosystem's own cure for the hazard — one ESM file
     * that a require may load — and the driver resolves it (node 22 and later
     * do). Both formats must still land on that one file: a condition that
     * matches from either direction is only worth having if it collapses the
     * two, and it would be worth nothing if it forked them instead. */
    publishing({ ".": { "module-sync": "./esm.mjs", require: "./cjs.cjs" } });
    assert.deepEqual(await facesIn("cjs"), ["ESM_COPY"]);
    assert.deepEqual(await facesIn("esm"), ["ESM_COPY"]);
  });

  it("takes the one face a single-condition package publishes, whatever the format", async () => {
    /* The other kind: a package with nothing to choose between. The native kind
     * finds nothing and the fallback answers, so a CJS-only package still
     * bundles into an ESM output rather than failing on the kind it was asked
     * under. */
    publishing({ ".": { require: "./cjs.cjs" } });
    assert.deepEqual(await facesIn("esm"), ["CJS_COPY"]);
  });
});
