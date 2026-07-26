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
import { RepairableResolution, resolveMVS, resolveWithRepairs } from "./MVSResolver";
import { parseVersion, SEMVER, SemverVersion, versionToString } from "./Semver";
import { MetadataFetchError, VersionNotFoundError } from "../core/Errors";
import { PackageRegistry, Requirement, MVSResolution, Selected } from "./Types";
import { expect } from "chai";

/**
 * Mock registry over a literal { pkg: { version: { dep: constraint } } } table.
 * The versions present in the table ARE the published set; passing `raisable`
 * additionally enables the floor-raise hook (lowestAvailable) over that set —
 * without it an unpublished version stays a hard failure, as for a registry
 * without the hook.
 */
function mockRegistry(data: Record<string, Record<string, Record<string, string>>>, raisable = false): PackageRegistry<SemverVersion> {
  const registry: PackageRegistry<SemverVersion> = {
    getRequirements(pkg: string, version: SemverVersion): Computable<Requirement[]> {
      const deps = data[pkg]?.[versionToString(version)];
      if (deps === undefined) {
        throw new VersionNotFoundError(pkg, versionToString(version), `${pkg}@${versionToString(version)} not found in mock registry`);
      }
      return Computable.resolve(
        Object.entries(deps).map(([dep, constraint]) =>
          constraint.startsWith("peer ") ? { pkg: dep, constraint: constraint.substring(5), soft: true } : { pkg: dep, constraint }
        )
      );
    },
  };
  if (raisable) {
    registry.lowestAvailable = (pkg: string, constraint: string): Computable<SemverVersion | undefined> => {
      const parsed = SEMVER.parseConstraint(constraint);
      const satisfying = Object.keys(data[pkg] ?? {})
        .map(parseVersion)
        .filter(version => SEMVER.satisfies(version, parsed))
        .sort(SEMVER.compare);
      return Computable.resolve(satisfying[0]);
    };
  }
  return registry;
}

function resolve(
  roots: Record<string, string>,
  data: Record<string, Record<string, Record<string, string>>>,
  raisable = false
): MVSResolution<SemverVersion> {
  let result: MVSResolution<SemverVersion> | undefined;
  resolveMVS(
    Object.entries(roots).map(([pkg, constraint]) => ({ pkg, constraint })),
    SEMVER,
    mockRegistry(data, raisable)
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
      {
        message:
          "'B' is required by A@1.0.0 without a version constraint ('*'), and no versioned requirement for it exists — add one explicitly",
        rootPkg: "A",
      },
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

  it("reports upper bound violations as data without rejecting", () => {
    const result = resolve(
      { D: "~1.1.0", E: "1.0.0" },
      {
        D: { "1.1.0": {}, "1.3.0": {} },
        E: { "1.0.0": { D: "^1.3.0" } },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["D@1.3.0", "E@1.0.0"]);
    expect(result.errors).to.deep.equal([]);
    expect(result.violations).to.have.lengthOf(1);
    expect(result.violations[0].pkg).to.equal("D");
    expect(result.violations[0].constraint).to.equal("~1.1.0");
    expect(result.violations[0].requiredBy).to.equal("(root)");
    expect(versionToString(result.violations[0].selected)).to.equal("1.3.0");
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
    /* (Hyphen ranges used to be the specimen here; they parse now, so the
     * unparseable case is a protocol-prefixed constraint.) */
    const result = resolve(
      { A: "^1.0.0" },
      {
        A: { "1.0.0": { B: "workspace:*" } },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["A@1.0.0"]);
    expect(result.errors).to.have.length(1);
    /* The diagnostic names the dependency the bad constraint is on, quotes the
     * constraint verbatim, attributes the requirer, and carries the root whose
     * subtree contains it (for written-reference attribution). */
    expect(result.errors[0].message).to.contain("'B: workspace:*'");
    expect(result.errors[0].message).to.contain("required by A@1.0.0");
    expect(result.errors[0].rootPkg).to.equal("A");
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

  it("raises an unpublished floor to the lowest published satisfying version", () => {
    /* B's declared floor ^1.0.0 → 1.0.0 was never published (DefinitelyTyped-style);
     * with the raise hook, the lowest published satisfying version is selected. */
    const result = resolve(
      { A: "1.0.0" },
      {
        A: { "1.0.0": { B: "^1.0.0" } },
        B: { "1.6.0": {}, "1.7.0": {} },
      },
      true
    );
    expect(selectionStrings(result)).to.deep.equal(["A@1.0.0", "B@1.6.0"]);
    expect(result.errors).to.deep.equal([]);
    expect(result.raises).to.have.lengthOf(1);
    expect(result.raises[0].pkg).to.equal("B");
    expect(result.raises[0].constraint).to.equal("^1.0.0");
    expect(versionToString(result.raises[0].declared)).to.equal("1.0.0");
    expect(versionToString(result.raises[0].raised)).to.equal("1.6.0");
    expect(result.raises[0].requiredBy).to.equal("A@1.0.0");
  });

  it("drops a raise superseded by a higher requirement's floor", () => {
    /* A's broken floor raises B to 1.6.0, but C's published floor 1.7.0 wins the
     * key — the raise never shaped the result, so it is not reported. */
    const result = resolve(
      { A: "1.0.0", C: "1.0.0" },
      {
        A: { "1.0.0": { B: "^1.0.0" } },
        C: { "1.0.0": { B: "^1.7.0" } },
        B: { "1.6.0": {}, "1.7.0": {} },
      },
      true
    );
    expect(selectionStrings(result)).to.deep.equal(["A@1.0.0", "B@1.7.0", "C@1.0.0"]);
    expect(result.raises).to.deep.equal([]);
  });

  it("tolerates a transient unpublished floor that a later declared floor supersedes", () => {
    /* A@1.0.0's floor ~2.0.5 was never published and NOTHING published
     * satisfies ~2.0.5 — but the root's ^2.6.0 supersedes it within the key,
     * so a repair-free resolution exists and repairs must not fire. (Before
     * the two-phase split, the eager probe of 2.0.5 hard-failed the whole
     * resolution whenever it was visited first — a walk-order dependence.) */
    const result = resolve(
      { A: "1.0.0", C: "^2.6.0" },
      {
        A: { "1.0.0": { C: "~2.0.5" } },
        C: { "2.6.0": {} },
      },
      true
    );
    expect(selectionStrings(result)).to.deep.equal(["A@1.0.0", "C@2.6.0"]);
    expect(result.raises).to.deep.equal([]);
    expect(result.errors).to.deep.equal([]);
  });

  it("without the hook, a transient unpublished floor is tolerated too", () => {
    const result = resolve(
      { A: "1.0.0", C: "^2.6.0" },
      {
        A: { "1.0.0": { C: "~2.0.5" } },
        C: { "2.6.0": {} },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["A@1.0.0", "C@2.6.0"]);
  });

  it("a soft (peer) requirement attaches to a satisfying selection across majors", () => {
    /* chai-as-promised peers on chai '>= 2.1.2 < 5' while the tree already
     * selects chai@4: attach-first semantics must satisfy the peer against the
     * existing selection, not key the range's floor into a coexisting chai@2
     * (whose own deps would then walk and conflict). */
    const result = resolve(
      { A: "1.0.0" },
      {
        A: { "1.0.0": { chai: "^4.2.0", plugin: "1.0.0" } },
        plugin: { "1.0.0": { chai: "peer >=2.1.2 <5" } },
        chai: { "4.2.0": {}, "2.1.2": { "assertion-error": "1.0.0" } },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["A@1.0.0", "chai@4.2.0", "plugin@1.0.0"]);
    expect(result.violations).to.deep.equal([]);
    expect(result.errors).to.deep.equal([]);
  });

  it("a soft requirement whose package nothing selects fires as an ordinary demand", () => {
    /* The R6 crash shape: a plugin consumed alone must get its peer in the
     * closure (npm's auto-install as last resort), at the range's minimum. */
    const result = resolve(
      { plugin: "1.0.0" },
      {
        plugin: { "1.0.0": { eslint: "peer ^9.0.0" } },
        eslint: { "9.0.0": {} },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["eslint@9.0.0", "plugin@1.0.0"]);
    expect(result.violations).to.deep.equal([]);
  });

  it("an unsatisfiable soft requirement reports a violation against the delivered version", () => {
    const result = resolve(
      { A: "1.0.0" },
      {
        A: { "1.0.0": { chai: "^5.0.0", plugin: "1.0.0" } },
        plugin: { "1.0.0": { chai: "peer <5" } },
        chai: { "5.0.0": {} },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["A@1.0.0", "chai@5.0.0", "plugin@1.0.0"]);
    expect(result.violations).to.have.lengthOf(1);
    expect(result.violations[0].pkg).to.equal("chai");
    expect(result.violations[0].constraint).to.equal("<5");
    expect(result.violations[0].requiredBy).to.equal("plugin@1.0.0");
  });

  it("repairs only when the converged tree needs it (a transient floor never fires)", () => {
    /* D's floor genuinely needs a raise (nothing supersedes it) — that alone
     * triggers the repair phase. A's transient ~2.0.5 floor, superseded by the
     * root's ^2.6.0, contributes nothing to the result even though the repair
     * phase probes eagerly (its candidate is dropped at finish: 2.6.0 won). */
    const result = resolve(
      { A: "1.0.0", C: "^2.6.0", D: "^1.0.0" },
      {
        A: { "1.0.0": { C: "~2.0.5" } },
        C: { "2.0.9": {}, "2.6.0": {} },
        D: { "1.0.1": {} },
      },
      true
    );
    expect(selectionStrings(result)).to.deep.equal(["A@1.0.0", "C@2.6.0", "D@1.0.1"]);
    expect(result.raises).to.have.lengthOf(1);
    expect(result.raises[0].pkg).to.equal("D");
    expect(versionToString(result.raises[0].raised)).to.equal("1.0.1");
  });

  it("fails when nothing published satisfies an unpublished floor", () => {
    let error: Error | undefined;
    resolveMVS([{ pkg: "A", constraint: "1.0.0" }], SEMVER, mockRegistry({ A: { "1.0.0": { B: "^2.0.0" } }, B: { "1.6.0": {} } }, true)).then(
      () => undefined,
      err => {
        error = err as Error;
      }
    );
    expect(error).to.be.instanceOf(MetadataFetchError);
    expect((error as MetadataFetchError).pkg).to.equal("B");
  });

  it("without the raise hook an unpublished floor stays a hard failure", () => {
    const err = resolveError(
      { A: "1.0.0" },
      {
        A: { "1.0.0": { B: "^1.0.0" } },
        B: { "1.6.0": {} },
      }
    );
    expect(err).to.be.instanceOf(MetadataFetchError);
    expect((err as MetadataFetchError).pkg).to.equal("B");
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

describe("resolveWithRepairs", () => {
  function repair(
    roots: Record<string, string>,
    data: Record<string, Record<string, Record<string, string>>>
  ): RepairableResolution<SemverVersion> {
    let result: RepairableResolution<SemverVersion> | undefined;
    resolveWithRepairs(
      Object.entries(roots).map(([pkg, constraint]) => ({ pkg, constraint })),
      SEMVER,
      mockRegistry(data, true)
    ).then(resolution => {
      result = resolution;
    });
    expect(result).to.not.equal(undefined);
    return result!;
  }

  it("gives a violated exact pin a private split subtree", () => {
    /* The mdn-data shape: X exact-pins M@2.0.28, Y floors it at 2.12.2 — same
     * major, jointly unsatisfiable. The violated edge gets its own standalone
     * subtree pinned at exactly 2.0.28. */
    const result = repair(
      { X: "1.0.0", Y: "1.0.0" },
      {
        X: { "1.0.0": { M: "2.0.28" } },
        Y: { "1.0.0": { M: "^2.12.2" } },
        M: { "2.0.28": {}, "2.12.2": {} },
      }
    );
    expect(selectionStrings(result.tree)).to.deep.equal(["M@2.12.2", "X@1.0.0", "Y@1.0.0"]);
    expect(result.tree.violations).to.have.lengthOf(1);
    expect(result.splits).to.have.lengthOf(1);
    expect(result.splits[0].pkg).to.equal("M");
    expect(result.splits[0].constraint).to.equal("2.0.28");
    expect(selectionStrings(result.splits[0].tree)).to.deep.equal(["M@2.0.28"]);
  });

  it("deduplicates identical violated edges and splits recursively", () => {
    /* A and B pin the same (P, 1.0.0) — one split; inside that split P@1.0.0's
     * own tree violates (Q, 1.0.0) — a second, nested split. */
    const result = repair(
      { A: "1.0.0", B: "1.0.0", C: "1.0.0" },
      {
        A: { "1.0.0": { P: "1.0.0" } },
        B: { "1.0.0": { P: "1.0.0" } },
        C: { "1.0.0": { P: "^1.5.0" } },
        P: { "1.0.0": { Q: "1.0.0", R: "^1.0.0" }, "1.5.0": {} },
        Q: { "1.0.0": {}, "1.2.0": {} },
        R: { "1.0.0": { Q: "^1.2.0" } },
      }
    );
    expect(result.splits.map(split => `${split.pkg}@${split.constraint}`).sort()).to.deep.equal(["P@1.0.0", "Q@1.0.0"]);
    const p = result.splits.find(split => split.pkg === "P")!;
    expect(selectionStrings(p.tree)).to.deep.equal(["P@1.0.0", "Q@1.2.0", "R@1.0.0"]);
    /* P's subtree still lists its own violation, mapped to the Q split */
    expect(p.tree.violations).to.have.lengthOf(1);
    const q = result.splits.find(split => split.pkg === "Q")!;
    expect(selectionStrings(q.tree)).to.deep.equal(["Q@1.0.0"]);
  });

  it("returns no splits for a violation-free tree", () => {
    const result = repair(
      { A: "1.0.0" },
      {
        A: { "1.0.0": { B: "^1.2.0" } },
        B: { "1.2.0": {} },
      }
    );
    expect(result.splits).to.deep.equal([]);
    expect(result.tree.violations).to.deep.equal([]);
  });
});
