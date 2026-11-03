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
  MemoryFile,
  NamespaceRef,
  openUrlStream,
  parseName,
  RepositoryLookup,
  RepositoryRef,
  TargetContext,
} from "@fabr-build/core";
import { AwsAccount } from "./AwsAccount";
import { RequestSigner } from "./Signing";

/** An S3-compatible store over a fixed set of objects in the bucket `acme`: GETs of objects and `ListObjectsV2`, one key per page. */
interface IFakeStore {
  readonly url: string;
  /** The requests it was sent: method, path and query, and the authorization header. */
  readonly requests: Array<{ path: string; authorization?: string }>;
  close(): Promise<void>;
}

function startStore(objects: Record<string, string>, refused: string[] = [], buckets: string[] | "refused" = ["acme"]): Promise<IFakeStore> {
  const requests: IFakeStore["requests"] = [];
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url!, authorization: req.headers.authorization });
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
        `<?xml version="1.0"?><ListBucketResult>${page.map(key => `<Contents><Key>${key}</Key></Contents>`).join("")}` +
          `${start === 0 ? grouped.map(prefix => `<CommonPrefixes><Prefix>${prefix}</Prefix></CommonPrefixes>`).join("") : ""}` +
          `<IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${start + 1}</NextContinuationToken>` : ""}</ListBucketResult>`
      );
      return;
    }
    const key = rest.map(decodeURIComponent).join("/");
    if (refused.includes(key)) {
      res.writeHead(403).end();
    } else if (key in objects) {
      res.writeHead(200, { etag: `"${key}"` }).end(objects[key]);
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
  return ((ref as RepositoryRef).source as RepositoryLookup).resolve(ref as RepositoryRef);
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
    store = await startStore(OBJECTS, ["private/x"]);
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
    store = await startStore(OBJECTS, [], ["zeta", "acme", "beta"]);
    const service = accountAt(store).getRepositoryRef(parseName("s3")) as NamespaceRef;
    const children = await service.children();
    expect([...children.keys()]).to.deep.equal(["acme", "beta", "zeta"]);
    expect((children.get("acme") as NamespaceRef).name).to.equal("s3:acme");
    expect(store.requests.map(({ path }) => path)).to.deep.equal(["/?max-buckets=10000", "/?continuation-token=1&max-buckets=10000", "/?continuation-token=2&max-buckets=10000"]);
  });

  it("says what listing the buckets needs where the credentials may not", async () => {
    await store.close();
    store = await startStore(OBJECTS, [], "refused");
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

  it("is no publish destination yet", () => {
    expect(() => accountAt(store).getRepositoryPublishRef(parseName("s3:acme:x"))).to.throw("is not a publish destination yet");
  });

  it("lists its services", async () => {
    expect([...(await accountAt(store).children()).keys()]).to.deep.equal(["s3"]);
  });
});
