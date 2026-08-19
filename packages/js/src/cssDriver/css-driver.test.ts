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

/* The CSS driver requires sass-embedded lazily, inside main() — so nothing here
 * needs it, and these run under jest as well as under the fabr test harness.
 * What they pin is the driver's own resolution policy, which follows dart-sass's
 * NodePackageImporter rather than node's rules (see packageImporter). */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { IPnpPackageInfo, IPnpSerializedState } from "../PnPManifest";
import { PnpResolver } from "../pnp/PnPResolver";
import { isPartial, isSass, packageImporter, plainCssName, SASS_CONDITIONS, sassFailure } from "./css-driver";

describe("isSass", () => {
  it("matches .scss/.sass including modules", () => {
    assert.equal(isSass("Foo.scss"), true);
    assert.equal(isSass("Foo.module.scss"), true);
    assert.equal(isSass("Foo.sass"), true);
  });
  it("rejects plain css", () => {
    assert.equal(isSass("Foo.css"), false);
    assert.equal(isSass("Foo.module.css"), false);
  });
});

describe("output name mapping", () => {
  it("maps a plain sass source to .css", () => {
    assert.equal(plainCssName("a/Foo.scss"), "a/Foo.css");
    assert.equal(plainCssName("Foo.sass"), "Foo.css");
  });
  it("maps a module source to a .module.css, for esbuild to scope", () => {
    assert.equal(plainCssName("a/Foo.module.scss"), "a/Foo.module.css");
    assert.equal(plainCssName("Foo.module.sass"), "Foo.module.css");
  });
});

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

describe("isPartial", () => {
  it("matches an underscore-prefixed basename at any depth", () => {
    assert.equal(isPartial("_foo.scss"), true);
    assert.equal(isPartial("a/b/_foo.scss"), true);
  });
  it("rejects a non-partial under an underscore-prefixed directory", () => {
    assert.equal(isPartial("foo.scss"), false);
    assert.equal(isPartial("_dir/foo.scss"), false);
  });
});

describe("packageImporter", () => {
  const root = path.resolve("/workspace");
  const entry = (reference: string, dependencies: Record<string, string>): [string, IPnpPackageInfo] => [
    reference,
    {
      packageLocation: `./.fabr-tree/${reference}/`,
      packageDependencies: Object.entries(dependencies),
      linkType: "HARD",
    },
  ];
  /* Two deliveries of one design-system: the compilation's own, and the older
   * one `@shorthand/common` was resolved against — the case a table exists for. */
  const state: IPnpSerializedState = {
    __info: [],
    dependencyTreeRoots: [],
    enableTopLevelFallback: true,
    ignorePatternData: null,
    fallbackExclusionList: [],
    fallbackPool: [["@shorthand/fonts", "ref-fonts"]],
    packageRegistryData: [
      [
        null,
        [
          [
            null,
            {
              packageLocation: "./",
              packageDependencies: [
                ["@shorthand/design-system", "ref-new"],
                ["@shorthand/common", "ref-common"],
                ["@shorthand/fonts", "ref-fonts"],
              ],
              linkType: "SOFT",
            },
          ],
        ],
      ],
      ["@shorthand/design-system", [entry("ref-new", {}), entry("ref-old", {})]],
      ["@shorthand/common", [entry("ref-common", { "@shorthand/design-system": "ref-old" })]],
      ["@shorthand/fonts", [entry("ref-fonts", {})]],
    ],
  };
  const importer = packageImporter(new PnpResolver(state, root, SASS_CONDITIONS));
  /** A load written in `file`, as Sass reports it. */
  const load = (url: string, file: string): string | null => {
    const found = importer.findFileUrl(url, { containingUrl: pathToFileURL(path.resolve(root, file)), fromImport: false });
    return found === null ? null : fileURLToPath(found);
  };

  it("resolves a package load to its directory, leaving the file part to sass", () => {
    /* A directory, not a file: `_colours.scss`, `colours/_index.scss` and the
     * extension search are sass's own business below this point. */
    assert.equal(
      load("@shorthand/design-system/colours", "src/theme.scss"),
      path.join(root, ".fabr-tree/ref-new/colours")
    );
    /* A package named with no subpath resolves to the package root. */
    assert.equal(load("@shorthand/fonts", "src/theme.scss"), path.join(root, ".fabr-tree/ref-fonts"));
  });

  it("answers from the row of the package the load is WRITTEN IN, not the top level", () => {
    /* The whole point of a table: a stylesheet inside a dependency sees what
     * that dependency was resolved against, even where the compilation itself
     * resolved the same name differently. */
    assert.equal(
      load("@shorthand/design-system/colours", ".fabr-tree/ref-common/mixins.scss"),
      path.join(root, ".fabr-tree/ref-old/colours")
    );
  });

  it("falls back to the declared surface for a name the asking package never declared", () => {
    /* `@shorthand/common` declares no fonts; the compilation does. Same
     * forgiveness the type sidecars get, and scoped the same way. */
    assert.equal(
      load("@shorthand/fonts/body", ".fabr-tree/ref-common/mixins.scss"),
      path.join(root, ".fabr-tree/ref-fonts/body")
    );
  });

  it("declines a bare name that is no package, leaving sass to resolve it", () => {
    /* `@use "variables"` resolves beside the importing file (or under a load
     * path) — sass's own rule, which this must not pre-empt. */
    assert.equal(load("variables", "src/theme.scss"), null);
    assert.equal(load("utilities/spacing", "src/theme.scss"), null);
    /* Nor is anything answerable when sass cannot say where the load came from. */
    assert.equal(importer.findFileUrl("@shorthand/fonts", { containingUrl: null, fromImport: false }), null);
  });

  it("refuses a webpack-style '~' load, naming the fix", () => {
    /* `~` is a bundler convention, not a sass one: accepting it would make
     * stylesheets that build only under fabr. */
    assert.throws(
      () => load("~@shorthand/design-system/colours", "src/theme.scss"),
      /uses the webpack '~' prefix.*write the package name directly \('@shorthand\/design-system\/colours'\)/
    );
  });
});

describe("packageImporter, over packages that publish an exports map", () => {
  let store: string;

  beforeEach(() => {
    store = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-cssexports-"));
  });

  afterEach(() => {
    fs.rmSync(store, { recursive: true, force: true });
  });

  /** A package in the store, with the manifest the case is about. */
  function pkg(reference: string, manifest: Record<string, unknown>): void {
    fs.mkdirSync(path.join(store, reference), { recursive: true });
    fs.writeFileSync(path.join(store, reference, "package.json"), JSON.stringify({ name: reference, version: "1.0.0", ...manifest }));
  }

  /** An importer over the store, with a row for each name given. */
  function importing(...names: Array<[string, string]>): (url: string, file: string) => string | null {
    const declared = Object.entries(Object.fromEntries(names));
    const state: IPnpSerializedState = {
      __info: [],
      dependencyTreeRoots: [],
      enableTopLevelFallback: true,
      ignorePatternData: null,
      fallbackExclusionList: [],
      fallbackPool: declared,
      packageRegistryData: [
        [null, [[null, { packageLocation: "./", packageDependencies: declared, linkType: "SOFT" }]]],
        ...names.map(([name, reference]): [string, Array<[string, IPnpPackageInfo]>] => [
          name,
          [[reference, { packageLocation: `./${reference}/`, packageDependencies: declared, linkType: "HARD" }]],
        ]),
      ],
    };
    const importer = packageImporter(new PnpResolver(state, store, SASS_CONDITIONS));
    return (url, file) => {
      const found = importer.findFileUrl(url, { containingUrl: pathToFileURL(path.resolve(store, file)), fromImport: false });
      return found === null ? null : fileURLToPath(found);
    };
  }

  it("takes the sass face of a package that publishes several", () => {
    /* A design system shipping both compiled CSS and its Sass sources names them
     * apart by condition — and a stylesheet wants the sources, or `@use` has
     * nothing to work with. */
    pkg("ref-ds", {
      exports: { "./colours": { sass: "./src/_colours.scss", style: "./dist/colours.css", default: "./dist/colours.css" } },
    });
    const load = importing(["@shorthand/design-system", "ref-ds"]);
    assert.equal(load("@shorthand/design-system/colours", "theme.scss"), path.join(store, "ref-ds/src/_colours.scss"));
  });

  it("keeps handing back the directory for a package that publishes no map", () => {
    /* Nothing to say, so nothing said: sass's partial/index/extension search is
     * what resolves it, exactly as before. */
    pkg("ref-plain", {});
    const load = importing(["plain", "ref-plain"]);
    assert.equal(load("plain/colours", "theme.scss"), path.join(store, "ref-plain/colours"));
  });

  it("falls through to the directory for a load the map does not publish", () => {
    /* dart-sass's own NodePackageImporter treats a map as a first choice, not a
       gate: a load it does not publish goes to the ordinary directory search.
       `exports` encapsulates a package's JavaScript — Sass never agreed to
       that, and enforcing it here stops stylesheets that compile under plain
       Sass. */
    pkg("ref-ds", { exports: { "./colours": "./src/_colours.scss" } });
    const load = importing(["@shorthand/design-system", "ref-ds"]);
    assert.equal(load("@shorthand/design-system/internal", "theme.scss"), path.join(store, "ref-ds/internal"));
  });

  it("takes the package's legacy stylesheet fields for a root the map leaves out", () => {
    /* The `sass`/`style` fields are the stylesheet counterpart of `types`/`main`
       — consulted for the ROOT only, since a field describes one entry point,
       and `sass` ahead of `style`. */
    pkg("ref-fields", { sass: "./src/_lib.scss", style: "./dist/lib.css" });
    assert.equal(importing(["fields", "ref-fields"])("fields", "theme.scss"), path.join(store, "ref-fields/src/_lib.scss"));

    pkg("ref-style", { style: "./dist/lib.css" });
    assert.equal(importing(["styled", "ref-style"])("styled", "theme.scss"), path.join(store, "ref-style/dist/lib.css"));

    /* A map that publishes the root wins over them. */
    pkg("ref-both", { sass: "./src/_lib.scss", exports: { ".": { sass: "./exp/root.scss" } } });
    assert.equal(importing(["both", "ref-both"])("both", "theme.scss"), path.join(store, "ref-both/exp/root.scss"));

    /* A map that publishes only a SUBPATH leaves the root to them. */
    pkg("ref-closed", { sass: "./src/_lib.scss", exports: { "./other": { sass: "./exp/o.scss" } } });
    assert.equal(importing(["closed", "ref-closed"])("closed", "theme.scss"), path.join(store, "ref-closed/src/_lib.scss"));

    /* And they answer for the root alone — a subpath falls to the directory. */
    pkg("ref-sub", { sass: "./src/_lib.scss" });
    assert.equal(importing(["subbed", "ref-sub"])("subbed/other", "theme.scss"), path.join(store, "ref-sub/other"));
  });
});
