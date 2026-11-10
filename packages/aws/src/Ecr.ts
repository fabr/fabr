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
 * ECR, the account's container registry: signing in to it with the account's
 * own credentials, by ECR's `GetAuthorizationToken`.
 */

import { Computable, Credential, FabrError, IAuthChallenge, IRequestHead, isJsonObject, parseJson, sendRequest, toJsonObject } from "@fabr-build/core";
import { IServiceRequest, requestUrl } from "./Signing";
import { IServiceSettings } from "./Types";

/** The name of the ECR service under an account. */
export const ECR_SERVICE = "ecr";

/** What ECR's `GetAuthorizationToken` gives: the registry's password, already `AWS:<password>` in base64, and the registry's URL. */
interface IEcrToken {
  readonly authorization: string;
  readonly proxyEndpoint: string;
}

/**
 * Signing in to an account's ECR registry: each request carries `Basic` with
 * the password ECR's `GetAuthorizationToken` gives, fetched once and again
 * where the registry no longer accepts it (it lasts 12 hours), once however
 * many requests meet that together.
 */
export class EcrSignIn implements Credential {
  private token?: Computable<IEcrToken>;

  constructor(private readonly account: IServiceSettings) {}

  /** Get the token held, fetching it the first time. */
  public current(): Computable<IEcrToken> {
    this.token ??= this.fetch();
    return this.token;
  }

  public authorize(_request: IRequestHead, challenge?: IAuthChallenge): Computable<ReadonlyMap<string, string> | undefined> {
    const token = challenge === undefined || (this.token !== undefined && !this.token.isSettled()) ? this.current() : (this.token = this.fetch());
    return token.then(({ authorization }) => new Map([["authorization", `Basic ${authorization}`]]));
  }

  /** Fetch a token from ECR's `GetAuthorizationToken`, signed with the account's credentials. */
  private fetch(): Computable<IEcrToken> {
    const request = tokenRequest(this.account.region, this.account.endpoint);
    const url = requestUrl(request);
    return this.account.signer
      .sign(request, ECR_SERVICE, this.account.region)
      .then(headers => sendRequest(url, { method: "POST", headers, body: request.body }))
      .then(response => {
        if (response.statusCode !== 200) {
          throw new FabrError(`ECR refused a registry token (${response.statusCode}: ${errorOf(response.body.toString("utf8"))})`).withHelp(
            "signing in to ECR needs the ecr:GetAuthorizationToken permission"
          );
        }
        return parseJson(response.body, `token from ${url}`, toEcrToken);
      });
  }
}

/** Make the URL of the ECR registry of the account `accountId` in `region`. */
export function registryUrl(accountId: string, region: string): string {
  return `https://${accountId}.dkr.ecr.${region}.amazonaws.com`;
}

/** Make the `GetAuthorizationToken` request: to `endpoint` where there is one, else to ECR's API in `region`. */
export function tokenRequest(region: string, endpoint?: URL): IServiceRequest & { readonly body: string } {
  const headers = new Map([
    ["content-type", "application/x-amz-json-1.1"],
    ["x-amz-target", "AmazonEC2ContainerRegistry_V20150921.GetAuthorizationToken"],
  ]);
  const base =
    endpoint === undefined
      ? { protocol: "https:", hostname: `api.ecr.${region}.amazonaws.com` }
      : { protocol: endpoint.protocol, hostname: endpoint.hostname, ...(endpoint.port === "" ? {} : { port: Number(endpoint.port) }) };
  return { ...base, method: "POST", path: endpoint === undefined ? "/" : `${endpoint.pathname.replace(/\/+$/, "")}/`, query: new Map(), headers, body: "{}" };
}

/** Read a `GetAuthorizationToken` answer. Throws where it holds no token. */
export function toEcrToken(json: unknown): IEcrToken {
  const data = isJsonObject(json) && Array.isArray(json.authorizationData) ? json.authorizationData[0] : undefined;
  if (!isJsonObject(data) || typeof data.authorizationToken !== "string" || typeof data.proxyEndpoint !== "string") {
    throw new FabrError("the answer holds no authorization data");
  }
  return { authorization: data.authorizationToken, proxyEndpoint: data.proxyEndpoint };
}

/** Read the message of an AWS JSON error document, or its text where it is none. */
function errorOf(text: string): string {
  let doc: Record<string, unknown>;
  try {
    doc = parseJson(text, "an error", toJsonObject);
  } catch {
    return text.trim() || "no detail given";
  }
  const message = typeof doc.message === "string" ? doc.message : typeof doc.Message === "string" ? doc.Message : undefined;
  const type = typeof doc.__type === "string" ? doc.__type.replace(/^.*#/, "") : undefined;
  return message === undefined ? text.trim() || "no detail given" : type === undefined ? message : `${type}: ${message}`;
}
