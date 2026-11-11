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

/**
 * Secrets Manager: reading a secret's current value with `GetSecretValue`.
 */

import {
  Computable,
  FabrError,
  FileSet,
  HttpStatusError,
  IProvenanceStep,
  isJsonObject,
  ISecretRecord,
  Name,
  parseJson,
  registerProvenanceDescriber,
  registerProvenanceRenderer,
  Repository,
  RepositoryLookup,
  RepositoryPublishRef,
  RepositoryRef,
  SecretFile,
  sendRequest,
} from "@fabr-build/core";
import { describeServiceError, jsonRequest, serviceErrorOf } from "./JsonProtocol";
import { IServiceRequest, requestUrl } from "./Signing";
import { IAccountSettings } from "./Types";

/** The name of the Secrets Manager service under an account. */
export const SECRETS_MANAGER_SERVICE = "secretsmanager";

/** Bumped when what is kept for a secret changes shape. */
const SECRET_TAG = "aws:secretsmanager:secret:1";

/** Provenance kind for a secret read from Secrets Manager. */
const SECRETS_MANAGER_PROVENANCE = "secretsmanager-secret";

interface ISecretOrigin extends IProvenanceStep {
  readonly kind: typeof SECRETS_MANAGER_PROVENANCE;
  /** The account it was read with (`@aws`). */
  readonly account: string;
  /** The secret's name (`prod/db/password`). */
  readonly secret: string;
}

registerProvenanceRenderer(SECRETS_MANAGER_PROVENANCE, step => {
  const origin = step as ISecretOrigin;
  return [{ message: `read from Secrets Manager secret ${origin.secret} with ${origin.account}` }];
});
registerProvenanceDescriber(SECRETS_MANAGER_PROVENANCE, step => `secretsmanager:${(step as ISecretOrigin).secret}`);

/** What `GetSecretValue` answers with, as far as it is read: the value is its text, or its bytes where it is binary. */
export interface ISecretValue {
  readonly arn: string;
  readonly versionId: string;
  readonly value: Buffer;
}

/**
 * The Secrets Manager secrets of an account (`@aws:secretsmanager`). A name in
 * it is a secret's (`prod/db/password`), whose current value is read as one
 * secret file ({@link SecretFile}) named as the secret is, without a leading
 * `/`. What is read is kept in the cache's secrets store, and read again once
 * it is a day old or under `--refresh`.
 */
export class SecretsManagerSecrets implements Repository, RepositoryLookup {
  /** The name the service is written as (`@aws:secretsmanager`), for messages. */
  private readonly written: string;

  constructor(private readonly account: IAccountSettings) {
    this.written = `${account.name}:${SECRETS_MANAGER_SERVICE}`;
  }

  /** Vend the reference for the secret `name` names, which must be literal. */
  public getRepositoryRef(name: Name): RepositoryRef {
    const written = `${this.written}:${name.toString()}`;
    if (name.getMarker() !== undefined) {
      throw new FabrError(`'${written}' is a secret, not resolved, so an override marker means nothing on it`).withHelp(
        "write the reference without the marker"
      );
    }
    const secret = name.getLiteralPrefix();
    if (!name.isSimpleName() || !/^[A-Za-z0-9/_+=.@-]+$/.test(secret) || secret.endsWith("/") || secret.includes("//")) {
      throw new FabrError(`'${written}' does not name a Secrets Manager secret`).withHelp(
        `name the secret as it is, without a pattern, as in '${this.written}:prod/db/password'`
      );
    }
    return new RepositoryRef(this, { name: secret, versionConstraint: undefined }).find(name.substring(secret.startsWith("/") ? 1 : 0));
  }

  public getRepositoryPublishRef(name: Name): RepositoryPublishRef {
    throw new FabrError(`${this.written} cannot be published to (cannot sync to '${this.written}:${name.toString()}')`);
  }

  /** Read the current value of the secret `reference` names, as one secret file named as the secret is, without a leading `/`. */
  public resolve(reference: RepositoryRef): Computable<FileSet> {
    const secret = reference.name;
    const { context, credentials, region, endpoint, name } = this.account;
    const request = secretValueRequest(secret, region, endpoint);
    const url = requestUrl(request);
    const cacheKey = `${name} ${credentials} ${region} ${endpoint?.href ?? ""} ${secret}`;
    return context
      .fetchSecret(cacheKey, SECRET_TAG, `secretsmanager:${secret}`, () => this.fetch(request, url, secret), { resource: "secret", role: "content" })
      .then(record => {
        const origin: ISecretOrigin = { kind: SECRETS_MANAGER_PROVENANCE, account: name, secret };
        const file = new SecretFile(`${this.written}:${secret}`, record.identity, record.value);
        return new FileSet(new Map([[secret.replace(/^\//, ""), file]])).withOrigin(origin);
      });
  }

  /** Fetch the current value of `secret` with `GetSecretValue`. */
  private fetch(request: IServiceRequest & { readonly body: string }, url: string, secret: string): Computable<ISecretRecord> {
    return this.account.signer
      .sign(request, SECRETS_MANAGER_SERVICE, this.account.region)
      .then(headers => sendRequest(url, { method: "POST", headers, body: request.body }))
      .then(response => {
        if (response.statusCode >= 500) {
          throw new HttpStatusError(response.statusCode, url);
        }
        if (response.statusCode !== 200) {
          throw refusal(response.body.toString("utf8"), secret, this.account.name);
        }
        const found = parseJson(response.body, `the answer from ${url}`, toSecretValue);
        return { identity: `${found.arn} ${found.versionId}`, secret: true, value: found.value };
      });
  }
}

/** Make the `GetSecretValue` request for `secret`'s current value: to `endpoint` where there is one, else to Secrets Manager in `region`. */
export function secretValueRequest(secret: string, region: string, endpoint?: URL): IServiceRequest & { readonly body: string } {
  return jsonRequest("secretsmanager.GetSecretValue", { SecretId: secret }, `secretsmanager.${region}.amazonaws.com`, endpoint);
}

/** Read a `GetSecretValue` answer. Throws where it holds no value. */
export function toSecretValue(json: unknown): ISecretValue {
  if (!isJsonObject(json) || typeof json.ARN !== "string" || typeof json.VersionId !== "string") {
    throw new FabrError("the answer holds no secret");
  }
  if (typeof json.SecretString === "string") {
    return { arn: json.ARN, versionId: json.VersionId, value: Buffer.from(json.SecretString, "utf8") };
  }
  if (typeof json.SecretBinary === "string") {
    return { arn: json.ARN, versionId: json.VersionId, value: Buffer.from(json.SecretBinary, "base64") };
  }
  throw new FabrError("the answer holds no secret value");
}

/** Make the error for Secrets Manager refusing to read `secret`, from its error document `text`. */
function refusal(text: string, secret: string, account: string): FabrError {
  const error = serviceErrorOf(text);
  if (error.type === "ResourceNotFoundException") {
    return new FabrError(`Secrets Manager has no secret '${secret}' in ${account}'s account and region`);
  }
  const refused = new FabrError(`Secrets Manager refused to read '${secret}' (${describeServiceError(error)})`);
  return error.type === "AccessDeniedException"
    ? refused.withHelp("reading a secret needs secretsmanager:GetSecretValue, and kms:Decrypt on its key where it is encrypted with your own")
    : refused;
}
