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
import { HostLink, SymlinkFile } from "./SymlinkFile";
import { writeFileSet } from "./Staging";

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

describe("HostLink", () => {
  it("is identified by the program's content, not where it lies", () => {
    const here = new HostLink("abc123", "/usr/bin/cc");
    const there = new HostLink("abc123", "/opt/tools/bin/cc");
    expect(here.hash).to.equal(there.hash);
    expect(here.isSameFile(there)).to.equal(true);
    expect(here.isSameFile(new HostLink("def456", "/usr/bin/cc"))).to.equal(false);
    expect(here.target).to.not.contain("/usr/bin");
    expect(() => new HostLink("abc123", "bin/cc")).to.throw(/absolute path/);
  });

  it("stages as a link to the program, outside the staged tree", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-hostlink-"));
    const program = path.join(dir, "program");
    try {
      fs.writeFileSync(program, "#!/bin/sh\n");
      const files = new FileSet(new Map<string, import("./FileSet").IFile>([["cc", new HostLink("abc123", program)]]));
      await writeFileSet(path.join(dir, "staged"), files);
      expect(fs.readlinkSync(path.join(dir, "staged/cc"))).to.equal(program);
      /* A plain symlink spelling the same target text is not one, and stays inside. */
      await writeFileSet(path.join(dir, "plain"), new FileSet(new Map([["cc", new SymlinkFile(new HostLink("abc123", program).target)]])));
      expect(fs.existsSync(path.join(dir, "plain/cc"))).to.equal(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
