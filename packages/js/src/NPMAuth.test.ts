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
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { Computable, HttpResponse } from "@fabr-build/core";
import { AcquiredOtp, NPMAuth, otpChallengeOf, OtpSession, parseNpmrc, pollWebAuthToken, replaceDoneUrlOrigin } from "./NPMAuth";

/** Base64, for building `_auth`/`_password` fixtures. */
function b64(s: string): string {
  return Buffer.from(s).toString("base64");
}

describe("parseNpmrc", () => {
  it("parses key=value, skipping blanks, comments and section headers", () => {
    const entries = parseNpmrc(
      ["# a comment", "; another", "[a-section]", "", "//reg/:_authToken=abc", "registry = https://reg/  "].join("\n")
    );
    expect(entries.get("//reg/:_authToken")).to.equal("abc");
    expect(entries.get("registry")).to.equal("https://reg/");
    expect(entries.has("# a comment")).to.equal(false);
    expect(entries.has("[a-section]")).to.equal(false);
  });

  it("substitutes ${VAR} from the environment (unset → empty)", () => {
    process.env.FABR_NPMRC_TEST = "sekret";
    try {
      const entries = parseNpmrc("//reg/:_authToken=${FABR_NPMRC_TEST}\n//other/:_authToken=${FABR_NPMRC_MISSING}");
      expect(entries.get("//reg/:_authToken")).to.equal("sekret");
      expect(entries.get("//other/:_authToken")).to.equal("");
    } finally {
      delete process.env.FABR_NPMRC_TEST;
    }
  });

  it("strips surrounding quotes", () => {
    expect(parseNpmrc('//reg/:_authToken="quoted"').get("//reg/:_authToken")).to.equal("quoted");
  });
});

describe("NPMAuth.getHeadersFor", () => {
  it("sends _authToken as Bearer, matched by longest registry prefix", () => {
    const config = new NPMAuth(
      new Map([
        ["//registry.example.org/:_authToken", "root-token"],
        ["//registry.example.org/private/:_authToken", "scoped-token"],
      ])
    );
    /* Deeper path → the more specific key wins. */
    expect(config.getHeadersFor("https://registry.example.org/private/pkg")).to.deep.equal({
      Authorization: "Bearer scoped-token",
    });
    expect(config.getHeadersFor("https://registry.example.org/public/pkg")).to.deep.equal({
      Authorization: "Bearer root-token",
    });
  });

  it("sends _auth as Basic verbatim", () => {
    const config = new NPMAuth(new Map([["//reg/:_auth", b64("user:pass")]]));
    expect(config.getHeadersFor("https://reg/pkg")).to.deep.equal({ Authorization: `Basic ${b64("user:pass")}` });
  });

  it("builds Basic from username + base64 _password", () => {
    const config = new NPMAuth(new Map([["//reg/:username", "alice"], ["//reg/:_password", b64("hunter2")]]));
    expect(config.getHeadersFor("https://reg/pkg")).to.deep.equal({ Authorization: `Basic ${b64("alice:hunter2")}` });
  });

  it("prefers _authToken over the other mechanisms", () => {
    const config = new NPMAuth(new Map([["//reg/:_authToken", "tok"], ["//reg/:_auth", b64("u:p")]]));
    expect(config.getHeadersFor("https://reg/pkg")).to.deep.equal({ Authorization: "Bearer tok" });
  });

  it("matches registry prefixes at a path boundary, not a bare string prefix", () => {
    /* A non-slash-terminated key (`//host/npm`) must not leak its credential to a
     * sibling path (`//host/npm-other`); it applies only under `//host/npm/`. */
    const config = new NPMAuth(new Map([["//host/npm:_authToken", "tok"]]));
    expect(config.getHeadersFor("https://host/npm/pkg")).to.deep.equal({ Authorization: "Bearer tok" });
    expect(config.getHeadersFor("https://host/npm")).to.deep.equal({ Authorization: "Bearer tok" });
    expect(config.getHeadersFor("https://host/npm-other/pkg")).to.deep.equal({});
  });

  it("sends no headers for a host with no configured credential", () => {
    const config = new NPMAuth(new Map([["//reg/:_authToken", "tok"]]));
    expect(config.getHeadersFor("https://cdn.other.net/pkg-1.0.0.tgz")).to.deep.equal({});
  });

  it("layers project over user (project overrides on a shared key)", () => {
    /* Sources in increasing precedence: user first, project last (wins the shared key). */
    const config = NPMAuth.fromSources("//reg/:_authToken=user\n//user-only/:_authToken=u", "//reg/:_authToken=project");
    expect(config.getHeadersFor("https://reg/pkg")).to.deep.equal({ Authorization: "Bearer project" });
    expect(config.getHeadersFor("https://user-only/pkg")).to.deep.equal({ Authorization: "Bearer u" });
  });
});

describe("otpChallengeOf", () => {
  function response(statusCode: number, body: string, wwwAuthenticate?: string): HttpResponse {
    return {
      statusCode,
      headers: wwwAuthenticate === undefined ? {} : { "www-authenticate": wwwAuthenticate },
      body: Buffer.from(body),
    };
  }

  it("recognizes the www-authenticate header case-insensitively (npmjs sends 'OTP')", () => {
    expect(otpChallengeOf(response(401, `{"error":"nope"}`, "OTP"))).to.deep.equal({});
    expect(otpChallengeOf(response(401, `{"error":"nope"}`, "otp"))).to.deep.equal({});
  });

  it("recognizes a header-less challenge by its body", () => {
    expect(otpChallengeOf(response(401, `{"error":"You must provide a one-time pass."}`))).to.deep.equal({});
  });

  it("carries the web-auth ceremony URLs when the body offers them", () => {
    const body = `{"authUrl":"https://www.npmjs.com/auth/cli/x","doneUrl":"https://registry.npmjs.org/-/v1/done?authId=x"}`;
    expect(otpChallengeOf(response(401, body, "OTP"))).to.deep.equal({
      authUrl: "https://www.npmjs.com/auth/cli/x",
      doneUrl: "https://registry.npmjs.org/-/v1/done?authId=x",
    });
  });

  it("treats unusable ceremony URLs as a bare challenge", () => {
    expect(otpChallengeOf(response(401, `{"authUrl":"javascript:alert(1)","doneUrl":42}`, "OTP"))).to.deep.equal({});
  });

  it("is not fooled by an ordinary 401 or a non-401", () => {
    expect(otpChallengeOf(response(401, `{"error":"bad credentials"}`, "Basic realm=x"))).to.equal(undefined);
    expect(otpChallengeOf(response(403, `{"error":"one-time pass"}`, "OTP"))).to.equal(undefined);
    expect(otpChallengeOf(response(200, "{}"))).to.equal(undefined);
  });
});

describe("replaceDoneUrlOrigin", () => {
  it("rewrites the canonical npmjs host to the registry the write used", () => {
    expect(replaceDoneUrlOrigin("https://registry.npmjs.org/-/v1/done?authId=x", "http://127.0.0.1:9999/prefix")).to.equal(
      "http://127.0.0.1:9999/prefix/-/v1/done?authId=x"
    );
  });

  it("leaves a non-canonical done host alone", () => {
    expect(replaceDoneUrlOrigin("https://reg.example.com/-/v1/done", "http://127.0.0.1:9999")).to.equal(
      "https://reg.example.com/-/v1/done"
    );
  });

  it("leaves the canonical host alone when it IS the registry", () => {
    expect(replaceDoneUrlOrigin("https://registry.npmjs.org/-/v1/done", "https://registry.npmjs.org")).to.equal(
      "https://registry.npmjs.org/-/v1/done"
    );
  });
});

/** What one scripted-server request looked like, as the handler saw it. */
interface SeenRequest {
  method?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * A local server whose `script` maps (request, index-so-far) to the reply —
 * lets a test express "202-pending first, 200 once the ceremony completes".
 */
function scriptedServer(
  script: (request: SeenRequest, index: number) => { status: number; headers?: Record<string, string>; body: string }
): Promise<{ url: string; seen: SeenRequest[]; close(): void }> {
  return new Promise(resolve => {
    const seen: SeenRequest[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => {
        const request = { method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() };
        const reply = script(request, seen.length);
        seen.push(request);
        res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
        res.end(reply.body);
      });
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        seen,
        close: () => server.close(),
      })
    );
  });
}

describe("pollWebAuthToken", () => {
  it("waits out a 202 (honoring retry-after) and resolves the completion token", async () => {
    const server = await scriptedServer((request, index) =>
      index === 0
        ? { status: 202, headers: { "retry-after": "0.01" }, body: "{}" }
        : { status: 200, body: `{"token":"webtok"}` }
    );
    try {
      expect(await pollWebAuthToken(`${server.url}/-/v1/done`, { authorization: "Bearer t" })).to.equal("webtok");
      expect(server.seen.length).to.equal(2);
      expect(server.seen[0].headers.authorization).to.equal("Bearer t");
    } finally {
      server.close();
    }
  });

  it("rejects when the ceremony outlives the timeout", async () => {
    const server = await scriptedServer(() => ({ status: 202, body: "{}" }));
    try {
      let thrown: unknown;
      await pollWebAuthToken(`${server.url}/-/v1/done`, {}, 5).catch(err => (thrown = err));
      expect((thrown as Error).message).to.match(/not completed within/);
    } finally {
      server.close();
    }
  });

  it("rejects a completion response without a token", async () => {
    const server = await scriptedServer(() => ({ status: 200, body: "{}" }));
    try {
      let thrown: unknown;
      await pollWebAuthToken(`${server.url}/-/v1/done`, {}).catch(err => (thrown = err));
      expect((thrown as Error).message).to.match(/web-auth completion response/);
    } finally {
      server.close();
    }
  });

  it("rejects any status other than pending or complete", async () => {
    const server = await scriptedServer(() => ({ status: 410, body: `{"error":"gone"}` }));
    try {
      let thrown: unknown;
      await pollWebAuthToken(`${server.url}/-/v1/done`, {}).catch(err => (thrown = err));
      expect((thrown as Error).message).to.match(/failed \(410\)/);
    } finally {
      server.close();
    }
  });
});

describe("OtpSession", () => {
  it("caches a reusable answer (a typed OTP) for the run's later obtains", async () => {
    const session = new OtpSession();
    let calls = 0;
    const acquire = (): Computable<AcquiredOtp> => Computable.resolve({ password: `tok${++calls}`, reusable: true });
    expect(await session.obtain(acquire)).to.equal("tok1");
    expect(await session.obtain(acquire)).to.equal("tok1");
    expect(calls).to.equal(1);
  });

  it("never caches a single-use answer (a web ceremony token)", async () => {
    /* npmjs refuses a ceremony token's second use — a cached one would burn a
     * retry and leave only the refusal's bare challenge to re-acquire from. */
    const session = new OtpSession();
    let calls = 0;
    const acquire = (): Computable<AcquiredOtp> => Computable.resolve({ password: `tok${++calls}`, reusable: false });
    expect(await session.obtain(acquire)).to.equal("tok1");
    expect(await session.obtain(acquire)).to.equal("tok2");
    expect(calls).to.equal(2);
  });

  it("joins concurrent obtains to a single acquisition", async () => {
    const session = new OtpSession();
    let calls = 0;
    let deliver!: (acquired: AcquiredOtp) => void;
    const acquire = (): Computable<AcquiredOtp> => {
      calls++;
      return Computable.from<AcquiredOtp>(resolve => (deliver = resolve));
    };
    const first = session.obtain(acquire);
    const second = session.obtain(acquire);
    deliver({ password: "tok", reusable: false });
    expect(await first).to.equal("tok");
    expect(await second).to.equal("tok");
    expect(calls).to.equal(1);
  });

  it("discards a refused cached answer and acquires afresh", async () => {
    const session = new OtpSession();
    let calls = 0;
    const acquire = (): Computable<AcquiredOtp> => Computable.resolve({ password: `tok${++calls}`, reusable: true });
    expect(await session.obtain(acquire)).to.equal("tok1");
    expect(await session.obtain(acquire, "tok1")).to.equal("tok2");
    /* The refusal named tok1; the now-cached tok2 is untouched by it. */
    expect(await session.obtain(acquire, "tok1")).to.equal("tok2");
    expect(calls).to.equal(2);
  });

  it("ignores a refusal of an answer it did not serve", async () => {
    const session = new OtpSession();
    let calls = 0;
    const acquire = (): Computable<AcquiredOtp> => Computable.resolve({ password: `tok${++calls}`, reusable: true });
    expect(await session.obtain(acquire)).to.equal("tok1");
    expect(await session.obtain(acquire, "other")).to.equal("tok1");
    expect(calls).to.equal(1);
  });

  it("retries after a failed acquisition instead of replaying the failure", async () => {
    const session = new OtpSession();
    let thrown: unknown;
    await session.obtain(() => Computable.reject(new Error("ceremony abandoned"))).catch(err => (thrown = err));
    expect((thrown as Error).message).to.equal("ceremony abandoned");
    expect(await session.obtain(() => Computable.resolve({ password: "tok", reusable: true }))).to.equal("tok");
  });
});
