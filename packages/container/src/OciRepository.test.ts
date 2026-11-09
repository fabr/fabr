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
  PartialRepositoryRef,
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
import { RegistrySignIn } from "./RegistrySignIn";

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
  /* What each repository holds: its manifests by tag and digest, and the digests of its blobs. */
  const repositories = new Map<string, { manifests: Map<string, string>; blobs: Set<string> }>([
    ["library/demo", { manifests, blobs: new Set(blobs.keys()) }],
  ]);
  const repositoryOf = (name: string): { manifests: Map<string, string>; blobs: Set<string> } => {
    if (!repositories.has(name)) {
      repositories.set(name, { manifests: new Map(), blobs: new Set() });
    }
    return repositories.get(name)!;
  };
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const url = new URL(req.url!, origin);
    if (url.pathname === "/token") {
      const scopes = url.searchParams.getAll("scope");
      res.writeHead(200).end(JSON.stringify({ token: scopes.length > 0 && scopes.every(scope => scope.startsWith("repository:")) ? "t" : "wrong" }));
      return;
    }
    if (url.pathname === "/v2/" || req.headers.authorization !== "Bearer t") {
      res.writeHead(401, { "www-authenticate": `Bearer realm="${origin}/token",service="test"` }).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const received = Buffer.concat(chunks);
      /* Each repository's tags, two a page, the next linked from the last. */
      const tagList = /^\/v2\/(.+)\/tags\/list$/.exec(url.pathname);
      if (tagList !== null) {
        const tags = [...(repositories.get(tagList[1])?.manifests.keys() ?? [])].filter(tag => !tag.startsWith("sha256:")).sort();
        if (!repositories.has(tagList[1])) {
          res.writeHead(404).end();
          return;
        }
        const last = url.searchParams.get("last");
        const rest = last === null ? tags : tags.filter(tag => tag > last);
        const page = rest.slice(0, 2);
        const more = rest.length > 2 ? { link: `</v2/${tagList[1]}/tags/list?n=2&last=${page[page.length - 1]}>; rel="next"` } : {};
        res.writeHead(200, more).end(JSON.stringify({ name: tagList[1], tags: page }));
        return;
      }
      const upload = /^\/v2\/(.+)\/blobs\/uploads\/(.*)$/.exec(url.pathname);
      if (upload !== null && req.method === "POST") {
        const mount = url.searchParams.get("mount");
        const from = url.searchParams.get("from");
        if (mount !== null && from !== null && repositoryOf(from).blobs.has(mount)) {
          repositoryOf(upload[1]).blobs.add(mount);
          res.writeHead(201).end();
        } else {
          res.writeHead(202, { location: `/v2/${upload[1]}/blobs/uploads/session` }).end();
        }
        return;
      }
      if (upload !== null && req.method === "PUT") {
        const digest = url.searchParams.get("digest")!;
        if (sha256(received) !== digest) {
          res.writeHead(400).end("digest mismatch");
          return;
        }
        blobs.set(digest, received);
        repositoryOf(upload[1]).blobs.add(digest);
        res.writeHead(201).end();
        return;
      }
      const found = /^\/v2\/(.+)\/(manifests|blobs)\/([^/]+)$/.exec(url.pathname);
      if (found !== null && found[2] === "manifests" && req.method === "PUT") {
        const text = received.toString("utf8");
        repositoryOf(found[1]).manifests.set(found[3], text);
        repositoryOf(found[1]).manifests.set(sha256(text), text);
        res.writeHead(201).end();
        return;
      }
      const held = found === null ? undefined : repositoryOf(found[1]);
      const body =
        found === null || held === undefined
          ? undefined
          : found[2] === "manifests"
          ? held.manifests.get(found[3])
          : held.blobs.has(found[3])
          ? blobs.get(found[3])
          : undefined;
      if (body === undefined) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, found![2] === "manifests" ? { "docker-content-digest": sha256(body) } : {}).end(req.method === "HEAD" ? undefined : body);
    });
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
      return request().then(({ url, headers, credential, process }) =>
        openUrlStream(url, headers, Date.now, "content", undefined, credential).then(response => {
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
    const repository = new OciRepository(context, new Registry(context, registry.url, new RegistrySignIn(registry.url, () => Computable.resolve(undefined))), "library");
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

  it("publishes an image under a tag, mounting the layers its registry already holds, then finds it synced", async () => {
    const context = fetchingContext("x86_64-unknown-linux");
    const repository = new OciRepository(context, new Registry(context, registry.url, new RegistrySignIn(registry.url, () => Computable.resolve(undefined))), "library");
    const node = await Promise.resolve(repository.resolve(repository.getRepositoryRef(parseName("demo:1.0")) as RepositoryRef));
    const image = (await Promise.resolve(node.content.files())) as ImageFileSet;
    const destination = repository.getRepositoryPublishRef(parseName("myorg/copy:2"));
    const [carrier] = await Promise.resolve(repository.package([{ destination, content: image }]));
    registry.requests.length = 0;
    expect(await Promise.resolve(repository.publish(carrier))).to.equal("published");
    const mounts = registry.requests.filter(request => request.startsWith("POST /v2/myorg/copy/blobs/uploads/?mount="));
    expect(mounts).to.have.lengthOf(2);
    expect(registry.requests).to.include("PUT /v2/myorg/copy/manifests/2");

    const copied = await Promise.resolve(repository.resolve(repository.getRepositoryRef(parseName("myorg/copy:2")) as RepositoryRef));
    const pulled = (await Promise.resolve(copied.content.files())) as ImageFileSet;
    expect(await pulled.readFile("app/server")).to.equal("srv");
    expect(await Promise.resolve(repository.publish(carrier))).to.equal("already-synced");
  });

  it("lists an image's tags, page by page, each as the reference to its image", async () => {
    const context = fetchingContext("x86_64-unknown-linux");
    const repository = new OciRepository(context, new Registry(context, registry.url, new RegistrySignIn(registry.url, () => Computable.resolve(undefined))), "library");
    for (const tag of ["2.0", "1.1", "0.9"]) {
      const node = await Promise.resolve(repository.resolve(repository.getRepositoryRef(parseName("demo:1.0")) as RepositoryRef));
      const image = (await Promise.resolve(node.content.files())) as ImageFileSet;
      const [carrier] = await Promise.resolve(repository.package([{ destination: repository.getRepositoryPublishRef(parseName(`demo:${tag}`)), content: image }]));
      await Promise.resolve(repository.publish(carrier));
    }
    const listed = await Promise.resolve(repository.children(repository.getRepositoryRef(parseName("demo")) as PartialRepositoryRef));
    expect([...listed.keys()]).to.deep.equal(["0.9", "1.0", "1.1", "2.0"]);
    const ref = listed.get("1.1") as RepositoryRef;
    expect([ref.name, ref.versionConstraint]).to.deep.equal(["demo", "1.1"]);
    expect(registry.requests.filter(request => request.startsWith("GET /v2/library/demo/tags/list"))).to.have.lengthOf(2);
    const missing = await Promise.resolve(repository.children(repository.getRepositoryRef(parseName("absent")) as PartialRepositoryRef)).catch((err: Error) => err);
    expect((missing as Error).message).to.match(/has no image absent/);
  });

  it("refuses a digest, or a name with no tag, as a coordinate to publish to", () => {
    const context = fetchingContext("x86_64-unknown-linux");
    const repository = new OciRepository(context, new Registry(context, registry.url, new RegistrySignIn(registry.url, () => Computable.resolve(undefined))), "library");
    expect(() => repository.getRepositoryPublishRef(parseName(`myorg/app:sha256:${"a".repeat(64)}`))).to.throw(/no image and tag to publish to/);
    expect(() => repository.getRepositoryPublishRef(parseName("myorg/app"))).to.throw(/no image and tag to publish to/);
  });

  it("names the platforms an image has where none is the one asked for", async () => {
    const failure = await imageOf("demo:1.0", "aarch64-unknown-linux").catch((err: Error) => err);
    expect((failure as Error).message).to.match(/has no image for linux\/arm64/);
  });

  it("vends a namespace for an image named without a version, and a projection after one", () => {
    const context = fetchingContext("x86_64-unknown-linux");
    const repository = new OciRepository(context, new Registry(context, registry.url, new RegistrySignIn(registry.url, () => Computable.resolve(undefined))), "library");
    expect(repository.getRepositoryRef(parseName("demo")).constructor.name).to.equal("PartialRepositoryRef");
    const projected = repository.getRepositoryRef(parseName("demo:1.0:etc/*")) as RepositoryRef;
    expect(projected.name).to.equal("demo");
    expect(projected.versionConstraint).to.equal("1.0");
    expect(projected.projections).to.have.lengthOf(1);
  });
});
