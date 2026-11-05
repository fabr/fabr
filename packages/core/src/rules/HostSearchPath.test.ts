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
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BuildCache } from "../core/BuildCache";
import { ComputableSource } from "../core/Computable";
import { FileSet } from "../core/FileSet";
import { hashString } from "../core/FSWrapper";
import { hostFiles } from "../model/ExecutionContext";
import { RepositoryRef } from "../core/Repository";
import { RunnableFileSet } from "../core/RunnableFileSet";
import { HostLink } from "../core/SymlinkFile";
import { parseName } from "../model/Parser";
import { HostSearchPathRepository } from "./HostSearchPath";

function toPromise<T>(computable: ComputableSource<T>): Promise<T> {
  return new Promise((resolve, reject) => computable.then(resolve, reject));
}

describe("HostSearchPathRepository", () => {
  let dir: string;
  let cacheRoot: string;
  let repository: HostSearchPathRepository;
  let savedPath: string | undefined;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fabr-host-repo-")));
    cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-host-repo-cache-"));
    fs.writeFileSync(path.join(dir, "tool"), "#!/bin/sh\necho tool\n", { mode: 0o755 });
    savedPath = process.env.PATH;
    process.env.PATH = dir;
    repository = new HostSearchPathRepository(hostFiles(new BuildCache(cacheRoot, { log: () => undefined })));
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  });

  const referenceTo = (name: string): RepositoryRef => repository.getRepositoryRef(parseName(name)) as RepositoryRef;

  it("resolves a program found on PATH to a runnable linking to it", async () => {
    const resolved = await toPromise(repository.resolve(referenceTo("tool")));
    expect(resolved).to.be.instanceOf(RunnableFileSet);
    const link = resolved.getFile("tool");
    expect(link).to.be.instanceOf(HostLink);
    expect((link as HostLink).location).to.equal(path.join(dir, "tool"));
    expect((link as HostLink).contentHash).to.equal(hashString("#!/bin/sh\necho tool\n"));
    expect((resolved as RunnableFileSet).toCommandLine(["x"])).to.deep.equal(["./tool", "x"]);
  });

  it("resolves a program by its absolute path, named as its last part", async () => {
    const resolved = await toPromise(repository.resolve(referenceTo(path.join(dir, "tool"))));
    expect((resolved.getFile("tool") as HostLink).location).to.equal(path.join(dir, "tool"));
    expect((resolved as RunnableFileSet).toCommandLine([])).to.deep.equal(["./tool"]);
  });

  it("resolves its files to the one link, named as the command", async () => {
    const files: FileSet = await toPromise(repository.resolveFiles(referenceTo("tool")));
    expect([...files].map(([name]) => name)).to.deep.equal(["tool"]);
  });

  it("refuses what is not a program's name", () => {
    expect(() => repository.getRepositoryRef(parseName("bin/tool"))).to.throw(/not the name of a program/);
    expect(() => repository.getRepositoryRef(parseName("./tool"))).to.throw(/not the name of a program/);
    expect(() => repository.getRepositoryRef(parseName("*"))).to.throw(/not the name of a program/);
    expect(() => repository.getRepositoryRef(parseName("tool!"))).to.throw(/override marker/);
  });

  it("fails for a program not on PATH", async () => {
    const failure = await toPromise(repository.resolve(referenceTo("missing"))).then(
      () => undefined,
      (err: Error) => err
    );
    expect(failure?.message).to.match(/Unable to find 'missing' in PATH/);
  });
});
