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
import { FileSet } from "../core/FileSet";
import { MemoryFile } from "../core/MemoryFS";
import { LogFormatter, LogLevel } from "../support/Log";
import { DeclKind } from "./AST";
import { BuildModel } from "./BuildModel";
import { loadProject } from "./Loader";

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
  const model = await loadProject(project, startFile, logger, undefined, NO_BASE);
  expect(errors).to.deep.equal([]);
  return model;
}

function propertyValue(model: BuildModel, name: string): string | undefined {
  const decl = model.getDecl(name);
  return decl?.kind === DeclKind.Property ? decl.values.map(value => value.value.toString()).join(" ") : undefined;
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
      await loadProject(project, "PROJECT.fabr", logger, undefined, NO_BASE);
    } catch (err) {
      error = err as Error;
    }
    expect(error?.message).to.match(/outside the project tree/);
  });

  it("errors on a missing include", async () => {
    const project = files({ "PROJECT.fabr": "include missing.fabr;" });
    const logger = new LogFormatter(LogLevel.Info, () => undefined);
    let error: Error | undefined;
    try {
      await loadProject(project, "PROJECT.fabr", logger, undefined, NO_BASE);
    } catch (err) {
      error = err as Error;
    }
    expect(error?.message).to.match(/File not found/);
  });
});
