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

/* Watch mode over a `serve` target: the server (a shell script polling its
 * cwd-relative content file — which also proves the install-anchored launch
 * cwd, since the file only exists in the staged install) stays running across
 * content edits — the staged file is synced in place ("Updating ... content")
 * and the server observes the new bytes with NO restart — while an edit to the
 * server program itself still restarts it. */

/* jest caps each test at `testTimeout` (30s); the fabr runner bounds tests
 * itself. Called as a BARE `jest`: under real jest the object is injected into
 * MODULE scope and is not on globalThis, so reaching it through globalThis was a
 * silent no-op — these suites have been running at 30s and only passing because
 * they finished in time. `@types/jest` rides the e2e target's deps, so the bare
 * name type-checks under the fabr compile too. */
jest.setTimeout(90000);

/* The server announces itself, then polls `data.txt` in its cwd and announces
 * each distinct content it observes. `exec` is unavailable (the loop IS the
 * program); the short sleep bounds SIGTERM latency. */
const SERVER = (banner: string): string =>
  `echo "${banner} up" >&2\n` +
  'last=""\n' +
  "while true; do\n" +
  '  cur=$(cat data.txt 2>/dev/null)\n' +
  '  if [ "$cur" != "$last" ]; then echo "CONTENT [$cur]" >&2; last="$cur"; fi\n' +
  "  sleep 0.2\n" +
  "done\n";

const PROJECT =
  "script server { entry = src:server.sh; }\n" +
  "serve site { tool = server; files = content:**; }\n";

describe("e2e: serve target under fabr run -w", () => {
  it("syncs content in place without a restart, and restarts on a program change", async () => {
    const session = startFabrWatch(
      {
        "PROJECT.fabr": PROJECT,
        "src/server.sh": SERVER("SERVER V1"),
        "content/data.txt": "one",
      },
      ["run", "-w", "site"]
    );
    try {
      /* Initial launch: install-anchored cwd, so the polled file resolves. */
      await session.waitFor("SERVER V1 up", { timeoutMs: 60000 });
      await session.waitFor("CONTENT [one]", { timeoutMs: 60000 });
      await session.waitFor("Watching for changes", { timeoutMs: 60000 });

      /* A content edit is synced into the running server's staging area — the
       * server sees the new bytes, and nothing restarted. */
      session.write("content/data.txt", "two");
      await session.waitFor("Updating site content", { timeoutMs: 60000 });
      await session.waitFor("CONTENT [two]", { timeoutMs: 60000 });
      expect(session.stderr).to.not.match(/Restarting/);
      expect((session.stderr.match(/SERVER V1 up/g) || []).length).to.equal(1);

      /* A program edit still restarts — and the fresh install carries the
       * current content. */
      session.write("src/server.sh", SERVER("SERVER V2"));
      await session.waitFor("Restarting site", { timeoutMs: 60000 });
      await session.waitFor("SERVER V2 up", { timeoutMs: 60000 });
      await session.waitFor("CONTENT [two]", { count: 2, timeoutMs: 60000 });
    } finally {
      const code = await session.stop();
      expect(code).to.equal(0);
    }
  });

  it("reports the cycle's build against the served target, not 'Already up to date'", async () => {
    /* The docs_serve shape: `files` come through a generate dependency, so the
     * rebuild work happens beneath a *dependency* of the requested target. The
     * per-cycle status marker must attribute that work to the request ("Built
     * app") — the top-level target's own evaluation yields no action, and
     * before the demand-chain attribution the cycle reported the contradictory
     * "Already up to date" right before "Updating app content". */
    const session = startFabrWatch(
      {
        "PROJECT.fabr":
          "script gen { entry = src:gen.sh; }\n" +
          "generate site { run = gen; srcs = content:**; output = out:**; }\n" +
          "script server { entry = src:server.sh; }\n" +
          "serve app { tool = server; files = site:**; }\n",
        "src/gen.sh": "mkdir -p out\ntr 'a-z' 'A-Z' < data.txt > out/data.txt\n",
        "src/server.sh": SERVER("SERVER"),
        "content/data.txt": "one",
      },
      ["run", "-w", "app"]
    );
    try {
      await session.waitFor("Built app", { timeoutMs: 60000 });
      await session.waitFor("CONTENT [ONE]", { timeoutMs: 60000 });
      await session.waitFor("Watching for changes", { timeoutMs: 60000 });

      /* The content edit rebuilds `site` (required by app): the marker
       * attributes it to the request and is the cycle's TERMINAL line —
       * deferred until after the in-place sync has landed. No restart. */
      session.write("content/data.txt", "two");
      await session.waitFor("Built app", { count: 2, timeoutMs: 60000 });
      await session.waitFor("Updating app content", { timeoutMs: 60000 });
      await session.waitFor("CONTENT [TWO]", { timeoutMs: 60000 });
      expect(session.stderr).to.not.match(/Already up to date|Restarting/);
      expect(session.stderr.lastIndexOf("Built app")).to.be.greaterThan(session.stderr.indexOf("Updating app content"));
    } finally {
      const code = await session.stop();
      expect(code).to.equal(0);
    }
  });
});
