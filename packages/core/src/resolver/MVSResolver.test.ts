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

import { Computable } from "../core/Computable";
import { resolveMVS } from "./MVSResolver";
import { SEMVER, SemverVersion, versionToString } from "./Semver";
import { MetadataFetchError } from "../core/Errors";
import { PackageRegistry, Requirement, MVSResolution, Selected } from "./Types";
import { expect } from "chai";

/**
 * Mock registry over a literal { pkg: { version: { dep: constraint } } } table.
 */
function mockRegistry(data: Record<string, Record<string, Record<string, string>>>): PackageRegistry<SemverVersion> {
  return {
    getRequirements(pkg: string, version: SemverVersion): Computable<Requirement[]> {
      const deps = data[pkg]?.[versionToString(version)];
      if (deps === undefined) {
        throw new Error(`${pkg}@${versionToString(version)} not found in mock registry`);
      }
      return Computable.resolve(Object.entries(deps).map(([dep, constraint]) => ({ pkg: dep, constraint })));
    },
  };
}

function resolve(
  roots: Record<string, string>,
  data: Record<string, Record<string, Record<string, string>>>
): MVSResolution<SemverVersion> {
  let result: MVSResolution<SemverVersion> | undefined;
  resolveMVS(
    Object.entries(roots).map(([pkg, constraint]) => ({ pkg, constraint })),
    SEMVER,
    mockRegistry(data)
  ).then(resolution => {
    result = resolution;
  });
  /* The mock registry is synchronous, so resolution completes before we get here */
  expect(result).to.not.equal(undefined);
  return result!;
}

/** As resolve, but for inputs whose resolution walk must reject. */
function resolveError(roots: Record<string, string>, data: Record<string, Record<string, Record<string, string>>>): Error {
  let error: Error | undefined;
  resolveMVS(
    Object.entries(roots).map(([pkg, constraint]) => ({ pkg, constraint })),
    SEMVER,
    mockRegistry(data)
  ).then(
    () => undefined,
    err => {
      error = err as Error;
    }
  );
  expect(error).to.not.equal(undefined);
  return error!;
}

function selectionStrings(resolution: MVSResolution<SemverVersion>): string[] {
  return resolution.selections.map(sel => `${sel.pkg}@${versionToString(sel.version)}`);
}

describe("MVSResolver", () => {
  it("resolves a single package with no dependencies", () => {
    const result = resolve({ A: "1.2.3" }, { A: { "1.2.3": {} } });
    expect(selectionStrings(result)).to.deep.equal(["A@1.2.3"]);
    expect(result.errors).to.deep.equal([]);
  });

  it("resolves transitive dependencies", () => {
    const result = resolve(
      { A: "^1.0.0" },
      {
        A: { "1.0.0": { B: "^1.2.0" } },
        B: { "1.2.0": { C: "~2.1.0" } },
        C: { "2.1.0": {} },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["A@1.0.0", "B@1.2.0", "C@2.1.0"]);
    expect(result.errors).to.deep.equal([]);
  });

  it("selects the maximum of declared minimums (diamond)", () => {
    const result = resolve(
      { B: "^1.0.0", C: "^1.0.0" },
      {
        B: { "1.0.0": { D: "^1.1.0" } },
        C: { "1.0.0": { D: "^1.3.0" } },
        D: { "1.1.0": {}, "1.3.0": {} },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["B@1.0.0", "C@1.0.0", "D@1.3.0"]);
    expect(result.errors).to.deep.equal([]);
  });

  it("prunes packages only required by superseded versions", () => {
    /* B@1.0.0 (visited first) pulls in C, but the final selection B@1.2.0 does not */
    const result = resolve(
      { B: "^1.0.0", "B-upgrader": "1.0.0" },
      {
        B: { "1.0.0": { C: "^1.0.0" }, "1.2.0": {} },
        "B-upgrader": { "1.0.0": { B: "^1.2.0" } },
        C: { "1.0.0": {} },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["B@1.2.0", "B-upgrader@1.0.0"]);
    expect(result.errors).to.deep.equal([]);
  });

  it("attaches unconstrained requirements to the selected version", () => {
    const result = resolve(
      { A: "1.0.0" },
      {
        A: { "1.0.0": { B: "^1.2.0", C: "*" } },
        B: { "1.2.0": { C: "^2.0.0" } },
        C: { "2.0.0": {} },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["A@1.0.0", "B@1.2.0", "C@2.0.0"]);
    expect(result.errors).to.deep.equal([]);
  });

  it("resolves an unconstrained root against a sibling requirement", () => {
    const result = resolve(
      { A: "*", B: "1.0.0" },
      {
        A: { "1.1.0": {} },
        B: { "1.0.0": { A: "^1.1.0" } },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["A@1.1.0", "B@1.0.0"]);
    expect(result.errors).to.deep.equal([]);
    /* Both roots reach A */
    expect(result.selections.find(sel => sel.pkg === "A")?.reachableFrom).to.deep.equal([0, 1]);
  });

  it("reports unconstrained requirements that nothing selects", () => {
    const result = resolve(
      { A: "1.0.0" },
      {
        A: { "1.0.0": { B: "*" } },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["A@1.0.0"]);
    expect(result.errors).to.deep.equal([
      "'B' is required by A@1.0.0 without a version constraint ('*'), and no versioned requirement for it exists — add one explicitly",
    ]);
  });

  it("terminates on dependency cycles", () => {
    const result = resolve(
      { A: "^1.0.0" },
      {
        A: { "1.0.0": { B: "^1.0.0" } },
        B: { "1.0.0": { A: "^1.0.0" } },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["A@1.0.0", "B@1.0.0"]);
    expect(result.errors).to.deep.equal([]);
  });

  it("allows distinct major versions to coexist", () => {
    const result = resolve(
      { B: "^1.0.0", C: "^1.0.0" },
      {
        B: { "1.0.0": { D: "^1.0.0" } },
        C: { "1.0.0": { D: "^2.0.0" } },
        D: { "1.0.0": {}, "2.0.0": {} },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["B@1.0.0", "C@1.0.0", "D@1.0.0", "D@2.0.0"]);
    expect(result.errors).to.deep.equal([]);
  });

  it("reports upper bound violations without rejecting", () => {
    const result = resolve(
      { D: "~1.1.0", E: "1.0.0" },
      {
        D: { "1.1.0": {}, "1.3.0": {} },
        E: { "1.0.0": { D: "^1.3.0" } },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["D@1.3.0", "E@1.0.0"]);
    expect(result.errors).to.have.length(1);
    expect(result.errors[0]).to.contain("D@1.3.0");
    expect(result.errors[0]).to.contain("~1.1.0");
  });

  it("attributes a metadata failure on a root requirement to itself", () => {
    const err = resolveError({ A: "1.2.3" }, {});
    expect(err).to.be.instanceOf(MetadataFetchError);
    const failure = err as MetadataFetchError;
    expect(failure.pkg).to.equal("A");
    expect(failure.version).to.equal("1.2.3");
    expect(failure.rootPkg).to.equal("A");
    expect(failure.requirerPath).to.deep.equal([]);
    expect(failure.message).to.equal("A@1.2.3 not found in mock registry");
  });

  it("attributes a transitive metadata failure to the root requirement that reached it", () => {
    /* Scoped root: the node-id parse must split on the LAST '@' */
    const err = resolveError(
      { "@s/A": "1.0.0" },
      {
        "@s/A": { "1.0.0": { B: "^1.2.0" } },
        B: { "1.2.0": { C: "~2.1.0" } },
        /* C is unpublished */
      }
    );
    expect(err).to.be.instanceOf(MetadataFetchError);
    const failure = err as MetadataFetchError;
    expect(failure.pkg).to.equal("C");
    expect(failure.rootPkg).to.equal("@s/A");
    expect(failure.requirerPath).to.deep.equal(["B@1.2.0", "@s/A@1.0.0"]);
    expect(failure.message).to.equal("C@2.1.0 not found in mock registry (required by B@1.2.0 < @s/A@1.0.0)");
  });

  it("a root override dominates transitive requirements", () => {
    const result = resolve(
      { B: "^1.0.0", D: "1.4.0" },
      {
        B: { "1.0.0": { D: "^1.1.0" } },
        D: { "1.1.0": {}, "1.4.0": {} },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["B@1.0.0", "D@1.4.0"]);
    expect(result.errors).to.deep.equal([]);
  });

  it("reports unparseable constraints as errors", () => {
    const result = resolve(
      { A: "^1.0.0" },
      {
        A: { "1.0.0": { B: "1.0.0 - 2.0.0" } },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["A@1.0.0"]);
    expect(result.errors).to.have.length(1);
    expect(result.errors[0]).to.contain("A@1.0.0");
  });

  it("resolves an empty root set", () => {
    const result = resolve({}, {});
    expect(selectionStrings(result)).to.deep.equal([]);
    expect(result.errors).to.deep.equal([]);
  });

  it("records which roots reach each selection", () => {
    const result = resolve(
      { B: "^1.0.0", C: "^1.0.0" },
      {
        B: { "1.0.0": { D: "^1.0.0" } },
        C: { "1.0.0": {} },
        D: { "1.0.0": {} },
      }
    );
    const get = (pkg: string): Selected<SemverVersion> => result.selections.find(sel => sel.pkg === pkg)!;
    expect(get("B").reachableFrom).to.deep.equal([0]);
    expect(get("C").reachableFrom).to.deep.equal([1]);
    expect(get("D").reachableFrom).to.deep.equal([0]);
  });

  it("records multiple reaching roots through a diamond", () => {
    const result = resolve(
      { B: "^1.0.0", C: "^1.0.0" },
      {
        B: { "1.0.0": { D: "^1.1.0" } },
        C: { "1.0.0": { D: "^1.3.0" } },
        D: { "1.1.0": {}, "1.3.0": {} },
      }
    );
    const d = result.selections.find(sel => sel.pkg === "D")!;
    expect(d.reachableFrom?.slice().sort()).to.deep.equal([0, 1]);
  });

  it("records why each selection was reached and which requirement won", () => {
    const result = resolve(
      { B: "^1.0.0", C: "^1.0.0" },
      {
        B: { "1.0.0": { D: "^1.1.0" } },
        C: { "1.0.0": { D: "^1.3.0" } },
        D: { "1.1.0": {}, "1.3.0": {} },
      }
    );
    const b = result.selections.find(sel => sel.pkg === "B")!;
    expect(b.reachedVia).to.deep.equal({ requiredBy: "(root)", constraint: "^1.0.0" });
    expect(b.selectedBy).to.deep.equal({ requiredBy: "(root)", constraint: "^1.0.0" });

    /* D is first reached through B, but its version was raised by C's requirement */
    const d = result.selections.find(sel => sel.pkg === "D")!;
    expect(d.reachedVia).to.deep.equal({ requiredBy: "B@1.0.0", constraint: "^1.1.0" });
    expect(d.selectedBy).to.deep.equal({ requiredBy: "C@1.0.0", constraint: "^1.3.0" });
  });

  it("keeps a version raised by a superseded requirement, and says so", () => {
    /* A@1.0.0 raises D to 1.5.0 before A itself is upgraded to 1.2.0, which only
     * needs D ^1.1.0; per MVS the raised version stands, and selectedBy records
     * the (now unselected) node that raised it. */
    const result = resolve(
      { A: "^1.0.0", AUP: "1.0.0" },
      {
        A: { "1.0.0": { D: "^1.5.0" }, "1.2.0": { D: "^1.1.0" } },
        AUP: { "1.0.0": { A: "^1.2.0" } },
        D: { "1.1.0": {}, "1.5.0": {} },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["A@1.2.0", "AUP@1.0.0", "D@1.5.0"]);
    const d = result.selections.find(sel => sel.pkg === "D")!;
    expect(d.selectedBy).to.deep.equal({ requiredBy: "A@1.0.0", constraint: "^1.5.0" });
    expect(d.reachedVia).to.deep.equal({ requiredBy: "A@1.2.0", constraint: "^1.1.0" });
    /* The winning node is not among the final selections */
    expect(selectionStrings(result)).to.not.contain("A@1.0.0");
  });
});
