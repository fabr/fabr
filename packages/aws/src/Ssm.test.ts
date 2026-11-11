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
import {
  Computable,
  ISecretRecord,
  MemoryFile,
  NamespaceRef,
  parseName,
  RepositoryRef,
  SecretFile,
  TargetContext,
} from "@fabr-build/core";
import { AwsAccount } from "./AwsAccount";
import { RequestSigner } from "./Signing";
import { parameterRequest, SsmParameters, toParameter } from "./Ssm";

/** A stand-in for SSM's `GetParameter` over `parameters`, recording each request's target, body and authorization. */
interface IFakeSsm {
  readonly url: string;
  readonly requests: Array<{ target?: string; body: string; authorization?: string }>;
  close(): Promise<void>;
}

interface IFakeParameter {
  readonly type: string;
  readonly value: string;
  readonly version: number;
}

function startSsm(parameters: Record<string, IFakeParameter>): Promise<IFakeSsm> {
  const requests: IFakeSsm["requests"] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ target: req.headers["x-amz-target"] as string | undefined, body, authorization: req.headers.authorization });
      const { Name } = JSON.parse(body) as { Name: string };
      const found = parameters[Name];
      if (found === undefined) {
        res.writeHead(400, { "content-type": "application/x-amz-json-1.1" }).end(JSON.stringify({ __type: "ParameterNotFound" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/x-amz-json-1.1" }).end(
        JSON.stringify({
          Parameter: {
            Name,
            Type: found.type,
            Value: found.value,
            Version: found.version,
            ARN: `arn:aws:ssm:us-east-1:111122223333:parameter${Name.startsWith("/") ? "" : "/"}${Name}`,
          },
        })
      );
    });
  });
  return new Promise(resolve =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        requests,
        close: () => new Promise(done => server.close(() => done())),
      })
    )
  );
}

/** A TargetContext whose `fetchSecret` fetches every time, with no cache, recording each cache key. */
function fetchingContext(keys: string[]): TargetContext {
  return {
    name: "@aws",
    fetchSecret: (cacheKey: string, _tag: string, _url: string, fetch: () => Computable<ISecretRecord>) => {
      keys.push(cacheKey);
      return fetch();
    },
  } as unknown as TargetContext;
}

function accountAt(ssm: IFakeSsm, keys: string[] = []): AwsAccount {
  return new AwsAccount({
    name: "@aws",
    context: fetchingContext(keys),
    signer: new RequestSigner(undefined),
    credentials: "profile:default",
    region: "us-east-1",
    endpoint: new URL(ssm.url),
    repositoryTypes: new Map(),
  });
}

/** Vend the reference `name`, written after `@aws:ssm:`, makes. */
function refOf(account: AwsAccount, name: string): Computable<RepositoryRef> {
  return new NamespaceRef(account, "@aws")
    .get("ssm", ":")
    .then(member =>
      (member as { getRepositoryRef(name: unknown, separator: string): RepositoryRef }).getRepositoryRef(parseName(name), ":")
    );
}

/** Read the parameter `name`, written after `@aws:ssm:`, names. */
function read(account: AwsAccount, name: string): Computable<Map<string, unknown>> {
  return refOf(account, name).then(ref => (ref.source as SsmParameters).resolve(ref).then(files => new Map([...files])));
}

/** @return the error `outcome` rejects with, or undefined where it resolves. */
function failureOf(outcome: Computable<unknown>): Promise<Error | undefined> {
  return Promise.resolve(
    outcome.then(
      () => undefined,
      e => e as Error
    )
  );
}

const PARAMETERS: Record<string, IFakeParameter> = {
  "/app/ssl/ca.key": { type: "SecureString", value: "-----BEGIN PRIVATE KEY-----", version: 7 },
  "/app/region": { type: "String", value: "eu-west-2", version: 2 },
};

describe("the SSM parameters of an AWS account", () => {
  let ssm: IFakeSsm;
  const saved = { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY };

  beforeEach(async () => {
    process.env.AWS_ACCESS_KEY_ID = "AKIDTEST";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
    ssm = await startSsm(PARAMETERS);
  });

  afterEach(async () => {
    await ssm.close();
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

  it("reads a SecureString as a secret, named as the parameter is without its leading '/', identified by its ARN and version", async () => {
    const keys: string[] = [];
    const files = await read(accountAt(ssm, keys), "/app/ssl/ca.key");
    expect([...files.keys()]).to.deep.equal(["app/ssl/ca.key"]);
    const file = files.get("app/ssl/ca.key") as SecretFile;
    expect(file).to.be.instanceOf(SecretFile);
    expect((await file.getBuffer()).toString()).to.equal("-----BEGIN PRIVATE KEY-----");
    expect(file.getDisplayName()).to.equal("@aws:ssm:/app/ssl/ca.key");
    expect(file.hash).to.not.equal(new MemoryFile(Buffer.from("-----BEGIN PRIVATE KEY-----")).hash);
    expect(file.hash).to.equal(
      new SecretFile("elsewhere", "arn:aws:ssm:us-east-1:111122223333:parameter/app/ssl/ca.key:7", Buffer.from("other")).hash
    );
    expect(ssm.requests).to.have.length(1);
    expect(ssm.requests[0].target).to.equal("AmazonSSM.GetParameter");
    expect(JSON.parse(ssm.requests[0].body)).to.deep.equal({ Name: "/app/ssl/ca.key", WithDecryption: true });
    expect(ssm.requests[0].authorization).to.match(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/us-east-1\/ssm\/aws4_request, /);
    expect(keys).to.deep.equal([`@aws profile:default us-east-1 ${ssm.url}/ /app/ssl/ca.key`]);
  });

  it("reads a String as ordinary content", async () => {
    const files = await read(accountAt(ssm), "/app/region");
    const file = files.get("app/region");
    expect(file).to.be.instanceOf(MemoryFile);
    expect((file as MemoryFile).hash).to.equal(new MemoryFile(Buffer.from("eu-west-2")).hash);
  });

  it("refuses a parameter SSM does not have", async () => {
    const err = await failureOf(read(accountAt(ssm), "/app/missing"));
    expect(err?.message).to.equal("SSM has no parameter '/app/missing' in @aws's account and region");
  });

  it("refuses a name that is a pattern", async () => {
    const err = await failureOf(refOf(accountAt(ssm), "/app/*"));
    expect(err?.message).to.equal("'@aws:ssm:/app/*' does not name an SSM parameter");
  });

  it("selects the parameter's file through the reference's projection, renamed where it says so", async () => {
    const ref = await refOf(accountAt(ssm), "/app/ssl/ca.key -> ca.key");
    const files = await (ref.source as SsmParameters).resolve(ref);
    const projected = await files.find(ref.projections[0].pattern);
    expect([...projected].map(([name]) => name)).to.deep.equal(["ca.key"]);
  });
});

describe("SSM's GetParameter", () => {
  it("is a signed JSON POST to the region's SSM, decrypting", () => {
    const request = parameterRequest("/app/key", "eu-west-2");
    expect(request.hostname).to.equal("ssm.eu-west-2.amazonaws.com");
    expect(request.headers?.get("x-amz-target")).to.equal("AmazonSSM.GetParameter");
    expect(JSON.parse(request.body)).to.deep.equal({ Name: "/app/key", WithDecryption: true });
  });

  it("reads the parameter from an answer, and refuses one holding none", () => {
    expect(toParameter({ Parameter: { Name: "/a", Type: "String", Value: "v", Version: 3, ARN: "arn:x" } })).to.deep.equal({
      name: "/a",
      type: "String",
      value: "v",
      version: 3,
      arn: "arn:x",
    });
    expect(() => toParameter({})).to.throw("the answer holds no parameter");
  });
});
