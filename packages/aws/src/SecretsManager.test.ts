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
import { Computable, ISecretRecord, NamespaceRef, parseName, RepositoryRef, SecretFile, TargetContext } from "@fabr-build/core";
import { AwsAccount } from "./AwsAccount";
import { SecretsManagerSecrets, secretValueRequest, toSecretValue } from "./SecretsManager";
import { RequestSigner } from "./Signing";

/** A stand-in for Secrets Manager's `GetSecretValue` over `secrets`, recording each request's target, body and authorization. */
interface IFakeSecretsManager {
  readonly url: string;
  readonly requests: Array<{ target?: string; body: string; authorization?: string }>;
  close(): Promise<void>;
}

interface IFakeSecret {
  readonly text?: string;
  readonly binary?: Buffer;
  readonly versionId: string;
}

function startSecretsManager(secrets: Record<string, IFakeSecret>): Promise<IFakeSecretsManager> {
  const requests: IFakeSecretsManager["requests"] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ target: req.headers["x-amz-target"] as string | undefined, body, authorization: req.headers.authorization });
      const { SecretId } = JSON.parse(body) as { SecretId: string };
      const found = secrets[SecretId];
      if (found === undefined) {
        res.writeHead(400, { "content-type": "application/x-amz-json-1.1" }).end(
          JSON.stringify({ __type: "ResourceNotFoundException", message: "Secrets Manager can't find the specified secret." })
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/x-amz-json-1.1" }).end(
        JSON.stringify({
          ARN: `arn:aws:secretsmanager:us-east-1:111122223333:secret:${SecretId}-AbCdEf`,
          Name: SecretId,
          VersionId: found.versionId,
          ...(found.text === undefined ? {} : { SecretString: found.text }),
          ...(found.binary === undefined ? {} : { SecretBinary: found.binary.toString("base64") }),
          VersionStages: ["AWSCURRENT"],
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

function accountAt(service: IFakeSecretsManager, keys: string[] = []): AwsAccount {
  return new AwsAccount({
    name: "@aws",
    context: fetchingContext(keys),
    signer: new RequestSigner(undefined),
    credentials: "profile:default",
    region: "us-east-1",
    endpoint: new URL(service.url),
    repositoryTypes: new Map(),
  });
}

/** Vend the reference `name`, written after `@aws:secretsmanager:`, makes. */
function refOf(account: AwsAccount, name: string): Computable<RepositoryRef> {
  return new NamespaceRef(account, "@aws")
    .get("secretsmanager", ":")
    .then(member => (member as { getRepositoryRef(name: unknown, separator: string): RepositoryRef }).getRepositoryRef(parseName(name), ":"));
}

/** Read the secret `name`, written after `@aws:secretsmanager:`, names. */
function read(account: AwsAccount, name: string): Computable<Map<string, unknown>> {
  return refOf(account, name).then(ref => (ref.source as SecretsManagerSecrets).resolve(ref).then(files => new Map([...files])));
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

const SECRETS: Record<string, IFakeSecret> = {
  "prod/db/password": { text: "hunter2", versionId: "11111111-aaaa-bbbb-cccc-222222222222" },
  "prod/signing.key": { binary: Buffer.from([0, 1, 2, 255]), versionId: "33333333-aaaa-bbbb-cccc-444444444444" },
};

describe("the Secrets Manager secrets of an AWS account", () => {
  let service: IFakeSecretsManager;
  const saved = { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY };

  beforeEach(async () => {
    process.env.AWS_ACCESS_KEY_ID = "AKIDTEST";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
    service = await startSecretsManager(SECRETS);
  });

  afterEach(async () => {
    await service.close();
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

  it("reads a secret's text as a secret file named as the secret is, identified by its ARN and version", async () => {
    const keys: string[] = [];
    const files = await read(accountAt(service, keys), "prod/db/password");
    expect([...files.keys()]).to.deep.equal(["prod/db/password"]);
    const file = files.get("prod/db/password") as SecretFile;
    expect(file).to.be.instanceOf(SecretFile);
    expect((await file.getBuffer()).toString()).to.equal("hunter2");
    expect(file.getDisplayName()).to.equal("@aws:secretsmanager:prod/db/password");
    expect(file.hash).to.equal(
      new SecretFile("elsewhere", "arn:aws:secretsmanager:us-east-1:111122223333:secret:prod/db/password-AbCdEf 11111111-aaaa-bbbb-cccc-222222222222", Buffer.from("x")).hash
    );
    expect(service.requests[0].target).to.equal("secretsmanager.GetSecretValue");
    expect(JSON.parse(service.requests[0].body)).to.deep.equal({ SecretId: "prod/db/password" });
    expect(service.requests[0].authorization).to.match(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/us-east-1\/secretsmanager\/aws4_request, /);
    expect(keys).to.deep.equal([`@aws profile:default us-east-1 ${service.url}/ prod/db/password`]);
  });

  it("reads a binary secret as its bytes", async () => {
    const files = await read(accountAt(service), "prod/signing.key");
    const file = files.get("prod/signing.key") as SecretFile;
    expect([...(await file.getBuffer())]).to.deep.equal([0, 1, 2, 255]);
  });

  it("refuses a secret Secrets Manager does not have", async () => {
    const err = await failureOf(read(accountAt(service), "prod/missing"));
    expect(err?.message).to.equal("Secrets Manager has no secret 'prod/missing' in @aws's account and region");
  });

  it("refuses a name that is a pattern", async () => {
    const err = await failureOf(refOf(accountAt(service), "prod/*"));
    expect(err?.message).to.equal("'@aws:secretsmanager:prod/*' does not name a Secrets Manager secret");
  });
});

describe("Secrets Manager's GetSecretValue", () => {
  it("is a signed JSON POST to the region's Secrets Manager", () => {
    const request = secretValueRequest("prod/key", "eu-west-2");
    expect(request.hostname).to.equal("secretsmanager.eu-west-2.amazonaws.com");
    expect(request.headers?.get("x-amz-target")).to.equal("secretsmanager.GetSecretValue");
    expect(JSON.parse(request.body)).to.deep.equal({ SecretId: "prod/key" });
  });

  it("reads the value from an answer, and refuses one holding none", () => {
    expect(toSecretValue({ ARN: "arn:x", VersionId: "v", SecretString: "s" })).to.deep.equal({ arn: "arn:x", versionId: "v", value: Buffer.from("s") });
    expect(() => toSecretValue({ ARN: "arn:x", VersionId: "v" })).to.throw("the answer holds no secret value");
    expect(() => toSecretValue({})).to.throw("the answer holds no secret");
  });
});
