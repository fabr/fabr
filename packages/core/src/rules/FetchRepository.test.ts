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
import { Readable, Writable } from "stream";
import { expect } from "chai";
import { Computable } from "../core/Computable";
import { FileSet, IFile } from "../core/FileSet";
import { Name, NameBuilder } from "../core/Name";
import { Repository, RepositoryReader } from "../core/Repository";
import { TargetContext } from "../model/BuildContext";
import { fetchRepositoryRegistration } from "./FetchRepository";

const BODY = "tarball bytes";
const sri = (content = BODY): string => `sha256-${crypto.createHash("sha256").update(content).digest("base64")}`;

/** What the stubbed fetch recorded: which URLs were asked for, and whether the
 *  streamed output was finalized (committed) or discarded. */
interface FetchLog {
  readonly urls: string[];
  readonly finalized: string[];
  discarded: number;
}

/**
 * A TargetContext whose `fetch` really runs the caller's `process` callback
 * over `body`, against a stub output handle — so a test exercises the digest
 * gate and the commit/discard decision, not just the wiring around them.
 */
function fakeContext(members: Record<string, string>, log: FetchLog, body = BODY): TargetContext {
  return {
    name: "@dl",
    getWildcardProperties: () =>
      Computable.resolve(Object.keys(members).map(name => ({ key: Name.fromLiteral(name), decl: { name } }))),
    getString: (name: string) => Computable.resolve(members[name]),
    fetch: (
      url: string,
      _tag: string,
      process: (content: Readable, ctx: { createOutput: () => unknown }) => Computable<FileSet>
    ) => {
      log.urls.push(url);
      const output = {
        stream: new Writable({ write: (_chunk, _enc, done): void => done() }),
        finalize: (name: string): Computable<IFile> => {
          log.finalized.push(name);
          return Computable.resolve({ name } as unknown as IFile);
        },
        discard: (): void => {
          log.discarded++;
        },
      };
      return process(Readable.from([body]), { createOutput: () => output });
    },
  } as unknown as TargetContext;
}

function newLog(): FetchLog {
  return { urls: [], finalized: [], discarded: 0 };
}

function repositoryFor(members: Record<string, string>, log: FetchLog, body?: string): Computable<Repository> {
  return fetchRepositoryRegistration.provider(fakeContext(members, log, body));
}

/** Deliver one member by name, as a consumer's reference would. */
function materialize(repository: Repository, member: string): Computable<FileSet> {
  const ref = repository.getRepositoryRef(Name.fromLiteral(member));
  return (repository as unknown as RepositoryReader).deliver(ref);
}

describe("fetch repository", () => {
  const TABLE = {
    "amperize.tgz": `https://host/a/sha ${sri()}`,
    "other.tgz": `${sri()} https://host/b/sha`,
  };

  it("delivers a member as a file under its own name, so the member stays in the projection path", async () => {
    const log = newLog();
    const repository = await repositoryFor(TABLE, log);
    const files = await materialize(repository, "amperize.tgz");
    expect([...files].map(([name]) => name)).to.deep.equal(["amperize.tgz"]);
    expect(log.finalized).to.deep.equal(["amperize.tgz"]);
  });

  it("selects a member named by a projection prefix, packing the whole name as the projection", async () => {
    /* `@dl:amperize.tgz:*:**` — the member is named by a *prefix* of the
     * reference (the same boundary rule archive descent uses), and the whole
     * written name rides as the ref's projection, delivered pending for the
     * driving context to apply over the `amperize.tgz` file (descending there). */
    const log = newLog();
    const repository = await repositoryFor(TABLE, log);
    const name = new NameBuilder()
      .appendLiteralString("amperize.tgz:")
      .appendGlobMetachars("*")
      .appendLiteralString(":")
      .appendGlobMetachars("**")
      .name();
    const ref = repository.getRepositoryRef(name);
    const files = await (repository as unknown as RepositoryReader).deliver(ref);
    expect([...files].map(([n]) => n)).to.deep.equal(["amperize.tgz"]);
    expect(log.urls).to.deep.equal(["https://host/a/sha"]);
    expect(ref.projections.map(projection => projection.pattern.toString())).to.deep.equal(["amperize.tgz:*:**"]);
  });

  it("prefix-matches a path-shaped member name at its own depth", async () => {
    /* Member selection is an ordinary declared-name prefix match — a member
     * key may be a path, claimed by the reference's leading components. */
    const log = newLog();
    const repository = await repositoryFor({ "vendor/amperize.tgz": `https://host/v/sha ${sri()}` }, log);
    const name = new NameBuilder()
      .appendLiteralString("vendor/amperize.tgz:")
      .appendGlobMetachars("**")
      .name();
    const ref = repository.getRepositoryRef(name);
    const files = await (repository as unknown as RepositoryReader).deliver(ref);
    expect([...files].map(([n]) => n)).to.deep.equal(["vendor/amperize.tgz"]);
    expect(log.urls).to.deep.equal(["https://host/v/sha"]);
  });

  it("selects a path-shaped member spanned by a bare **", async () => {
    /* The whole-reference matcher is what lets `**` span into deeper member
     * names; the depth-prefix matcher alone cannot reach them. */
    const log = newLog();
    const repository = await repositoryFor({ "vendor/amperize.tgz": `https://host/v/sha ${sri()}` }, log);
    const ref = repository.getRepositoryRef(new NameBuilder().appendGlobMetachars("**").name());
    const files = await (repository as unknown as RepositoryReader).deliver(ref);
    expect([...files].map(([n]) => n)).to.deep.equal(["vendor/amperize.tgz"]);
    expect(log.urls).to.deep.equal(["https://host/v/sha"]);
  });

  it("fetches only the member that was named", async () => {
    const log = newLog();
    const repository = await repositoryFor(TABLE, log);
    await materialize(repository, "amperize.tgz");
    expect(log.urls).to.deep.equal(["https://host/a/sha"]);
  });

  it("reads the URL and the digest in either order", async () => {
    const log = newLog();
    const repository = await repositoryFor(TABLE, log);
    await materialize(repository, "other.tgz");
    expect(log.urls).to.deep.equal(["https://host/b/sha"]);
  });

  it("reports an unknown member against what the table declares", async () => {
    const log = newLog();
    const repository = await repositoryFor(TABLE, log);
    const err = await materialize(repository, "nope.tgz").then(
      () => undefined,
      (e: Error) => e
    );
    /* Wrapped by attributedTo into a RequirementResolutionError, so assert on
     * the rendered chain rather than the class. */
    expect(String(err)).to.contain("nope.tgz");
    expect(log.urls).to.deep.equal([]);
  });

  it("discards rather than commits when the content does not match its digest", async () => {
    const log = newLog();
    const repository = await repositoryFor(TABLE, log, "different bytes");
    const err = await materialize(repository, "amperize.tgz").then(
      () => undefined,
      (e: Error) => e
    );
    expect(String(err)).to.contain("integrity check failed");
    expect(log.discarded).to.equal(1);
    expect(log.finalized).to.deep.equal([]);
  });

  describe("declaration errors", () => {
    const rejects = async (value: string, expected: string): Promise<void> => {
      const err = await repositoryFor({ "x.tgz": value }, newLog()).then(
        () => undefined,
        (e: Error) => e
      );
      expect(err?.message ?? "").to.contain(expected);
    };

    it("requires an integrity digest — a URL alone promises nothing", async () => {
      await rejects("https://host/x", "no integrity digest");
    });

    it("requires exactly one URL", async () => {
      await rejects(sri(), "no URL");
      await rejects(`https://host/a https://host/b ${sri()}`, "2 URLs");
    });

    it("rejects a member that is a path prefix of another", async () => {
      /* With both declared, a reference to the deeper name would be ambiguous
       * with a projection into the shorter one — impossible by construction. */
      const err = await repositoryFor({ a: `https://host/a ${sri()}`, "a/b.tgz": `https://host/b ${sri()}` }, newLog()).then(
        () => undefined,
        (e: Error) => e
      );
      expect(err?.message ?? "").to.contain("path prefix of another member");
    });
  });
});
