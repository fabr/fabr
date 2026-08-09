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

import { Computable } from "../core/Computable";
import { attachHelp } from "../core/Errors";
import { FileSet, IFile } from "../core/FileSet";
import { Name } from "../core/Name";
import { attributedTo, Repository, RepositoryPublishRef, RepositoryReader, RepositoryRef } from "../core/Repository";
import { ExpectedDigest, isIntegrity, parseIntegrity, verifyingStream } from "../support/Integrity";
import { TargetContext } from "../model/BuildContext";
import { RepositoryRegistration } from "./Types";

/**
 * A `fetch` repository is a declared table of downloads — a name, a URL, and the
 * integrity digest the content must match:
 *
 * ```
 * fetch @dl {
 *   amperize.tgz = "https://codeload.github.com/…/<sha>" "sha256-…";
 * }
 * ```
 *
 * `@dl` denotes the whole set and each member is a **file in it**, so a member's
 * name stays part of the projection path: `@dl:amperize.tgz` is the downloaded
 * file (usable as-is), and `@dl:amperize.tgz:*:**` projects into it exactly as
 * `./amperize.tgz:*:**` would over a local copy. Nothing here knows what an
 * archive is — digging into one is the projection's business, so a member that
 * is wanted whole and a member that is wanted unpacked take the same path.
 *
 * A member is fetched only when something names it (the resolve/fetch split: the
 * table is a pin, not a download list).
 */
class FetchRepository implements Repository, RepositoryReader {
  constructor(
    private readonly repositoryName: string,
    private readonly members: Map<string, FetchMember>,
    private readonly context: TargetContext
  ) {}

  /**
   * Deliver every member the reference selects (downloading those and only
   * those — the table is a pin, not a download list), each named by its member
   * name so the reference's own projection applies over `<member>/…` — the
   * same name space a local file of that name would occupy. Genuinely
   * per-reference: there is nothing to version-select, so the reader face is
   * exactly this.
   */
  public deliver(reference: RepositoryRef): Computable<FileSet> {
    return attributedTo(reference, () => this.deliverName(reference.name));
  }

  private deliverName(name: Name): Computable<FileSet> {
    const selected = this.select(name);
    if (selected.length === 0) {
      /* Rejection, not a throw: materialize is called synchronously, so throwing
       * here would escape the Computable chain instead of failing it. */
      return Computable.reject(
        attachHelp(
          new Error(`${this.repositoryName} has no download matching '${name.toString()}'`),
          this.members.size > 0 ? `it declares: ${[...this.members.keys()].sort().join(", ")}` : "it declares no downloads"
        )
      );
    }
    return Computable.forAll(
      selected.map(([memberName, member]) => this.download(memberName, member)),
      (...files: FileSet[]) => FileSet.unionAll(...files)
    );
  }

  /**
   * The members a reference names: an ordinary declared-name **prefix match**,
   * the same move as target prefix matching or npm's identity claim — each
   * member name is matched against the reference's leading components at the
   * member's own depth, literally (`@dl:amperize.tgz:…`) or by glob
   * (`@dl:*.tgz`, fetch's documented extension), or by the whole reference
   * (which is how a `**` spans into a path-shaped member name); everything
   * past the member projects into the downloaded file, applied by the
   * consumer's ordinary descent.
   */
  private select(name: Name): [string, FetchMember][] {
    const prefixes = name.componentPrefixes();
    const whole = name.makeProjector();
    return [...this.members].filter(([memberName]) => {
      const memberPath = memberName.replaceAll(":", "/");
      const prefix = prefixes[memberPath.split("/").length - 1];
      return whole(memberPath) !== undefined || prefix?.makeProjector()(memberPath) !== undefined;
    });
  }

  /**
   * Fetch one member, verifying its digest as the bytes stream past so a
   * mismatch throws before the cache entry commits. The result is the file
   * itself under the member's name — never unpacked (see the class comment).
   */
  private download(memberName: string, member: FetchMember): Computable<FileSet> {
    return this.context.fetch(
      member.url,
      FETCH_TAG,
      (content, ctx) => {
        const { hashing, verify } = verifyingStream(member.digest, member.url);
        const output = ctx.createOutput();
        content.pipe(hashing).pipe(output.stream, { end: false });
        return streamed(hashing)
          .then(() => {
            /* Before finalize: a digest mismatch must leave nothing behind. */
            try {
              verify();
            } catch (err) {
              output.discard();
              throw err;
            }
            return output.finalize(memberName);
          })
          .then((file: IFile) => new FileSet(new Map([[memberName, file]])));
      },
      memberName
    );
  }

  /**
   * The whole name is the projection: `@dl` is what gets addressed, and the
   * member name stays in the path so projecting into a member reads exactly as
   * projecting into a local file of that name — the delivery is the selected
   * member files under their member names, and the written name applies over
   * them as an ordinary projection when the resolver finishes the delivery —
   * which is where a `:*:**` tail descends into an archive member. (A catalog
   * splits its alias off instead — its members are packages, addressed by
   * name and delivering their contents; a download is a file sitting in a
   * set.)
   */
  public getRepositoryRef(name: Name): RepositoryRef {
    return new RepositoryRef(this, name, [{ pattern: name, prefix: "" }]);
  }

  /** Downloads are read-only: a URL is not a place content goes. */
  public getRepositoryPublishRef(name: Name): RepositoryPublishRef {
    throw new Error(`${this.repositoryName} is not a publish destination (cannot sync to '${name.toString()}')`);
  }
}

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
   * the VALUE resolves under the written property name. */
  return context.getWildcardProperties().then(wildcards =>
    Computable.forAll(
      wildcards.map(member => context.getString(member.decl.name).then(value => [member.key.toGlobString(), value ?? ""] as const)),
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
function rejectShadowedMembers(repositoryName: string, names: string[]): void {
  const paths = new Map(names.map(name => [name.replaceAll(":", "/"), name]));
  const sorted = [...paths.keys()].sort();
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startsWith(sorted[i - 1] + "/")) {
      throw attachHelp(
        new Error(
          `download '${paths.get(sorted[i - 1])}' in ${repositoryName} conflicts with '${paths.get(
            sorted[i]
          )}': a member may not be a path prefix of another member`
        ),
        "a reference to the deeper name would be ambiguous with a projection into the shorter one — rename one of them"
      );
    }
  }
}

function readMember(repositoryName: string, memberName: string, value: string): FetchMember {
  const values = value
    .trim()
    .split(/\s+/)
    .filter(entry => entry !== "");
  const integrity = values.filter(isIntegrity);
  const urls = values.filter(entry => !isIntegrity(entry));
  const where = `download '${memberName}' in ${repositoryName}`;
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

function createFetchRepository(context: TargetContext): Computable<Repository> {
  return readMembers(context).then(members => new FetchRepository(context.name, members, context));
}

export const fetchRepositoryRegistration: RepositoryRegistration = { type: "fetch", provider: createFetchRepository };
