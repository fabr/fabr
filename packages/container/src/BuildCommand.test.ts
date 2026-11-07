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

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Readable } from "stream";
import { expect } from "chai";
import { BuildCache, LogFormatter, LogLevel, TarExtract, TarHeader, TarPack } from "@fabr-build/core";
import { changedPaths, writeChanges } from "./BuildCommand";

/** A `security.capability` value as `setcap cap_setuid=ep` writes it: vfs_cap_data revision 2, its bytes not UTF-8. */
const SETUID_CAPABILITY = Buffer.from("0100000280000000000000000000000000000000", "hex");

/** @return everything `pack` writes. */
function bytesOf(pack: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    pack.on("data", (chunk: Buffer) => chunks.push(chunk));
    pack.on("end", () => resolve(Buffer.concat(chunks)));
    pack.on("error", reject);
  });
}

/** @return the headers of the entries of `archive`. */
function headersOf(archive: Buffer): Promise<TarHeader[]> {
  const extract = new TarExtract();
  const headers: TarHeader[] = [];
  return new Promise((resolve, reject) => {
    extract.on("entry", (header, content, next) => {
      headers.push(header);
      content.on("end", () => next());
      content.resume();
    });
    extract.on("finish", () => resolve(headers));
    extract.on("error", reject);
    extract.end(archive);
  });
}

describe("changedPaths", () => {
  it("copies each added tree by its top and each changed file, and whites out each deleted tree by its top", () => {
    const diff = [
      "C /usr",
      "C /usr/bin",
      "A /usr/bin/curl",
      "A /usr/share/curl",
      "A /usr/share/curl/a",
      "A /usr/share/curl/b/c",
      "C /etc",
      "C /etc/apk/world",
      "D /etc/motd",
      "D /var/cache/old",
      "D /var/cache/old/x",
      "",
    ].join("\n");
    expect(changedPaths(diff)).to.deep.equal({
      copies: ["/etc/apk/world", "/usr/bin/curl", "/usr/share/curl"],
      deletions: ["/etc/motd", "/var/cache/old"],
    });
  });

  it("reads nothing from output that is not a change", () => {
    expect(changedPaths("warning: something\n\n")).to.deep.equal({ copies: [], deletions: [] });
  });
});

describe("writeChanges", () => {
  it("writes each copied entry into the layer at its path with everything it carries, its times fixed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-build-command-"));
    try {
      /* What `docker cp <container>:/usr/bin -` streams out: entries relative to /usr. */
      const copy = new TarPack();
      const copied = bytesOf(copy);
      copy.entry({ name: "bin", type: "directory", mtime: new Date(1_700_000_000_000) });
      copy.entry(
        {
          name: "bin/newuidmap",
          mode: 0o755,
          mtime: new Date(1_700_000_000_123),
          pax: new Map([
            ["atime", "1700000001.5"],
            ["comment", "kept"],
          ]),
          xattrs: new Map([["security.capability", SETUID_CAPABILITY]]),
        },
        "elf"
      );
      copy.entry({ name: "bin/newgidmap", type: "link", linkname: "bin/newuidmap" });
      copy.finalize();
      const archive = path.join(dir, "changed-0.tar");
      fs.writeFileSync(archive, await copied);

      const cache = new BuildCache(path.join(dir, "cache"), new LogFormatter(LogLevel.Info, () => undefined));
      const { records } = await writeChanges(
        cache.getTemporaryWriteStream(),
        ["/etc/motd"],
        [{ path: "/usr/bin", archive }],
        "layer/layer.tar"
      );
      const layer = await records.get("layer/layer.tar")!.getBuffer();

      const headers = await headersOf(layer);
      expect(headers.map(header => [header.name, header.type, header.linkname])).to.deep.equal([
        ["etc/.wh.motd", "file", ""],
        ["usr/bin/", "directory", ""],
        ["usr/bin/newuidmap", "file", ""],
        ["usr/bin/newgidmap", "link", "usr/bin/newuidmap"],
      ]);
      expect(headers.every(header => header.mtime.getTime() === 0)).to.equal(true);
      const tool = headers[2];
      expect(tool.xattrs.get("security.capability")!.equals(SETUID_CAPABILITY)).to.equal(true);
      expect([...tool.pax]).to.deep.equal([["comment", "kept"]]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
