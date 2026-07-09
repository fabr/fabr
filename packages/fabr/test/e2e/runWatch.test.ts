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
import { startFabrWatch } from "./harness";

/* Watch mode over `fabr run`: a long-lived program (a stand-in "server" that
 * announces itself on stderr then blocks) is supervised across source edits —
 * a changed build relaunches it, an identical rebuild leaves it alone, and
 * SIGINT tears down both fabr and the child. The child inherits fabr's stdio,
 * so its stderr flows through to the harness. `exec` so the sleep replaces the
 * shell and a single SIGTERM stops it (no orphaned sleep). */
/* jest caps each test at 5s; the fabr runner (node:test) imposes no such cap.
 * Bump it only under jest, reaching the global through globalThis so the bare
 * `jest` name (undeclared in the fabr test compile) never appears. */
(globalThis as { jest?: { setTimeout(ms: number): void } }).jest?.setTimeout(90000);

describe("e2e: run watch mode (fabr run -w)", () => {
  it("relaunches the program on a source change and exits cleanly on SIGINT", async () => {
    const session = startFabrWatch(
      {
        "PROJECT.fabr": "script server { deps = src:server.sh; entry = server.sh; }\n",
        "src/server.sh": 'echo "SERVER V1 up" >&2\nexec sleep 300\n',
      },
      ["run", "-w", "server"]
    );
    try {
      /* Initial launch: the program is running and fabr is watching. */
      await session.waitFor("SERVER V1 up", { timeoutMs: 60000 });
      await session.waitFor("Watching for changes", { timeoutMs: 60000 });

      /* A real change relaunches: the supervisor reports "Restarting" and the
       * new build announces itself. */
      session.write("src/server.sh", 'echo "SERVER V2 up" >&2\nexec sleep 300\n');
      await session.waitFor("Restarting server", { timeoutMs: 60000 });
      await session.waitFor("SERVER V2 up", { timeoutMs: 60000 });
    } finally {
      const code = await session.stop();
      expect(code).to.equal(0);
    }
  });

  it("does not relaunch when the rebuilt program is unchanged", async () => {
    const server = 'echo "SERVER up" >&2\nexec sleep 300\n';
    const session = startFabrWatch(
      {
        "PROJECT.fabr": "script server { deps = src:server.sh; entry = server.sh; }\n",
        "src/server.sh": server,
      },
      ["run", "-w", "server"]
    );
    try {
      await session.waitFor("SERVER up", { timeoutMs: 60000 });
      await session.waitFor("Watching for changes", { timeoutMs: 60000 });

      /* Rewrite the source with byte-identical content: no content change, so
       * nothing restarts (the install manifest is unchanged). */
      session.write("src/server.sh", server);
      await session.waitFor("Watching for changes", { timeoutMs: 60000 });
      /* Give any (erroneous) restart a chance to happen before asserting none. */
      await new Promise(resolve => setTimeout(resolve, 1000));
      expect(session.stderr).to.not.match(/Restarting/);
      expect((session.stderr.match(/SERVER up/g) || []).length).to.equal(1);
    } finally {
      const code = await session.stop();
      expect(code).to.equal(0);
    }
  });
});
