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
import { edgeBinding, nodeId, reachableFrom } from "./ResolutionGraph";
import { parseVersion, SEMVER, SemverVersion, versionToString } from "./Semver";
import { MetadataFetchError, VersionNotFoundError } from "../core/Errors";
import { RequirementSource, Requirement, MVSResolution, Selected } from "./Types";
import { expect } from "chai";

/**
 * Mock registry over a literal { pkg: { version: { dep: constraint } } } table.
 * The versions present in the table ARE the published set; passing `raisable`
 * additionally enables the floor-raise hook (lowestAvailable) over that set —
 * without it an unpublished version stays a hard failure, as for a registry
 * without the hook.
 */
function mockRegistry(data: Record<string, Record<string, Record<string, string>>>, raisable = false): RequirementSource<SemverVersion> {
  const registry: RequirementSource<SemverVersion> = {
    getRequirements(pkg: string, version: SemverVersion): Computable<Requirement[]> {
      const deps = data[pkg]?.[versionToString(version)];
      if (deps === undefined) {
        throw new VersionNotFoundError(pkg, versionToString(version), `${pkg}@${versionToString(version)} not found in mock registry`);
      }
      return Computable.resolve(
        Object.entries(deps).map(([dep, constraint]) => {
          /* 'peer? ' is npm's `peerDependenciesMeta: { optional: true }`. */
          if (constraint.startsWith("peer? ")) {
            return { pkg: dep, constraint: constraint.substring(6), soft: true, attachOnly: true };
          }
          return constraint.startsWith("peer ") ? { pkg: dep, constraint: constraint.substring(5), soft: true } : { pkg: dep, constraint };
        })
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

/** Root requirements from the test's shorthand: a trailing '!' marks a force
 * override, a trailing '?' an alternate (the resolver's override inputs;
 * parsing markers off written references is the repository's job). */
function rootRequirements(roots: Record<string, string>): Requirement[] {
  return Object.entries(roots).map(([pkg, constraint]) => {
    if (constraint.endsWith("!")) {
      return { pkg, constraint: constraint.slice(0, -1), override: "force" as const };
    }
    if (constraint.endsWith("?")) {
      return { pkg, constraint: constraint.slice(0, -1), override: "alternate" as const };
    }
    return { pkg, constraint };
  });
}

function resolve(
  roots: Record<string, string>,
  data: Record<string, Record<string, Record<string, string>>>,
  raisable = false
): MVSResolution<SemverVersion> {
  let result: MVSResolution<SemverVersion> | undefined;
  resolveMVS(rootRequirements(roots), SEMVER, mockRegistry(data, raisable)).then(resolution => {
    result = resolution;
  });
  /* The mock registry is synchronous, so resolution completes before we get here */
  expect(result).to.not.equal(undefined);
  return result!;
}

/**
 * As mockRegistry, but every metadata answer is *deferred*: requests queue up
 * and are delivered by the caller, so a test can drive the walk through any
 * arrival order. `pick` chooses the index of the next pending request to
 * answer (delivering one may enqueue more).
 */
function deferredRegistry(
  data: Record<string, Record<string, Record<string, string>>>,
  pick: (pending: string[]) => number,
  raisable: boolean
): { registry: RequirementSource<SemverVersion>; drain: () => void } {
  const base = mockRegistry(data, raisable);
  const queue: Array<{ key: string; deliver: () => void }> = [];
  const registry: RequirementSource<SemverVersion> = {
    getRequirements(pkg: string, version: SemverVersion): Computable<Requirement[]> {
      return Computable.from((resolve, reject) => {
        const deliver = (): void => {
          try {
            base.getRequirements(pkg, version).then(resolve, reject);
          } catch (err) {
            reject(err as Error);
          }
        };
        queue.push({ key: `${pkg}@${versionToString(version)}`, deliver });
      });
    },
    lowestAvailable: base.lowestAvailable,
  };
  const drain = (): void => {
    while (queue.length > 0) {
      queue.splice(pick(queue.map(entry => entry.key)), 1)[0].deliver();
    }
  };
  return { registry, drain };
}

/**
 * Resolve under two opposite metadata-arrival orders (answer the oldest
 * outstanding request first, versus the newest) and assert the results are
 * identical — the property MVS owes its caller, since the result is persisted
 * in the build cache and a cache flush must not be able to change a build.
 */
function resolveOrderIndependent(
  roots: Record<string, string>,
  data: Record<string, Record<string, Record<string, string>>>,
  raisable = false
): MVSResolution<SemverVersion> {
  const under = (pick: (pending: string[]) => number): MVSResolution<SemverVersion> => {
    const { registry, drain } = deferredRegistry(data, pick, raisable);
    let result: MVSResolution<SemverVersion> | undefined;
    resolveMVS(rootRequirements(roots), SEMVER, registry).then(resolution => {
      result = resolution;
    });
    drain();
    expect(result).to.not.equal(undefined);
    return result!;
  };
  const oldestFirst = under(() => 0);
  const newestFirst = under(pending => pending.length - 1);
  expect(JSON.stringify(newestFirst)).to.equal(JSON.stringify(oldestFirst));
  return oldestFirst;
}

/** As resolve, but for inputs whose resolution walk must reject. */
function resolveError(
  roots: Record<string, string>,
  data: Record<string, Record<string, Record<string, string>>>,
  raisable = false
): Error {
  let error: Error | undefined;
  resolveMVS(rootRequirements(roots), SEMVER, mockRegistry(data, raisable)).then(
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

  it("reports floorless requirements that nothing selects", () => {
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
          "'B' is required by A@1.0.0 without a version lower bound ('*'), and no versioned requirement for it exists — add one explicitly",
        rootPkg: "A",
        pkg: "B",
        requiredBy: "A@1.0.0",
      },
    ]);
  });

  it("an upper-bound-only requirement contributes no demand and is answered by a pin", () => {
    /* @google-cloud/storage requires promisify '<4.1.0': the 0.0.0 floor is a
     * fabrication of the grammar, so it must neither be demanded (the
     * unpublished 0.0.0 would 404) nor seed a phantom 0.0 coexistence slot
     * that a root pin can never dislodge — the pin answers the request. */
    const result = resolve(
      { A: "1.0.0", B: "4.0.0" },
      {
        A: { "1.0.0": { B: "<4.1.0" } },
        B: { "4.0.0": {} },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["A@1.0.0", "B@4.0.0"]);
    expect(result.errors).to.deep.equal([]);
    expect(result.violations).to.deep.equal([]);
  });

  it("an upper-bound-only requirement's cap is still violation-checked", () => {
    const result = resolve(
      { A: "1.0.0", B: "5.0.0" },
      {
        A: { "1.0.0": { B: "<4.1.0" } },
        B: { "5.0.0": {} },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["A@1.0.0", "B@5.0.0"]);
    expect(result.violations).to.have.lengthOf(1);
    expect(result.violations[0].pkg).to.equal("B");
    expect(result.violations[0].constraint).to.equal("<4.1.0");
  });

  it("an upper-bound-only requirement nothing selects is the ordinary add-a-pin error", () => {
    const result = resolve({ A: "1.0.0" }, { A: { "1.0.0": { B: "<4.1.0" } } });
    expect(result.errors).to.have.lengthOf(1);
    expect(result.errors[0].pkg).to.equal("B");
    expect(result.errors[0].message).to.contain("without a version lower bound ('<4.1.0')");
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

  it("forks a package whose demanded majors are jointly unsatisfiable", () => {
    /* One selection per name: D@2.0.0 is the principal (max of floors), and
     * B's ^1.0.0 — which no version satisfying ^2.0.0 can satisfy — is a
     * violation, repaired by a D@1.0.0 fork a sealed delivery nests. */
    const result = resolve(
      { B: "^1.0.0", C: "^1.0.0" },
      {
        B: { "1.0.0": { D: "^1.0.0" } },
        C: { "1.0.0": { D: "^2.0.0" } },
        D: { "1.0.0": {}, "2.0.0": {} },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["B@1.0.0", "C@1.0.0", "D@1.0.0", "D@2.0.0"]);
    const [d1, d2] = result.selections.filter(sel => sel.pkg === "D");
    expect(d1.fork).to.equal(1);
    expect(d2.fork).to.be.undefined;
    expect(result.violations).to.have.lengthOf(1);
    expect(result.violations[0].requiredBy).to.equal("B@1.0.0");
    expect(versionToString(result.violations[0].selected)).to.equal("2.0.0");
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
    /* The violated root edge is repaired by the D@1.1.0 fork; the violation
     * itself — judged against the principal, what a flat delivery ships —
     * remains the recorded fact a strict consumer errors on. */
    expect(selectionStrings(result)).to.deep.equal(["D@1.1.0", "D@1.3.0", "E@1.0.0"]);
    expect(result.selections[0].fork).to.equal(1);
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

  it("an optional peer binds what the tree provides", () => {
    /* zustand's shape: `peerDependencies: {react}` with
     * `peerDependenciesMeta: {react: {optional: true}}` and no dependencies of
     * its own. A hoisted tree let it reach the hoisted react by walking up; a
     * dependency table has to record the edge or the import resolves to
     * nothing. */
    const result = resolve(
      { app: "1.0.0" },
      {
        app: { "1.0.0": { zustand: "3.7.1", react: "18.0.0" } },
        zustand: { "3.7.1": { react: "peer? >=16.8" } },
        react: { "18.0.0": {} },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["app@1.0.0", "react@18.0.0", "zustand@3.7.1"]);
    expect([...(result.edges.get("zustand@3.7.1") ?? [])]).to.deep.equal([["react", "react@18.0.0"]]);
    expect(result.errors).to.deep.equal([]);
  });

  it("an optional peer nothing provides installs nothing and reports nothing", () => {
    /* The other half of npm's contract, and the reason it cannot simply be a
     * soft requirement: a soft one installs its minimum as a last resort, an
     * optional peer installs nothing at all. */
    const result = resolve(
      { app: "1.0.0" },
      {
        app: { "1.0.0": { zustand: "3.7.1" } },
        zustand: { "3.7.1": { react: "peer? >=16.8" } },
        react: { "18.0.0": {} },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["app@1.0.0", "zustand@3.7.1"]);
    expect([...(result.edges.get("zustand@3.7.1") ?? [])]).to.deep.equal([]);
    expect(result.errors).to.deep.equal([]);
    expect(result.violations).to.deep.equal([]);
  });

  it("an optional peer attaches to what is delivered and resurrects nothing", () => {
    /* The dylan regression. A selection can exist without being delivered — here
     * `stale` is demanded by A@1.0.0, which loses to A@2.0.0 and is pruned with
     * its subtree. An optional peer must attach to what the tree DELIVERS, so
     * binding one must not drag such a selection back in: doing so installs a
     * package npm never would, and walks metadata nothing needs (the real one
     * carried a `git+https://` spec no semver domain can parse). */
    const result = resolve(
      { app: "1.0.0" },
      {
        app: { "1.0.0": { A: "^2.0.0", B: "1.0.0", P: "1.0.0" } },
        B: { "1.0.0": { A: ">=1.0.0" } },
        A: { "1.0.0": { stale: "1.0.0" }, "2.0.0": {} },
        stale: { "1.0.0": {} },
        P: { "1.0.0": { stale: "peer? >=1" } },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["A@2.0.0", "B@1.0.0", "P@1.0.0", "app@1.0.0"]);
    expect([...(result.edges.get("P@1.0.0") ?? [])]).to.deep.equal([]);
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

  it("repairs the principal only when the converged tree needs it", () => {
    /* D's floor genuinely needs a raise (nothing supersedes it) — that alone
     * triggers the principal repair phase, and it must not move C's principal
     * (the root's ^2.6.0 wins; A's superseded ~2.0.5 floor contributes
     * nothing to it). A's violated edge is separately repaired by a fork,
     * whose own unpublished floor raises to the lowest published satisfier —
     * fork repairs need no arming, the converged violation is their proof. */
    const result = resolve(
      { A: "1.0.0", C: "^2.6.0", D: "^1.0.0" },
      {
        A: { "1.0.0": { C: "~2.0.5" } },
        C: { "2.0.9": {}, "2.6.0": {} },
        D: { "1.0.1": {} },
      },
      true
    );
    expect(selectionStrings(result)).to.deep.equal(["A@1.0.0", "C@2.0.9", "C@2.6.0", "D@1.0.1"]);
    const cs = result.selections.filter(sel => sel.pkg === "C");
    expect(cs[0].fork).to.equal(1);
    expect(cs[1].fork).to.be.undefined;
    expect(result.raises.map(raise => `${raise.pkg}@${versionToString(raise.raised)}`)).to.deep.equal(["C@2.0.9", "D@1.0.1"]);
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

  it("raises an unpublished floor across majors to the first published satisfier", () => {
    /* A requires B '>=1.2.3'; 1.2.3 was never published and the only published
     * satisfier is 2.0.0 — a different major from the floor's. The request was
     * for '>=1.2.3', and the first published version meeting it is an
     * acceptable answer: the raise re-offers it through the normal max rule,
     * the phantom serves no edge, and the edge binds by satisfaction — B does
     * not vanish from the closure. */
    const result = resolve({ A: "1.0.0" }, { A: { "1.0.0": { B: ">=1.2.3" } }, B: { "2.0.0": {} } }, true);
    expect(selectionStrings(result)).to.deep.equal(["A@1.0.0", "B@2.0.0"]);
    expect(result.errors).to.deep.equal([]);
    expect(result.violations).to.deep.equal([]);
    expect(result.raises).to.have.lengthOf(1);
    expect(result.raises[0].pkg).to.equal("B");
    expect(versionToString(result.raises[0].declared)).to.equal("1.2.3");
    expect(versionToString(result.raises[0].raised)).to.equal("2.0.0");
  });

  it("a 0.x cross-minor raise lands too, and a same-range raise is unchanged", () => {
    /* C's floor 0.5.0 is unpublished; the lowest published satisfier within
     * '>=0.5.0' is 0.6.0 — a different 0.x minor (a different caret
     * compatibility unit), crossed on the same terms as a major. */
    const crossed = resolve({ A: "1.0.0" }, { A: { "1.0.0": { C: ">=0.5.0" } }, C: { "0.6.0": {} } }, true);
    expect(selectionStrings(crossed)).to.deep.equal(["A@1.0.0", "C@0.6.0"]);
    expect(crossed.raises).to.have.lengthOf(1);

    const result = resolve({ A: "1.0.0" }, { A: { "1.0.0": { D: "^1.0.0" } }, D: { "1.0.1": {} } }, true);
    expect(selectionStrings(result)).to.deep.equal(["A@1.0.0", "D@1.0.1"]);
    expect(result.raises).to.have.lengthOf(1);
  });

  it("an existing satisfying selection answers an unpublished floor without any raise", () => {
    /* nise requires fake-timers '>=5' whose 5.x line was never published, and
     * the tree already pins fake-timers 11.2.2 — which satisfies '>=5'. The
     * pin answers the request outright: no repair phase, no registry
     * version-list read (the registry here has no raise hook at all), fully
     * deterministic. */
    const result = resolve(
      { A: "1.0.0", B: "11.2.2" },
      {
        A: { "1.0.0": { B: ">=5" } },
        B: { "11.2.2": {} },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["A@1.0.0", "B@11.2.2"]);
    expect(result.errors).to.deep.equal([]);
    expect(result.violations).to.deep.equal([]);
    expect(result.raises).to.deep.equal([]);
  });

  it("attributes a failure of the raise hook itself to the node that provoked it", () => {
    /* The hook is only consulted for an unpublished floor, so its own failure
     * (an unreachable registry, a package the registry has never heard of)
     * belongs to the same requirement chain as the 404 that provoked it — not
     * bare against whatever target was being built. */
    const registry = mockRegistry({ A: { "1.0.0": { B: "^2.0.0" } }, B: { "1.6.0": {} } }, true);
    registry.lowestAvailable = (): Computable<SemverVersion | undefined> => Computable.reject(new Error("registry unreachable"));
    let error: Error | undefined;
    resolveMVS([{ pkg: "A", constraint: "1.0.0" }], SEMVER, registry).then(
      () => undefined,
      err => {
        error = err as Error;
      }
    );
    expect(error).to.be.instanceOf(MetadataFetchError);
    const failure = error as MetadataFetchError;
    expect(failure.pkg).to.equal("B");
    expect(failure.rootPkg).to.equal("A");
    expect(failure.message).to.equal("registry unreachable (required by A@1.0.0)");
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

  it("expands a demanded version that loses its slot, whatever the arrival order", () => {
    /* P and Q demand different minors of B; the two B versions declare
     * different C floors. Under Go's MVS the module graph holds every demanded
     * version, so B@1.0.0's C floor counts even though B@1.2.0 supersedes it —
     * C is 1.5.0 either way. (Expanding only *improving* versions made this a
     * coin toss on which packument landed first, and the answer is persisted in
     * the resolution memo, so a cache flush could change the build.) */
    const result = resolveOrderIndependent(
      { P: "1.0.0", Q: "1.0.0" },
      {
        P: { "1.0.0": { B: "^1.0.0" } },
        Q: { "1.0.0": { B: "^1.2.0" } },
        B: { "1.0.0": { C: "^1.5.0" }, "1.2.0": { C: "^1.0.0" } },
        C: { "1.0.0": {}, "1.5.0": {} },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["B@1.2.0", "C@1.5.0", "P@1.0.0", "Q@1.0.0"]);
    expect(result.errors).to.deep.equal([]);
  });

  it("forks and re-judges in a canonical order, whatever the arrival order", () => {
    /* B's violated edge forks D@1.0.0, whose own exact pin on G then violates
     * and forks in turn — a fork's subtree is judged in the same graph, and
     * `violations`, fork indices and `reachedVia` are all persisted, so every
     * round's order must come from the converged tree, not from which
     * packument landed first. E's floorless edge binds the principal only. */
    const result = resolveOrderIndependent(
      { E: "1.0.0", B: "^1.0.0", C: "^1.0.0", G: "1.5.0", H: "1.5.0" },
      {
        E: { "1.0.0": { D: "*" } },
        B: { "1.0.0": { D: "^1.0.0" } },
        C: { "1.0.0": { D: "^2.0.0" } },
        D: { "1.0.0": { G: "1.0.0" }, "2.0.0": { H: "1.0.0" } },
        G: { "1.0.0": {}, "1.5.0": {} },
        H: { "1.0.0": {}, "1.5.0": {} },
      }
    );
    expect(selectionStrings(result)).to.deep.equal([
      "B@1.0.0",
      "C@1.0.0",
      "D@1.0.0",
      "D@2.0.0",
      "E@1.0.0",
      "G@1.0.0",
      "G@1.5.0",
      "H@1.0.0",
      "H@1.5.0",
    ]);
    const forks = result.selections.filter(sel => sel.fork !== undefined);
    expect(forks.map(sel => `${sel.pkg}@${versionToString(sel.version)}`)).to.deep.equal(["D@1.0.0", "G@1.0.0", "H@1.0.0"]);
    /* Violations in reachability order: the root-violated edge first, then the
     * principal D@2's pin, then the fork D@1's — each judged against the
     * principal of its target. */
    expect(result.violations.map(violation => `${violation.requiredBy} -> ${violation.pkg}`)).to.deep.equal([
      "B@1.0.0 -> D",
      "D@2.0.0 -> H",
      "D@1.0.0 -> G",
    ]);
  });

  it("attributes a tied floor to the same requirement whatever the arrival order", () => {
    /* Two requirements demand the identical winning floor: the tie is broken
     * canonically, not by whichever was recorded first (selectedBy is persisted
     * and drives the 'why this version' diagnostic). */
    const result = resolveOrderIndependent(
      { X: "1.0.0", A: "1.0.0" },
      {
        X: { "1.0.0": { D: "^1.2.0" } },
        A: { "1.0.0": { D: "^1.2.0" } },
        D: { "1.2.0": {} },
      }
    );
    expect(result.selections.find(sel => sel.pkg === "D")?.selectedBy).to.deep.equal({ requiredBy: "A@1.0.0", constraint: "^1.2.0" });
  });

  it("raises a floor demanded after the unpublished answer landed", () => {
    /* C@2.0.5 is unpublished and A's ~2.0.5 can never be repaired (nothing in
     * 2.0.x is published); Z's ^2.0.5 raises cleanly to 2.6.0. Whether Z's
     * demand is recorded before or after the registry's 404 must not decide
     * whether the repair happens — nor may A's unrepairable floor fail a tree
     * that Z's raise makes resolvable. */
    const result = resolveOrderIndependent(
      { A: "1.0.0", Z: "1.0.0" },
      {
        A: { "1.0.0": { C: "~2.0.5" } },
        Z: { "1.0.0": { C: "^2.0.5" } },
        C: { "2.6.0": {} },
      },
      true
    );
    expect(selectionStrings(result)).to.deep.equal(["A@1.0.0", "C@2.6.0", "Z@1.0.0"]);
    expect(result.raises).to.have.lengthOf(1);
    expect(result.raises[0].constraint).to.equal("^2.0.5");
    expect(versionToString(result.raises[0].raised)).to.equal("2.6.0");
    /* A's ~2.0.5 is unsatisfiable by anything published — reported as the
     * ordinary upper-bound violation against what was delivered, not a failure */
    expect(result.violations.map(violation => violation.requiredBy)).to.deep.equal(["A@1.0.0"]);
  });

  it("leaves a tolerable broken floor alone when an unrelated subtree needs repair", () => {
    /* P's floor on F is unpublished but superseded by Q's higher one, so it is
     * tolerable and F resolves to 1.5.0 with no repair at all. R's floor on G is
     * NOT — nothing supersedes it, so the tree needs a repair. Repairing G must
     * not also raise P's demand (which would drag F to 1.9.0): a package's
     * version cannot depend on whether some other subtree happened to be broken. */
    const data = {
      P: { "1.0.0": { F: "^1.0.0" } },
      Q: { "1.0.0": { F: "^1.5.0" } },
      R: { "1.0.0": { G: "^2.0.0" } },
      F: { "1.5.0": {}, "1.9.0": {} },
      G: { "2.4.0": {} },
    };
    /* Without R, no repair is needed and F is 1.5.0. */
    expect(selectionStrings(resolve({ P: "1.0.0", Q: "1.0.0" }, data, true))).to.deep.equal(["F@1.5.0", "P@1.0.0", "Q@1.0.0"]);
    /* With R, G is raised — and F is still 1.5.0. */
    const repaired = resolve({ P: "1.0.0", Q: "1.0.0", R: "1.0.0" }, data, true);
    expect(selectionStrings(repaired)).to.deep.equal(["F@1.5.0", "G@2.4.0", "P@1.0.0", "Q@1.0.0", "R@1.0.0"]);
    expect(repaired.raises.map(raise => `${raise.pkg}@${versionToString(raise.raised)}`)).to.deep.equal(["G@2.4.0"]);
  });

  it("repairs a floor that only a previous repair exposed", () => {
    /* H@1.0.0 is unpublished and unsupersedable, so it is repaired to 1.4.0 —
     * whose own floor on K is *also* unpublished. That second break is only
     * reachable once the first is repaired, so the walk must rerun with both
     * armed rather than stopping at the first round's converged set. */
    const result = resolve(
      { S: "1.0.0" },
      {
        S: { "1.0.0": { H: "^1.0.0" } },
        H: { "1.4.0": { K: "^3.0.0" } },
        K: { "3.7.0": {} },
      },
      true
    );
    expect(selectionStrings(result)).to.deep.equal(["H@1.4.0", "K@3.7.0", "S@1.0.0"]);
    expect(result.raises.map(raise => `${raise.pkg}@${versionToString(raise.raised)}`)).to.deep.equal(["H@1.4.0", "K@3.7.0"]);
  });

  it("fetches each demanded version's metadata exactly once", () => {
    /* Expanding the whole demanded closure costs one metadata document per
     * demanded version — and must cost no more, however many requirements
     * demand it. (The bound on the walk is the same fact: a finite node set,
     * each visited once.) */
    const data = {
      A: { "1.0.0": { D: "^1.0.0" }, "1.2.0": { D: "^1.5.0" } },
      B: { "1.0.0": { A: "^1.0.0", D: "^1.0.0" } },
      C: { "1.0.0": { A: "^1.2.0", D: "^1.0.0" } },
      D: { "1.0.0": {}, "1.5.0": {} },
    };
    const calls = new Map<string, number>();
    const base = mockRegistry(data);
    const registry: RequirementSource<SemverVersion> = {
      getRequirements(pkg: string, version: SemverVersion): Computable<Requirement[]> {
        const id = `${pkg}@${versionToString(version)}`;
        calls.set(id, (calls.get(id) ?? 0) + 1);
        return base.getRequirements(pkg, version);
      },
    };
    let result: MVSResolution<SemverVersion> | undefined;
    resolveMVS([{ pkg: "B", constraint: "1.0.0" }, { pkg: "C", constraint: "1.0.0" }], SEMVER, registry).then(resolution => {
      result = resolution;
    });
    expect(result).to.not.equal(undefined);
    /* Both A versions are expanded — A@1.0.0 loses its key but its D floor is
     * in the graph — and D@1.0.0 too, demanded by three requirements. */
    expect([...calls.entries()].sort(([a], [b]) => (a < b ? -1 : 1))).to.deep.equal([
      ["A@1.0.0", 1],
      ["A@1.2.0", 1],
      ["B@1.0.0", 1],
      ["C@1.0.0", 1],
      ["D@1.0.0", 1],
      ["D@1.5.0", 1],
    ]);
  });

  it("terminates on a dependency cycle whose versions alternate", () => {
    /* The graph cycles through four distinct nodes; each is demanded and so
     * expanded, but only once, so the walk closes. */
    const result = resolveOrderIndependent(
      { A: "^1.0.0" },
      {
        A: { "1.0.0": { B: "^2.0.0" }, "2.0.0": { B: "^1.0.0" } },
        B: { "1.0.0": { A: "^1.0.0" }, "2.0.0": { A: "^2.0.0" } },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["A@1.0.0", "A@2.0.0", "B@1.0.0", "B@2.0.0"]);
    expect(result.errors).to.deep.equal([]);
  });

  it("terminates when the raise hook offers a version the registry then rejects", () => {
    /* A registry inconsistent with itself: the version list keeps offering
     * 1.6.0, whose metadata 404s in turn. Repairing that offer re-demands it,
     * and every demanded version is now expanded — so the walk must repair each
     * (node, demand) once rather than trading the same offer back and forth
     * forever. Termination is the property under test; the outcome is the
     * terminal not-found for the offered version (nothing the registry will
     * actually serve satisfies the requirement — an unfetchable selection must
     * never look resolved). */
    const registry: RequirementSource<SemverVersion> = {
      getRequirements(pkg: string, version: SemverVersion): Computable<Requirement[]> {
        if (pkg === "A") {
          return Computable.resolve([{ pkg: "B", constraint: "^1.0.0" }]);
        }
        throw new VersionNotFoundError(pkg, versionToString(version), `${pkg}@${versionToString(version)} not found`);
      },
      lowestAvailable: (): Computable<SemverVersion | undefined> => Computable.resolve(parseVersion("1.6.0")),
    };
    let error: Error | undefined;
    resolveMVS([{ pkg: "A", constraint: "1.0.0" }], SEMVER, registry).then(
      () => undefined,
      err => {
        error = err as Error;
      }
    );
    expect(error).to.be.instanceOf(MetadataFetchError);
    expect((error as MetadataFetchError).pkg).to.equal("B");
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

describe("fork packing", () => {
  it("gives a violated exact pin a fork selection", () => {
    /* The mdn-data shape: X exact-pins M@2.0.28, Y floors it at 2.12.2 — same
     * major, jointly unsatisfiable. The violated edge is repaired by a fork of
     * M at exactly 2.0.28, which a sealed delivery nests privately. */
    const result = resolve(
      { X: "1.0.0", Y: "1.0.0" },
      {
        X: { "1.0.0": { M: "2.0.28" } },
        Y: { "1.0.0": { M: "^2.12.2" } },
        M: { "2.0.28": {}, "2.12.2": {} },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["M@2.0.28", "M@2.12.2", "X@1.0.0", "Y@1.0.0"]);
    const [fork, principal] = result.selections.filter(sel => sel.pkg === "M");
    expect(fork.fork).to.equal(1);
    expect(principal.fork).to.be.undefined;
    expect(result.violations).to.have.lengthOf(1);
    expect(result.violations[0].constraint).to.equal("2.0.28");
    /* The fork records the requirement whose floor selected it */
    expect(fork.selectedBy).to.deep.equal({ requiredBy: "X@1.0.0", constraint: "2.0.28" });
    expect(fork.reachedVia).to.deep.equal({ requiredBy: "X@1.0.0", constraint: "2.0.28" });
  });

  it("shares a fork between identical violated edges and forks recursively", () => {
    /* A and B pin the same (P, 1.0.0) — one fork serves both edges; the fork's
     * own subtree violates (Q, 1.0.0) against the jointly-selected Q@1.2.0 —
     * a second fork, packed by the same rule in the same graph. R is shared
     * with the main tree (its edges are satisfied by the principals), not
     * duplicated into a private world. */
    const result = resolve(
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
    expect(selectionStrings(result)).to.deep.equal([
      "A@1.0.0",
      "B@1.0.0",
      "C@1.0.0",
      "P@1.0.0",
      "P@1.5.0",
      "Q@1.0.0",
      "Q@1.2.0",
      "R@1.0.0",
    ]);
    const forks = result.selections.filter(sel => sel.fork !== undefined);
    expect(forks.map(sel => `${sel.pkg}@${versionToString(sel.version)}`)).to.deep.equal(["P@1.0.0", "Q@1.0.0"]);
    expect(result.violations.map(violation => `${violation.requiredBy} -> ${violation.pkg}`)).to.deep.equal([
      "A@1.0.0 -> P",
      "B@1.0.0 -> P",
      "P@1.0.0 -> Q",
    ]);
  });

  it("creates no forks for a violation-free tree", () => {
    const result = resolve(
      { A: "1.0.0" },
      {
        A: { "1.0.0": { B: "^1.2.0" } },
        B: { "1.2.0": {} },
      }
    );
    expect(result.selections.every(sel => sel.fork === undefined)).to.equal(true);
    expect(result.violations).to.deep.equal([]);
  });

  it("raises a fork's unpublished floor to the lowest published satisfier", () => {
    /* The violated edge's floor ~1.8.0 → 1.8.0 was never published; the fork
     * lands at the lowest published version satisfying the constraint, and the
     * raise is recorded. No arming round is needed — the converged violation is
     * itself the proof the fork (hence the raise) is required. */
    const result = resolve(
      { A: "1.0.0", B: "^2.6.2" },
      {
        A: { "1.0.0": { B: "~1.8.0" } },
        B: { "1.8.3": {}, "2.6.2": {} },
      },
      true
    );
    expect(selectionStrings(result)).to.deep.equal(["A@1.0.0", "B@1.8.3", "B@2.6.2"]);
    const fork = result.selections.find(sel => sel.fork !== undefined)!;
    expect(versionToString(fork.version)).to.equal("1.8.3");
    expect(result.raises).to.have.lengthOf(1);
    expect(versionToString(result.raises[0].declared)).to.equal("1.8.0");
    expect(versionToString(result.raises[0].raised)).to.equal("1.8.3");
    expect(result.raises[0].requiredBy).to.equal("A@1.0.0");
  });

  it("leaves a violation nothing published satisfies bare — no fork", () => {
    /* A's exact pin has no published satisfier at all: the violation stands
     * with no repairing fork (a consumer sees no selection satisfies it), and
     * the rest of the tree still resolves — the unsatisfiable edge is judged
     * where it is in scope, not turned into a whole-resolution failure. */
    const result = resolve(
      { A: "1.0.0", B: "^2.6.2" },
      {
        A: { "1.0.0": { B: "1.9.9" } },
        B: { "2.6.2": {} },
      },
      true
    );
    expect(selectionStrings(result)).to.deep.equal(["A@1.0.0", "B@2.6.2"]);
    expect(result.violations).to.have.lengthOf(1);
    expect(result.violations[0].constraint).to.equal("1.9.9");
  });

  it("a floorless edge in a fork's subtree is answered by the delivery's pin", () => {
    /* The jest-30 shape: X exact-pins M@2.0.28 (violated by Y's higher floor,
     * so M@2.0.28 forks), and the fork requires T '*'. Forks resolve in the
     * ONE graph, so the batch's T pin answers the floorless edge directly —
     * no error, and no private world that couldn't see the pin. */
    const result = resolve(
      { X: "1.0.0", Y: "1.0.0", T: "20.0.0" },
      {
        X: { "1.0.0": { M: "2.0.28" } },
        Y: { "1.0.0": { M: "^2.12.2" } },
        M: { "2.0.28": { T: "*" }, "2.12.2": {} },
        T: { "20.0.0": {} },
      }
    );
    expect(result.errors).to.deep.equal([]);
    expect(selectionStrings(result)).to.deep.equal(["M@2.0.28", "M@2.12.2", "T@20.0.0", "X@1.0.0", "Y@1.0.0"]);
  });

  it("keeps the floorless-only error when nothing provides the package", () => {
    const result = resolve(
      { X: "1.0.0", Y: "1.0.0" },
      {
        X: { "1.0.0": { M: "2.0.28" } },
        Y: { "1.0.0": { M: "^2.12.2" } },
        M: { "2.0.28": { T: "*" }, "2.12.2": {} },
      }
    );
    expect(result.errors).to.have.lengthOf(1);
    expect(result.errors[0].pkg).to.equal("T");
    /* Attributed through the first-reacher chain to the root whose subtree
     * demanded the erring node (X exact-pinned the fork) */
    expect(result.errors[0].rootPkg).to.equal("X");
  });
});

describe("force overrides", () => {
  it("substitutes every requirement on the forced package — force can go DOWN", () => {
    /* npm-overrides semantics: A demands C ^3.0.0, but the force pins 2.0.0 —
     * the higher floor does not out-vote it; the coerced range is recorded as
     * data, no violation, no fork, and C@3.0.0 is never even expanded. */
    const result = resolve(
      { A: "1.0.0", C: "2.0.0!" },
      {
        A: { "1.0.0": { C: "^3.0.0" } },
        C: { "2.0.0": {}, "3.0.0": {} },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["A@1.0.0", "C@2.0.0"]);
    expect(result.violations).to.deep.equal([]);
    expect(result.selections.every(sel => sel.fork === undefined)).to.equal(true);
    expect(result.coerced).to.have.lengthOf(1);
    expect(result.coerced[0]).to.deep.include({ pkg: "C", constraint: "^3.0.0", requiredBy: "A@1.0.0" });
    expect(versionToString(result.coerced[0].selected)).to.equal("2.0.0");
  });

  it("coerces a lower exact pin up onto the forced version without forking", () => {
    const result = resolve(
      { A: "1.0.0", C: "2.0.0!" },
      {
        A: { "1.0.0": { C: "1.4.0" } },
        C: { "1.4.0": {}, "2.0.0": {} },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["A@1.0.0", "C@2.0.0"]);
    expect(result.violations).to.deep.equal([]);
    expect(result.coerced.map(edge => `${edge.requiredBy} -> ${edge.pkg}:${edge.constraint}`)).to.deep.equal(["A@1.0.0 -> C:1.4.0"]);
  });

  it("a satisfied requirement on a forced package is not coerced", () => {
    const result = resolve(
      { A: "1.0.0", C: "2.0.0!" },
      {
        A: { "1.0.0": { C: "^2.0.0" } },
        C: { "2.0.0": {} },
      }
    );
    expect(result.coerced).to.deep.equal([]);
    expect(result.violations).to.deep.equal([]);
  });

  it("the forced version's own dependencies resolve normally", () => {
    const result = resolve(
      { A: "1.0.0", C: "2.0.0!" },
      {
        A: { "1.0.0": { C: "^3.0.0" } },
        C: { "2.0.0": { D: "^1.1.0" }, "3.0.0": {} },
        D: { "1.1.0": {} },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["A@1.0.0", "C@2.0.0", "D@1.1.0"]);
  });

  it("a forced version that was never published is a terminal failure, not a raise", () => {
    /* The user pinned it; the raise hook must not move an explicit force. */
    const err = resolveError(
      { A: "1.0.0", C: "2.0.0!" },
      {
        A: { "1.0.0": { C: "^1.0.0" } },
        C: { "1.0.0": {}, "2.1.0": {} },
      },
      true
    );
    expect(err).to.be.instanceOf(MetadataFetchError);
    expect((err as MetadataFetchError).pkg).to.equal("C");
  });

  it("an alternate supplies the version for a floorless-only requirement (attach-last)", () => {
    /* A requires T '*' and nothing selects T: the written alternate answers,
     * instead of the add-a-pin error — and reads as a root selection. */
    const result = resolve(
      { A: "1.0.0", T: "26.0.0?" },
      {
        A: { "1.0.0": { T: "*" } },
        T: { "26.0.0": {} },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["A@1.0.0", "T@26.0.0"]);
    expect(result.errors).to.deep.equal([]);
    expect(result.selections.find(sel => sel.pkg === "T")?.selectedBy).to.deep.equal({ requiredBy: "(root)", constraint: "26.0.0" });
  });

  it("an alternate still answers when the package's only selection is a phantom", () => {
    /* T's only floor comes from a SUPERSEDED node (C@1.0.0 — expanded by the
     * whole-closure walk, but C selects 2.0.0) and names an unpublished
     * version, so the slot holds a phantom. The in-effect edge (C@2.0.0's) is
     * floorless, so the written alternate must fire exactly as it does when
     * nothing selects T at all — and must beat the phantom's higher floor. */
    const result = resolve(
      { B: "1.0.0", C: "2.0.0", T: "1.0.0?" },
      {
        B: { "1.0.0": { C: ">=1.0.0" } },
        C: { "1.0.0": { T: "9.9.9" }, "2.0.0": { T: "*" } },
        T: { "1.0.0": {}, "3.0.0": {} },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["B@1.0.0", "C@2.0.0", "T@1.0.0"]);
    expect(result.errors).to.deep.equal([]);
    expect(result.selections.find(sel => sel.pkg === "T")?.selectedBy).to.deep.equal({ requiredBy: "(root)", constraint: "1.0.0" });
  });

  it("an alternate stays inert when a floored requirement selects the package", () => {
    const result = resolve(
      { A: "1.0.0", T: "26.0.0?" },
      {
        A: { "1.0.0": { T: "^25.0.0" } },
        T: { "25.0.0": {}, "26.0.0": {} },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["A@1.0.0", "T@25.0.0"]);
  });

  it("an alternate stays inert when nothing requires the package at all", () => {
    const result = resolve(
      { A: "1.0.0", T: "26.0.0?" },
      {
        A: { "1.0.0": {} },
        T: { "26.0.0": {} },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["A@1.0.0"]);
  });

  it("force is deterministic under any metadata arrival order", () => {
    const result = resolveOrderIndependent(
      { A: "1.0.0", B: "1.0.0", C: "2.0.0!" },
      {
        A: { "1.0.0": { C: "^3.0.0" } },
        B: { "1.0.0": { C: "1.4.0" } },
        C: { "1.4.0": {}, "2.0.0": {}, "3.0.0": {} },
      }
    );
    expect(selectionStrings(result)).to.deep.equal(["A@1.0.0", "B@1.0.0", "C@2.0.0"]);
    expect(result.coerced.map(edge => edge.requiredBy).sort()).to.deep.equal(["A@1.0.0", "B@1.0.0"]);
  });
});

/* The resolution stores where each edge leads (MVSResolution.edges) instead of
 * leaving every consumer to recompute it. These pin the stored answers to the
 * rule that produced them — the contract a layout relies on. */
describe("resolved edges", () => {
  /** What a consumer would compute for itself, the old way. */
  function recomputed(result: MVSResolution<SemverVersion>): Map<string, Map<string, string>> {
    const edges = new Map<string, Map<string, string>>();
    for (const sel of result.selections) {
      const id = nodeId(SEMVER, sel.pkg, sel.version);
      const from = new Map<string, string>();
      for (const req of result.requirements.get(id) ?? []) {
        const name = req.alias ?? req.pkg;
        if (from.has(name)) {
          continue;
        }
        const target = edgeBinding(SEMVER, result.selections, req);
        if (target) {
          from.set(name, nodeId(SEMVER, target.pkg, target.version));
        }
      }
      edges.set(id, from);
    }
    return edges;
  }

  const cases: Array<[string, Record<string, string>, Record<string, Record<string, Record<string, string>>>]> = [
    ["a plain tree", { A: "^1.0.0" }, { A: { "1.0.0": { B: "^1.0.0" } }, B: { "1.0.0": {} } }],
    [
      "a diamond",
      { A: "^1.0.0", B: "^1.0.0" },
      { A: { "1.0.0": { C: "^1.0.0" } }, B: { "1.0.0": { C: "^1.2.0" } }, C: { "1.0.0": {}, "1.2.0": {} } },
    ],
    [
      "a coexistence fork (the case where an edge binds somewhere other than the principal)",
      { A: "^1.0.0", B: "^1.0.0" },
      { A: { "1.0.0": { C: "^1.0.0" } }, B: { "1.0.0": { C: "^2.0.0" } }, C: { "1.0.0": {}, "2.0.0": {} } },
    ],
    ["a cycle", { A: "^1.0.0" }, { A: { "1.0.0": { B: "^1.0.0" } }, B: { "1.0.0": { A: "^1.0.0" } } }],
  ];

  for (const [what, roots, data] of cases) {
    it(`stores what edgeBinding computes, for ${what}`, () => {
      const result = resolve(roots, data);
      expect(result.edges).to.deep.equal(recomputed(result));
    });

    it(`binds each root to what it reaches, for ${what}`, () => {
      const result = resolve(roots, data);
      const requirements = rootRequirements(roots);
      result.rootBindings.forEach((stored, index) => {
        /* The scoped rule: a root binds within what it reaches, so a fork
         * packed for another root's violated edge cannot answer it. */
        const reachable = result.selections.filter(sel => sel.reachableFrom?.includes(index));
        const expected = edgeBinding(SEMVER, reachable, requirements[index]);
        /* Stored as a position in `selections`, so a delivery reaches its root
         * with an index rather than an id lookup. */
        expect(stored === undefined ? undefined : result.selections[stored]).to.equal(expected);
      });
    });
  }

  it("names an aliased edge by the requirer's name for it", () => {
    const result = resolve({ A: "^1.0.0" }, { A: { "1.0.0": { B: "^1.0.0" } }, B: { "1.0.0": {} } });
    expect([...result.edges.get("A@1.0.0")!.keys()]).to.deep.equal(["B"]);
  });

  /* A delivery carves its subset by walking these edges forward from its roots,
   * where the resolver recorded the same reachability backwards as
   * `reachableFrom`. Nothing keeps the two in step but this: they are computed
   * by different code over the same bindings. */
  for (const [what, roots, data] of cases) {
    it(`walking the edges reaches exactly what reachableFrom marks, for ${what}`, () => {
      const result = resolve(roots, data);
      result.rootBindings.forEach((at, index) => {
        if (at === undefined) {
          return;
        }
        const walked = reachableFrom(result.edges, [nodeId(SEMVER, result.selections[at].pkg, result.selections[at].version)]);
        const marked = new Set(
          result.selections
            .filter(sel => sel.reachableFrom?.includes(index))
            .map(sel => nodeId(SEMVER, sel.pkg, sel.version))
        );
        expect([...walked].sort()).to.deep.equal([...marked].sort());
      });
    });
  }
});
