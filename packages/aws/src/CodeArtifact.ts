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
 * CodeArtifact: a domain's repositories, each serving packages of several
 * formats (npm, Maven, PyPI, …) at an endpoint of its own, signed in with a
 * token CodeArtifact's `GetAuthorizationToken` gives for the domain.
 */

import {
  Credential,
  FabrError,
  IAuthChallenge,
  IRequestHead,
  isJsonObject,
  parseJson,
  RenewableToken,
  sendRequest,
} from "@fabr-build/core";
import { IServiceRequest, requestUrl } from "./Signing";
import { IServiceSettings } from "./Types";

/** The name of the CodeArtifact service under an account. */
export const CODEARTIFACT_SERVICE = "codeartifact";

/** Make the URL of `repository`'s endpoint for `format` in the domain `domain` that `owner` owns, in `region`, or at `endpoint` where there is one. */
export function endpointUrl(
  domain: string,
  owner: string,
  region: string,
  format: string,
  repository: string,
  endpoint?: URL
): string {
  const base =
    endpoint === undefined ? `https://${domain}-${owner}.d.codeartifact.${region}.amazonaws.com` : endpoint.href.replace(/\/+$/, "");
  return `${base}/${format}/${repository}/`;
}

/** Make the `GetAuthorizationToken` request for the domain `domain` that `owner` owns: to `endpoint` where there is one, else to CodeArtifact's API in `region`. */
export function tokenRequest(
  domain: string,
  owner: string,
  region: string,
  endpoint?: URL
): IServiceRequest & { readonly body: string } {
  const base =
    endpoint === undefined
      ? { protocol: "https:", hostname: `codeartifact.${region}.amazonaws.com`, path: "/v1/authorization-token" }
      : {
          protocol: endpoint.protocol,
          hostname: endpoint.hostname,
          ...(endpoint.port === "" ? {} : { port: Number(endpoint.port) }),
          path: `${endpoint.pathname.replace(/\/+$/, "")}/v1/authorization-token`,
        };
  return {
    ...base,
    method: "POST",
    query: new Map([
      ["domain", domain],
      ["domain-owner", owner],
    ]),
    body: "",
  };
}

/** Read a `GetAuthorizationToken` answer: its token. Throws where it holds none. */
export function toCodeArtifactToken(json: unknown): string {
  if (!isJsonObject(json) || typeof json.authorizationToken !== "string" || json.authorizationToken === "") {
    throw new FabrError("the answer holds no authorization token");
  }
  return json.authorizationToken;
}

/**
 * Make a domain's token, as CodeArtifact's `GetAuthorizationToken` gives it,
 * signed with the account's credentials.
 */
export function codeArtifactToken(account: IServiceSettings, domain: string, owner: string): RenewableToken<string> {
  return new RenewableToken(() => {
    const request = tokenRequest(domain, owner, account.region, account.endpoint);
    const url = requestUrl(request);
    return account.signer
      .sign(request, CODEARTIFACT_SERVICE, account.region)
      .then(headers => sendRequest(url, { method: "POST", headers, body: request.body }))
      .then(response => {
        if (response.statusCode !== 200) {
          throw new FabrError(`CodeArtifact refused a token for the domain ${domain} (${response.statusCode})`).withHelp(
            "signing in to CodeArtifact needs the codeartifact:GetAuthorizationToken and sts:GetServiceBearerToken permissions"
          );
        }
        return parseJson(response.body, `token from ${url}`, toCodeArtifactToken);
      });
  });
}

/**
 * Make the credential a repository of `format` signs in to CodeArtifact with:
 * the domain's token as `format`'s clients send it, a bearer token for npm,
 * else basic authentication as the user `aws`.
 */
export function formatCredential(token: RenewableToken<string>, format: string): Credential {
  return {
    authorize: (_request: IRequestHead, challenge?: IAuthChallenge) =>
      token
        .forRequest(challenge)
        .then(
          value =>
            new Map([
              ["authorization", format === "npm" ? `Bearer ${value}` : `Basic ${Buffer.from(`aws:${value}`).toString("base64")}`],
            ])
        ),
  };
}
