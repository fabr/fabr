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

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Readable } from "stream";
import { expect } from "chai";
import { TarExtract } from "@fabr-build/core";
import { runArguments, tarOf } from "../launcher/fabr-container-launch";

/** The launcher's compiled file, as the runnable runs it. */
const LAUNCHER = require.resolve("../launcher/fabr-container-launch");

/** `it`, or `it.skip` on Windows, which runs no script as a program: for a test run against an engine that is one. */
const withScriptEngine = process.platform === "win32" ? it.skip : it;

/** Read the names and contents of the entries of the tar `archive`. */
function entriesOf(archive: Buffer): Promise<Array<{ name: string; type: string; content: string }>> {
  const extract = new TarExtract();
  const entries: Array<{ name: string; type: string; content: string }> = [];
  return new Promise((resolve, reject) => {
    extract.on("entry", (header, content, next) => {
      const chunks: Buffer[] = [];
      content.on("data", (data: Buffer) => chunks.push(data));
      content.on("error", reject);
      content.on("end", () => {
        entries.push({ name: header.name, type: header.type ?? "", content: Buffer.concat(chunks).toString() });
        next();
      });
    });
    extract.on("finish", () => resolve(entries));
    extract.on("error", reject);
    Readable.from([archive]).pipe(extract);
  });
}

describe("the launcher of a runnable image", () => {
  it("names the run's options before the image and the program's arguments after it, keeping each whole", () => {
    expect(
      runArguments("fabr-myhost-7-run", "localhost/fabr/app:abc", ["-e", "GREETING=hello there"], ["two words"], false)
    ).to.deep.equal([
      "run",
      "--rm",
      "--init",
      "-i",
      "--name",
      "fabr-myhost-7-run",
      "-e",
      "GREETING=hello there",
      "localhost/fabr/app:abc",
      "two words",
    ]);
  });

  it("gives the run a terminal only where stdin is one", () => {
    expect(runArguments("c", "i", [], [], true).slice(0, 5)).to.deep.equal(["run", "--rm", "--init", "-i", "-t"]);
    expect(runArguments("c", "i", [], [], false)).to.not.include("-t");
  });

  it("streams a layout as a tar: each directory before what it holds, each file at its name, a long name whole (a long directory's without its '/')", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-launch-tar-"));
    try {
      const blob = `blobs/sha256/${"a".repeat(64)}`;
      const long = `${"d".repeat(60)}/${"e".repeat(60)}/file.txt`;
      /* Its last `/` leaves a prefix over 155 bytes; its first fits. */
      const split = `${"p".repeat(100)}/${"q".repeat(60)}/${"r".repeat(30)}`;
      for (const [name, content] of [
        ["index.json", "{}"],
        ["oci-layout", "x".repeat(600)],
        [blob, "layer"],
        [long, "deep"],
        [split, "split"],
      ]) {
        fs.mkdirSync(path.join(dir, path.dirname(name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), content);
      }
      const chunks: Buffer[] = [];
      for await (const chunk of tarOf(dir)) {
        chunks.push(chunk);
      }
      const entries = await entriesOf(Buffer.concat(chunks));
      expect(entries.map(({ name, type }) => `${type} ${name}`)).to.deep.equal([
        "directory blobs/",
        "directory blobs/sha256/",
        `file ${blob}`,
        `directory ${"d".repeat(60)}/`,
        `directory ${"d".repeat(60)}/${"e".repeat(60)}`,
        `file ${long}`,
        "file index.json",
        "file oci-layout",
        `directory ${"p".repeat(100)}`,
        `directory ${"p".repeat(100)}/${"q".repeat(60)}`,
        `file ${split}`,
      ]);
      expect(entries.find(({ name }) => name === split)?.content).to.equal("split");
      expect(entries.find(({ name }) => name === "oci-layout")?.content).to.equal("x".repeat(600));
      expect(entries.find(({ name }) => name === long)?.content).to.equal("deep");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("run against an engine", () => {
    let dir: string;

    /* An engine that records each call, holds the image once it is loaded
     * (`loaded` lists the names it was given), and lists the tags in `tags`
     * (each line a tag and when it was set). Its `#!` names a link to this
     * node beside it, as short as the line must be. */
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-launch-"));
      fs.symlinkSync(process.execPath, path.join(dir, "node"));
      fs.mkdirSync(path.join(dir, "layout"));
      fs.writeFileSync(path.join(dir, "layout", "index.json"), "{}");
      fs.writeFileSync(
        path.join(dir, "engine"),
        `#!${path.join(dir, "node")}\n` +
          'const fs = require("fs"), path = require("path");\n' +
          "const at = name => path.join(__dirname, name);\n" +
          "const args = process.argv.slice(2);\n" +
          'fs.appendFileSync(at("calls"), args.join(" ") + "\\n");\n' +
          'fs.writeFileSync(at("arguments"), args.map(arg => arg + "\\n").join(""));\n' +
          'const tags = fs.existsSync(at("tags")) ? fs.readFileSync(at("tags"), "utf8").split("\\n").filter(Boolean) : [];\n' +
          'if (args[0] === "image" && args[1] === "ls") {\n' +
          '  process.stdout.write(tags.map(line => line.split(" ")[0] + "\\n").join(""));\n' +
          '} else if (args[0] === "image" && args[2] === "-f") {\n' +
          '  const line = tags.find(line => line.startsWith(args[4] + " "));\n' +
          "  if (line) process.stdout.write(line.slice(args[4].length + 1));\n" +
          '} else if (args[0] === "image") {\n' +
          '  process.exit(fs.existsSync(at("loaded")) ? 0 : 1);\n' +
          '} else if (args[0] === "load") {\n' +
          "  const chunks = [];\n" +
          '  process.stdin.on("data", chunk => chunks.push(chunk));\n' +
          '  process.stdin.on("end", () => {\n' +
          "    const tar = Buffer.concat(chunks), names = [];\n" +
          "    for (let at = 0; at + 512 <= tar.length && tar[at] !== 0; ) {\n" +
          '      names.push(tar.toString("utf8", at, at + 100).replace(/\\0.*$/s, ""));\n' +
          '      const size = parseInt(tar.toString("ascii", at + 124, at + 135), 8);\n' +
          "      at += 512 + Math.ceil(size / 512) * 512;\n" +
          "    }\n" +
          '    fs.writeFileSync(at("loaded"), names.sort().join("\\n"));\n' +
          "  });\n" +
          "}\n",
        { mode: 0o755 }
      );
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    /** Run the launcher with `args`, the engine and the layout leading them, and `env` over this process's. */
    const launch = (args: string[], env: Record<string, string> = {}): void => {
      execFileSync(
        process.execPath,
        [LAUNCHER, "run", path.join(dir, "engine"), "myhost", "localhost/fabr/app:abc", path.join(dir, "layout"), ...args],
        { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FABR_LAUNCH: "", ...env } }
      );
    };

    /* Each call, the launcher's pid in a container's name read as `PID`. */
    const calls = (): string[] =>
      fs
        .readFileSync(path.join(dir, "calls"), "utf8")
        .trim()
        .split("\n")
        .map(call => call.replace(/fabr-myhost-\d+-run/, "fabr-myhost-PID-run"));

    withScriptEngine(
      "loads the layout, streamed, where the engine lacks the image, then runs it with its options and the caller's arguments",
      () => {
        launch(["4", "-p", "53:53/udp", "-p", "8080:8080/tcp", "one", "two words"]);
        expect(calls()).to.deep.equal([
          "image inspect localhost/fabr/app:abc",
          "load -q",
          "image ls localhost/fabr/app --format {{.Repository}}:{{.Tag}}",
          "run --rm --init -i --name fabr-myhost-PID-run -p 53:53/udp -p 8080:8080/tcp localhost/fabr/app:abc one two words",
        ]);
        expect(fs.readFileSync(path.join(dir, "loaded"), "utf8").split("\n")).to.deep.equal(["index.json"]);
        /* Each argument reaches the engine whole. */
        expect(fs.readFileSync(path.join(dir, "arguments"), "utf8").trimEnd().split("\n").slice(-2)).to.deep.equal([
          "one",
          "two words",
        ]);
      }
    );

    withScriptEngine("removes the program's earlier images once it loads one, keeping the one loaded most recently before it", () => {
      fs.writeFileSync(
        path.join(dir, "tags"),
        [
          "localhost/fabr/app:abc 2026-11-05 10:00:03 +0000 UTC",
          "localhost/fabr/app:old 2026-11-05 10:00:00 +0000 UTC",
          "localhost/fabr/app:prev 2026-11-05 10:00:02 +0000 UTC",
          "localhost/fabr/app:older 2026-11-05 10:00:01 +0000 UTC",
        ].join("\n") + "\n"
      );
      launch(["0"]);
      expect(
        calls()
          .filter(call => call.startsWith("rmi"))
          .sort()
      ).to.deep.equal(["rmi localhost/fabr/app:old", "rmi localhost/fabr/app:older"]);
    });

    withScriptEngine("names the container for the launch fabr gave it, where there is one", () => {
      fs.writeFileSync(path.join(dir, "loaded"), "");
      launch(["0"], { FABR_LAUNCH: "myhost-42-7" });
      expect(calls()).to.deep.equal([
        "image inspect localhost/fabr/app:abc",
        "run --rm --init -i --name fabr-myhost-42-7 localhost/fabr/app:abc",
      ]);
    });

    withScriptEngine("runs an image the engine holds without loading it again", () => {
      fs.writeFileSync(path.join(dir, "loaded"), "");
      launch(["0"]);
      expect(calls()).to.deep.equal([
        "image inspect localhost/fabr/app:abc",
        "run --rm --init -i --name fabr-myhost-PID-run localhost/fabr/app:abc",
      ]);
    });

    withScriptEngine("removes the container of the launch fabr gave it, and nothing where it gave none", () => {
      const remove = (env: Record<string, string>): void => {
        execFileSync(process.execPath, [LAUNCHER, "remove", path.join(dir, "engine")], {
          stdio: "ignore",
          env: { ...process.env, FABR_LAUNCH: "", ...env },
        });
      };
      remove({});
      expect(fs.existsSync(path.join(dir, "calls"))).to.equal(false);
      remove({ FABR_LAUNCH: "myhost-42-7" });
      expect(calls()).to.deep.equal(["rm -f fabr-myhost-42-7"]);
    });
  });
});
