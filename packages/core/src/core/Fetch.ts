import * as http from "http";
import { URL } from "url";
import { Readable } from "stream";
import { EnvHttpProxyAgent, interceptors, request as httpRequest } from "undici";
import { Computable } from "./Computable";
import { HttpStatusError } from "./Errors";

/** Bounded redirect following npmjs serves tarballs directly, but GitHub
 * Packages, Artifactory, and most corporate mirrors 302 to blob storage. */
const MAX_REDIRECTS = 5;

/**
 * The one dispatcher every fabr HTTP(S) request rides. It combines two things
 * node's raw `http`/`https` don't do:
 *  - **Proxy** from the standard environment (`http_proxy`/`https_proxy`/
 *    `no_proxy`, upper- or lower-case) — {@link EnvHttpProxyAgent} reads them
 *    once at construction and CONNECT-tunnels or routes accordingly.
 *  - **Redirects**, bounded to {@link MAX_REDIRECTS}; undici's redirect
 *    interceptor drops credential-bearing headers on cross-origin hops.
 * A single pooling instance for the process (agents reuse keep-alive sockets).
 */
const dispatcher = new EnvHttpProxyAgent().compose(interceptors.redirect({ maxRedirections: MAX_REDIRECTS }));

/** Reject a non-HTTP(S) URL with a clear message rather than a transport-layer
 * error; fabr only ever fetches over http/https. */
function unsupportedProtocol(urlstring: string): Error | undefined {
  const protocol = new URL(urlstring).protocol;
  return protocol === "https:" || protocol === "http:" ? undefined : new Error("Unsupported protocol: " + protocol);
}

export function fetchUrl(urlstring: string): Computable<Buffer> {
  /* Unconditional request, so a resolved response always carries the stream */
  return openUrlStream(urlstring).then(response => readStream(response.stream!));
}

export interface HttpRequest {
  method: string;
  headers?: Record<string, string>;
  /** Request body, sent verbatim; Content-Length is derived when not supplied. */
  body?: Buffer | string;
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
  return Computable.from<HttpResponse>((resolve, reject) => {
    const unsupported = unsupportedProtocol(urlstring);
    if (unsupported) {
      reject(unsupported);
      return;
    }
    /* undici derives Content-Length from the body and follows redirects itself. */
    httpRequest(urlstring, { method: request.method, headers: request.headers, body: request.body, dispatcher }).then(
      response =>
        response.body.arrayBuffer().then(
          buffer =>
            resolve({
              statusCode: response.statusCode,
              headers: response.headers as http.IncomingHttpHeaders,
              body: Buffer.from(buffer),
            }),
          reject
        ),
      reject
    );
  });
}

/**
 * The HTTP cache-control facts of a response, parsed: when the copy must next
 * be revalidated before serving, and the validators to revalidate it with.
 * Returned by {@link openConditionalUrlStream} alongside the content (and
 * persisted by the build cache as a non-immutable entry's `!meta` header).
 */
export interface ICacheControl {
  /** Epoch-ms time after which the entry must be revalidated before serving. */
  expires: number;
  /** HTTP validators for conditional revalidation, as the origin sent them. */
  etag?: string;
  lastModified?: string;
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
  now: () => number = Date.now
): Computable<UrlStreamResponse> {
  const conditional =
    headers !== undefined && Object.keys(headers).some(name => /^if-(none-match|modified-since)$/i.test(name));
  return Computable.from<UrlStreamResponse>((resolve, reject) => {
    const unsupported = unsupportedProtocol(urlstring);
    if (unsupported) {
      reject(unsupported);
      return;
    }
    /* Redirects are followed transparently by the dispatcher, so the response
     * we see is the final hop (a 200, a conditional 304, or an error status). */
    httpRequest(urlstring, { method: "GET", headers, dispatcher }).then(response => {
      const resHeaders = response.headers as http.IncomingHttpHeaders;
      if (response.statusCode === 200) {
        resolve({ cacheControl: parseCacheControl(resHeaders, now()), stream: response.body });
      } else if (response.statusCode === 304 && conditional) {
        void response.body.dump(); /* discard the (empty) body so the socket is released */
        resolve({ cacheControl: parseCacheControl(resHeaders, now()) });
      } else {
        void response.body.dump();
        reject(new HttpStatusError(response.statusCode, "", urlstring));
      }
    }, reject);
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
function parseCacheControl(headers: http.IncomingHttpHeaders, now: number): ICacheControl {
  const declared = declaredLifetime(headers, now);
  const age = Number.isFinite(Number(headers.age)) ? Number(headers.age) * 1000 : 0;
  const lifetime = declared === undefined ? 0 : Math.max(0, declared - age);
  return { expires: now + lifetime, etag: headers.etag, lastModified: headers["last-modified"] };
}

/**
 * The freshness lifetime (ms) a response's own headers declare:
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
