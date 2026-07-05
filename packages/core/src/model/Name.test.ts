import { NameBuilder } from "./Name";
import { expect } from "chai";

describe("Name", () => {
  it("Substitute", () => {
    let name = new NameBuilder().appendLiteralString("ab").appendSubstVar("CD").appendLiteralString("ef").name();
    expect(name.substitute(["CD"], ["actual value"]).toString()).to.equal("abactual valueef");
    expect(name.toString()).to.equal("ab${CD}ef");

    name = new NameBuilder().appendSubstVar("CD").name();
    expect(name.substitute(["CD"], ["actual value"]).toString()).to.equal("actual value");
    expect(name.toString()).to.equal("${CD}");
  });
});
