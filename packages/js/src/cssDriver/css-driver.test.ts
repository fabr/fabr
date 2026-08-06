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
 * requires sass-embedded (unavailable to jest). Importing the driver module is
 * safe: sass is required lazily inside main(), not at load. */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { isPartial, isSass, plainCssName } from "./css-driver";

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
