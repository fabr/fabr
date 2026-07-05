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
import { parseBuildString } from "./Parser";

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
      "PROJECT.fabr:1:12:error:Read EOF but expected Name, ';', or '}'\nhello=world\n           ^\n",
    ]);
    expect(parseInvalid("foo/bar=woo;")).to.deep.equal([
      "PROJECT.fabr:1:1:error:Read Path but expected Statement\nfoo/bar=woo;\n^\n",
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

  it("Missing Close Brace", () => {
    expect(parseInvalid("js_package fabr {\nsrcs=src:**/*.ts; deps= es2019\n node \nunicode-properties;")).to.deep.equal([
      "PROJECT.fabr:4:20:error:Read EOF but expected Identifier or '}'\nunicode-properties;\n                   ^\n",
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

  it("Plugin Decl with invalid name", () => {
    expect(parseInvalid("plugin ${TEST_PLUGIN};")).to.deep.equal([
      "PROJECT.fabr:1:8:error:Plugin names must be plain target names (no glob patterns or variables)\nplugin ${TEST_PLUGIN};\n       ^\n",
    ]);
    expect(parseInvalid("plugin @fabr/*;")).to.deep.equal([
      "PROJECT.fabr:1:8:error:Plugin names must be plain target names (no glob patterns or variables)\nplugin @fabr/*;\n       ^\n",
    ]);
  });
});
