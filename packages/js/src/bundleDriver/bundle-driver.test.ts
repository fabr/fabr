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

/* Note: this file is run by the fabr test harness itself (node:test based),
 * not by the workspace jest setup — it lives beside the standalone bundle
 * driver, which requires esbuild (unavailable to jest). Importing the driver
 * module is safe: esbuild is required lazily inside main(), not at load. */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { isBareSpecifier, packageOf, rewriteStyledImport } from "./bundle-driver";

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
  it("maps a Sass css-module import to its proxy .js", () => {
    assert.equal(rewriteStyledImport("./Foo.module.scss"), "./Foo.module.js");
    assert.equal(rewriteStyledImport("../a/Foo.module.sass"), "../a/Foo.module.js");
  });

  it("maps a plain Sass import to its compiled .css", () => {
    assert.equal(rewriteStyledImport("./styles.scss"), "./styles.css");
    assert.equal(rewriteStyledImport("./styles.sass"), "./styles.css");
  });

  it("leaves plain .css (incl. the scoped .module.css the proxy imports) unchanged", () => {
    assert.equal(rewriteStyledImport("./Foo.module.css"), "./Foo.module.css");
    assert.equal(rewriteStyledImport("./app.css"), "./app.css");
  });

  it("leaves non-styled specifiers unchanged", () => {
    assert.equal(rewriteStyledImport("./util.js"), "./util.js");
    assert.equal(rewriteStyledImport("react"), "react");
  });
});
