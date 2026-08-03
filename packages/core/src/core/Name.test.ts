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

    it("excludes the alias path itself from a rename (x:** names only what is under x)", () => {
      /* `a/**` admits `a`, so without the guard a rename projection into an
       * archive would emit the archive file itself under the template's
       * collapsed (empty-capture) name. */
      const rename = new NameBuilder()
        .appendLiteralString("x.tgz:")
        .appendGlobMetachars("**")
        .name()
        .withRenameTo(new NameBuilder().appendLiteralString("out/").appendGlobMetachars("**").name());
      const project = rename.makeProjector();
      expect(project("x.tgz")).to.equal(undefined);
      expect(project("x.tgz/lib/a.js")).to.equal("out/lib/a.js");
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

  /* Matching and naming happen in canonical path space: walked / FileSet names
   * arrive normalized, so a selector's literal head is normalized before
   * compiling, and the alias is a naming ROOT (results are named relative to
   * it — prefix-strip being the non-climbing degenerate case). This is what
   * lets a file-relative reference climb (`lib:../tools/*.js` from a build
   * file re-rooted at `lib`) and still match + name coherently. */
  describe("makeProjector in canonical path space", () => {
    it("matches a climbing selector against normalized inputs and names relative to the alias", () => {
      /* `../tools/*.js` written in a file whose dir alias is `lib` — the walk
       * delivers normalized names (`tools/y.js`); the result is named by its
       * path relative to the alias (`../tools/y.js` — FileSet canonicalization
       * later flattens the climb to `tools/y.js`). */
      const name = new NameBuilder()
        .appendLiteralString("lib:../tools/")
        .appendGlobMetachars("*")
        .appendLiteralString(".js")
        .name();
      const project = name.makeProjector();
      expect(project("tools/y.js")).to.equal("../tools/y.js");
      expect(project("lib/y.js")).to.equal(undefined);
    });

    it("normalizes an interior climb in a slash-form glob head", () => {
      const name = new NameBuilder()
        .appendLiteralString("docs/../scripts/")
        .appendGlobMetachars("*")
        .appendLiteralString(".ts")
        .name();
      /* Slash form retains the written path as the name — but matching must be
       * on the normalized head or the query silently matches nothing. */
      expect(name.makeProjector()("scripts/gendoc.ts")).to.equal("scripts/gendoc.ts");
    });

    it("matches a climbing rename selector against normalized inputs", () => {
      const rename = new NameBuilder()
        .appendLiteralString("lib:../golden/")
        .appendGlobMetachars("*")
        .appendLiteralString(".expect")
        .name()
        .withRenameTo(new NameBuilder().appendGlobMetachars("*").appendLiteralString(".out").name());
      expect(rename.makeProjector()("golden/b.expect")).to.equal("b.out");
    });

    it("does not normalize a climb through a glob (cannot be resolved lexically)", () => {
      /* a glob segment followed by `..` (a/&ast;/../b.txt) — what the `..`
       * climbs out of is unknown until match time, so lexical normalization
       * must leave it alone (it then never matches a canonical input, the
       * honest outcome). */
      const name = new NameBuilder()
        .appendLiteralString("a/")
        .appendGlobMetachars("*")
        .appendLiteralString("/../b.txt")
        .name();
      expect(name.makeProjector()("a/b.txt")).to.equal(undefined);
    });
  });

  describe("rebase", () => {
    it("sheds the root prefix from an absolute head, keeping facets", () => {
      const name = new NameBuilder()
        .appendLiteralString("/tmp/proj/lib:../tool/")
        .appendGlobMetachars("*")
        .appendLiteralString(".js")
        .name()
        .withConstraints([["BUILD_TYPE", Name.fromLiteral("release")]]);
      const rebased = name.rebase("/");
      expect(rebased.toString()).to.equal("tmp/proj/lib:../tool/*.js<BUILD_TYPE=release>");
      expect(rebased.getConstraints().map(([k, v]) => [k, v.toString()])).to.deep.equal([["BUILD_TYPE", "release"]]);
    });

    it("leaves a relative name and an out-of-root absolute name unchanged", () => {
      const relative = new NameBuilder().appendLiteralString("src/x.ts").name();
      expect(relative.rebase("/some/root")).to.equal(relative);
      const outside = new NameBuilder().appendLiteralString("/elsewhere/x.ts").name();
      expect(outside.rebase("/some/root")).to.equal(outside);
    });

    it("rebases against a non-slash root", () => {
      const name = new NameBuilder().appendLiteralString("/home/me/proj/docs/x.ts").name();
      expect(name.rebase("/home/me/proj").toString()).to.equal("docs/x.ts");
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

  describe("components", () => {
    const componentsOf = (name: Name): string[] => name.components().map(component => component.toString());

    it("splits at slash and colon separators alike", () => {
      expect(componentsOf(Name.fromLiteral("dir:x.tgz/foo"))).to.deep.equal(["dir", "x.tgz", "foo"]);
      expect(componentsOf(Name.fromLiteral("a.tgz"))).to.deep.equal(["a.tgz"]);
    });

    it("preserves glob and substitution parts within their components", () => {
      const name = new NameBuilder()
        .appendLiteralString("a.tgz:")
        .appendGlobMetachars("*")
        .appendLiteralString(":")
        .appendGlobMetachars("**")
        .name();
      expect(componentsOf(name)).to.deep.equal(["a.tgz", "*", "**"]);
      const subst = new NameBuilder().appendSubstVar("A").appendLiteralString("/x").name();
      const [head, tail] = subst.components();
      expect(head.hasVarSubst()).to.equal(true);
      expect(tail.toString()).to.equal("x");
    });

    it("carries no facets onto the components", () => {
      const name = Name.fromLiteral("x.tgz/foo")
        .withConstraints([["K", Name.fromLiteral("v")]])
        .withRenameTo(Name.fromLiteral("bar"));
      const [component] = name.components();
      expect(component.hasConstraints()).to.equal(false);
      expect(component.getRenameTo()).to.equal(undefined);
    });

    it("componentPrefixes are the cumulative slash-joined leading paths", () => {
      expect(
        Name.fromLiteral("dir:x.tgz/foo")
          .componentPrefixes()
          .map(prefix => prefix.toString())
      ).to.deep.equal(["dir", "dir/x.tgz", "dir/x.tgz/foo"]);
    });
  });

});
