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

/*
 * Content classification by magic bytes — the home of {@link IFile.mime}'s
 * vocabulary and the one place that knows a format's signature. Deliberately
 * import-free: classification is consulted from the lowest layers (file
 * hashing, the cache store), which must not drag stream/unpack machinery into
 * their import graphs.
 */

/** How many leading bytes classification needs (tar's magic sits at bytes
 * 257–262; everything else is within the first four). */
export const SNIFF_LENGTH = 262;

/* The MIME names fabr's sniffer can assign — the persistent vocabulary of
 * {@link IFile.mime} (written into cache manifests, so additions extend it and
 * never re-number it). Standard names, minimal set: a type earns an entry when
 * something consumes it. */
export const MIME_GZIP = "application/gzip";
export const MIME_TAR = "application/x-tar";
export const MIME_ZIP = "application/zip";
export const MIME_XZ = "application/x-xz";
/** The everything-else classification: every file has a mime; this is "nothing
 * fabr recognizes", NOT an error. */
export const MIME_UNKNOWN = "application/octet-stream";

/**
 * Classify content by its leading bytes (up to {@link SNIFF_LENGTH} of them —
 * fewer is fine, the magic simply won't match). Pure and deterministic: the
 * same bytes always classify the same way, which is what makes the result safe
 * to persist beside the content hash.
 */
export function sniffMime(head: Buffer): string {
  if (head[0] === 0x1f && head[1] === 0x8b && head[2] === 0x08) {
    return MIME_GZIP;
  } else if (head[257] === 0x75 && head[258] === 0x73 && head[259] === 0x74 && head[260] === 0x61 && head[261] === 0x72) {
    return MIME_TAR;
  } else if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    return MIME_ZIP;
  } else if (
    head[0] === 0xfd &&
    head[1] === 0x37 &&
    head[2] === 0x7a &&
    head[3] === 0x58 &&
    head[4] === 0x5a &&
    head[5] === 0x00
  ) {
    return MIME_XZ;
  } else {
    return MIME_UNKNOWN;
  }
}

/** Whether this mime names an archive fabr can expand (see Expand.ts / Unpack.ts). */
export function isArchiveMime(mime: string): boolean {
  return mime === MIME_GZIP || mime === MIME_TAR || mime === MIME_ZIP || mime === MIME_XZ;
}
