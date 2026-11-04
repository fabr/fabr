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

import { FabrError } from "@fabr-build/core";

/** A digest as it is written in a reference and in OCI's documents: `sha256:` and 64 lowercase hex digits. */
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** The distribution spec's repository name: lowercase components separated by `.`, `_`, `__` or dashes, joined by `/`. */
const NAME_PATTERN = /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*)*$/;

/** The distribution spec's tag. */
const TAG_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/;

/** What a reference into an `oci_repository` names, split off what follows it. */
export interface IImageReference {
  /** The repository's name as written (`node`, `myorg/app`). */
  readonly name: string;
  /** The tag or digest the image is named by; absent where the name stands alone. */
  readonly version?: string;
  /** Where the rest of the reference begins, after its separator; absent where there is none. */
  readonly rest?: { readonly at: number; readonly separator: ":" | "/" };
}

/** @return true if `version` is a digest (`sha256:<64 hex>`), otherwise false: any other version is a tag. */
export function isDigest(version: string): boolean {
  return DIGEST_PATTERN.test(version);
}

/**
 * Split the literal text of a reference into an image's name, its tag or
 * digest, and where what selects in it begins: `node:22`, `node:22:etc/os-release`,
 * `node:22/etc/os-release`, `myorg/app:sha256:<hex>`, or `node` alone. A version
 * is a digest only when it is `sha256:` and 64 lowercase hex digits.
 */
export function splitImageReference(literal: string, written: string): IImageReference {
  const colon = literal.indexOf(":");
  const name = colon === -1 ? literal : literal.substring(0, colon);
  if (!NAME_PATTERN.test(name)) {
    throw new FabrError(`'${written}' does not name an image`).withHelp(
      "an image's name is lowercase letters, digits and `.`, `_` or `-`, its parts joined by `/`, as in 'node' or 'myorg/app'"
    );
  }
  if (colon === -1) {
    return { name };
  }
  const start = colon + 1;
  const digest = /^sha256:[0-9a-f]{64}/.exec(literal.substring(start));
  const end = digest !== null ? start + digest[0].length : endOfTag(literal, start);
  const version = literal.substring(start, end);
  if (digest === null && !TAG_PATTERN.test(version)) {
    throw new FabrError(`'${written}' does not name a tag of '${name}'`).withHelp(
      "a tag is letters, digits and `.`, `_` or `-`, as in 'node:22-bookworm-slim'; a digest is 'sha256:' and 64 hex digits"
    );
  }
  if (end === literal.length) {
    return { name, version };
  }
  return { name, version, rest: { at: end + 1, separator: literal[end] as ":" | "/" } };
}

/** @return where the tag starting at `start` ends: at the next `:` or `/`, else the end of `literal`. */
function endOfTag(literal: string, start: number): number {
  const found = literal.substring(start).search(/[:/]/);
  return found === -1 ? literal.length : start + found;
}
