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
  FabrError,
  fetchDocument,
  FileSet,
  HASH_ALGORITHM,
  IFetchContext,
  IFile,
  isJsonObject,
  MemoryFile,
  parseJson,
  sendRequest,
  TargetContext,
  toError,
  toJsonObject,
  verifiedStream,
} from "@fabr-build/core";
import { isDigest } from "./ImageReference";
import { ILayerIndex, indexLayer } from "./LayerIndex";

/* The media types of the documents a registry serves for an image: OCI's and Docker's. */
export const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
export const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
export const DOCKER_MANIFEST_LIST = "application/vnd.docker.distribution.manifest.list.v2+json";
export const DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json";
/** What a manifest request accepts: an index or a manifest, OCI's or Docker's. */
export const MANIFEST_ACCEPT = [OCI_INDEX, OCI_MANIFEST, DOCKER_MANIFEST_LIST, DOCKER_MANIFEST].join(", ");

/** How a layer's bytes are compressed, by its media type. */
export type LayerCompression = "none" | "gzip" | "zstd";

const LAYER_COMPRESSION = new Map<string, LayerCompression>([
  ["application/vnd.oci.image.layer.v1.tar", "none"],
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
export type ManifestDocument = { readonly kind: "index"; readonly manifests: readonly IIndexEntry[] } | ({ readonly kind: "manifest" } & IImageManifest);

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
export const DIGEST_HEADER = "Docker-Content-Digest";

/** Bumped when what is kept under each key changes shape. */
const MANIFEST_TAG = "oci:manifest:1";
const CONFIG_TAG = "oci:config:1";
const LAYER_TAG = "oci:layer:1";

/** The names a stored layer's files are kept under in its cache entry. */
export const LAYER_TAR = "layer.tar";
export const LAYER_INDEX = "index.json";

/** A manifest as served: the document, and its digest (of the bytes as served). */
export interface IServedManifest {
  readonly document: ManifestDocument;
  readonly digest: string;
}

/** A layer as stored: its uncompressed tar (a file in the blob pool) and its index. */
export interface IStoredLayer {
  readonly tar: IFile;
  readonly index: ILayerIndex;
}

/**
 * A registry speaking the OCI distribution API, at `url`: manifests by tag or
 * digest, blobs by digest, each through the build cache. Requests carry a
 * bearer token where the registry asks for one (`WWW-Authenticate: Bearer`),
 * fetched anonymously.
 */
export class Registry {
  /** How requests to the registry are authenticated, found once per run. */
  private challenge?: Computable<IChallenge | undefined>;
  /** Each repository's pull token, fetched once per run. */
  private readonly tokens = new Map<string, Computable<Record<string, string>>>();

  constructor(
    private readonly context: TargetContext,
    public readonly url: string
  ) {}

  /** Fetch the manifest `version` (a tag or a digest) names in `repository`. A tag's is re-checked by its digest; a digest's is verified against it. */
  public manifest(repository: string, version: string): Computable<IServedManifest | undefined> {
    const url = `${this.url}/v2/${repository}/manifests/${version}`;
    const byDigest = isDigest(version);
    return fetchDocument(this.context, {
      url,
      file: "manifest.json",
      tag: MANIFEST_TAG,
      report: { resource: byDigest ? "image manifest" : `tag ${repository}:${version}`, role: "index" },
      convert: text => {
        const digest = `sha256:${createHash(HASH_ALGORITHM).update(text, "utf8").digest("hex")}`;
        if (byDigest && digest !== version) {
          throw new FabrError(`${url} served a manifest whose digest is ${digest}`);
        }
        return { document: parseJson(text, `manifest from ${url}`, json => toManifestDocument(json)), digest };
      },
      headers: () => this.headers(repository).then(headers => ({ ...headers, accept: MANIFEST_ACCEPT })),
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
        const digest = `sha256:${createHash(HASH_ALGORITHM).update(text, "utf8").digest("hex")}`;
        if (digest !== descriptor.digest) {
          throw new FabrError(`${url} served a config whose digest is ${digest}`);
        }
        return parseJson(text, `image config from ${url}`, toImageConfig);
      },
      headers: () => this.headers(repository),
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
          this.headers(repository).then(headers => ({
            url,
            headers,
            process: (content: Readable, { createOutput }: IFetchContext) => storeLayer(content, descriptor, diffId, url, createOutput),
          })),
        { resource: "image layer", role: "content" }
      )
      .then(files =>
        files.readFile(LAYER_INDEX).then(text => ({ tar: files.getFile(LAYER_TAR)!, index: parseJson(text, `index of layer ${descriptor.digest}`, toLayerIndex) }))
      );
  }

  /** Make the headers a request for `repository` carries: a bearer token where the registry asks for one. */
  private headers(repository: string): Computable<Record<string, string>> {
    let token = this.tokens.get(repository);
    if (token === undefined) {
      token = this.getChallenge().then(challenge => (challenge === undefined ? {} : this.pullToken(challenge, repository)));
      this.tokens.set(repository, token);
    }
    return token;
  }

  /** Find how the registry authenticates, from its answer to `GET /v2/`. */
  private getChallenge(): Computable<IChallenge | undefined> {
    this.challenge ??= sendRequest(`${this.url}/v2/`, { method: "GET" }).then(response => {
      if (response.statusCode !== 401) {
        return undefined;
      }
      const header = response.headers["www-authenticate"];
      const challenge = parseChallenge(Array.isArray(header) ? header[0] : header);
      if (challenge === undefined) {
        throw new FabrError(`${this.url} asks for authentication fabr cannot give (${String(header)})`);
      }
      return challenge;
    });
    return this.challenge;
  }

  private pullToken(challenge: IChallenge, repository: string): Computable<Record<string, string>> {
    const query = new URLSearchParams({ ...(challenge.service === undefined ? {} : { service: challenge.service }), scope: `repository:${repository}:pull` });
    const url = `${challenge.realm}?${query.toString()}`;
    return sendRequest(url, { method: "GET" }).then(response => {
      if (response.statusCode !== 200) {
        throw new FabrError(`${challenge.realm} refused a token to pull ${repository} (${response.statusCode})`);
      }
      const answer = parseJson(response.body, `token from ${challenge.realm}`, toToken);
      return { authorization: `Bearer ${answer}` };
    });
  }
}

/** A registry's `Bearer` challenge. */
interface IChallenge {
  readonly realm: string;
  readonly service?: string;
}

/** Read a `WWW-Authenticate: Bearer realm="…",service="…"` challenge; undefined for any other scheme. */
export function parseChallenge(header: string | undefined): IChallenge | undefined {
  const match = /^\s*Bearer\s+(.*)$/i.exec(header ?? "");
  if (match === null) {
    return undefined;
  }
  const params = new Map<string, string>();
  for (const param of match[1].matchAll(/([a-zA-Z_]+)\s*=\s*(?:"([^"]*)"|([^,\s]*))/g)) {
    params.set(param[1].toLowerCase(), param[2] ?? param[3]);
  }
  const realm = params.get("realm");
  return realm === undefined ? undefined : { realm, ...(params.has("service") ? { service: params.get("service") } : {}) };
}

function toToken(json: unknown): string {
  const doc = json as Record<string, unknown>;
  const token = typeof doc?.token === "string" ? doc.token : doc?.access_token;
  if (typeof token !== "string" || token === "") {
    throw new FabrError("the answer holds no token");
  }
  return token;
}

function toLayerIndex(json: unknown): ILayerIndex {
  const doc = json as ILayerIndex;
  if (typeof doc?.diffId !== "string" || !Array.isArray(doc.entries)) {
    throw new FabrError("a stored layer index is malformed");
  }
  return doc;
}

/** Decompress a layer as it streams in, store its tar, index it, and check both digests. */
function storeLayer(
  content: Readable,
  descriptor: ILayerDescriptor,
  diffId: string,
  url: string,
  createOutput: IFetchContext["createOutput"]
): Computable<FileSet> {
  const { stream, verify } = verifiedStream(content, { algorithm: "sha256", encoding: "hex", value: descriptor.digest.substring("sha256:".length) }, url);
  const decompressed: Transform | Readable =
    descriptor.compression === "gzip" ? stream.pipe(createGunzip()) : descriptor.compression === "zstd" ? stream.pipe(createZstdDecompress()) : stream;
  stream.on("error", err => decompressed.destroy(toError(err)));
  const output = createOutput();
  const indexer = indexLayer();
  return Computable.fromOnce<void>((resolve, reject) => {
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
        return output.finalize(LAYER_TAR).then(tar => new FileSet(new Map<string, IFile>([[LAYER_TAR, tar], [LAYER_INDEX, MemoryFile.from(JSON.stringify(index))]])));
      } catch (err) {
        return output.discard().then(() => Computable.reject<FileSet>(toError(err)));
      }
    },
    (err: Error) => output.discard().then(() => Computable.reject<FileSet>(err))
  );
}
