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

/** A Build Server Protocol client: JSON-RPC over a server's stdio, framed as LSP frames it. */
export class BspClient {
  private buffer = Buffer.alloc(0);
  private id = 0;
  private readonly pending = new Map<number, { resolve(result: unknown): void; reject(err: Error): void }>();
  private readonly handlers = new Map<string, Array<(params: unknown) => void>>();
  private readonly anyHandlers: Array<(method: string, params: unknown) => void> = [];

  constructor(
    private readonly output: NodeJS.WritableStream,
    input: NodeJS.ReadableStream
  ) {
    input.on("data", (data: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      for (let message = this.next(); message !== undefined; message = this.next()) {
        this.receive(message);
      }
    });
  }

  /** Send request `method`, resolving with its result. */
  public request<T>(method: string, params: unknown): Promise<T> {
    this.id += 1;
    const id = this.id;
    return new Promise<T>((resolve, reject) => {
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

  private next(): { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } } | undefined {
    const blank = this.buffer.indexOf("\r\n\r\n");
    if (blank < 0) {
      return undefined;
    }
    const length = /^content-length: *(\d+)$/im.exec(this.buffer.subarray(0, blank).toString("latin1"));
    const end = blank + 4 + Number(length?.[1] ?? 0);
    if (length === null || this.buffer.length < end) {
      return undefined;
    }
    const message = JSON.parse(this.buffer.subarray(blank + 4, end).toString("utf8"));
    this.buffer = this.buffer.subarray(end);
    return message;
  }

  private receive(message: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } }): void {
    if (message.method !== undefined) {
      for (const handler of this.handlers.get(message.method) ?? []) {
        handler(message.params);
      }
      for (const handler of this.anyHandlers) {
        handler(message.method, message.params);
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
    this.output.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.output.write(body);
  }
}
