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

import { expect } from "chai";
import { Computable, provenanceStatement } from "@fabr-build/core";
import { gitLabBuild } from "./GitLabCi";

/** Make an unsigned JWT whose payload is `claims`. */
function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part(claims)}.signature`;
}

function issuing(claims: Record<string, unknown>): (audience: string) => Computable<string> {
  return () => Computable.resolve(jwt(claims));
}

const SUBJECT = { name: "pkg:npm/%40acme/widgets@1.0.0", digest: { sha512: "ab12" } };

const GITLAB_ENV = {
  CI: "true",
  GITLAB_CI: "true",
  SIGSTORE_ID_TOKEN: "token",
  CI_PROJECT_URL: "https://gitlab.com/acme/widgets",
  CI_RUNNER_ID: "12270837",
  CI_COMMIT_SHA: "0123abcd",
  CI_JOB_NAME: "publish",
  CI_JOB_URL: "https://gitlab.com/acme/widgets/-/jobs/404",
  CI_JOB_ID: "404",
  CI_PIPELINE_ID: "505",
  CI_CONFIG_PATH: ".gitlab-ci.yml",
  CI_PROJECT_PATH: "acme/widgets",
  CI_SERVER_URL: "https://gitlab.com",
  CI_RUNNER_DESCRIPTION: "shared-runner",
  CI_RUNNER_EXECUTABLE_ARCH: "linux/amd64",
  CI_COMMIT_REF_NAME: "v1.0.0",
};

/* The statement npm 11.12.1's libnpmpublish makes for this environment. */
const NPM_GITLAB_STATEMENT =
  '{"_type":"https://in-toto.io/Statement/v0.1","subject":[{"name":"pkg:npm/%40acme/widgets@1.0.0","digest":{"sha512":"ab12"}}],"predicateType":"https://slsa.dev/provenance/v0.2","predicate":{"buildType":"https://github.com/npm/cli/gitlab/v0alpha1","builder":{"id":"https://gitlab.com/acme/widgets/-/runners/12270837"},"invocation":{"configSource":{"uri":"git+https://gitlab.com/acme/widgets","digest":{"sha1":"0123abcd"},"entryPoint":"publish"},"parameters":{"CI":"true","CI_COMMIT_REF_NAME":"v1.0.0","CI_COMMIT_SHA":"0123abcd","CI_CONFIG_PATH":".gitlab-ci.yml","CI_JOB_ID":"404","CI_JOB_NAME":"publish","CI_JOB_URL":"https://gitlab.com/acme/widgets/-/jobs/404","CI_PIPELINE_ID":"505","CI_PROJECT_PATH":"acme/widgets","CI_PROJECT_URL":"https://gitlab.com/acme/widgets","CI_RUNNER_DESCRIPTION":"shared-runner","CI_RUNNER_ID":"12270837","CI_SERVER_URL":"https://gitlab.com","GITLAB_CI":"true"},"environment":{"name":"shared-runner","architecture":"linux/amd64","server":"https://gitlab.com","project":"acme/widgets","job":{"id":"404"},"pipeline":{"id":"505","ref":".gitlab-ci.yml"}}},"metadata":{"buildInvocationId":"https://gitlab.com/acme/widgets/-/jobs/404","completeness":{"parameters":true,"environment":true,"materials":false},"reproducible":false},"materials":[{"uri":"git+https://gitlab.com/acme/widgets","digest":{"sha1":"0123abcd"}}]}}';

describe("gitLabBuild", () => {
  it("states a GitLab CI/CD job exactly as npm does", () => {
    const build = gitLabBuild(GITLAB_ENV, issuing({}))!;
    expect(JSON.stringify(provenanceStatement(SUBJECT, build))).to.equal(NPM_GITLAB_STATEMENT);
    expect(build.sourceRepository).to.equal("https://gitlab.com/acme/widgets");
  });

  it("is absent where the job has no token for Sigstore", () => {
    expect(gitLabBuild({ ...GITLAB_ENV, SIGSTORE_ID_TOKEN: undefined }, issuing({}))).to.equal(undefined);
  });

  it("reads whether the source is public from the token's project_visibility", async () => {
    expect(await gitLabBuild(GITLAB_ENV, issuing({ project_visibility: "public" }))!.isPublicSource()).to.equal(true);
    expect(await gitLabBuild(GITLAB_ENV, issuing({ project_visibility: "internal" }))!.isPublicSource()).to.equal(false);
  });
});
