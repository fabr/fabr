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
import { buildCatalog } from "./Catalog";
import { packageOfTypes, planTargets, typesPackageOf } from "./Targets";
import { Report } from "./Report";
import { writeProject } from "./TestProject";
import { readWorkspace } from "./Workspace";

/** Plan the targets of the project `files` describe. */
function plan(files: Record<string, string | object>): { plans: ReturnType<typeof planTargets>; report: string } {
  const workspace = readWorkspace(writeProject(files));
  const report = new Report();
  const { addressOf } = buildCatalog(workspace, undefined, report);
  const plans = planTargets(workspace, addressOf);
  plans.forEach(each => report.addAll(each.report));
  return { plans, report: report.render().join("\n") };
}

describe("planning a package's target", () => {
  it("states the package's dependencies, a peer as provided, and another workspace package as its target", () => {
    const { plans } = plan({
      "package.json": { workspaces: ["p/*"] },
      "p/a/package.json": {
        name: "a",
        dependencies: { b: "workspace:*", lodash: "^4.0.0" },
        devDependencies: { react: "^18.0.0", vitest: "^2.0.0" },
        peerDependencies: { react: ">=17", "react-dom": ">=17" },
        peerDependenciesMeta: { "react-dom": { optional: true } },
      },
      "p/a/src/index.ts": "",
      "p/a/src/index.test.ts": "",
      "p/b/package.json": { name: "b" },
    });
    expect(plans[0]).to.deep.include({
      target: "a",
      srcs: ["src:**/*.ts"],
      tests: ["src:**/*.test.ts"],
      deps: ["b", "@dep:lodash", "@dep:vitest"],
      provided: ["@dep:react"],
      optionalProvided: ["@dep:react-dom"],
    });
  });

  it("adds the root's dependencies a package imports undeclared, with their types", () => {
    const { plans, report } = plan({
      "package.json": {
        workspaces: ["p/*"],
        devDependencies: { lodash: "^4.0.0", "@types/lodash": "^4.0.0", "@types/aws-lambda": "^8.0.0", "@types/node": "^20.0.0" },
      },
      "p/a/package.json": { name: "a" },
      "p/a/tsconfig.json": '{ "compilerOptions": { "types": ["node"] } }',
      "p/a/src/index.ts": 'import _ from "lodash"; import type { Handler } from "aws-lambda"; import x from "missing";',
    });
    expect([...plans[0].deps].sort()).to.deep.equal([
      "@dep:@types/aws-lambda",
      "@dep:@types/lodash",
      "@dep:@types/node",
      "@dep:lodash",
    ]);
    expect(report).to.include("missing, imported in p/a");
  });

  it("takes every root @types package as ambient where tsconfig sets no types", () => {
    const { plans } = plan({
      "package.json": { workspaces: ["p/*"], devDependencies: { "@types/node": "^20.0.0", "@types/jest": "^29.0.0" } },
      "p/a/package.json": { name: "a" },
      "p/a/src/index.ts": "",
    });
    expect([...plans[0].deps].sort()).to.deep.equal(["@dep:@types/jest", "@dep:@types/node"]);
  });

  it("leaves out a tool's configuration and the sources of a nested package", () => {
    const { plans } = plan({
      "package.json": { workspaces: ["app", "app/plugin"] },
      "app/package.json": { name: "app" },
      "app/jest.config.js": 'require("jest-preset");',
      "app/index.ts": "",
      "app/plugin/package.json": { name: "plugin" },
      "app/plugin/index.js": "",
    });
    expect(plans.map(each => [each.target, each.srcs])).to.deep.equal([
      ["app", ["**/*.ts"]],
      ["plugin", ["**/*.js"]],
    ]);
  });

  it("names an @types package and the package it types", () => {
    expect(typesPackageOf("@scope/name")).to.equal("@types/scope__name");
    expect(packageOfTypes("@types/scope__name")).to.equal("@scope/name");
    expect(packageOfTypes("@types/node")).to.equal("node");
  });
});
