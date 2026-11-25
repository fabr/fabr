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
  IProvenanceStep,
  ISecretRecord,
  isJsonObject,
  Name,
  parseJson,
  registerProvenanceDescriber,
  registerProvenanceRenderer,
  Repository,
  RepositoryLookup,
  RepositoryPublishRef,
  RepositoryRef,
  SecretFile,
  secure,
  SecureString,
  shownUrl,
} from "@fabr-build/core";
import { describeServiceError, jsonRequest, postServiceRequest, serviceErrorOf } from "./JsonProtocol";
import { getServiceUrl, IServiceRequest, requestUrl } from "./Signing";
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

registerProvenanceRenderer<ISecretOrigin>(SECRETS_MANAGER_PROVENANCE, origin => {
  return [{ message: `read from Secrets Manager secret ${origin.secret} with ${origin.account}` }];
});
registerProvenanceDescriber<ISecretOrigin>(SECRETS_MANAGER_PROVENANCE, step => `secretsmanager:${step.secret}`);

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
 * `/`, or a secret's with a version ID (`prod/db/password:<VersionId>`), whose
 * value at that version is read so. What is read is kept in the cache's
 * secrets store, and read again once it is a day old or under `--refresh`; a
 * version is never read again once held.
 */
export class SecretsManagerSecrets implements Repository, RepositoryLookup {
  /** The name the service is written as (`@aws:secretsmanager`), for messages. */
  private readonly written: string;

  constructor(private readonly account: IAccountSettings) {
    this.written = `${account.name}:${SECRETS_MANAGER_SERVICE}`;
  }

  /**
   * Vend the reference for the secret `name` names, which must be literal: the
   * secret, or one version of it by its version ID, as the reference's version
   * constraint.
   */
  public getRepositoryRef(name: Name): RepositoryRef {
    const written = `${this.written}:${name.toDisplayString()}`;
    if (name.getMarker() !== undefined) {
      throw new FabrError(`'${written}' is a secret, not resolved, so an override marker means nothing on it`).withHelp(
        "write the reference without the marker"
      );
    }
    const [, secret, version] = /^(.*?)(?::([A-Za-z0-9-]{32,64}))?$/.exec(name.getLiteralPrefix())!;
    if (!name.isSimpleName() || !/^[A-Za-z0-9/_+=.@-]+$/.test(secret) || secret.endsWith("/") || secret.includes("//")) {
      throw new FabrError(`'${written}' does not name a Secrets Manager secret`).withHelp(
        `name the secret as it is, without a pattern, as in '${this.written}:prod/db/password', ` +
          `or one version of it by its version ID, as in '${this.written}:prod/db/password:a1b2c3d4-5678-90ab-cdef-EXAMPLE11111'`
      );
    }
    return new RepositoryRef(this, { name: secret, versionConstraint: version }).find(
      name.substring(secret.startsWith("/") ? 1 : 0, version === undefined ? undefined : secret.length)
    );
  }

  public getRepositoryPublishRef(name: Name): RepositoryPublishRef {
    throw new FabrError(`${this.written} cannot be published to (cannot sync to '${this.written}:${name.toDisplayString()}')`);
  }

  /**
   * Read the value of the secret `reference` names, as one secret file named
   * as the secret is, without a leading `/`: at the version its version
   * constraint names, which is never read again once held, else the current
   * value.
   */
  public resolve(reference: RepositoryRef): Computable<FileSet> {
    const secret = reference.name;
    const version = reference.versionConstraint;
    const selector = version === undefined ? secret : `${secret}:${version}`;
    const { context, credentials, region, endpoint, name } = this.account;
    const request = secretValueRequest(secret, region, endpoint, version);
    const cacheKey = secure`${name} ${credentials} ${region} ${endpoint ?? ""} ${selector}`.toUnmaskedString();
    return context
      .fetchSecret(
        cacheKey,
        SECRET_TAG,
        `secretsmanager:${selector}`,
        () => this.fetch(request, selector, version !== undefined),
        { resource: "secret", role: "content" },
        version !== undefined
      )
      .then(record => {
        const origin: ISecretOrigin = { kind: SECRETS_MANAGER_PROVENANCE, account: name, secret };
        const file = new SecretFile(`${this.written}:${selector}`, record.identity, record.value);
        return new FileSet(new Map([[secret.replace(/^\//, ""), file]])).withOrigin(origin);
      });
  }

  /** Fetch the value `request` asks `GetSecretValue` for: of `secret`, at a version where `versioned` (`secret` is then `<name>:<VersionId>`). */
  private fetch(request: IServiceRequest & { readonly body: string }, secret: string, versioned: boolean): Computable<ISecretRecord> {
    return postServiceRequest(this.account, SECRETS_MANAGER_SERVICE, request, text =>
      refusal(text, secret, versioned, this.account.name)
    ).then(body => {
      const found = parseJson(body, `the answer from ${shownUrl(requestUrl(request))}`, toSecretValue);
      return { identity: `${found.arn} ${found.versionId}`, secret: true, value: found.value };
    });
  }
}

/** Make the `GetSecretValue` request for `secret`'s value, at `version` (a version ID) where given, else its current one: to `endpoint` where there is one, else to Secrets Manager in `region`. */
export function secretValueRequest(
  secret: string,
  region: string,
  endpoint?: SecureString,
  version?: string
): IServiceRequest & { readonly body: string } {
  const body = version === undefined ? { SecretId: secret } : { SecretId: secret, VersionId: version };
  return jsonRequest("secretsmanager.GetSecretValue", body, getServiceUrl("secretsmanager", region), endpoint);
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

/** Make the error for Secrets Manager refusing to read `secret` (`<name>:<VersionId>` where `versioned`), from its error document `text`. */
function refusal(text: string, secret: string, versioned: boolean, account: string): FabrError {
  const error = serviceErrorOf(text);
  if (error.type === "ResourceNotFoundException") {
    return new FabrError(`Secrets Manager has no secret${versioned ? " version" : ""} '${secret}' in ${account}'s account and region`);
  }
  const refused = new FabrError(`Secrets Manager refused to read '${secret}' (${describeServiceError(error)})`);
  return error.type === "AccessDeniedException"
    ? refused.withHelp(
        "reading a secret needs secretsmanager:GetSecretValue, and kms:Decrypt on its key where it is encrypted with your own"
      )
    : refused;
}
