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

import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { Computable } from "../core/Computable";
import { EMPTY_FILESET, FileSet, FileSource } from "../core/FileSet";
import { MemoryFile } from "../core/MemoryFS";
import {
  ProjectedPackage,
  PublishMember,
  PublishStatus,
  Repository,
  RepositoryPublishRef,
  RepositoryRef,
  RepositoryWriter,
  RepositoryLookup,
  SourceRef,
  Resolved,
} from "../core/Repository";
import { dependencyName, isPackage, PackageFileSet, ResolvedNode } from "../core/PackageFileSet";
import { buildOperation } from "../Fabr";
import { materializeTargets, TargetRef } from "../core/TargetRef";
import { ResolvedTarget } from "./ResolvedTarget";
import { PublishableFileSet } from "../core/PublishableFileSet";
import { SyncSource, syncRule } from "../rules/BuildSync";
import { defaultFilesRule } from "../rules/DefaultFilesRule";
import { RunnableFileSet } from "../core/RunnableFileSet";
import { makeRewrite, Name } from "../core/Name";
import { renderProvenance } from "../core/Provenance";
import { ConflictError, CycleError, FabrError, MultiError, toError } from "../core/Errors";
import { cycleErrorOf } from "../model/ErrorFormatter";
import { LogFormatter, LogLevel } from "../support/Log";
import { BuildAction, IBuildActionDefinition } from "../core/BuildAction";
import { DiscoveredDeps } from "../core/Manifest";
import { defineRule, PluginContribution, RepositoryProvider, RepositoryRegistration, RuleDefinition } from "../rules/Types";
import { FSFileSource } from "../core/FSFileSource";
import { scriptRunRule } from "../rules/RunScript";
import { BuildContext, InternalBuildContext } from "./BuildContext";
import { ResolvedRequirements } from "./Collection";
import { mapEntryOrigin, PropertyMap, PropertyMapValue } from "./PropertyMap";
import { BUILD_OPERATION, BUILD_OVERRIDE, Constraints } from "../model/Constraints";
import { SEMVER, SemverConstraint, SemverVersion, versionToString } from "../resolver/Semver";
import { PackageFormat } from "../resolver/PackageFormat";
import { Requirement } from "../resolver/Types";
import { resolveBarePackage, vendPackageRef } from "../resolver/PackageResolver";
import { RepositoryReader } from "../core/Repository";
import { NamespaceRef, refuseNamespaces } from "../core/NamespaceRef";
import {
  CircularDependencyError,
  DependencyFailedError,
  NameResolutionError,
  NoRuleFoundError,
  ReferenceFailedError,
} from "../model/Errors";
import { ExecutionContext } from "../model/ExecutionContext";
import { declName, INameValue, syntheticValue } from "../model/AST";
import { StringReader } from "../support/StringReader";
import { parseBuildString, parseName } from "../model/Parser";
import { toBuildModel } from "../model/Sema";
import chai, { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { BuildCache } from "../core/BuildCache";

chai.use(chaiAsPromised);

/* The model never writes to it, but ExecutionContext requires a log; these
 * tests don't inspect it, so a stderr-backed one (as the driver uses) serves. */
const testLog = new LogFormatter(LogLevel.Info, console.error);

/* The runtime surroundings for evaluation: one throwaway store serves every
 * test here that does not need its own. A registry's resolution is memoized
 * through it, so it is written to even where nothing is built. */
const cacheRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "fabr-context-test-"));
afterAll(() => fs.rmSync(cacheRoot, { recursive: true, force: true }));
const execution = new ExecutionContext(new BuildCache(cacheRoot, testLog), testLog, EMPTY_FILESET, EMPTY_FILESET);

/** Make a name as the driver hands one over. Every {@link BuildContext} method
 * takes the decl its reference was written in (the CLI synthesizes one over
 * the command line, see CommandLineSource). */
function writtenOnCommandLine(name: string): INameValue {
  const source = { fs: EMPTY_FILESET, file: "<command-line>", reader: new StringReader(name) };
  return syntheticValue(parseName(name), source, 0, name.length);
}

/** Gather what `resolved` requires, by requirement name: a target's
 * requirements under their own names, and anything else as itself under the
 * empty name. */
function requirementsOf(resolved: ResolvedRequirements): Map<string, Resolved[]> {
  const sections = new Map<string, Resolved[]>();
  for (const source of resolved.denoted) {
    const entries: Array<[string, ReadonlyArray<Resolved>]> =
      source instanceof ResolvedTarget ? [...source.resolved.sources] : [["", [source]]];
    entries.forEach(([name, sources]) => sections.set(name, [...(sections.get(name) ?? []), ...sources]));
  }
  return sections;
}

/** A configuration as the framework's own code holds it. */
const internal = (config: BuildContext): InternalBuildContext => config as InternalBuildContext;

/* These tests exercise the evaluation engine with throwaway rules, collected
 * into one contribution that each test's model is built with. Each rule is
 * added to `testRules` and each repository type to `testRepos`, directly or
 * through `registerRule` and `registerRepositoryProvider`. */
const testRules: RuleDefinition[] = [];
const testRepos: RepositoryRegistration[] = [];
function registerRule(type: string, properties: Record<string, string>, evaluate: RuleDefinition["evaluate"]): void {
  testRules.push({ type, properties, evaluate });
}
function registerRepositoryProvider(type: string, provider: RepositoryProvider): void {
  testRepos.push({ type, provider });
}

/* Trivial rules for exercising target-to-target dependency behaviour */
let lastDeps: FileSet | undefined;
/* The delivered sets before the union, for a test that cares about the identity
 * a delivery carries rather than its content. */
let lastDepSets: FileSet[] = [];
testRules.push(
  defineRule({
    type: "test_good",
    properties: {},
    requirements: context => Computable.resolve({ deps: context.getPackageProperty("deps") }),
    evaluateResolved: (_context, requirements) =>
      requirements.materializeAll().then(({ deps }) => {
        lastDepSets = deps;
        lastDeps = FileSet.unionAll(...deps);
        return Computable.resolve(EMPTY_FILESET);
      }),
  })
);
/* States what it requires only after an asynchronous step, so that another
 * target can begin, and ask for this one, before this one has asked for anything. */
testRules.push(
  defineRule({
    type: "test_slow",
    properties: {},
    requirements: context =>
      Computable.from<void>(resolve => setTimeout(resolve, 5)).then(() => ({ deps: context.getPackageProperty("deps") })),
    evaluateResolved: (_context, requirements) => requirements.materializeAll().then(() => EMPTY_FILESET),
  })
);
/* Yields a package under its own target name, so a reference to it delivers one
 * — the subject of a `-> name` package rename. */
testRules.push({
  type: "test_package",
  properties: {},
  evaluate: context => Computable.resolve(new PackageFileSet(new Map([["index.js", MemoryFile.from("")]]), context.name, "1.0.0")),
});
/* A package built against its `deps`, which it states and carries; its one
 * file holds the `MODE` it was built in. */
testRules.push(
  defineRule({
    type: "test_carrier",
    properties: { [BUILD_OPERATION]: "build" },
    requirements: context => Computable.resolve({ dependencies: context.getPackageProperty("deps") }),
    evaluateResolved: (context, requirements) =>
      Computable.forAll([requirements.packages("dependencies"), context.getGlobalString("MODE")], (dependencies, mode) =>
        new PackageFileSet(new Map([["mode.txt", MemoryFile.from(mode)]]), context.name, undefined, dependencies)
      ),
  })
);
/* Holds what its `deps` were materialized as, entry by entry. */
let heldDeps: FileSet[] = [];
testRules.push(
  defineRule({
    type: "test_holds",
    properties: {},
    requirements: context => Computable.resolve({ deps: context.getPackageProperty("deps") }),
    evaluateResolved: (_context, requirements) =>
      requirements.materializeAll().then(({ deps }) => {
        heldDeps = deps;
        return EMPTY_FILESET;
      }),
  })
);
registerRule("test_fail", {}, () => Computable.reject(new Error("reasons")));
/* The operation-hop shape: a rule for one operation whose result IS its own
 * target under another (what `js_package[run]` and the `files` rule do — build
 * myself, then present the result differently). The hop is a dependency edge
 * like any other, so it must carry the stack; this rule is here to hold that. */
registerRule("test_good", { [BUILD_OPERATION]: "run" }, context =>
  context.buildSelfWithOverrides(BUILD_OVERRIDE).then(() => EMPTY_FILESET)
);
/* Resolves its dep under a caller-supplied constraint override, for testing
 * override precedence against a reference's own <k=v> requirement. */
testRules.push(
  defineRule({
    type: "test_override",
    properties: {},
    requirements: context => Computable.resolve({ dep: context.getPackageProperty("dep", Constraints.of({ FLAVOR: "caller" })) }),
    evaluateResolved: (_context, requirements) =>
      requirements.materializeAll().then(({ dep }) => {
        lastDeps = FileSet.unionAll(...dep);
        return Computable.resolve(EMPTY_FILESET);
      }),
  })
);
/* Resolves a GLOBAL under a caller-supplied override, for testing override
 * precedence against a <k=v> requirement written on the global's value (the
 * getGlobalFileProperty path — e.g. getGlobalRunnable forcing BUILD_OPERATION=run). */
testRules.push(
  defineRule({
    type: "test_globaltool",
    properties: {},
    requirements: context =>
      Computable.resolve({ tool: context.getGlobalFileProperty("GLOBALTOOL", Constraints.of({ FLAVOR: "caller" })) }),
    evaluateResolved: (_context, requirements) =>
      requirements.materializeAll().then(({ tool }) => {
        lastDeps = FileSet.unionAll(...tool);
        return Computable.resolve(EMPTY_FILESET);
      }),
  })
);
/* Resolve a tool to launch, through the two accessors that own that contract:
 * a FILES property naming one, and a global naming one. */
registerRule("test_tool", {}, context => context.getRunnableProperty("tool").then(() => EMPTY_FILESET));
registerRule("test_globalrunnable", {}, context => context.getGlobalRunnable("TOOLGLOBAL").then(() => EMPTY_FILESET));
/* Reads a STRING global under a caller override, for testing override precedence
 * against a <k=v> requirement written on the global's value (the getGlobalString /
 * string path — the counterpart of test_globaltool). */
let lastString: string | undefined;
registerRule("test_globalstr", {}, context =>
  context.getGlobalString("GLOBALSTR", Constraints.of({ FLAVOR: "caller" })).then(value => {
    lastString = value;
    return EMPTY_FILESET;
  })
);
registerRule("test_file", {}, context =>
  context.getRequiredString("content").then(content => new FileSet(new Map([["f.txt", MemoryFile.from(content)]])))
);
/* Produces a small multi-file, multi-directory tree, for exercising rename
 * projections (`sel -> tmpl`) into a target's content. */
registerRule("test_dir", {}, () =>
  Computable.resolve(
    new FileSet(
      new Map([
        ["a.expect", MemoryFile.from("A")],
        ["sub/b.expect", MemoryFile.from("B")],
        ["c.txt", MemoryFile.from("C")],
      ])
    )
  )
);
/* Yields two separate sources (a sync-like multi-member result), each with a
 * same-named file plus a unique one, for exercising per-source projection */
registerRule("test_multi", {}, () =>
  Computable.resolve([
    new FileSet(
      new Map([
        ["package.json", MemoryFile.from("one")],
        ["one.tgz", MemoryFile.from("1")],
      ])
    ),
    new FileSet(
      new Map([
        ["package.json", MemoryFile.from("two")],
        ["two.tgz", MemoryFile.from("2")],
      ])
    ),
  ])
);
/* Registered only under a specific constraint, so selection under {} fails */
registerRule("test_constrained", { FLAVOR: "special" }, () => Computable.resolve(EMPTY_FILESET));
/* Reads a REWRITE property and applies it to a fixed set of names, so a test
 * can observe the resolved name mapping. */
let lastRewrite: Array<string | undefined> | undefined;
registerRule("test_rw", {}, context =>
  context
    .getRewriteRules("out")
    .then(makeRewrite)
    .then(rewrite => {
      lastRewrite = ["a.entry.js", "b.entry.js", "keep.txt"].map(name => rewrite(name));
      return EMPTY_FILESET;
    })
);

/* Reads a MAP property, so a test can observe the resolved key -> value map
 * (order preserved, strings substituted and kept as word lists, sub-maps recursive);
 * `testMapObserver` additionally receives the map itself (for origin probes). */
let lastMap: Array<[string, PropertyMapValue]> | undefined;
let testMapObserver: ((map: PropertyMap) => void) | undefined;
registerRule("test_map", {}, context =>
  context.getMap("defines").then(map => {
    lastMap = [...map];
    testMapObserver?.(map);
    return EMPTY_FILESET;
  })
);

/* Repository double: delivers each reference as a single file, and records
 * each reference it delivered. */
/* One entry per delivered reference, labelled with the delivering repository's
 * declared name. Every reference a collection point gathers is delivered by
 * the repository it names. */
const batchCalls: { repo: string; name: string }[] = [];
class TestRepo implements Repository, RepositoryLookup {
  private readonly cache = new Map<string, FileSet>();

  constructor(private readonly label: string = "repo") {}

  /* No sub-package grammar: the whole name is the requirement, nothing projects. */
  public getRepositoryRef(name: Name): RepositoryRef {
    return RepositoryRef.written(this, name);
  }

  public getRepositoryPublishRef(name: Name): RepositoryPublishRef {
    throw new Error(`test_repo is not a publish destination ('${name.toString()}')`);
  }

  public resolve(reference: RepositoryRef): Computable<FileSet> {
    batchCalls.push({ repo: this.label, name: reference.name.toString() });
    return Computable.resolve(this.filesFor(reference.name.toString()));
  }

  private filesFor(name: string): FileSet {
    let files = this.cache.get(name);
    if (!files) {
      files = new FileSet(new Map([[`${name}/data.txt`, MemoryFile.from(name)]]));
      this.cache.set(name, files);
    }
    return files;
  }
}
registerRepositoryProvider("test_repo", context => Computable.resolve(new TestRepo(context.name)));

/* Delivers a runnable rather than plain files, so the launch-bound accessors
 * (getRunnableProperty / getGlobalRunnable / the run verb's materialize) can be
 * driven against a repository reference — what they ask FOR is recorded in
 * batchCalls by the base class. */
class TestToolRepo extends TestRepo {
  public override resolve(reference: RepositoryRef): Computable<FileSet> {
    return super.resolve(reference).then(files => RunnableFileSet.forEntry(files, [...files].map(([name]) => name)[0]));
  }
}
registerRepositoryProvider("test_tool_repo", context => Computable.resolve(new TestToolRepo(context.name)));

/* A registry, whose references resolve jointly: a written name is the package
 * at 1.0.0, or `name:version`; what each version requires is what
 * `registryRequirements` holds for `name@version`, nothing where it holds
 * nothing. A package is one file; under `run` it is delivered as a runnable. */
const REGISTRY_FORMAT: PackageFormat<SemverVersion, SemverConstraint> = {
  ...SEMVER,
  resolutionTag: "buildcontexttest:resolve:1",
  providedMismatch: "tolerate",
  splitReference: (name: Name) => {
    const written = name.toBaseString();
    const colon = written.lastIndexOf(":");
    return colon === -1
      ? { name: written, versionConstraint: "1.0.0" }
      : { name: written.substring(0, colon), versionConstraint: written.substring(colon + 1) };
  },
  validateRequirement: () => undefined,
  parsePublishCoordinate: () => {
    throw new Error("not used");
  },
  readContentPackage: () => {
    throw new Error("not used");
  },
  makeRunnable: pkg => Computable.resolve(RunnableFileSet.forEntry(pkg, `${pkg.packageName}/data.txt`, [], "node")),
};
const registryRequirements = new Map<string, Requirement[]>();
class TestRegistry implements Repository, RepositoryReader<SemverVersion, SemverConstraint> {
  public readonly format = REGISTRY_FORMAT;

  constructor(
    public readonly identity: string,
    public readonly operation: string,
    public readonly name: string
  ) {}

  public getRepositoryRef(name: Name): RepositoryRef | NamespaceRef {
    return vendPackageRef(this, REGISTRY_FORMAT, name);
  }

  public getRepositoryPublishRef(name: Name): never {
    throw new Error(`test_registry is not a publish destination ('${name.toString()}')`);
  }

  public environmentKey(): Computable<string> {
    return Computable.resolve("test-env");
  }

  public fetchFiles(reference: RepositoryRef): Computable<FileSet> {
    return resolveBarePackage(this, reference);
  }

  public getRequirements(pkg: string, version: SemverVersion): Computable<Requirement[]> {
    return Computable.resolve(registryRequirements.get(`${pkg}@${versionToString(version)}`) ?? []);
  }

  public fetch(pkg: string, version: SemverVersion): Computable<PackageFileSet> {
    return Computable.resolve(new PackageFileSet(new Map([[`${pkg}/data.txt`, MemoryFile.from(pkg)]]), pkg, versionToString(version)));
  }
}
/* A fresh identity per instance: a resolution is memoized by it through the
 * cache, and each test's model is a fresh registry. */
let registries = 0;
registerRepositoryProvider("test_registry", context => Computable.resolve(new TestRegistry(`${context.name}#${++registries}`, context.operation, context.name)));

/* A registry whose references must state a version, as npm's must: a name with
 * none is not yet a complete reference. */
const VERSIONED_FORMAT: PackageFormat<SemverVersion, SemverConstraint> = {
  ...REGISTRY_FORMAT,
  resolutionTag: "buildcontexttest:versioned:1",
  splitReference: (name: Name) => {
    const written = name.toBaseString();
    const colon = written.lastIndexOf(":");
    return colon === -1
      ? { name: written, versionConstraint: undefined }
      : { name: written.substring(0, colon), versionConstraint: written.substring(colon + 1) };
  },
  validateRequirement: requirement => {
    if (requirement.versionConstraint === undefined) {
      throw new Error(`'${requirement.name}' states no version`);
    }
  },
};
class TestVersionedRegistry extends TestRegistry {
  public override readonly format = VERSIONED_FORMAT;

  public override getRepositoryRef(name: Name): RepositoryRef | NamespaceRef {
    return vendPackageRef(this, VERSIONED_FORMAT, name);
  }
}
registerRepositoryProvider("test_versioned_registry", context =>
  Computable.resolve(new TestVersionedRegistry(`${context.name}#${++registries}`, context.operation, context.name))
);

/** A repository answering every name with the package of that name, marked as
 * its answer, and a bare scope with the namespace of it — a stand-in for
 * `fabr_home`. */
class TestNamespaceRepo implements Repository, RepositoryLookup {
  public getRepositoryRef(name: Name): RepositoryRef | NamespaceRef {
    const literal = name.toString();
    return /^@[^/:]+$/.test(literal) ? new NamespaceRef(this, literal) : RepositoryRef.written(this, name);
  }

  public getRepositoryPublishRef(name: Name): RepositoryPublishRef {
    throw new Error(`not a publish destination: ${name.toString()}`);
  }

  public resolve(reference: RepositoryRef): Computable<FileSet> {
    return Computable.resolve(new PackageFileSet(new Map([["from-fallback", MemoryFile.from("")]]), reference.name, "1.0.0"));
  }
}
registerRepositoryProvider("test_ns_repo", () => Computable.resolve(new TestNamespaceRepo()));

/* Every member any destination has been asked to package, in call order — the
 * probe behind the "packages only what is named" test. */
const packagedMembers: string[] = [];

/* Publish-capable repository double: vends publish refs, and packages each
 * member's content verbatim plus a `manifest.txt` naming its address — for
 * exercising the sync rules. */
class TestPubRepo extends TestRepo implements RepositoryWriter {
  public override getRepositoryPublishRef(name: Name): RepositoryPublishRef {
    const written = name.toBaseString();
    const colon = written.lastIndexOf(":");
    return new RepositoryPublishRef(this, { name: written.substring(0, colon), version: written.substring(colon + 1) });
  }

  public package(members: PublishMember[]): Computable<PublishableFileSet[]> {
    packagedMembers.push(...members.map(member => member.destination.toString()));
    return Computable.resolve(
      members.map(
        member =>
          new PublishableFileSet(
            FileSet.unionAll(member.content, new FileSet(new Map([["manifest.txt", MemoryFile.from(member.destination.toString())]]))),
            member.destination
          )
      )
    );
  }

  public publish(): Computable<PublishStatus> {
    return Computable.resolve<PublishStatus>("published");
  }
}
registerRepositoryProvider("test_pub", () => Computable.resolve(new TestPubRepo()));
/* The real sync rule, exercised against the double — with the generic files
 * rule, which is what serves a sync under `files` (it has none of its own). */
testRules.push(syncRule, defaultFilesRule);

/* A rule gathering two properties and a global through ONE collection point:
 * all of their references must land in a single joint resolution batch */
testRules.push(
  defineRule({
    type: "test_joint",
    properties: {},
    requirements: context =>
      Computable.resolve({
        adeps: context.getPackageProperty("adeps"),
        bdeps: context.getPackageProperty("bdeps"),
        globalSrc: context.getGlobalFileProperty("JOINT_GLOBAL"),
      }),
    evaluateResolved: (_context, requirements) =>
      requirements.materializeAll().then(({ adeps, bdeps, globalSrc }) => {
        lastDeps = FileSet.unionAll(...adeps, ...bdeps, ...globalSrc);
        return Computable.resolve(EMPTY_FILESET);
      }),
  })
);

/* A leaf build step and a rule that yields it as a build action, for
 * exercising the boundary caching. The step counts its executions so a
 * cache hit (no run) is observable. */
let leafRuns = 0;
const TEST_LEAF_STEP: IBuildActionDefinition = {
  id: "test:leaf",
  version: 1,
  run: action => {
    leafRuns++;
    return Computable.resolve({ result: new FileSet(new Map([["out.txt", MemoryFile.from(action.config.data as string)]])) });
  },
};
registerRule("test_parent", {}, context =>
  context.getRequiredString("content").then(content => new BuildAction(TEST_LEAF_STEP, {}, { data: content }, undefined, "leaf"))
);

/* An internal type built only as a sub-target: it reads its input through the
 * same context accessors as any target (unaware it is anonymous) and yields
 * the leaf action. */
registerRule("test_sub", {}, context =>
  context.getRequiredString("data").then(data => new BuildAction(TEST_LEAF_STEP, {}, { data }, undefined, "sub"))
);
/* A rule that composes the sub-target: builds it, then wraps its output —
 * the wrap runs in resolution (every evaluation), reconstructing shape on the
 * cache-hit path too. */
let wrapRuns = 0;
registerRule("test_composer", {}, context =>
  context.getRequiredString("content").then(content =>
    context.subTarget("test_sub", { data: content }, { label: "sub" }).then(output => {
      wrapRuns++;
      return output.withStep({ kind: "composed-marker" });
    })
  )
);

/* A composer that supplies an EMPTY input bag, so every property the sub-target
 * reads must come from its type's declared defaults. */
registerRule("test_default_composer", {}, context => context.subTarget("test_sub", {}, { label: "sub" }));

/* A composer that hands its sub-target a REWRITE as already-substituted Names —
 * the form a rule computing exact pairs produces (js_compile's `assets`). */
registerRule("test_rw_composer", {}, context =>
  context.subTarget(
    "test_rw",
    {
      out: [
        Name.fromLiteral("a.entry.js").withRenameTo(Name.fromLiteral("one.js")),
        Name.fromLiteral("b.entry.js").withRenameTo(Name.fromLiteral("two.js")),
      ],
    },
    { label: "sub" }
  )
);

/* A composer that hands its sub-target the MAP it read, as it read it. */
registerRule("test_map_composer", {}, context =>
  context.getMap("defines").then(defines => context.subTarget("test_map", { defines }, { label: "sub" }))
);

/* A sub-target that resolves its COMMAND against sources of its own, and a
 * composer that hands it the command as it read it. */
let lastCommand: Array<{ args: string[]; stdout?: string }> | undefined;
registerRule("test_cmd", {}, context =>
  context
    .getCommandProperty("run", new FileSet(new Map([["a.txt", MemoryFile.from("a")], ["b.txt", MemoryFile.from("b")], ["c.md", MemoryFile.from("c")]])))
    .then(stages => {
      lastCommand = stages.map(stage => ({ args: stage.args, stdout: stage.stdout }));
      return EMPTY_FILESET;
    })
);
registerRule("test_cmd_composer", {}, context =>
  context.getCommand("run").then(run => context.subTarget("test_cmd", { run }, { label: "sub" }))
);

/* A composer that builds a sub-target whose type has a rule but NO targetdef —
 * used to assert subTarget rejects a type missing from the build vocabulary. */
registerRule("test_orphan_sub", {}, context =>
  context.getRequiredString("data").then(data => new BuildAction(TEST_LEAF_STEP, {}, { data }, undefined, "orphan"))
);
registerRule("test_orphan_composer", {}, context =>
  context.getRequiredString("content").then(content => context.subTarget("test_orphan_sub", { data: content }, { label: "sub" }))
);

/* A step with **discoverable deps**: it is given the whole `headers` package
 * but reads only the files its source names, and reports those as a selection
 * — so the framework keys it on that selection rather than on everything it
 * could have read. The package is module state so a test can change a header
 * between builds under an unchanged source. */
let compileRuns = 0;
let testHeaders = new PackageFileSet(new Map(), "headers", "1.0.0");
const TEST_COMPILE_STEP: IBuildActionDefinition = {
  id: "test:compile",
  version: 1,
  run: action => {
    compileRuns++;
    const pkg = (action.discoverable!.headers as PackageFileSet[])[0];
    const included = (action.config.includes as string).split(",").filter(name => pkg.getFile(name) !== undefined);
    /* The output IS what it read, so reusing the wrong entry shows up as
     * content rather than only as a missing run. */
    return Computable.forAll(
      included.map(name =>
        pkg
          .getFile(name)!
          .readString()
          .then(text => `${name}=${text}`)
      ),
      (...lines: string[]) => ({
        result: new FileSet(new Map([["out.o", MemoryFile.from(lines.sort().join("\n"))]])),
        /* Each read stated as the path that found it: the `headers` edge of the
         * input's own members, then the file. */
        discoveredDeps: new Map([["headers", included.map(name => ["headers", name])]]) as DiscoveredDeps,
      })
    );
  },
};
registerRule("test_compile", {}, context =>
  context
    .getRequiredString("includes")
    .then(includes => new BuildAction(TEST_COMPILE_STEP, {}, { includes }, { headers: [testHeaders] }))
);

/* Reports the wildcard members (keys the schema never named) its target
 * declares, so a test can observe which of them a configuration admits. */
let lastMemberKeys: string[] | undefined;
registerRule("test_members", {}, context =>
  context.getWildcardProperties().then(members => {
    lastMemberKeys = members.map(member => member.key.toString());
    return EMPTY_FILESET;
  })
);

/* Read a GLOBAL on the target's behalf — `TOOL` as files, built as a rule
 * builds a tool it reads, or `MODE` as a string where the target sets `mode`
 * — after an asynchronous step where it sets `wait`. By then the target's own
 * evaluation is in the target cache, which is what a request re-entering it
 * finds. */
registerRule("test_reads_global", {}, context =>
  Computable.forAll([context.getString("wait"), context.getString("mode")], (wait, mode) =>
    (wait ? Computable.from<void>(resolve => setTimeout(resolve, 5)) : Computable.resolve(undefined))
      .then(
        (): Computable<unknown> =>
          mode ? context.getGlobalString("MODE") : context.getGlobalFileProperty("TOOL").then(materializeTargets)
      )
      .then(() => EMPTY_FILESET)
  )
);

/* Records who its task says required it. */
let lastRequiredBy: string[] = [];
registerRule("test_records_requirer", {}, context => {
  const task = context.taskDescription();
  lastRequiredBy = task.kind === "target-build" ? task.requiredBy.map(declName) : [];
  return Computable.resolve(EMPTY_FILESET);
});

const testContributions: PluginContribution[] = [{ rules: testRules, repositories: testRepos }];

/** Get the cycle `err` reports: unwrapped from the target boundaries around it, and read as the report reads it. */
function circularOf(err: unknown): CircularDependencyError {
  let cause = err;
  while (cause instanceof DependencyFailedError || cause instanceof ReferenceFailedError || cause instanceof MultiError) {
    cause = cause instanceof MultiError ? cause.errors[0] : cause.cause;
  }
  expect(cause, cause instanceof Error ? cause.message : String(cause)).to.be.instanceOf(CycleError);
  const circular = cycleErrorOf((cause as CycleError).labels);
  return (circular instanceof DependencyFailedError ? circular.cause : circular) as CircularDependencyError;
}

/** Await `outcome`, or yield `otherwise` if it has not settled within two
 * seconds — so a build that never settles fails its test rather than hanging
 * the suite. */
function settledOr<T>(outcome: Promise<T>, otherwise: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<T>(resolve => {
    timer = setTimeout(() => resolve(otherwise), 2000);
  });
  return Promise.race([outcome, expiry]).finally(() => clearTimeout(timer));
}

async function testGetProperty(input: string, prop: string, constraints?: Record<string, string>): Promise<string[]> {
  const errors: string[] = [];
  const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
  const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
  if (errors.length !== 0) {
    throw new Error("Parse error:\n" + errors.join("\n"));
  }

  const context = model.getConfig(Constraints.of(constraints ?? {}), execution);
  const result = await internal(context).getProperty(prop);
  return result.getValues();
}

describe("BuildContext", () => {
  it("Renames a built package a reference delivers ('mylib -> other')", async () => {
    /* The same `-> ` rule an external delivery goes through, applied where a
     * built package is referenced: nothing to project, so the rename is the
     * package's own identity — what a consumer mounts it as. */
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_good { deps = PACKAGES; }\n" +
      "targetdef test_package { }\n" +
      "test_package mylib { }\n" +
      "test_good a { deps = mylib -> renamedlib; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
    const delivered = lastDepSets[0] as PackageFileSet;
    expect(delivered).to.be.instanceOf(PackageFileSet);
    expect(delivered.packageName).to.equal("renamedlib");
    /* Only the identity is the rename's — the content is the target's own, and
     * the target is still built and referred to under its declared name. */
    expect([...delivered].map(([name]) => name)).to.deep.equal(["index.js"]);
  });

  it("Rejects renaming a target that does not deliver a package", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_good { deps = PACKAGES; }\n" +
      "targetdef test_file { content = STRING; }\n" +
      "test_file plain { content = hello; }\n" +
      "test_good a { deps = plain -> renamed; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    try {
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      expect.fail("expected target a to fail");
    } catch (err) {
      /* Never a silent no-op: a dropped rename is a mount under the wrong name,
       * which shows up far from the mistake. */
      expect(err).to.be.instanceOf(DependencyFailedError);
      const cause = (err as DependencyFailedError).cause;
      /* Intrinsic to a's own resolution (the referenced target built fine), so
       * it arrives unwrapped, naming the reference the rename was written on. */
      expect(cause.message).to.contain("'plain -> renamed' does not deliver a package");
    }
  });

  it("Wraps dependent target failures with their target chain", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_good { deps = PACKAGES; }\n" + "targetdef test_fail { }\n" + "test_fail b { }\n" + "test_good a { deps = b; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    try {
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      expect.fail("expected target a to fail");
    } catch (err) {
      expect(err).to.be.instanceOf(DependencyFailedError);
      const outer = err as DependencyFailedError;
      expect(declName(outer.target)).to.equal("a");
      /* The failure crossed the written reference 'b' in a's deps: the hop
       * records the use site (value span, property, owning target) */
      expect(outer.cause).to.be.instanceOf(ReferenceFailedError);
      const hop = outer.cause as ReferenceFailedError;
      expect(hop.value.value.toString()).to.equal("b");
      expect(hop.property.name.toBaseString()).to.equal("deps");
      expect(hop.target && declName(hop.target)).to.equal("a");
      expect(hop.cause).to.be.instanceOf(DependencyFailedError);
      const inner = hop.cause as DependencyFailedError;
      expect(declName(inner.target)).to.equal("b");
      expect(inner.cause.message).to.equal("reasons");
    }
  });

  it("Reports a name that resolves to itself as a cycle at the reference that closed it", async () => {
    /* Name shadowing: 'base:*.ts' reads as a directory but a target of that
     * name takes precedence, so the target's srcs are its own output. The
     * cycle is one use site — the written reference, which is the mistake. */
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input = "targetdef test_good { deps = PACKAGES; }\ntest_good base { deps = base:*.ts; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    try {
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("base"));
      expect.fail("expected target base to fail");
    } catch (err) {
      const circular = circularOf(err);
      expect(circular.name).to.equal("base");
      expect(circular.message).to.equal("Circular dependency: 'base' depends on itself");
      expect(circular.cycle.map(site => site.value.value.toString())).to.deep.equal(["base:*.ts"]);
      expect(circular.cycle[0].property.name.toBaseString()).to.equal("deps");
      expect(circular.cycle[0].target && declName(circular.cycle[0].target!)).to.equal("base");
    }
  });

  it("Reports a cycle through several targets as the whole loop", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input = "targetdef test_good { deps = PACKAGES; }\ntest_good one { deps = two; }\ntest_good two { deps = one; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    try {
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("one"));
      expect.fail("expected target one to fail");
    } catch (err) {
      const circular = circularOf(err);
      expect(circular.name).to.equal("one");
      /* Closing reference first ('one', written in two's deps), back to the use
       * site that entered the cycle ('two', written in one's deps). */
      expect(
        circular.cycle.map(
          site => `${site.target && declName(site.target)} ${site.property.name.toBaseString()} = ${site.value.value.toString()}`
        )
      ).to.deep.equal(["two deps = one", "one deps = two"]);
    }
  });

  it("Reports a cycle that closes through an operation hop, rather than overflowing", async () => {
    /* `one[build]` needs `two[run]`, whose rule's result is `two[build]` (the
     * js_package[run] shape), and two's own deps close back on one. The cycle
     * is named rather than recursing to a RangeError. */
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_good { deps = PACKAGES; }\n" +
      "test_good one { deps = two<BUILD_OPERATION=run>; }\n" +
      "test_good two { deps = one; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    try {
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("one"));
      expect.fail("expected target one to fail");
    } catch (err) {
      const circular = circularOf(err);
      /* The whole loop, both use sites: one's deps naming two under `run`, and
       * two's deps naming one back. */
      expect(
        circular.cycle.map(
          site => `${site.target && declName(site.target)} ${site.property.name.toBaseString()} = ${site.value.value.toString()}`
        )
      ).to.deep.equal(["one deps = two<BUILD_OPERATION=run>", "two deps = one"]);
    }
  });

  describe("a cycle entered through something a target's rule reads", () => {
    /* The target reaches itself only through what its rule reads, never through
     * one of its own properties. The cycle must be found however the timing
     * falls, including a re-entry that arrives after the evaluation was cached
     * and joins it. */
    /* (Under `run`, test_good reaches itself under `build`, so the loops below
     * close in the build configuration: on `u`, by the global naming it.) */
    const DEFS = "targetdef test_reads_global { wait = STRING; mode = STRING; }\ntargetdef test_good { deps = PACKAGES; }\n";

    async function cycleOf(input: string, name: string, operation = "run"): Promise<CircularDependencyError> {
      const errors: string[] = [];
      const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
      const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", DEFS + input, logger)], logger, testContributions);
      expect(errors).to.deep.equal([]);
      const failure = await settledOr(
        Promise.resolve(
          model.getConfig(Constraints.of({ BUILD_OPERATION: operation }), execution).materialize(writtenOnCommandLine(name))
        ).then(
          () => new Error("built"),
          (err: Error) => err
        ),
        new Error("never settled")
      );
      /* Where several named targets are in the cycle each reports it, so one
       * of them is followed. */
      return circularOf(failure);
    }
    const sites = (circular: CircularDependencyError): string[] =>
      circular.cycle.map(site => `${site.target ? declName(site.target) + " " : ""}${site.property.name.toBaseString()} = ${site.value.value.toString()}`);

    for (const wait of ["", " wait = yes;"]) {
      const timing = wait ? "after an asynchronous step" : "immediately";

      it(`names a FILES global that names the target reading it (${timing})`, async () => {
        const circular = await cycleOf(`TOOL = t;\ntest_reads_global t {${wait} }\n`, "t");
        expect(circular.name).to.equal("t");
        expect(sites(circular)).to.deep.equal(["TOOL = t"]);
      });

      it(`names a FILES global naming a target that depends on the one reading it (${timing})`, async () => {
        const circular = await cycleOf(`TOOL = u;\ntest_good u { deps = t; }\ntest_reads_global t {${wait} }\n`, "t");
        /* Read from `t`, the first of the cycle to be asked for: the closing
         * reference, then the one that led to it. */
        expect(circular.name).to.equal("t");
        expect(sites(circular)).to.deep.equal(["u deps = t", "TOOL = u"]);
      });

      it(`names a string global whose command needs the target reading it (${timing})`, async () => {
        const circular = await cycleOf(`MODE = \`u\`;\ntest_good u { deps = t; }\ntest_reads_global t { mode = yes;${wait} }\n`, "t");
        expect(sites(circular)).to.deep.equal(["MODE = `u`", "u deps = t"]);
      });
    }

    it("names the command that runs a tool depending on the target running it", async () => {
      const circular = await cycleOf("targetdef test_cmd { run = COMMAND; }\ntest_cmd g { run = u a.txt; }\ntest_good u { deps = g; }\n", "g", "build");
      expect(circular.name).to.equal("g");
      expect(sites(circular)).to.deep.equal(["u deps = g", "g run = u"]);
    });

    it("names the redirect that reads from a target depending on the one running the command", async () => {
      const circular = await cycleOf(
        "targetdef test_cmd { run = COMMAND; }\ntest_cmd g { run = echo < u; }\ntest_good u { deps = g; }\n",
        "g",
        "build"
      );
      expect(sites(circular)).to.deep.equal(["u deps = g", "g run = u"]);
    });

    it("finds the cycle when the target the global names was resolved before the one reading it", async () => {
      /* `t` and then `u` are resolved by the name that lists them, neither
       * under the other, so the answer is already in hand when `t`'s rule reads
       * TOOL. The cycle is found by carrying on through what `u` requires to
       * `t`. */
      const circular = await cycleOf("TOOL = u;\nALL = t u;\ntest_good u { deps = t; }\ntest_reads_global t { }\n", "ALL", "build");
      expect(circular.name).to.equal("t");
    });

    for (const order of ["w t u", "u w t", "t u w"]) {
      it(`finds the cycle through a global another target resolved first (${order})`, async () => {
        /* `w` and `u` both reach `t` through COMMON, and whichever is resolved
         * second gets COMMON's answer without asking for `t` itself. The
         * cycle closes when `t` is built and its rule reads TOOL. */
        const circular = await cycleOf(
          `TOOL = u;\nCOMMON = t;\nALL = ${order};\ntest_good w { deps = COMMON; }\ntest_good u { deps = COMMON; }\ntest_reads_global t { }\n`,
          "ALL",
          "build"
        );
        /* Reported at whichever target of the cycle is being asked for again. */
        expect(["t", "u"]).to.include(circular.name);
      });
    }

    it("finds the cycle through a string global another target read first", async () => {
      /* `w` is the first to read MODE, whose command needs `u`, which needs
       * `t`; `t` then reads MODE while it is still being answered for `w`. */
      const circular = await cycleOf(
        "MODE = `u`;\nALL = w t;\ntest_good u { deps = t; }\ntest_reads_global w { mode = yes; }\ntest_reads_global t { mode = yes; }\n",
        "ALL",
        "build"
      );
      expect(["t", "MODE"]).to.include(circular.name);
    });

    for (const order of ["a b", "b a"]) {
      it(`finds a cycle between two targets resolved side by side (${order})`, async () => {
        /* Neither is resolved under the other: `a` pauses before it asks for
         * `b`, and `b`, begun in the meantime, asks for `a` and joins it. */
        const circular = await cycleOf(
          `targetdef test_slow { deps = PACKAGES; }\nALL = ${order};\ntest_slow a { deps = b; }\ntest_good b { deps = a; }\n`,
          "ALL",
          "build"
        );
        expect(["a", "b"]).to.include(circular.name);
        expect(sites(circular).sort()).to.deep.equal(["a deps = b", "b deps = a"]);
      });
    }

    it("finds a cycle between two slow targets resolved side by side", async () => {
      const circular = await cycleOf(
        "targetdef test_slow { deps = PACKAGES; }\nALL = a b;\ntest_slow a { deps = b; }\ntest_slow b { deps = a; }\n",
        "ALL",
        "build"
      );
      expect(sites(circular).sort()).to.deep.equal(["a deps = b", "b deps = a"]);
    });

    describe("through a global read under the reader's own overrides, which is not cached", () => {
      const TOOLS = "targetdef test_globalrunnable { }\ntargetdef test_globalstr { }\n";

      it("finds a tool global that names the target reading it", async () => {
        const circular = await cycleOf(`${TOOLS}TOOLGLOBAL = t;\ntest_globalrunnable t { }\n`, "t", "build");
        expect(circular.name).to.equal("t");
        expect(sites(circular)).to.deep.equal(["TOOLGLOBAL = t"]);
      });

      it("finds a tool global naming a target that depends on the one reading it", async () => {
        const circular = await cycleOf(`${TOOLS}TOOLGLOBAL = u;\ntest_good u { deps = t; }\ntest_globalrunnable t { }\n`, "t", "build");
        expect(sites(circular)).to.include.members(["TOOLGLOBAL = u", "u deps = t"]);
      });

      it("finds two tool globals that reach each other through targets that read them", async () => {
        const circular = await cycleOf(
          `${TOOLS}targetdef test_tool { tool = PACKAGES; }\nTOOLGLOBAL = u;\ntest_tool u { tool = t; }\ntest_globalrunnable t { }\n`,
          "t",
          "build"
        );
        expect(sites(circular)).to.include.members(["TOOLGLOBAL = u", "u tool = t"]);
      });

      it("finds a string global whose value reads itself back", async () => {
        const circular = await cycleOf(`${TOOLS}FLAVOR = ambient;\nGLOBALSTR = \${OTHER};\nOTHER = \${GLOBALSTR};\ntest_globalstr t { }\n`, "t", "build");
        expect(["GLOBALSTR", "OTHER"]).to.include(circular.name);
      });
    });

    it("says which target the cycle re-entered, where no property of its own did", async () => {
      const circular = await cycleOf("TOOL = t;\ntest_reads_global t { wait = yes; }\n", "t");
      expect(circular.entered && declName(circular.entered)).to.equal("t");
    });
  });

  it("Names the target whose rule read a global as the requirer of what the global names", async () => {
    /* No property of `t` names `u` — its rule reads TOOL — so only t's own
     * evaluation on the stack says who wanted it. */
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_reads_global { wait = STRING; mode = STRING; }\ntargetdef test_records_requirer { }\ntargetdef test_good { deps = PACKAGES; }\n" +
      "TOOL = u;\ntest_records_requirer u { }\ntest_reads_global t { }\ntest_good top { deps = t; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("top"));
    expect(lastRequiredBy).to.deep.equal(["t", "top"]);
  });

  it("Reports a cycle between global FILES properties instead of overflowing", async () => {
    /* A cycle between globals is found in the Computable graph like any other,
     * and reported positioned rather than overflowing. */
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input = "A = B;\nB = A;\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    try {
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("A"));
      expect.fail("expected property A to fail");
    } catch (err) {
      const circular = circularOf(err);
      expect(circular.name).to.equal("A");
      expect(circular.cycle.map(site => `${site.property.name.toBaseString()} = ${site.value.value.toString()}`)).to.deep.equal([
        "B = A",
        "A = B",
      ]);
    }
  });

  it("Reports a self-referential global FILES property as a one-site cycle", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input = "DEPS = DEPS;\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    try {
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("DEPS"));
      expect.fail("expected property DEPS to fail");
    } catch (err) {
      const circular = circularOf(err);
      expect(circular.name).to.equal("DEPS");
      expect(circular.cycle.map(site => site.value.value.toString())).to.deep.equal(["DEPS"]);
    }
  });

  it("Reports a guard reading its own property as a cycle instead of overflowing", async () => {
    /* Judging FOO's guard reads FOO, so the loop is the ordinary positioned
     * cycle error, not a RangeError. */
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input = "FOO<FOO=x> = y;\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    try {
      await internal(model.getConfig(Constraints.of({}), execution)).getProperty("FOO");
      expect.fail("expected property FOO to fail");
    } catch (err) {
      expect(circularOf(err).name).to.equal("FOO");
    }
  });

  it("Reports mutually-guarded properties as a cycle instead of overflowing", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input = "A<B=1> = x;\nB<A=1> = y;\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    try {
      await internal(model.getConfig(Constraints.of({}), execution)).getProperty("A");
      expect.fail("expected property A to fail");
    } catch (err) {
      const circular = circularOf(err);
      expect(circular.name).to.equal("A");
      /* Both use sites — each frame's value is the guarded declaration's key. */
      expect(circular.cycle.map(site => site.value.value.toString())).to.deep.equal(["B<A=1>", "A<B=1>"]);
    }
  });

  it("Reports a transitive guard cycle that closes through an ordinary value", async () => {
    /* The guard-judgment frame is the stack for everything the guard
     * transitively demands — here MODE carries no guard at all, and the loop
     * closes through its VALUE reading FOO back. */
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input = "FOO<MODE=x> = y;\nMODE = ${FOO};\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    try {
      await internal(model.getConfig(Constraints.of({}), execution)).getProperty("FOO");
      expect.fail("expected property FOO to fail");
    } catch (err) {
      const circular = circularOf(err);
      expect(circular.name).to.equal("FOO");
      /* Both hops: MODE's value reading FOO back, and the guarded key that
       * demanded MODE. */
      expect(circular.cycle.map(site => site.value.value.toString())).to.deep.equal(["${FOO}", "FOO<MODE=x>"]);
    }
  });

  it("Lets a target property reference a same-named global (not a cycle)", async () => {
    /* Target properties are not in the `${}` namespace, so `${deps}` inside the
     * target's own `deps` binds to the global — and, not being referenceable, a
     * target property can never close a cycle: this is no cycle, and must not
     * be reported as one. */
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input = "targetdef test_good { deps = PACKAGES; }\ndeps = sub;\ntest_good t { deps = ${deps}/*.txt; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("t"));
    expect(lastDeps?.isEmpty()).to.equal(true);
  });

  it("Attributes file conflicts to the dependencies that introduced them", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_good { deps = PACKAGES; }\n" +
      "targetdef test_file { content = STRING; }\n" +
      "test_file c1 { content = one; }\n" +
      "test_file c2 { content = two; }\n" +
      "test_good a { deps = c1 c2; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    try {
      await model.getConfig(Constraints.of({ arch: "armv7" }), execution).materialize(writtenOnCommandLine("a"));
      expect.fail("expected target a to fail");
    } catch (err) {
      expect(err).to.be.instanceOf(DependencyFailedError);
      const cause = (err as DependencyFailedError).cause;
      expect(cause.message).to.equal("Conflicting files for f.txt (from 'c1' and 'c2')");
      expect(cause).to.be.instanceOf(ConflictError);
      const conflict = cause as ConflictError;
      expect(conflict.key).to.equal("f.txt");
      expect(conflict.left.label).to.equal("c1");
      expect(conflict.right.label).to.equal("c2");

      /* Each side carries a provenance chain: the model reference (the
       * written value's span, its use site, active constraints as the label)
       * chained onto the producing target's step */
      const rendered = renderProvenance(conflict.left.provenance, { path: "f.txt" });
      expect(rendered[0].message).to.equal("from 'c1' (a deps)");
      expect(rendered[0].label).to.equal("with arch=armv7");
      const loc = rendered[0].loc!;
      expect(loc.file).to.equal("TEST.fabr");
      const pos = loc.reader.resolvePosition(loc.offset)!;
      expect(pos.line).to.equal(5);
      expect(pos.lineText).to.equal("test_good a { deps = c1 c2; }");
      /* The span underlines exactly the written 'c1' */
      expect(loc.endOffset! - loc.offset).to.equal(2);
      expect(rendered.some(note => note.message === "built by test_file 'c1'")).to.equal(true);

      /* A caller's ambient keys are elided from the "with" annotation */
      const elided = renderProvenance(conflict.left.provenance, { path: "f.txt", elideConstraintKeys: new Set(["arch"]) });
      expect(elided[0].label).to.equal(undefined);
    }
  });

  it("Says where a substituted reference got its value", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_good { deps = PACKAGES; }\n" +
      "targetdef test_file { content = STRING; }\n" +
      "test_file c1 { content = one; }\n" +
      "test_file c2 { content = two; }\n" +
      "FIRST = c1;\n" +
      "test_good a { deps = ${FIRST} c2; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    try {
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      expect.fail("expected target a to fail");
    } catch (err) {
      const conflict = (err as DependencyFailedError).cause as ConflictError;
      const rendered = renderProvenance(conflict.left.provenance, { path: "f.txt" });
      expect(rendered[0].message).to.equal("from '${FIRST}' (a deps)");
      /* The note after it points at the value FIRST was given, where it was
       * given — the line to change when that value is what is wrong. */
      expect(rendered[1].message).to.equal("FIRST is 'c1'");
      const loc = rendered[1].loc!;
      const pos = loc.reader.resolvePosition(loc.offset)!;
      expect(pos.lineText).to.equal("FIRST = c1;");
      expect(loc.endOffset! - loc.offset).to.equal(2);
    }
  });

  it("Attributes a conflict raised mid-resolution to the written value that caused it", async () => {
    /* A projection into a multi-source property (`x:f.txt`) unions two producers
     * that both emit `f.txt` — the conflict is raised inside the value's own
     * resolution (a rename projection collapsing names is the same path), before
     * the model step is stamped, so it must be chained on so the driver
     * traces it to the written `x:f.txt`, not just the underlying producers. */
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_good { deps = PACKAGES; }\n" +
      "targetdef test_file { content = STRING; }\n" +
      "test_file c1 { content = one; }\n" +
      "test_file c2 { content = two; }\n" +
      "x = c1 c2;\n" +
      "test_good a { deps = x:f.txt; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    try {
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      expect.fail("expected target a to fail");
    } catch (err) {
      expect(err).to.be.instanceOf(DependencyFailedError);
      const cause = (err as DependencyFailedError).cause;
      expect(cause).to.be.instanceOf(ConflictError);
      const conflict = cause as ConflictError;
      /* The outermost provenance hop is the written value `x:f.txt` in a's deps,
       * chained on by the mid-resolution enrichment — above the producing
       * targets' own steps. */
      const rendered = renderProvenance(conflict.left.provenance, { path: "f.txt" });
      expect(rendered[0].message).to.equal("from 'x:f.txt' (a deps)");
      const pos = rendered[0].loc!.reader.resolvePosition(rendered[0].loc!.offset)!;
      expect(pos.lineText).to.equal("test_good a { deps = x:f.txt; }");
    }
  });

  it("Wraps an unmatched target type per written reference, like a failed build", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_good { deps = PACKAGES; }\n" +
      "targetdef test_constrained { }\n" +
      "test_constrained n { }\n" +
      "test_good a { deps = n; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    try {
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      expect.fail("expected target a to fail");
    } catch (err) {
      expect(err).to.be.instanceOf(DependencyFailedError);
      /* The no-rule failure crossed the written reference 'n' in a's deps */
      const hop = (err as DependencyFailedError).cause;
      expect(hop).to.be.instanceOf(ReferenceFailedError);
      expect((hop as ReferenceFailedError).value.value.toString()).to.equal("n");
      expect((hop as ReferenceFailedError).property.name.toBaseString()).to.equal("deps");
      const cause = (hop as ReferenceFailedError).cause;
      expect(cause).to.be.instanceOf(NoRuleFoundError);
      const noRule = cause as NoRuleFoundError;
      expect(noRule.message).to.equal("No rule matches target 'n' of type 'test_constrained'");
      expect(declName(noRule.target)).to.equal("n");
      /* The full constraint set rides as data; presentation decides what shows */
      expect(noRule.constraints.isEmpty()).to.equal(true);
    }
  });

  it("rejects a prototype-polluting name instead of resolving an inherited member", async () => {
    /* Names are user-controlled. A name like `toString` or `__proto__` must
     * resolve as an ordinary unknown name, not hit an Object.prototype member. */
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const model = toBuildModel(
      [parseBuildString(EMPTY_FILESET, "TEST.fabr", "targetdef test_good { deps = PACKAGES; }\n", logger)],
      logger,
      testContributions
    );
    expect(errors).to.deep.equal([]);

    for (const name of ["toString", "valueOf", "__proto__", "constructor"]) {
      let threw = false;
      try {
        await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine(name));
      } catch (err) {
        threw = true;
        expect((err as Error).message, name).to.match(/^Unknown name '/);
      }
      expect(threw, `expected '${name}' to be unresolved`).to.equal(true);
    }
    /* The `${valueOf}` property path is guarded the same way. */
    expect(() => internal(model.getConfig(Constraints.of({}), execution)).getProperty("valueOf")).to.throw(/Unknown property/);
  });

  it("Fails a literal name that names no target and matches no file", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input = "targetdef test_good { deps = PACKAGES; }\n" + "test_good a { deps = fooff; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    try {
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      expect.fail("expected target a to fail");
    } catch (err) {
      expect(err).to.be.instanceOf(DependencyFailedError);
      const cause = (err as DependencyFailedError).cause;
      expect(cause).to.be.instanceOf(NameResolutionError);
      expect(cause.message).to.equal("Unable to resolve 'fooff'");
      /* The use site identifies whose property the name was written in */
      const useSite = (cause as NameResolutionError).useSite;
      expect(useSite && useSite.property.name.toBaseString()).to.equal("deps");
      expect(useSite?.target && declName(useSite.target)).to.equal("a");
      /* The position points at the written value, not the target declaration */
      const position = (cause as NameResolutionError).position;
      expect(position.file).to.equal("TEST.fabr");
      const resolved = position.reader.resolvePosition(position.offset);
      expect(resolved?.line).to.equal(2);
      expect(resolved?.lineText).to.equal("test_good a { deps = fooff; }");
      expect(resolved && resolved.lineText[resolved.column - 1]).to.equal("f");
    }
  });

  it("resolves a naked FILES reference against the constraint map (override repins)", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_good { deps = PACKAGES; }\n" +
      "targetdef test_file { content = STRING; }\n" +
      "test_file t1 { content = one; }\n" +
      "test_file t2 { content = two; }\n" +
      "tool = t1;\n" +
      "test_good a { deps = tool; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    /* No override: the naked `tool` resolves the declared value t1. */
    await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
    expect(await lastDeps!.readFile("f.txt")).to.equal("one");

    /* `-Dtool=t2` (a constraint) repins the same bare reference to t2. */
    await model.getConfig(Constraints.of({ tool: "t2" }), execution).materialize(writtenOnCommandLine("a"));
    expect(await lastDeps!.readFile("f.txt")).to.equal("two");
  });

  it("Leaves a glob matching nothing as an empty resolution", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input = "targetdef test_good { deps = PACKAGES; }\n" + "test_good a { deps = fooff*; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
    expect(lastDeps?.isEmpty()).to.equal(true);
  });

  it("Fails a literal projection into a target that matches no file", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_good { deps = PACKAGES; }\n" +
      "targetdef test_file { content = STRING; }\n" +
      "test_file b { content = one; }\n" +
      "test_good a { deps = b:missing.txt; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    try {
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      expect.fail("expected target a to fail");
    } catch (err) {
      expect(err).to.be.instanceOf(DependencyFailedError);
      const cause = (err as DependencyFailedError).cause;
      expect(cause).to.be.instanceOf(NameResolutionError);
      expect(cause.message).to.equal("Unable to resolve 'b:missing.txt'");
    }
  });

  it("Judges a literal projection over every source the name reached, targets among them", async () => {
    /* `P` reaches two targets, each answering for the name once it is built:
     * the name fails only where neither has the file, and passes where either
     * does. */
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_good { deps = PACKAGES; }\n" +
      "targetdef test_file { content = STRING; }\n" +
      "targetdef test_dir { }\n" +
      "test_file b { content = one; }\n" +
      "test_dir d { }\n" +
      "P = b d;\n" +
      "test_good either { deps = P:c.txt; }\n" +
      "test_good neither { deps = P:missing.txt; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);
    const config = model.getConfig(Constraints.of({}), execution);
    /* Only `d` has c.txt. */
    await config.materialize(writtenOnCommandLine("either"));
    try {
      await config.materialize(writtenOnCommandLine("neither"));
      expect.fail("expected target neither to fail");
    } catch (err) {
      expect(err).to.be.instanceOf(DependencyFailedError);
      const cause = (err as DependencyFailedError).cause;
      expect(cause).to.be.instanceOf(NameResolutionError);
      expect(cause.message).to.equal("Unable to resolve 'P:missing.txt'");
    }
  });

  it("Projects a multi-source target per source, never unioning across members", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input = "targetdef test_multi { }\n" + "test_multi m { }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);
    const config = model.getConfig(Constraints.of({}), execution);

    /* A name every member matches: one projected source per member — the
     * same-named files are NOT a conflict here (union, and its conflict
     * detection, is the consumer's act). */
    const both = await config.materialize(writtenOnCommandLine("m:package.json"));
    expect(both).to.have.length(2);
    const contents = await Promise.all(both.map(source => (source as FileSet).get("package.json").then(file => file!.readString())));
    expect(contents.sort()).to.deep.equal(["one", "two"]);

    /* A name only one member matches: the missed members are dropped, not
     * kept as empty sources. */
    const one = await config.materialize(writtenOnCommandLine("m:one.tgz"));
    expect(one).to.have.length(1);
    expect([...(one[0] as FileSet)].map(([name]) => name)).to.deep.equal(["one.tgz"]);
  });

  it("Hands a target that requires a multi-source target each of its sources", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input = "targetdef test_multi { }\ntargetdef test_holds { deps = PACKAGES; }\ntest_multi m { }\ntest_holds u { deps = m; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);
    await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("u"));
    /* The same-named files of two sources are no conflict: nothing unions them. */
    expect(heldDeps).to.have.length(2);
    const contents = await Promise.all(heldDeps.map(source => source.get("package.json").then(file => file!.readString())));
    expect(contents.sort()).to.deep.equal(["one", "two"]);
  });

  const RELEASE_INPUT =
    "targetdef test_pub { }\n" +
    "targetdef test_file { content = STRING; }\n" +
    "targetdef sync { * = FILES; }\n" +
    "test_pub pub { }\n" +
    "test_file c1 { content = one; }\n" +
    "test_file c2 { content = two; }\n" +
    "sync release { pub:alpha:1.0.0 = c1; pub:beta:2.0.0 = c2; }\n";

  /** The release above, as the given operation sees it. */
  function releaseConfig(operation: string): BuildContext {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", RELEASE_INPUT, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);
    return model.getConfig(Constraints.of({ [BUILD_OPERATION]: operation }), execution);
  }

  const namesOf = (sources: unknown[]): string[] => sources.flatMap(source => [...(source as FileSet)].map(([name]) => name)).sort();

  it("Addresses a sync member's files by coordinate, identically under build and files", async () => {
    /* The release is a namespace: a projection into it names a member's file by
     * the ordinary written-name rule (alias separators as path separators), and
     * means the same thing under either operation — `files` yields the build's
     * own content, never a differently-shaped view of it, which is what lets one
     * written reference mean one thing at the CLI and in a build script. */
    for (const operation of ["files", "build"]) {
      const config = releaseConfig(operation);
      const slash = await config.materialize(writtenOnCommandLine("release/pub/alpha/1.0.0/manifest.txt"));
      expect(namesOf(slash), operation).to.deep.equal(["release/pub/alpha/1.0.0/manifest.txt"]);
      /* Colon form strips to the last alias boundary, as anywhere else. */
      const colon = await config.materialize(writtenOnCommandLine("release:pub:alpha:1.0.0:manifest.txt"));
      expect(namesOf(colon), operation).to.deep.equal(["manifest.txt"]);
      /* The vended ref's display form is the full written coordinate — the
       * resolver attached the repository's declared name (`pub`) at vend time. */
      const file = await (colon[0] as FileSet).get("manifest.txt");
      expect(await file!.readString(), operation).to.equal("pub:alpha:1.0.0");
    }
  });

  it("Yields the carrier itself for a member named in full, and its files for a glob", async () => {
    const config = releaseConfig("build");
    /* Naming a member outright yields the entity — still publishable, which is
     * what lets `fabr sync release/pub/alpha/1.0.0` publish just that one. */
    const member = await config.materialize(writtenOnCommandLine("release/pub/alpha/1.0.0"));
    expect(member).to.have.length(1);
    expect(member[0]).to.be.instanceOf(PublishableFileSet);
    expect((member[0] as PublishableFileSet).destination.toString()).to.equal("pub:alpha:1.0.0");
    /* Its content is the wire artifact as the destination made it, root-relative. */
    expect(namesOf(member)).to.deep.equal(["f.txt", "manifest.txt"]);

    /* A glob is a match over the namespace's files, not a name for an entry. */
    const globbed = await config.materialize(writtenOnCommandLine("release/**/manifest.txt"));
    expect(namesOf(globbed)).to.deep.equal(["release/pub/alpha/1.0.0/manifest.txt", "release/pub/beta/2.0.0/manifest.txt"]);

    /* A bare `**` spans every member — what a name that stops AT the release
     * asks for, and how the file verbs list one (they hold files, so a source
     * that is not itself a FileSet is opened out this way rather than silently
     * listing nothing). */
    const all = await releaseConfig("build").materialize(writtenOnCommandLine("release"));
    const everything = await (all[0] as SyncSource).find(parseName("**"));
    expect([...everything].map(([name]) => name).sort()).to.deep.equal([
      "pub/alpha/1.0.0/f.txt",
      "pub/alpha/1.0.0/manifest.txt",
      "pub/beta/2.0.0/f.txt",
      "pub/beta/2.0.0/manifest.txt",
    ]);
  });

  it("Publishes one package in two configurations, each as its own build", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "default MODE = plain;\n" +
      "targetdef test_pub { }\n" +
      "targetdef test_package { }\n" +
      "targetdef test_carrier { deps = PACKAGES; }\n" +
      "targetdef sync { * = FILES; }\n" +
      "test_pub pub { }\n" +
      "test_package base { }\n" +
      "test_carrier lib { deps = base; }\n" +
      "sync twice { pub:lib-debug:1.0.0 = lib<MODE=debug>; pub:lib:1.0.0 = lib<MODE=release>; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);
    const config = model.getConfig(Constraints.of({ [BUILD_OPERATION]: "build" }), execution);
    const modeOf = async (member: string): Promise<string> => {
      const [files] = await config.materialize(writtenOnCommandLine(`twice:pub:${member}:1.0.0:mode.txt`));
      return (await (files as FileSet).get("mode.txt"))!.readString();
    };
    expect(await modeOf("lib-debug")).to.equal("debug");
    expect(await modeOf("lib")).to.equal("release");
  });

  it("Packages only the members a reference names", async () => {
    /* The declaration is a list of outputs, not an instruction to make all of
     * them: naming one member must not build the others (the same property a
     * `fetch` table has — the table is a pin, not a download list). */
    packagedMembers.length = 0;
    const config = releaseConfig("build");
    await config.materialize(writtenOnCommandLine("release/pub/alpha/1.0.0/manifest.txt"));
    expect(packagedMembers).to.deep.equal(["pub:alpha:1.0.0"]);

    /* And the whole release when the whole release is named. */
    packagedMembers.length = 0;
    const all = await releaseConfig("build").materialize(writtenOnCommandLine("release"));
    const release = all[0] as SyncSource;
    const everything = await release.members();
    expect([...packagedMembers].sort()).to.deep.equal(["pub:alpha:1.0.0", "pub:beta:2.0.0"]);
    /* Selecting every member IS naming them all: `members()` narrows nothing
     * rather than being a second way in, so the two cannot drift apart. */
    const globbed = await release.members(parseName("**"));
    expect(globbed).to.deep.equal(everything);
  });

  it("Reports a name that no member answers against the declared members", async () => {
    const config = releaseConfig("files");
    try {
      await config.materialize(writtenOnCommandLine("release/pub/gamma/3.0.0/manifest.txt"));
      expect.fail("expected an unknown-member failure");
    } catch (err) {
      expect(toError(err).message).to.match(/release has no member matching 'pub\/gamma\/3\.0\.0\/manifest\.txt'/);
    }
  });

  it("Defers a multi-source same-name collision to the consumer that unions", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_good { deps = PACKAGES; }\n" +
      "targetdef test_multi { }\n" +
      "test_multi m { }\n" +
      "test_good a { deps = m:package.json; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    try {
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      expect.fail("expected target a to fail");
    } catch (err) {
      expect(err).to.be.instanceOf(DependencyFailedError);
      const cause = (err as DependencyFailedError).cause;
      expect(cause).to.be.instanceOf(ConflictError);
      expect((cause as ConflictError).key).to.equal("package.json");
    }
  });

  it("Renames a recursive projection into a target, structure-preserving", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_good { deps = PACKAGES; }\n" +
      "targetdef test_dir { }\n" +
      "test_dir d { }\n" +
      "test_good a { deps = d:**/*.expect -> **/*.out; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
    /* `.expect` files renamed to `.out`, directory structure kept, `c.txt`
     * dropped (not selected); the root-level file gets no leading slash. */
    expect(lastDeps && [...lastDeps].map(([name]) => name).sort()).to.deep.equal(["a.out", "sub/b.out"]);
  });

  it("Handles a colon reaching the projection selector (multi-colon ref), renamed", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    /* `d:sub:*.expect` — getPrefixMatch stops at target `d`, so the projection
     * selector is `sub:*.expect` (a reached colon): it matches `sub/…` and the
     * `sub/` alias is stripped, then renamed. */
    const input =
      "targetdef test_good { deps = PACKAGES; }\n" +
      "targetdef test_dir { }\n" +
      "test_dir d { }\n" +
      "test_good a { deps = d:sub:*.expect -> *.out; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
    expect(lastDeps && [...lastDeps].map(([name]) => name).sort()).to.deep.equal(["b.out"]);
  });

  it("Renames a single-segment projection, leaving subdirectories unselected", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_good { deps = PACKAGES; }\n" +
      "targetdef test_dir { }\n" +
      "test_dir d { }\n" +
      "test_good a { deps = d:*.expect -> *.out; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
    /* `*` is segment-bounded, so only the root `a.expect` matches. */
    expect(lastDeps && [...lastDeps].map(([name]) => name).sort()).to.deep.equal(["a.out"]);
  });

  it("Resolves a REWRITE property to a first-match name mapping", async () => {
    lastRewrite = undefined;
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input = "targetdef test_rw { out = REWRITE; }\n" + "test_rw t { out = *.entry.js -> *.min.js; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("t"));
    /* Matched names replay into the template; an unmatched name maps to undefined. */
    expect(lastRewrite).to.deep.equal(["a.min.js", "b.min.js", undefined]);
  });

  it("Resolves a bare REWRITE value as a constant output name", async () => {
    lastRewrite = undefined;
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input = "targetdef test_rw { out = REWRITE; }\n" + "test_rw t { out = bundle.js; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("t"));
    /* A bare constant maps every input to itself. */
    expect(lastRewrite).to.deep.equal(["bundle.js", "bundle.js", "bundle.js"]);
  });

  describe("declared property defaults", () => {
    /* Own cache root: the sub-target cases run a real BuildAction, and the shared
     * `execution` caches into the cwd (which would litter the source tree). */
    let root: string;
    let runExecution: ExecutionContext;
    beforeEach(() => {
      root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "fabr-defaults-test-"));
      runExecution = new ExecutionContext(new BuildCache(root, testLog), testLog, EMPTY_FILESET, EMPTY_FILESET);
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    /** Build target `t` from a source declaring the targetdefs and the target,
     * yielding its content (for the rules that turn a property into a file). */
    async function build(input: string): Promise<FileSet> {
      const errors: string[] = [];
      const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
      const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
      expect(errors).to.deep.equal([]);
      const sources = await model.getConfig(Constraints.of({}), runExecution).materialize(writtenOnCommandLine("t"));
      return sources[0] as FileSet;
    }

    it("Supplies an unwritten STRING property from the targetdef's default", async () => {
      const files = await build("targetdef test_file { content = STRING default from the schema; }\n" + "test_file t { }\n");
      expect(await files.readFile("f.txt")).to.equal("from the schema");
    });

    it("Prefers a written value over the default", async () => {
      const files = await build(
        "targetdef test_file { content = STRING default from the schema; }\n" + "test_file t { content = written; }\n"
      );
      expect(await files.readFile("f.txt")).to.equal("written");
    });

    it("Substitutes globals in a default under the using target's context", async () => {
      const files = await build(
        "targetdef test_file { content = STRING default v${VERSION}; }\n" + "VERSION = 2.1;\n" + "test_file t { }\n"
      );
      expect(await files.readFile("f.txt")).to.equal("v2.1");
    });

    it("Supplies an unwritten FILES property from the default, resolving its references", async () => {
      lastDeps = undefined;
      await build(
        "targetdef test_file { content = STRING; }\n" +
          "targetdef test_good { deps = PACKAGES default fallback; }\n" +
          "test_file fallback { content = defaulted; }\n" +
          "test_good t { }\n"
      );
      expect(await lastDeps!.readFile("f.txt")).to.equal("defaulted");
    });

    it("Supplies an unwritten MAP property from the default", async () => {
      lastMap = undefined;
      await build("targetdef test_map { defines = MAP default { DEBUG = false; } }\n" + "test_map t { }\n");
      expect(lastMap).to.deep.equal([["DEBUG", ["false"]]]);
    });

    it("Supplies an unwritten REWRITE property from the default", async () => {
      lastRewrite = undefined;
      await build("targetdef test_rw { out = REWRITE default *.entry.js -> *.min.js; }\n" + "test_rw t { }\n");
      expect(lastRewrite).to.deep.equal(["a.min.js", "b.min.js", undefined]);
    });

    it("Supplies a sub-target's absent input from its type's default", async () => {
      /* The footgun this closes: a sub-target reads through the same accessors as
       * a declared target, so a type whose schema declares a default must get it
       * whether the rule composing the bag supplied the key or not. */
      const files = await build(
        "targetdef test_sub { data = STRING default from the schema; }\n" +
          "targetdef test_default_composer { }\n" +
          "test_default_composer t { }\n"
      );
      expect(await files.readFile("out.txt")).to.equal("from the schema");
    });

    it("Reports a default that resolves back to its own target as a cycle", async () => {
      /* A default is resolved against the using target, so a self-reference in one
       * closes a cycle exactly as a written value would — it must be diagnosed,
       * not recursed into. */
      try {
        await build("targetdef test_good { deps = PACKAGES default t; }\n" + "test_good t { }\n");
        expect.fail("expected target t to fail");
      } catch (err) {
        expect(circularOf(err).name).to.equal("t");
      }
    });

    it("Reads a sub-target's REWRITE input from the Names the composer supplied", async () => {
      /* A rule that has computed exact name pairs states them as literal renames
       * and gets first-match-wins for free — the same semantics a written
       * REWRITE property has, since it is the same value one resolves to. */
      lastRewrite = undefined;
      await build(
        "targetdef test_rw { out = REWRITE; }\n" + "targetdef test_rw_composer { }\n" + "test_rw_composer t { }\n"
      );
      /* Each literal rename answers its own name, and a name none of them
       * selects maps to nothing — passthrough, for the rule to decide. */
      expect(lastRewrite).to.deep.equal(["one.js", "two.js", undefined]);
    });

    it("Reads a sub-target's MAP input from the map the composer supplied", async () => {
      /* A sub-target takes what any target takes: the composer passes on the
       * map it resolved, and the sub-rule reads it with the same accessor. */
      lastMap = undefined;
      await build(
        "targetdef test_map { defines = MAP; }\n" +
          "targetdef test_map_composer { defines = MAP; }\n" +
          "test_map_composer t { defines = { MODE = fast; FLAGS = a b; } }\n"
      );
      expect([...lastMap!]).to.deep.equal([
        ["MODE", ["fast"]],
        ["FLAGS", ["a", "b"]],
      ]);
    });

    it("Reads a sub-target's COMMAND input from the command the composer supplied", async () => {
      /* The composer passes the command on unresolved, so the sub-target's own
       * read resolves the tool and expands the glob over ITS sources. */
      lastCommand = undefined;
      await build(
        "targetdef test_tool_repo { }\n" +
          "targetdef test_cmd { run = COMMAND; }\n" +
          "targetdef test_cmd_composer { run = COMMAND; }\n" +
          "test_tool_repo tools { }\n" +
          "test_cmd_composer t { run = tools:fmt --check *.txt | tools:count > report; }\n"
      );
      expect(lastCommand).to.deep.equal([
        { args: ["--check", "a.txt", "b.txt"], stdout: undefined },
        { args: [], stdout: "report" },
      ]);
    });

    it("Prefers a sub-target's supplied input over its type's default", async () => {
      const files = await build(
        "targetdef test_sub { data = STRING default from the schema; }\n" +
          "targetdef test_composer { content = STRING; }\n" +
          "test_composer t { content = supplied; }\n"
      );
      expect(await files.readFile("out.txt")).to.equal("supplied");
    });
  });

  it("Resolves a MAP property to an ordered, substituted key -> string-list map", async () => {
    lastMap = undefined;
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_map { defines = MAP; }\n" +
      "NAME = production;\n" +
      "test_map t { defines = { process.env.NODE_ENV = ${NAME}; DEBUG = false; } }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("t"));
    expect(lastMap).to.deep.equal([
      ["process.env.NODE_ENV", ["production"]],
      ["DEBUG", ["false"]],
    ]);
  });

  it("Resolves nested blocks to sub-maps and block lists to arrays of maps", async () => {
    lastMap = undefined;
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_map { defines = MAP; }\n" +
      "test_map t { defines = { repository = { type = git; url = ${U}; }; maintainers = { name = a; } { name = b; }; }; }\n" +
      "U = example.com;\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("t"));
    expect(lastMap).to.deep.equal([
      [
        "repository",
        new Map([
          ["type", ["git"]],
          ["url", ["example.com"]],
        ]),
      ],
      ["maintainers", [new Map([["name", ["a"]]]), new Map([["name", ["b"]]])]],
    ]);
  });

  it("Splices a shared map into a block, later entries winning in written order", async () => {
    lastMap = undefined;
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_map { defines = MAP; }\n" +
      "SHARED = { license = gpl3; description = generic; }\n" +
      "test_map t { defines = { before = x; SHARED; description = specific; }; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("t"));
    /* The splice lands at its written position; the later literal entry
     * overrides the spliced `description`. */
    expect(lastMap).to.deep.equal([
      ["before", ["x"]],
      ["license", ["gpl3"]],
      ["description", ["specific"]],
    ]);
  });

  it("Records ghost origins through a splice (entry decl + via-hop)", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_map { defines = MAP; }\n" +
      "SHARED = { license = gpl3; }\n" +
      "test_map t { defines = { SHARED; description = own; }; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    let map: PropertyMap | undefined;
    testMapObserver = resolved => {
      map = resolved;
    };
    await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("t"));
    testMapObserver = undefined;

    /* license arrived via the SHARED splice: origin names the written entry in
     * the shared block plus one via-hop; the literal entry has no hops. */
    const licenseOrigin = map && mapEntryOrigin(map, "license");
    expect(licenseOrigin && licenseOrigin.entry.name.toBaseString()).to.equal("license");
    expect(licenseOrigin?.via).to.have.lengthOf(1);
    const ownOrigin = map && mapEntryOrigin(map, "description");
    expect(ownOrigin && ownOrigin.entry.name.toBaseString()).to.equal("description");
    expect(ownOrigin?.via).to.deep.equal([]);
  });

  it("Fails a splice cycle", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input = "targetdef test_map { defines = MAP; }\n" + "A = { B; }\n" + "B = { A; }\n" + "test_map t { defines = A; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    let caught: Error | undefined;
    await model
      .getConfig(Constraints.of({}), execution)
      .materialize(writtenOnCommandLine("t"))
      .catch((err: Error) => {
        caught = err;
      });
    const cause = caught instanceof DependencyFailedError ? caught.cause : caught;
    expect(cause?.message).to.match(/Circular map reference/);
  });

  it("Resolves a MAP property written as a bare reference to a shared block", async () => {
    lastMap = undefined;
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_map { defines = MAP; }\n" +
      "SHARED = { license = gpl3; owner = ${WHO}; };\n" +
      "WHO = nathan;\n" +
      "test_map t { defines = SHARED; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("t"));
    /* The shared block's `${WHO}` resolves under the consuming build's config. */
    expect(lastMap).to.deep.equal([
      ["license", ["gpl3"]],
      ["owner", ["nathan"]],
    ]);
  });

  it("Fails a MAP reference that does not name a map property", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input = "targetdef test_map { defines = MAP; }\n" + "test_map t { defines = missing; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    let caught: Error | undefined;
    await model
      .getConfig(Constraints.of({}), execution)
      .materialize(writtenOnCommandLine("t"))
      .catch((err: Error) => {
        caught = err;
      });
    /* The reference failure is wrapped by the target boundary; its cause carries
     * the map-reference message. */
    const cause = caught instanceof DependencyFailedError ? caught.cause : caught;
    expect(cause?.message).to.match(/does not name a map property/);
  });

  it("Rejects ${...}-interpolating a map property, with the bare-name hint", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_map { defines = MAP; }\n" + "SHARED = { license = gpl3; };\n" + "test_map t { defines = ${SHARED}; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    let caught: Error | undefined;
    await model
      .getConfig(Constraints.of({}), execution)
      .materialize(writtenOnCommandLine("t"))
      .catch((err: Error) => {
        caught = err;
      });
    const cause = caught instanceof DependencyFailedError ? caught.cause : caught;
    expect(cause?.message).to.match(/'SHARED' is a map and cannot be used as a string/);
  });

  it("Rejects resolving a map property as files", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input = "SHARED = { license = gpl3; };\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    /* `fabr cat SHARED` / `deps = SHARED` territory: a bare name resolving to a
     * block-valued property decl in files context. */
    let caught: Error | undefined;
    await model
      .getConfig(Constraints.of({}), execution)
      .materialize(writtenOnCommandLine("SHARED"))
      .catch((err: Error) => {
        caught = err;
      });
    expect(caught?.message).to.match(/'SHARED' is a map and cannot be used as files/);
  });

  it("Resolves an absent MAP property to an empty map", async () => {
    lastMap = undefined;
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input = "targetdef test_map { defines = MAP; }\n" + "test_map t { }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("t"));
    expect(lastMap).to.deep.equal([]);
  });

  /* The wildcard rules are the parser's (they read only the written name — see
   * Parser.test); what needs the REWRITE *type* is checked here. */
  it("Rejects REWRITE values that violate the type's rules", () => {
    const cases: Array<[string, string]> = [
      ["test_rw t { out = *.js; }", "must be a literal constant"],
      ["test_rw t { out = a:b -> c; }", "REWRITE selector cannot contain ':'"],
      ["test_rw t { out = a<K=v> -> c; }", "REWRITE selector cannot carry constraints"],
    ];
    for (const [decl, fragment] of cases) {
      const errors: string[] = [];
      const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
      toBuildModel(
        [parseBuildString(EMPTY_FILESET, "TEST.fabr", "targetdef test_rw { out = REWRITE; }\n" + decl + "\n", logger)],
        logger,
        testContributions
      );
      expect(errors.join("\n"), decl).to.contain(fragment);
    }
  });

  it("Resolves external references jointly at the consuming target", async () => {
    batchCalls.length = 0;
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_repo { }\n" +
      "targetdef test_good { deps = PACKAGES; }\n" +
      "test_repo repo { }\n" +
      "x = repo:one;\n" +
      "test_good a { deps = x repo:two; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
    /* Both references delivered — the one reached through the property
     * expansion of 'x' as well as the direct one */
    expect(batchCalls.map(call => call.name).sort()).to.deep.equal(["one", "two"]);
    expect(lastDeps && [...lastDeps].map(([path]) => path).sort()).to.deep.equal(["one/data.txt", "two/data.txt"]);
  });

  it("Gathers external references through multiple levels of property indirection", async () => {
    batchCalls.length = 0;
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_repo { }\n" +
      "targetdef test_good { deps = PACKAGES; }\n" +
      "test_repo repo { }\n" +
      "one = repo:one;\n" +
      "two = repo:two;\n" +
      "mydeps = one two;\n" +
      "test_good a { deps = mydeps; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
    expect(batchCalls.map(call => call.name).sort()).to.deep.equal(["one", "two"]);
    expect(lastDeps && [...lastDeps].map(([path]) => path).sort()).to.deep.equal(["one/data.txt", "two/data.txt"]);
  });

  it("Partitions references by repository for resolution", async () => {
    batchCalls.length = 0;
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_repo { }\n" +
      "targetdef test_good { deps = PACKAGES; }\n" +
      "test_repo repoA { }\n" +
      "test_repo repoB { }\n" +
      "test_good a { deps = repoA:one repoB:two; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
    /* Each repository delivers its own references */
    expect(batchCalls.map(call => `${call.repo}:${call.name}`).sort()).to.deep.equal(["repoA:one", "repoB:two"]);
    expect(lastDeps && [...lastDeps].map(([path]) => path).sort()).to.deep.equal(["one/data.txt", "two/data.txt"]);
  });

  it("Suspends projections into external references until resolution", async () => {
    batchCalls.length = 0;
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_repo { }\n" +
      "targetdef test_good { deps = PACKAGES; }\n" +
      "test_repo repo { }\n" +
      "x = repo:one;\n" +
      "test_good a { deps = x:one/*.txt; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
    expect(batchCalls.map(call => call.name)).to.deep.equal(["one"]);
    /* The projection was applied to the resolved files */
    expect(lastDeps && [...lastDeps].map(([path]) => path)).to.deep.equal(["one/data.txt"]);
  });

  it("Keeps the written prefix for slash-form references into a target", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_good { deps = PACKAGES; }\n" +
      "targetdef test_file { content = STRING; }\n" +
      "test_file c1 { content = one; }\n" +
      "test_good a { deps = c1/f.txt c1:f.txt; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
    /* Slash-form keeps the written name; colon-form strips the prefix */
    expect(lastDeps && [...lastDeps].map(([path]) => path).sort()).to.deep.equal(["c1/f.txt", "f.txt"]);
  });

  it("Keeps the written prefix for slash-form projections into external references", async () => {
    batchCalls.length = 0;
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_repo { }\n" +
      "targetdef test_good { deps = PACKAGES; }\n" +
      "test_repo repo { }\n" +
      "x = repo:one;\n" +
      "test_good a { deps = x/one/*.txt; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
    expect(batchCalls.map(call => call.name)).to.deep.equal(["one"]);
    expect(lastDeps && [...lastDeps].map(([path]) => path)).to.deep.equal(["x/one/data.txt"]);
  });

  it("Get String Property", async () => {
    await expect(testGetProperty("a = b c; d = ${a};", "a")).to.eventually.deep.equal(["b", "c"]);
    await expect(testGetProperty("a = b c; d = ${a};", "d")).to.eventually.deep.equal(["b c"]);
    await expect(testGetProperty("a = b c; d = ${a} ${a};", "d")).to.eventually.deep.equal(["b c", "b c"]);
    await expect(testGetProperty("a = b c; d = a${a};", "d", { a: "QUUX" })).to.eventually.deep.equal(["aQUUX"]);
  });

  it("Reads a value's <k=v> as part of its text", async () => {
    await expect(testGetProperty("default K = a; g = foo<K=V>; h = ${g};", "g")).to.eventually.deep.equal(["foo<K=V>"]);
    await expect(testGetProperty("default K = a; g = foo<K=V>; h = ${g};", "h")).to.eventually.deep.equal(["foo<K=V>"]);
    /* The requirement does not configure the value's own substitutions. */
    await expect(testGetProperty("default K = a; g = ${K}<K=b>;", "g")).to.eventually.deep.equal(["a<K=b>"]);
  });

  it("Reads ${NAME<k=v>} under the requirement", async () => {
    const input = "default K = a; default L = x; X = b; g = ${K}${K<K=b>}; h = ${K<K=${X}, L=y>}; i = ${L<K=b>};";
    await expect(testGetProperty(input, "g")).to.eventually.deep.equal(["ab"]);
    await expect(testGetProperty(input, "h")).to.eventually.deep.equal(["b"]);
    await expect(testGetProperty(input, "i")).to.eventually.deep.equal(["x"]);
    /* Inside double quotes too. */
    await expect(testGetProperty('default K = a; g = "v ${K<K=b>}";', "g")).to.eventually.deep.equal(["v b"]);
  });

  it("Reads a guarded declaration under a ${NAME<k=v>} requirement", async () => {
    const input = "default K = a; V<K=b> = guarded; V<K=a> = plain; g = ${V<K=b>} ${V};";
    await expect(testGetProperty(input, "g")).to.eventually.deep.equal(["guarded", "plain"]);
  });

  it("Fails a reference substituted with its <k=v>, as the literal name it is", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_good { deps = PACKAGES; }\n" +
      "targetdef test_package { }\n" +
      "default FLAVOR = plain;\n" +
      "test_package core { }\n" +
      "G = core<FLAVOR=fancy>;\n" +
      "test_good a { deps = ${G}; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    try {
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
      expect.fail("expected target a to fail");
    } catch (err) {
      expect(err).to.be.instanceOf(DependencyFailedError);
      const cause = (err as DependencyFailedError).cause;
      expect(cause).to.be.instanceOf(NameResolutionError);
      expect(cause.message).to.equal("Unable to resolve 'core<FLAVOR=fancy>'");
    }
  });

  it("Collects an evaluation's requirements into one joint batch across properties and globals", async () => {
    batchCalls.length = 0;
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_repo { }\n" +
      "targetdef test_joint { adeps = PACKAGES; bdeps = PACKAGES; }\n" +
      "test_repo repo { }\n" +
      "JOINT_GLOBAL = repo:three;\n" +
      "test_joint a { adeps = repo:one; bdeps = repo:two; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("a"));
    /* One batch for the whole evaluation — not one per property/global */
    expect(batchCalls.map(call => call.name).sort()).to.deep.equal(["one", "three", "two"]);
    expect(lastDeps && [...lastDeps].map(([path]) => path).sort()).to.deep.equal(["one/data.txt", "three/data.txt", "two/data.txt"]);
  });

  describe("A package whose closure needs two versions of one package", () => {
    /* tool needs a and b, which need x at ^2.0.0 and (through y) at ^1.0.0:
     * no one version of x is both. A target linked against it is refused for
     * it. A program is a sealed install, so whatever launches one is not:
     * a rule reading it as a tool, by property or by global, and the run verb. */
    let root: string;
    let runExecution: ExecutionContext;
    beforeEach(() => {
      /* Own cache root: a registry's resolution is memoized through the cache. */
      root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "fabr-closure-test-"));
      runExecution = new ExecutionContext(new BuildCache(root, testLog), testLog, EMPTY_FILESET, EMPTY_FILESET);
      registryRequirements.clear();
      registryRequirements.set("tool@1.0.0", [
        { name: "a", versionConstraint: "^1.0.0" },
        { name: "b", versionConstraint: "^1.0.0" },
      ]);
      registryRequirements.set("a@1.0.0", [{ name: "x", versionConstraint: "^2.0.0" }]);
      registryRequirements.set("b@1.0.0", [{ name: "y", versionConstraint: "1.0.0" }]);
      registryRequirements.set("y@1.0.0", [{ name: "x", versionConstraint: "^1.0.0" }]);
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    const input =
      "targetdef test_registry { }\n" +
      "targetdef test_good { deps = PACKAGES; }\n" +
      "targetdef test_tool { tool = PACKAGES; }\n" +
      "targetdef test_globalrunnable { }\n" +
      "test_registry @reg { }\n" +
      "TOOLGLOBAL = @reg:tool;\n" +
      "test_good linked { deps = @reg:tool; }\n" +
      "test_tool byproperty { tool = @reg:tool; }\n" +
      "test_globalrunnable byglobal { }\n";
    const REFUSED = "Resolution requires multiple versions of the same package:";

    /** Materialize `name` under `operation`: "accepted", or the first line of
     * the failure under the target boundaries around it. */
    function outcome(name: string, operation = "build"): Promise<string> {
      const errors: string[] = [];
      const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
      const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
      expect(errors).to.deep.equal([]);
      return Promise.resolve(model.getConfig(Constraints.of({ [BUILD_OPERATION]: operation }), runExecution).materialize(writtenOnCommandLine(name))).then(
        () => "accepted",
        (err: unknown) => {
          let cause = err;
          while (cause instanceof DependencyFailedError || cause instanceof ReferenceFailedError) {
            cause = cause.cause;
          }
          return (cause as Error).message.split("\n")[0];
        }
      );
    }

    it("is refused where a target depends on it", async () => {
      expect(await outcome("linked")).to.equal(REFUSED);
    });

    it("is accepted where a rule reads it as a tool, by property or by global", async () => {
      expect(await outcome("byproperty")).to.equal("accepted");
      expect(await outcome("byglobal")).to.equal("accepted");
    });

    it("is accepted where it is the program named to run", async () => {
      expect(await outcome("@reg:tool", "run")).to.equal("accepted");
    });
  });

  it("Caches build steps at the boundary and announces only real work", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "fabr-boundary-test-"));
    const input = "targetdef test_parent { content = STRING; }\ntest_parent a { content = hello; }\n";
    leafRuns = 0;
    try {
      const run = async (): Promise<string[]> => {
        const errors: string[] = [];
        const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
        const events: string[] = [];
        const runExecution = new ExecutionContext(new BuildCache(root, testLog), testLog, EMPTY_FILESET, EMPTY_FILESET);
        runExecution.onBuildEvent(event => events.push(event.kind));
        const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
        expect(errors).to.deep.equal([]);
        await model.getConfig(Constraints.of({}), runExecution).materialize(writtenOnCommandLine("a"));
        return events;
      };

      /* Cold: the leaf evaluate runs once; its action is one task, reported
       * from start to end */
      const first = await run();
      expect(leafRuns).to.equal(1);
      expect(first).to.deep.equal(["task-start", "task-end"]);

      /* Warm (fresh model + execution, same cache): served entirely from the
       * entry — no rule evaluate runs, nothing is announced */
      const second = await run();
      expect(leafRuns).to.equal(1);
      expect(second).to.deep.equal([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("Builds a sub-target once and reshapes its output in resolution every run", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "fabr-subtarget-test-"));
    const input =
      "targetdef test_sub { data = STRING; }\n" +
      "targetdef test_composer { content = STRING; }\n" +
      "test_composer a { content = shape; }\n";
    leafRuns = 0;
    wrapRuns = 0;
    try {
      const run = async (): Promise<FileSet> => {
        const errors: string[] = [];
        const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
        const runExecution = new ExecutionContext(new BuildCache(root, testLog), testLog, EMPTY_FILESET, EMPTY_FILESET);
        const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
        expect(errors).to.deep.equal([]);
        const sources = await new Promise<SourceRef[]>((resolve, reject) =>
          model.getConfig(Constraints.of({}), runExecution).materialize(writtenOnCommandLine("a")).then(resolve, reject)
        );
        return sources[0] as FileSet;
      };

      /* Cold: the sub-target's leaf builds once; resolution wraps its output */
      const cold = await run();
      expect(leafRuns).to.equal(1);
      expect(wrapRuns).to.equal(1);
      /* Shape is: target provenance → composed-marker → sub-target output */
      expect(cold.origin?.parent?.kind).to.equal("composed-marker");

      /* Warm: the sub-target is a cache hit (leaf did not re-run) but
       * resolution — and its reshaping — runs every evaluation */
      const warm = await run();
      expect(leafRuns).to.equal(1);
      expect(wrapRuns).to.equal(2);
      expect(warm.origin?.parent?.kind).to.equal("composed-marker");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("Rejects a sub-target whose type has no registered targetdef", async () => {
    const input = "targetdef test_orphan_composer { content = STRING; }\n" + "test_orphan_composer a { content = shape; }\n";
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);
    /* test_orphan_sub has a rule but no targetdef, so building it as a sub-target
     * is an internal inconsistency — wrapped to the composing declared target. */
    let caught: Error | undefined;
    await new Promise<void>(resolve =>
      model
        .getConfig(Constraints.of({}), execution)
        .materialize(writtenOnCommandLine("a"))
        .then(
          () => resolve(),
          err => {
            caught = err;
            resolve();
          }
        )
    );
    expect(caught).to.be.instanceOf(Error);
    /* The guard error is wrapped to the composing declared target; walk the
     * cause chain for it. */
    const messages: string[] = [];
    for (let e: unknown = caught; e instanceof Error; e = (e as { cause?: unknown }).cause) {
      messages.push(e.message);
    }
    expect(messages.join(" | ")).to.match(/sub-target type 'test_orphan_sub' has no registered targetdef/);
  });

  it("Interns configurations by constraint value", () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", "a = b;", logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    expect(model.getConfig(Constraints.of({ x: "1" }), execution)).to.equal(model.getConfig(Constraints.of({ x: "1" }), execution));
    expect(model.getConfig(Constraints.of({ x: "2" }), execution)).to.not.equal(
      model.getConfig(Constraints.of({ x: "1" }), execution)
    );

    /* Configs are per execution context: a fresh run never shares evaluation
     * state with another */
    const other = new ExecutionContext(new BuildCache(cacheRoot, testLog), testLog, EMPTY_FILESET, EMPTY_FILESET);
    expect(model.getConfig(Constraints.of({ x: "1" }), other)).to.not.equal(model.getConfig(Constraints.of({ x: "1" }), execution));
  });

  it("Applies a reference's <k=v> requirement to the referenced target's build", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    /* `leaf` bakes ${FLAVOR} into its output; the dependant references it once
     * plainly and once with a FLAVOR override, so the override must reach leaf's
     * own evaluation (not the ambient config). */
    const input =
      "targetdef test_good { deps = PACKAGES; }\n" +
      "targetdef test_file { content = STRING; }\n" +
      "default FLAVOR = plain;\n" +
      "test_file leaf { content = ${FLAVOR}; }\n" +
      "test_good plain_root { deps = leaf; }\n" +
      "test_good fancy_root { deps = leaf<FLAVOR=fancy>; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);
    const config = model.getConfig(Constraints.of({}), execution);
    const readLeaf = (): Computable<string | undefined> => lastDeps!.get("f.txt").then(file => file?.readString());

    await config.materialize(writtenOnCommandLine("plain_root"));
    expect(await readLeaf()).to.equal("plain");

    await config.materialize(writtenOnCommandLine("fancy_root"));
    expect(await readLeaf()).to.equal("fancy");
  });

  it("A caller's constraint override takes precedence over a reference's own requirement", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    /* The rule resolves `dep` under an explicit {FLAVOR: caller} override while
     * the reference carries <FLAVOR=ref>; the caller's requirement must win
     * (e.g. a `run` rule forcing BUILD_OPERATION=run over a stray requirement). */
    const input =
      "targetdef test_override { dep = PACKAGES; }\n" +
      "targetdef test_file { content = STRING; }\n" +
      "default FLAVOR = ambient;\n" +
      "test_file leaf { content = ${FLAVOR}; }\n" +
      "test_override root { dep = leaf<FLAVOR=ref>; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("root"));
    expect(await lastDeps!.get("f.txt").then(file => file?.readString())).to.equal("caller");
  });

  it("A caller's override also wins over a requirement on a GLOBAL's value", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    /* Same precedence rule, through getGlobalFileProperty: the rule forces
     * {FLAVOR: caller} while the global's written value carries <FLAVOR=ref>.
     * The override must ride as callerOverrides (applied after the
     * requirement), not be demoted to the ambient set (which it would beat). */
    const input =
      "targetdef test_globaltool { }\n" +
      "targetdef test_file { content = STRING; }\n" +
      "default FLAVOR = ambient;\n" +
      "test_file leaf { content = ${FLAVOR}; }\n" +
      "GLOBALTOOL = leaf<FLAVOR=ref>;\n" +
      "test_globaltool root { }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("root"));
    expect(await lastDeps!.get("f.txt").then(file => file?.readString())).to.equal("caller");
  });

  it("A caller's override wins over a requirement on a substitution in a STRING global", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    /* The rule forces {FLAVOR: caller} while the substitution carries
     * <FLAVOR=ref>, so the override (threaded as callerOverrides, applied last)
     * wins, rather than being folded into ambient, which the requirement would
     * beat. */
    const input =
      "targetdef test_globalstr { }\n" +
      "default FLAVOR = ambient;\n" +
      "GLOBALSTR = ${FLAVOR<FLAVOR=ref>};\n" +
      "test_globalstr root { }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    lastString = undefined;
    await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("root"));
    expect(lastString).to.equal("caller");
  });

  describe("a default target beside other declarations of its name", () => {
    const load = (body: string): { model: ReturnType<typeof toBuildModel>; errors: string[] } => {
      const errors: string[] = [];
      const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
      const input =
        "targetdef test_good { deps = PACKAGES; }\n" +
        "targetdef test_file { content = STRING; }\n" +
        "default FLAVOR = plain;\n" +
        "test_file other { content = overridden; }\n" +
        body;
      return { model: toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions), errors };
    };
    const built = async (model: ReturnType<typeof toBuildModel>, constraints: Record<string, string>): Promise<string | undefined> => {
      lastDeps = undefined;
      await model.getConfig(Constraints.of(constraints), execution).materialize(writtenOnCommandLine("root"));
      return lastDeps!.get("f.txt").then(file => file?.readString());
    };

    it("is the fallback wherever no guarded property declaration applies", async () => {
      const { model, errors } = load(
        "default test_file foo { content = fallback; }\nfoo<FLAVOR=special> = other;\ntest_good root { deps = foo; }\n"
      );
      expect(errors).to.deep.equal([]);
      expect(await built(model, {})).to.equal("fallback");
      expect(await built(model, { FLAVOR: "special" })).to.equal("overridden");
    });

    it("is superseded by an unguarded property", async () => {
      const { model, errors } = load("default test_file foo { content = fallback; }\nfoo = other;\ntest_good root { deps = foo; }\n");
      expect(errors).to.deep.equal([]);
      expect(await built(model, {})).to.equal("overridden");
    });

    it("yields to an ordinary target when it is a property, whichever is declared first", async () => {
      for (const body of [
        "default foo = other;\ntest_file foo { content = target; }\ntest_good root { deps = foo; }\n",
        "test_file foo { content = target; }\ndefault foo = other;\ntest_good root { deps = foo; }\n",
      ]) {
        const { model, errors } = load(body);
        expect(errors, body).to.deep.equal([]);
        expect(await built(model, {}), body).to.equal("target");
      }
    });

    it("conflicts with a default of the other kind, and ordinary with ordinary", () => {
      for (const body of [
        "default test_file foo { content = fallback; }\ndefault foo = other;\n",
        "default foo = other;\ndefault test_file foo { content = fallback; }\n",
        "foo = other;\ntest_file foo { content = target; }\n",
      ]) {
        const { errors } = load(body);
        expect(errors.join("\n"), body).to.match(/conflict|duplicate/i);
      }
    });

    it("conflicts with a namespace of its name, whichever is declared first", () => {
      for (const body of [
        "default test_file foo { content = fallback; }\ntest_file foo/bar { content = x; }\n",
        "test_file foo/bar { content = x; }\ndefault test_file foo { content = fallback; }\n",
      ]) {
        const { errors } = load(body);
        expect(errors.join("\n"), body).to.match(/conflict/i);
      }
    });
  });

  describe("guards judged under a caller's override", () => {
    /* Each read forces {FLAVOR: caller} against an ambient `FLAVOR = ambient`;
     * the declaration guarded on the caller's value must be the one selected,
     * exactly as it is when a written <FLAVOR=caller> requirement reaches it. */
    const guardedModel = (body: string): ReturnType<typeof toBuildModel> => {
      const errors: string[] = [];
      const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
      const input =
        "targetdef test_override { dep = PACKAGES; }\n" +
        "targetdef test_globaltool { }\n" +
        "targetdef test_globalstr { }\n" +
        "targetdef test_good { deps = PACKAGES; }\n" +
        "targetdef test_file { content = STRING; }\n" +
        "default FLAVOR = ambient;\n" +
        "test_file leaf { content = ${FLAVOR}; }\n" +
        "test_file wrong { content = wrong; }\n" +
        body;
      const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
      expect(errors).to.deep.equal([]);
      return model;
    };
    const leafContent = (): Computable<string | undefined> => lastDeps!.get("f.txt").then(file => file?.readString());

    it("for a target property", async () => {
      const model = guardedModel("test_override root { dep<FLAVOR=ambient> = wrong; dep<FLAVOR=caller> = leaf; }\n");
      lastDeps = undefined;
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("root"));
      expect(await leafContent()).to.equal("caller");
    });

    it("for a global FILES property", async () => {
      const model = guardedModel(
        "GLOBALTOOL<FLAVOR=ambient> = wrong;\nGLOBALTOOL<FLAVOR=caller> = leaf;\ntest_globaltool root { }\n"
      );
      lastDeps = undefined;
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("root"));
      expect(await leafContent()).to.equal("caller");
    });

    it("for a global STRING property", async () => {
      const model = guardedModel(
        "GLOBALSTR<FLAVOR=ambient> = wrong;\nGLOBALSTR<FLAVOR=caller> = ${FLAVOR};\ntest_globalstr root { }\n"
      );
      lastString = undefined;
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("root"));
      expect(lastString).to.equal("caller");
    });

    it("agreeing with a written requirement on a reference to the property", async () => {
      const model = guardedModel(
        "GLOBALTOOL<FLAVOR=ambient> = wrong;\nGLOBALTOOL<FLAVOR=caller> = leaf;\n" +
          "test_good root { deps = GLOBALTOOL<FLAVOR=caller>; }\n"
      );
      lastDeps = undefined;
      await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("root"));
      expect(await leafContent()).to.equal("caller");
    });
  });

  it("substitutes ${vars} in a whole target name (build/test parity with cat/ls)", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    /* build/test substitute a ${...} in a whole target name as ls/cat do for
     * any name. */
    const input = "targetdef test_file { content = STRING; }\n" + "default WHICH = leaf;\n" + "test_file leaf { content = hi; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    const [sources] = await buildOperation(model.getConfig(Constraints.of({}), execution), [writtenOnCommandLine("${WHICH}")]);
    const files = FileSet.unionAll(...sources.filter((source): source is FileSet => source instanceof FileSet));
    expect(await files.get("f.txt").then(file => file?.readString())).to.equal("hi");
  });

  it("builds a name that only a -D gives a value to, as what the value names", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input = "targetdef test_file { content = STRING; }\n" + "test_file leaf { content = hi; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);
    const [sources] = await buildOperation(model.getConfig(Constraints.of({ zz: "leaf" }), execution), [writtenOnCommandLine("zz")]);
    const files = FileSet.unionAll(...sources.filter((source): source is FileSet => source instanceof FileSet));
    expect(await files.get("f.txt").then(file => file?.readString())).to.equal("hi");
  });
});

/**
 * A step whose real inputs are only known after it ran: the framework demands
 * it under an *anchor* (its always-real inputs, the discoverable deps omitted
 * entirely) and keys the entry on the subset the run reports reading.
 */
describe("discovered dependencies", () => {
  let root: string;
  let runExecution: ExecutionContext;

  beforeEach(() => {
    root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "fabr-discovery-test-"));
    runExecution = new ExecutionContext(new BuildCache(root, testLog), testLog, EMPTY_FILESET, EMPTY_FILESET);
    compileRuns = 0;
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const input = "targetdef test_compile { includes = STRING; }\n" + "test_compile t { includes = a.h; }\n";

  /** Build `t` against the delivery as it currently stands. */
  async function compile(headers: Record<string, string>): Promise<string> {
    testHeaders = new PackageFileSet(
      new Map(Object.entries(headers).map(([name, text]) => [name, MemoryFile.from(text)])),
      "headers",
      "1.0.0"
    );
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);
    const sources = await model.getConfig(Constraints.of({}), runExecution).materialize(writtenOnCommandLine("t"));
    return (sources[0] as FileSet).readFile("out.o");
  }

  it("does not rebuild when a discoverable dep the step never read changes", async () => {
    const first = await compile({ "a.h": "one", "b.h": "unused" });
    expect(compileRuns).to.equal(1);
    /* b.h is staged for the step and could have been read, but wasn't — so it
     * is in neither the anchor (which omits them) nor the precise key
     * (which holds only the reported reads), and its new bytes change nothing. */
    expect(await compile({ "a.h": "one", "b.h": "edited" })).to.equal(first);
    expect(compileRuns).to.equal(1);
  });

  it("does not rebuild when an unrelated discoverable dep appears", async () => {
    await compile({ "a.h": "one", "b.h": "unused" });
    /* Discoverable NAMES are out of the anchor as well as their contents: fabr
     * stages them all, so a new file cannot shadow what a name already
     * resolved to, and adding one invalidates nothing. */
    await compile({ "a.h": "one", "b.h": "unused", "c.h": "new" });
    expect(compileRuns).to.equal(1);
  });

  it("rebuilds when a discoverable dep the step read changes", async () => {
    const first = await compile({ "a.h": "one", "b.h": "unused" });
    const second = await compile({ "a.h": "two", "b.h": "unused" });
    expect(compileRuns).to.equal(2);
    expect(second).to.not.equal(first);
    expect(second).to.equal("a.h=two");
    /* Reverting reconstructs the first entry's key, which is still in the
     * store — no run, no memo change. */
    expect(await compile({ "a.h": "one", "b.h": "unused" })).to.equal(first);
    expect(compileRuns).to.equal(2);
  });
});

describe("default target declarations", () => {
  /** Build a model from `input`, materialize `leaf` and read the content its
   * rule wrote, which says which of the collated declarations won. */
  async function leafContent(input: string): Promise<string | undefined> {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);
    const sources = await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("leaf"));
    const files = FileSet.unionAll(...sources.filter((source): source is FileSet => source instanceof FileSet));
    return files.get("f.txt").then(file => file?.readString());
  }

  const targetdef = "targetdef test_file { content = STRING; }\n";

  it("builds a default target when nothing shadows it", async () => {
    expect(await leafContent(targetdef + "default test_file leaf { content = fallback; }\n")).to.equal("fallback");
  });

  it("lets a plain declaration shadow a default target", async () => {
    /* Same rule as a default property: the default is used if and only if there
     * is no non-default declaration of that name, whichever order they appear. */
    expect(
      await leafContent(targetdef + "test_file leaf { content = declared; }\n" + "default test_file leaf { content = fallback; }\n")
    ).to.equal("declared");
  });
});

describe("unresolved-name diagnostics", () => {
  function modelOf(input: string): ReturnType<typeof toBuildModel> {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);
    return model;
  }

  it("positions a typo'd ${property} at its use and suggests the near name", async () => {
    /* The substitution site carries a dependency stack, so the error is the
     * positioned NameResolutionError, anchored at the referencing value and
     * delivered as a Computable rejection. */
    const input = "FOO = x;\nBAR = ${FOOO};\n";
    const context = modelOf(input).getConfig(Constraints.of({}), execution);
    try {
      await internal(context).getProperty("BAR");
      expect.fail("expected a rejection");
    } catch (e) {
      const err = e as NameResolutionError;
      expect(err.message).to.contain("Unknown property 'FOOO'");
      expect(err.help.join("\n")).to.contain("did you mean 'FOO'?");
      expect(err).to.be.instanceOf(NameResolutionError);
      expect(err.position.offset).to.be.greaterThan(0);
    }
  });

  it("names the kind when a property reference hits a target", () => {
    const input = "targetdef test_file { content = STRING; }\ntest_file thing { content = x; }\n";
    const context = modelOf(input).getConfig(Constraints.of({}), execution);
    expect(() => internal(context).getProperty("thing")).to.throw(/'thing' names a target, not a property/);
  });

  it("suggests a near target name and points at list-targets for a CLI name", () => {
    const input = "targetdef test_file { content = STRING; }\ntest_file mytarget { content = x; }\n";
    const context = modelOf(input).getConfig(Constraints.of({}), execution);
    try {
      internal(context).resolveTarget("mytargt");
      expect.fail("expected a throw");
    } catch (e) {
      const err = e as FabrError;
      expect(err.message).to.contain("Unknown name 'mytargt'");
      expect(err.help.join("\n")).to.contain("did you mean 'mytarget'?");
      expect(err.help.join("\n")).to.contain("fabr list-targets");
    }
  });

  it("reports a name nothing declares the same way for every verb", async () => {
    /* `resolveTarget` looks up a whole name, and `materialize` a possibly
     * projected one (as ls/cat/run do). Both report the one mistake with one
     * wording and one suggestion. */
    const input = "targetdef test_file { content = STRING; }\ntest_file mytarget { content = x; }\n";
    const context = modelOf(input).getConfig(Constraints.of({}), execution);
    const failures: FabrError[] = [];
    try {
      internal(context).resolveTarget("mytargt");
      expect.fail("expected a throw");
    } catch (e) {
      failures.push(e as FabrError);
    }
    try {
      /* A projected name, as ls/cat/run may be given. */
      await context.materialize(writtenOnCommandLine("mytargt:build/x.js"));
      expect.fail("expected a rejection");
    } catch (e) {
      failures.push(e as FabrError);
    }

    expect(failures.map(err => err.message)).to.deep.equal(["Unknown name 'mytargt'", "Unknown name 'mytargt:build/x.js'"]);
    for (const err of failures) {
      expect(err.help.join("\n")).to.contain("did you mean 'mytarget'?");
    }
  });

  it("refuses to build a reference that selects files of a target", async () => {
    const input = "targetdef test_file { content = STRING; }\ntest_file mytarget { content = x; }\n";
    const model = modelOf(input);
    const context = model.getConfig(Constraints.of({}), execution);
    const failure = await Promise.resolve(buildOperation(context, [writtenOnCommandLine("mytarget:build/x.js")])).then(
      () => undefined,
      (err: FabrError) => err
    );
    expect(failure?.message).to.equal("'mytarget:build/x.js' selects files of 'mytarget'");
    expect(failure?.help.join("\n")).to.contain("name it without the selection: 'mytarget'");
  });

  it("builds a name the project declares, whatever it resolves to, and nothing else", async () => {
    const input =
      "targetdef test_file { content = STRING; }\ntest_file mytarget { content = x; }\n" +
      "ALL = mytarget;\nMIXED = mytarget mytarget:nothing/*.zzz;\n";
    const model = modelOf(input);
    const context = model.getConfig(Constraints.of({}), execution);
    const refused = (name: string): Promise<string | undefined> =>
      Promise.resolve(buildOperation(context, [writtenOnCommandLine(name)])).then(
        () => undefined,
        (err: FabrError) => err.message
      );
    /* A target, and a global: one naming a target, one naming files too. */
    expect(await refused("mytarget")).to.equal(undefined);
    expect(await refused("ALL")).to.equal(undefined);
    expect(await refused("MIXED")).to.equal(undefined);
    /* A pattern is no declared name, so a mistyped one does not pass. */
    expect(await refused("nothing/*.zzz")).to.equal("'nothing/*.zzz' is not a name the project declares");
  });
});

/* A decl written in an absolutely-pathed contributed lib file resolves a relative
 * FILES value against that file's own directory through its own FileSource
 * (the loader's absFileSource — no project-tree containment), and the result
 * is named by the written path's flattened tail (a leading `../` strips — the
 * general FileSet namespace rule). Also exercises an `@`-prefixed name on an
 * ordinary (non-repository) target decl. */
describe("contributed-lib-relative FILES", () => {
  it("resolves literal and glob references relative to an absolute lib file, named by their flattened tails", async () => {
    const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "fabr-libentry-"));
    try {
      fs.mkdirSync(nodePath.join(tmp, "tool"));
      fs.mkdirSync(nodePath.join(tmp, "lib"));
      fs.writeFileSync(nodePath.join(tmp, "tool", "run.sh"), "#!/bin/sh\necho hi\n");
      fs.writeFileSync(nodePath.join(tmp, "tool", "helper.js"), "// helper\n");
      fs.writeFileSync(nodePath.join(tmp, "tool", "extra.js"), "// extra\n");
      const errors: string[] = [];
      const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
      /* The entry exercises the literal single-file path; the deps glob
       * exercises the walk — an absolute query head (rebased into the source's
       * namespace) whose remainder climbs out of the lib dir, matched in
       * canonical path space and named relative to the dir alias. */
      const input =
        "targetdef script { deps = PACKAGES; entry = REQUIRED FILES; args = STRING; }\n" +
        "script @plug/drv { entry = ../tool/run.sh; deps = ../tool/*.js; }\n";
      const model = toBuildModel(
        [parseBuildString(new FSFileSource("/"), nodePath.join(tmp, "lib", "LIB.fabr"), input, logger)],
        logger,
        [{ rules: [scriptRunRule] }]
      );
      expect(errors).to.deep.equal([]);
      const sources = await model
        .getConfig(Constraints.of({ [BUILD_OPERATION]: "run" }), execution)
        .materialize(writtenOnCommandLine("@plug/drv"));
      const runnable = sources.find((source): source is RunnableFileSet => source instanceof RunnableFileSet);
      expect(runnable, "expected a RunnableFileSet").to.not.equal(undefined);
      const names = [...(runnable as RunnableFileSet)].map(([name]) => name).sort();
      expect(names).to.deep.equal(["tool/extra.js", "tool/helper.js", "tool/run.sh"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  /*
   * Conditional properties: the decl-position reading of the `<k=v>` facet.
   * Guards FILTER — they never rank — so these assert the combination rules
   * rather than any precedence order: a list-shaped read unions every matching
   * declaration, a scalar read demands exactly one, and the targetdef's declared
   * default supplies a property no guard admitted.
   */
  describe("conditional properties (constraint guards)", () => {
    const GUARD_DEFS =
      "targetdef test_good { deps = PACKAGES; }\n" +
      "targetdef test_file { content = STRING; }\n" +
      "targetdef test_dir { }\n" +
      "default FLAVOR = none;\n";

    /** Build `input` under `constraints` and return the file names its `deps`
     * union delivered — the observable of a FILES read. */
    async function depNames(input: string, constraints: Record<string, string> = {}): Promise<string[]> {
      const errors: string[] = [];
      const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
      const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
      expect(errors).to.deep.equal([]);
      lastDeps = undefined;
      await model.getConfig(Constraints.of(constraints), execution).materialize(writtenOnCommandLine("t"));
      return [...(lastDeps ?? EMPTY_FILESET)].map(([name]) => name).sort();
    }

    it("unions every matching declaration of a FILES property", async () => {
      const input =
        GUARD_DEFS +
        "test_file base { content = A; }\n" +
        "test_dir extra { }\n" +
        "test_good t { deps = base; deps<FLAVOR=lin*> = extra; }\n";
      /* The guarded declaration participates alongside the unguarded one — a
       * guard decides participation, and participants combine as a value list
       * always has. */
      expect(await depNames(input, { FLAVOR: "linux" })).to.deep.equal(["a.expect", "c.txt", "f.txt", "sub/b.expect"]);
      expect(await depNames(input, { FLAVOR: "windows" })).to.deep.equal(["f.txt"]);
    });

    it("unions two matching guarded declarations (guards are not ranked)", async () => {
      const input =
        GUARD_DEFS +
        "test_file base { content = A; }\n" +
        "test_dir extra { }\n" +
        "test_good t { deps<FLAVOR=lin*> = base; deps<FLAVOR=*ux> = extra; }\n";
      /* Both guards admit `linux`, and neither is 'more specific' — there is no
       * such relation over patterns, so both contribute. */
      expect(await depNames(input, { FLAVOR: "linux" })).to.deep.equal(["a.expect", "c.txt", "f.txt", "sub/b.expect"]);
    });

    it("yields nothing for a FILES property no guard admits", async () => {
      const input = GUARD_DEFS + "test_file base { content = A; }\n" + "test_good t { deps<FLAVOR=lin*> = base; }\n";
      expect(await depNames(input, { FLAVOR: "windows" })).to.deep.equal([]);
    });

    it("matches a guard against a conjunction of properties", async () => {
      const input =
        GUARD_DEFS +
        "default BUILD_TYPE = debug;\n" +
        "test_file base { content = A; }\n" +
        "test_good t { deps<FLAVOR=lin*, BUILD_TYPE=release> = base; }\n";
      expect(await depNames(input, { FLAVOR: "linux", BUILD_TYPE: "release" })).to.deep.equal(["f.txt"]);
      /* Every pair must match: a conjunction, as in a rule's constraint set. */
      expect(await depNames(input, { FLAVOR: "linux", BUILD_TYPE: "debug" })).to.deep.equal([]);
      expect(await depNames(input, { FLAVOR: "windows", BUILD_TYPE: "release" })).to.deep.equal([]);
    });

    it("reads a guard through property resolution, so a declared default answers it", async () => {
      /* Nothing is overridden here: `FLAVOR` resolves to its declared default,
       * which is what the guard matches against — the configuration is the
       * properties, not just the constraint set. */
      const input = GUARD_DEFS + "test_file base { content = A; }\n" + "test_good t { deps<FLAVOR=none> = base; }\n";
      expect(await depNames(input)).to.deep.equal(["f.txt"]);
    });

    it("takes the single matching declaration of a STRING property", async () => {
      const input =
        GUARD_DEFS +
        "test_file t { content<FLAVOR=lin*> = linux; content<FLAVOR=win*> = windows; }\n" +
        "test_good unused { deps = t; }\n";
      const errors: string[] = [];
      const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
      const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
      expect(errors).to.deep.equal([]);
      const files = await model.getConfig(Constraints.of({ FLAVOR: "linux" }), execution).materialize(writtenOnCommandLine("t"));
      expect(await (files[0] as FileSet).readFile("f.txt")).to.equal("linux");
    });

    it("rejects two declarations of a STRING property matching at once", async () => {
      const input = GUARD_DEFS + "test_file t { content<FLAVOR=lin*> = one; content<FLAVOR=*ux> = two; }\n";
      const errors: string[] = [];
      const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
      const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
      expect(errors).to.deep.equal([]);
      try {
        await model.getConfig(Constraints.of({ FLAVOR: "linux" }), execution).materialize(writtenOnCommandLine("t"));
        expect.fail("expected target t to fail");
      } catch (err) {
        /* A scalar cannot silently join two contributions the way a list can,
         * and there is no ranking to break the tie — so it is an error naming
         * both guards. */
        expect(err).to.be.instanceOf(DependencyFailedError);
        const message = (err as DependencyFailedError).cause.message;
        expect(message).to.contain("but takes a single value");
        /* Named by the property alone, each declaration by its own guard. */
        expect(message).to.contain("'content' is declared for this configuration by 2 declarations (<FLAVOR=lin*> and <FLAVOR=*ux>)");
      }
    });

    it("names an unguarded declaration as such when it is one of the ambiguous pair", async () => {
      const input = GUARD_DEFS + "test_file t { content = one; content<FLAVOR=lin*> = two; }\n";
      const errors: string[] = [];
      const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
      const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
      expect(errors).to.deep.equal([]);
      try {
        await model.getConfig(Constraints.of({ FLAVOR: "linux" }), execution).materialize(writtenOnCommandLine("t"));
        expect.fail("expected target t to fail");
      } catch (err) {
        expect((err as DependencyFailedError).cause.message).to.contain("(unguarded and <FLAVOR=lin*>)");
      }
    });

    it("falls back to the targetdef's declared default when no guard matches", async () => {
      const input =
        "targetdef test_file { content = STRING default fallback; }\n" +
        "default FLAVOR = none;\n" +
        "test_file t { content<FLAVOR=lin*> = linux; }\n";
      const errors: string[] = [];
      const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
      const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
      expect(errors).to.deep.equal([]);
      /* Guarded out ⇒ the target supplies no value here, which is exactly the
       * case the schema's default exists for — the same path a target that
       * never mentioned the property takes. */
      const windows = await model.getConfig(Constraints.of({ FLAVOR: "windows" }), execution).materialize(writtenOnCommandLine("t"));
      expect(await (windows[0] as FileSet).readFile("f.txt")).to.equal("fallback");
      const linux = await model.getConfig(Constraints.of({ FLAVOR: "linux" }), execution).materialize(writtenOnCommandLine("t"));
      expect(await (linux[0] as FileSet).readFile("f.txt")).to.equal("linux");
    });

    it("guards a global, and takes its `default` declaration when none matches", async () => {
      const input = "default FLAVOR = none;\n" + "default TSC = generic;\n" + "TSC<FLAVOR=lin*> = tsc-linux;\n";
      expect(await testGetProperty(input, "TSC", { FLAVOR: "linux" })).to.deep.equal(["tsc-linux"]);
      /* An ordinary declaration displaces a `default` one only where it
       * applies; guarded out, the default is what supplies the global. */
      expect(await testGetProperty(input, "TSC", { FLAVOR: "windows" })).to.deep.equal(["generic"]);
    });

    it("reports a global that no declaration supplies in this configuration", async () => {
      const input = "default FLAVOR = none;\n" + "TSC<FLAVOR=lin*> = tsc-linux;\n";
      try {
        await testGetProperty(input, "TSC", { FLAVOR: "windows" });
        expect.fail("expected TSC to be unsupplied");
      } catch (err) {
        /* Declared but not here — which is a different mistake from a typo, and
         * the message must not claim the property is unknown. */
        expect(toError(err).message).to.contain("no declaration of it applies to this configuration");
      }
    });

    it("distributes a guard block over the properties it contains", async () => {
      const input =
        GUARD_DEFS +
        "test_file base { content = A; }\n" +
        "test_dir extra { }\n" +
        "test_good t {\n  deps = base;\n  <FLAVOR=lin*> {\n    deps = extra;\n  }\n}\n";
      expect(await depNames(input, { FLAVOR: "linux" })).to.deep.equal(["a.expect", "c.txt", "f.txt", "sub/b.expect"]);
      expect(await depNames(input, { FLAVOR: "windows" })).to.deep.equal(["f.txt"]);
    });

    it("guards a wildcard member (a key the schema never named)", async () => {
      /* A member is enumerated rather than looked up, so its guard decides
       * whether the member exists here — nothing to union or to call ambiguous. */
      const input =
        "default FLAVOR = none;\n" +
        "targetdef test_members { * = FILES; }\n" +
        "test_file base { content = A; }\n" +
        "targetdef test_file { content = STRING; }\n" +
        "test_members m { common = base; linux_only<FLAVOR=lin*> = base; }\n";
      const errors: string[] = [];
      const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
      const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
      expect(errors).to.deep.equal([]);
      const keysUnder = async (flavor: string): Promise<string[]> => {
        lastMemberKeys = undefined;
        await model.getConfig(Constraints.of({ FLAVOR: flavor }), execution).materialize(writtenOnCommandLine("m"));
        return lastMemberKeys ?? [];
      };
      expect(await keysUnder("linux")).to.deep.equal(["common", "linux_only"]);
      expect(await keysUnder("windows")).to.deep.equal(["common"]);
    });

    it("reports a guard naming a property nothing declares", async () => {
      const input = GUARD_DEFS + "test_file base { content = A; }\n" + "test_good t { deps<NOSUCH=x> = base; }\n";
      try {
        await depNames(input);
        expect.fail("expected the guard to fail");
      } catch (err) {
        /* A typo in a guard must not quietly mean "never", or the declaration
         * would vanish from every build. */
        expect(err).to.be.instanceOf(DependencyFailedError);
        expect((err as DependencyFailedError).cause.message).to.contain("Unknown property 'NOSUCH'");
      }
    });
  });
});

describe("an incomplete reference", () => {
  const input =
    "targetdef test_versioned_registry { }\n" +
    "test_versioned_registry @reg { }\n" +
    "A = @reg:foo;\n" +
    "T = @reg:@scope;\n";

  function materialize(name: string): Computable<Array<FileSource | NamespaceRef>> {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);
    return model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine(name));
  }

  it("is completed by the rest of the name written after it, with ':'", async () => {
    const [pkg] = await Promise.resolve(materialize("A:1.2.0"));
    expect((pkg as PackageFileSet).packageName).to.equal("foo");
    expect((pkg as PackageFileSet).version).to.equal("1.2.0");
  });

  it("is completed by the rest of the name written after it, with '/'", async () => {
    const [pkg] = await Promise.resolve(materialize("T/foo:1.0.0"));
    expect((pkg as PackageFileSet).packageName).to.equal("@scope/foo");
  });

  it("is refused where it is used as a package before it is complete", async () => {
    const sources = await Promise.resolve(materialize("A"));
    expect(() => refuseNamespaces(sources)).to.throw("'@reg:foo' is not a complete reference, so it names no package or files");
  });

  it("cannot be renamed, whether the repository or a name into it", async () => {
    /* A rename names the package delivered; a repository delivers none, so
     * carrying the rename onward would drop it without a word. */
    for (const [name, message] of [
      ["@reg -> other", "'@reg' names a repository, which cannot be renamed"],
      ["A -> other", "'@reg:foo' is not a complete reference, so it names no package to rename"],
    ]) {
      try {
        await Promise.resolve(materialize(name));
        expect.fail(`expected '${name}' to be refused`);
      } catch (err) {
        expect((err as Error).message, name).to.contain(message);
      }
    }
  });
});

describe("a namespace's fallback property", () => {
  const preamble = "targetdef test_ns_repo { }\ntargetdef test_package { }\ntest_ns_repo @root { }\n";

  function load(source: string): { model: ReturnType<typeof toBuildModel>; errors: string[] } {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", preamble + source, logger)], logger, testContributions);
    return { model, errors };
  }

  /** Materialize `name` and report the package's name and whether the
   * fallback's repository answered. */
  async function answer(model: ReturnType<typeof toBuildModel>, name: string): Promise<{ name: string; fallback: boolean }> {
    const [source] = await model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine(name));
    const pkg = source as PackageFileSet;
    return { name: pkg.packageName, fallback: (await pkg.get("from-fallback")) !== undefined };
  }

  it("answers an undeclared name under the namespace as a projection into its value", async () => {
    /* The value names the `@ns` scope of the repository, unresolved; the rest of
     * the name goes on from it. */
    const { model, errors } = load("default @ns = @root:@ns;\n");
    expect(errors).to.deep.equal([]);
    expect(await answer(model, "@ns/tool")).to.deep.equal({ name: "@ns/tool", fallback: true });
  });

  it("leaves a declared name to its declaration, whichever is declared first", async () => {
    for (const source of ["default @ns = @root:@ns;\ntest_package @ns/tool { }\n", "test_package @ns/tool { }\ndefault @ns = @root:@ns;\n"]) {
      const { model, errors } = load(source);
      expect(errors).to.deep.equal([]);
      expect(await answer(model, "@ns/tool")).to.deep.equal({ name: "@ns/tool", fallback: false });
      expect(await answer(model, "@ns/other")).to.deep.equal({ name: "@ns/other", fallback: true });
    }
  });

  it("takes an ordinary declaration over a default one, as any property does", async () => {
    const { model, errors } = load("default @ns = @nowhere;\n@ns = @root:@ns;\ntest_package @ns/tool { }\n");
    expect(errors).to.deep.equal([]);
    expect(await answer(model, "@ns/other")).to.deep.equal({ name: "@ns/other", fallback: true });
  });

  it("materializes the namespace's own name as its value, a namespace of a repository, which content refuses", async () => {
    const { model } = load("default @ns = @root:@ns;\ntest_package @ns/tool { }\n");
    const sources = await Promise.resolve(model.getConfig(Constraints.of({}), execution).materialize(writtenOnCommandLine("@ns")));
    expect(sources).to.have.lengthOf(1);
    expect(sources[0]).to.be.instanceOf(NamespaceRef);
    expect(() => refuseNamespaces(sources)).to.throw("'@root:@ns' is not a complete reference, so it names no package or files");
  });

  it("conflicts with a target of the namespace's name", () => {
    expect(load("default @ns = @root:@ns;\ntest_package @ns/tool { }\ntest_package @ns { }\n").errors.join("\n")).to.match(/@ns/);
    expect(load("test_package @ns { }\ntest_package @ns/tool { }\ndefault @ns = @root:@ns;\n").errors.join("\n")).to.match(/@ns/);
  });

  it("allows one declaration of it per tier", () => {
    expect(load("@ns = @root:@ns;\n@ns = @root:@ns;\ntest_package @ns/tool { }\n").errors.join("\n")).to.match(/@ns/);
  });

  it("gives a repository no namespace of its own", () => {
    /* Only a property is a namespace's fallback: a repository declared under the
     * namespace's name is an ordinary target of it, which the namespace
     * conflicts with. */
    expect(load("test_ns_repo @ns { }\ntest_package @ns/tool { }\n").errors.join("\n")).to.match(/conflicts with/);
  });
});

describe("Rule selection", () => {
  /** The rule that last ran, identified by its evaluate function. */
  let lastRan: RuleDefinition["evaluate"] | undefined;
  function recording(): RuleDefinition["evaluate"] {
    const evaluate: RuleDefinition["evaluate"] = () => {
      lastRan = evaluate;
      return Computable.resolve(EMPTY_FILESET);
    };
    return evaluate;
  }

  const wildcardRule = recording();
  const testRule = recording();
  const specificTestRule = recording();
  const defaultRule = recording();
  const overrideRule = recording();

  /**
   * A model over the given build-file text and rules. Each type a rule is
   * registered for, and each of `types`, is declared (unless `input` declares it)
   * and given a target `a_<type>` for {@link selected} to build.
   */
  function modelOf(input: string, rules: RuleDefinition[], types: string[] = []): ReturnType<typeof toBuildModel> {
    const errors: string[] = [];
    const log = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const subjects = [...new Set([...rules.flatMap(rule => (rule.type === undefined ? [] : [rule.type])), ...types])]
      .map(type => `${input.includes(`targetdef ${type} `) ? "" : `targetdef ${type} { }\n`}${type} a_${type} { }\n`)
      .join("");
    const built = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input + subjects, log)], log, [{ rules }]);
    expect(errors).to.deep.equal([]);
    return built;
  }

  /** The evaluate function of the rule selected for a target of `type` under
   * `config`, or undefined if none applies. */
  async function selected(from: ReturnType<typeof toBuildModel>, type: string, config: Record<string, string> = {}): Promise<unknown> {
    lastRan = undefined;
    try {
      await from.getConfig(Constraints.of(config), execution).materialize(writtenOnCommandLine(`a_${type}`));
    } catch (err) {
      if (err instanceof NoRuleFoundError) {
        return undefined;
      }
      throw err instanceof DependencyFailedError ? err.cause : err;
    }
    return lastRan;
  }

  const model = modelOf(
    "",
    [
      { type: "reg_test", properties: {}, evaluate: wildcardRule },
      { type: "reg_test", properties: { BUILD_OPERATION: "test" }, evaluate: testRule },
      /* A type with only operation-specific rules (no {} catch-all), so an
       * operation it doesn't cover falls through to the default rule. */
      { type: "reg_specific", properties: { BUILD_OPERATION: "test" }, evaluate: specificTestRule },
      /* A type-specific rule matching the same operation as the default rule, to
       * prove the type-specific one is preferred. */
      { type: "reg_override", properties: { BUILD_OPERATION: "reg_default" }, evaluate: overrideRule },
      { properties: { BUILD_OPERATION: "reg_default" }, evaluate: defaultRule },
    ],
    ["no_such_type", "some_other_type"]
  );

  it("selects the most specific matching rule", async () => {
    expect(await selected(model, "reg_test")).to.equal(wildcardRule);
    expect(await selected(model, "reg_test", { BUILD_OPERATION: "build" })).to.equal(wildcardRule);
    expect(await selected(model, "reg_test", { BUILD_OPERATION: "test" })).to.equal(testRule);
    /* Unrelated constraints don't disturb selection */
    expect(await selected(model, "reg_test", { BUILD_OPERATION: "test", arch: "armv7" })).to.equal(testRule);
  });

  it("selects nothing when no rule matches", async () => {
    expect(await selected(model, "no_such_type")).to.equal(undefined);
  });

  it("falls back to a default rule for any type when no type-specific rule matches", async () => {
    /* A type with no rules at all: the default rule applies */
    expect(await selected(model, "some_other_type", { BUILD_OPERATION: "reg_default" })).to.equal(defaultRule);
    /* A type that HAS rules, but none matching this operation: still falls back */
    expect(await selected(model, "reg_specific", { BUILD_OPERATION: "reg_default" })).to.equal(defaultRule);
  });

  it("lets a type's own {} wildcard shadow the default rule", async () => {
    /* reg_test's {} rule is type-specific, so it matches every operation and the
     * default is never reached — the type dimension dominates. */
    expect(await selected(model, "reg_test", { BUILD_OPERATION: "reg_default" })).to.equal(wildcardRule);
  });

  it("prefers a type-specific rule over a default rule matching the same operation", async () => {
    expect(await selected(model, "reg_override", { BUILD_OPERATION: "reg_default" })).to.equal(overrideRule);
  });

  it("errors on an ambiguous (equally-specific) rule tie rather than picking first-registered", async () => {
    const tied = modelOf("", [
      { type: "amb", properties: { BUILD_OPERATION: "test" }, evaluate: testRule },
      { type: "amb", properties: { arch: "armv7" }, evaluate: specificTestRule },
    ]);
    /* Both rules have one key and both match, so neither is more specific. */
    await expect(selected(tied, "amb", { BUILD_OPERATION: "test", arch: "armv7" })).to.be.rejectedWith(/Ambiguous 'amb' rule selection/);
    /* But a config satisfying only one of them selects cleanly. */
    expect(await selected(tied, "amb", { BUILD_OPERATION: "test" })).to.equal(testRule);
  });

  describe("reads the configuration as properties", () => {
    const rules: RuleDefinition[] = [
      { type: "typed", properties: {}, evaluate: wildcardRule },
      { type: "typed", properties: { MODE: "fast" }, evaluate: testRule },
    ];

    it("matches a `default` nothing overrides", async () => {
      expect(await selected(modelOf("default MODE = fast;\n", rules), "typed")).to.equal(testRule);
    });

    it("matches a declared global, over the default", async () => {
      const declared = modelOf("default MODE = slow;\nMODE = fast;\n", rules);
      expect(await selected(declared, "typed")).to.equal(testRule);
    });

    it("matches an override of what is declared", async () => {
      const declared = modelOf("default MODE = fast;\n", rules);
      expect(await selected(declared, "typed", { MODE: "slow" })).to.equal(wildcardRule);
      expect(await selected(modelOf("default MODE = slow;\n", rules), "typed", { MODE: "fast" })).to.equal(testRule);
    });

    it("matches by pattern, as a guard does", async () => {
      const globbed = modelOf("default PLATFORM = x86_64-linux-gnu;\n", [
        { type: "typed", properties: {}, evaluate: wildcardRule },
        { type: "typed", properties: { PLATFORM: "*-linux-*" }, evaluate: testRule },
      ]);
      expect(await selected(globbed, "typed")).to.equal(testRule);
      expect(await selected(globbed, "typed", { PLATFORM: "arm64-darwin" })).to.equal(wildcardRule);
    });

    it("skips a rule keyed on a name nothing declares", async () => {
      expect(await selected(modelOf("", rules), "typed")).to.equal(wildcardRule);
      /* A target of that name is not a property either. */
      expect(await selected(modelOf("targetdef typed { }\ntyped MODE { }\n", rules), "typed")).to.equal(wildcardRule);
    });

    it("skips a rule keyed on a property no declaration supplies here", async () => {
      const guarded = modelOf("default FLAVOUR = plain;\nMODE<FLAVOUR=spicy> = fast;\n", rules);
      expect(await selected(guarded, "typed")).to.equal(wildcardRule);
      expect(await selected(guarded, "typed", { FLAVOUR: "spicy" })).to.equal(testRule);
    });

    it("fails on a key that cannot be read, rather than skipping its rule", async () => {
      const broken = modelOf("MODE = ${UNDECLARED};\n", rules);
      await expect(selected(broken, "typed")).to.be.rejectedWith(/UNDECLARED/);
    });
  });

  it("reports a cycle through a key whose value needs a target selected on it", async () => {
    /* `u` settles asynchronously, so by the time it asks for `t` again, t's own
     * evaluation — waiting on MODE, which is waiting on u — is already cached. */
    const cyclic = modelOf("targetdef typed { }\ntargetdef mid { deps = PACKAGES; }\nMODE = `u`;\nmid u { deps = t; }\ntyped t { }\n", [
      { type: "typed", properties: {}, evaluate: wildcardRule },
      { type: "typed", properties: { MODE: "fast" }, evaluate: testRule },
      {
        type: "mid",
        properties: {},
        requirements: context =>
          Computable.from<void>(resolve => setTimeout(resolve, 5)).then(() => ({ deps: context.getPackageProperty("deps") })),
        evaluate: () => Computable.resolve(EMPTY_FILESET),
      },
    ]);
    const outcome = await settledOr(
      Promise.resolve(
        cyclic.getConfig(Constraints.of({ BUILD_OPERATION: "run" }), execution).materialize(writtenOnCommandLine("t"))
      ).then(
        () => "built",
        (err: Error) => {
          let cause = err;
          while (cause instanceof DependencyFailedError || cause instanceof ReferenceFailedError) {
            cause = cause.cause;
          }
          return cause.message;
        }
      ),
      "never settled"
    );
    expect(outcome).to.equal("Circular dependency: 't' depends on itself");
  });

  describe("on the target's own properties", () => {
    let ran: string[] = [];
    const record = (name: string): RuleDefinition["evaluate"] => () => {
      ran.push(name);
      return Computable.resolve(EMPTY_FILESET);
    };
    const rules: RuleDefinition[] = [
      { type: "typed", properties: {}, evaluate: record("wildcard") },
      { type: "typed", properties: {}, targetProperties: { flavour: "van*" }, evaluate: record("vanilla") },
      { type: "typed", properties: { MODE: "fast" }, evaluate: record("fast") },
      { type: "typed", properties: { MODE: "fast" }, targetProperties: { flavour: "van*" }, evaluate: record("fast vanilla") },
      /* Builds an anonymous `typed` of the flavour it is given. */
      { type: "outer", properties: {}, evaluate: context => context.getString("inner").then(inner => context.subTarget("typed", inner ? { flavour: inner } : {})) },
    ];
    const DEFS = "targetdef typed { flavour = STRING; srcs = FILES; }\ntargetdef outer { inner = STRING; }\n";

    async function build(input: string, name: string, config: Record<string, string> = {}): Promise<string[]> {
      ran = [];
      await modelOf(DEFS + input, rules)
        .getConfig(Constraints.of(config), execution)
        .materialize(writtenOnCommandLine(name));
      return ran;
    }

    it("selects the rule whose pattern the target's property matches", async () => {
      expect(await build("typed t { flavour = vanilla; }\n", "t")).to.deep.equal(["vanilla"]);
      expect(await build("typed t { flavour = chocolate; }\n", "t")).to.deep.equal(["wildcard"]);
    });

    it("skips such a rule for a target that does not set the property", async () => {
      expect(await build("typed t { }\n", "t")).to.deep.equal(["wildcard"]);
    });

    it("reads the property as the target resolves it", async () => {
      expect(await build("KIND = vanilla;\ntyped t { flavour = ${KIND}; }\n", "t")).to.deep.equal(["vanilla"]);
      const guarded = "default MODE = slow;\ntyped t { flavour<MODE=fast> = vanilla; }\n";
      expect(await build(guarded, "t")).to.deep.equal(["wildcard"]);
    });

    it("counts both guards' keys when ranking", async () => {
      const input = "default MODE = slow;\ntyped t { flavour = vanilla; }\n";
      expect(await build(input, "t", { MODE: "fast" })).to.deep.equal(["fast vanilla"]);
      expect(await build("default MODE = slow;\ntyped t { }\n", "t", { MODE: "fast" })).to.deep.equal(["fast"]);
    });

    it("judges an anonymous target against the inputs it is given", async () => {
      expect(await build("outer o { inner = vanilla; }\n", "o")).to.deep.equal(["vanilla"]);
      expect(await build("outer o { }\n", "o")).to.deep.equal(["wildcard"]);
    });

    it("reports a property that cannot be read against the target", async () => {
      await expect(build("typed t { flavour = ${UNDECLARED}; }\n", "t")).to.be.rejectedWith(DependencyFailedError);
    });

    it("reports no rule where none applies, with how each rule was judged", async () => {
      const only = modelOf(DEFS + "typed t { flavour = chocolate; }\n", [rules[1]]);
      const failure = (await only
        .getConfig(Constraints.of({}), execution)
        .materialize(writtenOnCommandLine("t"))
        .then(
          () => undefined,
          (err: Error) => err
        )) as NoRuleFoundError;
      expect(failure).to.be.instanceOf(NoRuleFoundError);
      expect(failure.candidates).to.deep.equal([[{ key: "flavour", own: true, pattern: "van*", value: "chocolate", matched: false }]]);
    });

    it("rejects a rule selecting on a property its type does not declare as a STRING", () => {
      const keyed = (key: string): RuleDefinition[] => [{ type: "typed", properties: {}, targetProperties: { [key]: "x" }, evaluate: wildcardRule }];
      expect(() => modelOf(DEFS, keyed("colour"))).to.throw(/selects on its property 'colour', which 'typed' does not declare as a STRING/);
      expect(() => modelOf(DEFS, keyed("srcs"))).to.throw(/'srcs'/);
    });
  });
});

describe("inspecting a target's collection", () => {
  /** The targets whose rule was evaluated, in order. */
  let proceeded: string[] = [];
  const libRule = (part: string, properties: Record<string, string>): RuleDefinition => ({
    type: "lib",
    properties,
    requirements: context => {
      const deps = context.getPackageProperty("deps", BUILD_OVERRIDE);
      /* The package's own requirements under `build`; under `test`, a
       * requirement of the test run alone. */
      return Computable.resolve({ srcs: context.getFileProperty("srcs"), [part === "deps" ? "dependencies" : part]: deps });
    },
    evaluate: (context, requirements) =>
      Computable.forAll([requirements.materializeAll(), requirements.packages(part === "deps" ? "dependencies" : part)], (_collected, deps) => {
        proceeded.push(context.name);
        return new PackageFileSet([["index.js", new MemoryFile(Buffer.from(context.name))]], context.name, "1.0.0", deps);
      }),
  });
  /* A rule with requirements that delivers files, not a package. */
  const filesRule: RuleDefinition = {
    type: "files",
    properties: {},
    requirements: context => Computable.resolve({ srcs: context.getFileProperty("srcs") }),
    evaluate: context => {
      proceeded.push(context.name);
      return Computable.resolve(new FileSet(new Map([["out.txt", new MemoryFile(Buffer.from(context.name))]])));
    },
  };
  /* A `run` rule whose one requirement is its own target under `build`. */
  const runRule: RuleDefinition = {
    type: "lib",
    properties: { BUILD_OPERATION: "run" },
    requirements: context => Computable.resolve({ pkg: context.resolveSelfWithOverrides(BUILD_OVERRIDE) }),
    evaluate: (context, requirements) =>
      requirements.materializeAll().then(({ pkg }) => {
        proceeded.push(`${context.name}[run]`);
        return Computable.resolve(pkg[0]);
      }),
  };
  const rules: RuleDefinition[] = [
    libRule("deps", {}),
    libRule("test_deps", { BUILD_OPERATION: "test" }),
    runRule,
    filesRule,
    { type: "plain", properties: {}, evaluate: () => Computable.resolve(EMPTY_FILESET) },
  ];
  const DEFS = "targetdef lib { srcs = FILES; deps = PACKAGES; }\ntargetdef files { srcs = FILES; }\ntargetdef plain { }\n";

  function configOf(input: string): BuildContext {
    const errors: string[] = [];
    const log = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const built = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", DEFS + input, log)], log, [{ rules }]);
    expect(errors).to.deep.equal([]);
    return built.getConfig(Constraints.of({}), execution);
  }

  /** Resolve `name` and list each requirement's package ids, by requirement name. */
  async function inspected(config: BuildContext, name: string): Promise<Record<string, string[]>> {
    const parts = requirementsOf(await config.resolve(writtenOnCommandLine(name)));
    return Object.fromEntries([...parts].map(([part, resolved]) => [part, resolved.filter(isPackage).map(pkg => pkg.packageId)]));
  }

  beforeEach(() => {
    proceeded = [];
  });

  it("yields what the rule requires, building nothing", async () => {
    const config = configOf("lib base { }\nlib mid { deps = base; }\nlib app { deps = mid; }");
    expect(await inspected(config, "app")).to.deep.equal({ srcs: [], dependencies: ["mid@*"] });
    expect(proceeded).to.deep.equal([]);
  });

  it("states each package with the packages it requires", async () => {
    const config = configOf("lib base { }\nlib mid { deps = base; }\nlib app { deps = mid; }");
    const [mid] = requirementsOf(await config.resolve(writtenOnCommandLine("app"))).get("dependencies")!;
    expect(mid).to.be.instanceOf(ResolvedNode);
    expect((mid as ResolvedNode).packages.map(pkg => pkg.packageId)).to.deep.equal(["base@*"]);
  });

  it("answers for a target and for one that depends on it", async () => {
    const config = configOf("lib base { }\nlib app { deps = base; }");
    const [base, app] = await Promise.all([inspected(config, "base"), inspected(config, "app")]);
    expect(base).to.deep.equal({ srcs: [], dependencies: [] });
    expect(app).to.deep.equal({ srcs: [], dependencies: ["base@*"] });
  });

  it("reads a projection into a package as no requirement", async () => {
    const config = configOf("lib base { }\nlib mid { deps = base:index.js; }\nlib app { deps = mid base:*.js; }");
    expect(await inspected(config, "app")).to.deep.equal({ srcs: [], dependencies: ["mid@*"] });
    const [mid] = requirementsOf(await config.resolve(writtenOnCommandLine("app"))).get("dependencies")!;
    expect((mid as ResolvedNode).packages).to.deep.equal([]);
    expect(proceeded).to.deep.equal([]);
  });

  it("reads a rule's requirement of its own target without building it", async () => {
    const config = configOf("lib base { }\nlib app { deps = base; }");
    expect(await inspected(config, "app<BUILD_OPERATION=run>")).to.deep.equal({ pkg: ["app@*"] });
    expect(proceeded).to.deep.equal([]);
    /* Materialized, the run rule is given the target's own build. */
    const [built] = await config.materialize(writtenOnCommandLine("app<BUILD_OPERATION=run>"));
    expect((built as PackageFileSet).packageId).to.equal("app@1.0.0");
    expect(proceeded).to.deep.equal(["base", "app", "app[run]"]);
  });

  it("reports a cycle among what is read, building nothing", async () => {
    const failure = await configOf("lib a { deps = b; }\nlib b { deps = a; }")
      .resolve(writtenOnCommandLine("a"))
      .then(
        () => undefined,
        err => err
      );
    expect(circularOf(failure)).to.be.instanceOf(CircularDependencyError);
    expect(proceeded).to.deep.equal([]);
  });

  it("reads a name a constraint overrides as what it is overridden to", async () => {
    const errors: string[] = [];
    const log = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const built = toBuildModel(
      [parseBuildString(EMPTY_FILESET, "TEST.fabr", DEFS + "lib base { }\nlib alt { }\nlib app { deps = base; }", log)],
      log,
      [{ rules }]
    );
    const config = built.getConfig(Constraints.of({ base: "alt" }), execution);
    expect(await inspected(config, "app")).to.deep.equal({ srcs: [], dependencies: ["alt@*"] });
  });

  it("shows a target that builds files as it shows any target, unbuilt", async () => {
    const config = configOf("files gen { }\nlib app { deps = gen; }");
    expect(await inspected(config, "app")).to.deep.equal({ srcs: [], dependencies: ["gen@*"] });
    expect(proceeded).to.deep.equal([]);
  });

  it("asks under the configuration the name requires", async () => {
    const config = configOf("lib base { }\nlib app { deps = base; }");
    expect(await inspected(config, "app<BUILD_OPERATION=test>")).to.deep.equal({ srcs: [], test_deps: ["base@*"] });
  });

  it("yields no parts for a target whose rule has no requirements", async () => {
    expect(await inspected(configOf("plain p { }"), "p")).to.deep.equal({});
  });

  it("resolves a global to the targets it names, each resolved to its node without being built", async () => {
    const config = configOf("lib base { }\nDEPS = base;");
    const [base] = (await config.resolve(writtenOnCommandLine("DEPS"))).denoted;
    expect(base).to.be.instanceOf(ResolvedTarget);
    expect((base as ResolvedTarget).packageId).to.equal("base@*");
    expect(proceeded).to.deep.equal([]);
  });

  it("resolves a projection into a target to the projection pending over its node", async () => {
    const [selected] = (await configOf("lib base { }").resolve(writtenOnCommandLine("base:lib/*.js"))).denoted;
    expect(selected).to.be.instanceOf(ProjectedPackage);
    expect(((selected as ProjectedPackage).base as ResolvedTarget).packageName).to.equal("base");
  });
});

describe("a reference to a target", () => {
  /** The targets whose rule was evaluated, in order. */
  let evaluated: string[] = [];
  /* A package made from its `deps`, with one file. */
  const libRule: RuleDefinition = {
    type: "lib",
    properties: {},
    requirements: context => Computable.resolve({ dependencies: context.getPackageProperty("deps") }),
    evaluate: (context, requirements) =>
      Computable.forAll([requirements.materializeAll(), requirements.packages("dependencies")], (_collected, packages) => {
        evaluated.push(context.name);
        return new PackageFileSet([["index.js", new MemoryFile(Buffer.from(context.name))]], context.name, "1.0.0", packages);
      }),
  };
  /* Plain files. */
  const genRule: RuleDefinition = {
    type: "gen",
    properties: {},
    requirements: () => Computable.resolve({}),
    evaluate: context => {
      evaluated.push(context.name);
      return Computable.resolve(new FileSet(new Map([["out.txt", new MemoryFile(Buffer.from(context.name))]])));
    },
  };
  /* Plain files: one, named for the target. */
  const noteRule: RuleDefinition = {
    type: "note",
    properties: {},
    evaluate: context => Computable.resolve(new FileSet(new Map([[`${context.name}.txt`, new MemoryFile(Buffer.from(context.name))]]))),
  };
  /* A package that requires nothing, from a rule that states no requirements. */
  const bareLibRule: RuleDefinition = {
    type: "barelib",
    properties: {},
    evaluate: context => Computable.resolve(new PackageFileSet([["index.js", new MemoryFile(Buffer.from(context.name))]], context.name, "1.0.0")),
  };
  /* A package whose build fails. */
  const badLibRule: RuleDefinition = {
    type: "badlib",
    properties: {},
    evaluate: () => Computable.reject(new FabrError("it broke")),
  };
  const brokenRule: RuleDefinition = {
    type: "broken",
    properties: {},
    requirements: () => Computable.resolve({}),
    evaluate: () => Computable.reject(new FabrError("it broke")),
  };
  /* Records what each of its `deps` delivered: `package <name>` for a package,
   * and the file names of anything else. */
  const userRule: RuleDefinition = {
    type: "user",
    properties: {},
    requirements: context => Computable.resolve({ deps: context.getPackageProperty("deps") }),
    evaluate: (context, requirements) =>
      requirements.materializeAll().then(({ deps }) => {
        evaluated.push(context.name);
        const names = deps.flatMap(dep =>
          dep instanceof PackageFileSet ? [`package ${dep.packageName}`] : [...(dep as FileSet)].map(([name]) => name)
        );
        return Computable.resolve(new FileSet(new Map([["names", new MemoryFile(Buffer.from(names.join(",")))]])));
      }),
  };
  /* Reads `extra` in `evaluate`, outside its requirements, and materializes
   * none of it. */
  const readerRule: RuleDefinition = {
    type: "reader",
    properties: {},
    requirements: () => Computable.resolve({}),
    evaluate: context => context.getPackageProperty("extra").then(() => EMPTY_FILESET),
  };
  /* A package naming each of its `deps` as a provided requirement. */
  const peerLibRule: RuleDefinition = {
    type: "peerlib",
    properties: {},
    requirements: context => Computable.resolve({ dependencies: context.getPackageProperty("deps") }),
    evaluate: (context, requirements) =>
      Computable.forAll([requirements.materializeAll(), requirements.packages("dependencies")], (_collected, packages) => {
        const provided = new Map(packages.map(edge => [dependencyName(edge), "expected" as const]));
        return new PackageFileSet([["index.js", new MemoryFile(Buffer.from(context.name))]], context.name, "1.0.0", packages, undefined, provided);
      }),
  };
  /* The packages the last `outer` handed its sub-target. */
  let handed: PackageFileSet[] = [];
  /* Hands the packages among its `deps` to an `inner` sub-target as they are. */
  const outerRule: RuleDefinition = {
    type: "outer",
    properties: {},
    requirements: context => Computable.resolve({ deps: context.getPackageProperty("deps") }),
    evaluate: (context, requirements) =>
      requirements.materializeAll().then(({ deps }) => {
        handed = deps.filter((dep): dep is PackageFileSet => dep instanceof PackageFileSet);
        return context.subTarget("inner", { deps: handed }, { label: "inner" });
      }),
  };
  /* Records, per package among its `deps`, whether it is the very one handed. */
  const innerRule: RuleDefinition = {
    type: "inner",
    properties: {},
    requirements: context => Computable.resolve({ deps: context.getPackageProperty("deps") }),
    evaluate: (_context, requirements) =>
      requirements.materializeAll().then(({ deps }) => {
        const names = deps.map(dep => (dep instanceof PackageFileSet ? `${dep.packageName}:${handed.includes(dep)}` : "files"));
        return new FileSet(new Map([["names", new MemoryFile(Buffer.from(names.join(",")))]]));
      }),
  };
  const DEFS =
    ["lib", "user", "peerlib", "outer", "inner"].map(type => `targetdef ${type} { deps = PACKAGES; }\n`).join("") +
    "targetdef gen { }\ntargetdef note { }\ntargetdef broken { }\ntargetdef badlib { }\ntargetdef barelib { }\ntargetdef reader { extra = PACKAGES; }\n";

  function configOf(input: string): BuildContext {
    const errors: string[] = [];
    const log = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const built = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", DEFS + input, log)], log, [
      { rules: [libRule, genRule, noteRule, brokenRule, badLibRule, bareLibRule, userRule, readerRule, peerLibRule, outerRule, innerRule] },
    ]);
    expect(errors).to.deep.equal([]);
    return built.getConfig(Constraints.of({}), execution);
  }

  /** Materialize `u` and return what its deps delivered, as its rule saw them. */
  async function delivered(config: BuildContext): Promise<string> {
    const [result] = await config.materialize(writtenOnCommandLine("u"));
    return (await (result as FileSet).getFile("names")!.readString()).toString();
  }

  /** Unwrap `err` from the target boundaries around it. */
  function rootCause(err: unknown): unknown {
    let cause = err;
    while (cause instanceof DependencyFailedError || cause instanceof ReferenceFailedError) {
      cause = cause.cause;
    }
    return cause;
  }

  beforeEach(() => {
    evaluated = [];
  });

  it("builds none of the names it was given when one names nothing", async () => {
    const config = configOf("gen g { }\n");
    const failure = await Promise.resolve(buildOperation(config, [writtenOnCommandLine("g"), writtenOnCommandLine("nosuch")])).then(
      () => undefined,
      (err: FabrError) => err.message
    );
    expect(failure).to.equal("Unknown name 'nosuch'");
    expect(evaluated).to.deep.equal([]);
  });

  it("gives each file a target delivers the reference that resolves to it", async () => {
    const config = configOf("gen g { }\nlib l { }\n");
    const sourcePaths = async (name: string): Promise<Array<[string, string | undefined]>> => {
      const [built] = await config.materialize(writtenOnCommandLine(name));
      return [...(built as FileSet)].map(([file]) => [file, (built as FileSet).sourcePathOf(file)]);
    };
    expect(await sourcePaths("g")).to.deep.equal([["out.txt", "g:out.txt"]]);
    expect(await sourcePaths("l")).to.deep.equal([["index.js", "l:index.js"]]);
    /* The same in any configuration: a configuration names no source. */
    expect(await sourcePaths("g<FLAVOR=x>")).to.deep.equal([["out.txt", "g:out.txt"]]);
    /* One prefix names every file, so the set says so whole. */
    const [built] = await config.materialize(writtenOnCommandLine("l"));
    expect((built as FileSet).sourcePathPrefix).to.equal("l:");
  });

  it("gives each file a registry delivers the reference that resolves to it", async () => {
    const log = new LogFormatter(LogLevel.Info, () => undefined);
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", "targetdef test_registry { }\ntest_registry @reg { }\n", log)], log, testContributions);
    const config = model.getConfig(Constraints.of({}), execution);
    const [pkg] = await config.materialize(writtenOnCommandLine("@reg:pkg:1.2.0"));
    expect([...(pkg as FileSet)].map(([file]) => [file, (pkg as FileSet).sourcePathOf(file)])).to.deep.equal([
      ["pkg/data.txt", "@reg:pkg:1.2.0:pkg/data.txt"],
    ]);
    expect((pkg as FileSet).sourcePathPrefix).to.equal("@reg:pkg:1.2.0:");
  });

  it("hands a sub-target the packages it was given as they stand, provided requirements among them or not", async () => {
    expect(await delivered(configOf("lib base { }\nlib x { deps = base; }\nouter u { deps = x base; }"))).to.equal("x:true,base:true");
    expect(await delivered(configOf("lib base { }\npeerlib x { deps = base; }\nouter u { deps = x base; }"))).to.equal("x:true,base:true");
  });

  it("delivers a target and a rename of it as two packages, each for its reference, from one build", async () => {
    expect(await delivered(configOf("lib base { }\nuser u { deps = base base -> other; }"))).to.equal("package base,package other");
    expect(evaluated.filter(name => name === "base")).to.deep.equal(["base"]);
    expect(await delivered(configOf("lib base { }\nuser u { deps = base -> other base; }"))).to.equal("package other,package base");
  });

  it("leaves a sibling's edge to the target where a rename of it is delivered beside", async () => {
    const config = configOf("lib base { }\nlib mid { deps = base; }\nuser u { deps = mid base -> other; }");
    const [mid, other] = requirementsOf(await config.resolve(writtenOnCommandLine("u"))).get("deps")!;
    expect((mid as ResolvedNode).packages.map(pkg => pkg.packageName)).to.deep.equal(["base"]);
    expect((other as ResolvedNode).packageName).to.equal("other");
    expect(await delivered(config)).to.equal("package mid,package other");
  });

  it("is built by the collection point of what names it, not by reading the property", async () => {
    const config = configOf("lib base { }\nuser u { deps = base; }");
    const model = config as unknown as { resolveTarget(name: string): Computable<unknown[]> };
    const [reference] = await model.resolveTarget("base");
    expect(reference).to.be.instanceOf(TargetRef);
    expect(evaluated).to.deep.equal([]);
    expect(await delivered(config)).to.equal("package base");
    expect(evaluated).to.deep.equal(["base", "u"]);
  });

  it("resolves to its node for the reference that asks, renamed as written", async () => {
    const config = configOf("lib base { }");
    const resolved = await config.resolve(writtenOnCommandLine("base"));
    const [reference] = resolved.references.get("")!;
    expect(reference).to.be.instanceOf(TargetRef);
    expect(reference?.toString()).to.equal("base");
    /* Renamed, the package and the reference that asked for it agree. */
    const renamed = await config.resolve(writtenOnCommandLine("base -> other"));
    expect((renamed.denoted[0] as ResolvedNode).packageName).to.equal("other");
    expect(renamed.references.get("")![0]?.localName).to.equal("other");
  });

  it("is built once, however many name it", async () => {
    const config = configOf("lib base { }\nlib left { deps = base; }\nlib right { deps = base; }\nuser u { deps = left right; }");
    expect(await delivered(config)).to.equal("package left,package right");
    expect(evaluated.filter(name => name === "base")).to.deep.equal(["base"]);
  });

  it("applies a projection when the target is delivered", async () => {
    expect(await delivered(configOf("gen g { }\nuser u { deps = g:out.txt; }"))).to.equal("out.txt");
    expect(await delivered(configOf("gen g { }\nuser u { deps = g:*.txt -> *.md; }"))).to.equal("out.md");
  });

  it("reports a literal projection that matches nothing in the target", async () => {
    const failure = await configOf("gen g { }\nuser u { deps = g:nope.txt; }")
      .materialize(writtenOnCommandLine("u"))
      .then(
        () => undefined,
        err => err
      );
    expect(rootCause(failure)).to.be.instanceOf(NameResolutionError);
    /* A glob that matches nothing is no error. */
    expect(await delivered(configOf("gen g { }\nuser u { deps = g:*.md; }"))).to.equal("");
  });

  it("refuses a literal projection over a target that selects nothing, where the name reached that target alone", async () => {
    const failure = await configOf("gen g { }\nuser u { deps = g:nope.txt; }")
      .materialize(writtenOnCommandLine("u"))
      .then(
        () => undefined,
        err => err
      );
    expect(rootCause(failure)).to.be.instanceOf(NameResolutionError);
  });

  it("holds no target to a literal projection where its name reached several", async () => {
    /* BOTH names two targets: each is projected on its own, and one that has
     * no such file yields none, as a registry reference among them would. */
    expect(await delivered(configOf("gen g { }\nnote n { }\nBOTH = g n;\nuser u { deps = BOTH:n.txt; }"))).to.equal("n.txt");
  });

  it("applies a rename when the target is delivered", async () => {
    expect(await delivered(configOf("lib base { }\nuser u { deps = base -> other; }"))).to.equal("package other");
  });

  it("reaches a target through a property that names it", async () => {
    expect(await delivered(configOf("lib base { }\nALL = base;\nuser u { deps = ALL; }"))).to.equal("package base");
  });

  it("attributes a target's failure to the reference it was delivered for", async () => {
    const failure = await configOf("broken b { }\nuser u { deps = b; }")
      .materialize(writtenOnCommandLine("u"))
      .then(
        () => undefined,
        err => err
      );
    expect(failure).to.be.instanceOf(DependencyFailedError);
    const hop = (failure as DependencyFailedError).cause;
    expect(hop).to.be.instanceOf(ReferenceFailedError);
    expect((rootCause(failure) as Error).message).to.equal("it broke");
  });

  it("takes a package that requires nothing from a rule that states no requirements", async () => {
    expect(await delivered(configOf("barelib b { }\nuser u { deps = b; }"))).to.equal("package b");
  });

  it("takes such a package as the dependency of another package, wherever that one is required", async () => {
    /* `b`'s rule states nothing, which is to say that `b` requires nothing;
     * `mid` states `b` and builds requiring it. */
    const built = await configOf("barelib b { }\nlib mid { deps = b; }\nuser u { deps = mid; }").materialize(writtenOnCommandLine("u"));
    expect(built).to.have.length(1);
    const [mid] = await configOf("barelib b { }\nlib mid { deps = b; }").materialize(writtenOnCommandLine("mid"));
    expect((mid as PackageFileSet).packages.map(pkg => pkg.packageName)).to.deep.equal(["b"]);
  });

  it("attributes the failure of a package, built for what requires it, to each reference crossed", async () => {
    /* `bad` and `mid` are packages, so each is built through the node its
     * requirer resolved it as, and not by the reference being materialized. */
    const failure = await configOf("badlib bad { }\nlib mid { deps = bad; }\nuser u { deps = mid; }")
      .materialize(writtenOnCommandLine("u"))
      .then(
        () => undefined,
        err => err
      );
    const crossed: string[] = [];
    const causes = new Set<string>();
    const visit = (err: unknown): void => {
      if (err instanceof MultiError) {
        err.errors.forEach(visit);
      } else if (err instanceof ReferenceFailedError) {
        crossed.push(`${err.target === undefined ? "" : declName(err.target)} ${err.value.value.toString()}`);
        visit(err.cause);
      } else if (err instanceof DependencyFailedError) {
        visit(err.cause);
      } else {
        causes.add((err as Error).message);
      }
    };
    visit(failure);
    expect(crossed).to.include("u mid");
    expect(crossed).to.include("mid bad");
    expect([...causes]).to.deep.equal(["it broke"]);
  });

  it("reports a cycle through references", async () => {
    const failure = await configOf("lib a { deps = b; }\nlib b { deps = a; }")
      .materialize(writtenOnCommandLine("a"))
      .then(
        () => undefined,
        err => err
      );
    expect(circularOf(failure)).to.be.instanceOf(CircularDependencyError);
  });

  it("reports a cycle whose members something else names first", async () => {
    const failure = await configOf("lib a { deps = b; }\nlib b { deps = a; }\nuser u { deps = a b; }")
      .materialize(writtenOnCommandLine("u"))
      .then(
        () => undefined,
        err => err
      );
    /* Both members fail with the cycle, and each is reported. */
    const causes = (
      failure instanceof DependencyFailedError && failure.cause instanceof MultiError ? failure.cause.errors : [failure]
    ).map(rootCause);
    expect(causes).to.have.length(2);
    causes.forEach(cause => expect(circularOf(cause)).to.be.instanceOf(CircularDependencyError));
    expect(evaluated).to.deep.equal([]);
  });

  it("does not count a reference that is looked up and never depended on", async () => {
    /* `a`'s build looks `b` up, which resolves it and builds nothing; `b`
     * requires `a`. Nothing depends on itself: `a` is resolved before either
     * is built, and `b` is never built. */
    const built = await configOf("reader a { extra = b; }\nlib b { deps = a; }").materialize(writtenOnCommandLine("a"));
    expect(built).to.have.length(1);
  });

  it("resolves what a target requires where it is referenced, building none of it", async () => {
    const failure = await configOf("lib base { deps = nowhere; }\nreader a { extra = base; }")
      .materialize(writtenOnCommandLine("a"))
      .then(
        () => undefined,
        err => err
      );
    expect(rootCause(failure)).to.be.instanceOf(NameResolutionError);
    expect(evaluated).to.deep.equal([]);
  });
});

describe("BuildModel repository registration", () => {
  const provider = (): never => {
    throw new Error("unused");
  };
  it("rejects a duplicate repository type across contributions", () => {
    expect(() =>
      toBuildModel([], testLog, [
        { repositories: [{ type: "dup", provider }] },
        { repositories: [{ type: "dup", provider }] },
      ])
    ).to.throw(/Duplicate repository type 'dup'/);
  });
});
