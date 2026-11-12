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

import {
  Computable,
  Credential,
  FabrError,
  IAuthChallenge,
  IRequestHead,
  isJsonObject,
  parseJson,
  RenewableToken,
  sendRequest,
} from "@fabr-build/core";
import { describeServiceError, jsonRequest, serviceErrorOf } from "./JsonProtocol";
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
 * The credential of an account's ECR registry: each request carries `Basic`
 * with the password ECR's `GetAuthorizationToken` gives. The password is
 * fetched when first needed, and again when the registry challenges a request
 * (a password lasts 12 hours); requests challenged while a fetch is under way
 * share it.
 */
export class EcrSignIn implements Credential {
  /** The password, fetched when first needed. */
  private readonly token = new RenewableToken(() => this.fetch());

  constructor(private readonly account: IServiceSettings) {}

  /** Get the token held, fetching it the first time or where its fetch failed. */
  public current(): Computable<IEcrToken> {
    return this.token.current();
  }

  public authorize(_request: IRequestHead, challenge?: IAuthChallenge): Computable<ReadonlyMap<string, string> | undefined> {
    return this.token.forRequest(challenge).then(({ authorization }) => new Map([["authorization", `Basic ${authorization}`]]));
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
          throw new FabrError(
            `ECR refused a registry token (${response.statusCode}: ${describeServiceError(serviceErrorOf(response.body.toString("utf8")))})`
          ).withHelp("signing in to ECR needs the ecr:GetAuthorizationToken permission");
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
  return jsonRequest("AmazonEC2ContainerRegistry_V20150921.GetAuthorizationToken", {}, `api.ecr.${region}.amazonaws.com`, endpoint);
}

/** Read a `GetAuthorizationToken` answer. Throws where it holds no token. */
export function toEcrToken(json: unknown): IEcrToken {
  const data = isJsonObject(json) && Array.isArray(json.authorizationData) ? json.authorizationData[0] : undefined;
  if (!isJsonObject(data) || typeof data.authorizationToken !== "string" || typeof data.proxyEndpoint !== "string") {
    throw new FabrError("the answer holds no authorization data");
  }
  return { authorization: data.authorizationToken, proxyEndpoint: data.proxyEndpoint };
}
