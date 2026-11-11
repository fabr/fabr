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

import * as http from "node:http";
import { AddressInfo } from "node:net";
import { expect } from "chai";
import { Computable } from "@fabr-build/core";
import { parseChallenge, RegistrySignIn, scopesOf } from "./RegistrySignIn";

const REGISTRY = "https://registry.example";

describe("the scopes a registry request needs", () => {
  it("reads the repository from the path, pulling for a read and pushing for a write", () => {
    expect(scopesOf({ method: "GET", url: `${REGISTRY}/v2/library/node/manifests/22` }, REGISTRY)).to.deep.equal([
      "repository:library/node:pull",
    ]);
    expect(scopesOf({ method: "HEAD", url: `${REGISTRY}/v2/acme/app/blobs/sha256:ab` }, REGISTRY)).to.deep.equal([
      "repository:acme/app:pull",
    ]);
    expect(scopesOf({ method: "PUT", url: `${REGISTRY}/v2/acme/app/blobs/uploads/42?digest=sha256:ab` }, REGISTRY)).to.deep.equal([
      "repository:acme/app:pull,push",
    ]);
  });

  it("reads a repository whose name holds a request's kind, from the end of the path", () => {
    expect(scopesOf({ method: "GET", url: `${REGISTRY}/v2/acme/blobs/app/manifests/latest` }, REGISTRY)).to.deep.equal([
      "repository:acme/blobs/app:pull",
    ]);
    expect(scopesOf({ method: "GET", url: `${REGISTRY}/v2/acme/manifests/tags/list` }, REGISTRY)).to.deep.equal([
      "repository:acme/manifests:pull",
    ]);
    expect(scopesOf({ method: "POST", url: `${REGISTRY}/v2/acme/blobs/app/blobs/uploads/` }, REGISTRY)).to.deep.equal([
      "repository:acme/blobs/app:pull,push",
    ]);
  });

  it("adds pulling the repository a blob is mounted from", () => {
    expect(
      scopesOf({ method: "POST", url: `${REGISTRY}/v2/acme/copy/blobs/uploads/?mount=sha256:ab&from=library/node` }, REGISTRY)
    ).to.deep.equal(["repository:acme/copy:pull,push", "repository:library/node:pull"]);
  });

  it("needs none for a request to no repository, or to another host", () => {
    expect(scopesOf({ method: "GET", url: `${REGISTRY}/v2/` }, REGISTRY)).to.deep.equal([]);
    expect(scopesOf({ method: "GET", url: "https://s3.example/layer" }, REGISTRY)).to.deep.equal([]);
  });
});

describe("reading a registry's challenge", () => {
  it("reads a Bearer challenge's realm, service and scope", () => {
    expect(
      parseChallenge('Bearer realm="https://auth.example/token",service="registry.example",scope="repository:a:pull"')
    ).to.deep.equal({
      scheme: "bearer",
      realm: "https://auth.example/token",
      service: "registry.example",
      scope: "repository:a:pull",
    });
    expect(parseChallenge('Basic realm="x"')).to.deep.equal({ scheme: "basic" });
    expect(parseChallenge("Negotiate")).to.equal(undefined);
  });
});

describe("signing in to a registry", () => {
  let server: http.Server;
  let realm = "";
  const issued: string[] = [];
  /* How many token requests to refuse before answering. */
  let refusals = 0;

  beforeEach(async () => {
    issued.length = 0;
    refusals = 0;
    server = http.createServer((req, res) => {
      if (refusals > 0) {
        refusals--;
        res.writeHead(400).end();
        return;
      }
      const scopes = new URL(req.url!, "http://x").searchParams.getAll("scope").join(" ");
      issued.push(scopes);
      res.writeHead(200).end(JSON.stringify({ token: `token for ${scopes}` }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
    realm = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`;
  });

  afterEach(() => new Promise<void>(resolve => server.close(() => resolve())));

  const anonymous = (): RegistrySignIn => new RegistrySignIn(REGISTRY, () => Computable.resolve(undefined));
  const head = (url: string): { method: string; url: string; headers: Map<string, string> } => ({
    method: "GET",
    url,
    headers: new Map(),
  });
  const challenge = (): { challenges: string[] } => ({ challenges: [`Bearer realm="${realm}",service="test"`] });

  it("sends nothing until challenged, then a token for the request's scopes", async () => {
    const signIn = anonymous();
    const manifest = head(`${REGISTRY}/v2/library/node/manifests/22`);
    expect(await signIn.authorize(manifest)).to.deep.equal(new Map());
    expect(await signIn.authorize(manifest, challenge())).to.deep.equal(
      new Map([["authorization", "Bearer token for repository:library/node:pull"]])
    );
    expect(await signIn.authorize(manifest)).to.deep.equal(
      new Map([["authorization", "Bearer token for repository:library/node:pull"]])
    );
    expect(issued).to.deep.equal(["repository:library/node:pull"]);
  });

  it("fetches a token up front for new scopes once the registry has named its realm", async () => {
    const signIn = anonymous();
    await signIn.authorize(head(`${REGISTRY}/v2/library/node/manifests/22`), challenge());
    expect(await signIn.authorize(head(`${REGISTRY}/v2/library/alpine/manifests/3`))).to.deep.equal(
      new Map([["authorization", "Bearer token for repository:library/alpine:pull"]])
    );
  });

  it("fetches one token for requests challenged together", async () => {
    const signIn = anonymous();
    const manifest = head(`${REGISTRY}/v2/library/node/manifests/22`);
    await Promise.all([signIn.authorize(manifest, challenge()), signIn.authorize(manifest, challenge())]);
    expect(issued).to.deep.equal(["repository:library/node:pull"]);
  });

  it("fetches the token again where the registry no longer accepts it", async () => {
    const signIn = anonymous();
    const manifest = head(`${REGISTRY}/v2/library/node/manifests/22`);
    await signIn.authorize(manifest, challenge());
    await signIn.authorize(manifest, challenge());
    expect(issued).to.deep.equal(["repository:library/node:pull", "repository:library/node:pull"]);
  });

  it("fetches the token again where fetching it failed", async () => {
    const signIn = anonymous();
    const manifest = head(`${REGISTRY}/v2/library/node/manifests/22`);
    refusals = 1;
    const failed = await Promise.resolve(signIn.authorize(manifest, challenge())).then(
      () => undefined,
      (err: Error) => err
    );
    expect(failed).to.be.instanceOf(Error);
    expect(await signIn.authorize(manifest)).to.deep.equal(
      new Map([["authorization", "Bearer token for repository:library/node:pull"]])
    );
    expect(issued).to.deep.equal(["repository:library/node:pull"]);
  });

  it("sends the credential to an https realm, or an http one for an http registry, and no other", async () => {
    const credential = (): Computable<{ username: string; password: string }> => Computable.resolve({ username: "u", password: "p" });
    const manifest = (registry: string): { method: string; url: string; headers: Map<string, string> } =>
      head(`${registry}/v2/library/node/manifests/22`);
    /* The fixture's realm is http: refused for an https registry... */
    const secure = new RegistrySignIn(REGISTRY, credential);
    const refused = await Promise.resolve(secure.authorize(manifest(REGISTRY), challenge())).then(
      () => undefined,
      (err: Error) => err.message
    );
    expect(refused).to.match(/which is not https, so its credential is not sent/);
    expect(issued).to.deep.equal([]);
    /* ...and sent for an http one. */
    const plain = new RegistrySignIn("http://registry.example", credential);
    expect(await plain.authorize(manifest("http://registry.example"), challenge())).to.deep.equal(
      new Map([["authorization", "Bearer token for repository:library/node:pull"]])
    );
  });

  it("answers a Basic challenge with the registry's credential, and gives up without one", async () => {
    const signedIn = new RegistrySignIn(REGISTRY, () => Computable.resolve({ username: "u", password: "p" }));
    const basic = { challenges: ['Basic realm="registry"'] };
    expect(await signedIn.authorize(head(`${REGISTRY}/v2/`), basic)).to.deep.equal(
      new Map([["authorization", `Basic ${Buffer.from("u:p").toString("base64")}`]])
    );
    expect(await anonymous().authorize(head(`${REGISTRY}/v2/`), basic)).to.equal(undefined);
  });
});
