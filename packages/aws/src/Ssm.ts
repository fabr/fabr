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
 * SSM Parameter Store: reading a parameter with `GetParameter`, a
 * `SecureString` as a secret.
 */

import {
  Computable,
  FabrError,
  FileSet,
  HttpStatusError,
  ISecretRecord,
  IProvenanceStep,
  isJsonObject,
  MemoryFile,
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
import { describeServiceError, isThrottling, jsonRequest, serviceErrorOf } from "./JsonProtocol";
import { IServiceRequest, requestUrl } from "./Signing";
import { IAccountSettings } from "./Types";

/** The name of the SSM service under an account. */
export const SSM_SERVICE = "ssm";

/** Bumped when what is kept for a parameter changes shape. */
const PARAMETER_TAG = "aws:ssm:parameter:1";

/** Provenance kind for a parameter read from SSM. */
const SSM_PROVENANCE = "ssm-parameter";

interface ISsmOrigin extends IProvenanceStep {
  readonly kind: typeof SSM_PROVENANCE;
  /** The account it was read with (`@aws`). */
  readonly account: string;
  /** The parameter's name (`/app/key`). */
  readonly parameter: string;
  readonly version: number;
}

registerProvenanceRenderer(SSM_PROVENANCE, step => {
  const origin = step as ISsmOrigin;
  return [{ message: `read from SSM parameter ${origin.parameter} (version ${origin.version}) with ${origin.account}` }];
});
registerProvenanceDescriber(SSM_PROVENANCE, step => `ssm:${(step as ISsmOrigin).parameter}`);

/** What `GetParameter` answers with, as far as it is read. */
export interface IParameter {
  readonly name: string;
  /** `String`, `StringList` or `SecureString`. */
  readonly type: string;
  readonly value: string;
  readonly version: number;
  readonly arn: string;
}

/**
 * The SSM Parameter Store of an account (`@aws:ssm`). A name in it is a
 * parameter's (`/app/db/password`), which is read as one file named as the
 * parameter is, without its leading `/` (`app/db/password`). A `SecureString`
 * is a secret ({@link SecretFile}); any other parameter is ordinary content.
 * What is read is kept in the cache's secrets store, and read again once it is
 * a day old or under `--refresh`.
 */
export class SsmParameters implements Repository, RepositoryLookup {
  /** The name the service is written as (`@aws:ssm`), for messages. */
  private readonly written: string;

  constructor(private readonly account: IAccountSettings) {
    this.written = `${account.name}:${SSM_SERVICE}`;
  }

  /** Vend the reference for the parameter `name` names, which must be literal. */
  public getRepositoryRef(name: Name): RepositoryRef {
    const written = `${this.written}:${name.toString()}`;
    if (name.getMarker() !== undefined) {
      throw new FabrError(`'${written}' is an SSM parameter, not resolved, so an override marker means nothing on it`).withHelp(
        "write the reference without the marker"
      );
    }
    const parameter = name.getLiteralPrefix();
    if (!/^\/?[A-Za-z0-9_.\-/]+$/.test(parameter) || parameter.endsWith("/") || parameter.includes("//")) {
      throw new FabrError(`'${written}' does not name an SSM parameter`).withHelp(
        `name the parameter as it is, without a pattern, as in '${this.written}:/app/db/password'`
      );
    }
    return new RepositoryRef(this, { name: parameter, versionConstraint: undefined }).find(
      name.substring(parameter.startsWith("/") ? 1 : 0)
    );
  }

  public getRepositoryPublishRef(name: Name): RepositoryPublishRef {
    throw new FabrError(`${this.written} cannot be published to (cannot sync to '${this.written}:${name.toString()}')`);
  }

  /** Read the parameter `reference` names, as one file named as the parameter is, without its leading `/`. */
  public resolve(reference: RepositoryRef): Computable<FileSet> {
    const parameter = reference.name;
    const { context, credentials, region, endpoint, name } = this.account;
    const request = parameterRequest(parameter, region, endpoint);
    const url = requestUrl(request);
    const cacheKey = `${name} ${credentials} ${region} ${endpoint?.href ?? ""} ${parameter}`;
    return context
      .fetchSecret(cacheKey, PARAMETER_TAG, `ssm:${parameter}`, () => this.fetch(request, url, parameter), {
        resource: "parameter",
        role: "content",
      })
      .then(record => {
        const file = record.secret
          ? new SecretFile(`${this.written}:${parameter}`, record.identity, record.value)
          : new MemoryFile(record.value);
        const origin: ISsmOrigin = { kind: SSM_PROVENANCE, account: name, parameter, version: versionOf(record.identity) };
        return new FileSet(new Map([[parameter.replace(/^\//, ""), file]])).withOrigin(origin);
      });
  }

  /** Fetch `parameter` with `GetParameter`, decrypted where it is a `SecureString`. */
  private fetch(request: IServiceRequest & { readonly body: string }, url: string, parameter: string): Computable<ISecretRecord> {
    return this.account.signer
      .sign(request, SSM_SERVICE, this.account.region)
      .then(headers => sendRequest(url, { method: "POST", headers, body: request.body }))
      .then(response => {
        if (response.statusCode >= 500) {
          throw new HttpStatusError(response.statusCode, url);
        }
        if (response.statusCode !== 200) {
          const text = response.body.toString("utf8");
          /* Throttling is answered as a 400; it is HTTP's "too many requests", which is retried. */
          if (isThrottling(serviceErrorOf(text))) {
            throw new HttpStatusError(429, url);
          }
          throw refusal(text, parameter, this.account.name);
        }
        const found = parseJson(response.body, `the answer from ${url}`, toParameter);
        return {
          identity: `${found.arn}:${found.version}`,
          secret: found.type === "SecureString",
          value: Buffer.from(found.value, "utf8"),
        };
      });
  }
}

/** Make the `GetParameter` request for `parameter`, decrypted: to `endpoint` where there is one, else to SSM in `region`. */
export function parameterRequest(parameter: string, region: string, endpoint?: URL): IServiceRequest & { readonly body: string } {
  return jsonRequest("AmazonSSM.GetParameter", { Name: parameter, WithDecryption: true }, `ssm.${region}.amazonaws.com`, endpoint);
}

/** Read a `GetParameter` answer. Throws where it holds no parameter. */
export function toParameter(json: unknown): IParameter {
  const parameter = isJsonObject(json) ? json.Parameter : undefined;
  if (
    !isJsonObject(parameter) ||
    typeof parameter.Name !== "string" ||
    typeof parameter.Type !== "string" ||
    typeof parameter.Value !== "string" ||
    typeof parameter.Version !== "number" ||
    typeof parameter.ARN !== "string"
  ) {
    throw new FabrError("the answer holds no parameter");
  }
  return { name: parameter.Name, type: parameter.Type, value: parameter.Value, version: parameter.Version, arn: parameter.ARN };
}

/** Read the version a kept parameter's identity (`<ARN>:<version>`) ends with. */
function versionOf(identity: string): number {
  return Number(identity.substring(identity.lastIndexOf(":") + 1));
}

/** Make the error for SSM refusing to read `parameter`, from its error document `text`. */
function refusal(text: string, parameter: string, account: string): FabrError {
  const error = serviceErrorOf(text);
  if (error.type === "ParameterNotFound") {
    return new FabrError(`SSM has no parameter '${parameter}' in ${account}'s account and region`);
  }
  const refused = new FabrError(`SSM refused to read '${parameter}' (${describeServiceError(error)})`);
  return error.type === "AccessDeniedException"
    ? refused.withHelp("reading a parameter needs ssm:GetParameter, and a SecureString kms:Decrypt on its key")
    : refused;
}
