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
import type { BspClient } from "./BspClient";

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
export function relayBuildServer(client: BspClient, initialized: unknown, socket: string): Promise<net.Server> {
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

/** Call `receive` with each message read from `input`, framed as LSP frames it. */
function readMessages(input: net.Socket, receive: (message: IMessage) => void): void {
  let buffer = Buffer.alloc(0);
  input.on("data", (data: Buffer) => {
    buffer = Buffer.concat([buffer, data]);
    for (;;) {
      const blank = buffer.indexOf("\r\n\r\n");
      const length = blank < 0 ? null : /^content-length: *(\d+)$/im.exec(buffer.subarray(0, blank).toString("latin1"));
      const end = length === null ? 0 : blank + 4 + Number(length[1]);
      if (length === null || buffer.length < end) {
        return;
      }
      const message = JSON.parse(buffer.subarray(blank + 4, end).toString("utf8")) as IMessage;
      buffer = buffer.subarray(end);
      receive(message);
    }
  });
}

function send(output: net.Socket, message: unknown): void {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  output.write(`Content-Length: ${body.length}\r\n\r\n`);
  output.write(body);
}
