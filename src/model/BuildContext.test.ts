import { Computable } from "../core/Computable";
import { EMPTY_FILESET, FileSet } from "../core/FileSet";
import { MemoryFile } from "../core/MemoryFS";
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
registerTargetRule("test_good", {}, context => context.getFileSet("deps").then(() => EMPTY_FILESET));
registerTargetRule("test_fail", {}, () => Computable.reject(new Error("reasons")));
registerTargetRule("test_file", {}, context =>
  context.getRequiredString("content").then(content => new FileSet(new Map([["f.txt", MemoryFile.from(content)]])))
);

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

  it("Get String Property", async () => {
    await expect(testGetProperty("a = b c; d = ${a};", "a")).to.eventually.deep.equal(["b", "c"]);
    await expect(testGetProperty("a = b c; d = ${a};", "d")).to.eventually.deep.equal(["b c"]);
    await expect(testGetProperty("a = b c; d = ${a} ${a};", "d")).to.eventually.deep.equal(["b c", "b c"]);
    await expect(testGetProperty("a = b c; d = a${a};", "d", { a: new Property(["QUUX"]) })).to.eventually.deep.equal(["aQUUX"]);
  });
});
