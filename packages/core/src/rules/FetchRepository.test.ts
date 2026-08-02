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
import { Name } from "../core/Name";
import { Repository, RepositoryReader } from "../core/Repository";
import { RepositoryContext } from "../model/BuildContext";
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
 * A RepositoryContext whose `fetch` really runs the caller's `process` callback
 * over `body`, against a stub output handle — so a test exercises the digest
 * gate and the commit/discard decision, not just the wiring around them.
 */
function fakeContext(members: Record<string, string>, log: FetchLog, body = BODY): RepositoryContext {
  return {
    target: {
      name: "@dl",
      properties: Object.keys(members).map(name => ({ name })),
    },
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
  } as unknown as RepositoryContext;
}

function newLog(): FetchLog {
  return { urls: [], finalized: [], discarded: 0 };
}

function repositoryFor(members: Record<string, string>, log: FetchLog, body?: string): Computable<Repository> {
  return fetchRepositoryRegistration.provider(fakeContext(members, log, body));
}

/** Materialize one member by name, as a consumer's reference would. */
function materialize(repository: Repository, member: string): Computable<FileSet> {
  const ref = repository.getRepositoryRef(Name.fromLiteral(member));
  return (repository as unknown as RepositoryReader).materialize([ref], { roots: [] }).then(([files]: FileSet[]) => files);
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
  });
});
