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
import { isValidPackageName, parseMetadataResponse } from "./NPMProtocol";

describe("isValidPackageName", () => {
  it("accepts real-world names, scoped and legacy-uppercase included", () => {
    for (const name of ["lodash", "@types/node", "@esbuild/darwin-arm64", "JSONStream", "socket.io-client", "co-body"]) {
      expect(isValidPackageName(name), name).to.equal(true);
    }
  });

  it("rejects names that could not be used as the paths they become", () => {
    /* Validity is "already canonical as a path" (the FileSet name rule), because
     * the name is mounted verbatim at node_modules/<name>: a name that
     * canonicalization would rewrite could silently occupy another package's
     * mount point. */
    for (const name of ["../evil", "a/../b", "@scope/../up", "./a", "/rooted", "\\evil", "a\nb", "", ".", ".."]) {
      expect(isValidPackageName(name), JSON.stringify(name)).to.equal(false);
    }
  });

  it("does not police npm's own name grammar", () => {
    /* Un-npm-ish but path-clean names pass: no honest registry hosts them, so
     * they simply 404 at fetch with normal attribution — while enforcing the
     * grammar would risk rejecting legacy names npm itself serves. */
    for (const name of ["a b", "%2e%2e", "UPPER!(case)", "a/b/c", "a".repeat(300)]) {
      expect(isValidPackageName(name), JSON.stringify(name)).to.equal(true);
    }
  });
});

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
