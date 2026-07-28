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
import { BuildCache } from "../core/BuildCache";
import { EMPTY_FILESET, FileSet } from "../core/FileSet";
import { MemoryFile } from "../core/MemoryFS";
import { LogFormatter, LogLevel } from "../support/Log";
import { DeclKind, isNameValue } from "./AST";
import { BuildModel } from "./BuildModel";
import { BuildFilesInvalidError } from "./Errors";
import { ExecutionContext } from "./ExecutionContext";
import { loadProject } from "./Loader";

/** A minimal ExecutionContext for the loader: the project tree as the source, an
 *  empty absolute source (these tests use NO_BASE, so no lib files are read). */
function exec(project: FileSet, log: LogFormatter): ExecutionContext {
  return new ExecutionContext(new BuildCache(".", log), log, project, EMPTY_FILESET);
}

/* Includes are now: core's STD.fabr (always, no explicit include — exercised by
 * the bootstrap/e2e against the real built lib/, not here), a `plugin` decl's
 * auto-included files (bootstrap/e2e against real @fabr-build/js), and explicit
 * path-relative `include ./p;`. There is no system include path. These unit tests
 * cover the include mechanics with a STUB base contribution whose `includes` are
 * empty, so they touch no real on-disk lib/ (unavailable under ts-jest). */

const NO_BASE = { includes: [] };

function files(entries: Record<string, string>): FileSet {
  return new FileSet(new Map(Object.entries(entries).map(([name, content]) => [name, MemoryFile.from(content)])));
}

async function load(project: FileSet, startFile: string): Promise<BuildModel> {
  const errors: string[] = [];
  const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
  const model = await loadProject(exec(project, logger), startFile, NO_BASE);
  expect(errors).to.deep.equal([]);
  return model;
}

function propertyValue(model: BuildModel, name: string): string | undefined {
  const decl = model.getDecl(name);
  return decl?.kind === DeclKind.Property
    ? decl.values.map(value => (isNameValue(value) ? value.value.toString() : "")).join(" ")
    : undefined;
}

describe("Loader", () => {
  it("resolves explicit includes relative to the including file", async () => {
    const project = files({
      "PROJECT.fabr": "include sub/LIB.fabr;\nown = here;",
      "sub/LIB.fabr": "which = relative;",
    });
    const model = await load(project, "PROJECT.fabr");
    expect(propertyValue(model, "which")).to.equal("relative");
    expect(propertyValue(model, "own")).to.equal("here");
  });

  it("resolves a nested include relative to its own including file", async () => {
    const project = files({
      "PROJECT.fabr": "include sub/OUTER.fabr;",
      "sub/OUTER.fabr": "include INNER.fabr;\nouter = yes;",
      "sub/INNER.fabr": "inner = yes;",
    });
    const model = await load(project, "PROJECT.fabr");
    expect(propertyValue(model, "outer")).to.equal("yes");
    expect(propertyValue(model, "inner")).to.equal("yes");
  });

  it("allows an include climbing within the project tree", async () => {
    const project = files({
      "PROJECT.fabr": "include sub/OUTER.fabr;",
      "sub/OUTER.fabr": "include ../TOP.fabr;",
      "TOP.fabr": "top = yes;",
    });
    const model = await load(project, "PROJECT.fabr");
    expect(propertyValue(model, "top")).to.equal("yes");
  });

  it("blocks an include outside the project tree", async () => {
    const project = files({ "PROJECT.fabr": "include ../outside.fabr;" });
    const logger = new LogFormatter(LogLevel.Info, () => undefined);
    let error: Error | undefined;
    try {
      await loadProject(exec(project, logger), "PROJECT.fabr", NO_BASE);
    } catch (err) {
      error = err as Error;
    }
    expect(error?.message).to.match(/outside the project tree/);
  });

  it("reports a missing include positioned at the include, then stops", async () => {
    const { error, logged } = await loadErr(files({ "PROJECT.fabr": "include missing.fabr;" }));
    /* Halts like any build-file error, and the diagnostic is a block naming the
     * missing file and pointing back at the `include` that wrote it. */
    expect(error).to.be.an.instanceOf(BuildFilesInvalidError);
    expect(logged.join("\n")).to.match(/Included file not found: missing\.fabr/);
    expect(logged.join("\n")).to.match(/PROJECT\.fabr:1:9/);
  });

  it("traces a missing include back through the whole include chain", async () => {
    const { error, logged } = await loadErr(
      files({
        "PROJECT.fabr": "include mid.fabr;",
        "mid.fabr": "include gone.fabr;",
      })
    );
    expect(error).to.be.an.instanceOf(BuildFilesInvalidError);
    const out = logged.join("\n");
    /* Primary at the include that named the missing file, then a note per hop
     * back to the project file. */
    expect(out).to.match(/Included file not found: gone\.fabr[\s\S]*mid\.fabr:1:9/);
    expect(out).to.match(/included from here[\s\S]*PROJECT\.fabr:1:9/);
  });

  /* Parse and sema/validation recover to report every error rather than throwing;
   * the load as a whole must still reject so no operation builds against an
   * unsound model. Each error is reported to the log; the rejection just stops. */
  async function loadErr(project: FileSet): Promise<{ error?: Error; logged: string[] }> {
    const logged: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => logged.push(msg));
    let error: Error | undefined;
    try {
      await loadProject(exec(project, logger), "PROJECT.fabr", NO_BASE);
    } catch (err) {
      error = err as Error;
    }
    return { error, logged };
  }

  it("reports a plugin activation failure positioned at the declaration, then stops", async () => {
    const { error, logged } = await loadErr(files({ "PROJECT.fabr": "plugin @fabr/definitely-not-installed;" }));
    expect(error).to.be.an.instanceOf(BuildFilesInvalidError);
    const out = logged.join("\n");
    expect(out).to.match(/not installed/);
    expect(out).to.match(/PROJECT\.fabr:1:8/);
  });

  it("rejects the load when a build file has a syntax error (reported, then stops)", async () => {
    const { error, logged } = await loadErr(files({ "PROJECT.fabr": "good = value;\n@@@ not valid\n" }));
    expect(error).to.be.an.instanceOf(BuildFilesInvalidError);
    expect(logged.some(msg => /error/i.test(msg))).to.equal(true);
  });

  it("rejects the load when an included file has a syntax error", async () => {
    const { error } = await loadErr(
      files({ "PROJECT.fabr": "include bad.fabr;\ngood = value;", "bad.fabr": "@@@ not valid\n" })
    );
    expect(error).to.be.an.instanceOf(BuildFilesInvalidError);
  });

  it("counts every reported error", async () => {
    const { error } = await loadErr(files({ "PROJECT.fabr": "targetdef good { x = STRING; }\ngood a { y = 1; z = 2; }" }));
    /* Two unrecognized properties in one target -> two errors. */
    expect(error).to.be.an.instanceOf(BuildFilesInvalidError);
    expect((error as BuildFilesInvalidError).errorCount).to.equal(2);
  });
});
