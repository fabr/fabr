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
import { Readable } from "stream";
import { expect } from "chai";
import { packToTarball } from "./Pack";
import { unpackStream } from "./Unpack";
import { Computable } from "../core/Computable";
import { FileSet, IFile } from "../core/FileSet";
import { MemoryFile } from "../core/MemoryFS";

function fileSetOf(entries: Record<string, string>): FileSet {
  const map = new Map<string, IFile>();
  for (const [name, content] of Object.entries(entries)) {
    map.set(name, MemoryFile.from(content));
  }
  return new FileSet(map);
}

/** A minimal on-disk IFile probe: the mode contract packToTarball reads is
 *  "an IFile with an abs path", carried by the blob, not the IFile. */
function diskFile(abspath: string): IFile {
  const file: IFile = {
    hash: abspath,
    readString: encoding => Computable.resolve(fs.readFileSync(abspath, encoding ?? "utf8")),
    getDisplayName: () => abspath,
    isSameFile: other => other === file,
    getAbsPath: () => abspath,
    getBuffer: () => Computable.resolve(fs.readFileSync(abspath)),
  };
  return file;
}

describe("Pack", () => {
  it("round-trips a FileSet through pack + unpack", async () => {
    const source = fileSetOf({
      "package.json": '{"name":"demo","version":"1.0.0"}',
      "lib/index.js": "module.exports = 42;\n",
      "README.md": "# demo\n",
    });

    const tarball = await packToTarball(source);
    const unpacked = await unpackStream(Readable.from(tarball), "/tmp");

    expect(unpacked.size).to.equal(source.size);
    for (const [name, file] of source) {
      const back = await unpacked.get(name);
      expect(back, `missing ${name}`).to.not.equal(undefined);
      expect(back?.hash).to.equal(file.hash);
    }
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
      const out = path.join(dir, "out");
      fs.mkdirSync(out);
      await unpackStream(Readable.from(tarball), out);

      expect(fs.statSync(path.join(out, "bin/cli.sh")).mode & 0o111, "exec bit lost").to.not.equal(0);
      expect(fs.statSync(path.join(out, "readme.txt")).mode & 0o111, "stray exec bit").to.equal(0);
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
