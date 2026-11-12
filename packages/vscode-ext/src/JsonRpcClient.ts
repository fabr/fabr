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

/** A JSON-RPC message, as a client reads one. */
/** A JSON-RPC message, as a connection reads one. */
export interface IMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message: string };
}

/** @return `json` as a JSON-RPC message, or undefined where it is none: an object whose `id` and `method`, where it has them, are a number or a string and a string. */
export function toMessage(json: unknown): IMessage | undefined {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return undefined;
  }
  const { id, method, params, result, error } = json as Record<string, unknown>;
  if (
    (id !== undefined && id !== null && typeof id !== "number" && typeof id !== "string") ||
    (method !== undefined && typeof method !== "string")
  ) {
    return undefined;
  }
  const message =
    typeof error === "object" && error !== null ? String((error as Record<string, unknown>).message ?? "error") : undefined;
  return {
    ...(typeof id === "number" || typeof id === "string" ? { id } : {}),
    ...(method === undefined ? {} : { method }),
    params,
    result,
    ...(message === undefined ? {} : { error: { message } }),
  };
}

/** @return the offset at which the first frame in `buffer` ends, where its
 * headers are whole and state its length, otherwise undefined. */
function frameEnd(buffer: Buffer, blank: number): number | undefined {
  const length = /^content-length: *(\d+)$/im.exec(buffer.subarray(0, blank).toString("latin1"));
  return length === null ? undefined : blank + 4 + Number(length[1]);
}

/**
 * Read the first frame in `buffer`, framed by a `Content-Length` header as LSP
 * frames one.
 *
 * @return the frame's `fabr-protocol` header, its body parsed as JSON (absent
 * where it is none), and what follows it in `rest`; or undefined where `buffer`
 * holds no whole frame yet. A frame whose headers state no length is taken up
 * to the end of its headers, with no body, so a malformed frame never stops
 * the reading.
 */
function takeFrame(buffer: Buffer): { rest: Buffer; protocol?: string; json?: unknown } | undefined {
  const blank = buffer.indexOf("\r\n\r\n");
  if (blank < 0) {
    return undefined;
  }
  const protocol = /^fabr-protocol: *(\S+)$/im.exec(buffer.subarray(0, blank).toString("latin1"))?.[1];
  const end = frameEnd(buffer, blank);
  if (end === undefined) {
    return { rest: buffer.subarray(blank + 4), protocol };
  }
  if (buffer.length < end) {
    return undefined;
  }
  const rest = buffer.subarray(end);
  try {
    return { rest, protocol, json: JSON.parse(buffer.subarray(blank + 4, end).toString("utf8")) };
  } catch {
    return { rest, protocol };
  }
}

/**
 * Call `receive` with each message read from `input` and the `fabr-protocol`
 * its frame names, a frame that holds none skipped. The data is joined into one
 * buffer only once a frame can be whole.
 */
export function readMessages(input: NodeJS.ReadableStream, receive: (message: IMessage, protocol?: string) => void): void {
  let buffer = Buffer.alloc(0);
  let chunks: Buffer[] = [];
  let held = 0;
  let wanted = 0;
  input.on("data", (data: Buffer) => {
    chunks.push(data);
    held += data.length;
    if (held < wanted) {
      return;
    }
    buffer = Buffer.concat([buffer, ...chunks]);
    chunks = [];
    for (let frame = takeFrame(buffer); frame !== undefined; frame = takeFrame(buffer)) {
      buffer = frame.rest;
      const message = toMessage(frame.json);
      if (message !== undefined) {
        receive(message, frame.protocol);
      }
    }
    held = buffer.length;
    const blank = buffer.indexOf("\r\n\r\n");
    wanted = blank < 0 ? 0 : (frameEnd(buffer, blank) ?? 0);
  });
}

/**
 * A JSON-RPC client over a server's stdio, each message framed by a
 * `Content-Length` header as LSP frames one, of one of the protocols the
 * server carries: BSP's, whose frames are untagged, or
 * another's, named in each frame's `Fabr-Protocol` header. A client handles
 * its own protocol's frames alone, so several can share one server's streams.
 */
export class JsonRpcClient {
  private id = 0;
  private readonly pending = new Map<number, { resolve(result: unknown): void; reject(err: Error): void }>();
  private readonly handlers = new Map<string, Array<(params: unknown) => void>>();
  private readonly anyHandlers: Array<(method: string, params: unknown) => void> = [];
  /** True once the server's output has ended: a request then fails at once. */
  private ended = false;

  constructor(
    private readonly output: NodeJS.WritableStream,
    input: NodeJS.ReadableStream,
    private readonly protocol?: string
  ) {
    readMessages(input, (message, protocol) => {
      if (protocol === this.protocol) {
        this.receive(message);
      }
    });
    input.on("close", () => this.end());
    input.on("end", () => this.end());
  }

  /** Fail every request still waiting, and every later one: the server has gone. */
  private end(): void {
    this.ended = true;
    for (const { reject } of this.pending.values()) {
      reject(new Error("the server has ended"));
    }
    this.pending.clear();
  }

  /** Send request `method`, resolving with its result. */
  public request<T>(method: string, params: unknown): Promise<T> {
    this.id += 1;
    const id = this.id;
    return new Promise<T>((resolve, reject) => {
      if (this.ended) {
        reject(new Error("the server has ended"));
        return;
      }
      this.pending.set(id, { resolve: result => resolve(result as T), reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Send notification `method`. */
  public notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** Call `handler` with each notification `method` the server sends. */
  public onNotification(method: string, handler: (params: unknown) => void): void {
    this.handlers.set(method, [...(this.handlers.get(method) ?? []), handler]);
  }

  /** Call `handler` with every notification the server sends, until the disposer returned is called. */
  public onAnyNotification(handler: (method: string, params: unknown) => void): () => void {
    this.anyHandlers.push(handler);
    return () => {
      const at = this.anyHandlers.indexOf(handler);
      if (at >= 0) {
        this.anyHandlers.splice(at, 1);
      }
    };
  }

  private receive(message: IMessage): void {
    if (message.method !== undefined) {
      const method = message.method;
      /* A handler's failure is reported as the host reports any, and does not stop the reading. */
      const call = (handler: () => void): void => {
        try {
          handler();
        } catch (err) {
          queueMicrotask(() => {
            throw err;
          });
        }
      };
      for (const handler of this.handlers.get(method) ?? []) {
        call(() => handler(message.params));
      }
      for (const handler of this.anyHandlers) {
        call(() => handler(method, message.params));
      }
      return;
    }
    const id = message.id;
    const waiting = typeof id === "number" ? this.pending.get(id) : undefined;
    if (waiting !== undefined) {
      this.pending.delete(id as number);
      if (message.error !== undefined) {
        waiting.reject(new Error(message.error.message));
      } else {
        waiting.resolve(message.result);
      }
    }
  }

  private send(message: unknown): void {
    sendMessage(this.output, message, this.protocol);
  }
}

/** Write `message` to `output`, framed by a `Content-Length` header as LSP frames one, tagged with `protocol` where it is not BSP's. */
export function sendMessage(output: NodeJS.WritableStream, message: unknown, protocol?: string): void {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  output.write(`Content-Length: ${body.length}\r\n${protocol === undefined ? "" : `Fabr-Protocol: ${protocol}\r\n`}\r\n`);
  output.write(body);
}
