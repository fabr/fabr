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
import { Computable } from "@fabr-build/core";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { identityProviderOf } from "./Identity";

/** Serve GitHub's token request endpoint, answering every request with
 *  `status` and `body` and recording each request's url and authorization. */
function tokenServer(status: number, body: string): Promise<{ url: string; requests: { url?: string; auth?: string }[]; close: () => void }> {
  return new Promise(resolve => {
    const requests: { url?: string; auth?: string }[] = [];
    const server = http.createServer((req, res) => {
      requests.push({ url: req.url, auth: req.headers.authorization });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}/token?api-version=2.0`, requests, close: () => server.close() });
    });
  });
}

describe("identityProviderOf", () => {
  it("is absent where the job was given no identity", () => {
    expect(identityProviderOf({})).to.equal(undefined);
    expect(identityProviderOf({ ACTIONS_ID_TOKEN_REQUEST_URL: "http://127.0.0.1/token" })).to.equal(undefined);
  });

  it("asks GitHub for a token for the audience, signed in with the request token", async () => {
    const server = await tokenServer(200, '{"value":"jwt"}');
    try {
      const identity = identityProviderOf({ ACTIONS_ID_TOKEN_REQUEST_URL: server.url, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token" })!;
      expect(await identity.token("npm:registry.npmjs.org")).to.equal("jwt");
      expect(server.requests).to.deep.equal([
        { url: "/token?api-version=2.0&audience=npm%3Aregistry.npmjs.org", auth: "Bearer request-token" },
      ]);
    } finally {
      server.close();
    }
  });

  it("fails without reporting the request token where GitHub issues none", async () => {
    const server = await tokenServer(403, '{"message":"request-token is not allowed"}');
    try {
      const identity = identityProviderOf({ ACTIONS_ID_TOKEN_REQUEST_URL: server.url, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token" })!;
      const err = await Promise.resolve(identity.token("npm:registry.npmjs.org")).then(
        () => undefined,
        (e: Error) => e
      );
      expect(err?.message).to.equal("GitHub Actions did not issue an identity token for 'npm:registry.npmjs.org' (403)");
    } finally {
      server.close();
    }
  });

  /** Make an unsigned JWT whose payload is `claims`. */
  function jwt(claims: Record<string, unknown>): string {
    const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${part({ alg: "RS256" })}.${part(claims)}.signature`;
  }

  function failure(token: () => Computable<string>): Promise<Error | undefined> {
    return new Promise(resolve => token().then(() => resolve(undefined), (e: Error) => resolve(e)));
  }

  it("answers with the token in NPM_ID_TOKEN for an audience it names", async () => {
    const token = jwt({ aud: "npm:registry.npmjs.org", sub: "project_path:acme/widgets" });
    expect(await identityProviderOf({ NPM_ID_TOKEN: token })!.token("npm:registry.npmjs.org")).to.equal(token);
    const listed = jwt({ aud: ["other", "npm:registry.npmjs.org"] });
    expect(await identityProviderOf({ NPM_ID_TOKEN: listed })!.token("npm:registry.npmjs.org")).to.equal(listed);
  });

  it("refuses an audience the token in NPM_ID_TOKEN was not issued for, without reporting the token", async () => {
    const token = jwt({ aud: "npm:registry.npmjs.org" });
    const err = await failure(() => identityProviderOf({ NPM_ID_TOKEN: token })!.token("sigstore"));
    expect(err?.message).to.equal("the job's identity token in NPM_ID_TOKEN is for 'npm:registry.npmjs.org', not 'sigstore'");
    expect(err?.message).to.not.contain(token);
  });

  it("refuses a token in NPM_ID_TOKEN that is not a JWT", async () => {
    const err = await failure(() => identityProviderOf({ NPM_ID_TOKEN: "opaque" })!.token("npm:registry.npmjs.org"));
    expect(err?.message).to.equal("the job's identity token in NPM_ID_TOKEN is not a JWT");
  });

  it("prefers GitHub's identity where both are present", async () => {
    const server = await tokenServer(200, '{"value":"github-jwt"}');
    try {
      const identity = identityProviderOf({
        ACTIONS_ID_TOKEN_REQUEST_URL: server.url,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
        NPM_ID_TOKEN: jwt({ aud: "npm:registry.npmjs.org" }),
      })!;
      expect(await identity.token("npm:registry.npmjs.org")).to.equal("github-jwt");
    } finally {
      server.close();
    }
  });
});
