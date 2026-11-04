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

import { createHash } from "crypto";
import * as http from "http";
import { AddressInfo } from "net";
import { Writable } from "stream";
import { gunzipSync, gzipSync } from "zlib";
import { expect } from "chai";
import {
  Computable,
  FetchOptions,
  IFetchContext,
  IFetchRequest,
  FileSet,
  IFile,
  MemoryFile,
  packToTarball,
  openUrlStream,
  parseName,
  RepositoryRef,
  ResolvedNode,
  SymlinkFile,
  TargetContext,
} from "@fabr-build/core";
import { ImageFileSet } from "./ImageFileSet";
import { OciRepository, ociPlatformOf } from "./OciRepository";
import { Registry } from "./OciProtocol";

/** Pack `files` as an uncompressed tar, as a layer's is once decompressed. */
function layerTar(files: Record<string, string | SymlinkFile>): Promise<Buffer> {
  const set = new FileSet(
    new Map<string, IFile>(Object.entries(files).map(([name, content]) => [name, typeof content === "string" ? MemoryFile.from(content) : content]))
  );
  return Promise.resolve(packToTarball(set)).then(buffer => gunzipSync(buffer));
}

const sha256 = (data: Buffer | string): string => `sha256:${createHash("sha256").update(data).digest("hex")}`;

/** A registry holding one image, `library/demo:1.0`, for linux/amd64, which every request but `/v2/` and the token's must carry a token for. */
interface IFakeRegistry {
  readonly url: string;
  readonly requests: string[];
  close(): Promise<void>;
}

async function startRegistry(): Promise<IFakeRegistry> {
  const layers = [
    await layerTar({
      "etc/os-release": "base",
      "bin/busybox": "bb",
      "bin/sh": new SymlinkFile("busybox"),
      "usr/share/doc/a": "a",
      "usr/share/doc/b": "b",
    }),
    await layerTar({ "etc/.wh.os-release": "", "usr/share/doc/.wh..wh..opq": "", "usr/share/doc/c": "c", "app/server": "srv" }),
  ];
  const compressed = layers.map(tar => gzipSync(tar));
  const config = JSON.stringify({ architecture: "amd64", os: "linux", rootfs: { type: "layers", diff_ids: layers.map(sha256) }, config: { Env: ["PATH=/bin"] } });
  const manifest = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: sha256(config), size: config.length },
    layers: compressed.map(blob => ({ mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: sha256(blob), size: blob.length })),
  });
  const index = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: sha256(manifest), size: manifest.length, platform: { os: "linux", architecture: "amd64" } },
      { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: sha256("attestation"), size: 11, platform: { os: "unknown", architecture: "unknown" } },
    ],
  });
  const blobs = new Map<string, Buffer | string>([[sha256(config), config], ...compressed.map((blob): [string, Buffer] => [sha256(blob), blob])]);
  const manifests = new Map<string, string>([["1.0", index], [sha256(index), index], [sha256(manifest), manifest]]);
  const requests: string[] = [];
  let origin = "";
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const url = new URL(req.url!, origin);
    if (url.pathname === "/token") {
      res.writeHead(200).end(JSON.stringify({ token: url.searchParams.get("scope") === "repository:library/demo:pull" ? "t" : "wrong" }));
      return;
    }
    if (url.pathname === "/v2/" || req.headers.authorization !== "Bearer t") {
      res.writeHead(401, { "www-authenticate": `Bearer realm="${origin}/token",service="test"` }).end();
      return;
    }
    const found = /^\/v2\/library\/demo\/(manifests|blobs)\/(.+)$/.exec(url.pathname);
    const body = found === null ? undefined : found[1] === "manifests" ? manifests.get(found[2]) : blobs.get(found[2]);
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, found![1] === "manifests" ? { "docker-content-digest": sha256(body) } : {}).end(req.method === "HEAD" ? undefined : body);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url: origin, requests, close: () => new Promise(done => server.close(() => done())) };
}

/** A TargetContext whose `fetch` makes the request it is given, with no cache, and whose OCI_TARGET is `triple`. */
function fetchingContext(triple: string, options: Array<FetchOptions | undefined> = []): TargetContext {
  return {
    name: "@test",
    getGlobalString: () => Computable.resolve(triple),
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

describe("OciRepository", () => {
  let registry: IFakeRegistry;

  beforeEach(async () => {
    registry = await startRegistry();
  });

  afterEach(async () => {
    await registry.close();
  });

  const imageOf = (name: string, triple = "x86_64-unknown-linux", options?: Array<FetchOptions | undefined>): Promise<unknown> => {
    const context = fetchingContext(triple, options);
    const repository = new OciRepository(context, new Registry(context, registry.url), "library");
    const reference = repository.getRepositoryRef(parseName(name)) as RepositoryRef;
    return Promise.resolve(repository.resolve(reference)).then(node => {
      expect(node).to.be.instanceOf(ResolvedNode);
      expect(node.packageName).to.equal("demo");
      expect(node.version).to.match(/^sha256:[0-9a-f]{64}$/);
      /* Resolved from the tag's index and the platform's manifest, no blob fetched. */
      expect(registry.requests.filter(request => request.includes("/blobs/"))).to.deep.equal([]);
      return Promise.resolve(node.content.files());
    });
  };

  it("fetches an image by tag for the platform, presented as its filesystem", async () => {
    const options: Array<FetchOptions | undefined> = [];
    const image = (await imageOf("demo:1.0", undefined, options)) as ImageFileSet;
    expect(image).to.be.instanceOf(ImageFileSet);
    expect([...image].map(([name]) => name).sort()).to.deep.equal(["app/server", "bin/busybox", "bin/sh", "usr/share/doc/c"]);
    expect(await image.readFile("app/server")).to.equal("srv");
    expect(image.getFile("bin/sh")).to.be.instanceOf(SymlinkFile);
    expect(image.config.document.config).to.deep.equal({ Env: ["PATH=/bin"] });
    expect(image.layers.map(layer => layer.published?.mediaType)).to.deep.equal([
      "application/vnd.oci.image.layer.v1.tar+gzip",
      "application/vnd.oci.image.layer.v1.tar+gzip",
    ]);
    /* The tag's manifest is a pointer, re-checked by its digest; the rest is named by digest. */
    expect(options[0]).to.deep.equal({ immutable: false, digestHeader: "Docker-Content-Digest" });
    expect(options.slice(1).every(option => option === undefined)).to.equal(true);
  });

  it("reads a Linux triple's CPU as OCI's architecture", () => {
    expect(ociPlatformOf("x86_64-unknown-linux")).to.deep.equal({ os: "linux", architecture: "amd64" });
    expect(ociPlatformOf("aarch64-unknown-linux-gnu")).to.deep.equal({ os: "linux", architecture: "arm64" });
    expect(ociPlatformOf("armv7-unknown-linux-gnueabihf")).to.deep.equal({ os: "linux", architecture: "arm", variant: "v7" });
    expect(() => ociPlatformOf("aarch64-apple-darwin")).to.throw(/not a Linux platform/);
  });

  it("names the platforms an image has where none is the one asked for", async () => {
    const failure = await imageOf("demo:1.0", "aarch64-unknown-linux").catch((err: Error) => err);
    expect((failure as Error).message).to.match(/has no image for linux\/arm64/);
  });

  it("vends a namespace for an image named without a version, and a projection after one", () => {
    const context = fetchingContext("x86_64-unknown-linux");
    const repository = new OciRepository(context, new Registry(context, registry.url), "library");
    expect(repository.getRepositoryRef(parseName("demo")).constructor.name).to.equal("NamespaceRef");
    const projected = repository.getRepositoryRef(parseName("demo:1.0:etc/*")) as RepositoryRef;
    expect(projected.name).to.equal("demo");
    expect(projected.versionConstraint).to.equal("1.0");
    expect(projected.projections).to.have.lengthOf(1);
  });
});
