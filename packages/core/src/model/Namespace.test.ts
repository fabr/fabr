/*
 * Copyright (c) 2022 Nathan Keynes <nkeynes@deadcoderemoval.net>
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
import { DeclKind, IBuildFile, ITargetDecl } from "./AST";
import { Name } from "../core/Name";
import { Namespace } from "./Namespace";
import { parseName } from "./Parser";

const fakeFile = {} as IBuildFile;

function targetDecl(name: string): ITargetDecl {
  return {
    kind: DeclKind.Target,
    type: "library",
    typeOffset: 0,
    name: Name.fromLiteral(name),
    offset: 0,
    properties: [],
    source: fakeFile,
  };
}

describe("Namespace.getPrefixMatch", () => {
  const ns = new Namespace(new Map([["pkg", targetDecl("pkg")]]), new Map());

  it("strips everything before ':' (glob immediately after the target)", () => {
    /* `pkg:*.js` — colon projection: result names retain nothing of the prefix. */
    const match = ns.getPrefixMatch(parseName("pkg:*.js"));
    expect(match?.name).to.equal("pkg");
    expect(match?.retainedPrefix).to.equal("");
    expect(match?.rest.toString()).to.equal("*.js");
  });

  it("keeps the written name for a '/' path (glob immediately after the target)", () => {
    /* `pkg/*.txt` — plain path: the `pkg/` prefix is retained on result names. */
    const match = ns.getPrefixMatch(parseName("pkg/*.txt"));
    expect(match?.name).to.equal("pkg");
    expect(match?.retainedPrefix).to.equal("pkg/");
    expect(match?.rest.toString()).to.equal("*.txt");
  });

  it("strips before ':' with a literal path segment before the glob", () => {
    const match = ns.getPrefixMatch(parseName("pkg:build/*.js"));
    expect(match?.name).to.equal("pkg");
    expect(match?.retainedPrefix).to.equal("");
    expect(match?.rest.toString()).to.equal("build/*.js");
  });
});
