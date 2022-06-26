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

import { EMPTY_FILESET, FileSet, IFile, IFileSetProvider } from "../core/FileSet";
import { LogFormatter, LogLevel } from "../support/Log";
import { parseBuildString } from "./Parser";

describe("Parser Tests", () => {
  const errors: string[] = [];
  const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));

  const fs = EMPTY_FILESET;

  it("Include Decl", () => {
    errors.length = 0;
    expect(parseBuildString(fs, "BUILD.TOP", "include src/BUILD.FABR;", logger)).toMatchSnapshot();
    expect(errors.length).toBe(0);
  });

  it("Property Decl", () => {
    errors.length = 0;
    expect(
      parseBuildString(fs, "BUILD.TOP", "tsc=@npm:typescript;\n js_target=es5-commonjs;\nflavours=red green blue;", logger)
    ).toMatchSnapshot();
    expect(errors.length).toBe(0);
  });

  it("Target Decl", () => {
    errors.length = 0;
    expect(
      parseBuildString(
        fs,
        "BUILD.TOP",
        "js_package fabr {\nsrcs=src:**/*.ts; deps= es2019\n node \nunicode-properties; } empty test {}",
        logger
      )
    ).toMatchSnapshot();
    expect(errors.length).toBe(0);

    expect(parseBuildString(fs, "BUILD.FABR", "js_package @fabr/common {\n  srcs= src:*.ts; }", logger)).toMatchSnapshot();
    expect(errors.length).toBe(0);
  });

  it("Missing Close Brace", () => {
    errors.length = 0;
    expect(
      parseBuildString(fs, "BUILD.TOP", "js_package fabr {\nsrcs=src:**/*.ts; deps= es2019\n node \nunicode-properties;", logger)
    ).toMatchSnapshot();
    expect(errors).toMatchSnapshot();
  });
});
