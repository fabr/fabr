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
import * as fs from "fs";
import * as http from "http";
import { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { Writable } from "stream";
import { gunzipSync, gzipSync } from "zlib";
import { expect } from "chai";
import {
  Computable,
  contentSize,
  FetchOptions,
  FileSet,
  IFetchContext,
  IFetchRequest,
  IFile,
  MemoryFile,
  openUrlStream,
  packToTarball,
  parseName,
  PartialRepositoryRef,
  RepositoryRef,
  ResolvedNode,
  SecureString,
  SILENT_REPORT,
  SymlinkFile,
  TargetContext,
} from "@fabr-build/core";
import { ILayerRecord, ImageFileSet } from "./ImageFileSet";
import { indexLayer } from "./LayerIndex";
import { OciRepository, ociPlatformOf, registrySignIn } from "./OciRepository";
import { Registry, toImageConfig } from "./OciProtocol";
import { RegistrySignIn } from "./RegistrySignIn";

/** Pack `files` as an uncompressed tar, as a layer's is once decompressed. */
function layerTar(files: Record<string, string | SymlinkFile>): Promise<Buffer> {
  const set = new FileSet(
    new Map<string, IFile>(
      Object.entries(files).map(([name, content]) => [name, typeof content === "string" ? MemoryFile.from(content) : content])
    )
  );
  return Promise.resolve(packToTarball(set)).then(buffer => gunzipSync(buffer));
}

/** Make the record of a layer built here holding `files`. */
async function builtLayer(files: Record<string, string>): Promise<ILayerRecord> {
  const tar = await layerTar(files);
  const { sink, result } = indexLayer();
  await new Promise<void>((resolve, reject) => sink.on("finish", resolve).on("error", reject).end(tar));
  const index = result();
  return { tar: new MemoryFile(tar), index, indexFile: MemoryFile.from(JSON.stringify(index)) };
}

/* The work directories the test contexts' memos were made in. */
const workDirs: string[] = [];

const sha256 = (data: Buffer | string): string => `sha256:${createHash("sha256").update(data).digest("hex")}`;

/** A registry holding one image, `library/demo:1.0`, for linux/amd64, which every request but `/v2/` and the token's must carry a token for. */
interface IFakeRegistry {
  readonly url: string;
  readonly requests: string[];
  /** Get the manifests `repository` holds, by tag and digest. */
  manifestsOf(repository: string): ReadonlyMap<string, string>;
  /** Get the blob `digest`, as uploaded or held. */
  blob(digest: string): Buffer | string | undefined;
  close(): Promise<void>;
}

/** A certificate for the fake Fulcio to issue. */
const CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIBJzCBzgIJAJfJvFEElpo7MAoGCCqGSM49BAMCMBsxGTAXBgNVBAMMEGZhYnIt
dGVzdC1mdWxjaW8wIBcNMjYxMTExMDI0MzAxWhgPMjEyNjEwMTgwMjQzMDFaMBsx
GTAXBgNVBAMMEGZhYnItdGVzdC1mdWxjaW8wWTATBgcqhkjOPQIBBggqhkjOPQMB
BwNCAASixLPyPpMtg39bfwejfBKj1fZfJH4IYZh8DuVlD4eeBDQ/QjcYynjEQnvu
i5oBWk0tSGCd0oy2JZXic3fOO7uuMAoGCCqGSM49BAMCA0gAMEUCIQD8lycWVf8S
07g74WFv3ck8l+7FcyjjHWIjU6S31EwhtAIgZPDNsOQR9elPe7TNMzUFq6SzylrL
SZmsJo0cKcK3owM=
-----END CERTIFICATE-----
`;

/**
 * Start a registry holding one image, `library/demo:1.0`, which also answers
 * as Sigstore's Fulcio and Rekor. With `referrers`, it says it recorded a
 * pushed manifest's subject (`OCI-Subject`), as one with the referrers API
 * does; with `rekorStatus`, Rekor answers with that status; with
 * `failReferrers`, it refuses that many puts of a manifest with a subject.
 */
async function startRegistry(
  options: { declineMounts?: boolean; referrers?: boolean; rekorStatus?: number; failReferrers?: number } = {}
): Promise<IFakeRegistry> {
  let refusals = options.failReferrers ?? 0;
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
  const config = JSON.stringify({
    architecture: "amd64",
    os: "linux",
    rootfs: { type: "layers", diff_ids: layers.map(sha256) },
    config: { Env: ["PATH=/bin"] },
  });
  const manifest = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: sha256(config), size: config.length },
    layers: compressed.map(blob => ({
      mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
      digest: sha256(blob),
      size: blob.length,
    })),
  });
  const index = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: sha256(manifest),
        size: manifest.length,
        platform: { os: "linux", architecture: "amd64" },
      },
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: sha256("attestation"),
        size: 11,
        platform: { os: "unknown", architecture: "unknown" },
      },
    ],
  });
  const blobs = new Map<string, Buffer | string>([
    [sha256(config), config],
    ...compressed.map((blob): [string, Buffer] => [sha256(blob), blob]),
  ]);
  const manifests = new Map<string, string>([
    ["1.0", index],
    [sha256(index), index],
    [sha256(manifest), manifest],
  ]);
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
      res
        .writeHead(200)
        .end(JSON.stringify({ token: scopes.length > 0 && scopes.every(scope => scope.startsWith("repository:")) ? "t" : "wrong" }));
      return;
    }
    if (url.pathname === "/api/v2/signingCert") {
      res.writeHead(201).end(JSON.stringify({ signedCertificateEmbeddedSct: { chain: { certificates: [CERTIFICATE] } } }));
      return;
    }
    if (url.pathname === "/api/v1/log/entries") {
      const entry = {
        body: Buffer.from('{"kind":"dsse","apiVersion":"0.0.1"}').toString("base64"),
        integratedTime: 1,
        logID: "00",
        logIndex: 7,
      };
      res
        .writeHead(options.rekorStatus ?? 201)
        .end(options.rekorStatus === undefined ? JSON.stringify({ uuid: entry }) : "unavailable");
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
        if (!options.declineMounts && mount !== null && from !== null && repositoryOf(from).blobs.has(mount)) {
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
        if ((JSON.parse(text) as { subject?: unknown }).subject !== undefined && refusals > 0) {
          refusals--;
          res.writeHead(500).end("unavailable");
          return;
        }
        repositoryOf(found[1]).manifests.set(found[3], text);
        repositoryOf(found[1]).manifests.set(sha256(text), text);
        const subject = (JSON.parse(text) as { subject?: { digest: string } }).subject;
        res.writeHead(201, options.referrers && subject !== undefined ? { "oci-subject": subject.digest } : {}).end();
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
      res
        .writeHead(200, found![2] === "manifests" ? { "docker-content-digest": sha256(body) } : {})
        .end(req.method === "HEAD" ? undefined : body);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: origin,
    requests,
    manifestsOf: repository => repositoryOf(repository).manifests,
    blob: digest => blobs.get(digest),
    close: () => new Promise(done => server.close(() => done())),
  };
}

/**
 * A TargetContext whose `fetch` makes the request it is given, with no cache,
 * and whose OCI_TARGET is `triple`; the auth files hold no login, and each
 * name a login is looked up under is added to `logins`.
 */
function fetchingContext(triple: string, options: Array<FetchOptions | undefined> = [], logins: string[] = []): TargetContext {
  const auth = {
    registryAuth: () =>
      Computable.resolve({
        credentialFor: (server: string) => {
          logins.push(server);
          return Computable.resolve(undefined);
        },
      }),
  };
  return {
    name: "@test",
    execution: { getOrCreatePluginContext: () => auth },
    getGlobalString: () => Computable.resolve(SecureString.of(triple)),
    memoize: (_tag: string, _key: string, make: (workDir: string) => Computable<FileSet>) => {
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-oci-test-"));
      workDirs.push(workDir);
      return make(workDir);
    },
    reshape: <T>(_tag: string, file: { readString(): Computable<string> }, convert: (text: string) => T) =>
      file.readString().then(convert),
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
    workDirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true }));
  });

  const imageOf = (name: string, triple = "x86_64-unknown-linux", options?: Array<FetchOptions | undefined>): Promise<unknown> => {
    const context = fetchingContext(triple, options);
    const repository = new OciRepository(
      context,
      new Registry(
        context,
        SecureString.of(registry.url),
        new RegistrySignIn(SecureString.of(registry.url), () => Computable.resolve(undefined))
      ),
      "library"
    );
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
    const repository = new OciRepository(
      context,
      new Registry(
        context,
        SecureString.of(registry.url),
        new RegistrySignIn(SecureString.of(registry.url), () => Computable.resolve(undefined))
      ),
      "library"
    );
    const node = await Promise.resolve(repository.resolve(repository.getRepositoryRef(parseName("demo:1.0")) as RepositoryRef));
    const image = (await Promise.resolve(node.content.files())) as ImageFileSet;
    const destination = repository.getRepositoryPublishRef(parseName("myorg/copy:2"));
    const [carrier] = await Promise.resolve(repository.package([{ destination, content: image }]));

    /* The carrier is an OCI image layout: its index names the manifest by digest, with its platform and full reference. */
    expect(JSON.parse(await carrier.readFile("oci-layout"))).to.deep.equal({ imageLayoutVersion: "1.0.0" });
    const index = JSON.parse(await carrier.readFile("index.json")) as {
      mediaType: string;
      manifests: Array<{ digest: string; size: number; platform: unknown; annotations: Record<string, string> }>;
    };
    expect(index.mediaType).to.equal("application/vnd.oci.image.index.v1+json");
    expect(index.manifests).to.have.lengthOf(1);
    const [entry] = index.manifests;
    const manifestFile = carrier.getFile(`blobs/sha256/${entry.digest.substring("sha256:".length)}`)!;
    expect(`sha256:${manifestFile.hash}`).to.equal(entry.digest);
    expect(await Promise.resolve(contentSize(manifestFile))).to.equal(entry.size);
    expect(entry.platform).to.deep.equal({ os: "linux", architecture: "amd64" });
    expect(entry.annotations["org.opencontainers.image.ref.name"]).to.equal(
      `${new URL(registry.url).host}/myorg/copy:2@${entry.digest}`
    );
    const manifest = JSON.parse(await carrier.readFile(`blobs/sha256/${entry.digest.substring(7)}`)) as {
      config: { digest: string };
      layers: Array<{ digest: string }>;
    };
    expect(carrier.getFile(`blobs/sha256/${manifest.config.digest.substring(7)}`)).to.not.equal(undefined);
    /* The layers were fetched, so they are had from their registry rather than held. */
    expect(manifest.layers.map(layer => carrier.getFile(`blobs/sha256/${layer.digest.substring(7)}`))).to.deep.equal([
      undefined,
      undefined,
    ]);

    registry.requests.length = 0;
    expect(await Promise.resolve(repository.publish(carrier, SILENT_REPORT))).to.equal("published");
    const mounts = registry.requests.filter(request => request.startsWith("POST /v2/myorg/copy/blobs/uploads/?mount="));
    expect(mounts).to.have.lengthOf(2);
    expect(registry.requests).to.include("PUT /v2/myorg/copy/manifests/2");

    const copied = await Promise.resolve(repository.resolve(repository.getRepositoryRef(parseName("myorg/copy:2")) as RepositoryRef));
    const pulled = (await Promise.resolve(copied.content.files())) as ImageFileSet;
    expect(await pulled.readFile("app/server")).to.equal("srv");
    expect(await Promise.resolve(repository.publish(carrier, SILENT_REPORT))).to.equal("already-synced");
  });

  it("publishes an image built here, its layers compressed into the carrier's layout and uploaded from there", async () => {
    const context = fetchingContext("x86_64-unknown-linux");
    const repository = new OciRepository(
      context,
      new Registry(
        context,
        SecureString.of(registry.url),
        new RegistrySignIn(SecureString.of(registry.url), () => Computable.resolve(undefined))
      ),
      "library"
    );
    const layer = await builtLayer({ "app/main": "built" });
    const config = toImageConfig({ architecture: "arm64", os: "linux", rootfs: { type: "layers", diff_ids: [layer.index.diffId] } });
    const image = ImageFileSet.of(config, [layer], "app");
    const [carrier] = await Promise.resolve(
      repository.package([{ destination: repository.getRepositoryPublishRef(parseName("myorg/app:1")), content: image }])
    );
    const index = JSON.parse(await carrier.readFile("index.json")) as {
      manifests: Array<{ digest: string; platform: unknown; annotations: Record<string, string> }>;
    };
    expect(index.manifests[0].platform).to.deep.equal({ os: "linux", architecture: "arm64" });
    const manifest = JSON.parse(await carrier.readFile(`blobs/sha256/${index.manifests[0].digest.substring(7)}`)) as {
      layers: Array<{ mediaType: string; digest: string }>;
    };
    expect(manifest.layers.map(entry => entry.mediaType)).to.deep.equal(["application/vnd.oci.image.layer.v1.tar+gzip"]);
    const compressed = carrier.getFile(`blobs/sha256/${manifest.layers[0].digest.substring(7)}`)!;
    expect(gunzipSync(await Promise.resolve(compressed.getBuffer())).equals(await Promise.resolve(layer.tar.getBuffer()))).to.equal(
      true
    );
    expect(JSON.parse(await carrier.readFile("sources.json"))).to.deep.equal([]);

    expect(await Promise.resolve(repository.publish(carrier, SILENT_REPORT))).to.equal("published");
    expect(registry.requests.some(request => request.startsWith("PUT /v2/myorg/app/blobs/uploads/"))).to.equal(true);
    const pushed = await Promise.resolve(repository.resolve(repository.getRepositoryRef(parseName("myorg/app:1")) as RepositoryRef));
    expect(pushed.version).to.equal(index.manifests[0].digest);
  });

  it("uploads a layer its registry declines to mount, read through the registry's own sign-in", async () => {
    const declining = await startRegistry({ declineMounts: true });
    try {
      const context = fetchingContext("x86_64-unknown-linux");
      const repository = new OciRepository(
        context,
        new Registry(
          context,
          SecureString.of(declining.url),
          new RegistrySignIn(SecureString.of(declining.url), () => Computable.resolve(undefined))
        ),
        "library"
      );
      const node = await Promise.resolve(repository.resolve(repository.getRepositoryRef(parseName("demo:1.0")) as RepositoryRef));
      const image = (await Promise.resolve(node.content.files())) as ImageFileSet;
      const [carrier] = await Promise.resolve(
        repository.package([{ destination: repository.getRepositoryPublishRef(parseName("myorg/copy:2")), content: image }])
      );
      declining.requests.length = 0;
      expect(await Promise.resolve(repository.publish(carrier, SILENT_REPORT))).to.equal("published");
      expect(declining.requests.filter(request => request.startsWith("GET /v2/library/demo/blobs/"))).to.have.lengthOf(2);
      /* The token the registry's sign-in holds for reading `library/demo` is reused: no second client signs in. */
      expect(
        declining.requests.filter(request => /^GET \/token\?service=test&scope=repository%3Alibrary%2Fdemo%3Apull$/.test(request))
      ).to.deep.equal([]);
    } finally {
      await declining.close();
    }
  });

  it("copies a layer from the registry it was published to, signing in there under its declared login", async () => {
    const target = await startRegistry();
    try {
      const logins: string[] = [];
      const context = fetchingContext("x86_64-unknown-linux", [], logins);
      const source = new OciRepository(
        context,
        new Registry(
          context,
          SecureString.of(registry.url),
          new RegistrySignIn(SecureString.of(registry.url), () => Computable.resolve(undefined))
        ),
        "library",
        "https://login.example/v1/"
      );
      const node = await Promise.resolve(source.resolve(source.getRepositoryRef(parseName("demo:1.0")) as RepositoryRef));
      const image = (await Promise.resolve(node.content.files())) as ImageFileSet;
      expect(image.layers.map(layer => layer.published?.loginUrl)).to.deep.equal([
        "https://login.example/v1/",
        "https://login.example/v1/",
      ]);
      const destination = new OciRepository(
        context,
        new Registry(
          context,
          SecureString.of(target.url),
          new RegistrySignIn(SecureString.of(target.url), () => Computable.resolve(undefined))
        )
      );
      const [carrier] = await Promise.resolve(
        destination.package([{ destination: destination.getRepositoryPublishRef(parseName("myorg/copy:2")), content: image }])
      );
      expect(await Promise.resolve(destination.publish(carrier, SILENT_REPORT))).to.equal("published");
      expect(logins).to.include("https://login.example/v1/");
      const copied = await Promise.resolve(
        destination.resolve(destination.getRepositoryRef(parseName("myorg/copy:2")) as RepositoryRef)
      );
      expect(await ((await Promise.resolve(copied.content.files())) as ImageFileSet).readFile("app/server")).to.equal("srv");
    } finally {
      await target.close();
    }
  });

  it("lists an image's tags, page by page, each as the reference to its image", async () => {
    const context = fetchingContext("x86_64-unknown-linux");
    const repository = new OciRepository(
      context,
      new Registry(
        context,
        SecureString.of(registry.url),
        new RegistrySignIn(SecureString.of(registry.url), () => Computable.resolve(undefined))
      ),
      "library"
    );
    for (const tag of ["2.0", "1.1", "0.9"]) {
      const node = await Promise.resolve(repository.resolve(repository.getRepositoryRef(parseName("demo:1.0")) as RepositoryRef));
      const image = (await Promise.resolve(node.content.files())) as ImageFileSet;
      const [carrier] = await Promise.resolve(
        repository.package([{ destination: repository.getRepositoryPublishRef(parseName(`demo:${tag}`)), content: image }])
      );
      await Promise.resolve(repository.publish(carrier, SILENT_REPORT));
    }
    const listed = await Promise.resolve(repository.children(repository.getRepositoryRef(parseName("demo")) as PartialRepositoryRef));
    expect([...listed.keys()]).to.deep.equal(["0.9", "1.0", "1.1", "2.0"]);
    const ref = listed.get("1.1") as RepositoryRef;
    expect([ref.name, ref.versionConstraint]).to.deep.equal(["demo", "1.1"]);
    expect(registry.requests.filter(request => request.startsWith("GET /v2/library/demo/tags/list"))).to.have.lengthOf(2);
    const missing = await Promise.resolve(
      repository.children(repository.getRepositoryRef(parseName("absent")) as PartialRepositoryRef)
    ).catch((err: Error) => err);
    expect((missing as Error).message).to.match(/has no image absent/);
  });

  it("shows a registry URL written as an environment variable as written where the registry refuses", async () => {
    const context = fetchingContext("x86_64-unknown-linux");
    const url = SecureString.masked(registry.url, "${ENV.REGISTRY}");
    const repository = new OciRepository(
      context,
      new Registry(context, url, new RegistrySignIn(url, () => Computable.resolve(undefined))),
      "library"
    );
    const missing = await Promise.resolve(
      repository.children(repository.getRepositoryRef(parseName("absent")) as PartialRepositoryRef)
    ).catch((err: Error) => err);
    expect((missing as Error).message).to.match(/^\$\{ENV\.REGISTRY\}.* has no image absent/);
    expect((missing as Error).message).not.to.contain(registry.url);
  });

  it("refuses a digest, or a name with no tag, as a coordinate to publish to", () => {
    const context = fetchingContext("x86_64-unknown-linux");
    const repository = new OciRepository(
      context,
      new Registry(
        context,
        SecureString.of(registry.url),
        new RegistrySignIn(SecureString.of(registry.url), () => Computable.resolve(undefined))
      ),
      "library"
    );
    expect(() => repository.getRepositoryPublishRef(parseName(`myorg/app:sha256:${"a".repeat(64)}`))).to.throw(
      /no image and tag to publish to/
    );
    expect(() => repository.getRepositoryPublishRef(parseName("myorg/app"))).to.throw(/no image and tag to publish to/);
  });

  it("names the platforms an image has where none is the one asked for", async () => {
    const failure = await imageOf("demo:1.0", "aarch64-unknown-linux").catch((err: Error) => err);
    expect((failure as Error).message).to.match(/has no image for linux\/arm64/);
  });

  it("signs in the registry's own requests alone, never a blob or an upload on another origin", async () => {
    const credential = {
      authorize: (): Computable<ReadonlyMap<string, string>> => Computable.resolve(new Map([["authorization", "Basic c"]])),
    };
    const signIn = registrySignIn(
      fetchingContext("x86_64-unknown-linux"),
      SecureString.of("https://registry.example"),
      undefined,
      credential
    );
    const at = (url: string): { method: string; url: string; headers: Map<string, string> } => ({
      method: "PUT",
      url,
      headers: new Map(),
    });
    expect(await signIn.authorize(at("https://registry.example/v2/app/blobs/uploads/1"))).to.deep.equal(
      new Map([["authorization", "Basic c"]])
    );
    expect(await signIn.authorize(at("https://storage.example/upload/1"))).to.deep.equal(new Map());
    expect(await signIn.authorize(at("https://storage.example/upload/1"), { challenges: ["Basic"] })).to.equal(undefined);
  });

  it("vends a namespace for an image named without a version, and a projection after one", () => {
    const context = fetchingContext("x86_64-unknown-linux");
    const repository = new OciRepository(
      context,
      new Registry(
        context,
        SecureString.of(registry.url),
        new RegistrySignIn(SecureString.of(registry.url), () => Computable.resolve(undefined))
      ),
      "library"
    );
    expect(repository.getRepositoryRef(parseName("demo")).constructor.name).to.equal("PartialRepositoryRef");
    const projected = repository.getRepositoryRef(parseName("demo:1.0:etc/*")) as RepositoryRef;
    expect(projected.name).to.equal("demo");
    expect(projected.versionConstraint).to.equal("1.0");
    expect(projected.projections).to.have.lengthOf(1);
  });
});

describe("OciRepository provenance", () => {
  const SIGSTORE_BUNDLE = "application/vnd.dev.sigstore.bundle.v0.3+json";
  let server: IFakeRegistry;

  afterEach(async () => {
    await server.close();
    workDirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true }));
  });

  /** Make an unsigned JWT whose payload is `claims`. */
  function jwt(claims: Record<string, unknown>): string {
    const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${part({ alg: "RS256" })}.${part(claims)}.signature`;
  }

  /**
   * Push an image built here to `myorg/app:<tag>` on `server`, which serves
   * Sigstore too, from a CI job building a repository of `visibility` (none:
   * outside CI). @return what the push reports, the image's digest and the
   * annotations the push reported.
   */
  async function pushFromRun(
    options: { visibility?: "public" | "private"; provenance?: boolean; tag?: string } = {}
  ): Promise<{ status: string; digest: string; annotations: string[] }> {
    const context = fetchingContext("x86_64-unknown-linux");
    if (options.visibility !== undefined) {
      (context.execution as { identityProvider?: unknown }).identityProvider = {
        token: (audience: string) =>
          Computable.resolve(audience === "sigstore" ? jwt({ sub: "repo:acme/app:ref:refs/heads/main" }) : "id"),
        build: {
          statementType: "https://in-toto.io/Statement/v1",
          predicateType: "https://slsa.dev/provenance/v1",
          predicate: { runDetails: { metadata: { invocationId: "https://github.com/acme/app/actions/runs/1/attempts/1" } } },
          sourceRepository: "https://github.com/acme/app",
          isPublicSource: () => Computable.resolve(options.visibility === "public"),
        },
      };
    }
    const repository = new OciRepository(
      context,
      new Registry(
        context,
        SecureString.of(server.url),
        new RegistrySignIn(SecureString.of(server.url), () => Computable.resolve(undefined))
      ),
      undefined,
      undefined,
      options.provenance ?? true,
      { fulcioUrl: server.url, rekorUrl: server.url }
    );
    const layer = await builtLayer({ "app/main": "built" });
    const config = toImageConfig({ architecture: "amd64", os: "linux", rootfs: { type: "layers", diff_ids: [layer.index.diffId] } });
    const [carrier] = await Promise.resolve(
      repository.package([
        {
          destination: repository.getRepositoryPublishRef(parseName(`myorg/app:${options.tag ?? "1"}`)),
          content: ImageFileSet.of(config, [layer], "app"),
        },
      ])
    );
    const index = JSON.parse(await carrier.readFile("index.json")) as { manifests: Array<{ digest: string }> };
    const annotations: string[] = [];
    const status = await Promise.resolve(repository.publish(carrier, { ...SILENT_REPORT, annotate: text => annotations.push(text) }));
    return { status, digest: index.manifests[0].digest, annotations };
  }

  /** @return the attestations `repository` holds, each its manifest. */
  function attestationsIn(repository: string): Array<{ subject: { digest: string }; layers: Array<{ digest: string }> }> {
    return [...new Set(server.manifestsOf(repository).values())]
      .map(text => JSON.parse(text) as { artifactType?: string; subject: { digest: string }; layers: Array<{ digest: string }> })
      .filter(manifest => manifest.artifactType === SIGSTORE_BUNDLE);
  }

  /** @return the in-toto statement the bundle of `attestation` signs. */
  function statementOf(attestation: { layers: Array<{ digest: string }> }): { subject: Array<{ name: string; digest: unknown }> } {
    const bundle = JSON.parse(server.blob(attestation.layers[0].digest)!.toString()) as { dsseEnvelope: { payload: string } };
    return JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64").toString("utf8")) as {
      subject: Array<{ name: string; digest: unknown }>;
    };
  }

  it("attaches a signed provenance statement to an image pushed from a public repository's CI, as a referrer", async () => {
    server = await startRegistry({ referrers: true });
    const { status, digest, annotations } = await pushFromRun({ visibility: "public" });
    expect(status).to.equal("published");
    expect(annotations).to.deep.equal(["provenance"]);
    const [attestation, ...others] = attestationsIn("myorg/app");
    expect(others).to.deep.equal([]);
    expect(attestation.subject.digest).to.equal(digest);
    expect(statementOf(attestation).subject).to.deep.equal([
      { name: `${new URL(server.url).host}/myorg/app`, digest: { sha256: digest.substring("sha256:".length) } },
    ]);
    /* The registry recorded the subject, so no referrers tag index is written. */
    expect(server.manifestsOf("myorg/app").has(digest.replace(":", "-"))).to.equal(false);
    /* Signed before anything was pushed; the image put by digest, then its attestation, then the tag. */
    const signed = server.requests.indexOf("POST /api/v1/log/entries");
    const puts = server.requests.filter(request => request.startsWith("PUT /v2/myorg/app/manifests/"));
    expect(signed).to.be.lessThan(server.requests.indexOf(puts[0]));
    expect(puts).to.have.lengthOf(3);
    expect(puts[0]).to.equal(`PUT /v2/myorg/app/manifests/${digest}`);
    expect(puts[2]).to.equal("PUT /v2/myorg/app/manifests/1");
  });

  it("leaves the tag unset where attaching the attestation fails, so a second push completes it", async () => {
    server = await startRegistry({ referrers: true, failReferrers: 1 });
    const failed = await pushFromRun({ visibility: "public" }).then(
      () => undefined,
      (e: unknown) => e as Error
    );
    expect(failed?.message).to.match(/refused putting the manifest myorg\/app:sha256:/);
    expect(server.manifestsOf("myorg/app").has("1")).to.equal(false);
    const { status, digest } = await pushFromRun({ visibility: "public" });
    expect(status).to.equal("published");
    expect(server.manifestsOf("myorg/app").has("1")).to.equal(true);
    expect(attestationsIn("myorg/app").map(attestation => attestation.subject.digest)).to.deep.equal([digest]);
  });

  it("lists the attestation in the referrers tag index where the registry has no referrers API, keeping those listed", async () => {
    server = await startRegistry();
    const first = await pushFromRun({ visibility: "public", tag: "1" });
    const second = await pushFromRun({ visibility: "public", tag: "latest" });
    expect(second.digest).to.equal(first.digest);
    const index = JSON.parse(server.manifestsOf("myorg/app").get(first.digest.replace(":", "-"))!) as {
      mediaType: string;
      manifests: Array<{ digest: string; artifactType: string }>;
    };
    expect(index.mediaType).to.equal("application/vnd.oci.image.index.v1+json");
    expect(index.manifests).to.have.lengthOf(2);
    expect(index.manifests.every(entry => entry.artifactType === SIGSTORE_BUNDLE)).to.equal(true);
    expect(attestationsIn("myorg/app").map(attestation => attestation.subject.digest)).to.deep.equal([first.digest, first.digest]);
  });

  for (const [where, options] of [
    ["from a private repository", { visibility: "private" }],
    ["outside CI", {}],
    ["where the repository turns it off", { visibility: "public", provenance: false }],
  ] as const) {
    it(`pushes without provenance ${where}`, async () => {
      server = await startRegistry({ referrers: true });
      const { status, annotations } = await pushFromRun(options);
      expect(status).to.equal("published");
      expect(annotations).to.deep.equal([]);
      expect(attestationsIn("myorg/app")).to.deep.equal([]);
      expect(server.requests.filter(request => request.startsWith("POST /api/"))).to.deep.equal([]);
    });
  }

  it("pushes nothing where signing fails", async () => {
    server = await startRegistry({ referrers: true, rekorStatus: 503 });
    const err = await pushFromRun({ visibility: "public" }).then(
      () => undefined,
      (e: unknown) => e as Error
    );
    expect(err?.message).to.match(/^Rekor at .* failed \(503\)/);
    expect(server.requests.filter(request => request.startsWith("PUT /v2/") || request.startsWith("POST /v2/"))).to.deep.equal([]);
  });

  it("signs nothing where the tag already names the image", async () => {
    server = await startRegistry({ referrers: true });
    await pushFromRun({ visibility: "public" });
    server.requests.length = 0;
    expect((await pushFromRun({ visibility: "public" })).status).to.equal("already-synced");
    expect(server.requests.filter(request => request.startsWith("POST /api/"))).to.deep.equal([]);
  });
});
