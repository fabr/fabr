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
import { Readable } from "node:stream";
import { expect } from "chai";
import { inspect } from "util";
import { secure, SecureString } from "./SecureString";
import { Computable } from "./Computable";
import type { Credential, IAuthChallenge } from "./Credential";
import { HttpStatusError } from "./Errors";
import { fetchUrl, openUrlStream, readStream, relayUrl, reportingProgress, sendRequest, urlResolved } from "./Fetch";

interface Received {
  method?: string;
  url?: string;
  auth?: string | string[];
  userAgent?: string;
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
        capture({
          method: req.method,
          url: req.url,
          auth: req.headers.authorization,
          userAgent: req.headers["user-agent"],
          body: Buffer.concat(chunks).toString(),
        });
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
      const res = await sendRequest(SecureString.of(server.url), {
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

  it("sends fabr's User-Agent where the headers name none, and the caller's where they do", async () => {
    const plain = await withServer(200, "");
    try {
      await sendRequest(SecureString.of(plain.url), { method: "GET" });
      expect((await plain.received).userAgent).to.match(/^fabr\/\S+$/);
    } finally {
      plain.close();
    }
    const named = await withServer(200, "");
    try {
      await sendRequest(SecureString.of(named.url), { method: "GET", headers: { "User-Agent": "npm/10.0.0" } });
      expect((await named.received).userAgent).to.equal("npm/10.0.0");
    } finally {
      named.close();
    }
  });

  it("sends a stream as the body as it is read", async () => {
    const server = await withServer(201, "");
    try {
      const body = Readable.from([Buffer.from("one "), Buffer.from("two")]);
      const res = await sendRequest(SecureString.of(server.url), { method: "PUT", headers: { "content-length": "7" }, body });
      expect((await server.received).body).to.equal("one two");
      expect(res.statusCode).to.equal(201);
    } finally {
      server.close();
    }
  });

  it("returns non-2xx responses (does not reject) so the caller can read the error body", async () => {
    const server = await withServer(409, '{"error":"cannot publish over existing version"}');
    try {
      const res = await sendRequest(SecureString.of(server.url), { method: "PUT", body: "{}" });
      expect(res.statusCode).to.equal(409);
      expect(res.body.toString()).to.contain("existing version");
    } finally {
      server.close();
    }
  });
});

/** A server driven by a per-path handler, plus a record of the auth header seen
 * at each path — for asserting redirect following and cross-origin auth drop. */
function routeServer(routes: (path: string) => { status: number; location?: string; body?: string } | undefined): Promise<{
  origin: string;
  authAt: Map<string, string | undefined>;
  close: () => Promise<void>;
}> {
  const authAt = new Map<string, string | undefined>();
  const server = http.createServer((req, res) => {
    authAt.set(req.url ?? "", req.headers.authorization);
    const route = routes(req.url ?? "");
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    const headers: http.OutgoingHttpHeaders = {};
    if (route.location) {
      headers.location = route.location;
    }
    res.writeHead(route.status, headers).end(route.body ?? "");
  });
  return new Promise(resolve =>
    server.listen(0, "127.0.0.1", () => {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve({ origin, authAt, close: () => new Promise(r => server.close(() => r())) });
    })
  );
}

describe("urlResolved", () => {
  const base = secure`https://${SecureString.masked("reg.example", "${ENV.HOST}")}/v2/`;
  const shown = (ref: string): [string, string] => {
    const url = urlResolved(base, ref);
    return [url.toUnmaskedString(), url.toDisplayString()];
  };

  it("keeps the base whole for a URL under it, and its origin for one of its origin", () => {
    expect(shown("lib/tags/list?last=a")).to.deep.equal([
      "https://reg.example/v2/lib/tags/list?last=a",
      "https://${ENV.HOST}/v2/lib/tags/list?last=a",
    ]);
    expect(shown("https://reg.example/v2/x.tgz")).to.deep.equal(["https://reg.example/v2/x.tgz", "https://${ENV.HOST}/v2/x.tgz"]);
    expect(shown("/other?n=1")).to.deep.equal(["https://reg.example/other?n=1", "https://${ENV.HOST}/other?n=1"]);
  });

  it("keeps the base whole only up to a path boundary", () => {
    const short = secure`https://${SecureString.masked("reg", "${ENV.REG}")}`;
    expect(urlResolved(short, "https://registry.example/x.tgz").toDisplayString()).to.equal("https://registry.example/x.tgz");
    const prefix = secure`https://reg.example/${SecureString.masked("npm", "${ENV.PATH}")}`;
    expect(urlResolved(prefix, "https://reg.example/npm-mirror/x.tgz").toDisplayString()).to.equal(
      "https://reg.example/npm-mirror/x.tgz"
    );
  });

  it("keeps a base's masked user:password@ in a URL of its origin", () => {
    const credentialed = secure`https://user:${SecureString.masked("pw", "${ENV.PW}")}@host.example/v2/`;
    expect(urlResolved(credentialed, "/other?n=1").toDisplayString()).to.equal("https://user:${ENV.PW}@host.example/other?n=1");
    expect(urlResolved(credentialed, "/other?n=1").toUnmaskedString()).to.equal("https://user:pw@host.example/other?n=1");
  });

  it("takes a URL of another origin as it is", () => {
    expect(shown("https://blobs.example/x")).to.deep.equal(["https://blobs.example/x", "https://blobs.example/x"]);
  });
});

describe("a request to a masked URL", () => {
  it("fails showing the URL as written where it is no URL, and holds nothing of its value", async () => {
    const url = secure`${SecureString.masked("not a url", "${ENV.REGISTRY}")}/v2/`;
    const err = await openUrlStream(url, {}).then(
      () => undefined,
      e => e as Error
    );
    expect(err?.message).to.equal("'${ENV.REGISTRY}/v2/' is not a URL");
    expect(inspect(err)).not.to.include("not a url");
  });

  it("fails showing a host it could not reach as written", async () => {
    const url = secure`http://${SecureString.masked("unreachable.invalid", "${ENV.HOST}")}/x`;
    const err = await openUrlStream(url, {}).then(
      () => undefined,
      e => e as Error
    );
    expect(err?.message).to.include("${ENV.HOST}");
    expect(err?.message).not.to.include("unreachable.invalid");
  });
});

describe("openUrlStream redirects", () => {
  it("follows a redirect to the final 200 body", async () => {
    const server = await routeServer(path =>
      path === "/start" ? { status: 302, location: "/final" } : path === "/final" ? { status: 200, body: "arrived" } : undefined
    );
    try {
      const body = await fetchUrl(SecureString.of(`${server.origin}/start`));
      expect(body.toString()).to.equal("arrived");
    } finally {
      await server.close();
    }
  });

  it("rejects rather than looping forever on a redirect cycle", async () => {
    /* A server that redirects to itself: following is bounded, so this fails
     * (undici surfaces its loop detection) instead of spinning. */
    const server = await routeServer(() => ({ status: 302, location: "/loop" }));
    try {
      let thrown: unknown;
      await fetchUrl(SecureString.of(`${server.origin}/loop`)).catch(err => (thrown = err));
      expect(thrown).to.be.instanceOf(Error);
    } finally {
      await server.close();
    }
  });

  it("keeps auth on a same-origin redirect", async () => {
    const server = await routeServer(path =>
      path === "/a" ? { status: 302, location: "/b" } : path === "/b" ? { status: 200, body: "ok" } : undefined
    );
    try {
      await openUrlStream(SecureString.of(`${server.origin}/a`), { authorization: "Bearer tok" }).then(r => r.stream?.resume());
      expect(server.authAt.get("/b")).to.equal("Bearer tok");
    } finally {
      await server.close();
    }
  });

  it("drops auth on a cross-origin redirect", async () => {
    const dest = await routeServer(() => ({ status: 200, body: "ok" }));
    const src = await routeServer(() => ({ status: 302, location: `${dest.origin}/x` }));
    try {
      await openUrlStream(SecureString.of(`${src.origin}/start`), { authorization: "Bearer tok" }).then(r => r.stream?.resume());
      expect(src.authAt.get("/start")).to.equal("Bearer tok");
      expect(dest.authAt.get("/x")).to.equal(undefined);
    } finally {
      await src.close();
      await dest.close();
    }
  });
});

/**
 * Start a server that answers 200 to a request carrying `accepted` as its
 * authorization, and 401 with `challenge` to any other, recording each
 * authorization it is sent.
 */
function withChallengingServer(
  accepted: string,
  challenge: string
): Promise<{ url: string; sent: Array<string | undefined>; close: () => void }> {
  const sent: Array<string | undefined> = [];
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        sent.push(req.headers.authorization);
        if (req.headers.authorization === accepted) {
          res.writeHead(200).end("let in");
        } else {
          res.writeHead(401, { "www-authenticate": challenge }).end();
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}/v2/`, sent, close: () => server.close() });
    });
  });
}

/** A credential that sends `first`, and answers a challenge with `renewed` (or gives up, where it is undefined), recording the challenges it is asked. */
function renewingCredential(first: string, renewed: string | undefined, asked: IAuthChallenge[] = []): Credential {
  return {
    authorize: (_request, challenge) => {
      if (challenge !== undefined) {
        asked.push(challenge);
      }
      const value = challenge === undefined ? first : renewed;
      return Computable.resolve(value === undefined ? undefined : new Map([["authorization", value]]));
    },
  };
}

describe("a request's credential", () => {
  it("signs a request in, and answers a 401's challenge with what it renews to", async () => {
    const server = await withChallengingServer("Basic new", 'Basic realm="registry"');
    const asked: IAuthChallenge[] = [];
    try {
      const response = await sendRequest(SecureString.of(server.url), {
        method: "GET",
        credential: renewingCredential("Basic old", "Basic new", asked),
      });
      expect(response.statusCode).to.equal(200);
      expect(server.sent).to.deep.equal(["Basic old", "Basic new"]);
      expect(asked).to.deep.equal([{ challenges: ['Basic realm="registry"'] }]);
    } finally {
      server.close();
    }
  });

  it("answers a streamed GET's 401 the same way", async () => {
    const server = await withChallengingServer("Bearer fresh", 'Bearer realm="https://auth.example/token"');
    try {
      const response = await openUrlStream(
        SecureString.of(server.url),
        {},
        Date.now,
        "content",
        undefined,
        renewingCredential("Bearer stale", "Bearer fresh")
      );
      expect((await readStream(response.stream!)).toString()).to.equal("let in");
      expect(server.sent).to.deep.equal(["Bearer stale", "Bearer fresh"]);
    } finally {
      server.close();
    }
  });

  it("leaves the 401 standing, with its challenges, where the credential gives up", async () => {
    const server = await withChallengingServer("Basic right", 'Basic realm="registry"');
    try {
      const err = await openUrlStream(
        SecureString.of(server.url),
        {},
        Date.now,
        "content",
        undefined,
        renewingCredential("Basic wrong", undefined)
      ).then(
        () => undefined,
        e => e as HttpStatusError
      );
      expect([err?.statusCode, err?.challenges]).to.deep.equal([401, ['Basic realm="registry"']]);
      expect(server.sent).to.deep.equal(["Basic wrong"]);
    } finally {
      server.close();
    }
  });

  it("sends a request at most twice", async () => {
    const server = await withChallengingServer("never", 'Basic realm="registry"');
    try {
      const response = await sendRequest(SecureString.of(server.url), {
        method: "GET",
        credential: renewingCredential("Basic a", "Basic b"),
      });
      expect(response.statusCode).to.equal(401);
      expect(server.sent).to.deep.equal(["Basic a", "Basic b"]);
    } finally {
      server.close();
    }
  });

  it("does not send a streamed body twice", async () => {
    const server = await withChallengingServer("Basic new", 'Basic realm="registry"');
    try {
      const response = await sendRequest(SecureString.of(server.url), {
        method: "PUT",
        body: Readable.from([Buffer.from("once")]),
        credential: renewingCredential("Basic old", "Basic new"),
      });
      expect(response.statusCode).to.equal(401);
      expect(server.sent).to.deep.equal(["Basic old"]);
    } finally {
      server.close();
    }
  });
});

describe("reportingProgress", () => {
  it("delivers every byte to a consumer that attaches a tick late, counting them past", async () => {
    const source = Readable.from([Buffer.from("abc"), Buffer.from("defg")]);
    const counts: number[] = [];
    const counted = reportingProgress(source, bytes => counts.push(bytes));
    /* The wrap must not start the flow on its own: a consumer that attaches
     * only after an await (a mkdir, say) must still see the whole body. */
    await new Promise(resolve => setImmediate(resolve));
    const chunks: Buffer[] = [];
    for await (const chunk of counted) {
      chunks.push(chunk as Buffer);
    }
    expect(Buffer.concat(chunks).toString()).to.equal("abcdefg");
    expect(counts[counts.length - 1]).to.equal(7);
  });

  it("fails the consumer when the source fails, rather than hanging it", async () => {
    const source = new Readable({
      read(): void {
        this.destroy(new Error("boom"));
      },
    });
    const counted = reportingProgress(source, () => undefined);
    let failed: Error | undefined;
    try {
      for await (const chunk of counted) {
        void chunk;
      }
    } catch (err) {
      failed = err as Error;
    }
    expect(failed?.message).to.equal("boom");
  });

  it("closes the source when the consumer closes before the source has ended", async () => {
    const source = new Readable({ read() {} });
    const counted = reportingProgress(source, () => undefined);
    source.push(Buffer.from("abc"));
    counted.destroy();
    await new Promise(resolve => setImmediate(resolve));
    expect(source.destroyed).to.equal(true);
  });
});

describe("relayUrl", () => {
  /** An origin serving a 256 KB blob to a GET, and reading through what a POST or PUT sends: answering with the bytes it read. */
  function startStore(): Promise<{ url: string; close: () => void }> {
    return new Promise(resolve => {
      const server = http.createServer((req, res) => {
        if (req.method === "GET") {
          res.writeHead(200);
          res.end(Buffer.alloc(256 * 1024, 1));
          return;
        }
        let read = 0;
        req.on("data", (chunk: Buffer) => (read += chunk.length));
        req.on("end", () => {
          res.writeHead(req.method === "POST" ? 202 : 201);
          res.end(String(read));
        });
      });
      server.listen(0, "127.0.0.1", () =>
        resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() })
      );
    });
  }

  /** Relay `count` blobs of `from` into `to` at once, each a POST and then the relay into a PUT: the bytes each PUT sent. */
  function relayAll(from: string, to: string, count: number): Promise<string[]> {
    const relays = Array.from({ length: count }, (_, i) =>
      sendRequest(`${to}/uploads/${i}`, { method: "POST", headers: { "content-length": "0" } })
        .then(() =>
          relayUrl(
            { url: SecureString.of(`${from}/blob/${i}`) },
            { url: SecureString.of(`${to}/uploads/${i}?put`), method: "PUT", headers: { "content-length": String(256 * 1024) } }
          )
        )
        .then(response => response.body.toString())
    );
    return settled(Computable.forAll(relays, (...sent: string[]) => sent));
  }

  /** Wait for `relays` to settle, failing where they have not within ten seconds. */
  function settled<T>(relays: Computable<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out (the relays wait on each other)")), 10_000);
      relays.then(
        value => {
          clearTimeout(timer);
          resolve(value);
        },
        err => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  it("relays more blobs within one origin than it has connections or content slots", async () => {
    const store = await startStore();
    try {
      const sent = await relayAll(store.url, store.url, 40);
      expect(new Set(sent)).to.deep.equal(new Set([String(256 * 1024)]));
    } finally {
      store.close();
    }
  });

  it("relays between two origins, in both directions at once", async () => {
    const [a, b] = [await startStore(), await startStore()];
    try {
      const sent = await Promise.all([relayAll(a.url, b.url, 24), relayAll(b.url, a.url, 24)]);
      expect(new Set(sent.flat())).to.deep.equal(new Set([String(256 * 1024)]));
    } finally {
      a.close();
      b.close();
    }
  });

  it("signs both requests in, and gives back what it holds where the upload cannot be sent", async () => {
    const store = await startStore();
    const asked: string[] = [];
    const credential: Credential = {
      authorize: head => {
        asked.push(head.method);
        return Computable.resolve(new Map([["authorization", "Bearer t"]]));
      },
    };
    try {
      /* Nothing listens at the destination: more relays fail than the source has slots or connections. */
      const failures = await settled(
        Computable.forAll(
          Array.from({ length: 24 }, (_, i) =>
            relayUrl(
              { url: SecureString.of(`${store.url}/blob/${i}`), credential },
              { url: SecureString.of("http://127.0.0.1:1/put"), method: "PUT", credential }
            ).then(
              () => "sent",
              () => "failed"
            )
          ),
          (...outcomes: string[]) => outcomes
        )
      );
      expect(new Set(failures)).to.deep.equal(new Set(["failed"]));
      expect(asked.filter(method => method === "PUT")).to.have.lengthOf(24);
      expect(asked.filter(method => method === "GET")).to.have.lengthOf(24);
      expect((await settled(fetchUrl(SecureString.of(`${store.url}/blob`)))).length).to.equal(256 * 1024);
    } finally {
      store.close();
    }
  });
});

describe("readStream", () => {
  it("rejects (rather than hanging) when the stream closes before its end", async () => {
    const source = new Readable({ read() {} });
    const read = new Promise<string>(resolve =>
      readStream(source).then(
        () => resolve("read"),
        (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message)
      )
    );
    source.push(Buffer.from("abc"));
    source.destroy();
    expect(await read).to.equal("ERR_STREAM_PREMATURE_CLOSE");
  });
});
