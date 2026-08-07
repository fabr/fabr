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
import { FileSet } from "./FileSet";
import { FileSetRef } from "./FileSetRef";
import { MemoryFile } from "./MemoryFS";
import { PackageFileSet } from "./PackageFileSet";
import { renamedDelivery, RepositoryReader, RepositoryRef } from "./Repository";
import { parseName } from "../model/Parser";

/** deliveredAs reads only the reference itself, never its source. */
const SOURCE = {} as unknown as RepositoryReader;

function ref(written: string): RepositoryRef {
  return new RepositoryRef(SOURCE, parseName(written));
}

function pkg(name: string, version = "1.0.0", dependencies: PackageFileSet[] = []): PackageFileSet {
  return new PackageFileSet(new Map([["index.js", MemoryFile.from("")]]), name, version, dependencies);
}

describe("RepositoryRef.deliveredAs", () => {
  it("delivers a package unchanged when the reference carries no rename", () => {
    const delivered = ref("stream-browserify:3.0.0").deliveredAs(pkg("stream-browserify", "3.0.0"));
    expect((delivered as PackageFileSet).packageName).to.equal("stream-browserify");
  });

  it("restamps the delivered package when the identity half carries a rename", () => {
    /* `-> ` renames what the reference delivers; at the identity half that is a
     * package, so the rename is its mount identity — the npm dependency alias
     * ("stream": "npm:stream-browserify@^3") written the other way round. */
    const inner = pkg("readable-stream", "2.0.0");
    const delivered = ref("stream-browserify:3.0.0 -> stream").deliveredAs(pkg("stream-browserify", "3.0.0", [inner]));
    const renamed = delivered as PackageFileSet;
    expect(renamed.packageName).to.equal("stream");
    expect(renamed.packageId).to.equal("stream@3.0.0");
    /* Only the identity changes: content, version and the closure — which still
     * resolves among itself under the real names — are the delivery's own. */
    expect([...renamed].map(([name]) => name)).to.deep.equal(["index.js"]);
    expect(renamed.dependencies).to.deep.equal([inner]);
  });

  it("leaves the package alone when the rename rides a projection", () => {
    /* The facet reaches exactly one half: a repository splits its reference at
     * the projection boundary, so a projected rename renames the files it
     * selects and the delivered package keeps its own name. */
    const projected = ref("stream-browserify:3.0.0").find(parseName("lib/*.js -> *.mjs"));
    const delivered = projected.deliveredAs(pkg("stream-browserify", "3.0.0"));
    expect(delivered).to.be.instanceOf(FileSetRef);
    expect((delivered as FileSetRef).source).to.be.instanceOf(PackageFileSet);
    expect(((delivered as FileSetRef).source as PackageFileSet).packageName).to.equal("stream-browserify");
  });

  it("rejects a rename of a delivery that is not a package", () => {
    /* Only a package has an identity to rename; a plain fileset has no name a
     * rename could be about, so this is an error rather than a silent no-op. */
    const files = new FileSet(new Map([["a.txt", MemoryFile.from("")]]));
    expect(() => ref("something:1.0.0 -> other").deliveredAs(files)).to.throw(/does not deliver a package/);
  });
});

describe("renamedDelivery", () => {
  /* The rule itself, shared by both delivery sites — an external package's (via
   * deliveredAs, above) and a built one's (BuildContext.resolveFileSource). */
  const to = (name: string): ReturnType<typeof parseName> => parseName(name);

  it("carries the rename onward when the delivery is still deferred", () => {
    /* A reference that has not been delivered yet cannot be restamped, so the
     * facet rides it — reaching this same rule again at its collection point. */
    const deferred = renamedDelivery(ref("stream-browserify:3.0.0"), to("stream"), "written");
    expect(deferred).to.be.instanceOf(RepositoryRef);
    expect((deferred as RepositoryRef).name.getRenameTo()?.toString()).to.equal("stream");
    /* And it means the same thing when it lands. */
    const delivered = (deferred as RepositoryRef).deliveredAs(pkg("stream-browserify", "3.0.0"));
    expect((delivered as PackageFileSet).packageName).to.equal("stream");
  });

  it("refuses a reference whose own projection already renames files", () => {
    /* Its delivery is files, not a package — the two readings of `-> ` must not
     * both apply to one reference. */
    const projected = ref("pkg:1.0.0").find(parseName("lib/*.js -> *.mjs"));
    expect(() => renamedDelivery(projected, to("other"), "written")).to.throw(/does not deliver a package/);
  });
});
