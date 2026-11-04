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
import { Computable, FileSet, IFile, MemoryFile } from "@fabr-build/core";
import { ImageFileSet } from "./ImageFileSet";
import { digested, IDigested, OCI_CONFIG, OCI_INDEX, OCI_LAYER, OCI_MANIFEST } from "./OciProtocol";

/**
 * Make the OCI image layout of `image`, tagged `name` (`myorg/app:1.4`):
 * `oci-layout`, `index.json`, the blobs under `blobs/sha256/`, and Docker's
 * `manifest.json` beside them, which Docker's classic image store loads an
 * archive by. Its layers are uncompressed, each named by its `diff_id`.
 */
export function imageLayout(image: ImageFileSet, name: string): Computable<FileSet> {
  return manifestOf(image).then(({ manifest, config }) => {
    const files = new Map<string, IFile>([
      ["oci-layout", MemoryFile.from(JSON.stringify({ imageLayoutVersion: "1.0.0" }))],
      [blobPath(config.digest), new MemoryFile(config.bytes)],
      [blobPath(manifest.digest), new MemoryFile(manifest.bytes)],
    ]);
    image.layers.forEach(layer => files.set(blobPath(layer.index.diffId), layer.tar));
    const tag = name.substring(name.lastIndexOf(":") + 1);
    files.set(
      "index.json",
      MemoryFile.from(
        JSON.stringify({
          schemaVersion: 2,
          mediaType: OCI_INDEX,
          manifests: [
            {
              mediaType: OCI_MANIFEST,
              digest: manifest.digest,
              size: manifest.bytes.length,
              annotations: { "io.containerd.image.name": name, "org.opencontainers.image.ref.name": tag },
            },
          ],
        })
      )
    );
    files.set(
      "manifest.json",
      MemoryFile.from(
        JSON.stringify([{ Config: blobPath(config.digest), RepoTags: [name], Layers: image.layers.map(layer => blobPath(layer.index.diffId)) }])
      )
    );
    return new FileSet(files);
  });
}

/** Make `image`'s manifest, its layers uncompressed, and the config it names, each as written. */
export function manifestOf(image: ImageFileSet): Computable<{ manifest: IDigested<Record<string, unknown>>; config: IDigested<Record<string, unknown>> }> {
  const config = digested(image.config.document);
  return Computable.forAll(
    image.layers.map(layer => sizeOf(layer.tar)),
    (...sizes: number[]) => ({
      manifest: digested<Record<string, unknown>>({
        schemaVersion: 2,
        mediaType: OCI_MANIFEST,
        config: { mediaType: OCI_CONFIG, digest: config.digest, size: config.bytes.length },
        layers: image.layers.map((layer, index) => ({ mediaType: OCI_LAYER, digest: layer.index.diffId, size: sizes[index] })),
      }),
      config,
    })
  );
}

function blobPath(digest: string): string {
  return `blobs/sha256/${digest.substring("sha256:".length)}`;
}

/** @return the size of `file`'s content: from the store where it is there, else from its bytes. */
function sizeOf(file: IFile): Computable<number> {
  const where = file.getAbsPath();
  return where === undefined
    ? file.getBuffer().then(buffer => buffer.length)
    : Computable.from<number>((resolve, reject) => fs.stat(where, (err, stats) => (err ? reject(err) : resolve(stats.size))));
}
