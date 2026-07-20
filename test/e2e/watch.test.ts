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

/* Watch mode smoke test through the real CLI: a long-running `fabr build -w`
 * subprocess that we drive by mutating a fixture file and asserting on the
 * incremental stderr (explicit signals, not sleeps), then stop with SIGINT. The
 * fine-grained watch logic (debounce, batching, skip-on-unchanged) is covered
 * deterministically by the core unit tests; this proves the whole stack wires
 * up end to end. */
/* Generous ceilings: this drives a real subprocess + real filesystem watcher,
 * so under a saturated gate (all suites + coverage in parallel) event processing
 * can be starved well past a tight timeout. It resolves in well under a second
 * normally — the ceiling only bites under heavy load, so raising it costs nothing
 * in the common case while removing the flake. */
/* jest caps each test at 5s; the fabr runner (node:test) imposes no such cap.
 * Bump it only under jest, reaching the global through globalThis so the bare
 * `jest` name (undeclared in the fabr test compile) never appears. */
(globalThis as { jest?: { setTimeout(ms: number): void } }).jest?.setTimeout(90000);

describe("e2e: watch mode (fabr build -w)", () => {
  it("rebuilds on a source change and exits cleanly on SIGINT", async () => {
    const session = startFabrWatch(
      {
        "PROJECT.fabr":
          "script gen_prog { entry = src:gen.sh; }\n" +
          "generate gen { tool = gen_prog; output = out:**; }\n",
        "src/gen.sh": 'mkdir -p out\nprintf "V1\\n" > out/msg.txt\n',
      },
      ["build", "-w", "gen"]
    );
    try {
      /* Initial build establishes the live graph and starts watching. */
      await session.waitFor("Building gen", { timeoutMs: 60000 });
      await session.waitFor("Watching for changes", { timeoutMs: 60000 });

      /* Editing the source triggers exactly one more build cycle: the target
       * re-announces ("Building gen" again) and re-reports ("Built gen"). */
      session.write("src/gen.sh", 'mkdir -p out\nprintf "V2\\n" > out/msg.txt\n');
      await session.waitFor("Building gen", { count: 2, timeoutMs: 60000 });
      await session.waitFor("Built gen", { count: 2, timeoutMs: 60000 });
    } finally {
      const code = await session.stop();
      expect(code).to.equal(0);
    }
  });
});
