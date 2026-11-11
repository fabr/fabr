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

import {
  Computable,
  FabrError,
  IdentityProvider,
  ISlsaBuild,
  jwtClaims,
  parseJson,
  sendRequest,
  SIGSTORE_AUDIENCE,
  toJsonObject,
} from "@fabr-build/core";

/**
 * Make the identity provider of the GitHub Actions workflow run `env`
 * describes, which asks GitHub for a token on each request, or undefined where
 * the workflow was granted no identity (`permissions: id-token: write` sets
 * the request endpoint and its token).
 */
export function gitHubCiProvider(env: NodeJS.ProcessEnv): IdentityProvider | undefined {
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    return undefined;
  }
  const token = (audience: string): Computable<string> => {
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
  };
  return { token, build: gitHubBuild(env, token) };
}

/** Convert GitHub's token response, `{ "value": "<jwt>" }`, to the token. */
function toIssuedToken(json: unknown): string {
  const value = toJsonObject(json).value;
  if (typeof value !== "string" || value === "") {
    throw new FabrError("expected a 'value' string");
  }
  return value;
}

/**
 * Make the build of the GitHub Actions workflow run `env` describes, as npm
 * states it (SLSA provenance v1, GitHub's workflow build type), or undefined
 * where `env` lacks any of the facts it records. `token` issues the job's
 * identity tokens.
 */
export function gitHubBuild(env: NodeJS.ProcessEnv, token: (audience: string) => Computable<string>): ISlsaBuild | undefined {
  const facts = [
    "GITHUB_SERVER_URL",
    "GITHUB_REPOSITORY",
    "GITHUB_REPOSITORY_ID",
    "GITHUB_REPOSITORY_OWNER_ID",
    "GITHUB_WORKFLOW_REF",
    "GITHUB_EVENT_NAME",
    "GITHUB_REF",
    "GITHUB_SHA",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "RUNNER_ENVIRONMENT",
  ];
  if (facts.some(fact => !env[fact])) {
    return undefined;
  }
  const repository = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}`;
  const relativeRef = env.GITHUB_WORKFLOW_REF!.replace(`${env.GITHUB_REPOSITORY}/`, "");
  const at = relativeRef.indexOf("@");
  return {
    statementType: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: {
          workflow: { ref: relativeRef.slice(at + 1), repository, path: relativeRef.slice(0, at) },
        },
        internalParameters: {
          github: {
            event_name: env.GITHUB_EVENT_NAME,
            repository_id: env.GITHUB_REPOSITORY_ID,
            repository_owner_id: env.GITHUB_REPOSITORY_OWNER_ID,
          },
        },
        resolvedDependencies: [{ uri: `git+${repository}@${env.GITHUB_REF}`, digest: { gitCommit: env.GITHUB_SHA } }],
      },
      runDetails: {
        builder: { id: `https://github.com/actions/runner/${env.RUNNER_ENVIRONMENT}` },
        metadata: { invocationId: `${repository}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}` },
      },
    },
    sourceRepository: repository,
    isPublicSource: () => token(SIGSTORE_AUDIENCE).then(sigstore => claimOf(sigstore, "repository_visibility") === "public"),
  };
}

/** Get the claim `name` of the job's identity token for Sigstore. */
function claimOf(token: string, name: string): unknown {
  return jwtClaims(token, "the job's identity token for Sigstore")[name];
}
