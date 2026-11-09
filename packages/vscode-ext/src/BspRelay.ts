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


/**
 * The project's build server, shared with other clients in the window — the
 * Java language server's fabr importer — over a Unix socket: each connection
 * is a BSP session of its own, `build/initialize` answered with what the
 * server answered the extension, every other request forwarded to the server,
 * and every notification the server sends passed on.
 */

import * as fs from "fs";
import * as net from "net";
import { type JsonRpcClient, takeFrame } from "./JsonRpcClient";

/** A JSON-RPC message, as a connection reads it. */
interface IMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
}

/**
 * Serve `client`'s server at the socket `socket`, `initialized` the result of
 * its `build/initialize`.
 *
 * @return the relay, once it is listening.
 */
export function relayBuildServer(client: JsonRpcClient, initialized: unknown, socket: string): Promise<net.Server> {
  const connections = new Set<net.Socket>();
  client.onAnyNotification((method, params) => {
    for (const connection of connections) {
      send(connection, { jsonrpc: "2.0", method, params });
    }
  });
  fs.rmSync(socket, { force: true });
  const server = net.createServer(connection => {
    connections.add(connection);
    connection.on("close", () => connections.delete(connection));
    connection.on("error", () => connections.delete(connection));
    readMessages(connection, message => {
      if (message.method === undefined || message.id === undefined) {
        if (message.method === "build/exit") {
          connection.end();
        }
        return;
      }
      const answer =
        message.method === "build/initialize"
          ? Promise.resolve(initialized)
          : message.method === "build/shutdown"
            ? Promise.resolve(null)
            : client.request(message.method, message.params);
      answer.then(
        result => send(connection, { jsonrpc: "2.0", id: message.id, result: result ?? null }),
        (err: unknown) => send(connection, { jsonrpc: "2.0", id: message.id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } })
      );
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

/** @return `json` as a JSON-RPC message, or undefined where it is none: an object whose `id` and `method`, where it has them, are a number or string and a string. */
function toMessage(json: unknown): IMessage | undefined {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return undefined;
  }
  const { id, method, params } = json as Record<string, unknown>;
  if ((id !== undefined && typeof id !== "number" && typeof id !== "string") || (method !== undefined && typeof method !== "string")) {
    return undefined;
  }
  return { ...(id === undefined ? {} : { id }), ...(method === undefined ? {} : { method }), params };
}

/** Call `receive` with each message read from `input`, a frame that holds none skipped. */
function readMessages(input: net.Socket, receive: (message: IMessage) => void): void {
  let buffer = Buffer.alloc(0);
  input.on("data", (data: Buffer) => {
    buffer = Buffer.concat([buffer, data]);
    for (let frame = takeFrame(buffer); frame !== undefined; frame = takeFrame(buffer)) {
      buffer = frame.rest;
      const message = toMessage(frame.json);
      if (message !== undefined) {
        receive(message);
      }
    }
  });
}

function send(output: net.Socket, message: unknown): void {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  output.write(`Content-Length: ${body.length}\r\n\r\n`);
  output.write(body);
}
