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
import { IFile } from "../core/FileSet";
import { MemoryFile } from "../core/MemoryFS";
import { isJsonObject, parseJson, readJsonFile, toJsonObject } from "./Json";

/** A file that names itself, the way a real source or artifact file does. */
function namedFile(name: string, content: string): IFile {
  return Object.assign(MemoryFile.from(content), { getDisplayName: () => name });
}

/** Settle a Computable synchronously (in-memory files settle immediately). */
function settled<T>(value: { then(fn: (v: T) => void, onErr: (e: Error) => void): unknown }): { value?: T; error?: string } {
  const out: { value?: T; error?: string } = {};
  value.then(
    v => {
      out.value = v;
    },
    err => {
      out.error = err.message;
    }
  );
  return out;
}

describe("isJsonObject", () => {
  it("accepts only a JSON object", () => {
    expect(isJsonObject({})).to.equal(true);
    expect(isJsonObject({ a: 1 })).to.equal(true);
    /* Both are `typeof === "object"` and neither has fields to read. */
    expect(isJsonObject(null)).to.equal(false);
    expect(isJsonObject([])).to.equal(false);
    expect(isJsonObject("{}")).to.equal(false);
    expect(isJsonObject(undefined)).to.equal(false);
  });
});

describe("toJsonObject", () => {
  it("passes an object through, and refuses anything else with a reason", () => {
    expect(toJsonObject({ name: "pkg" })).to.deep.equal({ name: "pkg" });
    for (const document of [null, [], "just a string", 42]) {
      expect(() => toJsonObject(document)).to.throw(/expected a JSON object/);
    }
  });
});

describe("parseJson", () => {
  it("reads a document from a string or a Buffer (a fetched body has no file)", () => {
    expect(parseJson('{"name":"pkg"}', "a document", toJsonObject)).to.deep.equal({ name: "pkg" });
    expect(parseJson(Buffer.from('{"name":"pkg"}'), "a document", toJsonObject)).to.deep.equal({ name: "pkg" });
  });

  it("attributes malformed JSON to the document, keeping the parser's reason", () => {
    expect(() => parseJson("<html>502</html>", "response from the registry", toJsonObject)).to.throw(
      /Invalid JSON in response from the registry: /
    );
  });

  it("attributes the converter's refusal to the document too", () => {
    /* A caller holds a value, never a maybe — so `null`, an array and a bare
     * scalar are errors here rather than each caller's problem downstream. */
    for (const document of ["null", "[]", '"just a string"', "42"]) {
      expect(() => parseJson(document, "a document", toJsonObject)).to.throw(/Invalid a document: expected a JSON object/);
    }
  });
});

describe("readJsonFile", () => {
  /* A converter (not a boolean predicate) so that it can say what was wrong. */
  const toPackageName = (json: unknown): string => {
    if (!isJsonObject(json) || typeof json.name !== "string") {
      throw new Error("no package name");
    }
    return json.name;
  };

  it("reads a document from a file", () => {
    const { value, error } = settled(readJsonFile(namedFile("package.json", '{"name":"pkg"}'), toPackageName));
    expect(error).to.equal(undefined);
    expect(value).to.equal("pkg");
  });

  it("attributes an error to the file, which names itself", () => {
    const { error } = settled(readJsonFile(namedFile("/src/proj/package.json", "not json"), toJsonObject));
    expect(error).to.match(/^Invalid JSON in \/src\/proj\/package.json: /);
  });

  it("attributes the converter's own reason to the file", () => {
    expect(settled(readJsonFile(namedFile("package.json", "{}"), toPackageName)).error).to.equal(
      "Invalid package.json: no package name"
    );
  });
});
