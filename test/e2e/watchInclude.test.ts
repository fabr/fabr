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

/* A globbing `include` makes the set of build files *itself* a live query: which
 * files the model is made of changes when one appears or disappears, with nothing
 * edited. This drives that through the real CLI and the real filesystem watcher —
 * the deterministic semantics (ordering, silent drop, the vanished-file race) are
 * unit-tested in Loader.test.ts; this proves the whole stack reacts. */
(globalThis as { jest?: { setTimeout(ms: number): void } }).jest?.setTimeout(90000);

const TIMEOUT = { timeoutMs: 60000 };

describe("e2e: watch mode over a glob include", () => {
  it("picks up an added build file and drops a removed one", async () => {
    const session = startFabrWatch(
      {
        /* The included files are where MESSAGE comes from, so gen's command
         * changes with the tree rather than with any edit. */
        "PROJECT.fabr":
          "include targets/*.fabr;\n" +
          "script gen_prog { entry = src:gen.sh; args = ${MESSAGE}; }\n" +
          "generate gen { run = gen_prog; output = out:**; }\n",
        "src/gen.sh": 'mkdir -p out\nprintf "%s\\n" "$1" > out/msg.txt\n',
        "targets/base.fabr": "default MESSAGE = base;\n",
      },
      ["build", "-w", "gen"]
    );
    try {
      await session.waitFor("Building gen", TIMEOUT);
      await session.waitFor("Watching for changes", TIMEOUT);

      /* A build file appearing under the pattern joins the model: MESSAGE is now
       * assigned, so gen's command differs and it rebuilds. */
      session.write("targets/message.fabr", "MESSAGE = added;\n");
      await session.waitFor("Building gen", { count: 2, ...TIMEOUT });
      await session.waitFor("Built gen", { count: 2, ...TIMEOUT });

      /* Removing it drops it from the model — reverting MESSAGE to the default,
       * which is the build already cached from the first cycle, so this cycle
       * completes with nothing to do rather than reporting the file missing. */
      const settled = (session.stderr.match(/Already up to date/g) ?? []).length;
      session.remove("targets/message.fabr");
      await session.waitFor("Already up to date", { count: settled + 1, ...TIMEOUT });
      expect(session.stderr).not.to.match(/not found/);
    } finally {
      const code = await session.stop();
      expect(code).to.equal(0);
    }
  });
});
