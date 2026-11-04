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

import { createHash } from "crypto";
import { Writable } from "stream";
import { gunzipSync } from "zlib";
import { expect } from "chai";
import { FileSet, IFile, MemoryFile, packToTarball, SymlinkFile } from "@fabr-build/core";
import { ILayerIndex, indexLayer } from "./LayerIndex";

/** Pack `files` as an uncompressed tar, as a layer's is once decompressed. */
function layerTar(files: Record<string, string | SymlinkFile>, options?: { directories?: boolean }): Promise<Buffer> {
  const set = new FileSet(
    new Map<string, IFile>(Object.entries(files).map(([name, content]) => [name, typeof content === "string" ? MemoryFile.from(content) : content]))
  );
  return Promise.resolve(packToTarball(set, { ...options, hardlinks: true })).then(buffer => gunzipSync(buffer));
}

/** Index `tar`, fed in chunks of `chunk` bytes. */
async function indexed(tar: Buffer, chunk = 100): Promise<ILayerIndex> {
  const { sink, result } = indexLayer();
  await new Promise<void>((resolve, reject) => {
    (sink as Writable).on("finish", resolve).on("error", reject);
    for (let at = 0; at < tar.length; at += chunk) {
      sink.write(tar.subarray(at, at + chunk));
    }
    sink.end();
  });
  return result();
}

describe("indexLayer", () => {
  it("records each entry's metadata, and a file's range, hash and mime", async () => {
    const tar = await layerTar({ "etc/motd": "hello\n", "bin/sh": new SymlinkFile("busybox"), "bin/ash": "hello\n" }, { directories: true });
    const index = await indexed(tar, 37);
    expect(index.diffId).to.equal(`sha256:${createHash("sha256").update(tar).digest("hex")}`);
    expect(index.entries.map(entry => [entry.path, entry.type])).to.deep.equal([
      ["bin", "directory"],
      ["bin/ash", "file"],
      ["bin/sh", "symlink"],
      ["etc", "directory"],
      ["etc/motd", "hardlink"],
    ]);
    const ash = index.entries[1];
    expect(tar.subarray(ash.offset!, ash.offset! + ash.size!).toString()).to.equal("hello\n");
    expect(ash.hash).to.equal(createHash("sha256").update("hello\n").digest("hex"));
    expect(index.entries[2].linkname).to.equal("busybox");
    expect(index.entries[4].linkname).to.equal("bin/ash");
    expect(index.entries[0]).to.include({ mode: 0o755, uid: 0, gid: 0 });
  });

  it("reads a name longer than a ustar header holds", async () => {
    const long = `${"d".repeat(120)}/${"f".repeat(120)}.txt`;
    const index = await indexed(await layerTar({ [long]: "x" }));
    expect(index.entries.map(entry => entry.path)).to.deep.equal([long]);
  });

  it("refuses a tar that ends before its end-of-archive marker", async () => {
    const tar = await layerTar({ "a.txt": "a" });
    const failure = await indexed(tar.subarray(0, 512)).catch((err: Error) => err);
    expect(failure).to.be.instanceOf(Error).with.property("message").that.matches(/ends before/);
  });
});
