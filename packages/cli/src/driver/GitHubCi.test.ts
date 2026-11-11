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
import { gitHubBuild } from "./GitHubCi";

/** Make an unsigned JWT whose payload is `claims`. */
function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part(claims)}.signature`;
}

function issuing(claims: Record<string, unknown>): (audience: string) => Computable<string> {
  return () => Computable.resolve(jwt(claims));
}

const SUBJECT = { name: "pkg:npm/%40acme/widgets@1.0.0", digest: { sha512: "ab12" } };

const GITHUB_ENV = {
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "acme/widgets",
  GITHUB_REPOSITORY_ID: "101",
  GITHUB_REPOSITORY_OWNER_ID: "202",
  GITHUB_WORKFLOW_REF: "acme/widgets/.github/workflows/release.yml@refs/tags/v1.0.0",
  GITHUB_EVENT_NAME: "release",
  GITHUB_REF: "refs/tags/v1.0.0",
  GITHUB_SHA: "0123abcd",
  GITHUB_RUN_ID: "303",
  GITHUB_RUN_ATTEMPT: "1",
  RUNNER_ENVIRONMENT: "github-hosted",
};

/* The statement npm 11.12.1's libnpmpublish makes for this environment. */
const NPM_GITHUB_STATEMENT =
  '{"_type":"https://in-toto.io/Statement/v1","subject":[{"name":"pkg:npm/%40acme/widgets@1.0.0","digest":{"sha512":"ab12"}}],"predicateType":"https://slsa.dev/provenance/v1","predicate":{"buildDefinition":{"buildType":"https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1","externalParameters":{"workflow":{"ref":"refs/tags/v1.0.0","repository":"https://github.com/acme/widgets","path":".github/workflows/release.yml"}},"internalParameters":{"github":{"event_name":"release","repository_id":"101","repository_owner_id":"202"}},"resolvedDependencies":[{"uri":"git+https://github.com/acme/widgets@refs/tags/v1.0.0","digest":{"gitCommit":"0123abcd"}}]},"runDetails":{"builder":{"id":"https://github.com/actions/runner/github-hosted"},"metadata":{"invocationId":"https://github.com/acme/widgets/actions/runs/303/attempts/1"}}}}';

describe("gitHubBuild", () => {
  it("states a GitHub Actions run exactly as npm does", () => {
    const build = gitHubBuild(GITHUB_ENV, issuing({}))!;
    expect(JSON.stringify(provenanceStatement(SUBJECT, build))).to.equal(NPM_GITHUB_STATEMENT);
    expect(build.sourceRepository).to.equal("https://github.com/acme/widgets");
  });

  it("is absent where GitHub's environment lacks a fact it records", () => {
    expect(gitHubBuild({ ...GITHUB_ENV, GITHUB_SHA: "" }, issuing({}))).to.equal(undefined);
  });

  it("reads whether the source is public from the token's repository_visibility", async () => {
    expect(await gitHubBuild(GITHUB_ENV, issuing({ repository_visibility: "public" }))!.isPublicSource()).to.equal(true);
    expect(await gitHubBuild(GITHUB_ENV, issuing({ repository_visibility: "private" }))!.isPublicSource()).to.equal(false);
  });
});
