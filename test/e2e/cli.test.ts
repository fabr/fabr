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
import { runFabr, runFabrClosingStream } from "./harness";

/* Driver-level CLI behaviours exercised through the real command line: `cat`
 * output ordering/atomicity, and setup-failure reporting. */
describe("e2e: driver CLI", () => {
  const project = {
    "PROJECT.fabr": "files = src:**/*;\n",
    "src/a.txt": "AAA\n",
    "src/b.txt": "BBB\n",
  };

  it("cats multiple names in argument order, not name-sorted / settle order", () => {
    /* `b.txt` first though it sorts after `a.txt`: the output must follow the
     * argument order, so a wrong (sorted or settle-order) result is visible. */
    const result = runFabr(project, ["cat", "files:b.txt", "files:a.txt"]);
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("BBB\nAAA\n");
  });

  it("writes no partial output when a later name matches nothing", () => {
    /* The first name resolves fine, the second matches no files. Because cat
     * collects every name before emitting, the run fails with nothing on stdout
     * (rather than the first name's content followed by an error). */
    const result = runFabr(project, ["cat", "files:a.txt", "files:zzz.txt"]);
    expect(result.status).to.equal(1);
    expect(result.stdout).to.equal("");
    expect(result.stderr).to.contain("Unable to resolve 'files:zzz.txt'");
    /* Same atomicity for the lenient (glob) form, which resolves to an empty
     * result rather than failing resolution, and reports as such. */
    const globbed = runFabr(project, ["cat", "files:a.txt", "files:*.zzz"]);
    expect(globbed.status).to.equal(1);
    expect(globbed.stdout).to.equal("");
    expect(globbed.stderr).to.contain("matched no files");
  });

  it("cats each source of a multi-source name in turn, never unioning them", () => {
    /* `both` is a multi-value property whose two values resolve to filesets that
     * each name `dup.txt` at a different underlying file. A name's sources are
     * iterated, not unioned — `cat both` behaves exactly like `cat adir bdir`
     * (value order, sorted within each source), so a same-named file in two
     * sources is two files to print, not a conflict. (Checked unions still
     * conflict where content genuinely merges: inside a target build.) */
    const twoSources = {
      "PROJECT.fabr": "adir = src:a/* -> *;\nbdir = src:b/* -> *;\nboth = adir bdir;\n",
      "src/a/dup.txt": "FROM A\n",
      "src/b/dup.txt": "FROM B\n",
    };
    const result = runFabr(twoSources, ["cat", "both"]);
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("FROM A\nFROM B\n");
  });

  it("resolves a bare path on the command line, as a build file's reference would", () => {
    /* A name given to a verb is a written reference like any other, so a path
     * that names no target resolves against the filesystem — `./src` naming the
     * directory's contents, exactly as `./src` written in a root build file
     * does. Names carry the written prefix (the slash-form rule). */
    const result = runFabr(project, ["ls", "./src"]);
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("src/a.txt\nsrc/b.txt\n");
    /* And with no `./`, and through a glob and cat. */
    expect(runFabr(project, ["ls", "src/*.txt"]).stdout).to.equal("src/a.txt\nsrc/b.txt\n");
    expect(runFabr(project, ["cat", "src/a.txt"]).stdout).to.equal("AAA\n");
  });

  it("roots a command-line bare path at the invocation directory, not the project root", () => {
    /* The cwd is to a command-line name what the containing build file's
     * directory is to a written one — fabr still finds the project by walking
     * up, but `a.txt` means the one *here*. */
    const result = runFabr(project, ["cat", "a.txt"], undefined, "src");
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("AAA\n");
    /* Named from the cwd, so the listing is too (the containing dir is the
     * locating alias, stripped from result names). */
    expect(runFabr(project, ["ls", "*.txt"], undefined, "src").stdout).to.equal("a.txt\nb.txt\n");
  });

  it("prefers a declared name over a same-named directory", () => {
    /* Same precedence as anywhere else: the target/property prefix is matched
     * first, and only a name that declares nothing reaches the filesystem. */
    const shadowed = { ...project, "PROJECT.fabr": "src = ./src/b.txt;\n" };
    const result = runFabr(shadowed, ["ls", "src"]);
    expect(result.status).to.equal(0);
    /* The property's single file, not the directory's two. */
    expect(result.stdout).to.equal("src/b.txt\n");
  });

  it("reports a name that is neither declared nor a file against the command line", () => {
    /* One wording for one mistake, whichever verb was used — and, since the name
     * resolves as a value written in a synthesized decl over the invocation, it
     * reports like any other written reference: the command excerpted, the
     * offending argument underlined where it sits in it. */
    const result = runFabr(project, ["cat", "files:a.txt", "srcc"]);
    expect(result.status).to.equal(1);
    expect(result.stderr).to.contain("Unknown name 'srcc'");
    expect(result.stderr).to.contain("<command-line>:1:22");
    expect(result.stderr).to.contain("fabr cat files:a.txt srcc");
    expect(result.stderr).to.contain(`${" ".repeat(21)}^^^^`);
    expect(result.stderr).to.contain("fabr list-targets");
  });

  it("renders both sides of a naming conflict raised by a target's own union", () => {
    /* A `script`'s deps union flat into one install, so two deps that each name
     * `dup.txt` at a different underlying file conflict inside the target build.
     * The formatter must surface both attributed sides — each contributor traced
     * to its underlying file — not just the one-line message. */
    const conflict = {
      "PROJECT.fabr":
        "adir = src:a/* -> *;\nbdir = src:b/* -> *;\nscript clash { deps = adir bdir; entry = src:a/go.sh; }\n",
      "src/a/go.sh": "true\n",
      "src/a/dup.txt": "FROM A\n",
      "src/b/dup.txt": "FROM B\n",
    };
    const result = runFabr(conflict, ["run", "clash"]);
    expect(result.status).to.equal(1);
    expect(result.stdout).to.equal("");
    expect(result.stderr).to.match(/Conflicting files for dup\.txt/);
    expect(result.stderr).to.match(/src\/a\/dup\.txt/);
    expect(result.stderr).to.match(/src\/b\/dup\.txt/);
  });

  it("exits quietly (not a raw EPIPE crash) when the stdout consumer closes early", async () => {
    /* `fabr cat many | head`: the consumer stops reading mid-stream, closing the
     * pipe. The next stdout write hits EPIPE — which, unhandled, Node turns into a
     * raw uncaught-exception stack. fabr must swallow it and exit cleanly instead.
     * Many files (so many separate writes) makes the failure land mid-stream and
     * deterministic: a single write can race the process's own exit and mask it. */
    const files: Record<string, string> = { "PROJECT.fabr": "files = src:**/*;\n" };
    for (let i = 0; i < 2000; i++) {
      files[`src/f${i}.txt`] = `content of file ${i}\n`;
    }
    const result = await runFabrClosingStream(files, ["cat", "files:**/*.txt"]);
    /* Clean exit, and no Node error stack / EPIPE mention leaked to stderr. */
    expect(result.status).to.equal(0);
    expect(result.stderr).to.not.match(/EPIPE/);
    expect(result.stderr).to.not.match(/Unhandled 'error' event/);
  });

  it("keeps a failing command's non-zero status when its stderr pipe breaks", async () => {
    /* A failing command whose diagnostics pipe is gone (`fabr … 2>&1 | head`)
     * still exits non-zero: swallowing EPIPE must not swallow the failure. This
     * locks the contract that EPIPE handling never overrides the real exit status
     * — the reason the handler swallows rather than force-exiting 0 (which, if it
     * won the race against a mid-operation write, would report failure as success). */
    const project = { "PROJECT.fabr": "files = src:**/*;\n", "src/a.txt": "AAA\n" };
    const result = await runFabrClosingStream(project, ["cat", "files:missing.txt"], "stderr");
    expect(result.status).to.equal(1);
  });

  it("reports a formatted diagnostic (not a raw crash) when run outside a project", () => {
    /* No PROJECT.fabr anywhere up the tree: getSourceRoot fails before the build
     * graph exists. That failure must be reported like any other (the terminal
     * "Build failed" line marks the handled path) and not escape as an unhandled
     * rejection. */
    const result = runFabr({ "notes.txt": "hi\n" }, ["cat", "files:a.txt"]);
    expect(result.status).to.equal(1);
    expect(result.stdout).to.equal("");
    expect(result.stderr).to.match(/No PROJECT\.fabr found/);
    expect(result.stderr).to.match(/Build failed/);
  });

  it("cp of a single named file copies it flat (cp file out → out/file)", () => {
    /* `files:a.txt` directly names one file (the `:` strips the `src` prefix), so
     * — like `cp a.txt out/` — it lands flat at `out/a.txt`, no wrapper dir. Data
     * goes to disk, not stdout; the confirmation is on stderr. */
    const result = runFabr(project, ["cp", "files:a.txt", "out"], ["out/a.txt"]);
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("");
    expect(result.files?.["out/a.txt"]).to.equal("AAA\n");
    expect(result.stderr).to.match(/Copied 1 file/);
  });

  it("cp of a container name nests its files under a dir named for the reference", () => {
    /* `files` names a container (a multi-file target), so — like `cp -r dir out/`
     * → `out/dir/` — its contents nest under `out/files/`, the dir named for the
     * entered reference's final component (not any resolved package name). */
    const result = runFabr(project, ["cp", "files", "out"], ["out/files/a.txt", "out/files/b.txt", "out/a.txt"]);
    expect(result.status).to.equal(0);
    expect(result.files?.["out/files/a.txt"]).to.equal("AAA\n");
    expect(result.files?.["out/files/b.txt"]).to.equal("BBB\n");
    /* NOT flattened into out/ directly. */
    expect(result.files?.["out/a.txt"]).to.be.undefined;
  });

  it("cp of a glob projection copies the matched files flat", () => {
    /* A final glob (`files:*.txt`) is a file selection, not a container, so — like
     * `cp *.txt out/` — the matches land directly under `out/`, no wrapper. */
    const result = runFabr(project, ["cp", "files:*.txt", "out"], ["out/a.txt", "out/b.txt", "out/files/a.txt"]);
    expect(result.status).to.equal(0);
    expect(result.files?.["out/a.txt"]).to.equal("AAA\n");
    expect(result.files?.["out/b.txt"]).to.equal("BBB\n");
    expect(result.files?.["out/files/a.txt"]).to.be.undefined;
  });

  it("cp of a glob under a subdirectory drops the walked directories, keeping structure below", () => {
    /* The bug this covers: `copyPrefix` correctly declined to add a wrapper for a final
     * glob, but the resolved names still carried the directories the selector walked
     * through (a projection strips only what precedes its `:`), so the matches landed under
     * `out/nested/` instead of in `out/`. Real `cp` names a file source by its basename —
     * the shell expands `nested/*.txt` and hands cp each file — so the literal part of the
     * selector is the path copied *from* and comes off. What a wildcard matched is still
     * structure, and is kept: `**` below the base preserves its subdirectories, exactly as
     * `cp -R nested/. out` does. */
    const nested = {
      "PROJECT.fabr": "files = src:**/*;\n",
      "src/nested/a.txt": "AAA\n",
      "src/nested/deep/c.txt": "CCC\n",
    };
    const flat = runFabr(nested, ["cp", "files:nested/*.txt", "out"], ["out/a.txt", "out/nested/a.txt"]);
    expect(flat.status).to.equal(0);
    expect(flat.files?.["out/a.txt"]).to.equal("AAA\n");
    expect(flat.files?.["out/nested/a.txt"]).to.be.undefined;

    const recursive = runFabr(nested, ["cp", "files:nested/**", "out"], ["out/a.txt", "out/deep/c.txt", "out/nested/a.txt"]);
    expect(recursive.status).to.equal(0);
    expect(recursive.files?.["out/a.txt"]).to.equal("AAA\n");
    expect(recursive.files?.["out/deep/c.txt"]).to.equal("CCC\n");
    expect(recursive.files?.["out/nested/a.txt"]).to.be.undefined;
  });

  it("cp leaves an explicit rename alone rather than stripping its prefix back off", () => {
    /* The rename asks for the files under `core/`, and the selector's literal prefix is also
     * `core/` — so cp's default strip would take straight back off what the rename just put
     * on, silently overriding it. An explicit `-> tmpl` is the naming; cp adds nothing. */
    const nested = {
      "PROJECT.fabr": "files = src:**/*;\n",
      "src/core/a.ts": "AAA\n",
      "src/core/sub/b.ts": "BBB\n",
    };
    const result = runFabr(
      nested,
      ["cp", "files:core/**/*.ts -> core/**/*.js", "out"],
      ["out/core/a.js", "out/core/sub/b.js", "out/a.js", "out/sub/b.js"]
    );
    expect(result.status).to.equal(0);
    expect(result.files?.["out/core/a.js"]).to.equal("AAA\n");
    expect(result.files?.["out/core/sub/b.js"]).to.equal("BBB\n");
    /* NOT stripped back to the flat form the default would have produced. */
    expect(result.files?.["out/a.js"]).to.be.undefined;
    expect(result.files?.["out/sub/b.js"]).to.be.undefined;
  });

  it("cp of a glob outside the final segment keeps what the wildcard matched", () => {
    /* The wildcard is not in the last segment, so the leaf is a literal *file* name. Judging
     * flatness by that leaf used to send this down the container path and nest everything
     * under a directory named for a file (`out/t.ts/x1/t.ts`); the name's own `hasGlob` is
     * what makes it a file selection. Nothing literal precedes the wildcard, so nothing is
     * stripped and each match keeps the directory it was found in. */
    const dirs = {
      "PROJECT.fabr": "files = src:**/*;\n",
      "src/x1/t.ts": "T1\n",
      "src/x2/t.ts": "T2\n",
    };
    const result = runFabr(dirs, ["cp", "files:*/t.ts", "out"], ["out/x1/t.ts", "out/x2/t.ts", "out/t.ts/x1/t.ts"]);
    expect(result.status).to.equal(0);
    expect(result.files?.["out/x1/t.ts"]).to.equal("T1\n");
    expect(result.files?.["out/x2/t.ts"]).to.equal("T2\n");
    expect(result.files?.["out/t.ts/x1/t.ts"]).to.be.undefined;
  });

  it("cp copies identically whether the path was written with ':' or '/'", () => {
    /* The separator decides what the resolved files are *named* — `:` strips what precedes
     * it, `/` keeps the whole written path — but cp copies from the path as written either
     * way, so both forms must land the same files in the same places. */
    const nested = {
      "PROJECT.fabr": "files = src:**/*;\n",
      "src/nested/a.txt": "AAA\n",
    };
    for (const separator of [":", "/"]) {
      const glob = runFabr(nested, ["cp", `files${separator}nested/*.txt`, "out"], ["out/a.txt", "out/nested/a.txt"]);
      expect(glob.status, separator).to.equal(0);
      expect(glob.files?.["out/a.txt"], separator).to.equal("AAA\n");
      expect(glob.files?.["out/nested/a.txt"], separator).to.be.undefined;

      const single = runFabr(nested, ["cp", `files${separator}nested/a.txt`, "out"], ["out/a.txt", "out/nested/a.txt"]);
      expect(single.status, separator).to.equal(0);
      expect(single.files?.["out/a.txt"], separator).to.equal("AAA\n");
      expect(single.files?.["out/nested/a.txt"], separator).to.be.undefined;
    }
  });

  it("cp of a leading-wildcard glob keeps the whole matched structure", () => {
    /* Nothing literal precedes the wildcard, so there is no path to copy *from* and
     * nothing comes off — the matches keep their full names under dest. */
    const nested = {
      "PROJECT.fabr": "files = src:**/*;\n",
      "src/nested/a.txt": "AAA\n",
    };
    const result = runFabr(nested, ["cp", "files:**/*.txt", "out"], ["out/nested/a.txt"]);
    expect(result.status).to.equal(0);
    expect(result.files?.["out/nested/a.txt"]).to.equal("AAA\n");
  });

  it("cp of several containers yields one directory per source", () => {
    /* `cp @scope/core @scope/cli out` → `out/core`, `out/cli`: each container
     * source becomes its own subdirectory, named for the reference's final
     * component (here two multi-file targets stand in for packages). */
    const twoTargets = {
      "PROJECT.fabr": "one = a:**/*;\ntwo = b:**/*;\n",
      "a/x.txt": "X\n",
      "b/y.txt": "Y\n",
    };
    const result = runFabr(twoTargets, ["cp", "one", "two", "out"], ["out/one/x.txt", "out/two/y.txt"]);
    expect(result.status).to.equal(0);
    expect(result.files?.["out/one/x.txt"]).to.equal("X\n");
    expect(result.files?.["out/two/y.txt"]).to.equal("Y\n");
  });

  it("cp of a constrained container nests under the facet-stripped name, not the literal", () => {
    /* A `<k=v>` delta on the source (`one<BUILD_TYPE=release>`) constrains its
     * build; it must NOT leak into the destination directory name — the reference
     * is parsed and its facets stripped before its leaf becomes the wrapper dir,
     * so the files land under `out/one/`, never `out/one<BUILD_TYPE=release>/`. */
    const result = runFabr(
      { "PROJECT.fabr": "one = a:**/*;\n", "a/x.txt": "X\n" },
      ["cp", "one<BUILD_TYPE=release>", "out"],
      ["out/one/x.txt", "out/one<BUILD_TYPE=release>/x.txt"]
    );
    expect(result.status).to.equal(0);
    expect(result.files?.["out/one/x.txt"]).to.equal("X\n");
    expect(result.files?.["out/one<BUILD_TYPE=release>/x.txt"]).to.be.undefined;
  });

  it("cp of a glob projection carrying a constraint still copies flat", () => {
    /* The facet strips before the flatness check too: a final glob copies flat
     * whether or not the source also carries a `<k=v>` delta. */
    const result = runFabr(
      { "PROJECT.fabr": "one = a:**/*;\n", "a/x.txt": "X\n" },
      ["cp", "one<BUILD_TYPE=release>:*.txt", "out"],
      ["out/x.txt", "out/one/x.txt"]
    );
    expect(result.status).to.equal(0);
    expect(result.files?.["out/x.txt"]).to.equal("X\n");
    expect(result.files?.["out/one/x.txt"]).to.be.undefined;
  });

  it("cp fails, writing nothing, when a source matches no files", () => {
    const result = runFabr(project, ["cp", "files:zzz.txt", "out"], ["out/zzz.txt"]);
    expect(result.status).to.equal(1);
    expect(result.files?.["out/zzz.txt"]).to.be.undefined;
    expect(result.stderr).to.contain("Unable to resolve 'files:zzz.txt'");
  });

  it("cp requires a destination as well as a source", () => {
    const result = runFabr(project, ["cp", "files:a.txt"]);
    expect(result.status).to.equal(1);
    expect(result.stderr).to.match(/cp requires .* destination/);
  });
});
