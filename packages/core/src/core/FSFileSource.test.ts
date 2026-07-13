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

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ComputableSource } from "./Computable";
import { FSFileSource } from "./FSFileSource";
import { expect } from "chai";

function toPromise<T>(computable: ComputableSource<T>): Promise<T> {
  return new Promise((resolve, reject) => computable.then(resolve, reject));
}

describe("FSFileSource.ingest", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-fs-test-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("treats a file that has vanished as absent, not an error", async () => {
    const src = new FSFileSource(root);
    /* No sync throw at the call site, and the ingest resolves to 'absent' rather
     * than rejecting — a file vanishing mid-event (the editor save-rename dance)
     * must not crash the watcher callback nor sink the whole re-settle batch. */
    const result = await toPromise(src.ingest("gone.txt"));
    expect(result).to.equal(undefined);
  });

  it("ingests an existing file", async () => {
    fs.writeFileSync(path.join(root, "a.txt"), "hi");
    const src = new FSFileSource(root);
    const file = await toPromise(src.ingest("a.txt"));
    expect(file?.name).to.equal("a.txt");
  });
});
