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
import * as crypto from "node:crypto";
import { Readable } from "node:stream";
import { IntegrityError } from "@fabr-build/core";
import { expectedTarballDigest, parseMetadataResponse, verifyTarballStream } from "./NPMProtocol";

describe("parseMetadataResponse", () => {
  function doc(overrides: Record<string, unknown>): Buffer {
    return Buffer.from(
      JSON.stringify({ name: "pkg", version: "1.0.0", dist: { tarball: "https://example.com/pkg-1.0.0.tgz" }, ...overrides })
    );
  }

  it("accepts a well-formed version document", () => {
    const meta = parseMetadataResponse(doc({ dependencies: { lodash: "^4.0.0" } }), "pkg/1.0.0");
    expect(meta.name).to.equal("pkg");
  });

  it("rejects a document whose own name is invalid", () => {
    /* The document's name becomes the delivered identity (and mount path).
     * Thrown from the fetch's process callback, so the document never enters
     * the cache — the validate-before-cache invariant. Dependency names are
     * deliberately NOT checked: a dep key either fails to resolve (ordinary
     * error) or resolves to a document validated by this same check. */
    expect(() => parseMetadataResponse(doc({ name: "../evil" }), "pkg/1.0.0")).to.throw(/Invalid package name/);
    expect(() => parseMetadataResponse(doc({ dependencies: { "../evil": "^1.0.0" } }), "pkg/1.0.0")).to.not.throw();
  });
});

describe("expectedTarballDigest", () => {
  it("prefers the strongest SRI algorithm over a weaker one and the legacy shasum", () => {
    expect(expectedTarballDigest({ integrity: "sha256-aaa sha512-bbb", shasum: "ccc" })).to.deep.equal({
      algorithm: "sha512",
      encoding: "base64",
      value: "bbb",
    });
  });

  it("falls back to the legacy sha1 shasum (lowercased) when no SRI is present", () => {
    expect(expectedTarballDigest({ shasum: "ABCDEF01" })).to.deep.equal({
      algorithm: "sha1",
      encoding: "hex",
      value: "abcdef01",
    });
  });

  it("ignores a sha1 SRI entry — sha1 is honored only via shasum", () => {
    expect(expectedTarballDigest({ integrity: "sha1-aaa" })).to.equal(undefined);
  });

  it("is undefined when neither integrity nor shasum is promised", () => {
    expect(expectedTarballDigest({})).to.equal(undefined);
  });
});

describe("verifyTarballStream", () => {
  const bytes = Buffer.from("a plausible tarball payload");
  const sha512 = crypto.createHash("sha512").update(bytes).digest("base64");
  const sha1 = crypto.createHash("sha1").update(bytes).digest("hex");

  /** Feed `bytes` through the hashing pass-through to completion, then verify. */
  async function check(dist: { integrity?: string; shasum?: string }): Promise<void> {
    const { hashing, verify } = verifyTarballStream(dist, "https://example.com/pkg-1.0.0.tgz");
    await new Promise<void>((resolve, reject) => {
      hashing.on("data", () => undefined);
      hashing.on("end", resolve);
      hashing.on("error", reject);
      Readable.from([bytes]).pipe(hashing);
    });
    verify();
  }

  it("passes a tarball matching its sha512 SRI", async () => {
    await check({ integrity: `sha512-${sha512}` });
  });

  it("passes a tarball matching its legacy sha1 shasum", async () => {
    await check({ shasum: sha1 });
  });

  it("passes when the metadata promises no digest", async () => {
    await check({});
  });

  it("throws IntegrityError on a digest mismatch", async () => {
    const wrong = crypto.createHash("sha512").update("something else").digest("base64");
    let thrown: unknown;
    await check({ integrity: `sha512-${wrong}` }).catch(err => (thrown = err));
    expect(thrown).to.be.instanceOf(IntegrityError);
    expect((thrown as IntegrityError).algorithm).to.equal("sha512");
  });
});
