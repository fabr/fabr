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
import { Computable, ComputableSource } from "../core/Computable";
import { FabrError, IntegrityError } from "../core/Errors";
import { EMPTY_FILESET, FileSet, FileSource, IFile } from "../core/FileSet";
import { HASH_ALGORITHM } from "../core/FSWrapper";
import { Name } from "../core/Name";
import { IProvenanceStep, registerProvenanceDescriber, registerProvenanceRenderer } from "../core/Provenance";
import { ExpectedDigest, isIntegrity, parseIntegrity } from "../support/Integrity";
import { fetchFile } from "../support/FetchDocument";
import { TargetContext } from "../context/index";
import { RepositoryImplementation, RepositoryRegistration } from "./Types";
import { mapComputable } from "../support/Functional";

/**
 * The file source a `fetch` declaration is: a table of downloads, each a name,
 * a URL, and the integrity digest the content must match:
 *
 * ```
 * fetch @dl {
 *   amperize.tgz = "https://codeload.github.com/…/<sha>" "sha256-…";
 * }
 * ```
 *
 * Its names are the table's members; it is no repository, and nothing in it
 * is resolved. `@dl:amperize.tgz` is the downloaded file, and
 * `@dl:amperize.tgz:*:**` projects into it as `./amperize.tgz:*:**` would into
 * a local copy: the projection's lookup ({@link FetchSource.get}) lands on the
 * member, which is downloaded, and expands it as any archive is expanded.
 *
 * A member is downloaded only when a reference names it, and is checked
 * against its declared digest each time it is handed back, from the cache or
 * not.
 */
class FetchSource implements FileSource {
  constructor(
    /** The declared name of the fetch table (`@dl`) — for messages. */
    private readonly declaredName: string,
    /** Each member's declaration, by its path (slash form). */
    private readonly members: Map<string, FetchMember>,
    private readonly context: TargetContext
  ) {}

  /**
   * Download the members `name` selects, each named by the pattern's
   * projection (a `-> tmpl` rename applied), and return them as one set. A
   * pattern that selects no member but reaches into one returns the empty
   * set, the projection expanding the member itself; one that does neither
   * rejects, listing the members the table declares.
   */
  public find(name: Name, prefix = ""): ComputableSource<FileSet> {
    const projector = name.makeProjector(prefix);
    const prefixes = name.componentPrefixes();
    const matched: Array<{ path: string; as: string; member: FetchMember }> = [];
    let reachable = false;
    for (const [path, member] of this.members) {
      const as = projector(path);
      if (as !== undefined) {
        matched.push({ path, as, member });
      } else {
        /* Where the pattern's leading components at this member's depth match
         * the member, the pattern reaches into it. */
        const probe = prefixes[path.split("/").length - 1];
        if (probe !== undefined && probe.makeProjector()(path) !== undefined) {
          reachable = true;
        }
      }
    }
    if (matched.length === 0) {
      return reachable ? Computable.resolve(EMPTY_FILESET) : Computable.reject(this.unknownDownload(name));
    }
    return mapComputable(matched, ({ path, as, member }) =>
      this.download(path, member).then(file => this.delivered(as, file, path, member))
    ).then(sets => FileSet.unionAll(...sets));
  }

  /**
   * Look up the member `name` exactly, downloading it as {@link find} does.
   * @return the member's file, or undefined where `name` is no member (whether
   * that is an error is the projection's to judge).
   */
  public get(name: string): ComputableSource<IFile | undefined> {
    const member = this.members.get(name);
    if (!member) {
      return Computable.resolve(undefined);
    }
    return this.download(name, member);
  }

  /** Make a FileSet of one downloaded member, named `as`, with its `fetch` provenance. */
  private delivered(as: string, file: IFile, path: string, member: FetchMember): FileSet {
    const origin: IFetchOrigin = { kind: FETCH_PROVENANCE, source: this.declaredName, member: path, url: member.url };
    return new FileSet(new Map([[as, file]]), origin);
  }

  /** Make the error for a pattern naming no member, listing the members there are. */
  private unknownDownload(name: Name): Error {
    return new FabrError(`${this.declaredName} has no download matching '${name.toString()}'`).withHelp(
      this.members.size > 0 ? `it declares: ${[...this.members.keys()].sort().join(", ")}` : "it declares no downloads"
    );
  }

  /**
   * Fetch one member, cached by its URL, and return the file as downloaded
   * (never unpacked). The digest is checked as the bytes arrive, so a
   * mismatch is never cached, and again on the file returned
   * ({@link verifiedAgainst}). Rejects with an IntegrityError on a mismatch.
   */
  private download(path: string, member: FetchMember): Computable<IFile> {
    return fetchFile(this.context, {
      key: member.url,
      tag: FETCH_TAG,
      report: { resource: path, role: "content" },
      name: path,
      source: () => Computable.resolve({ url: member.url, expected: member.digest }),
    }).then(files => {
      /* Take the entry's one file whatever its name: the entry is keyed by
       * URL, so it may have been stored under another member's name. */
      const file = files.getSingleFile();
      if (!file) {
        throw new FabrError(`download '${path}' in ${this.declaredName} did not produce a file`);
      }
      return verifiedAgainst(file, member.digest, member.url);
    });
  }
}

/** The provenance kind of a download: which member of which table the content
 * is, and the URL it was fetched from. */
export const FETCH_PROVENANCE = "fetch";

/** A {@link FETCH_PROVENANCE} step. */
interface IFetchOrigin extends IProvenanceStep {
  readonly kind: typeof FETCH_PROVENANCE;
  /** The declared name of the fetch table (`@dl`). */
  readonly source: string;
  /** The member path within the table. */
  readonly member: string;
  readonly url: string;
}

registerProvenanceRenderer<IFetchOrigin>(FETCH_PROVENANCE, fetch => {
  return [{ message: `download '${fetch.member}' in ${fetch.source}, fetched from ${fetch.url}` }];
});

registerProvenanceDescriber<IFetchOrigin>(FETCH_PROVENANCE, fetch => {
  return `${fetch.source}:${fetch.member}`;
});

/** One declared download: where it comes from and what it must hash to. */
interface FetchMember {
  readonly url: string;
  readonly digest: ExpectedDigest;
}

/** The cache tag of a download: bump it when what is stored under a fetch key changes shape. */
const FETCH_TAG = "fetch:1";

/**
 * Check `file` against `digest`, so a cached file (or one stored for another
 * member with the same URL) is checked as a fresh download is. A digest in the
 * store's own algorithm is compared with the file's hash; any other reads the
 * content back through a hasher.
 * @return `file`; throws or rejects with an IntegrityError where it does not match.
 */
function verifiedAgainst(file: IFile, digest: ExpectedDigest, url: string): Computable<IFile> {
  if (digest.algorithm === HASH_ALGORITHM) {
    const expected = digest.encoding === "hex" ? digest.value : Buffer.from(digest.value, "base64").toString("hex");
    if (expected !== file.hash) {
      throw new IntegrityError(url, digest.algorithm, digest.value, encodeDigest(file.hash, digest.encoding));
    }
    return Computable.resolve(file);
  }
  return file.getBuffer().then(buffer => {
    const actual = crypto.createHash(digest.algorithm).update(buffer).digest(digest.encoding);
    if (actual !== digest.value) {
      throw new IntegrityError(url, digest.algorithm, digest.value, actual);
    }
    return file;
  });
}

/** @return the store's hex hash in `encoding`, the declared digest's, for a mismatch message. */
function encodeDigest(hexHash: string, encoding: "base64" | "hex"): string {
  return encoding === "hex" ? hexHash : Buffer.from(hexHash, "hex").toString("base64");
}

/**
 * Read the table a `fetch` declaration declares. Each member is a STRING
 * property whose values are its URL and its integrity digest, in either order:
 * an SRI value (`<algorithm>-<base64>`) is the digest, the other the URL. Both
 * are required. Rejects as {@link readMember} and {@link rejectShadowedMembers}
 * throw.
 */
function readMembers(context: TargetContext): Computable<Map<string, FetchMember>> {
  /* Every property the targetdef does not declare is a member, its key
   * substituted (so a member may be named `${VARIANT}.tgz`) and its value read
   * under the property name as written. Keys are held in slash form, as file
   * paths. */
  return context.getWildcardProperties().then(wildcards =>
    Computable.forAll(
      wildcards.map(member =>
        context
          .getString(member.decl.name.toBaseString())
          .then(value => [member.key.toGlobString().replaceAll(":", "/"), value ?? ""] as const)
      ),
      (...entries: (readonly [string, string])[]) => {
        const members = new Map<string, FetchMember>();
        for (const [name, value] of entries) {
          members.set(name, readMember(context.name, name, value));
        }
        rejectShadowedMembers(context.name, [...members.keys()]);
        return members;
      }
    )
  );
}

/**
 * Throw where a member's path is a path prefix of another's: with both `a` and
 * `a/b.tgz` declared, `@dl:a/b.tgz` could name the deeper member or a
 * projection into `a`.
 */
function rejectShadowedMembers(declaredName: string, paths: string[]): void {
  const sorted = [...paths].sort();
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startsWith(sorted[i - 1] + "/")) {
      throw new FabrError(
        `download '${sorted[i - 1]}' in ${declaredName} conflicts with '${sorted[i]}': a member may not be a path prefix of another member`
      ).withHelp("a reference to the deeper name would be ambiguous with a projection into the shorter one — rename one of them");
    }
  }
}

/** Read one member's value, its URL and digest. Throws where it has other than one of each. */
function readMember(declaredName: string, memberName: string, value: string): FetchMember {
  const values = value
    .trim()
    .split(/\s+/)
    .filter(entry => entry !== "");
  const integrity = values.filter(isIntegrity);
  const urls = values.filter(entry => !isIntegrity(entry));
  const where = `download '${memberName}' in ${declaredName}`;
  if (urls.length !== 1) {
    throw new FabrError(`${where} names ${urls.length === 0 ? "no URL" : `${urls.length} URLs`}`).withHelp(
      "write exactly one URL and one integrity digest, in either order"
    );
  }
  if (integrity.length !== 1) {
    throw new FabrError(`${where} states ${integrity.length === 0 ? "no integrity digest" : "several integrity digests"}`).withHelp(
      'a URL is not immutable on its own, so every download must state one digest, e.g. "sha256-<base64>"'
    );
  }
  const digest = parseIntegrity(integrity[0]);
  if (!digest) {
    /* Reached only where isIntegrity and parseIntegrity disagree. */
    throw new FabrError(`${where} has an unreadable integrity digest '${integrity[0]}'`);
  }
  return { url: urls[0], digest };
}

/** Make the file source of the `fetch` declaration `context` reads. */
function createFetchSource(context: TargetContext): Computable<FileSource> {
  return readMembers(context).then(members => new FetchSource(context.name, members, context));
}

export const fetchSourceRegistration: RepositoryRegistration = { type: "fetch", provider: createFetchSource };

/** The implementation STD.fabr's `repository` declaration names. */
export default { provider: createFetchSource } satisfies RepositoryImplementation;
