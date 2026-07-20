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
  const depsRule: RuleRegistration = {
    type: "test_deps",
    constraints: {},
    evaluate: (context: TargetContext) =>
      context.getFileSet("deps").then(files => {
        lastDeps = files;
        return EMPTY_FILESET;
      }),
  };
  let lastTool: FileSet | undefined;
  const runRule: RuleRegistration = {
    type: "test_run",
    constraints: {},
    evaluate: (context: TargetContext) =>
      context.getFileSet("tool", { BUILD_OPERATION: "run" }).then(files => {
        lastTool = files;
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
    await model.getConfig({}, execution).getTarget("a");
    const repo = backings.get("@backing")!;
    /* the consumer got foo's package... */
    expect(await lastDeps!.readFile("foo/data.txt")).to.equal("foo");
    /* ...versions were resolved for the WHOLE catalog in one joint call... */
    expect(repo.resolved).to.have.length(1);
    expect([...repo.resolved[0]].sort()).to.deep.equal(["bar", "foo"]);
    /* ...but ONLY foo was ever fetched — bar, pinned yet unreferenced, is not. */
    expect(repo.materialized).to.deep.equal(["foo"]);
  });

  it("delivers a member as a runnable under run, delegating to its source (no re-resolution)", async () => {
    const model = build(
      "package_repo @backing { }\n" +
        "catalog @cat { deps = @backing:tool; }\n" +
        "test_run a { tool = @cat:tool; }\n"
    );
    await model.getConfig({}, execution).getTarget("a");
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
      await model.getConfig({}, execution).getTarget("a");
      expect.fail("expected @cat:missing to fail");
    } catch (err) {
      const failure = findCause(err, RequirementResolutionError);
      expect(failure, "a RequirementResolutionError in the cause chain").to.not.be.undefined;
      expect(failure!.cause.message).to.contain("has no member 'missing'");
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
      await model.getConfig({}, execution).getTarget("a");
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
