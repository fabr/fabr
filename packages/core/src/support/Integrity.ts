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
import { Transform } from "stream";
import { IntegrityError } from "../core/Errors";

/**
 * Subresource Integrity (https://www.w3.org/TR/SRI/) — `<algorithm>-<base64>`,
 * the digest form npm's `dist.integrity`, Bazel's `integrity =` and Nix all
 * use. Ordered strongest-first: a value listing several takes the strongest.
 */
export const SRI_ALGORITHMS = ["sha512", "sha384", "sha256"] as const;

/** A digest to check content against: what to hash it with, and the expected
 *  result in that encoding. */
export interface ExpectedDigest {
  readonly algorithm: string;
  readonly encoding: "base64" | "hex";
  readonly value: string;
}

/** True for a token shaped like an SRI digest. Distinguishes an integrity value
 *  from a URL without relying on the order the two were written in. */
export function isIntegrity(value: string): boolean {
  return SRI_ALGORITHMS.some(algorithm => value.startsWith(`${algorithm}-`));
}

/**
 * The strongest digest an SRI string states, or undefined if it states none in
 * an algorithm we know. A value may list several space-separated entries; a
 * hash fabr cannot compute is not an error here (the caller decides whether
 * "nothing checkable" is acceptable — npm metadata often carries only the
 * legacy sha1 `dist.shasum`, whereas a written declaration should insist).
 */
export function parseIntegrity(integrity: string): ExpectedDigest | undefined {
  const entries = integrity.trim().split(/\s+/);
  for (const algorithm of SRI_ALGORITHMS) {
    const match = entries.find(entry => entry.startsWith(`${algorithm}-`));
    if (match) {
      return { algorithm, encoding: "base64", value: match.slice(algorithm.length + 1) };
    }
  }
  return undefined;
}

/**
 * Prepare verification of a stream against `expected`: a pass-through that
 * hashes as bytes flow, plus a `verify` to call once the stream has been fully
 * consumed. Hashing on the way past is what lets the check gate a *cache
 * commit* — run `verify` inside the fetch `process` callback and a mismatched
 * download never becomes an entry. An undefined `expected` yields an identity
 * pass-through and a no-op verify (nothing promised, nothing to check).
 *
 * `resource` names the thing being checked in the error (a URL, ordinarily).
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
    if (actual !== expected.value) {
      throw new IntegrityError(resource, expected.algorithm, expected.value, actual);
    }
  };
  return { hashing, verify };
}
