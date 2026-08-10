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
import { FileSet, FileSource, IFile } from "../core/FileSet";
import { Name, NameBuilder } from "../core/Name";
import { TargetContext } from "../model/BuildContext";
import { FETCH_PROVENANCE, fetchSourceRegistration } from "./FetchSource";

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
function fakeContext(members: Record<string, string>, log: FetchLog, body: string | Readable = BODY): TargetContext {
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
          return Computable.resolve(storedFile(name, body));
        },
        discard: (): void => {
          log.discarded++;
        },
      };
      return process(typeof body === "string" ? Readable.from([body]) : body, { createOutput: () => output });
    },
  } as unknown as TargetContext;
}

/** A file as the store would serve it: content-hashed, readable back. */
function storedFile(name: string, content: string | Readable): IFile {
  const bytes = typeof content === "string" ? content : "";
  return {
    name,
    hash: crypto.createHash("sha256").update(bytes).digest("hex"),
    getBuffer: () => Computable.resolve(Buffer.from(bytes)),
  } as unknown as IFile;
}

/**
 * A TargetContext whose `fetch` answers from "cache": the process callback is
 * never run — the stored file for `cachedBytes` is served directly, as a warm
 * cache does — so a test exercises the hit-path digest judgment.
 */
function cachedContext(members: Record<string, string>, log: FetchLog, cachedBytes: string): TargetContext {
  return {
    name: "@dl",
    getWildcardProperties: () =>
      Computable.resolve(Object.keys(members).map(name => ({ key: Name.fromLiteral(name), decl: { name } }))),
    getString: (name: string) => Computable.resolve(members[name]),
    fetch: (url: string): Computable<FileSet> => {
      log.urls.push(url);
      return Computable.resolve(new FileSet(new Map([["stored", storedFile("stored", cachedBytes)]])));
    },
  } as unknown as TargetContext;
}

function newLog(): FetchLog {
  return { urls: [], finalized: [], discarded: 0 };
}

function sourceFor(members: Record<string, string>, log: FetchLog, body?: string | Readable): Computable<FileSource> {
  return fetchSourceRegistration.provider(fakeContext(members, log, body)) as Computable<FileSource>;
}

describe("fetch source", () => {
  const TABLE = {
    "amperize.tgz": `https://host/a/sha ${sri()}`,
    "other.tgz": `${sri()} https://host/b/sha`,
  };

  it("delivers a member as a file under its own name, so the member stays in the projection path", async () => {
    const log = newLog();
    const source = await sourceFor(TABLE, log);
    const files = await source.find(Name.fromLiteral("amperize.tgz"));
    expect([...files].map(([name]) => name)).to.deep.equal(["amperize.tgz"]);
    expect(log.finalized).to.deep.equal(["amperize.tgz"]);
  });

  it("stamps the delivery's origin with the member and its URL", async () => {
    const log = newLog();
    const source = await sourceFor(TABLE, log);
    const files = await source.find(Name.fromLiteral("amperize.tgz"));
    expect(files.origin?.kind).to.equal(FETCH_PROVENANCE);
    expect(files.origin).to.include({ source: "@dl", member: "amperize.tgz", url: "https://host/a/sha" });
  });

  it("matches nothing (without downloading) for a pattern that reaches into a member", async () => {
    /* `@dl:amperize.tgz:*:**` — the direct match is empty (the member is a
     * file, not a directory), but the pattern can still descend into it, so
     * this is no miss: the projection walker's probes (`get`) land on the
     * member and expand it. */
    const log = newLog();
    const source = await sourceFor(TABLE, log);
    const name = new NameBuilder()
      .appendLiteralString("amperize.tgz:")
      .appendGlobMetachars("*")
      .appendLiteralString(":")
      .appendGlobMetachars("**")
      .name();
    const files = await source.find(name);
    expect(files.isEmpty()).to.equal(true);
    expect(log.urls).to.deep.equal([]);
  });

  it("downloads a member on an exact lookup — how a descent probe lands on it", async () => {
    const log = newLog();
    const source = await sourceFor(TABLE, log);
    const file = await source.get("amperize.tgz");
    expect(file).to.not.equal(undefined);
    expect(log.urls).to.deep.equal(["https://host/a/sha"]);
  });

  it("is undefined (not an error) for an exact lookup that is not a member", async () => {
    const log = newLog();
    const source = await sourceFor(TABLE, log);
    expect(await source.get("nope.tgz")).to.equal(undefined);
    expect(log.urls).to.deep.equal([]);
  });

  it("holds path-shaped members reachable at their own depth without downloading", async () => {
    /* A member key may be a path; a pattern reaching past it descends there.
     * `vendor/amperize.tgz:**` names the files *under* the member, so the
     * direct find is empty and the probe (`get`) does the download. */
    const log = newLog();
    const source = await sourceFor({ "vendor/amperize.tgz": `https://host/v/sha ${sri()}` }, log);
    const name = new NameBuilder().appendLiteralString("vendor/amperize.tgz:").appendGlobMetachars("**").name();
    const files = await source.find(name);
    expect(files.isEmpty()).to.equal(true);
    expect(log.urls).to.deep.equal([]);
    expect(await source.get("vendor/amperize.tgz")).to.not.equal(undefined);
    expect(log.urls).to.deep.equal(["https://host/v/sha"]);
  });

  it("selects a path-shaped member spanned by a bare **", async () => {
    /* The whole-pattern matcher is what lets `**` span into deeper member
     * names; the depth-prefix matcher alone cannot reach them. */
    const log = newLog();
    const source = await sourceFor({ "vendor/amperize.tgz": `https://host/v/sha ${sri()}` }, log);
    const files = await source.find(new NameBuilder().appendGlobMetachars("**").name());
    expect([...files].map(([n]) => n)).to.deep.equal(["vendor/amperize.tgz"]);
    expect(log.urls).to.deep.equal(["https://host/v/sha"]);
  });

  it("fetches only the member that was named", async () => {
    const log = newLog();
    const source = await sourceFor(TABLE, log);
    await source.find(Name.fromLiteral("amperize.tgz"));
    expect(log.urls).to.deep.equal(["https://host/a/sha"]);
  });

  it("reads the URL and the digest in either order", async () => {
    const log = newLog();
    const source = await sourceFor(TABLE, log);
    await source.find(Name.fromLiteral("other.tgz"));
    expect(log.urls).to.deep.equal(["https://host/b/sha"]);
  });

  it("reports an unknown member against what the table declares", async () => {
    const log = newLog();
    const source = await sourceFor(TABLE, log);
    const err = await Computable.resolve(undefined)
      .then(() => source.find(Name.fromLiteral("nope.tgz")))
      .then(
        () => undefined,
        (e: Error) => e
      );
    expect(String(err)).to.contain("nope.tgz");
    expect(log.urls).to.deep.equal([]);
  });

  it("discards rather than commits when the content does not match its digest", async () => {
    const log = newLog();
    const source = await sourceFor(TABLE, log, "different bytes");
    const err = await Computable.resolve(undefined)
      .then(() => source.find(Name.fromLiteral("amperize.tgz")))
      .then(
        () => undefined,
        (e: Error) => e
      );
    expect(String(err)).to.contain("integrity check failed");
    expect(log.discarded).to.equal(1);
    expect(log.finalized).to.deep.equal([]);
  });

  it("fails the attempt (and discards) when the body drops mid-stream", async () => {
    /* pipe() does not forward a source error; without the explicit wiring this
     * is an unhandled 'error' event, not a rejection. */
    const log = newLog();
    const broken = new Readable({
      read(): void {
        this.destroy(new Error("connection reset mid-body"));
      },
    });
    const source = await sourceFor(TABLE, log, broken);
    const err = await Computable.resolve(undefined)
      .then(() => source.find(Name.fromLiteral("amperize.tgz")))
      .then(
        () => undefined,
        (e: Error) => e
      );
    expect(String(err)).to.contain("connection reset mid-body");
    expect(log.discarded).to.equal(1);
    expect(log.finalized).to.deep.equal([]);
  });

  describe("cache hits", () => {
    /* The streaming digest gate only guards the commit; a hit serves stored
     * bytes with nothing streaming past, so the declaration is re-judged
     * against the store. */
    const hitSource = (members: Record<string, string>, log: FetchLog, cachedBytes: string): Computable<FileSource> =>
      fetchSourceRegistration.provider(cachedContext(members, log, cachedBytes)) as Computable<FileSource>;

    it("serves a hit whose stored content matches the declared digest", async () => {
      const log = newLog();
      const source = await hitSource({ "amperize.tgz": `https://host/a/sha ${sri()}` }, log, BODY);
      const files = await source.find(Name.fromLiteral("amperize.tgz"));
      expect([...files].map(([name]) => name)).to.deep.equal(["amperize.tgz"]);
    });

    it("re-judges an edited digest against stored content — warm and cold agree", async () => {
      const log = newLog();
      const source = await hitSource({ "amperize.tgz": `https://host/a/sha ${sri("expected bytes")}` }, log, BODY);
      const err = await Computable.resolve(undefined)
        .then(() => source.find(Name.fromLiteral("amperize.tgz")))
        .then(
          () => undefined,
          (e: Error) => e
        );
      expect(String(err)).to.contain("integrity check failed");
    });

    it("checks each member's own digest when two share a URL", async () => {
      /* First-fetched content serves both members off one cache entry; the
       * member whose declaration disagrees must still fail. */
      const log = newLog();
      const table = {
        "good.tgz": `https://host/shared ${sri()}`,
        "bad.tgz": `https://host/shared ${sri("other bytes")}`,
      };
      const source = await hitSource(table, log, BODY);
      const good = await source.find(Name.fromLiteral("good.tgz"));
      expect(good.isEmpty()).to.equal(false);
      const err = await Computable.resolve(undefined)
        .then(() => source.find(Name.fromLiteral("bad.tgz")))
        .then(
          () => undefined,
          (e: Error) => e
        );
      expect(String(err)).to.contain("integrity check failed");
    });

    it("verifies a non-store algorithm by reading the content back", async () => {
      const log = newLog();
      const sha512 = `sha512-${crypto.createHash("sha512").update(BODY).digest("base64")}`;
      const source = await hitSource({ "amperize.tgz": `https://host/a/sha ${sha512}` }, log, BODY);
      const files = await source.find(Name.fromLiteral("amperize.tgz"));
      expect(files.isEmpty()).to.equal(false);
      const bad = await hitSource({ "amperize.tgz": `https://host/a/sha ${sha512}` }, newLog(), "other bytes");
      const err = await Computable.resolve(undefined)
        .then(() => bad.find(Name.fromLiteral("amperize.tgz")))
        .then(
          () => undefined,
          (e: Error) => e
        );
      expect(String(err)).to.contain("integrity check failed");
    });
  });

  describe("declaration errors", () => {
    const rejects = async (value: string, expected: string): Promise<void> => {
      const err = await sourceFor({ "x.tgz": value }, newLog()).then(
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
      const err = await sourceFor({ a: `https://host/a ${sri()}`, "a/b.tgz": `https://host/b ${sri()}` }, newLog()).then(
        () => undefined,
        (e: Error) => e
      );
      expect(err?.message ?? "").to.contain("path prefix of another member");
    });
  });
});
