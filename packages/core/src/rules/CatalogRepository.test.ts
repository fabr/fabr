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
import { PackageFileSet, packageNodeSignature, reachablePackages } from "../core/PackageFileSet";
import { RunnableFileSet } from "../core/RunnableFileSet";
import { CatalogRepository, catalogRepositoryRegistration } from "./CatalogRepository";
import { Repository, RepositoryRef,
  MaterializeOptions,
  ClosureThunk,
} from "../core/Repository";
import { splitOverrideMarker } from "../resolver/Overrides";
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
import { resolveBarePackage } from "../resolver/PackageResolver";
import { RepositoryReader, ResolutionContext } from "../core/Repository";
import { expect } from "chai";
import { SILENT_REPORT } from "../support/Execute";

/* getRepositoryRef vending is pure — an empty catalog suffices. */
const TEST_RESOLUTION_CONTEXT: ResolutionContext = {
  name: "@cat",
  getGlobalString: () => Computable.resolve("build"),
  memoize: (_tag, _key, create) => create("unused"),
  runTask: (_task, run) => run(SILENT_REPORT),
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
  /** The test ecosystem: a near-versionless grammar over semver — a written
   * name IS the package, implicitly at 1.0.0, with an optional `:version` tail
   * for the tests that need two versions of one package. Read off the name's
   * base form, since the facets (a `-> alias` rename) say what to do *about*
   * the reference and name no part of the package. */
  const CAT_FORMAT: PackageFormat<SemverVersion, SemverConstraint> = {
    ...SEMVER,
    resolutionTag: "cattest:resolve:1",
    splitReference: (name: Name) => ({ requirement: name }),
    parseRequirement: (name: Name) => {
      const written = name.toBaseString();
      const colon = written.lastIndexOf(":");
      if (colon === -1) {
        return { pkg: written, constraint: "1.0.0" };
      }
      const { text, override } = splitOverrideMarker(written.substring(colon + 1));
      return { pkg: written.substring(0, colon), constraint: text, ...(override ? { override } : {}) };
    },
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

  /** What each `pkg@version` requires, for a test that needs a transitive
   * graph; anything unlisted requires nothing. */
  const requirementTable = new Map<string, Requirement[]>();

  class BackingRepo implements Repository, RepositoryReader<SemverVersion, SemverConstraint> {
    public readonly format = CAT_FORMAT;
    /** Every requirement read — how a test proves the WHOLE catalog was
     * version-resolved (pinning reads every member) while only named members
     * were fetched. */
    public readonly requested: string[] = [];
    public readonly materialized: string[] = [];
    /** Every fetch as `pkg@version`. */
    public readonly fetched: string[] = [];

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

      /* Members are pinned and delivered as packages: a catalog resolves
       * build-shaped whatever it is consumed under. */
      /* Delivers the assembled package as-is: these fakes stand in for a registry
       * reached under an ordinary build. */
      public deliver(_reference: RepositoryRef, _options?: MaterializeOptions, closure?: ClosureThunk): Computable<FileSet> {
        return closure ? closure().then((pkg: PackageFileSet | undefined) => pkg ?? EMPTY_FILESET) : Computable.resolve<FileSet>(EMPTY_FILESET);
      }

      public deliverFiles(reference: RepositoryRef): Computable<FileSet> {
        return Computable.resolve(undefined).then(() => resolveBarePackage(this, reference));
      }

    public getRequirements(pkg: string, version: SemverVersion): Computable<Requirement[]> {
      this.requested.push(pkg);
      return Computable.resolve(requirementTable.get(`${pkg}@${versionToString(version)}`) ?? []);
    }

    public fetch(pkg: string, version: SemverVersion): Computable<PackageFileSet> {
      this.materialized.push(pkg);
      this.fetched.push(`${pkg}@${versionToString(version)}`);
      return Computable.resolve(new PackageFileSet(new Map([[`${pkg}/data.txt`, contentOf(pkg)]]), pkg, versionToString(version)));
    }
  }

  /* One fixture file per package, shared by every version of it: the deps rule
   * below unions the delivered sets flat (a real consumer mounts each package
   * apart), so two versions of one package must carry the same file identity to
   * union — these tests are about what a delivery is NAMED, not about content. */
  const contents = new Map<string, MemoryFile>();
  function contentOf(pkg: string): MemoryFile {
    let file = contents.get(pkg);
    if (!file) {
      file = MemoryFile.from(pkg);
      contents.set(pkg, file);
    }
    return file;
  }

  let lastDeps: FileSet | undefined;
  /* The delivered sets before the union, for a test that cares about the
   * identity a delivery carries rather than its content. */
  let lastDepSets: FileSet[] = [];
  /* What a manifest would record of those deps (collectDeclaredRequirements —
   * the declaration, not what resolution pinned). */
  let lastDeclared: (Requirement | undefined)[] = [];
  const depsRule: RuleRegistration = {
    type: "test_deps",
    constraints: {},
    evaluate: (context: TargetContext) =>
      context.getFileProperty("deps").then(sources =>
        Computable.forAll(
          [context.collectDeclaredRequirements(sources), context.getFileSetProperties(["deps"])],
          (declared, { deps }) => {
            lastDeclared = declared;
            lastDepSets = deps;
            lastDeps = FileSet.unionAll(...deps);
            return EMPTY_FILESET;
          }
        )
      ),
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
    requirementTable.clear();
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

  it("fetches only the member a projection reads from, not its closure", async () => {
    const model = build(
      "package_repo @backing { }\n" +
        "catalog @cat { deps = @backing:foo; }\n" +
        "test_deps a { deps = @cat:foo:foo/data.txt; }\n"
    );
    requirementTable.set("foo@1.0.0", [{ pkg: "bar", constraint: "1.0.0" }]);
    await model.getConfig(Constraints.of({}), execution).getTarget("a");
    const repo = backings.get("@backing")!;
    expect([...lastDeps!].map(([name]) => name)).to.deep.equal(["foo/data.txt"]);
    /* The catalog pinned foo's whole closure; the projection fetched foo alone. */
    expect([...repo.requested].sort()).to.deep.equal(["bar", "foo"]);
    expect(repo.fetched).to.deep.equal(["foo@1.0.0"]);
  });

  it("delivers a member alone under the files operation", async () => {
    const model = build(
      "package_repo @backing { }\n" +
        "catalog @cat { deps = @backing:foo; }\n" +
        "test_deps a { deps = @cat:foo; }\n"
    );
    requirementTable.set("foo@1.0.0", [{ pkg: "bar", constraint: "1.0.0" }]);
    await model.getConfig(Constraints.of({ BUILD_OPERATION: "files" }), execution).getTarget("a");
    const delivered = lastDepSets[0] as PackageFileSet;
    expect(delivered.packageName).to.equal("foo");
    expect(delivered.dependencies).to.deep.equal([]);
    expect(backings.get("@backing")!.fetched).to.deep.equal(["foo@1.0.0"]);
  });

  describe("judging a strict subset by what it ships", () => {
    /* `a` needs x ^2; `b` reaches x ^1 through `y`. Jointly x's principal is
     * 2.0.0 and y's edge is repaired by a second selection, x@1.0.0. */
    const source =
      "package_repo @backing { }\n" +
      "catalog @cat { deps = @backing:a @backing:b; }\n" +
      "test_deps only_b { deps = @cat:b; }\n" +
      "test_deps both { deps = @cat:a @cat:b; }\n";
    const graph = (): void => {
      requirementTable.set("a@1.0.0", [{ pkg: "x", constraint: "^2.0.0" }]);
      requirementTable.set("b@1.0.0", [{ pkg: "y", constraint: "1.0.0" }]);
      requirementTable.set("y@1.0.0", [{ pkg: "x", constraint: "^1.0.0" }]);
    };

    it("delivers a subset that reaches only the version satisfying it", async () => {
      /* b's closure holds x@1.0.0 alone — an ordinary one-version install; the
       * principal x@2.0.0 is a's, and b's delivery does not reach it. */
      const model = build(source);
      graph();
      await model.getConfig(Constraints.of({}), execution).getTarget("only_b");
      expect([...backings.get("@backing")!.fetched].sort()).to.deep.equal(["b@1.0.0", "x@1.0.0", "y@1.0.0"]);
    });

    it("still refuses a delivery that ships both versions together", async () => {
      const model = build(source);
      graph();
      let message = "";
      try {
        await model.getConfig(Constraints.of({}), execution).getTarget("both");
      } catch (err) {
        for (let current: unknown = err; current instanceof Error; current = (current as { cause?: unknown }).cause) {
          message = current.message;
        }
      }
      expect(message).to.contain("x@2.0.0 does not satisfy '^1.0.0' required by y@1.0.0");
      /* Explained as fully as one delivery's conflict: the winner's path and the
       * losing requirement's, each through the delivery that ships it. */
      expect(message).to.contain("2.0.0 selected by: a@1.0.0 -> x@2.0.0 (^2.0.0)");
      expect(message).to.contain("'^1.0.0' required via: b@1.0.0 -> y@1.0.0 (1.0.0)");
    });

    /** The deepest message and help a failed build of `name` carries. */
    async function failure(model: BuildModel, name: string): Promise<{ message: string; help: string }> {
      let message = "";
      let help = "";
      try {
        await model.getConfig(Constraints.of({}), execution).getTarget(name);
      } catch (err) {
        for (let current: unknown = err; current instanceof Error; current = (current as { cause?: unknown }).cause) {
          message = current.message;
          help = String((current as { help?: unknown }).help ?? help);
        }
      }
      return { message, help };
    }

    it("counts the catalog's exact pin as written for a subset that does not name it", async () => {
      /* x is pinned at 2.0.0 and 1.0.0 is sanctioned, both in the catalog;
       * `both` names neither, yet ships both versions — each written. */
      const model = build(
        "package_repo @backing { }\n" +
          "catalog @cat { deps = @backing:a @backing:b @backing:x:2.0.0 @backing:x:1.0.0?; }\n" +
          "test_deps both { deps = @cat:a @cat:b; }\n"
      );
      graph();
      await model.getConfig(Constraints.of({}), execution).getTarget("both");
      expect([...backings.get("@backing")!.fetched].sort()).to.include.members(["x@1.0.0", "x@2.0.0"]);
    });

    it("suggests only the versions shipped and not yet written", async () => {
      /* c raises x's principal to 3.0.0, which `both` never reaches: it ships
       * x@2.0.0 (for a) and x@1.0.0 (for y), and 1.0.0 is already sanctioned. */
      const model = build(
        "package_repo @backing { }\n" +
          "catalog @cat { deps = @backing:a @backing:b @backing:c @backing:x:1.0.0?; }\n" +
          "test_deps both { deps = @cat:a @cat:b; }\n"
      );
      graph();
      requirementTable.set("c@1.0.0", [{ pkg: "x", constraint: "^3.0.0" }]);
      const { help } = await failure(model, "both");
      expect(help).to.contain("@backing:x:2.0.0?");
      expect(help).to.not.contain("@backing:x:1.0.0?");
      expect(help).to.not.contain("@backing:x:3.0.0?");
    });

    it("refuses a catalog member and a direct reference shipping two versions together", async () => {
      /* Two resolutions, each consistent on its own: the catalog pins x@1.0.0
       * for b; the direct reference asks x@2.0.0. Used together, they ship two
       * versions — judged over the consumer's whole collection point, and
       * explained through each resolution in turn. */
      const model = build(
        "package_repo @backing { }\n" +
          "catalog @cat { deps = @backing:b; }\n" +
          "test_deps mixed { deps = @cat:b @backing:x:2.0.0; }\n"
      );
      graph();
      let message = "";
      let help = "";
      try {
        await model.getConfig(Constraints.of({}), execution).getTarget("mixed");
      } catch (err) {
        for (let current: unknown = err; current instanceof Error; current = (current as { cause?: unknown }).cause) {
          message = current.message;
          help = String((current as { help?: unknown }).help ?? help);
        }
      }
      expect(message).to.contain("requires multiple versions of x (1.0.0, 2.0.0)");
      expect(message).to.contain("1.0.0 required via: b@1.0.0 -> y@1.0.0");
      expect(message).to.contain("2.0.0 required directly ('2.0.0')");
      /* The direct reference's exact pin already sanctions 2.0.0; the remedy
       * completes the set. */
      expect(help).to.contain("@backing:x:1.0.0?");
      expect(help).to.not.contain("@backing:x:2.0.0?");
    });
  });

  describe("an optional peer, across members delivered apart", () => {
    /* langsmith's `openai` is an optional peer: classic's closure holds openai,
     * anthropic's does not. Each member is delivered as its own subset, so
     * whether langsmith is bound to openai is decided by the installation that
     * consumes them, not by which subset delivered it. */
    const graph = (): void => {
      requirementTable.set("anthropic@1.0.0", [{ pkg: "langsmith", constraint: "1.0.0" }]);
      requirementTable.set("classic@1.0.0", [
        { pkg: "langsmith", constraint: "1.0.0" },
        { pkg: "openai", constraint: "1.0.0" },
      ]);
      requirementTable.set("langsmith@1.0.0", [{ pkg: "openai", constraint: "1.0.0", provided: "optional" }]);
    };
    const catalog = "package_repo @backing { }\ncatalog @cat { deps = @backing:anthropic @backing:classic; }\n";
    const langsmiths = (): PackageFileSet[] =>
      reachablePackages(lastDepSets).filter(pkg => pkg.packageName === "langsmith");

    it("binds the peer in an installation that holds it, making the two deliveries one node", async () => {
      const model = build(catalog + "test_deps a { deps = @cat:anthropic @cat:classic; }\n");
      graph();
      await model.getConfig(Constraints.of({}), execution).getTarget("a");
      const found = langsmiths();
      expect(found.length, "langsmith reached through both members").to.be.greaterThan(0);
      for (const pkg of found) {
        expect(pkg.getDependency("openai"), "bound to the installation's openai").to.not.equal(undefined);
      }
      expect(new Set(found.map(packageNodeSignature)).size, "one node").to.equal(1);
    });

    it("leaves the peer unbound, and unfetched, in an installation without it", async () => {
      const model = build(catalog + "test_deps a { deps = @cat:anthropic; }\n");
      graph();
      await model.getConfig(Constraints.of({}), execution).getTarget("a");
      const found = langsmiths();
      expect(found).to.have.lengthOf(1);
      expect(found[0].getDependency("openai")).to.equal(undefined);
      expect(found[0].provided.get("openai")).to.equal("1.0.0");
      expect(backings.get("@backing")!.materialized).to.not.include("openai");
    });
  });

  describe("a provided requirement, bound by its consumer", () => {
    /* `tool` needs a `ts` something above it supplies. The catalog holds two —
     * 2.0.0 under its own name, which is what its resolution offers, and 1.0.0
     * under an alias. */
    const catalog =
      "package_repo @backing { }\ncatalog @cat { deps = @backing:tool @backing:ts:2.0.0 @backing:ts:1.0.0 -> ts1; }\n";
    const graph = (): void => {
      requirementTable.set("tool@1.0.0", [{ pkg: "ts", constraint: "*", provided: "expected" }]);
    };
    const versionsOf = (name: string): string[] =>
      [...new Set(reachablePackages(lastDepSets).filter(pkg => pkg.packageName === name).map(pkg => pkg.version!))].sort();
    const boundBy = (requirer: string, name: string): string[] => [
      ...new Set(
        reachablePackages(lastDepSets)
          .filter(pkg => pkg.packageName === requirer)
          .map(pkg => (pkg.getDependency(name) as PackageFileSet | undefined)?.version ?? "unbound")
      ),
    ];

    it("keeps what the resolution offers where nothing above supplies the name", async () => {
      const model = build(catalog + "test_deps a { deps = @cat:tool; }\n");
      graph();
      await model.getConfig(Constraints.of({}), execution).getTarget("a");
      expect(boundBy("tool", "ts")).to.deep.equal(["2.0.0"]);
    });

    it("binds the consuming target's own package of that name, and the offer leaves the installation", async () => {
      /* A strict collection: were the dropped offer still judged, `ts` would
       * ship at two versions and this would be refused. */
      const model = build(catalog + "test_deps a { deps = @cat:tool @cat:ts1 -> ts; }\n");
      graph();
      await model.getConfig(Constraints.of({}), execution).getTarget("a");
      expect(boundBy("tool", "ts")).to.deep.equal(["1.0.0"]);
      expect(versionsOf("ts")).to.deep.equal(["1.0.0"]);
    });

    it("binds what the dependent uses over what the build selects", async () => {
      /* `plugin` needs a `host` supplied; its dependent `suite` pins host 1.0.0
       * while the catalog's own is 2.0.0. The plugin shares its dependent's. */
      const model = build(
        "package_repo @backing { }\n" +
          "catalog @cat { deps = @backing:suite @backing:host:2.0.0 @backing:host:1.0.0?; }\n" +
          "test_deps a { deps = @cat:suite @cat:host; }\n"
      );
      requirementTable.set("suite@1.0.0", [
        { pkg: "plugin", constraint: "1.0.0" },
        { pkg: "host", constraint: "1.0.0" },
      ]);
      requirementTable.set("plugin@1.0.0", [{ pkg: "host", constraint: "*", provided: "expected" }]);
      await model.getConfig(Constraints.of({}), execution).getTarget("a");
      expect(boundBy("suite", "host")).to.deep.equal(["1.0.0"]);
      expect(boundBy("plugin", "host")).to.deep.equal(["1.0.0"]);
      expect(versionsOf("host")).to.deep.equal(["1.0.0", "2.0.0"]);
    });
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
    /* A rename at the USE site is what this requirer knows it by, so it — not
     * the member's own address — is what a generated manifest would record. */
    expect(lastDeclared).to.deep.equal([{ pkg: "foo", constraint: "1.0.0", alias: "renamed" }]);
    const repo = backings.get("@backing")!;
    expect(repo.requested).to.deep.equal(["foo"]);
    expect(repo.materialized).to.deep.equal(["foo"]);
  });

  it("pins two versions of one package side by side, each addressed by its written alias", async () => {
    /* The address is what must be unique in a catalog, not the package behind
     * it: an entry written with a rename is keyed — and delivered — under that
     * alias, so a second entry for the same package is an ordinary member
     * rather than a same-name conflict. */
    const model = build(
      "package_repo @backing { }\n" +
        "catalog @cat { deps = @backing:foo:1.0.0 @backing:foo:2.0.0 -> foo2; }\n" +
        "test_deps a { deps = @cat:foo @cat:foo2; }\n"
    );
    await model.getConfig(Constraints.of({}), execution).getTarget("a");
    const [one, two] = lastDepSets as PackageFileSet[];
    /* Each alias delivered its own pinned version, named as it is addressed —
     * so a consumer can mount both. */
    expect([one.packageName, one.version]).to.deep.equal(["foo", "1.0.0"]);
    expect([two.packageName, two.version]).to.deep.equal(["foo2", "2.0.0"]);
    /* One joint resolution over both entries, and each version fetched under
     * the package's own name: only the address is the alias's. */
    expect(backings.get("@backing")!.materialized).to.deep.equal(["foo", "foo"]);
    /* And a manifest generated for the consumer records each dep under the name
     * the consumer's own code imports it by — the address, with the package it
     * stands for carried as the alias. */
    expect(lastDeclared).to.deep.equal([
      { pkg: "foo", constraint: "1.0.0" },
      { pkg: "foo", constraint: "2.0.0", alias: "foo2" },
    ]);
  });

  it("reports two entries claiming one ALIAS as a conflict (the address, not the package)", async () => {
    const model = build(
      "package_repo @backing { }\n" +
        "catalog @cat { deps = @backing:foo -> shared @backing:bar -> shared; }\n" +
        "test_deps a { deps = @cat:shared; }\n"
    );
    try {
      await model.getConfig(Constraints.of({}), execution).getTarget("a");
      expect.fail("expected the duplicate alias to conflict");
    } catch (err) {
      const conflict = findCause(err, ConflictError);
      expect(conflict, "a ConflictError in the cause chain").to.not.be.undefined;
      expect(conflict!.key).to.equal("shared");
    }
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
