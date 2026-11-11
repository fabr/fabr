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
import { Computable, Credential, Name, NamespaceRef, PartialRepositoryRef, parseName, TargetContext } from "@fabr-build/core";
import { AwsAccount } from "./AwsAccount";
import { CodeArtifactToken, endpointUrl, formatCredential, tokenRequest, toCodeArtifactToken } from "./CodeArtifact";
import { onlyTo, RequestSigner, requestUrl } from "./Signing";

const TYPES = new Map([
  ["ecr", "oci_repository"],
  ["npm", "npm_repository"],
  ["maven", "maven_repository"],
]);

/* A repository that vends a reference written as it is asked for, standing in for another plugin's. */
function stubRef(name: string, repositoryName?: string): { name: string; repositoryName?: string; withRepositoryName(written: string): unknown } {
  return { name, repositoryName, withRepositoryName: (written: string) => stubRef(name, written) };
}
const STUB = { getRepositoryRef: (name: { toString(): string }) => stubRef(name.toString()), getRepositoryPublishRef: (name: { toString(): string }) => stubRef(name.toString()) };

/** A context recording each repository the account makes: its type, name, url and credential. */
function makingContext(made: Array<{ type: string; name: string; url?: string; credential?: Credential }>, defined = true): TargetContext {
  return {
    name: "@aws",
    hasRepositoryType: () => defined,
    makeRepository: (type: string, member: { name: string; url?: string; credential?: Credential }) => {
      made.push({ type, name: member.name, url: member.url, credential: member.credential });
      return Computable.resolve(STUB);
    },
  } as unknown as TargetContext;
}

/** Vend the reference `name`, written after `separator`, makes in `source`, following a namespace's members as looking it up does. */
function refIn(source: unknown, name: Name, separator: ":" | "/"): Computable<unknown> {
  if (source instanceof NamespaceRef) {
    const literal = name.getLiteralPrefix();
    const end = literal.search(/[:/]/);
    const first = end === -1 ? literal : literal.substring(0, end);
    return source.get(first, separator).then(member => (end === -1 ? member : refIn(member, name.substring(end + 1), literal[end] as ":" | "/")));
  }
  const ref = (source as PartialRepositoryRef).getRepositoryRef(name, separator);
  return Computable.resolve(ref);
}

/** Vend the reference `name`, written after `@aws:`, makes in `account`, as looking it up does. */
function refOf(account: AwsAccount, name: string): Computable<unknown> {
  return refIn(new NamespaceRef(account, "@aws"), parseName(name), ":");
}

const failureOf = (outcome: unknown): Promise<Error | undefined> =>
  (outcome as Computable<unknown>).then(
    () => undefined,
    e => e as Error
  ) as unknown as Promise<Error | undefined>;

describe("CodeArtifact's requests", () => {
  it("names a repository's endpoint for a format by its domain, owner and region", () => {
    expect(endpointUrl("acme", "111122223333", "eu-west-2", "npm", "shared")).to.equal("https://acme-111122223333.d.codeartifact.eu-west-2.amazonaws.com/npm/shared/");
    expect(endpointUrl("acme", "111122223333", "us-east-1", "maven", "shared", new URL("http://localhost:4566"))).to.equal("http://localhost:4566/maven/shared/");
  });

  it("asks for a domain's token by its name and owner", () => {
    expect(requestUrl(tokenRequest("acme", "111122223333", "eu-west-2"))).to.equal(
      "https://codeartifact.eu-west-2.amazonaws.com/v1/authorization-token?domain=acme&domain-owner=111122223333"
    );
  });

  it("reads the token from the answer", () => {
    expect(toCodeArtifactToken({ authorizationToken: "tok", expiration: 1 })).to.equal("tok");
    expect(() => toCodeArtifactToken({})).to.throw("holds no authorization token");
  });
});

describe("a CodeArtifact domain's token", () => {
  let server: http.Server;
  let endpoint: URL;
  const asked: Array<{ url: string; authorization: string }> = [];
  const saved = { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY };

  beforeEach(async () => {
    process.env.AWS_ACCESS_KEY_ID = "AKIDTEST";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
    asked.length = 0;
    server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        asked.push({ url: req.url!, authorization: req.headers.authorization ?? "" });
        res.writeHead(200).end(JSON.stringify({ authorizationToken: `token-${asked.length}` }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
    endpoint = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const [name, value] of [
      ["AWS_ACCESS_KEY_ID", saved.id],
      ["AWS_SECRET_ACCESS_KEY", saved.secret],
    ] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  const head = { method: "GET", url: "http://x/npm/shared/lodash", headers: new Map<string, string>() };

  it("is fetched once with a signed request, and given as npm sends it, or as Maven does", async () => {
    const token = new CodeArtifactToken({ signer: new RequestSigner(undefined), region: "eu-west-2", endpoint }, "acme", "111122223333");
    expect(await formatCredential(token, "npm").authorize(head)).to.deep.equal(new Map([["authorization", "Bearer token-1"]]));
    expect(await formatCredential(token, "maven").authorize(head)).to.deep.equal(
      new Map([["authorization", `Basic ${Buffer.from("aws:token-1").toString("base64")}`]])
    );
    expect(asked).to.have.lengthOf(1);
    expect(asked[0].url).to.equal("/v1/authorization-token?domain=acme&domain-owner=111122223333");
    expect(asked[0].authorization).to.match(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/eu-west-2\/codeartifact\/aws4_request, /);
  });

  it("is fetched again where a repository no longer accepts it, once for requests challenged together", async () => {
    const token = new CodeArtifactToken({ signer: new RequestSigner(undefined), region: "eu-west-2", endpoint }, "acme", "111122223333");
    const npm = formatCredential(token, "npm");
    await npm.authorize(head);
    const challenge = { challenges: ['Bearer realm="codeartifact"'] };
    expect(await Promise.all([npm.authorize(head, challenge), npm.authorize(head, challenge)])).to.deep.equal([
      new Map([["authorization", "Bearer token-2"]]),
      new Map([["authorization", "Bearer token-2"]]),
    ]);
    expect(asked).to.have.lengthOf(2);
  });
});

describe("a credential an account gives", () => {
  it("signs in requests to its repository's origin alone", async () => {
    const credential = onlyTo("https://acme-1.d.codeartifact.us-east-1.amazonaws.com", {
      authorize: () => Computable.resolve(new Map([["authorization", "Bearer t"]])),
    });
    const at = (url: string): { method: string; url: string; headers: Map<string, string> } => ({ method: "GET", url, headers: new Map() });
    expect(await credential.authorize(at("https://acme-1.d.codeartifact.us-east-1.amazonaws.com/npm/shared/lodash"))).to.deep.equal(
      new Map([["authorization", "Bearer t"]])
    );
    expect(await credential.authorize(at("https://cdn.example/lodash.tgz"))).to.deep.equal(new Map());
    expect(await credential.authorize(at("https://cdn.example/lodash.tgz"), { challenges: [] })).to.equal(undefined);
  });
});

describe("an account's CodeArtifact repositories", () => {
  it("are made as the type AWS_REPOSITORY_TYPES names for their format, at their endpoint", async () => {
    const made: Array<{ type: string; name: string; url?: string }> = [];
    const account = new AwsAccount({ name: "@aws", context: makingContext(made), signer: new RequestSigner(undefined), credentials: "profile:default", region: "eu-west-2", accountId: "123456789012", repositoryTypes: TYPES });
    const npm = (await refOf(account, "codeartifact:acme:shared:npm")) as PartialRepositoryRef;
    await refOf(account, "codeartifact:acme:shared:npm:lodash:4.17.21");
    await refOf(account, "codeartifact:acme:shared:maven:org.slf4j:slf4j-api:2.0.13");
    expect(made.map(({ type, name, url }) => ({ type, name, url }))).to.deep.equal([
      { type: "npm_repository", name: "codeartifact:acme:shared:npm", url: "https://acme-123456789012.d.codeartifact.eu-west-2.amazonaws.com/npm/shared/" },
      { type: "maven_repository", name: "codeartifact:acme:shared:maven", url: "https://acme-123456789012.d.codeartifact.eu-west-2.amazonaws.com/maven/shared/" },
    ]);
    expect(npm.toString()).to.equal("@aws:codeartifact:acme:shared:npm");
  });

  it("are another account's domain's where the owner is named", async () => {
    const made: Array<{ type: string; name: string; url?: string }> = [];
    const account = new AwsAccount({ name: "@aws", context: makingContext(made), signer: new RequestSigner(undefined), credentials: "profile:default", region: "eu-west-2", repositoryTypes: TYPES });
    await refOf(account, "111122223333:codeartifact:acme:shared:npm:lodash:4.17.21");
    expect(made.map(({ name, url }) => ({ name, url }))).to.deep.equal([
      { name: "111122223333:codeartifact:acme:shared:npm", url: "https://acme-111122223333.d.codeartifact.eu-west-2.amazonaws.com/npm/shared/" },
    ]);
  });

  describe("where the account declares no ID", () => {
    let server: http.Server;
    let endpoint: URL;
    let answer: { status: number; body: string };
    const asked: Array<{ body: string; authorization: string }> = [];
    const saved = { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY };

    beforeEach(async () => {
      process.env.AWS_ACCESS_KEY_ID = "AKIDTEST";
      process.env.AWS_SECRET_ACCESS_KEY = "secret";
      asked.length = 0;
      answer = {
        status: 200,
        body: '<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Account>444455556666</Account></GetCallerIdentityResult></GetCallerIdentityResponse>',
      };
      server = http.createServer((req, res) => {
        const body: Buffer[] = [];
        req.on("data", chunk => body.push(chunk as Buffer));
        req.on("end", () => {
          asked.push({ body: Buffer.concat(body).toString("utf8"), authorization: req.headers.authorization ?? "" });
          res.writeHead(answer.status).end(answer.body);
        });
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
      endpoint = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });

    afterEach(async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      for (const [name, value] of [
        ["AWS_ACCESS_KEY_ID", saved.id],
        ["AWS_SECRET_ACCESS_KEY", saved.secret],
      ] as const) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    });

    it("are the domains of the account STS says the credentials sign in to, asked once", async () => {
      const made: Array<{ type: string; name: string; url?: string }> = [];
      const account = new AwsAccount({ name: "@aws", context: makingContext(made), signer: new RequestSigner(undefined), credentials: "profile:default", region: "eu-west-2", endpoint, repositoryTypes: TYPES });
      await refOf(account, "codeartifact:acme:shared:npm:lodash:4.17.21");
      await refOf(account, "codeartifact:acme:shared:maven:org.slf4j:slf4j-api:2.0.13");
      expect(made.map(({ name }) => name)).to.deep.equal(["codeartifact:acme:shared:npm", "codeartifact:acme:shared:maven"]);
      expect(asked).to.have.lengthOf(1);
      expect(asked[0].body).to.equal("Action=GetCallerIdentity&Version=2011-06-15");
      expect(asked[0].authorization).to.match(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/eu-west-2\/sts\/aws4_request, /);
    });

    it("are refused where STS will not say, naming the account", async () => {
      answer = { status: 403, body: "" };
      const account = new AwsAccount({ name: "@aws", context: makingContext([]), signer: new RequestSigner(undefined), credentials: "profile:default", region: "us-east-1", endpoint, repositoryTypes: TYPES });
      expect((await failureOf(refOf(account, "codeartifact:acme:shared:npm:x:1")))?.message).to.equal(
        "STS refused to say which account @aws's credentials sign in to (403)"
      );
    });
  });

  it("are refused for a format AWS_REPOSITORY_TYPES names no type for", async () => {
    const account = new AwsAccount({ name: "@aws", context: makingContext([]), signer: new RequestSigner(undefined), credentials: "profile:default", region: "us-east-1", accountId: "123456789012", repositoryTypes: TYPES });
    expect((await failureOf(refOf(account, "codeartifact:acme:shared:pypi:requests:2")))?.message).to.equal(
      "AWS_REPOSITORY_TYPES names no repository type for pypi, which '@aws:codeartifact:acme:shared:pypi' is"
    );
  });

  it("are namespaces until the name reaches a format, refused as packages or files", async () => {
    const made: Array<{ type: string; name: string; url?: string }> = [];
    const account = new AwsAccount({ name: "@aws", context: makingContext(made), signer: new RequestSigner(undefined), credentials: "profile:default", region: "us-east-1", repositoryTypes: TYPES });
    const shared = (await refOf(account, "codeartifact:acme:shared")) as NamespaceRef;
    expect(shared).to.be.instanceOf(NamespaceRef);
    expect(shared.toString()).to.equal("@aws:codeartifact:acme:shared");
    expect(shared.refused().message).to.include("'@aws:codeartifact:acme:shared' names a namespace, not a package or files");
    expect(made).to.deep.equal([]);
  });
});
