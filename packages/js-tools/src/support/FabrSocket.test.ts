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
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { acquireSlots, connectFabrSocket, FabrSocketError } from "./FabrSocket";

/** A message the stand-in server read. */
interface IReceived {
  id?: number;
  method: string;
  params?: { token?: string; count?: number; id?: number };
}

/**
 * Start a stand-in for fabr's socket at a fresh path: it answers
 * `fabr/initialize` for the token `good`, grants `slots/acquire` where `grant`
 * says so (else refuses it), and records every message it reads.
 */
function standIn(
  grant: (count: number) => boolean
): Promise<{ variable: (token: string) => string; received: IReceived[]; close(): void }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-client-"));
  const socketPath = path.join(dir, "fabr.sock");
  const received: IReceived[] = [];
  const server = net.createServer(socket => {
    let buffered = "";
    const send = (message: object): void => {
      const body = JSON.stringify({ jsonrpc: "2.0", ...message });
      socket.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    };
    socket.on("data", chunk => {
      buffered += chunk.toString("utf8");
      for (
        let match = /^Content-Length: (\d+)\r\n\r\n/.exec(buffered);
        match;
        match = /^Content-Length: (\d+)\r\n\r\n/.exec(buffered)
      ) {
        const end = match[0].length + Number(match[1]);
        if (buffered.length < end) {
          return;
        }
        const message = JSON.parse(buffered.slice(match[0].length, end)) as IReceived;
        buffered = buffered.slice(end);
        received.push(message);
        if (message.method === "fabr/initialize") {
          send(
            message.params?.token === "good"
              ? { id: message.id, result: { server: { name: "fabr" }, protocol: 1, capabilities: { slots: {} } } }
              : { id: message.id, error: { code: -32602, message: "unknown token" } }
          );
        } else if (message.method === "slots/acquire") {
          send(
            grant(message.params?.count ?? 1)
              ? { id: message.id, result: {} }
              : { id: message.id, error: { code: -32602, message: "no" } }
          );
        }
      }
    });
  });
  return new Promise(resolve =>
    server.listen(socketPath, () =>
      resolve({
        variable: token => `${socketPath}#${token}`,
        received,
        close: () => {
          server.close();
          fs.rmSync(dir, { recursive: true, force: true });
        },
      })
    )
  );
}

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 20));

describe("connectFabrSocket", () => {
  it("identifies the process by its token, and reads what the socket serves", async () => {
    const server = await standIn(() => true);
    try {
      const client = await connectFabrSocket(server.variable("good"));
      expect(client?.capabilities).to.deep.equal({ slots: {} });
      expect(server.received[0]).to.deep.include({ method: "fabr/initialize", params: { token: "good" } });
      client?.close();
    } finally {
      server.close();
    }
  });

  it("resolves no connection where there is no socket, it cannot be reached, or it refuses the token", async () => {
    const server = await standIn(() => true);
    try {
      expect(await connectFabrSocket("")).to.equal(undefined);
      expect(await connectFabrSocket(`${path.join(os.tmpdir(), "fabr-no-such-socket")}#good`)).to.equal(undefined);
      expect(await connectFabrSocket(server.variable("bad"))).to.equal(undefined);
    } finally {
      server.close();
    }
  });

  it("rejects a request answered with an error, with its code", async () => {
    const server = await standIn(() => false);
    try {
      const client = (await connectFabrSocket(server.variable("good")))!;
      const err = await client.request("slots/acquire", { count: 1 }).catch(e => e);
      expect(err).to.be.instanceOf(FabrSocketError);
      expect((err as FabrSocketError).code).to.equal(-32602);
      client.close();
    } finally {
      server.close();
    }
  });
});

describe("acquireSlots", () => {
  it("takes the slots asked for, and gives them back by the request's id", async () => {
    const server = await standIn(() => true);
    try {
      const client = (await connectFabrSocket(server.variable("good")))!;
      const release = await acquireSlots(client, 2);
      expect(release).to.be.a("function");
      release!();
      await settle();
      const acquire = server.received.find(message => message.method === "slots/acquire")!;
      expect(acquire.params).to.deep.equal({ count: 2 });
      expect(server.received.find(message => message.method === "slots/release")?.params).to.deep.equal({ id: acquire.id });
      client.close();
    } finally {
      server.close();
    }
  });

  it("resolves nothing where the socket refuses the slots", async () => {
    const server = await standIn(() => false);
    try {
      const client = (await connectFabrSocket(server.variable("good")))!;
      expect(await acquireSlots(client, 2)).to.equal(undefined);
      client.close();
    } finally {
      server.close();
    }
  });
});
