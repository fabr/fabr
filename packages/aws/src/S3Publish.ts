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

/**
 * Publishing to S3: a `sync` member's coordinate, and its content as the
 * objects it is stored as.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as mime from "mime-types";
import {
  Computable,
  contentStream,
  FabrError,
  HASH_ALGORITHM,
  IFile,
  PublishableFileSet,
  PublishMember,
  RepositoryPublishRef,
  RepositoryWriter,
  SymlinkFile,
} from "@fabr-build/core";

/**
 * Where a `sync` member is stored in S3: an object (`s3:acme:tools/tool.tgz`),
 * or, with a key ending in `/`, a prefix every file of the member's content is
 * stored under by its name (`s3:acme:site/v3/`).
 */
export class S3PublishRef extends RepositoryPublishRef {
  constructor(
    source: RepositoryWriter,
    public readonly bucket: string,
    /** The object's key, or the prefix, ending in `/`. */
    public readonly key: string,
    repositoryName?: string
  ) {
    super(source, { name: `s3:${bucket}:${key}` }, repositoryName);
  }

  /** @return true if the coordinate is a prefix, otherwise false. */
  public get isPrefix(): boolean {
    return this.key.endsWith("/");
  }

  public override withRepositoryName(repositoryName: string): S3PublishRef {
    return new S3PublishRef(this.source, this.bucket, this.key, repositoryName);
  }
}

/** Make the help for a coordinate that is no S3 address to publish to, in `account`. */
export function publishHelp(account: string): string {
  return `write a key, as in '${account}:s3:<bucket>:<key>', or a prefix ending in '/', as in '${account}:s3:<bucket>:<prefix>/'`;
}

/** Check `key` is a key or prefix a member may be published at in `account`, naming `written` where it is not. */
export function checkedPublishKey(key: string, written: string, account: string): string {
  const fail = (reason: string): never => {
    throw new FabrError(`'${written}' is not an S3 address to publish to: ${reason}`).withHelp(publishHelp(account));
  };
  if (key === "" || key === "/") {
    fail("it names no key");
  }
  if (key.includes(":")) {
    fail("a key is written with '/' between its parts, not ':'");
  }
  const parts = key.replace(/\/$/, "").split("/");
  if (parts.some(part => part === "" || part === "." || part === "..")) {
    fail("a key has no empty, '.' or '..' part");
  }
  return key;
}

/** Get `ref` as the S3 coordinate an S3 repository vended it as. */
export function s3CoordinateOf(ref: RepositoryPublishRef): S3PublishRef {
  if (!(ref instanceof S3PublishRef)) {
    throw new FabrError(`internal: '${ref.toString()}' is not an S3 coordinate`);
  }
  return ref;
}

/**
 * Package a member for S3: for a prefix, its content's files as they are, each
 * named by its key within the prefix; for an object, its content's one file,
 * named by the key's last part. A symbolic link is refused: an object holds
 * bytes.
 */
export function packageS3Member({ destination, content }: PublishMember): PublishableFileSet {
  const coordinate = s3CoordinateOf(destination);
  const files = [...content];
  const link = files.find(([, file]) => file instanceof SymlinkFile);
  if (link !== undefined) {
    throw new FabrError(`cannot publish ${destination.toString()}: '${link[0]}' is a symbolic link, which S3 cannot store`);
  }
  if (coordinate.isPrefix) {
    return new PublishableFileSet(files, destination);
  }
  if (files.length !== 1) {
    throw new FabrError(
      `cannot publish ${destination.toString()}: an object's content must be one file, and it holds ${files.length === 0 ? "none" : files.length}`
    ).withHelp(`publish to a prefix to store several, as in '${destination.toString()}/'`);
  }
  return new PublishableFileSet([[path.posix.basename(coordinate.key), files[0][1]]], destination);
}

/** One object a carrier stores: its key and the file it holds. */
export interface IStoredObject {
  readonly key: string;
  readonly file: IFile;
}

/** List the objects `artifact`, an S3 carrier, stores. */
export function storedObjects(artifact: PublishableFileSet): IStoredObject[] {
  const coordinate = s3CoordinateOf(artifact.destination);
  const files = [...artifact];
  return coordinate.isPrefix ? files.map(([name, file]) => ({ key: `${coordinate.key}${name}`, file })) : [{ key: coordinate.key, file: files[0][1] }];
}

/** Get the `Content-Type` an object holding `file` at `key` is stored with: by the key's extension, else the file's sniffed type. */
export function contentTypeOf(key: string, file: IFile): string {
  const extension = path.posix.extname(key);
  return (extension === "" ? false : mime.contentType(extension)) || file.mime;
}

/** Get `file`'s size in bytes. */
export function sizeOf(file: IFile): Computable<number> {
  const where = file.getAbsPath();
  return where !== undefined ? Computable.resolve(fs.statSync(where).size) : file.getBuffer().then(buffer => buffer.length);
}

/** Get `file`'s SHA-256, hex-encoded: its hash in the store, which is SHA-256. */
export function sha256Of(file: IFile): string {
  if (HASH_ALGORITHM !== "sha256") {
    throw new FabrError(`internal: the store hashes with ${HASH_ALGORITHM}, not SHA-256`);
  }
  return file.hash;
}

/** Get the `x-amz-checksum-sha256` S3 stores with an object holding `file`: its SHA-256, base64-encoded. */
export function checksumOf(file: IFile): string {
  return Buffer.from(sha256Of(file), "hex").toString("base64");
}

/** Get the ETag S3 gives an object stored by one `PutObject` of `file`: its MD5, quoted. */
export function etagOf(file: IFile): Computable<string> {
  return contentStream(file).then(
    stream =>
      Computable.from<string>((resolve, reject) => {
        const md5 = crypto.createHash("md5");
        stream.on("data", chunk => md5.update(chunk));
        stream.on("end", () => resolve(`"${md5.digest("hex")}"`));
        stream.on("error", reject);
      })
  );
}
