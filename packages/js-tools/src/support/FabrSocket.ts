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

/**
 * The client side of the fabr socket: the channel from a process fabr runs as
 * a build step back to that fabr, named in the process's environment as
 * `FABR_SOCKET=<path>#<token>` (core's `support/FabrSocket.ts` serves it;
 * docs' reference/fabr-socket.md is the protocol). Messages are JSON-RPC 2.0,
 * each framed by a `Content-Length` header as LSP frames one.
 *
 * {@link connectFabrSocket} connects and identifies the process by its token;
 * {@link acquireSlots} takes slots of fabr's process limit through it.
 * Wherever the socket cannot be used, they resolve to nothing, and the caller
 * carries on as it would where fabr offers no socket.
 */

import * as net from "node:net";

/** The variable naming the fabr socket and the process's token, `<path>#<token>`: core's
 * `FABR_SOCKET_VARIABLE`, spelled out here since js-tools does not load core. */
export const FABR_SOCKET_VARIABLE = "FABR_SOCKET";

/** An error the fabr socket answered a request with. */
export class FabrSocketError extends Error {
  constructor(
    message: string,
    public readonly code: number
  ) {
    super(message);
  }
}

/** A JSON-RPC message as the client reads one: a response, by its `id`. */
interface IResponse {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

/** A connection to the fabr socket, identified as the process its token names. */
export class FabrSocketClient {
  private nextId = 1;
  private buffered = Buffer.alloc(0);
  private readonly pending = new Map<number, { resolve: (result: unknown) => void; reject: (err: Error) => void }>();
  private closed = false;

  /** What the socket said it serves, in its answer to `fabr/initialize`. */
  public capabilities: Readonly<Record<string, unknown>> = {};

  private constructor(private readonly socket: net.Socket) {
    socket.on("data", (bytes: Buffer) => this.receive(bytes));
    socket.on("close", () => this.end(new Error("the fabr socket closed")));
    socket.on("error", err => this.end(err));
  }

  /** Connect to `path` and identify the process by `token`. Rejects where the socket cannot be reached or refuses the token. */
  public static connect(path: string, token: string): Promise<FabrSocketClient> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(path);
      const client = new FabrSocketClient(socket);
      socket.once("error", reject);
      socket.once("connect", () => {
        client
          .request("fabr/initialize", { token })
          .then(result => {
            const capabilities = (result as { capabilities?: unknown } | null)?.capabilities;
            client.capabilities =
              capabilities !== null && typeof capabilities === "object" ? (capabilities as Record<string, unknown>) : {};
            resolve(client);
          })
          .catch(err => {
            client.close();
            reject(err);
          });
      });
    });
  }

  /** Send the request `method`. @return its result, once answered; rejected with a {@link FabrSocketError} where it is answered with an error, or with an Error where the connection ends first. */
  public request(method: string, params?: object): Promise<unknown> {
    return this.call(method, params).result;
  }

  /** Send the request `method`. @return the id it was sent with, by which a later message names it, and its result as {@link request} answers it. */
  public call(method: string, params?: object): { id: number; result: Promise<unknown> } {
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      if (this.closed) {
        reject(new Error("the fabr socket is closed"));
        return;
      }
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, ...(params === undefined ? {} : { params }) });
    });
    return { id, result };
  }

  /** Send the notification `method`. */
  public notify(method: string, params?: object): void {
    if (!this.closed) {
      this.send({ method, ...(params === undefined ? {} : { params }) });
    }
  }

  /** Close the connection: the socket gives back every slot it holds and withdraws every request not yet answered. */
  public close(): void {
    this.end(new Error("the fabr socket connection was closed"));
    this.socket.end();
  }

  private send(message: object): void {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
    this.socket.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
  }

  /** Take each whole message the bytes complete, answering the request it responds to; end the connection on one that cannot be read. */
  private receive(bytes: Buffer): void {
    this.buffered = Buffer.concat([this.buffered, bytes]);
    for (;;) {
      const end = this.buffered.indexOf("\r\n\r\n");
      if (end < 0) {
        return;
      }
      const length = Number(/content-length:\s*(\d+)/i.exec(this.buffered.subarray(0, end).toString("ascii"))?.[1]);
      if (Number.isNaN(length)) {
        this.close();
        return;
      }
      if (this.buffered.length < end + 4 + length) {
        return;
      }
      let message: IResponse | null;
      try {
        message = JSON.parse(this.buffered.subarray(end + 4, end + 4 + length).toString("utf8")) as IResponse | null;
      } catch {
        this.close();
        return;
      }
      this.buffered = this.buffered.subarray(end + 4 + length);
      const waiting = typeof message?.id === "number" ? this.pending.get(message.id) : undefined;
      if (waiting === undefined) {
        continue;
      }
      this.pending.delete(message!.id as number);
      if (message!.error !== undefined) {
        const { code, message: text } = message!.error;
        waiting.reject(
          new FabrSocketError(
            typeof text === "string" ? text : "the fabr socket refused the request",
            typeof code === "number" ? code : 0
          )
        );
      } else {
        waiting.resolve(message!.result);
      }
    }
  }

  /** Reject every request not yet answered with `err`, once. */
  private end(err: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const waiting of this.pending.values()) {
      waiting.reject(err);
    }
    this.pending.clear();
  }
}

/**
 * Connect to the fabr socket `variable` names, as `<path>#<token>` (by
 * default the process's `FABR_SOCKET`).
 * @return the connection, or undefined where fabr offers no socket, the value
 *   names no token, or the socket cannot be reached or refuses the token.
 */
export function connectFabrSocket(variable = process.env[FABR_SOCKET_VARIABLE]): Promise<FabrSocketClient | undefined> {
  if (variable === undefined || variable === "") {
    return Promise.resolve(undefined);
  }
  const hash = variable.lastIndexOf("#");
  if (hash < 0) {
    return Promise.resolve(undefined);
  }
  return FabrSocketClient.connect(variable.slice(0, hash), variable.slice(hash + 1)).catch(() => undefined);
}

/**
 * Take `count` slots of fabr's process limit (`slots/acquire`), granted
 * together, waiting as long as that takes.
 * @return a function that gives them back (`slots/release`), once granted;
 *   or undefined where the socket refuses them or closes first.
 */
export function acquireSlots(client: FabrSocketClient, count = 1): Promise<(() => void) | undefined> {
  const { id, result } = client.call("slots/acquire", { count });
  return result.then(
    () => () => client.notify("slots/release", { id }),
    () => undefined
  );
}
