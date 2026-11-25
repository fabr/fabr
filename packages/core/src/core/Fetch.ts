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
import { finished, pipeline, Readable, Transform } from "stream";
import type { Credential, IRequestHead } from "./Credential";
import { EnvHttpProxyAgent, interceptors, request as httpRequest } from "undici";
import { Computable } from "./Computable";
import { FabrError, HttpStatusError, toError } from "./Errors";
import { SecureString } from "./SecureString";
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
 * core, between 64 and 96 (pnpm's default). Keep half the content limit below
 * {@link MAX_CONNECTIONS_PER_ORIGIN}: each relay ({@link relayUrl}) within an
 * origin holds two content slots and a connection for its download while its
 * upload waits for one.
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

/** @return the key of the request limit of `role` at `urlstring`'s origin. */
function admissionKey(urlstring: string, role: FetchRole): string {
  return `${role} ${new URL(urlstring).origin}`;
}

/** @return the request limit `key` names, made on first use. */
function admissionOf(key: string): Semaphore {
  let limit = admissions.get(key);
  if (limit === undefined) {
    limit = new Semaphore(MAX_REQUESTS_PER_ORIGIN[key.startsWith("index ") ? "index" : "content"]);
    admissions.set(key, limit);
  }
  return limit;
}

/**
 * How a request takes its slot: called with the function that sends it, which
 * is handed the release to call when the response's body has been read,
 * discarded or failed.
 */
type Admission = (send: (release: () => void) => void) => void;

/** @return the admission that sends a request to `urlstring`'s origin once it has a slot free for `role`, held until released. */
function admitted(urlstring: string, role: FetchRole): Admission {
  return send => void admissionOf(admissionKey(urlstring, role)).run(() => Computable.from<void>(done => send(() => done())));
}

/** The admission of a request whose slot its caller holds: sent at once. */
const HELD: Admission = send => send(() => undefined);

/**
 * Run `work` holding a content slot for a request to `from`'s origin and one
 * for a request to `to`'s, taken together where the two are one origin, and
 * in the order of their keys otherwise.
 */
function admittedPair<T>(from: string, to: string, work: () => Computable<T>): Computable<T> {
  const keys = [admissionKey(from, "content"), admissionKey(to, "content")].sort();
  return keys[0] === keys[1] ? admissionOf(keys[0]).run(work, 2) : admissionOf(keys[0]).run(() => admissionOf(keys[1]).run(work));
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

/**
 * @return `url` as output shows it: its text from a masked source as written
 * ({@link SecureString.toDisplayString}), and any `user:password@` left out.
 */
export function shownUrl(url: SecureString): string {
  return url.toDisplayString().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, "$1");
}

/** @return `url` without its trailing `/`s. */
export function urlRoot(url: SecureString): SecureString {
  return url.slice(0, url.toUnmaskedString().replace(/\/+$/, "").length);
}

/** @return the URL of `path` under `base`: `base` without its trailing `/`s, then `/`, then `path`. */
export function urlJoin(base: SecureString, path: string): SecureString {
  return urlRoot(base).concat(`/${path}`);
}

/**
 * @return `ref`, a URL as a server gave it, resolved against `base`, the URL
 * it was fetched from, keeping `base`'s masked runs where the result begins
 * with `base`'s text:
 * - where the result lies under `base` (at a `/`, `?` or `#`, or `base` ends
 *   with `/`): `base` followed by the rest;
 * - where it lies under `base`'s scheme and authority (any `user:password@`
 *   included): those, as `base` has them, followed by the rest;
 * - where it is of `base`'s origin, its host written otherwise (in other
 *   capitals), and `base` holds no `user:password@`: `base`'s scheme and
 *   authority followed by the result's path, query and fragment;
 * - otherwise the result as it resolves, nothing masked.
 */
export function urlResolved(base: SecureString, ref: string): SecureString {
  const text = base.toUnmaskedString();
  const resolved = new URL(ref, text);
  const href = resolved.href;
  const under = (prefix: string): boolean =>
    href.startsWith(prefix) && (prefix.endsWith("/") || href.length === prefix.length || "/?#".includes(href[prefix.length]));
  if (under(text)) {
    return base.concat(href.slice(text.length));
  }
  const authority = text.indexOf("//") + 2;
  const authorityEnd = text.slice(authority).search(/[/?#]/);
  const originEnd = authorityEnd === -1 ? text.length : authority + authorityEnd;
  if (under(text.slice(0, originEnd))) {
    return base.slice(0, originEnd).concat(href.slice(originEnd));
  }
  return resolved.origin === new URL(text).origin && !text.slice(authority, originEnd).includes("@")
    ? base.slice(0, originEnd).concat(resolved.pathname + resolved.search + resolved.hash)
    : SecureString.of(href);
}

/**
 * @return the host name of `url`, as `URL.hostname` reads it, its text from a
 * masked source kept: where the host is written otherwise (in capitals, or
 * encoded), the name is masked whole, shown as written.
 */
export function urlHostname(url: SecureString): SecureString {
  const text = url.toUnmaskedString();
  const hostname = new URL(text).hostname;
  const authority = text.indexOf("//") + 2;
  const authorityEnd = text.slice(authority).search(/[/?#]/);
  const hostStart = text.lastIndexOf("@", authorityEnd === -1 ? text.length : authority + authorityEnd) + 1 || authority;
  const start = Math.max(hostStart, authority);
  if (text.startsWith(hostname, start)) {
    return url.slice(start, start + hostname.length);
  }
  const written = url.slice(start, authorityEnd === -1 ? text.length : authority + authorityEnd);
  return written.isMasked() ? SecureString.masked(hostname, written.toDisplayString()) : SecureString.of(hostname);
}

/** Send a GET for `url` and return its body. Rejects as {@link openUrlStream} does. */
export function fetchUrl(url: SecureString): Computable<Buffer> {
  /* No validators are sent, so a resolved response carries a stream. */
  return openUrlStream(url).then(response => readStream(response.stream!));
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
 * Send one HTTP(S) request to `written`, a URL (its masked text kept out of
 * what output shows), and return its response, whatever its status: the
 * caller reads `statusCode` and the body (where a registry's publish states
 * its error detail). The whole response is read into memory, so this is for
 * small exchanges such as a publish or a dist-tag; {@link openUrlStream}
 * streams a download. The request is admitted under the `content` role, and
 * a 401 is answered with `credential` as {@link withCredential} describes.
 *
 * Rejects where the URL's protocol is not http or https, or the request fails
 * in transport.
 */
export function sendRequest(written: string | SecureString, request: HttpRequest): Computable<HttpResponse> {
  return sendWith(undefined, written, request);
}

/** Send {@link sendRequest}'s request under `admission`, or as its role admits it where there is none. */
function sendWith(admission: Admission | undefined, written: string | SecureString, request: HttpRequest): Computable<HttpResponse> {
  const { credential, method, headers, body } = request;
  const url = typeof written === "string" ? SecureString.of(written) : written;
  const urlstring = url.toUnmaskedString();
  return maskingFailures(
    url,
    withCredential(
      credential,
      method,
      urlstring,
      headers,
      signed => send(urlstring, method, signed, body, admission ?? admitted(urlstring, "content")),
      response => (body instanceof Readable ? undefined : challengesOf(response.statusCode, response.headers))
    )
  );
}

/** @return `request`, a request to `url`, its failure rewritten by {@link maskedFailure} where `url` holds masked text. */
function maskingFailures<T>(url: SecureString, request: Computable<T>): Computable<T> {
  return url.isMasked()
    ? request.catch(err => {
        throw maskedFailure(err, url);
      })
    : request;
}

/**
 * @return `err`, the failure of a request to `url`, as output may show it:
 * - where `url`'s host is masked and the message of a failure in transport
 *   names it (a host the connection could not reach): a FabrError whose
 *   message shows the host as written, `err` its cause;
 * - where `url` is no URL: a FabrError saying so, without `err`, whose message
 *   holds the URL's text;
 * - otherwise `err` as it is.
 */
function maskedFailure(err: unknown, url: SecureString): unknown {
  const message = (err as { message?: unknown } | undefined)?.message;
  if (!url.isMasked() || err instanceof HttpStatusError || typeof message !== "string") {
    return err;
  }
  let hostname: SecureString;
  try {
    hostname = urlHostname(url);
  } catch {
    return new FabrError(`'${shownUrl(url)}' is not a URL`);
  }
  if (!hostname.isMasked() || hostname.length === 0) {
    return err;
  }
  const shown = SecureString.of(message).replaceAll(hostname.toUnmaskedString(), hostname).toDisplayString();
  return shown === message ? err : new FabrError(shown, err as Error);
}

/** Send {@link sendRequest}'s request with `headers`, as they stand. */
function send(
  urlstring: string,
  method: string,
  headers: Record<string, string> | undefined,
  body: HttpRequest["body"],
  admission: Admission
): Computable<HttpResponse> {
  return Computable.from<HttpResponse>((resolve, reject) => {
    const unsupported = unsupportedProtocol(urlstring);
    if (unsupported) {
      reject(unsupported);
      return;
    }
    admission(release => {
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
 * returned stream with it, and the returned stream closing before `stream`
 * has ended destroys `stream`.
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
  /* Each stream reports its own failure to whoever reads it. */
  return pipeline(stream, counter, () => undefined);
}

/**
 * Send a GET for `url` and return its response with the body as a
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
  url: SecureString,
  headers?: Record<string, string>,
  now: () => number = Date.now,
  role: FetchRole = "content",
  /** The response header stating the document's digest, recorded as {@link ICacheControl.digest}. */
  digestHeader?: string,
  /** What signs the request in, asked again with the challenge where the server answers 401 (see {@link withCredential}). */
  credential?: Credential
): Computable<UrlStreamResponse> {
  return maskingFailures(
    url,
    withCredential(
      credential,
      "GET",
      url.toUnmaskedString(),
      headers,
      signed => streamUrl(url, signed, now, digestHeader, admitted(url.toUnmaskedString(), role)),
      () => undefined
    )
  );
}

/** Send {@link openUrlStream}'s GET with `headers`, as they stand. */
function streamUrl(
  url: SecureString,
  headers: Record<string, string> | undefined,
  now: () => number,
  digestHeader: string | undefined,
  admission: Admission
): Computable<UrlStreamResponse> {
  const urlstring = url.toUnmaskedString();
  const conditional = headers !== undefined && Object.keys(headers).some(name => /^if-(none-match|modified-since)$/i.test(name));
  return Computable.from<UrlStreamResponse>((resolve, reject) => {
    const unsupported = unsupportedProtocol(urlstring);
    if (unsupported) {
      reject(unsupported);
      return;
    }
    admission(release => {
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
            reject(new HttpStatusError(response.statusCode, shownUrl(url), challengesOf(response.statusCode, resHeaders)));
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

/** The download a relay reads ({@link relayUrl}). */
export interface RelaySource {
  url: SecureString;
  headers?: Record<string, string>;
  /** What signs the download in, as {@link openUrlStream}'s does. */
  credential?: Credential;
}

/** The request a relay sends its download in ({@link relayUrl}). */
export interface RelayDestination {
  url: SecureString;
  method: string;
  /** The request's headers, among them the body's length where the server needs it. */
  headers?: Record<string, string>;
  /** What signs the request in. It is asked once: a 401 stands, since the body cannot be sent twice. */
  credential?: Credential;
}

/**
 * Relay a download into an upload: send a GET for `source` and send its body,
 * as it is read, as the body of the request to `destination`.
 * @return the destination's response, whatever its status.
 *
 * Both requests are signed in first. The relay then holds a content slot at
 * each origin, taken together, from the time its GET is sent until the
 * destination's response is read, when the download is closed if it was not
 * read through.
 *
 * Rejects as {@link openUrlStream} does where the download cannot be opened,
 * and where the request to `destination` fails in transport.
 */
export function relayUrl(source: RelaySource, destination: RelayDestination): Computable<HttpResponse> {
  const from = source.url.toUnmaskedString();
  const to = destination.url.toUnmaskedString();
  const relayed = (
    uploadHeaders: Record<string, string> | undefined,
    signed: Record<string, string> | undefined
  ): Computable<HttpResponse> => {
    try {
      const unsupported = unsupportedProtocol(from) ?? unsupportedProtocol(to);
      if (unsupported) {
        return Computable.reject(unsupported);
      }
      return admittedPair(from, to, () =>
        streamUrl(source.url, signed, Date.now, undefined, HELD).then(response => {
          const body = response.stream!;
          return send(to, destination.method, uploadHeaders, body, HELD).finally(() => {
            body.on("error", () => undefined);
            body.destroy();
          });
        })
      );
    } catch (err) {
      return Computable.reject(toError(err));
    }
  };
  return maskingFailures(
    destination.url,
    maskingFailures(
      source.url,
      signedHeaders(destination.credential, destination.method, to, destination.headers).then(uploadHeaders =>
        withCredential(
          source.credential,
          "GET",
          from,
          source.headers,
          signed => relayed(uploadHeaders, signed),
          () => undefined
        )
      )
    )
  );
}

/** @return `headers` with those `credential` gives a `method` request to `url` added, or `headers` as they stand without one. */
function signedHeaders(
  credential: Credential | undefined,
  method: string,
  url: string,
  headers: Record<string, string> | undefined
): Computable<Record<string, string> | undefined> {
  if (credential === undefined) {
    return Computable.resolve(headers);
  }
  return credential
    .authorize({ method, url, headers: new Map(Object.entries(headers ?? {})) })
    .then(added => ({ ...headers, ...Object.fromEntries(added ?? []) }));
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
 * Send a `HEAD` for `url` and return the response's caching facts, with
 * the digest the `digestHeader` response header states, for a caller
 * revalidating a held copy by comparing digests. Any status but 200 rejects
 * as an {@link HttpStatusError}, as does a 401 that `credential` cannot
 * answer.
 */
export function headUrl(
  url: SecureString,
  headers: Record<string, string> | undefined,
  digestHeader: string,
  now: () => number = Date.now,
  role: FetchRole = "index",
  /** What signs the request in, asked again with the challenge where the server answers 401 (see {@link withCredential}). */
  credential?: Credential
): Computable<ICacheControl> {
  return maskingFailures(
    url,
    withCredential(
      credential,
      "HEAD",
      url.toUnmaskedString(),
      headers,
      signed => headOf(url, signed, digestHeader, now, role),
      () => undefined
    )
  );
}

/** Send {@link headUrl}'s HEAD with `headers`, as they stand. */
function headOf(
  url: SecureString,
  headers: Record<string, string> | undefined,
  digestHeader: string,
  now: () => number,
  role: FetchRole
): Computable<ICacheControl> {
  const urlstring = url.toUnmaskedString();
  return Computable.from<ICacheControl>((resolve, reject) => {
    const unsupported = unsupportedProtocol(urlstring);
    if (unsupported) {
      reject(unsupported);
      return;
    }
    admitted(
      urlstring,
      role
    )(release => {
      httpRequest(urlstring, { method: "HEAD", headers, dispatcher }).then(
        response => {
          void response.body.dump().finally(release);
          const resHeaders = response.headers as http.IncomingHttpHeaders;
          if (response.statusCode === 200) {
            resolve(parseCacheControl(resHeaders, now(), digestHeader));
          } else {
            reject(new HttpStatusError(response.statusCode, shownUrl(url), challengesOf(response.statusCode, resHeaders)));
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

/** Read `stream` to its end and return its contents. Rejects where it fails, or closes before its end. */
export function readStream(stream: Readable): Computable<Buffer> {
  return Computable.from<Buffer>((resolve, reject) => {
    const data: Buffer[] = [];
    stream.on("data", chunk => data.push(chunk));
    finished(stream, { writable: false }, err => (err ? reject(err) : resolve(Buffer.concat(data))));
  });
}
