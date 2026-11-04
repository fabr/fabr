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

import * as crypto from "node:crypto";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { expect } from "chai";
import {
  Computable,
  FetchOptions,
  FileSet,
  IFetchContext,
  IFetchRequest,
  IFile,
  ITaskReport,
  MemoryFile,
  NamespaceRef,
  openUrlStream,
  parseName,
  PublishStatus,
  RepositoryRef,
  TargetContext,
  TaskProgress,
} from "@fabr-build/core";
import { AwsAccount } from "./AwsAccount";
import { S3PublishRef } from "./S3Publish";
import { RequestSigner } from "./Signing";
import { S3Repository } from "./S3Repository";

/**
 * An S3-compatible store over the objects of the bucket `acme`: GETs, HEADs
 * and PUTs of objects (a PUT refused where its body does not match its
 * `x-amz-content-sha256`, or its `x-amz-checksum-sha256`, which is kept and
 * given back to a HEAD in checksum mode), and `ListObjectsV2`, one key per
 * page. An object's ETag is its MD5, as S3 gives a single-part upload, except
 * in an `encrypted` bucket, whose ETags are no MD5, as under SSE-KMS.
 */
interface IFakeStore {
  readonly url: string;
  /** The requests it was sent: method, path and query, and the authorization and content-type headers. */
  readonly requests: Array<{ method: string; path: string; authorization?: string; contentType?: string; checksum?: string }>;
  close(): Promise<void>;
}

function etagOfText(text: string): string {
  return `"${crypto.createHash("md5").update(text).digest("hex")}"`;
}

function startStore(
  objects: Record<string, string>,
  refused: string[] = [],
  buckets: string[] | "refused" = ["acme"],
  encrypted = false
): Promise<IFakeStore> {
  const requests: IFakeStore["requests"] = [];
  const checksums = new Map<string, string>();
  const etagOf = (key: string): string => (encrypted ? `"kms-${crypto.createHash("sha1").update(objects[key]).digest("hex")}"` : etagOfText(objects[key]));
  const server = http.createServer((req, res) => {
    const checksum = req.headers["x-amz-checksum-sha256"] as string | undefined;
    requests.push({ method: req.method!, path: req.url!, authorization: req.headers.authorization, contentType: req.headers["content-type"], checksum });
    const url = new URL(req.url!, "http://store");
    const [, bucket, ...rest] = url.pathname.split("/");
    if (bucket === "") {
      if (buckets === "refused") {
        res.writeHead(403).end();
        return;
      }
      const start = Number(url.searchParams.get("continuation-token") ?? "0");
      const next = start + 1 < buckets.length ? `<ContinuationToken>${start + 1}</ContinuationToken>` : "";
      res.writeHead(200).end(
        `<ListAllMyBucketsResult><Buckets><Bucket><Name>${buckets[start]}</Name></Bucket></Buckets>${next}</ListAllMyBucketsResult>`
      );
      return;
    }
    if (bucket !== "acme") {
      res.writeHead(404).end();
      return;
    }
    if (rest.length === 0 && req.method === "HEAD") {
      res.writeHead(200).end();
      return;
    }
    if (rest.length === 0) {
      const prefix = url.searchParams.get("prefix") ?? "";
      const delimiter = url.searchParams.get("delimiter");
      const start = Number(url.searchParams.get("continuation-token") ?? "0");
      const keys = Object.keys(objects)
        .filter(key => key.startsWith(prefix))
        .sort();
      const direct = delimiter === null ? keys : keys.filter(key => !key.substring(prefix.length).includes(delimiter));
      const grouped =
        delimiter === null
          ? []
          : [...new Set(keys.filter(key => key.substring(prefix.length).includes(delimiter)).map(key => key.substring(0, key.indexOf(delimiter, prefix.length) + 1)))];
      const page = direct.slice(start, start + 1);
      const truncated = start + 1 < direct.length;
      res.writeHead(200, { "content-type": "application/xml" }).end(
        `<?xml version="1.0"?><ListBucketResult>${page.map(key => `<Contents><Key>${key}</Key><ETag>${etagOf(key)}</ETag></Contents>`).join("")}` +
          `${start === 0 ? grouped.map(prefix => `<CommonPrefixes><Prefix>${prefix}</Prefix></CommonPrefixes>`).join("") : ""}` +
          `<IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${start + 1}</NextContinuationToken>` : ""}</ListBucketResult>`
      );
      return;
    }
    const key = rest.map(decodeURIComponent).join("/");
    if (req.method === "PUT" && refused.includes(key)) {
      res.writeHead(403).end("<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>");
    } else if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        if (crypto.createHash("sha256").update(body).digest("hex") !== req.headers["x-amz-content-sha256"]) {
          res.writeHead(400).end("<Error><Code>XAmzContentSHA256Mismatch</Code><Message>The digests do not match.</Message></Error>");
          return;
        }
        if (checksum !== undefined && checksum !== crypto.createHash("sha256").update(body).digest("base64")) {
          res.writeHead(400).end("<Error><Code>BadDigest</Code><Message>The SHA256 you specified did not match the calculated checksum.</Message></Error>");
          return;
        }
        objects[key] = body.toString("utf8");
        if (checksum === undefined) {
          checksums.delete(key);
        } else {
          checksums.set(key, checksum);
        }
        res.writeHead(200, { etag: etagOf(key) }).end();
      });
    } else if (refused.includes(key)) {
      res.writeHead(403).end();
    } else if (key in objects) {
      const stored = req.headers["x-amz-checksum-mode"] === "ENABLED" ? checksums.get(key) : undefined;
      res
        .writeHead(200, { etag: etagOf(key), ...(stored === undefined ? {} : { "x-amz-checksum-sha256": stored }) })
        .end(req.method === "HEAD" ? undefined : objects[key]);
    } else {
      res.writeHead(404).end();
    }
  });
  return new Promise(resolve =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        requests,
        close: () => new Promise(done => server.close(() => done())),
      })
    )
  );
}

/** A TargetContext whose `fetch` makes the request it is given, with no cache, recording the options it was fetched with. */
function fetchingContext(options: Array<FetchOptions | undefined>): TargetContext {
  return {
    name: "@aws",
    fetch: (_key: string, _tag: string, request: () => Computable<IFetchRequest>, _report: unknown, fetchOptions?: FetchOptions) => {
      options.push(fetchOptions);
      return request().then(({ url, headers, process }) =>
        openUrlStream(url, headers).then(response => {
          const chunks: Buffer[] = [];
          const output = {
            stream: new Writable({
              write: (chunk: Buffer, _enc, done): void => {
                chunks.push(chunk);
                done();
              },
            }),
            finalize: (): Computable<IFile> => Computable.resolve(new MemoryFile(Buffer.concat(chunks))),
            discard: (): Computable<void> => Computable.resolve(undefined),
          };
          return process(response.stream!, { createOutput: () => output } as unknown as IFetchContext);
        })
      );
    },
  } as unknown as TargetContext;
}

function accountAt(store: IFakeStore, options: Array<FetchOptions | undefined> = []): AwsAccount {
  return new AwsAccount({ name: "@aws", context: fetchingContext(options), signer: new RequestSigner(undefined), endpoint: new URL(store.url) });
}

/** Resolve `name`, written after `@aws:`, to the objects it reaches, before its projections select among them. */
function objectsOf(account: AwsAccount, name: string): Computable<FileSet> {
  const ref = account.getRepositoryRef(parseName(name));
  expect(ref).to.be.instanceOf(RepositoryRef);
  return ((ref as RepositoryRef).source as S3Repository).resolve(ref as RepositoryRef);
}

/** Publish `content` at `coordinate`, written after `@aws:`, as a `sync` would: packaged, then uploaded, recording into `progress` what it reports. */
function publishTo(account: AwsAccount, coordinate: string, content: FileSet, progress: TaskProgress[] = []): Computable<PublishStatus> {
  const destination = account.getRepositoryPublishRef(parseName(coordinate));
  const report: ITaskReport = { activity: () => undefined, progress: measured => progress.push(measured) };
  return destination.source
    .package([{ destination, content }], [destination], new Map())
    .then(([carrier]) => destination.source.publish(carrier, report));
}

function namesOf(files: FileSet): string[] {
  return [...files].map(([name]) => name);
}

const OBJECTS = {
  "v3/model.bin": "model",
  "assets/a.png": "a",
  "assets/b.png": "b",
  "assets/notes.txt": "notes",
  "assets/": "",
};

describe("the S3 service of an AWS account", () => {
  let store: IFakeStore;
  const saved = { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY };

  beforeEach(async () => {
    process.env.AWS_ACCESS_KEY_ID = "AKIDTEST";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
    store = await startStore({ ...OBJECTS }, ["private/x"]);
  });

  afterEach(async () => {
    await store.close();
    for (const [name, value] of [
      ["AWS_ACCESS_KEY_ID", saved.id],
      ["AWS_SECRET_ACCESS_KEY", saved.secret],
    ] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it("fetches an object a literal key names, signed, and kept as HTTP caching says", async () => {
    const options: Array<FetchOptions | undefined> = [];
    const files = await objectsOf(accountAt(store, options), "s3:acme:v3/model.bin");
    expect(namesOf(files)).to.deep.equal(["v3/model.bin"]);
    expect((await (await files.get("v3/model.bin"))!.getBuffer()).toString()).to.equal("model");
    expect(store.requests.map(({ path }) => path)).to.deep.equal(["/acme", "/acme/v3/model.bin"]);
    expect(store.requests[1].authorization).to.match(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/us-east-1\/s3\/aws4_request, /);
    expect(options).to.deep.equal([{ immutable: false }]);
  });

  it("projects the key from a ':', keeping the bucket in the name after a '/'", () => {
    const account = accountAt(store);
    const colon = account.getRepositoryRef(parseName("s3:acme:v3/model.bin")) as RepositoryRef;
    const slash = account.getRepositoryRef(parseName("s3:acme/v3/model.bin")) as RepositoryRef;
    expect(colon.name).to.equal("s3:acme");
    expect(colon.projections.map(({ pattern, prefix }) => [pattern.toString(), prefix])).to.deep.equal([["v3/model.bin", ""]]);
    expect(slash.projections.map(({ pattern, prefix }) => [pattern.toString(), prefix])).to.deep.equal([["v3/model.bin", "acme/"]]);
  });

  it("lists the bucket from a pattern's literal head, a page at a time, leaving folder markers out", async () => {
    const files = await objectsOf(accountAt(store), "s3:acme:assets/*.png");
    expect(namesOf(files).sort()).to.deep.equal(["assets/a.png", "assets/b.png", "assets/notes.txt"]);
    expect(store.requests.filter(({ path }) => path.includes("list-type")).length).to.equal(4);
  });

  it("lists nothing for a literal name that is no object", async () => {
    const files = await objectsOf(accountAt(store), "s3:acme:assets");
    expect(namesOf(files)).to.deep.equal([]);
    expect(store.requests.map(({ path }) => path)).to.deep.equal(["/acme", "/acme/assets"]);
  });

  it("finds nothing for a key that does not exist", async () => {
    const files = await objectsOf(accountAt(store), "s3:acme:missing.bin");
    expect(files.isEmpty()).to.equal(true);
  });

  it("says an object refused it may be missing or unreadable", async () => {
    const err = await objectsOf(accountAt(store), "s3:acme:private/x").then(
      () => undefined,
      e => e as Error
    );
    expect(err?.message).to.match(/private\/x was not found, or is not readable with @aws's credentials/);
  });

  it("names the service and the bucket as namespaces", () => {
    const account = accountAt(store);
    const service = account.getRepositoryRef(parseName("s3"));
    const bucket = account.getRepositoryRef(parseName("s3:acme"));
    expect(service).to.be.instanceOf(NamespaceRef);
    expect((service as NamespaceRef).name).to.equal("s3");
    expect((bucket as NamespaceRef).name).to.equal("s3:acme");
  });

  it("lists a bucket one level at a time", async () => {
    const account = accountAt(store);
    const bucket = account.getRepositoryRef(parseName("s3:acme")) as NamespaceRef;
    const children = await bucket.children();
    expect([...children.keys()]).to.deep.equal(["assets", "v3"]);
    const assets = children.get("assets") as NamespaceRef;
    expect([...(await assets.children()).keys()]).to.deep.equal(["a.png", "b.png", "notes.txt"]);
  });

  it("lists the account's buckets, a page at a time", async () => {
    await store.close();
    store = await startStore({ ...OBJECTS }, [], ["zeta", "acme", "beta"]);
    const service = accountAt(store).getRepositoryRef(parseName("s3")) as NamespaceRef;
    const children = await service.children();
    expect([...children.keys()]).to.deep.equal(["acme", "beta", "zeta"]);
    expect((children.get("acme") as NamespaceRef).name).to.equal("s3:acme");
    expect(store.requests.map(({ path }) => path)).to.deep.equal(["/?max-buckets=10000", "/?continuation-token=1&max-buckets=10000", "/?continuation-token=2&max-buckets=10000"]);
  });

  it("says what listing the buckets needs where the credentials may not", async () => {
    await store.close();
    store = await startStore({ ...OBJECTS }, [], "refused");
    const service = accountAt(store).getRepositoryRef(parseName("s3")) as NamespaceRef;
    const err = await service.children().then(
      () => undefined,
      e => e as Error
    );
    expect(err?.message).to.match(/@aws's credentials may not list its buckets/);
  });

  it("refuses a bucket the store does not have", async () => {
    const err = await objectsOf(accountAt(store), "s3:other:x").then(
      () => undefined,
      e => e as Error
    );
    expect(err?.message).to.equal(`${store.url} has no bucket 'other'`);
  });

  it("refuses a name that is not a bucket's", () => {
    expect(() => accountAt(store).getRepositoryRef(parseName("s3:Acme:x"))).to.throw("which is not an S3 bucket name");
  });

  it("refuses a service it does not have, naming the ones it does", () => {
    expect(() => accountAt(store).getRepositoryRef(parseName("ec2:x"))).to.throw("@aws has no service 'ec2:x'");
  });

  it("publishes to a key, or a prefix ending in '/'", () => {
    const account = accountAt(store);
    const prefix = account.getRepositoryPublishRef(parseName("s3:acme:site/v3/")) as S3PublishRef;
    expect([prefix.bucket, prefix.key, prefix.isPrefix]).to.deep.equal(["acme", "site/v3/", true]);
    expect((account.getRepositoryPublishRef(parseName("s3:acme/tools/tool.tgz")) as S3PublishRef).key).to.equal("tools/tool.tgz");
  });

  it("refuses to publish to a bucket, or to a pattern", () => {
    const account = accountAt(store);
    expect(() => account.getRepositoryPublishRef(parseName("s3:acme"))).to.throw("it names no key");
    expect(() => account.getRepositoryPublishRef(parseName("s3:acme:site/*.html"))).to.throw("it is written as a pattern");
  });

  it("stores what a prefix's content changed, streamed, signed and typed by extension, and nothing the second time", async () => {
    const objects = { "site/a.css": "a{}", "site/old.html": "old" };
    await store.close();
    store = await startStore(objects);
    const account = accountAt(store);
    const content = new FileSet(
      new Map([
        ["index.html", MemoryFile.from("<p>")],
        ["a.css", MemoryFile.from("a{}")],
      ])
    );
    expect(await publishTo(account, "s3:acme:site/", content)).to.equal("published");
    const puts = store.requests.filter(({ method }) => method === "PUT");
    expect(puts.map(({ path, contentType }) => [path, contentType])).to.deep.equal([["/acme/site/index.html", "text/html; charset=utf-8"]]);
    expect(puts[0].authorization).to.match(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\//);
    expect(objects).to.deep.equal({ "site/a.css": "a{}", "site/old.html": "old", "site/index.html": "<p>" });
    expect(await publishTo(account, "s3:acme:site/", content)).to.equal("already-synced");
    expect(store.requests.filter(({ method }) => method === "PUT").length).to.equal(1);
  });

  it("reports the bytes sent of all the objects it stores, against their total", async () => {
    const objects: Record<string, string> = { "site/same.txt": "same" };
    await store.close();
    store = await startStore(objects);
    const progress: TaskProgress[] = [];
    const content = new FileSet(
      new Map([
        ["a.txt", MemoryFile.from("aaaa")],
        ["b.txt", MemoryFile.from("bbbbbb")],
        ["same.txt", MemoryFile.from("same")],
      ])
    );
    expect(await publishTo(accountAt(store), "s3:acme:site/", content, progress)).to.equal("published");
    expect(progress.at(-1)).to.deep.equal({ measure: "bytes", done: 10, total: 10 });
  });

  it("stores each object with its SHA-256 checksum", async () => {
    const objects: Record<string, string> = {};
    await store.close();
    store = await startStore(objects);
    const content = new FileSet(new Map([["a.txt", MemoryFile.from("a")]]));
    expect(await publishTo(accountAt(store), "s3:acme:site/", content)).to.equal("published");
    const [put] = store.requests.filter(({ method }) => method === "PUT");
    expect(put.checksum).to.equal(crypto.createHash("sha256").update("a").digest("base64"));
  });

  it("knows what it stored in an encrypted bucket, whose ETags are no MD5, by its checksum", async () => {
    const objects: Record<string, string> = {};
    await store.close();
    store = await startStore(objects, [], ["acme"], true);
    const account = accountAt(store);
    const content = new FileSet(
      new Map([
        ["index.html", MemoryFile.from("<p>")],
        ["a.css", MemoryFile.from("a{}")],
      ])
    );
    expect(await publishTo(account, "s3:acme:site/", content)).to.equal("published");
    const first = store.requests.length;
    expect(await publishTo(account, "s3:acme:site/", content)).to.equal("already-synced");
    expect(
      store.requests
        .slice(first)
        .filter(({ method }) => method !== "GET")
        .map(({ method, path }) => `${method} ${path}`)
        .sort()
    ).to.deep.equal(["HEAD /acme/site/a.css", "HEAD /acme/site/index.html"]);
  });

  it("stores again, in an encrypted bucket, an object another tool stored without a checksum", async () => {
    const objects: Record<string, string> = { "site/a.css": "a{}" };
    await store.close();
    store = await startStore(objects, [], ["acme"], true);
    const content = new FileSet(new Map([["a.css", MemoryFile.from("a{}")]]));
    expect(await publishTo(accountAt(store), "s3:acme:site/", content)).to.equal("published");
    expect(store.requests.filter(({ method }) => method === "PUT").map(({ path }) => path)).to.deep.equal(["/acme/site/a.css"]);
  });

  it("stores an object at its key, checking the one object there", async () => {
    const objects: Record<string, string> = {};
    await store.close();
    store = await startStore(objects);
    const content = new FileSet(new Map([["build/tool.tgz", MemoryFile.from("tgz")]]));
    expect(await publishTo(accountAt(store), "s3:acme:tools/tool.tgz", content)).to.equal("published");
    expect(objects).to.deep.equal({ "tools/tool.tgz": "tgz" });
    expect(store.requests.map(({ method, path }) => `${method} ${path}`)).to.deep.equal(["HEAD /acme", "HEAD /acme/tools/tool.tgz", "PUT /acme/tools/tool.tgz"]);
  });

  it("says why S3 refused an object", async () => {
    const content = new FileSet(new Map([["x", MemoryFile.from("x")]]));
    const err = await publishTo(accountAt(store), "s3:acme:private/x", content).then(
      () => undefined,
      e => e as Error
    );
    expect(err?.message).to.equal("cannot store s3://acme/private/x (403): AccessDenied: Access Denied");
  });

  it("lists its services", async () => {
    expect([...(await accountAt(store).children()).keys()]).to.deep.equal(["s3"]);
  });
});
