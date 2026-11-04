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

import * as crypto from "node:crypto";
import { expect } from "chai";
import { FileSet, MemoryFile, RepositoryWriter, SymlinkFile } from "@fabr-build/core";
import { checkedPublishKey, checksumOf, contentTypeOf, etagOf, packageS3Member, S3PublishRef, storedObjects } from "./S3Publish";

const WRITER = {} as RepositoryWriter;

function files(entries: Record<string, string>): FileSet {
  return new FileSet(new Map(Object.entries(entries).map(([name, text]) => [name, MemoryFile.from(text)])));
}

function namesOf(set: FileSet): string[] {
  return [...set].map(([name]) => name);
}

describe("an S3 publish coordinate", () => {
  it("takes a key, or a prefix ending in '/'", () => {
    expect(checkedPublishKey("tools/tool.tgz", "x")).to.equal("tools/tool.tgz");
    expect(new S3PublishRef(WRITER, "acme", "site/v3/").isPrefix).to.equal(true);
    expect(new S3PublishRef(WRITER, "acme", "tools/tool.tgz").isPrefix).to.equal(false);
  });

  it("refuses a key that names nothing, has an empty, '.' or '..' part, or is written with ':'", () => {
    for (const [key, reason] of [
      ["", "it names no key"],
      ["/", "it names no key"],
      ["a//b", "no empty, '.' or '..' part"],
      ["a/../b", "no empty, '.' or '..' part"],
      ["a:b", "written with '/' between its parts"],
    ]) {
      expect(() => checkedPublishKey(key, "s3:acme:x"), key).to.throw(reason);
    }
  });

  it("is written as the account names it", () => {
    expect(new S3PublishRef(WRITER, "acme", "site/v3/", "@aws").toString()).to.equal("@aws:s3:acme:site/v3/");
    expect(new S3PublishRef(WRITER, "acme", "x").withRepositoryName("@prod").toString()).to.equal("@prod:s3:acme:x");
  });
});

describe("packaging a member for S3", () => {
  it("stores a prefix's content under it, each file by its name", () => {
    const destination = new S3PublishRef(WRITER, "acme", "site/v3/");
    const carrier = packageS3Member({ destination, content: files({ "index.html": "<p>", "css/a.css": "a{}" }) });
    expect(namesOf(carrier)).to.deep.equal(["index.html", "css/a.css"]);
    expect(storedObjects(carrier).map(({ key }) => key)).to.deep.equal(["site/v3/index.html", "site/v3/css/a.css"]);
  });

  it("stores an object's one file at its key", () => {
    const destination = new S3PublishRef(WRITER, "acme", "tools/tool.tgz");
    const carrier = packageS3Member({ destination, content: files({ "build/out.tgz": "tgz" }) });
    expect(namesOf(carrier)).to.deep.equal(["tool.tgz"]);
    expect(storedObjects(carrier).map(({ key }) => key)).to.deep.equal(["tools/tool.tgz"]);
  });

  it("refuses an object whose content is not one file", () => {
    const destination = new S3PublishRef(WRITER, "acme", "tools/tool.tgz", "@aws");
    expect(() => packageS3Member({ destination, content: files({ a: "a", b: "b" }) })).to.throw(
      "cannot publish @aws:s3:acme:tools/tool.tgz: an object's content must be one file, and it holds 2"
    );
  });

  it("refuses a symbolic link", () => {
    const destination = new S3PublishRef(WRITER, "acme", "site/");
    const content = new FileSet(new Map([["latest", new SymlinkFile("v3")]]));
    expect(() => packageS3Member({ destination, content })).to.throw("'latest' is a symbolic link");
  });
});

describe("an S3 object's metadata", () => {
  it("is typed by its key's extension, else as its content sniffs", () => {
    expect(contentTypeOf("site/index.html", MemoryFile.from("<p>"))).to.equal("text/html; charset=utf-8");
    expect(contentTypeOf("data/blob", MemoryFile.from("plain"))).to.equal(MemoryFile.from("plain").mime);
  });

  it("has the content's SHA-256 as its checksum, base64-encoded", () => {
    expect(checksumOf(MemoryFile.from("hello"))).to.equal(crypto.createHash("sha256").update("hello").digest("base64"));
  });

  it("has the ETag a single PutObject of its content gets", async () => {
    const expected = `"${crypto.createHash("md5").update("hello").digest("hex")}"`;
    expect(await etagOf(MemoryFile.from("hello"))).to.equal(expected);
  });
});
