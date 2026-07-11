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
import { IBuildFileContents, IPropertyDecl, PropertyType } from "./AST";
import { Name, NamePart, NamePartKind } from "./Name";
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

function propertyValues(properties: IPropertyDecl[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const prop of properties) {
    result[prop.name] = prop.values.map(value => nameText(value.value));
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
        `${schema.required ? "REQUIRED " : ""}${schema.type === PropertyType.String ? "STRING" : "FILES"}`,
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

  it("recovers after a bad statement and parses the subsequent ones", () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    /* `= oops;` is a bad statement; recovery must resume at the next statement
     * (which starts with an identifier), not swallow the rest of the file. */
    const result = parseBuildString(EMPTY_FILESET, "PROJECT.fabr", "a = 1;\n= oops;\nc = 3;\nd = 4;", logger);
    expect(result.properties.map(p => p.name)).to.deep.equal(["a", "c", "d"]);
    expect(errors).to.have.length(1);
  });

  it("Missing Close Brace", () => {
    expect(parseInvalid("js_package fabr {\nsrcs=src:**/*.ts; deps= es2019\n node \nunicode-properties;")).to.deep.equal([
      diagnosticBlock(4, 20, "Read EOF but expected Identifier or '}'", "unicode-properties;"),
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

  it("Plugin Decl", () => {
    expect(summarize(parseValid("plugin @fabr/js;\nplugin simple;"))).to.deep.equal(
      summary({ plugins: ["@fabr/js", "simple"] })
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
      return parseValid(text).properties[0].values[0].value;
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

    it("requires the '<' to abut the reference", () => {
      /* A whitespace-separated '<' cannot start a value, so it is an error */
      expect(parseInvalid("dep = mylib <A=1>;")).to.deep.equal([
        diagnosticBlock(1, 12, "Read '<' but expected Name, ';', or '}'", "dep = mylib <A=1>;"),
      ]);
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
});
