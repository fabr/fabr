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
import { EMPTY_FILESET, FileSet } from "../core/FileSet";
import { MemoryFile } from "../core/MemoryFS";
import {
  PublishMember,
  PublishStatus,
  Repository,
  RepositoryPublishRef,
  RepositoryRef,
  RepositoryWriter,
  Resolution,
  SourceRef,
} from "../core/Repository";
import { PublishableFileSet } from "../core/PublishableFileSet";
import { syncFilesRule, syncRule } from "../rules/BuildSync";
import { RunnableFileSet } from "../core/RunnableFileSet";
import { Name } from "../core/Name";
import { renderProvenance } from "../core/Provenance";
import { ConflictError } from "../core/Errors";
import { LogFormatter, LogLevel } from "../support/Log";
import {
  BuildAction,
  IBuildActionDefinition,
  PluginContribution,
  RepositoryProvider,
  RepositoryRegistration,
  RuleRegistration,
} from "../rules/Types";
import { FSFileSource } from "../core/FSFileSource";
import { scriptRunRule } from "../rules/RunScript";
import { mapEntryOrigin, PropertyMap, PropertyMapValue } from "./BuildContext";
import { BUILD_OPERATION, Constraints } from "./Constraints";
import { CircularDependencyError, DependencyFailedError, NameResolutionError, NoRuleFoundError, ReferenceFailedError } from "./Errors";
import { ExecutionContext } from "./ExecutionContext";
import { INameValue, syntheticValue } from "./AST";
import { StringReader } from "../support/StringReader";
import { parseBuildString, parseName } from "./Parser";
import { toBuildModel } from "./Sema";
import * as chai from "chai";
import { expect } from "chai";
import * as chaiAsPromised from "chai-as-promised";
import { BuildCache } from "../core/BuildCache";

chai.use(chaiAsPromised);

/* The model never writes to it, but ExecutionContext requires a log; these
 * tests don't inspect it, so a stderr-backed one (as the driver uses) serves. */
const testLog = new LogFormatter(LogLevel.Info, console.error);

/* The runtime surroundings for evaluation: none of these tests reach the
 * cache, so a single throwaway instance serves them all */
const execution = new ExecutionContext(new BuildCache(".", testLog), testLog, EMPTY_FILESET, EMPTY_FILESET);

/** A name as the driver hands one over: every caller of {@link
 * BuildContext.resolveName} supplies the decl its reference was written in
 * (the CLI's is synthesized over the command line — see CommandLineSource),
 * there being no such thing as a reference written nowhere. */
function writtenOnCommandLine(name: string): INameValue {
  const source = { fs: EMPTY_FILESET, file: "<command-line>", reader: new StringReader(name) };
  return syntheticValue(parseName(name), source, 0, name.length);
}

/* These tests exercise the evaluation engine with throwaway rules. Rules now
 * ride the model's registry (not a global), so collect them into a contribution
 * and build a per-test registry passed to toBuildModel. `registerRule` /
 * `registerRepositoryProvider` are kept as local shims so the registrations
 * below read unchanged. */
const testRules: RuleRegistration[] = [];
const testRepos: RepositoryRegistration[] = [];
function registerRule(type: string, constraints: Record<string, string>, evaluate: RuleRegistration["evaluate"]): void {
  testRules.push({ type, constraints, evaluate });
}
function registerRepositoryProvider(type: string, provider: RepositoryProvider): void {
  testRepos.push({ type, provider });
}

/* Trivial rules for exercising target-to-target dependency behaviour */
let lastDeps: FileSet | undefined;
registerRule("test_good", {}, context =>
  context.getFileSetProperties(["deps"]).then(({ deps }) => {
    lastDeps = FileSet.unionAll(...deps);
    return EMPTY_FILESET;
  })
);
registerRule("test_fail", {}, () => Computable.reject(new Error("reasons")));
/* Resolves its dep under a caller-supplied constraint override, for testing
 * override precedence against a reference's own <k=v> delta. */
registerRule("test_override", {}, context =>
  context.getFileSetProperties(["dep"], Constraints.of({ FLAVOR: "caller" })).then(({ dep }) => {
    lastDeps = FileSet.unionAll(...dep);
    return EMPTY_FILESET;
  })
);
/* Resolves a GLOBAL under a caller-supplied override, for testing override
 * precedence against a <k=v> delta written on the global's value (the
 * getGlobalFileProperty path — e.g. getGlobalRunnable forcing BUILD_OPERATION=run). */
registerRule("test_globaltool", {}, context =>
  context.collect({ tool: context.getGlobalFileProperty("GLOBALTOOL", Constraints.of({ FLAVOR: "caller" })) }).then(({ tool }) => {
    lastDeps = FileSet.unionAll(...tool);
    return EMPTY_FILESET;
  })
);
/* Reads a STRING global under a caller override, for testing override precedence
 * against a <k=v> delta written on the global's value (the getGlobalString /
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
  context.getRewrite("out").then(rewrite => {
    lastRewrite = ["a.entry.js", "b.entry.js", "keep.txt"].map(name => rewrite(name));
    return EMPTY_FILESET;
  })
);

/* Reads a MAP property, so a test can observe the resolved key -> value map
 * (order preserved, strings substituted and space-joined, sub-maps recursive);
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

/* Repository double: resolves each reference to a single file, and records
 * the batches it was asked to resolve */
const batchCalls: string[][] = [];
class TestRepo implements Repository {
  private readonly cache = new Map<string, FileSet>();

  /* No sub-package grammar: the whole name is the requirement, nothing projects. */
  public getRepositoryRef(name: Name): RepositoryRef {
    return new RepositoryRef(this, name);
  }

  public getRepositoryPublishRef(name: Name): RepositoryPublishRef {
    throw new Error(`test_repo is not a publish destination ('${name.toString()}')`);
  }

  /* The joint batch is the resolve phase — that's where batchCalls records. */
  public resolve(references: RepositoryRef[]): Computable<Resolution> {
    batchCalls.push(references.map(reference => reference.name.toString()));
    return Computable.resolve({ roots: references.map(reference => ({ reference, name: reference.name.toString() })) });
  }

  public materialize(references: RepositoryRef[]): Computable<FileSet[]> {
    return Computable.resolve(references.map(reference => this.filesFor(reference.name.toString())));
  }

  public makeRunnable(): Computable<RunnableFileSet> {
    throw new Error("test_repo does not produce runnables");
  }

  public declaredRequirement(): Computable<undefined> {
    return Computable.resolve(undefined);
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
registerRepositoryProvider("test_repo", () => Computable.resolve(new TestRepo()));

/* Publish-capable repository double: vends publish refs, and packages each
 * member's content verbatim plus a `manifest.txt` naming its address — for
 * exercising the sync rules. */
class TestPubRepo extends TestRepo implements RepositoryWriter {
  public override getRepositoryPublishRef(name: Name): RepositoryPublishRef {
    return new RepositoryPublishRef(this, name);
  }

  public package(members: PublishMember[]): Computable<PublishableFileSet[]> {
    return Computable.resolve(
      members.map(
        member =>
          new PublishableFileSet(
            FileSet.unionAll(
              member.content,
              new FileSet(new Map([["manifest.txt", MemoryFile.from(member.destination.toString())]]))
            ),
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
/* The real sync rules (build + files views), exercised against the double */
testRules.push(syncRule, syncFilesRule);

/* A rule gathering two properties and a global through ONE collection point:
 * all of their references must land in a single joint resolution batch */
registerRule("test_joint", {}, context =>
  context
    .collect({
      adeps: context.getFileProperty("adeps"),
      bdeps: context.getFileProperty("bdeps"),
      globalSrc: context.getGlobalFileProperty("JOINT_GLOBAL"),
    })
    .then(({ adeps, bdeps, globalSrc }) => {
      lastDeps = FileSet.unionAll(...adeps, ...bdeps, ...globalSrc);
      return EMPTY_FILESET;
    })
);

/* A leaf build step and a rule that yields it as a build action, for
 * exercising the boundary caching. The step counts its executions so a
 * cache hit (no run) is observable. */
let leafRuns = 0;
const TEST_LEAF_STEP: IBuildActionDefinition = {
  id: "test:leaf",
  version: 1,
  run: inputs => {
    leafRuns++;
    return Computable.resolve(new FileSet(new Map([["out.txt", MemoryFile.from(inputs.data as string)]])));
  },
};
registerRule("test_parent", {}, context =>
  context.getRequiredString("content").then(content => new BuildAction(TEST_LEAF_STEP, { data: content }, "leaf"))
);

/* An internal type built only as a sub-target: it reads its input through the
 * same context accessors as any target (unaware it is anonymous) and yields
 * the leaf action. */
registerRule("test_sub", {}, context =>
  context.getRequiredString("data").then(data => new BuildAction(TEST_LEAF_STEP, { data }, "sub"))
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

/* A composer that builds a sub-target whose type has a rule but NO targetdef —
 * used to assert subTarget rejects a type missing from the build vocabulary. */
registerRule("test_orphan_sub", {}, context =>
  context.getRequiredString("data").then(data => new BuildAction(TEST_LEAF_STEP, { data }, "orphan"))
);
registerRule("test_orphan_composer", {}, context =>
  context.getRequiredString("content").then(content => context.subTarget("test_orphan_sub", { data: content }, { label: "sub" }))
);

const testContributions: PluginContribution[] = [{ rules: testRules, repositories: testRepos }];

async function testGetProperty(input: string, prop: string, constraints?: Record<string, string>): Promise<string[]> {
  const errors: string[] = [];
  const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
  const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
  if (errors.length !== 0) {
    throw new Error("Parse error:\n" + errors.join("\n"));
  }

  const context = model.getConfig(Constraints.of(constraints ?? {}), execution);
  const result = await context.getProperty(prop);
  return result.getValues();
}

describe("BuildContext", () => {
  it("Wraps dependent target failures with their target chain", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_good { deps = FILES; }\n" +
      "targetdef test_fail { }\n" +
      "test_fail b { }\n" +
      "test_good a { deps = b; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    try {
      await model.getConfig(Constraints.of({}), execution).getTarget("a");
      expect.fail("expected target a to fail");
    } catch (err) {
      expect(err).to.be.instanceOf(DependencyFailedError);
      const outer = err as DependencyFailedError;
      expect(outer.target.name).to.equal("a");
      /* The failure crossed the written reference 'b' in a's deps: the hop
       * records the use site (value span, property, owning target) */
      expect(outer.cause).to.be.instanceOf(ReferenceFailedError);
      const hop = outer.cause as ReferenceFailedError;
      expect(hop.value.value.toString()).to.equal("b");
      expect(hop.property.name).to.equal("deps");
      expect(hop.target?.name).to.equal("a");
      expect(hop.cause).to.be.instanceOf(DependencyFailedError);
      const inner = hop.cause as DependencyFailedError;
      expect(inner.target.name).to.equal("b");
      expect(inner.cause.message).to.equal("reasons");
    }
  });

  it("Reports a name that resolves to itself as a cycle at the reference that closed it", async () => {
    /* Name shadowing: 'base:*.ts' reads as a directory but a target of that
     * name takes precedence, so the target's srcs are its own output. The
     * cycle is one use site — the written reference, which is the mistake. */
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input = "targetdef test_good { deps = FILES; }\ntest_good base { deps = base:*.ts; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    try {
      await model.getConfig(Constraints.of({}), execution).getTarget("base");
      expect.fail("expected target base to fail");
    } catch (err) {
      const cause = (err as DependencyFailedError).cause;
      expect(cause).to.be.instanceOf(CircularDependencyError);
      const circular = cause as CircularDependencyError;
      expect(circular.name).to.equal("base");
      expect(circular.message).to.equal("Circular dependency: 'base' depends on itself");
      expect(circular.cycle.map(site => site.value.value.toString())).to.deep.equal(["base:*.ts"]);
      expect(circular.cycle[0].property.name).to.equal("deps");
      expect(circular.cycle[0].target?.name).to.equal("base");
    }
  });

  it("Reports a cycle through several targets as the whole loop", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input = "targetdef test_good { deps = FILES; }\ntest_good one { deps = two; }\ntest_good two { deps = one; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    try {
      await model.getConfig(Constraints.of({}), execution).getTarget("one");
      expect.fail("expected target one to fail");
    } catch (err) {
      let cause: Error = err as Error;
      while (cause instanceof DependencyFailedError || cause instanceof ReferenceFailedError) {
        cause = cause.cause;
      }
      expect(cause).to.be.instanceOf(CircularDependencyError);
      const circular = cause as CircularDependencyError;
      expect(circular.name).to.equal("one");
      /* Closing reference first ('one', written in two's deps), back to the use
       * site that entered the cycle ('two', written in one's deps). */
      expect(circular.cycle.map(site => `${site.target?.name} ${site.property.name} = ${site.value.value.toString()}`)).to.deep.equal([
        "two deps = one",
        "one deps = two",
      ]);
    }
  });

  it("Attributes file conflicts to the dependencies that introduced them", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_good { deps = FILES; }\n" +
      "targetdef test_file { content = STRING; }\n" +
      "test_file c1 { content = one; }\n" +
      "test_file c2 { content = two; }\n" +
      "test_good a { deps = c1 c2; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    try {
      await model.getConfig(Constraints.of({ arch: "armv7" }), execution).getTarget("a");
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

  it("Attributes a conflict raised mid-resolution to the written value that caused it", async () => {
    /* A projection into a multi-source property (`x:f.txt`) unions two producers
     * that both emit `f.txt` — the conflict is raised inside the value's own
     * resolution (a rename projection collapsing names is the same path), before
     * the model-ref step is stamped, so it must be chained on so the driver
     * traces it to the written `x:f.txt`, not just the underlying producers. */
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_good { deps = FILES; }\n" +
      "targetdef test_file { content = STRING; }\n" +
      "test_file c1 { content = one; }\n" +
      "test_file c2 { content = two; }\n" +
      "x = c1 c2;\n" +
      "test_good a { deps = x:f.txt; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    try {
      await model.getConfig(Constraints.of({}), execution).getTarget("a");
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
      "targetdef test_good { deps = FILES; }\n" +
      "targetdef test_constrained { }\n" +
      "test_constrained n { }\n" +
      "test_good a { deps = n; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    try {
      await model.getConfig(Constraints.of({}), execution).getTarget("a");
      expect.fail("expected target a to fail");
    } catch (err) {
      expect(err).to.be.instanceOf(DependencyFailedError);
      /* The no-rule failure crossed the written reference 'n' in a's deps */
      const hop = (err as DependencyFailedError).cause;
      expect(hop).to.be.instanceOf(ReferenceFailedError);
      expect((hop as ReferenceFailedError).value.value.toString()).to.equal("n");
      expect((hop as ReferenceFailedError).property.name).to.equal("deps");
      const cause = (hop as ReferenceFailedError).cause;
      expect(cause).to.be.instanceOf(NoRuleFoundError);
      const noRule = cause as NoRuleFoundError;
      expect(noRule.message).to.equal("No rule matches target 'n' of type 'test_constrained'");
      expect(noRule.target.name).to.equal("n");
      /* The full constraint set rides as data; presentation decides what shows */
      expect(noRule.constraints.isEmpty()).to.equal(true);
    }
  });

  it("rejects a prototype-polluting name instead of resolving an inherited member", async () => {
    /* Names are user-controlled and looked up with `name in cache` / `cache[name]`.
     * A name like `toString` or `__proto__` must resolve as an ordinary unknown
     * name, not silently hit an Object.prototype member (which previously let
     * `fabr build toString` succeed with exit 0 against no such target). */
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const model = toBuildModel(
      [parseBuildString(EMPTY_FILESET, "TEST.fabr", "targetdef test_good { deps = FILES; }\n", logger)],
      logger,
      testContributions
    );
    expect(errors).to.deep.equal([]);

    for (const name of ["toString", "valueOf", "__proto__", "constructor"]) {
      let threw = false;
      try {
        await model.getConfig(Constraints.of({}), execution).getTarget(name);
      } catch (err) {
        threw = true;
        expect((err as Error).message, name).to.match(/^Unknown name '/);
      }
      expect(threw, `expected '${name}' to be unresolved`).to.equal(true);
    }
    /* The `${valueOf}` property path is guarded the same way. */
    expect(() => model.getConfig(Constraints.of({}), execution).getProperty("valueOf")).to.throw(/Unknown property/);
  });

  it("Fails a literal name that names no target and matches no file", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input = "targetdef test_good { deps = FILES; }\n" + "test_good a { deps = fooff; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    try {
      await model.getConfig(Constraints.of({}), execution).getTarget("a");
      expect.fail("expected target a to fail");
    } catch (err) {
      expect(err).to.be.instanceOf(DependencyFailedError);
      const cause = (err as DependencyFailedError).cause;
      expect(cause).to.be.instanceOf(NameResolutionError);
      expect(cause.message).to.equal("Unable to resolve 'fooff'");
      /* The use site identifies whose property the name was written in */
      const useSite = (cause as NameResolutionError).useSite;
      expect(useSite?.property.name).to.equal("deps");
      expect(useSite?.target?.name).to.equal("a");
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
      "targetdef test_good { deps = FILES; }\n" +
      "targetdef test_file { content = STRING; }\n" +
      "test_file t1 { content = one; }\n" +
      "test_file t2 { content = two; }\n" +
      "tool = t1;\n" +
      "test_good a { deps = tool; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    /* No override: the naked `tool` resolves the declared value t1. */
    await model.getConfig(Constraints.of({}), execution).getTarget("a");
    expect(await lastDeps!.readFile("f.txt")).to.equal("one");

    /* `-Dtool=t2` (a constraint) repins the same bare reference to t2. */
    await model.getConfig(Constraints.of({ tool: "t2" }), execution).getTarget("a");
    expect(await lastDeps!.readFile("f.txt")).to.equal("two");
  });

  it("Leaves a glob matching nothing as an empty resolution", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input = "targetdef test_good { deps = FILES; }\n" + "test_good a { deps = fooff*; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).getTarget("a");
    expect(lastDeps?.isEmpty()).to.equal(true);
  });

  it("Fails a literal projection into a target that matches no file", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_good { deps = FILES; }\n" +
      "targetdef test_file { content = STRING; }\n" +
      "test_file b { content = one; }\n" +
      "test_good a { deps = b:missing.txt; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    try {
      await model.getConfig(Constraints.of({}), execution).getTarget("a");
      expect.fail("expected target a to fail");
    } catch (err) {
      expect(err).to.be.instanceOf(DependencyFailedError);
      const cause = (err as DependencyFailedError).cause;
      expect(cause).to.be.instanceOf(NameResolutionError);
      expect(cause.message).to.equal("Unable to resolve 'b:missing.txt'");
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
    const both = await config.resolveName(writtenOnCommandLine("m:package.json"));
    expect(both).to.have.length(2);
    const contents = await Promise.all(
      both.map(source => (source as FileSet).get("package.json").then(file => file!.readString()))
    );
    expect(contents.sort()).to.deep.equal(["one", "two"]);

    /* A name only one member matches: the missed members are dropped, not
     * kept as empty sources. */
    const one = await config.resolveName(writtenOnCommandLine("m:one.tgz"));
    expect(one).to.have.length(1);
    expect([...(one[0] as FileSet)].map(([name]) => name)).to.deep.equal(["one.tgz"]);
  });

  it("Lays a sync out under member-coordinate directories for the files operation", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_pub { }\n" +
      "targetdef test_file { content = STRING; }\n" +
      "targetdef sync { * = FILES; }\n" +
      "test_pub pub { }\n" +
      "test_file c1 { content = one; }\n" +
      "test_file c2 { content = two; }\n" +
      "sync release { pub:alpha:1.0.0 = c1; pub:beta:2.0.0 = c2; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);
    const config = model.getConfig(Constraints.of({ [BUILD_OPERATION]: "files" }), execution);

    /* The whole release under `files`: ONE FileSet, each member's artifacts
     * under its coordinate as a directory (alias separators as path
     * separators). */
    const all = await config.resolveName(writtenOnCommandLine("release"));
    expect(all).to.have.length(1);
    expect([...(all[0] as FileSet)].map(([name]) => name).sort()).to.deep.equal([
      "pub/alpha/1.0.0/f.txt",
      "pub/alpha/1.0.0/manifest.txt",
      "pub/beta/2.0.0/f.txt",
      "pub/beta/2.0.0/manifest.txt",
    ]);

    /* So the ordinary written-name rule addresses one member's file — no
     * bespoke namespace: the coordinate matches as alias segments and is
     * stripped colon-form. */
    const one = await config.resolveName(writtenOnCommandLine("release:pub:alpha:1.0.0:manifest.txt"));
    expect(one).to.have.length(1);
    expect([...(one[0] as FileSet)].map(([name]) => name)).to.deep.equal(["manifest.txt"]);
    /* The vended ref's display form is the full written coordinate — the
     * resolver attached the repository's declared name (`pub`) at vend time. */
    const file = await (one[0] as FileSet).get("manifest.txt");
    expect(await file!.readString()).to.equal("pub:alpha:1.0.0");
  });

  it("Defers a multi-source same-name collision to the consumer that unions", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_good { deps = FILES; }\n" +
      "targetdef test_multi { }\n" +
      "test_multi m { }\n" +
      "test_good a { deps = m:package.json; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    try {
      await model.getConfig(Constraints.of({}), execution).getTarget("a");
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
      "targetdef test_good { deps = FILES; }\n" +
      "targetdef test_dir { }\n" +
      "test_dir d { }\n" +
      "test_good a { deps = d:**/*.expect -> **/*.out; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).getTarget("a");
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
      "targetdef test_good { deps = FILES; }\n" +
      "targetdef test_dir { }\n" +
      "test_dir d { }\n" +
      "test_good a { deps = d:sub:*.expect -> *.out; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).getTarget("a");
    expect(lastDeps && [...lastDeps].map(([name]) => name).sort()).to.deep.equal(["b.out"]);
  });

  it("Renames a single-segment projection, leaving subdirectories unselected", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_good { deps = FILES; }\n" +
      "targetdef test_dir { }\n" +
      "test_dir d { }\n" +
      "test_good a { deps = d:*.expect -> *.out; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).getTarget("a");
    /* `*` is segment-bounded, so only the root `a.expect` matches. */
    expect(lastDeps && [...lastDeps].map(([name]) => name).sort()).to.deep.equal(["a.out"]);
  });

  it("Resolves a REWRITE property to a first-match name mapping", async () => {
    lastRewrite = undefined;
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_rw { out = REWRITE; }\n" + "test_rw t { out = *.entry.js -> *.min.js; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).getTarget("t");
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

    await model.getConfig(Constraints.of({}), execution).getTarget("t");
    /* A bare constant maps every input to itself. */
    expect(lastRewrite).to.deep.equal(["bundle.js", "bundle.js", "bundle.js"]);
  });

  it("Resolves a MAP property to an ordered, substituted key -> string map", async () => {
    lastMap = undefined;
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_map { defines = MAP; }\n" +
      "NAME = production;\n" +
      "test_map t { defines = { process.env.NODE_ENV = ${NAME}; DEBUG = false; } }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).getTarget("t");
    expect(lastMap).to.deep.equal([
      ["process.env.NODE_ENV", "production"],
      ["DEBUG", "false"],
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

    await model.getConfig(Constraints.of({}), execution).getTarget("t");
    expect(lastMap).to.deep.equal([
      ["repository", new Map([["type", "git"], ["url", "example.com"]])],
      ["maintainers", [new Map([["name", "a"]]), new Map([["name", "b"]])]],
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

    await model.getConfig(Constraints.of({}), execution).getTarget("t");
    /* The splice lands at its written position; the later literal entry
     * overrides the spliced `description`. */
    expect(lastMap).to.deep.equal([
      ["before", "x"],
      ["license", "gpl3"],
      ["description", "specific"],
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
    await model.getConfig(Constraints.of({}), execution).getTarget("t");
    testMapObserver = undefined;

    /* license arrived via the SHARED splice: origin names the written entry in
     * the shared block plus one via-hop; the literal entry has no hops. */
    const licenseOrigin = map && mapEntryOrigin(map, "license");
    expect(licenseOrigin?.entry.name).to.equal("license");
    expect(licenseOrigin?.via).to.have.lengthOf(1);
    const ownOrigin = map && mapEntryOrigin(map, "description");
    expect(ownOrigin?.entry.name).to.equal("description");
    expect(ownOrigin?.via).to.deep.equal([]);
  });

  it("Fails a splice cycle", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_map { defines = MAP; }\n" +
      "A = { B; }\n" +
      "B = { A; }\n" +
      "test_map t { defines = A; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    let caught: Error | undefined;
    await model
      .getConfig(Constraints.of({}), execution)
      .getTarget("t")
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

    await model.getConfig(Constraints.of({}), execution).getTarget("t");
    /* The shared block's `${WHO}` resolves under the consuming build's config. */
    expect(lastMap).to.deep.equal([
      ["license", "gpl3"],
      ["owner", "nathan"],
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
      .getTarget("t")
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
      "targetdef test_map { defines = MAP; }\n" +
      "SHARED = { license = gpl3; };\n" +
      "test_map t { defines = ${SHARED}; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    let caught: Error | undefined;
    await model
      .getConfig(Constraints.of({}), execution)
      .getTarget("t")
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
      .getTarget("SHARED")
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

    await model.getConfig(Constraints.of({}), execution).getTarget("t");
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
      "targetdef test_good { deps = FILES; }\n" +
      "test_repo repo { }\n" +
      "x = repo:one;\n" +
      "test_good a { deps = x repo:two; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).getTarget("a");
    /* One joint batch, containing the reference reached through the property
     * expansion of 'x' as well as the direct one */
    expect(batchCalls).to.have.length(1);
    expect(batchCalls[0].slice().sort()).to.deep.equal(["one", "two"]);
    expect(lastDeps && [...lastDeps].map(([path]) => path).sort()).to.deep.equal(["one/data.txt", "two/data.txt"]);
  });

  it("Gathers external references through multiple levels of property indirection", async () => {
    batchCalls.length = 0;
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_repo { }\n" +
      "targetdef test_good { deps = FILES; }\n" +
      "test_repo repo { }\n" +
      "one = repo:one;\n" +
      "two = repo:two;\n" +
      "mydeps = one two;\n" +
      "test_good a { deps = mydeps; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).getTarget("a");
    expect(batchCalls).to.have.length(1);
    expect(batchCalls[0].slice().sort()).to.deep.equal(["one", "two"]);
    expect(lastDeps && [...lastDeps].map(([path]) => path).sort()).to.deep.equal(["one/data.txt", "two/data.txt"]);
  });

  it("Partitions references by repository for resolution", async () => {
    batchCalls.length = 0;
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_repo { }\n" +
      "targetdef test_good { deps = FILES; }\n" +
      "test_repo repoA { }\n" +
      "test_repo repoB { }\n" +
      "test_good a { deps = repoA:one repoB:two; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).getTarget("a");
    /* Each repository resolves its own references, as separate batches */
    expect(batchCalls.map(batch => batch.slice().sort()).sort()).to.deep.equal([["one"], ["two"]]);
    expect(lastDeps && [...lastDeps].map(([path]) => path).sort()).to.deep.equal(["one/data.txt", "two/data.txt"]);
  });

  it("Suspends projections into external references until resolution", async () => {
    batchCalls.length = 0;
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_repo { }\n" +
      "targetdef test_good { deps = FILES; }\n" +
      "test_repo repo { }\n" +
      "x = repo:one;\n" +
      "test_good a { deps = x:one/*.txt; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).getTarget("a");
    expect(batchCalls).to.deep.equal([["one"]]);
    /* The projection was applied to the resolved files */
    expect(lastDeps && [...lastDeps].map(([path]) => path)).to.deep.equal(["one/data.txt"]);
  });

  it("Keeps the written prefix for slash-form references into a target", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_good { deps = FILES; }\n" +
      "targetdef test_file { content = STRING; }\n" +
      "test_file c1 { content = one; }\n" +
      "test_good a { deps = c1/f.txt c1:f.txt; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).getTarget("a");
    /* Slash-form keeps the written name; colon-form strips the prefix */
    expect(lastDeps && [...lastDeps].map(([path]) => path).sort()).to.deep.equal(["c1/f.txt", "f.txt"]);
  });

  it("Keeps the written prefix for slash-form projections into external references", async () => {
    batchCalls.length = 0;
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_repo { }\n" +
      "targetdef test_good { deps = FILES; }\n" +
      "test_repo repo { }\n" +
      "x = repo:one;\n" +
      "test_good a { deps = x/one/*.txt; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).getTarget("a");
    expect(batchCalls).to.deep.equal([["one"]]);
    expect(lastDeps && [...lastDeps].map(([path]) => path)).to.deep.equal(["x/one/data.txt"]);
  });

  it("Get String Property", async () => {
    await expect(testGetProperty("a = b c; d = ${a};", "a")).to.eventually.deep.equal(["b", "c"]);
    await expect(testGetProperty("a = b c; d = ${a};", "d")).to.eventually.deep.equal(["b c"]);
    await expect(testGetProperty("a = b c; d = ${a} ${a};", "d")).to.eventually.deep.equal(["b c", "b c"]);
    await expect(testGetProperty("a = b c; d = a${a};", "d", { a: "QUUX" })).to.eventually.deep.equal(["aQUUX"]);
  });

  it("Collects an evaluation's requirements into one joint batch across properties and globals", async () => {
    batchCalls.length = 0;
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input =
      "targetdef test_repo { }\n" +
      "targetdef test_joint { adeps = FILES; bdeps = FILES; }\n" +
      "test_repo repo { }\n" +
      "JOINT_GLOBAL = repo:three;\n" +
      "test_joint a { adeps = repo:one; bdeps = repo:two; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).getTarget("a");
    /* One batch for the whole evaluation — not one per property/global */
    expect(batchCalls).to.have.length(1);
    expect(batchCalls[0].slice().sort()).to.deep.equal(["one", "three", "two"]);
    expect(lastDeps && [...lastDeps].map(([path]) => path).sort()).to.deep.equal([
      "one/data.txt",
      "three/data.txt",
      "two/data.txt",
    ]);
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
        runExecution.onProgress(event => events.push(event.kind));
        const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
        expect(errors).to.deep.equal([]);
        await model.getConfig(Constraints.of({}), runExecution).getTarget("a");
        return events;
      };

      /* Cold: the leaf evaluate runs once; the sub-target's miss announces its
       * declared target as building (once) */
      const first = await run();
      expect(leafRuns).to.equal(1);
      expect(first).to.deep.equal(["target-build"]);

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
          model.getConfig(Constraints.of({}), runExecution).getTarget("a").then(resolve, reject)
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
    const input =
      "targetdef test_orphan_composer { content = STRING; }\n" + "test_orphan_composer a { content = shape; }\n";
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
        .getTarget("a")
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
    expect(model.getConfig(Constraints.of({ x: "2" }), execution)).to.not.equal(model.getConfig(Constraints.of({ x: "1" }), execution));

    /* Configs are per execution context: a fresh run never shares evaluation
     * state with another */
    const other = new ExecutionContext(new BuildCache(".", testLog), testLog, EMPTY_FILESET, EMPTY_FILESET);
    expect(model.getConfig(Constraints.of({ x: "1" }), other)).to.not.equal(model.getConfig(Constraints.of({ x: "1" }), execution));
  });

  it("Applies a reference's <k=v> delta to the referenced target's build", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    /* `leaf` bakes ${FLAVOR} into its output; the dependant references it once
     * plainly and once with a FLAVOR override, so the override must reach leaf's
     * own evaluation (not the ambient config). */
    const input =
      "targetdef test_good { deps = FILES; }\n" +
      "targetdef test_file { content = STRING; }\n" +
      "default FLAVOR = plain;\n" +
      "test_file leaf { content = ${FLAVOR}; }\n" +
      "test_good plain_root { deps = leaf; }\n" +
      "test_good fancy_root { deps = leaf<FLAVOR=fancy>; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);
    const config = model.getConfig(Constraints.of({}), execution);
    const readLeaf = (): Computable<string | undefined> => lastDeps!.get("f.txt").then(file => file?.readString());

    await config.getTarget("plain_root");
    expect(await readLeaf()).to.equal("plain");

    await config.getTarget("fancy_root");
    expect(await readLeaf()).to.equal("fancy");
  });

  it("A caller's constraint override takes precedence over a reference's own delta", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    /* The rule resolves `dep` under an explicit {FLAVOR: caller} override while
     * the reference carries <FLAVOR=ref>; the caller's requirement must win
     * (e.g. a `run` rule forcing BUILD_OPERATION=run over a stray delta). */
    const input =
      "targetdef test_override { dep = FILES; }\n" +
      "targetdef test_file { content = STRING; }\n" +
      "default FLAVOR = ambient;\n" +
      "test_file leaf { content = ${FLAVOR}; }\n" +
      "test_override root { dep = leaf<FLAVOR=ref>; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).getTarget("root");
    expect(await lastDeps!.get("f.txt").then(file => file?.readString())).to.equal("caller");
  });

  it("A caller's override also wins over a delta on a GLOBAL's value", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    /* Same precedence rule, through getGlobalTarget: the rule forces
     * {FLAVOR: caller} while the global's written value carries <FLAVOR=ref>.
     * The override must ride as callerOverrides (applied after the delta),
     * not be demoted to the ambient set (which the delta would beat). */
    const input =
      "targetdef test_globaltool { }\n" +
      "targetdef test_file { content = STRING; }\n" +
      "default FLAVOR = ambient;\n" +
      "test_file leaf { content = ${FLAVOR}; }\n" +
      "GLOBALTOOL = leaf<FLAVOR=ref>;\n" +
      "test_globaltool root { }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig(Constraints.of({}), execution).getTarget("root");
    expect(await lastDeps!.get("f.txt").then(file => file?.readString())).to.equal("caller");
  });

  it("A caller's override wins over a delta on a STRING global's value too", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    /* The string path layers overrides identically to the file path: the rule
     * forces {FLAVOR: caller} while the global's value carries <FLAVOR=ref>, so
     * the override (threaded as callerOverrides, applied last) wins — rather than
     * being folded into ambient, which the delta would beat. */
    const input =
      "targetdef test_globalstr { }\n" +
      "default FLAVOR = ambient;\n" +
      "GLOBALSTR = ${FLAVOR}<FLAVOR=ref>;\n" +
      "test_globalstr root { }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    lastString = undefined;
    await model.getConfig(Constraints.of({}), execution).getTarget("root");
    expect(lastString).to.equal("caller");
  });

  it("getTargetRef substitutes ${vars} in the target name (build/test parity with cat/ls)", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    /* build/test resolve a whole target name via getTargetRef; a ${...} in that
     * name is substituted just as it is on the file/CLI path — previously it was
     * substituted only when the reference also carried a <k=v> delta. */
    const input =
      "targetdef test_file { content = STRING; }\n" +
      "default WHICH = leaf;\n" +
      "test_file leaf { content = hi; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    const sources = await model.getConfig(Constraints.of({}), execution).getTargetRef("${WHICH}");
    const files = FileSet.unionAll(...sources.filter((source): source is FileSet => source instanceof FileSet));
    expect(await files.get("f.txt").then(file => file?.readString())).to.equal("hi");
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
     * positioned NameResolutionError, anchored at the referencing value —
     * delivered via Computable rejection (as the file path always has), the
     * string path now resolving each value through the same context path. */
    const input = "FOO = x;\nBAR = ${FOOO};\n";
    const context = modelOf(input).getConfig(Constraints.of({}), execution);
    try {
      await context.getProperty("BAR");
      expect.fail("expected a rejection");
    } catch (e) {
      const err = e as NameResolutionError & { help?: string };
      expect(err.message).to.contain("Unknown property 'FOOO'");
      expect(err.help).to.contain("did you mean 'FOO'?");
      expect(err).to.be.instanceOf(NameResolutionError);
      expect(err.position.offset).to.be.greaterThan(0);
    }
  });

  it("names the kind when a property reference hits a target", () => {
    const input = "targetdef test_file { content = STRING; }\ntest_file thing { content = x; }\n";
    const context = modelOf(input).getConfig(Constraints.of({}), execution);
    expect(() => context.getProperty("thing")).to.throw(/'thing' names a target, not a property/);
  });

  it("suggests a near target name and points at list-targets for a CLI name", () => {
    const input = "targetdef test_file { content = STRING; }\ntest_file mytarget { content = x; }\n";
    const context = modelOf(input).getConfig(Constraints.of({}), execution);
    try {
      context.getTarget("mytargt");
      expect.fail("expected a throw");
    } catch (e) {
      const err = e as Error & { help?: string };
      expect(err.message).to.contain("Unknown name 'mytargt'");
      expect(err.help).to.contain("did you mean 'mytarget'?");
      expect(err.help).to.contain("fabr list-targets");
    }
  });

  it("reports a name nothing declares the same way for every verb", async () => {
    /* build/test resolve a whole name through getTarget; ls/cat/run resolve a
     * possibly-projected one through resolveName. One mistake, so one wording
     * and one suggestion — they used to differ ('Unresolved name' with a
     * suggestion versus 'Unknown target' without the property candidates). */
    const input = "targetdef test_file { content = STRING; }\ntest_file mytarget { content = x; }\n";
    const context = modelOf(input).getConfig(Constraints.of({}), execution);
    const failures: Array<Error & { help?: string }> = [];
    try {
      context.getTarget("mytargt");
      expect.fail("expected a throw");
    } catch (e) {
      failures.push(e as Error & { help?: string });
    }
    try {
      /* The projection is what routes this one down the resolveName path. */
      await context.resolveName(writtenOnCommandLine("mytargt:build/x.js"));
      expect.fail("expected a rejection");
    } catch (e) {
      failures.push(e as Error & { help?: string });
    }

    expect(failures.map(err => err.message)).to.deep.equal(["Unknown name 'mytargt'", "Unknown name 'mytargt:build/x.js'"]);
    for (const err of failures) {
      expect(err.help).to.contain("did you mean 'mytarget'?");
    }
  });

  it("hints that build/test take whole targets when the name carries a projection", () => {
    const input = "targetdef test_file { content = STRING; }\ntest_file mytarget { content = x; }\n";
    const context = modelOf(input).getConfig(Constraints.of({}), execution);
    try {
      context.getTarget("mytarget:build/x.js");
      expect.fail("expected a throw");
    } catch (e) {
      expect((e as { help?: string }).help).to.contain("whole target names");
    }
  });
});

/* The mechanism behind plugin-declared driver tools (JS.fabr's `js_script
 * @fabr-build/js/css-driver { entry = ../cssDriver/css-driver.js; }`): a decl
 * written in an absolutely-pathed contributed lib file resolves a relative
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
        "targetdef script { deps = FILES; entry = REQUIRED FILES; args = STRING; }\n" +
        "script @plug/drv { entry = ../tool/run.sh; deps = ../tool/*.js; }\n";
      const model = toBuildModel(
        [parseBuildString(new FSFileSource("/"), nodePath.join(tmp, "lib", "LIB.fabr"), input, logger)],
        logger,
        [{ rules: [scriptRunRule] }]
      );
      expect(errors).to.deep.equal([]);
      const sources = await model.getConfig(Constraints.of({ [BUILD_OPERATION]: "run" }), execution).getTarget("@plug/drv");
      const runnable = sources.find((source): source is RunnableFileSet => source instanceof RunnableFileSet);
      expect(runnable, "expected a RunnableFileSet").to.not.equal(undefined);
      const names = [...(runnable as RunnableFileSet)].map(([name]) => name).sort();
      expect(names).to.deep.equal(["tool/extra.js", "tool/helper.js", "tool/run.sh"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
