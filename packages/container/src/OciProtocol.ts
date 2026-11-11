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
import { Readable, Transform } from "stream";
import { createGunzip, createZstdDecompress } from "zlib";
import {
  Computable,
  Credential,
  FabrError,
  fetchDocument,
  FileSet,
  HASH_ALGORITHM,
  HttpRequest,
  HttpResponse,
  IFetchContext,
  IFile,
  isJsonObject,
  MemoryFile,
  openUrlStream,
  parseJson,
  sendRequest,
  TargetContext,
  toError,
  toJsonObject,
  verifiedStream,
} from "@fabr-build/core";
import { isDigest } from "./ImageReference";
import { ILayerEntry, ILayerIndex, indexLayer, LayerEntryType } from "./LayerIndex";

/* The media types of the documents a registry serves for an image: OCI's and Docker's. */
export const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
export const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
export const DOCKER_MANIFEST_LIST = "application/vnd.docker.distribution.manifest.list.v2+json";
export const DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json";
export const OCI_CONFIG = "application/vnd.oci.image.config.v1+json";
/** An uncompressed layer, as fabr writes one. */
export const OCI_LAYER = "application/vnd.oci.image.layer.v1.tar";
/** What a manifest request accepts: an index or a manifest, OCI's or Docker's. */
const MANIFEST_ACCEPT = [OCI_INDEX, OCI_MANIFEST, DOCKER_MANIFEST_LIST, DOCKER_MANIFEST].join(", ");

/** How a layer's bytes are compressed, by its media type. */
export type LayerCompression = "none" | "gzip" | "zstd";

const LAYER_COMPRESSION = new Map<string, LayerCompression>([
  [OCI_LAYER, "none"],
  ["application/vnd.oci.image.layer.v1.tar+gzip", "gzip"],
  ["application/vnd.oci.image.layer.v1.tar+zstd", "zstd"],
  ["application/vnd.docker.image.rootfs.diff.tar.gzip", "gzip"],
]);

/** A content descriptor: what a document names by digest. */
export interface IDescriptor {
  readonly mediaType: string;
  readonly digest: string;
  readonly size: number;
}

/** A platform as OCI writes one. */
export interface IOciPlatform {
  readonly os: string;
  readonly architecture: string;
  readonly variant?: string;
}

/** An index entry: a manifest and the platform it is for, where it says. */
export interface IIndexEntry extends IDescriptor {
  readonly platform?: IOciPlatform;
}

/** An image manifest: the image's config and its layers, in order. */
export interface IImageManifest {
  readonly config: IDescriptor;
  readonly layers: readonly ILayerDescriptor[];
}

export interface ILayerDescriptor extends IDescriptor {
  readonly compression: LayerCompression;
}

/** A manifest document, read: an index over platforms, or an image's manifest. */
export type ManifestDocument =
  { readonly kind: "index"; readonly manifests: readonly IIndexEntry[] } | ({ readonly kind: "manifest" } & IImageManifest);

/** An image's config: its platform, the layers' uncompressed digests, and the run-time settings, kept as written. */
export interface IImageConfig {
  readonly platform: IOciPlatform;
  /** Each layer's uncompressed digest, in order (`rootfs.diff_ids`). */
  readonly diffIds: readonly string[];
  /** The whole document as it was served, which an image built on this one starts from. */
  readonly document: Record<string, unknown>;
}

/** Read a manifest document served as `mediaType` (the response's own, or the document's `mediaType`). */
export function toManifestDocument(json: unknown, mediaType?: string): ManifestDocument {
  const doc = toJsonObject(json);
  const type = typeof doc.mediaType === "string" ? doc.mediaType : mediaType;
  if (type === OCI_INDEX || type === DOCKER_MANIFEST_LIST || (type === undefined && Array.isArray(doc.manifests))) {
    if (!Array.isArray(doc.manifests)) {
      throw new FabrError("an image index has no 'manifests'");
    }
    return { kind: "index", manifests: doc.manifests.map(toIndexEntry) };
  }
  if (type === OCI_MANIFEST || type === DOCKER_MANIFEST || (type === undefined && Array.isArray(doc.layers))) {
    if (!Array.isArray(doc.layers)) {
      throw new FabrError("an image manifest has no 'layers'");
    }
    return { kind: "manifest", config: toDescriptor(doc.config), layers: doc.layers.map(toLayerDescriptor) };
  }
  throw new FabrError(`'${type ?? "(none)"}' is not an image index or manifest`);
}

/** Read an image's config. */
export function toImageConfig(json: unknown): IImageConfig {
  const doc = toJsonObject(json);
  const rootfs = toJsonObject(doc.rootfs);
  if (!Array.isArray(rootfs.diff_ids) || !rootfs.diff_ids.every(id => typeof id === "string" && isDigest(id))) {
    throw new FabrError("an image config's 'rootfs.diff_ids' is not a list of sha256 digests");
  }
  return { platform: toPlatform(doc), diffIds: rootfs.diff_ids as string[], document: doc };
}

function toIndexEntry(json: unknown): IIndexEntry {
  const doc = toJsonObject(json);
  return { ...toDescriptor(doc), ...(isJsonObject(doc.platform) ? { platform: toPlatform(doc.platform) } : {}) };
}

function toLayerDescriptor(json: unknown): ILayerDescriptor {
  const descriptor = toDescriptor(json);
  const compression = LAYER_COMPRESSION.get(descriptor.mediaType);
  if (compression === undefined) {
    throw new FabrError(`a layer of media type '${descriptor.mediaType}' cannot be read`);
  }
  return { ...descriptor, compression };
}

function toDescriptor(json: unknown): IDescriptor {
  const doc = toJsonObject(json);
  if (typeof doc.mediaType !== "string" || typeof doc.digest !== "string" || typeof doc.size !== "number") {
    throw new FabrError("a descriptor lacks its 'mediaType', 'digest' or 'size'");
  }
  if (!isDigest(doc.digest)) {
    throw new FabrError(`'${doc.digest}' is not a sha256 digest`);
  }
  return { mediaType: doc.mediaType, digest: doc.digest, size: doc.size };
}

function toPlatform(json: unknown): IOciPlatform {
  const doc = toJsonObject(json);
  if (typeof doc.os !== "string" || typeof doc.architecture !== "string") {
    throw new FabrError("a platform lacks its 'os' or 'architecture'");
  }
  return { os: doc.os, architecture: doc.architecture, ...(typeof doc.variant === "string" ? { variant: doc.variant } : {}) };
}

/** Render a platform as OCI tools write it: `linux/arm64`, `linux/arm/v7`. */
export function platformText(platform: IOciPlatform): string {
  return [platform.os, platform.architecture, ...(platform.variant === undefined ? [] : [platform.variant])].join("/");
}

/** @return true if an image for `found` runs on `wanted`, otherwise false: an arm64 image states no variant or `v8`. */
export function platformMatches(found: IOciPlatform, wanted: IOciPlatform): boolean {
  if (found.os !== wanted.os || found.architecture !== wanted.architecture) {
    return false;
  }
  const variant = found.variant ?? (found.architecture === "arm64" ? "v8" : undefined);
  return variant === (wanted.variant ?? (wanted.architecture === "arm64" ? "v8" : undefined));
}

/**
 * Choose the manifest for `wanted` among an index's entries, or undefined
 * where none is for it. An entry that states no platform, or one that is no
 * image (BuildKit's attestations, `unknown/unknown`), is passed over.
 */
export function selectManifest(entries: readonly IIndexEntry[], wanted: IOciPlatform): IIndexEntry | undefined {
  return imageEntries(entries).find(entry => platformMatches(entry.platform!, wanted));
}

/** @return the platforms an index has images for, as OCI tools write them. */
export function indexPlatforms(entries: readonly IIndexEntry[]): string[] {
  return [...new Set(imageEntries(entries).map(entry => platformText(entry.platform!)))];
}

function imageEntries(entries: readonly IIndexEntry[]): IIndexEntry[] {
  return entries.filter(entry => entry.platform !== undefined && entry.platform.os !== "unknown");
}

/** The header in which a registry states a manifest's digest. */
const DIGEST_HEADER = "Docker-Content-Digest";

/** Bumped when what is kept under each key changes shape. */
const MANIFEST_TAG = "oci:manifest:1";
const CONFIG_TAG = "oci:config:1";
const LAYER_TAG = "oci:layer:1";

/** The names a stored layer's files are kept under in its cache entry. */
const LAYER_TAR = "layer.tar";
const LAYER_INDEX = "index.json";

/** A document as its bytes are, read or written, and their digest: what names it. */
export interface IDigested<T> {
  readonly document: T;
  readonly bytes: Buffer;
  readonly digest: string;
}

/** @return the digest of `bytes`, as OCI writes one: `sha256:<hex>`. */
export function digestOf(bytes: Buffer): string {
  return `sha256:${createHash(HASH_ALGORITHM).update(bytes).digest("hex")}`;
}

/** Make `document`, written as JSON, digested. */
export function digested<T>(document: T): IDigested<T> {
  const bytes = Buffer.from(JSON.stringify(document), "utf8");
  return { document, bytes, digest: digestOf(bytes) };
}

/** @return `served` where it is an image's manifest, otherwise undefined (an index). */
export function imageManifestOf(served: IDigested<ManifestDocument>): IDigested<IImageManifest> | undefined {
  const { document } = served;
  return document.kind === "manifest" ? { ...served, document } : undefined;
}

/** A layer as stored: its uncompressed tar (a file in the blob pool) and its index. */
interface IStoredLayer {
  readonly tar: IFile;
  readonly index: ILayerIndex;
  readonly indexFile: IFile;
}

/**
 * A registry speaking the OCI distribution API, at `url`: manifests by tag or
 * digest, blobs by digest, each read through the build cache, and pushed.
 * Every request is signed in by `credential`, which core's HTTP layer asks
 * again where the registry answers 401 (see RegistrySignIn).
 */
export class Registry {
  constructor(
    private readonly context: TargetContext,
    public readonly url: string,
    private readonly credential: Credential
  ) {}

  /** Fetch the manifest `version` (a tag or a digest) names in `repository`. A tag's is re-checked by its digest; a digest's is verified against it. */
  public manifest(repository: string, version: string): Computable<IDigested<ManifestDocument> | undefined> {
    const url = `${this.url}/v2/${repository}/manifests/${version}`;
    const byDigest = isDigest(version);
    return fetchDocument(this.context, {
      url,
      file: "manifest.json",
      tag: MANIFEST_TAG,
      report: { resource: byDigest ? "image manifest" : `tag ${repository}:${version}`, role: "index" },
      convert: text => {
        const bytes = Buffer.from(text, "utf8");
        const digest = digestOf(bytes);
        if (byDigest && digest !== version) {
          throw new FabrError(`${url} served a manifest whose digest is ${digest}`);
        }
        return { document: parseJson(text, `manifest from ${url}`, json => toManifestDocument(json)), bytes, digest };
      },
      headers: () => Computable.resolve({ accept: MANIFEST_ACCEPT }),
      credential: this.credential,
      options: byDigest ? undefined : { immutable: false, digestHeader: DIGEST_HEADER },
    });
  }

  /** Fetch an image's config by its descriptor, verified against its digest. */
  public config(repository: string, descriptor: IDescriptor): Computable<IImageConfig> {
    const url = `${this.url}/v2/${repository}/blobs/${descriptor.digest}`;
    return fetchDocument(this.context, {
      url,
      key: `${this.url} ${descriptor.digest}`,
      file: "config.json",
      tag: CONFIG_TAG,
      report: { resource: "image config", role: "index" },
      convert: text => {
        const digest = digestOf(Buffer.from(text, "utf8"));
        if (digest !== descriptor.digest) {
          throw new FabrError(`${url} served a config whose digest is ${digest}`);
        }
        return parseJson(text, `image config from ${url}`, toImageConfig);
      },
      credential: this.credential,
    }).then(config => {
      if (config === undefined) {
        throw new FabrError(`${this.url} has no config ${descriptor.digest} for ${repository}`);
      }
      return config;
    });
  }

  /**
   * Fetch a layer by its descriptor and store it decompressed, beside its
   * index: checked against its digest as it streams, and its uncompressed tar
   * against `diffId`, so a layer that does not match is never kept.
   */
  public layer(repository: string, descriptor: ILayerDescriptor, diffId: string): Computable<IStoredLayer> {
    const url = `${this.url}/v2/${repository}/blobs/${descriptor.digest}`;
    return this.context
      .fetch(
        `${this.url} ${descriptor.digest}`,
        LAYER_TAG,
        () =>
          Computable.resolve({
            url,
            credential: this.credential,
            process: (content: Readable, { createOutput }: IFetchContext) =>
              storeLayer(content, descriptor, diffId, url, createOutput),
          }),
        { resource: "image layer", role: "content" }
      )
      .then(files =>
        files.readFile(LAYER_INDEX).then(text => ({
          tar: files.getFile(LAYER_TAR)!,
          index: parseJson(text, `index of layer ${descriptor.digest}`, toLayerIndex),
          indexFile: files.getFile(LAYER_INDEX)!,
        }))
      );
  }

  /**
   * List the tags of `repository`, page by page as the registry's `Link`
   * header leads; undefined where the registry has no such repository.
   */
  public tags(repository: string): Computable<string[] | undefined> {
    const page = (path: string, listed: string[]): Computable<string[] | undefined> =>
      this.send(path, { method: "GET" }).then(response => {
        if (response.statusCode === 404) {
          return undefined;
        }
        this.expect(response, [200], `listing the tags of ${repository}`);
        const tags = parseJson(response.body, `tags of ${repository} from ${this.url}`, toTags);
        const next = nextPage(response.headers.link);
        return next === undefined ? [...listed, ...tags] : page(new URL(next, this.url).toString(), [...listed, ...tags]);
      });
    return page(`/v2/${repository}/tags/list`, []);
  }

  /** Open a stream of the blob `digest` in `repository`, as published, to push it to another registry. */
  public blobStream(repository: string, digest: string): Computable<Readable> {
    return openUrlStream(`${this.url}/v2/${repository}/blobs/${digest}`, {}, Date.now, "content", undefined, this.credential).then(
      response => response.stream!
    );
  }

  /** @return the digest `tag` names in `repository`, or undefined where it names nothing. */
  public taggedDigest(repository: string, tag: string): Computable<string | undefined> {
    return this.send(`/v2/${repository}/manifests/${tag}`, { method: "HEAD", headers: { accept: MANIFEST_ACCEPT } }).then(response => {
      if (response.statusCode === 404) {
        return undefined;
      }
      this.expect(response, [200], `reading the tag ${repository}:${tag}`);
      const digest = response.headers[DIGEST_HEADER.toLowerCase()];
      return typeof digest === "string" ? digest : undefined;
    });
  }

  /** @return true if `repository` holds the blob `digest`, otherwise false. */
  public hasBlob(repository: string, digest: string): Computable<boolean> {
    return this.send(`/v2/${repository}/blobs/${digest}`, { method: "HEAD" }).then(response => {
      if (response.statusCode === 404) {
        return false;
      }
      this.expect(response, [200], `reading the blob ${digest} of ${repository}`);
      return true;
    });
  }

  /** Mount the blob `digest` of `from`, on this registry, into `repository`: true where mounted, false where the registry declined. */
  public mountBlob(repository: string, digest: string, from: string): Computable<boolean> {
    const query = new URLSearchParams({ mount: digest, from });
    return this.send(`/v2/${repository}/blobs/uploads/?${query.toString()}`, {
      method: "POST",
      headers: { "content-length": "0" },
    }).then(response => {
      this.expect(response, [201, 202], `mounting the blob ${digest} into ${repository}`);
      return response.statusCode === 201;
    });
  }

  /** Upload the blob `digest`, `size` bytes, into `repository`, in one request. */
  public uploadBlob(repository: string, digest: string, size: number, body: Readable | Buffer): Computable<void> {
    return this.send(`/v2/${repository}/blobs/uploads/`, { method: "POST", headers: { "content-length": "0" } }).then(started => {
      this.expect(started, [202], `starting an upload to ${repository}`);
      const location = started.headers.location;
      if (typeof location !== "string") {
        throw new FabrError(`${this.url} started an upload to ${repository} without saying where`);
      }
      const url = new URL(location, this.url);
      url.searchParams.set("digest", digest);
      return this.send(url.toString(), {
        method: "PUT",
        headers: { "content-type": "application/octet-stream", "content-length": String(size) },
        body,
      }).then(response => this.expect(response, [201], `uploading the blob ${digest} to ${repository}`));
    });
  }

  /** Put `manifest` into `repository` under `tag`. */
  public putManifest(repository: string, tag: string, manifest: Buffer, mediaType: string): Computable<void> {
    return this.send(`/v2/${repository}/manifests/${tag}`, {
      method: "PUT",
      headers: { "content-type": mediaType },
      body: manifest,
    }).then(response => this.expect(response, [201], `putting the manifest ${repository}:${tag}`));
  }

  /** Send a request to `path` (or a whole URL) on the registry, signed in. */
  private send(path: string, request: HttpRequest): Computable<HttpResponse> {
    const url = path.startsWith("/") ? `${this.url}${path}` : path;
    return sendRequest(url, { ...request, credential: this.credential });
  }

  /** Throw, with what the registry said, where `response`'s status is not among `statuses`. */
  private expect(response: HttpResponse, statuses: readonly number[], doing: string): void {
    if (!statuses.includes(response.statusCode)) {
      const said = response.body.toString("utf8").trim();
      throw new FabrError(`${this.url} refused ${doing} (${response.statusCode}${said === "" ? "" : `: ${said.substring(0, 300)}`})`);
    }
  }
}

/** Read a tag list's `tags` (null where a repository has none). */
function toTags(json: unknown): string[] {
  const tags = toJsonObject(json).tags;
  if (tags === null || tags === undefined) {
    return [];
  }
  if (!Array.isArray(tags) || !tags.every(tag => typeof tag === "string")) {
    throw new FabrError("its 'tags' is not a list of names");
  }
  return tags as string[];
}

/** @return where a `Link` header's `rel="next"` page is (`</v2/…/tags/list?last=x&n=100>; rel="next"`), or undefined where it names none. */
export function nextPage(link: string | string[] | undefined): string | undefined {
  const text = Array.isArray(link) ? link.join(", ") : (link ?? "");
  return /<([^>]+)>\s*;\s*rel="?next"?/.exec(text)?.[1];
}

/** Read a layer's index as fabr stores it. */
export function toLayerIndex(json: unknown): ILayerIndex {
  const doc = toJsonObject(json);
  if (typeof doc.diffId !== "string" || !Array.isArray(doc.entries)) {
    throw new FabrError("a stored layer index is malformed");
  }
  return { diffId: doc.diffId, entries: doc.entries.map(toLayerEntry) };
}

const LAYER_ENTRY_TYPES: ReadonlySet<string> = new Set<LayerEntryType>(["file", "directory", "symlink", "hardlink", "other"]);

/** Read one entry of a stored layer index. */
function toLayerEntry(json: unknown): ILayerEntry {
  const { path, type, mode, uid, gid, linkname, offset, size, hash, mime } = toJsonObject(json);
  const optional = (value: unknown, kind: "string" | "number"): boolean => value === undefined || typeof value === kind;
  if (
    typeof path !== "string" ||
    typeof type !== "string" ||
    !LAYER_ENTRY_TYPES.has(type) ||
    typeof mode !== "number" ||
    typeof uid !== "number" ||
    typeof gid !== "number" ||
    !optional(linkname, "string") ||
    !optional(offset, "number") ||
    !optional(size, "number") ||
    !optional(hash, "string") ||
    !optional(mime, "string")
  ) {
    throw new FabrError("a stored layer index has a malformed entry");
  }
  if (
    type === "file" &&
    (typeof offset !== "number" || typeof size !== "number" || typeof hash !== "string" || typeof mime !== "string")
  ) {
    throw new FabrError(`a stored layer index's file '${path}' lacks its range, hash or mime`);
  }
  return {
    path,
    type: type as LayerEntryType,
    mode,
    uid,
    gid,
    ...(linkname === undefined ? {} : { linkname: linkname as string }),
    ...(offset === undefined ? {} : { offset: offset as number }),
    ...(size === undefined ? {} : { size: size as number }),
    ...(hash === undefined ? {} : { hash: hash as string }),
    ...(mime === undefined ? {} : { mime: mime as string }),
  };
}

/** Decompress a layer as it streams in, store its tar, index it, and check both digests. */
function storeLayer(
  content: Readable,
  descriptor: ILayerDescriptor,
  diffId: string,
  url: string,
  createOutput: IFetchContext["createOutput"]
): Computable<FileSet> {
  const { stream, verify } = verifiedStream(
    content,
    { algorithm: "sha256", encoding: "hex", value: descriptor.digest.substring("sha256:".length) },
    url
  );
  const decompressed: Transform | Readable =
    descriptor.compression === "gzip"
      ? stream.pipe(createGunzip())
      : descriptor.compression === "zstd"
        ? stream.pipe(createZstdDecompress())
        : stream;
  stream.on("error", err => decompressed.destroy(toError(err)));
  const output = createOutput();
  const indexer = indexLayer();
  return Computable.from<void>((resolve, reject) => {
    let open = 2;
    const done = (): void => {
      if (--open === 0) {
        resolve();
      }
    };
    decompressed.on("error", reject);
    output.stream.on("error", reject);
    indexer.sink.on("error", reject);
    indexer.sink.on("finish", done);
    decompressed.on("end", done);
    decompressed.pipe(output.stream, { end: false });
    decompressed.pipe(indexer.sink);
  }).then(
    () => {
      try {
        verify();
        const index = indexer.result();
        if (index.diffId !== diffId) {
          throw new FabrError(`${url} decompresses to ${index.diffId}, not the image's ${diffId}`);
        }
        return output.finalize(LAYER_TAR).then(
          tar =>
            new FileSet(
              new Map<string, IFile>([
                [LAYER_TAR, tar],
                [LAYER_INDEX, MemoryFile.from(JSON.stringify(index))],
              ])
            )
        );
      } catch (err) {
        return output.discard().then(() => Computable.reject<FileSet>(toError(err)));
      }
    },
    (err: Error) => output.discard().then(() => Computable.reject<FileSet>(err))
  );
}
