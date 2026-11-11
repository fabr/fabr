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

import { Computable, FabrError, IdentityProvider, jwtClaims } from "@fabr-build/core";
import { gitHubCiProvider } from "./GitHubCi";
import { gitLabCiProvider } from "./GitLabCi";

/** The variables a job is given identity tokens in, by npm's convention: GitLab's
 *  `id_tokens` and CircleCI's `circleci run oidc get` follow it. */
const TOKEN_VARIABLES = ["NPM_ID_TOKEN", "SIGSTORE_ID_TOKEN"];

/**
 * Make the identity provider of the CI job `env` describes, or undefined where
 * the job has no identity: a GitHub Actions workflow run, a GitLab CI/CD job,
 * or any other job given tokens in {@link TOKEN_VARIABLES} (CircleCI's). Each
 * issues OIDC ID tokens.
 */
export function identityProviderOf(env: NodeJS.ProcessEnv): IdentityProvider | undefined {
  if (env.GITHUB_ACTIONS === "true") {
    return gitHubCiProvider(env);
  }
  const token = givenTokens(env);
  if (token === undefined) {
    return undefined;
  }
  return env.GITLAB_CI === "true" ? gitLabCiProvider(env, token) : { token };
}

/** Make the issuer of the tokens `env` gives the job in {@link TOKEN_VARIABLES},
 *  issued before it ran: each answers only for the audiences its `aud` claim
 *  names. Undefined where `env` gives none. */
function givenTokens(env: NodeJS.ProcessEnv): ((audience: string) => Computable<string>) | undefined {
  const given = TOKEN_VARIABLES.filter(variable => !!env[variable]);
  if (given.length === 0) {
    return undefined;
  }
  const token = (audience: string): Computable<string> =>
    Computable.resolve(undefined).then(() => {
      const audiences = given.map(variable => ({ variable, audiences: audiencesOf(env[variable]!, variable) }));
      const answering = audiences.find(token => token.audiences.includes(audience));
      if (answering === undefined) {
        const named = audiences
          .map(token => `${token.variable} is for ${token.audiences.map(a => "'" + a + "'").join(", ")}`)
          .join("; ");
        throw new FabrError(`none of the job's identity tokens is for '${audience}' (${named})`).withHelp(
          `issue the token with the audience '${audience}'`
        );
      }
      return env[answering.variable]!;
    });
  return token;
}

/** Get the audiences the `aud` claim of `jwt`, given in `variable`, names. */
function audiencesOf(jwt: string, variable: string): string[] {
  const aud = jwtClaims(jwt, `the job's identity token in ${variable}`).aud;
  if (typeof aud === "string") {
    return [aud];
  }
  if (Array.isArray(aud) && aud.every(a => typeof a === "string")) {
    return aud as string[];
  }
  throw new FabrError(`the job's identity token in ${variable} has no 'aud' claim`);
}
