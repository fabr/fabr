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
import {
  relocateSources,
  sourceMapComment,
  cssModuleDeclaration,
  cssModuleShim,
  isSass,
  packageImporter,
  SASS_CONDITIONS,
  sassFailure,
  scopeFailure,
} from "./css-driver";

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

describe("cssModuleShim", () => {
  it("imports its own stylesheet by basename and exports the map as a default", () => {
    const shim = cssModuleShim("a/b/Card.module.css", { card: "card_k3f1c", "header-bar": "header-bar_k3f1c" });
    /* The specifier is a SIBLING reference: the shim is written beside the css
     * it belongs to, so its own directory is the only thing it can name. */
    assert.match(shim, /^import "\.\/Card\.module\.css";$/m);
    assert.match(shim, /^ {2}"card": "card_k3f1c",$/m);
    /* A name that is not a TS identifier survives, quoted. */
    assert.match(shim, /^ {2}"header-bar": "header-bar_k3f1c",$/m);
    assert.match(shim, /^export default styles;$/m);
  });

  it("orders its entries canonically, so the same map is the same bytes", () => {
    const one = cssModuleShim("x.module.css", { b: "b_1", a: "a_1" });
    const two = cssModuleShim("x.module.css", { a: "a_1", b: "b_1" });
    assert.equal(one, two);
  });
});

describe("cssModuleDeclaration", () => {
  it("declares a default-export object with quoted keys", () => {
    const declaration = cssModuleDeclaration({ card: "card_k3f1c", "header-bar": "header-bar_k3f1c" });
    assert.match(declaration, /^declare const styles: \{$/m);
    assert.match(declaration, /^ {2}readonly "card": string;$/m);
    /* Quoted rather than named exports: a class name need not be a valid
     * identifier, and named exports would force dropping the ones that are not. */
    assert.match(declaration, /^ {2}readonly "header-bar": string;$/m);
    assert.match(declaration, /^export default styles;$/m);
  });

  it("declares an empty module for a plain stylesheet", () => {
    /* It exports nothing, but the import must still resolve so a side-effect
     * import typechecks. */
    assert.equal(cssModuleDeclaration(undefined), "export {};\n");
  });
});

describe("relocateSources", () => {
  /* As the driver calls it for `a/Card.css`: sources staged under `src`, the map
   * written next to its stylesheet under `out`. */
  const where = { root: "/work", srcRoot: "src", mapDir: "out/a" };
  const map = (...sources: string[]): { sources: string[] } => ({ sources });

  it("names the target's own source as the target names it", () => {
    /* Staging is fabr's word, not the project's — a target whose srcs are
     * `src:**` calls the file `Card.module.scss`. */
    const out = relocateSources(map("file:///work/src/a/Card.module.scss"), where);
    assert.deepEqual(out.sources, ["a/Card.module.scss"]);
  });

  it("carries no host path, whatever the file was", () => {
    /* The first design rule: nothing machine-specific may reach an artifact. A
     * dependency's stylesheet keeps its working-root-relative (and so
     * content-addressed) path. */
    const out = relocateSources(map("file:///work/.fabr-tree/abc123/vendor/_mixins.scss"), where);
    assert.deepEqual(out.sources, [".fabr-tree/abc123/vendor/_mixins.scss"]);
    assert.equal(JSON.stringify(out).includes("/work"), false);
  });

  it("names postcss's own input as the lowered stylesheet, where Sass ran", () => {
    /* Chained, postcss adds an entry for the content it was HANDED — the lowered
     * CSS — under the name it was told that content came from. Left alone it
     * would shadow the real source: same name, different content. Sass spells
     * its sources as file URLs and postcss spells its own as a path, which is
     * what tells them apart. */
    const out = relocateSources(
      map("file:///work/src/a/Card.module.scss", "../../src/a/Card.module.scss"),
      where,
      "a/Card.css"
    );
    assert.deepEqual(out.sources, ["a/Card.module.scss", "a/Card.css"]);
  });

  it("leaves an unchained run's own input named as the source it really is", () => {
    /* A `.module.css` never goes near Sass, so postcss's input IS the source and
     * must keep its own name. */
    const out = relocateSources(map("../../src/a/Card.module.css"), where);
    assert.deepEqual(out.sources, ["a/Card.module.css"]);
  });
});

describe("sourceMapComment", () => {
  it("names the map by basename, since it sits beside the stylesheet", () => {
    assert.equal(sourceMapComment("a/b/Card.css.map"), "\n/*# sourceMappingURL=Card.css.map */\n");
  });
});

describe("scopeFailure", () => {
  it("attributes a positioned failure to the source file", () => {
    /* postcss's CssSyntaxError shape: a reason plus 1-based coordinates. */
    const err = { reason: "Unclosed block", line: 4, column: 2 };
    assert.equal(scopeFailure("a/Foo.module.scss", err).message, "a/Foo.module.scss:4:2: css-modules: Unclosed block");
  });
  it("attributes a positionless failure to the file alone", () => {
    assert.equal(
      scopeFailure("a/Foo.module.scss", new Error("plugin blew up")).message,
      "a/Foo.module.scss: css-modules: plugin blew up"
    );
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
