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
import { attachHelp, IntegrityError, toError } from "../core/Errors";
import { EMPTY_FILESET, FileSet, FileSource, IFile } from "../core/FileSet";
import { HASH_ALGORITHM } from "../core/FSWrapper";
import { Name } from "../core/Name";
import { IProvenanceStep, registerProvenanceDescriber, registerProvenanceRenderer } from "../core/Provenance";
import { ExpectedDigest, isIntegrity, parseIntegrity, verifyingStream } from "../support/Integrity";
import { TargetContext } from "../model/BuildContext";
import { RepositoryRegistration } from "./Types";

/**
 * A `fetch` table is a declared set of downloads — a name, a URL, and the
 * integrity digest the content must match:
 *
 * ```
 * fetch @dl {
 *   amperize.tgz = "https://codeload.github.com/…/<sha>" "sha256-…";
 * }
 * ```
 *
 * It is a plain {@link FileSource} — a namespace whose NAMES are the declared
 * member table and whose CONTENTS download on demand — deliberately not a
 * repository: there is nothing to version-select, so it wants none of the
 * resolution machinery (no references, no batching, no joint pin).
 * `@dl:amperize.tgz` is the downloaded file (usable as-is), and
 * `@dl:amperize.tgz:*:**` projects into it exactly as `./amperize.tgz:*:**`
 * would over a local copy: the projection walker's descent probes ({@link
 * FetchSource.get}) land on the member, download it, and expand it — nothing
 * here knows what an archive is.
 *
 * A member is fetched only when a projection names it (the table is a pin, not
 * a download list), and every delivered file is ingested on arrival — hash
 * verified against the declared digest, mime sniffed — because the walker
 * judges descent from the file's properties.
 */
class FetchSource implements FileSource {
  constructor(
    /** The declared name of the fetch table (`@dl`) — for messages. */
    private readonly declaredName: string,
    /** Member path (slash form) -> its declaration. */
    private readonly members: Map<string, FetchMember>,
    private readonly context: TargetContext
  ) {}

  /**
   * The member files the pattern selects, downloaded — those and only those —
   * each named by the pattern's own projection (so the written-name rule and
   * `-> tmpl` renames apply as over any container). A pattern that reaches
   * *into* a member is descent's business and matches nothing here, but the
   * table being a closed namespace tells "nothing yet" apart from "nothing
   * ever": a pattern that neither names a member nor could descend into one
   * is an unknown download, failed with the declared table — the same
   * judgment (and message) the repository form of fetch used to make.
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
        /* The pattern's component-prefix at this member's own depth: when it
         * matches, the pattern reaches INTO the member — the walker's descent
         * probes will land on it — so an empty direct result is not a miss. */
        const probe = prefixes[path.split("/").length - 1];
        if (probe !== undefined && probe.makeProjector()(path) !== undefined) {
          reachable = true;
        }
      }
    }
    if (matched.length === 0) {
      return reachable ? Computable.resolve(EMPTY_FILESET) : Computable.reject(this.unknownDownload(name));
    }
    return Computable.forAll(
      matched.map(({ path, as, member }) => this.download(path, member).then(file => this.delivered(as, file, path, member))),
      (...sets: FileSet[]) => FileSet.unionAll(...sets)
    );
  }

  /**
   * Exact member lookup — how a descent probe lands on a download before
   * expanding into it. Downloads on demand, like {@link find}; a path that is
   * not a member is simply undefined (probes are speculative — whether an
   * unmatched name is an error is the projection's judgment, made over the
   * whole walk).
   */
  public get(name: string): ComputableSource<IFile | undefined> {
    const member = this.members.get(name);
    if (!member) {
      return Computable.resolve(undefined);
    }
    return this.download(name, member);
  }

  /** One delivered member as a FileSet, its origin stamped: where this content
   * came from is the download's own knowledge, recorded at ingest (a
   * FileSource stamps origin on what it yields). */
  private delivered(as: string, file: IFile, path: string, member: FetchMember): FileSet {
    const origin: IFetchOrigin = { kind: FETCH_PROVENANCE, source: this.declaredName, member: path, url: member.url };
    return new FileSet(new Map([[as, file]]), origin);
  }

  private unknownDownload(name: Name): Error {
    return attachHelp(
      new Error(`${this.declaredName} has no download matching '${name.toString()}'`),
      this.members.size > 0 ? `it declares: ${[...this.members.keys()].sort().join(", ")}` : "it declares no downloads"
    );
  }

  /**
   * Fetch one member, verifying its digest as the bytes stream past so a
   * mismatch throws before the cache entry commits. The result is the file
   * itself — never unpacked (see the class comment).
   */
  private download(path: string, member: FetchMember): Computable<IFile> {
    return this.context
      .fetch(
        member.url,
        FETCH_TAG,
        (content, ctx) => {
          const { hashing, verify } = verifyingStream(member.digest, member.url);
          const output = ctx.createOutput();
          /* pipe() does not forward a source error: a body dropped mid-stream
           * (reset, idle timeout) must fail this attempt through the hasher,
           * not raise an unhandled 'error' on the bare response. */
          content.on("error", err => hashing.destroy(toError(err)));
          content.pipe(hashing).pipe(output.stream, { end: false });
          return streamed(hashing)
            .then(
              () => {
                /* Before finalize: a digest mismatch must leave nothing behind. */
                try {
                  verify();
                } catch (err) {
                  output.discard();
                  throw err;
                }
                return output.finalize(path);
              },
              err => {
                output.discard();
                throw err;
              }
            )
            .then((file: IFile) => new FileSet(new Map([[path, file]])));
        },
        { resource: path, role: "content" }
      )
      .then(files => {
        /* By single file rather than by name: the cache entry is keyed on the
         * URL, so content first ingested under another declared name serves
         * this one too. */
        const file = files.getSingleFile();
        if (!file) {
          throw new Error(`download '${path}' in ${this.declaredName} did not produce a file`);
        }
        return verifiedAgainst(file, member.digest, member.url);
      });
  }
}

/** Provenance kind for a delivered download: which table member the content
 * is, and the URL it was fetched from. */
export const FETCH_PROVENANCE = "fetch";

interface IFetchOrigin extends IProvenanceStep {
  readonly kind: typeof FETCH_PROVENANCE;
  /** The declared name of the fetch table (`@dl`). */
  readonly source: string;
  /** The member path within the table. */
  readonly member: string;
  readonly url: string;
}

registerProvenanceRenderer(FETCH_PROVENANCE, step => {
  const fetch = step as IFetchOrigin;
  return [{ message: `download '${fetch.member}' in ${fetch.source}, fetched from ${fetch.url}` }];
});

registerProvenanceDescriber(FETCH_PROVENANCE, step => {
  const fetch = step as IFetchOrigin;
  return `${fetch.source}:${fetch.member}`;
});

/** One declared download: where it comes from and what it must hash to. */
interface FetchMember {
  readonly url: string;
  readonly digest: ExpectedDigest;
}

/** Bumped when what is stored under a fetch key changes shape. */
const FETCH_TAG = "fetch:1";

/** Settle when a stream has been fully consumed (or failed). */
function streamed(stream: NodeJS.ReadableStream): Computable<void> {
  return Computable.from<void>((resolve, reject) => {
    stream.on("end", () => resolve(undefined));
    stream.on("error", err => reject(err instanceof Error ? err : new Error(String(err))));
  });
}

/**
 * Judge a delivered file against the declared digest. The streaming check in
 * {@link FetchSource.download} gates only the cache *commit*: a cache hit (or a
 * second member sharing the URL under a different digest) serves stored bytes
 * with no fetch to stream through, so the declaration is re-judged against the
 * store here — an edited digest fails identically warm or cold. Free in the
 * declared-sha256 case (the store's own algorithm — a hash compare); any other
 * algorithm reads the content back through a hasher.
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

/** The store's hex hash re-encoded to the declaration's encoding, so the
 *  mismatch message shows both sides in the form the user wrote. */
function encodeDigest(hexHash: string, encoding: "base64" | "hex"): string {
  return encoding === "hex" ? hexHash : Buffer.from(hexHash, "hex").toString("base64");
}

/**
 * Read the declared table. Each member is a STRING property whose values are its
 * URL and its integrity digest, told apart **by shape** rather than by position:
 * an SRI value is `<algorithm>-<base64>` and a URL has a scheme, so the two
 * cannot be confused and their order does not matter. Requiring the digest is
 * the point — a URL is not immutable by itself (a git SHA in the path makes it
 * so, but only the author knows that), so the declaration is where that claim
 * gets made in checkable form.
 */
function readMembers(context: TargetContext): Computable<Map<string, FetchMember>> {
  /* Members via the wildcard surface: every non-declared property, its key
   * variable-substituted — so a member may be named `${VARIANT}.tgz` — while
   * the VALUE resolves under the written property name. Keys are held in
   * slash form: a member is a file in the set, so its name is a path. */
  return context.getWildcardProperties().then(wildcards =>
    Computable.forAll(
      wildcards.map(member =>
        context.getString(member.decl.name.toBaseString()).then(value => [member.key.toGlobString().replaceAll(":", "/"), value ?? ""] as const)
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
 * A member name may not be a path prefix of another member — the same rule
 * that keeps a target name from conflicting with an implicit namespace: with
 * both `a` and `a/b.tgz` declared, a reference `@dl:a/b.tgz` would be
 * ambiguous between the deeper member and a projection *into* member `a`.
 * Rejected at declaration so the ambiguity is impossible by construction.
 */
function rejectShadowedMembers(declaredName: string, paths: string[]): void {
  const sorted = [...paths].sort();
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startsWith(sorted[i - 1] + "/")) {
      throw attachHelp(
        new Error(
          `download '${sorted[i - 1]}' in ${declaredName} conflicts with '${sorted[i]}': a member may not be a path prefix of another member`
        ),
        "a reference to the deeper name would be ambiguous with a projection into the shorter one — rename one of them"
      );
    }
  }
}

function readMember(declaredName: string, memberName: string, value: string): FetchMember {
  const values = value
    .trim()
    .split(/\s+/)
    .filter(entry => entry !== "");
  const integrity = values.filter(isIntegrity);
  const urls = values.filter(entry => !isIntegrity(entry));
  const where = `download '${memberName}' in ${declaredName}`;
  if (urls.length !== 1) {
    throw attachHelp(
      new Error(`${where} names ${urls.length === 0 ? "no URL" : `${urls.length} URLs`}`),
      "write exactly one URL and one integrity digest, in either order"
    );
  }
  if (integrity.length !== 1) {
    throw attachHelp(
      new Error(`${where} states ${integrity.length === 0 ? "no integrity digest" : "several integrity digests"}`),
      'a URL is not immutable on its own, so every download must state one digest, e.g. "sha256-<base64>"'
    );
  }
  const digest = parseIntegrity(integrity[0]);
  if (!digest) {
    /* isIntegrity matched, so the algorithm is one we know — unreachable unless
     * the two disagree. */
    throw new Error(`${where} has an unreadable integrity digest '${integrity[0]}'`);
  }
  return { url: urls[0], digest };
}

function createFetchSource(context: TargetContext): Computable<FileSource> {
  return readMembers(context).then(members => new FetchSource(context.name, members, context));
}

export const fetchSourceRegistration: RepositoryRegistration = { type: "fetch", provider: createFetchSource };
