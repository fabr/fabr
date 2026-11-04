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
import { Computable, FileSet, IFile, IProvenanceStep, SymlinkFile } from "@fabr-build/core";
import { ILayerEntry, ILayerIndex } from "./LayerIndex";
import { IImageConfig } from "./OciProtocol";

/** The name of a whiteout's file: `.wh.<name>` hides `<name>` below it, and `.wh..wh..opq` everything else in its directory. */
const WHITEOUT_PREFIX = ".wh.";
const OPAQUE_WHITEOUT = ".wh..wh..opq";

/**
 * One layer of an image, as an image built on it needs it: its uncompressed
 * tar and index as stored, and, where it was fetched, how it was published
 * (its compressed digest, media type and size) and where from.
 */
export interface ILayerRecord {
  readonly tar: IFile;
  readonly index: ILayerIndex;
  readonly published?: { readonly digest: string; readonly mediaType: string; readonly size: number; readonly from: string };
}

/**
 * An image, presented as the FileSet of its filesystem: the layers' entries
 * merged top-down, a whiteout removing what is below it, each regular file
 * read from its layer when its content is wanted. Directories, device nodes,
 * fifos and sockets are not presented, and every file is presented
 * root-owned. Beside its files it carries what an image built on it needs:
 * its config and its layers.
 */
export class ImageFileSet extends FileSet {
  constructor(
    public readonly config: IImageConfig,
    public readonly layers: readonly ILayerRecord[],
    origin?: IProvenanceStep
  ) {
    super(filesystemOf(layers), origin);
  }
}

/** Merge `layers`' entries, lowest first, into the files of the filesystem they make. */
function filesystemOf(layers: readonly ILayerRecord[]): Map<string, IFile> {
  const merged = new Map<string, { entry: ILayerEntry; layer: ILayerRecord }>();
  for (const layer of layers) {
    /* A layer's whiteouts apply to the layers below it, so before its own entries are added. */
    for (const entry of layer.index.entries) {
      const slash = entry.path.lastIndexOf("/");
      const dir = slash === -1 ? "" : entry.path.substring(0, slash);
      const base = entry.path.substring(slash + 1);
      if (base === OPAQUE_WHITEOUT) {
        removeUnder(merged, dir);
      } else if (base.startsWith(WHITEOUT_PREFIX)) {
        const hidden = (dir === "" ? "" : `${dir}/`) + base.substring(WHITEOUT_PREFIX.length);
        merged.delete(hidden);
        removeUnder(merged, hidden);
      }
    }
    for (const entry of layer.index.entries) {
      const base = entry.path.substring(entry.path.lastIndexOf("/") + 1);
      if (entry.path !== "" && !base.startsWith(WHITEOUT_PREFIX)) {
        if (entry.type !== "directory" && merged.get(entry.path)?.entry.type === "directory") {
          /* A file replacing a directory hides what was under it. */
          removeUnder(merged, entry.path);
        }
        merged.set(entry.path, { entry, layer });
      }
    }
  }
  const files = new Map<string, IFile>();
  for (const [path, { entry, layer }] of merged) {
    const file = fileOf(entry, layer, merged);
    if (file !== undefined) {
      files.set(path, file);
    }
  }
  return files;
}

function removeUnder(merged: Map<string, unknown>, dir: string): void {
  const prefix = dir === "" ? "" : `${dir}/`;
  for (const path of [...merged.keys()]) {
    if (path.startsWith(prefix) && path !== dir) {
      merged.delete(path);
    }
  }
}

/** Make the file an entry presents: a regular file read from its layer, a symlink, or the file a hardlink shares. */
function fileOf(entry: ILayerEntry, layer: ILayerRecord, merged: ReadonlyMap<string, { entry: ILayerEntry; layer: ILayerRecord }>): IFile | undefined {
  if (entry.type === "file") {
    return new LayerEntryFile(layer.tar, entry);
  }
  if (entry.type === "symlink") {
    return new SymlinkFile(entry.linkname ?? "");
  }
  if (entry.type === "hardlink") {
    const target = merged.get(entry.linkname ?? "");
    return target !== undefined && target.entry.type === "file" ? new LayerEntryFile(target.layer.tar, target.entry, entry.mode) : undefined;
  }
  return undefined;
}

/**
 * A regular file of an image's layer: its hash and mime as the layer's index
 * records them, its content read from its range of the layer's stored tar when
 * wanted. It has no path of its own, so it is copied wherever it is staged.
 */
export class LayerEntryFile implements IFile {
  public readonly hash: string;
  public readonly mime: string;
  public readonly mode: number;

  constructor(
    private readonly tar: IFile,
    private readonly entry: ILayerEntry,
    mode?: number
  ) {
    this.hash = entry.hash!;
    this.mime = entry.mime!;
    this.mode = mode ?? entry.mode;
  }

  public getBuffer(): Computable<Buffer> {
    const where = this.tar.getAbsPath();
    const offset = this.entry.offset ?? 0;
    const size = this.entry.size ?? 0;
    if (where === undefined) {
      return this.tar.getBuffer().then(buffer => buffer.subarray(offset, offset + size));
    }
    return Computable.from<Buffer>((resolve, reject) => {
      if (size === 0) {
        resolve(Buffer.alloc(0));
        return;
      }
      const chunks: Buffer[] = [];
      fs.createReadStream(where, { start: offset, end: offset + size - 1 })
        .on("data", chunk => chunks.push(chunk as Buffer))
        .on("end", () => resolve(Buffer.concat(chunks)))
        .on("error", reject);
    });
  }

  public readString(encoding: BufferEncoding = "utf8"): Computable<string> {
    return this.getBuffer().then(buffer => buffer.toString(encoding));
  }

  public getDisplayName(): string {
    return this.entry.path;
  }

  public isSameFile(file: IFile): boolean {
    return file instanceof LayerEntryFile && file.tar.isSameFile(this.tar) && file.entry.offset === this.entry.offset;
  }

  public getAbsPath(): undefined {
    return undefined;
  }
}
