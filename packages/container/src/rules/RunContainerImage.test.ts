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
import { expect } from "chai";
import { LAUNCH_SCRIPT } from "../ImageRunnable";

describe("the launcher of a runnable image", () => {
  let dir: string;

  /* An engine that records each call, holds the image once it is loaded, and
   * lists the tags in `tags` (each line a tag and when it was set). */
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-launch-"));
    fs.writeFileSync(path.join(dir, "launch.sh"), LAUNCH_SCRIPT, { mode: 0o755 });
    fs.mkdirSync(path.join(dir, "layout"));
    fs.writeFileSync(path.join(dir, "layout", "index.json"), "{}");
    fs.writeFileSync(
      path.join(dir, "engine"),
      '#!/bin/sh\necho "$*" >> "$(dirname "$0")/calls"\nprintf "%s\\n" "$@" > "$(dirname "$0")/arguments"\n' +
        'tags="$(dirname "$0")/tags"\n' +
        'if [ "$1 $2" = "image ls" ]; then [ ! -f "$tags" ] || cut -d" " -f1 "$tags"; exit 0; fi\n' +
        'if [ "$1 $3" = "image -f" ]; then grep "^$5 " "$tags" | cut -d" " -f2-; exit 0; fi\n' +
        'if [ "$1" = image ]; then [ -f "$(dirname "$0")/loaded" ]; exit $?; fi\n' +
        'if [ "$1" = load ]; then tar -tf - | sort > "$(dirname "$0")/loaded"; fi\n',
      { mode: 0o755 }
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /* Each call, the launcher's pid in a container's name read as `PID`. */
  const calls = (): string[] =>
    fs
      .readFileSync(path.join(dir, "calls"), "utf8")
      .trim()
      .split("\n")
      .map(call => call.replace(/fabr-myhost-\d+-run/, "fabr-myhost-PID-run"));

  it("loads the layout, streamed, where the engine lacks the image, then runs it with its options and the caller's arguments", () => {
    execFileSync("/bin/sh", [path.join(dir, "launch.sh"), path.join(dir, "engine"), "myhost", "localhost/fabr/app:abc", "4", "-p", "53:53/udp", "-p", "8080:8080/tcp", "one", "two words"], { stdio: ["ignore", "pipe", "pipe"] });
    expect(calls()).to.deep.equal(["image inspect localhost/fabr/app:abc", "load -q", "image ls localhost/fabr/app --format {{.Repository}}:{{.Tag}}", "run --rm --init -i --name fabr-myhost-PID-run -p 53:53/udp -p 8080:8080/tcp localhost/fabr/app:abc one two words"]);
    expect(fs.readFileSync(path.join(dir, "loaded"), "utf8").trim().split("\n")).to.deep.equal(["./", "./index.json"]);
  });

  it("removes the program's earlier images once it loads one, keeping the one loaded most recently before it", () => {
    fs.writeFileSync(
      path.join(dir, "tags"),
      [
        "localhost/fabr/app:abc 2026-11-05 10:00:03 +0000 UTC",
        "localhost/fabr/app:old 2026-11-05 10:00:00 +0000 UTC",
        "localhost/fabr/app:prev 2026-11-05 10:00:02 +0000 UTC",
        "localhost/fabr/app:older 2026-11-05 10:00:01 +0000 UTC",
      ].join("\n") + "\n"
    );
    execFileSync("/bin/sh", [path.join(dir, "launch.sh"), path.join(dir, "engine"), "myhost", "localhost/fabr/app:abc", "0"], { stdio: ["ignore", "pipe", "pipe"] });
    expect(calls().filter(call => call.startsWith("rmi")).sort()).to.deep.equal(["rmi localhost/fabr/app:old", "rmi localhost/fabr/app:older"]);
  });

  it("names the container for the launch fabr gave it, where there is one", () => {
    fs.writeFileSync(path.join(dir, "loaded"), "");
    execFileSync("/bin/sh", [path.join(dir, "launch.sh"), path.join(dir, "engine"), "myhost", "localhost/fabr/app:abc", "0"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FABR_LAUNCH: "myhost-42-7" },
    });
    expect(calls()).to.deep.equal(["image inspect localhost/fabr/app:abc", "run --rm --init -i --name fabr-myhost-42-7 localhost/fabr/app:abc"]);
  });

  it("runs an image the engine holds without loading it again", () => {
    fs.writeFileSync(path.join(dir, "loaded"), "");
    execFileSync("/bin/sh", [path.join(dir, "launch.sh"), path.join(dir, "engine"), "myhost", "localhost/fabr/app:abc", "0"], { stdio: ["ignore", "pipe", "pipe"] });
    expect(calls()).to.deep.equal(["image inspect localhost/fabr/app:abc", "run --rm --init -i --name fabr-myhost-PID-run localhost/fabr/app:abc"]);
  });

  it("keeps each option and argument whole, spaces and all", () => {
    fs.writeFileSync(path.join(dir, "loaded"), "");
    execFileSync("/bin/sh", [path.join(dir, "launch.sh"), path.join(dir, "engine"), "myhost", "localhost/fabr/app:abc", "2", "-e", "GREETING=hello there", "two words"], { stdio: ["ignore", "pipe", "pipe"] });
    const run = fs.readFileSync(path.join(dir, "arguments"), "utf8").replace(/fabr-myhost-\d+-run/, "fabr-myhost-PID-run");
    expect(run.trimEnd().split("\n")).to.deep.equal(["run", "--rm", "--init", "-i", "--name", "fabr-myhost-PID-run", "-e", "GREETING=hello there", "localhost/fabr/app:abc", "two words"]);
  });
});
