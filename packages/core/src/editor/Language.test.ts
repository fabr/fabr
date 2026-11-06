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

import { expect } from "chai";
import { EMPTY_FILESET } from "../core/FileSet";
import { LogFormatter, LogLevel } from "../support/Log";
import { completionsAt, type IDocumentation, namedAt, symbolsOf, writtenAt } from "./Language";
import { toBuildModel } from "../model/ModelBuilder";
import { parseBuildString } from "../model/Parser";

const TEXT = [
  "# The packages a test reads.",
  "LIBS = lib;",
  "# A thing that holds files.",
  "targetdef holder {",
  "  # What it holds.",
  "  srcs = FILES;",
  "  * = FILES;",
  "}",
  "# The library.",
  "holder lib { srcs = a.txt; }",
  "holder app { srcs = lib ${LIBS}; }",
  "holder named { lib_${LIBS} = a.txt; }",
  "holder @dep { srcs = @npm:@sentry/cli:2.0.0 @npm:typescript:6.0.0 -> typescript-6; }",
  "holder uses { srcs = @dep:@sentry/cli @dep:typescript-6 @shorthand/app-tools; }",
  "holder misses { srcs = @dep:2.0.0 @dep:typescript; }",
  "",
].join("\n");

describe("build file language", () => {
  const errors: string[] = [];
  const log = new LogFormatter(LogLevel.Info, message => errors.push(message));
  const contents = parseBuildString(EMPTY_FILESET, "BUILD.fabr", TEXT, log);
  const model = toBuildModel([contents], log, []);
  const at = (needle: string, nth = 0): number => {
    let found = -1;
    for (let i = 0; i <= nth; i++) {
      found = TEXT.indexOf(needle, found + 1);
    }
    return found + 1;
  };

  it("parses the fixture", () => {
    expect(errors).to.deep.equal([]);
  });

  it("lists a file's declarations in written order, a target by its type", () => {
    expect(symbolsOf(contents).map(({ name, kind, detail }) => [name, kind, detail])).to.deep.equal([
      ["LIBS", "property", undefined],
      ["holder", "targetdef", undefined],
      ["lib", "target", "holder"],
      ["app", "target", "holder"],
      ["named", "target", "holder"],
      ["@dep", "target", "holder"],
      ["uses", "target", "holder"],
      ["misses", "target", "holder"],
    ]);
    const lib = symbolsOf(contents).find(symbol => symbol.name === "lib")!;
    expect(TEXT.slice(lib.selection.offset, lib.selection.endOffset)).to.equal("lib");
    expect(TEXT.slice(lib.range.offset, lib.range.endOffset)).to.equal("holder lib { srcs = a.txt");
  });

  it("finds what is written at a place: a target's type and name, a property's name, a value", () => {
    expect(writtenAt(contents, at("holder lib"))?.kind).to.equal("target-type");
    expect(writtenAt(contents, at("lib {"))?.kind).to.equal("target-name");
    expect(writtenAt(contents, at("srcs = lib"))?.kind).to.equal("property-name");
    expect(writtenAt(contents, at("lib ${"))?.kind).to.equal("value");
  });

  it("finds where a reference, a substitution and a target's type are declared", () => {
    const declared = (offset: number): string[] =>
      (namedAt(model, writtenAt(contents, offset)!, offset)?.declarations ?? []).map(span => TEXT.slice(span.offset, span.endOffset ?? span.offset));
    expect(declared(at("lib ${"))).to.deep.equal(["lib"]);
    expect(declared(at("LIBS}"))).to.deep.equal(["LIBS"]);
    expect(declared(at("holder app"))).to.deep.equal(["holder"]);
    /* A substitution in a property's name, as a catalog entry's key holds one. */
    expect(declared(at("LIBS} ="))).to.deep.equal(["LIBS"]);
  });

  it("documents a property by its schema, and a reference by its declaration", () => {
    const documented = (offset: number): IDocumentation | undefined => namedAt(model, writtenAt(contents, offset)!, offset)?.documentation;
    expect(documented(at("srcs = lib"))).to.deep.equal({ title: "srcs: FILES", within: "holder", comment: "What it holds." });
    expect(documented(at("lib ${"))).to.deep.equal({ title: "holder lib", comment: "The library." });
    expect(documented(at("LIBS}"))).to.deep.equal({ source: "LIBS = lib;", comment: "The packages a test reads." });
    /* A plugin's name, where a target of the project is the plugin. */
    const plugins = parseBuildString(EMPTY_FILESET, "OTHER.fabr", "plugin lib;\n", log);
    expect(namedAt(model, writtenAt(plugins, 8)!, 8)?.documentation).to.deep.equal({ title: "holder lib", comment: "The library." });
  });

  it("offers to complete what is typed, as the place it is typed at reads it", () => {
    const offered = (typed: string): string[] => completionsAt(model, typed, typed.length).map(completion => completion.label);
    expect(offered("holder x {\n  ")).to.deep.equal(["srcs"]);
    expect(offered("holder x { srcs = ")).to.include.members(["lib", "app", "LIBS"]);
    expect(offered("holder x { srcs = ${")).to.deep.equal(["LIBS"]);
    expect(offered("")).to.include.members(["holder", "targetdef", "include"]);
    expect(offered("# a comment ")).to.deep.equal([]);
    const srcs = completionsAt(model, "holder x { ", 11)[0];
    expect(srcs).to.deep.include({ label: "srcs", kind: "property", detail: "FILES", comment: "What it holds." });
  });

  it("finds the type a targetdef extends, and offers what a target's body can splice", () => {
    const text = [
      "targetdef holder { srcs = FILES; }",
      "# A holder with more.",
      "targetdef bigger extends holder { more = FILES; }",
      "# Shared settings.",
      "COMMON = { srcs = a.txt; };",
      "",
    ].join("\n");
    const extended = parseBuildString(EMPTY_FILESET, "EXT.fabr", text, log);
    const extendedModel = toBuildModel([extended], log, []);
    const base = text.indexOf("holder {", text.indexOf("extends")) + 1;
    const written = writtenAt(extended, base)!;
    expect(written.kind).to.equal("targetdef-base");
    const named = namedAt(extendedModel, written, base)!;
    expect(named.declarations.map(span => text.slice(span.offset, span.endOffset ?? span.offset))).to.deep.equal(["holder"]);
    const offered = (typed: string): string[] => completionsAt(extendedModel, typed, typed.length).map(completion => completion.label);
    expect(offered("bigger x {\n  ")).to.deep.equal(["srcs", "more", "COMMON"]);
    expect(offered("rule bigger b = holder inner {\n  ")).to.deep.equal(["srcs", "COMMON", "b"]);
    expect(offered("rule bigger b<BUILD_OPERATION=x> = r {\n  holder r {\n    ")).to.deep.equal(["srcs", "COMMON", "b"]);
  });

  describe("a rule's declaration", () => {
    const text = [
      "# A thing that holds files.",
      "targetdef holder {",
      "  # What it holds.",
      "  srcs = FILES;",
      "  more = FILES;",
      "}",
      "extra = x.txt;",
      "rule holder pkg<BUILD_OPERATION=lint> = held {",
      "  both = pkg.srcs extra;",
      "  holder held { srcs = both ${pkg.more}; more = pkg; }",
      "  holder spliced { pkg; }",
      "}",
      "",
    ].join("\n");
    const ruled = parseBuildString(EMPTY_FILESET, "RULE.fabr", text, log);
    const ruledModel = toBuildModel([ruled], log, []);
    const find = (needle: string, nth = 0): number => {
      let found = -1;
      for (let i = 0; i <= nth; i++) {
        found = text.indexOf(needle, found + 1);
      }
      return found + 1;
    };
    const declared = (offset: number): string[] =>
      (namedAt(ruledModel, writtenAt(ruled, offset)!, offset)?.declarations ?? []).map(span => text.slice(span.offset, span.endOffset ?? span.offset));

    it("finds what is written in it: its type, its parameter, the block's targets and values", () => {
      expect(writtenAt(ruled, find("holder pkg"))?.kind).to.equal("rule-type");
      expect(writtenAt(ruled, find("pkg<"))?.kind).to.equal("rule-parameter");
      expect(writtenAt(ruled, find("holder held"))?.kind).to.equal("target-type");
      expect(writtenAt(ruled, find("held {", 1))?.kind).to.equal("target-name");
      expect(writtenAt(ruled, find("pkg; }", 1))?.kind).to.equal("splice");
      /* The block's result. */
      expect(writtenAt(ruled, find("held {"))?.kind).to.equal("value");
    });

    it("looks a name up in the block first: the parameter, its properties, the block's own names, then the file's", () => {
      expect(declared(find("holder pkg"))).to.deep.equal(["holder"]);
      expect(declared(find("pkg.srcs"))).to.deep.equal(["holder"]);
      expect(namedAt(ruledModel, writtenAt(ruled, find("pkg.srcs"))!, find("pkg.srcs"))?.documentation).to.deep.equal({ title: "srcs: FILES", within: "holder", comment: "What it holds." });
      expect(declared(find("both ${"))).to.deep.equal(["both"]);
      expect(declared(find("pkg.more}"))).to.deep.equal(["holder"]);
      expect(declared(find("pkg; }", 0))).to.deep.equal(["pkg"]);
      expect(declared(find("extra;"))).to.deep.equal(["extra"]);
    });

    it("offers the parameter and its properties as values in the block", () => {
      const typed = "rule holder pkg = r {\n  holder r { srcs = ";
      const offered = completionsAt(ruledModel, typed, typed.length).map(completion => completion.label);
      expect(offered).to.include.members(["pkg", "pkg.srcs", "pkg.more"]);
    });

    it("lists the rule in the outline, with what its block declares beneath it", () => {
      const rule = symbolsOf(ruled).find(symbol => symbol.kind === "rule")!;
      expect([rule.name, rule.detail]).to.deep.equal(["holder", "BUILD_OPERATION=lint"]);
      expect(rule.children?.map(child => [child.name, child.kind])).to.deep.equal([
        ["both", "property"],
        ["held", "target"],
        ["spliced", "target"],
      ]);
    });
  });

  it("names a reference's parts apart: a repository, then the entry of its own that names the rest", () => {
    const parts = (needle: string, delta = 1): [string, string[]] | undefined => {
      const offset = TEXT.indexOf(needle) + delta;
      const named = namedAt(model, writtenAt(contents, offset)!, offset);
      return named && [TEXT.slice(named.origin.offset, named.origin.endOffset), named.declarations.map(span => TEXT.slice(span.offset, span.endOffset ?? span.offset))];
    };
    expect(parts("@dep:@sentry/cli")).to.deep.equal(["@dep", ["@dep"]]);
    expect(parts("@sentry/cli @dep")).to.deep.equal(["@sentry/cli", ["@npm:@sentry/cli:2.0.0"]]);
    expect(parts("typescript-6 @shorthand")).to.deep.equal(["typescript-6", ["@npm:typescript:6.0.0 -> typescript-6"]]);
    /* A version is no entry's name, and nor is a package the catalog names otherwise: both name the catalog. */
    expect(parts("2.0.0 @dep")).to.deep.equal(["2.0.0", ["@dep"]]);
    expect(parts("typescript;")).to.deep.equal(["typescript", ["@dep"]]);
  });
});
