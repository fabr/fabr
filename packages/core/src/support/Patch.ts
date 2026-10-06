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

import { applyPatch, parsePatch, StructuredPatch } from "diff";
import { FabrError } from "../core/Errors";

/**
 * One file's change in a patch: `from` → `to`, each a path within the tree
 * the patch applies to. A created file has no `from`, a deleted one no `to`,
 * and a renamed one two different names.
 */
export interface FilePatch {
  readonly from: string | undefined;
  readonly to: string | undefined;
  /** The permission bits the patch gives the file, where it states them. */
  readonly mode: number | undefined;
  /**
   * @return `content` — the text of `from`, the empty string for a created
   * file — with this file's hunks applied. Hunks match exactly, at the line
   * they state or wherever else their context is found; the text keeps its own
   * line endings.
   * @throws a {@link FabrError} naming the hunks that do not apply.
   */
  apply(content: string): string;
}

/* The two ways git writes a binary change; neither carries hunks. */
const BINARY_MARKER = /^(?:GIT binary patch|Binary files .* differ)$/;
const GIT_HEADER = /^diff --git /;
const NO_FILE = "/dev/null";

/**
 * Parse `text` — a unified diff, git-style or plain — into the file changes it
 * makes, in order. `strip` is the number of leading path components each name
 * loses, as `patch -p` counts them: 1 for the `a/`…`b/` names git writes.
 *
 * @param what names the patch in errors.
 * @throws a {@link FabrError} for a binary change, a change with nothing to
 * apply, or a name that `strip` leaves empty or that leaves the tree.
 */
export function parsePatchFile(text: string, what: string, strip = 1): FilePatch[] {
  let section = "";
  for (const line of text.split(/\r?\n/)) {
    if (GIT_HEADER.test(line)) {
      section = line;
    } else if (BINARY_MARKER.test(line)) {
      throw new FabrError(`${what} changes a binary file, which a patch cannot carry${section === "" ? "" : ` (${section})`}`);
    }
  }
  let parsed: StructuredPatch[];
  try {
    parsed = parsePatch(text);
  } catch (err) {
    throw new FabrError(`${what} is not a unified diff: ${err instanceof Error ? err.message : String(err)}`);
  }
  const changes = parsed.filter(file => file.oldFileName !== undefined || file.newFileName !== undefined);
  if (changes.length === 0) {
    throw new FabrError(`${what} is not a unified diff: it changes no files`);
  }
  return changes.map(file => {
    const from = file.isCreate === true ? undefined : strippedName(file.oldFileName, what, strip);
    const to = file.isDelete === true ? undefined : strippedName(file.newFileName, what, strip);
    if (from === undefined && to === undefined) {
      throw new FabrError(`${what} has a change that names no file`);
    }
    return {
      from,
      to,
      mode: to === undefined || file.newMode === undefined ? undefined : parseInt(file.newMode, 8) & 0o7777,
      apply: (content: string): string => applyHunks(content, file, from ?? to!, what),
    };
  });
}

/** A name as the patch writes it, less `strip` leading components; undefined
 * for the null file. */
function strippedName(written: string | undefined, what: string, strip: number): string | undefined {
  if (written === undefined || written === NO_FILE) {
    return undefined;
  }
  const parts = written.split("/").filter(part => part !== "" && part !== ".");
  const kept = parts.slice(strip);
  if (kept.length === 0) {
    throw new FabrError(`${what} names '${written}', which has no path left after stripping ${strip} leading component${strip === 1 ? "" : "s"}`);
  }
  if (written.startsWith("/") || kept.includes("..")) {
    throw new FabrError(`${what} names '${written}', which is outside the files it applies to`);
  }
  return kept.join("/");
}

function applyHunks(content: string, file: StructuredPatch, name: string, what: string): string {
  const result = applyPatch(content, file, { fuzzFactor: 0 });
  if (result !== false) {
    return result;
  }
  const failed = file.hunks.filter(hunk => applyPatch(content, { ...file, hunks: [hunk] }, { fuzzFactor: 0 }) === false);
  const header = (hunk: StructuredPatch["hunks"][number]): string =>
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
  throw new FabrError(
    failed.length === 0
      ? `${what} does not apply to '${name}': its hunks apply one at a time but not together`
      : `${what} does not apply to '${name}': ${failed.length === 1 ? "hunk" : "hunks"} ${failed.map(header).join(", ")} ${
          failed.length === 1 ? "does" : "do"
        } not match the file`
  );
}
