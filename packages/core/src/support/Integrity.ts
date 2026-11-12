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
import { Readable, Transform } from "stream";
import { IntegrityError, toError } from "../core/Errors";

/**
 * The Subresource Integrity (https://www.w3.org/TR/SRI/) algorithms fabr
 * checks, strongest first. An SRI digest is `<algorithm>-<base64>`, as npm's
 * `dist.integrity` writes one.
 */
export const SRI_ALGORITHMS = ["sha512", "sha384", "sha256"] as const;

/** A digest to check content against: what to hash it with, and the expected
 *  result in that encoding. */
export interface ExpectedDigest {
  readonly algorithm: string;
  readonly encoding: "base64" | "hex";
  readonly value: string;
  /** Further digests of the same algorithm, any of which content may match
   *  instead (SRI allows several per algorithm). */
  readonly alternates?: readonly string[];
}

/** @return true if `value` begins as an SRI digest of an algorithm in
 *  {@link SRI_ALGORITHMS}, otherwise false. */
export function isIntegrity(value: string): boolean {
  return SRI_ALGORITHMS.some(algorithm => value.startsWith(`${algorithm}-`));
}

/**
 * Parse the strongest digest an SRI string states, of its space-separated
 * entries. Entries of other algorithms are ignored.
 * @return the digest, or undefined where no entry is of an algorithm in
 *   {@link SRI_ALGORITHMS}: whether that is an error is the caller's to judge.
 */
export function parseIntegrity(integrity: string): ExpectedDigest | undefined {
  const entries = integrity.trim().split(/\s+/);
  for (const algorithm of SRI_ALGORITHMS) {
    /* Every entry of the strongest algorithm stated, each without its
     * `?<options>` suffix (SRI defines no options). */
    const values = entries
      .filter(entry => entry.startsWith(`${algorithm}-`))
      .map(entry => entry.slice(algorithm.length + 1).replace(/\?.*$/, ""));
    if (values.length > 0) {
      /* Set `alternates` only where there are some. */
      return { algorithm, encoding: "base64", value: values[0], ...(values.length > 1 ? { alternates: values.slice(1) } : {}) };
    }
  }
  return undefined;
}

/**
 * Make a check of a stream against `expected`: `hashing`, a pass-through that
 * hashes the bytes going through it, and `verify`, to call once they all have,
 * which throws an {@link IntegrityError} naming `resource` (a URL) where they
 * do not match. Call `verify` in a fetch's `process` callback so a download
 * that does not match is never cached. Where `expected` is undefined, `verify`
 * checks nothing.
 */
export function verifyingStream(expected: ExpectedDigest | undefined, resource: string): { hashing: Transform; verify: () => void } {
  const hash = expected ? crypto.createHash(expected.algorithm) : undefined;
  const hashing = new Transform({
    transform(chunk, _encoding, callback): void {
      hash?.update(chunk);
      callback(undefined, chunk);
    },
  });
  const verify = (): void => {
    if (!expected || !hash) {
      return;
    }
    const actual = hash.digest(expected.encoding);
    const acceptable = [expected.value, ...(expected.alternates ?? [])];
    if (!acceptable.includes(actual)) {
      throw new IntegrityError(resource, expected.algorithm, acceptable.join(" | "), actual);
    }
  };
  return { hashing, verify };
}

/**
 * Check a download's `content` against `expected` as it streams (see
 * {@link verifyingStream}): `stream` carries the bytes on, and fails where
 * `content` fails, and `verify` is to be called once they have all passed,
 * before anything is kept.
 */
export function verifiedStream(
  content: Readable,
  expected: ExpectedDigest | undefined,
  resource: string
): { stream: Transform; verify: () => void } {
  const { hashing, verify } = verifyingStream(expected, resource);
  content.on("error", err => hashing.destroy(toError(err)));
  content.pipe(hashing);
  return { stream: hashing, verify };
}
