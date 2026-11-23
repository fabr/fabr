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
import * as net from "net";
import { Computable } from "../core/Computable";
import { FABR_SOCKET_VARIABLE, IRegisteredProcess, registerProcess } from "./FabrSocket";
import { Semaphore } from "./Semaphore";

/** A client of the fabr socket: the responses it has had, by request id, and how to send requests and notifications. */
interface IClient {
  responses: Map<number | null, { result?: object; error?: { code: number; message: string } }>;
  request(id: number | null, method: string, params?: object): void;
  notify(method: string, params?: object): void;
  sendRaw(text: string): void;
  closed(): boolean;
  close(): Promise<void>;
}

function connect(registered: IRegisteredProcess, initialize = true): IClient {
  const [socketPath, token] = registered.env[FABR_SOCKET_VARIABLE].split("#");
  const socket = net.connect(socketPath);
  const responses: IClient["responses"] = new Map();
  let buffered = "";
  let closed = false;
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffered += chunk;
    for (let match = /^Content-Length: (\d+)\r\n\r\n/.exec(buffered); match; match = /^Content-Length: (\d+)\r\n\r\n/.exec(buffered)) {
      const end = match[0].length + Number(match[1]);
      if (buffered.length < end) {
        return;
      }
      const message = JSON.parse(buffered.slice(match[0].length, end));
      responses.set(message.id, message);
      buffered = buffered.slice(end);
    }
  });
  socket.on("close", () => (closed = true));
  const send = (message: object): void => {
    const body = JSON.stringify({ jsonrpc: "2.0", ...message });
    socket.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };
  if (initialize) {
    send({ id: 0, method: "fabr/initialize", params: { token } });
  }
  return {
    responses,
    request: (id, method, params) => send({ id, method, params }),
    notify: (method, params) => send({ method, params }),
    sendRaw: text => socket.write(text),
    closed: () => closed,
    close: () => new Promise(resolve => socket.end(resolve)),
  };
}

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 50));

function toPromise<T>(computable: Computable<T>): Promise<T> {
  return new Promise((resolve, reject) => computable.then(resolve, reject));
}

/** @return true if request `id` has been granted its slot, otherwise false. */
const granted = (client: IClient, id: number): boolean => client.responses.get(id)?.result !== undefined;

describe("registerProcess", () => {
  it("names the socket and the process's token, and the handshake answers with the server's capabilities", async () => {
    const registered = await toPromise(registerProcess((work, count, signal) => new Semaphore(1).run(work, count, signal)));
    try {
      expect(registered.env[FABR_SOCKET_VARIABLE]).to.match(/#[0-9a-f]{32}$/);
      const client = connect(registered);
      await settle();
      expect(client.responses.get(0)).to.deep.include({
        result: { server: { name: "fabr" }, protocol: 1, capabilities: { slots: {} } },
      });
      await client.close();
    } finally {
      registered.unregister();
    }
  });

  it("lends the process's own slot first, then grants the limit's as they come free, oldest request first", async () => {
    /* A limit of two: the process holds one, so one more is free. */
    const limit = new Semaphore(2);
    let endProcess = (): void => undefined;
    void limit.run(() => Computable.from<void>(resolve => (endProcess = () => resolve())));
    const registered = await toPromise(registerProcess((work, count, signal) => limit.run(work, count, signal)));
    try {
      const [first, second, third] = [connect(registered), connect(registered), connect(registered)];
      await settle();
      first.request(1, "slots/acquire");
      await settle();
      second.request(1, "slots/acquire");
      await settle();
      third.request(1, "slots/acquire");
      third.request(2, "slots/acquire");
      await settle();
      expect([granted(first, 1), granted(second, 1), granted(third, 1), granted(third, 2)]).to.deep.equal([true, true, false, false]);
      /* The process's own slot, given back, goes to the oldest waiting request. */
      first.notify("slots/release", { id: 1 });
      await settle();
      expect([granted(third, 1), granted(third, 2)]).to.deep.equal([true, false]);
      /* A slot of the limit, given back by closing, goes to the limit's next waiter. */
      await second.close();
      await settle();
      expect(granted(third, 2)).to.equal(true);
      await Promise.all([first.close(), third.close()]);
      await settle();
      /* Every slot back: the process's own, and the limit's free one. */
      const later = connect(registered);
      await settle();
      later.request(1, "slots/acquire");
      later.request(2, "slots/acquire");
      await settle();
      expect([granted(later, 1), granted(later, 2)]).to.deep.equal([true, true]);
      await later.close();
    } finally {
      registered.unregister();
      endProcess();
    }
  });

  it("withdraws a cancelled or released waiting request, and refuses a request before the handshake, an unknown method and an unknown token", async () => {
    const limit = new Semaphore(1);
    const registered = await toPromise(registerProcess((work, count, signal) => limit.run(work, count, signal)));
    try {
      const client = connect(registered);
      await settle();
      client.request(1, "slots/acquire");
      client.request(2, "slots/acquire");
      client.request(3, "slots/acquire");
      await settle();
      expect([granted(client, 1), granted(client, 2), granted(client, 3)], "the own slot, the limit's one, none").to.deep.equal([
        true,
        true,
        false,
      ]);
      client.notify("$/cancelRequest", { id: 3 });
      client.request(4, "slots/unknown");
      client.request(5, "slots/acquire");
      await settle();
      expect(client.responses.get(3)?.error?.code).to.equal(-32800);
      /* Released while it waits, a request is withdrawn as a cancel withdraws it. */
      client.notify("slots/release", { id: 5 });
      await settle();
      expect(client.responses.get(5)?.error?.code).to.equal(-32800);
      expect(client.responses.get(4)?.error?.code).to.equal(-32601);
      const early = connect(registered, false);
      early.request(1, "slots/acquire");
      await settle();
      expect(early.responses.get(1)?.error?.code).to.equal(-32002);
      const stranger = connect({
        env: { [FABR_SOCKET_VARIABLE]: `${registered.env[FABR_SOCKET_VARIABLE].split("#")[0]}#nope` },
        unregister: () => undefined,
      });
      await settle();
      expect(stranger.responses.get(0)?.error?.message).to.contain("unknown token");
      stranger.request(1, "slots/acquire");
      await settle();
      expect(stranger.responses.get(1)?.error?.code, "still not initialized").to.equal(-32002);
      await Promise.all([client.close(), early.close()]);
    } finally {
      registered.unregister();
    }
  });

  it("refuses a reused request id, a second initialize, a batch and a body that is no message, and closes a connection sending an oversized one", async () => {
    const limit = new Semaphore(2);
    const registered = await toPromise(registerProcess((work, count, signal) => limit.run(work, count, signal)));
    try {
      const client = connect(registered);
      await settle();
      client.request(1, "slots/acquire");
      client.request(2, "slots/acquire");
      await settle();
      expect([granted(client, 1), granted(client, 2)]).to.deep.equal([true, true]);
      /* Id 1 is still held: refused, and nothing more is taken. */
      client.request(1, "slots/acquire");
      client.request(null, "slots/acquire");
      client.request(3, "fabr/initialize", { token: registered.env[FABR_SOCKET_VARIABLE].split("#")[1] });
      client.sendRaw("Content-Length: 2\r\n\r\n[]");
      await settle();
      expect(client.responses.get(1)?.error?.code, "id 1 reused").to.equal(-32600);
      expect(client.responses.get(null)?.error?.code, "the batch, then the null id, refused").to.equal(-32600);
      expect(client.responses.get(3)?.error?.code).to.equal(-32600);
      /* Released, id 1 is free again, and both slots come back on closing. */
      client.notify("slots/release", { id: 1 });
      await settle();
      client.request(1, "slots/acquire");
      await settle();
      expect(client.responses.get(1)?.result).to.deep.equal({});
      await client.close();
      for (const [body, code] of [
        ["null", -32600],
        ["42", -32600],
        ["{not json", -32700],
      ] as const) {
        const odd = connect(registered);
        odd.sendRaw(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
        await settle();
        expect(odd.responses.get(null)?.error?.code, body).to.equal(code);
        expect(odd.closed(), body).to.equal(false);
        await odd.close();
      }
      const huge = connect(registered, false);
      huge.sendRaw("Content-Length: 99999999999\r\n\r\n{");
      await settle();
      expect(huge.closed(), "an oversized body").to.equal(true);
      /* The server is still serving: a new connection gets both slots. */
      const later = connect(registered);
      await settle();
      later.request(1, "slots/acquire");
      later.request(2, "slots/acquire");
      await settle();
      expect([granted(later, 1), granted(later, 2)]).to.deep.equal([true, true]);
      await later.close();
    } finally {
      registered.unregister();
    }
  });

  it("takes a request's count of slots from the limit together, the process's own slot whatever its count", async () => {
    /* A limit of five: the process holds one, so four are free. */
    const limit = new Semaphore(5);
    let endProcess = (): void => undefined;
    void limit.run(() => Computable.from<void>(resolve => (endProcess = () => resolve())));
    const registered = await toPromise(registerProcess((work, count, signal) => limit.run(work, count, signal)));
    try {
      const client = connect(registered);
      await settle();
      client.request(1, "slots/acquire", { count: 2 });
      await settle();
      client.request(2, "slots/acquire", { count: 2 });
      await settle();
      client.request(3, "slots/acquire", { count: 3 });
      client.request(4, "slots/acquire");
      client.request(5, "slots/acquire", { count: 0 });
      await settle();
      expect(
        [1, 2, 3, 4].map(id => granted(client, id)),
        "own, two of four, then three waits with one behind it"
      ).to.deep.equal([true, true, false, false]);
      expect(client.responses.get(5)?.error?.code).to.equal(-32602);
      client.notify("slots/release", { id: 2 });
      await settle();
      expect([granted(client, 3), granted(client, 4)], "four free: three, then one").to.deep.equal([true, true]);
      await client.close();
    } finally {
      registered.unregister();
      endProcess();
    }
  });

  it("takes a request answered with the process's own slot, or withdrawn, out of the limit's queue, so it holds back no other work", async () => {
    /* A limit of three: the process holds one. */
    const limit = new Semaphore(3);
    let endProcess = (): void => undefined;
    void limit.run(() => Computable.from<void>(resolve => (endProcess = () => resolve())));
    const registered = await toPromise(registerProcess((work, count, signal) => limit.run(work, count, signal)));
    try {
      const client = connect(registered);
      await settle();
      client.request(1, "slots/acquire");
      client.request(2, "slots/acquire", { count: 3 });
      await settle();
      /* Another step's work, queued behind the request for three. */
      let ran = false;
      void limit.run(() => Computable.resolve((ran = true)));
      expect([granted(client, 1), granted(client, 2), ran]).to.deep.equal([true, false, false]);
      /* The own slot, given back, answers request 2, which leaves the queue. */
      client.notify("slots/release", { id: 1 });
      await settle();
      expect([granted(client, 2), ran]).to.deep.equal([true, true]);
      client.request(3, "slots/acquire", { count: 3 });
      await settle();
      let ranToo = false;
      void limit.run(() => Computable.resolve((ranToo = true)));
      await settle();
      expect(ranToo, "held back by request 3").to.equal(false);
      client.notify("$/cancelRequest", { id: 3 });
      await settle();
      expect(ranToo, "request 3 withdrawn").to.equal(true);
      await client.close();
    } finally {
      registered.unregister();
      endProcess();
    }
  });

  it("gives back every slot a process's connections hold when it is unregistered", async () => {
    const limit = new Semaphore(1);
    const registered = await toPromise(registerProcess((work, count, signal) => limit.run(work, count, signal)));
    const client = connect(registered);
    await settle();
    client.request(1, "slots/acquire");
    client.request(2, "slots/acquire");
    await settle();
    expect(granted(client, 2), "the limit's one slot").to.equal(true);
    registered.unregister();
    await settle();
    expect(client.closed()).to.equal(true);
    let ran = false;
    await toPromise(limit.run(() => Computable.resolve((ran = true))));
    expect(ran).to.equal(true);
  });
});
