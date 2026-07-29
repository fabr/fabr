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

import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startFabrWatch } from "./harness";

/* Stopping a one-shot `fabr run` — SIGTERM from a supervisor or CI job, the
 * ordinary way to stop a running program — must take the launched program with
 * it and leave no staged install behind. Both used to fail: fabr routes its
 * termination signals through process.exit (so the build-step group sweep runs),
 * which skips the Computable `finally` that removed the staged dir, and the
 * launched program shares fabr's process group so a directed signal never
 * reached it. A private cache keeps the staging assertions off the other suites'
 * work trees. */
describe("e2e: interrupting a one-shot run", () => {
  /** The installs staged under `cache`, across every owner's work tree — so the
   * test sees a leak whether or not fabr got as far as reclaiming its own. */
  function stagedInstalls(cache: string): string[] {
    const work = path.join(cache, "work");
    if (!fs.existsSync(work)) {
      return [];
    }
    return fs
      .readdirSync(work)
      .flatMap(owner => fs.readdirSync(path.join(work, owner)).map(entry => path.join(owner, entry)))
      .filter(entry => path.basename(entry).startsWith("run-"));
  }

  /** True once `pid` is gone (kill(0) is the liveness probe). */
  function isDead(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }

  async function waitUntilDead(pid: number): Promise<boolean> {
    for (let i = 0; i < 50 && !isDead(pid); i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return isDead(pid);
  }

  it("stops the launched program and removes its staged install", async () => {
    /* Its own cache, not the session's: the harness removes that one as part of
     * stop(), which would erase the very thing this test inspects afterwards. */
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-e2e-runcache-"));
    const session = startFabrWatch(
      {
        "PROJECT.fabr": "script forever { entry = src:forever.sh; }\n",
        /* Records its own pid in the caller's cwd (the project dir — a script
         * runnable launches there) and then never exits on its own. */
        "src/forever.sh": 'echo $$ > run.pid\necho started 1>&2\nwhile true; do sleep 0.2; done\n',
      },
      ["run", "forever"],
      { FABR_CACHE_DIR: cache }
    );
    try {
      await session.waitFor("started");
      const pid = Number(fs.readFileSync(path.join(session.dir, "run.pid"), "utf8").trim());
      expect(pid).to.be.greaterThan(0);
      expect(stagedInstalls(cache), "the install should be staged while running").to.have.lengthOf(1);

      const status = await session.stop("SIGTERM");
      const stopped = await waitUntilDead(pid);
      /* Reap it ourselves before asserting: a regression here leaves the program
       * running with the runner's stdio pipes, which wedges the whole suite —
       * this test must fail, not hang. */
      if (!stopped) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* raced us to it */
        }
      }
      expect(status, "fabr exits with 128+SIGTERM").to.equal(143);
      expect(stopped, "the launched program is stopped with fabr").to.equal(true);
      expect(stagedInstalls(cache), "the staged install is removed").to.have.lengthOf(0);
    } finally {
      fs.rmSync(cache, { recursive: true, force: true });
    }
  });
});
