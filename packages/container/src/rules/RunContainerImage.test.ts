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

  /* An engine that records each call, and holds the image once it is loaded. */
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-launch-"));
    fs.writeFileSync(path.join(dir, "launch.sh"), LAUNCH_SCRIPT, { mode: 0o755 });
    fs.mkdirSync(path.join(dir, "layout"));
    fs.writeFileSync(path.join(dir, "layout", "index.json"), "{}");
    fs.writeFileSync(
      path.join(dir, "engine"),
      '#!/bin/sh\necho "$*" >> "$(dirname "$0")/calls"\n' +
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

  it("loads the layout, streamed, where the engine lacks the image, then runs it with its ports published and the caller's arguments", () => {
    execFileSync("/bin/sh", [path.join(dir, "launch.sh"), "myhost", "localhost/fabr/app:abc", "53/udp 8080/tcp", "one", "two words"], { stdio: ["ignore", "pipe", "pipe"] });
    expect(calls()).to.deep.equal(["image inspect localhost/fabr/app:abc", "load -q", "run --rm --init -i --name fabr-myhost-PID-run -p 53:53/udp -p 8080:8080/tcp localhost/fabr/app:abc one two words"]);
    expect(fs.readFileSync(path.join(dir, "loaded"), "utf8").trim().split("\n")).to.deep.equal(["./", "./index.json"]);
  });

  it("names the container for the launch fabr gave it, where there is one", () => {
    fs.writeFileSync(path.join(dir, "loaded"), "");
    execFileSync("/bin/sh", [path.join(dir, "launch.sh"), "myhost", "localhost/fabr/app:abc", ""], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FABR_LAUNCH: "myhost-42-7" },
    });
    expect(calls()).to.deep.equal(["image inspect localhost/fabr/app:abc", "run --rm --init -i --name fabr-myhost-42-7 localhost/fabr/app:abc"]);
  });

  it("runs an image the engine holds without loading it again", () => {
    fs.writeFileSync(path.join(dir, "loaded"), "");
    execFileSync("/bin/sh", [path.join(dir, "launch.sh"), "myhost", "localhost/fabr/app:abc", ""], { stdio: ["ignore", "pipe", "pipe"] });
    expect(calls()).to.deep.equal(["image inspect localhost/fabr/app:abc", "run --rm --init -i --name fabr-myhost-PID-run localhost/fabr/app:abc"]);
  });
});
