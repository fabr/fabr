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
  IResolvableDecl,
  IMapItemDecl,
  IPropertyDecl,
  ITargetDecl,
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
    result[prop.name.toString()] = prop.values.map(value => nameText(nameOf(value)));
  }
  return result;
}

function targetSummary(target: ITargetDecl): Record<string, unknown> {
  return { type: target.type, properties: propertyValues(target.properties) };
}

/** Defaults hold either kind of declaration, each summarized as its own kind is
 * elsewhere: a property by its values, a target by its type and properties. */
function defaultValues(decls: IResolvableDecl[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const decl of decls) {
    result[decl.name.toString()] =
      decl.kind === DeclKind.Target ? targetSummary(decl) : decl.values.map(value => nameText(nameOf(value)));
  }
  return result;
}

/** Reduce the parse result to its semantic content, for whole-value assertions */
function summarize(contents: IBuildFileContents): Record<string, unknown> {
  const targets: Record<string, unknown> = {};
  for (const target of contents.targets) {
    targets[target.name.toString()] = targetSummary(target);
  }
  const targetdefs: Record<string, Record<string, string>> = {};
  for (const def of contents.targetdefs) {
    targetdefs[def.name] = Object.fromEntries(
      [...def.properties].map(([name, schema]) => [
        name,
        `${schema.required ? "REQUIRED " : ""}${propertyTypeName(schema.type)}${
          schema.default ? ` default ${schema.default.values.map(value => nameText(nameOf(value))).join(" ")}` : ""
        }`,
      ])
    );
  }
  return {
    includes: contents.includes.map(include => include.name.toString()),
    plugins: contents.plugins.map(plugin => plugin.name),
    properties: propertyValues(contents.properties),
    defaults: defaultValues(contents.defaults),
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

  it("Include Decl with a glob", () => {
    const contents = parseValid("include lib/**/*.fabr;");
    expect(summarize(contents)).to.deep.equal(summary({ includes: ["lib/**/*.fabr"] }));
    /* The two cases are told apart by the name alone: a plain include is a simple
     * name (the one file it names), a globbing one is not. */
    expect(contents.includes[0].name.getSimpleName()).to.equal(undefined);
    expect(parseValid("include src/BUILD.FABR;").includes[0].name.getSimpleName()).to.equal("src/BUILD.FABR");
  });

  it("rejects a variable in an include name", () => {
    /* Which files make up the model must be readable from the build files
     * themselves — never from a value that can vary by configuration. */
    expect(parseInvalid("include ${DIR}/BUILD.fabr;")).to.deep.equal([
      diagnosticBlock(1, 9, "Invalid include name: variables are not permitted", "include ${DIR}/BUILD.fabr;"),
    ]);
  });

  it("rejects reference syntax in an include name", () => {
    /* `lib:*.fabr` would name files *relative to* lib rather than under it — an
     * include names a path, and the projection rules are not its business. */
    expect(parseInvalid("include lib:*.fabr;")).to.deep.equal([
      diagnosticBlock(1, 9, "Invalid include name: an include names a path, not a reference", "include lib:*.fabr;"),
    ]);
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

  it("keeps Object.prototype names out of the parsed property-schema map", () => {
    /* Property names are user-controlled, so the schema is a Map: a builtin name
     * like `valueOf` is absent (not a phantom inherited member), and a property
     * named `__proto__`/`toString` is a real entry. */
    const props = parseValid("targetdef t { __proto__ = STRING; toString = FILES; }").targetdefs[0].properties;
    expect(props.has("valueOf")).to.equal(false);
    expect(props.get("__proto__")?.type).to.equal(PropertyType.String);
    expect(props.get("toString")?.type).to.equal(PropertyType.FileSet);
  });

  it("rejects a 'default' with a non-identifier name (not a target of type 'default')", () => {
    /* `default` is a keyword; a `/`-bearing name must error positioned at the
     * name, rather than silently parsing as a target of type `default`. */
    expect(parseInvalid("default foo/bar = x;")).to.deep.equal([
      diagnosticBlock(
        1,
        9,
        "Read Name but expected a property name or target type after 'default'",
        "default foo/bar = x;"
      ),
    ]);
  });

  it("parses a well-formed default property", () => {
    expect(summarize(parseValid("default FLAVOR = plain;"))).to.deep.equal(summary({ defaults: { FLAVOR: ["plain"] } }));
  });

  it("parses a default target", () => {
    /* `default` prefixes either form of declaration; which one follows from the
     * token after the identifier, exactly as for an undefaulted statement. */
    expect(summarize(parseValid("default js_library tool { srcs = a.ts; }"))).to.deep.equal(
      summary({ defaults: { tool: { type: "js_library", properties: { srcs: ["a.ts"] } } } })
    );
  });

  it("parses a default target with a path name", () => {
    /* The target *name* may be a path, unlike a default property's name. */
    expect(summarize(parseValid("default js_library tools/tsc { srcs = a.ts; }"))).to.deep.equal(
      summary({ defaults: { "tools/tsc": { type: "js_library", properties: { srcs: ["a.ts"] } } } })
    );
  });

  it("rejects a default targetdef", () => {
    /* Only properties and targets have a default slot: this is an error at the
     * keyword, not a target whose type is `targetdef`. */
    expect(parseInvalid("default targetdef t { srcs = FILES; }")).to.deep.equal([
      diagnosticBlock(
        1,
        9,
        "Read Identifier but expected a property name or target type after 'default'",
        "default targetdef t { srcs = FILES; }"
      ),
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
    const target = contents.targets.find(t => t.name.toString() === "fabr_release");
    expect(target?.type).to.equal("sync");
    expect(target?.properties.length).to.equal(2);
    const [core, cli] = target!.properties;
    /* The coordinate IS the key — a property key is a Name, so a whole
     * reference needs no separate field; the value is the content target. */
    expect(core.name.toString()).to.equal("@npm:@fabr/core:0.1");
    expect(core.values.map(v => nameOf(v).toString())).to.deep.equal(["core"]);
    expect(cli.name.toString()).to.equal("@npm:@fabr/cli:0.2");
    expect(cli.values.map(v => nameOf(v).toString())).to.deep.equal(["cli"]);
  });

  it("recovers after a bad statement and parses the subsequent ones", () => {
    const errors: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
    /* `= oops;` is a bad statement; recovery must resume at the next statement
     * (which starts with an identifier), not swallow the rest of the file. */
    const result = parseBuildString(EMPTY_FILESET, "PROJECT.fabr", "a = 1;\n= oops;\nc = 3;\nd = 4;", logger);
    expect(result.properties.map(prop => prop.name.toBaseString())).to.deep.equal(["a", "c", "d"]);
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

  it("Targetdef with declared defaults", () => {
    expect(
      summarize(
        parseValid("targetdef js_package {\n  value = STRING default some default value;\n  srcs = FILES default *.ts;\n}")
      )
    ).to.deep.equal(
      summary({
        targetdefs: {
          js_package: { value: "STRING default some default value", srcs: "FILES default glob(*)+.ts" },
        },
      })
    );
  });

  it("names a default's decl for its property, so an error against it reads as that property", () => {
    const schema = parseValid("targetdef t { srcs = FILES default *.ts; }").targetdefs[0].properties.get("srcs");
    expect(schema?.default && schema.default.name.toBaseString()).to.equal("srcs");
  });

  it("Targetdef default taking a map block", () => {
    const schema = parseValid("targetdef t { defines = MAP default { a = 1; b = 2; } }").targetdefs[0].properties.get(
      "defines"
    );
    const entries = entriesOf(schema?.default?.values[0]) ?? [];
    expect(entries.filter((item): item is IPropertyDecl => item.kind === DeclKind.Property).map(prop => prop.name.toBaseString())).to.deep.equal([
      "a",
      "b",
    ]);
  });

  it("Targetdef default following the type keywords, terminated by '}' without a ';'", () => {
    expect(summarize(parseValid("targetdef t {\n  version = STRING default 1.0.0\n}"))).to.deep.equal(
      summary({ targetdefs: { t: { version: "STRING default 1.0.0" } } })
    );
  });

  it("rejects a property that is both REQUIRED and defaulted", () => {
    /* A default supplies the property whenever unwritten, so REQUIRED has nothing
     * left to demand — the pair is a contradiction, not a redundancy. */
    const errors = parseInvalid("targetdef t { srcs = FILES REQUIRED default *.ts; }");
    expect(errors).to.have.lengthOf(1);
    expect(errors[0]).to.match(/cannot be both REQUIRED and have a default/);
  });

  it("rejects 'default' written before the type keyword, positioned at the property", () => {
    /* The clause parses clean (values and ';' consumed), so the parse recovers
     * and the following property still loads — one error, at the mistake, not
     * a generic unexpected-token report at whatever follows the clause. */
    const errors = parseInvalid("targetdef t { srcs = default a.ts; other = STRING; }");
    expect(errors).to.have.lengthOf(1);
    expect(errors[0]).to.match(/'srcs' declares 'default' before its type/);
  });

  it("rejects a default on the '*' wildcard", () => {
    /* The wildcard types only keys that ARE written, so there is no unwritten
     * property for a default to supply — rejected, not silently ignored. */
    const errors = parseInvalid("targetdef sync { * = FILES default x; }");
    expect(errors).to.have.lengthOf(1);
    expect(errors[0]).to.match(/wildcard cannot have a default/);
  });

  it("treats 'default' as an ordinary property name in key position", () => {
    expect(summarize(parseValid("targetdef t { default = STRING; }"))).to.deep.equal(
      summary({ targetdefs: { t: { default: "STRING" } } })
    );
  });

  it("rejects a quoted '*' as the wildcard member — it is the literal character", () => {
    /* The wildcard is matched by part structure, not by rendered text: quoted,
     * `'*'` is data. Comparing text would admit it, since the text rendering of
     * a literal `*` and of the wildcard are both "*". */
    expect(parseInvalid("targetdef sync {\n  '*' = FILES;\n}")).to.have.lengthOf(1);
    expect(parseInvalid("targetdef sync {\n  '*' = FILES;\n}")[0]).to.match(/expected Identifier, '\*', or '}'/);
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
      expect(def.properties.get("tests")?.docComment).to.equal("The test files.");
      expect(def.properties.get("deps")?.docComment).to.be.undefined;
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

  describe("trailing glob (version marker fold)", () => {
    it("a trailing '?' lexes as a glob and folds back via getLiteralWithGlobTail", () => {
      /* The permitted-alternate marker `pkg:1.4.2?` is lexically a glob —
       * repositories fold it back into the version text, where a pattern has
       * no meaning (Name.getLiteralWithGlobTail). */
      const name = parseName("@npm:tslib:1.14.1?");
      expect(name.getSimpleName()).to.equal(undefined);
      expect(name.getLiteralWithGlobTail()).to.equal("@npm:tslib:1.14.1?");
    });

    it("only a pure literal-then-glob name folds", () => {
      /* A real pattern — a projection like `src/*.ts?` — has interior glob
       * parts and is never folded; trailing-`?` globs keep their wildcard
       * meaning everywhere a pattern is a pattern. */
      expect(parseName("test?.js").getLiteralWithGlobTail()).to.equal(undefined);
      expect(parseName("src/*.ts?").getLiteralWithGlobTail()).to.equal(undefined);
      expect(parseName("esbuild:1.14.*").getLiteralWithGlobTail()).to.equal("esbuild:1.14.*");
    });

    it("a trailing '?' composes with a constraint facet", () => {
      const name = parseName("@npm:tslib:1.14.1?<BUILD_TYPE=release>");
      expect(name.getLiteralWithGlobTail()).to.equal("@npm:tslib:1.14.1?");
      expect(name.getConstraints().map(([key]) => key)).to.deep.equal(["BUILD_TYPE"]);
    });

    it("a trailing '!' is no glob and stays literal", () => {
      expect(parseName("@npm:foo:2.0.0!").getSimpleName()).to.equal("@npm:foo:2.0.0!");
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

    it("binds the arrow after a constraint requirement", () => {
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

    it("accepts a wildcard-free template collapsing a pattern to one name", () => {
      /* It fills no slot, so neither wildcard rule applies: the counts need not
       * agree and the selector may use any wildcard kind. Whether the collapse is
       * legal is decided against the files it selects, not the written name —
       * FileSet.rename conflicts unless it lands on a single file. */
      const collapsed = firstValue("out = foo/*/bar/index.ts -> index.ts;");
      expect(collapsed.toString()).to.equal("foo/*/bar/index.ts -> index.ts");
      expect(collapsed.getRenameTo()?.toString()).to.equal("index.ts");
      expect(firstValue("out = src/**/a?.js -> one.js;").getRenameTo()?.toString()).to.equal("one.js");
      expect(parseName("golden:**/*.expect -> one.out").getRenameTo()?.toString()).to.equal("one.out");
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

    /* The wildcard rules read the written name alone, so they are enforced here
     * rather than in Validate — which means they also hold for a name that gets
     * no Validate pass: a schema-less global, and a CLI reference. */
    it("rejects unequal wildcard counts, in either direction (a slotted template)", () => {
      expect(parseInvalid("out = *.a -> *.b.*;")).to.deep.equal([
        diagnosticBlock(
          1,
          11,
          "Invalid rename template: selector and template must have equal wildcard counts (1 vs 2)",
          "out = *.a -> *.b.*;"
        ),
      ]);
      expect(parseInvalid("out = *.a.* -> *.b;")).to.deep.equal([
        diagnosticBlock(
          1,
          13,
          "Invalid rename template: selector and template must have equal wildcard counts (2 vs 1)",
          "out = *.a.* -> *.b;"
        ),
      ]);
    });

    /* Numbered back-references: the explicit form of the same replay, which
     * lifts the equal-count rule because each one says which wildcard it takes.
     * (`$1` means a capture only in a template — elsewhere it is the ordinary
     * substitution of a property named `1`, which cannot be declared.) */
    describe("numbered captures", () => {
      it("replays a capture more than once", () => {
        const name = nameOf(parseValid("out = v*.tgz -> v$1/node-v$1.tgz;").properties[0].values[0]);
        expect(name.getRenameTo()?.toString()).to.equal("v$1/node-v$1.tgz");
      });

      it("replays captures out of order, and drops unused ones", () => {
        expect(parseInvalid("out = */*.a -> $2-$1.b;")).to.deep.equal([]);
        expect(parseInvalid("out = */*.a -> only-$2.b;")).to.deep.equal([]);
      });

      it("rejects a reference to a wildcard the selector does not have", () => {
        expect(parseInvalid("out = *.a -> $2.b;")).to.deep.equal([
          diagnosticBlock(1, 11, "Invalid rename template: '$2' is out of range — the selector has 1 wildcard(s)", "out = *.a -> $2.b;"),
        ]);
        expect(parseInvalid("out = a.txt -> $1.b;")).to.deep.equal([
          diagnosticBlock(1, 13, "Invalid rename template: '$1' has no wildcard to replay — the selector has none", "out = a.txt -> $1.b;"),
        ]);
      });

      it("rejects mixing the two replay forms in one template", () => {
        expect(parseInvalid("out = */*.a -> $1-*.b;")).to.deep.equal([
          diagnosticBlock(
            1,
            13,
            "Invalid rename template: a rename template replays wildcards either positionally ('*') or by number ('$1'), not both",
            "out = */*.a -> $1-*.b;"
          ),
        ]);
      });

      it("leaves '$1' alone outside a rename template", () => {
        /* Still an ordinary substitution there — the reinterpretation is the
         * template's, so nothing else has to know captures exist. */
        const name = nameOf(parseValid("out = $1.b;").properties[0].values[0]);
        expect(name.getVariables()).to.deep.equal(["1"]);
      });
    });

    it("rejects a wildcard picomatch does not capture positionally", () => {
      expect(parseInvalid("out = a?.js -> a?.out;")).to.deep.equal([
        diagnosticBlock(
          1,
          13,
          "Invalid rename template: rename wildcards must be '*' or '**' (found '?')",
          "out = a?.js -> a?.out;"
        ),
      ]);
    });

    it("rejects a ':' in the template (a pattern, not a reference)", () => {
      expect(parseInvalid("out = *.a -> pkg:*.b;")).to.deep.equal([
        diagnosticBlock(
          1,
          11,
          "Invalid rename template: a rename template cannot contain ':'",
          "out = *.a -> pkg:*.b;"
        ),
      ]);
    });

    it("rejects them on a command-line name too (parseName parity)", () => {
      expect(() => parseName("x:*.a -> *.b.*")).to.throw(/equal wildcard counts/);
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
       * construct. The diagnostic survives the CLI parseName path, which lexes
       * the whole name in the parser's constructor. */
      expect(() => parseName("[abc")).to.throw(/Invalid name '\[abc'.*expected \]/);
    });
  });

  /* Bash's extended globs. The leader, each '|' and the closing ')' are their own
   * glob runs with the interior scanned as ordinary name text, which is what
   * keeps a literal-only group (`!(Validation)`) out of the literal path prefix
   * the FS walk bases on — the whole point, since a pure-literal extglob used to
   * be walked as a directory of that name and match nothing. */
  describe("extended globs", () => {
    it("reads each leader as a glob run around a literal interior", () => {
      for (const leader of ["?", "*", "+", "@", "!"]) {
        expect(nameText(parseName(`${leader}(abc)`))).to.equal(`glob(${leader}()+abc+glob())`);
      }
    });

    it("keeps the literal path prefix short of the group", () => {
      /* parts[0] must stop at the leader: getLiteralPathPrefix reads only that,
       * so an extglob can never be swallowed into the walk base. */
      expect(parseName("!(Validation)/**").getLiteralPathPrefix()).to.equal("");
      expect(parseName("src/!(Validation)/**").getLiteralPathPrefix()).to.equal("src/");
      expect(parseName("!(Validation)").hasGlob()).to.equal(true);
    });

    it("separates alternatives on '|' inside a group", () => {
      expect(nameText(parseName("!(a|b)"))).to.equal("glob(!()+a+glob(|)+b+glob())");
    });

    it("scans the interior as ordinary name text — wildcards, classes, variables", () => {
      /* A group's structural runs merge with an adjacent interior glob (the
       * builder collapses same-kind neighbours), so '!(' + '[ab]' reads as one
       * run — the rendered pattern is the same either way. */
      expect(nameText(parseName("!(V*)"))).to.equal("glob(!()+V+glob(*))");
      expect(nameText(parseName("!([ab])"))).to.equal("glob(!([ab]))");
      expect(nameText(parseName("!(${X})"))).to.equal("glob(!()+var(X)+glob())");
    });

    it("nests groups", () => {
      expect(nameText(parseName("!(a|@(b|c))"))).to.equal("glob(!()+a+glob(|@()+b+glob(|)+c+glob()))");
      /* What matters downstream is that it renders back to the written glob. */
      expect(parseName("!(a|@(b|c))").toString()).to.equal("!(a|@(b|c))");
    });

    it("reads '**(' as a wildcard then a leader, as bash does", () => {
      expect(nameText(parseName("**(a)"))).to.equal("glob(**()+a+glob())");
    });

    it("leaves the leader characters literal when no '(' abuts", () => {
      /* Otherwise ordinary name text: a repository reference, a build-metadata
       * version, and — as in bash — a bare '!', which is NOT a negation. */
      expect(nameText(parseName("@npm:pkg"))).to.equal("@npm:pkg");
      expect(nameText(parseName("1.0.0+build"))).to.equal("1.0.0+build");
      expect(nameText(parseName("!literal"))).to.equal("!literal");
      expect(parseName("!literal").hasGlob()).to.equal(false);
    });

    it("leaves ')' and '|' literal outside a group", () => {
      expect(nameText(parseName("foo(1).txt"))).to.equal("foo(1).txt");
      expect(nameText(parseName("a|b"))).to.equal("a|b");
      expect(parseName("a|b").hasGlob()).to.equal(false);
    });

    it("rejects an unterminated group, positioned at its leader", () => {
      /* Bash degrades this to literal text; a build script says what it means,
       * and the parallel '[' construct already errors. Quoting still names such
       * a file. The caret sits on the outermost unclosed leader. */
      expect(parseInvalid("srcs = src:!(Validation/**;")).to.deep.equal([
        diagnosticBlock(
          1,
          12,
          "Unterminated extglob group '!(', expected ')' (quote it to match literally)",
          "srcs = src:!(Validation/**;"
        ),
      ]);
      expect(() => parseName("!(abc")).to.throw(/Unterminated extglob group '!\('/);
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
      expect(entries.map(prop => prop.name.toBaseString())).to.deep.equal(["author", "repository"]);
      expect(contents.properties[0].name.toBaseString()).to.equal("AFTER");
    });

    it("parses a nested block and a list of blocks", () => {
      const values = parseValid(
        "js_bundle b {\n  meta = { repository = { type = git; url = u; }; maintainers = { name = a; } { name = b; }; }\n}"
      ).targets[0].properties[0].values;
      const entries = blockEntries(entriesOf(values[0]));
      const repository = entries[0];
      expect(repository.name.toBaseString()).to.equal("repository");
      expect(repository.values).to.have.lengthOf(1);
      expect(blockEntries(entriesOf(repository.values[0])).map(prop => prop.name.toBaseString())).to.deep.equal(["type", "url"]);
      const maintainers = entries[1];
      expect(maintainers.name.toBaseString()).to.equal("maintainers");
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
      expect(entry.kind === DeclKind.Property && entry.name.toBaseString()).to.equal("description");
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

    it("reports nesting past the depth limit as a diagnostic, not a stack overflow", () => {
      const depth = 50_000;
      const text = `js_bundle b {\n  defines = ${"{ k = ".repeat(depth)}v${" }".repeat(depth)};\n}`;
      const errors = parseInvalid(text);
      expect(errors.length).to.be.greaterThan(0);
      expect(errors[0]).to.contain("Block nesting is too deep");
    });
  });

  it("skips a UTF-8 BOM rather than reporting it as an unexpected character", () => {
    expect(summarize(parseValid("\uFEFFwhich = relative;"))).to.deep.equal(summary({ properties: { which: ["relative"] } }));
  });

  it("reports a duplicate targetdef property rather than silently taking the last", () => {
    const errors = parseInvalid("targetdef t { srcs = FILES; srcs = STRING; }");
    expect(errors).to.deep.equal([
      diagnosticBlock(1, 29, "Duplicate property 'srcs' in targetdef", "targetdef t { srcs = FILES; srcs = STRING; }"),
    ]);
  });

  /* The decl-position reading of the `<k=v>` facet: on a use it selects a
   * configuration (a requirement), on a declaration it matches one (a guard). */
  describe("constraint guards", () => {
    /** The guard on a decl, rendered `KEY=value, …` (empty string if unguarded). */
    function guardText(decl: IPropertyDecl): string {
      return decl.name.getConstraints().map(([key, value]) => `${key}=${value.toString()}`).join(", ");
    }

    it("parses a guard on a target's property key", () => {
      const target = parseValid("library l {\n  srcs = base.c;\n  srcs<TARGET=*-linux-*> = epoll.c;\n}").targets[0];
      expect(target.properties.map(prop => prop.name.toBaseString())).to.deep.equal(["srcs", "srcs"]);
      expect(target.properties.map(guardText)).to.deep.equal(["", "TARGET=*-linux-*"]);
    });

    it("parses a guard on a global", () => {
      const properties = parseValid("TSC<TARGET=*-windows-*> = tsc.exe;").properties;
      expect(properties.map(guardText)).to.deep.equal(["TARGET=*-windows-*"]);
    });

    it("parses a conjunction of guard keys", () => {
      const target = parseValid("library l {\n  srcs<TARGET=*-linux-*, BUILD_TYPE=release> = fast.c;\n}").targets[0];
      expect(guardText(target.properties[0])).to.equal("TARGET=*-linux-*, BUILD_TYPE=release");
    });

    it("distributes a guard block over the declarations it contains", () => {
      const target = parseValid("library l {\n  srcs = base.c;\n  <TARGET=*-linux-*> {\n    srcs = epoll.c;\n    deps = libaio;\n  }\n}").targets[0];
      expect(target.properties.map(prop => prop.name.toBaseString())).to.deep.equal(["srcs", "srcs", "deps"]);
      /* Sugar only: the block leaves no trace beyond the guard on each decl. */
      expect(target.properties.map(guardText)).to.deep.equal(["", "TARGET=*-linux-*", "TARGET=*-linux-*"]);
    });

    it("distributes a top-level guard block over globals", () => {
      const properties = parseValid("<TARGET=*-windows-*> {\n  TSC = tsc.exe;\n}").properties;
      expect(properties.map(prop => prop.name.toBaseString())).to.deep.equal(["TSC"]);
      expect(properties.map(guardText)).to.deep.equal(["TARGET=*-windows-*"]);
    });

    it("conjoins a declaration's own guard with the enclosing block's", () => {
      const target = parseValid("library l {\n  <TARGET=*-linux-*> {\n    srcs<BUILD_TYPE=release> = fast.c;\n  }\n}").targets[0];
      expect(guardText(target.properties[0])).to.equal("TARGET=*-linux-*, BUILD_TYPE=release");
    });

    it("rejects a key guarded by both an enclosing block and the declaration", () => {
      const errors = parseInvalid("library l {\n  <TARGET=*-linux-*> {\n    srcs<TARGET=*-apple-*> = kqueue.c;\n  }\n}");
      expect(errors).to.have.lengthOf(1);
      expect(errors[0]).to.contain("Constraint 'TARGET' is guarded on twice");
    });

    it("does not distribute a guard block into a map value", () => {
      const target = parseValid("js_bundle b {\n  <TARGET=*-linux-*> {\n    defines = { DEBUG = true; };\n  }\n}").targets[0];
      const entries = entriesOf(target.properties[0].values[0]) as IPropertyDecl[];
      expect(guardText(target.properties[0])).to.equal("TARGET=*-linux-*");
      /* The block guards the property, not the entries of the map it holds. */
      expect(entries.map(guardText)).to.deep.equal([""]);
    });

    /* The transposition `deps = mylib<TARGET=*-linux-*>` for
     * `deps<TARGET=*-linux-*> = mylib`. A requirement names a configuration to build
     * under, and constraint values are exact, so a pattern there is meaningless
     * — which is what makes the commonest form of the mistake diagnosable. */
    it("rejects a pattern in a use-position requirement", () => {
      const errors = parseInvalid("library l {\n  deps = mylib<TARGET=*-linux-*>;\n}");
      expect(errors).to.have.lengthOf(1);
      expect(errors[0]).to.contain("Constraint 'TARGET' is required as a pattern, but a requirement names an exact configuration");
      expect(errors[0]).to.contain("did you mean a guard on the property");
    });

    it("still accepts an exact value in a use-position requirement", () => {
      const target = parseValid("library l {\n  deps = mylib<BUILD_TYPE=release>;\n}").targets[0];
      const value = target.properties[0].values[0];
      expect(isNameValue(value) && value.value.getConstraints().map(([key]) => key)).to.deep.equal(["BUILD_TYPE"]);
    });

    it("guards a reference-shaped key, the facet meaning the same there", () => {
      /* A key is a key: a `sync` coordinate's facet is read in DECL position
       * like any other, so it guards the member rather than requiring a
       * configuration of
       * the coordinate (which, naming a publish destination, could not mean
       * anything). Its value may therefore be a pattern. */
      const target = parseValid("sync rel {\n  @npm:pkg:1.0<TARGET=*-linux-*> = content;\n}").targets[0];
      expect(target.properties[0].name.toBaseString()).to.equal("@npm:pkg:1.0");
      expect(guardText(target.properties[0])).to.equal("TARGET=*-linux-*");
    });

    it("rejects a rename on a property key", () => {
      /* A rename says what to call what a name selects; a key selects nothing —
       * it IS the name. */
      const errors = parseInvalid("library l {\n  srcs -> out = a.c;\n}");
      expect(errors).to.have.lengthOf(1);
      expect(errors[0]).to.contain("a property key cannot carry a rename");
    });

    it("reports a guard that does not abut its property name", () => {
      const errors = parseInvalid("library l {\n  srcs <TARGET=*-linux-*> = epoll.c;\n}");
      expect(errors).to.have.lengthOf(1);
      expect(errors[0]).to.contain("A constraint guard must abut the property name");
    });
  });
});
