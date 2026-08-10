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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileSet, IFile } from "./FileSet";
import { FSFileSource } from "./FSFileSource";
import { MemoryFile } from "./MemoryFS";
import { parseName } from "../model/Parser";
import { locateSource } from "./Provenance";
import { IWriteBackCandidate, WriteBackFileSet, writeBackCandidates } from "./WriteBack";

/** A fresh project directory per test, cleaned up after it. */
let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-writeback-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** An offer as a rule makes one: content named in the inputs' own namespace,
 * plus the rewrite saying which input each name belongs to. Never a host path. */
function candidate(content: string, at: string): IWriteBackCandidate {
  return {
    files: FileSet.layout({ [at]: MemoryFile.from(content) }),
    belongsTo: parseName("**/__snapshots__/*.snap").withRenameTo(parseName("**/*")),
    origin: undefined,
  };
}

describe("locateSource", () => {
  it("gives the on-disk path a file in a source query came from", async () => {
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src/a.txt"), "a");
    const files = await new FSFileSource(dir).find(parseName("src:*.txt"));
    /* The projection stripped `src/`, so the result name alone cannot say where
     * the file was read from — which is exactly what the provenance step
     * records. */
    expect([...files].map(([name]) => name)).to.deep.equal(["a.txt"]);
    expect(locateSource(files.origin, "a.txt")).to.equal(path.join(dir, "src/a.txt"));
  });

  it("follows a file through a union and a mount to its own source", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "a");
    const files = await new FSFileSource(dir).find(parseName("*.txt"));
    /* Assembly rebases before delegating, so a file's origin survives being
     * unioned with generated content and mounted under a prefix. */
    const generated = new FileSet(new Map<string, IFile>([["b.txt", MemoryFile.from("b")]]));
    const install = FileSet.layout({ lib: [FileSet.unionAll(files, generated)] });
    expect(locateSource(install.origin, "lib/a.txt")).to.equal(path.join(dir, "a.txt"));
    /* Generated content has no source location, and does not borrow one. */
    expect(locateSource(install.origin, "lib/b.txt")).to.equal(undefined);
  });

  it("says nothing about a file no chain explains", () => {
    expect(locateSource(undefined, "a.txt")).to.equal(undefined);
  });
});

describe("writeBackCandidates", () => {
  it("collects what a built result offers, and nothing from a plain one", () => {
    const offered = candidate("x", "__snapshots__/a.ts.snap");
    const carrier = new WriteBackFileSet(new Map<string, IFile>(), [offered]);
    const plain = new FileSet(new Map<string, IFile>());
    expect(writeBackCandidates([carrier, plain])).to.deep.equal([offered]);
    expect(writeBackCandidates([plain])).to.deep.equal([]);
  });
});
