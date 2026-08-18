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
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FileSet } from "./FileSet";
import { MemoryFile } from "./MemoryFS";
import { CacheLink, SymlinkFile } from "./SymlinkFile";
import { syncFileSet, writeFileSet } from "./Staging";

describe("SymlinkFile", () => {
  it("is a distinct IFile that names its target", () => {
    const link = new SymlinkFile("bin/tsc");
    expect(link.target).to.equal("bin/tsc");
    expect(link.isSameFile(new SymlinkFile("bin/tsc"))).to.equal(true);
    expect(link.isSameFile(new SymlinkFile("bin/other"))).to.equal(false);
    expect(link.isSameFile(MemoryFile.from("bin/tsc"))).to.equal(false);
  });

  it("stages to disk as a real symlink resolving to the target's content", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-symlink-"));
    try {
      const files = new FileSet(
        new Map<string, import("./FileSet").IFile>([
          ["real.txt", MemoryFile.from("hello")],
          ["link.txt", new SymlinkFile("real.txt")],
        ])
      );
      await writeFileSet(dir, files);
      expect(fs.lstatSync(path.join(dir, "link.txt")).isSymbolicLink()).to.equal(true);
      expect(fs.readlinkSync(path.join(dir, "link.txt"))).to.equal("real.txt");
      /* Following the link reads the target's content. */
      expect(fs.readFileSync(path.join(dir, "link.txt"), "utf8")).to.equal("hello");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to stage a symlink whose target escapes the staged tree", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-symlink-"));
    try {
      const files = new FileSet(
        new Map<string, import("./FileSet").IFile>([
          ["escape.txt", new SymlinkFile("../../../../etc/passwd")],
          ["absolute.txt", new SymlinkFile("/etc/passwd")],
          ["ok/inside.txt", new SymlinkFile("../real.txt")],
          ["real.txt", MemoryFile.from("safe")],
        ])
      );
      await writeFileSet(dir, files);
      /* Escaping targets (via `..` past the root, or absolute) are not written. */
      expect(fs.existsSync(path.join(dir, "escape.txt"))).to.equal(false);
      expect(fs.existsSync(path.join(dir, "absolute.txt"))).to.equal(false);
      /* A `..` that stays within the tree is fine. */
      expect(fs.lstatSync(path.join(dir, "ok/inside.txt")).isSymbolicLink()).to.equal(true);
      expect(fs.readFileSync(path.join(dir, "ok/inside.txt"), "utf8")).to.equal("safe");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("catches a target that escapes through a symlinked parent (not just lexically)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-symlink-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-outside-"));
    try {
      /* A pre-existing `via` symlink points out of the tree. A staged link under
       * it (`via/escape.txt` → `evil.txt`) is lexically `dir/via/evil.txt` — inside —
       * but really `outside/evil.txt`. path.resolve alone would pass it; resolving
       * against the realpath of the parent catches it. */
      fs.symlinkSync(outside, path.join(dir, "via"));
      const files = new FileSet(new Map<string, import("./FileSet").IFile>([["via/escape.txt", new SymlinkFile("evil.txt")]]));
      await writeFileSet(dir, files);
      expect(fs.existsSync(path.join(outside, "escape.txt"))).to.equal(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("CacheLink", () => {
  it("identifies itself by its cache-relative path, never by where the cache is", () => {
    const link = new CacheLink("tree", "/var/cache/one");
    const elsewhere = new CacheLink("tree", "/somewhere/else");
    /* Identity — hence every action key it rides in — is location free, which is
     * what keeps a key portable across cache moves. */
    expect(link.hash).to.equal(elsewhere.hash);
    expect(link.isSameFile(elsewhere)).to.equal(true);
    expect(link.isSameFile(new CacheLink("blob"))).to.equal(false);
    /* Only the resolution differs. */
    expect(link.resolveTarget()).to.equal(path.join("/var/cache/one", "tree"));
    expect(new CacheLink("tree").resolveTarget()).to.equal(undefined);
    expect(link.withCacheRoot("/moved").resolveTarget()).to.equal(path.join("/moved", "tree"));
  });

  it("normalizes its path, and refuses one that leaves the cache", () => {
    /* fabr constructs every one of these, so an escape is a bug and not a
     * condition to handle — it cannot reach staging, which exempts the class
     * from the containment guard. */
    expect(new CacheLink("./tree/other/../.").relpath).to.equal("tree");
    expect(() => new CacheLink("../elsewhere")).to.throw(/must name a path inside the cache/);
    expect(() => new CacheLink("tree/../..")).to.throw(/must name a path inside the cache/);
    expect(() => new CacheLink("/etc")).to.throw(/must name a path inside the cache/);
  });

  it("stages as an absolute link into the cache — the one licensed escape from the staged tree", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-cachelink-"));
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-cacheroot-"));
    try {
      fs.mkdirSync(path.join(cache, "tree", "abc"), { recursive: true });
      fs.writeFileSync(path.join(cache, "tree", "abc", "index.js"), "pad");
      const files = new FileSet(
        new Map<string, import("./FileSet").IFile>([
          [".fabr-tree", new CacheLink("tree", cache)],
          /* An ordinary symlink escaping the tree keeps today's containment: the
           * exemption is per-class, not a widening of the guard. */
          ["node_modules/escape", new SymlinkFile(path.join(cache, "tree"))],
          /* THE LAUNDERING REGRESSION: a delivered symlink whose target text
           * spells the scheme is not a cache link and gets no exemption — it is
           * a garbage relative path, contained and therefore dropped. */
          ["node_modules/launder", new SymlinkFile("fabr-cache:tree")],
        ])
      );
      await writeFileSet(dir, files);
      const staged = path.join(dir, ".fabr-tree");
      expect(fs.lstatSync(staged).isSymbolicLink()).to.equal(true);
      expect(fs.readlinkSync(staged)).to.equal(path.join(cache, "tree"));
      expect(fs.readFileSync(path.join(staged, "abc/index.js"), "utf8")).to.equal("pad");
      expect(fs.existsSync(path.join(dir, "node_modules/escape"))).to.equal(false);
      expect(fs.existsSync(path.join(dir, "node_modules/launder"))).to.equal(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(cache, { recursive: true, force: true });
    }
  });

  it("syncs as the same absolute link", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-cachelink-"));
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-cacheroot-"));
    try {
      fs.mkdirSync(path.join(cache, "tree"), { recursive: true });
      const link = new FileSet(new Map<string, import("./FileSet").IFile>([[".fabr-tree", new CacheLink("tree", cache)]]));
      await syncFileSet(dir, new FileSet(new Map()), link);
      expect(fs.readlinkSync(path.join(dir, ".fabr-tree"))).to.equal(path.join(cache, "tree"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(cache, { recursive: true, force: true });
    }
  });

  it("refuses to stage a cache link that carries no cache location", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-cachelink-"));
    try {
      const files = new FileSet(new Map<string, import("./FileSet").IFile>([["a", new CacheLink("tree")]]));
      let error: Error | undefined;
      await new Promise<void>(resolve =>
        writeFileSet(dir, files).then(
          () => resolve(),
          (err: Error) => {
            error = err;
            resolve();
          }
        )
      );
      /* Silently dropping it (as the containment guard drops an escaping link)
       * would stage a subtly broken install instead of failing. */
      expect(error?.message).to.match(/carries no cache location/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
