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

import { expect } from "chai";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { BspClient } from "./BspClient";
import { relayBuildServer } from "./BspRelay";

/** Frame `message` as LSP frames it. */
function frame(message: unknown): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

/** Read the messages framed on `input`, one `next()` at a time. */
function reader(input: NodeJS.ReadableStream): () => Promise<Record<string, unknown>> {
  let buffer = "";
  const read: Array<Record<string, unknown>> = [];
  const waiting: Array<(message: Record<string, unknown>) => void> = [];
  input.on("data", (data: Buffer) => {
    buffer += data.toString("utf8");
    for (let match = /^Content-Length: (\d+)\r\n\r\n/.exec(buffer); match !== null; match = /^Content-Length: (\d+)\r\n\r\n/.exec(buffer)) {
      const end = match[0].length + Number(match[1]);
      if (buffer.length < end) {
        return;
      }
      const message = JSON.parse(buffer.slice(match[0].length, end));
      buffer = buffer.slice(end);
      const next = waiting.shift();
      if (next) {
        next(message);
      } else {
        read.push(message);
      }
    }
  });
  return () => {
    const message = read.shift();
    return message ? Promise.resolve(message) : new Promise(resolve => waiting.push(resolve));
  };
}

/* A server reached through the extension's client, and a second client
 * connected to the relay. */
describe("build server relay", () => {
  let socket: string;
  let relay: net.Server;
  let toServer: () => Promise<Record<string, unknown>>;
  let fromServer: PassThrough;
  let connection: net.Socket;
  let fromRelay: () => Promise<Record<string, unknown>>;

  beforeEach(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-relay-"));
    socket = path.join(dir, "bsp.sock");
    const toServerStream = new PassThrough();
    fromServer = new PassThrough();
    toServer = reader(toServerStream);
    relay = await relayBuildServer(new BspClient(toServerStream, fromServer), { displayName: "fabr", data: { root: "file:///p/" } }, socket);
    connection = net.connect(socket);
    fromRelay = reader(connection);
  });
  afterEach(() => {
    connection.destroy();
    relay.close();
    fs.rmSync(path.dirname(socket), { recursive: true, force: true });
  });

  it("answers initialize with the server's own answer, without asking it", async () => {
    connection.write(frame({ jsonrpc: "2.0", id: 7, method: "build/initialize", params: {} }));
    expect(await fromRelay()).to.deep.equal({ jsonrpc: "2.0", id: 7, result: { displayName: "fabr", data: { root: "file:///p/" } } });
  });

  it("forwards a request to the server and its answer back, under the client's own id", async () => {
    connection.write(frame({ jsonrpc: "2.0", id: "a", method: "workspace/buildTargets", params: {} }));
    const forwarded = await toServer();
    expect(forwarded.method).to.equal("workspace/buildTargets");
    fromServer.write(frame({ jsonrpc: "2.0", id: forwarded.id, result: { targets: [] } }));
    expect(await fromRelay()).to.deep.equal({ jsonrpc: "2.0", id: "a", result: { targets: [] } });
  });

  it("passes on what the server notifies", async () => {
    connection.write(frame({ jsonrpc: "2.0", id: 1, method: "build/initialize", params: {} }));
    await fromRelay();
    fromServer.write(frame({ jsonrpc: "2.0", method: "buildTarget/didChange", params: { changes: [] } }));
    expect(await fromRelay()).to.deep.equal({ jsonrpc: "2.0", method: "buildTarget/didChange", params: { changes: [] } });
  });
});
