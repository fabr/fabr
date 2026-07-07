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
import {
  explainResolutionPath,
  IRequirementEdge,
  IResolutionOrigin,
  Name,
  parseVersion,
  ROOT_REQUIRER,
  Selected,
  SemverVersion,
  versionToString,
} from "@fabr/core";
import { npmPackageOfPath, splitNpmReference } from "./NPMRepository";

function selection(
  pkg: string,
  version: string,
  reachedVia?: IRequirementEdge,
  selectedBy?: IRequirementEdge
): Selected<SemverVersion> {
  return { pkg, version: parseVersion(version), reachedVia, selectedBy: selectedBy ?? reachedVia };
}

function origin(
  root: { pkg: string; constraint: string },
  selections: Selected<SemverVersion>[]
): IResolutionOrigin<SemverVersion> {
  return {
    kind: "package-resolution",
    repository: "https://registry.example.org",
    root,
    selections,
    versionToString,
    packageOfPath: npmPackageOfPath,
  };
}

const ROOT_EDGE = (constraint: string): IRequirementEdge => ({ requiredBy: ROOT_REQUIRER, constraint });

describe("explainResolutionPath", () => {
  const chokidarClosure = origin({ pkg: "chokidar", constraint: "3.5.3" }, [
    selection("chokidar", "3.5.3", ROOT_EDGE("3.5.3")),
    selection("anymatch", "3.1.2", { requiredBy: "chokidar@3.5.3", constraint: "~3.1.2" }),
    selection("readdirp", "3.6.0", { requiredBy: "chokidar@3.5.3", constraint: "~3.6.0" }),
    selection(
      "picomatch",
      "2.2.1",
      { requiredBy: "anymatch@3.1.2", constraint: "^2.0.4" },
      { requiredBy: "readdirp@3.6.0", constraint: "^2.2.1" }
    ),
  ]);

  it("renders the chain through the requirement that picked the version", () => {
    expect(explainResolutionPath(chokidarClosure, "picomatch/LICENSE")).to.deep.equal([
      "chokidar@3.5.3 -> readdirp@3.6.0 (~3.6.0) -> picomatch@2.2.1 (^2.2.1)",
    ]);
  });

  it("renders a plain transitive chain", () => {
    expect(explainResolutionPath(chokidarClosure, "anymatch/index.js")).to.deep.equal([
      "chokidar@3.5.3 -> anymatch@3.1.2 (~3.1.2)",
    ]);
  });

  it("renders a root package tersely", () => {
    expect(explainResolutionPath(chokidarClosure, "chokidar/lib/index.js")).to.deep.equal(["chokidar@3.5.3 (3.5.3)"]);
  });

  it("handles scoped package paths", () => {
    const scoped = origin({ pkg: "@types/picomatch", constraint: "2.3.0" }, [
      selection("@types/picomatch", "2.3.0", ROOT_EDGE("2.3.0")),
    ]);
    expect(explainResolutionPath(scoped, "@types/picomatch/index.d.ts")).to.deep.equal(["@types/picomatch@2.3.0 (2.3.0)"]);
  });

  it("marks a winning requirement from a superseded version", () => {
    const withSuperseded = origin({ pkg: "A", constraint: "^1.0.0" }, [
      selection("A", "1.2.0", ROOT_EDGE("^1.0.0")),
      selection(
        "D",
        "1.5.0",
        { requiredBy: "A@1.2.0", constraint: "^1.1.0" },
        { requiredBy: "A@1.0.0", constraint: "^1.5.0" }
      ),
    ]);
    expect(explainResolutionPath(withSuperseded, "D/index.js")).to.deep.equal([
      "A@1.2.0 -> D@1.5.0 (^1.1.0)",
      "version 1.5.0 raised by A@1.0.0 requiring ^1.5.0 (since superseded)",
    ]);
  });

  it("degrades gracefully for a package not in the resolution", () => {
    expect(explainResolutionPath(chokidarClosure, "mystery/index.js")).to.deep.equal([
      "mystery is not present in the resolution of chokidar:3.5.3",
    ]);
  });
});

describe("splitNpmReference", () => {
  function split(ref: string): { requirement: string; projection?: { pattern: string; prefix: string } } {
    const { requirement, projection } = splitNpmReference(Name.fromLiteral(ref));
    return {
      requirement: requirement.getSimpleName() as string,
      ...(projection ? { projection: { pattern: projection.pattern.getSimpleName() as string, prefix: projection.prefix } } : {}),
    };
  }

  it("leaves a requirement-only reference whole", () => {
    expect(split("esbuild:0.28.1")).to.deep.equal({ requirement: "esbuild:0.28.1" });
  });

  it("splits a colon projection (strips the requirement prefix)", () => {
    expect(split("esbuild:0.28.1:package.json")).to.deep.equal({
      requirement: "esbuild:0.28.1",
      projection: { pattern: "package.json", prefix: "" },
    });
  });

  it("splits a slash projection (retains the written prefix)", () => {
    expect(split("esbuild:0.28.1/lib/main.js")).to.deep.equal({
      requirement: "esbuild:0.28.1",
      projection: { pattern: "lib/main.js", prefix: "esbuild:0.28.1/" },
    });
  });

  it("does not treat a scoped name's slash as a projection boundary", () => {
    expect(split("@types/node:20.12.7")).to.deep.equal({ requirement: "@types/node:20.12.7" });
    expect(split("@types/node:20.12.7:index.d.ts")).to.deep.equal({
      requirement: "@types/node:20.12.7",
      projection: { pattern: "index.d.ts", prefix: "" },
    });
  });
});
