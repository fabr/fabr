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
import { unpackStream } from "./Unpack";
import { SymlinkFile } from "../core/SymlinkFile";
import { Computable } from "../core/Computable";
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-unpack-"));
    try {
      const result = await unpackStream(ins, dir);
      expect(result.size).to.equal(1);
      const file = await result.get("package.json");
      expect(file?.hash).to.equal("ff344d6ce0cb6497bcc78b026420dee7538870af60809bab61e9a2e83b70a287");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves the executable bit from tar entry modes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-unpack-"));
    try {
      const pack = tar.pack();
      pack.entry({ name: "package/bin/tool", mode: 0o755 }, "#!/bin/sh\n");
      pack.entry({ name: "package/lib/plain.js", mode: 0o644 }, "module.exports = 1;\n");
      pack.finalize();

      const result = await unpackStream(pack, dir);
      expect(result.size).to.equal(2);
      /* 0o111 = any execute bit; the plain file must not have gained one. */
      expect(fs.statSync(path.resolve(dir, "package/bin/tool")).mode & 0o111).to.not.equal(0);
      expect(fs.statSync(path.resolve(dir, "package/lib/plain.js")).mode & 0o111).to.equal(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("translates a symlink to a SymlinkFile and resolves a hardlink to shared content", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-unpack-"));
    try {
      const pack = tar.pack();
      pack.entry({ name: "package/real.js", mode: 0o644 }, "module.exports = 1;\n");
      pack.entry({ name: "package/link.js", type: "symlink", linkname: "real.js" });
      /* A hardlink shares the earlier entry's content — content-addressed
       * storage makes it a dedup: same hash under a second name. */
      pack.entry({ name: "package/hard.js", type: "link", linkname: "package/real.js" });
      /* A hardlink to a target that never appears (or was dropped) is itself dropped. */
      pack.entry({ name: "package/dangling.js", type: "link", linkname: "package/missing.js" });
      pack.finalize();

      const result = await unpackStream(pack, dir);
      expect(result.size).to.equal(3);
      const link = await result.get("package/link.js");
      expect(link).to.be.instanceOf(SymlinkFile);
      expect((link as SymlinkFile).target).to.equal("real.js");
      const real = await result.get("package/real.js");
      const hard = await result.get("package/hard.js");
      expect(hard).to.not.equal(undefined);
      expect(hard?.hash).to.equal(real?.hash);
      expect(await result.get("package/dangling.js")).to.equal(undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects (rather than hanging) when the stream errors before a full header", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-unpack-"));
    try {
      const ins = new Readable({ read() {} });
      const result = unpackStream(ins, dir);
      /* Fewer than MIN_HEAD_LENGTH bytes arrive, then the connection fails. */
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
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects (rather than crashing) when the stream drops mid-archive", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-unpack-"));
    try {
      /* A valid TAR magic (ustar at offset 257) clears the header phase; the
       * connection then drops, exercising the live pipe's error path. */
      const head = Buffer.alloc(512);
      head.write("ustar", 257, "ascii");
      const ins = new Readable({ read() {} });
      const result = unpackStream(ins, dir);
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
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops tar entries whose path escapes the target dir (tar-slip)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-unpack-"));
    const escape = path.resolve(dir, "..", "fabr-tar-slip.txt");
    try {
      const pack = tar.pack();
      pack.entry({ name: "package/ok.txt" }, "safe");
      pack.entry({ name: "../fabr-tar-slip.txt" }, "evil");
      pack.entry({ name: "/etc/fabr-tar-slip.txt" }, "evil");
      pack.finalize();

      const result = await unpackStream(pack, dir);
      /* Only the contained entry survives; the escaping ones are neither in the
       * result nor written to disk outside the target dir. */
      expect(result.size).to.equal(1);
      expect(await result.get("package/ok.txt")).to.not.equal(undefined);
      expect(fs.existsSync(escape)).to.equal(false);
      expect(fs.existsSync("/etc/fabr-tar-slip.txt")).to.equal(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(escape, { force: true });
    }
  });
});
