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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BuildCache } from "../core/BuildCache";
import { Computable } from "../core/Computable";
import { EMPTY_FILESET, FileSet } from "../core/FileSet";
import { MemoryFile } from "../core/MemoryFS";
import { Name } from "../core/Name";
import { PackageFileSet } from "../core/PackageFileSet";
import { RunnableFileSet } from "../core/RunnableFileSet";
import { PublishableFileSet } from "../core/PublishableFileSet";
import {
  PublishMember,
  PublishStatus,
  Repository,
  RepositoryPublishRef,
  RepositoryReader,
  RepositoryRef,
  MaterializeOptions,
  ClosureThunk,
} from "../core/Repository";
import { VersionNotFoundError } from "../core/Errors";
import { TargetContext } from "../model/BuildContext";
import { BuildModel } from "../model/BuildModel";
import { Constraints } from "../model/Constraints";
import { ExecutionContext } from "../model/ExecutionContext";
import { parseBuildString } from "../model/Parser";
import { toBuildModel } from "../model/Sema";
import { LogFormatter, LogLevel } from "../support/Log";
import { parseVersion, SEMVER, SemverConstraint, SemverVersion, versionToString } from "../resolver/Semver";
import { Requirement, Selected } from "../resolver/Types";
import { IContentPackage, PackageFormat } from "../resolver/PackageFormat";
import { declaredRequirementOf, vendPackageRef } from "../resolver/PackageResolver";
import { bestRoute, parseRouteKey, repositoryGroupRegistration, RouteKey, routeKeyText } from "./RepositoryGroup";
import { PluginContribution, RuleRegistration } from "./Types";

function key(text: string): RouteKey {
  const parsed = parseRouteKey(text);
  if ("error" in parsed) {
    throw new Error(parsed.error);
  }
  return parsed;
}

describe("parseRouteKey", () => {
  it("parses an exact name", () => {
    expect(key("lodash")).to.deep.equal({ components: ["lodash"], prefix: false });
  });

  it("parses a scope prefix", () => {
    expect(key("@fortawesome/*")).to.deep.equal({ components: ["@fortawesome", ""], prefix: true });
  });

  it("parses a sub-scope prefix within a component", () => {
    expect(key("@acme/legacy-*")).to.deep.equal({ components: ["@acme", "legacy-"], prefix: true });
  });

  it("parses the catch-all as the empty prefix", () => {
    expect(key("*")).to.deep.equal({ components: [""], prefix: true });
  });

  it("parses a multi-component identity key (colon-bounded)", () => {
    expect(key("com.google.guava:guava")).to.deep.equal({ components: ["com.google.guava", "guava"], prefix: false });
  });

  it("round-trips through routeKeyText", () => {
    for (const text of ["lodash", "@fortawesome/*", "@acme/legacy-*", "*", "acme-*"]) {
      expect(routeKeyText(key(text))).to.equal(text);
    }
  });

  it("rejects every pattern shape that is not a literal prefix", () => {
    /* Not silently-degraded prefixes: the shape rule is what keeps richer
     * patterns admissible later as a pure widening. */
    for (const bad of ["lo?ash", "a[bc]d", "!(scope)/*", "@acme/@(a|b)", "a*b", "**", "*.tgz"]) {
      expect(parseRouteKey(bad), bad).to.have.property("error");
    }
  });

  it("rejects an empty interior component", () => {
    expect(parseRouteKey("a//b")).to.have.property("error").that.contains("empty");
  });
});

describe("bestRoute", () => {
  const routes = [
    { key: key("@acme/legacy-*"), member: "old" },
    { key: key("@acme/*"), member: "new" },
    { key: key("lodash"), member: "exact" },
    { key: key("lodash-*"), member: "family" },
    { key: key("*"), member: "public" },
  ];

  it("routes by longest literal match, declaration order carrying no meaning", () => {
    expect(bestRoute(routes, "@acme/legacy-auth")?.member).to.equal("old");
    expect(bestRoute(routes, "@acme/ui")?.member).to.equal("new");
    expect(bestRoute([...routes].reverse(), "@acme/legacy-auth")?.member).to.equal("old");
  });

  it("an exact match beats every prefix", () => {
    expect(bestRoute(routes, "lodash")?.member).to.equal("exact");
    expect(bestRoute(routes, "lodash-es")?.member).to.equal("family");
  });

  it("matches whole components: an exact key does not claim a longer name", () => {
    /* The component-boundary rule — `lodash` claims `lodash:4.17.21` (the key's
     * depth stops before version position) but never `lodash-es`. */
    expect(bestRoute(routes, "lodash:4.17.21")?.member).to.equal("exact");
    expect(bestRoute(routes, "lodash-es:1.0.0")?.member).to.equal("family");
  });

  it("a scope prefix claims its depth, whatever follows", () => {
    expect(bestRoute(routes, "@acme/ui:2.0.0:lib/index.js")?.member).to.equal("new");
  });

  it("falls to the catch-all, which is not a distinguished entry", () => {
    expect(bestRoute(routes, "left-pad")?.member).to.equal("public");
  });

  it("a multi-component key claims exactly its own components", () => {
    const maven = [
      { key: key("com.google.guava:guava"), member: "central" },
      { key: key("*"), member: "fallback" },
    ];
    expect(bestRoute(maven, "com.google.guava:guava:31.0")?.member).to.equal("central");
    expect(bestRoute(maven, "com.google.guava:failureaccess:1.0")?.member).to.equal("fallback");
  });

  it("an exact key beats its identical-literal prefix twin, whichever is declared first", () => {
    /* The one shape where two distinct keys match with equal literal length —
     * without the tie-break, declaration order would silently decide. */
    const pair = [
      { key: key("foo"), member: "exact" },
      { key: key("foo*"), member: "prefix" },
    ];
    expect(bestRoute(pair, "foo")?.member).to.equal("exact");
    expect(bestRoute([...pair].reverse(), "foo")?.member).to.equal("exact");
    expect(bestRoute(pair, "foobar")?.member).to.equal("prefix");
    expect(bestRoute([...pair].reverse(), "foobar")?.member).to.equal("prefix");
  });

  it("a key deeper than the name does not match it", () => {
    expect(bestRoute([{ key: key("@fortawesome/*"), member: "fa" }], "@fortawesome")).to.equal(undefined);
  });

  it("a name no route matches is not routed — a closed domain is legitimate", () => {
    const closed = [{ key: key("@acme/*"), member: "private" }];
    expect(bestRoute(closed, "left-pad")).to.equal(undefined);
  });
});

/** A minimal ecosystem format for tests: `name:version` identities over
 * semver, no projections, no override markers; content packages read from a
 * `pkg.json` at the content root
 * (`{"version": "1.5.0", "deps": {"left-pad": "^1.0.0"}}`) — the same
 * contract the npm format implements from a package.json. One shared instance
 * — sharing it is what admits two registries to one group. */
function makeFormat(tag: string): PackageFormat<SemverVersion, SemverConstraint> {
  const splitIdentity = (name: Name): { identifier: string; version: string } | undefined => {
    const lit = name.toString();
    const idx = lit.lastIndexOf(":");
    return idx > 0 ? { identifier: lit.substring(0, idx), version: lit.substring(idx + 1) } : undefined;
  };
  return {
    ...SEMVER,
    resolutionTag: tag,
    splitReference: (name: Name) => ({ requirement: name }),
    parseRequirement: (name: Name): Requirement => {
      const split = splitIdentity(name);
      if (!split) {
        throw new Error(`missing version in '${name.toString()}'`);
      }
      return { pkg: split.identifier, constraint: split.version };
    },
    parsePublishCoordinate: (name: Name) => {
      const split = splitIdentity(name);
      if (!split) {
        throw new Error(`publish coordinate '${name.toString()}' must name a version`);
      }
      return { name: split.identifier, version: split.version };
    },
    readContentPackage: (files: FileSet): Computable<IContentPackage<SemverVersion>> =>
      files.readFile("pkg.json").then(text => {
        const meta = JSON.parse(text) as { name?: string; version: string; deps?: Record<string, string> };
        return {
          name: meta.name,
          version: parseVersion(meta.version),
          requirements: Object.entries(meta.deps ?? {}).map(([pkg, constraint]) => ({ pkg, constraint })),
        };
      }),
    makeRunnable: (pkg: PackageFileSet) => Computable.reject<RunnableFileSet>(new Error(`cannot run '${pkg.packageName}'`)),
  };
}
const TEST_FORMAT = makeFormat("test:resolve:1");
/** A structurally identical but DISTINCT format object — another ecosystem. */
const ALIEN_FORMAT = makeFormat("alien:resolve:1");

/** One version's table entry: its declared dependencies. */
type RegistryTable = Record<string, Record<string, string>>;

/** An in-memory registry recording every per-name call, so a test can prove
 * which registry served which package — standing alone as a repository, its
 * reader face driven by the package-domain functions exactly as
 * npm_repository's is. */
class FakeRegistry implements Repository, RepositoryReader<SemverVersion, SemverConstraint> {
  public readonly requested: string[] = [];
  public readonly fetched: string[] = [];

  constructor(
    public readonly identity: string,
    public readonly format: PackageFormat<SemverVersion, SemverConstraint>,
    private readonly table: RegistryTable,
    private readonly context: TargetContext
  ) {}

  public getRepositoryRef(name: Name): RepositoryRef {
    return vendPackageRef(this, this.format, name);
  }

  public getRepositoryPublishRef(name: Name): never {
    throw new Error(`test_registry is not a publish destination ('${name.toString()}')`);
  }

  public declaredRequirement(ref: RepositoryRef): Computable<Requirement | undefined> {
    return declaredRequirementOf(this.format, ref);
  }

  public getRequirements(pkg: string, version: SemverVersion): Computable<Requirement[]> {
    const id = `${pkg}@${versionToString(version)}`;
    this.requested.push(id);
    const deps = this.table[id];
    if (!deps) {
      return Computable.reject(new VersionNotFoundError(pkg, versionToString(version), `${id} not in ${this.identity}`));
    }
    return Computable.resolve(Object.entries(deps).map(([dep, constraint]) => ({ pkg: dep, constraint })));
  }

  public environmentKey(): Computable<string> {
    return Computable.resolve("test-env");
  }

    /* These fakes stand in for a registry reached under an ordinary build. */
    /* Delivers the assembled package as-is: these fakes stand in for a registry
     * reached under an ordinary build. */
    public deliver(_reference: RepositoryRef, _options?: MaterializeOptions, closure?: ClosureThunk): Computable<FileSet> {
      return closure ? closure().then((pkg: PackageFileSet | undefined) => pkg ?? EMPTY_FILESET) : Computable.resolve<FileSet>(EMPTY_FILESET);
    }

  public availableVersions(pkg: string): Computable<SemverVersion[] | undefined> {
    const versions = Object.keys(this.table)
      .filter(id => id.startsWith(`${pkg}@`))
      .map(id => parseVersion(id.substring(pkg.length + 1)));
    return Computable.resolve(versions.length > 0 ? versions : undefined);
  }

  public validateSelections(_selections: Selected<SemverVersion>[]): Computable<void> {
    return Computable.resolve(undefined);
  }

  public fetch(pkg: string, version: SemverVersion): Computable<PackageFileSet> {
    const id = `${pkg}@${versionToString(version)}`;
    this.fetched.push(id);
    return Computable.resolve(
      new PackageFileSet(new Map([["from.txt", MemoryFile.from(this.identity)]]), pkg, versionToString(version))
    );
  }

  public makeRunnable(pkg: PackageFileSet): Computable<RunnableFileSet> {
    return Computable.reject(new Error(`cannot run '${pkg.packageName}'`));
  }

  public validateCoordinate(): void {}

  public package(_members: PublishMember[], _release: readonly RepositoryPublishRef[]): Computable<PublishableFileSet[]> {
    return Computable.reject(new Error("not a publish destination"));
  }

  public publish(): Computable<PublishStatus> {
    return Computable.reject(new Error("not a publish destination"));
  }
}

describe("repository_group (through the model)", () => {
  /* One backing registry per declared `test_registry` target, seeded per test. */
  const registries = new Map<string, FakeRegistry>();
  const tables = new Map<string, RegistryTable>();
  function backingRegistry(
    context: TargetContext,
    format: PackageFormat<SemverVersion, SemverConstraint>
  ): FakeRegistry {
    const name = context.name;
    let registry = registries.get(name);
    if (!registry) {
      registry = new FakeRegistry(`test:${name}`, format, tables.get(name) ?? {}, context);
      registries.set(name, registry);
    }
    return registry;
  }

  let lastDepSets: FileSet[] = [];
  const depsRule: RuleRegistration = {
    type: "test_deps",
    constraints: {},
    evaluate: (context: TargetContext) =>
      context.getFileSetProperties(["deps"]).then(({ deps }) => {
        lastDepSets = deps;
        return EMPTY_FILESET;
      }),
  };
  const contributions: PluginContribution[] = [
    {
      rules: [depsRule],
      repositories: [
        {
          type: "test_registry",
          provider: (context: TargetContext) => Computable.resolve(backingRegistry(context, TEST_FORMAT)),
        },
        {
          type: "alien_registry",
          provider: (context: TargetContext) => Computable.resolve(backingRegistry(context, ALIEN_FORMAT)),
        },
        repositoryGroupRegistration,
      ],
    },
  ];
  const testLog = new LogFormatter(LogLevel.Info, () => undefined);
  /* A throwaway cache root: the domain PERSISTS resolution memos through the
   * build cache, so a cache in the working directory would leak entries into
   * the repo and serve stale resolutions across test runs. */
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-group-test-"));
  afterAll(() => fs.rmSync(cacheRoot, { recursive: true, force: true }));
  const execution = new ExecutionContext(new BuildCache(cacheRoot, testLog), testLog, EMPTY_FILESET, EMPTY_FILESET);

  const preamble =
    "default BUILD_OPERATION = build;\n" +
    "targetdef repository_group { * = FILES; }\n" +
    "targetdef test_registry { }\n" +
    "targetdef alien_registry { }\n" +
    "targetdef test_deps { deps = FILES; }\n";

  function build(source: string, expectErrors = false, sourceFs: FileSet = EMPTY_FILESET): { model: BuildModel; errors: string[] } {
    registries.clear();
    tables.clear();
    lastDepSets = [];
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const model = toBuildModel([parseBuildString(sourceFs, "TEST.fabr", preamble + source, logger)], logger, contributions);
    if (!expectErrors) {
      expect(errors).to.deep.equal([]);
    }
    return { model, errors };
  }

  function seed(name: string, table: RegistryTable): void {
    tables.set(name, table);
  }

  async function getTarget(model: BuildModel, name: string): Promise<void> {
    await model.getConfig(Constraints.of({}), execution).getTarget(name);
  }

  /** Every message down the cause chain, for asserting through the
   * DependencyFailedError wrapping a repository construction failure gets. */
  function messageChain(err: unknown): string {
    const messages: string[] = [];
    for (let e = err as { message?: string; cause?: unknown } | undefined; e; e = e.cause as never) {
      if (e.message) {
        messages.push(e.message);
      }
    }
    return messages.join("\n");
  }

  async function failure(model: BuildModel, name: string): Promise<string> {
    try {
      await getTarget(model, name);
    } catch (err) {
      return messageChain(err);
    }
    throw new Error("expected the build to fail, but it succeeded");
  }

  const GROUP = "repository_group @deps { @scope/* = @a; * = @b; }\n";
  const REGISTRIES = "test_registry @a { }\ntest_registry @b { }\n";

  it("resolves a cross-registry closure jointly, each name served by its routed registry", async () => {
    /* The FontAwesome shape: a public package's transitive requirement lands in
     * the private scope — discovered inside @b's metadata, served by @a. */
    const { model } = build(REGISTRIES + GROUP + "test_deps t { deps = @deps:top:1.0.0; }\n");
    seed("@b", { "top@1.0.0": { "@scope/lib": "^1.2.0" } });
    seed("@a", { "@scope/lib@1.2.0": {} });
    await getTarget(model, "t");

    const top = lastDepSets[0] as PackageFileSet;
    expect(top.packageName).to.equal("top");
    expect(await top.readFile("from.txt")).to.equal("test:@b");
    /* The transitive scoped package rode the private registry end to end. */
    const lib = top.dependencies[0] as PackageFileSet;
    expect(lib.packageName).to.equal("@scope/lib");
    expect(await lib.readFile("from.txt")).to.equal("test:@a");
    expect(registries.get("@a")!.requested).to.deep.equal(["@scope/lib@1.2.0"]);
    expect(registries.get("@a")!.fetched).to.deep.equal(["@scope/lib@1.2.0"]);
    expect(registries.get("@b")!.fetched).to.deep.equal(["top@1.0.0"]);
  });

  it("reads an exact bare-name route (no keyRef) as a route like any other", async () => {
    /* `lodash = @a;` lexes as a bare identifier and carries no keyRef — the
     * route table must be read off property names, or exact unscoped routes
     * silently vanish. */
    const { model } = build(
      REGISTRIES +
        "repository_group @deps { lodash = @a; * = @b; }\n" +
        "test_deps t { deps = @deps:lodash:1.0.0 @deps:left-pad:1.0.0; }\n"
    );
    seed("@a", { "lodash@1.0.0": {} });
    seed("@b", { "left-pad@1.0.0": {} });
    await getTarget(model, "t");
    expect(registries.get("@a")!.fetched).to.deep.equal(["lodash@1.0.0"]);
    expect(registries.get("@b")!.fetched).to.deep.equal(["left-pad@1.0.0"]);
  });

  it("a closed domain (no catch-all) does not serve an unrouted name", async () => {
    const { model } = build(
      "test_registry @a { }\n" +
        "repository_group @deps { @scope/* = @a; }\n" +
        "test_deps t { deps = @deps:left-pad:1.0.0; }\n"
    );
    const message = await failure(model, "t");
    expect(message).to.contain("has no route serving 'left-pad'");
    expect(message).to.contain("@scope/*");
  });

  it("substitutes variables in route keys like any other name", async () => {
    /* Route keys read through the wildcard-property surface, so a `${...}` in
     * a key resolves under the build config before the shape check judges it. */
    const { model } = build(
      REGISTRIES +
        'default SCOPE = "@scope";\n' +
        "repository_group @deps { ${SCOPE}/* = @a; * = @b; }\n" +
        "test_deps t { deps = @deps:@scope/lib:1.0.0; }\n"
    );
    seed("@a", { "@scope/lib@1.0.0": {} });
    await getTarget(model, "t");
    expect(registries.get("@a")!.fetched).to.deep.equal(["@scope/lib@1.0.0"]);
  });

  it("rejects a non-prefix pattern key at the route", async () => {
    const { model } = build(REGISTRIES + "repository_group @deps { \"!(scope)/*\" = @a; * = @b; }\ntest_deps t { deps = @deps:x:1.0.0; }\n");
    const message = await failure(model, "t");
    expect(message).to.contain("in @deps");
    expect(message).to.contain("not a literal name prefix");
  });

  it("rejects a non-registry value under a prefix key — content serves one literal name", async () => {
    /* A value that names no repository is a content route, and a content route
     * serves exactly the one package its key names — a prefix key cannot. */
    const { model } = build(
      "test_registry @b { }\n" +
        "test_deps plain { }\n" +
        "repository_group @deps { @scope/* = plain; * = @b; }\n" +
        "test_deps t { deps = @deps:x:1.0.0; }\n"
    );
    const message = await failure(model, "t");
    expect(message).to.contain("route '@scope/*' in @deps maps a name prefix to package content");
  });

  it("rejects two routes that parse to one canonical key", async () => {
    /* ':' and '/' are equivalent component separators, so `a:b` and `a/b` are
     * distinct property names (invisible to the duplicate-property check) but
     * one route key — an error, never an order-dependent pick. */
    const { model } = build(
      REGISTRIES + "repository_group @deps { a:b = @a; a/b = @b; }\ntest_deps t { deps = @deps:x:1.0.0; }\n"
    );
    const message = await failure(model, "t");
    expect(message).to.contain("are the same key ('a/b')");
  });

  it("rejects a route whose value carries more than the repository", async () => {
    const { model } = build(
      REGISTRIES +
        "test_deps extra { }\n" +
        "repository_group @deps { @scope/* = @a extra; * = @b; }\n" +
        "test_deps t { deps = @deps:x:1.0.0; }\n"
    );
    const message = await failure(model, "t");
    expect(message).to.contain("carries more than the repository");
  });

  it("rejects a group as a route target", async () => {
    const { model } = build(
      REGISTRIES +
        GROUP +
        "repository_group @outer { * = @deps; }\n" +
        "test_deps t { deps = @outer:x:1.0.0; }\n"
    );
    const message = await failure(model, "t");
    expect(message).to.contain("route '*' in @outer does not name a package registry");
    expect(message).to.contain("another repository group");
  });

  it("rejects members speaking different package languages, positioned at the route", async () => {
    const { model } = build(
      "test_registry @a { }\n" +
        "alien_registry @maven { }\n" +
        "repository_group @deps { @scope/* = @a; * = @maven; }\n" +
        "test_deps t { deps = @deps:x:1.0.0; }\n"
    );
    const message = await failure(model, "t");
    expect(message).to.contain("route '*' in @deps names a repository speaking a different package format");
  });

  it("two identical route keys are a duplicate-property error at validation", () => {
    const { errors } = build(REGISTRIES + "repository_group @deps { * = @a; * = @b; }\n", true);
    expect(errors.join("\n")).to.match(/[Dd]uplicate/);
  });

  /** A source tree holding one content-served package (manifest at the
   * package root once the route's `:**` projection strips the written path). */
  function vendorTree(manifest: Record<string, unknown>): FileSet {
    return new FileSet(
      new Map([
        ["vendor/mylib/pkg.json", MemoryFile.from(JSON.stringify(manifest))],
        ["vendor/mylib/lib/index.js", MemoryFile.from("42")],
      ])
    );
  }

  it("serves a content route as a package resolved from its manifest, deps routed through the group", async () => {
    /* The vendored-git-dependency shape: a range requirement on the name
     * (discovered in another registry's metadata) raises to the declared
     * content's version, and the content's own requirements route through the
     * group like any registry-served package's. */
    const { model } = build(
      "test_registry @b { }\n" +
        "repository_group @deps { mylib = ./vendor/mylib:**; * = @b; }\n" +
        "test_deps t { deps = @deps:top:1.0.0; }\n",
      false,
      vendorTree({ version: "1.5.0", deps: { "left-pad": "^1.0.0" } })
    );
    seed("@b", { "top@1.0.0": { mylib: "^1.0.0" }, "left-pad@1.0.0": {} });
    await getTarget(model, "t");

    const top = lastDepSets[0] as PackageFileSet;
    expect(top.packageName).to.equal("top");
    const lib = top.dependencies[0] as PackageFileSet;
    expect(lib.packageName).to.equal("mylib");
    expect(lib.version).to.equal("1.5.0");
    expect(await lib.readFile("lib/index.js")).to.equal("42");
    /* The content's requirement was answered by the registry its name routes
     * to — the composition a standalone content member cannot do. */
    const pad = lib.dependencies[0] as PackageFileSet;
    expect(pad.packageName).to.equal("left-pad");
    expect(await pad.readFile("from.txt")).to.equal("test:@b");
    expect(registries.get("@b")!.fetched).to.have.members(["top@1.0.0", "left-pad@1.0.0"]);
  });

  it("a directly referenced content package resolves at its declared version", async () => {
    const { model } = build(
      "test_registry @b { }\n" +
        "repository_group @deps { mylib = ./vendor/mylib:**; * = @b; }\n" +
        "test_deps t { deps = @deps:mylib:1.5.0; }\n",
      false,
      vendorTree({ version: "1.5.0" })
    );
    await getTarget(model, "t");
    const lib = lastDepSets[0] as PackageFileSet;
    expect(lib.packageName).to.equal("mylib");
    expect(lib.version).to.equal("1.5.0");
  });

  it("rejects a group of only content routes — the ecosystem must come from a registry", async () => {
    const { model } = build(
      "repository_group @deps { mylib = ./vendor/mylib:**; }\ntest_deps t { deps = @deps:mylib:1.5.0; }\n",
      false,
      vendorTree({ version: "1.5.0" })
    );
    const message = await failure(model, "t");
    expect(message).to.contain("@deps has no registry route");
  });

  it("rejects a content route whose value is more than one source", async () => {
    const { model } = build(
      "test_registry @b { }\n" +
        "test_deps plain { }\n" +
        "test_deps extra { }\n" +
        "repository_group @deps { mylib = plain extra; * = @b; }\n" +
        "test_deps t { deps = @deps:x:1.0.0; }\n"
    );
    const message = await failure(model, "t");
    expect(message).to.contain("route 'mylib' in @deps must name a registry or one package's content");
    expect(message).to.contain("resolves to 2 sources");
  });
});
