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
import { Repository, RepositoryRef, Resolution } from "../core/Repository";
import { Requirement } from "../resolver/Types";
import { ConflictError, RequirementResolutionError } from "../core/Errors";
import { MemoryFile } from "../core/MemoryFS";
import { BuildCache } from "../core/BuildCache";
import { Name } from "../core/Name";
import { RepositoryContext, TargetContext } from "../model/BuildContext";
import { Constraints, RUN_OVERRIDE } from "../model/Constraints";
import { BuildModel } from "../model/BuildModel";
import { ExecutionContext } from "../model/ExecutionContext";
import { parseBuildString } from "../model/Parser";
import { toBuildModel } from "../model/Sema";
import { LogFormatter, LogLevel } from "../support/Log";
import { PluginContribution, RuleRegistration } from "./Types";
import { expect } from "chai";

/* getRepositoryRef vending is pure — an empty catalog suffices. */
const emptyCatalog = new CatalogRepository("@cat", Computable.resolve("build"), Computable.resolve(new Map()));

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
 * resolve/materialize). A backing repository records its resolve and materialize
 * calls separately, so a test can prove versions resolve jointly up front while
 * package contents are fetched only when a member is actually named.
 */
describe("CatalogRepository (through the model)", () => {
  /* One backing repository per declared `package_repo` target, resolvable by name
   * so a test can inspect the exact instance the catalog used. */
  const backings = new Map<string, BackingRepo>();
  function backing(name: string): BackingRepo {
    let repo = backings.get(name);
    if (!repo) {
      repo = new BackingRepo();
      backings.set(name, repo);
    }
    return repo;
  }

  class BackingRepo implements Repository {
    public readonly resolved: string[][] = [];
    public readonly materialized: string[] = [];
    /** One entry per materialize CALL, naming the batch it was given. */
    public readonly materializeCalls: string[][] = [];
    public readonly ran: string[] = [];

    public getRepositoryRef(name: Name): RepositoryRef {
      return new RepositoryRef(this, name);
    }

    public getRepositoryPublishRef(name: Name): never {
      throw new Error(`package_repo is not a publish destination ('${name.toString()}')`);
    }

    /* Version resolution — cheap, up front; records the joint batch. */
    public resolve(references: RepositoryRef[]): Computable<Resolution> {
      this.resolved.push(references.map(reference => reference.name.toString()));
      return Computable.resolve({ roots: references.map(reference => ({ reference, name: reference.name.toString() })) });
    }

    /* Fetch — deferred; records exactly which members were fetched. */
    public materialize(references: RepositoryRef[]): Computable<FileSet[]> {
      this.materializeCalls.push(references.map(reference => reference.name.toString()));
      return Computable.resolve(
        references.map(reference => {
          const name = reference.name.toString();
          this.materialized.push(name);
          return new PackageFileSet(new Map([[`${name}/data.txt`, MemoryFile.from(name)]]), name, "1.0.0");
        })
      );
    }

    public makeRunnable(pkg: PackageFileSet): Computable<RunnableFileSet> {
      this.ran.push(pkg.packageName);
      return Computable.resolve(RunnableFileSet.forEntry(pkg, `${pkg.packageName}/data.txt`, [], "node"));
    }

    /* The member's own source reads its declared version off `name:version`
     * (a catalog delegates here for a consumer's manifest). */
    public declaredRequirement(ref: RepositoryRef): Computable<Requirement | undefined> {
      const name = ref.name.toString();
      const idx = name.lastIndexOf(":");
      return Computable.resolve(idx > 0 ? { pkg: name.substring(0, idx), constraint: name.substring(idx + 1) } : undefined);
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
        { type: "package_repo", provider: (context: RepositoryContext) => Computable.resolve(backing(context.target.name)) },
        catalogRepositoryRegistration,
      ],
    },
  ];
  const testLog = new LogFormatter(LogLevel.Info, () => undefined);
  const execution = new ExecutionContext(new BuildCache(".", testLog), testLog, EMPTY_FILESET, EMPTY_FILESET);

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
    /* ...versions were resolved for the WHOLE catalog in one joint call... */
    expect(repo.resolved).to.have.length(1);
    expect([...repo.resolved[0]].sort()).to.deep.equal(["bar", "foo"]);
    /* ...but ONLY foo was ever fetched — bar, pinned yet unreferenced, is not. */
    expect(repo.materialized).to.deep.equal(["foo"]);
  });

  it("materializes the named members in ONE call per source, not one per member", async () => {
    /* A repository lays each delivery out against the batch it is asked for, so
     * that the deliveries a consumer merges into one node_modules agree on what
     * must nest privately. Materializing members one at a time would make every
     * batch a batch of one, and a member whose own delivery never saw a higher
     * version of what it requires would record nothing and silently inherit it. */
    const model = build(
      "package_repo @backing { }\n" +
        "catalog @cat { deps = @backing:foo @backing:bar; }\n" +
        "test_deps a { deps = @cat:foo @cat:bar; }\n"
    );
    await model.getConfig(Constraints.of({}), execution).getTarget("a");
    const repo = backings.get("@backing")!;
    expect(repo.materializeCalls).to.deep.equal([["foo", "bar"]]);
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
    expect(repo.resolved).to.deep.equal([["foo"]]);
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
    /* the pinned package was made runnable by its source — resolved once, fetched once */
    expect(repo.resolved).to.have.length(1);
    expect(repo.materialized).to.deep.equal(["tool"]);
    expect(repo.ran).to.deep.equal(["tool"]);
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
