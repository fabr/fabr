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
import { spawnOrphanReaper, startFabrWatch } from "./harness";

/* Watch mode over `fabr run`: a long-lived program (a stand-in "server" that
 * announces itself on stderr then blocks) is supervised across source edits —
 * a changed build relaunches it, an identical rebuild leaves it alone, and
 * SIGINT tears down both fabr and the child. The child inherits fabr's stdio,
 * so its stderr flows through to the harness. */
/* jest caps each test at `testTimeout` (30s); the fabr runner bounds tests
 * itself. Called as a BARE `jest`: under real jest the object is injected into
 * MODULE scope and is not on globalThis. `@types/jest` rides the e2e target's
 * deps, so the bare name type-checks under the fabr compile too. */
jest.setTimeout(90000);

/** A server that writes `line` to stderr, then runs until it is stopped. */
const IDLE_SERVER = (line: string): string => `console.error(${JSON.stringify(line)});\nsetInterval(() => {}, 1000);\n`;

/* A server that binds a socket at a *stable* address (a program runs in the
 * caller's cwd, unchanged across restarts: a path there, or on Windows a pipe
 * named for it) and, on SIGTERM, holds it for ~600ms — under the 2s restart
 * grace, so it exits and frees it cleanly. A replacement that binds before the
 * old one exits fails with EADDRINUSE (printed as "BIND FAILED"); the socket
 * models a listening port without a flaky real port. */
const SOCKET_SERVER = (version: string): string =>
  `console.error("${version} starting");\n` +
  'const net = require("net"), path = require("path"), crypto = require("crypto");\n' +
  'const sock = process.platform === "win32"\n' +
  '  ? "\\\\\\\\.\\\\pipe\\\\fabr-" + crypto.createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16)\n' +
  '  : path.join(process.cwd(), "srv.sock");\n' +
  "const s = net.createServer();\n" +
  's.on("error", e => { console.error("BIND FAILED " + e.code); process.exit(1); });\n' +
  `s.listen(sock, () => console.error("${version} up"));\n` +
  'process.on("SIGTERM", () => setTimeout(() => { s.close(); process.exit(0); }, 600));\n';

describe("e2e: run watch mode (fabr run -w)", () => {
  it("waits for the old child to exit before binding the replacement (no port race)", async () => {
    const session = startFabrWatch(
      {
        "PROJECT.fabr": "plugin @fabr-build/js;\njs_script server { entry = src:server.js; }\n",
        "src/server.js": SOCKET_SERVER("SERVER V1"),
      },
      ["run", "-w", "server"]
    );
    try {
      await session.waitFor("SERVER V1 up", { timeoutMs: 60000 });
      await session.waitFor("Watching for changes", { timeoutMs: 60000 });

      /* Change the program: the old server keeps its socket for ~600ms after
       * SIGTERM. If the supervisor spawned the replacement synchronously, it
       * would try to bind while the old one still holds the address and
       * fail (EADDRINUSE). It must instead wait for the old child to exit — then
       * the new one binds cleanly. */
      session.write("src/server.js", SOCKET_SERVER("SERVER V2"));
      await session.waitFor("Restarting server", { timeoutMs: 60000 });
      /* Settle on whichever the replacement did — bind, or fail to — so the race
       * (BIND FAILED) fails this test promptly rather than via a 60s timeout. */
      await session.waitFor(/SERVER V2 up|BIND FAILED/, { timeoutMs: 60000 });
      expect(session.stderr).to.not.match(/BIND FAILED/);
      expect(session.stderr).to.match(/SERVER V2 up/);
    } finally {
      const code = await session.stop();
      expect(code).to.equal(0);
    }
  });

  it("relaunches the program on a source change and exits cleanly on SIGINT", async () => {
    const session = startFabrWatch(
      {
        "PROJECT.fabr": "plugin @fabr-build/js;\njs_script server { entry = src:server.js; }\n",
        "src/server.js": IDLE_SERVER("SERVER V1 up"),
      },
      ["run", "-w", "server"]
    );
    try {
      /* Initial launch: the program is running and fabr is watching. */
      await session.waitFor("SERVER V1 up", { timeoutMs: 60000 });
      await session.waitFor("Watching for changes", { timeoutMs: 60000 });

      /* A real change relaunches: the supervisor reports "Restarting" and the
       * new build announces itself. */
      session.write("src/server.js", IDLE_SERVER("SERVER V2 up"));
      await session.waitFor("Restarting server", { timeoutMs: 60000 });
      await session.waitFor("SERVER V2 up", { timeoutMs: 60000 });
    } finally {
      const code = await session.stop();
      expect(code).to.equal(0);
    }
  });

  it("tears down cleanly on SIGTERM, not just SIGINT", async () => {
    /* A default SIGTERM disposition would kill fabr outright (exit 143) without
     * running the exit hook that stops the supervised child — orphaning it and
     * leaking its staged install. The watch lifecycle handles SIGTERM like
     * SIGINT, so fabr exits 0 and the child is cleaned up. */
    const session = startFabrWatch(
      {
        "PROJECT.fabr": "plugin @fabr-build/js;\njs_script server { entry = src:server.js; }\n",
        "src/server.js": IDLE_SERVER("SERVER up"),
      },
      ["run", "-w", "server"]
    );
    try {
      await session.waitFor("SERVER up", { timeoutMs: 60000 });
      await session.waitFor("Watching for changes", { timeoutMs: 60000 });
    } finally {
      const code = await session.stop("SIGTERM");
      expect(code).to.equal(0);
    }
  });

  it("is reaped by the harness's orphan daemon when the harness's pipe drops (SIGKILL-proof)", async () => {
    /* SIGKILL of a test worker runs no exit hook, so the in-process reaper
     * can't fire. The backstop is the orphan-reaper daemon: it holds a pipe from
     * the harness and sweeps its registered pids when that pipe closes. The
     * kernel closes the pipe identically on SIGKILL and on an explicit drop, so
     * dropPipe() here exercises the exact death signal without this test having
     * to kill its own process. */
    const session = startFabrWatch(
      {
        "PROJECT.fabr": "plugin @fabr-build/js;\njs_script server { entry = src:server.js; }\n",
        "src/server.js": IDLE_SERVER("SERVER up"),
      },
      ["run", "-w", "server"]
    );
    const reaper = spawnOrphanReaper(); /* a private instance, so the harness's own daemon stays armed */
    try {
      await session.waitFor("Watching for changes", { timeoutMs: 60000 });
      expect(session.pid).to.not.equal(undefined);
      reaper.register(session.pid!);
      reaper.dropPipe(); /* ≡ the harness dying — the daemon SIGTERMs the watcher */

      const deadline = Date.now() + 20000;
      let alive = true;
      while (alive && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 250));
        try {
          process.kill(session.pid!, 0);
        } catch {
          alive = false;
        }
      }
      expect(alive).to.equal(false);
    } finally {
      /* The daemon killed fabr out from under the session; stop() handles an
       * already-exited child and cleans the fixture dirs. */
      await session.stop();
    }
  });

  it("relaunches into the install a previous child ran from, holding exactly the new program", async () => {
    /* Three versions: the third is staged into the install the first ran from,
     * by syncing what changed — so a data file the second removed must be gone
     * from it, and one the third added present. The server lists its install's
     * data files, beside its staged entry. */
    const server = (version: string): string =>
      'const fs = require("fs"), path = require("path");\n' +
      'const names = fs.readdirSync(path.join(__dirname, "data")).sort();\n' +
      `console.error("${version} up: " + names.map(name => name + " ").join(""));\n` +
      "setInterval(() => {}, 1000);\n";
    const session = startFabrWatch(
      {
        "PROJECT.fabr": "plugin @fabr-build/js;\njs_script server { entry = src:server.js; deps = src:data/*; }\n",
        "src/server.js": server("V1"),
        "src/data/a.txt": "a",
        "src/data/b.txt": "b",
      },
      ["run", "-w", "server"]
    );
    try {
      await session.waitFor("V1 up: a.txt b.txt", { timeoutMs: 60000 });
      await session.waitFor("Watching for changes", { timeoutMs: 60000 });
      session.remove("src/data/b.txt");
      session.write("src/server.js", server("V2"));
      await session.waitFor("V2 up: a.txt", { timeoutMs: 60000 });
      session.write("src/data/c.txt", "c");
      session.write("src/server.js", server("V3"));
      await session.waitFor(/V3 up: .*/, { timeoutMs: 60000 });
      expect(session.stderr).to.match(/V3 up: a\.txt c\.txt \n/);
    } finally {
      const code = await session.stop();
      expect(code).to.equal(0);
    }
  });

  it("does not relaunch when the rebuilt program is unchanged", async () => {
    const server = IDLE_SERVER("SERVER up");
    const session = startFabrWatch(
      {
        "PROJECT.fabr": "plugin @fabr-build/js;\njs_script server { entry = src:server.js; }\n",
        "src/server.js": server,
      },
      ["run", "-w", "server"]
    );
    try {
      await session.waitFor("SERVER up", { timeoutMs: 60000 });
      await session.waitFor("Watching for changes", { timeoutMs: 60000 });

      /* Rewrite the source with byte-identical content: no content change, so
       * nothing restarts (the install manifest is unchanged). */
      session.write("src/server.js", server);
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
