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
import { FileSet, IFile, MemoryFile, PackageFileSet, SymlinkFile } from "@fabr/core";
import { assembleScopedNodeModules } from "./JSPackage";

/** A package with a single `index.js` and the given (already-built) deps. */
function pkg(name: string, deps: PackageFileSet[] = []): PackageFileSet {
  return new PackageFileSet(new Map<string, IFile>([["index.js", MemoryFile.from(`// ${name}`)]]), name, "1.0.0", deps);
}

/** Snapshot a FileSet's entries into a plain map for synchronous inspection. */
function entries(set: FileSet): Map<string, IFile> {
  return new Map(set);
}

describe("assembleScopedNodeModules", () => {
  it("exposes only direct deps at the top level, the closure only in the store", () => {
    const transitive = pkg("b4a");
    const direct = pkg("tar-stream", [transitive]);
    const files = entries(assembleScopedNodeModules([direct]));

    /* The direct dep is a symlink into the store; the transitive one is not
     * present at the top level at all. */
    const top = files.get("tar-stream");
    expect(top).to.be.instanceOf(SymlinkFile);
    expect((top as SymlinkFile).target).to.equal(".pkgs/node_modules/tar-stream");
    expect(files.has("b4a")).to.equal(false);

    /* Both packages' real files live in the store, so a direct dep can resolve
     * its own (transitive) imports there. */
    expect(files.has(".pkgs/node_modules/tar-stream/index.js")).to.equal(true);
    expect(files.has(".pkgs/node_modules/b4a/index.js")).to.equal(true);
  });

  it("points a scoped package's symlink back up to the store", () => {
    const files = entries(assembleScopedNodeModules([pkg("@types/node")]));
    /* From node_modules/@types/node the link must climb one level to reach the store. */
    const top = files.get("@types/node");
    expect(top).to.be.instanceOf(SymlinkFile);
    expect((top as SymlinkFile).target).to.equal("../.pkgs/node_modules/@types/node");
    expect(files.has(".pkgs/node_modules/@types/node/index.js")).to.equal(true);
  });

  it("passes non-package sources through at the top level", () => {
    const loose = new FileSet(new Map<string, IFile>([["loose.js", MemoryFile.from("x")]]));
    const files = entries(assembleScopedNodeModules([pkg("tar-stream"), loose]));
    expect(files.has("loose.js")).to.equal(true);
  });
});
