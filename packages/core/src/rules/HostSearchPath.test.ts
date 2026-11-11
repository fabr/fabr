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
import { EMPTY_FILESET, FileSet } from "../core/FileSet";
import { BuildAction } from "../core/BuildAction";
import { createPipelineAction, stagePipeline } from "../core/PipelineAction";
import { hashString } from "../core/FSWrapper";
import { hostFiles } from "../model/ExecutionContext";
import { RepositoryRef } from "../core/Repository";
import { manifestArguments, RunnableFileSet, toArgv } from "../core/RunnableFileSet";
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

  it("resolves a program found on PATH to a runnable run where it lies", async () => {
    const resolved = await toPromise(repository.resolve(referenceTo("tool")));
    expect(resolved).to.be.instanceOf(RunnableFileSet);
    const runnable = resolved as RunnableFileSet;
    /* Nothing is installed: the program is the entry, at its own location. */
    expect(runnable.size).to.equal(0);
    const link = runnable.surface.getFile("tool");
    expect(link).to.be.instanceOf(HostLink);
    expect((link as HostLink).location).to.equal(path.join(dir, "tool"));
    expect((link as HostLink).contentHash).to.equal(hashString("#!/bin/sh\necho tool\n"));
    expect(runnable.toCommandLine(["x"], { base: "tools" })).to.deep.equal([link, "x"]);
    expect(toArgv(runnable.toCommandLine(["x"]))).to.deep.equal([path.join(dir, "tool"), "x"]);
  });

  it("resolves a program by its absolute path, named as its last part", async () => {
    const resolved = (await toPromise(repository.resolve(referenceTo(path.join(dir, "tool"))))) as RunnableFileSet;
    expect((resolved.surface.getFile("tool") as HostLink).location).to.equal(path.join(dir, "tool"));
    expect(toArgv(resolved.toCommandLine([]))).to.deep.equal([path.join(dir, "tool")]);
  });

  it("keys a program by its content and command, not where it was found", async () => {
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fabr-host-repo-other-")));
    try {
      fs.symlinkSync(dir, path.join(other, "linked"));
      const here = (await toPromise(repository.resolve(referenceTo("tool")))) as RunnableFileSet;
      const there = (await toPromise(repository.resolve(referenceTo(path.join(other, "linked", "tool"))))) as RunnableFileSet;
      expect(toArgv(there.toCommandLine())).to.deep.equal([path.join(other, "linked", "tool")]);
      expect(manifestArguments(there.toCommandLine(["-x"]))).to.equal(manifestArguments(here.toCommandLine(["-x"])));
      /* Run as a command, the program keys one action wherever it was found. */
      const actionOf = (runnable: RunnableFileSet): BuildAction => {
        const { files, specs } = stagePipeline([{ runnable, args: ["-x"], stdout: "out" }], EMPTY_FILESET);
        return createPipelineAction(files, specs, undefined, undefined);
      };
      expect(actionOf(there).actionKey()).to.equal(actionOf(here).actionKey());
      expect(actionOf(here).actionKey()).not.to.include(dir);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
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
