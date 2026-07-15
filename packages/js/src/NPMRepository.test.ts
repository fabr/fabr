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
  BUILD_OPERATION,
  Computable,
  explainResolutionPath,
  FILES_OPERATION,
  FileSet,
  IRequirementEdge,
  IResolutionOrigin,
  MemoryFile,
  Name,
  PackageFileSet,
  parseVersion,
  RepositoryContext,
  RepositoryRef,
  resolveAndMaterialize,
  ROOT_REQUIRER,
  Selected,
  SemverVersion,
  TARGET,
  versionToString,
} from "@fabr-build/core";
import {
  matchesTargetPlatform,
  NPMRepository,
  npmPackageOfPath,
  parseMetadataResponse,
  platformGateAdmits,
  splitNpmReference,
  unsupportedPlatformReason,
} from "./NPMRepository";

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

describe("platformGateAdmits", () => {
  it("admits any value when the gate is absent or empty", () => {
    expect(platformGateAdmits(undefined, "linux")).to.equal(true);
    expect(platformGateAdmits([], "linux")).to.equal(true);
  });

  it("treats a gate as an allow-list", () => {
    expect(platformGateAdmits(["darwin", "linux"], "linux")).to.equal(true);
    expect(platformGateAdmits(["darwin", "linux"], "win32")).to.equal(false);
  });

  it("honours negated entries as a block-list", () => {
    expect(platformGateAdmits(["!win32"], "linux")).to.equal(true);
    expect(platformGateAdmits(["!win32"], "win32")).to.equal(false);
  });

  it("a block wins even against an allow of the same value", () => {
    expect(platformGateAdmits(["linux", "!linux"], "linux")).to.equal(false);
  });

  it("cannot confirm a gated package when the host fact is unknown", () => {
    expect(platformGateAdmits(["linux"], undefined)).to.equal(false);
    expect(platformGateAdmits(undefined, undefined)).to.equal(true);
  });
});

describe("matchesTargetPlatform", () => {
  const target = { os: "darwin", cpu: "arm64" };

  it("keeps the target-matching native variant", () => {
    expect(matchesTargetPlatform({ os: ["darwin"], cpu: ["arm64"] }, target)).to.equal(true);
  });

  it("rejects a variant for another os or cpu", () => {
    expect(matchesTargetPlatform({ os: ["linux"], cpu: ["arm64"] }, target)).to.equal(false);
    expect(matchesTargetPlatform({ os: ["darwin"], cpu: ["x64"] }, target)).to.equal(false);
  });

  it("keeps a platform-agnostic package (no gates)", () => {
    expect(matchesTargetPlatform({}, target)).to.equal(true);
  });

  it("requires both os and cpu to admit the target", () => {
    expect(matchesTargetPlatform({ os: ["darwin", "linux"], cpu: ["x64"] }, target)).to.equal(false);
    expect(matchesTargetPlatform({ os: ["darwin", "linux"], cpu: ["arm64", "x64"] }, target)).to.equal(true);
  });

  it("gates on libc when the target declares one", () => {
    const linuxGnu = { os: "linux", cpu: "x64", libc: "glibc" };
    expect(matchesTargetPlatform({ os: ["linux"], cpu: ["x64"], libc: ["glibc"] }, linuxGnu)).to.equal(true);
    expect(matchesTargetPlatform({ os: ["linux"], cpu: ["x64"], libc: ["musl"] }, linuxGnu)).to.equal(false);
    /* A package with no libc gate admits any libc. */
    expect(matchesTargetPlatform({ os: ["linux"], cpu: ["x64"] }, linuxGnu)).to.equal(true);
  });
});

describe("unsupportedPlatformReason", () => {
  const target = { os: "linux", cpu: "x64", libc: "glibc" };

  it("returns undefined for a supported package", () => {
    expect(unsupportedPlatformReason({ os: ["linux"], cpu: ["x64"] }, target)).to.equal(undefined);
    expect(unsupportedPlatformReason({}, target)).to.equal(undefined);
  });

  it("explains an os mismatch", () => {
    expect(unsupportedPlatformReason({ os: ["darwin"] }, target)).to.equal("os 'linux' is not in [darwin]");
  });

  it("explains a cpu mismatch", () => {
    expect(unsupportedPlatformReason({ cpu: ["arm64"] }, target)).to.equal("cpu 'x64' is not in [arm64]");
  });

  it("explains a libc mismatch", () => {
    expect(unsupportedPlatformReason({ libc: ["musl"] }, target)).to.equal("libc 'glibc' is not in [musl]");
  });

  it("reports both when both mismatch", () => {
    expect(unsupportedPlatformReason({ os: ["darwin"], cpu: ["arm64"] }, target)).to.equal(
      "os 'linux' is not in [darwin]; cpu 'x64' is not in [arm64]"
    );
  });
});

/** The internal name of the metadata file NPMRepository fetches (kept in step
 * with NPMRepository.METADATA_FILE, which is module-private). */
const METADATA_FILE = "metadata.json";
const REG = "https://registry.example.org";

function metadataFor(pkg: string, version: string, deps: Record<string, string>): FileSet {
  const meta = {
    name: pkg,
    version,
    dependencies: deps,
    dist: { tarball: `${REG}/tarball/${version}.tgz`, integrity: "", shasum: "", signatures: [] },
  };
  return new FileSet(new Map([[METADATA_FILE, MemoryFile.from(JSON.stringify(meta))]]));
}

function packageTarball(): FileSet {
  return new FileSet(
    new Map([
      ["package.json", MemoryFile.from("{}")],
      ["index.js", MemoryFile.from("module.exports = {};")],
    ])
  );
}

/**
 * A minimal RepositoryContext that serves a fixed set of URLs and records every
 * fetch, so a test can assert which documents were (and were not) requested.
 * Any unexpected fetch rejects — so a test that expected the dependency closure
 * to be skipped fails loudly if it isn't.
 */
function fakeContext(operation: string, served: Record<string, FileSet>, fetched: string[]): RepositoryContext {
  /* Properties the repository reads: the operation, and a fixed TARGET triple —
   * test packages carry no os/cpu/libc gates, so it never filters anything; it
   * only has to resolve (getJointResolution reads it for the memo key). */
  const globals: Record<string, string> = { [BUILD_OPERATION]: operation, [TARGET]: "arm64-apple-macosx15.0" };
  return {
    getGlobalString: (name: string) =>
      name in globals ? Computable.resolve(globals[name]) : Computable.reject(new Error(`unexpected property: ${name}`)),
    fetch: (url: string) => {
      fetched.push(url);
      return url in served ? Computable.resolve(served[url]) : Computable.reject(new Error(`unexpected fetch: ${url}`));
    },
  } as unknown as RepositoryContext;
}

function toPromise<T>(computable: Computable<T>): Promise<T> {
  return new Promise((resolve, reject) => computable.then(resolve, reject));
}

async function rejection(fn: () => unknown): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a rejection, but none occurred");
}

describe("NPMRepository resolveAll under files", () => {
  it("delivers a package's own files without resolving its dependency closure", async () => {
    const fetched: string[] = [];
    /* The metadata declares a dependency whose fetch is NOT served: if the
     * closure were walked, resolving it would reject with 'unexpected fetch'. */
    const served = {
      [`${REG}/@parcel/watcher/2.4.1`]: metadataFor("@parcel/watcher", "2.4.1", { "node-addon-api": "^7.0.0" }),
      [`${REG}/tarball/2.4.1.tgz`]: packageTarball(),
    };
    const repo = new NPMRepository(REG, fakeContext(FILES_OPERATION, served, fetched));
    const ref = new RepositoryRef(repo, Name.fromLiteral("@parcel/watcher:2.4.1"));

    const [delivered] = await toPromise(resolveAndMaterialize(repo, [ref]));

    expect(delivered).to.be.instanceOf(PackageFileSet);
    const pkg = delivered as PackageFileSet;
    expect(pkg.packageName).to.equal("@parcel/watcher");
    expect(pkg.version).to.equal("2.4.1");
    expect(pkg.dependencies).to.deep.equal([]);
    expect([...pkg].map(([name]) => name).sort()).to.deep.equal(["index.js", "package.json"]);
    /* Only the root's own metadata + tarball were fetched — never the dep. */
    expect(fetched).to.deep.equal([`${REG}/@parcel/watcher/2.4.1`, `${REG}/tarball/2.4.1.tgz`]);
  });

  it("resolves a range standalone at its constraint minimum", async () => {
    const fetched: string[] = [];
    const served = {
      [`${REG}/left-pad/1.2.0`]: metadataFor("left-pad", "1.2.0", {}),
      [`${REG}/tarball/1.2.0.tgz`]: packageTarball(),
    };
    const repo = new NPMRepository(REG, fakeContext(FILES_OPERATION, served, fetched));
    const ref = new RepositoryRef(repo, Name.fromLiteral("left-pad:^1.2.0"));

    const [delivered] = await toPromise(resolveAndMaterialize(repo, [ref]));

    expect((delivered as PackageFileSet).version).to.equal("1.2.0");
  });

  it("rejects projecting into an unconstrained version", async () => {
    const repo = new NPMRepository(REG, fakeContext(FILES_OPERATION, {}, []));
    const ref = new RepositoryRef(repo, Name.fromLiteral("left-pad:*"));

    const err = await rejection(() => resolveAndMaterialize(repo, [ref]));
    expect(err.message).to.match(/unconstrained/);
  });
});

describe("parseMetadataResponse", () => {
  const metaBuf = (extra: object = {}): Buffer =>
    Buffer.from(
      JSON.stringify({
        name: "pkg",
        version: "1.2.3",
        dist: { tarball: `${REG}/pkg/-/pkg-1.2.3.tgz`, shasum: "s", integrity: "i", signatures: [] },
        ...extra,
      })
    );

  it("accepts a valid single-version metadata document", () => {
    expect(parseMetadataResponse(metaBuf(), "pkg/1.2.3").version).to.equal("1.2.3");
  });

  it("accepts metadata even when it carries a spurious error/code field (its package.json echoed)", () => {
    expect(parseMetadataResponse(metaBuf({ error: "oops", code: "E" }), "pkg/1.2.3").name).to.equal("pkg");
  });

  it("rejects a full packument as the wrong URL, not a single version", () => {
    const doc = Buffer.from(JSON.stringify({ name: "pkg", "dist-tags": {}, versions: {} }));
    expect(() => parseMetadataResponse(doc, "pkg")).to.throw(/wrong URL/i);
  });

  it("treats every non-version, non-packument body as an unusable response", () => {
    /* HTTP-level failures are handled upstream; a body reaching here that isn't a
     * version or packument — an error body, non-JSON, empty, or a non-object — is
     * simply not installable, so they all collapse to one 'unusable' error. */
    const unusable = [
      Buffer.from(JSON.stringify({ error: "Not Found" })), // error body
      Buffer.from(JSON.stringify({ code: "E500", message: "boom" })), // error body
      Buffer.from("<html><body>502 Bad Gateway</body></html>"), // non-JSON (HTML)
      Buffer.from(""), // empty
      Buffer.from('"just a string"'), // valid JSON, not an object
      Buffer.from("null"), // valid JSON, not an object
    ];
    for (const body of unusable) {
      expect(() => parseMetadataResponse(body, "pkg/1")).to.throw(/Invalid response/i);
    }
  });
});

describe("NPMRepository metadata memo", () => {
  it("does not poison the in-process memo with a transient fetch failure", async () => {
    const url = `${REG}/pkg/1.0.0`;
    const good = metadataFor("pkg", "1.0.0", {});
    let failNext = true;
    const globals: Record<string, string> = { [BUILD_OPERATION]: "build", [TARGET]: "arm64-apple-macosx15.0" };
    const context = {
      getGlobalString: (name: string) =>
        name in globals ? Computable.resolve(globals[name]) : Computable.reject(new Error(`unexpected property: ${name}`)),
      fetch: (u: string) => {
        if (u === url && failNext) {
          failNext = false;
          return Computable.reject(new Error("network blip"));
        }
        return u === url ? Computable.resolve(good) : Computable.reject(new Error(`unexpected fetch: ${u}`));
      },
    } as unknown as RepositoryContext;
    const repo = new NPMRepository(REG, context);

    /* The first resolve hits the transient failure. */
    await rejection(() => toPromise(repo.getRequirements("pkg", parseVersion("1.0.0"))));
    /* A retry must re-fetch and succeed — the rejection was not cached. */
    const requirements = await toPromise(repo.getRequirements("pkg", parseVersion("1.0.0")));
    expect(requirements).to.be.an("array");
  });
});
