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

import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { realpathKeepingVirtual, resolveVirtual, virtualLocation } from "./VirtualPath";

describe("resolveVirtual", () => {
  it("maps the spec's example", () => {
    expect(resolveVirtual("/path/to/some/folder/__virtual__/a0b1c2d3/0/subpath/to/file.dat")).to.equal(
      "/path/to/some/folder/subpath/to/file.dat"
    );
  });

  it("steps up n directories", () => {
    expect(resolveVirtual("/a/b/__virtual__/ff/2/c/d")).to.equal("/c/d");
    expect(resolveVirtual("/a/b/c/__virtual__/ff/1/d")).to.equal("/a/b/d");
  });

  it("accepts a name-prefixed hash and the $$virtual spelling", () => {
    expect(resolveVirtual("/a/b/__virtual__/pkg-ff00/0/c")).to.equal("/a/b/c");
    expect(resolveVirtual("/a/b/$$virtual/ff00/0/c")).to.equal("/a/b/c");
  });

  it("leaves a plain path, and a malformed virtual one, as written", () => {
    expect(resolveVirtual("/a/b/c")).to.equal("/a/b/c");
    expect(resolveVirtual("/a/b/__virtual__/nothex/0/c")).to.equal("/a/b/__virtual__/nothex/0/c");
    expect(resolveVirtual("/a/b/__virtual__/ff/x/c")).to.equal("/a/b/__virtual__/ff/x/c");
  });

  it("resolves nested virtual segments in turn", () => {
    expect(resolveVirtual("/a/__virtual__/ff/0/b/__virtual__/ee/0/c")).to.equal("/a/b/c");
  });

  it("inverts virtualLocation", () => {
    const at = virtualLocation("/w/.fabr-tree/abc123", "0123456789abcdef");
    expect(at).to.equal("/w/.fabr-tree/__virtual__/0123456789abcdef/0/abc123");
    expect(resolveVirtual(`${at}/lib/x.js`)).to.equal("/w/.fabr-tree/abc123/lib/x.js");
  });
});

describe("realpathKeepingVirtual", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-virtual-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("resolves the part before the virtual segment and keeps the rest", () => {
    fs.mkdirSync(path.join(root, "pool", "tree"), { recursive: true });
    fs.symlinkSync(path.join(root, "pool"), path.join(root, "link"));
    const real = fs.realpathSync(path.join(root, "pool"));
    expect(realpathKeepingVirtual(path.join(root, "link", "__virtual__", "ff", "0", "tree", "x.js"))).to.equal(
      path.join(real, "__virtual__", "ff", "0", "tree", "x.js")
    );
  });

  it("is an ordinary realpath for a plain path", () => {
    fs.mkdirSync(path.join(root, "pool"));
    fs.symlinkSync(path.join(root, "pool"), path.join(root, "link"));
    expect(realpathKeepingVirtual(path.join(root, "link"))).to.equal(fs.realpathSync(path.join(root, "pool")));
  });
});
