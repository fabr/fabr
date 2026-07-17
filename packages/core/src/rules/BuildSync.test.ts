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
import { Name } from "../core/Name";
import { PublishableFileSet } from "../core/PublishableFileSet";
import { RepositoryPublishRef, RepositoryWriter } from "../core/Repository";
import { publishOrder } from "./BuildSync";

/* The sort reads only the provides/dependsOn tokens; the destination is inert
 * here. Tokens are npm-style names, addresses written name:version. */
const DEST = {} as RepositoryWriter;

function carrier(name: string, version: string, dependsOn: string[] = [], destination = DEST): PublishableFileSet {
  const coordinate = new RepositoryPublishRef(destination, Name.fromLiteral(`${name}:${version}`));
  return new PublishableFileSet(new Map(), coordinate, name, dependsOn);
}

function labels(carriers: PublishableFileSet[]): string[] {
  return carriers.map(c => c.destination.toString());
}

describe("publishOrder (deps-first release ordering)", () => {
  it("orders a member after the members it depends on, whatever the declaration order", () => {
    const app = carrier("app", "1.0.0", ["base"]);
    const mid = carrier("mid", "1.0.0", ["base"]);
    const base = carrier("base", "1.0.0");
    expect(labels(publishOrder([app, mid, base]))).to.deep.equal(["base:1.0.0", "app:1.0.0", "mid:1.0.0"]);
  });

  it("orders across the whole release, not per destination (edges may cross registries)", () => {
    const other = { marker: true } as unknown as RepositoryWriter;
    const twin = carrier("base", "1.0.0", [], other);
    const app = carrier("app", "1.0.0", ["base"]);
    expect(labels(publishOrder([app, twin]))).to.deep.equal(["base:1.0.0", "app:1.0.0"]);
  });

  it("orders a dependant after every member providing the depended-on token", () => {
    const app = carrier("app", "1.0.0", ["base"]);
    const base1 = carrier("base", "1.0.0");
    const base2 = carrier("base", "2.0.0");
    const ordered = labels(publishOrder([app, base1, base2]));
    expect(ordered.indexOf("app:1.0.0")).to.be.greaterThan(ordered.indexOf("base:1.0.0"));
    expect(ordered.indexOf("app:1.0.0")).to.be.greaterThan(ordered.indexOf("base:2.0.0"));
  });

  it("tolerates a dependency cycle (broken at the back-edge) rather than failing", () => {
    const a = carrier("a", "1.0.0", ["b"]);
    const b = carrier("b", "1.0.0", ["a"]);
    expect(labels(publishOrder([a, b]))).to.deep.equal(["b:1.0.0", "a:1.0.0"]);
  });
});
