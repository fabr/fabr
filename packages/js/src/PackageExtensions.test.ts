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
import { parseVersion } from "@fabr-build/core";
import { declaredDependencies } from "./PackageJson";
import { PackageExtensions, toPackageExtensions } from "./PackageExtensions";

/** A list over the given `[selector, data]` pairs. */
function extensions(entries: unknown[]): PackageExtensions {
  return new PackageExtensions(toPackageExtensions(entries), "test");
}

describe("toPackageExtensions", () => {
  it("reads name@range selectors, scoped names included", () => {
    const list = extensions([
      ["reactcss@*", { peerDependencies: { react: "*" } }],
      ["@scope/pkg@<1.2.0 || 2.0.0", { dependencies: { left: "^1.0.0" } }],
    ]);
    expect(list.extend("@scope/pkg", parseVersion("1.1.0"), {}).dependencies).to.deep.equal({ left: "^1.0.0" });
    expect(list.extend("@scope/pkg", parseVersion("2.0.0"), {}).dependencies).to.deep.equal({ left: "^1.0.0" });
    expect(list.extend("@scope/pkg", parseVersion("1.5.0"), {}).dependencies).to.equal(undefined);
  });

  it("refuses a field it does not know rather than applying half a repair", () => {
    expect(() => toPackageExtensions([["pkg@*", { dependencies: {}, bin: {} }]])).to.throw(/unknown field 'bin'/);
  });

  it("refuses a selector with no range, and an invalid range", () => {
    expect(() => toPackageExtensions([["pkg", {}]])).to.throw(/not a name@range selector/);
    expect(() => toPackageExtensions([["pkg@latest", {}]])).to.throw(/invalid range/);
  });
});

describe("PackageExtensions.extend", () => {
  const list = extensions([
    ["reactcss@*", { peerDependencies: { react: "*" } }],
    ["widget@<2.0.0", { dependencies: { lodash: "^4.0.0" }, peerDependenciesMeta: { react: { optional: true } } }],
  ]);

  it("adds an undeclared peer, which the manifest reading makes an expected peer", () => {
    const decls = list.extend("reactcss", parseVersion("1.2.3"), { dependencies: { lodash: "^4.0.1" } });
    const { required } = declaredDependencies(decls);
    expect(required.map(req => [req.name, req.versionConstraint, req.provided])).to.deep.equal([
      ["lodash", "^4.0.1", undefined],
      ["react", "*", "expected"],
    ]);
  });

  it("leaves a manifest no repair selects untouched", () => {
    const decls = { dependencies: { a: "1.0.0" } };
    expect(list.extend("other", parseVersion("1.0.0"), decls)).to.equal(decls);
    expect(list.extend("widget", parseVersion("2.0.0"), decls)).to.equal(decls);
    expect(list.extend(undefined, parseVersion("1.0.0"), decls)).to.equal(decls);
  });

  it("never replaces what the manifest states, under any dependency field", () => {
    const own = list.extend("widget", parseVersion("1.0.0"), {
      dependencies: { lodash: "3.0.0" },
      peerDependencies: { react: ">=16" },
      peerDependenciesMeta: { react: { optional: false } },
    });
    expect(own.dependencies).to.deep.equal({ lodash: "3.0.0" });
    expect(own.peerDependenciesMeta).to.deep.equal({ react: { optional: false } });
    /* A peer the manifest already takes as a dependency is not added beside it. */
    const asDependency = list.extend("reactcss", parseVersion("1.0.0"), { dependencies: { react: "16.0.0" } });
    expect(asDependency.peerDependencies).to.deep.equal({});
    const asOptional = list.extend("widget", parseVersion("1.0.0"), { optionalDependencies: { lodash: "4.0.0" } });
    expect(asOptional.dependencies).to.deep.equal({});
  });

  it("marks a peer optional where the manifest gives it no metadata", () => {
    const decls = list.extend("widget", parseVersion("1.0.0"), { peerDependencies: { react: ">=16" } });
    expect(declaredDependencies(decls).required.find(req => req.name === "react")?.provided).to.equal("optional");
  });
});
