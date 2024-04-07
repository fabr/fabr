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

import { EMPTY_FILESET } from "../core/FileSet";
import { LogFormatter, LogLevel } from "../support/Log";
import { IBuildFileContents } from "./AST";
import { parseBuildString } from "./Parser";

function parseValid(text: string): IBuildFileContents {
  const errors: string[] = [];
  const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));

  const result = parseBuildString(EMPTY_FILESET, "PROJECT.fabr", text, logger);
  expect(errors).toStrictEqual([]);
  return result;
}

function parseInvalid(text: string): string[] {
  const errors: string[] = [];
  const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));

  parseBuildString(EMPTY_FILESET, "PROJECT.fabr", text, logger);
  return errors;
}

describe("Parser Tests", () => {
  it("Include Decl", () => {
    expect(parseValid("include src/BUILD.FABR;")).toMatchSnapshot();
  });

  it("Property Decl", () => {
    expect(parseValid("tsc=@npm:typescript;\n js_target=es5-commonjs;\nflavours=red green blue;")).toMatchSnapshot();
    expect(parseInvalid("hello=world")).toMatchSnapshot();
    expect(parseInvalid("foo/bar=woo;")).toMatchSnapshot();
  });

  it("Property with Subst var", () => {
    expect(parseValid("A=b; B=${A};")).toMatchSnapshot();
  });

  it("Property with double quotes", () => {
    expect(parseValid('A="a b"; B=a b "cd${A}e";')).toMatchSnapshot();
  });

  it("Property with single quotes", () => {
    expect(parseValid("A='a b'; B=a b '${A}';")).toMatchSnapshot();
  });

  it("Target Decl", () => {
    expect(
      parseValid("js_package fabr {\nsrcs=src:**/*.ts; deps= es2019\n node \nunicode-properties; } empty test {}")
    ).toMatchSnapshot();
    expect(parseValid("js_package @fabr/common {\n  srcs= src:*.ts; }")).toMatchSnapshot();
  });

  it("Missing Close Brace", () => {
    expect(parseInvalid("js_package fabr {\nsrcs=src:**/*.ts; deps= es2019\n node \nunicode-properties;")).toMatchSnapshot();
  });

  it("Optional final semicolon", () => {
    expect(parseValid("npm_dep @npm {\n  deps = chokidar:3.5.3 picomatch:2.3.1 unicode-properties:1.3.1\n}")).toMatchSnapshot();
  });

  it("Targetdef", () => {
    expect(parseValid("targetdef js_package {\n  deps = FILES;\n  srcs=FILES REQUIRED;version=STRING}")).toMatchSnapshot();
  });
});
