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

  it("keeps adjacent substitution variables distinct", () => {
    /* `${A}${B}` must not merge into a single variable `AB`. */
    const name = new NameBuilder().appendSubstVar("A").appendSubstVar("B").name();
    expect(name.getVariables()).to.deep.equal(["A", "B"]);
    expect(name.toString()).to.equal("${A}${B}");
    expect(name.substitute(["A", "B"], ["x", "y"]).toString()).to.equal("xy");
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

  describe("rename template", () => {
    const selector = (): Name =>
      new NameBuilder().appendGlobMetachars("*").appendLiteralString(".expect").name();
    const template = (): Name =>
      new NameBuilder().appendGlobMetachars("*").appendLiteralString(".out").name();

    it("round-trips through toString with a spaced arrow", () => {
      const name = selector().withRenameTo(template());
      expect(name.toString()).to.equal("*.expect -> *.out");
      expect(name.getRenameTo()?.toString()).to.equal("*.out");
    });

    it("renders after the constraint delta", () => {
      const name = selector()
        .withConstraints([["BUILD_TYPE", Name.fromLiteral("release")]])
        .withRenameTo(template());
      expect(name.toString()).to.equal("*.expect<BUILD_TYPE=release> -> *.out");
    });

    it("reports the glob units of each side", () => {
      const recursive = new NameBuilder()
        .appendGlobMetachars("**")
        .appendLiteralString("/")
        .appendGlobMetachars("*")
        .appendLiteralString(".in")
        .name();
      expect(recursive.getGlobUnits()).to.deep.equal(["**", "*"]);
    });

    it("collects template variables and substitutes them", () => {
      const stamped = new NameBuilder()
        .appendGlobMetachars("*")
        .appendLiteralString(".")
        .appendSubstVar("BUILD_NO")
        .appendLiteralString(".js")
        .name();
      const name = selector().withRenameTo(stamped);
      expect(name.getVariables()).to.include("BUILD_NO");
      const resolved = name.substitute(["BUILD_NO"], ["42"]);
      expect(resolved.toString()).to.equal("*.expect -> *.42.js");
    });

    it("compiles a renamer that renames matches and drops non-matches", () => {
      const rename = selector().withRenameTo(template()).makeRenamer(template());
      expect(rename("foo.expect")).to.equal("foo.out");
      expect(rename("foo.other")).to.equal(undefined);
    });

    it("keeps the rename and constraint facets when re-rooted relative to a file", () => {
      /* A file-relative reference (`./DOCGEN.fabr -> PROJECT.fabr`) is re-rooted
       * against its including file via relativeTo → withPrefix; the facets must
       * survive so the rename (and any delta) still applies at the new path. */
      const name = new NameBuilder()
        .appendLiteralString("DOCGEN.fabr")
        .name()
        .withConstraints([["BUILD_TYPE", Name.fromLiteral("release")]])
        .withRenameTo(new NameBuilder().appendLiteralString("PROJECT.fabr").name());
      const rerooted = name.relativeTo("docs/BUILD.fabr");
      expect(rerooted.getRenameTo()?.toString()).to.equal("PROJECT.fabr");
      expect(rerooted.getConstraints().map(([k, v]) => [k, v.toString()])).to.deep.equal([["BUILD_TYPE", "release"]]);
    });

    it("preserves directory structure under a recursive rename", () => {
      const recSel = new NameBuilder()
        .appendGlobMetachars("**")
        .appendLiteralString("/")
        .appendGlobMetachars("*")
        .appendLiteralString(".in")
        .name();
      const recTmpl = new NameBuilder()
        .appendGlobMetachars("**")
        .appendLiteralString("/")
        .appendGlobMetachars("*")
        .appendLiteralString(".out")
        .name();
      const rename = recSel.makeRenamer(recTmpl);
      expect(rename("src/a/foo.in")).to.equal("src/a/foo.out");
      expect(rename("foo.in")).to.equal("foo.out");
    });

    it("trims slashes from an empty trailing globstar", () => {
      const sel = new NameBuilder().appendLiteralString("src/").appendGlobMetachars("**").name();
      const tmpl = new NameBuilder().appendLiteralString("out/").appendGlobMetachars("**").name();
      const rename = sel.makeRenamer(tmpl);
      expect(rename("src")).to.equal("out"); // empty globstar -> "out/" -> "out"
      expect(rename("src/a/b")).to.equal("out/a/b");
    });

    it("collapses a doubled slash from an empty middle globstar", () => {
      const sel = new NameBuilder().appendLiteralString("a/").appendGlobMetachars("**").appendLiteralString("/b").name();
      const tmpl = new NameBuilder().appendLiteralString("x/").appendGlobMetachars("**").appendLiteralString("/y").name();
      const rename = sel.makeRenamer(tmpl);
      expect(rename("a/b")).to.equal("x/y"); // empty globstar -> "x//y" -> "x/y"
      expect(rename("a/m/n/b")).to.equal("x/m/n/y");
    });

    it("renders toReplacement as a $n string, escaping literal $", () => {
      const tmpl = new NameBuilder()
        .appendGlobMetachars("*")
        .appendLiteralString(".$v.out")
        .appendGlobMetachars("*")
        .name();
      /* `$v` in a substituted literal must not read as a group reference. */
      expect(tmpl.toReplacement()).to.equal("$1.$$v.out$2");
    });

    it("has no rename target by default", () => {
      const name = Name.fromLiteral("mylib");
      expect(name.getRenameTo()).to.equal(undefined);
    });
  });

  describe("makeProjector", () => {
    it("glob-selects and rewrites the match under the prefix", () => {
      const glob = new NameBuilder().appendGlobMetachars("*").appendLiteralString(".ts").name();
      const project = glob.makeProjector("out/");
      expect(project("mod.ts")).to.equal("out/mod.ts");
      expect(project("mod.js")).to.equal(undefined);
    });

    it("defaults to an empty prefix (identity name)", () => {
      const glob = new NameBuilder().appendGlobMetachars("**").name();
      expect(glob.makeProjector()("a/b.ts")).to.equal("a/b.ts");
    });

    it("applies the rename when the name carries a target (prefix ignored)", () => {
      const rename = new NameBuilder()
        .appendGlobMetachars("*")
        .appendLiteralString(".expect")
        .name()
        .withRenameTo(new NameBuilder().appendGlobMetachars("*").appendLiteralString(".out").name());
      const project = rename.makeProjector("ignored/");
      expect(project("foo.expect")).to.equal("foo.out");
      expect(project("foo.txt")).to.equal(undefined);
    });

    it("matches on colon->slash and strips the alias segment (colon form)", () => {
      const name = new NameBuilder()
        .appendLiteralString("src:")
        .appendGlobMetachars("**")
        .appendLiteralString("/")
        .appendGlobMetachars("*")
        .appendLiteralString(".ts")
        .name();
      const project = name.makeProjector();
      expect(project("src/a/b.ts")).to.equal("a/b.ts");
      expect(project("src/x.ts")).to.equal("x.ts");
      expect(project("other/x.ts")).to.equal(undefined);
    });

    it("retains the full path for a slash-form name", () => {
      const name = new NameBuilder()
        .appendLiteralString("src/bar/")
        .appendGlobMetachars("*")
        .appendLiteralString(".ts")
        .name();
      expect(name.makeProjector()("src/bar/x.ts")).to.equal("src/bar/x.ts");
    });

    it("prepends the prefix onto a colon-stripped name (colon x prefix)", () => {
      const name = new NameBuilder()
        .appendLiteralString("src:")
        .appendGlobMetachars("**")
        .appendLiteralString("/")
        .appendGlobMetachars("*")
        .appendLiteralString(".ts")
        .name();
      const project = name.makeProjector("out/");
      expect(project("src/a/b.ts")).to.equal("out/a/b.ts");
      expect(project("other/a.ts")).to.equal(undefined);
    });

    /* A colon can reach the selector via a multi-colon reference (`d:sub:*.x` —
     * getPrefixMatch stops at target `d`, leaving `sub:*.x` as the projection).
     * Both branches must then treat `:` as the path separator + strip boundary
     * consistently — the reason makeRenamer colon-converts too. */
    const reachedColon = (): Name =>
      new NameBuilder().appendLiteralString("sub:").appendGlobMetachars("*").appendLiteralString(".expect").name();

    it("strips a reached colon for a plain projection", () => {
      const project = reachedColon().makeProjector();
      expect(project("sub/b.expect")).to.equal("b.expect");
      expect(project("other/b.expect")).to.equal(undefined);
    });

    it("strips a reached colon under a rename too (matches the slash path)", () => {
      const rename = reachedColon().withRenameTo(
        new NameBuilder().appendGlobMetachars("*").appendLiteralString(".out").name()
      );
      const project = rename.makeProjector();
      expect(project("sub/b.expect")).to.equal("b.out");
      expect(project("other/b.expect")).to.equal(undefined);
    });

    it("converts every colon and strips up to the last (multi-colon)", () => {
      /* `a:b:*.ts` — all colons are path separators; the alias `a:b` is stripped
       * wholesale (up to the last colon). */
      const name = new NameBuilder()
        .appendLiteralString("a:b:")
        .appendGlobMetachars("*")
        .appendLiteralString(".ts")
        .name();
      const project = name.makeProjector();
      expect(project("a/b/x.ts")).to.equal("x.ts");
      expect(project("a/b/x.js")).to.equal(undefined);
      /* and the same under a rename */
      const renamed = name.withRenameTo(
        new NameBuilder().appendGlobMetachars("*").appendLiteralString(".js").name()
      );
      expect(renamed.makeProjector()("a/b/x.ts")).to.equal("x.js");
    });
  });

  describe("appendGlobstar", () => {
    it("appends /** to a slash-form directory (retained)", () => {
      const dir = Name.fromLiteral("src");
      expect(dir.appendGlobstar().toString()).to.equal("src/**");
      const project = dir.appendGlobstar().makeProjector();
      expect(project("src/a/b.ts")).to.equal("src/a/b.ts");
    });

    it("appends ** after a colon boundary (stripped)", () => {
      const dir = Name.fromLiteral("src:");
      expect(dir.appendGlobstar().toString()).to.equal("src:**");
      const project = dir.appendGlobstar().makeProjector();
      expect(project("src/a/b.ts")).to.equal("a/b.ts");
    });
  });
});
