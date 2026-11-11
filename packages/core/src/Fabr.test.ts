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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ComputableSource } from "./core/Computable";
import { IFile } from "./core/FileSet";
import { Fabr } from "./Fabr";
import { LogFormatter, LogLevel } from "./support/Log";

let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fabr-run-")));
  fs.mkdirSync(path.join(root, "project"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function toPromise<T>(computable: ComputableSource<T>): Promise<T> {
  return new Promise((resolve, reject) => computable.then(resolve, reject));
}

describe("Fabr", () => {
  it("reads absolute paths where they lie, and fabr's installation as copies in the blob pool", async () => {
    const cacheRoot = path.join(root, "cache");
    const fabr = new Fabr({
      sourceRoot: path.join(root, "project"),
      cacheRoot,
      log: new LogFormatter(LogLevel.Info, () => undefined),
    });
    const credentials = path.join(root, "settings.xml");
    fs.writeFileSync(credentials, "<password>secret</password>");

    const read = (await toPromise(fabr.execution.absFileSource.get(credentials))) as IFile;
    expect(read.getAbsPath()).to.equal(credentials);
    expect(fabr.execution.buildCache.presentBlob(read.hash)).to.equal(undefined);

    const installed = (await toPromise(fabr.execution.installedFileSource.get(credentials))) as IFile;
    expect(installed.getAbsPath()?.startsWith(cacheRoot + path.sep)).to.equal(true);
  });
});
