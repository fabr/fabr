import { EMPTY_FILESET } from "../core/FileSet";
import { LogFormatter, LogLevel } from "../support/Log";
import { Constraints } from "./BuildContext";
import { parseBuildString } from "./Parser";
import { toBuildModel } from "./Sema";
import { expect } from "chai";
import * as chai from "chai";
import * as chaiPromise from "chai-as-promised";
import { Property } from "./Property";
import { BuildCache } from "../core/BuildCache";

chai.use(chaiPromise);

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
  it("Get String Property", async () => {
    await expect(testGetProperty("a = b c; d = ${a};", "a")).to.eventually.deep.equal(["b", "c"]);
    await expect(testGetProperty("a = b c; d = ${a};", "d")).to.eventually.deep.equal(["b c"]);
    await expect(testGetProperty("a = b c; d = ${a} ${a};", "d")).to.eventually.deep.equal(["b c", "b c"]);
    await expect(testGetProperty("a = b c; d = a${a};", "d", { a: new Property(["QUUX"]) })).to.eventually.deep.equal(["aQUUX"]);
  });
});
