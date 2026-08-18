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

/* Command substitution: `` `cmd` `` runs a fabr runnable and substitutes its
 * stdout as text, in any name position — a name part like `${...}`, not a value.
 *
 * The tools are loose js_scripts. `ver` prints a version-ish string; `multi`
 * prints several whitespace-separated words over several lines; `noisy` writes
 * to both streams; `echoarg` prints its arguments `|`-joined, so a substituted
 * value's exact text — and its word boundaries — are visible through `cat`. */
const TOOLS =
  "plugin @fabr-build/js;\n" +
  "js_script ver { entry = src:ver.js; }\n" +
  "js_script multi { entry = src:multi.js; }\n" +
  "js_script noisy { entry = src:noisy.js; }\n" +
  "js_script echoarg { entry = src:echoarg.js; }\n";
const TOOL_FILES = {
  "src/ver.js": "process.stdout.write('1.2.3\\n');\n",
  "src/multi.js": "process.stdout.write('-I/a\\n\\n  -I/b \\n');\n",
  "src/noisy.js": "process.stdout.write('out');\nprocess.stderr.write('err');\n",
  "src/echoarg.js": "process.stdout.write(process.argv.slice(2).join('|'));\n",
  "src/upper.js": "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d.trim().toUpperCase()));\n",
};

/** Build a `generate` target whose command is `spec`, and cat what it captured. */
function generated(spec: string, extra = ""): ReturnType<typeof runFabr> {
  return runFabr(
    { "PROJECT.fabr": TOOLS + extra + `generate g { run = ${spec} > out.txt; }\n`, ...TOOL_FILES },
    ["cat", "g:out.txt"]
  );
}

describe("e2e: command substitution", () => {
  it("substitutes a command's stdout as text", () => {
    const result = generated("echoarg `ver`");
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("1.2.3");
  });

  it("composes with adjacent text, as a part rather than a whole value", () => {
    /* `` v`ver`-final `` is the case that ruled out treating a backtick
     * expression as a whole value: it must concatenate exactly as `${...}` does,
     * and stay ONE argument while doing it. */
    const result = generated("echoarg v`ver`-final");
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("v1.2.3-final");
  });

  it("trims and collapses whitespace runs, as a shell does", () => {
    /* `-I/a\n\n  -I/b \n` becomes `-I/a -I/b`: trailing newlines gone, internal
     * runs (newlines included) collapsed to single spaces. It stays one
     * argument — substitution is text into a name, and the name was written as
     * one word; there is no word-splitting to re-split it. */
    const result = generated("echoarg `multi`");
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("-I/a -I/b");
  });

  it("keeps stderr out of the value until it is dup'd in", () => {
    expect(generated("echoarg `noisy`").stdout).to.equal("out");
    /* `2>&1` is the whole of "modulo redirection": it folds the diagnostic
     * stream into the value. */
    expect(generated("echoarg `noisy 2>&1`").stdout).to.equal("outerr");
  });

  it("runs in a global, which has no owning target", () => {
    /* The target-free demand path: a global belongs to no target, so the
     * substitution describes its own work item rather than borrowing a name. */
    const result = generated("echoarg ${VERSION}", "VERSION = `ver`;\n");
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("1.2.3");
  });

  it("is inert inside single quotes, which are literal-only", () => {
    const result = generated("echoarg '`ver`'");
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("`ver`");
  });

  it("runs a pipeline inside a substitution", () => {
    /* `noisy` rather than `ver` so the second stage visibly does something —
     * uppercasing a version number proves nothing. */
    const result = generated("echoarg `noisy | upper`", "js_script upper { entry = src:upper.js; }\n");
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("OUT");
  });

  it("substitutes variables inside the command itself", () => {
    /* A command's own words are ordinary names, substituted before it runs — so
     * a tool named by a global is how you would actually write this. */
    const result = generated("echoarg `${TOOL}`", "TOOL = ver;\n");
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("1.2.3");
  });

  it("substitutes variables in a command's arguments", () => {
    const result = generated("echoarg `echoarg ${WHAT}`", "WHAT = hello;\n");
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("hello");
  });

  it("runs in a guard, deciding which declaration applies", () => {
    /* Feature detection's shape: a probe decides which declaration is in force.
     * Guards filter rather than rank, so the alternatives must be disjoint. */
    const result = runFabr(
      {
        "PROJECT.fabr":
          TOOLS +
          "WHICH = 1.2.3;\n" +
          "generate g { run<WHICH=`ver`> = echoarg matched > out.txt;\n" +
          "             run<WHICH=9.9.9> = echoarg other > out.txt; }\n",
        ...TOOL_FILES,
      },
      ["cat", "g:out.txt"]
    );
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("matched");
  });

  it("reports a failing command against the command", () => {
    const result = generated("echoarg `nosuchtool`");
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.contain("nosuchtool");
  });

  it("treats a named redirect inside a substitution as /dev/null", () => {
    /* The FileSet a substitution's pipeline produces is read for one entry and
     * dropped, so a redirect target is meaningless as a *name* and means only
     * "not on my terminal" — `2> log` silences stderr and writes nothing. */
    expect(generated("echoarg `noisy 2> log`").stdout).to.equal("out");
  });

  it("cannot have its value displaced by a redirect naming the capture", () => {
    /* Captures share one namespace, last writer wins — so before every name was
     * generated, `2> <capture>` silently replaced the value with stderr. No
     * reserved name could have fixed it: a target is substitutable (`> ${X}`). */
    expect(generated("echoarg `noisy 2> stdout`").stdout).to.equal("out");
    expect(generated("echoarg `noisy 2> value`").stdout).to.equal("out");
  });

  it("yields an empty value when the command redirects its own stdout", () => {
    /* As `$(cmd > f)` is in a shell: the value IS stdout, so sending it
     * elsewhere leaves nothing behind. */
    const result = generated("echoarg x`ver > gone`y");
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("xy");
  });

});
