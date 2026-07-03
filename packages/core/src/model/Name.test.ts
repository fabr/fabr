import { NameBuilder } from "./Name";

describe("Name", () => {
  it("Substitute", () => {
    let name = new NameBuilder().appendLiteralString("ab").appendSubstVar("CD").appendLiteralString("ef").name();
    expect(name.substitute(["CD"], ["actual value"]).toString()).toBe("abactual valueef");
    expect(name.toString()).toBe("ab${CD}ef");

    name = new NameBuilder().appendSubstVar("CD").name();
    expect(name.substitute(["CD"], ["actual value"]).toString()).toBe("actual value");
    expect(name.toString()).toBe("${CD}");
  });
});
