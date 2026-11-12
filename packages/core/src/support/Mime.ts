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
 * Classifying content by its leading bytes: the values of {@link IFile.mime}.
 * Keep this module free of imports: file hashing and the cache store use it.
 */

/** The number of leading bytes classification reads (tar's magic is at bytes
 * 257 to 261). */
export const SNIFF_LENGTH = 262;

/* The MIME types {@link sniffMime} assigns. They are written into cache
 * manifests: add to them, never change one. */
export const MIME_GZIP = "application/gzip";
export const MIME_TAR = "application/x-tar";
export const MIME_ZIP = "application/zip";
export const MIME_XZ = "application/x-xz";
/** The MIME type of a file of no type fabr recognizes. */
export const MIME_UNKNOWN = "application/octet-stream";

/**
 * Classify content by its leading bytes (the first {@link SNIFF_LENGTH}; fewer
 * classify as far as they reach).
 * @return a gzip, tar, zip or xz MIME type, else {@link MIME_UNKNOWN}.
 */
export function sniffMime(head: Buffer): string {
  if (head[0] === 0x1f && head[1] === 0x8b && head[2] === 0x08) {
    return MIME_GZIP;
  } else if (head[257] === 0x75 && head[258] === 0x73 && head[259] === 0x74 && head[260] === 0x61 && head[261] === 0x72) {
    return MIME_TAR;
  } else if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    return MIME_ZIP;
  } else if (head[0] === 0xfd && head[1] === 0x37 && head[2] === 0x7a && head[3] === 0x58 && head[4] === 0x5a && head[5] === 0x00) {
    return MIME_XZ;
  } else {
    return MIME_UNKNOWN;
  }
}

/** @return true if `mime` is of an archive fabr can unpack, otherwise false. */
export function isArchiveMime(mime: string): boolean {
  return mime === MIME_GZIP || mime === MIME_TAR || mime === MIME_ZIP || mime === MIME_XZ;
}
