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
import { runFabr } from "./harness";

/* The `generate` genrule as a command pipeline: commands are fabr runnables,
 * streams are wired with `|`, and `>`/`2>`/`&>` capture output as content. Two
 * loose js_script tools — `emit` writes to stdout, `upper` uppercases stdin —
 * exercise redirects and piping through the real CLI. */
const TOOLS =
  "plugin @fabr-build/js;\n" +
  "js_script emit { entry = src:emit.js; }\n" +
  "js_script upper { entry = src:upper.js; }\n";
const TOOL_FILES = {
  "src/emit.js": "process.stdout.write('hello\\n');\nprocess.stderr.write('noise');\n",
  "src/upper.js": "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d.toUpperCase()));\n",
};

/* A tool that WRITES A FILE (rather than to a stream), to exercise the `output`
 * glob that collects files the command wrote. */
const WRITER = "plugin @fabr-build/js;\njs_script writer { entry = src:writer.js; }\n";
const WRITER_FILES = { "src/writer.js": "require('fs').writeFileSync('made.txt','content\\n');\n" };

describe("e2e: generate command pipelines", () => {
  it("captures a command's stdout as content ('> name')", () => {
    const result = runFabr(
      { "PROJECT.fabr": TOOLS + "generate g { run = emit > out.txt; }\n", ...TOOL_FILES },
      ["cat", "g:out.txt"]
    );
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("hello\n");
  });

  it("pipes one stage's stdout into the next, capturing the result", () => {
    /* The docgen shape: produce | transform > file. */
    const result = runFabr(
      { "PROJECT.fabr": TOOLS + "generate g { run = emit | upper > out.txt; }\n", ...TOOL_FILES },
      ["cat", "g:out.txt"]
    );
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("HELLO\n");
  });

  it("merges stdout and stderr with '&>'", () => {
    const result = runFabr(
      { "PROJECT.fabr": TOOLS + "generate g { run = emit &> both.txt; }\n", ...TOOL_FILES },
      ["cat", "g:both.txt"]
    );
    expect(result.status).to.equal(0);
    /* emit writes 'hello\n' to stdout and 'noise' to stderr; both captured. */
    expect(result.stdout).to.contain("hello");
    expect(result.stdout).to.contain("noise");
  });

  it("fails the build when any stage exits non-zero (pipefail)", () => {
    const result = runFabr(
      {
        "PROJECT.fabr": "plugin @fabr-build/js;\njs_script boom { entry = src:boom.js; }\ngenerate g { run = boom > out.txt; }\n",
        "src/boom.js": "process.exit(3);\n",
      },
      ["build", "g"]
    );
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.match(/error code 3/);
  });

  it("references a reusable command defined in a standalone property (the chase)", () => {
    /* A command-valued property is a reusable definition (like a standalone map);
     * a bare `run = <name>` chases it to its pipeline rather than trying to run
     * `<name>` as a runnable. */
    const result = runFabr(
      { "PROJECT.fabr": TOOLS + "shared_cmd = emit | upper > out.txt;\ngenerate g { run = shared_cmd; }\n", ...TOOL_FILES },
      ["cat", "g:out.txt"]
    );
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("HELLO\n");
  });

  it("substitutes ${vars} in a command name", () => {
    const result = runFabr(
      { "PROJECT.fabr": TOOLS + "TOOL = emit;\ngenerate g { run = ${TOOL} > out.txt; }\n", ...TOOL_FILES },
      ["cat", "g:out.txt"]
    );
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("hello\n");
  });

  it("reads stdin from a file path ('< path'), not only a declared name", () => {
    /* stdin resolves through the same file core as a FILES value, so a bare
     * `< src/input.txt` names a file relative to the build file — previously
     * only an exact declared target/property name resolved. */
    const result = runFabr(
      {
        "PROJECT.fabr": TOOLS + "generate g { run = upper < src/input.txt > out.txt; }\n",
        ...TOOL_FILES,
        "src/input.txt": "hello\n",
      },
      ["cat", "g:out.txt"]
    );
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("HELLO\n");
  });

  it("collects files the command wrote via the 'output' glob", () => {
    const result = runFabr(
      { "PROJECT.fabr": WRITER + "generate g { run = writer; output = made.txt; }\n", ...WRITER_FILES },
      ["cat", "g:made.txt"]
    );
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("content\n");
  });

  it("renames collected files via an 'output' rename projection ('sel -> tmpl')", () => {
    /* `output` is a projection, not just a glob: a `-> tmpl` facet renames the
     * files the command wrote (here, relocating made.txt under dist/). */
    const result = runFabr(
      { "PROJECT.fabr": WRITER + "generate g { run = writer; output = *.txt -> dist/*.txt; }\n", ...WRITER_FILES },
      ["cat", "g:dist/made.txt"]
    );
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("content\n");
  });

  it("errors when the 'output' glob matches nothing the command wrote (not a silent empty success)", () => {
    /* The command succeeds but writes made.txt, which `dist:**` never matches:
     * a declared output that collects zero files is a build error, positioned at
     * the target with a help hint — not a green build with no output. */
    const result = runFabr(
      { "PROJECT.fabr": WRITER + "generate g { run = writer; output = dist:**; }\n", ...WRITER_FILES },
      ["build", "g"]
    );
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.match(/no files matching output pattern 'dist:\*\*'/);
    expect(result.stderr).to.match(/help:/);
  });

  it("streams a successful command's output to stderr by default, suppressed with -q", () => {
    /* A successful step's un-redirected output is shown live on fabr's stderr, and
     * -q silences it. Each run uses a DISTINCT marker so both are genuine cache
     * misses (the e2e cache is shared + content-addressed — an identical build
     * would be a hit and run nothing, forwarding nothing regardless of -q). */
    const project = (marker: string): Record<string, string> => ({
      "PROJECT.fabr": "plugin @fabr-build/js;\njs_script noisy { entry = src:noisy.js; }\ngenerate g { run = noisy > out.txt; }\n",
      "src/noisy.js": `process.stderr.write(${JSON.stringify(marker)});\n`,
    });
    const shown = runFabr(project("MARK-SHOWN-a1b2"), ["build", "g"]);
    expect(shown.status).to.equal(0);
    expect(shown.stderr).to.contain("MARK-SHOWN-a1b2");

    const quiet = runFabr(project("MARK-QUIET-c3d4"), ["build", "-q", "g"]);
    expect(quiet.status).to.equal(0);
    expect(quiet.stderr).to.not.contain("MARK-QUIET-c3d4");
  });

  it("rejects a pipeline operator in a non-COMMAND target property (Validate)", () => {
    const result = runFabr(
      { "PROJECT.fabr": "flag f { provides = a | b; }\n" },
      ["build", "f"]
    );
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.match(/only valid in a COMMAND property/);
  });

  it("rejects a pipeline operator reached through a standalone property (resolution backstop)", () => {
    /* A top-level property is not run through Validate; the guard at the name-
     * resolution choke point catches the operator when it is actually read,
     * rather than silently dropping the marker's empty Name to "". */
    const result = runFabr(
      { "PROJECT.fabr": "myprop = a | b;\nflag f { provides = ${myprop}; }\n" },
      ["build", "f"]
    );
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.match(/only valid in a COMMAND property/);
  });
});
