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
import { EMPTY_FILESET, FileSet } from "../core/FileSet";
import { PackageFileSet } from "../core/PackageFileSet";
import { RunnableFileSet } from "../core/RunnableFileSet";
import { CatalogRepository, catalogRepositoryRegistration } from "./CatalogRepository";
import { Repository, RepositoryRef } from "../core/Repository";
import { Requirement } from "../resolver/Types";
import { ConflictError, RequirementResolutionError } from "../core/Errors";
import { MemoryFile } from "../core/MemoryFS";
import { BuildCache } from "../core/BuildCache";
import { Name } from "../core/Name";
import { TargetContext } from "../model/BuildContext";
import { Constraints, RUN_OVERRIDE } from "../model/Constraints";
import { BuildModel } from "../model/BuildModel";
import { ExecutionContext } from "../model/ExecutionContext";
import { parseBuildString } from "../model/Parser";
import { toBuildModel } from "../model/Sema";
import { LogFormatter, LogLevel } from "../support/Log";
import { PluginContribution, RuleRegistration } from "./Types";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SEMVER, SemverConstraint, SemverVersion, versionToString } from "../resolver/Semver";
import { IContentPackage, PackageFormat } from "../resolver/PackageFormat";
import { RepositoryReader } from "../core/Repository";
import { ResolutionContext } from "../core/Repository";
import { expect } from "chai";

/* getRepositoryRef vending is pure — an empty catalog suffices. */
const TEST_RESOLUTION_CONTEXT: ResolutionContext = {
  getGlobalString: () => Computable.resolve("build"),
  memoize: (_tag, _key, create) => create("unused"),
  notifyProgress: () => undefined,
};
const emptyCatalog = new CatalogRepository("@cat", TEST_RESOLUTION_CONTEXT, Computable.resolve(new Map()));

describe("CatalogRepository.getRepositoryRef", () => {
  it("claims a plain alias, no projection", () => {
    const ref = emptyCatalog.getRepositoryRef(Name.fromLiteral("chai"));
    expect(ref.name.toString()).to.equal("chai");
    expect(ref.projections).to.be.empty;
  });

  it("keys a scoped package by its full name (the '/' is part of the alias)", () => {
    const ref = emptyCatalog.getRepositoryRef(Name.fromLiteral("@types/node"));
    expect(ref.name.toString()).to.equal("@types/node");
    expect(ref.projections).to.be.empty;
  });

  it("packs a trailing ':tail' into the ref as a projection into the pinned package", () => {
    const ref = emptyCatalog.getRepositoryRef(Name.fromLiteral("typescript:bin/tsc"));
    expect(ref.name.toString()).to.equal("typescript");
    expect(ref.projections).to.have.length(1);
    expect(ref.projections[0].pattern.toString()).to.equal("bin/tsc");
    expect(ref.projections[0].prefix).to.equal("");
  });

  it("refuses to vend a write ref (a catalog is read-only)", () => {
    expect(() => emptyCatalog.getRepositoryPublishRef(Name.fromLiteral("chai:1.0.0"))).to.throw(/not a publish destination/);
  });
});

/**
 * The catalog through the model — the real path (provider + resolvePackageSet +
 * the resolution layer's driver over the backing registries). A backing
 * registry records requirement reads and fetches separately, so a test can
 * prove versions resolve for the whole catalog up front while package contents
 * are fetched only when a member is actually named.
 */
describe("CatalogRepository (through the model)", () => {
  /* The runnable record is format-level (launching is format convention). */
  const ran: string[] = [];
  /** The test ecosystem: a versionless grammar (a whole written name IS the
   * package, implicitly at 1.0.0) over semver — the catalog's own aliasing is
   * what these tests exercise, not version syntax. */
  const CAT_FORMAT: PackageFormat<SemverVersion, SemverConstraint> = {
    ...SEMVER,
    resolutionTag: "cattest:resolve:1",
    splitReference: (name: Name) => ({ requirement: name }),
    parseRequirement: (name: Name) => ({ pkg: name.toString(), constraint: "1.0.0" }),
    parsePublishCoordinate: () => {
      throw new Error("not used");
    },
    readContentPackage: (): Computable<IContentPackage<SemverVersion>> => {
      throw new Error("not used");
    },
    makeRunnable: (pkg: PackageFileSet) => {
      ran.push(pkg.packageName);
      return Computable.resolve(RunnableFileSet.forEntry(pkg, `${pkg.packageName}/data.txt`, [], "node"));
    },
  };

  /* One backing registry per declared `package_repo` target, resolvable by name
   * so a test can inspect the exact instance the catalog used. */
  const backings = new Map<string, BackingRepo>();
  let instances = 0;
  function backing(name: string): BackingRepo {
    let repo = backings.get(name);
    if (!repo) {
      /* Unique identity per INSTANCE: the resolution layer memoizes by
       * registry identity through the real cache, and each test seeds a fresh
       * fake table under the same declared name. */
      repo = new BackingRepo(`${name}#${++instances}`);
      backings.set(name, repo);
    }
    return repo;
  }

  class BackingRepo implements Repository, RepositoryReader<SemverVersion, SemverConstraint> {
    public readonly format = CAT_FORMAT;
    /** Every requirement read — how a test proves the WHOLE catalog was
     * version-resolved (pinning reads every member) while only named members
     * were fetched. */
    public readonly requested: string[] = [];
    public readonly materialized: string[] = [];

    constructor(public readonly identity: string) {}

    public getRepositoryRef(name: Name): RepositoryRef {
      return new RepositoryRef(this, name);
    }

    public getRepositoryPublishRef(name: Name): never {
      throw new Error(`package_repo is not a publish destination ('${name.toString()}')`);
    }

    public environmentKey(): Computable<string> {
      return Computable.resolve("cattest-env");
    }

    public getRequirements(pkg: string, _version: SemverVersion): Computable<Requirement[]> {
      this.requested.push(pkg);
      return Computable.resolve([]);
    }

    public fetch(pkg: string, version: SemverVersion): Computable<PackageFileSet> {
      this.materialized.push(pkg);
      return Computable.resolve(new PackageFileSet(new Map([[`${pkg}/data.txt`, MemoryFile.from(pkg)]]), pkg, versionToString(version)));
    }
  }

  let lastDeps: FileSet | undefined;
  /* The delivered sets before the union, for a test that cares about the
   * identity a delivery carries rather than its content. */
  let lastDepSets: FileSet[] = [];
  const depsRule: RuleRegistration = {
    type: "test_deps",
    constraints: {},
    evaluate: (context: TargetContext) =>
      context.getFileSetProperties(["deps"]).then(({ deps }) => {
        lastDepSets = deps;
        lastDeps = FileSet.unionAll(...deps);
        return EMPTY_FILESET;
      }),
  };
  let lastTool: FileSet | undefined;
  const runRule: RuleRegistration = {
    type: "test_run",
    constraints: {},
    evaluate: (context: TargetContext) =>
      context.getFileSetProperties(["tool"], RUN_OVERRIDE).then(({ tool }) => {
        lastTool = FileSet.unionAll(...tool);
        return EMPTY_FILESET;
      }),
  };
  const contributions: PluginContribution[] = [
    {
      rules: [depsRule, runRule],
      repositories: [
        { type: "package_repo", provider: (context: TargetContext) => Computable.resolve(backing(context.name)) },
        catalogRepositoryRegistration,
      ],
    },
  ];
  const testLog = new LogFormatter(LogLevel.Info, () => undefined);
  /* A throwaway cache root: the resolution layer PERSISTS memos through the
   * build cache, so a cache in the working directory would leak entries into
   * the repo and serve stale resolutions across test runs. */
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-catalog-test-"));
  afterAll(() => fs.rmSync(cacheRoot, { recursive: true, force: true }));
  const execution = new ExecutionContext(new BuildCache(cacheRoot, testLog), testLog, EMPTY_FILESET, EMPTY_FILESET);

  /* STD isn't loaded for a raw-string model; the catalog reads the operation,
   * which the real build always has via STD's default. */
  const preamble =
    "default BUILD_OPERATION = build;\n" +
    "targetdef catalog { deps = FILES; }\n" +
    "targetdef package_repo { }\n" +
    "targetdef test_deps { deps = FILES; }\n" +
    "targetdef test_run { tool = FILES; }\n";

  function build(source: string): BuildModel {
    backings.clear();
    ran.length = 0;
    lastDeps = undefined;
    lastDepSets = [];
    lastTool = undefined;
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", preamble + source, logger)], logger, contributions);
    expect(errors).to.deep.equal([]);
    return model;
  }

  it("resolves versions jointly up front but fetches only the named member (lazy)", async () => {
    const model = build(
      "package_repo @backing { }\n" +
        "catalog @cat { deps = @backing:foo @backing:bar; }\n" +
        "test_deps a { deps = @cat:foo; }\n"
    );
    await model.getConfig(Constraints.of({}), execution).getTarget("a");
    const repo = backings.get("@backing")!;
    /* the consumer got foo's package... */
    expect(await lastDeps!.readFile("foo/data.txt")).to.equal("foo");
    /* ...versions were resolved for the WHOLE catalog (pinning read both)... */
    expect([...repo.requested].sort()).to.deep.equal(["bar", "foo"]);
    /* ...but ONLY foo was ever fetched — bar, pinned yet unreferenced, is not. */
    expect(repo.materialized).to.deep.equal(["foo"]);
  });

  it("delivers each named member once, every delivery a subset of the ONE pinned resolution", async () => {
    /* Each delivery materializes against the catalog's stored resolution (the
     * resolution carries its own edges, so subset deliveries agree by
     * construction — what must nest privately is the consuming assembler's
     * judgment over complete facts, not a property of batch shape). */
    const model = build(
      "package_repo @backing { }\n" +
        "catalog @cat { deps = @backing:foo @backing:bar; }\n" +
        "test_deps a { deps = @cat:foo @cat:bar; }\n"
    );
    await model.getConfig(Constraints.of({}), execution).getTarget("a");
    const repo = backings.get("@backing")!;
    expect([...repo.materialized].sort()).to.deep.equal(["bar", "foo"]);
  });

  it("shares a collection point with direct (non-catalog) references, each source its own batch", async () => {
    /* `deps = @cat:foo @direct:bar` — a catalog member and an ordinary
     * repository reference in ONE property. They group by repository instance:
     * the catalog answers foo from its pinned resolution, @direct resolves bar
     * in a batch of its own, and the two deliveries merge at the consumer —
     * two domains sharing a collection point, never one joint resolution. */
    const model = build(
      "package_repo @backing { }\n" +
        "package_repo @direct { }\n" +
        "catalog @cat { deps = @backing:foo; }\n" +
        "test_deps a { deps = @cat:foo @direct:bar; }\n"
    );
    await model.getConfig(Constraints.of({}), execution).getTarget("a");
    /* Both deliveries arrived at the one collection point. */
    expect(await lastDeps!.readFile("foo/data.txt")).to.equal("foo");
    expect(await lastDeps!.readFile("bar/data.txt")).to.equal("bar");
    /* Each source resolved exactly its own names: the catalog's pin for foo
     * (resolved at catalog construction), the direct repository for bar. */
    expect(backings.get("@backing")!.requested).to.deep.equal(["foo"]);
    expect(backings.get("@backing")!.materialized).to.deep.equal(["foo"]);
    expect(backings.get("@direct")!.requested).to.deep.equal(["bar"]);
    expect(backings.get("@direct")!.materialized).to.deep.equal(["bar"]);
  });

  it("delivers a member under a written rename, without changing what is pinned or fetched", async () => {
    /* `@cat:foo -> renamed` — the package rename, which the catalog needs no
     * knowledge of: it is applied where every delivery is finished. */
    const model = build(
      "package_repo @backing { }\n" +
        "catalog @cat { deps = @backing:foo; }\n" +
        "test_deps a { deps = @cat:foo -> renamed; }\n"
    );
    await model.getConfig(Constraints.of({}), execution).getTarget("a");
    const delivered = lastDepSets[0] as PackageFileSet;
    expect(delivered).to.be.instanceOf(PackageFileSet);
    expect(delivered.packageName).to.equal("renamed");
    /* Only the identity is the rename's: the content is the pinned member's,
     * and the member was resolved and fetched under its own name. */
    expect(await delivered.readFile("foo/data.txt")).to.equal("foo");
    const repo = backings.get("@backing")!;
    expect(repo.requested).to.deep.equal(["foo"]);
    expect(repo.materialized).to.deep.equal(["foo"]);
  });

  it("delivers a member as a runnable under run, delegating to its source (no re-resolution)", async () => {
    const model = build(
      "package_repo @backing { }\n" +
        "catalog @cat { deps = @backing:tool; }\n" +
        "test_run a { tool = @cat:tool; }\n"
    );
    await model.getConfig(Constraints.of({}), execution).getTarget("a");
    const repo = backings.get("@backing")!;
    expect(lastTool).to.be.instanceOf(RunnableFileSet);
    /* the pinned package was made runnable via its source's format — resolved
     * once, fetched once, closure kept */
    expect(repo.requested).to.deep.equal(["tool"]);
    expect(repo.materialized).to.deep.equal(["tool"]);
    expect(ran).to.deep.equal(["tool"]);
  });

  it("attributes an unpinned member to the written reference (a plain resolution failure)", async () => {
    const model = build(
      "package_repo @backing { }\n" +
        "catalog @cat { deps = @backing:foo; }\n" +
        "test_deps a { deps = @cat:missing; }\n"
    );
    try {
      await model.getConfig(Constraints.of({}), execution).getTarget("a");
      expect.fail("expected @cat:missing to fail");
    } catch (err) {
      const failure = findCause(err, RequirementResolutionError);
      expect(failure, "a RequirementResolutionError in the cause chain").to.not.be.undefined;
      expect(failure!.cause.message).to.contain("has no member 'missing'");
    }
  });

  it("rejects a catalog entry that projects into a package", async () => {
    /* A projected entry would materialize to plain files, not a package —
     * caught at resolveDeps, before any resolution work. The inner catalog is
     * the projection producer here: its getRepositoryRef packs ':data.txt'
     * into the ref as a projection (pinned by its own unit test above). */
    const model = build(
      "package_repo @backing { }\n" +
        "catalog @inner { deps = @backing:foo; }\n" +
        "catalog @outer { deps = @inner:foo:data.txt; }\n" +
        "test_deps a { deps = @outer:foo; }\n"
    );
    try {
      await model.getConfig(Constraints.of({}), execution).getTarget("a");
      expect.fail("expected the projected entry to be rejected");
    } catch (err) {
      let message = "";
      for (let current: unknown = err; current instanceof Error; current = (current as { cause?: unknown }).cause) {
        message = current.message;
      }
      expect(message).to.contain("projects into a package");
    }
  });

  it("rejects a catalog entry that is another catalog's member (no chaining)", async () => {
    /* Each catalog is its own joint resolution; pinning another catalog's
     * member would nest one inside another, so it is refused with a remedy
     * naming the two sanctioned alternatives. */
    const model = build(
      "package_repo @backing { }\n" +
        "catalog @inner { deps = @backing:foo; }\n" +
        "catalog @outer { deps = @inner:foo; }\n" +
        "test_deps a { deps = @outer:foo; }\n"
    );
    try {
      await model.getConfig(Constraints.of({}), execution).getTarget("a");
      expect.fail("expected the chained entry to be rejected");
    } catch (err) {
      const failure = findCause(err, RequirementResolutionError);
      expect(failure, "a RequirementResolutionError in the cause chain").to.not.be.undefined;
      expect(failure!.cause.message).to.contain("is a member of another catalog");
    }
  });

  it("rejects an entry that names no packages (a bare repository reference)", async () => {
    /* `deps = @backing;` resolves to the repository itself — it pins nothing,
     * and silence would leave the catalog quietly missing the entry. */
    const model = build(
      "package_repo @backing { }\n" +
        "catalog @cat { deps = @backing; }\n" +
        "test_deps a { deps = @cat:foo; }\n"
    );
    try {
      await model.getConfig(Constraints.of({}), execution).getTarget("a");
      expect.fail("expected the bare repository entry to be rejected");
    } catch (err) {
      let message = "";
      for (let current: unknown = err; current instanceof Error; current = (current as { cause?: unknown }).cause) {
        message = current.message;
      }
      expect(message).to.contain("names no packages");
    }
  });

  it("reports two entries claiming one package name (from different sources) as a two-sided conflict", async () => {
    /* Two repositories each resolve a package named 'dup' — a genuine conflict
     * (not two versions of one package), reported as the general ConflictError
     * with both written entries attributed. */
    const model = build(
      "package_repo @backing { }\n" +
        "package_repo @other { }\n" +
        "catalog @cat { deps = @backing:dup @other:dup; }\n" +
        "test_deps a { deps = @cat:dup; }\n"
    );
    try {
      await model.getConfig(Constraints.of({}), execution).getTarget("a");
      expect.fail("expected a catalog conflict");
    } catch (err) {
      const conflict = findCause(err, ConflictError);
      expect(conflict, "a ConflictError in the cause chain").to.not.be.undefined;
      expect(conflict!.kind).to.equal("catalog entries");
      expect(conflict!.key).to.equal("dup");
      /* both sides attributed back to where each was written */
      expect(conflict!.left.provenance).to.not.be.undefined;
      expect(conflict!.right.provenance).to.not.be.undefined;
      expect(conflict!.message).to.contain("Conflicting catalog entries for dup");
    }
  });
});

/* Walk the cause chain (DependencyFailedError / ReferenceFailedError wrappers). */
function findCause<T extends Error>(err: unknown, type: new (...args: never[]) => T): T | undefined {
  for (let current: unknown = err; current instanceof Error; current = (current as { cause?: unknown }).cause) {
    if (current instanceof type) {
      return current;
    }
  }
  return undefined;
}
