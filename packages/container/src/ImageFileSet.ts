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
import {
  Computable,
  Dependency,
  FabrError,
  FileSet,
  IFile,
  IProvenanceStep,
  MemoryFile,
  MetadataMap,
  PackageFileSet,
  parseJson,
  Provided,
  UsedFor,
  SymlinkFile,
  toJsonObject,
} from "@fabr-build/core";
import { ILayerEntry, ILayerIndex } from "./LayerIndex";
import { IImageConfig, toImageConfig, toLayerIndex } from "./OciProtocol";

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
  /** The index as it is stored, beside the tar. */
  readonly indexFile: IFile;
  /** How it was published, and the registry and repository it was fetched from, with the name the registry's login is stored under where it declares one. */
  readonly published?: {
    readonly digest: string;
    readonly mediaType: string;
    readonly size: number;
    readonly registry: string;
    readonly repository: string;
    readonly loginUrl?: string;
  };
}

/**
 * An image, a package presented as the FileSet of its filesystem: the layers'
 * entries merged top-down, a whiteout removing what is below it, each regular
 * file read from its layer when its content is wanted. Directories, device
 * nodes, fifos and sockets are not presented, and every file is presented
 * root-owned. Beside its files it carries what an image built on it needs:
 * its config and its layers. Its dependency is the image it is built on,
 * where it was built here.
 */
export class ImageFileSet extends PackageFileSet {
  public readonly config: IImageConfig;
  public readonly layers: readonly ILayerRecord[];

  /**
   * Make an image of `files` under the package fields given; its config and
   * layers are `image`'s, or else those of `files`, which must then be an
   * image (as {@link PackageGraphBuilder} and a copy remake one).
   */
  constructor(
    files: Iterable<[string, IFile]>,
    packageName: string,
    version?: string,
    dependencies?: ReadonlyArray<Dependency<PackageFileSet>>,
    origin?: IProvenanceStep,
    provided?: ReadonlyMap<string, Provided>,
    metadata?: MetadataMap,
    usedFor?: ReadonlyMap<string, UsedFor>,
    image?: { readonly config: IImageConfig; readonly layers: readonly ILayerRecord[] }
  ) {
    super(files, packageName, version, dependencies, origin, provided, metadata, usedFor);
    const from = image ?? (files instanceof ImageFileSet ? files : undefined);
    if (from === undefined) {
      throw new FabrError(`'${packageName}' is made as an image from files that are no image`);
    }
    this.config = from.config;
    this.layers = from.layers;
  }

  /** Make the image named `packageName` whose config is `config` and whose layers, lowest first, are `layers`. */
  public static of(
    config: IImageConfig,
    layers: readonly ILayerRecord[],
    packageName: string,
    version?: string,
    origin?: IProvenanceStep
  ): ImageFileSet {
    return new ImageFileSet(filesystemOf(layers), packageName, version, [], origin, undefined, undefined, undefined, {
      config,
      layers,
    });
  }

  /**
   * @return the image's records as files, for a build step to take as input
   * and hand on: `config.json`, and per layer, numbered from the lowest,
   * `layers/<n>/layer.tar`, `index.json` and, where it was fetched,
   * `published.json`. {@link imageOfRecords} reads them back.
   */
  public toRecords(): FileSet {
    const records = new Map<string, IFile>([[RECORD_CONFIG, MemoryFile.from(JSON.stringify(this.config.document))]]);
    this.layers.forEach((layer, index) => {
      const dir = layerRecordDir(index);
      records.set(`${dir}/${RECORD_TAR}`, layer.tar);
      records.set(`${dir}/${RECORD_INDEX}`, layer.indexFile);
      if (layer.published !== undefined) {
        records.set(`${dir}/${RECORD_PUBLISHED}`, MemoryFile.from(JSON.stringify(layer.published)));
      }
    });
    return new FileSet(records);
  }
}

/* The names of an image's records (see {@link ImageFileSet.toRecords}). */
export const RECORD_CONFIG = "config.json";
const RECORD_TAR = "layer.tar";
const RECORD_INDEX = "index.json";
const RECORD_PUBLISHED = "published.json";

/** @return the directory of the records of the layer numbered `index`: zero-padded, so they sort in order. */
export function layerRecordDir(index: number): string {
  return `layers/${String(index).padStart(3, "0")}`;
}

/** Read the image named `packageName` back from its records (see {@link ImageFileSet.toRecords}). */
export function imageOfRecords(records: FileSet, packageName: string, origin?: IProvenanceStep): Computable<ImageFileSet> {
  const dirs = [
    ...new Set(
      [...records]
        .map(([name]) => name)
        .filter(name => name.startsWith("layers/"))
        .map(name => name.split("/").slice(0, 2).join("/"))
    ),
  ].sort();
  const read = (name: string): Computable<string> => {
    const file = records.getFile(name);
    return file === undefined ? Computable.reject<string>(new FabrError(`an image's records lack '${name}'`)) : file.readString();
  };
  return Computable.forAll(
    [
      read(RECORD_CONFIG),
      Computable.forAll(
        dirs.map(dir =>
          Computable.forAll(
            [
              read(`${dir}/${RECORD_INDEX}`),
              records.getFile(`${dir}/${RECORD_PUBLISHED}`)?.readString() ?? Computable.resolve(undefined),
            ] as const,
            (index: string, published: string | undefined): ILayerRecord => ({
              tar: records.getFile(`${dir}/${RECORD_TAR}`)!,
              index: parseJson(index, `${dir}/${RECORD_INDEX}`, toLayerIndex),
              indexFile: records.getFile(`${dir}/${RECORD_INDEX}`)!,
              ...(published === undefined ? {} : { published: parseJson(published, `${dir}/${RECORD_PUBLISHED}`, toPublished) }),
            })
          )
        ),
        (...layers: ILayerRecord[]) => layers
      ),
    ] as const,
    (config: string, layers: ILayerRecord[]) =>
      ImageFileSet.of(parseJson(config, RECORD_CONFIG, toImageConfig), layers, packageName, undefined, origin)
  );
}

/** Read a layer's `published.json` record. */
function toPublished(json: unknown): NonNullable<ILayerRecord["published"]> {
  const doc = toJsonObject(json);
  const { digest, mediaType, size, registry, repository, loginUrl } = doc;
  if (
    typeof digest !== "string" ||
    typeof mediaType !== "string" ||
    typeof size !== "number" ||
    typeof registry !== "string" ||
    typeof repository !== "string" ||
    (loginUrl !== undefined && typeof loginUrl !== "string")
  ) {
    throw new FabrError("a layer's published record is malformed");
  }
  return { digest, mediaType, size, registry, repository, ...(loginUrl === undefined ? {} : { loginUrl }) };
}

/** The C library an image's programs are linked against, as a target triple's environment names it. */
export type ImageLibc = "gnu" | "musl";

/**
 * Find the C library an image has, from its dynamic loader: musl's
 * `lib/ld-musl-<arch>.so.1` (even beside a glibc-named shim), else glibc's
 * `ld-linux*.so.<n>` under `lib`, `lib64` or `usr/lib`. Undefined where it has
 * neither (`scratch`, a static distroless image).
 */
export function libcOf(image: FileSet): ImageLibc | undefined {
  const names = [...image].map(([name]) => name);
  if (names.some(name => /^(usr\/)?lib\/ld-musl-[^/]+\.so\.1$/.test(name))) {
    return "musl";
  }
  return names.some(name => /^(usr\/)?lib(64)?(\/[^/]+-linux-gnu[^/]*)?\/ld-linux[^/]*\.so\.\d+$/.test(name)) ? "gnu" : undefined;
}

/** An entry of the merged filesystem: the layer it is from, and, for a regular file or a hardlink to one, the entry its content is read as. */
interface IMergedEntry {
  readonly entry: ILayerEntry;
  readonly content?: { readonly entry: ILayerEntry; readonly layer: ILayerRecord };
}

/**
 * Merge `layers`' entries, lowest first, into the files of the filesystem they
 * make. A hardlink shares the content of its target as the filesystem holds
 * it where the link's layer applies, whatever a later layer does to the target.
 */
function filesystemOf(layers: readonly ILayerRecord[]): Map<string, IFile> {
  const merged = new Map<string, IMergedEntry>();
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
        const content =
          entry.type === "file" ? { entry, layer } : entry.type === "hardlink" ? merged.get(entry.linkname ?? "")?.content : undefined;
        merged.set(entry.path, { entry, ...(content === undefined ? {} : { content }) });
      }
    }
  }
  const files = new Map<string, IFile>();
  for (const [path, merge] of merged) {
    const file = fileOf(merge);
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
function fileOf({ entry, content }: IMergedEntry): IFile | undefined {
  if (entry.type === "symlink") {
    return new SymlinkFile(entry.linkname ?? "");
  }
  return content === undefined ? undefined : new LayerEntryFile(content.layer.tar, content.entry, entry.mode);
}

/**
 * A regular file of an image's layer: its hash and mime as the layer's index
 * records them, its content read from its range of the layer's stored tar when
 * wanted. It has no path of its own, so it is copied wherever it is staged.
 */
class LayerEntryFile implements IFile {
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
