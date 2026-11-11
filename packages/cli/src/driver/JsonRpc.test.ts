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

import { expect } from "chai";
import { PassThrough } from "node:stream";
import { InvalidParams, JsonRpcConnection, MethodNotFound, type Protocol } from "./JsonRpc";

/** A message the connection sent, with the protocol its frame named. */
interface ISent {
  protocol: Protocol;
  message: { id?: unknown; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };
}

/** Make a connection over in-memory streams, serving each protocol by echoing what it is asked. */
function connect(): { input: PassThrough; sent: ISent[]; connection: JsonRpcConnection; settle(): Promise<void> } {
  const input = new PassThrough();
  const output = new PassThrough();
  const sent: ISent[] = [];
  let buffer = "";
  output.on("data", (data: Buffer) => {
    buffer += data.toString("utf8");
    for (;;) {
      const blank = buffer.indexOf("\r\n\r\n");
      const length = blank < 0 ? null : /content-length: *(\d+)/i.exec(buffer.slice(0, blank));
      if (length === null || buffer.length < blank + 4 + Number(length[1])) {
        return;
      }
      const tag = /^Fabr-Protocol: *(\S+)$/im.exec(buffer.slice(0, blank))?.[1];
      sent.push({
        protocol: tag === "lsp" ? "lsp" : "bsp",
        message: JSON.parse(buffer.slice(blank + 4, blank + 4 + Number(length[1]))),
      });
      buffer = buffer.slice(blank + 4 + Number(length[1]));
    }
  });
  const connection = new JsonRpcConnection(output);
  for (const protocol of ["bsp", "lsp"] as const) {
    connection.serve(protocol, (method, params) => {
      if (method === "unknown") {
        throw new MethodNotFound(method);
      }
      if (method === "invalid") {
        throw new InvalidParams(method);
      }
      return { protocol, method, params };
    });
  }
  connection.listen(input, () => {});
  return { input, sent, connection, settle: () => new Promise(resolve => setTimeout(resolve, 10)) };
}

/** @return `message` framed as the connection reads it, tagged with `protocol` where that is not BSP. */
function frame(message: unknown, protocol?: Protocol): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n${protocol === "lsp" ? "Fabr-Protocol: lsp\r\n" : ""}\r\n${body}`;
}

describe("JSON-RPC connection", () => {
  it("answers each protocol's requests by its own server, in frames naming that protocol", async () => {
    const { input, sent, settle } = connect();
    input.write(frame({ jsonrpc: "2.0", id: 1, method: "ping", params: 1 }));
    input.write(frame({ jsonrpc: "2.0", id: 2, method: "ping", params: 2 }, "lsp"));
    await settle();
    expect(sent).to.deep.equal([
      { protocol: "bsp", message: { jsonrpc: "2.0", id: 1, result: { protocol: "bsp", method: "ping", params: 1 } } },
      { protocol: "lsp", message: { jsonrpc: "2.0", id: 2, result: { protocol: "lsp", method: "ping", params: 2 } } },
    ]);
  });

  it("reads a frame split across chunks, and several in one", async () => {
    const { input, sent, settle } = connect();
    const both = frame({ jsonrpc: "2.0", id: 1, method: "a" }) + frame({ jsonrpc: "2.0", id: 2, method: "b" });
    input.write(both.slice(0, 7));
    input.write(both.slice(7));
    await settle();
    expect(sent.map(({ message }) => message.id)).to.deep.equal([1, 2]);
  });

  it("holds each protocol's notifications until its own initialize is answered, and drops those of a protocol with no client", async () => {
    const { input, sent, connection, settle } = connect();
    connection.notify("early", 1);
    connection.notify("unheard", 2, "lsp");
    input.write(frame({ jsonrpc: "2.0", method: "$/hello" }, "lsp"));
    await settle();
    connection.notify("early", 3, "lsp");
    input.write(frame({ jsonrpc: "2.0", id: 1, method: "initialize" }, "lsp"));
    await settle();
    expect(sent.map(({ protocol, message }) => [protocol, message.method ?? message.id])).to.deep.equal([
      ["lsp", 1],
      ["lsp", "early"],
    ]);
    expect(sent[1].message.params).to.equal(3);
    input.write(frame({ jsonrpc: "2.0", id: 2, method: "build/initialize" }));
    await settle();
    expect(sent.slice(2).map(({ protocol, message }) => [protocol, message.method ?? message.id])).to.deep.equal([
      ["bsp", 2],
      ["bsp", "early"],
    ]);
  });

  it("answers a request no server has with method not found, and parameters it cannot take with invalid params", async () => {
    const { input, sent, settle } = connect();
    input.write(frame({ jsonrpc: "2.0", id: 1, method: "unknown" }));
    input.write(frame({ jsonrpc: "2.0", id: 2, method: "invalid" }));
    await settle();
    expect(sent.map(({ message }) => [message.id, message.error?.code])).to.deep.equal([
      [1, -32601],
      [2, -32602],
    ]);
  });

  it("answers a malformed frame with JSON-RPC's error and goes on reading", async () => {
    const { input, sent, settle } = connect();
    input.write("Content-Length: 5\r\n\r\n{bad}");
    input.write("Content-Type: nothing\r\n\r\n");
    input.write(frame([1, 2]));
    input.write(frame({ jsonrpc: "2.0", id: 1, method: "ping" }));
    await settle();
    expect(sent.map(({ message }) => message.error?.code ?? message.id)).to.deep.equal([-32700, -32600, -32600, 1]);
    expect(sent.slice(0, 3).every(({ message }) => message.id === null)).to.equal(true);
  });
});
