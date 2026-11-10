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
import { BuildCache } from "../core/BuildCache";
import { FileSet, IFile } from "../core/FileSet";
import { MemoryFile } from "../core/MemoryFS";
import { SymlinkFile } from "../core/SymlinkFile";
import { syntheticValue } from "../model/AST";
import { BUILD_OPERATION, Constraints } from "../model/Constraints";
import { ExecutionContext } from "../model/ExecutionContext";
import { toBuildModel } from "../model/ModelBuilder";
import { parseBuildString, parseName } from "../model/Parser";
import { LogFormatter, LogLevel } from "../support/Log";
import { StringReader } from "../support/StringReader";
import zip from "./BuildZip";

describe("zip", () => {
  const log = new LogFormatter(LogLevel.Warn, () => undefined);
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-zip-test-"));
  afterAll(() => fs.rmSync(cacheRoot, { recursive: true, force: true }));
  const tree = new FileSet(
    new Map<string, IFile>([
      ["a.txt", MemoryFile.from("a")],
      ["sub/b.txt", MemoryFile.from("b")],
      ["link", new SymlinkFile("a.txt")],
    ])
  );
  /** Build the archive in a model of its own, in a run whose cache is at `root`. */
  const archiveIn = async (root: string): Promise<Buffer> => {
    const model = toBuildModel(
      [parseBuildString(tree, "BUILD.fabr", "targetdef zip { srcs = FILES; }\nzip deploy/app { srcs = a.txt sub:b.txt link; }\n", log)],
      log,
      [{ rules: [{ type: "zip", properties: { [BUILD_OPERATION]: "build" }, ...zip }] }]
    );
    const run = new ExecutionContext(new BuildCache(root, log), log, FileSet.layout({}), FileSet.layout({}));
    const name = "deploy/app";
    const ref = syntheticValue(parseName(name), { fs: tree, file: "<command-line>", reader: new StringReader(name) }, 0, name.length);
    const sources = await model.getConfig(Constraints.of({ [BUILD_OPERATION]: "build" }), run).materialize(ref);
    const result = FileSet.unionAll(...(sources as FileSet[]));
    expect([...result].map(([file]) => file)).to.deep.equal(["app.zip"]);
    return result.getFile("app.zip")!.getBuffer();
  };

  /** @return the mode of the entry `name` in `archive`, read from its central directory. */
  const modeOf = (archive: Buffer, name: string): number | undefined => {
    let at = archive.readUInt32LE(archive.length - 22 + 16);
    while (archive.readUInt32LE(at) === 0x02014b50) {
      const length = archive.readUInt16LE(at + 28);
      if (archive.toString("utf8", at + 46, at + 46 + length) === name) {
        return archive.readUInt32LE(at + 38) >>> 16;
      }
      at += 46 + length + archive.readUInt16LE(at + 30) + archive.readUInt16LE(at + 32);
    }
    return undefined;
  };

  it("builds one archive named after the target, of its files as they are found, its symlink stored as a symlink", async () => {
    const archive = await archiveIn(path.join(cacheRoot, "first"));
    expect(archive.readUInt32LE(0)).to.equal(0x04034b50);
    expect(modeOf(archive, "a.txt")).to.not.equal(undefined);
    expect(modeOf(archive, "b.txt")).to.not.equal(undefined);
    expect(modeOf(archive, "sub/b.txt")).to.equal(undefined);
    expect(modeOf(archive, "link")! & 0o170000).to.equal(0o120000);
  });

  it("builds the same bytes again from nothing", async () => {
    const first = await archiveIn(path.join(cacheRoot, "first"));
    const again = await archiveIn(path.join(cacheRoot, "again"));
    expect(again.equals(first)).to.equal(true);
  });
});
