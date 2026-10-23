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
import { EMPTY_FILESET, FileSet, IFile } from "../core/FileSet";
import { Dependency, isPackage, PackageFileSet, ResolvedNode, packageNodeSignature, reachablePackages } from "../core/PackageFileSet";
import { TargetRef, Unbuilt } from "../core/TargetRef";
import { ResolvedTarget } from "../context/ResolvedTarget";
import { RunnableFileSet } from "../core/RunnableFileSet";
import { CatalogRepository, catalogRepositoryRegistration } from "./CatalogRepository";
import { patchedRule } from "./BuildPatched";
import { Repository, RepositoryRef } from "../core/Repository";
import { Requirement } from "../resolver/Types";
import { ConflictError, CycleError, FabrError, RequirementResolutionError } from "../core/Errors";
import { cycleErrorOf } from "../model/ErrorFormatter";
import { CircularDependencyError } from "../model/Errors";
import { MemoryFile } from "../core/MemoryFS";
import { BuildCache } from "../core/BuildCache";
import { Name } from "../core/Name";
import { permissive, ResolvedRequirements, TargetContext } from "../context/index";
import { Constraints, RUN_OVERRIDE } from "../model/Constraints";
import { BuildModel } from "../model/BuildModel";
import { ExecutionContext } from "../model/ExecutionContext";
import { parseBuildString, parseName } from "../model/Parser";
import { INameValue, syntheticValue } from "../model/AST";
import { StringReader } from "../support/StringReader";
import { toBuildModel } from "../model/Sema";
import { LogFormatter, LogLevel } from "../support/Log";
import { defineRule, PluginContribution, RuleDefinition } from "./Types";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SEMVER, SemverConstraint, SemverVersion, versionToString } from "../resolver/Semver";
import { IContentPackage, PackageFormat } from "../resolver/PackageFormat";
import { requestedConstraint, resolveBarePackage, vendPackageRef } from "../resolver/PackageResolver";
import { RepositoryReader, Resolved, SourceRef } from "../core/Repository";
import { expect } from "chai";

/** Group what `resolved` requires by name: a target's requirements, and
 * anything else as itself under no name, the shape `fabr deps` prints. */
function requirementsOf(resolved: ResolvedRequirements): Map<string, Resolved[]> {
  const sections = new Map<string, Resolved[]>();
  for (const source of resolved.denoted) {
    const entries: Array<[string, ReadonlyArray<Resolved>]> =
      source instanceof ResolvedTarget ? [...source.resolved.sources] : [["", [source]]];
    entries.forEach(([name, sources]) => sections.set(name, [...(sections.get(name) ?? []), ...sources]));
  }
  return sections;
}

/** Make `name` a reference written on the command line. */
function writtenOnCommandLine(name: string): INameValue {
  const source = { fs: EMPTY_FILESET, file: "<command-line>", reader: new StringReader(name) };
  return syntheticValue(parseName(name), source, 0, name.length);
}

/* getRepositoryRef vending is pure — an empty catalog suffices. */
const emptyCatalog = new CatalogRepository(
  "@cat",
  "build",
  Computable.resolve({
    entries: new Map(),
    collection: { requests: new Map(), resolutions: new Map(), locals: new Map(), members: new Map(), instances: new Set() },
  })
);

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

  it("reads a `?` or `!` ending the alias as a marker, and one ending a projection as the pattern's", () => {
    expect(emptyCatalog.getRepositoryRef(parseName("chai?")).override).to.equal("alternate");
    expect(emptyCatalog.getRepositoryRef(parseName("chai!")).name.toString()).to.equal("chai");
    const globbed = emptyCatalog.getRepositoryRef(parseName("typescript:bin/ts?"));
    expect(globbed.override).to.equal(undefined);
    expect(globbed.name.toString()).to.equal("typescript");
    expect(globbed.projections.map(p => p.pattern.toString())).to.deep.equal(["bin/ts?"]);
    expect(emptyCatalog.getRepositoryRef(parseName("typescript:README!")).projections.map(p => p.pattern.toString())).to.deep.equal(["README!"]);
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
    providedMismatch: "tolerate",
    splitReference: (name: Name) => {
      const written = name.toBaseString();
      const colon = written.lastIndexOf(":");
      if (colon === -1) {
        return { name: written, versionConstraint: "1.0.0" };
      }
      return { name: written.substring(0, colon), versionConstraint: written.substring(colon + 1) };
    },
    validateRequirement: () => undefined,
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
      return vendPackageRef(this, CAT_FORMAT, name);
    }

    public getRepositoryPublishRef(name: Name): never {
      throw new Error(`package_repo is not a publish destination ('${name.toString()}')`);
    }

    public environmentKey(): Computable<string> {
      return Computable.resolve("cattest-env");
    }

    /* Members are pinned and delivered as packages: a catalog resolves
     * build-shaped whatever it is consumed under. */
    /* These fakes stand in for a registry reached under an ordinary build. */
    public readonly operation = "build";

    public fetchFiles(reference: RepositoryRef): Computable<FileSet> {
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
  const depsRule: RuleDefinition = defineRule({
    type: "test_deps",
    properties: {},
    requirements: context => Computable.resolve({ deps: context.getPackageProperty("deps"), also: context.getPackageProperty("also") }),
    evaluateResolved: (context, requirements) =>
      requirements.materializeAll().then(({ deps, also }) =>
        context
          .getFileProperty("deps")
          .then(sources => context.collectDeclaredRequirements(sources))
          .then(declared => {
            lastDeclared = declared;
            lastDepSets = [...deps, ...also];
            lastDeps = FileSet.unionAll(...deps, ...also);
            return EMPTY_FILESET;
          })
      ),
  });
  let lastTool: FileSet | undefined;
  const runRule: RuleDefinition = defineRule({
    type: "test_run",
    properties: {},
    requirements: context => Computable.resolve({ tool: context.getPackageProperty("tool", RUN_OVERRIDE) }),
    evaluateResolved: (_context, requirements) =>
      requirements.materializeAll().then(({ tool }) => {
        lastTool = FileSet.unionAll(...tool);
        return Computable.resolve(EMPTY_FILESET);
      }),
  });
  /* Run a tool, read the two ways a rule reads one: a property naming it, and
   * a global naming it. A tool is no requirement of the target's. */
  const toolRule: RuleDefinition = {
    type: "test_usetool",
    properties: {},
    evaluate: context => context.getRunnableProperty("tool").then(() => EMPTY_FILESET),
  };
  /* Assembles its deps into a sealed install of its own, as a rule that
   * defines a program does: nothing links against them. */
  const sealedRule: RuleDefinition = defineRule({
    type: "test_sealed",
    properties: {},
    requirements: context => Computable.resolve(permissive({ deps: context.getPackageProperty("deps") })),
    evaluateResolved: (_context, requirements) => requirements.materializeAll().then(() => EMPTY_FILESET),
  });
  const globalToolRule: RuleDefinition = {
    type: "test_useglobal",
    properties: {},
    evaluate: context => context.getGlobalRunnable("TOOL").then(() => EMPTY_FILESET),
  };
  /* A locally built package: named as its target, unversioned, carrying its
   * `deps` as written — packages as packages, external requirements as inert
   * references — and its `provided` as provided requirements, as a
   * package-building rule delivers one. */
  const providedNames = (provided: ReadonlyArray<SourceRef>, optional: ReadonlyArray<Written>): Map<string, "expected" | "optional"> =>
    new Map([
      ...provided.flatMap(
        (source): Array<[string, "expected"]> => (source instanceof RepositoryRef ? [[source.localName, "expected"]] : [])
      ),
      ...optional.flatMap(({ opened }): Array<[string, "optional"]> =>
        isPackage(opened) ? [[opened.packageName, "optional"]] : opened instanceof RepositoryRef ? [[opened.localName, "optional"]] : []
      ),
    ]);
  /* Read `deps` and `provided`, each target among them as `open` gives it (its
   * node, or its build), and yield them with `provided` as read. */
  /** Each written source with what it opens to, and the `provided` sources. */
  interface Written {
    reference: SourceRef;
    opened: SourceRef | Unbuilt;
  }
  const written = (
    context: TargetContext,
    open: (target: TargetRef) => Computable<ReadonlyArray<SourceRef | Unbuilt>>
  ): Computable<[Written[], SourceRef[], Written[]]> =>
    Computable.forAll(
      [context.getFileProperty("deps"), context.getFileProperty("provided"), context.getFileProperty("optional")],
      (sources, provided, optional) => {
        const opening = (source: SourceRef): Computable<Written[]> =>
          (source instanceof TargetRef ? open(source) : Computable.resolve([source])).then(opened =>
            opened.map((each): Written => ({ reference: source, opened: each }))
          );
        return Computable.forAll(
          [Computable.forAll([...sources, ...provided].map(opening), (...all: Written[][]) => all.flat()), Computable.forAll(optional.map(opening), (...all: Written[][]) => all.flat())],
          (carried, optionals): [Written[], SourceRef[], Written[]] => [[...carried, ...optionals], provided, optionals]
        );
      }
    );
  /* The edges to what was opened: a package by the reference written for it,
   * a repository's reference as it stands. */
  const carriedAmong = (entries: ReadonlyArray<Written>): Dependency[] =>
    entries.flatMap(({ reference, opened }): Dependency[] =>
      isPackage(opened)
        ? [{ reference: reference as TargetRef | RepositoryRef, package: opened }]
        : opened instanceof RepositoryRef
        ? [{ reference: opened }]
        : []
    );
  const packageRule: RuleDefinition = {
    type: "test_pkg",
    properties: {},
    requirements: (context: TargetContext) =>
      Computable.resolve({
        dependencies: context.getPackageProperty("deps"),
        provided: context.getPackageProperty("provided"),
        optional_provided: context.getPackageProperty("optional"),
      }),
    evaluate: (context: TargetContext) =>
      written(context, target => target.materialize()).then(
        ([sources, provided, optional]) =>
          new PackageFileSet(
            new Map([[`${context.name}/data.txt`, contentOf(context.name)]]),
            context.name,
            undefined,
            carriedAmong(sources) as Array<Dependency<PackageFileSet>>,
            undefined,
            providedNames(provided, optional)
          )
      ),
  };
  /* A patch file, as a target: its text is what the test set for its name. */
  const patchTexts = new Map<string, string>();
  const patchRule: RuleDefinition = {
    type: "test_patch",
    properties: {},
    evaluate: (context: TargetContext) =>
      Computable.resolve(new FileSet(new Map([[`${context.name}.patch`, MemoryFile.from(patchTexts.get(context.name) ?? "")]]))),
  };
  /* Files that differ by configuration: one named for the `MODE` it is built in. */
  const modeRule: RuleDefinition = {
    type: "test_mode",
    properties: {},
    evaluate: (context: TargetContext) =>
      context
        .getGlobalString("MODE")
        .then(mode => new FileSet(new Map([[`${context.name}-${mode}.txt`, MemoryFile.from(mode)]]))),
  };
  /* Reads `srcs` for files and `deps` as packages, and holds what each was
   * materialized as. */
  let lastFiles: FileSet[] = [];
  const mixedRule: RuleDefinition = defineRule({
    type: "test_mixed",
    properties: {},
    requirements: context => Computable.resolve({ srcs: context.getFileProperty("srcs"), deps: context.getPackageProperty("deps") }),
    evaluateResolved: (_context, requirements) =>
      requirements.materializeAll().then(({ srcs, deps }) => {
        lastFiles = srcs;
        lastDepSets = deps;
        return EMPTY_FILESET;
      }),
  });
  /* Reads `extra` for its loose files alone. */
  const looseRule: RuleDefinition = defineRule({
    type: "test_loose",
    properties: {},
    requirements: context => Computable.resolve({ deps: context.getPackageProperty("deps"), extra: context.getLooseFileProperty("extra") }),
    evaluateResolved: (_context, requirements) =>
      requirements.materializeAll().then(({ deps, extra }) => {
        lastDepSets = deps;
        lastFiles = extra;
        return EMPTY_FILESET;
      }),
  });
  /* Yields a package and a set of files beside it. */
  const bothRule: RuleDefinition = {
    type: "test_both",
    properties: {},
    evaluate: (context: TargetContext) =>
      Computable.resolve([
        new PackageFileSet(new Map([["index.js", MemoryFile.from("")]]), context.name, "1.0.0"),
        new FileSet(new Map([["extra.txt", MemoryFile.from("")]])),
      ]),
  };
  /* Reads as packages a property its targetdef declares FILES. */
  const wrongTypeRule: RuleDefinition = defineRule({
    type: "test_wrongtype",
    properties: {},
    requirements: context => Computable.resolve({ srcs: context.getPackageProperty("srcs") }),
    evaluateResolved: (_context, requirements) => requirements.materializeAll().then(() => EMPTY_FILESET),
  });
  /* Reads for files a property its targetdef declares PACKAGES. */
  const filesOfRule: RuleDefinition = defineRule({
    type: "test_filesof",
    properties: {},
    requirements: context => Computable.resolve({ pkgs: context.getFileProperty("pkgs") }),
    evaluateResolved: (_context, requirements) =>
      requirements.materializeAll().then(({ pkgs }) => {
        lastFiles = pkgs;
        return EMPTY_FILESET;
      }),
  });
  /* States what it passes on from a list it read for files. */
  const misreadRule: RuleDefinition = defineRule({
    type: "test_misread",
    properties: {},
    requirements: context => Computable.resolve({ dependencies: context.getFileProperty("deps") }),
    evaluateResolved: (_context, requirements) => requirements.materializeAll().then(() => EMPTY_FILESET),
  });
  /* A package built against its deps: it collects them once, and carries what
   * they were delivered as. What a manifest would record of them is kept. */
  let builtDeclared: (Requirement | undefined)[] = [];
  const builtRule: RuleDefinition = defineRule({
    type: "test_built",
    properties: {},
    requirements: context => Computable.resolve({ dependencies: context.getPackageProperty("deps") }),
    evaluateResolved: (context, requirements) =>
      requirements.packages("dependencies").then(carried =>
        Computable.forAll([context.collectDeclaredRequirements(carried), context.getString("version")], (declared, version) => {
          builtDeclared = declared;
          return new PackageFileSet(new Map([[`${context.name}/data.txt`, contentOf(context.name)]]), context.name, version || undefined, carried);
        })
      ),
  });
  /* A package whose rule states what it passes on (`dependencies`), so it is
   * resolved with whatever requires it before it is built. `statedBuilt` names
   * those evaluated. */
  const statedBuilt: string[] = [];
  const packageCarrying = (name: string, files: Iterable<[string, IFile]>, deps: ReadonlyArray<Dependency<PackageFileSet>>): PackageFileSet =>
    new PackageFileSet(files, name, undefined, deps);
  const statedRule: RuleDefinition = defineRule({
    type: "test_stated",
    properties: {},
    requirements: context => Computable.resolve({ dependencies: context.getPackageProperty("deps") }),
    evaluateResolved: (context, requirements) =>
      requirements.packages("dependencies").then(deps => {
        statedBuilt.push(context.name);
        if (statedFailing.has(context.name)) {
          return Computable.reject(new FabrError(`${context.name} broke`));
        }
        return Computable.resolve(packageCarrying(context.name, new Map([[`${context.name}/data.txt`, contentOf(context.name)]]), deps));
      }),
  });
  /* The `test_stated` targets whose build fails. */
  const statedFailing = new Set<string>();
  /* A package carrying requirements its rule reads as private `deps` and does
   * not state it passes on. */
  const driftRule: RuleDefinition = defineRule({
    type: "test_drift",
    properties: {},
    requirements: context => Computable.resolve({ deps: context.getPackageProperty("deps") }),
    evaluateResolved: (context, requirements) =>
      requirements
        .packages("deps")
        .then(deps => Computable.resolve(packageCarrying(context.name, new Map([[`${context.name}/data.txt`, contentOf(context.name)]]), deps))),
  });
  /* A target that hands on the first package among its deps as its own build,
   * stating nothing it passes on. */
  const passRule: RuleDefinition = defineRule({
    type: "test_pass",
    properties: {},
    requirements: context => Computable.resolve({ deps: context.getPackageProperty("deps") }),
    evaluateResolved: (_context, requirements) => requirements.materializeAll().then(({ deps }) => Computable.resolve(deps[0])),
  });
  /* A target that collects its deps and hands the first to a sub-target. */
  const subRule: RuleDefinition = defineRule({
    type: "test_sub",
    properties: {},
    requirements: context => Computable.resolve({ deps: context.getPackageProperty("deps") }),
    evaluateResolved: (context, requirements) =>
      requirements.materializeAll().then(({ deps }) => context.subTarget("test_deps", { deps: [deps[0]] })),
  });
  const contributions: PluginContribution[] = [
    {
      rules: [depsRule, runRule, toolRule, globalToolRule, sealedRule, packageRule, patchRule, modeRule, mixedRule, misreadRule, wrongTypeRule, filesOfRule, bothRule, looseRule, patchedRule, passRule, subRule, builtRule, statedRule, driftRule],
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
    "targetdef catalog { deps = PACKAGES; }\n" +
    "targetdef package_repo { }\n" +
    "targetdef test_deps { deps = PACKAGES; also = PACKAGES; }\n" +
    "targetdef test_run { tool = PACKAGES; }\n" +
    "targetdef test_usetool { tool = PACKAGES; }\n" +
    "targetdef test_useglobal { }\n" +
    "targetdef test_sealed { deps = PACKAGES; }\n" +
    "targetdef test_pkg { deps = PACKAGES; provided = PACKAGES; optional = PACKAGES; }\n" +
    "targetdef test_patch { }\n" +
    "targetdef test_mode { }\n" +
    "targetdef test_mixed { srcs = FILES; deps = PACKAGES; }\n" +
    "targetdef test_misread { deps = PACKAGES; }\n" +
    "targetdef test_wrongtype { srcs = FILES; }\n" +
    "targetdef test_both { }\n" +
    "targetdef test_loose { deps = PACKAGES; extra = PACKAGES; }\n" +
    "targetdef test_filesof { pkgs = PACKAGES; }\n" +
    "targetdef test_pass { deps = PACKAGES; }\n" +
    "targetdef test_sub { deps = PACKAGES; }\n" +
    "targetdef test_built { deps = PACKAGES; version = STRING; }\n" +
    "targetdef test_stated { deps = PACKAGES; }\n" +
    "targetdef test_drift { deps = PACKAGES; }\n" +
    "targetdef patched { srcs = REQUIRED PACKAGES; patches = REQUIRED FILES; }\n";

  function build(source: string): BuildModel {
    backings.clear();
    requirementTable.clear();
    patchTexts.clear();
    ran.length = 0;
    statedBuilt.length = 0;
    statedFailing.clear();
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
    await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
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
    requirementTable.set("foo@1.0.0", [{ name: "bar", versionConstraint: "1.0.0" }]);
    await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
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
    requirementTable.set("foo@1.0.0", [{ name: "bar", versionConstraint: "1.0.0" }]);
    await model.getConfig(Constraints.of({ BUILD_OPERATION: "files" }), execution).materialize(writtenOnCommandLine("a"));
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
      requirementTable.set("a@1.0.0", [{ name: "x", versionConstraint: "^2.0.0" }]);
      requirementTable.set("b@1.0.0", [{ name: "y", versionConstraint: "1.0.0" }]);
      requirementTable.set("y@1.0.0", [{ name: "x", versionConstraint: "^1.0.0" }]);
    };

    it("delivers a subset that reaches only the version satisfying it", async () => {
      /* b's closure holds x@1.0.0 alone — an ordinary one-version install; the
       * principal x@2.0.0 is a's, and b's delivery does not reach it. */
      const model = build(source);
      graph();
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("only_b"));
      expect([...backings.get("@backing")!.fetched].sort()).to.deep.equal(["b@1.0.0", "x@1.0.0", "y@1.0.0"]);
    });

    it("still refuses a delivery that ships both versions together", async () => {
      const model = build(source);
      graph();
      let message = "";
      try {
        await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("both"));
      } catch (err) {
        for (let current: unknown = err; current instanceof Error; current = (current as { cause?: unknown }).cause) {
          message = current.message;
        }
      }
      expect(message).to.contain("x is required as '^1.0.0' and as '^2.0.0', and no one version is both");
      /* Explained as fully as one delivery's conflict: the winner's path and the
       * losing requirement's, each through the delivery that ships it. */
      expect(message).to.contain("'^2.0.0' required via: a@1.0.0");
      expect(message).to.contain("'^1.0.0' required via: b@1.0.0 -> y@1.0.0 (1.0.0)");
    });

    /** The deepest message and help a failed build of `name` carries. */
    async function failure(model: BuildModel, name: string): Promise<{ message: string; help: string }> {
      let message = "";
      let help = "";
      try {
        await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine(name));
      } catch (err) {
        for (let current: unknown = err; current instanceof Error; current = (current as { cause?: unknown }).cause) {
          message = current.message;
          help = current instanceof FabrError && current.help.length > 0 ? current.help.join("\n") : help;
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
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("both"));
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
      requirementTable.set("c@1.0.0", [{ name: "x", versionConstraint: "^3.0.0" }]);
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
        await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("mixed"));
      } catch (err) {
        for (let current: unknown = err; current instanceof Error; current = (current as { cause?: unknown }).cause) {
          message = current.message;
          help = current instanceof FabrError && current.help.length > 0 ? current.help.join("\n") : help;
        }
      }
      expect(message).to.contain("Resolution requires multiple versions of the same package:");
      expect(message).to.contain("x is required at 1.0.0 and 2.0.0");
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
      requirementTable.set("anthropic@1.0.0", [{ name: "langsmith", versionConstraint: "1.0.0" }]);
      requirementTable.set("classic@1.0.0", [
        { name: "langsmith", versionConstraint: "1.0.0" },
        { name: "openai", versionConstraint: "1.0.0" },
      ]);
      requirementTable.set("langsmith@1.0.0", [{ name: "openai", versionConstraint: "1.0.0", provided: "optional" }]);
    };
    const catalog = "package_repo @backing { }\ncatalog @cat { deps = @backing:anthropic @backing:classic; }\n";
    const langsmiths = (): PackageFileSet[] =>
      reachablePackages(lastDepSets).filter(pkg => pkg.packageName === "langsmith");

    it("binds the peer in an installation that holds it, making the two deliveries one node", async () => {
      const model = build(catalog + "test_deps a { deps = @cat:anthropic @cat:classic; }\n");
      graph();
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      const found = langsmiths();
      expect(found.length, "langsmith reached through both members").to.be.greaterThan(0);
      for (const pkg of found) {
        expect(pkg.getDependency("openai")?.package, "bound to the installation's openai").to.be.instanceOf(PackageFileSet);
      }
      expect(new Set(found.map(packageNodeSignature)).size, "one node").to.equal(1);
    });

    it("leaves the peer unbound, and unfetched, in an installation without it", async () => {
      const model = build(catalog + "test_deps a { deps = @cat:anthropic; }\n");
      graph();
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      const found = langsmiths();
      expect(found).to.have.lengthOf(1);
      expect(found[0].packages.map(pkg => pkg.packageName)).to.not.include("openai");
      /* What would answer it is recorded, as a reference nothing resolves. */
      const peer = found[0].getDependency("openai");
      expect([found[0].provided.get("openai"), peer?.reference.toString()]).to.deep.equal(["optional", "openai:1.0.0"]);
      expect(peer?.package).to.equal(undefined);
      expect(peer?.reference).to.be.instanceOf(RepositoryRef);
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
      requirementTable.set("tool@1.0.0", [{ name: "ts", versionConstraint: "*", provided: "expected" }]);
    };
    const versionsOf = (name: string): string[] =>
      [...new Set(reachablePackages(lastDepSets).filter(pkg => pkg.packageName === name).map(pkg => pkg.version!))].sort();
    const boundBy = (requirer: string, name: string): string[] => [
      ...new Set(
        reachablePackages(lastDepSets)
          .filter(pkg => pkg.packageName === requirer)
          .map(pkg => pkg.getDependency(name)?.package?.version ?? "unbound")
      ),
    ];

    it("keeps what the resolution offers where nothing above supplies the name", async () => {
      const model = build(catalog + "test_deps a { deps = @cat:tool; }\n");
      graph();
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      expect(boundBy("tool", "ts")).to.deep.equal(["2.0.0"]);
    });

    it("binds the consuming target's own package of that name, and the offer leaves the installation", async () => {
      /* A strict collection: were the dropped offer still judged, `ts` would
       * ship at two versions and this would be refused. */
      const model = build(catalog + "test_deps a { deps = @cat:tool @cat:ts1 -> ts; }\n");
      graph();
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
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
        { name: "plugin", versionConstraint: "1.0.0" },
        { name: "host", versionConstraint: "1.0.0" },
      ]);
      requirementTable.set("plugin@1.0.0", [{ name: "host", versionConstraint: "*", provided: "expected" }]);
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
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
    await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
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
    await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
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
    await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
    const delivered = lastDepSets[0] as PackageFileSet;
    expect(delivered).to.be.instanceOf(PackageFileSet);
    expect(delivered.packageName).to.equal("renamed");
    /* Only the identity is the rename's: the content is the pinned member's,
     * and the member was resolved and fetched under its own name. */
    expect(await delivered.readFile("foo/data.txt")).to.equal("foo");
    /* A rename at the USE site is what this requirer knows it by, so it — not
     * the member's own address — is what a generated manifest would record. */
    expect(lastDeclared).to.deep.equal([{ name: "foo", versionConstraint: "1.0.0", renameTo: "renamed" }]);
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
    await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
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
      { name: "foo", versionConstraint: "1.0.0" },
      { name: "foo", versionConstraint: "2.0.0", renameTo: "foo2" },
    ]);
  });

  it("delivers a renamed requirement as a package of its own, beside another version of the one it renames", async () => {
    /* One version per name, and the name is the one after renaming: foo's
     * `semver-old` keeps its own minimum beside the consumer's semver, and the
     * two are no divergence for the strict check to refuse. */
    const model = build("package_repo @backing { }\n" + "test_deps a { deps = @backing:foo @backing:semver:7.6.0; }\n");
    requirementTable.set("foo@1.0.0", [{ name: "semver", versionConstraint: "^7.5.0", renameTo: "semver-old" }]);
    await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
    const [foo, semver] = lastDepSets as PackageFileSet[];
    expect(semver.packageId).to.equal("semver@7.6.0");
    expect(foo.packages.map(dep => dep.packageId)).to.deep.equal(["semver-old@7.5.0"]);
    /* Its content is the package's it renames, asked of the registry by that name. */
    expect(await (foo.packages[0]).readFile("semver/data.txt")).to.equal("semver");
    expect([...backings.get("@backing")!.fetched].sort()).to.deep.equal(["foo@1.0.0", "semver@7.5.0", "semver@7.6.0"]);
  });

  it("reports two entries claiming one ALIAS as a conflict (the address, not the package)", async () => {
    /* One name is one package: the registry's joint resolution refuses it,
     * attributed to the entries that wrote it. */
    const model = build(
      "package_repo @backing { }\n" +
        "catalog @cat { deps = @backing:foo -> shared @backing:bar -> shared; }\n" +
        "test_deps a { deps = @cat:shared; }\n"
    );
    try {
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      expect.fail("expected the duplicate alias to conflict");
    } catch (err) {
      const failure = findCause(err, RequirementResolutionError);
      expect(failure, "a RequirementResolutionError in the cause chain").to.not.be.undefined;
      expect(failure!.message).to.contain("'shared' is required as two different packages");
      expect(failure!.refs.map(ref => ref.toString()).sort()).to.deep.equal(["bar:1.0.0 -> shared", "foo:1.0.0 -> shared"]);
    }
  });

  describe("a locally built member", () => {
    /** The names a delivered package's dependencies resolved to; an edge still
     * an inert reference shows as `ref:<name>`. */
    const edges = (pkg: PackageFileSet): string[] =>
      pkg.dependencies.map(dep => (dep.package ? dep.package.packageId : `ref:${dep.reference.toString()}`));

    it("delivers a directly listed package with its requirements resolved (the baseline)", async () => {
      const model = build("package_repo @backing { }\n" + "test_pkg lib { deps = @backing:bar; }\n" + "test_deps a { deps = lib; }\n");
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      expect(edges(lastDepSets[0] as PackageFileSet)).to.deep.equal(["bar@1.0.0"]);
      expect(backings.get("@backing")!.fetched).to.deep.equal(["bar@1.0.0"]);
    });

    it("delivers it through the catalog with its requirements resolved", async () => {
      const model = build(
        "package_repo @backing { }\n" +
          "test_pkg lib { deps = @backing:bar; }\n" +
          "catalog @cat { deps = @backing:foo lib; }\n" +
          "test_deps a { deps = @cat:lib; }\n"
      );
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      const delivered = lastDepSets[0] as PackageFileSet;
      expect(delivered.packageName).to.equal("lib");
      expect(edges(delivered)).to.deep.equal(["bar@1.0.0"]);
      /* Only what the named member reaches is fetched: foo is pinned, not named. */
      expect(backings.get("@backing")!.fetched).to.deep.equal(["bar@1.0.0"]);
    });

    it("selects the member's requirements jointly with the catalog's own entries", async () => {
      const model = build(
        "package_repo @backing { }\n" +
          "test_pkg lib { deps = @backing:foo; }\n" +
          "catalog @cat { deps = @backing:bar:1.2.0 lib; }\n" +
          "test_deps a { deps = @cat:lib @cat:bar; }\n"
      );
      requirementTable.set("foo@1.0.0", [{ name: "bar", versionConstraint: "^1.0.0" }]);
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      const [lib, bar] = lastDepSets as PackageFileSet[];
      /* What the member reaches is bound by the catalog's own pin. */
      expect(edges(lib)).to.deep.equal(["foo@1.0.0"]);
      expect(edges(lib.packages[0])).to.deep.equal(["bar@1.2.0"]);
      expect(bar.packageId).to.equal("bar@1.2.0");
      /* Each delivery fetches what it reaches; no other version of bar is among them. */
      expect([...new Set(backings.get("@backing")!.fetched)].sort()).to.deep.equal(["bar@1.2.0", "foo@1.0.0"]);
      /* The consumer's manifest records the member as declared: unversioned. */
      expect(lastDeclared[0]).to.deep.equal({ name: "lib", versionConstraint: undefined });
      expect(lib.version).to.equal(undefined);
    });

    it("brings a built package the member depends on into the same resolution", async () => {
      const model = build(
        "package_repo @backing { }\n" +
          "test_pkg base { deps = @backing:bar; }\n" +
          "test_pkg lib { deps = base; }\n" +
          "catalog @cat { deps = lib; }\n" +
          "test_deps a { deps = @cat:lib; }\n"
      );
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      const lib = lastDepSets[0] as PackageFileSet;
      expect(edges(lib)).to.deep.equal(["base@*"]);
      expect(edges(lib.packages[0])).to.deep.equal(["bar@1.0.0"]);
    });

    it("delivers a built package reached through another once, whichever way it is also named", async () => {
      for (const deps of ["outer", "outer lib", "lib outer"]) {
        const model = build(
          "package_repo @backing { }\n" +
            "test_pkg lib { deps = @backing:foo; }\n" +
            "test_pkg outer { deps = lib; }\n" +
            `test_deps a { deps = ${deps}; }\n`
        );
        await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
        expect(backings.get("@backing")!.fetched, deps).to.deep.equal(["foo@1.0.0"]);
        /* One lib in the installation, with its requirement resolved. */
        const libs = reachablePackages(lastDepSets).filter(pkg => pkg.packageName === "lib");
        expect(new Set(libs).size, deps).to.equal(1);
        expect(edges(libs[0]), deps).to.deep.equal(["foo@1.0.0"]);
      }
    });

    it("takes a marker the member wrote on its own requirement as the member's, not the catalog's", async () => {
      /* The member's requirement is a transitive one here, as a published
       * package's would be: its `!` forced the member's own build and forces
       * nothing for anyone the catalog serves. */
      const model = build(
        "package_repo @backing { }\n" +
          "test_pkg lib { deps = @backing:bar:1.0.0!; }\n" +
          "catalog @cat { deps = @backing:foo lib @backing:bar:2.0.0? @backing:bar:1.0.0?; }\n" +
          "test_deps a { deps = @cat:lib @cat:foo; }\n"
      );
      requirementTable.set("foo@1.0.0", [{ name: "bar", versionConstraint: "^2.0.0" }]);
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      const [lib, foo] = lastDepSets as PackageFileSet[];
      expect(edges(lib)).to.deep.equal(["bar@1.0.0"]);
      expect(edges(foo)).to.deep.equal(["bar@2.0.0"]);
    });

    it("pins a carried requirement without making it a member", async () => {
      const model = build(
        "package_repo @backing { }\n" +
          "test_pkg lib { deps = @backing:bar; }\n" +
          "catalog @cat { deps = lib; }\n" +
          "test_deps a { deps = @cat:bar; }\n"
      );
      try {
        await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
        expect.fail("expected bar to be no member of the catalog");
      } catch (err) {
        expect(findCause(err, RequirementResolutionError)!.message).to.contain("Catalog @cat has no member 'bar'");
      }
    });

    it("reports a member that takes a requirement from the catalog itself as a cycle", async () => {
      /* The catalog's pin needs the member built, and the member names the
       * catalog: a dependency loop, in whichever configuration it closes. */
      const source =
        "package_repo @backing { }\n" +
        "test_pkg lib { deps = @cat:bar; }\n" +
        "catalog @cat { deps = @backing:bar:1.2.0 lib; }\n" +
        "test_deps a { deps = @cat:lib; }\n";
      for (const constraints of [Constraints.of({}), Constraints.of({ BUILD_OPERATION: "build" })]) {
        try {
          await build(source).getConfig(constraints, execution).materialize(writtenOnCommandLine("a"));
          expect.fail("expected the loop through the catalog to be reported");
        } catch (err) {
          const cycle = findCause(err, CycleError);
          expect(cycle, "a CycleError in the cause chain").to.not.be.undefined;
          const circular = findCause(cycleErrorOf(cycle!.labels), CircularDependencyError);
          /* Both halves are written references: the catalog's entry, and the
           * member's own reference back into the catalog. */
          expect(circular!.cycle.map(site => site.value.value.toString()).sort()).to.deep.equal(["@cat:bar", "lib"]);
        }
      }
    });

    it("resolves over what the member's rule states, and builds it only to deliver it", async () => {
      const model = build(
        "package_repo @backing { }\n" +
          "test_stated lib { deps = @backing:bar; }\n" +
          "catalog @cat { deps = @backing:foo lib; }\n" +
          "test_deps a { deps = @cat:foo; }\n" +
          "test_deps b { deps = @cat:lib; }\n"
      );
      const config = model.getConfig(Constraints.of({}), execution);
      await config.materialize(writtenOnCommandLine("a"));
      /* The whole catalog was resolved, the member's requirement included. */
      expect([...new Set(backings.get("@backing")!.requested)].sort()).to.deep.equal(["bar", "foo"]);
      expect(statedBuilt).to.deep.equal([]);

      await config.materialize(writtenOnCommandLine("b"));
      expect(statedBuilt).to.deep.equal(["lib"]);
      const delivered = lastDepSets[0] as PackageFileSet;
      expect(await delivered.readFile("lib/data.txt")).to.equal("lib");
      expect(edges(delivered)).to.deep.equal(["bar@1.0.0"]);
    });

    it("builds only the members a delivery reaches, wired by the catalog's selection", async () => {
      const model = build(
        "package_repo @backing { }\n" +
          "test_stated lib { deps = @backing:foo; }\n" +
          "test_stated other { }\n" +
          "catalog @cat { deps = @backing:bar:1.2.0 lib other; }\n" +
          "test_deps a { deps = @cat:lib; }\n"
      );
      requirementTable.set("foo@1.0.0", [{ name: "bar", versionConstraint: "^1.0.0" }]);
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      expect(statedBuilt).to.deep.equal(["lib"]);
      const lib = lastDepSets[0] as PackageFileSet;
      expect(await lib.readFile("lib/data.txt")).to.equal("lib");
      expect(edges(lib)).to.deep.equal(["foo@1.0.0"]);
      expect(edges(lib.packages[0])).to.deep.equal(["bar@1.2.0"]);
    });

    it("builds a member another member depends on, with it", async () => {
      const model = build(
        "test_stated base { }\n" +
          "test_stated lib { deps = base; }\n" +
          "catalog @cat { deps = lib; }\n" +
          "test_deps a { deps = @cat:lib; }\n"
      );
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      const lib = lastDepSets[0] as PackageFileSet;
      expect(await lib.readFile("lib/data.txt")).to.equal("lib");
      expect(await lib.packages[0].readFile("base/data.txt")).to.equal("base");
    });

    it("fetches no file a projection selects for a reading, and fetches it for a build", async () => {
      const model = build(
        "package_repo @backing { }\n" +
          "catalog @cat { deps = @backing:foo; }\n" +
          "test_stated app { deps = @cat:foo:foo/data.txt; }\n" +
          "test_deps a { deps = @cat:foo:foo/data.txt; }\n"
      );
      const name = "app";
      const written = syntheticValue(
        parseName(name),
        { fs: EMPTY_FILESET, file: "<command-line>", reader: new StringReader(name) },
        0,
        name.length
      );
      const config = model.getConfig(Constraints.of({}), execution);
      await config.resolve(written);
      expect(backings.get("@backing")!.fetched).to.deep.equal([]);
      await config.materialize(writtenOnCommandLine("a"));
      expect(await lastDeps!.readFile("foo/data.txt")).to.equal("foo");
      expect(backings.get("@backing")!.fetched).to.deep.equal(["foo@1.0.0"]);
    });

    it("builds no member for a reading that projects into one", async () => {
      const model = build(
        "test_stated lib { }\n" + "catalog @cat { deps = lib; }\n" + "test_stated app { deps = @cat:lib:lib/data.txt; }\n"
      );
      const name = "app";
      const written = syntheticValue(
        parseName(name),
        { fs: EMPTY_FILESET, file: "<command-line>", reader: new StringReader(name) },
        0,
        name.length
      );
      await model.getConfig(Constraints.of({}), execution).resolve(written);
      expect(statedBuilt).to.deep.equal([]);
    });

    it("refuses a member built in the project as a runnable, naming the catalog, before building it", async () => {
      const model = build("test_stated lib { }\n" + "catalog @cat { deps = lib; }\n" + "test_run a { tool = @cat:lib; }\n");
      try {
        await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
        expect.fail("expected the member to be refused as a runnable");
      } catch (err) {
        expect((rootCauseOf(err) as Error).message).to.equal(
          "@cat member 'lib' is built in this project, which @cat cannot deliver as a runnable"
        );
        expect(statedBuilt).to.deep.equal([]);
      }
    });

    describe("a tool whose own closure needs two versions of one package", () => {
      /* tool needs a and b, which need x at ^2.0.0 and (through y) at ^1.0.0:
       * no one version of x is both. A program is a sealed install, so that
       * is its own business; something linked against it is not. */
      const source =
        "package_repo @backing { }\ncatalog @cat { deps = @backing:tool; }\nTOOL = @cat:tool;\n" +
        "test_deps linked { deps = @cat:tool; }\n" +
        "test_sealed sealed { deps = @cat:tool; }\n" +
        "test_usetool byproperty { tool = @cat:tool; }\n" +
        "test_useglobal byglobal { }\n";
      const graph = (): void => {
        requirementTable.set("tool@1.0.0", [
          { name: "a", versionConstraint: "^1.0.0" },
          { name: "b", versionConstraint: "^1.0.0" },
        ]);
        requirementTable.set("a@1.0.0", [{ name: "x", versionConstraint: "^2.0.0" }]);
        requirementTable.set("b@1.0.0", [{ name: "y", versionConstraint: "1.0.0" }]);
        requirementTable.set("y@1.0.0", [{ name: "x", versionConstraint: "^1.0.0" }]);
      };
      const outcome = (name: string, operation: string): Promise<string> => {
        const model = build(source);
        graph();
        return Promise.resolve(model.getConfig(Constraints.of({ BUILD_OPERATION: operation }), execution).materialize(writtenOnCommandLine(name))).then(
          () => "accepted",
          (err: Error) => (rootCauseOf(err) as Error).message.split("\n")[0]
        );
      };
      const REFUSED = "Resolution requires multiple versions of the same package:";

      it("is refused where a target requires it as a dependency", async () => {
        expect(await outcome("linked", "build")).to.equal(REFUSED);
      });

      it("is accepted where a rule materializes its requirements as a sealed install", async () => {
        expect(await outcome("sealed", "build")).to.equal("accepted");
      });

      it("is accepted where a rule reads it as a tool, by property or by global", async () => {
        expect(await outcome("byproperty", "build")).to.equal("accepted");
        expect(await outcome("byglobal", "build")).to.equal("accepted");
      });

      it("is accepted where it is the program named to run", async () => {
        expect(await outcome("@cat:tool", "run")).to.equal("accepted");
      });
    });

    it("states what each edge of a reading asks for", async () => {
      const model = build("package_repo @backing { }\n" + "test_stated app { deps = @backing:foo:1.0.0; }\n");
      requirementTable.set("foo@1.0.0", [{ name: "bar", versionConstraint: "^1.0.0" }]);
      const name = "app";
      const written = syntheticValue(
        parseName(name),
        { fs: EMPTY_FILESET, file: "<command-line>", reader: new StringReader(name) },
        0,
        name.length
      );
      const [target] = (await model.getConfig(Constraints.of({}), execution).resolve(written)).denoted;
      const [foo] = (target as ResolvedTarget).resolved.sources.get("dependencies") as PackageFileSet[];
      const [fooReference] = (target as ResolvedTarget).resolved.references.get("dependencies")!;
      expect(requestedConstraint(fooReference)).to.equal("1.0.0");
      expect(requestedConstraint(foo.dependencies[0].reference)).to.equal("^1.0.0");
    });

    it("delivers a member as stated, unbuilt, to a reading of what is required", async () => {
      const model = build(
        "package_repo @backing { }\n" +
          "test_stated lib { deps = @backing:bar; }\n" +
          "catalog @cat { deps = lib; }\n" +
          "test_stated app { deps = @cat:lib; }\n"
      );
      const name = "app";
      const written = syntheticValue(
        parseName(name),
        { fs: EMPTY_FILESET, file: "<command-line>", reader: new StringReader(name) },
        0,
        name.length
      );
      const parts = requirementsOf(await model.getConfig(Constraints.of({}), execution).resolve(written));
      const [lib] = parts.get("dependencies") as PackageFileSet[];
      expect(lib.packageName).to.equal("lib");
      expect(edges(lib)).to.deep.equal(["bar@1.0.0"]);
      expect(statedBuilt).to.deep.equal([]);
    });

    it("delivers a member that projects into another of the project's packages", async () => {
      const model = build(
        "test_stated base { }\n" +
          "test_stated lib { deps = base:base/data.txt; }\n" +
          "catalog @cat { deps = lib; }\n" +
          "test_deps a { deps = @cat:lib; }\n"
      );
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      const lib = lastDepSets[0] as PackageFileSet;
      expect(await lib.readFile("lib/data.txt")).to.equal("lib");
      expect(lib.packages).to.deep.equal([]);
    });

    it("reports a member's failed build as that build's failure, not as the catalog's", async () => {
      const model = build("test_stated lib { }\n" + "catalog @cat { deps = lib; }\n" + "test_deps a { deps = @cat:lib; }\n");
      statedFailing.add("lib");
      try {
        await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
        expect.fail("expected lib's build to fail");
      } catch (err) {
        expect(findCause(err, RequirementResolutionError), "no resolution failure in the cause chain").to.be.undefined;
        const cause = rootCauseOf(err);
        expect((cause as Error).message).to.equal("lib broke");
      }
    });

    it("refuses a member built with a requirement its rule did not state", async () => {
      const model = build(
        "test_stated base { }\n" +
          "test_drift lib { deps = base; }\n" +
          "catalog @cat { deps = lib; }\n" +
          "test_deps a { deps = @cat:lib; }\n"
      );
      try {
        await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
        expect.fail("expected the disagreement to be reported");
      } catch (err) {
        const cause = rootCauseOf(err);
        expect((cause as Error).message).to.match(
          /'lib' builds a package requiring 'base', which its rule does not state/
        );
      }
    });

    it("reports a stated member that takes a requirement from the catalog itself as a cycle", async () => {
      const model = build(
        "package_repo @backing { }\n" +
          "test_stated lib { deps = @cat:bar; }\n" +
          "catalog @cat { deps = @backing:bar:1.2.0 lib; }\n" +
          "test_deps a { deps = @cat:lib; }\n"
      );
      try {
        await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
        expect.fail("expected the loop through the catalog to be reported");
      } catch (err) {
        expect(findCause(err, CycleError), "a CycleError in the cause chain").to.not.be.undefined;
      }
    });

    it("delivers a requirement the member takes from another catalog, at that catalog's pin", async () => {
      const model = build(
        "package_repo @backing { }\n" +
          "catalog @other { deps = @backing:bar:1.1.0; }\n" +
          "test_pkg lib { deps = @other:bar; }\n" +
          "catalog @cat { deps = @backing:bar:1.2.0 lib; }\n" +
          "test_deps a { deps = @cat:lib; }\n"
      );
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      expect(edges(lastDepSets[0] as PackageFileSet)).to.deep.equal(["bar@1.1.0"]);
    });
  });

  describe("a built package's provided requirement", () => {
    const edges = (pkg: PackageFileSet): string[] =>
      pkg.dependencies.map(dep => (dep.package ? dep.package.packageId : `ref:${dep.reference.toString()}`));
    const versionsOf = (name: string): string[] =>
      [...new Set(reachablePackages(lastDepSets).filter(pkg => pkg.packageName === name).map(pkg => pkg.version!))].sort();

    it("is answered by what its reference resolves to where nothing above supplies the name", async () => {
      const model = build(
        "package_repo @backing { }\n" + "test_pkg lib { provided = @backing:host; }\n" + "test_deps a { deps = lib; }\n"
      );
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      const lib = lastDepSets[0] as PackageFileSet;
      expect(edges(lib)).to.deep.equal(["host@1.0.0"]);
      expect([...lib.provided].map(([name, expected]) => [expected, lib.getDependency(name)!.package!.packageId])).to.deep.equal([
        ["expected", "host@1.0.0"],
      ]);
    });

    it("binds the consuming target's own package of that name, whatever supplies it", async () => {
      /* The consumer's `host` comes from another repository, which the one
       * resolving the package's own reference cannot see. */
      const model = build(
        "package_repo @backing { }\n" +
          "package_repo @other { }\n" +
          "test_pkg lib { provided = @backing:host:1.0.0; }\n" +
          "test_deps a { deps = lib @other:host:2.0.0; }\n"
      );
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      expect(edges(lastDepSets[0] as PackageFileSet)).to.deep.equal(["host@2.0.0"]);
      expect(versionsOf("host")).to.deep.equal(["2.0.0"]);
    });

    it("demands nothing where its repository already selects the package", async () => {
      /* The consumer's own requirement is the selection; the package's is
       * bound to it, out of range or not, and no second version is selected
       * to answer it. */
      const model = build(
        "package_repo @backing { }\n" +
          "test_pkg lib { provided = @backing:host:2.0.0; }\n" +
          "test_deps a { deps = lib @backing:host:1.0.0; }\n"
      );
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      expect(edges(lastDepSets[0] as PackageFileSet)).to.deep.equal(["host@1.0.0"]);
      expect(backings.get("@backing")!.fetched).to.deep.equal(["host@1.0.0"]);
    });

    it("binds what the dependent of the package uses", async () => {
      const model = build(
        "package_repo @backing { }\n" +
          "package_repo @other { }\n" +
          "test_pkg plugin { provided = @backing:host:1.0.0; }\n" +
          "test_pkg suite { deps = plugin @other:host:2.0.0; }\n" +
          "test_deps a { deps = suite; }\n"
      );
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      const suite = lastDepSets[0] as PackageFileSet;
      const plugin = suite.getDependency("plugin")!.package!;
      expect(edges(plugin)).to.deep.equal(["host@2.0.0"]);
    });

    it("is pinned by a catalog that lists the package, and still bound by the consumer", async () => {
      const model = build(
        "package_repo @backing { }\n" +
          "test_pkg lib { provided = @backing:host:1.0.0; }\n" +
          "catalog @cat { deps = lib @backing:host:2.0.0 -> host2; }\n" +
          "test_deps a { deps = @cat:lib @cat:host2 -> host; }\n"
      );
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      expect(edges(lastDepSets[0] as PackageFileSet)).to.deep.equal(["host@2.0.0"]);
    });
  });

  describe("a built package's optional provided requirement", () => {
    const edges = (pkg: PackageFileSet): string[] =>
      pkg.dependencies.map(dep => (dep.package ? dep.package.packageId : `ref:${dep.reference.toString()}`));
    const delivered = (name: string): string[] =>
      [...new Set(reachablePackages(lastDepSets).filter(pkg => pkg.packageName === name).map(pkg => pkg.packageId))].sort();

    it("is bound to the consumer's own package of that name", async () => {
      const model = build("test_pkg host { }\n" + "test_pkg lib { optional = host; }\n" + "test_deps a { deps = lib host; }\n");
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      const lib = lastDepSets.find(set => set instanceof PackageFileSet && set.packageName === "lib") as PackageFileSet;
      expect(lib.provided.get("host")).to.equal("optional");
      expect(edges(lib)).to.deep.equal(["host@*"]);
    });

    it("is left unbound, installing nothing, where the consumer has none", async () => {
      /* lib was built against host, but that copy is not what an optional
       * requirement is answered by. */
      const model = build("test_pkg host { }\n" + "test_pkg lib { optional = host; }\n" + "test_deps a { deps = lib; }\n");
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      expect(edges(lastDepSets[0] as PackageFileSet)).to.deep.equal(["ref:host"]);
      expect(delivered("host")).to.deep.equal([]);
    });

    it("installs nothing from its repository unless the consumer selects the package", async () => {
      /* lib's own build is compiled against host; its consumer gets none. */
      const model = build(
        "package_repo @backing { }\n" + "test_pkg lib { optional = @backing:host:1.0.0; }\n" + "test_deps a { deps = lib; }\n"
      );
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      expect(delivered("host")).to.deep.equal([]);
    });

    it("is bound to the consumer's own selection from the repository", async () => {
      const model = build(
        "package_repo @backing { }\n" +
          "test_pkg lib { optional = @backing:host:1.0.0; }\n" +
          "test_deps a { deps = lib @backing:host:1.0.0; }\n"
      );
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      expect(delivered("host")).to.deep.equal(["host@1.0.0"]);
    });
  });

  describe("two exact pins of one package", () => {
    /** The first line of every message down the failure's chain of causes, or
     * the versions delivered where there is none. */
    const outcome = async (model: BuildModel): Promise<string> => {
      try {
        await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      } catch (err) {
        const messages: string[] = [];
        for (let current: unknown = err; current instanceof Error; current = (current as { cause?: unknown }).cause) {
          messages.push(current.message, ...((current as { help?: string[] }).help ?? []));
        }
        return messages.join("\n");
      }
      return [...new Set(reachablePackages(lastDepSets).map(pkg => pkg.packageId))].sort().join(" ");
    };
    const libs = "package_repo @backing { }\n" + "test_pkg old { deps = @backing:bar:1.0.0; }\n" + "test_pkg new { deps = @backing:bar:1.2.0; }\n";

    it("written by the packages a target uses are requirements like any transitive one, and sanction nothing", async () => {
      const failure = await outcome(build(libs + "test_deps a { deps = old new; }\n"));
      /* Reported as it is for two published packages: against the package that
       * made the requirement — a node of the graph like any other — with the
       * entries that would permit it. */
      expect(failure).to.contain("bar is required as '1.0.0' and as '1.2.0', and no one version is both");
      expect(failure).to.contain("'1.0.0' required via: old\n");
      expect(failure).to.contain("'1.2.0' required via: new\n");
      expect(failure).to.contain("add to the failing deps (or a shared catalog): @backing:bar:1.2.0? @backing:bar:1.0.0?");
    });

    it("ship together once the target itself permits both", async () => {
      const permitted = libs + "test_deps a { deps = old new @backing:bar:1.0.0? @backing:bar:1.2.0?; }\n";
      expect(await outcome(build(permitted))).to.equal("bar@1.0.0 bar@1.2.0 new@* old@*");
    });

    it("are resolved with their conflicts, and refused where the target is built", async () => {
      const config = build(libs + "test_deps a { deps = old new; }\n").getConfig(Constraints.of({}), execution);
      const [target] = (await config.resolve(writtenOnCommandLine("a"))).denoted;
      expect(target).to.be.instanceOf(ResolvedTarget);
      expect([...(target as ResolvedTarget).resolved.conflicts.versions].map(([pkg, versions]) => [pkg, [...versions].sort()])).to.deep.equal([["bar", ["1.0.0", "1.2.0"]]]);
      expect(await outcome(build(libs + "test_deps a { deps = old new; }\n"))).to.contain("no one version is both");
    });

    it("are not completed by a pin one of those packages wrote", async () => {
      /* The target permits 1.0.0; the other version is `new`'s requirement,
       * which the target has not vouched for. */
      const failure = await outcome(build(libs + "test_deps a { deps = old new @backing:bar:1.0.0?; }\n"));
      expect(failure).to.contain("required bar versions: 1.0.0, 1.2.0 — allowed: 1.0.0; add @backing:bar:1.2.0?");
    });

    it("permit a version beside the target's own pin of the other", async () => {
      const pinned = libs + "test_deps a { deps = old @backing:bar:1.2.0 @backing:bar:1.0.0?; }\n";
      expect(await outcome(build(pinned))).to.equal("bar@1.0.0 bar@1.2.0 old@*");
    });

    it("of a package a target uses does not carry that package's own permissions to the target", async () => {
      const model = build(
        "package_repo @backing { }\n" +
          "test_pkg lib { deps = @backing:foo @backing:bar:1.2.0? @backing:bar:1.0.0?; }\n" +
          "test_deps a { deps = lib @backing:bar:1.2.0; }\n"
      );
      requirementTable.set("foo@1.0.0", [{ name: "bar", versionConstraint: "1.0.0" }]);
      const failure = await outcome(model);
      expect(failure).to.contain("add @backing:bar:1.0.0?");
    });

    it("are one version where they agree", async () => {
      const model = build("package_repo @backing { }\n" + "test_pkg old { deps = @backing:bar:1.2.0; }\n" + "test_deps a { deps = old @backing:bar:1.2.0; }\n");
      expect(await outcome(model)).to.equal("bar@1.2.0 old@*");
    });
  });

  describe("a package a rule hands on", () => {
    const edges = (pkg: PackageFileSet): string[] =>
      pkg.dependencies.map(dep => (dep.package ? dep.package.packageId : `ref:${dep.reference.toString()}`));

    it("is refused where it requires something its rule did not state", async () => {
      /* `through` builds foo, whose requirement on bar its rule does not state,
       * so nothing resolved it with a's pin. */
      const model = build(
        "package_repo @backing { }\n" + "test_pass through { deps = @backing:foo; }\n" + "test_deps a { deps = through @backing:bar:1.2.0; }\n"
      );
      requirementTable.set("foo@1.0.0", [{ name: "bar", versionConstraint: "^1.0.0" }]);
      const failure = await Promise.resolve(
        model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"))
      ).then(
        () => undefined,
        (err: Error) => err
      );
      expect((rootCauseOf(failure) as Error).message).to.equal("'through' builds a package requiring 'bar', which its rule does not state");
    });

    for (const [route, deps] of [
      ["directly", "base"],
      ["through a catalog", "@cat:base"],
    ]) {
      it(`declares a package built in the project at the version it is built with, required ${route}`, async () => {
        const model = build(`test_built base { version = 1.2.3; }\ncatalog @cat { deps = base; }\ntest_built app { deps = ${deps}; }\n`);
        await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("app"));
        expect(builtDeclared).to.deep.equal([{ name: "base", versionConstraint: "1.2.3" }]);
      });

      it(`declares no version for a package built without one, required ${route}`, async () => {
        const model = build(`test_built base { }\ncatalog @cat { deps = base; }\ntest_built app { deps = ${deps}; }\n`);
        await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("app"));
        expect(builtDeclared).to.deep.equal([{ name: "base", versionConstraint: undefined }]);
      });
    }

    const refusal = (model: BuildModel): Promise<string | undefined> =>
      Promise.resolve(model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"))).then(
        () => undefined,
        (err: Error) => (rootCauseOf(err) as Error).message
      );

    it("refuses a registry's package bound, by its name, to a target that builds no package", async () => {
      /* foo requires a package called `notes`, and the project has a target
       * of that name, so the requirement is bound to it. What the target
       * builds is known when it is built, and it is no package. */
      const model = build("package_repo @backing { }\n" + "test_patch notes { }\n" + "test_deps a { deps = @backing:foo notes; }\n");
      requirementTable.set("foo@1.0.0", [{ name: "notes", versionConstraint: "^1.0.0" }]);
      const failure = await Promise.resolve(model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"))).then(
        () => undefined,
        (err: Error) => err
      );
      const cause = rootCauseOf(failure) as FabrError;
      expect(cause.message).to.equal("foo:1.0.0 depends on notes:^1.0.0, which is provided by the target 'notes', but 'notes' is not a package");
      expect(cause.help).to.deep.equal(["either build 'notes' as a package, or rename it to avoid the name collision"]);
    });

    const entries = (): Array<string | string[]> =>
      lastDepSets.map(set => (set instanceof PackageFileSet ? set.packageId : [...set].map(([name]) => name)));

    describe("forced in place of a build of its name", () => {
      it("is passed on by a target that states it, asked for at the version selected", async () => {
        const model = build(
          "package_repo @backing { }\n" +
            "test_built notes { }\n" +
            "test_stated mid { deps = notes; }\n" +
            "test_stated lib { deps = @backing:notes:1.0.0! mid; }\n" +
            "test_deps a { deps = lib; }\n"
        );
        expect(await refusal(model)).to.equal(undefined);
        expect((lastDepSets[0] as PackageFileSet).getDependency("notes")?.package?.packageId).to.equal("notes@1.0.0");
      });

      it("joins the resolution of what reaches it through another target, its closure with it", async () => {
        const model = build(
          "package_repo @backing { }\n" +
            "test_built pages { }\n" +
            "test_stated lib { deps = pages; }\n" +
            "test_stated app { deps = lib @backing:pages:1.0.0!; }\n" +
            "test_deps a { deps = app @backing:z:2.0.0; }\n"
        );
        requirementTable.set("pages@1.0.0", [{ name: "z", versionConstraint: "^1.0.0" }]);
        expect(await refusal(model)).to.contain("z is required as '^1.0.0' and as '2.0.0'");
      });
    });

    const collision = (via: string): string =>
      "Resolution requires multiple versions of the same package:\n" +
      "  notes is required as '1.0.0' and as 'notes', and no one version is both\n" +
      "    '1.0.0' required directly\n" +
      `    'notes' ${via}\n` +
      "    required notes versions: 1.0.0, notes — allowed: 1.0.0; add notes?";

    for (const [builds, type] of [
      ["files", "test_patch"],
      ["a package", "test_built"],
    ]) {
      it(`refuses a registry's package required beside a target of its name that builds ${builds}`, async () => {
        const model = build(`package_repo @backing { }\n${type} notes { }\ntest_deps a { deps = @backing:notes:1.0.0 notes; }\n`);
        expect(await refusal(model)).to.equal(
          "'notes' is required here as two different packages (from '@backing:notes:1.0.0' and 'notes')"
        );
      });

      it(`refuses it where the target that builds ${builds} is reached through another target`, async () => {
        const model = build(
          `package_repo @backing { }\n${type} notes { }\ntest_stated lib { deps = notes; }\ntest_deps a { deps = lib @backing:notes:1.0.0; }\n`
        );
        expect(await refusal(model)).to.equal(collision("required via: lib"));
      });
    }

    it("refuses a forced target that builds no package where a registry's package was asked for", async () => {
      const model = build("package_repo @backing { }\n" + "test_patch notes { }\n" + "test_deps a { deps = @backing:notes:1.0.0; also = notes!; }\n");
      expect(await refusal(model)).to.equal("'@backing:notes:1.0.0' is provided by the target 'notes', but 'notes' is not a package");
    });

    describe("required beside a catalog's member of its name", () => {
      const built = (model: BuildModel): Promise<string | undefined> =>
        Promise.resolve(model.getConfig(Constraints.of({ BUILD_OPERATION: "build" }), execution).materialize(writtenOnCommandLine("a"))).then(
          () => undefined,
          (err: Error) => (rootCauseOf(err) as Error).message
        );

      it("is the one package where the member is that same target", async () => {
        const model = build("test_built lib { }\n" + "catalog @cat { deps = lib; }\n" + "test_deps a { deps = lib; also = @cat:lib; }\n");
        expect(await built(model)).to.equal(undefined);
        expect(entries()).to.deep.equal(["lib@*", "lib@*"]);
      });

      it("is the one package where the target is reached through another", async () => {
        const model = build(
          "test_built lib { }\n" + "test_stated app { deps = lib; }\n" + "catalog @cat { deps = lib; }\n" + "test_deps a { deps = app @cat:lib; }\n"
        );
        expect(await built(model)).to.equal(undefined);
      });

      it("is a collision where the member is another package", async () => {
        const model = build(
          "package_repo @backing { }\n" + "test_built lib { }\n" + "catalog @cat { deps = @backing:lib:1.0.0; }\n" + "test_deps a { deps = lib @cat:lib; }\n"
        );
        expect(await built(model)).to.equal("'lib' is required here as two different packages (from 'lib' and '@cat:lib')");
      });
    });

    it("refuses a target that builds a package with other things beside it", async () => {
      const model = build("test_both lib { }\n" + "test_deps a { deps = lib; }\n");
      expect(await refusal(model)).to.equal("'lib' builds a package and other things beside it");
    });

    it("gives the name to a target that is forced, in place of the registry's package", async () => {
      const model = build("package_repo @backing { }\n" + "test_built notes { }\n" + "test_deps a { deps = @backing:notes:1.0.0; also = notes!; }\n");
      expect(await refusal(model)).to.equal(undefined);
      expect(entries()).to.deep.equal(["notes@*", "notes@*"]);
      expect(backings.get("@backing")!.fetched).to.deep.equal([]);
    });

    it("accepts a target written as an alternate alongside the registry's package, and delivers nothing for it", async () => {
      const model = build(
        "package_repo @backing { }\n" + "test_built notes { }\n" + "test_stated lib { deps = notes; }\n" + "test_deps a { deps = lib @backing:notes:1.0.0 notes?; }\n"
      );
      expect(await refusal(model)).to.equal(undefined);
      expect(entries()).to.deep.equal(["lib@*", "notes@1.0.0"]);
    });

    it("uses the registry's package where the target beside it is marked an alternate", async () => {
      const model = build("package_repo @backing { }\n" + "test_built notes { }\n" + "test_deps a { deps = notes? @backing:notes:1.0.0; }\n");
      expect(await refusal(model)).to.equal(undefined);
      expect(entries()).to.deep.equal(["notes@1.0.0"]);
    });

    it("gives the name to the target where the registry's package is marked an alternate", async () => {
      const model = build("package_repo @backing { }\n" + "test_built notes { }\n" + "test_deps a { deps = @backing:notes:1.0.0? notes; }\n");
      expect(await refusal(model)).to.equal(undefined);
      expect(entries()).to.deep.equal(["notes@*"]);
      expect(backings.get("@backing")!.fetched).to.deep.equal([]);
    });

    it("gives the name to the registry's package where it is forced, which then answers for the target", async () => {
      const model = build("package_repo @backing { }\n" + "test_patch notes { }\n" + "test_deps a { deps = @backing:notes:1.0.0!; also = notes; }\n");
      expect(await refusal(model)).to.equal(undefined);
      expect(entries()).to.deep.equal(["notes@1.0.0", "notes@1.0.0"]);
    });

    for (const type of ["test_deps", "test_sealed"]) {
      it(`refuses two versions of a registry's package required directly, whether or not judged strictly (${type})`, async () => {
        const model = build(`package_repo @backing { }\n${type} a { deps = @backing:x:1.0.0 @backing:x:2.0.0; }\n`);
        expect(await refusal(model)).to.equal(
          "'x' is required here as two different packages (from '@backing:x:1.0.0' and '@backing:x:2.0.0')"
        );
        expect(backings.get("@backing")!.fetched).to.deep.equal([]);
      });
    }

    it("accepts two requirements on one name in separate lists that resolve to one package", async () => {
      const model = build("package_repo @backing { }\n" + "test_deps a { deps = @backing:x:^1.0.0; also = @backing:x:1.0.0; }\n");
      expect(await refusal(model)).to.equal(undefined);
      expect(entries()).to.deep.equal(["x@1.0.0", "x@1.0.0"]);
      /* One selection is one node, whichever reference delivers it. */
      expect(lastDepSets[0]).to.equal(lastDepSets[1]);
    });

    it("delivers a catalog's member and a direct reference to the same version as one node", async () => {
      /* Two resolutions answer with the same package wired the same way: the
       * collection holds it once, and plugin's peer on it binds to that one. */
      const model = build(
        "package_repo @backing { }\n" +
          "catalog @cat { deps = @backing:x:1.0.0; }\n" +
          "test_deps a { deps = @cat:x; also = @backing:x:1.0.0; }\n"
      );
      requirementTable.set("x@1.0.0", [{ name: "plugin", versionConstraint: "1.0.0" }]);
      requirementTable.set("plugin@1.0.0", [{ name: "x", versionConstraint: "1.0.0", provided: "expected" }]);
      expect(await refusal(model)).to.equal(undefined);
      const [fromCatalog, direct] = lastDepSets as PackageFileSet[];
      expect(direct).to.equal(fromCatalog);
      expect(reachablePackages([direct]).filter(pkg => pkg.packageName === "plugin")).to.have.lengthOf(1);
    });

    it("refuses a catalog's member and a direct reference to the same version wired differently", async () => {
      /* x requires y: the catalog pins y@1.0.0, the direct collection selects
       * y@1.1.0 for a range, so the two x's are two packages and y ships at
       * two versions, one of them sanctioned by nothing written. */
      const model = build(
        "package_repo @backing { }\n" +
          "catalog @cat { deps = @backing:x:1.0.0 @backing:y:1.0.0; }\n" +
          "test_deps a { deps = @cat:x; also = @backing:x:1.0.0 @backing:y:^1.1.0; }\n"
      );
      requirementTable.set("x@1.0.0", [{ name: "y", versionConstraint: "^1.0.0" }]);
      expect(await refusal(model)).to.contain("Resolution requires multiple versions of the same package");
    });

    it("delivers one node for one selection through a cycle back to it", async () => {
      /* x requires plugin, which requires x back as a plugin requires its
       * host: each delivery of x is the one node, and plugin's edge leads to
       * it, not to a copy. */
      const model = build("package_repo @backing { }\n" + "test_deps a { deps = @backing:x:1.0.0; also = @backing:x:^1.0.0; }\n");
      requirementTable.set("x@1.0.0", [{ name: "plugin", versionConstraint: "1.0.0" }]);
      requirementTable.set("plugin@1.0.0", [{ name: "x", versionConstraint: "1.0.0", provided: "expected" }]);
      expect(await refusal(model)).to.equal(undefined);
      const [x, again] = lastDepSets as PackageFileSet[];
      expect(again).to.equal(x);
      expect(reachablePackages([x]).filter(pkg => pkg.packageName === "x")).to.have.lengthOf(1);
      expect(x.packages[0].packageName).to.equal("plugin");
      expect(x.packages[0].packages[0]).to.equal(x);
    });

    it("refuses two requirements on one name in one list, though they resolve to one package", async () => {
      const model = build("package_repo @backing { }\n" + "test_deps a { deps = @backing:x:^1.0.0 @backing:x:1.0.0; }\n");
      expect(await refusal(model)).to.equal(
        "'x' is required here as two different packages (from '@backing:x:^1.0.0' and '@backing:x:1.0.0')"
      );
    });

    it("refuses a second request of one name in one list though one is forced", async () => {
      const model = build("package_repo @backing { }\n" + "test_built notes { }\n" + "test_deps a { deps = notes! @backing:notes:1.0.0; }\n");
      expect(await refusal(model)).to.equal(
        "'notes' is required here as two different packages (from 'notes!' and '@backing:notes:1.0.0')"
      );
    });

    it("accepts a second version of a name required directly where it is an alternate", async () => {
      const model = build("package_repo @backing { }\n" + "test_deps a { deps = @backing:x:1.0.0 @backing:x:2.0.0?; }\n");
      expect(await refusal(model)).to.equal(undefined);
      expect(entries()).to.deep.equal(["x@1.0.0"]);
    });

    it("refuses a target and a registry's package both forced under one name", async () => {
      const model = build("package_repo @backing { }\n" + "test_built notes { }\n" + "test_deps a { deps = @backing:notes:1.0.0!; also = notes!; }\n");
      expect(await refusal(model)).to.equal("'notes' is forced ('!') at two different versions (1.0.0, notes) — pick one");
    });

    it("leaves a target read for its files holding no name: what requires the target keeps it", async () => {
      const model = build("test_built notes { }\n" + "test_stated lib { deps = notes; }\n" + "test_deps a { deps = lib notes<BUILD_OPERATION=files>; }\n");
      expect(await refusal(model)).to.equal(undefined);
      const [lib, files] = lastDepSets;
      expect((lib as PackageFileSet).packages.map(pkg => pkg.packageId)).to.deep.equal(["notes@*"]);
      expect(files).to.not.be.instanceOf(PackageFileSet);
    });

    it("delivers a target's files, not its package, beside the target itself", async () => {
      const model = build("test_built notes { }\n" + "test_deps a { deps = notes notes<BUILD_OPERATION=files>; }\n");
      expect(await refusal(model)).to.equal(undefined);
      expect(lastDepSets.map(set => set instanceof PackageFileSet)).to.deep.equal([true, false]);
    });

    it("accepts a target as an alternate where a registry's packages are resolved too", async () => {
      const model = build(
        "package_repo @backing { }\n" + "test_built notes { }\n" + "test_stated lib { deps = notes; }\n" + "test_deps a { deps = lib notes? @backing:foo; }\n"
      );
      expect(await refusal(model)).to.equal(undefined);
      expect(entries()).to.deep.equal(["lib@*", "foo@1.0.0"]);
    });

    it("settles a catalog's own collision by the marker: the forced target is the member", async () => {
      const model = build(
        "package_repo @backing { }\n" + "test_built notes { }\n" + "catalog @cat { deps = @backing:notes:1.0.0 notes!; }\n" + "test_deps a { deps = @cat:notes; }\n"
      );
      expect(await refusal(model)).to.equal(undefined);
      expect(entries()).to.deep.equal(["notes@*"]);
    });

    it("leaves an alternate out of a catalog's members", async () => {
      const model = build(
        "package_repo @backing { }\n" + "test_built notes { }\n" + "catalog @cat { deps = notes? @backing:notes:1.0.0; }\n" + "test_deps a { deps = @cat:notes; }\n"
      );
      expect(await refusal(model)).to.equal(undefined);
      expect(entries()).to.deep.equal(["notes@1.0.0"]);
    });

    for (const lists of ["deps = @backing:host:1.0.0! @backing:plugin; also = host", "deps = host @backing:plugin; also = @backing:host:1.0.0!"]) {
      it(`answers a provided requirement with the forced registry package, whichever list holds it (${lists})`, async () => {
        const model = build(`package_repo @backing { }\ntest_built host { }\ntest_deps a { ${lists}; }\n`);
        requirementTable.set("plugin@1.0.0", [{ name: "host", versionConstraint: "^1.0.0", provided: "expected" }]);
        expect(await refusal(model)).to.equal(undefined);
        const plugin = lastDepSets.find((set): set is PackageFileSet => set instanceof PackageFileSet && set.packageName === "plugin")!;
        expect(plugin.packages.map(pkg => pkg.packageId)).to.deep.equal(["host@1.0.0"]);
      });
    }

    it("refuses a target's own requirement on a registry's package bound to a target that builds no package", async () => {
      /* lib asked for the package `notes`; here that name is the target's. */
      const model = build(
        "package_repo @backing { }\n" + "test_patch notes { }\n" + "test_stated lib { deps = @backing:notes:1.0.0; }\n" + "test_deps a { deps = lib notes; }\n"
      );
      expect(await refusal(model)).to.equal("'@backing:notes:1.0.0' is provided by the target 'notes', but 'notes' is not a package");
    });

    describe("read for its loose files", () => {
      it("keeps what a target builds where that is files, and leaves out a package", async () => {
        const model = build("test_patch notes { }\n" + "test_built lib { }\n" + "test_loose a { extra = notes lib; }\n");
        expect(await refusal(model)).to.equal(undefined);
        expect(lastFiles.map(set => [...set].map(([name]) => name))).to.deep.equal([["notes.patch"]]);
      });

      it("leaves a registry's package out unresolved, so it constrains nothing", async () => {
        const model = build("package_repo @backing { }\n" + "test_loose a { deps = @backing:bar:^1.0.0; extra = @backing:bar:1.2.0; }\n");
        expect(await refusal(model)).to.equal(undefined);
        expect(lastFiles).to.deep.equal([]);
        expect(entries()).to.deep.equal(["bar@1.0.0"]);
        expect(backings.get("@backing")!.fetched).to.deep.equal(["bar@1.0.0"]);
      });
    });

    describe("read for its files", () => {
      const names = (): string[][] => lastFiles.map(set => [...set].map(([name]) => name));

      it("is each configuration's own build, side by side", async () => {
        const model = build("default MODE = plain;\n" + "test_mode notes { }\n" + "test_mixed a { srcs = notes<MODE=debug> notes<MODE=release>; }\n");
        expect(await refusal(model)).to.equal(undefined);
        expect(names()).to.deep.equal([["notes-debug.txt"], ["notes-release.txt"]]);
      });

      it("is its files, with no name: a registry's package of that name stands with it", async () => {
        const model = build(
          "package_repo @backing { }\n" + "test_built notes { }\n" + "test_mixed a { srcs = notes; deps = @backing:notes:1.0.0; }\n"
        );
        expect(await refusal(model)).to.equal(undefined);
        expect(lastFiles.map(set => set instanceof PackageFileSet)).to.deep.equal([false]);
        expect(names()).to.deep.equal([["notes/data.txt"]]);
        expect(entries()).to.deep.equal(["notes@1.0.0"]);
      });

      it("delivers a registry's package as its own files, with nothing it requires fetched", async () => {
        const model = build("package_repo @backing { }\n" + "test_mixed a { srcs = @backing:foo:1.0.0; }\n");
        requirementTable.set("foo@1.0.0", [{ name: "bar", versionConstraint: "^1.0.0" }]);
        expect(await refusal(model)).to.equal(undefined);
        expect(lastFiles.map(set => set instanceof PackageFileSet)).to.deep.equal([false]);
        expect(backings.get("@backing")!.fetched).to.deep.equal(["foo@1.0.0"]);
      });

      it("may be read from a property declared PACKAGES: each package is its files", async () => {
        const model = build("test_built notes { }\n" + "test_filesof a { pkgs = notes; }\n");
        expect(await refusal(model)).to.equal(undefined);
        expect(lastFiles.map(set => set instanceof PackageFileSet)).to.deep.equal([false]);
      });

      it("is all a property declared FILES can be read for", async () => {
        const model = build("test_built notes { }\n" + "test_wrongtype a { srcs = notes; }\n");
        expect(await refusal(model)).to.equal("internal: 'srcs' of test_wrongtype is not declared PACKAGES, and is read as packages");
      });

      it("projects through a global naming a target and a registry's package, delivering both", async () => {
        const model = build("package_repo @backing { }\n" + "test_built notes { }\n" + "G = notes @backing:x:1.0.0;\n" + "test_mixed a { srcs = G:*/data.txt; }\n");
        expect(await refusal(model)).to.equal(undefined);
        expect(names().sort()).to.deep.equal([["notes/data.txt"], ["x/data.txt"]]);
      });

      it("attributes a registry reference it cannot deliver to the reference", async () => {
        const model = build("package_repo @backing { }\n" + "test_mixed a { srcs = @backing:x:1.0.0 -> z; }\n");
        const failure = await Promise.resolve(model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"))).then(
          () => undefined,
          (err: Error) => err
        );
        expect(findCause(failure, RequirementResolutionError), "attributed to the written reference").to.not.be.undefined;
      });

      it("is refused for what a target passes on", async () => {
        const model = build("test_built notes { }\n" + "test_misread a { deps = notes; }\n");
        expect(await refusal(model)).to.equal("internal: the rule of 'a' reads its 'dependencies' requirement for files");
      });
    });

    describe("forced among builds of one name", () => {
      const VERSIONS = "default MODE = 1.0.0;\n" + "package_repo @backing { }\n" + "test_built foo { version = ${MODE}; }\n";
      const depsOf = (index: number): string[] => (lastDepSets[index] as PackageFileSet).packages.map(pkg => pkg.packageId);

      for (const lists of ["deps = foo<MODE=2.0.0>; also = foo!", "deps = foo!; also = foo<MODE=2.0.0>"]) {
        it(`holds the name whichever list holds it (${lists})`, async () => {
          const model = build(VERSIONS + `test_deps a { ${lists}; }\n`);
          expect(await refusal(model)).to.equal(undefined);
          expect(entries()).to.deep.equal(["foo@1.0.0", "foo@1.0.0"]);
        });
      }

      it("stands in for a build another target brings, written after it", async () => {
        const model = build(VERSIONS + "test_stated lib { deps = foo<MODE=2.0.0> @backing:x; }\n" + "test_deps a { deps = lib foo!; }\n");
        expect(await refusal(model)).to.equal(undefined);
        expect(depsOf(0)).to.include("foo@1.0.0");
        expect(depsOf(0)).to.not.include("foo@2.0.0");
      });

      it("settles the name after two other builds of it", async () => {
        const model = build(
          VERSIONS + "test_stated lib { deps = foo<MODE=2.0.0>; }\n" + "test_stated lib2 { deps = foo<MODE=3.0.0>; }\n" + "test_deps a { deps = lib lib2 foo!; }\n"
        );
        expect(await refusal(model)).to.equal(undefined);
        expect([depsOf(0), depsOf(1)]).to.deep.equal([["foo@1.0.0"], ["foo@1.0.0"]]);
      });

      it("belongs to the collection it is written in: a dependency's own `!` is not its consumer's", async () => {
        const model = build(VERSIONS + "test_stated lib { deps = foo!; }\n" + "test_deps a { deps = lib foo!<MODE=2.0.0>; }\n");
        expect(await refusal(model)).to.equal(undefined);
        expect(depsOf(0)).to.deep.equal(["foo@2.0.0"]);
      });

      it("is refused where two different builds are both forced", async () => {
        const model = build(VERSIONS + "test_deps a { deps = foo!; also = foo!<MODE=2.0.0>; }\n");
        expect(await refusal(model)).to.equal("'foo' is forced ('!') at two different versions (foo, foo<MODE=2.0.0>) — pick one");
      });

      it("settles a catalog's entry: the forced build is the member", async () => {
        const model = build(VERSIONS + "catalog @cat { deps = foo<MODE=2.0.0> foo!; }\n" + "test_deps a { deps = @cat:foo; }\n");
        expect(await refusal(model)).to.equal(undefined);
        expect(entries()).to.deep.equal(["foo@1.0.0"]);
      });

      it("leaves a catalog's other build the member where one is an alternate", async () => {
        const model = build(VERSIONS + "catalog @cat { deps = foo<MODE=2.0.0> foo?; }\n" + "test_deps a { deps = @cat:foo; }\n");
        expect(await refusal(model)).to.equal(undefined);
        expect(entries()).to.deep.equal(["foo@2.0.0"]);
      });
    });

    describe("required in two configurations by one target", () => {
      const MODES = "default MODE = plain;\n";

      it("is refused: one name is one build", async () => {
        const model = build(MODES + "test_mode notes { }\n" + "test_deps a { deps = notes<MODE=debug> notes<MODE=release>; }\n");
        expect(await refusal(model)).to.equal(
          "'notes' is required here as two different packages (from 'notes<MODE=debug>' and 'notes<MODE=release>')"
        );
      });

      it("is a conflict where two lists each ask for one: a reference to a target sanctions nothing", async () => {
        const model = build(MODES + "test_mode notes { }\n" + "test_deps a { deps = notes<MODE=debug>; also = notes<MODE=release>; }\n");
        expect(await refusal(model)).to.equal(
          "Resolution requires multiple versions of the same package:\n" +
            "  notes is required as 'notes<MODE=debug>' and as 'notes<MODE=release>', and no one version is both\n" +
            "    'notes<MODE=debug>' required directly\n" +
            "    'notes<MODE=release>' required directly"
        );
      });

      it("is the build the target requires directly, wherever another build of it is required", async () => {
        const model = build(
          MODES + "test_built notes { }\n" + "test_stated lib { deps = notes; }\n" + "test_deps a { deps = notes lib<MODE=debug>; }\n"
        );
        expect(await refusal(model)).to.equal(undefined);
        const [direct, lib] = lastDepSets as PackageFileSet[];
        expect(lib.packages).to.deep.equal([direct]);
      });

      it("is the direct build for every other build of it that is required", async () => {
        const model = build(
          MODES +
            "test_built notes { }\n" +
            "test_stated lib1 { deps = notes<MODE=debug>; }\n" +
            "test_stated lib2 { deps = notes<MODE=release>; }\n" +
            "test_deps a { deps = notes lib1 lib2; }\n"
        );
        expect(await refusal(model)).to.equal(undefined);
        const [direct, lib1, lib2] = lastDepSets as PackageFileSet[];
        expect([lib1.packages, lib2.packages]).to.deep.equal([[direct], [direct]]);
      });

      it("names each build on the path to a conflicting build by its reference", async () => {
        const model = build(
          MODES +
            "test_built notes { }\n" +
            "test_stated mid { deps = notes<MODE=debug>; }\n" +
            "test_stated lib1 { deps = mid; }\n" +
            "test_stated lib2 { deps = notes<MODE=release>; }\n" +
            "test_deps a { deps = lib1 lib2; }\n"
        );
        expect(await refusal(model)).to.contain("'notes<MODE=debug>' required via: lib1 -> mid\n");
      });

      it("is refused where two builds of it are required and the target requires neither directly", async () => {
        const model = build(
          MODES +
            "test_built notes { }\n" +
            "test_stated lib1 { deps = notes<MODE=debug>; }\n" +
            "test_stated lib2 { deps = notes<MODE=release>; }\n" +
            "test_deps a { deps = lib1 lib2; }\n"
        );
        expect(await refusal(model)).to.equal(
          "Resolution requires multiple versions of the same package:\n" +
            "  notes is required as 'notes<MODE=debug>' and as 'notes<MODE=release>', and no one version is both\n" +
            "    'notes<MODE=debug>' required via: lib1\n" +
            "    'notes<MODE=release>' required via: lib2"
        );
      });

      it("is the forced build throughout where one is forced", async () => {
        const model = build(
          MODES + "test_built notes { }\n" + "test_stated lib { deps = notes<MODE=debug>; }\n" + "test_deps a { deps = notes! lib; }\n"
        );
        expect(await refusal(model)).to.equal(undefined);
        const [forced, lib] = lastDepSets as PackageFileSet[];
        expect(lib.packages).to.deep.equal([forced]);
      });

      it("is each its own where one is accepted as an alternate", async () => {
        const model = build(
          MODES + "test_built notes { }\n" + "test_stated lib { deps = notes<MODE=debug>; }\n" + "test_deps a { deps = notes? lib; }\n"
        );
        expect(await refusal(model)).to.equal(undefined);
        expect(entries()).to.deep.equal(["lib@*"]);
      });

      it("is each target's own where one requires it privately", async () => {
        const model = build(
          MODES + "test_mode notes { }\n" + "test_deps inner { deps = notes<MODE=debug>; }\n" + "test_deps a { deps = notes inner; }\n"
        );
        expect(await refusal(model)).to.equal(undefined);
        expect(lastDepSets.map(set => [...set].map(([name]) => name))).to.deep.equal([["notes-plain.txt"], []]);
      });
    });

    it("is carried by a package built against it, and bound again where that package is used", async () => {
      const model = build(
        "package_repo @backing { }\n" + "test_built lib { deps = @backing:bar:^1.0.0; }\n" + "test_deps a { deps = lib @backing:bar:1.2.0; }\n"
      );
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      const lib = lastDepSets[0] as PackageFileSet;
      expect(edges(lib)).to.deep.equal(["bar@1.2.0"]);
      /* The manifest records what was written, not what lib's own build selected. */
      expect(builtDeclared).to.deep.equal([{ name: "bar", versionConstraint: "^1.0.0" }]);
    });

    it("is bound by the consumer's own pin where the package was built in another configuration", async () => {
      /* lib<MODE=x> carries its reference as @backing under MODE=x: the same
       * registry, which resolves it with the consumer's pin. */
      const model = build(
        "default MODE = plain;\n" +
          "package_repo @backing { }\n" +
          "test_built lib { deps = @backing:bar:^1.0.0; }\n" +
          "test_deps a { deps = lib<MODE=x> @backing:bar:1.2.0; }\n"
      );
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      const lib = lastDepSets[0] as PackageFileSet;
      expect(edges(lib)).to.deep.equal(["bar@1.2.0"]);
    });

    it("neither carries nor declares a requirement that installs nothing", async () => {
      const model = build(
        "package_repo @backing { }\n" +
          "test_built lib { deps = @backing:foo @backing:bar:1.0.0?; }\n" +
          "test_deps a { deps = lib; }\n"
      );
      requirementTable.set("foo@1.0.0", [{ name: "bar", versionConstraint: "^1.1.0" }]);
      requirementTable.set("bar@1.1.0", []);
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      const lib = lastDepSets[0] as PackageFileSet;
      /* The `?` is lib's own collection point's: it sanctions a version there,
       * and is no requirement of the package lib builds. */
      expect(edges(lib)).to.deep.equal(["foo@1.0.0"]);
      expect(builtDeclared.map(req => req?.name)).to.deep.equal(["foo"]);
    });

    it("is taken as it stands by a sub-target of the rule that collected it", async () => {
      const model = build("package_repo @backing { }\n" + "test_sub a { deps = @backing:foo @backing:bar:1.2.0; }\n");
      requirementTable.set("foo@1.0.0", [{ name: "bar", versionConstraint: "^1.0.0" }]);
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      /* The sub-target holds only foo: resolving foo's requirement there, apart
       * from the pin its creator held, would select another bar. */
      const foo = lastDepSets[0] as PackageFileSet;
      expect(edges(foo)).to.deep.equal(["bar@1.2.0"]);
      expect([...new Set(backings.get("@backing")!.fetched)].sort()).to.deep.equal(["bar@1.2.0", "foo@1.0.0"]);
    });
  });

  describe("a patched package", () => {
    /** A patch replacing the one line `pkg`'s fixture file holds. */
    const rewrite = (pkg: string, to: string): string =>
      [
        `diff --git a/${pkg}/data.txt b/${pkg}/data.txt`,
        `--- a/${pkg}/data.txt`,
        `+++ b/${pkg}/data.txt`,
        "@@ -1 +1 @@",
        `-${pkg}`,
        "\\ No newline at end of file",
        `+${to}`,
        "\\ No newline at end of file",
        "",
      ].join("\n");
    const edges = (pkg: PackageFileSet): string[] =>
      pkg.dependencies.map(dep => (dep.package ? dep.package.packageId : `ref:${dep.reference.toString()}`));
    const text = (pkg: FileSet, name: string): Promise<string> => Promise.resolve(pkg.getFile(name)!.readString());
    /** Every message down an error's chain of causes. */
    const messagesOf = (err: unknown): string[] => {
      const messages: string[] = [];
      for (let current: unknown = err; current instanceof Error; current = (current as { cause?: unknown }).cause) {
        messages.push(current.message);
      }
      return messages;
    };
    const dependency = (pkg: PackageFileSet, name: string): PackageFileSet =>
      pkg.getDependency(name)!.package!;

    it("is stated unpatched to a reading of what requires it: its name, the patched package's version and requirements", async () => {
      const model = build(
        "package_repo @backing { }\n" +
          "test_patch fix { }\n" +
          "patched foo { srcs = @backing:foo; patches = fix; }\n" +
          "test_stated app { deps = foo; }\n"
      );
      patchTexts.set("fix", rewrite("foo", "foo, patched"));
      requirementTable.set("foo@1.0.0", [{ name: "bar", versionConstraint: "^1.0.0" }]);
      const name = "app";
      const written = syntheticValue(
        parseName(name),
        { fs: EMPTY_FILESET, file: "<command-line>", reader: new StringReader(name) },
        0,
        name.length
      );
      const parts = requirementsOf(await model.getConfig(Constraints.of({}), execution).resolve(written));
      const [foo] = parts.get("dependencies") as PackageFileSet[];
      expect(foo.packageId).to.equal("foo@1.0.0");
      expect(edges(foo)).to.deep.equal(["bar@1.0.0"]);
      expect(foo).to.be.instanceOf(ResolvedNode);
      /* Resolving it fetched nothing: the package it patches is fetched when
       * the patch is applied. */
      expect(backings.get("@backing")!.fetched).to.deep.equal([]);
    });

    it("is the package it patches, with its files changed and its requirements resolved by the consumer", async () => {
      const model = build(
        "package_repo @backing { }\n" +
          "test_patch fix { }\n" +
          "patched foo { srcs = @backing:foo; patches = fix; }\n" +
          "test_deps a { deps = foo @backing:bar:1.2.0; }\n"
      );
      patchTexts.set("fix", rewrite("foo", "foo, patched"));
      requirementTable.set("foo@1.0.0", [{ name: "bar", versionConstraint: "^1.0.0" }]);
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      const foo = lastDepSets[0] as PackageFileSet;
      expect(foo.packageId).to.equal("foo@1.0.0");
      expect(await text(foo, "foo/data.txt")).to.equal("foo, patched");
      /* What it declares is selected with the consumer's own requirements. */
      expect(edges(foo)).to.deep.equal(["bar@1.2.0"]);
      expect([...new Set(backings.get("@backing")!.fetched)].sort()).to.deep.equal(["bar@1.2.0", "foo@1.0.0"]);
    });

    it("carries a provided requirement of the package as one, for its consumer to bind", async () => {
      const model = build(
        "package_repo @backing { }\n" +
          "test_patch fix { }\n" +
          "patched foo { srcs = @backing:foo; patches = fix; }\n" +
          "test_deps a { deps = foo @backing:host:1.3.0; }\n"
      );
      patchTexts.set("fix", rewrite("foo", "foo, patched"));
      requirementTable.set("foo@1.0.0", [{ name: "host", versionConstraint: "^1.0.0", provided: "expected" }]);
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      const foo = lastDepSets[0] as PackageFileSet;
      expect([...foo.provided.keys()].map(name => foo.getDependency(name)).map(dep => dep?.package?.packageId ?? "unbound")).to.deep.equal([
        "host@1.3.0",
      ]);
    });

    it("patches a package built in the project, leaving its requirements for the consumer to resolve", async () => {
      const model = build(
        "package_repo @backing { }\n" +
          "test_patch fix { }\n" +
          "test_pkg lib { deps = @backing:foo; }\n" +
          "patched patched_lib { srcs = lib; patches = fix; }\n" +
          "test_deps a { deps = patched_lib @backing:bar:1.2.0; }\n"
      );
      patchTexts.set("fix", rewrite("lib", "lib, patched"));
      requirementTable.set("foo@1.0.0", [{ name: "bar", versionConstraint: "^1.0.0" }]);
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      const lib = lastDepSets[0] as PackageFileSet;
      /* A package of its own, named as its target is. */
      expect(lib.packageName).to.equal("patched_lib");
      expect(await text(lib, "lib/data.txt")).to.equal("lib, patched");
      expect(edges(lib)).to.deep.equal(["foo@1.0.0"]);
      expect(edges(lib.packages[0])).to.deep.equal(["bar@1.2.0"]);
      /* The patched target resolved nothing of its own: only the consumer's
       * selection was ever fetched. */
      expect([...new Set(backings.get("@backing")!.fetched)].sort()).to.deep.equal(["bar@1.2.0", "foo@1.0.0"]);
    });

    it("is named as its target, so a package patched under another name leaves the original where it is used", async () => {
      for (const deps of ["patched_lib other", "other patched_lib"]) {
        const model = build(
          "package_repo @backing { }\n" +
            "test_patch fix { }\n" +
            "test_pkg lib { }\n" +
            "patched patched_lib { srcs = lib; patches = fix; }\n" +
            "test_pkg other { deps = lib; }\n" +
            `test_deps a { deps = ${deps}; }\n`
        );
        patchTexts.set("fix", rewrite("lib", "lib, patched"));
        await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
        const delivered = new Map((lastDepSets as PackageFileSet[]).map(pkg => [pkg.packageName, pkg]));
        expect(await text(delivered.get("patched_lib")!, "lib/data.txt"), deps).to.equal("lib, patched");
        expect(await text(dependency(delivered.get("other")!, "lib"), "lib/data.txt"), deps).to.equal("lib");
      }
    });

    it("stands in for the registry's copy wherever another package requires it", async () => {
      const model = build(
        "package_repo @backing { }\n" +
          "test_patch fix { }\n" +
          "patched foo { srcs = @backing:foo; patches = fix; }\n" +
          "test_deps a { deps = foo @backing:app; }\n"
      );
      patchTexts.set("fix", rewrite("foo", "foo, patched"));
      requirementTable.set("app@1.0.0", [{ name: "foo", versionConstraint: "^1.0.0" }]);
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      const [foo, app] = lastDepSets as PackageFileSet[];
      expect(dependency(app, "foo")).to.equal(foo);
      expect(await text(dependency(app, "foo"), "foo/data.txt")).to.equal("foo, patched");
      /* One package of the name in the installation. */
      expect(reachablePackages([foo, app]).filter(pkg => pkg.packageName === "foo")).to.have.length(1);
      /* The registry's foo is a node the resolution never selects: it is
       * fetched once, as the material patched, and never as a dependency. */
      expect(backings.get("@backing")!.fetched.filter(fetched => fetched === "foo@1.0.0")).to.have.length(1);
    });

    it("stands in for it throughout a catalog that lists it, for a member named without it", async () => {
      const model = build(
        "package_repo @backing { }\n" +
          "test_patch fix { }\n" +
          "patched foo { srcs = @backing:foo; patches = fix; }\n" +
          "catalog @cat { deps = foo @backing:app; }\n" +
          "test_deps a { deps = @cat:app; }\n"
      );
      patchTexts.set("fix", rewrite("foo", "foo, patched"));
      requirementTable.set("app@1.0.0", [{ name: "foo", versionConstraint: "^1.0.0" }]);
      requirementTable.set("foo@1.0.0", [{ name: "bar", versionConstraint: "^1.0.0" }]);
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      const app = lastDepSets[0] as PackageFileSet;
      const foo = dependency(app, "foo");
      expect(await text(foo, "foo/data.txt")).to.equal("foo, patched");
      expect(edges(foo)).to.deep.equal(["bar@1.0.0"]);
    });

    it("stands in for the copy a catalog member brings, which then ships no version of its own", async () => {
      /* The catalog pins foo at 1.2.0 for app; the consumer holds its own foo.
       * Only that one is installed, so two versions are not judged to ship —
       * whether or not the patched package has requirements of its own. */
      for (const requires of [[], [{ name: "bar", versionConstraint: "^1.0.0" }]] as Requirement[][]) {
        const model = build(
          "package_repo @backing { }\n" +
            "test_patch fix { }\n" +
            "patched foo { srcs = @backing:foo; patches = fix; }\n" +
            "catalog @cat { deps = @backing:app @backing:foo:1.2.0; }\n" +
            "test_deps a { deps = foo @cat:app; }\n"
        );
        patchTexts.set("fix", rewrite("foo", "foo, patched"));
        requirementTable.set("app@1.0.0", [{ name: "foo", versionConstraint: "^1.0.0" }]);
        requirementTable.set("foo@1.0.0", requires);
        await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
        const [foo, app] = lastDepSets as PackageFileSet[];
        expect(dependency(app, "foo")).to.equal(foo);
        expect(await text(foo, "foo/data.txt")).to.equal("foo, patched");
      }
    });

    it("applies patches in the order written, each to what the last left", async () => {
      const model = build(
        "package_repo @backing { }\n" +
          "test_patch first { }\n" +
          "test_patch second { }\n" +
          "patched foo { srcs = @backing:foo; patches = second first; }\n" +
          "test_deps a { deps = foo; }\n"
      );
      patchTexts.set("second", rewrite("foo", "once"));
      patchTexts.set("first", rewrite("foo", "twice").replace("-foo", "-once"));
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      expect(await text(lastDepSets[0], "foo/data.txt")).to.equal("twice");
    });

    it("yields plain patched files for anything but one package", async () => {
      const model = build(
        "package_repo @backing { }\n" +
          "test_patch fix { }\n" +
          "patched both { srcs = @backing:foo @backing:bar; patches = fix; }\n" +
          "test_deps a { deps = both; }\n"
      );
      patchTexts.set("fix", rewrite("foo", "foo, patched"));
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      const both = lastDepSets[0];
      expect(both instanceof PackageFileSet).to.equal(false);
      expect([...both].map(([name]) => name).sort()).to.deep.equal(["bar/data.txt", "foo/data.txt"]);
      expect(await text(both, "foo/data.txt")).to.equal("foo, patched");
      expect(await text(both, "bar/data.txt")).to.equal("bar");
    });

    it("creates, renames and deletes files, and gives a file the mode the patch states", async () => {
      const model = build(
        "package_repo @backing { }\n" +
          "test_patch fix { }\n" +
          "patched both { srcs = @backing:foo @backing:bar; patches = fix; }\n" +
          "test_deps a { deps = both; }\n"
      );
      patchTexts.set(
        "fix",
        [
          "diff --git a/foo/data.txt b/foo/moved/data.txt",
          "similarity index 50%",
          "rename from foo/data.txt",
          "rename to foo/moved/data.txt",
          "--- a/foo/data.txt",
          "+++ b/foo/moved/data.txt",
          "@@ -1 +1 @@",
          "-foo",
          "\\ No newline at end of file",
          "+moved",
          "diff --git a/bin/run.sh b/bin/run.sh",
          "new file mode 100755",
          "--- /dev/null",
          "+++ b/bin/run.sh",
          "@@ -0,0 +1 @@",
          "+#!/bin/sh",
          "diff --git a/bar/data.txt b/bar/data.txt",
          "deleted file mode 100644",
          "--- a/bar/data.txt",
          "+++ /dev/null",
          "@@ -1 +0,0 @@",
          "-bar",
          "\\ No newline at end of file",
          "",
        ].join("\n")
      );
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      const both = lastDepSets[0];
      expect([...both].map(([name]) => name).sort()).to.deep.equal(["bin/run.sh", "foo/moved/data.txt"]);
      expect(await text(both, "foo/moved/data.txt")).to.equal("moved\n");
      expect(both.getFile("bin/run.sh")!.mode).to.equal(0o755);
      expect(both.getFile("foo/moved/data.txt")!.mode).to.equal(0o644);
    });

    it("reports every change that does not apply, across the patches", async () => {
      const model = build(
        "package_repo @backing { }\n" +
          "test_patch one { }\n" +
          "test_patch two { }\n" +
          "patched foo { srcs = @backing:foo; patches = one two; }\n" +
          "test_deps a { deps = foo; }\n"
      );
      patchTexts.set("one", rewrite("missing", "x"));
      patchTexts.set("two", ["--- /dev/null", "+++ b/foo/data.txt", "@@ -0,0 +1 @@", "+again", ""].join("\n"));
      let failure = "";
      await model
        .getConfig(Constraints.of({}), execution)
        .materialize(writtenOnCommandLine("a"))
        .catch(err => {
          failure = messagesOf(err).join("\n");
        });
      expect(failure).to.contain("patch 'one.patch' does not apply to 'missing/data.txt': there is no such file");
      expect(failure).to.contain("patch 'two.patch' does not apply to 'foo/data.txt': the file it creates already exists");
    });

    it("fails naming the patch, the file and the hunk that does not apply", async () => {
      const model = build(
        "package_repo @backing { }\n" +
          "test_patch fix { }\n" +
          "patched foo { srcs = @backing:foo; patches = fix; }\n" +
          "test_deps a { deps = foo; }\n"
      );
      patchTexts.set("fix", rewrite("foo", "x").replace("-foo", "-something else"));
      let failure = "";
      await model
        .getConfig(Constraints.of({}), execution)
        .materialize(writtenOnCommandLine("a"))
        .catch(err => {
          failure = messagesOf(err).join("\n");
        });
      expect(failure).to.contain("patch 'fix.patch' does not apply to 'foo/data.txt': hunk @@ -1,1 +1,1 @@ does not match the file");
    });
  });

  it("delivers a member as a runnable under run, delegating to its source (no re-resolution)", async () => {
    const model = build(
      "package_repo @backing { }\n" +
        "catalog @cat { deps = @backing:tool; }\n" +
        "test_run a { tool = @cat:tool; }\n"
    );
    await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
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
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      expect.fail("expected @cat:missing to fail");
    } catch (err) {
      const failure = findCause(err, RequirementResolutionError);
      expect(failure, "a RequirementResolutionError in the cause chain").to.not.be.undefined;
      expect(failure!.cause.message).to.contain("has no member 'missing'");
    }
  });

  it("rejects a catalog entry that projects into a package", async () => {
    /* A projected entry would materialize to plain files, not a package —
     * refused in resolveCatalog, before any resolution work. The inner catalog is
     * the projection producer here: its getRepositoryRef packs ':data.txt'
     * into the ref as a projection (pinned by its own unit test above). */
    const model = build(
      "package_repo @backing { }\n" +
        "catalog @inner { deps = @backing:foo; }\n" +
        "catalog @outer { deps = @inner:foo:data.txt; }\n" +
        "test_deps a { deps = @outer:foo; }\n"
    );
    try {
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
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
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
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
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
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
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
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

/** Get the failure at the bottom of `err`'s cause chain. */
function rootCauseOf(err: unknown): unknown {
  let current = err;
  for (;;) {
    const cause = (current as { cause?: unknown }).cause;
    if (!(cause instanceof Error)) {
      return current;
    }
    current = cause;
  }
}

/* Walk the cause chain (DependencyFailedError / ReferenceFailedError wrappers). */
function findCause<T extends Error>(err: unknown, type: new (...args: never[]) => T): T | undefined {
  for (let current: unknown = err; current instanceof Error; current = (current as { cause?: unknown }).cause) {
    if (current instanceof type) {
      return current;
    }
  }
  return undefined;
}
