import * as https from "https";
import * as http from "http";
import { URL } from "url";
import { Computable } from "./Computable";
import { HttpStatusError } from "./Errors";
import { Readable } from "stream";

export function fetchUrl(urlstring: string): Computable<Buffer> {
  return openUrlStream(urlstring).then(readStream);
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
    const url = new URL(urlstring);
    const transport = url.protocol === "https:" ? https : url.protocol === "http:" ? http : undefined;
    if (!transport) {
      reject(new Error("Unsupported protocol: " + url.protocol));
      return;
    }
    const headers = { ...request.headers };
    if (request.body !== undefined && headers["content-length"] === undefined) {
      headers["content-length"] = String(Buffer.byteLength(request.body));
    }
    const req = transport.request(url, { method: request.method, headers }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", err => reject(err));
    });
    req.on("error", err => reject(err));
    if (request.body !== undefined) {
      req.write(request.body);
    }
    req.end();
  });
}

export function openUrlStream(urlstring: string, headers?: Record<string, string>): Computable<Readable> {
  return Computable.from<Readable>((resolve, reject) => {
    function handleResponse(res: http.IncomingMessage): void {
      if (res.statusCode !== 200) {
        reject(new HttpStatusError(res.statusCode ?? 0, res.statusMessage ?? "", urlstring));
      } else {
        resolve(res);
      }
    }

    const url = new URL(urlstring);
    let req;
    switch (url.protocol) {
      case "https:":
        req = https.request(url, { method: "GET", headers }, handleResponse);
        break;
      case "http:":
        req = http.request(url, { method: "GET", headers }, handleResponse);
        break;
      default:
        reject(new Error("Unsupported protocol: " + url.protocol));
        return;
    }
    req.on("error", err => reject(err));
    req.end();
  });
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
