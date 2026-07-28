/*
 * Copyright (c) 2022 Nathan Keynes <nkeynes@deadcoderemoval.net>
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
import {
  DeclKind,
  IBuildFileContents,
  ICommandStage,
  IMapItemDecl,
  IPropertyDecl,
  isCommandValue,
  isMapValue,
  isNameValue,
  IValue,
  PropertyType,
} from "./AST";
import { Name, NamePart, NamePartKind } from "../core/Name";
import { parseBuildString, parseName } from "./Parser";

function parseValid(text: string): IBuildFileContents {
  const errors: string[] = [];
  const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));

  const result = parseBuildString(EMPTY_FILESET, "PROJECT.fabr", text, logger);
  expect(errors).to.deep.equal([]);
  return result;
}

function parseInvalid(text: string): string[] {
  const errors: string[] = [];
  const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));

  parseBuildString(EMPTY_FILESET, "PROJECT.fabr", text, logger);
  return errors;
}

/** The expected rendering of a single-caret parse diagnostic block. */
function diagnosticBlock(line: number, column: number, message: string, lineText: string): string {
  const width = String(line).length;
  return (
    `error: ${message}\n` +
    `${" ".repeat(width)}--> PROJECT.fabr:${line}:${column}\n` +
    `${" ".repeat(width + 1)}|\n` +
    `${line} | ${lineText}\n` +
    `${" ".repeat(width + 1)}| ${" ".repeat(column - 1)}^\n`
  );
}

/**
 * Render a parsed Name unambiguously: a purely-literal name is its text; a
 * composite name renders its parts joined with '+', tagging glob and
 * variable-substitution parts. (White-box: reads Name's internal parts, since
 * distinguishing a literal "${A}" from an actual substitution is the point.)
 */
function nameText(name: Name): string {
  const parts = (name as unknown as { parts: NamePart[] }).parts;
  if (parts.every(part => part.kind === NamePartKind.Literal)) {
    return parts.map(part => part.value).join("");
  }
  return parts.map(partText).join("+");
}

function partText(part: NamePart): string {
  switch (part.kind) {
    case NamePartKind.Glob:
      return `glob(${part.value})`;
    case NamePartKind.VarSubst:
      return `var(${part.value})`;
    default:
      return part.value;
  }
}

function propertyTypeName(type: PropertyType): string {
  switch (type) {
    case PropertyType.String:
      return "STRING";
    case PropertyType.Rewrite:
      return "REWRITE";
    case PropertyType.Map:
      return "MAP";
    default:
      return "FILES";
  }
}

/** The Name of a name value / the entries of a map value — white-box test
 * accessors over the {@link IValue} union (assert the expected kind). */
function nameOf(value: IValue): Name {
  if (!isNameValue(value)) throw new Error("expected a name value, got a map block");
  return value.value;
}
function entriesOf(value: IValue | undefined): IMapItemDecl[] | undefined {
  return value !== undefined && isMapValue(value) ? value.entries : undefined;
}

function propertyValues(properties: IPropertyDecl[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const prop of properties) {
    result[prop.name] = prop.values.map(value => nameText(nameOf(value)));
  }
  return result;
}

/** Reduce the parse result to its semantic content, for whole-value assertions */
function summarize(contents: IBuildFileContents): Record<string, unknown> {
  const targets: Record<string, unknown> = {};
  for (const target of contents.targets) {
    targets[target.name] = { type: target.type, properties: propertyValues(target.properties) };
  }
  const targetdefs: Record<string, Record<string, string>> = {};
  for (const def of contents.targetdefs) {
    targetdefs[def.name] = Object.fromEntries(
      Object.entries(def.properties).map(([name, schema]) => [
        name,
        `${schema.required ? "REQUIRED " : ""}${propertyTypeName(schema.type)}`,
      ])
    );
  }
  return {
    includes: contents.includes.map(include => include.filename),
    plugins: contents.plugins.map(plugin => plugin.name),
    properties: propertyValues(contents.properties),
    defaults: propertyValues(contents.defaults),
    targets,
    targetdefs,
  };
}

function summary(overrides: Record<string, unknown>): Record<string, unknown> {
  return { includes: [], plugins: [], properties: {}, defaults: {}, targets: {}, targetdefs: {}, ...overrides };
}

describe("Parser Tests", () => {
  it("Include Decl", () => {
    expect(summarize(parseValid("include src/BUILD.FABR;"))).to.deep.equal(summary({ includes: ["src/BUILD.FABR"] }));
  });

  it("rejects an absolute include path", () => {
    expect(parseInvalid("include /etc/evil.fabr;")).to.deep.equal([
      diagnosticBlock(1, 9, "Include paths must be relative to the including file", "include /etc/evil.fabr;"),
    ]);
    expect(parseInvalid("include C:/evil.fabr;")).to.deep.equal([
      diagnosticBlock(1, 9, "Include paths must be relative to the including file", "include C:/evil.fabr;"),
    ]);
  });

  it("Property Decl", () => {
    expect(summarize(parseValid("tsc=@npm:typescript;\n js_target=es5-commonjs;\nflavours=red green blue;"))).to.deep.equal(
      summary({
        properties: {
          tsc: ["@npm:typescript"],
          js_target: ["es5-commonjs"],
          flavours: ["red", "green", "blue"],
        },
      })
    );
    expect(parseInvalid("hello=world")).to.deep.equal([
      diagnosticBlock(1, 12, "Read EOF but expected Name, ';', or '}'", "hello=world"),
    ]);
    /* `foo/bar` is a SIMPLE_NAME (has a slash), not an identifier, so it can't
     * start a statement (a property name / type must be a plain identifier). */
    expect(parseInvalid("foo/bar=woo;")).to.deep.equal([
      diagnosticBlock(1, 1, "Read Name but expected Statement", "foo/bar=woo;"),
    ]);
  });

  it("treats tabs and CRLF as insignificant whitespace", () => {
    /* Tab indentation and Windows CRLF line endings must parse identically to
     * space-indented LF: the full POSIX [[:space:]] set is whitespace. */
    expect(summarize(parseValid("\ttsc=@npm:typescript;\r\n\tjs_target=es5;\r\n"))).to.deep.equal(
      summary({ properties: { tsc: ["@npm:typescript"], js_target: ["es5"] } })
    );
  });

  it("keeps Object.prototype names out of parsed property-schema records", () => {
    /* Property names are user-controlled and later tested with `x in properties`
     * (Validate), so the schema record must be null-prototype: a builtin name
     * like `toString` must not read as a phantom member, and a property named
     * `__proto__` must be a real own key, not the record's prototype. */
    const props = parseValid("targetdef t { __proto__ = STRING; toString = FILES; }").targetdefs[0].properties;
    expect(Object.getPrototypeOf(props)).to.equal(null);
    expect("valueOf" in props).to.equal(false);
    expect(Object.hasOwn(props, "__proto__")).to.equal(true);
    expect(props["__proto__"].type).to.equal(PropertyType.String);
    expect(props["toString"].type).to.equal(PropertyType.FileSet);
  });

  it("rejects a 'default' with a non-identifier name (not a target of type 'default')", () => {
    /* `default` is a keyword; a `/`-bearing name must error positioned at the
     * name, rather than silently parsing as a target of type `default`. */
    expect(parseInvalid("default foo/bar = x;")).to.deep.equal([
      diagnosticBlock(1, 9, "Read Name but expected a property name after 'default'", "default foo/bar = x;"),
    ]);
  });

  it("parses a well-formed default property", () => {
    expect(summarize(parseValid("default FLAVOR = plain;"))).to.deep.equal(summary({ defaults: { FLAVOR: ["plain"] } }));
  });

  it("Property with Subst var", () => {
    expect(summarize(parseValid("A=b; B=${A};"))).to.deep.equal(summary({ properties: { A: ["b"], B: ["var(A)"] } }));
  });

  it("Substitutions followed by more content", () => {
    expect(summarize(parseValid("A=$B; C=$B/x; D=${B}x; E=x$;"))).to.deep.equal(
      summary({
        properties: {
          A: ["var(B)"],
          C: ["var(B)+/x"],
          D: ["var(B)+x"],
          E: ["x$"],
        },
      })
    );
  });

  it("bare substitution variable names include underscores", () => {
    /* `$BUILD_TYPE` is one variable, not var(BUILD) + literal "_TYPE". */
    expect(summarize(parseValid("A=$BUILD_TYPE; B=$B_/x;"))).to.deep.equal(
      summary({
        properties: {
          A: ["var(BUILD_TYPE)"],
          B: ["var(B_)+/x"],
        },
      })
    );
  });

  it("Property with double quotes", () => {
    expect(summarize(parseValid('A="a b"; B=a b "cd${A}e"; C="x${A}";'))).to.deep.equal(
      summary({ properties: { A: ["a b"], B: ["a", "b", "cd+var(A)+e"], C: ["x+var(A)"] } })
    );
  });

  it("Property with single quotes", () => {
    expect(summarize(parseValid("A='a b'; B=a b '${A}';"))).to.deep.equal(
      summary({ properties: { A: ["a b"], B: ["a", "b", "${A}"] } })
    );
  });

  it("positions an unterminated-quote error at the opening quote", () => {
    expect(parseInvalid("A = 'oops;")).to.deep.equal([
      diagnosticBlock(1, 5, "Unexpected end of file, expected '", "A = 'oops;"),
    ]);
    expect(parseInvalid('A = "oops;')).to.deep.equal([
      diagnosticBlock(1, 5, 'Unexpected end of file, expected "', 'A = "oops;'),
    ]);
  });

  it("Target Decl", () => {
    expect(
      summarize(parseValid("js_package fabr {\nsrcs=src:**/*.ts; deps= es2019\n node \nunicode-properties; } empty test {}"))
    ).to.deep.equal(
      summary({
        targets: {
          fabr: {
            type: "js_package",
            properties: {
              srcs: ["src:+glob(**)+/+glob(*)+.ts"],
              deps: ["es2019", "node", "unicode-properties"],
            },
          },
          test: { type: "empty", properties: {} },
        },
      })
    );
    expect(summarize(parseValid("js_package @fabr/common {\n  srcs= src:*.ts; }"))).to.deep.equal(
      summary({
        targets: {
          "@fabr/common": { type: "js_package", properties: { srcs: ["src:+glob(*)+.ts"] } },
        },
      })
    );
  });

  it("parses coordinate-keyed members (sync)", () => {
    const contents = parseValid("sync fabr_release {\n @npm:@fabr/core:0.1 = core;\n @npm:@fabr/cli:0.2 = cli;\n}");
    const target = contents.targets.find(t => t.name === "fabr_release");
    expect(target?.type).to.equal("sync");
    expect(target?.properties.length).to.equal(2);
    const [core, cli] = target!.properties;
    /* The coordinate is carried as a parsed reference on keyRef (and its canonical
     * string is the property name); the value is the content target. */
    expect(core.keyRef?.toString()).to.equal("@npm:@fabr/core:0.1");
    expect(core.name).to.equal("@npm:@fabr/core:0.1");
    expect(core.values.map(v => nameOf(v).toString())).to.deep.equal(["core"]);
    expect(cli.keyRef?.toString()).to.equal("@npm:@fabr/cli:0.2");
    expect(cli.values.map(v => nameOf(v).toString())).to.deep.equal(["cli"]);
  });

  it("recovers after a bad statement and parses the subsequent ones", () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    /* `= oops;` is a bad statement; recovery must resume at the next statement
     * (which starts with an identifier), not swallow the rest of the file. */
    const result = parseBuildString(EMPTY_FILESET, "PROJECT.fabr", "a = 1;\n= oops;\nc = 3;\nd = 4;", logger);
    expect(result.properties.map(p => p.name)).to.deep.equal(["a", "c", "d"]);
    expect(errors).to.have.length(1);
  });

  it("recovers within a target body — one diagnostic per error, no top-level leak", () => {
    const count = (src: string): number => {
      const errors: string[] = [];
      parseBuildString(EMPTY_FILESET, "PROJECT.fabr", src, new LogFormatter(LogLevel.Info, m => errors.push(m)));
      return errors.length;
    };
    /* A bad property mid-body must not cascade: previously the recovery resumed
     * top-level parsing *inside* the body, leaking the remaining properties and
     * misreporting the closing `}`. Now each real error yields exactly one. */
    expect(count("js_package foo {\n  srcs = = ;\n  deps = bar;\n}\nother = ok;")).to.equal(1);
    expect(count("js_package foo {\n  a = = ;\n  b = = ;\n  c = ok;\n}\nx = ok;")).to.equal(2);
    /* A bad entry inside a map-block value stays contained in the block. */
    expect(count("js_package foo {\n  meta = { k = = ; };\n  deps = bar;\n}\nother = ok;")).to.equal(1);
  });

  it("Missing Close Brace", () => {
    /* An unterminated body runs to EOF; the body loop ends at EOF and the missing
     * `}` is reported directly, rather than as a property-list continuation. */
    expect(parseInvalid("js_package fabr {\nsrcs=src:**/*.ts; deps= es2019\n node \nunicode-properties;")).to.deep.equal([
      diagnosticBlock(4, 20, "Read EOF but expected '}'", "unicode-properties;"),
    ]);
  });

  it("Optional final semicolon", () => {
    expect(
      summarize(parseValid("npm_dep @npm {\n  deps = chokidar:3.5.3 picomatch:2.3.1 unicode-properties:1.3.1\n}"))
    ).to.deep.equal(
      summary({
        targets: {
          "@npm": {
            type: "npm_dep",
            properties: { deps: ["chokidar:3.5.3", "picomatch:2.3.1", "unicode-properties:1.3.1"] },
          },
        },
      })
    );
  });

  it("Targetdef", () => {
    expect(summarize(parseValid("targetdef js_package {\n  deps = FILES;\n  srcs=FILES REQUIRED;version=STRING}"))).to.deep.equal(
      summary({
        targetdefs: {
          js_package: { deps: "FILES", srcs: "REQUIRED FILES", version: "STRING" },
        },
      })
    );
  });

  it("Targetdef with a wildcard member (* = FILES)", () => {
    expect(summarize(parseValid("targetdef sync {\n  * = FILES;\n}"))).to.deep.equal(
      summary({ targetdefs: { sync: { "*": "FILES" } } })
    );
  });

  describe("doc comments", () => {
    it("attaches a comment block directly above a targetdef", () => {
      const def = parseValid("# A runnable thing.\ntargetdef script {\n  entry = FILES;\n}").targetdefs[0];
      expect(def.docComment).to.equal("A runnable thing.");
    });

    it("attaches a comment separated from the targetdef by a blank line", () => {
      /* The lib files put a blank line between a block comment and its decl;
       * the block still attaches (only blank lines are crossed). */
      const def = parseValid("#\n# A runnable thing.\n#\n\ntargetdef script {\n  entry = FILES;\n}").targetdefs[0];
      expect(def.docComment).to.equal("A runnable thing.");
    });

    it("does not pull in an earlier block separated by a blank line", () => {
      /* A banner/section comment above the doc block, blank-line-separated, is a
       * different block and must not leak into the attached comment. */
      const src = "# Section banner.\n\n# The real doc.\ntargetdef script {\n  entry = FILES;\n}";
      expect(parseValid(src).targetdefs[0].docComment).to.equal("The real doc.");
    });

    it("joins a multi-line block and strips markers", () => {
      const def = parseValid("# line one\n# line two\ntargetdef script {\n  entry = FILES;\n}").targetdefs[0];
      expect(def.docComment).to.equal("line one\nline two");
    });

    it("attaches comments to individual properties", () => {
      const def = parseValid("targetdef js_test {\n  # The test files.\n  tests = FILES;\n  deps = FILES;\n}").targetdefs[0];
      expect(def.properties.tests.docComment).to.equal("The test files.");
      expect(def.properties.deps.docComment).to.be.undefined;
    });

    it("leaves docComment undefined when there is no comment", () => {
      const def = parseValid("targetdef script {\n  entry = FILES;\n}").targetdefs[0];
      expect(def.docComment).to.be.undefined;
    });
  });

  it("Plugin Decl", () => {
    expect(summarize(parseValid("plugin @fabr-build/js;\nplugin simple;"))).to.deep.equal(
      summary({ plugins: ["@fabr-build/js", "simple"] })
    );
  });

  it("allows '-' and '.' in plugin and target names (real npm package names)", () => {
    expect(summarize(parseValid("plugin my-plugin;\nplugin lodash.merge;\nplugin @scope/a-b.c;"))).to.deep.equal(
      summary({ plugins: ["my-plugin", "lodash.merge", "@scope/a-b.c"] })
    );
    expect(summarize(parseValid("js_package my-target {\n  srcs = src:*.ts; }"))).to.deep.equal(
      summary({ targets: { "my-target": { type: "js_package", properties: { srcs: ["src:+glob(*)+.ts"] } } } })
    );
  });

  it("rejects '-'/'.' in identifier positions (property names, constraint keys)", () => {
    /* `-`/`.` belong to SIMPLE_NAME (names), not IDENTIFIER (property names,
     * keys, types), so a property named `a-b` can't start a statement. */
    expect(parseInvalid("a-b = 1;")).to.deep.equal([
      diagnosticBlock(1, 1, "Read Name but expected Statement", "a-b = 1;"),
    ]);
    expect(parseInvalid("dep = mylib<a-b=1>;")).to.deep.equal([
      diagnosticBlock(1, 13, "Read Name but expected a constraint key", "dep = mylib<a-b=1>;"),
    ]);
  });

  it("Plugin Decl with invalid name", () => {
    expect(parseInvalid("plugin ${TEST_PLUGIN};")).to.deep.equal([
      diagnosticBlock(1, 8, "Plugin names must be plain target names (no glob patterns or variables)", "plugin ${TEST_PLUGIN};"),
    ]);
    expect(parseInvalid("plugin @fabr/*;")).to.deep.equal([
      diagnosticBlock(1, 8, "Plugin names must be plain target names (no glob patterns or variables)", "plugin @fabr/*;"),
    ]);
  });

  describe("constrained references", () => {
    /** The Name of the first value of the first property. */
    function firstValue(text: string): Name {
      return nameOf(parseValid(text).properties[0].values[0]);
    }
    function constraintsOf(name: Name): [string, string][] {
      return name.getConstraints().map(([key, value]) => [key, value.toString()]);
    }

    it("parses a single constraint and rounds-trips it", () => {
      const name = firstValue("dep = mylib<BUILD_TYPE=release>;");
      expect(name.toString()).to.equal("mylib<BUILD_TYPE=release>");
      expect(constraintsOf(name)).to.deep.equal([["BUILD_TYPE", "release"]]);
    });

    it("parses multiple constraints, ordered, with a trailing comma", () => {
      const name = firstValue("dep = mylib<BUILD_TYPE=release, JS_TARGET=es6-esm,>;");
      expect(name.toString()).to.equal("mylib<BUILD_TYPE=release, JS_TARGET=es6-esm>");
      expect(constraintsOf(name)).to.deep.equal([
        ["BUILD_TYPE", "release"],
        ["JS_TARGET", "es6-esm"],
      ]);
    });

    it("accepts non-identifier constraint values (versions, requirements)", () => {
      expect(constraintsOf(firstValue("dep = a<V=5.4.5>;"))).to.deep.equal([["V", "5.4.5"]]);
      expect(constraintsOf(firstValue("dep = a<TSC=@npm:typescript:5.4.5>;"))).to.deep.equal([
        ["TSC", "@npm:typescript:5.4.5"],
      ]);
    });

    it("accepts a purely-numeric constraint value (the closing '>' is not an fd redirect)", () => {
      /* `<X=1>` must lex as value `1` then `>`, not the `1>` redirect operator. */
      expect(constraintsOf(firstValue("dep = a<X=1>;"))).to.deep.equal([["X", "1"]]);
      expect(constraintsOf(firstValue("dep = a<X=2, Y=1>;"))).to.deep.equal([
        ["X", "2"],
        ["Y", "1"],
      ]);
    });

    it("reassembles a projection tail after the constraint", () => {
      const name = firstValue("dep = pkg<BUILD_TYPE=release>:build/*.js;");
      expect(name.toString()).to.equal("pkg:build/*.js<BUILD_TYPE=release>");
      /* The literal prefix must remain intact for target-prefix matching */
      expect(name.getLiteralPrefix()).to.equal("pkg:build/");
    });

    it("treats the constraint position relative to ':' as equivalent", () => {
      const before = firstValue("dep = pkg<BUILD_TYPE=release>:x;");
      const after = firstValue("dep = pkg:x<BUILD_TYPE=release>;");
      expect(before.toString()).to.equal("pkg:x<BUILD_TYPE=release>");
      expect(after.toString()).to.equal("pkg:x<BUILD_TYPE=release>");
    });

    it("substitutes variables in constraint values", () => {
      const name = firstValue("dep = mylib<BUILD_TYPE=${DEFAULT}>;");
      expect(name.getVariables()).to.deep.equal(["DEFAULT"]);
      expect(name.substitute(["DEFAULT"], ["release"]).toString()).to.equal("mylib<BUILD_TYPE=release>");
    });

    it("rejects an empty constraint list", () => {
      expect(parseInvalid("dep = mylib<>;")).to.deep.equal([
        diagnosticBlock(1, 13, "Read '>' but expected a constraint key", "dep = mylib<>;"),
      ]);
    });

    it("rejects a duplicate constraint key", () => {
      expect(parseInvalid("dep = mylib<A=1, A=2>;")).to.deep.equal([
        diagnosticBlock(1, 18, "Duplicate constraint key 'A'", "dep = mylib<A=1, A=2>;"),
      ]);
    });

    it("rejects a constraint with no value", () => {
      expect(parseInvalid("dep = mylib<A>;")).to.deep.equal([
        diagnosticBlock(1, 14, "Read '>' but expected '='", "dep = mylib<A>;"),
      ]);
    });

    it("treats a spaced '< file' with no '=' as a stdin redirect", () => {
      /* A spaced `<` is disambiguated by content: without a `key=` it is a
       * command stdin redirect, so the value parses to a `command`. */
      const command = parseValid("run = mylib < src;").properties[0].values.find(isCommandValue);
      expect(command?.pipeline).to.have.length(1);
      expect(command?.pipeline[0].command.value.toString()).to.equal("mylib");
      expect(command?.pipeline[0].stdin?.value.toString()).to.equal("src");
    });

    it("binds a spaced '<k=v>' as a constraint (disambiguated by the '=')", () => {
      /* A space before `<` no longer forces a redirect: `<key=` can only be a
       * constraint (never a redirect target), so it binds to the reference. */
      const name = firstValue("dep = mylib <BUILD_TYPE=release>;");
      expect(name.toString()).to.equal("mylib<BUILD_TYPE=release>");
      expect(constraintsOf(name)).to.deep.equal([["BUILD_TYPE", "release"]]);
    });

    it("binds a spaced constraint with a projection tail", () => {
      const name = firstValue("dep = mylib <BUILD_TYPE=release>:build/*.js;");
      expect(name.toString()).to.equal("mylib:build/*.js<BUILD_TYPE=release>");
      expect(constraintsOf(name)).to.deep.equal([["BUILD_TYPE", "release"]]);
    });

    it("does not glue non-projection text after a constraint (foo<k=v>bar)", () => {
      /* Only a `:`/`/`-led projection tail rejoins; arbitrary abutting text is a
       * separate value, not silently glued into `foobar<k=v>`. */
      const values = parseValid("dep = foo<K=V>bar;").properties[0].values;
      expect(values.map(nameOf).map(name => name.toString())).to.deep.equal(["foo<K=V>", "bar"]);
    });

    it("binds a spaced constraint to the preceding value in a list", () => {
      const values = parseValid("dep = a b <K=V>;").properties[0].values;
      expect(values).to.have.length(2);
      expect(nameOf(values[0]).toString()).to.equal("a");
      expect(nameOf(values[1]).toString()).to.equal("b<K=V>");
    });

    it("keeps a spaced bare-identifier redirect a redirect (not a constraint)", () => {
      /* `< input` shares the IDENTIFIER prefix with a constraint key but has no
       * `=`, so the left-factoring commits it to a redirect target. */
      const command = parseValid("run = cmd < input;").properties[0].values.find(isCommandValue);
      expect(command?.pipeline[0].stdin?.value.toString()).to.equal("input");
    });

    it("keeps both spaced redirects working around the left-factoring", () => {
      const command = parseValid("run = cmd < in > out;").properties[0].values.find(isCommandValue);
      expect(command?.pipeline[0].stdin?.value.toString()).to.equal("in");
      expect(command?.pipeline[0].stdout?.value.toString()).to.equal("out");
    });

    it("parses constraints on a command-line name (parseName parity)", () => {
      const name = parseName("pkg<BUILD_TYPE=release>:build/*.js");
      expect(name.toString()).to.equal("pkg:build/*.js<BUILD_TYPE=release>");
      expect(constraintsOf(name)).to.deep.equal([["BUILD_TYPE", "release"]]);
      /* A plain command-line name still parses unchanged */
      expect(parseName("@npm:esbuild:0.28.1").toString()).to.equal("@npm:esbuild:0.28.1");
    });

    it("rejects trailing input rather than silently dropping it", () => {
      /* The space means `<a=1>` doesn't abut `ref`; report it, don't ignore it. */
      expect(() => parseName("ref <a=1>")).to.throw(/Invalid name 'ref <a=1>'.*expected end of input/);
    });

    it("throws a diagnostic message (never logs) on a malformed name", () => {
      expect(() => parseName("mylib<A>")).to.throw(/Invalid name 'mylib<A>'.*expected '='/);
    });

    it("returns an empty name for empty input", () => {
      expect(parseName("").toString()).to.equal("");
    });
  });

  describe("rename templates", () => {
    function firstValue(text: string): Name {
      return nameOf(parseValid(text).properties[0].values[0]);
    }

    it("parses a selector -> template pair and round-trips it", () => {
      const name = firstValue("out = golden:*.expect -> *.out;");
      expect(name.toString()).to.equal("golden:*.expect -> *.out");
      expect(name.getRenameTo()?.toString()).to.equal("*.out");
    });

    it("parses a bare REWRITE value with no arrow (no template)", () => {
      const name = firstValue("out = bundle.js;");
      expect(name.getRenameTo()).to.equal(undefined);
      expect(name.toString()).to.equal("bundle.js");
    });

    it("binds the arrow after a constraint delta", () => {
      const name = firstValue("out = pkg<BUILD_TYPE=release>:*.js -> *.mjs;");
      expect(name.toString()).to.equal("pkg:*.js<BUILD_TYPE=release> -> *.mjs");
      expect(name.getRenameTo()?.toString()).to.equal("*.mjs");
    });

    it("substitutes variables in the template", () => {
      const name = firstValue("out = *.entry.js -> *.${BUILD_NO}.min.js;");
      expect(name.getVariables()).to.deep.equal(["BUILD_NO"]);
      expect(name.substitute(["BUILD_NO"], ["7"]).toString()).to.equal("*.entry.js -> *.7.min.js");
    });

    it("parses on a command-line name (parseName parity)", () => {
      const name = parseName("golden:*.expect -> *.out");
      expect(name.toString()).to.equal("golden:*.expect -> *.out");
    });

    it("rejects a missing template after the arrow", () => {
      expect(parseInvalid("out = *.expect -> ;")).to.deep.equal([
        /* The caret sits on the ';' itself (col 19), not the space before it. */
        diagnosticBlock(1, 19, "Read ';' but expected a rename template", "out = *.expect -> ;"),
      ]);
    });

    it("rejects constraints on the template", () => {
      expect(parseInvalid("out = *.expect -> *.out<A=1>;")).to.deep.equal([
        diagnosticBlock(
          1,
          24,
          "Invalid rename template: a rename template cannot carry constraints",
          "out = *.expect -> *.out<A=1>;"
        ),
      ]);
    });

    it("rejects a chained arrow", () => {
      expect(parseInvalid("out = *.a -> *.b -> *.c;")).to.deep.equal([
        diagnosticBlock(
          1,
          /* The caret sits on the second '->' itself (col 18), not the space before it. */
          18,
          "Invalid rename template: rename templates cannot be chained",
          "out = *.a -> *.b -> *.c;"
        ),
      ]);
    });

    it("hints when the arrow is not spaced", () => {
      expect(parseInvalid("out = a-> *.b;")).to.deep.equal([
        diagnosticBlock(
          1,
          9,
          "Invalid rename template: the '->' arrow must be surrounded by spaces (`sel -> tmpl`)",
          "out = a-> *.b;"
        ),
      ]);
    });
  });

  describe("character classes", () => {
    it("reads a plain char class as a single glob unit", () => {
      expect(nameText(parseName("[abc]"))).to.equal("glob([abc])");
      expect(nameText(parseName("[a-z]"))).to.equal("glob([a-z])");
    });

    it("keeps a ']' immediately after '[' a literal member", () => {
      expect(nameText(parseName("[]a]"))).to.equal("glob([]a])");
    });

    it("treats the contents as literal characters — no variable substitution", () => {
      /* A '$' inside a class matches a literal '$'; it is never a substitution
       * (which would show as a var(...) part, splitting the glob unit). */
      expect(nameText(parseName("[$x]"))).to.equal("glob([$x])");
      expect(nameText(parseName("[${}]"))).to.equal("glob([${}])");
    });

    it("keeps a POSIX class element whole (its inner ':]' is not the class close)", () => {
      expect(nameText(parseName("[[:alpha:]]"))).to.equal("glob([[:alpha:]])");
      expect(nameText(parseName("[[:alpha:][:digit:]]"))).to.equal("glob([[:alpha:][:digit:]])");
      /* Collating '[.x.]' and equivalence '[=e=]' elements likewise. */
      expect(nameText(parseName("[[.-.]a]"))).to.equal("glob([[.-.]a])");
    });

    it("composes a POSIX class with surrounding literals", () => {
      /* The class and the following '*' are adjacent globs, so they merge into a
       * single glob unit (the builder collapses same-kind neighbours). */
      expect(nameText(parseName("src/[[:digit:]]*.ts"))).to.equal("src/+glob([[:digit:]]*)+.ts");
    });

    it("keeps a stray '[' inside a class a literal member (not a POSIX element)", () => {
      /* '[x]' — the inner '[' has no ':'/'.'/'=' after it, so it is an ordinary
       * class member and the first ']' closes the class. */
      expect(nameText(parseName("[[x]"))).to.equal("glob([[x])");
    });

    it("rejects an unterminated char class", () => {
      /* The class runs to EOF with no ']'; rejected like any unterminated
       * construct (a build-file parse emits a positioned "expected ']'"
       * diagnostic — the CLI parseName path surfaces the generic parse error). */
      expect(() => parseName("[abc")).to.throw();
    });
  });

  describe("command pipelines", () => {
    /** Render a parsed `command` back to a canonical string (command, args, then
     * redirects in a fixed order), to assert the pipeline structure round-trips. */
    function renderStage(stage: ICommandStage): string {
      const parts = [stage.command.value.toString(), ...stage.args.map(arg => arg.value.toString())];
      if (stage.stdin !== undefined) parts.push("<", stage.stdin.value.toString());
      if (stage.stdout !== undefined) parts.push(">", stage.stdout.value.toString());
      if (stage.stderr !== undefined) parts.push("2>", stage.stderr.value.toString());
      if (stage.both !== undefined) parts.push("&>", stage.both.value.toString());
      return parts.join(" ");
    }
    function sequence(src: string): string {
      const command = parseValid(src).properties[0].values.find(isCommandValue);
      return (command?.pipeline ?? []).map(renderStage).join(" | ");
    }

    it("parses a pipeline with a redirect", () => {
      expect(sequence("run = list_targetdefs --json | gendoc > out.mdx;")).to.equal(
        "list_targetdefs --json | gendoc > out.mdx"
      );
    });

    it("parses stdin, stderr and both redirects", () => {
      expect(sequence("run = tool < src 2> err;")).to.equal("tool < src 2> err");
      expect(sequence("run = a b &> log;")).to.equal("a b &> log");
    });

    it("keeps an abutting <k=v> a constraint on the command, not a stdin redirect", () => {
      /* The constraint binds because it abuts; only a spaced `<` is a redirect. A
       * pipe makes the value a command so we can read the parsed stages. */
      expect(sequence("run = mytool<BUILD_TYPE=release> --flag | tee;")).to.equal(
        "mytool<BUILD_TYPE=release> --flag | tee"
      );
    });

    it("preserves glob args (expanded over srcs at resolution, not here)", () => {
      expect(sequence("run = tool src/*.ts > out;")).to.equal("tool src/*.ts > out");
    });

    it("still flags an unspaced arrow rather than reading it as a redirect", () => {
      expect(parseInvalid("out = a-> *.b;")).to.deep.equal([
        diagnosticBlock(1, 9, "Invalid rename template: the '->' arrow must be surrounded by spaces (`sel -> tmpl`)", "out = a-> *.b;"),
      ]);
    });

    it("rejects a dangling redirect with no target", () => {
      expect(parseInvalid("run = emit >;")).to.deep.equal([
        diagnosticBlock(1, 12, "Invalid command: redirect '>' must be followed by a target name", "run = emit >;"),
      ]);
    });

    it("rejects an empty command beside a pipe", () => {
      expect(parseInvalid("run = emit | ;")).to.deep.equal([
        diagnosticBlock(1, 12, "Invalid command: empty command (nothing beside '|')", "run = emit | ;"),
      ]);
    });

    it("rejects a leading redirect with no command", () => {
      expect(parseInvalid("run = > out;")).to.deep.equal([
        diagnosticBlock(1, 7, "Invalid command: a redirect must follow a command", "run = > out;"),
      ]);
    });

    it("rejects capturing a stream twice", () => {
      expect(parseInvalid("run = emit > a > b;")).to.deep.equal([
        diagnosticBlock(1, 16, "Invalid command: stdout is redirected more than once", "run = emit > a > b;"),
      ]);
      expect(parseInvalid("run = tool < a < b;")).to.deep.equal([
        diagnosticBlock(1, 16, "Invalid command: stdin is redirected more than once", "run = tool < a < b;"),
      ]);
    });

    it("rejects stdout capture on a non-final stage", () => {
      expect(parseInvalid("run = a > x | b;")).to.deep.equal([
        diagnosticBlock(1, 13, "Invalid command: only the final stage of a pipeline can capture stdout ('>' / '&>')", "run = a > x | b;"),
      ]);
    });

    it("rejects stdin on a non-first stage", () => {
      expect(parseInvalid("run = a | b < x;")).to.deep.equal([
        diagnosticBlock(1, 13, "Invalid command: only the first stage of a pipeline can take stdin ('<')", "run = a | b < x;"),
      ]);
    });

    it("rejects a `{ ... }` block used as a command word", () => {
      expect(parseInvalid("run = emit | { a = b; };")).to.deep.equal([
        diagnosticBlock(1, 14, "Invalid command: a `{ ... }` block is not a command", "run = emit | { a = b; };"),
      ]);
    });
  });

  describe("MAP properties", () => {
    it("parses the MAP keyword in a targetdef schema", () => {
      expect(summarize(parseValid("targetdef js_bundle {\n  defines = MAP;\n}"))).to.deep.equal(
        summary({ targetdefs: { js_bundle: { defines: "MAP" } } })
      );
    });

    /** Narrow a block's items to its `key = value;` entries (no splices). */
    function blockEntries(items: IMapItemDecl[] | undefined): IPropertyDecl[] {
      return (items ?? []).filter((item): item is IPropertyDecl => item.kind === DeclKind.Property);
    }

    /** The entries of the first target's first property's sole block value, as
     * key -> rendered values. */
    function firstBlock(text: string): Record<string, string[]> {
      const values = parseValid(text).targets[0].properties[0].values;
      expect(values).to.have.lengthOf(1);
      const entries = entriesOf(values[0]);
      expect(entries).to.not.equal(undefined);
      return Object.fromEntries(blockEntries(entries).map(entry => [entry.name, entry.values.map(v => nameText(nameOf(v)))]));
    }

    it("parses a block as a single value carrying ordered entries", () => {
      const prop = parseValid("js_bundle b {\n  defines = { DEBUG = false; NAME = production; }\n}").targets[0]
        .properties[0];
      expect(prop.values).to.have.lengthOf(1);
      expect(entriesOf(prop.values[0])).to.not.equal(undefined);
      expect(firstBlock("js_bundle b {\n  defines = { DEBUG = false; NAME = production; }\n}")).to.deep.equal({
        DEBUG: ["false"],
        NAME: ["production"],
      });
    });

    it("closes a block entry without a ';' (like a target body)", () => {
      /* Nested block entries and the top-level property alike end at their '}';
       * the next NAME starts the next entry/statement. */
      const contents = parseValid(
        "js_bundle b {\n  meta = {\n    author = {\n      name = ann;\n    }\n    repository = {\n      type = git;\n    }\n  }\n}\nAFTER = 1;"
      );
      const entries = blockEntries(entriesOf(contents.targets[0].properties[0].values[0]));
      expect(entries.map(entry => entry.name)).to.deep.equal(["author", "repository"]);
      expect(contents.properties[0].name).to.equal("AFTER");
    });

    it("parses a nested block and a list of blocks", () => {
      const values = parseValid(
        "js_bundle b {\n  meta = { repository = { type = git; url = u; }; maintainers = { name = a; } { name = b; }; }\n}"
      ).targets[0].properties[0].values;
      const entries = blockEntries(entriesOf(values[0]));
      const repository = entries[0];
      expect(repository.name).to.equal("repository");
      expect(repository.values).to.have.lengthOf(1);
      expect(blockEntries(entriesOf(repository.values[0])).map(entry => entry.name)).to.deep.equal(["type", "url"]);
      const maintainers = entries[1];
      expect(maintainers.name).to.equal("maintainers");
      expect(maintainers.values).to.have.lengthOf(2);
      expect(maintainers.values.every(value => entriesOf(value) !== undefined)).to.equal(true);
    });

    it("parses a bare reference statement as a splice", () => {
      const items = entriesOf(
        parseValid("js_bundle b {\n  meta = {\n    FABR_METADATA;\n    description = CLI package;\n  };\n}").targets[0]
          .properties[0].values[0]
      );
      expect(items).to.have.lengthOf(2);
      const [splice, entry] = items ?? [];
      expect(splice.kind).to.equal(DeclKind.MapSplice);
      expect(splice.kind === DeclKind.MapSplice && splice.ref.toString()).to.equal("FABR_METADATA");
      expect(entry.kind).to.equal(DeclKind.Property);
      expect(entry.kind === DeclKind.Property && entry.name).to.equal("description");
    });

    it("accepts dotted foreign names as keys (not resolved as references)", () => {
      expect(firstBlock("js_bundle b {\n  defines = { process.env.NODE_ENV = production; }\n}")).to.deep.equal({
        "process.env.NODE_ENV": ["production"],
      });
    });

    it("interpolates ${...} in entry values", () => {
      const entries = blockEntries(
        entriesOf(parseValid("js_bundle b {\n  defines = { VERSION = ${BUILD_NO}; }\n}").targets[0].properties[0].values[0])
      );
      expect(nameOf(entries[0].values[0]).getVariables()).to.deep.equal(["BUILD_NO"]);
    });

    it("parses an empty block", () => {
      expect(firstBlock("js_bundle b {\n  defines = {}\n}")).to.deep.equal({});
    });

    it("parses a bare name before '}' as a splice (final ';' optional)", () => {
      const items = entriesOf(parseValid("js_bundle b {\n  defines = { DEBUG }\n}").targets[0].properties[0].values[0]);
      expect(items).to.have.lengthOf(1);
      expect(items?.[0].kind).to.equal(DeclKind.MapSplice);
    });

    it("rejects a second name where '=' or ';' must follow", () => {
      expect(parseInvalid("js_bundle b {\n  defines = { DEBUG extra = 1; }\n}")).to.deep.equal([
        diagnosticBlock(2, 21, "Read Identifier but expected '=' or ';'", "  defines = { DEBUG extra = 1; }"),
      ]);
    });

    it("rejects a block with a missing key", () => {
      expect(parseInvalid("js_bundle b {\n  defines = { = false; }\n}")).to.deep.equal([
        diagnosticBlock(2, 15, "Read '=' but expected a map key, a map reference, or '}'", "  defines = { = false; }"),
      ]);
    });
  });
});
