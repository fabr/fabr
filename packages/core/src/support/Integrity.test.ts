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

import crypto from "crypto";
import { Readable } from "stream";
import { expect } from "chai";
import { IntegrityError } from "../core/Errors";
import { isIntegrity, parseIntegrity, verifyingStream } from "./Integrity";

const CONTENT = "the quick brown fox";
const sri = (algorithm: string): string => `${algorithm}-${crypto.createHash(algorithm).update(CONTENT).digest("base64")}`;

/** Run `content` through the verifying stream to completion, then verify. */
function check(expected: string | undefined, content = CONTENT): Promise<void> {
  const { hashing, verify } = verifyingStream(expected ? parseIntegrity(expected) : undefined, "http://host/x");
  return new Promise((resolve, reject) => {
    hashing.on("data", () => undefined);
    hashing.on("end", () => {
      try {
        verify();
        resolve();
      } catch (err) {
        reject(err);
      }
    });
    hashing.on("error", reject);
    Readable.from([content]).pipe(hashing);
  });
}

describe("Integrity", () => {
  describe("isIntegrity", () => {
    it("recognizes each SRI algorithm, so url and digest need no fixed order", () => {
      expect(isIntegrity(sri("sha256"))).to.equal(true);
      expect(isIntegrity(sri("sha384"))).to.equal(true);
      expect(isIntegrity(sri("sha512"))).to.equal(true);
    });

    it("rejects a URL and a bare/legacy digest", () => {
      expect(isIntegrity("https://codeload.github.com/o/r/tar.gz/abc")).to.equal(false);
      expect(isIntegrity("sha1-deadbeef")).to.equal(false);
      expect(isIntegrity("deadbeef")).to.equal(false);
    });
  });

  describe("parseIntegrity", () => {
    it("takes the strongest of several entries", () => {
      const parsed = parseIntegrity(`${sri("sha256")} ${sri("sha512")}`);
      expect(parsed?.algorithm).to.equal("sha512");
      expect(parsed?.encoding).to.equal("base64");
    });

    it("yields undefined when no known algorithm is stated", () => {
      expect(parseIntegrity("sha1-abc")).to.equal(undefined);
      expect(parseIntegrity("")).to.equal(undefined);
    });
  });

  describe("verifyingStream", () => {
    it("passes matching content", async () => {
      await check(sri("sha256"));
      await check(sri("sha512"));
    });

    it("throws IntegrityError naming the resource when content differs", async () => {
      let caught: unknown;
      await check(sri("sha256"), "something else").catch(err => (caught = err));
      expect(caught).to.be.instanceOf(IntegrityError);
      expect((caught as IntegrityError).url).to.equal("http://host/x");
      expect((caught as IntegrityError).algorithm).to.equal("sha256");
    });

    it("passes content through unchanged", async () => {
      const { hashing } = verifyingStream(parseIntegrity(sri("sha256")), "http://host/x");
      const chunks: Buffer[] = [];
      hashing.on("data", (chunk: Buffer) => chunks.push(chunk));
      await new Promise<void>(resolve => {
        hashing.on("end", () => resolve());
        Readable.from([CONTENT]).pipe(hashing);
      });
      expect(Buffer.concat(chunks).toString()).to.equal(CONTENT);
    });

    it("checks nothing when no digest is expected", async () => {
      await check(undefined, "anything at all");
    });
  });
});
