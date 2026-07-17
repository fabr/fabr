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

import * as http from "node:http";
import { AddressInfo } from "node:net";
import { expect } from "chai";
import { sendRequest } from "./Fetch";

interface Received {
  method?: string;
  url?: string;
  auth?: string | string[];
  body: string;
}

/** Start a one-request server that echoes the request back and replies with the
 * given status, returning both the server and a promise of what it received. */
function withServer(status: number, responseBody: string): Promise<{ url: string; received: Promise<Received>; close: () => void }> {
  return new Promise(resolve => {
    let capture: (r: Received) => void;
    const received = new Promise<Received>(r => (capture = r));
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", c => chunks.push(c));
      req.on("end", () => {
        capture({ method: req.method, url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString() });
        res.writeHead(status, { "content-type": "application/json" });
        res.end(responseBody);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}/pkg`, received, close: () => server.close() });
    });
  });
}

describe("sendRequest", () => {
  it("sends method/headers/body and returns the response", async () => {
    const server = await withServer(201, '{"ok":true}');
    try {
      const res = await sendRequest(server.url, {
        method: "PUT",
        headers: { authorization: "Bearer tok", "content-type": "application/json" },
        body: '{"hello":"world"}',
      });
      const got = await server.received;
      expect(got.method).to.equal("PUT");
      expect(got.auth).to.equal("Bearer tok");
      expect(got.body).to.equal('{"hello":"world"}');
      expect(res.statusCode).to.equal(201);
      expect(res.body.toString()).to.equal('{"ok":true}');
    } finally {
      server.close();
    }
  });

  it("returns non-2xx responses (does not reject) so the caller can read the error body", async () => {
    const server = await withServer(409, '{"error":"cannot publish over existing version"}');
    try {
      const res = await sendRequest(server.url, { method: "PUT", body: "{}" });
      expect(res.statusCode).to.equal(409);
      expect(res.body.toString()).to.contain("existing version");
    } finally {
      server.close();
    }
  });
});
