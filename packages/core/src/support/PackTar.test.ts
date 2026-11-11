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
import { expect } from "chai";
import { packToTarball, writeTar } from "./PackTar";
import { TarExtract } from "./TarExtract";
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

/** Unpack through a throwaway BuildCache's CAS output. The returned FileSet's
 * hashes are computed during unpack, so it stays valid after the cache dir is
 * removed. */
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

  it("round-trips names and symlink targets too long for a ustar header", async () => {
    const longName = `lib/${"a".repeat(120)}/${"b".repeat(120)}.js`;
    const longTarget = `../${"c".repeat(150)}.js`;
    const source = new FileSet(
      new Map<string, IFile>([
        [longName, MemoryFile.from("long\n")],
        ["link.js", new SymlinkFile(longTarget)],
        ["café.txt", MemoryFile.from("unicode\n")],
      ])
    );

    const unpacked = await unpackInTemp(await packToTarball(source));
    expect([...unpacked].map(([name]) => name).sort()).to.deep.equal(["café.txt", longName, "link.js"].sort());
    expect((await unpacked.get(longName))?.hash).to.equal(MemoryFile.from("long\n").hash);
    expect(((await unpacked.get("link.js")) as SymlinkFile).target).to.equal(longTarget);
  });

  type Header = { name: string; type: string; mode: number; uid: number; gid: number; body: string };

  /** The raw entry headers of a tarball, gzipped unless `plain`, in packed order. */
  async function headersOf(tarball: Buffer, plain = false): Promise<Header[]> {
    const headers: Header[] = [];
    const extract = new TarExtract();
    await new Promise<void>((resolve, reject) => {
      extract.on("entry", (h, stream, next) => {
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => {
          headers.push({
            name: h.name,
            type: h.type ?? "unknown",
            mode: h.mode,
            uid: h.uid,
            gid: h.gid,
            body: Buffer.concat(chunks).toString(),
          });
          next();
        });
      });
      extract.on("finish", () => resolve());
      extract.on("error", reject);
      Readable.from(plain ? tarball : zlib.gunzipSync(tarball)).pipe(extract);
    });
    return headers;
  }

  /** Write `files` with {@link writeTar} into a throwaway cache and read back the stored archive. */
  async function writtenTar(files: FileSet, options?: Parameters<typeof writeTar>[3]): Promise<Buffer> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-pack-cache-"));
    const cache = new BuildCache(dir, new LogFormatter(LogLevel.Info, () => undefined));
    try {
      const written = await writeTar(files, cache.getTemporaryWriteStream(), "layer.tar", options);
      return await written.getBuffer();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("rejects (rather than hanging) when the output it writes into fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-pack-cache-"));
    const cache = new BuildCache(dir, new LogFormatter(LogLevel.Info, () => undefined));
    const work = path.join(dir, "work");
    const own = path.join(
      work,
      fs.readdirSync(work).find(name => name.endsWith(`-${process.pid}`))!
    );
    fs.chmodSync(own, 0o500);
    try {
      const files = new FileSet(new Map([["big.bin", new MemoryFile(Buffer.alloc(1024 * 1024, 7))]]));
      const failure = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out (hang)")), 5000);
        writeTar(files, cache.getTemporaryWriteStream(), "layer.tar").then(
          () => resolve(""),
          (err: NodeJS.ErrnoException) => {
            clearTimeout(timer);
            resolve(err.code ?? err.message);
          }
        );
      });
      expect(failure).to.equal("EACCES");
    } finally {
      fs.chmodSync(own, 0o700);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dedups identical content as a hardlink to the first entry", async () => {
    const tarball = await packToTarball(fileSetOf({ "a.txt": "same", "b.txt": "same", "c.txt": "diff" }));

    /* Read the raw entry headers: in sorted order a.txt is the content, b.txt a
     * hardlink to it (identical bytes packed once), c.txt its own content. */
    const headers = await headersOf(tarball);
    expect(headers.find(h => h.name === "a.txt")?.type).to.equal("file");
    expect(headers.find(h => h.name === "b.txt")?.type).to.equal("link");
    expect(headers.find(h => h.name === "c.txt")?.type).to.equal("file");

    /* It round-trips: both names come back sharing one content hash. */
    const unpacked = await unpackInTemp(tarball);
    expect(unpacked.size).to.equal(3);
    expect((await unpacked.get("a.txt"))?.hash).to.equal((await unpacked.get("b.txt"))?.hash);
  });

  it("packs identical content as its own entry when hardlinks are off", async () => {
    /* For a destination that refuses links — npm's registry rejects an upload
     * containing one — the repeat carries its own bytes instead. */
    const tarball = await packToTarball(fileSetOf({ "a.txt": "same", "b.txt": "same" }), { hardlinks: false });

    const headers = await headersOf(tarball);
    expect(headers.map(h => h.type)).to.deep.equal(["file", "file"]);

    const unpacked = await unpackInTemp(tarball);
    expect(unpacked.size).to.equal(2);
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

  it("writes an uncompressed archive into the store, streaming each file's content", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-pack-"));
    try {
      fs.writeFileSync(path.join(dir, "big.bin"), Buffer.alloc(200_000, 7));
      const source = new FileSet(
        new Map<string, IFile>([
          ["usr/lib/big.bin", diskFile(path.join(dir, "big.bin"))],
          ["etc/motd", MemoryFile.from("hi\n")],
        ])
      );
      const headers = await headersOf(await writtenTar(source), true);
      expect(headers.map(h => [h.name, h.type])).to.deep.equal([
        ["etc/motd", "file"],
        ["usr/lib/big.bin", "file"],
      ]);
      expect(headers[1].body.length).to.equal(200_000);
      expect(headers.every(h => h.uid === 0 && h.gid === 0)).to.equal(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives every directory above a file an entry of its own, before its contents, when asked", async () => {
    const headers = await headersOf(
      await writtenTar(fileSetOf({ "a/b/c.txt": "c", "a-z.txt": "z", "a/d.txt": "d" }), { directories: true }),
      true
    );
    expect(headers.map(h => [h.name.replace(/\/$/, ""), h.type])).to.deep.equal([
      ["a-z.txt", "file"],
      ["a", "directory"],
      ["a/b", "directory"],
      ["a/b/c.txt", "file"],
      ["a/d.txt", "file"],
    ]);
    expect(headers.filter(h => h.type === "directory").map(h => h.mode)).to.deep.equal([0o755, 0o755]);
  });

  it("writes the same bytes as it packs before compressing", async () => {
    const source = fileSetOf({ "a.txt": "one", "b/c.txt": "two" });
    expect((await writtenTar(source)).equals(zlib.gunzipSync(await packToTarball(source)))).to.equal(true);
  });

  it("is deterministic — identical content packs to identical bytes", async () => {
    const a = await packToTarball(fileSetOf({ "a.txt": "one", "b.txt": "two" }));
    /* Different insertion order, same content: sorted-entry + fixed-mtime packing
     * must yield byte-identical output (it is content-addressed and cached). */
    const b = await packToTarball(fileSetOf({ "b.txt": "two", "a.txt": "one" }));
    expect(a.equals(b)).to.equal(true);
  });
});
