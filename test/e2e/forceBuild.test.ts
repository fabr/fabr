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

import { expect } from "chai";
import { runFabr, STUB_TSC, STUB_TSC_CONFIG } from "./harness";

/* `-f`: rebuild what the command line named even when it is already cached (a
 * development aid for timing a step, undocumented). The boundary is what needs
 * testing end to end, through the real cache: a target's own sub-targets are
 * its work and rebuild with it, while the targets it depends on do not.
 *
 * `gen`'s command names the package `tool_pkg` as the program to run, so it is
 * a genuine dependency reached under BUILD_OPERATION=run — and `js_package[run]`
 * re-enters its own build with no dependency stack. That is precisely what an
 * "is this a top-level request?" reading of the build graph mistakes for a
 * named target (fabr's own docs build has this shape). */
const PROJECT =
  "plugin @fabr-build/js;\n\n" +
  STUB_TSC_CONFIG +
  "\njs_package tool_pkg { srcs = pkgsrc:**; }\n" +
  "generate gen { run = tool_pkg > out.txt; }\n";
const FILES = {
  ...STUB_TSC,
  /* Type-free "TypeScript": the stub tsc copies it to .js verbatim. */
  "pkgsrc/bin/cli.ts": 'process.stdout.write("hello\\n");\n',
};

/** The runs share one cache (the harness's), so a repeat of an identical
 * fixture is a cache hit — which is what gives a forced run something to
 * defeat. */
function build(...args: string[]): { stderr: string; status: number } {
  const result = runFabr({ "PROJECT.fabr": PROJECT, ...FILES }, ["-DJS_TARGET=es2020", ...args]);
  return { stderr: result.stderr, status: result.status };
}

describe("e2e: forced builds (-f)", () => {
  it("rebuilds the named target when it is already up to date, but not its dependencies", () => {
    expect(build("build", "gen").status, "the cold build succeeds").to.equal(0);
    expect(build("build", "gen").stderr, "a second identical build is a cache hit").to.contain("Already up to date");

    const forced = build("-f", "build", "gen");
    expect(forced.status).to.equal(0);
    expect(forced.stderr, "the named target is rebuilt").to.contain("Building gen");
    /* The tool is a dependency, and its build is reached by a path carrying no
     * dependency stack — so this is the assertion that force follows what was
     * named rather than the shape of the request. */
    expect(forced.stderr, "the tool it depends on is not").to.not.contain("tool_pkg");

    expect(build("build", "gen").stderr, "and the forced result is cached again").to.contain("Already up to date");
  });

  it("forces the named target's own sub-targets (its work, not a dependency)", () => {
    /* Naming the tool's package instead: its compile is an anonymous sub-target
     * announced as "Compiling tool_pkg" — the step whose time is what -f is
     * normally used to measure. It is the same target the case above relies on
     * NOT forcing, forced here because it is the one named. */
    expect(build("build", "tool_pkg").status).to.equal(0);
    expect(build("build", "tool_pkg").stderr).to.contain("Already up to date");

    const forced = build("-f", "build", "tool_pkg");
    expect(forced.status).to.equal(0);
    expect(forced.stderr).to.contain("Compiling tool_pkg");
  });
});
