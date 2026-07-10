import { Name, NameBuilder } from "./Name";
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

  describe("constraints", () => {
    it("round-trips through toString in written order", () => {
      const name = Name.fromLiteral("mylib").withConstraints([
        ["BUILD_TYPE", Name.fromLiteral("release")],
        ["JS_TARGET", Name.fromLiteral("es6-esm")],
      ]);
      expect(name.toString()).to.equal("mylib<BUILD_TYPE=release, JS_TARGET=es6-esm>");
      expect(name.hasConstraints()).to.equal(true);
      expect(name.getConstraints().map(([k, v]) => [k, v.toString()])).to.deep.equal([
        ["BUILD_TYPE", "release"],
        ["JS_TARGET", "es6-esm"],
      ]);
    });

    it("keeps the constraint apart from the resolvable parts", () => {
      const parts = new NameBuilder().appendLiteralString("pkg:build/").appendGlobMetachars("*").appendLiteralString(".js").name();
      const name = parts.withConstraints([["BUILD_TYPE", Name.fromLiteral("release")]]);
      /* The projection glob rides in the parts; the delta rides alongside */
      expect(name.getConstraints()).to.have.length(1);
      expect(name.toString()).to.equal("pkg:build/*.js<BUILD_TYPE=release>");
    });

    it("collects variables from constraint values and substitutes them", () => {
      const value = new NameBuilder().appendSubstVar("DEFAULT_TYPE").name();
      const name = Name.fromLiteral("mylib").withConstraints([["BUILD_TYPE", value]]);
      expect(name.getVariables()).to.include("DEFAULT_TYPE");
      const resolved = name.substitute(["DEFAULT_TYPE"], ["release"]);
      expect(resolved.toString()).to.equal("mylib<BUILD_TYPE=release>");
      expect(resolved.getConstraints().map(([, v]) => v.toString())).to.deep.equal(["release"]);
    });

    it("has no constraints by default", () => {
      const name = Name.fromLiteral("mylib");
      expect(name.hasConstraints()).to.equal(false);
      expect(name.getConstraints()).to.deep.equal([]);
      expect(name.toString()).to.equal("mylib");
    });
  });
});
