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
import * as path from "path";
import { Transform } from "stream";
import { createGzip } from "zlib";
import {
  Computable,
  contentSize,
  contentStream,
  FabrError,
  getResultFileSet,
  IFile,
  MemoryFile,
  packageCoordinateOf,
  parseJson,
  PublishableFileSet,
  PublishMember,
  PublishStatus,
  TargetContext,
  toJsonObject,
} from "@fabr-build/core";
import { attachImageAttestation, IImageAttestation } from "./ImageAttestation";
import { ImageFileSet, ILayerRecord } from "./ImageFileSet";
import { blobPath, OCI_LAYOUT_DOCUMENT, OCI_LAYOUT_FILE, OCI_LAYOUT_INDEX, REF_NAME_ANNOTATION } from "./OciLayout";
import { digested, digestOf, IDescriptor, OCI_CONFIG, OCI_INDEX, OCI_MANIFEST, Registry, toManifestDocument } from "./OciProtocol";
import { authFileSignIn } from "./RegistrySignIn";

/** A layer as published: gzip-compressed. */
const OCI_LAYER_GZIP = "application/vnd.oci.image.layer.v1.tar+gzip";

/** Bumped when how a layer is compressed changes. */
const GZIP_TAG = "oci:gzip:1";

/** The carrier's file beside its layout: where each layer published before is had from, its digest, registry and repository. */
const CARRIER_SOURCES = "sources.json";

/** Where a layer published before can be had from, by its published digest, and the name its registry's login is stored under where it declares one. */
interface ILayerSource {
  readonly digest: string;
  readonly registry: string;
  readonly repository: string;
  readonly loginUrl?: string;
}

/**
 * Package a member for its registry, as the `PublishableFileSet` (the carrier)
 * `pushImage` pushes: an OCI image layout of the image as published, and
 * `sources.json` beside it, where each layer not in the layout is fetched
 * from. The layout's index names the manifest, with its platform and, as its
 * `org.opencontainers.image.ref.name`, `named` (`host/repository:tag`) and the
 * manifest's digest; its blobs are the manifest, the config and the
 * compressed layers built here.
 *
 * A layer fetched from a registry keeps the form it was published in, and is
 * fetched from there when pushed. A layer built here is gzip-compressed, the
 * same bytes for the same layer on any machine, cached by its `diff_id`.
 * Throws where the member's content is not an image.
 */
export function packageImage(context: TargetContext, member: PublishMember, named: string): Computable<PublishableFileSet> {
  const image = member.content;
  if (!(image instanceof ImageFileSet)) {
    throw new FabrError(`${member.destination.toString()} can only hold an image`).withHelp(
      "publish a container_image target, or an image from a registry"
    );
  }
  return Computable.forAll(
    image.layers.map(layer => publishedLayer(context, layer)),
    (...layers: Array<{ descriptor: IDescriptor; blob?: IFile; source?: ILayerSource }>) => {
      const config = digested(image.config.document);
      const manifest = digested({
        schemaVersion: 2,
        mediaType: OCI_MANIFEST,
        config: { mediaType: OCI_CONFIG, digest: config.digest, size: config.bytes.length },
        layers: layers.map(({ descriptor }) => descriptor),
      });
      const index = {
        schemaVersion: 2,
        mediaType: OCI_INDEX,
        manifests: [
          {
            mediaType: OCI_MANIFEST,
            digest: manifest.digest,
            size: manifest.bytes.length,
            platform: image.config.platform,
            annotations: { [REF_NAME_ANNOTATION]: `${named}@${manifest.digest}` },
          },
        ],
      };
      const files = new Map<string, IFile>([
        [OCI_LAYOUT_FILE, MemoryFile.from(OCI_LAYOUT_DOCUMENT)],
        [OCI_LAYOUT_INDEX, MemoryFile.from(JSON.stringify(index))],
        [blobPath(manifest.digest), new MemoryFile(manifest.bytes)],
        [blobPath(config.digest), new MemoryFile(config.bytes)],
        [CARRIER_SOURCES, MemoryFile.from(JSON.stringify(layers.flatMap(({ source }) => (source === undefined ? [] : [source]))))],
        ...layers.flatMap(({ descriptor, blob }): Array<[string, IFile]> =>
          blob === undefined ? [] : [[blobPath(descriptor.digest), blob]]
        ),
      ]);
      return new PublishableFileSet(files, member.destination);
    }
  );
}

/** Make a layer's published form: as it was published, where it was, else compressed here. */
function publishedLayer(
  context: TargetContext,
  layer: ILayerRecord
): Computable<{ descriptor: IDescriptor; blob?: IFile; source?: ILayerSource }> {
  const { published } = layer;
  if (published !== undefined) {
    return Computable.resolve({
      descriptor: { mediaType: published.mediaType, digest: published.digest, size: published.size },
      source: {
        digest: published.digest,
        registry: published.registry,
        repository: published.repository,
        ...(published.loginUrl === undefined ? {} : { loginUrl: published.loginUrl }),
      },
    });
  }
  return context
    .memoize(GZIP_TAG, layer.index.diffId, workDir =>
      compressLayer(layer.tar, path.join(workDir, "layer.tar.gz")).then(() => getResultFileSet(workDir, "layer.tar.gz"))
    )
    .then(files => {
      const blob = files.getFile("layer.tar.gz")!;
      return contentSize(blob).then(size => ({
        descriptor: { mediaType: OCI_LAYER_GZIP, digest: `sha256:${blob.hash}`, size },
        blob,
      }));
    });
}

/**
 * Gzip `tar` into `out` at a fixed level, with the header's OS byte fixed
 * (`unix`), so the bytes depend on the layer alone; node's gzip header carries
 * no time.
 */
function compressLayer(tar: IFile, out: string): Computable<void> {
  return contentStream(tar).then(source =>
    Computable.from<void>((resolve, reject) => {
      let seen = 0;
      const fixOs = new Transform({
        transform(chunk: Buffer, _encoding, done): void {
          if (seen <= 9 && seen + chunk.length > 9) {
            chunk = Buffer.from(chunk);
            chunk[9 - seen] = 3;
          }
          seen += chunk.length;
          done(null, chunk);
        },
      });
      const sink = fs.createWriteStream(out);
      source.on("error", reject);
      sink.on("error", reject);
      sink.on("finish", () => resolve());
      source
        .pipe(createGzip({ level: 6 }))
        .pipe(fixOs)
        .pipe(sink);
    })
  );
}

/**
 * Push a carrier `packageImage` made to `repository` on `registry`, under the
 * tag its destination names: each blob of the manifest its index names that
 * the repository lacks, then the manifest. A blob is mounted from the
 * repository it was published to where that is on the same registry, else
 * uploaded (a layer published on another registry is streamed from there).
 * Where the tag does not name the manifest yet, `sign` is asked for an
 * attestation of the manifest before anything is pushed. One it gives is
 * attached to the image before the tag is put: the manifest is put by its
 * digest first, so the tag names the image only once its attestation is in,
 * and a push that fails before then is not already synced when run again.
 * @return "already-synced" where the tag already names the manifest, else "published".
 */
export function pushImage(
  context: TargetContext,
  registry: Registry,
  carrier: PublishableFileSet,
  repository: string,
  sign: (manifest: IDescriptor) => Computable<IImageAttestation | undefined> = () => Computable.resolve(undefined)
): Computable<PublishStatus> {
  const tag = packageCoordinateOf(carrier.destination).version;
  return carrier
    .readFile(OCI_LAYOUT_INDEX)
    .then(indexText => {
      const indexed = parseJson(indexText, OCI_LAYOUT_INDEX, toIndexedManifest);
      const path = blobPath(indexed.digest);
      return Computable.forAll(
        [carrier.readFile(path), carrier.readFile(CARRIER_SOURCES)] as const,
        (manifestText: string, sourcesText: string) => ({
          indexed,
          manifestText,
          manifestImage: parseJson(manifestText, path, toImageManifest),
          sources: new Map(parseJson(sourcesText, CARRIER_SOURCES, toLayerSources).map(source => [source.digest, source])),
        })
      );
    })
    .then(({ indexed, manifestText, manifestImage, sources }) => {
      const manifest = Buffer.from(manifestText, "utf8");
      const subject: IDescriptor = { mediaType: OCI_MANIFEST, digest: digestOf(manifest), size: manifest.length };
      if (subject.digest !== indexed.digest) {
        throw new FabrError(`a carrier's index names ${indexed.digest}, but its manifest's digest is ${subject.digest}`);
      }
      return registry.taggedDigest(repository, tag).then(existing => {
        if (existing === subject.digest) {
          return Computable.resolve<PublishStatus>("already-synced");
        }
        return sign(subject).then(attestation => {
          const blobs = [...manifestImage.layers, manifestImage.config].map(blob =>
            pushBlob(context, registry, repository, blob, carrier.getFile(blobPath(blob.digest)), sources.get(blob.digest))
          );
          const attached = (): Computable<unknown> =>
            attestation === undefined
              ? Computable.resolve(undefined)
              : registry
                  .putManifest(repository, subject.digest, manifest, OCI_MANIFEST)
                  .then(() => attachImageAttestation(registry, repository, subject, attestation));
          return Computable.forAll(blobs, () => undefined)
            .then(attached)
            .then(() => registry.putManifest(repository, tag, manifest, OCI_MANIFEST))
            .then((): PublishStatus => "published");
        });
      });
    });
}

/** Push one blob `repository` lacks: mounted where it is on this registry, else uploaded from `file` or fetched from where it was published. */
function pushBlob(
  context: TargetContext,
  registry: Registry,
  repository: string,
  blob: IDescriptor,
  file: IFile | undefined,
  source?: ILayerSource
): Computable<void> {
  return registry.hasBlob(repository, blob.digest).then(held => {
    if (held) {
      return Computable.resolve(undefined);
    }
    const sameRegistry = source !== undefined && source.registry === registry.url;
    const upload = (): Computable<void> =>
      file !== undefined
        ? contentStream(file).then(stream => registry.uploadBlob(repository, blob.digest, blob.size, stream))
        : source !== undefined
          ? (sameRegistry
              ? registry
              : new Registry(context, source.registry, authFileSignIn(context, source.registry, source.loginUrl))
            )
              .blobStream(source.repository, blob.digest)
              .then(stream => registry.uploadBlob(repository, blob.digest, blob.size, stream))
          : Computable.reject<void>(new FabrError(`nothing holds the blob ${blob.digest} to push`));
    if (source !== undefined && sameRegistry) {
      return registry
        .mountBlob(repository, blob.digest, source.repository)
        .then(mounted => (mounted ? Computable.resolve(undefined) : upload()));
    }
    return upload();
  });
}

/** Read the descriptor of the one manifest a carrier's layout index names. */
function toIndexedManifest(json: unknown): IDescriptor {
  const index = toManifestDocument(json, OCI_INDEX);
  if (index.kind !== "index" || index.manifests.length !== 1) {
    throw new FabrError("a carrier's index does not name exactly one manifest");
  }
  return index.manifests[0];
}

/** Read a carrier's manifest: its config and layers. */
function toImageManifest(json: unknown): { config: IDescriptor; layers: readonly IDescriptor[] } {
  const manifest = toManifestDocument(json, OCI_MANIFEST);
  if (manifest.kind !== "manifest") {
    throw new FabrError("a carrier's manifest is an image index");
  }
  return manifest;
}

/** Read a carrier's record of where each layer published before is had from. */
function toLayerSources(json: unknown): ILayerSource[] {
  if (!Array.isArray(json)) {
    throw new FabrError("expected a list of layer sources");
  }
  return json.map(entry => {
    const { digest, registry, repository, loginUrl } = toJsonObject(entry);
    if (
      typeof digest !== "string" ||
      typeof registry !== "string" ||
      typeof repository !== "string" ||
      (loginUrl !== undefined && typeof loginUrl !== "string")
    ) {
      throw new FabrError("a layer source lacks its 'digest', 'registry' or 'repository'");
    }
    return { digest, registry, repository, ...(loginUrl === undefined ? {} : { loginUrl }) };
  });
}
