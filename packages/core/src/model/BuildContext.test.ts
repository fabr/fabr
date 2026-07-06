import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { Computable } from "../core/Computable";
import { EMPTY_FILESET, FileSet } from "../core/FileSet";
import { MemoryFile } from "../core/MemoryFS";
import { Repository, RepositoryRef, SourceRef } from "../core/Repository";
import { FileConflictError, renderProvenance } from "../core/Provenance";
import { LogFormatter, LogLevel } from "../support/Log";
import { registerRepositoryProvider, registerRule } from "../rules/Registry";
import { BuildAction, IBuildActionDefinition } from "../rules/Types";
import { Constraints, DependencyFailedError } from "./BuildContext";
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

/* Trivial rules for exercising target-to-target dependency behaviour */
let lastDeps: FileSet | undefined;
registerRule("test_good", {}, context =>
  context.getFileSet("deps").then(files => {
    lastDeps = files;
    return EMPTY_FILESET;
  })
);
registerRule("test_fail", {}, () => Computable.reject(new Error("reasons")));
registerRule("test_file", {}, context =>
  context.getRequiredString("content").then(content => new FileSet(new Map([["f.txt", MemoryFile.from(content)]])))
);

/* Repository double: resolves each reference to a single file, and records
 * the batches it was asked to resolve */
const batchCalls: string[][] = [];
class TestRepo implements Repository {
  private readonly cache = new Map<string, FileSet>();

  public resolveAll(references: RepositoryRef[]): Computable<FileSet[]> {
    batchCalls.push(references.map(reference => reference.name.toString()));
    return Computable.resolve(references.map(reference => this.filesFor(reference.name.toString())));
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

async function testGetProperty(input: string, prop: string, constraints?: Constraints): Promise<string[]> {
  const errors: string[] = [];
  const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
  const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger);
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
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger);
    expect(errors).to.deep.equal([]);

    try {
      await model.getConfig({}, execution).getTarget("a");
      expect.fail("expected target a to fail");
    } catch (err) {
      expect(err).to.be.instanceOf(DependencyFailedError);
      const outer = err as DependencyFailedError;
      expect(outer.target.name).to.equal("a");
      expect(outer.cause).to.be.instanceOf(DependencyFailedError);
      const inner = outer.cause as DependencyFailedError;
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
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger);
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

      /* Each side carries a provenance chain: the model reference (position
       * header, source excerpt, caret, active constraints) chained onto the
       * producing target's step */
      const rendered = renderProvenance(conflict.left.provenance, { path: "f.txt" });
      expect(rendered.some(line => /^TEST.fabr:5:\d+: from 'c1':$/.test(line))).to.equal(true);
      expect(rendered).to.include("test_good a { deps = c1 c2; }");
      expect(rendered.some(line => /^ *\^$/.test(line))).to.equal(true);
      expect(rendered).to.include("with arch=armv7");
      expect(rendered.some(line => /^TEST.fabr:3:\d+: built by test_file 'c1'$/.test(line))).to.equal(true);
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
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger);
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
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger);
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
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger);
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
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger);
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
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger);
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
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger);
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
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger);
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
        const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger);
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
        const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], logger);
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
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", "a = b;", logger)], logger);
    expect(errors).to.deep.equal([]);

    expect(model.getConfig({ x: "1" }, execution)).to.equal(model.getConfig({ x: "1" }, execution));
    expect(model.getConfig({ x: "2" }, execution)).to.not.equal(model.getConfig({ x: "1" }, execution));

    /* Configs are per execution context: a fresh run never shares evaluation
     * state with another */
    const other = new ExecutionContext(new BuildCache("."));
    expect(model.getConfig({ x: "1" }, other)).to.not.equal(model.getConfig({ x: "1" }, execution));
  });
});
