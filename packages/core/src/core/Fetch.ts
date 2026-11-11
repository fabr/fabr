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

/** Bounded redirect following: npmjs serves tarballs directly, but GitHub
 * Packages, Artifactory, and most corporate mirrors 302 to blob storage. */
const MAX_REDIRECTS = 5;

/**
 * Explicit HTTP timeouts, so the worst case is fabr's choice rather than
 * undici's inherited defaults. `connectTimeout`/`headersTimeout` bound reaching
 * the origin and its first response (a wedged registry fails fast); `bodyTimeout`
 * bounds only the *idle gap between body chunks*, not total transfer, so a large
 * tarball on a slow-but-live link still completes — it fires only when a stream
 * stalls. All are inter-event idle timeouts, not overall deadlines.
 */
const CONNECT_TIMEOUT_MS = 30_000;
const HEADERS_TIMEOUT_MS = 30_000;
const BODY_TIMEOUT_MS = 120_000;

/**
 * Sockets held open per origin; requests beyond it queue in the dispatcher's
 * pool and dispatch as sockets free. A wide resolution demands metadata for
 * every reachable requirement at once and then tarballs for every selection, so
 * without a cap fabr opens a socket per in-flight demand — hundreds against one
 * registry. Matched to npm's own default (15) so fabr puts no more pressure on
 * a registry than the client it replaces. Per *origin* is the useful
 * granularity here: a registry that redirects tarballs to blob storage gets an
 * independent pool for each, so bulk downloads can't starve metadata reads.
 *
 * This bounds sockets only. The timeouts above are socket-level idle timeouts
 * that start once a request has a connection, so a queued request does not
 * spend its budget waiting.
 */
const MAX_CONNECTIONS_PER_ORIGIN = 15;

/**
 * Requests in flight per origin, by role, whatever protocol the origin speaks:
 * further requests queue until one ends. The socket limit above does not bound
 * this where the origin speaks HTTP/2 (which undici negotiates by default),
 * since one socket then carries many streams. A request holds its slot until
 * its body has been read or discarded, so the bound is on transfers, not on
 * handshakes. Each role is admitted apart, so a resolution's index reads never
 * queue behind large downloads, and each is sized for what limits it: an index
 * read is small and waits on the registry, so many at once (pnpm's own default:
 * three per CPU core, between 64 and 96); a download is limited by bandwidth,
 * which a few at once already fill, and more only share it thinner.
 */
const MAX_REQUESTS_PER_ORIGIN: Readonly<Record<FetchRole, number>> = {
  index: Math.min(96, Math.max(availableParallelism() * 3, 64)),
  content: 16,
};

/**
 * HTTP/2 flow-control windows: how much a sender may have in flight unread on
 * one stream, and on a connection's streams together. undici's defaults (256KB
 * and 512KB) cap a stream at its window per round trip — a few MB/s whatever
 * the link. A stream's window is sized for a large tarball at speed, and the
 * connection's holds every stream an origin admits (both roles) at once, so
 * streams read slowly cannot fill it and stall the others on the connection
 * (which a registry then cuts as idle).
 */
const STREAM_WINDOW_BYTES = 4 * 1024 * 1024;
const CONNECTION_WINDOW_BYTES = (MAX_REQUESTS_PER_ORIGIN.index + MAX_REQUESTS_PER_ORIGIN.content) * STREAM_WINDOW_BYTES;

/** What a request is for: reading a registry's index (a packument,
 *  per-version metadata) or transferring content the build consumes. */
export type FetchRole = "content" | "index";

/** Each origin's admission per role, made on first use. */
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
 * The one dispatcher every fabr HTTP(S) request rides. It combines two things
 * node's raw `http`/`https` don't do:
 *  - **Proxy** from the standard environment (`http_proxy`/`https_proxy`/
 *    `no_proxy`, upper- or lower-case) — {@link EnvHttpProxyAgent} reads them
 *    once at construction and CONNECT-tunnels or routes accordingly.
 *  - **Redirects**, bounded to {@link MAX_REDIRECTS}; undici's redirect
 *    interceptor drops credential-bearing headers on cross-origin hops.
 * A single pooling instance for the process (agents reuse keep-alive sockets),
 * which is also what makes {@link MAX_CONNECTIONS_PER_ORIGIN} a whole-run bound
 * rather than a per-caller one.
 */
const dispatcher = new EnvHttpProxyAgent({
  connectTimeout: CONNECT_TIMEOUT_MS,
  headersTimeout: HEADERS_TIMEOUT_MS,
  bodyTimeout: BODY_TIMEOUT_MS,
  connections: MAX_CONNECTIONS_PER_ORIGIN,
  initialWindowSize: STREAM_WINDOW_BYTES,
  connectionWindowSize: CONNECTION_WINDOW_BYTES,
}).compose(interceptors.redirect({ maxRedirections: MAX_REDIRECTS }));

/** Make the error refusing a non-HTTP(S) URL — a clear message rather than a
 * transport-layer error — or undefined for http/https, the only protocols fabr
 * fetches over. */
function unsupportedProtocol(urlstring: string): Error | undefined {
  const protocol = new URL(urlstring).protocol;
  return protocol === "https:" || protocol === "http:" ? undefined : new FabrError("Unsupported protocol: " + protocol);
}

export function fetchUrl(urlstring: string): Computable<Buffer> {
  /* Unconditional request, so a resolved response always carries the stream */
  return openUrlStream(urlstring).then(response => readStream(response.stream!));
}

export interface HttpRequest {
  method: string;
  headers?: Record<string, string>;
  /** What signs the request in, asked again with the challenge where the server answers 401 (see {@link withCredential}): not where `body` is a stream, which cannot be sent twice. */
  credential?: Credential;
  /** Request body, sent verbatim: bytes, whose Content-Length is derived when not
   *  supplied, or a stream, sent as it is read, whose length the caller states
   *  where the server needs it. */
  body?: Buffer | string | Readable;
}

export interface HttpResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/**
 * Perform a single buffered HTTP(S) request/response. Unlike {@link openUrlStream}
 * (a streaming GET that *rejects* on any non-200), this returns the response
 * whatever its status — the caller inspects `statusCode` and reads the body,
 * which for a write (a registry publish) carries the server's JSON error detail
 * that a bare status code would lose. The whole response is buffered, so this is
 * for control-plane calls (publish, dist-tag), not bulk downloads.
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
 * The HTTP cache-control facts of a response, parsed: when the copy must next
 * be revalidated before serving, and the validators to revalidate it with.
 * Returned by {@link openUrlStream} alongside the content (and
 * persisted by the build cache as a non-immutable entry's `!meta` header).
 */
export interface ICacheControl {
  /** Epoch-ms time after which the entry must be revalidated before serving. */
  expires: number;
  /** HTTP validators for conditional revalidation, as the origin sent them. */
  etag?: string;
  lastModified?: string;
  /** The document's digest as the origin states it in a header of the
   *  caller's naming (a registry's `Docker-Content-Digest`), compared on a
   *  `HEAD` to revalidate (see {@link headUrl}). */
  digest?: string;
}

/**
 * The outcome of a (possibly conditional) GET: a fresh body stream for a 200,
 * or no stream for a 304 (Not Modified — the caller's cached copy stands; only
 * possible for a request that sent validators). The response's parsed
 * cache-control facts ride along in both cases; a 304's carry the updated
 * freshness lifetime and validators.
 */
export interface UrlStreamResponse {
  cacheControl: ICacheControl;
  /** Present for a 200; absent for a 304. */
  stream?: Readable;
  /**
   * The body's declared size in bytes, when the origin declared one — for
   * reporting a download's progress as a fraction. Absent for a chunked or
   * unlabelled response, which is why a consumer must be able to report bare
   * bytes with no total.
   */
  contentLength?: number;
}

/**
 * Parse the declared body size: undefined when the origin declared none — or
 * declared nonsense. A size is only ever used to render a fraction, so an
 * unusable one degrades to "no total" rather than failing the download.
 */
function parseContentLength(value: string | string[] | undefined): number | undefined {
  const size = typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
}

/**
 * Pass `stream` through unchanged while reporting how many bytes have gone by,
 * for a caller displaying a download's progress.
 *
 * Counted inside a Transform, not by a `data` listener: a listener would put
 * the counter in flowing mode at once, silently discarding whatever arrives
 * before the real consumer attaches — whereas `_transform` only sees bytes as
 * the consumer draws them, so backpressure holds and a consumer that attaches
 * a tick late loses nothing. Errors are forwarded, so a failed transfer still
 * fails the consumer rather than hanging it.
 */
export function reportingProgress(stream: Readable, report: (bytes: number) => void): Readable {
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
 * Streaming GET. A caller revalidating a cached copy supplies its validators
 * (`if-none-match`/`if-modified-since`) among `headers`, and a 304 then
 * resolves with no stream; a 304 to a request that sent NO validators is a
 * server defect and rejects like any other non-200 (so an unconditional
 * caller's resolved response always carries the stream). `now` feeds the
 * absolute `expires` in the parsed cache-control facts (injectable for tests;
 * defaults to the wall clock).
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
      /* Redirects are followed transparently by the dispatcher, so the response
       * we see is the final hop (a 200, a conditional 304, or an error status). */
      httpRequest(urlstring, { method: "GET", headers, dispatcher }).then(
        response => {
          const resHeaders = response.headers as http.IncomingHttpHeaders;
          if (response.statusCode === 200) {
            /* The slot is the transfer's: held until the body is read through or
             * given up, however the consumer ends it. */
            response.body.once("close", release);
            resolve({
              cacheControl: parseCacheControl(resHeaders, now(), digestHeader),
              stream: response.body,
              contentLength: parseContentLength(resHeaders["content-length"]),
            });
          } else if (response.statusCode === 304 && conditional) {
            void response.body.dump().finally(release); /* discard the (empty) body so the socket is released */
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
 * Send a `HEAD` for `urlstring` and return the response's cache-control facts,
 * the digest the `digestHeader` response header states among them — for a
 * caller revalidating a held copy by comparing digests, where the origin
 * counts a `GET` against a quota and a `HEAD` not (Docker Hub). Any status but
 * 200 rejects as an {@link HttpStatusError}.
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
 * Parse a response's cache-control facts, per plain HTTP caching semantics.
 * The freshness remaining is the origin-declared lifetime (`max-age`; a
 * `no-cache`/`no-store` counts as zero; else `Expires` relative to the
 * response's own `Date`) minus the response's `Age` — a CDN edge may serve a
 * copy that has already spent most of its lifetime in the edge cache (npmjs
 * serves packuments via Cloudflare with `age` routinely near the `max-age`).
 * An origin declaring nothing gets no lifetime — stale immediately,
 * revalidated on every demand (cheap 304s when it sends validators); the
 * origin owns its staleness contract.
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
 * Get the freshness lifetime (ms) a response's own headers declare:
 * `Cache-Control: max-age` wins (`no-cache`/`no-store` count as zero —
 * revalidate every time); else `Expires`, aged relative to the response's
 * `Date` (the origin's clock, avoiding skew against ours) or `now` when
 * absent — an unparseable `Expires` (e.g. the conventional "0") means already
 * stale. Undefined when the origin declares nothing.
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

/**
 * Read a stream to completion and return the entire contents as a single Buffer.
 */
export function readStream(stream: Readable): Computable<Buffer> {
  return Computable.from<Buffer>((resolve, reject) => {
    const data: Buffer[] = [];
    stream.on("data", chunk => data.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(data)));
    stream.on("error", err => reject(err));
  });
}
