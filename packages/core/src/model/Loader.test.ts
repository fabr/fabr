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
import { ISystemIncludeDir, loadProject } from "./Loader";

/* Note: build files are cached per resolved path for the process lifetime, so
 * every test case uses its own distinct directory names. */

function files(entries: Record<string, string>): FileSet {
  return new FileSet(new Map(Object.entries(entries).map(([name, content]) => [name, MemoryFile.from(content)])));
}

function load(project: FileSet, startFile: string, systemPath: ISystemIncludeDir[]): BuildModel {
  const errors: string[] = [];
  const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
  let model: BuildModel | undefined;
  loadProject(project, startFile, logger, undefined, systemPath).then(result => {
    model = result;
  });
  /* All sources are in-memory, so loading completes synchronously */
  expect(errors).to.deep.equal([]);
  expect(model).to.not.equal(undefined);
  return model!;
}

function propertyValue(model: BuildModel, name: string): string | undefined {
  const decl = model.getDecl(name);
  return decl?.kind === DeclKind.Property ? decl.values.map(value => value.value.toString()).join(" ") : undefined;
}

describe("Loader", () => {
  it("resolves bare includes against the system include path", () => {
    const project = files({ "/proj1/PROJECT.fabr": "include LIB.fabr;\nown = 1;" });
    const system = [{ dir: "/sys1/lib", fs: files({ "/sys1/lib/LIB.fabr": "from_system = yes;" }) }];
    const model = load(project, "/proj1/PROJECT.fabr", system);
    expect(propertyValue(model, "from_system")).to.equal("yes");
    expect(propertyValue(model, "own")).to.equal("1");
  });

  it("searches system directories in order", () => {
    const system = [
      { dir: "/sys2a", fs: files({ "/sys2a/LIB.fabr": "which = first;" }) },
      { dir: "/sys2b", fs: files({ "/sys2b/LIB.fabr": "which = second;" }) },
    ];
    const project = files({ "/proj2/PROJECT.fabr": "include LIB.fabr;" });
    const model = load(project, "/proj2/PROJECT.fabr", system);
    expect(propertyValue(model, "which")).to.equal("first");
  });

  it("system path wins over a same-named file next to the including file", () => {
    const project = files({
      "/proj3/PROJECT.fabr": "include LIB.fabr;",
      "/proj3/LIB.fabr": "which = local;",
    });
    const system = [{ dir: "/sys3", fs: files({ "/sys3/LIB.fabr": "which = system;" }) }];
    const model = load(project, "/proj3/PROJECT.fabr", system);
    expect(propertyValue(model, "which")).to.equal("system");
  });

  it("falls back to the including file's directory for bare names", () => {
    const project = files({
      "/proj4/PROJECT.fabr": "include LOCAL.fabr;",
      "/proj4/LOCAL.fabr": "which = local;",
    });
    const system = [{ dir: "/sys4", fs: files({}) }];
    const model = load(project, "/proj4/PROJECT.fabr", system);
    expect(propertyValue(model, "which")).to.equal("local");
  });

  it("resolves path-containing includes relative to the including file only", () => {
    const project = files({
      "/proj5/PROJECT.fabr": "include sub/LIB.fabr;",
      "/proj5/sub/LIB.fabr": "which = relative;",
    });
    /* A same-named system file must not shadow a path-containing include */
    const system = [{ dir: "/sys5", fs: files({ "/sys5/sub/LIB.fabr": "which = system;" }) }];
    const model = load(project, "/proj5/PROJECT.fabr", system);
    expect(propertyValue(model, "which")).to.equal("relative");
  });

  it("system-included files resolve their own bare includes on the system path", () => {
    const project = files({ "/proj6/PROJECT.fabr": "include OUTER.fabr;" });
    const system = [
      {
        dir: "/sys6",
        fs: files({
          "/sys6/OUTER.fabr": "include INNER.fabr;\nouter = yes;",
          "/sys6/INNER.fabr": "inner = yes;",
        }),
      },
    ];
    const model = load(project, "/proj6/PROJECT.fabr", system);
    expect(propertyValue(model, "outer")).to.equal("yes");
    expect(propertyValue(model, "inner")).to.equal("yes");
  });
});
