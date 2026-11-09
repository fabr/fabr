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
interface IMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message: string };
}

/** @return `json` as a JSON-RPC message, or undefined where it is none: an object whose `id` and `method`, where it has them, are a number and a string. */
function toMessage(json: unknown): IMessage | undefined {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return undefined;
  }
  const { id, method, params, result, error } = json as Record<string, unknown>;
  if ((id !== undefined && id !== null && typeof id !== "number") || (method !== undefined && typeof method !== "string")) {
    return undefined;
  }
  const message = typeof error === "object" && error !== null ? String((error as Record<string, unknown>).message ?? "error") : undefined;
  return {
    ...(typeof id === "number" ? { id } : {}),
    ...(method === undefined ? {} : { method }),
    params,
    result,
    ...(message === undefined ? {} : { error: { message } }),
  };
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
export function takeFrame(buffer: Buffer): { rest: Buffer; protocol?: string; json?: unknown } | undefined {
  const blank = buffer.indexOf("\r\n\r\n");
  if (blank < 0) {
    return undefined;
  }
  const headers = buffer.subarray(0, blank).toString("latin1");
  const protocol = /^fabr-protocol: *(\S+)$/im.exec(headers)?.[1];
  const length = /^content-length: *(\d+)$/im.exec(headers);
  if (length === null) {
    return { rest: buffer.subarray(blank + 4), protocol };
  }
  const end = blank + 4 + Number(length[1]);
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
 * A JSON-RPC client over a server's stdio, each message framed by a
 * `Content-Length` header as LSP frames one, of one of the protocols the
 * server carries: BSP's, whose frames are untagged, or
 * another's, named in each frame's `Fabr-Protocol` header. A client handles
 * its own protocol's frames alone, so several can share one server's streams.
 */
export class JsonRpcClient {
  private buffer = Buffer.alloc(0);
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
    input.on("data", (data: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      for (let next = this.next(); next !== undefined; next = this.next()) {
        if (next.message !== undefined && next.protocol === this.protocol) {
          this.receive(next.message);
        }
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

  /** Call `handler` with every notification the server sends. */
  public onAnyNotification(handler: (method: string, params: unknown) => void): void {
    this.anyHandlers.push(handler);
  }

  /** @return the next frame in the buffer, taken from it, as {@link takeFrame} reads one. */
  private next(): { protocol?: string; message?: IMessage } | undefined {
    const frame = takeFrame(this.buffer);
    if (frame === undefined) {
      return undefined;
    }
    this.buffer = frame.rest;
    return { protocol: frame.protocol, message: toMessage(frame.json) };
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
    const waiting = message.id === undefined ? undefined : this.pending.get(message.id);
    if (waiting !== undefined) {
      this.pending.delete(message.id!);
      if (message.error !== undefined) {
        waiting.reject(new Error(message.error.message));
      } else {
        waiting.resolve(message.result);
      }
    }
  }

  private send(message: unknown): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.output.write(`Content-Length: ${body.length}\r\n${this.protocol === undefined ? "" : `Fabr-Protocol: ${this.protocol}\r\n`}\r\n`);
    this.output.write(body);
  }
}
