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
import { Computable, Name, NamespaceRef, PartialRepositoryRef, parseName, TargetContext } from "@fabr-build/core";
import { AwsAccount } from "./AwsAccount";
import { EcrSignIn, tokenRequest, toEcrToken } from "./Ecr";
import { RequestSigner, requestUrl } from "./Signing";

/* The repository types AWS.fabr declares. */
const TYPES = new Map([
  ["ecr", "oci_repository"],
  ["npm", "npm_repository"],
  ["maven", "maven_repository"],
]);

/* A registry that vends a reference written as it is asked for, standing in for the container plugin's. */
const STUB_REGISTRY = {
  getRepositoryRef: (name: { toString(): string }) => stubRef(name.toString()),
  getRepositoryPublishRef: (name: { toString(): string }) => stubRef(name.toString()),
};

function stubRef(name: string, repositoryName?: string): { name: string; repositoryName?: string; withRepositoryName(written: string): unknown } {
  return { name, repositoryName, withRepositoryName: (written: string) => stubRef(name, written) };
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

describe("ECR's token request", () => {
  it("goes to ECR's API in the region, or to the endpoint", () => {
    expect(requestUrl(tokenRequest("eu-west-2"))).to.equal("https://api.ecr.eu-west-2.amazonaws.com/");
    expect(requestUrl(tokenRequest("us-east-1", new URL("http://localhost:4566")))).to.equal("http://localhost:4566/");
    expect(tokenRequest("us-east-1").headers?.get("x-amz-target")).to.equal("AmazonEC2ContainerRegistry_V20150921.GetAuthorizationToken");
  });

  it("reads the password and the registry from the answer", () => {
    expect(toEcrToken({ authorizationData: [{ authorizationToken: "QVdTOnB3", proxyEndpoint: "https://1.dkr.ecr.us-east-1.amazonaws.com" }] })).to.deep.equal({
      authorization: "QVdTOnB3",
      proxyEndpoint: "https://1.dkr.ecr.us-east-1.amazonaws.com",
    });
    expect(() => toEcrToken({ authorizationData: [] })).to.throw("holds no authorization data");
  });
});

describe("signing in to ECR", () => {
  let server: http.Server;
  let endpoint: URL;
  /* The tokens handed out, and what each request for one was signed with. */
  const signed: string[] = [];
  const saved = { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY };

  beforeEach(async () => {
    process.env.AWS_ACCESS_KEY_ID = "AKIDTEST";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
    signed.length = 0;
    server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        signed.push(req.headers.authorization ?? "");
        const password = Buffer.from(`AWS:password-${signed.length}`).toString("base64");
        res.writeHead(200).end(JSON.stringify({ authorizationData: [{ authorizationToken: password, proxyEndpoint: "https://1.dkr.ecr.us-east-1.amazonaws.com" }] }));
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

  const basic = (n: number): Map<string, string> => new Map([["authorization", `Basic ${Buffer.from(`AWS:password-${n}`).toString("base64")}`]]);
  const head = { method: "GET", url: "http://registry/v2/app/manifests/1", headers: new Map<string, string>() };

  it("signs each request in with the password a signed GetAuthorizationToken gives, fetched once", async () => {
    const signIn = new EcrSignIn({ signer: new RequestSigner(undefined), region: "us-east-1", endpoint });
    expect(await signIn.authorize(head)).to.deep.equal(basic(1));
    expect(await signIn.authorize(head)).to.deep.equal(basic(1));
    expect(signed).to.have.lengthOf(1);
    expect(signed[0]).to.match(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/us-east-1\/ecr\/aws4_request, /);
  });

  it("is made once, as the container plugin's oci_repository, at the account's endpoint, asking AWS nothing", async () => {
    const made: Array<{ type: string; name: string; url?: string }> = [];
    const context = {
      name: "@aws",
      hasRepositoryType: () => true,
      makeRepository: (type: string, member: { name: string; url?: string }) => {
        made.push({ type, name: member.name, url: member.url });
        return Computable.resolve(STUB_REGISTRY);
      },
    } as unknown as TargetContext;
    const account = new AwsAccount({ name: "@aws", repositoryTypes: TYPES, context, signer: new RequestSigner(undefined), region: "us-east-1", endpoint });
    await refOf(account, "ecr");
    await refOf(account, "ecr:app:1");
    expect(made).to.deep.equal([{ type: "oci_repository", name: "ecr", url: endpoint.href }]);
    expect(signed).to.have.lengthOf(0);
  });

  it("is made with nothing asked of AWS where the account's ID is declared", async () => {
    const made: Array<string | undefined> = [];
    const context = {
      name: "@aws",
      hasRepositoryType: () => true,
      makeRepository: (_type: string, member: { url?: string }) => {
        made.push(member.url);
        return Computable.resolve(STUB_REGISTRY);
      },
    } as unknown as TargetContext;
    const account = new AwsAccount({ name: "@aws", repositoryTypes: TYPES, context, signer: new RequestSigner(undefined), region: "eu-west-2", accountId: "123456789012" });
    await refOf(account, "ecr");
    expect(made).to.deep.equal(["https://123456789012.dkr.ecr.eu-west-2.amazonaws.com"]);
    expect(signed).to.have.lengthOf(0);
  });

  it("fetches the password again where the registry no longer accepts it, once for requests challenged together", async () => {
    const signIn = new EcrSignIn({ signer: new RequestSigner(undefined), region: "us-east-1", endpoint });
    await signIn.authorize(head);
    const challenge = { challenges: ['Basic realm="https://1.dkr.ecr.us-east-1.amazonaws.com/",service="ecr.amazonaws.com"'] };
    const [first, second] = await Promise.all([signIn.authorize(head, challenge), signIn.authorize(head, challenge)]);
    expect([first, second]).to.deep.equal([basic(2), basic(2)]);
    expect(signed).to.have.lengthOf(2);
  });
});

describe("an account's ECR registry", () => {
  it("is refused, naming the plugin to add, where no plugin in use defines oci_repository", async () => {
    const context = { name: "@aws", hasRepositoryType: () => false } as unknown as TargetContext;
    const account = new AwsAccount({ name: "@aws", repositoryTypes: TYPES, context, signer: new RequestSigner(undefined), region: "us-east-1" });
    const err = await refOf(account, "ecr:app:1").then(
      () => undefined,
      e => e as Error
    );
    expect(err?.message).to.equal("'@aws:ecr' needs the repository type oci_repository, which no plugin in use defines");
  });

  it("reaches another account's registry by its ID, in the account's region, asking AWS nothing", async () => {
    const made: Array<{ name: string; url?: string }> = [];
    const context = {
      name: "@aws",
      hasRepositoryType: () => true,
      makeRepository: (_type: string, member: { name: string; url?: string }) => {
        made.push({ name: member.name, url: member.url });
        return Computable.resolve(STUB_REGISTRY);
      },
    } as unknown as TargetContext;
    const account = new AwsAccount({ name: "@aws", repositoryTypes: TYPES, context, signer: new RequestSigner(undefined), region: "eu-west-2" });
    const registry = (await refOf(account, "111122223333:ecr")) as PartialRepositoryRef;
    await refOf(account, "111122223333:ecr:app:1");
    expect(made).to.deep.equal([{ name: "111122223333:ecr", url: "https://111122223333.dkr.ecr.eu-west-2.amazonaws.com" }]);
    expect(registry.toString()).to.equal("@aws:111122223333:ecr");
    const failureOf = (outcome: Computable<unknown>): Promise<string | undefined> =>
      Promise.resolve(
        outcome.then(
          () => undefined,
          e => (e as Error).message
        )
      );
    expect(await failureOf(refOf(account, "111122223333:s3:bucket:key"))).to.equal("@aws:111122223333 has no service 's3'");
    expect(await failureOf(refOf(account, "12345:x"))).to.equal("@aws has no service '12345'");
  });
});
