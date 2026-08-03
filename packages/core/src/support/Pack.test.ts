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

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";
import { Readable } from "stream";
import * as tar from "tar-stream";
import { expect } from "chai";
import { packToTarball } from "./Pack";
import { unpackStream } from "./Unpack";
import { BuildCache } from "../core/BuildCache";
import { LogFormatter, LogLevel } from "./Log";
import { Computable } from "../core/Computable";
import { FileSet, IFile } from "../core/FileSet";
import { MemoryFile } from "../core/MemoryFS";
import { SymlinkFile } from "../core/SymlinkFile";

function fileSetOf(entries: Record<string, string>): FileSet {
  const map = new Map<string, IFile>();
  for (const [name, content] of Object.entries(entries)) {
    map.set(name, MemoryFile.from(content));
  }
  return new FileSet(map);
}

/** A minimal on-disk IFile probe carrying its real permission bits (packToTarball
 *  emits the entry mode from IFile.mode). */
function diskFile(abspath: string): IFile {
  const file: IFile = {
    hash: abspath,
    mode: fs.statSync(abspath).mode & 0o7777,
    mime: "application/octet-stream",
    readString: encoding => Computable.resolve(fs.readFileSync(abspath, encoding ?? "utf8")),
    getDisplayName: () => abspath,
    isSameFile: other => other === file,
    getAbsPath: () => abspath,
    getBuffer: () => Computable.resolve(fs.readFileSync(abspath)),
  };
  return file;
}

/** Unpack into a fresh temp dir (production always unpacks into a clean
 * cache-owned scratch dir; a shared dir would trip the case-collision guard on
 * debris from a prior run). The returned FileSet's hashes are computed during
 * unpack, so it stays valid after the dir is removed. */
async function unpackInTemp(tarball: Buffer): Promise<FileSet> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-pack-cache-"));
  const cache = new BuildCache(dir, new LogFormatter(LogLevel.Info, () => undefined));
  try {
    return await unpackStream(Readable.from(tarball), () => cache.getTemporaryWriteStream());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("Pack", () => {
  it("round-trips a FileSet through pack + unpack", async () => {
    const source = fileSetOf({
      "package.json": '{"name":"demo","version":"1.0.0"}',
      "lib/index.js": "module.exports = 42;\n",
      "README.md": "# demo\n",
    });

    const tarball = await packToTarball(source);
    const unpacked = await unpackInTemp(tarball);

    expect(unpacked.size).to.equal(source.size);
    for (const [name, file] of source) {
      const back = await unpacked.get(name);
      expect(back, `missing ${name}`).to.not.equal(undefined);
      expect(back?.hash).to.equal(file.hash);
    }
  });

  it("round-trips a symlink as a symlink (not a regular file of the target text)", async () => {
    const source = new FileSet(
      new Map<string, IFile>([
        ["real.txt", MemoryFile.from("hi")],
        ["link.txt", new SymlinkFile("real.txt")],
      ])
    );

    const tarball = await packToTarball(source);
    const unpacked = await unpackInTemp(tarball);

    expect(unpacked.size).to.equal(2);
    const back = await unpacked.get("link.txt");
    expect(back).to.be.instanceOf(SymlinkFile);
    expect((back as SymlinkFile).target).to.equal("real.txt");
  });

  it("dedups identical content as a hardlink to the first entry", async () => {
    const tarball = await packToTarball(fileSetOf({ "a.txt": "same", "b.txt": "same", "c.txt": "diff" }));

    /* Read the raw entry headers: in sorted order a.txt is the content, b.txt a
     * hardlink to it (identical bytes packed once), c.txt its own content. */
    const headers: { name: string; type: string }[] = [];
    const extract = tar.extract();
    await new Promise<void>((resolve, reject) => {
      extract.on("entry", (h, stream, next) => {
        headers.push({ name: h.name, type: h.type as string });
        stream.on("end", next);
        stream.resume();
      });
      extract.on("finish", () => resolve());
      extract.on("error", reject);
      Readable.from(zlib.gunzipSync(tarball)).pipe(extract);
    });
    expect(headers.find(h => h.name === "a.txt")?.type).to.equal("file");
    expect(headers.find(h => h.name === "b.txt")?.type).to.equal("link");
    expect(headers.find(h => h.name === "c.txt")?.type).to.equal("file");

    /* It round-trips: both names come back sharing one content hash. */
    const unpacked = await unpackInTemp(tarball);
    expect(unpacked.size).to.equal(3);
    expect((await unpacked.get("a.txt"))?.hash).to.equal((await unpacked.get("b.txt"))?.hash);
  });

  it("preserves the exec bit — an executable blob packs as 0o755", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-pack-"));
    try {
      fs.writeFileSync(path.join(dir, "cli.sh"), "#!/bin/sh\n", { mode: 0o755 });
      fs.writeFileSync(path.join(dir, "readme.txt"), "hi\n");
      const source = new FileSet(
        new Map<string, IFile>([
          ["bin/cli.sh", diskFile(path.join(dir, "cli.sh"))],
          ["readme.txt", diskFile(path.join(dir, "readme.txt"))],
        ])
      );

      const tarball = await packToTarball(source);
      /* The exec bit rides the unpacked (blob-backed) IFile's mode, round-tripped
       * through the tar entry's mode. */
      const result = await unpackInTemp(tarball);
      const cli = await result.get("bin/cli.sh");
      const readme = await result.get("readme.txt");
      if (!cli || !readme) {
        throw new Error("expected both entries");
      }
      expect(cli.mode & 0o111, "exec bit lost").to.not.equal(0);
      expect(readme.mode & 0o111, "stray exec bit").to.equal(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is deterministic — identical content packs to identical bytes", async () => {
    const a = await packToTarball(fileSetOf({ "a.txt": "one", "b.txt": "two" }));
    /* Different insertion order, same content: sorted-entry + fixed-mtime packing
     * must yield byte-identical output (it is content-addressed and cached). */
    const b = await packToTarball(fileSetOf({ "b.txt": "two", "a.txt": "one" }));
    expect(a.equals(b)).to.equal(true);
  });
});
