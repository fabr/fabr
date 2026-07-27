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

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { BuildCache } from "./BuildCache";
import { Computable } from "./Computable";
import { readStream } from "./Fetch";
import { FileSet } from "./FileSet";
import { hashString } from "./FSWrapper";
import { MemoryFile } from "./MemoryFS";
import { SymlinkFile } from "./SymlinkFile";
import { Log } from "../support/Log";
import { expect } from "chai";

const NULL_LOG: Log = { log: () => undefined };

function toPromise<T>(computable: Computable<T>): Promise<T> {
  return new Promise((resolve, reject) => computable.then(resolve, reject));
}

describe("BuildCache", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-buildcache-test-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("persists in-memory files into the cache directory", async () => {
    const cache = new BuildCache(root, NULL_LOG);
    const files = await toPromise(
      cache.getOrCreate("test manifest", () =>
        Computable.resolve(new FileSet(new Map([["meta.json", MemoryFile.from('{"name":"test"}')]])))
      )
    );
    const file = await toPromise(files.get("meta.json"));
    expect(file).to.not.equal(undefined);
    const abspath = file!.getAbsPath();
    expect(abspath).to.not.equal(undefined);
    expect(abspath!.startsWith(root)).to.equal(true);
    expect(fs.readFileSync(abspath!, "utf8")).to.equal('{"name":"test"}');
  });

  it("preserves file mode through the manifest and stores blobs read-only", async () => {
    const cache = new BuildCache(root, NULL_LOG);
    const store = (): Computable<FileSet> =>
      cache.getOrCreate(
        "with modes",
        () =>
          Computable.resolve(
            new FileSet(
              new Map<string, import("./FileSet").IFile>([
                ["bin/tool", new MemoryFile(Buffer.from("#!/bin/sh\n"), 0o755)],
                ["lib/plain.js", new MemoryFile(Buffer.from("x"), 0o644)],
              ])
            )
          )
      );
    const fresh = await toPromise(store());

    /* Blobs are read-only; the executable's blob keeps an exec bit, the plain
     * one does not — so a launched tool can't write through a staged hardlink. */
    const execBlob = (await toPromise(fresh.get("bin/tool")))!.getAbsPath()!;
    const plainBlob = (await toPromise(fresh.get("lib/plain.js")))!.getAbsPath()!;
    expect(fs.statSync(execBlob).mode & 0o777).to.equal(0o555);
    expect(fs.statSync(plainBlob).mode & 0o777).to.equal(0o444);

    /* A fresh cache reads the original modes back from the manifest — not the
     * read-only blob's permission bits. */
    const reopened = new BuildCache(root, NULL_LOG);
    const files = await toPromise(
      reopened.getOrCreate("with modes", () => {
        throw new Error("cache entry should not be rebuilt");
      })
    );
    expect((await toPromise(files.get("bin/tool")))!.mode).to.equal(0o755);
    expect((await toPromise(files.get("lib/plain.js")))!.mode).to.equal(0o644);
  });

  it("round-trips a symlink through the manifest without materialising a blob", async () => {
    const cache = new BuildCache(root, NULL_LOG);
    await toPromise(
      cache.getOrCreate(
        "with symlink",
        () =>
          Computable.resolve(
            new FileSet(
              new Map<string, import("./FileSet").IFile>([
                ["real.txt", MemoryFile.from("hi")],
                ["link.txt", new SymlinkFile("real.txt")],
              ])
            )
          )
      )
    );
    /* The link's target rides in the manifest, so no blob is created for its
     * "content" — only the one real file's blob exists in the pool. */
    const blobDir = path.join(root, "blob");
    expect(fs.readdirSync(blobDir).length).to.equal(1);

    /* A fresh cache deserialises the link back as a SymlinkFile (not a regular
     * file containing the target text), with its target intact. */
    const reopened = new BuildCache(root, NULL_LOG);
    const files = await toPromise(
      reopened.getOrCreate("with symlink", () => {
        throw new Error("cache entry should not be rebuilt");
      })
    );
    const link = await toPromise(files.get("link.txt"));
    expect(link).to.be.instanceOf(SymlinkFile);
    expect((link as SymlinkFile).target).to.equal("real.txt");
    expect(await toPromise(files.readFile("real.txt"))).to.equal("hi");
  });

  it("writes the manifest atomically, leaving no temp debris", async () => {
    const cache = new BuildCache(root, NULL_LOG);
    await toPromise(
      cache.getOrCreate("atomic", () => Computable.resolve(new FileSet(new Map([["a.txt", MemoryFile.from("hi")]]))))
    );
    /* The manifest is present and the temp file was renamed into place, not left
     * behind (an atomic write, so no truncated manifest can ever be trusted). */
    expect(fs.existsSync(path.join(root, hashString("atomic") + ".manifest"))).to.equal(true);
    expect(fs.readdirSync(root).filter(name => name.includes(".manifest.tmp-"))).to.deep.equal([]);
    /* A fresh cache reads the complete manifest back rather than rebuilding. */
    const files = await toPromise(
      cache.getOrCreate("atomic", () => {
        throw new Error("cache entry should not be rebuilt");
      })
    );
    expect(await toPromise(files.readFile("a.txt"))).to.equal("hi");
  });

  it("pre-cleans debris and removes partial entries on failure", async () => {
    const cache = new BuildCache(root, NULL_LOG);
    const targetDir = path.join(root, hashString("failing manifest"));
    /* Simulate a crashed earlier attempt: entry content but no manifest */
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, "leftover.txt"), "stale");

    let failure: Error | undefined;
    try {
      await toPromise(cache.getOrCreate("failing manifest", () => Computable.reject(new Error("boom"))));
    } catch (err) {
      failure = err as Error;
    }
    expect(failure?.message).to.equal("boom");
    /* The partial entry was removed on failure */
    expect(fs.existsSync(targetDir)).to.equal(false);

    /* A retry over fresh debris pre-cleans and succeeds */
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, "leftover.txt"), "stale");
    const files = await toPromise(
      cache.getOrCreate("failing manifest", () =>
        Computable.resolve(new FileSet(new Map([["meta.json", MemoryFile.from('{"ok":true}')]])))
      )
    );
    expect(await toPromise(files.readFile("meta.json"))).to.equal('{"ok":true}');
    expect(fs.existsSync(path.join(targetDir, "leftover.txt"))).to.equal(false);
  });

  it("joins concurrent demands for one key to a single creation", async () => {
    const cache = new BuildCache(root, NULL_LOG);
    let release!: () => void;
    const gate = Computable.from<undefined>(resolve => {
      release = () => resolve(undefined);
    });
    let creates = 0;
    const create = (): Computable<FileSet> =>
      gate.then(() => {
        creates++;
        return new FileSet(new Map([["out.txt", MemoryFile.from("content")]]));
      });

    const first = cache.getOrCreate("shared key", create);
    const second = cache.getOrCreate("shared key", create);
    release();
    const [a, b] = await Promise.all([toPromise(first), toPromise(second)]);
    expect(creates).to.equal(1);
    expect(await toPromise(a.readFile("out.txt"))).to.equal("content");
    expect(await toPromise(b.readFile("out.txt"))).to.equal("content");
  });

  it("retries after a failed creation instead of joining it", async () => {
    const cache = new BuildCache(root, NULL_LOG);
    let failure: Error | undefined;
    try {
      await toPromise(cache.getOrCreate("retry key", () => Computable.reject(new Error("boom"))));
    } catch (err) {
      failure = err as Error;
    }
    expect(failure?.message).to.equal("boom");
    const recovered = await toPromise(
      cache.getOrCreate("retry key", () => Computable.resolve(new FileSet(new Map([["out.txt", MemoryFile.from("ok")]]))))
    );
    expect(await toPromise(recovered.readFile("out.txt"))).to.equal("ok");
  });

  it("stores a blob addressed by its content hash", async () => {
    const cache = new BuildCache(root, NULL_LOG);
    const bytes = Buffer.from("hello blob");
    const hash = hashString(bytes);
    const blobPath = await toPromise(cache.ensureBlob(hash, bytes));
    expect(blobPath).to.equal(path.join(root, "blob", hash));
    expect(fs.readFileSync(blobPath, "utf8")).to.equal("hello blob");
    /* Atomic write leaves no temp debris behind */
    expect(fs.readdirSync(path.join(root, "blob")).some(name => name.includes(".tmp-"))).to.equal(false);
  });

  it("reuses an existing blob without rewriting it", async () => {
    const cache = new BuildCache(root, NULL_LOG);
    const bytes = Buffer.from("content");
    const hash = hashString(bytes);
    const first = await toPromise(cache.ensureBlob(hash, bytes));
    /* A second demand under the same (immutable) hash returns the same path and
     * the original content stands — the store trusts the hash, not the bytes. */
    const second = await toPromise(cache.ensureBlob(hash, Buffer.from("would-be-ignored")));
    expect(second).to.equal(first);
    expect(fs.readFileSync(second, "utf8")).to.equal("content");
  });

  it("converges concurrent ingests of the same blob to one atomic result", async () => {
    const cache = new BuildCache(root, NULL_LOG);
    const bytes = Buffer.from("shared blob");
    const hash = hashString(bytes);
    /* No in-flight lock: both writers run, but the content-addressed path and the
     * atomic rename mean they converge on one blob with the right content. */
    const [a, b] = await Promise.all([toPromise(cache.ensureBlob(hash, bytes)), toPromise(cache.ensureBlob(hash, bytes))]);
    expect(a).to.equal(b);
    expect(fs.readFileSync(a, "utf8")).to.equal("shared blob");
    expect(fs.readdirSync(path.join(root, "blob")).some(name => name.includes(".tmp-"))).to.equal(false);
  });

  it("returns the cached result without re-running the build", async () => {
    const cache = new BuildCache(root, NULL_LOG);
    await toPromise(
      cache.getOrCreate("test manifest", () =>
        Computable.resolve(new FileSet(new Map([["meta.json", MemoryFile.from('{"name":"test"}')]])))
      )
    );

    /* A separate BuildCache instance sees the persisted entry and never calls
     * create (a rebuild would throw), so a fully-cached run does no work. */
    const reopened = new BuildCache(root, NULL_LOG);
    const files = await toPromise(
      reopened.getOrCreate("test manifest", () => {
        throw new Error("cache entry should not be rebuilt");
      })
    );
    const content = await toPromise(files.readFile("meta.json"));
    expect(content).to.equal('{"name":"test"}');
  });

  it("streams a write into a content-addressed blob via getTemporaryWriteStream", async () => {
    const cache = new BuildCache(root, NULL_LOG);
    const handle = cache.getTemporaryWriteStream();
    handle.stream.write("hello ");
    handle.stream.write("stream");
    const file = await toPromise(handle.finalize("out.txt"));
    expect(file.hash).to.equal(hashString(Buffer.from("hello stream")));
    expect(await toPromise(file.readString())).to.equal("hello stream");
    /* The temp spool file was renamed into the pool, not left behind */
    expect(fs.readdirSync(path.join(root, "blob")).some(name => name.includes(".tmp-"))).to.equal(false);
  });

  it("rejects finalize (rather than hanging) when the stream errored first", async () => {
    const cache = new BuildCache(root, NULL_LOG);
    const handle = cache.getTemporaryWriteStream();
    handle.stream.write("partial");
    /* A pre-finalize stream failure (e.g. ENOSPC): the destination unpipes and no
     * `finish` will ever fire, so finalize must reject on the recorded error
     * instead of waiting forever. */
    handle.stream.destroy(new Error("disk full"));
    let failure: Error | undefined;
    try {
      await toPromise(handle.finalize("out.txt"));
    } catch (err) {
      failure = err as Error;
    }
    expect(failure?.message).to.equal("disk full");
  });
});

type Responder = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/** A controllable local origin: records each request's headers and answers with
 * whatever responder the test has currently installed. */
function startOrigin(): Promise<{
  url: string;
  requests: http.IncomingHttpHeaders[];
  respond: (responder: Responder) => void;
  close: () => void;
}> {
  return new Promise(resolve => {
    let responder: Responder = (_req, res) => {
      res.writeHead(500);
      res.end();
    };
    const requests: http.IncomingHttpHeaders[] = [];
    const server = http.createServer((req, res) => {
      requests.push(req.headers);
      responder(req, res);
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/doc`,
        requests,
        respond: r => (responder = r),
        close: () => server.close(),
      });
    });
  });
}

const serve = (status: number, headers: http.OutgoingHttpHeaders, body?: string): Responder => {
  return (_req, res) => {
    res.writeHead(status, headers);
    res.end(body);
  };
};

describe("BuildCache non-immutable fetches", () => {
  let root: string;
  let clock: number;
  let cache: BuildCache;
  let origin: Awaited<ReturnType<typeof startOrigin>>;
  let processed: string[];

  /** The process callback: records each invocation's body and stores it. */
  const store = (content: Readable): Computable<FileSet> =>
    readStream(content).then(data => {
      processed.push(data.toString());
      return new FileSet(new Map([["doc.txt", MemoryFile.from(data.toString())]]));
    });

  const fetchDoc = (options?: Parameters<BuildCache["getOrFetch"]>[4]): Promise<string> =>
    toPromise(cache.getOrFetch(origin.url, "test:1", store, undefined, options).then(files => files.readFile("doc.txt")));

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-mutfetch-test-"));
    clock = 1_000_000;
    cache = new BuildCache(root, NULL_LOG, () => clock);
    origin = await startOrigin();
    processed = [];
  });

  afterEach(() => {
    origin.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("caches with origin-derived freshness and serves without refetching until stale", async () => {
    origin.respond(serve(200, { "cache-control": "max-age=300", etag: '"v1"' }, "one"));
    expect(await fetchDoc({ immutable: false })).to.equal("one");
    clock += 299_000; /* within max-age */
    expect(await fetchDoc({ immutable: false })).to.equal("one");
    expect(origin.requests).to.have.lengthOf(1);
    expect(processed).to.deep.equal(["one"]);
  });

  it("revalidates a stale entry conditionally and refreshes it in place on 304", async () => {
    origin.respond(serve(200, { "cache-control": "max-age=300", etag: '"v1"' }, "one"));
    await fetchDoc({ immutable: false });
    clock += 301_000; /* stale */
    origin.respond(serve(304, { "cache-control": "max-age=300", etag: '"v1"' }));
    expect(await fetchDoc({ immutable: false })).to.equal("one");
    expect(origin.requests).to.have.lengthOf(2);
    expect(origin.requests[1]["if-none-match"]).to.equal('"v1"');
    /* The 304 did not re-run process, and it restarted the freshness lifetime */
    expect(processed).to.deep.equal(["one"]);
    clock += 299_000;
    await fetchDoc({ immutable: false });
    expect(origin.requests).to.have.lengthOf(2);
  });

  it("replaces a stale entry when the origin serves new content", async () => {
    origin.respond(serve(200, { "cache-control": "max-age=300", etag: '"v1"' }, "one"));
    await fetchDoc({ immutable: false });
    clock += 301_000;
    origin.respond(serve(200, { "cache-control": "max-age=300", etag: '"v2"' }, "two"));
    expect(await fetchDoc({ immutable: false })).to.equal("two");
    expect(processed).to.deep.equal(["one", "two"]);
    /* Next revalidation presents the new validator */
    clock += 301_000;
    origin.respond(serve(304, {}));
    await fetchDoc({ immutable: false });
    expect(origin.requests[2]["if-none-match"]).to.equal('"v2"');
  });

  it("serves the stale copy, warning, when revalidation cannot reach the origin", async () => {
    const warnings: Record<string, unknown>[] = [];
    const logging = new BuildCache(root, { log: (_diagnostic, params) => warnings.push(params) }, () => clock);
    const fetchLogged = (): Promise<string> =>
      toPromise(logging.getOrFetch(origin.url, "test:1", store, undefined, { immutable: false }).then(files => files.readFile("doc.txt")));
    origin.respond(serve(200, { "cache-control": "max-age=300" }, "one"));
    await fetchLogged();
    expect(warnings).to.have.lengthOf(0);
    origin.close();
    clock += 301_000;
    expect(await fetchLogged()).to.equal("one");
    expect(warnings).to.have.lengthOf(1);
    expect(warnings[0].url).to.equal(origin.url);
  });

  it("propagates a validation failure and keeps the previous entry standing", async () => {
    origin.respond(serve(200, { "cache-control": "max-age=300", etag: '"v1"' }, "one"));
    await fetchDoc({ immutable: false });
    clock += 301_000;
    origin.respond(serve(200, { "cache-control": "max-age=300", etag: '"v2"' }, "two"));
    const reject = (content: Readable): Computable<FileSet> =>
      readStream(content).then(() => {
        throw new Error("invalid content");
      });
    let failure: Error | undefined;
    try {
      await toPromise(cache.getOrFetch(origin.url, "test:1", reject, undefined, { immutable: false }));
    } catch (err) {
      failure = err as Error;
    }
    expect(failure?.message).to.equal("invalid content");
    /* The previous entry survives: a later revalidation can still 304 onto it */
    origin.respond(serve(304, { "cache-control": "max-age=300" }));
    expect(await fetchDoc({ immutable: false })).to.equal("one");
  });

  it("forceRevalidate revalidates a still-fresh entry", async () => {
    origin.respond(serve(200, { "cache-control": "max-age=300", etag: '"v1"' }, "one"));
    await fetchDoc({ immutable: false });
    origin.respond(serve(304, { "cache-control": "max-age=300" }));
    expect(await fetchDoc({ immutable: false, forceRevalidate: true })).to.equal("one");
    expect(origin.requests).to.have.lengthOf(2);
    expect(origin.requests[1]["if-none-match"]).to.equal('"v1"');
  });

  it("treats an origin declaring no freshness as stale immediately (revalidate every demand)", async () => {
    /* No fabr-side TTL policy: the origin owns its staleness contract, and
     * declaring none means every demand revalidates (cheap 304s with an ETag). */
    origin.respond(serve(200, { etag: '"v1"' }, "one"));
    await fetchDoc({ immutable: false });
    origin.respond(serve(304, { etag: '"v1"' }));
    expect(await fetchDoc({ immutable: false })).to.equal("one");
    expect(origin.requests).to.have.lengthOf(2);
    expect(origin.requests[1]["if-none-match"]).to.equal('"v1"');
  });

  it("subtracts the response's Age from the declared lifetime (CDN edge-served copies)", async () => {
    /* npmjs serves packuments via a CDN: max-age=300 with `age` routinely near
     * it. Remaining freshness is max-age − Age, not a fresh max-age. */
    origin.respond(serve(200, { "cache-control": "max-age=300", age: "290", etag: '"v1"' }, "one"));
    await fetchDoc({ immutable: false });
    clock += 11_000; /* past the remaining 10s, well within a naive 300s */
    origin.respond(serve(304, { "cache-control": "max-age=300" }));
    await fetchDoc({ immutable: false });
    expect(origin.requests).to.have.lengthOf(2);
  });

  it("honors a long origin-declared lifetime as given (no fabr-side clamp)", async () => {
    origin.respond(serve(200, { "cache-control": "max-age=86400" }, "one"));
    await fetchDoc({ immutable: false });
    clock += 80_000_000; /* deep into the declared day */
    expect(await fetchDoc({ immutable: false })).to.equal("one");
    expect(origin.requests).to.have.lengthOf(1);
  });

  it("never mistakes a file named like the meta header for the header", async () => {
    /* A hostile/unlucky file name that textually mimics the `!meta` line must
     * round-trip as an ordinary file: file lines start with the content hash
     * (hex — no `!`), and only the first line is parsed as the header. */
    const trap = '!meta {"expires":0}';
    origin.respond(serve(200, { "cache-control": "max-age=300" }, "irrelevant"));
    const files = await toPromise(
      cache.getOrFetch(
        origin.url,
        "test:1",
        content =>
          readStream(content).then(
            () => new FileSet(new Map([[trap, MemoryFile.from("gotcha")], ["doc.txt", MemoryFile.from("one")]]))
          ),
        undefined,
        { immutable: false }
      )
    );
    expect(await toPromise(files.readFile(trap))).to.equal("gotcha");
    /* Reopened (fresh parse from disk): the trap file survives as a file and
     * the entry still has its real freshness header (no refetch while fresh). */
    const reopened = new BuildCache(root, NULL_LOG, () => clock);
    const again = await toPromise(
      reopened.getOrFetch(
        origin.url,
        "test:1",
        () => {
          throw new Error("should not refetch");
        },
        undefined,
        { immutable: false }
      )
    );
    expect(await toPromise(again.readFile(trap))).to.equal("gotcha");
    expect(await toPromise(again.readFile("doc.txt"))).to.equal("one");
    expect(origin.requests).to.have.lengthOf(1);
  });

  it("leaves immutable fetches untouched: no meta line, never refetched", async () => {
    origin.respond(serve(200, { "cache-control": "max-age=1" }, "one"));
    expect(await fetchDoc()).to.equal("one");
    const manifest = fs.readFileSync(
      path.join(root, hashString(`fetch:test:1 ${origin.url}`) + ".manifest"),
      "utf8"
    );
    expect(manifest).to.not.contain("!meta");
    clock += 1_000_000_000; /* far past any origin-declared lifetime */
    expect(await fetchDoc()).to.equal("one");
    expect(origin.requests).to.have.lengthOf(1);
  });
});
