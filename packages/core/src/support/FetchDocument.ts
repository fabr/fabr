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

import { finished, Readable } from "stream";
import { Computable } from "../core/Computable";
import { FetchOptions, IFetchContext, IFetchRequest } from "../core/BuildCache";
import type { Credential } from "../core/Credential";
import { HttpStatusError, toError } from "../core/Errors";
import { readStream } from "../core/Fetch";
import { FileSet, IFile } from "../core/FileSet";
import { MemoryFile } from "../core/MemoryFS";
import { IFetchReport } from "../model/BuildEvents";
import { ExpectedDigest, verifiedStream } from "./Integrity";
import { unpackStream } from "./Unpack";

/** What fetches through the build cache: a target's context, as its `fetch`. */
type CacheFetcher = {
  fetch(cacheKey: string, tag: string, request: () => Computable<IFetchRequest>, report: IFetchReport, options?: FetchOptions): Computable<FileSet>;
};

/** A document to fetch with {@link fetchDocument}. */
export interface IDocumentRequest<T> {
  readonly url: string;
  /** The name the document is kept under in its cache entry. */
  readonly file: string;
  /** The cache tag it is kept under, bumped when what is kept changes shape. */
  readonly tag: string;
  /** The cache key, where it is not the url. */
  readonly key?: string;
  readonly report: IFetchReport;
  /** Read the document as the value it states, throwing where it is unusable,
   *  so an unusable one is never cached. Applied to what is kept, too. */
  readonly convert: (text: string) => T;
  /** Render what is kept of the value, where that is less than the document;
   *  `convert` must read it back. */
  readonly keep?: (value: T) => string;
  /** The headers the request is made with (credentials): never part of the key. */
  readonly headers?: () => Computable<Record<string, string>>;
  /** What signs the request in, asked again where the server answers 401: never part of the key. */
  readonly credential?: Credential;
  readonly options?: FetchOptions;
}

/**
 * Fetch a document through the build cache and read it with `convert`: checked
 * before it is kept, and again as it is read back, cached or not. A document
 * the server does not have (a 404) is undefined.
 */
export function fetchDocument<T>(context: CacheFetcher, request: IDocumentRequest<T>): Computable<T | undefined> {
  const { url, file, convert, keep } = request;
  return context
    .fetch(
      request.key ?? url,
      request.tag,
      () =>
        (request.headers ? request.headers() : Computable.resolve(undefined)).then(headers => ({
          url,
          ...(headers ? { headers } : {}),
          ...(request.credential ? { credential: request.credential } : {}),
          process: (content: Readable) =>
            readStream(content).then(data => {
              const text = data.toString("utf8");
              const value = convert(text);
              return new FileSet(new Map([[file, MemoryFile.from(keep ? keep(value) : text)]]));
            }),
        })),
      request.report,
      request.options
    )
    .then(files => files.readFile(file))
    .then(
      text => convert(text) as T | undefined,
      err => {
        if (err instanceof HttpStatusError && err.statusCode === 404) {
          return undefined;
        }
        throw err;
      }
    );
}

/** Where an archive or file is downloaded from, found only when it is not cached. */
export interface IDownloadSource {
  readonly url: string;
  /** The digest the archive must match, where its publisher states one. */
  readonly expected: ExpectedDigest | undefined;
  /** The headers the request is made with (credentials): never part of the key. */
  readonly headers?: Record<string, string>;
  /** What signs the request in, asked again where the server answers 401: never part of the key. */
  readonly credential?: Credential;
}

/** An archive to fetch with {@link fetchArchive}. */
export interface IArchiveRequest {
  /** The cache key, which names the archive without its url (a registry's package and version). */
  readonly key: string;
  /** The cache tag it is kept under, bumped when what is kept changes shape. */
  readonly tag: string;
  readonly report: IFetchReport;
  /** Find where to download it from: asked only on a cache miss. */
  readonly source: () => Computable<IDownloadSource>;
  /** Reshape the unpacked files before they are kept (strip the top directory). */
  readonly keep?: (files: FileSet) => FileSet;
  readonly options?: FetchOptions;
}

/**
 * Fetch an archive through the build cache, checked against its digest as it
 * streams and unpacked straight into the store, so a mismatched download is
 * never kept.
 */
export function fetchArchive(context: CacheFetcher, request: IArchiveRequest): Computable<FileSet> {
  const { keep } = request;
  return context.fetch(
    request.key,
    request.tag,
    () =>
      request.source().then(({ url, expected, headers, credential }) => ({
        url,
        ...(headers ? { headers } : {}),
        ...(credential ? { credential } : {}),
        process: (content: Readable, { createOutput }: IFetchContext) => {
          const { stream, verify } = verifiedStream(content, expected, url);
          return unpackStream(stream, createOutput).then(files => {
            verify();
            return keep ? keep(files) : files;
          });
        },
      })),
    request.report,
    request.options
  );
}

/**
 * Strip the single root directory an archive wraps its contents in (npm's
 * `package/`, a release's `node-v24.22.1-darwin-arm64/`), naming each file
 * relative to it: a `keep` for {@link fetchArchive}.
 */
export function stripArchiveRoot(files: FileSet): FileSet {
  return files.remap(name => {
    const idx = name.indexOf("/");
    return idx === -1 ? undefined : name.substring(idx + 1);
  });
}

/** A single file to fetch with {@link fetchFile}. */
export interface IFileRequest {
  /** The cache key, which names the file without its url (a registry's package and version). */
  readonly key: string;
  /** The cache tag it is kept under, bumped when what is kept changes shape. */
  readonly tag: string;
  readonly report: IFetchReport;
  /** The name the file is kept under. */
  readonly name: string;
  /** Find where to download it from: asked only on a cache miss, or to
   *  revalidate a held copy. */
  readonly source: () => Computable<IDownloadSource>;
  readonly options?: FetchOptions;
}

/**
 * Fetch one file through the build cache, never unpacked, checked against its
 * digest as it streams into the store, so a mismatched download is never kept.
 */
export function fetchFile(context: CacheFetcher, request: IFileRequest): Computable<FileSet> {
  const { name } = request;
  return context.fetch(
    request.key,
    request.tag,
    () =>
      request.source().then(({ url, expected, headers, credential }) => ({
        url,
        ...(headers ? { headers } : {}),
        ...(credential ? { credential } : {}),
        process: (content: Readable, { createOutput }: IFetchContext) => {
          const { stream, verify } = verifiedStream(content, expected, url);
          const output = createOutput();
          /* A failed write ends the download with its error. */
          output.stream.once("error", err => content.destroy(err));
          stream.pipe(output.stream, { end: false });
          return streamed(stream)
            .then(
              () => {
                /* Before finalize: a digest mismatch must leave nothing behind. */
                try {
                  verify();
                } catch (err) {
                  return output.discard().then(() => Computable.reject<IFile>(toError(err)));
                }
                return output.finalize(name);
              },
              err => output.discard().then(() => Computable.reject<IFile>(toError(err)))
            )
            .then((file: IFile) => new FileSet(new Map([[name, file]])));
        },
      })),
    request.report,
    request.options
  );
}

/** Settle when a stream has been fully consumed, or has failed or closed before its end. */
function streamed(stream: NodeJS.ReadableStream): Computable<void> {
  return Computable.from<void>((resolve, reject) => {
    finished(stream, { writable: false }, err => (err ? reject(toError(err)) : resolve(undefined)));
  });
}
