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

import { FabrError, toError } from "../core/Errors";
import { isJsonObject, parseJson } from "./Json";

/**
 * The protocols a connection carries: the Build Server Protocol, the Language
 * Server Protocol, and the fabr socket's own (`fabr`). A frame names its
 * protocol in {@link PROTOCOL_HEADER} where it is not the connection's
 * default.
 */
export type Protocol = "bsp" | "lsp" | "fabr";

/** The frame header naming the protocol of a message that is not its connection's default. */
export const PROTOCOL_HEADER = "Fabr-Protocol";

/** Each protocol's initialize request: the server holds its notifications to the client until it is answered. */
const INITIALIZE: Record<Protocol, string> = { bsp: "build/initialize", lsp: "initialize", fabr: "fabr/initialize" };

/** The notification LSP defines for cancelling a request in flight, by its id. */
const CANCEL_REQUEST = "$/cancelRequest";

/** JSON-RPC's error codes a server answers with. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const SERVER_NOT_INITIALIZED = -32002;
const REQUEST_CANCELLED = -32800;

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

/** A request that is no valid request of its protocol in the state the connection is in. */
export class InvalidRequest extends FabrError {}

/** A request made before its protocol's initialize. */
export class ServerNotInitialized extends FabrError {}

/** A request cancelled before it was answered. */
export class RequestCancelled extends FabrError {}

/** What a handler is told of the message it answers: its id where it is a request, and a signal that aborts where the client cancels the request (`$/cancelRequest`). */
export interface IMessageContext {
  readonly id?: number | string;
  readonly signal: AbortSignal;
}

/** Limits on what a connection reads; a frame over one ends the connection. */
export interface IConnectionLimits {
  /** The largest header part read, in bytes. */
  maxHeaderBytes: number;
  /** The largest message body read, in bytes. */
  maxBodyBytes: number;
}

/** A protocol's server: answers a request or notification `method` with its result, or throws (MethodNotFound, InvalidParams, or any other error, answered as an internal error). */
export type Handler = (method: string, params: unknown, context: IMessageContext) => unknown;

/**
 * A JSON-RPC connection over a pair of streams, each message framed by a
 * `Content-Length` header as LSP frames one, carrying several protocols: a
 * frame names its protocol in {@link PROTOCOL_HEADER}, and one that names none
 * is the connection's default's (BSP's, unless the connection says otherwise),
 * so a client speaking that protocol alone sees nothing but it.
 *
 * A request is answered when its handler's result settles, so a handler may
 * answer much later; `$/cancelRequest` aborts the signal the handler was given
 * for the request it names, as the connection's end aborts every one in
 * flight, and a request whose id is still in flight on its protocol is
 * refused.
 */
export class JsonRpcConnection {
  /** The data read and joined, and not yet taken as frames. */
  private buffer = Buffer.alloc(0);
  /** The data read since the last join onto `buffer`. */
  private chunks: Buffer[] = [];
  /** The length of `buffer` and `chunks` together. */
  private readLength = 0;
  /** The length `buffer` must reach to hold the frame it begins, where its headers have said; else 0. */
  private wanted = 0;
  private readonly handlers = new Map<Protocol, Handler>();
  /** Each protocol's notifications sent before its client's initialize was answered, sent once it is. */
  private readonly held = new Map<Protocol, unknown[]>(Object.keys(INITIALIZE).map(protocol => [protocol as Protocol, []]));
  /** The protocols that have a client: the default, the connection's own, and
   * each other whose client has sent a frame naming it. */
  private readonly heard: Set<Protocol>;
  /** Each protocol's requests not yet answered, by id, with what cancels each. */
  private readonly inFlight = new Map<Protocol, Map<number | string, AbortController>>();
  /** Whether the connection has ended, reading nothing more. */
  private ended = false;

  constructor(
    private readonly output: NodeJS.WritableStream,
    private readonly defaultProtocol: Protocol = "bsp",
    private readonly limits?: IConnectionLimits
  ) {
    this.heard = new Set([defaultProtocol]);
  }

  /** Answer `protocol`'s requests and notifications with `handler`. */
  public serve(protocol: Protocol, handler: Handler): void {
    this.handlers.set(protocol, handler);
  }

  /** Read messages from `input` and dispatch each until it ends, then call `onEnd`. A frame that cannot be read is answered with an error; one over the connection's limits ends it. */
  public listen(input: NodeJS.ReadableStream, onEnd: () => void): void {
    /* Every request still in flight is cancelled: nothing can be answered. */
    const end = (): void => {
      if (!this.ended) {
        this.ended = true;
        for (const requests of this.inFlight.values()) {
          requests.forEach(controller => controller.abort());
        }
        onEnd();
      }
    };
    input.on("data", (data: Buffer) => {
      if (this.ended) {
        return;
      }
      this.chunks.push(data);
      this.readLength += data.length;
      if (this.readLength < this.wanted) {
        return;
      }
      this.buffer = Buffer.concat([this.buffer, ...this.chunks]);
      this.chunks = [];
      this.wanted = 0;
      for (let next = this.next(); next !== undefined; next = this.next()) {
        if (next === "over-limit") {
          end();
          (input as Partial<{ destroy(): void }>).destroy?.();
          return;
        }
        this.heard.add(next.protocol);
        if ("message" in next) {
          this.dispatch(next.protocol, next.message);
        } else {
          /* A message that cannot be read has no id to answer by: JSON-RPC answers it with a null one. */
          this.send(next.protocol, { jsonrpc: "2.0", id: null, error: { code: next.code, message: next.reason } });
        }
      }
      this.readLength = this.buffer.length;
    });
    input.on("end", end);
  }

  /** Send `protocol`'s notification `method` to its client, holding it until the
   * client's initialize has been answered. Dropped where the protocol has no client yet. */
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
   * taken up to the end of its headers and returned as an invalid request; one
   * whose body is not a JSON-RPC message is taken whole and returned as a parse
   * error or an invalid request.
   */
  private next(): Frame | "over-limit" | undefined {
    const blank = this.buffer.indexOf("\r\n\r\n");
    if (blank < 0) {
      return this.limits !== undefined && this.buffer.length > this.limits.maxHeaderBytes ? "over-limit" : undefined;
    }
    const headers = this.buffer.subarray(0, blank).toString("latin1");
    const named = new RegExp(`^${PROTOCOL_HEADER}: *(\\S+)$`, "im").exec(headers)?.[1];
    const protocol: Protocol = named === "lsp" || named === "bsp" || named === "fabr" ? named : this.defaultProtocol;
    const length = /^content-length: *(\d+)$/im.exec(headers);
    if (length === null) {
      this.buffer = this.buffer.subarray(blank + 4);
      return { protocol, code: INVALID_REQUEST, reason: "a message with no Content-Length" };
    }
    const start = blank + 4;
    if (this.limits !== undefined && Number(length[1]) > this.limits.maxBodyBytes) {
      return "over-limit";
    }
    const end = start + Number(length[1]);
    if (this.buffer.length < end) {
      this.wanted = end;
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

  /** Answer `message` with `protocol`'s handler: a request with its result or
   * error, a notification with nothing; a `$/cancelRequest` aborts the request
   * it names. Once the protocol's initialize is answered, send the
   * notifications held for it. A message with no method (a response) is
   * ignored. */
  private dispatch(protocol: Protocol, message: IMessage): void {
    if (message.method === undefined) {
      return;
    }
    const inFlight = this.inFlight.get(protocol) ?? new Map<number | string, AbortController>();
    this.inFlight.set(protocol, inFlight);
    if (message.method === CANCEL_REQUEST) {
      const params = message.params as { id?: unknown } | undefined;
      const id = params?.id;
      if (typeof id === "number" || typeof id === "string") {
        inFlight.get(id)?.abort();
      }
      return;
    }
    const id = message.id;
    if (id !== undefined && inFlight.has(id)) {
      this.send(protocol, {
        jsonrpc: "2.0",
        id,
        error: { code: INVALID_REQUEST, message: `request ${JSON.stringify(id)} is still in flight` },
      });
      return;
    }
    const controller = new AbortController();
    if (id !== undefined) {
      inFlight.set(id, controller);
    }
    const handler = this.handlers.get(protocol);
    Promise.resolve()
      .then(() => {
        if (handler === undefined) {
          throw new MethodNotFound(`no ${protocol} server`);
        }
        return handler(message.method!, message.params, { ...(id === undefined ? {} : { id }), signal: controller.signal });
      })
      .then(
        result => {
          if (id !== undefined) {
            inFlight.delete(id);
            this.send(protocol, { jsonrpc: "2.0", id, result: result ?? null });
          }
          const held = this.held.get(protocol);
          if (message.method === INITIALIZE[protocol] && held !== undefined) {
            this.held.delete(protocol);
            held.forEach(notification => this.send(protocol, notification));
          }
        },
        (err: unknown) => {
          if (id !== undefined) {
            inFlight.delete(id);
            const error = toError(err);
            this.send(protocol, { jsonrpc: "2.0", id, error: { code: errorCode(error), message: error.message } });
          }
        }
      );
  }

  /** Write `message` as a frame, naming its protocol where it is not the connection's default; nothing once the connection has ended. */
  private send(protocol: Protocol, message: unknown): void {
    if (this.ended) {
      return;
    }
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const tag = protocol === this.defaultProtocol ? "" : `${PROTOCOL_HEADER}: ${protocol}\r\n`;
    this.output.write(`Content-Length: ${body.length}\r\n${tag}\r\n`);
    this.output.write(body);
  }
}

/** @return the JSON-RPC error code `error` is answered with: its class's, else an internal error's. */
function errorCode(error: Error): number {
  if (error instanceof MethodNotFound) {
    return METHOD_NOT_FOUND;
  }
  if (error instanceof InvalidParams) {
    return INVALID_PARAMS;
  }
  if (error instanceof InvalidRequest) {
    return INVALID_REQUEST;
  }
  if (error instanceof ServerNotInitialized) {
    return SERVER_NOT_INITIALIZED;
  }
  if (error instanceof RequestCancelled) {
    return REQUEST_CANCELLED;
  }
  return INTERNAL_ERROR;
}
