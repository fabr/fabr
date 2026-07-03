import { Computable } from "../core/Computable";
import { EMPTY_FILESET, FileSet } from "../core/FileSet";
import { MemoryFile } from "../core/MemoryFS";
import { Repository, RepositoryRef } from "../core/Repository";
import { FileConflictError, renderProvenance } from "../core/Provenance";
import { LogFormatter, LogLevel } from "../support/Log";
import { registerTargetRule } from "../rules/Registry";
import { Constraints, DependencyFailedError } from "./BuildContext";
import { parseBuildString } from "./Parser";
import { toBuildModel } from "./Sema";
import { expect } from "chai";
import * as chai from "chai";
import * as chaiPromise from "chai-as-promised";
import { Property } from "./Property";
import { BuildCache } from "../core/BuildCache";

chai.use(chaiPromise);

/* Trivial rules for exercising target-to-target dependency behaviour */
let lastDeps: FileSet | undefined;
registerTargetRule("test_good", {}, context =>
  context.getFileSet("deps").then(files => {
    lastDeps = files;
    return EMPTY_FILESET;
  })
);
registerTargetRule("test_fail", {}, () => Computable.reject(new Error("reasons")));
registerTargetRule("test_file", {}, context =>
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
registerTargetRule("test_repo", {}, () => Computable.resolve(new TestRepo()));

async function testGetProperty(input: string, prop: string, constraints?: Constraints): Promise<string[]> {
  const errors: string[] = [];
  const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
  const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], new BuildCache("."), logger);
  if (errors.length !== 0) {
    throw new Error("Parse error:\n" + errors.join("\n"));
  }

  const context = model.getConfig(constraints);
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
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], new BuildCache("."), logger);
    expect(errors).to.deep.equal([]);

    try {
      await model.getConfig({}).getTarget("a");
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
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], new BuildCache("."), logger);
    expect(errors).to.deep.equal([]);

    try {
      await model.getConfig({ arch: new Property(["armv7"]) }).getTarget("a");
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
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], new BuildCache("."), logger);
    expect(errors).to.deep.equal([]);

    await model.getConfig({}).getTarget("a");
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
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], new BuildCache("."), logger);
    expect(errors).to.deep.equal([]);

    await model.getConfig({}).getTarget("a");
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
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], new BuildCache("."), logger);
    expect(errors).to.deep.equal([]);

    await model.getConfig({}).getTarget("a");
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
    const model = toBuildModel([parseBuildString(EMPTY_FILESET, "TEST.fabr", input, logger)], new BuildCache("."), logger);
    expect(errors).to.deep.equal([]);

    await model.getConfig({}).getTarget("a");
    expect(batchCalls).to.deep.equal([["one"]]);
    /* The projection was applied to the resolved files */
    expect(lastDeps && [...lastDeps].map(([path]) => path)).to.deep.equal(["one/data.txt"]);
  });

  it("Get String Property", async () => {
    await expect(testGetProperty("a = b c; d = ${a};", "a")).to.eventually.deep.equal(["b", "c"]);
    await expect(testGetProperty("a = b c; d = ${a};", "d")).to.eventually.deep.equal(["b c"]);
    await expect(testGetProperty("a = b c; d = ${a} ${a};", "d")).to.eventually.deep.equal(["b c", "b c"]);
    await expect(testGetProperty("a = b c; d = a${a};", "d", { a: new Property(["QUUX"]) })).to.eventually.deep.equal(["aQUUX"]);
  });
});
