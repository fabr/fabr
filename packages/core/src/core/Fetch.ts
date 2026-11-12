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

import * as http from "http";
import { availableParallelism } from "os";
import { URL } from "url";
import { Readable, Transform } from "stream";
import type { Credential, IRequestHead } from "./Credential";
import { EnvHttpProxyAgent, interceptors, request as httpRequest } from "undici";
import { Computable } from "./Computable";
import { FabrError, HttpStatusError, toError } from "./Errors";
import { Semaphore } from "../support/Semaphore";

/** The most redirects a request follows. */
const MAX_REDIRECTS = 5;

/**
 * HTTP idle timeouts, none of them a deadline on the whole request:
 * connecting, waiting for the response's headers, and the gap between two
 * chunks of its body.
 */
const CONNECT_TIMEOUT_MS = 30_000;
const HEADERS_TIMEOUT_MS = 30_000;
const BODY_TIMEOUT_MS = 120_000;

/**
 * Sockets held open per origin (npm's default); further requests queue in the
 * dispatcher's pool. The timeouts above start once a request has a socket, so
 * time spent queued counts against none of them.
 */
const MAX_CONNECTIONS_PER_ORIGIN = 15;

/**
 * Requests in flight per origin and role, whatever protocol the origin speaks
 * (over HTTP/2 one socket carries many requests, so the socket limit does not
 * bound them); further requests queue until one ends. A request holds its slot
 * until its body has been read or discarded. Index reads get three per CPU
 * core, between 64 and 96 (pnpm's default).
 */
const MAX_REQUESTS_PER_ORIGIN: Readonly<Record<FetchRole, number>> = {
  index: Math.min(96, Math.max(availableParallelism() * 3, 64)),
  content: 16,
};

/**
 * HTTP/2 flow-control windows: how much a sender may have in flight unread on
 * one stream, and on all of a connection's streams together. Keep the
 * connection's window at a full stream window for every request an origin
 * admits (both roles): slowly read streams that fill it stall every other
 * stream on the connection.
 */
const STREAM_WINDOW_BYTES = 4 * 1024 * 1024;
const CONNECTION_WINDOW_BYTES = (MAX_REQUESTS_PER_ORIGIN.index + MAX_REQUESTS_PER_ORIGIN.content) * STREAM_WINDOW_BYTES;

/** What a request is for: reading a registry's index (a packument,
 *  per-version metadata) or transferring content the build uses. Each role
 *  has its own limit per origin. */
export type FetchRole = "content" | "index";

/** The request limit of each role and origin, made on first use. */
const admissions = new Map<string, Semaphore>();

/**
 * Send a request to `urlstring`'s origin once it has a slot free for `role`,
 * and hold the slot until `send` calls the release it is handed: when the
 * response's body has been read, discarded or failed.
 */
function admitted(urlstring: string, role: FetchRole, send: (release: () => void) => void): void {
  const key = `${role} ${new URL(urlstring).origin}`;
  let limit = admissions.get(key);
  if (limit === undefined) {
    limit = new Semaphore(MAX_REQUESTS_PER_ORIGIN[role]);
    admissions.set(key, limit);
  }
  void limit.run(() => Computable.from<void>(done => send(() => done())));
}

/**
 * The dispatcher every fabr HTTP(S) request is sent through: one pooling agent
 * for the process, so {@link MAX_CONNECTIONS_PER_ORIGIN} holds for the whole
 * run. It uses the proxy the environment names (`http_proxy`/`https_proxy`/
 * `no_proxy`, either case, read once at construction), and follows up to
 * {@link MAX_REDIRECTS} redirects, dropping credential-bearing headers on a
 * hop to another origin.
 */
const dispatcher = new EnvHttpProxyAgent({
  connectTimeout: CONNECT_TIMEOUT_MS,
  headersTimeout: HEADERS_TIMEOUT_MS,
  bodyTimeout: BODY_TIMEOUT_MS,
  connections: MAX_CONNECTIONS_PER_ORIGIN,
  initialWindowSize: STREAM_WINDOW_BYTES,
  connectionWindowSize: CONNECTION_WINDOW_BYTES,
}).compose(interceptors.redirect({ maxRedirections: MAX_REDIRECTS }));

/** @return the error refusing `urlstring` where its protocol is not http or
 * https, otherwise undefined. */
function unsupportedProtocol(urlstring: string): Error | undefined {
  const protocol = new URL(urlstring).protocol;
  return protocol === "https:" || protocol === "http:" ? undefined : new FabrError("Unsupported protocol: " + protocol);
}

/** Send a GET for `urlstring` and return its body. Rejects as {@link openUrlStream} does. */
export function fetchUrl(urlstring: string): Computable<Buffer> {
  /* No validators are sent, so a resolved response carries a stream. */
  return openUrlStream(urlstring).then(response => readStream(response.stream!));
}

/** A request for {@link sendRequest}. */
export interface HttpRequest {
  method: string;
  headers?: Record<string, string>;
  /** What signs the request in, asked again with the challenges where the server answers 401 (see {@link withCredential}), unless `body` is a stream, which cannot be sent twice. */
  credential?: Credential;
  /** Request body, sent verbatim: bytes, whose Content-Length is derived where
   *  `headers` give none, or a stream, sent as it is read, whose length the
   *  caller states where the server needs it. */
  body?: Buffer | string | Readable;
}

/** A response {@link sendRequest} read, body and all. */
export interface HttpResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/**
 * Send one HTTP(S) request and return its response, whatever its status: the
 * caller reads `statusCode` and the body (where a registry's publish states
 * its error detail). The whole response is read into memory, so this is for
 * small exchanges such as a publish or a dist-tag; {@link openUrlStream}
 * streams a download. The request is admitted under the `content` role, and
 * a 401 is answered with `credential` as {@link withCredential} describes.
 *
 * Rejects where the URL's protocol is not http or https, or the request fails
 * in transport.
 */
export function sendRequest(urlstring: string, request: HttpRequest): Computable<HttpResponse> {
  const { credential, method, headers, body } = request;
  return withCredential(
    credential,
    method,
    urlstring,
    headers,
    signed => send(urlstring, method, signed, body),
    response => (body instanceof Readable ? undefined : challengesOf(response.statusCode, response.headers))
  );
}

/** Send {@link sendRequest}'s request with `headers`, as they stand. */
function send(
  urlstring: string,
  method: string,
  headers: Record<string, string> | undefined,
  body: HttpRequest["body"]
): Computable<HttpResponse> {
  return Computable.from<HttpResponse>((resolve, reject) => {
    const unsupported = unsupportedProtocol(urlstring);
    if (unsupported) {
      reject(unsupported);
      return;
    }
    admitted(urlstring, "content", release => {
      const fail = (err: unknown): void => {
        release();
        reject(toError(err));
      };
      /* undici derives Content-Length from the body and follows redirects itself. */
      httpRequest(urlstring, { method, headers, body, dispatcher }).then(
        response =>
          response.body.arrayBuffer().then(buffer => {
            release();
            resolve({
              statusCode: response.statusCode,
              headers: response.headers as http.IncomingHttpHeaders,
              body: Buffer.from(buffer),
            });
          }, fail),
        fail
      );
    });
  });
}

/**
 * The HTTP caching facts of a response: when a copy of it must next be
 * revalidated, and the validators to revalidate it with. The build cache keeps
 * them in a mutable entry's `!meta` header.
 */
export interface ICacheControl {
  /** Epoch-ms time after which the entry must be revalidated before serving. */
  expires: number;
  /** HTTP validators for conditional revalidation, as the origin sent them. */
  etag?: string;
  lastModified?: string;
  /** The document's digest, as the response header the caller names states
   *  it (a registry's `Docker-Content-Digest`), for revalidating by a `HEAD`
   *  (see {@link headUrl}). */
  digest?: string;
}

/**
 * The outcome of a GET: a body stream for a 200, or none for a 304 to a
 * request that sent validators (the caller's copy stands). Either carries the
 * response's caching facts.
 */
export interface UrlStreamResponse {
  cacheControl: ICacheControl;
  /** Present for a 200; absent for a 304. */
  stream?: Readable;
  /** The body's size in bytes, where the origin declared one. */
  contentLength?: number;
}

/** @return the body size a `Content-Length` header declares, or undefined
 * where there is none or it is not a non-negative integer. */
function parseContentLength(value: string | string[] | undefined): number | undefined {
  const size = typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
}

/**
 * Pass `stream` through unchanged, calling `report` with the number of bytes
 * read so far as each chunk is read. An error on `stream` destroys the
 * returned stream with it.
 */
export function reportingProgress(stream: Readable, report: (bytes: number) => void): Readable {
  /* Count in a Transform, not a `data` listener: a listener switches the
   * stream to flowing mode, and what arrives before the consumer attaches is
   * lost. */
  let seen = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done): void {
      seen += chunk.length;
      report(seen);
      done(null, chunk);
    },
  });
  stream.on("error", err => counter.destroy(err instanceof Error ? err : new FabrError(String(err))));
  return stream.pipe(counter);
}

/**
 * Send a GET for `urlstring` and return its response with the body as a
 * stream. The request holds its slot under `role` until the body is read
 * through or closed.
 *
 * A caller revalidating a held copy sends its validators
 * (`if-none-match`/`if-modified-since`) among `headers`, and a 304 then
 * resolves with no stream. Any other status but 200, a 304 to a request that
 * sent no validators included, rejects as an {@link HttpStatusError}; so does
 * a 401 that `credential` cannot answer. Also rejects where the URL's protocol
 * is not http or https, or the request fails in transport. `now` is the time
 * the caching facts' `expires` counts from.
 */
export function openUrlStream(
  urlstring: string,
  headers?: Record<string, string>,
  now: () => number = Date.now,
  role: FetchRole = "content",
  /** The response header stating the document's digest, recorded as {@link ICacheControl.digest}. */
  digestHeader?: string,
  /** What signs the request in, asked again with the challenge where the server answers 401 (see {@link withCredential}). */
  credential?: Credential
): Computable<UrlStreamResponse> {
  return withCredential(
    credential,
    "GET",
    urlstring,
    headers,
    signed => streamUrl(urlstring, signed, now, role, digestHeader),
    () => undefined
  );
}

/** Send {@link openUrlStream}'s GET with `headers`, as they stand. */
function streamUrl(
  urlstring: string,
  headers: Record<string, string> | undefined,
  now: () => number,
  role: FetchRole,
  digestHeader: string | undefined
): Computable<UrlStreamResponse> {
  const conditional = headers !== undefined && Object.keys(headers).some(name => /^if-(none-match|modified-since)$/i.test(name));
  return Computable.from<UrlStreamResponse>((resolve, reject) => {
    const unsupported = unsupportedProtocol(urlstring);
    if (unsupported) {
      reject(unsupported);
      return;
    }
    admitted(urlstring, role, release => {
      /* The dispatcher follows redirects, so this is the last hop's response. */
      httpRequest(urlstring, { method: "GET", headers, dispatcher }).then(
        response => {
          const resHeaders = response.headers as http.IncomingHttpHeaders;
          if (response.statusCode === 200) {
            /* Hold the slot until the body closes, however the consumer ends it. */
            response.body.once("close", release);
            resolve({
              cacheControl: parseCacheControl(resHeaders, now(), digestHeader),
              stream: response.body,
              contentLength: parseContentLength(resHeaders["content-length"]),
            });
          } else if (response.statusCode === 304 && conditional) {
            void response.body.dump().finally(release); /* discard the (empty) body, then free the slot */
            resolve({ cacheControl: parseCacheControl(resHeaders, now(), digestHeader) });
          } else {
            void response.body.dump().finally(release);
            reject(new HttpStatusError(response.statusCode, urlstring, challengesOf(response.statusCode, resHeaders)));
          }
        },
        err => {
          release();
          reject(err);
        }
      );
    });
  });
}

/**
 * Send a request with the headers `credential` gives it, added to `headers`.
 * Where the server answers 401, ask the credential again, with the server's
 * challenges, for the headers to answer them with (a renewed token, or one
 * for what the challenge asks), and send the request once more with those;
 * where it gives none, the 401 stands. A 401 is seen either as an {@link HttpStatusError}
 * `send` rejects with, or as a result `challengeOf` reads challenges from.
 * Without a credential, `headers` are sent as they stand.
 */
function withCredential<T>(
  credential: Credential | undefined,
  method: string,
  url: string,
  headers: Record<string, string> | undefined,
  send: (headers: Record<string, string> | undefined) => Computable<T>,
  challengeOf: (result: T) => readonly string[] | undefined
): Computable<T> {
  if (credential === undefined) {
    return send(headers);
  }
  const head: IRequestHead = { method, url, headers: new Map(Object.entries(headers ?? {})) };
  const withAdded = (added: ReadonlyMap<string, string> | undefined): Record<string, string> => ({
    ...headers,
    ...Object.fromEntries(added ?? []),
  });
  const answer = (challenges: readonly string[], standing: () => Computable<T>): Computable<T> =>
    credential.authorize(head, { challenges }).then(added => (added === undefined ? standing() : send(withAdded(added))));
  return credential.authorize(head).then(added =>
    send(withAdded(added)).then(
      result => {
        const challenges = challengeOf(result);
        return challenges === undefined ? result : answer(challenges, () => Computable.resolve(result));
      },
      err => {
        if (err instanceof HttpStatusError && err.statusCode === 401) {
          return answer(err.challenges, () => Computable.reject<T>(err));
        }
        throw err;
      }
    )
  );
}

/** @return a 401's `WWW-Authenticate` challenges, or undefined for any other status. */
function challengesOf(statusCode: number, headers: http.IncomingHttpHeaders): readonly string[] | undefined {
  if (statusCode !== 401) {
    return undefined;
  }
  const header = headers["www-authenticate"];
  return header === undefined ? [] : Array.isArray(header) ? header : [header];
}

/**
 * Send a `HEAD` for `urlstring` and return the response's caching facts, with
 * the digest the `digestHeader` response header states, for a caller
 * revalidating a held copy by comparing digests. Any status but 200 rejects
 * as an {@link HttpStatusError}, as does a 401 that `credential` cannot
 * answer.
 */
export function headUrl(
  urlstring: string,
  headers: Record<string, string> | undefined,
  digestHeader: string,
  now: () => number = Date.now,
  role: FetchRole = "index",
  /** What signs the request in, asked again with the challenge where the server answers 401 (see {@link withCredential}). */
  credential?: Credential
): Computable<ICacheControl> {
  return withCredential(
    credential,
    "HEAD",
    urlstring,
    headers,
    signed => headOf(urlstring, signed, digestHeader, now, role),
    () => undefined
  );
}

/** Send {@link headUrl}'s HEAD with `headers`, as they stand. */
function headOf(
  urlstring: string,
  headers: Record<string, string> | undefined,
  digestHeader: string,
  now: () => number,
  role: FetchRole
): Computable<ICacheControl> {
  return Computable.from<ICacheControl>((resolve, reject) => {
    const unsupported = unsupportedProtocol(urlstring);
    if (unsupported) {
      reject(unsupported);
      return;
    }
    admitted(urlstring, role, release => {
      httpRequest(urlstring, { method: "HEAD", headers, dispatcher }).then(
        response => {
          void response.body.dump().finally(release);
          const resHeaders = response.headers as http.IncomingHttpHeaders;
          if (response.statusCode === 200) {
            resolve(parseCacheControl(resHeaders, now(), digestHeader));
          } else {
            reject(new HttpStatusError(response.statusCode, urlstring, challengesOf(response.statusCode, resHeaders)));
          }
        },
        err => {
          release();
          reject(err);
        }
      );
    });
  });
}

/**
 * Parse a response's caching facts. `expires` is `now` plus the lifetime the
 * headers declare ({@link declaredLifetime}) less the response's `Age`, never
 * less than `now`; where no lifetime is declared it is `now`, so the copy is
 * already due for revalidation. The digest is read from `digestHeader` where
 * one is named and the response states it.
 */
function parseCacheControl(headers: http.IncomingHttpHeaders, now: number, digestHeader?: string): ICacheControl {
  const declared = declaredLifetime(headers, now);
  const age = Number.isFinite(Number(headers.age)) ? Number(headers.age) * 1000 : 0;
  const lifetime = declared === undefined ? 0 : Math.max(0, declared - age);
  const digest = digestHeader === undefined ? undefined : headers[digestHeader.toLowerCase()];
  return {
    expires: now + lifetime,
    etag: headers.etag,
    lastModified: headers["last-modified"],
    ...(typeof digest === "string" && digest !== "" ? { digest } : {}),
  };
}

/**
 * Get the freshness lifetime in ms a response's headers declare, or undefined
 * where they declare none. `Cache-Control: no-cache` or `no-store` declares
 * zero, and its `max-age` the lifetime; otherwise `Expires` less the
 * response's `Date` (or `now` where it has none), and zero where `Expires`
 * does not parse (the conventional "0").
 */
function declaredLifetime(headers: http.IncomingHttpHeaders, now: number): number | undefined {
  const cacheControl = headers["cache-control"];
  if (cacheControl) {
    if (/(?:^|[,\s])no-(?:cache|store)(?:$|[,\s])/.test(cacheControl)) {
      return 0;
    }
    const maxAge = /(?:^|[,\s])max-age=(\d+)/.exec(cacheControl);
    if (maxAge) {
      return Number(maxAge[1]) * 1000;
    }
  }
  const expires = headers.expires;
  if (expires !== undefined) {
    const expiry = Date.parse(expires);
    if (Number.isNaN(expiry)) {
      return 0;
    }
    const base = headers.date !== undefined ? Date.parse(headers.date) : Number.NaN;
    return Math.max(0, expiry - (Number.isNaN(base) ? now : base));
  }
  return undefined;
}

/** Read `stream` to its end and return its contents. */
export function readStream(stream: Readable): Computable<Buffer> {
  return Computable.from<Buffer>((resolve, reject) => {
    const data: Buffer[] = [];
    stream.on("data", chunk => data.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(data)));
    stream.on("error", err => reject(err));
  });
}
