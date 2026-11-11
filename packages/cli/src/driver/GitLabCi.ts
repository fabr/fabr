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

import { Computable, IdentityProvider, ISlsaBuild, jwtClaims, SIGSTORE_AUDIENCE } from "@fabr-build/core";

/**
 * Make the identity provider of the GitLab CI/CD job `env` describes, whose
 * tokens, given to the job before it ran, `token` answers with.
 */
export function gitLabCiProvider(env: NodeJS.ProcessEnv, token: (audience: string) => Computable<string>): IdentityProvider {
  return { token, build: gitLabBuild(env, token) };
}

/** The GitLab CI/CD variables npm records as a GitLab build's parameters. */
const GITLAB_PARAMETERS = [
  "CI",
  "CI_API_GRAPHQL_URL",
  "CI_API_V4_URL",
  "CI_BUILD_BEFORE_SHA",
  "CI_BUILD_ID",
  "CI_BUILD_NAME",
  "CI_BUILD_REF",
  "CI_BUILD_REF_NAME",
  "CI_BUILD_REF_SLUG",
  "CI_BUILD_STAGE",
  "CI_COMMIT_BEFORE_SHA",
  "CI_COMMIT_BRANCH",
  "CI_COMMIT_REF_NAME",
  "CI_COMMIT_REF_PROTECTED",
  "CI_COMMIT_REF_SLUG",
  "CI_COMMIT_SHA",
  "CI_COMMIT_SHORT_SHA",
  "CI_COMMIT_TIMESTAMP",
  "CI_COMMIT_TITLE",
  "CI_CONFIG_PATH",
  "CI_DEFAULT_BRANCH",
  "CI_DEPENDENCY_PROXY_DIRECT_GROUP_IMAGE_PREFIX",
  "CI_DEPENDENCY_PROXY_GROUP_IMAGE_PREFIX",
  "CI_DEPENDENCY_PROXY_SERVER",
  "CI_DEPENDENCY_PROXY_USER",
  "CI_JOB_ID",
  "CI_JOB_NAME",
  "CI_JOB_NAME_SLUG",
  "CI_JOB_STAGE",
  "CI_JOB_STARTED_AT",
  "CI_JOB_URL",
  "CI_NODE_TOTAL",
  "CI_PAGES_DOMAIN",
  "CI_PAGES_URL",
  "CI_PIPELINE_CREATED_AT",
  "CI_PIPELINE_ID",
  "CI_PIPELINE_IID",
  "CI_PIPELINE_SOURCE",
  "CI_PIPELINE_URL",
  "CI_PROJECT_CLASSIFICATION_LABEL",
  "CI_PROJECT_DESCRIPTION",
  "CI_PROJECT_ID",
  "CI_PROJECT_NAME",
  "CI_PROJECT_NAMESPACE",
  "CI_PROJECT_NAMESPACE_ID",
  "CI_PROJECT_PATH",
  "CI_PROJECT_PATH_SLUG",
  "CI_PROJECT_REPOSITORY_LANGUAGES",
  "CI_PROJECT_ROOT_NAMESPACE",
  "CI_PROJECT_TITLE",
  "CI_PROJECT_URL",
  "CI_PROJECT_VISIBILITY",
  "CI_REGISTRY",
  "CI_REGISTRY_IMAGE",
  "CI_REGISTRY_USER",
  "CI_RUNNER_DESCRIPTION",
  "CI_RUNNER_ID",
  "CI_RUNNER_TAGS",
  "CI_SERVER_HOST",
  "CI_SERVER_NAME",
  "CI_SERVER_PORT",
  "CI_SERVER_PROTOCOL",
  "CI_SERVER_REVISION",
  "CI_SERVER_SHELL_SSH_HOST",
  "CI_SERVER_SHELL_SSH_PORT",
  "CI_SERVER_URL",
  "CI_SERVER_VERSION",
  "CI_SERVER_VERSION_MAJOR",
  "CI_SERVER_VERSION_MINOR",
  "CI_SERVER_VERSION_PATCH",
  "CI_TEMPLATE_REGISTRY_HOST",
  "GITLAB_CI",
  "GITLAB_FEATURES",
  "GITLAB_USER_ID",
  "GITLAB_USER_LOGIN",
  "RUNNER_GENERATE_ARTIFACTS_METADATA",
];

/**
 * Make the build of the GitLab CI/CD job `env` describes, as npm states it
 * (SLSA provenance v0.2, npm's GitLab build type), or undefined where `env`
 * lacks any of the facts it must record or gives the job no token for Sigstore
 * (`SIGSTORE_ID_TOKEN`). `token` issues the job's identity tokens.
 */
export function gitLabBuild(env: NodeJS.ProcessEnv, token: (audience: string) => Computable<string>): ISlsaBuild | undefined {
  if (["SIGSTORE_ID_TOKEN", "CI_PROJECT_URL", "CI_RUNNER_ID", "CI_COMMIT_SHA", "CI_JOB_NAME", "CI_JOB_URL"].some(fact => !env[fact])) {
    return undefined;
  }
  const source = { uri: `git+${env.CI_PROJECT_URL}`, digest: { sha1: env.CI_COMMIT_SHA } };
  return {
    statementType: "https://in-toto.io/Statement/v0.1",
    predicateType: "https://slsa.dev/provenance/v0.2",
    predicate: {
      buildType: "https://github.com/npm/cli/gitlab/v0alpha1",
      builder: { id: `${env.CI_PROJECT_URL}/-/runners/${env.CI_RUNNER_ID}` },
      invocation: {
        configSource: { ...source, entryPoint: env.CI_JOB_NAME },
        parameters: Object.fromEntries(GITLAB_PARAMETERS.map(name => [name, env[name]])),
        environment: {
          name: env.CI_RUNNER_DESCRIPTION,
          architecture: env.CI_RUNNER_EXECUTABLE_ARCH,
          server: env.CI_SERVER_URL,
          project: env.CI_PROJECT_PATH,
          job: { id: env.CI_JOB_ID },
          pipeline: { id: env.CI_PIPELINE_ID, ref: env.CI_CONFIG_PATH },
        },
      },
      metadata: {
        buildInvocationId: env.CI_JOB_URL,
        completeness: { parameters: true, environment: true, materials: false },
        reproducible: false,
      },
      materials: [source],
    },
    sourceRepository: env.CI_PROJECT_URL!,
    isPublicSource: () => token(SIGSTORE_AUDIENCE).then(sigstore => claimOf(sigstore, "project_visibility") === "public"),
  };
}

/** Get the claim `name` of the job's identity token for Sigstore. */
function claimOf(token: string, name: string): unknown {
  return jwtClaims(token, "the job's identity token for Sigstore")[name];
}
