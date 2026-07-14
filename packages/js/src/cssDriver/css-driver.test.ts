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

/* Note: this file is run by the fabr test harness itself (node:test based), not
 * by the workspace jest setup — it lives beside the standalone CSS driver, which
 * requires sass-embedded + lightningcss (unavailable to jest). Importing the
 * driver module is safe: the tools are required lazily inside main(), not at
 * load. */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  adaptExports,
  camelCase,
  isModule,
  isSass,
  moduleCssName,
  moduleJsName,
  plainCssName,
  proxyModule,
} from "./css-driver";

describe("isModule", () => {
  it("matches .module.{scss,sass,css}", () => {
    assert.equal(isModule("a/Foo.module.scss"), true);
    assert.equal(isModule("Foo.module.css"), true);
    assert.equal(isModule("Foo.module.sass"), true);
  });
  it("rejects plain and non-module styled sources", () => {
    assert.equal(isModule("Foo.scss"), false);
    assert.equal(isModule("Foo.css"), false);
    assert.equal(isModule("Foomodule.scss"), false);
  });
});

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
  it("maps a module source to a plain scoped .css (source+.css, NOT *.module.css) and its .module.js", () => {
    /* The scoped CSS must not end in `.module.css`, else esbuild re-scopes it. */
    assert.equal(moduleCssName("a/Foo.module.scss"), "a/Foo.module.scss.css");
    assert.equal(moduleJsName("a/Foo.module.scss"), "a/Foo.module.js");
    assert.equal(moduleCssName("Foo.module.css"), "Foo.module.css.css");
    assert.equal(moduleJsName("Foo.module.css"), "Foo.module.js");
  });
});

describe("camelCase", () => {
  it("camelCases kebab keys, leaves camel/simple alone", () => {
    assert.equal(camelCase("header-bar"), "headerBar");
    assert.equal(camelCase("a-b-c"), "aBC");
    assert.equal(camelCase("header"), "header");
    assert.equal(camelCase("alreadyCamel"), "alreadyCamel");
  });
});

describe("adaptExports", () => {
  it("flattens nested kebab exports to a flat camelCased value map", () => {
    const exports = {
      "header-bar": { name: "FL0plG_header-bar", composes: [], isReferenced: false },
      "inner-title": { name: "FL0plG_inner-title", composes: [], isReferenced: true },
    };
    assert.deepEqual(adaptExports(exports), {
      headerBar: "FL0plG_header-bar",
      innerTitle: "FL0plG_inner-title",
    });
  });
  it("handles undefined/empty exports", () => {
    assert.deepEqual(adaptExports(undefined), {});
    assert.deepEqual(adaptExports({}), {});
  });
});

describe("proxyModule", () => {
  it("emits a side-effect css import plus the value map as default export", () => {
    const proxy = proxyModule("./Foo.module.css", { headerBar: "FL0plG_header-bar" });
    assert.equal(proxy, 'import "./Foo.module.css";\nexport default {"headerBar":"FL0plG_header-bar"};\n');
  });
});
