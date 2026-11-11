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
 */

import { FabrError, isJsonObject, parseJson, toError } from "@fabr-build/core";

/**
 * The protocols a connection carries: the Build Server Protocol, and the
 * Language Server Protocol, whose frames carry {@link PROTOCOL_HEADER}.
 */
export type Protocol = "bsp" | "lsp";

/** The frame header naming the protocol of a message that is not BSP's. */
export const PROTOCOL_HEADER = "Fabr-Protocol";

/** Each protocol's request a client opens it with, before whose answer the server sends it nothing. */
const INITIALIZE: Record<Protocol, string> = { bsp: "build/initialize", lsp: "initialize" };

/** JSON-RPC's error codes a server answers with. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/** A JSON-RPC message, as a connection reads one. */
interface IMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
}

/** What a frame read holds: a message, or what was wrong with it and the code to answer that with. */
type Frame = { protocol: Protocol; message: IMessage } | { protocol: Protocol; code: number; reason: string };

/** Convert a JSON-RPC message: an object whose `id`, where it has one, is a number or a string, and whose `method`, where it has one, is a string. */
function toMessage(json: unknown): IMessage {
  if (!isJsonObject(json)) {
    throw new FabrError("expected a JSON object");
  }
  const { id, method, params } = json;
  if (id !== undefined && id !== null && typeof id !== "number" && typeof id !== "string") {
    throw new FabrError("an id that is neither a number nor a string");
  }
  if (method !== undefined && typeof method !== "string") {
    throw new FabrError("a method that is not a string");
  }
  return { ...(id === undefined || id === null ? {} : { id }), ...(method === undefined ? {} : { method }), params };
}

/** A request a protocol's server has no answer for. */
export class MethodNotFound extends FabrError {}

/** Parameters a request's method cannot be answered with. */
export class InvalidParams extends FabrError {}

/** What a protocol's server answers a request or notification `method` with. */
export type Handler = (method: string, params: unknown) => unknown;

/**
 * A JSON-RPC connection over a pair of streams, each message framed by a
 * `Content-Length` header as LSP frames one, carrying several protocols: a
 * frame names its protocol in {@link PROTOCOL_HEADER}, and one that names none
 * is BSP's, so a client speaking BSP alone sees nothing but BSP.
 */
export class JsonRpcConnection {
  private buffer = Buffer.alloc(0);
  private readonly handlers = new Map<Protocol, Handler>();
  /** Each protocol's notifications sent before its client's initialize was answered, sent once it is. */
  private readonly held = new Map<Protocol, unknown[]>([
    ["bsp", []],
    ["lsp", []],
  ]);
  /** The protocols that have a client: BSP's, the connection's own, and each
   * other whose client has sent a frame naming it. */
  private readonly heard = new Set<Protocol>(["bsp"]);

  constructor(private readonly output: NodeJS.WritableStream) {}

  /** Answer `protocol`'s requests and notifications with `handler`. */
  public serve(protocol: Protocol, handler: Handler): void {
    this.handlers.set(protocol, handler);
  }

  /** Read messages from `input` until it ends, then call `onEnd`. */
  public listen(input: NodeJS.ReadableStream, onEnd: () => void): void {
    input.on("data", (data: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      for (let next = this.next(); next !== undefined; next = this.next()) {
        this.heard.add(next.protocol);
        if ("message" in next) {
          this.dispatch(next.protocol, next.message);
        } else {
          /* A message that cannot be read has no id to answer by: JSON-RPC answers it with a null one. */
          this.send(next.protocol, { jsonrpc: "2.0", id: null, error: { code: next.code, message: next.reason } });
        }
      }
    });
    input.on("end", onEnd);
  }

  /** Send `protocol`'s notification `method`: once its client's initialize has
   * been answered, and until then held; dropped where the protocol has no client yet. */
  public notify(method: string, params: unknown, protocol: Protocol = "bsp"): void {
    const held = this.held.get(protocol);
    if (!this.heard.has(protocol)) {
      return;
    }
    if (held !== undefined) {
      held.push({ jsonrpc: "2.0", method, params });
    } else {
      this.send(protocol, { jsonrpc: "2.0", method, params });
    }
  }

  /**
   * @return the next frame in the buffer, taken from it, or undefined where the
   * buffer holds no whole frame yet. A frame whose headers state no length is
   * dropped up to the end of its headers, and one whose body is no JSON-RPC
   * message is reported as such, so a malformed frame never stops the reading.
   */
  private next(): Frame | undefined {
    const blank = this.buffer.indexOf("\r\n\r\n");
    if (blank < 0) {
      return undefined;
    }
    const headers = this.buffer.subarray(0, blank).toString("latin1");
    const named = new RegExp(`^${PROTOCOL_HEADER}: *(\\S+)$`, "im").exec(headers)?.[1];
    const protocol: Protocol = named === "lsp" ? "lsp" : "bsp";
    const length = /^content-length: *(\d+)$/im.exec(headers);
    if (length === null) {
      this.buffer = this.buffer.subarray(blank + 4);
      return { protocol, code: INVALID_REQUEST, reason: "a message with no Content-Length" };
    }
    const start = blank + 4;
    const end = start + Number(length[1]);
    if (this.buffer.length < end) {
      return undefined;
    }
    const body = this.buffer.subarray(start, end);
    this.buffer = this.buffer.subarray(end);
    let json: unknown;
    try {
      json = parseJson(body, "a JSON-RPC message", value => value);
    } catch (err) {
      return { protocol, code: PARSE_ERROR, reason: toError(err).message };
    }
    try {
      return { protocol, message: toMessage(json) };
    } catch (err) {
      return { protocol, code: INVALID_REQUEST, reason: `Invalid JSON-RPC message: ${toError(err).message}` };
    }
  }

  private dispatch(protocol: Protocol, message: IMessage): void {
    if (message.method === undefined) {
      return;
    }
    const isRequest = message.id !== undefined;
    const handler = this.handlers.get(protocol);
    Promise.resolve()
      .then(() => {
        if (handler === undefined) {
          throw new MethodNotFound(`no ${protocol} server`);
        }
        return handler(message.method!, message.params);
      })
      .then(
        result => {
          if (isRequest) {
            this.send(protocol, { jsonrpc: "2.0", id: message.id, result: result ?? null });
          }
          const held = this.held.get(protocol);
          if (message.method === INITIALIZE[protocol] && held !== undefined) {
            this.held.delete(protocol);
            held.forEach(notification => this.send(protocol, notification));
          }
        },
        (err: unknown) => {
          const error = toError(err);
          const code =
            error instanceof MethodNotFound ? METHOD_NOT_FOUND : error instanceof InvalidParams ? INVALID_PARAMS : INTERNAL_ERROR;
          if (isRequest) {
            this.send(protocol, { jsonrpc: "2.0", id: message.id, error: { code, message: error.message } });
          }
        }
      );
  }

  private send(protocol: Protocol, message: unknown): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const tag = protocol === "bsp" ? "" : `${PROTOCOL_HEADER}: ${protocol}\r\n`;
    this.output.write(`Content-Length: ${body.length}\r\n${tag}\r\n`);
    this.output.write(body);
  }
}
