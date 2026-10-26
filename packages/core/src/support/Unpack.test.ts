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

import { Readable } from "stream";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as tar from "tar-stream";
import * as xz from "@napi-rs/lzma/xz";
import { unpackStream } from "./Unpack";
import { readZipMember } from "./UnpackZip";
import { packToZip } from "./PackZip";
import * as zlib from "zlib";
import * as crypto from "crypto";
import { FileSet } from "../core/FileSet";
import { MemoryFile } from "../core/MemoryFS";
import { IOutputHandle } from "./Execute";
import { BuildCache } from "../core/BuildCache";
import { SymlinkFile } from "../core/SymlinkFile";
import { Computable } from "../core/Computable";
import { LogFormatter, LogLevel } from "./Log";
import { expect } from "chai";

/* Settle a Computable to a promise with a hard timeout, so a *hang* — the failure
 * mode these error-path tests exist to catch — fails loudly instead of stalling jest. */
function withTimeout<T>(c: Computable<T>, ms = 2000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out (hang)")), ms);
    c.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      err => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

describe("Unpack", () => {
  /* Unpack streams each entry straight into the content-addressed store, so a
   * test provides a CAS-output factory backed by a temp BuildCache. The returned
   * FileSet holds blob-backed files. */
  let cacheDir: string;
  let createOutput: () => IOutputHandle;
  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-unpack-cache-"));
    const cache = new BuildCache(cacheDir, new LogFormatter(LogLevel.Info, () => undefined));
    createOutput = () => cache.getTemporaryWriteStream();
  });
  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it("tar.gz", async () => {
    const input = Buffer.from(
      `H4sICKfHJGYAA3Rlc3QudGFyAO2UzY6bMBDHc85ToBz2VJuvAKs97aFSLz30CVI54A1OwFges2pU
        7bvXNiQBmranVdVqfgcMM/P3jMeTKFae2IHTI3Ry9U5EljzfujUusmi6OpI4z1fxNo8tebS1cXGa
        5OkqiN6roCk9GKaDYCVP/Cw5/DLuT/5/lO/rINhI1vLNU7B5fmF7HbrH5oOzv3INopPOFdF4sDWi
        5BJ8+Kcvn0lKI9Jp0jDDR1HdtVzZkXIRtTEKnsLwIEzd72nZteE1xRGGeCi1UAZsuKvFGva9aCqn
        NlD6EGszHIwzHd062hohvY2DewtAX6P9CaxHdhX/2nZV33AI6V7I0ABxRhccClnxb9TARVWJIceZ
        aRn4IoKHh8B/ufTXD5/XSt58+RVX3G4kS8EnZyjr7iQq5qvYpTSj6SWLErYLzJS1dyU0HRvrDsk0
        AaM5a0dZTIuLr5dWV3GidKe4NkOyzS72+kkxrx/v1vNszsr2oKyZ8LrtNO/ESRi4FK0A7q9gV9gi
        Hu8FQr8Hbq5FpIuY43hhu6SgWxotvO4OBmlB7WQlC/fPPVpucKdVywp+07HFbn4AyTBG4bAQ1fQH
        4Sd/l9E4WjZrJlFMA9d3YmftzqfWu32e6eYNzm81D0m9/ZEWSzspO/kiDnZzbuyZ9RiX3eLmN3Md
        sJkgsYLbWAKZaiadHn9NxI7dWOdkWG59GluQ0cxP6vpt/bf/9RAEQRAEQRAEQRAEQRAEQRAEQRAE
        QRAEQf4ffgC7sbEGACgAAA==`,
      "base64"
    );

    const ins = Readable.from(input);
    const result = await unpackStream(ins, createOutput);
    expect(result.size).to.equal(1);
    const file = await result.get("package.json");
    expect(file?.hash).to.equal("ff344d6ce0cb6497bcc78b026420dee7538870af60809bab61e9a2e83b70a287");
  });

  it("tar.xz — decompresses the xz layer and unpacks the tar beneath it", async () => {
    /* Built here rather than pasted as a fixture, so the test exercises a real
     * xz container (the shape most native toolchains publish) rather than a
     * blob whose provenance nobody can check. */
    const pack = tar.pack();
    pack.entry({ name: "payload/greeting.txt" }, "hello from xz\n");
    pack.entry({ name: "payload/other.txt" }, "second\n");
    pack.finalize();
    const tarred = await new Promise<Buffer>(resolve => {
      const chunks: Buffer[] = [];
      pack.on("data", (chunk: Buffer) => chunks.push(chunk));
      pack.on("end", () => resolve(Buffer.concat(chunks)));
    });

    const result = await withTimeout(unpackStream(Readable.from(xz.compressSync(tarred)), createOutput));
    expect([...result].map(([name]) => name).sort()).to.deep.equal(["payload/greeting.txt", "payload/other.txt"]);
    expect(await result.readFile("payload/greeting.txt")).to.equal("hello from xz\n");
  });

  it("preserves the executable bit from tar entry modes", async () => {
    const pack = tar.pack();
    pack.entry({ name: "package/bin/tool", mode: 0o755 }, "#!/bin/sh\n");
    pack.entry({ name: "package/lib/plain.js", mode: 0o644 }, "module.exports = 1;\n");
    pack.finalize();

    const result = await unpackStream(pack, createOutput);
    expect(result.size).to.equal(2);
    /* The mode rides the (blob-backed) IFile; 0o111 = any execute bit. */
    const tool = await result.get("package/bin/tool");
    const plain = await result.get("package/lib/plain.js");
    if (!tool || !plain) {
      throw new Error("expected both entries");
    }
    expect(tool.mode & 0o111).to.not.equal(0);
    expect(plain.mode & 0o111).to.equal(0);
  });

  it("translates a symlink to a SymlinkFile and resolves a hardlink to shared content", async () => {
    const pack = tar.pack();
    pack.entry({ name: "package/real.js", mode: 0o644 }, "module.exports = 1;\n");
    pack.entry({ name: "package/link.js", type: "symlink", linkname: "real.js" });
    /* A hardlink shares the earlier entry's content — content-addressed
     * storage makes it a dedup: same hash under a second name. */
    pack.entry({ name: "package/hard.js", type: "link", linkname: "package/real.js" });
    /* A hardlink to a target that never appears (or was dropped) is itself dropped. */
    pack.entry({ name: "package/dangling.js", type: "link", linkname: "package/missing.js" });
    pack.finalize();

    const result = await unpackStream(pack, createOutput);
    expect(result.size).to.equal(3);
    const link = await result.get("package/link.js");
    expect(link).to.be.instanceOf(SymlinkFile);
    expect((link as SymlinkFile).target).to.equal("real.js");
    const real = await result.get("package/real.js");
    const hard = await result.get("package/hard.js");
    expect(hard).to.not.equal(undefined);
    expect(hard?.hash).to.equal(real?.hash);
    expect(await result.get("package/dangling.js")).to.equal(undefined);
  });

  it("rejects (rather than hanging) when the stream errors before a full header", async () => {
    const ins = new Readable({ read() {} });
    const result = unpackStream(ins, createOutput);
    /* Fewer than SNIFF_LENGTH bytes arrive, then the connection fails. */
    setImmediate(() => {
      ins.push(Buffer.alloc(16));
      ins.destroy(new Error("connection reset"));
    });
    let err: Error | undefined;
    try {
      await withTimeout(result);
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).to.equal("connection reset");
  });

  it("rejects (rather than crashing) when the stream drops mid-archive", async () => {
    /* A valid TAR magic (ustar at offset 257) clears the header phase; the
     * connection then drops, exercising the live pipe's error path. */
    const head = Buffer.alloc(512);
    head.write("ustar", 257, "ascii");
    const ins = new Readable({ read() {} });
    const result = unpackStream(ins, createOutput);
    setImmediate(() => {
      ins.push(head);
      setImmediate(() => ins.destroy(new Error("connection dropped")));
    });
    let err: Error | undefined;
    try {
      await withTimeout(result);
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.be.instanceOf(Error);
    expect(err?.message).to.not.equal("timed out (hang)");
  });

  it("strips a leading '/' (absolute → relative) and drops a '../' escape", async () => {
    const pack = tar.pack();
    pack.entry({ name: "package/ok.txt" }, "safe");
    /* A `../` traversal escapes the tree → dropped. An absolute name has its
     * leading `/` stripped → a relative key, kept (it stages under the install
     * root, contained). Under CAS nothing is written by name at all — these are
     * pure FileSet-key semantics. */
    pack.entry({ name: "../fabr-tar-slip.txt" }, "evil");
    pack.entry({ name: "/etc/fabr-tar-slip.txt" }, "abs");
    pack.finalize();

    const result = await unpackStream(pack, createOutput);
    expect(result.size).to.equal(2);
    expect(await result.get("package/ok.txt")).to.not.equal(undefined);
    expect(await result.get("etc/fabr-tar-slip.txt"), "absolute name stripped to relative, kept").to.not.equal(undefined);
    expect(await result.get("../fabr-tar-slip.txt"), "'../' escape dropped").to.equal(undefined);
  });

  describe("zip", () => {
    /** A zip entry for {@link handZip}: deflated unless `stored`, its sizes in
     *  a data descriptor after the data where `descriptor`, and `mode` (with
     *  its file type) in the central directory. */
    interface HandEntry {
      name: string;
      content: string | Buffer;
      stored?: boolean;
      descriptor?: boolean;
      mode?: number;
      badCrc?: boolean;
    }

    /** Write a zip by hand, as tools other than fabr do (the JDK's `jar` writes data descriptors). */
    function handZip(entries: HandEntry[]): Buffer {
      const chunks: Buffer[] = [];
      const central: Buffer[] = [];
      let offset = 0;
      for (const entry of entries) {
        const name = Buffer.from(entry.name, "utf8");
        const raw = typeof entry.content === "string" ? Buffer.from(entry.content, "utf8") : entry.content;
        const data = entry.stored ? raw : zlib.deflateRawSync(raw);
        const crc = zlib.crc32(raw) ^ (entry.badCrc ? 1 : 0);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800 | (entry.descriptor ? 0x8 : 0), 6);
        local.writeUInt16LE(entry.stored ? 0 : 8, 8);
        if (!entry.descriptor) {
          local.writeUInt32LE(crc >>> 0, 14);
          local.writeUInt32LE(data.length, 18);
          local.writeUInt32LE(raw.length, 22);
        }
        local.writeUInt16LE(name.length, 26);
        const descriptor = Buffer.alloc(entry.descriptor ? 16 : 0);
        if (entry.descriptor) {
          descriptor.writeUInt32LE(0x08074b50, 0);
          descriptor.writeUInt32LE(crc >>> 0, 4);
          descriptor.writeUInt32LE(data.length, 8);
          descriptor.writeUInt32LE(raw.length, 12);
        }
        const header = Buffer.alloc(46);
        header.writeUInt32LE(0x02014b50, 0);
        header.writeUInt16LE((3 << 8) | 20, 4);
        header.writeUInt16LE(20, 6);
        header.writeUInt16LE(0x0800, 8);
        header.writeUInt16LE(entry.stored ? 0 : 8, 10);
        header.writeUInt32LE(crc >>> 0, 16);
        header.writeUInt32LE(data.length, 20);
        header.writeUInt32LE(raw.length, 24);
        header.writeUInt16LE(name.length, 28);
        header.writeUInt32LE(((entry.mode ?? 0o100644) * 0x10000) >>> 0, 38);
        header.writeUInt32LE(offset, 42);
        central.push(header, name);
        chunks.push(local, name, data, descriptor);
        offset += local.length + name.length + data.length + descriptor.length;
      }
      const directory = Buffer.concat(central);
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(entries.length, 8);
      end.writeUInt16LE(entries.length, 10);
      end.writeUInt32LE(directory.length, 12);
      end.writeUInt32LE(offset, 16);
      return Buffer.concat([...chunks, directory, end]);
    }

    /** Stream `zip` in chunks of `size` bytes, so entries and headers straddle chunk boundaries. */
    function chunked(zip: Buffer, size: number): Readable {
      const pieces: Buffer[] = [];
      for (let at = 0; at < zip.length; at += size) {
        pieces.push(zip.subarray(at, at + size));
      }
      return Readable.from(pieces);
    }

    async function contents(files: FileSet): Promise<Record<string, string>> {
      const read: Record<string, string> = {};
      for (const [name, file] of files) {
        read[name] = file instanceof SymlinkFile ? `-> ${file.target}` : await file.readString();
      }
      return read;
    }

    it("reads back what packToZip writes, without its directory entries, in chunks of any size", async () => {
      const zip = await packToZip(
        new FileSet(
          new Map([
            ["META-INF/MANIFEST.MF", MemoryFile.from("Manifest-Version: 1.0\r\n")],
            ["com/x/A.class", MemoryFile.from("a".repeat(500))],
            ["empty.txt", MemoryFile.from("")],
          ])
        )
      );
      for (const size of [1, 7, 64, zip.length]) {
        const files = await withTimeout(unpackStream(chunked(zip, size), createOutput));
        expect(await contents(files), `in chunks of ${size}`).to.deep.equal({
          "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\r\n",
          "com/x/A.class": "a".repeat(500),
          "empty.txt": "",
        });
      }
    });

    it("reads entries whose sizes follow their data, stored or deflated", async () => {
      const zip = handZip([
        { name: "a.txt", content: "deflated ".repeat(40), descriptor: true },
        { name: "b.txt", content: "stored, and holding PK\x07\x08 inside", stored: true, descriptor: true },
        { name: "c.txt", content: "", descriptor: true },
        { name: "d.txt", content: "plain" },
      ]);
      for (const size of [1, 5, zip.length]) {
        const files = await withTimeout(unpackStream(chunked(zip, size), createOutput));
        expect(await contents(files), `in chunks of ${size}`).to.deep.equal({
          "a.txt": "deflated ".repeat(40),
          "b.txt": "stored, and holding PK\x07\x08 inside",
          "c.txt": "",
          "d.txt": "plain",
        });
      }
    });

    it("goes on past an entry that fills its inflater and ends within a chunk", async () => {
      /* Incompressible, so the deflated entry overruns the inflater's buffer
       * before the next entry begins in the same chunk. */
      const blocks: Buffer[] = [crypto.createHash("sha256").update("seed").digest()];
      while (blocks.length < 10000) {
        blocks.push(crypto.createHash("sha256").update(blocks[blocks.length - 1]).digest());
      }
      const noise = Buffer.concat(blocks);
      const zip = handZip([
        { name: "noise.bin", content: noise },
        { name: "after.txt", content: "after" },
      ]);
      const files = await withTimeout(unpackStream(Readable.from([zip]), createOutput), 10000);
      expect(await files.getFile("after.txt")!.readString()).to.equal("after");
      expect((await files.getFile("noise.bin")!.getBuffer()).equals(noise)).to.equal(true);
    });

    it("takes modes and symlinks from the central directory", async () => {
      const zip = handZip([
        { name: "bin/tool", content: "#!/bin/sh\n", mode: 0o100755 },
        { name: "bin/alias", content: "tool", mode: 0o120777, stored: true },
        { name: "readme", content: "hi" },
      ]);
      const files = await withTimeout(unpackStream(Readable.from([zip]), createOutput));
      expect(await contents(files)).to.deep.equal({ "bin/tool": "#!/bin/sh\n", "bin/alias": "-> tool", readme: "hi" });
      expect(files.getFile("bin/tool")!.mode & 0o777).to.equal(0o755);
      expect(files.getFile("readme")!.mode & 0o777).to.equal(0o644);
    });

    it("refuses an archive with a name that escapes the tree", async () => {
      const refused = await withTimeout(
        unpackStream(Readable.from([handZip([{ name: "../evil", content: "x" }, { name: "ok", content: "y" }])]), createOutput)
      ).then(
        () => "",
        (err: Error) => err.message
      );
      expect(refused).to.match(/ZIP archive cannot be read: invalid relative path: \.\.\/evil/);
    });

    it("refuses an entry whose content does not match its CRC-32, and a truncated archive", async () => {
      const corrupt = await withTimeout(unpackStream(Readable.from([handZip([{ name: "a", content: "x", badCrc: true }])]), createOutput)).then(
        () => "",
        (err: Error) => err.message
      );
      expect(corrupt).to.match(/ZIP entry 'a' is corrupt/);
      const whole = handZip([{ name: "a", content: "x" }]);
      const truncated = await withTimeout(unpackStream(Readable.from([whole.subarray(0, whole.length - 30)]), createOutput)).then(
        () => "",
        (err: Error) => err.message
      );
      expect(truncated).to.match(/ZIP archive cannot be read: .*truncated/);
    });

    it("rejects (rather than hanging) when the stream drops mid-archive", async () => {
      const zip = handZip([{ name: "a.txt", content: "a".repeat(5000), stored: true }]);
      const ins = new Readable({ read() {} });
      const result = unpackStream(ins, createOutput);
      setImmediate(() => {
        ins.push(zip.subarray(0, 600));
        setImmediate(() => ins.destroy(new Error("connection dropped")));
      });
      const failure = await withTimeout(result).then(
        () => "",
        (err: Error) => err.message
      );
      expect(failure).to.equal("connection dropped");
    });

    it("reads one member, passing over the rest", async () => {
      const zip = handZip([
        { name: "big.bin", content: "z".repeat(1000), descriptor: true },
        { name: "META-INF/MANIFEST.MF", content: "Main-Class: x.Y\r\n" },
      ]);
      expect((await withTimeout(readZipMember(zip, "META-INF/MANIFEST.MF")))?.toString()).to.equal("Main-Class: x.Y\r\n");
      expect(await withTimeout(readZipMember(zip, "missing"))).to.equal(undefined);
    });
  });
});
