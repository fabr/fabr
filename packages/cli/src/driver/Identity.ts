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

import { Computable, FabrError, IdentityProvider, parseJson, sendRequest, toJsonObject } from "@fabr-build/core";

/**
 * Make the identity provider of the CI job `env` describes, or undefined where
 * the job has none: GitHub Actions, for a workflow granted `permissions:
 * id-token: write`, else the token a job was given in `NPM_ID_TOKEN` (npm's
 * convention, which GitLab's `id_tokens` and CircleCI's `circleci run oidc get`
 * follow). Each issues OIDC ID tokens.
 */
export function identityProviderOf(env: NodeJS.ProcessEnv): IdentityProvider | undefined {
  return gitHubProvider(env) ?? givenTokenProvider(env.NPM_ID_TOKEN);
}

/** Make the provider that asks GitHub Actions for a token on each request,
 *  where `env` has the request endpoint and its token. */
function gitHubProvider(env: NodeJS.ProcessEnv): IdentityProvider | undefined {
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    return undefined;
  }
  return {
    token(audience: string): Computable<string> {
      const url = new URL(requestUrl);
      url.searchParams.set("audience", audience);
      return sendRequest(url.href, {
        method: "GET",
        headers: { authorization: `Bearer ${requestToken}`, accept: "application/json" },
      }).then(response => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          throw new FabrError(`GitHub Actions did not issue an identity token for '${audience}' (${response.statusCode})`);
        }
        return parseJson(response.body, "GitHub Actions identity token response", toIssuedToken);
      });
    },
  };
}

/** Convert GitHub's token response, `{ "value": "<jwt>" }`, to the token. */
function toIssuedToken(json: unknown): string {
  const value = toJsonObject(json).value;
  if (typeof value !== "string" || value === "") {
    throw new FabrError("expected a 'value' string");
  }
  return value;
}

/** Make the provider of `token`, a token issued before the job ran: it answers
 *  only for the audiences the token's `aud` claim names. */
function givenTokenProvider(token: string | undefined): IdentityProvider | undefined {
  if (!token) {
    return undefined;
  }
  return {
    token(audience: string): Computable<string> {
      return Computable.resolve(undefined).then(() => {
        const audiences = audiencesOf(token);
        if (!audiences.includes(audience)) {
          const named = audiences.map(a => "'" + a + "'").join(", ");
          throw new FabrError(`the job's identity token in NPM_ID_TOKEN is for ${named}, not '${audience}'`).withHelp(`issue the token with the audience '${audience}'`);
        }
        return token;
      });
    },
  };
}

/** Get the audiences a JWT's `aud` claim names, read from its payload without
 *  verifying it (the token's recipient does that). */
function audiencesOf(jwt: string): string[] {
  const payload = jwt.split(".")[1];
  if (payload === undefined) {
    throw new FabrError("the job's identity token in NPM_ID_TOKEN is not a JWT");
  }
  return parseJson(Buffer.from(payload, "base64url"), "payload of the job's identity token in NPM_ID_TOKEN", toAudiences);
}

/** Convert a JWT payload to the audiences its `aud` claim names: one, or a list. */
function toAudiences(json: unknown): string[] {
  const aud = toJsonObject(json).aud;
  if (typeof aud === "string") {
    return [aud];
  }
  if (Array.isArray(aud) && aud.every(a => typeof a === "string")) {
    return aud as string[];
  }
  throw new FabrError("expected an 'aud' claim");
}
