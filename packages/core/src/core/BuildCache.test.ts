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

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { BuildCache } from "./BuildCache";
import { Computable } from "./Computable";
import { readStream } from "./Fetch";
import { DEFAULT_FILE_MODE, FileSet } from "./FileSet";
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

  it("treats a manifest with a corrupt mode field as a miss, not a NaN mode", async () => {
    const cache = new BuildCache(root, NULL_LOG);
    const build = (): Computable<FileSet> =>
      cache.getOrCreate("bad mode", () => Computable.resolve(new FileSet(new Map([["x.txt", MemoryFile.from("x")]]))));
    await toPromise(build());

    /* Corrupt the stored mode. A bogus field must fail the parse (so the entry
     * rebuilds), never parse to NaN and ride on the IFile as its permissions. */
    const manifest = fs.readdirSync(root).find(name => name.endsWith(".manifest"))!;
    const manifestPath = path.join(root, manifest);
    fs.writeFileSync(manifestPath, fs.readFileSync(manifestPath, "utf8").replace(/^(\S+) \S+ /m, "$1 nonsense "));

    const reopened = new BuildCache(root, NULL_LOG);
    let rebuilt = false;
    const files = await toPromise(
      reopened.getOrCreate("bad mode", () => {
        rebuilt = true;
        return Computable.resolve(new FileSet(new Map([["x.txt", MemoryFile.from("x")]])));
      })
    );
    expect(rebuilt).to.equal(true);
    expect((await toPromise(files.get("x.txt")))!.mode).to.equal(DEFAULT_FILE_MODE);
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
    /* Nothing transient is left in the store: the temp behind that atomic write
     * lives in the work tree, and only blobs and manifests belong up here. */
    expect(fs.readdirSync(root).filter(name => !["blob", "work"].includes(name) && !name.endsWith(".manifest"))).to.deep.equal([]);
    /* A fresh cache reads the complete manifest back rather than rebuilding. */
    const files = await toPromise(
      cache.getOrCreate("atomic", () => {
        throw new Error("cache entry should not be rebuilt");
      })
    );
    expect(await toPromise(files.readFile("a.txt"))).to.equal("hi");
  });

  it("gives each attempt a fresh work dir and leaves nothing of a failed one", async () => {
    const cache = new BuildCache(root, NULL_LOG);
    const dirs: string[] = [];
    /* A failing attempt that gets as far as writing into its work dir — the
     * crashed-mid-build shape, which a retry must not inherit. */
    const failing = (dir: string): Computable<FileSet> => {
      dirs.push(dir);
      fs.writeFileSync(path.join(dir, "partial.txt"), "half a build");
      return Computable.reject(new Error("boom"));
    };

    let failure: Error | undefined;
    try {
      await toPromise(cache.getOrCreate("failing manifest", failing));
    } catch (err) {
      failure = err as Error;
    }
    expect(failure?.message).to.equal("boom");
    expect(fs.existsSync(dirs[0]), "the failed attempt's work dir is gone").to.equal(false);
    expect(fs.existsSync(path.join(root, hashString("failing manifest") + ".manifest")), "and it committed nothing").to.equal(false);

    /* The retry gets its own dir rather than whatever the last attempt left —
     * work dirs are named by owner, so there is no shared per-key dir to
     * inherit debris through. */
    const files = await toPromise(
      cache.getOrCreate("failing manifest", dir => {
        dirs.push(dir);
        expect(fs.readdirSync(dir), "a fresh work dir").to.deep.equal([]);
        return Computable.resolve(new FileSet(new Map([["meta.json", MemoryFile.from('{"ok":true}')]])));
      })
    );
    expect(dirs[1]).to.not.equal(dirs[0]);
    expect(await toPromise(files.readFile("meta.json"))).to.equal('{"ok":true}');
    expect(fs.existsSync(dirs[1]), "and the successful attempt's dir is discarded too").to.equal(false);
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

  /* Both failure routes into finalize must clear the spool. A `pipe` source error does
   * not destroy the destination, so the stream keeps its fd — and its file — unless
   * something tears it down, and finalize's failure path is the only place that can. The
   * store's work tree is reclaimed on the assumption that a settled action is finished
   * with it, so debris left here outlives the build. */
  it("leaves no spool behind when the error is recorded before finalize", async () => {
    const cache = new BuildCache(root, NULL_LOG);
    const handle = cache.getTemporaryWriteStream();
    handle.stream.write("partial");
    handle.stream.destroy(new Error("disk full"));
    /* `destroy(err)` emits 'error' on a *later* tick, so wait for it: only then is the
     * failure recorded, and only then does finalize take its already-failed path. */
    await new Promise(resolve => setImmediate(resolve));

    let failure: Error | undefined;
    await toPromise(handle.finalize("out.txt")).then(
      () => expect.fail("finalize should have rejected"),
      err => {
        failure = err as Error;
      }
    );
    expect(failure?.message).to.equal("disk full");
    expect(spoolFiles(root)).to.deep.equal([]);

    /* And it must not come *back*: createWriteStream opens asynchronously, so an unlink
     * issued before that open lands is undone by the open itself. */
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(spoolFiles(root)).to.deep.equal([]);
  });

  it("leaves no spool behind when the error arrives after finalize", async () => {
    const cache = new BuildCache(root, NULL_LOG);
    const handle = cache.getTemporaryWriteStream();
    handle.stream.write("partial");
    handle.stream.destroy(new Error("disk full")); /* 'error' lands after finalize starts */
    await toPromise(handle.finalize("out.txt")).then(
      () => expect.fail("finalize should have rejected"),
      () => undefined
    );
    expect(spoolFiles(root)).to.deep.equal([]);
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(spoolFiles(root)).to.deep.equal([]);
  });

  it("leaves no spool behind when the output is discarded", async () => {
    const cache = new BuildCache(root, NULL_LOG);
    const handle = cache.getTemporaryWriteStream();
    handle.stream.write("partial");
    handle.discard();
    /* discard() is void — the callers are synchronous error paths — so the removal
     * completes in the background, after the fd closes. */
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(spoolFiles(root)).to.deep.equal([]);
  });
});

/** Every spool temp still present under the store root, at any depth (they live in the
 * per-process work tree, whose name a test has no business knowing). */
function spoolFiles(root: string): string[] {
  const walk = (dir: string): string[] =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap(entry => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [entry.name]));
  return walk(root).filter(name => name.startsWith("stream-"));
}

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

  it("propagates a definite 4xx on revalidation rather than serving stale (auth/not-found)", async () => {
    const warnings: Record<string, unknown>[] = [];
    const logging = new BuildCache(root, { log: (_diagnostic, params) => warnings.push(params) }, () => clock);
    const fetchLogged = (): Promise<string> =>
      toPromise(logging.getOrFetch(origin.url, "test:1", store, undefined, { immutable: false }).then(files => files.readFile("doc.txt")));
    origin.respond(serve(200, { "cache-control": "max-age=300" }, "one"));
    await fetchLogged();
    clock += 301_000; /* stale */
    origin.respond(serve(403, {})); /* expired token: a definite answer, not a blip */
    let failure: Error | undefined;
    try {
      await fetchLogged();
    } catch (err) {
      failure = err as Error;
    }
    expect(failure).to.be.an("error");
    expect(warnings).to.have.lengthOf(0); /* not degraded to a stale-serve warning */
  });

  it("serves the stale copy on a retry-later 4xx (429 rate-limited)", async () => {
    const warnings: Record<string, unknown>[] = [];
    const logging = new BuildCache(root, { log: (_diagnostic, params) => warnings.push(params) }, () => clock);
    const fetchLogged = (): Promise<string> =>
      toPromise(logging.getOrFetch(origin.url, "test:1", store, undefined, { immutable: false }).then(files => files.readFile("doc.txt")));
    origin.respond(serve(200, { "cache-control": "max-age=300" }, "one"));
    await fetchLogged();
    clock += 301_000; /* stale */
    origin.respond(serve(429, {})); /* rate-limited: a transient try-later signal */
    expect(await fetchLogged()).to.equal("one");
    expect(warnings).to.have.lengthOf(1);
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

/**
 * The work tree: every transient the cache writes (build-step work dirs, the
 * temps behind atomic writes, an interactive verb's staged install) lives under
 * `work/<host>-<pid>/`, owned by the process that made it. Naming them by owner
 * rather than by cache key is what makes them reclaimable — debris under a key
 * nothing rebuilds is never cleaned — and what keeps two fabr processes sharing
 * a cache out of each other's way.
 */
describe("BuildCache work tree", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-worktree-test-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** This host's owner prefix, read back from a cache rather than recomputed —
   * the naming stays the implementation's business. Probed on a throwaway root:
   * taking ownership of a tree happens once per process, so doing it here on the
   * root under test would consume the very reclaim the test is watching for. */
  function hostPrefix(): string {
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-worktree-probe-"));
    try {
      new BuildCache(probe, NULL_LOG);
      const owner = fs.readdirSync(path.join(probe, "work"))[0];
      return owner.slice(0, owner.lastIndexOf("-"));
    } finally {
      fs.rmSync(probe, { recursive: true, force: true });
    }
  }

  /** A pid that certainly no longer exists: a process run to completion. */
  function deadPid(): number {
    const { pid } = spawnSync(process.execPath, ["-e", ""]);
    expect(pid).to.be.a("number");
    return pid!;
  }

  function seedOwner(owner: string): string {
    const dir = path.join(root, "work", owner);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "debris"), "x");
    return dir;
  }

  it("hands out work dirs inside this process's own tree", () => {
    const cache = new BuildCache(root, NULL_LOG);
    const dir = cache.createWorkDir("run-");
    expect(path.dirname(dir)).to.equal(path.join(root, "work", `${hostPrefix()}-${process.pid}`));
    expect(path.basename(dir).startsWith("run-")).to.equal(true);
    expect(fs.existsSync(dir)).to.equal(true);
    cache.releaseWorkDir(dir);
    expect(fs.existsSync(dir)).to.equal(false);
  });

  it("reclaims a dead process's tree but leaves a live one alone", () => {
    const host = hostPrefix();
    const dead = seedOwner(`${host}-${deadPid()}`);
    /* Our own parent: alive, and not us — so it must survive untouched. */
    const live = seedOwner(`${host}-${process.ppid}`);
    new BuildCache(root, NULL_LOG);
    expect(fs.existsSync(dead), "a dead owner's tree is reaped").to.equal(false);
    expect(fs.existsSync(live), "a live owner's tree is untouched").to.equal(true);
  });

  it("leaves another host's tree alone, whatever its pid says", () => {
    /* Pids from elsewhere mean nothing here — that tree is its own owner's to
     * reap (a cache on shared storage). */
    const foreign = seedOwner(`otherhost-${deadPid()}`);
    new BuildCache(root, NULL_LOG);
    expect(fs.existsSync(foreign)).to.equal(true);
  });

  it("reclaims its own tree on startup, debris and all", () => {
    /* The pid-reuse case: inheriting a dead fabr's pid means inheriting its
     * debris, which is ours to clean. */
    const own = seedOwner(`${hostPrefix()}-${process.pid}`);
    new BuildCache(root, NULL_LOG);
    expect(fs.existsSync(path.join(own, "debris"))).to.equal(false);
    expect(fs.existsSync(own), "and the tree itself is ready to use").to.equal(true);
  });
});
