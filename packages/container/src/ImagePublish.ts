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
import { contentOf, ImageFileSet, ILayerRecord, sizeOf } from "./ImageFileSet";
import { digested, digestOf, IDescriptor, OCI_CONFIG, OCI_MANIFEST, Registry } from "./OciProtocol";
import { authFileSignIn } from "./RegistrySignIn";

/** A layer as published: gzip-compressed. */
const OCI_LAYER_GZIP = "application/vnd.oci.image.layer.v1.tar+gzip";

/** Bumped when how a layer is compressed changes. */
const GZIP_TAG = "oci:gzip:1";

/* The names of a carrier's files. */
const CARRIER_MANIFEST = "manifest.json";
const CARRIER_CONFIG = "config.json";
/** Where each layer published before is had from: its digest, registry and repository. */
const CARRIER_SOURCES = "sources.json";
const CARRIER_BLOBS = "blobs";

/** Where a layer published before can be had from, by its published digest. */
interface ILayerSource {
  readonly digest: string;
  readonly registry: string;
  readonly repository: string;
}

/**
 * Package a member for its registry: its image's manifest, layers compressed,
 * and its config. A layer fetched from a registry keeps the form it was
 * published in, and is had from there when pushed; a layer built here is
 * gzip-compressed, the same bytes for the same layer anywhere, cached by its
 * `diff_id`. The carrier holds the manifest, the config, the compressed layers
 * built here, and where the others are had from.
 */
export function packageImage(context: TargetContext, member: PublishMember): Computable<PublishableFileSet> {
  const image = member.content;
  if (!(image instanceof ImageFileSet)) {
    throw new FabrError(`${member.destination.toString()} can only hold an image`).withHelp("publish a container_image target, or an image from a registry");
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
      const files = new Map<string, IFile>([
        [CARRIER_MANIFEST, new MemoryFile(manifest.bytes)],
        [CARRIER_CONFIG, new MemoryFile(config.bytes)],
        [CARRIER_SOURCES, MemoryFile.from(JSON.stringify(layers.flatMap(({ source }) => (source === undefined ? [] : [source]))))],
        ...layers.flatMap(({ descriptor, blob }): Array<[string, IFile]> => (blob === undefined ? [] : [[blobName(descriptor.digest), blob]])),
      ]);
      return new PublishableFileSet(files, member.destination);
    }
  );
}

/** Make a layer's published form: as it was published, where it was, else compressed here. */
function publishedLayer(context: TargetContext, layer: ILayerRecord): Computable<{ descriptor: IDescriptor; blob?: IFile; source?: ILayerSource }> {
  const { published } = layer;
  if (published !== undefined) {
    return Computable.resolve({
      descriptor: { mediaType: published.mediaType, digest: published.digest, size: published.size },
      source: { digest: published.digest, registry: published.registry, repository: published.repository },
    });
  }
  return context
    .memoize(GZIP_TAG, layer.index.diffId, workDir => compressLayer(layer.tar, path.join(workDir, "layer.tar.gz")).then(() => getResultFileSet(workDir, "layer.tar.gz")))
    .then(files => {
      const blob = files.getFile("layer.tar.gz")!;
      return sizeOf(blob).then(size => ({ descriptor: { mediaType: OCI_LAYER_GZIP, digest: `sha256:${blob.hash}`, size }, blob }));
    });
}

/**
 * Gzip `tar` into `out` at a fixed level, the header's OS byte fixed (`unix`),
 * so the bytes depend on the layer alone and not on the machine; its time is
 * already none.
 */
function compressLayer(tar: IFile, out: string): Computable<void> {
  return contentOf(tar).then(
    source =>
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
        source.pipe(createGzip({ level: 6 })).pipe(fixOs).pipe(sink);
      })
  );
}

/**
 * Push a carrier `packageImage` made to `registry`, under the repository and
 * tag its destination names: each blob the repository lacks mounted from the
 * repository it was published to where that is on the same registry, else
 * uploaded (a layer published elsewhere had from there), then the manifest.
 * Already synced where the tag names that manifest.
 */
export function pushImage(context: TargetContext, registry: Registry, carrier: PublishableFileSet, repository: string): Computable<PublishStatus> {
  const tag = packageCoordinateOf(carrier.destination).version;
  return Computable.forAll(
    [carrier.readFile(CARRIER_MANIFEST), carrier.readFile(CARRIER_CONFIG), carrier.readFile(CARRIER_SOURCES)] as const,
    (manifestText: string, configText: string, sourcesText: string) => {
      const manifest = Buffer.from(manifestText, "utf8");
      const layers = (toJsonObject(JSON.parse(manifestText)).layers as IDescriptor[]) ?? [];
      const sources = new Map(parseJson(sourcesText, CARRIER_SOURCES, json => json as ILayerSource[]).map(source => [source.digest, source]));
      return registry.taggedDigest(repository, tag).then(existing => {
        if (existing === digestOf(manifest)) {
          return Computable.resolve<PublishStatus>("already-synced");
        }
        const config = Buffer.from(configText, "utf8");
        const blobs = [
          ...layers.map(layer => pushBlob(context, registry, repository, layer, carrier.getFile(blobName(layer.digest)), sources.get(layer.digest))),
          pushBlob(context, registry, repository, { mediaType: OCI_CONFIG, digest: digestOf(config), size: config.length }, new MemoryFile(config)),
        ];
        return Computable.forAll(blobs, () => undefined)
          .then(() => registry.putManifest(repository, tag, manifest, OCI_MANIFEST))
          .then((): PublishStatus => "published");
      });
    }
  );
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
    const upload = (): Computable<void> =>
      file !== undefined
        ? contentOf(file).then(stream => registry.uploadBlob(repository, blob.digest, blob.size, () => stream))
        : source !== undefined
        ? new Registry(context, source.registry, authFileSignIn(context, source.registry))
            .blobStream(source.repository, blob.digest)
            .then(stream => registry.uploadBlob(repository, blob.digest, blob.size, () => stream))
        : Computable.reject<void>(new FabrError(`nothing holds the blob ${blob.digest} to push`));
    if (source !== undefined && source.registry === registry.url) {
      return registry.mountBlob(repository, blob.digest, source.repository).then(mounted => (mounted ? Computable.resolve(undefined) : upload()));
    }
    return upload();
  });
}

function blobName(digest: string): string {
  return `${CARRIER_BLOBS}/${digest.substring("sha256:".length)}`;
}

