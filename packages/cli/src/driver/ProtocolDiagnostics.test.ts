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
import { EMPTY_FILESET, type IFile, type ISourceSpan, StringReader } from "@fabr-build/core";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { documentOf, rangeOf } from "./ProtocolDiagnostics";

describe("rangeOf", () => {
  it("counts a range's characters in UTF-16 code units, as a client counts them", () => {
    const text = "X = \u{1F600} b;\nnext";
    const reader = new StringReader(text);
    while (!reader.eof()) {
      reader.next();
    }
    const offset = text.indexOf("b");
    expect(rangeOf({ fs: EMPTY_FILESET, file: "BUILD.fabr", reader, offset, endOffset: offset + 1 })).to.deep.equal({
      start: { line: 0, character: 7 },
      end: { line: 0, character: 8 },
    });
  });
});

describe("documentOf", () => {
  const reader = new StringReader("");
  const at = (readFrom?: IFile): ISourceSpan => ({ fs: EMPTY_FILESET, file: "@acme/rules:lib/X.fabr", reader, offset: 0, readFrom });

  it("names a build file by where the file it was read from lies", () => {
    const installed = path.join(os.tmpdir(), "acme", "lib", "X.fabr");
    const file = { getDisplayName: () => installed, getAbsPath: () => "/pool/blob" } as unknown as IFile;
    expect(documentOf("/project", at(file))).to.equal(pathToFileURL(installed).href);
  });

  it("names one whose file has no path for a name by the file's own path, and one read from no file from the project's root", () => {
    const built = { getDisplayName: () => "lib/X.fabr", getAbsPath: () => "/pool/blob" } as unknown as IFile;
    expect(documentOf("/project", at(built))).to.equal(pathToFileURL("/pool/blob").href);
    expect(documentOf("/project", { ...at(), file: "BUILD.fabr" })).to.equal(
      pathToFileURL(path.resolve("/project", "BUILD.fabr")).href
    );
  });
});
