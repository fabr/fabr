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
import { ActionContext, BuildCache, IBuildState } from "./BuildCache";
import { PackageFileSet, PackageGraphBuilder } from "./PackageFileSet";
import { ActionFileInputs, BuildAction, BuildResult, IBuildActionDefinition, preciseActionKey } from "./BuildAction";
import { narrowDeps } from "./BuildCache";
import { DiscoveredDeps, parseRecordedBase } from "./Manifest";
import { Computable } from "./Computable";
import { readStream } from "./Fetch";
import { SILENT_REPORT, TaskTracker } from "../support/Execute";
import { DEFAULT_FILE_MODE, FileSet } from "./FileSet";
import { hashString } from "./FSWrapper";
import { FSFile } from "./FSFileSource";
import { MemoryFile } from "./MemoryFS";
import { CacheLink, SymlinkFile } from "./SymlinkFile";
import { Log } from "../support/Log";
import { expect } from "chai";

const NULL_LOG: Log = { log: () => undefined };
/** A unit test is its own observer: track transfers with the silent report. */
const UNTRACKED: TaskTracker<FileSet> = run => run(SILENT_REPORT);

function toPromise<T>(computable: Computable<T>): Promise<T> {
  return new Promise((resolve, reject) => computable.then(resolve, reject));
}

/** A plain step's answer: the files it produced and nothing discovered. */
function produced(files: FileSet): Computable<BuildResult> {
  return Computable.resolve({ result: files });
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
      cache.getOrCreate("test manifest", () => produced(new FileSet(new Map([["meta.json", MemoryFile.from('{"name":"test"}')]]))))
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
      cache.getOrCreate("with modes", () =>
        produced(
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

  it("persists the sniffed mime through the manifest", async () => {
    const cache = new BuildCache(root, NULL_LOG);
    const gzip = new MemoryFile(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00]));
    const store = (create: () => Computable<BuildResult>): Computable<FileSet> => cache.getOrCreate("with mime", create);
    await toPromise(
      store(() =>
        produced(
          new FileSet(
            new Map([
              ["a.tgz", gzip],
              ["notes.txt", MemoryFile.from("text")],
            ])
          )
        )
      )
    );

    /* A fresh cache serves the classification straight from the manifest —
     * no content read, and no rebuild. */
    const reopened = new BuildCache(root, NULL_LOG);
    const files = await toPromise(
      reopened.getOrCreate("with mime", () => {
        throw new Error("cache entry should not be rebuilt");
      })
    );
    expect((await toPromise(files.get("a.tgz")))!.mime).to.equal("application/gzip");
    expect((await toPromise(files.get("notes.txt")))!.mime).to.equal("application/octet-stream");
  });

  it("round-trips names needing URI encoding (a space, a literal %)", async () => {
    const cache = new BuildCache(root, NULL_LOG);
    /* The name field is encodeURI'd so the field separator stays unambiguous;
     * a name carrying its own '%' must come back as written, not re-decoded. */
    const names = ["dir/a b.txt", "100%25.txt", "plain.txt"];
    const content = new Map(names.map(name => [name, MemoryFile.from(name)]));
    await toPromise(cache.getOrCreate("encoded names", () => produced(new FileSet(content))));

    const reopened = new BuildCache(root, NULL_LOG);
    const files = await toPromise(
      reopened.getOrCreate("encoded names", () => {
        throw new Error("cache entry should not be rebuilt");
      })
    );
    expect([...files].map(([name]) => name).sort()).to.deep.equal([...names].sort());
  });

  it("treats a mime-less (pre-mime) manifest line as a miss", async () => {
    const cache = new BuildCache(root, NULL_LOG);
    const build = (): Computable<FileSet> =>
      cache.getOrCreate("legacy line", () => produced(new FileSet(new Map([["x.txt", MemoryFile.from("x")]]))));
    await toPromise(build());

    /* Strip the trailing mime field, leaving the old three-field form. The
     * entry must rebuild — the format-change equivalent of a tag bump. */
    const manifest = fs.readdirSync(root).find(name => name.endsWith(".manifest"))!;
    const manifestPath = path.join(root, manifest);
    fs.writeFileSync(manifestPath, fs.readFileSync(manifestPath, "utf8").replace(/^(\S+ \S+ \S+) \S+$/m, "$1"));

    const reopened = new BuildCache(root, NULL_LOG);
    let rebuilt = false;
    await toPromise(
      reopened.getOrCreate("legacy line", () => {
        rebuilt = true;
        return produced(new FileSet(new Map([["x.txt", MemoryFile.from("x")]])));
      })
    );
    expect(rebuilt).to.equal(true);
  });

  it("treats an entry manifest torn at a line boundary as a miss, not a shorter entry", async () => {
    /* The case the count exists for, and the one no other field catches: the
     * manifest is written temp-then-rename with no fsync, so a power loss can
     * leave it whole lines short. Every line it kept parses, every blob it
     * names exists — so without the count the cache would serve an INCOMPLETE
     * build output as a hit. */
    const cache = new BuildCache(root, NULL_LOG);
    const files = new FileSet(
      new Map([
        ["a.txt", MemoryFile.from("a")],
        ["b.txt", MemoryFile.from("b")],
      ])
    );
    await toPromise(cache.getOrCreate("torn entry", () => produced(files)));

    const manifestPath = path.join(root, hashString("torn entry") + ".manifest");
    const lines = fs.readFileSync(manifestPath, "utf8").split("\n");
    fs.writeFileSync(manifestPath, [...lines.slice(0, lines.length - 2), ""].join("\n"));

    let rebuilt = false;
    const served = await toPromise(
      new BuildCache(root, NULL_LOG).getOrCreate("torn entry", () => {
        rebuilt = true;
        return produced(files);
      })
    );
    expect(rebuilt, "a lost line is a miss").to.equal(true);
    expect([...served].map(([name]) => name).sort()).to.deep.equal(["a.txt", "b.txt"]);
  });

  it("treats a countless (pre-count) manifest as a miss", async () => {
    /* Requiring the field IS the format bump: every manifest written before the
     * count reads as malformed and rebuilds, exactly as the mime-less ones did.
     * No version constant, and nothing grandfathered. */
    const cache = new BuildCache(root, NULL_LOG);
    const build = (): Computable<FileSet> =>
      cache.getOrCreate("countless", () => produced(new FileSet(new Map([["x.txt", MemoryFile.from("x")]]))));
    await toPromise(build());

    const manifestPath = path.join(root, hashString("countless") + ".manifest");
    fs.writeFileSync(manifestPath, fs.readFileSync(manifestPath, "utf8").split("\n").slice(1).join("\n"));

    let rebuilt = false;
    await toPromise(
      new BuildCache(root, NULL_LOG).getOrCreate("countless", () => {
        rebuilt = true;
        return produced(new FileSet(new Map([["x.txt", MemoryFile.from("x")]])));
      })
    );
    expect(rebuilt).to.equal(true);
  });

  it("treats a manifest with a corrupt mode field as a miss, not a NaN mode", async () => {
    const cache = new BuildCache(root, NULL_LOG);
    const build = (): Computable<FileSet> =>
      cache.getOrCreate("bad mode", () => produced(new FileSet(new Map([["x.txt", MemoryFile.from("x")]]))));
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
        return produced(new FileSet(new Map([["x.txt", MemoryFile.from("x")]])));
      })
    );
    expect(rebuilt).to.equal(true);
    expect((await toPromise(files.get("x.txt")))!.mode).to.equal(DEFAULT_FILE_MODE);
  });

  it("round-trips a symlink through the manifest without materialising a blob", async () => {
    const cache = new BuildCache(root, NULL_LOG);
    await toPromise(
      cache.getOrCreate("with symlink", () =>
        produced(
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

  it("never reconstructs a cache link from a manifest, whatever the target text spells", async () => {
    /* The laundering regression: a delivered tarball can contain a symlink whose
     * literal target reads `fabr-cache:…`. Nothing may promote that text back
     * into the class staging exempts from containment — so it round-trips as the
     * ordinary symlink it always was, and the guard disposes of it as usual. */
    const cache = new BuildCache(root, NULL_LOG);
    await toPromise(
      cache.getOrCreate("with a suspicious link", () =>
        produced(new FileSet(new Map<string, import("./FileSet").IFile>([["evil", new SymlinkFile("fabr-cache:tree/../../../etc")]])))
      )
    );
    const reopened = new BuildCache(root, NULL_LOG);
    const files = await toPromise(
      reopened.getOrCreate("with a suspicious link", () => {
        throw new Error("cache entry should not be rebuilt");
      })
    );
    const link = (await toPromise(files.get("evil")))!;
    expect(link).to.be.instanceOf(SymlinkFile);
    expect(link).to.not.be.instanceOf(CacheLink);
    expect((link as SymlinkFile).target).to.equal("fabr-cache:tree/../../../etc");
  });

  it("writes the manifest atomically, leaving no temp debris", async () => {
    const cache = new BuildCache(root, NULL_LOG);
    await toPromise(cache.getOrCreate("atomic", () => produced(new FileSet(new Map([["a.txt", MemoryFile.from("hi")]])))));
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
    const failing = (ctx: ActionContext): Computable<BuildResult> => {
      dirs.push(ctx.workDir);
      fs.writeFileSync(path.join(ctx.workDir, "partial.txt"), "half a build");
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
      cache.getOrCreate("failing manifest", ctx => {
        dirs.push(ctx.workDir);
        expect(fs.readdirSync(ctx.workDir), "a fresh work dir").to.deep.equal([]);
        return produced(new FileSet(new Map([["meta.json", MemoryFile.from('{"ok":true}')]])));
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
    const create = (): Computable<BuildResult> =>
      gate.then(() => {
        creates++;
        return { result: new FileSet(new Map([["out.txt", MemoryFile.from("content")]])) };
      });

    const first = cache.getOrCreate("shared key", create);
    const second = cache.getOrCreate("shared key", create);
    release();
    const [a, b] = await Promise.all([toPromise(first), toPromise(second)]);
    expect(creates).to.equal(1);
    expect(await toPromise(a.readFile("out.txt"))).to.equal("content");
    expect(await toPromise(b.readFile("out.txt"))).to.equal("content");
  });

  it("rebuilds a stored entry when the demand forces it, and re-stores the result", async () => {
    const cache = new BuildCache(root, NULL_LOG);
    let creates = 0;
    const create = (): Computable<BuildResult> => {
      creates++;
      return produced(new FileSet(new Map([["out.txt", MemoryFile.from(`build ${creates}`)]])));
    };
    await toPromise(cache.getOrCreate("forced key", create));
    /* Force defeats the lookup only: the rebuilt result commits as an ordinary
     * entry, so the next unforced demand is a hit again — on the newer content. */
    const forced = await toPromise(cache.getOrCreate("forced key", create, { force: true }));
    expect(creates).to.equal(2);
    expect(await toPromise(forced.readFile("out.txt"))).to.equal("build 2");
    const served = await toPromise(cache.getOrCreate("forced key", create));
    expect(creates).to.equal(2);
    expect(await toPromise(served.readFile("out.txt"))).to.equal("build 2");
  });

  it("joins a forced demand to an attempt already in flight for the key", async () => {
    /* The work is being redone by this run either way, so the second demand has
     * nothing to force — joining is what "one attempt per key" means. */
    const cache = new BuildCache(root, NULL_LOG);
    let release!: () => void;
    const gate = Computable.from<undefined>(resolve => {
      release = () => resolve(undefined);
    });
    let creates = 0;
    const create = (): Computable<BuildResult> =>
      gate.then(() => {
        creates++;
        return { result: new FileSet(new Map([["out.txt", MemoryFile.from("content")]])) };
      });

    const first = cache.getOrCreate("in-flight key", create);
    const second = cache.getOrCreate("in-flight key", create, { force: true });
    release();
    await Promise.all([toPromise(first), toPromise(second)]);
    expect(creates).to.equal(1);
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
      cache.getOrCreate("retry key", () => produced(new FileSet(new Map([["out.txt", MemoryFile.from("ok")]]))))
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
      cache.getOrCreate("test manifest", () => produced(new FileSet(new Map([["meta.json", MemoryFile.from('{"name":"test"}')]]))))
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

  it("classifies streamed content whose magic spans chunk boundaries", async () => {
    /* The head capture accumulates across writes, so a magic split over many
     * small chunks still classifies (gzip's is 3 bytes; write 1 at a time). */
    const cache = new BuildCache(root, NULL_LOG);
    const handle = cache.getTemporaryWriteStream();
    const content = Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08]), Buffer.alloc(400)]);
    for (const byte of content) {
      handle.stream.write(Buffer.from([byte]));
    }
    const file = await toPromise(handle.finalize("spanned.gz"));
    expect(file.mime).to.equal("application/gzip");
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

/**
 * Discovered dependencies: a step that may read any of its discoverable inputs
 * but reports which of them it actually read — as a selection in the inputs'
 * own vocabulary (package instances + package-root-relative files) — so the
 * entry is keyed on that selection's content and a change to an unread
 * discoverable dep invalidates nothing.
 *
 * The synthetic step is a miniature compiler over a delivered package of
 * "headers": it always reads `a.h`, plus whatever `a.h`'s own content names (a
 * comma-separated include list) — so a *content* change to a used header can
 * change the read set, which is the only thing that makes a second record
 * appear. Its output is what it read, so any stale reuse would show up as
 * wrong content rather than merely as a wrong run count.
 */
describe("BuildCache discovered dependencies", () => {
  let root: string;
  let cache: BuildCache;
  let runs: number;

  /* The anchor: the always-real inputs (a source, an argv, a tool identity),
   * with the discoverable inputs omitted entirely. */
  const ANCHOR = 'rule:test:cc:1\nargv=["cc","-c","foo.c"]\nsrc={hash-of-foo.c 644 foo.c}';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-discovered-deps-test-"));
    cache = new BuildCache(root, NULL_LOG);
    runs = 0;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** The discoverable inputs as they currently stand: one delivered package of
   * headers, name -> content. */
  function discoverableDeps(headers: Record<string, string>, version = "1.0.0"): ActionFileInputs {
    return { deps: [headerPackage(headers, version)] };
  }

  function headerPackage(
    headers: Record<string, string>,
    version = "1.0.0",
    deps: PackageFileSet[] = [],
    name = "hdrs"
  ): PackageFileSet {
    return new PackageFileSet(
      new Map(Object.entries(headers).map(([file, content]) => [file, MemoryFile.from(content)])),
      name,
      version,
      deps
    );
  }

  function depsOf(discoverable: ActionFileInputs): PackageFileSet[] {
    return discoverable.deps as PackageFileSet[];
  }

  /** What the step reports having read: files of the one header package,
   * each stated as the path that found it — the package's own edge from the
   * input's members, then the file. */
  function selectionOf(discoverable: ActionFileInputs, names: string[]): DiscoveredDeps {
    const held = depsOf(discoverable)[0].packageName;
    return new Map([["deps", [...names].sort().map(file => [held, file])]]);
  }

  /** What the step reads: `a.h`, plus the headers `a.h` itself includes (of
   * those that exist — an unresolvable include is simply not a read). */
  async function readSet(discoverable: ActionFileInputs): Promise<string[]> {
    const pkg = depsOf(discoverable)[0];
    const includes = (await toPromise(pkg.readFile("a.h"))).split(",").filter(name => pkg.getFile(name) !== undefined);
    return ["a.h", ...includes];
  }

  /** One demand of the compile against the inputs as they currently stand. */
  function build(discoverable: ActionFileInputs, options?: { force?: boolean }): Promise<FileSet> {
    return toPromise(
      cache.getOrCreate(
        ANCHOR,
        () => {
          runs++;
          return Computable.from<BuildResult>(resolve => {
            void readSet(discoverable).then(names =>
              resolve({
                result: new FileSet(new Map([["foo.o", MemoryFile.from(objectFor(names))]])),
                discoveredDeps: selectionOf(discoverable, names),
              })
            );
          });
        },
        { ...options, discoverable }
      )
    );
  }

  /** The "object file": exactly what the compile read, so reuse of the wrong
   * entry is visible as content, not just as a missing run. */
  function objectFor(names: string[]): string {
    return [...names].sort().join("+");
  }

  /** The discovered-deps records under the anchor. */
  function records(): string[] {
    const dir = path.join(root, "deps", hashString(ANCHOR));
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  }

  it("stores the result under the precise key, never under the anchor", async () => {
    const discoverable = discoverableDeps({ "a.h": "", "b.h": "unused" });
    await build(discoverable);
    expect(runs).to.equal(1);
    /* The anchor omits the discoverable, so a result there would not be a
     * function of its key — the entry lives under the precise key its reads
     * make: the anchor, the content manifest of what the paths found, and the
     * names they did not. */
    expect(fs.existsSync(path.join(root, hashString(ANCHOR) + ".manifest"))).to.equal(false);
    const used = narrowDeps(discoverable, selectionOf(discoverable, ["a.h"]));
    expect(fs.existsSync(path.join(root, hashString(preciseActionKey(hashString(ANCHOR), used)) + ".manifest"))).to.equal(true);
  });

  it("does not join an in-flight attempt that was given different discoverable", async () => {
    /**
     * The in-flight dedup is a lock on the entry AND a join, and the key it
     * used was the anchor alone. Two demands can share an anchor and differ in
     * their discoverable inputs — under watch, a superseded cycle still running
     * while the next one starts after a dependency's content changed — and
     * joining those hands the second demand a result built from the FIRST's
     * inputs, keyed on contents the second never saw.
     *
     * Held open here rather than raced, so the second demand provably arrives
     * while the first is still running.
     */
    let release: (() => void) | undefined;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const slow = (discoverable: ActionFileInputs): Promise<FileSet> =>
      toPromise(
        cache.getOrCreate(
          ANCHOR,
          () => {
            runs++;
            return Computable.from<BuildResult>(resolve => {
              void held
                .then(() => readSet(discoverable))
                .then(names =>
                  resolve({
                    result: new FileSet(new Map([["foo.o", MemoryFile.from(objectFor(names))]])),
                    discoveredDeps: selectionOf(discoverable, names),
                  })
                );
            });
          },
          { discoverable }
        )
      );
    /* Two deliveries whose READ subsets differ: `a.h` names `b.h` in the
     * second, so a result built from the first is the wrong answer for it. */
    const first = slow(discoverableDeps({ "a.h": "", "b.h": "shared" }));
    const second = slow(discoverableDeps({ "a.h": "b.h", "b.h": "shared" }));
    release!();
    const [one, two] = await Promise.all([first, second]);

    expect(runs, "the second demand ran rather than joining").to.equal(2);
    expect(await toPromise(one.readFile("foo.o"))).to.equal("a.h");
    expect(await toPromise(two.readFile("foo.o")), "and got its own delivery's answer").to.equal("a.h+b.h");
  });

  it("still joins an in-flight attempt given the same discoverable", async () => {
    /* The dedup that must survive: one anchor, one delivery, one run. */
    let release: (() => void) | undefined;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const discoverable = discoverableDeps({ "a.h": "", "b.h": "shared" });
    const slow = (): Promise<FileSet> =>
      toPromise(
        cache.getOrCreate(
          ANCHOR,
          () => {
            runs++;
            return Computable.from<BuildResult>(resolve => {
              void held
                .then(() => readSet(discoverable))
                .then(names =>
                  resolve({
                    result: new FileSet(new Map([["foo.o", MemoryFile.from(objectFor(names))]])),
                    discoveredDeps: selectionOf(discoverable, names),
                  })
                );
            });
          },
          { discoverable }
        )
      );
    const first = slow();
    const second = slow();
    release!();
    await Promise.all([first, second]);
    expect(runs, "one delivery, one run").to.equal(1);
  });

  it("serves a hit when an unread discoverable dep changes", async () => {
    const first = await build(discoverableDeps({ "a.h": "", "b.h": "one" }));
    expect(runs).to.equal(1);
    /* b.h is delivered but not in the record, so its new bytes enter no key:
     * the reconstructed precise key is the one already stored. This is the
     * whole point of the mechanism. */
    const second = await build(discoverableDeps({ "a.h": "", "b.h": "two" }));
    expect(runs).to.equal(1);
    expect(await toPromise(second.readFile("foo.o"))).to.equal(await toPromise(first.readFile("foo.o")));
  });

  it("serves a hit when an unrelated discoverable dep is added or removed", async () => {
    await build(discoverableDeps({ "a.h": "", "b.h": "one" }));
    expect(runs).to.equal(1);
    /* Discoverable NAMES are out of the anchor too (staging guarantees one root
     * per name, so nothing new can shadow what a name resolved to), which is
     * what makes an added header a no-op. */
    await build(discoverableDeps({ "a.h": "", "b.h": "one", "new.h": "arrived" }));
    await build(discoverableDeps({ "a.h": "" }));
    expect(runs).to.equal(1);
  });

  it("serves a hit when a read package's version bumps with identical bytes", async () => {
    /* A walk step is the edge's DELIVERED name, which a republish does not
     * move, and the key is the content found there — so a bump that moves no
     * byte the compile read still replays, and hits. Versions are what the
     * walk deliberately does not say. */
    const first = await build(discoverableDeps({ "a.h": "", "b.h": "one" }, "1.0.0"));
    expect(runs).to.equal(1);
    const second = await build(discoverableDeps({ "a.h": "", "b.h": "one" }, "2.0.0"));
    expect(runs).to.equal(1);
    expect(await toPromise(second.readFile("foo.o"))).to.equal(await toPromise(first.readFile("foo.o")));
  });

  it("tells a forked name's two instances apart by the path that found each", async () => {
    /* Two versions of one package name in one delivery — a direct root and a
     * nested override under a requirer. Nothing has to guess which is which:
     * `forked` and `requirer forked` are different paths, so the record states
     * both reads exactly and each replays to its own instance. */
    const fork = (oldBytes: string, newBytes: string): ActionFileInputs => {
      const nested = headerPackage({ "f.h": oldBytes }, "1.0.0", [], "forked");
      const requirer = headerPackage({ "r.h": "" }, "1.0.0", [nested], "requirer");
      return { deps: [headerPackage({ "f.h": newBytes }, "2.0.0", [], "forked"), requirer] };
    };
    const discoverable = fork("old", "new");
    const forked = (): DiscoveredDeps =>
      new Map([
        [
          "deps",
          [
            ["forked", "f.h"],
            ["requirer", "forked", "f.h"],
          ],
        ],
      ]);
    const demand = (discoverable: ActionFileInputs): Promise<FileSet> =>
      toPromise(
        cache.getOrCreate(
          ANCHOR,
          () => {
            runs++;
            return Computable.resolve({
              result: new FileSet(new Map([["foo.o", MemoryFile.from("both")]])),
              discoveredDeps: forked(),
            });
          },
          { discoverable }
        )
      );
    await demand(discoverable);
    expect(runs).to.equal(1);
    await demand(fork("old", "new"));
    expect(runs, "both instances reconstructed, the entry hits").to.equal(1);
    await demand(fork("edited", "new"));
    expect(runs, "either instance's bytes moving is a miss").to.equal(2);
  });

  it("does not serve a stale entry when a direct binding is re-bound over a surviving instance", async () => {
    /**
     * The re-bind hazard (diagnosed 2026-08-31, fixed by recording the path).
     *
     * The direct binding for the name `lodash` moves from 4.0.0 to 5.0.0, while
     * 4.0.0 survives in the closure — byte-identical — as a transitive of
     * `express`. The compile resolves the bare name and reads whatever it binds
     * to, so build 2 must produce v5's bytes; serving build 1's entry is a
     * WRONG ANSWER, not merely a coarse one.
     *
     * The path is what states it: build 1 records `lodash index.d.ts`, and in
     * build 2 that same path lands on v5, so the key moves with the binding.
     * Naming what was read (an instance, a version) instead of WHERE it was
     * found cannot express this — the surviving v4 answers such a record with
     * every byte unchanged.
     */
    const lodash = (version: string, body: string): PackageFileSet =>
      new PackageFileSet(new Map([["index.d.ts", MemoryFile.from(body)]]), "lodash", version, []);
    const express = (deps: PackageFileSet[]): PackageFileSet =>
      new PackageFileSet(new Map([["index.d.ts", MemoryFile.from("express")]]), "express", "1.0.0", deps);
    /* Build 1: lodash@4 bound directly, express carrying nothing. Build 2: the
     * direct binding is lodash@5, and the very same lodash@4 is still reachable
     * under express. */
    const before: ActionFileInputs = { deps: [lodash("4.0.0", "lodash v4"), express([])] };
    const after: ActionFileInputs = { deps: [lodash("5.0.0", "lodash v5"), express([lodash("4.0.0", "lodash v4")])] };
    /* What a compile does: resolve the bare name against its DIRECT deps, read
     * that instance's declarations, and report the read as the path it took —
     * the `lodash` edge of its own members, then the file. */
    const compile = (discoverable: ActionFileInputs): Promise<FileSet> =>
      toPromise(
        cache.getOrCreate(
          ANCHOR,
          () => {
            runs++;
            const bound = depsOf(discoverable).find(pkg => pkg.packageName === "lodash")!;
            return Computable.from<BuildResult>(resolve => {
              void toPromise(bound.readFile("index.d.ts")).then(body =>
                resolve({
                  result: new FileSet(new Map([["foo.o", MemoryFile.from(body)]])),
                  discoveredDeps: new Map([["deps", [["lodash", "index.d.ts"]]]]) as DiscoveredDeps,
                })
              );
            });
          },
          { discoverable }
        )
      );
    const first = await compile(before);
    expect(runs).to.equal(1);
    expect(await toPromise(first.readFile("foo.o"))).to.equal("lodash v4");
    const second = await compile(after);
    expect(await toPromise(second.readFile("foo.o")), "build 2 compiles against lodash@5").to.equal("lodash v5");
    expect(runs, "the re-bind must not be answered from the old entry").to.equal(2);
  });

  it("rebuilds when a discoverable dep it read changes", async () => {
    await build(discoverableDeps({ "a.h": "", "b.h": "unused" }));
    const rebuilt = await build(discoverableDeps({ "a.h": "/* edited */", "b.h": "unused" }));
    expect(runs).to.equal(2);
    expect(await toPromise(rebuilt.readFile("foo.o"))).to.equal("a.h");
    /* Same record, so nothing new to remember — the content discrimination all
     * lives in the store's keys. */
    expect(records()).to.have.lengthOf(1);
  });

  it("hits an older entry again when a used discoverable dep is reverted", async () => {
    const original = await build(discoverableDeps({ "a.h": "", "b.h": "unused" }));
    await build(discoverableDeps({ "a.h": "/* edited */", "b.h": "unused" }));
    expect(runs).to.equal(2);
    /* Both builds are still in the store, so reverting reconstructs the first
     * one's key and hits it — free, and with no change to the memo, because the
     * memo holds names and the store does the hashing. */
    const reverted = await build(discoverableDeps({ "a.h": "", "b.h": "unused" }));
    expect(runs).to.equal(2);
    expect(await toPromise(reverted.readFile("foo.o"))).to.equal(await toPromise(original.readFile("foo.o")));
    expect(records()).to.have.lengthOf(1);
  });

  it("rediscovers a deleted dependency rather than serving a stale entry", async () => {
    await build(discoverableDeps({ "a.h": "c.h", "c.h": "included" }));
    expect(runs).to.equal(1);
    /* The record names c.h, which is gone: that record can say nothing
     * about the delivery as it now stands, so it is dropped and the step
     * re-runs. */
    const rebuilt = await build(discoverableDeps({ "a.h": "" }));
    expect(runs).to.equal(2);
    expect(await toPromise(rebuilt.readFile("foo.o"))).to.equal("a.h");
  });

  it("re-derives an identical result with the cache deleted", async () => {
    const before = await build(discoverableDeps({ "a.h": "c.h", "b.h": "unused", "c.h": "included" }));
    fs.rmSync(root, { recursive: true, force: true });
    cache = new BuildCache(root, NULL_LOG);
    const after = await build(discoverableDeps({ "a.h": "c.h", "b.h": "unused", "c.h": "included" }));
    expect(runs).to.equal(2);
    expect(await toPromise(after.readFile("foo.o"))).to.equal(await toPromise(before.readFile("foo.o")));
    /* And the memo re-derives with it: nothing about the result depended on it. */
    expect(records()).to.have.lengthOf(1);
  });

  it("remembers both read sets when they alternate, and hits either", async () => {
    const flat = discoverableDeps({ "a.h": "", "b.h": "unused", "c.h": "included" });
    const wide = discoverableDeps({ "a.h": "c.h", "b.h": "unused", "c.h": "included" });
    await build(flat);
    await build(wide);
    expect(runs).to.equal(2);
    expect(records()).to.have.lengthOf(2);

    /* A record set, not a union: a union is a superset, so its key would match
     * only when the current read set happens to equal the whole of it. Both
     * records are kept, and each alternation hits the entry it produced. */
    expect(await toPromise((await build(flat)).readFile("foo.o"))).to.equal("a.h");
    expect(await toPromise((await build(wide)).readFile("foo.o"))).to.equal("a.h+c.h");
    expect(runs).to.equal(2);
  });

  it("keeps every distinct read set, and still finds the matching one", async () => {
    /* Ten distinct read sets under one anchor. Records accumulate — nothing
     * prunes them until the cache GC covers these directories — and the lookup
     * walks them in whatever order they are read, so a long list costs probes
     * and never a wrong answer. */
    const headers = (count: number): Record<string, string> => {
      const names = Array.from({ length: 10 }, (_unused, index) => `h${index}.h`);
      return Object.fromEntries([["a.h", names.slice(0, count).join(",")], ...names.map(name => [name, "x"])]);
    };
    for (let count = 1; count <= 10; count++) {
      await build(discoverableDeps(headers(count)));
    }
    expect(runs).to.equal(10);
    expect(records()).to.have.lengthOf(10);
    /* Every one of them still hits, including the oldest. */
    await build(discoverableDeps(headers(10)));
    await build(discoverableDeps(headers(1)));
    expect(runs).to.equal(10);
  });

  it("joins concurrent demands for one anchor to a single run", async () => {
    let release!: () => void;
    const gate = Computable.from<undefined>(resolve => {
      release = () => resolve(undefined);
    });
    const discoverable = discoverableDeps({ "a.h": "", "b.h": "unused" });
    /* Dedup is on the ANCHOR + discoverable — the precise key isn't known until
     * the step has run, so they are the only thing two demands for one compile
     * share. */
    const create = (): Computable<BuildResult> =>
      gate.then(() => {
        runs++;
        return {
          result: new FileSet(new Map([["foo.o", MemoryFile.from(objectFor(["a.h"]))]])),
          discoveredDeps: selectionOf(discoverable, ["a.h"]),
        };
      });
    const first = cache.getOrCreate(ANCHOR, create, { discoverable });
    const second = cache.getOrCreate(ANCHOR, create, { discoverable });
    release();
    const [a, b] = await Promise.all([toPromise(first), toPromise(second)]);
    expect(runs).to.equal(1);
    expect(await toPromise(a.readFile("foo.o"))).to.equal("a.h");
    expect(await toPromise(b.readFile("foo.o"))).to.equal("a.h");
  });

  it("records no discovered deps for a failed run", async () => {
    await toPromise(
      cache.getOrCreate(ANCHOR, () => Computable.reject<BuildResult>(new Error("boom")), {
        discoverable: discoverableDeps({ "a.h": "" }),
      })
    ).then(
      () => expect.fail("the failed run should have propagated"),
      () => undefined
    );
    /* Only successful runs record: a phantom record would mask a later build
     * that now succeeds (an unresolvable include finally present). */
    expect(records()).to.deep.equal([]);
  });

  it("writes each record as a complete, content-named file", async () => {
    await build(discoverableDeps({ "a.h": "c.h", "b.h": "unused", "c.h": "included" }));
    const dir = path.join(root, "deps", hashString(ANCHOR));
    /* Written temp-then-rename, so a name in the directory is always a whole
     * file — and the name IS its content's hash, so an identical record is
     * idempotent and a torn write could never masquerade as one. The body is
     * the path document: a section per discoverable input, an indented line per
     * path the run took, unmarked — no versions, no hashes, and nothing saying
     * what any path was expected to find. */
    for (const name of records()) {
      const body = fs.readFileSync(path.join(dir, name), "utf8");
      expect(hashString(body)).to.equal(name);
      expect(body).to.equal("!discovered-deps 4\ndeps\n hdrs a.h\n hdrs c.h\n");
    }
    /* Nothing transient in the memo directory: the temp behind that rename
     * lives in the work tree, like every other one. */
    expect(records()).to.have.lengthOf(1);
  });

  it("treats a garbage record file as a miss, never an error", async () => {
    const discoverable = discoverableDeps({ "a.h": "", "b.h": "unused" });
    await build(discoverable);
    expect(runs).to.equal(1);
    const dir = path.join(root, "deps", hashString(ANCHOR));
    /* A half-written or otherwise unusable record costs a probe: it either
     * fails the format check, or reconstructs a key no run ever recorded. */
    fs.writeFileSync(path.join(dir, "torn"), "!discovered-deps 4\ndeps\n hdrs b.");
    fs.writeFileSync(path.join(dir, "empty"), "");
    fs.writeFileSync(path.join(dir, "older"), "a.h\nb.h\n");
    expect(await toPromise((await build(discoverable)).readFile("foo.o"))).to.equal("a.h");
    expect(runs, "the good record still answers alongside the garbage").to.equal(1);

    /* With nothing usable left, the demand simply misses and the step runs. */
    for (const name of records().filter(entry => !["torn", "empty", "older"].includes(entry))) {
      fs.rmSync(path.join(dir, name));
    }
    expect(await toPromise((await build(discoverable)).readFile("foo.o"))).to.equal("a.h");
    expect(runs).to.equal(2);
  });

  it("keys a forced rebuild on the precise key too", async () => {
    await build(discoverableDeps({ "a.h": "", "b.h": "unused" }));
    await build(discoverableDeps({ "a.h": "", "b.h": "unused" }), { force: true });
    expect(runs, "force defeats the lookup, not the discovery").to.equal(2);
    expect(fs.existsSync(path.join(root, hashString(ANCHOR) + ".manifest"))).to.equal(false);
    /* And it commits as an ordinary entry, so the next demand is a hit again. */
    await build(discoverableDeps({ "a.h": "", "b.h": "unused" }));
    expect(runs).to.equal(2);
  });

  it("keys on the whole deps manifest when a step reports no reads at all", async () => {
    /* A step that declares discoverable inputs and discovers nothing is taken
     * the only safe way — as having read all of them — so the entry lives
     * under the anchor plus the whole discoverable manifest: literally what the
     * complete key would have said. Predict reconstructs that key with no
     * memo, so no record is recorded either. */
    const discoverable = discoverableDeps({ "a.h": "", "b.h": "one" });
    const demand = (files: ActionFileInputs): Promise<FileSet> =>
      toPromise(
        cache.getOrCreate(
          ANCHOR,
          () => {
            runs++;
            return produced(new FileSet(new Map([["foo.o", MemoryFile.from("opaque")]])));
          },
          { discoverable: files }
        )
      );
    await demand(discoverable);
    await demand(discoverable);
    expect(runs, "an unchanged delivery still hits").to.equal(1);
    expect(records(), "and no record was needed to find it").to.deep.equal([]);
    await demand(discoverableDeps({ "a.h": "", "b.h": "two" }));
    expect(runs, "and any change to it rebuilds").to.equal(2);
  });

  it("narrows a discoverable input of PLAIN filesets, which have no edges at all", async () => {
    /**
     * The C shape: `headers = src/include/*.h` is an ordinary FileSet, not a
     * package, so the path to one of its files is one name long — the file's
     * own. That is the general case and packages are the special one (they
     * nest, so reaching their files takes edges first); nothing here is a
     * package path with the packages taken out.
     *
     * Discovery over such an input used to buy exactly nothing: an unnamed
     * member could not be narrowed, so every discoverable dep rode the key whether it
     * was read or not.
     */
    const headers = (contents: Record<string, string>): ActionFileInputs => ({
      headers: [new FileSet(new Map(Object.entries(contents).map(([name, text]) => [name, MemoryFile.from(text)])))],
    });
    const compile = (discoverable: ActionFileInputs, read: string[]): Promise<FileSet> =>
      toPromise(
        cache.getOrCreate(
          ANCHOR,
          () => {
            runs++;
            return Computable.resolve({
              result: new FileSet(new Map([["foo.o", MemoryFile.from(read.join("+"))]])),
              discoveredDeps: new Map([["headers", read.map(file => [file])]]) as DiscoveredDeps,
            });
          },
          { discoverable }
        )
      );
    const five = (b: string): ActionFileInputs => headers({ "a.h": "a", "b.h": b, "c.h": "c", "d.h": "d", "e.h": "e" });
    const read = ["a.h", "c.h"];
    await compile(five("one"), read);
    expect(runs).to.equal(1);
    await compile(five("two"), read);
    expect(runs, "editing a header it never opened is free").to.equal(1);
    const edited = headers({ "a.h": "a edited", "b.h": "one", "c.h": "c", "d.h": "d", "e.h": "e" });
    expect(await toPromise((await compile(edited, read)).readFile("foo.o"))).to.equal("a.h+c.h");
    expect(runs, "editing one it did open rebuilds").to.equal(2);
  });

  it("keys an input the selection never mentioned WHOLE, and one it did by its paths", async () => {
    /**
     * The defect this pins: core used to read an unmentioned input as "the run
     * read nothing of it" — a claim only a recorder can make — so a discoverable
     * input its recorder had never been taught about keyed as though it were
     * irrelevant, and editing anything in it moved no key. A silent stale hit.
     *
     * The two halves are asserted against each other in one run, because it is
     * the *difference* that is the contract (see the three states of DiscoveredDeps):
     * `spoken` is mentioned, so an unread file of it is free; `unspoken` is
     * omitted, so every byte of it is key material — no claim, no narrowing.
     */
    const input = (contents: Record<string, string>): FileSet[] => [
      new FileSet(new Map(Object.entries(contents).map(([name, text]) => [name, MemoryFile.from(text)]))),
    ];
    const both = (readBytes: string, unreadBytes: string, otherBytes: string): ActionFileInputs => ({
      spoken: input({ "read.h": readBytes, "unread.h": unreadBytes }),
      unspoken: input({ "other.h": otherBytes }),
    });
    const compile = (discoverable: ActionFileInputs): Promise<FileSet> =>
      toPromise(
        cache.getOrCreate(
          ANCHOR,
          () => {
            runs++;
            /* `unspoken` is deliberately absent from the selection — this step
             * knows nothing about it, exactly as a recorder taught only about
             * one input would not. */
            return Computable.resolve({
              result: new FileSet(new Map([["foo.o", MemoryFile.from("built")]])),
              discoveredDeps: new Map([["spoken", [["read.h"]]]]) as DiscoveredDeps,
            });
          },
          { discoverable }
        )
      );
    await compile(both("r", "u", "o"));
    expect(runs).to.equal(1);
    await compile(both("r", "u EDITED", "o"));
    expect(runs, "the mentioned input still narrows: its unread file is not in the key").to.equal(1);
    await compile(both("r", "u EDITED", "o EDITED"));
    expect(runs, "the unmentioned input keys whole: editing it must rebuild").to.equal(2);
    await compile(both("r EDITED", "u EDITED", "o EDITED"));
    expect(runs, "and the mentioned input's READ file still keys as it always did").to.equal(3);
  });

  it("remembers a name that resolved to NOTHING, and rebuilds when it does", async () => {
    /**
     * A path that finds nothing: the step asked for the package `extra`, there
     * was no such member, and its output depends on that (it fell back to
     * `hdrs`). The path is written exactly like any other — nothing marks it as
     * an expected absence — and replay classifies it: it contributes no bytes,
     * only its own name in the key's absent section, which it leaves the moment
     * a member of that name arrives, with every byte the step read unchanged.
     *
     * It ends at a FILE of the package it was looking for, per the contract
     * (see DepsPath): that is what lets the arrival *say* something. A path
     * ending at the package name would land on something holding no file, which
     * would read exactly like the package still being missing — so the key
     * would not move and this test's last line would fail.
     */
    const step = (discoverable: ActionFileInputs): Promise<FileSet> =>
      toPromise(
        cache.getOrCreate(
          ANCHOR,
          () => {
            runs++;
            return Computable.resolve({
              result: new FileSet(new Map([["foo.o", MemoryFile.from("fell back")]])),
              discoveredDeps: new Map([
                [
                  "deps",
                  [
                    ["hdrs", "a.h"],
                    ["extra", "package.json"],
                  ],
                ],
              ]) as DiscoveredDeps,
            });
          },
          { discoverable }
        )
      );
    await step(discoverableDeps({ "a.h": "" }));
    await step(discoverableDeps({ "a.h": "" }));
    expect(runs, "still absent, so the record still holds").to.equal(1);
    /* And the record says so in as many words. */
    const dir = path.join(root, "deps", hashString(ANCHOR));
    expect(fs.readFileSync(path.join(dir, records()[0]), "utf8")).to.equal(
      "!discovered-deps 4\ndeps\n extra package.json\n hdrs a.h\n"
    );
    /* The package arrives, carrying the manifest the path names — which is the
     * guarantee the js recorder leans on when it appends one. */
    await step({ deps: [headerPackage({ "a.h": "" }), headerPackage({ "x.h": "", "package.json": "{}" }, "1.0.0", [], "extra")] });
    expect(runs, "the name resolves now, so it leaves the absent section and the key moves").to.equal(2);
  });

  it("keys a closure with no finite tree encoding like any other", async () => {
    /* A cross-generation version cycle has no classic-tree layout, but keying
     * needs no tree: a path is edges and a file name, and the fallback is
     * the whole discoverable manifest, which a cyclic graph manifests fine. Two
     * different closures key differently; the same closure hits. */
    const cyclic = (bytes: string): ActionFileInputs => {
      const builder = new PackageGraphBuilder();
      const one = builder.node(new Map([["a.h", MemoryFile.from(bytes)]]), "ouro", "1.0.0");
      const two = builder.node(new Map([["a.h", MemoryFile.from(`${bytes}-2`)]]), "ouro", "2.0.0");
      builder.wire(one, [two]);
      builder.wire(two, [one]);
      builder.seal();
      return { deps: [one] };
    };
    const demand = (discoverable: ActionFileInputs): Promise<FileSet> =>
      toPromise(
        cache.getOrCreate(
          ANCHOR,
          () => {
            runs++;
            return Computable.resolve({
              result: new FileSet(new Map([["foo.o", MemoryFile.from("cyclic")]])),
              discoveredDeps: new Map([["deps", [["ouro", "a.h"]]]]) as DiscoveredDeps,
            });
          },
          { discoverable }
        )
      );
    await demand(cyclic("one"));
    await demand(cyclic("one"));
    expect(runs, "the same closure hits").to.equal(1);
    await demand(cyclic("two"));
    expect(runs, "a different closure is a different key").to.equal(2);
  });
});

/**
 * The build-state record: one directory per target key holding three facts
 * about one build — `inputs` (fabr's own manifest of what that build was made
 * of, whose rows are NOT pool claims), `outputs` (a symlink to the entry it
 * produced) and `state` (the tool's kept files, blob-backed). Both manifests
 * are optional and every combination is legal; the pairing is what the
 * directory exists for. The cache owns where it lives, its integrity, and when
 * a stale attempt may write one; what the tool's bytes mean is the tool's
 * business alone.
 */
describe("BuildCache build state", () => {
  let root: string;
  let cache: BuildCache;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-state-test-"));
    cache = new BuildCache(root, NULL_LOG);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const DRIVER_BYTES = "!step 1\nwhatever the driver wrote\n";

  /** The inputs a build was made from, and the action key that names them —
   * which is what the record keeps, verbatim, rather than a manifest built for
   * the purpose. The awkward name is the point: rows are read back, so a space
   * in a name has to survive the round trip. */
  const INPUT_FILES = new FileSet(
    new Map([
      ["src/a file & 100%.ts", MemoryFile.from("alpha")],
      ["tsconfig.json", MemoryFile.from("beta")],
    ])
  );

  /** A build state as the cache records one: the action's own key material, and
   * the tool's kept files. */
  const STEP: IBuildActionDefinition = { id: "test:step", version: 1, run: () => Computable.resolve({ result: new FileSet(new Map()) }) };
  const STATE = {
    inputs: new BuildAction(STEP, { srcs: INPUT_FILES }, {}).actionKey(),
    incrementalState: new FileSet(new Map([["graph", MemoryFile.from(DRIVER_BYTES)]])),
  };

  const recordDir = (targetKey: string): string => path.join(root, "incremental", targetKey);
  const part = (targetKey: string, name: string): string => path.join(recordDir(targetKey), name);

  /** An entry in the store as the cache's own machinery makes one, answering
   * the hashed key it lives under — what a record's `outputs` link must
   * name. */
  const entry = async (name: string, files: Record<string, string>): Promise<string> => {
    await toPromise(
      cache.getOrCreate(name, () =>
        produced(new FileSet(new Map(Object.entries(files).map(([n, text]) => [n, MemoryFile.from(text)]))))
      )
    );
    return hashString(name);
  };

  /* Read back through a separate instance over the same store: the record is on
   * disk, not in this process's head. */
  const readState = (targetKey: string): Promise<IBuildState | undefined> =>
    toPromise(new BuildCache(root, NULL_LOG).readBuildState(targetKey));

  /** Record `STATE` against a fresh entry, answering that entry's key. */
  const record = async (targetKey: string, entryName = `entry-for-${targetKey}`): Promise<string> => {
    const key = await entry(entryName, { "out.js": entryName });
    await toPromise(cache.writeBuildState(targetKey, cache.beginBuildStateAttempt(targetKey), key, STATE));
    return key;
  };

  it("remembers a target key's build state and reads it back", async () => {
    const targetKey = "target-key-one";
    await record(targetKey);
    const read = await readState(targetKey);
    expect(
      await toPromise(read!.incrementalState!.getFile("graph")!.readString()),
      "the tool's file comes back byte-for-byte"
    ).to.equal(DRIVER_BYTES);
    /* The inputs manifest round-trips — name (escaping and all), hash and mode,
     * which are the whole of what a record keeps of an input. */
    const awkward = read!.inputs!.getFile("src/a file & 100%.ts");
    expect(awkward?.hash).to.equal(INPUT_FILES.getFile("src/a file & 100%.ts")!.hash);
    expect(awkward?.mode).to.equal(INPUT_FILES.getFile("src/a file & 100%.ts")!.mode);
    expect(read!.inputs!.size).to.equal(2);
    /* And the third fact, read THROUGH the link: the entry that build made. */
    expect(await toPromise(read!.outputs.getFile("out.js")!.readString())).to.equal("entry-for-target-key-one");
  });

  it("is ordinary files, the tool's state ordinary blob content", async () => {
    /* `inputs` (what was given) and `discovered` (what was accessed) are the
     * action's own key material verbatim, each sealed with the trailing count
     * that refuses a torn copy; `state` is an ordinary entry manifest whose
     * bytes live in the blob pool under the hash its line references;
     * `outputs` is a relative link to the entry itself. */
    const targetKey = "target-key-format";
    const key = await record(targetKey);
    expect(fs.readdirSync(recordDir(targetKey)).sort()).to.deep.equal(["discovered", "inputs", "outputs", "state"]);
    const inputs = fs.readFileSync(part(targetKey, "inputs"), "utf8");
    expect(parseRecordedBase(inputs)?.rows.length, "the key material reads back, sealed").to.equal(2);
    expect(fs.readFileSync(part(targetKey, "state"), "utf8").startsWith("!meta "), "the state is an entry manifest").to.equal(true);
    expect(fs.readlinkSync(part(targetKey, "outputs"))).to.equal(path.join("..", "..", `${key}.manifest`));
    expect(fs.existsSync(path.join(root, "blob", hashString(Buffer.from(DRIVER_BYTES)))), "the tool's blob is in the pool").to.equal(
      true
    );
  });

  it("answers nothing for a target key it has never seen", async () => {
    expect(await readState("never-built")).to.equal(undefined);
  });

  it("refuses inputs truncated at a line boundary, keeping the rest of the record", async () => {
    /* The load-bearing integrity case, and the one the manifest dialect alone
     * cannot catch: a record cut at a line boundary parses clean, and a
     * silently lost input line can lose a DELETION — a deleted source whose
     * outputs are never subtracted, breaking byte-identity with a cold build.
     * The meta's entry count is what refuses it, and what it must never do is
     * hand back the short set. */
    const targetKey = "target-key-truncated";
    await record(targetKey);
    const lines = fs.readFileSync(part(targetKey, "inputs"), "utf8").split("\n");
    fs.writeFileSync(part(targetKey, "inputs"), [...lines.slice(0, lines.length - 2), ""].join("\n"));
    const read = await readState(targetKey);
    expect(read?.inputs, "a lost line is no inputs, never a shorter set").to.equal(undefined);
    /* A different file tore; the tool's state still describes the entry the
     * link names, which is a legal record — state without inputs. */
    expect(read?.incrementalState?.size, "the good state file survives it").to.equal(1);
    expect(read?.outputs.size).to.equal(1);
  });

  it("refuses inputs torn mid-line, rather than failing the build", async () => {
    const targetKey = "target-key-torn";
    await record(targetKey);
    const text = fs.readFileSync(part(targetKey, "inputs"), "utf8");
    fs.writeFileSync(part(targetKey, "inputs"), text.substring(0, Math.floor(text.length / 2)));
    const read = await readState(targetKey);
    expect(read?.inputs).to.equal(undefined);
    expect(read?.incrementalState?.size).to.equal(1);
  });

  it("answers nothing when the tool's blob has gone", async () => {
    /* A wiped pool (or the future GC): the record cannot say what the tool
     * knew, so there is no record — a cold build, never an error. */
    const targetKey = "target-key-swept";
    await record(targetKey);
    fs.rmSync(path.join(root, "blob", hashString(Buffer.from(DRIVER_BYTES))), { force: true });
    expect(await readState(targetKey)).to.equal(undefined);
  });

  it("answers nothing for a dangling outputs link", async () => {
    /* The evicted entry: the state names what that build emitted, so pairing it
     * with an entry that is gone would have the tool skip emitting files that
     * no longer exist — a wrong output, not a slow build. The link's own ENOENT
     * is the whole invalidation. */
    const targetKey = "target-key-evicted";
    const key = await record(targetKey);
    fs.rmSync(path.join(root, `${key}.manifest`), { force: true });
    expect(await readState(targetKey)).to.equal(undefined);
  });

  it("answers nothing when the entry's own blob has gone", async () => {
    /* What a dangling link does NOT cover: the manifest still parses while a
     * file it names has been reclaimed, so the staged outputs would be short a
     * file. */
    const targetKey = "target-key-holed";
    await record(targetKey);
    fs.rmSync(path.join(root, "blob", hashString(Buffer.from("entry-for-target-key-holed"))), { force: true });
    expect(await readState(targetKey)).to.equal(undefined);
  });

  it("reads the retired single-file record as no record", async () => {
    /* The migration: an older cache's record is a FILE where a directory now
     * belongs, so reading through it fails and the target key builds cold once.
     * The layout change is its own discriminator — there is no format version. */
    const targetKey = "target-key-old";
    fs.mkdirSync(path.join(root, "incremental"), { recursive: true });
    fs.writeFileSync(recordDir(targetKey), "!meta {}\nffff 644 src/a.ts text/plain\n");
    expect(await readState(targetKey)).to.equal(undefined);
  });

  it("surfaces a real IO failure rather than reading it as an absent part", async () => {
    /* Now that a missing part and a damaged one both read as absent, this is
     * the only thing keeping an UNREADABLE one out of that bucket too:
     * swallowing it would take the target key cold on every build, forever,
     * with nothing said. */
    const targetKey = "target-key-unreadable";
    await record(targetKey);
    fs.rmSync(part(targetKey, "inputs"));
    fs.mkdirSync(part(targetKey, "inputs"));
    expect(
      await readState(targetKey).then(
        () => "read",
        () => "failed"
      )
    ).to.equal("failed");
  });

  it("records inputs with no state, and state with no inputs", async () => {
    /* Both halves are optional and independent: a tool deriving its changes
     * from its own state records no inputs, one keeping nothing records none. */
    const inputsOnly = await entry("inputs-only", { "out.js": "x" });
    await toPromise(
      cache.writeBuildState("key-inputs-only", cache.beginBuildStateAttempt("key-inputs-only"), inputsOnly, {
        inputs: STATE.inputs,
      })
    );
    expect(fs.readdirSync(recordDir("key-inputs-only")).sort()).to.deep.equal(["discovered", "inputs", "outputs"]);
    const inputsRead = await readState("key-inputs-only");
    expect(inputsRead?.inputs?.size).to.equal(2);
    expect(inputsRead?.incrementalState, "a part never written reads as absent").to.equal(undefined);

    const stateOnly = await entry("state-only", { "out.js": "y" });
    await toPromise(
      cache.writeBuildState("key-state-only", cache.beginBuildStateAttempt("key-state-only"), stateOnly, {
        incrementalState: STATE.incrementalState,
      })
    );
    expect(fs.readdirSync(recordDir("key-state-only")).sort()).to.deep.equal(["outputs", "state"]);
    const stateRead = await readState("key-state-only");
    expect(stateRead?.inputs).to.equal(undefined);
    expect(stateRead?.incrementalState?.size).to.equal(1);
  });

  it("writes no record where there is nothing to record", async () => {
    /* A lone `outputs` link would say only "this target key last produced entry
     * X", which the action already knows from its own key — so `incremental/`
     * holds exactly the target keys that have incremental data. */
    const targetKey = "key-nothing";
    const key = await entry("nothing-entry", { "out.js": "z" });
    await toPromise(cache.writeBuildState(targetKey, cache.beginBuildStateAttempt(targetKey), key, {}));
    expect(fs.existsSync(recordDir(targetKey))).to.equal(false);
    expect(await readState(targetKey)).to.equal(undefined);
  });

  it("leaves an existing record alone when a later build records nothing", async () => {
    /* The same rule a red run needs: the three parts still describe one real
     * earlier build, so a later incremental run may still work from it —
     * conservatively, never wrongly. */
    const targetKey = "key-keeps";
    const first = await record(targetKey);
    const later = await entry("later-entry", { "out.js": "later" });
    await toPromise(cache.writeBuildState(targetKey, cache.beginBuildStateAttempt(targetKey), later, {}));
    expect(fs.readlinkSync(part(targetKey, "outputs")), "still the earlier build's entry").to.equal(
      path.join("..", "..", `${first}.manifest`)
    );
    expect((await readState(targetKey))?.inputs?.size).to.equal(2);
  });

  it("lets the record only advance: a superseded attempt records nothing", async () => {
    /* Two attempts at one target key overlap normally — a watch rebuild has
     * a different anchor, so nothing joins them — and the older one finishing
     * last must not move the record backwards. */
    const targetKey = "target-key-raced";
    const newerEntry = await entry("newer", { "out.js": "newer" });
    const olderEntry = await entry("older", { "out.js": "older" });
    const first = cache.beginBuildStateAttempt(targetKey);
    const second = cache.beginBuildStateAttempt(targetKey);
    expect(second).to.be.greaterThan(first);

    await toPromise(cache.writeBuildState(targetKey, second, newerEntry, STATE));
    await toPromise(cache.writeBuildState(targetKey, first, olderEntry, STATE));
    const outputs = async (): Promise<string> => toPromise((await readState(targetKey))!.outputs.getFile("out.js")!.readString());
    expect(await outputs(), "the newer attempt's record stands").to.equal("newer");

    /* And a later attempt still writes: the guard refuses the stale, not the
     * target key. */
    const newestEntry = await entry("newest", { "out.js": "newest" });
    await toPromise(cache.writeBuildState(targetKey, cache.beginBuildStateAttempt(targetKey), newestEntry, STATE));
    expect(await outputs()).to.equal("newest");
  });

  it("keeps each target key's generations apart", async () => {
    const key = await entry("a-entry", { "out.js": "a" });
    const one = cache.beginBuildStateAttempt("target-key-a");
    cache.beginBuildStateAttempt("target-key-b");
    cache.beginBuildStateAttempt("target-key-b");
    /* b's second attempt must not make a's first look superseded. */
    await toPromise(cache.writeBuildState("target-key-a", one, key, STATE));
    expect(await toPromise((await readState("target-key-a"))!.outputs.getFile("out.js")!.readString())).to.equal("a");
  });

  it("commits by rename, leaving no debris in the incremental directory", async () => {
    const targetKey = "target-key-atomic";
    await record(targetKey);
    expect(fs.readdirSync(path.join(root, "incremental"))).to.deep.equal([targetKey]);
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

  const fetchDoc = (options?: Parameters<BuildCache["getOrFetch"]>[5]): Promise<string> =>
    toPromise(cache.getOrFetch(origin.url, "test:1", store, UNTRACKED, undefined, options).then(files => files.readFile("doc.txt")));

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
      toPromise(
        logging
          .getOrFetch(origin.url, "test:1", store, UNTRACKED, undefined, { immutable: false })
          .then(files => files.readFile("doc.txt"))
      );
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
      toPromise(
        logging
          .getOrFetch(origin.url, "test:1", store, UNTRACKED, undefined, { immutable: false })
          .then(files => files.readFile("doc.txt"))
      );
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
      toPromise(
        logging
          .getOrFetch(origin.url, "test:1", store, UNTRACKED, undefined, { immutable: false })
          .then(files => files.readFile("doc.txt"))
      );
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
      await toPromise(cache.getOrFetch(origin.url, "test:1", reject, UNTRACKED, undefined, { immutable: false }));
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
            () =>
              new FileSet(
                new Map([
                  [trap, MemoryFile.from("gotcha")],
                  ["doc.txt", MemoryFile.from("one")],
                ])
              )
          ),
        UNTRACKED,
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
        UNTRACKED,
        undefined,
        { immutable: false }
      )
    );
    expect(await toPromise(again.readFile(trap))).to.equal("gotcha");
    expect(await toPromise(again.readFile("doc.txt"))).to.equal("one");
    expect(origin.requests).to.have.lengthOf(1);
  });

  it("records no freshness for an immutable fetch, and never refetches", async () => {
    /* Every manifest carries the header, because the file count is a property
     * of the document; what an immutable entry records there is no `expires`,
     * so the origin's declared lifetime cannot expire it. */
    origin.respond(serve(200, { "cache-control": "max-age=1" }, "one"));
    expect(await fetchDoc()).to.equal("one");
    const manifest = fs.readFileSync(path.join(root, hashString(`fetch:test:1 ${origin.url}`) + ".manifest"), "utf8");
    expect(manifest.split("\n")[0]).to.equal('!meta {"entries":1}');
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

describe("BuildCache.ensureTree (the tree pool)", () => {
  let root: string;

  beforeEach(() => {
    /* A real temp dir of its own, like every other cache test: a tree's files
     * are hardlinks out of the blob pool, so both must sit on one filesystem
     * (and a cache pointed at the repo would leak blobs into it). */
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-treepool-test-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A FileSet of in-memory files, `name -> content`. */
  function fileset(files: Record<string, string>): FileSet {
    return new FileSet(new Map(Object.entries(files).map(([name, content]) => [name, MemoryFile.from(content)])));
  }

  it("names an entry by the manifest hash of what it holds", async () => {
    /* The invariant the signature enforces: `tree/<H>` IS the materialization
     * of the FileSet whose manifest hashes to H, so a tree is verifiable by
     * re-manifesting it and no caller can name one wrongly. */
    const cache = new BuildCache(root, NULL_LOG);
    const files = fileset({ "node_modules/a/index.js": "a" });
    const entry = await toPromise(cache.ensureTree(files));
    expect(entry).to.equal(path.join(root, "tree", files.toManifestHash()));
    expect(fs.readFileSync(path.join(entry, "node_modules/a/index.js"), "utf8")).to.equal("a");

    /* An equal FileSet is the same entry, served without rebuilding. */
    expect(await toPromise(cache.ensureTree(fileset({ "node_modules/a/index.js": "a" })))).to.equal(entry);
    expect(fs.readdirSync(path.join(root, "tree"))).to.deep.equal([files.toManifestHash()]);
  });

  it("holds a tree's files as read-only hardlinks into the blob pool", async () => {
    const cache = new BuildCache(root, NULL_LOG);
    const stored = await toPromise(
      cache.getOrCreate("a tool", () =>
        produced(new FileSet(new Map([["bin/tool", new MemoryFile(Buffer.from("#!/bin/sh\n"), 0o755)]])))
      )
    );
    const pooled = (await toPromise(stored.get("bin/tool")))!;
    const entry = await toPromise(
      cache.ensureTree(
        new FileSet(
          new Map([
            ["bin/tool", pooled],
            ["lib/generated.js", MemoryFile.from("x")],
          ])
        )
      )
    );

    /* One inode, shared with the blob pool — so a tree costs links, never bytes —
     * and read-only, so nothing staged from it can write through. */
    const file = path.join(entry, "bin/tool");
    expect(fs.statSync(file).ino).to.equal(fs.statSync(path.join(root, "blob", hashString("#!/bin/sh\n"))).ino);
    expect(fs.statSync(file).mode & 0o777).to.equal(0o555);

    /* Generated content interns on its way through, so the tree is a hardlink
     * farm all the way down: an in-memory file gains its blob here, and the
     * staged file is a link to it (two names, one inode) rather than a copy. */
    const generated = fs.statSync(path.join(entry, "lib/generated.js"));
    expect(generated.ino).to.equal(fs.statSync(path.join(root, "blob", hashString("x"))).ino);
    expect(generated.nlink).to.equal(2);
    expect(generated.mode & 0o777).to.equal(0o444);
  });

  it("is an accelerator only: deleting a tree rematerializes it identically", async () => {
    const cache = new BuildCache(root, NULL_LOG);
    const files = fileset({ "node_modules/a/index.js": "a" });
    const entry = await toPromise(cache.ensureTree(files));
    fs.rmSync(entry, { recursive: true, force: true });
    /* Same files, same name — the identity is derived, not remembered. */
    expect(await toPromise(cache.ensureTree(files))).to.equal(entry);
    expect(fs.readFileSync(path.join(entry, "node_modules/a/index.js"), "utf8")).to.equal("a");
  });

  it("holds a delivered package's own symlinks, and drops one that escapes it", async () => {
    /* What a tarball can carry, and the only link kind a tree holds now: an
     * in-package relative symlink. It is staged like any other file, under the
     * same containment rule the rest of staging applies. */
    const cache = new BuildCache(root, NULL_LOG);
    const entry = await toPromise(
      cache.ensureTree(
        new FileSet(
          new Map<string, import("./FileSet").IFile>([
            ["lib/real.js", MemoryFile.from("x")],
            ["lib/alias.js", new SymlinkFile("real.js")],
            ["escape.js", new SymlinkFile("../../../etc/passwd")],
          ])
        )
      )
    );
    expect(fs.readlinkSync(path.join(entry, "lib/alias.js"))).to.equal("real.js");
    expect(fs.readFileSync(path.join(entry, "lib/alias.js"), "utf8")).to.equal("x");
    expect(fs.existsSync(path.join(entry, "escape.js"))).to.equal(false);
  });

  it("builds in the work tree, so the pool only ever holds complete trees", async () => {
    /* Nothing partial is ever visible under `tree/` — which is what lets a
     * scan of it (a future GC, an fsck) trust every directory it sees, with no
     * skip-the-temps convention to know about. The temp is a work dir like any
     * other, so its cleanup rides the work tree's exit hook and startup sweep. */
    const cache = new BuildCache(root, NULL_LOG);
    const files = fileset({ "index.js": "x" });
    const materializing = cache.ensureTree(files);
    /* Synchronously after the call: the temp exists (createWorkDir is sync)
     * while the writes are still in flight. */
    const workDirs = fs.readdirSync(path.join(root, "work")).flatMap(owner => fs.readdirSync(path.join(root, "work", owner)));
    expect(workDirs.filter(name => name.startsWith("tree-"))).to.have.lengthOf(1);
    expect(fs.readdirSync(path.join(root, "tree"))).to.deep.equal([]);

    const entry = await toPromise(materializing);
    /* And afterwards the pool holds exactly the finished tree, the work dir
     * having been consumed by the publish. */
    expect(fs.readdirSync(path.join(root, "tree"))).to.deep.equal([files.toManifestHash()]);
    expect(fs.readFileSync(path.join(entry, "index.js"), "utf8")).to.equal("x");
  });

  it("yields to the winner of a concurrent race for the same tree", async () => {
    const cache = new BuildCache(root, NULL_LOG);
    /* Another process publishes the entry while this one is still writing its
     * temp: the rename then fails, the temp is discarded, and the winner's
     * directory — the same content by name — is what everyone uses. The
     * injection lands after the call because the writes are async; whichever
     * branch it reaches (rename-loses, or the fast path if it beat the temp),
     * what is asserted is the same guarantee — a published entry is never
     * replaced and nothing is left behind. */
    const files = fileset({ "loser.txt": "ours" });
    const published = path.join(root, "tree", files.toManifestHash());
    const materializing = cache.ensureTree(files);
    fs.mkdirSync(published, { recursive: true });
    fs.writeFileSync(path.join(published, "winner.txt"), "theirs");

    const entry = await toPromise(materializing);
    expect(entry).to.equal(published);
    expect(fs.readFileSync(path.join(entry, "winner.txt"), "utf8")).to.equal("theirs");
    expect(fs.existsSync(path.join(entry, "loser.txt"))).to.equal(false);
    /* Nothing left behind: the discarded temp is gone. */
    expect(fs.readdirSync(path.join(root, "tree"))).to.deep.equal([files.toManifestHash()]);
  });

  it("refuses a file that lives outside the cache, rather than taking it either way", () => {
    /* The only two ways to take one are both wrong: a rename evicts a file its
     * owner still expects, and re-reading its bytes stores them under the hash
     * recorded earlier — poisoning a blob if the path has drifted. */
    const cache = new BuildCache(root, NULL_LOG);
    const elsewhere = path.join(root, "mine.txt");
    fs.writeFileSync(elsewhere, "held by someone else");
    const held = new FSFile(root, "mine.txt", fs.statSync(elsewhere), hashString("held by someone else"), "text/plain");
    /* Synchronously, at the call: this is a broken delivery contract rather
     * than a build failure, so it fails where the mistake is instead of riding
     * a chain. */
    expect(() => cache.ensureTree(new FileSet(new Map([["lib/held.txt", held]])))).to.throw(
      /cannot materialize the tree .* from 'lib\/held\.txt', which lives outside the cache/
    );
    /* And it is refused BEFORE anything exists to clean up. */
    expect(fs.existsSync(elsewhere), "the file is left where its owner put it").to.equal(true);
    expect(fs.existsSync(path.join(root, "tree")) ? fs.readdirSync(path.join(root, "tree")) : []).to.deep.equal([]);
  });

  it("leaves no entry (and no debris) when the files fail to materialize", async () => {
    const cache = new BuildCache(root, NULL_LOG);
    const broken = new FileSet(
      new Map([
        ["a.txt", MemoryFile.from("x")],
        ["a.txt/b.txt", MemoryFile.from("y")],
      ])
    );
    let error: Error | undefined;
    await toPromise(cache.ensureTree(broken)).catch((err: Error) => (error = err));
    expect(error).to.not.equal(undefined);
    expect(fs.existsSync(path.join(root, "tree", broken.toManifestHash()))).to.equal(false);
    expect(fs.readdirSync(path.join(root, "tree"))).to.deep.equal([]);
  });

  it("joins an in-flight materialization rather than racing itself", async () => {
    const cache = new BuildCache(root, NULL_LOG);
    /* The second demand gets the FIRST one's attempt — the same node, not an
     * equal answer — which is what keeps two concurrent consumers of one
     * package from both writing it. */
    const first = cache.ensureTree(fileset({ "index.js": "x" }));
    const second = cache.ensureTree(fileset({ "index.js": "x" }));
    expect(second).to.equal(first);
    expect(await toPromise(second)).to.equal(await toPromise(first));
    expect(fs.readdirSync(path.join(root, "tree"))).to.have.lengthOf(1);
  });
});
