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
import { startFabrWatch, started } from "./harness";

/** Each unit of work logs a start line and a completion line, so a test that
 *  counts rebuilds must count the start lines alone. */
const BUILDING_GEN = started("Building gen");

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
/* jest caps each test at `testTimeout` (30s); the fabr runner bounds tests
 * itself. Called as a BARE `jest`: under real jest the object is injected into
 * MODULE scope and is not on globalThis, so reaching it through globalThis was a
 * silent no-op — these suites have been running at 30s and only passing because
 * they finished in time. `@types/jest` rides the e2e target's deps, so the bare
 * name type-checks under the fabr compile too. */
jest.setTimeout(90000);

describe("e2e: watch mode (fabr build -w)", () => {
  it("reports a cycle a value makes, keeps it through an edit inside it, and heals it when the value changes", async () => {
    /* Whether `foo` depends on its own output is decided by what `get_value`
     * prints. An edit to a source on the cycle, which `bar` shares, leaves it
     * standing: one more cycle, `bar` rebuilt, nothing new reported for `foo`.
     * An edit changing the value cuts it. */
    const session = startFabrWatch(
      {
        "PROJECT.fabr":
          "script get_value { entry = src:value.sh; }\n" +
          "CYCLE = `get_value`;\n" +
          "script foo_prog { entry = src:foo.sh; }\n" +
          "generate foo {\n" +
          "  run = foo_prog > out.txt;\n" +
          "  srcs = in.txt;\n" +
          "  srcs<CYCLE=1> = foo:out.txt;\n" +
          "}\n" +
          "generate bar { run = foo_prog > bar.txt; srcs = in.txt; }\n",
        "src/value.sh": 'printf "1"\n',
        "src/foo.sh": "cat in.txt\n",
        "in.txt": "one\n",
      },
      ["build", "-w", "foo", "bar"]
    );
    try {
      await session.waitFor("Watching for changes", { timeoutMs: 60000 });
      expect(session.stderr).to.contain("Circular dependency: 'foo' depends on itself");
      /* The standing cycle's batch: `bar` rebuilds, the unchanged failure is
       * not re-reported, and a failed cycle renders no marker. */
      session.write("in.txt", "two\n");
      await session.waitFor(started("Building bar"), { count: 2, timeoutMs: 60000 });
      await session.waitFor("✓ Building bar", { count: 2, timeoutMs: 60000 });
      /* The healing batch: the marker names `foo` alone — the batch before it
       * ended, so `bar` was reported with it rather than carried over. */
      session.write("src/value.sh", 'printf "0"\n');
      await session.waitFor("Watching for changes", { count: 2, timeoutMs: 60000 });
      expect(session.stderr).to.match(/info:Built foo\n/);
      expect(session.stderr).to.not.match(/Built .*bar/);
      expect(session.stderr.match(/Circular dependency/g)).to.have.length(1);
    } finally {
      const code = await session.stop();
      expect(code).to.equal(0);
    }
  });

  it("rebuilds on a source change and exits cleanly on SIGINT", async () => {
    const session = startFabrWatch(
      {
        "PROJECT.fabr":
          "script gen_prog { entry = src:gen.sh; }\n" +
          "generate gen { run = gen_prog; output = out:**; }\n",
        "src/gen.sh": 'mkdir -p out\nprintf "V1\\n" > out/msg.txt\n',
      },
      ["build", "-w", "gen"]
    );
    try {
      /* Initial build establishes the live graph and starts watching. */
      await session.waitFor(BUILDING_GEN, { timeoutMs: 60000 });
      await session.waitFor("Watching for changes", { timeoutMs: 60000 });

      /* Editing the source triggers exactly one more build cycle: the target
       * re-announces ("Building gen" again) and re-reports ("Built gen"). */
      session.write("src/gen.sh", 'mkdir -p out\nprintf "V2\\n" > out/msg.txt\n');
      await session.waitFor(BUILDING_GEN, { count: 2, timeoutMs: 60000 });
      await session.waitFor("Built gen", { count: 2, timeoutMs: 60000 });
    } finally {
      const code = await session.stop();
      expect(code).to.equal(0);
    }
  });
});
