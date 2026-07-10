import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { Computable } from "../core/Computable";
import { EMPTY_FILESET, FileSet } from "../core/FileSet";
import { MemoryFile } from "../core/MemoryFS";
import { Repository, RepositoryRef, SourceRef } from "../core/Repository";
import { Name } from "./Name";
import { renderProvenance } from "../core/Provenance";
import { FileConflictError } from "../core/Errors";
import { LogFormatter, LogLevel } from "../support/Log";
import {
  BuildAction,
  IBuildActionDefinition,
  PluginContribution,
  RepositoryProvider,
  RepositoryRegistration,
  RuleRegistration,
} from "../rules/Types";
import { Constraints } from "./BuildContext";
import { DependencyFailedError, NameResolutionError, NoRuleFoundError, ReferenceFailedError } from "./Errors";
import { ExecutionContext } from "./ExecutionContext";
import { parseBuildString } from "./Parser";
import { toBuildModel } from "./Sema";
import * as chai from "chai";
import { expect } from "chai";
import * as chaiAsPromised from "chai-as-promised";
import { BuildCache } from "../core/BuildCache";

chai.use(chaiAsPromised);

/* The runtime surroundings for evaluation: none of these tests reach the
 * cache, so a single throwaway instance serves them all */
const execution = new ExecutionContext(new BuildCache("."));

/* These tests exercise the evaluation engine with throwaway rules. Rules now
 * ride the model's registry (not a global), so collect them into a contribution
 * and build a per-test registry passed to toBuildModel. `registerRule` /
 * `registerRepositoryProvider` are kept as local shims so the registrations
 * below read unchanged. */
const testRules: RuleRegistration[] = [];
const testRepos: RepositoryRegistration[] = [];
function registerRule(type: string, constraints: Constraints, evaluate: RuleRegistration["evaluate"]): void {
  testRules.push({ type, constraints, evaluate });
}
function registerRepositoryProvider(type: string, provider: RepositoryProvider): void {
  testRepos.push({ type, provider });
}

/* Trivial rules for exercising target-to-target dependency behaviour */
let lastDeps: FileSet | undefined;
registerRule("test_good", {}, context =>
  context.getFileSet("deps").then(files => {
    lastDeps = files;
    return EMPTY_FILESET;
  })
);
registerRule("test_fail", {}, () => Computable.reject(new Error("reasons")));
/* Resolves its dep under a caller-supplied constraint override, for testing
 * override precedence against a reference's own <k=v> delta. */
registerRule("test_override", {}, context =>
  context.getFileSet("dep", { FLAVOR: "caller" }).then(files => {
    lastDeps = files;
    return EMPTY_FILESET;
  })
);
registerRule("test_file", {}, context =>
  context.getRequiredString("content").then(content => new FileSet(new Map([["f.txt", MemoryFile.from(content)]])))
);
/* Registered only under a specific constraint, so selection under {} fails */
registerRule("test_constrained", { FLAVOR: "special" }, () => Computable.resolve(EMPTY_FILESET));

/* Repository double: resolves each reference to a single file, and records
 * the batches it was asked to resolve */
const batchCalls: string[][] = [];
class TestRepo implements Repository {
  private readonly cache = new Map<string, FileSet>();

  public resolveAll(references: RepositoryRef[]): Computable<FileSet[]> {
    batchCalls.push(references.map(reference => reference.name.toString()));
    return Computable.resolve(references.map(reference => this.filesFor(reference.name.toString())));
  }

  /* No sub-package grammar: the whole name is the requirement, nothing projects. */
  public splitReference(name: Name): { requirement: Name } {
    return { requirement: name };
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

/* A rule gathering two properties and a global through ONE collection point:
 * all of their references must land in a single joint resolution batch */
registerRule("test_joint", {}, context =>
  context
    .collect({
      adeps: context.getFileSources("adeps"),
      bdeps: context.getFileSources("bdeps"),
      globalSrc: context.getGlobalSources("JOINT_GLOBAL"),
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

const testContributions: PluginContribution[] = [{ rules: testRules, repositories: testRepos }];

async function testGetProperty(input: string, prop: string, constraints?: Constraints): Promise<string[]> {
  const errors: string[] = [];
  const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
  const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
  if (errors.length !== 0) {
    throw new Error("Parse error:\n" + errors.join("\n"));
  }

  const context = model.getConfig(constraints ?? {}, execution);
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
      await model.getConfig({}, execution).getTarget("a");
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
      await model.getConfig({ arch: "armv7" }, execution).getTarget("a");
      expect.fail("expected target a to fail");
    } catch (err) {
      expect(err).to.be.instanceOf(DependencyFailedError);
      const cause = (err as DependencyFailedError).cause;
      expect(cause.message).to.equal("Conflicting files for f.txt (from 'c1' and 'c2')");
      expect(cause).to.be.instanceOf(FileConflictError);
      const conflict = cause as FileConflictError;
      expect(conflict.path).to.equal("f.txt");
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
      await model.getConfig({}, execution).getTarget("a");
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
      expect(noRule.constraints).to.deep.equal({});
    }
  });

  it("Fails a literal name that names no target and matches no file", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input = "targetdef test_good { deps = FILES; }\n" + "test_good a { deps = fooff; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    try {
      await model.getConfig({}, execution).getTarget("a");
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

  it("Leaves a glob matching nothing as an empty resolution", async () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const input = "targetdef test_good { deps = FILES; }\n" + "test_good a { deps = fooff*; }\n";
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    await model.getConfig({}, execution).getTarget("a");
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
      await model.getConfig({}, execution).getTarget("a");
      expect.fail("expected target a to fail");
    } catch (err) {
      expect(err).to.be.instanceOf(DependencyFailedError);
      const cause = (err as DependencyFailedError).cause;
      expect(cause).to.be.instanceOf(NameResolutionError);
      expect(cause.message).to.equal("Unable to resolve 'b:missing.txt'");
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

    await model.getConfig({}, execution).getTarget("a");
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

    await model.getConfig({}, execution).getTarget("a");
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

    await model.getConfig({}, execution).getTarget("a");
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

    await model.getConfig({}, execution).getTarget("a");
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

    await model.getConfig({}, execution).getTarget("a");
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

    await model.getConfig({}, execution).getTarget("a");
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

    await model.getConfig({}, execution).getTarget("a");
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
        const runExecution = new ExecutionContext(new BuildCache(root));
        runExecution.onProgress(event => events.push(event.kind));
        const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
        expect(errors).to.deep.equal([]);
        await model.getConfig({}, runExecution).getTarget("a");
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
    const input = "targetdef test_composer { content = STRING; }\ntest_composer a { content = shape; }\n";
    leafRuns = 0;
    wrapRuns = 0;
    try {
      const run = async (): Promise<FileSet> => {
        const errors: string[] = [];
        const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
        const runExecution = new ExecutionContext(new BuildCache(root));
        const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger, testContributions);
        expect(errors).to.deep.equal([]);
        const sources = await new Promise<SourceRef[]>((resolve, reject) =>
          model.getConfig({}, runExecution).getTarget("a").then(resolve, reject)
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

  it("Interns configurations by constraint value", () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", "a = b;", logger)], logger, testContributions);
    expect(errors).to.deep.equal([]);

    expect(model.getConfig({ x: "1" }, execution)).to.equal(model.getConfig({ x: "1" }, execution));
    expect(model.getConfig({ x: "2" }, execution)).to.not.equal(model.getConfig({ x: "1" }, execution));

    /* Configs are per execution context: a fresh run never shares evaluation
     * state with another */
    const other = new ExecutionContext(new BuildCache("."));
    expect(model.getConfig({ x: "1" }, other)).to.not.equal(model.getConfig({ x: "1" }, execution));
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
    const config = model.getConfig({}, execution);
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

    await model.getConfig({}, execution).getTarget("root");
    expect(await lastDeps!.get("f.txt").then(file => file?.readString())).to.equal("caller");
  });
});
