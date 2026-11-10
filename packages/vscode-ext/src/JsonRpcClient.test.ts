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
import { JsonRpcClient } from "./JsonRpcClient";

/** @return `message` framed as a server sends it, tagged with `protocol` where one is given. */
function frame(message: unknown, protocol?: string): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n${protocol === undefined ? "" : `Fabr-Protocol: ${protocol}\r\n`}\r\n${body}`;
}

describe("JSON-RPC client", () => {
  it("handles its own protocol's frames alone", async () => {
    const fromServer = new PassThrough();
    const bsp = new JsonRpcClient(new PassThrough(), fromServer);
    const lsp = new JsonRpcClient(new PassThrough(), fromServer, "lsp");
    const seen: string[] = [];
    bsp.onAnyNotification(method => seen.push(`bsp ${method}`));
    lsp.onAnyNotification(method => seen.push(`lsp ${method}`));
    fromServer.write(frame({ jsonrpc: "2.0", method: "a" }) + frame({ jsonrpc: "2.0", method: "b" }, "lsp"));
    await new Promise(resolve => setImmediate(resolve));
    expect(seen).to.deep.equal(["bsp a", "lsp b"]);
  });

  it("stops calling a notification handler once it is disposed", async () => {
    const fromServer = new PassThrough();
    const client = new JsonRpcClient(new PassThrough(), fromServer);
    const seen: string[] = [];
    const dispose = client.onAnyNotification(method => seen.push(method));
    fromServer.write(frame({ jsonrpc: "2.0", method: "first" }));
    await new Promise(resolve => setImmediate(resolve));
    dispose();
    fromServer.write(frame({ jsonrpc: "2.0", method: "second" }));
    await new Promise(resolve => setImmediate(resolve));
    expect(seen).to.deep.equal(["first"]);
  });

  it("drops a malformed frame and goes on reading", async () => {
    const fromServer = new PassThrough();
    const client = new JsonRpcClient(new PassThrough(), fromServer);
    const seen: string[] = [];
    client.onAnyNotification(method => seen.push(method));
    fromServer.write("Content-Length: 5\r\n\r\n{bad}" + "Content-Type: none\r\n\r\n" + frame([1]) + frame({ jsonrpc: "2.0", method: "after" }));
    await new Promise(resolve => setImmediate(resolve));
    expect(seen).to.deep.equal(["after"]);
  });

  it("fails a request still waiting when the server's output ends, and every later one", async () => {
    const fromServer = new PassThrough();
    const client = new JsonRpcClient(new PassThrough(), fromServer);
    const waiting = client.request("slow", {});
    fromServer.end();
    const failed = (request: Promise<unknown>): Promise<string> => request.then(
      () => "resolved",
      (err: Error) => err.message
    );
    expect(await failed(waiting)).to.equal("the server has ended");
    expect(await failed(client.request("later", {}))).to.equal("the server has ended");
  });
});
