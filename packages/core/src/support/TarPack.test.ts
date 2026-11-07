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
import { Readable } from "stream";
import { expect } from "chai";
import { TarExtract } from "./TarExtract";
import { TarEntryHeader, TarHeader } from "./TarHeader";
import { TarPack } from "./TarPack";

/** A `security.capability` value as `setcap cap_setuid=ep` writes it: vfs_cap_data revision 2, CAP_SETUID permitted and effective. */
const SETUID_CAPABILITY = Buffer.from("0100000280000000000000000000000000000000", "hex");

interface IReadEntry {
  header: TarHeader;
  content: Buffer;
}

/** @return everything `pack` writes. */
function bytesOf(pack: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    pack.on("data", (chunk: Buffer) => chunks.push(chunk));
    pack.on("end", () => resolve(Buffer.concat(chunks)));
    pack.on("error", reject);
  });
}

/** Pack `entries`, each with its content, into an archive. */
function packed(entries: ReadonlyArray<[TarEntryHeader, (string | Buffer)?]>): Promise<Buffer> {
  const pack = new TarPack();
  const bytes = bytesOf(pack);
  for (const [header, content] of entries) {
    pack.entry(header, content ?? Buffer.alloc(0));
  }
  pack.finalize();
  return bytes;
}

/** Read every entry of `archive`, fed in chunks of `chunk` bytes. */
function extracted(archive: Buffer, chunk = 777): Promise<IReadEntry[]> {
  const extract = new TarExtract();
  const entries: IReadEntry[] = [];
  return new Promise((resolve, reject) => {
    extract.on("entry", (header, content, next) => {
      const chunks: Buffer[] = [];
      content.on("data", (data: Buffer) => chunks.push(data));
      content.on("error", reject);
      content.on("end", () => {
        entries.push({ header, content: Buffer.concat(chunks) });
        next();
      });
    });
    extract.on("finish", () => resolve(entries));
    extract.on("error", reject);
    const parts: Buffer[] = [];
    for (let at = 0; at < archive.length; at += chunk) {
      parts.push(archive.subarray(at, at + chunk));
    }
    Readable.from(parts).pipe(extract);
  });
}

/** @return a pax record as tar writes one: `<length> <key>=<value>\n`, its length counting itself. */
function paxRecord(key: string, value: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(` ${key}=`), value, Buffer.from("\n")]);
  for (let digits = 1; ; digits++) {
    const length = body.length + digits;
    if (String(length).length === digits) {
      return Buffer.concat([Buffer.from(String(length)), body]);
    }
  }
}

/** @return one ustar header block, written by hand as another tar would write it. */
function ustarBlock(typeflag: string, name: string, size: number, options: { linkname?: string; mtime?: number } = {}): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, "utf8");
  block.write("0000644\0", 100, "latin1");
  block.write("0000000\0", 108, "latin1");
  block.write("0000000\0", 116, "latin1");
  block.write(size.toString(8).padStart(11, "0") + "\0", 124, "latin1");
  block.write((options.mtime ?? 0).toString(8).padStart(11, "0") + "\0", 136, "latin1");
  block.write(typeflag, 156, "latin1");
  block.write(options.linkname ?? "", 157, 100, "utf8");
  block.write("ustar\u000000", 257, "latin1");
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) {
    sum += byte;
  }
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  return block;
}

/** @return `content` padded with zeros to a whole number of blocks. */
function padded(content: Buffer): Buffer {
  return Buffer.concat([content, Buffer.alloc((512 - (content.length % 512)) % 512)]);
}

describe("TarPack and TarExtract", () => {
  it("round-trips files, directories, symlinks and hardlinks with their header fields", async () => {
    const mtime = new Date(1_700_000_000_000);
    const archive = await packed([
      [{ name: "etc", type: "directory", mtime }],
      [{ name: "etc/motd", mode: 0o640, uid: 1000, gid: 100, uname: "nathan", gname: "users", mtime }, "hello\n"],
      [{ name: "etc/issue", type: "symlink", linkname: "motd", mode: 0o777, mtime }],
      [{ name: "etc/motd2", type: "link", linkname: "etc/motd", mtime }],
      [{ name: "bin/tool", mode: 0o4755, mtime }, Buffer.from([0, 1, 2, 0xff])],
    ]);
    const entries = await extracted(archive);
    expect(entries.map(({ header }) => [header.name, header.type, header.mode & 0o7777, header.linkname])).to.deep.equal([
      ["etc/", "directory", 0o755, ""],
      ["etc/motd", "file", 0o640, ""],
      ["etc/issue", "symlink", 0o777, "motd"],
      ["etc/motd2", "link", 0o644, "etc/motd"],
      ["bin/tool", "file", 0o4755, ""],
    ]);
    const motd = entries[1];
    expect([motd.header.uid, motd.header.gid, motd.header.uname, motd.header.gname]).to.deep.equal([1000, 100, "nathan", "users"]);
    expect(motd.header.mtime.getTime()).to.equal(mtime.getTime());
    expect(motd.content.toString()).to.equal("hello\n");
    expect(entries[4].content).to.deep.equal(Buffer.from([0, 1, 2, 0xff]));
    /* A plain archive needs no pax header at all. */
    expect(archive.includes("PaxHeader")).to.equal(false);
  });

  it("writes a name or link target no ustar field holds as pax records, and reads them back", async () => {
    const longName = `usr/share/${"a".repeat(150)}/file.txt`;
    const unsplittable = "b".repeat(120);
    const unicode = "usr/share/doc/café/README";
    const longTarget = `../${"c".repeat(120)}/target`;
    const entries = await extracted(
      await packed([
        [{ name: longName }, "one"],
        [{ name: unsplittable }, "two"],
        [{ name: unicode }, "three"],
        [{ name: "link", type: "symlink", linkname: longTarget }],
      ])
    );
    expect(entries.map(({ header }) => header.name)).to.deep.equal([longName, unsplittable, unicode, "link"]);
    expect(entries[3].header.linkname).to.equal(longTarget);
    expect(entries.map(({ content }) => content.toString())).to.deep.equal(["one", "two", "three", ""]);
    /* What pax carries is in the fields, not repeated among the records. */
    expect(entries.every(({ header }) => header.pax.size === 0)).to.equal(true);
  });

  it("splits a long name across the ustar prefix where it fits, with no pax header", async () => {
    const name = `${"d".repeat(90)}/${"e".repeat(90)}/f.txt`;
    const archive = await packed([[{ name }, "x"]]);
    expect(archive.includes("PaxHeader")).to.equal(false);
    expect((await extracted(archive))[0].header.name).to.equal(name);
  });

  it("carries a binary extended attribute through extract and pack byte for byte", async () => {
    /* The archive as dnf's rpm payload reaches docker cp: a pax header holding
     * the file capability, its value bytes that are not UTF-8. */
    const records = Buffer.concat([
      paxRecord("SCHILY.xattr.security.capability", SETUID_CAPABILITY),
      paxRecord("SCHILY.xattr.user.note", Buffer.from("ok")),
    ]);
    const archive = Buffer.concat([
      ustarBlock("x", "PaxHeader/newuidmap", records.length),
      padded(records),
      ustarBlock("0", "usr/bin/newuidmap", 3),
      padded(Buffer.from("elf")),
      Buffer.alloc(1024),
    ]);
    const [first] = await extracted(archive);
    expect(first.header.name).to.equal("usr/bin/newuidmap");
    expect([...first.header.xattrs.keys()]).to.deep.equal(["security.capability", "user.note"]);
    expect(first.header.xattrs.get("security.capability")).to.deep.equal(SETUID_CAPABILITY);
    expect(first.header.pax.size).to.equal(0);

    const repacked = await packed([[{ ...first.header }, first.content]]);
    /* The records go back out exactly as they came in. */
    expect(repacked.includes(records)).to.equal(true);
    const [again] = await extracted(repacked);
    expect(again.header.xattrs.get("security.capability")!.equals(SETUID_CAPABILITY)).to.equal(true);
    expect(again.header.xattrs.get("user.note")!.toString()).to.equal("ok");
    expect(again.content.toString()).to.equal("elf");
  });

  it("keeps the pax records it does not interpret, and writes them back", async () => {
    const [entry] = await extracted(
      await packed([
        [
          {
            name: "a",
            pax: new Map([
              ["comment", "héllo"],
              ["SUN.devmajor", "0"],
            ]),
          },
          "a",
        ],
      ])
    );
    expect([...entry.header.pax]).to.deep.equal([
      ["SUN.devmajor", "0"],
      ["comment", "héllo"],
    ]);
  });

  it("writes and reads a pax mtime where the ustar field cannot hold it", async () => {
    const entries = await extracted(
      await packed([
        [{ name: "fraction", mtime: new Date(1_700_000_000_250) }, "x"],
        [{ name: "before-epoch", mtime: new Date(-1_500) }, "x"],
        [{ name: "whole", mtime: new Date(1_700_000_000_000) }, "x"],
      ])
    );
    expect(entries.map(({ header }) => header.mtime.getTime())).to.deep.equal([1_700_000_000_250, -1_500, 1_700_000_000_000]);

    /* As another tar writes one. */
    const records = paxRecord("mtime", Buffer.from("1234567890.5"));
    const [read] = await extracted(
      Buffer.concat([
        ustarBlock("x", "PaxHeader", records.length),
        padded(records),
        ustarBlock("0", "f", 0, { mtime: 7 }),
        Buffer.alloc(1024),
      ])
    );
    expect(read.header.mtime.getTime()).to.equal(1_234_567_890_500);
  });

  it("applies a global pax header's records to every entry after it, an entry's own over them", async () => {
    const global = paxRecord("comment", Buffer.from("global"));
    const own = paxRecord("comment", Buffer.from("own"));
    const entries = await extracted(
      Buffer.concat([
        ustarBlock("g", "pax_global_header", global.length),
        padded(global),
        ustarBlock("0", "a", 0),
        ustarBlock("x", "PaxHeader", own.length),
        padded(own),
        ustarBlock("0", "b", 0),
        ustarBlock("0", "c", 0),
        Buffer.alloc(1024),
      ])
    );
    expect(entries.map(({ header }) => [header.name, header.pax.get("comment")])).to.deep.equal([
      ["a", "global"],
      ["b", "own"],
      ["c", "global"],
    ]);
  });

  it("streams a large entry with backpressure, the next entry read only after it", async () => {
    const size = 8 * 1024 * 1024;
    const chunk = Buffer.alloc(64 * 1024, 0xa5);
    let produced = 0;
    let consumed = 0;
    let furthestAhead = 0;
    const source = new Readable({
      read() {
        if (produced >= size) {
          this.push(null);
        } else {
          produced += chunk.length;
          this.push(chunk);
        }
      },
    });
    const pack = new TarPack();
    source.pipe(pack.entry({ name: "big.bin", size }));
    pack.entry({ name: "after.txt" }, "after");
    pack.finalize();

    const extract = new TarExtract();
    const order: string[] = [];
    const digest = createHash("sha256");
    await new Promise<void>((resolve, reject) => {
      extract.on("entry", (header, content, next) => {
        order.push(`start ${header.name}`);
        content.on("data", (data: Buffer) => {
          consumed += data.length;
          furthestAhead = Math.max(furthestAhead, produced - consumed);
          if (header.name === "big.bin") {
            digest.update(data);
            /* A slow reader: pause a turn per chunk. */
            content.pause();
            setImmediate(() => content.resume());
          }
        });
        content.on("end", () => {
          order.push(`end ${header.name}`);
          next();
        });
      });
      extract.on("finish", () => resolve());
      extract.on("error", reject);
      pack.pipe(extract);
    });
    expect(order).to.deep.equal(["start big.bin", "end big.bin", "start after.txt", "end after.txt"]);
    expect(digest.digest("hex")).to.equal(createHash("sha256").update(Buffer.alloc(size, 0xa5)).digest("hex"));
    /* The writer was held back by the reader rather than buffering the entry. */
    expect(furthestAhead).to.be.lessThan(1024 * 1024);
  });

  it("packs a fixed input to the same bytes every time, whatever order its records were given in", async () => {
    const entries = (reversed: boolean): Array<[TarEntryHeader, string]> => {
      const records: Array<[string, string]> = [
        ["comment", "x"],
        ["SUN.devmajor", "0"],
      ];
      const xattrs: Array<[string, Buffer]> = [
        ["security.capability", SETUID_CAPABILITY],
        ["user.a", Buffer.from("a")],
      ];
      return [
        [{ name: "a".repeat(200), mtime: new Date(0) }, "one"],
        [
          {
            name: "b",
            mtime: new Date(0),
            pax: new Map(reversed ? records.reverse() : records),
            xattrs: new Map(reversed ? xattrs.reverse() : xattrs),
          },
          "two",
        ],
      ];
    };
    const first = await packed(entries(false));
    expect((await packed(entries(false))).equals(first)).to.equal(true);
    expect((await packed(entries(true))).equals(first)).to.equal(true);
  });

  it("refuses a corrupt header and an archive that ends mid-entry", async () => {
    const archive = await packed([[{ name: "a.txt" }, "hello"]]);
    const corrupt = Buffer.from(archive);
    corrupt[0] ^= 0xff;
    const failure = await extracted(corrupt).catch((err: Error) => err);
    expect((failure as Error).message).to.match(/Invalid tar header/);
    const truncated = await extracted(archive.subarray(0, 512 + 2)).catch((err: Error) => err);
    expect((truncated as Error).message).to.equal("Unexpected end of data");
  });

  it("refuses content that does not match the entry's size", async () => {
    const pack = new TarPack();
    pack.on("data", () => undefined);
    pack.on("error", () => undefined);
    const outcome = new Promise<Error | null | undefined>(resolve => {
      const sink = pack.entry({ name: "a", size: 4 }, resolve);
      sink.on("error", () => undefined);
      sink.end("too long");
    });
    expect((await outcome)?.message).to.equal("Size mismatch");
    expect(pack.destroyed).to.equal(true);
  });
});
