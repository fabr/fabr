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

import * as http from "node:http";
import { AddressInfo } from "node:net";
import { expect } from "chai";
import {
  BUILD_OPERATION,
  BuildCache,
  Computable,
  ExecutionContext,
  explainResolutionPath,
  FILES_OPERATION,
  FileSet,
  HttpStatusError,
  IFile,
  IRequirementEdge,
  IResolutionOrigin,
  LogFormatter,
  LogLevel,
  MemoryFile,
  Name,
  PackageFileSet,
  parseVersion,
  RepositoryPublishRef,
  RepositoryContext,
  RepositoryRef,
  resolveAndMaterialize,
  ROOT_REQUIRER,
  Selected,
  SemverVersion,
  TARGET,
  versionToString,
} from "@fabr-build/core";
import { NPMRepository, strictRepairError } from "./NPMRepository";
import {
  matchesTargetPlatform,
  npmPackageOfPath,
  parseMetadataResponse,
  platformGateAdmits,
  splitNpmReference,
  unsupportedPlatformReason,
} from "./NPMProtocol";

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

  it("reads a bare string as a one-entry gate", () => {
    expect(platformGateAdmits("darwin", "darwin")).to.equal(true);
    expect(platformGateAdmits("darwin", "linux")).to.equal(false);
    expect(platformGateAdmits("!win32", "linux")).to.equal(true);
    expect(platformGateAdmits("!win32", "win32")).to.equal(false);
  });

  it("treats a sole \"any\" as no constraint", () => {
    expect(platformGateAdmits(["any"], "win32")).to.equal(true);
    expect(platformGateAdmits("any", "win32")).to.equal(true);
    expect(platformGateAdmits(["any"], undefined)).to.equal(true);
    /* Only as a whole gate: alongside others it is just a platform name. */
    expect(platformGateAdmits(["any", "darwin"], "linux")).to.equal(false);
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

  it("reads string-form gates", () => {
    expect(matchesTargetPlatform({ os: "darwin", cpu: "arm64" }, target)).to.equal(true);
    expect(matchesTargetPlatform({ os: "linux", cpu: "arm64" }, target)).to.equal(false);
    expect(matchesTargetPlatform({ os: "any", cpu: "any" }, target)).to.equal(true);
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
    expect(unsupportedPlatformReason({ os: "darwin" }, target)).to.equal("os 'linux' is not in [darwin]");
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

function metadataFor(pkg: string, version: string, deps: Record<string, string>, extra: Record<string, unknown> = {}): FileSet {
  const meta = {
    name: pkg,
    version,
    dependencies: deps,
    dist: { tarball: `${REG}/tarball/${version}.tgz`, integrity: "", shasum: "", signatures: [] },
    ...extra,
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

/** A real ExecutionContext backing the fake contexts: `getOrCreatePluginContext`
 *  (the js plugin's shared-config machinery) is genuine in-memory logic, and a
 *  `.npmrc` — when a test supplies one — is served through the source FileSource,
 *  exactly as at runtime. The user `~/.npmrc` (absolute source) is always empty. */
function fakeExecution(npmrc?: string): ExecutionContext {
  const source = new FileSet(new Map(npmrc !== undefined ? [[".npmrc", MemoryFile.from(npmrc)]] : []));
  const log = new LogFormatter(LogLevel.Info, () => undefined);
  return new ExecutionContext(new BuildCache(".", log), log, source, new FileSet(new Map()));
}

/**
 * A minimal RepositoryContext that serves a fixed set of URLs and records every
 * fetch, so a test can assert which documents were (and were not) requested.
 * A served Error is delivered as that URL's failure (a registry status), and
 * any unexpected fetch rejects — so a test that expected the dependency closure
 * to be skipped fails loudly if it isn't.
 */
function fakeContext(operation: string, served: Record<string, FileSet | Error>, fetched: string[]): RepositoryContext {
  /* Properties the repository reads: the operation, and a fixed TARGET triple —
   * test packages carry no os/cpu/libc gates, so it never filters anything; it
   * only has to resolve (getJointResolution reads it for the memo key). */
  const globals: Record<string, string> = { [BUILD_OPERATION]: operation, [TARGET]: "arm64-apple-macosx15.0" };
  return {
    getGlobalString: (name: string) =>
      name in globals ? Computable.resolve(globals[name]) : Computable.reject(new Error(`unexpected property: ${name}`)),
    fetch: (url: string) => {
      fetched.push(url);
      if (!(url in served)) {
        return Computable.reject(new Error(`unexpected fetch: ${url}`));
      }
      const response = served[url];
      return response instanceof Error ? Computable.reject(response) : Computable.resolve(response);
    },
    execution: fakeExecution(),
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
      [`${REG}/@parcel%2fwatcher/2.4.1`]: metadataFor("@parcel/watcher", "2.4.1", { "node-addon-api": "^7.0.0" }),
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
    expect(fetched).to.deep.equal([`${REG}/@parcel%2fwatcher/2.4.1`, `${REG}/tarball/2.4.1.tgz`]);
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
     * simply not installable. All unusable, each attributed to the document it
     * came from; the standard JSON reader additionally names the parse problem
     * for a body that isn't JSON at all (a truncated or HTML page). */
    const unusable = [
      Buffer.from(JSON.stringify({ error: "Not Found" })), // error body
      Buffer.from(JSON.stringify({ code: "E500", message: "boom" })), // error body
      Buffer.from("<html><body>502 Bad Gateway</body></html>"), // non-JSON (HTML)
      Buffer.from(""), // empty
      Buffer.from('"just a string"'), // valid JSON, not an object
      Buffer.from("null"), // valid JSON, not an object
    ];
    for (const body of unusable) {
      expect(() => parseMetadataResponse(body, "pkg/1")).to.throw(/Invalid (JSON in )?response from NPM repository/i);
    }
  });
});

describe("NPMRepository lowestAvailable", () => {
  /** The packument as the repository caches it (the extracted version list). */
  function packument(versions: string[]): FileSet {
    return new FileSet(new Map([["versions.json", MemoryFile.from(JSON.stringify(versions))]]));
  }

  it("raises to the lowest published version satisfying the constraint", async () => {
    const fetched: string[] = [];
    const served = { [`${REG}/left-pad`]: packument(["1.0.0", "1.6.0", "2.0.0"]) };
    const repo = new NPMRepository(REG, fakeContext("build", served, fetched));

    const raised = await toPromise(repo.lowestAvailable("left-pad", "^1.2.0"));

    expect(raised && versionToString(raised)).to.equal("1.6.0");
  });

  it("reports no raise for a package the registry has never heard of", async () => {
    /* A typo'd name: the packument 404s. That is the package-level counterpart
     * of an unpublished version — no raise exists — and must not escape as a
     * raw transport error (which would report unattributed, against whatever
     * target was being built, instead of the written requirement). */
    const fetched: string[] = [];
    const url = `${REG}/no-such-package-xyzzy`;
    const repo = new NPMRepository(REG, fakeContext("build", { [url]: new HttpStatusError(404, url) }, fetched));

    const raised = await toPromise(repo.lowestAvailable("no-such-package-xyzzy", "^1.0.0"));

    expect(raised).to.equal(undefined);
    /* A definite answer, so the stale-list revalidation doesn't re-ask. */
    expect(fetched).to.deep.equal([url]);
  });

  it("revalidates once when a published list satisfies nothing", async () => {
    /* Distinct from the 404: the package exists, so the list may merely be a
     * stale copy of a registry that has since appended the version. */
    const fetched: string[] = [];
    const served = { [`${REG}/left-pad`]: packument(["1.0.0"]) };
    const repo = new NPMRepository(REG, fakeContext("build", served, fetched));

    expect(await toPromise(repo.lowestAvailable("left-pad", "^2.0.0"))).to.equal(undefined);
    expect(fetched).to.deep.equal([`${REG}/left-pad`, `${REG}/left-pad`]);
  });

  it("propagates a transport failure of the packument", async () => {
    /* "I could not find out" is not "there is nothing" — a 5xx must fail the
     * repair rather than silently report no raise. */
    const fetched: string[] = [];
    const url = `${REG}/left-pad`;
    const repo = new NPMRepository(REG, fakeContext("build", { [url]: new HttpStatusError(503, url) }, fetched));

    const err = await rejection(() => toPromise(repo.lowestAvailable("left-pad", "^1.0.0")));
    expect(err.message).to.equal(`503 Service Unavailable: ${url}`);
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
      execution: fakeExecution(),
    } as unknown as RepositoryContext;
    const repo = new NPMRepository(REG, context);

    /* The first resolve hits the transient failure. */
    await rejection(() => toPromise(repo.getRequirements("pkg", parseVersion("1.0.0"))));
    /* A retry must re-fetch and succeed — the rejection was not cached. */
    const requirements = await toPromise(repo.getRequirements("pkg", parseVersion("1.0.0")));
    expect(requirements).to.be.an("array");
  });

  it("treats non-optional peerDependencies as ordinary requirements", async () => {
    /* The plugin pattern: the peer joins the joint pin like any requirement
       ("present at a compatible version"); sharing holds by construction in a
       strict closure. An optional-flagged peer ("if present, must match") is
       never auto-installed — npm parity. */
    const url = `${REG}/plugin/1.0.0`;
    const meta = metadataFor("plugin", "1.0.0", { lodash: "^4.0.0" }, {
      peerDependencies: { eslint: "^9.0.0", typescript: ">=5" },
      peerDependenciesMeta: { typescript: { optional: true } },
    });
    const globals: Record<string, string> = { [BUILD_OPERATION]: "build", [TARGET]: "arm64-apple-macosx15.0" };
    const context = {
      getGlobalString: (name: string) =>
        name in globals ? Computable.resolve(globals[name]) : Computable.reject(new Error(`unexpected property: ${name}`)),
      fetch: (u: string) => (u === url ? Computable.resolve(meta) : Computable.reject(new Error(`unexpected fetch: ${u}`))),
      execution: fakeExecution(),
    } as unknown as RepositoryContext;
    const repo = new NPMRepository(REG, context);

    const requirements = await toPromise(repo.getRequirements("plugin", parseVersion("1.0.0")));
    expect(requirements).to.deep.equal([
      { pkg: "lodash", constraint: "^4.0.0" },
      { pkg: "eslint", constraint: "^9.0.0", soft: true },
    ]);
  });

  it("reads legal-but-odd dependency blocks the way npm does", async () => {
    /* A published manifest satisfies the registry, not us: `"dependencies": []`
       means none (reading it positionally would demand a package named `0`),
       and a malformed peer-meta block flags nothing optional. */
    const url = `${REG}/odd/1.0.0`;
    const meta = new FileSet(
      new Map([
        [
          METADATA_FILE,
          MemoryFile.from(
            JSON.stringify({
              name: "odd",
              version: "1.0.0",
              dependencies: [],
              peerDependencies: { eslint: "^9.0.0" },
              peerDependenciesMeta: "nonsense",
              dist: { tarball: `${REG}/tarball/1.0.0.tgz` },
            })
          ),
        ],
      ])
    );
    const globals: Record<string, string> = { [BUILD_OPERATION]: "build", [TARGET]: "arm64-apple-macosx15.0" };
    const context = {
      getGlobalString: (name: string) =>
        name in globals ? Computable.resolve(globals[name]) : Computable.reject(new Error(`unexpected property: ${name}`)),
      fetch: (u: string) => (u === url ? Computable.resolve(meta) : Computable.reject(new Error(`unexpected fetch: ${u}`))),
      execution: fakeExecution(),
    } as unknown as RepositoryContext;
    const repo = new NPMRepository(REG, context);

    const requirements = await toPromise(repo.getRequirements("odd", parseVersion("1.0.0")));
    expect(requirements).to.deep.equal([{ pkg: "eslint", constraint: "^9.0.0", soft: true }]);
  });
});

/** A stub RepositoryContext serving a project `.npmrc` (the credential source)
 *  through the execution's source FileSource; package()/publish() otherwise don't touch it. */
function npmrcContext(npmrc?: string): RepositoryContext {
  return {
    execution: fakeExecution(npmrc),
  } as unknown as RepositoryContext;
}

/** A publish coordinate: an address (`name:version`) vended by its npm destination. */
function coord(destination: NPMRepository, literal: string): RepositoryPublishRef {
  return destination.getRepositoryPublishRef(Name.fromLiteral(literal));
}

function publishFileSet(entries: Record<string, string>): FileSet {
  const map = new Map<string, IFile>();
  for (const [name, content] of Object.entries(entries)) {
    map.set(name, MemoryFile.from(content));
  }
  return new FileSet(map);
}

interface CapturedPut {
  method?: string;
  url?: string;
  auth?: string | string[];
  body: string;
}

function captureServer(status: number, response: string): Promise<{ port: number; captured: () => CapturedPut | undefined; close: () => void }> {
  return new Promise(resolve => {
    let captured: CapturedPut | undefined;
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", c => chunks.push(c));
      req.on("end", () => {
        captured = { method: req.method, url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString() };
        res.writeHead(status, { "content-type": "application/json" });
        res.end(response);
      });
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({ port: (server.address() as AddressInfo).port, captured: () => captured, close: () => server.close() })
    );
  });
}

describe("NPMRepository getRepositoryPublishRef", () => {
  const repo = new NPMRepository(REG, npmrcContext());

  it("vends a publish ref for a scoped name:version with an exact version", () => {
    const ref = repo.getRepositoryPublishRef(Name.fromLiteral("@fabr/core:1.2.3"));
    expect(ref.source).to.equal(repo);
    expect(ref.toString()).to.equal("@fabr/core:1.2.3");
  });

  it("rejects a coordinate that names no version", () => {
    expect(() => repo.getRepositoryPublishRef(Name.fromLiteral("@fabr/core"))).to.throw(/must name a version/);
  });

  it("rejects a range where a coordinate must pin an exact version", () => {
    expect(() => repo.getRepositoryPublishRef(Name.fromLiteral("@fabr/core:^1.0.0"))).to.throw(/exact version/);
  });
});

describe("NPMRepository publish", () => {
  it("packages with version+dep rewrite and PUTs the libnpmpublish envelope", async () => {
    const server = await captureServer(201, "{}");
    try {
      /* The credential comes from a project `.npmrc` keyed by the registry
       * (env substitution + per-registry keys are covered in NPMConfig.test). */
      const repo = new NPMRepository(
        `http://127.0.0.1:${server.port}`,
        npmrcContext(`//127.0.0.1:${server.port}/:_authToken=tok123`)
      );
      const src = publishFileSet({
        "package.json": JSON.stringify({ name: "demo", version: "0.0.0-dev", dependencies: { "@scope/dep": "*", left: "^1" } }),
        "index.js": "module.exports = 1;\n",
      });

      /* The release spans destinations: `@scope/dep` is a member of the sync but
       * not of this batch (published to another npm registry) — its dep is still
       * rewritten. */
      const other = new NPMRepository(REG, npmrcContext());
      const demo = coord(repo, "demo:1.2.3");
      const release = [demo, coord(other, "@scope/dep:2.0.0")];
      const [carrier] = await repo.package([{ destination: demo, content: src }], release);

      /* The carrier IS the wire artifact, with the manifest rewritten (versionless
       * content → coordinate version; a release member dep → its assigned version;
       * a non-member dep left alone), providing its name and recording the member
       * dep for upload ordering. */
      expect(await carrier.get("demo-1.2.3.tgz")).to.not.equal(undefined);
      const manifest = JSON.parse(await (await carrier.get("package.json"))!.readString());
      expect(manifest.version).to.equal("1.2.3");
      expect(manifest.dependencies["@scope/dep"]).to.equal("^2.0.0");
      expect(manifest.dependencies.left).to.equal("^1");
      expect(carrier.destination).to.equal(demo);
      expect(carrier.provides).to.equal("demo");
      expect([...carrier.dependsOn]).to.deep.equal(["@scope/dep"]);

      expect(await repo.publish(carrier)).to.equal("published");

      const put = server.captured()!;
      expect(put.method).to.equal("PUT");
      expect(put.url).to.equal("/demo");
      expect(put.auth).to.equal("Bearer tok123");
      const envelope = JSON.parse(put.body);
      expect(envelope._id).to.equal("demo");
      expect(envelope["dist-tags"]).to.deep.equal({ latest: "1.2.3" });
      const version = envelope.versions["1.2.3"];
      expect(version.dist.integrity).to.match(/^sha512-/);
      expect(version.dist.shasum).to.match(/^[0-9a-f]{40}$/);
      expect(version.dist.tarball).to.equal(`http://127.0.0.1:${server.port}/demo/-/demo-1.2.3.tgz`);
      expect(envelope._attachments["demo-1.2.3.tgz"].content_type).to.equal("application/octet-stream");
    } finally {
      server.close();
    }
  });

  it("PUTs a scoped name percent-encoded, attachment keyed by the scoped basename", async () => {
    const server = await captureServer(201, "{}");
    try {
      const repo = new NPMRepository(`http://127.0.0.1:${server.port}`, npmrcContext());
      const src = publishFileSet({ "package.json": JSON.stringify({ name: "@fabr/core", version: "0" }) });
      const destination = coord(repo, "@fabr/core:0.1.0");
      const [carrier] = await repo.package([{ destination, content: src }], [destination]);
      await repo.publish(carrier);
      const put = server.captured()!;
      expect(put.url).to.equal("/@fabr%2fcore");
      expect(JSON.parse(put.body)._attachments["@fabr/core-0.1.0.tgz"]).to.not.equal(undefined);
    } finally {
      server.close();
    }
  });

  it("treats a 409 (version already present) as the already-synced outcome, not an error", async () => {
    const server = await captureServer(409, '{"error":"cannot modify pre-existing version"}');
    try {
      const repo = new NPMRepository(`http://127.0.0.1:${server.port}`, npmrcContext());
      const src = publishFileSet({ "package.json": JSON.stringify({ name: "demo", version: "0" }) });
      const destination = coord(repo, "demo:1.0.0");
      const [carrier] = await repo.package([{ destination, content: src }], [destination]);
      expect(await repo.publish(carrier)).to.equal("already-synced");
    } finally {
      server.close();
    }
  });

  it("rejects a member whose dependency has no version — built here but not in the sync", async () => {
    const repo = new NPMRepository(REG, npmrcContext());
    const src = publishFileSet({
      "package.json": JSON.stringify({ name: "demo", version: "0", dependencies: { orphan: "*" } }),
    });
    const destination = coord(repo, "demo:1.0.0");
    /* `orphan` is a versionless built dep and the release doesn't publish it:
     * the published manifest would carry an unconstrained requirement. */
    const err = await rejection(() => toPromise(repo.package([{ destination, content: src }], [destination])));
    expect(err.message).to.match(/no version to record for 'orphan'/);
  });

  it("prefers this destination's own assignment when the release assigns a dep two versions", async () => {
    const repo = new NPMRepository(REG, npmrcContext());
    const other = new NPMRepository(REG, npmrcContext());
    const app = coord(repo, "app:1.0.0");
    const base1 = coord(repo, "base:1.0.0");
    const base2 = coord(other, "base:2.0.0"); /* the other registry's line */
    const [carrier] = await repo.package(
      [
        {
          destination: app,
          content: publishFileSet({ "package.json": JSON.stringify({ name: "app", dependencies: { base: "*" } }) }),
        },
        { destination: base1, content: publishFileSet({ "package.json": JSON.stringify({ name: "base" }) }) },
      ],
      [app, base1, base2]
    );
    /* app publishes alongside base@1.0.0 here — its consumers resolve THIS
     * registry's line, so that is the version its manifest declares. */
    const manifest = JSON.parse(await (await carrier.get("package.json"))!.readString());
    expect(manifest.dependencies.base).to.equal("^1.0.0");
  });

  it("rejects a dep the release assigns two versions when neither is at this destination", async () => {
    const repo = new NPMRepository(REG, npmrcContext());
    const other = new NPMRepository(REG, npmrcContext());
    const app = coord(repo, "app:1.0.0");
    const content = publishFileSet({ "package.json": JSON.stringify({ name: "app", dependencies: { base: "*" } }) });
    /* base goes to two OTHER registries at different versions: this destination
     * has no line of its own to prefer, and there is no single release-wide
     * version — which one app's consumers would resolve is unknowable. */
    const err = await rejection(() =>
      toPromise(
        repo.package([{ destination: app, content }], [app, coord(other, "base:1.0.0"), coord(other, "base:2.0.0")])
      )
    );
    expect(err.message).to.match(/no version to record for 'base'/);
  });

  it("rewrites by the release-wide assignment when twins share one version", async () => {
    const repo = new NPMRepository(REG, npmrcContext());
    const other = new NPMRepository(REG, npmrcContext());
    const app = coord(repo, "app:1.0.0");
    const content = publishFileSet({ "package.json": JSON.stringify({ name: "app", dependencies: { base: "*" } }) });
    /* base is published to two registries at the SAME version (maintained in
     * sync): one distinct version, so the rewrite is well-defined. */
    const [carrier] = await repo.package(
      [{ destination: app, content }],
      [app, coord(other, "base:1.5.0"), coord(other, "base:1.5.0")]
    );
    const manifest = JSON.parse(await (await carrier.get("package.json"))!.readString());
    expect(manifest.dependencies.base).to.equal("^1.5.0");
  });

  it("pins a peerDependency to a co-member's exact version, not a caret", async () => {
    const repo = new NPMRepository(REG, npmrcContext());
    const app = coord(repo, "app:1.0.0");
    const base = coord(repo, "base:1.5.0");
    const [carrier] = await repo.package(
      [
        {
          destination: app,
          content: publishFileSet({ "package.json": JSON.stringify({ name: "app", peerDependencies: { base: "*" } }) }),
        },
        { destination: base, content: publishFileSet({ "package.json": JSON.stringify({ name: "base" }) }) },
      ],
      [app, base]
    );
    /* A peer is singleton-by-identity: the consumer must supply THIS exact
     * instance, so it pins exact where a plain dependency takes a caret. */
    const manifest = JSON.parse(await (await carrier.get("package.json"))!.readString());
    expect(manifest.peerDependencies.base).to.equal("1.5.0");
  });
});

/** Like fakeContext, but records the auth headers passed with each fetch and
 *  serves a project `.npmrc` (the credential source), so a test can assert which
 *  requests carried the registry credential. */
function authCapturingContext(
  operation: string,
  served: Record<string, FileSet>,
  captured: Record<string, Record<string, string> | undefined>,
  npmrc?: string
): RepositoryContext {
  const globals: Record<string, string> = { [BUILD_OPERATION]: operation, [TARGET]: "arm64-apple-macosx15.0" };
  return {
    getGlobalString: (name: string) =>
      name in globals ? Computable.resolve(globals[name]) : Computable.reject(new Error(`unexpected property: ${name}`)),
    fetch: (url: string, _tag: string, _process: unknown, _resource: string | undefined, headers?: Record<string, string>) => {
      captured[url] = headers;
      return url in served ? Computable.resolve(served[url]) : Computable.reject(new Error(`unexpected fetch: ${url}`));
    },
    execution: fakeExecution(npmrc),
  } as unknown as RepositoryContext;
}

describe("NPMRepository read authentication", () => {
  it("sends the registry credential on same-host reads, but never to an off-host tarball", async () => {
    const captured: Record<string, Record<string, string> | undefined> = {};
    const metadataUrl = `${REG}/left-pad/1.2.0`;
    const cdnTarball = "https://cdn.example.net/left-pad-1.2.0.tgz";
    const meta = {
      name: "left-pad",
      version: "1.2.0",
      dependencies: {},
      dist: { tarball: cdnTarball, integrity: "", shasum: "", signatures: [] },
    };
    const served = {
      [metadataUrl]: new FileSet(new Map([[METADATA_FILE, MemoryFile.from(JSON.stringify(meta))]])),
      [cdnTarball]: packageTarball(),
    };
    const repo = new NPMRepository(
      REG,
      authCapturingContext(FILES_OPERATION, served, captured, "//registry.example.org/:_authToken=secret-token")
    );
    const ref = new RepositoryRef(repo, Name.fromLiteral("left-pad:1.2.0"));

    await toPromise(resolveAndMaterialize(repo, [ref]));

    /* Metadata is on the registry host → authenticated; the tarball is on a
     * different host (a CDN whose url came from the metadata) → no credential
     * (empty header set, never the registry token). */
    expect(captured[metadataUrl]).to.deep.equal({ Authorization: "Bearer secret-token" });
    expect(captured[cdnTarball]).to.deep.equal({});
  });

  it("sends no auth header when no credential is configured (public access)", async () => {
    const captured: Record<string, Record<string, string> | undefined> = {};
    const metadataUrl = `${REG}/left-pad/1.2.0`;
    const served = {
      [metadataUrl]: metadataFor("left-pad", "1.2.0", {}),
      [`${REG}/tarball/1.2.0.tgz`]: packageTarball(),
    };
    const repo = new NPMRepository(REG, authCapturingContext(FILES_OPERATION, served, captured));
    const ref = new RepositoryRef(repo, Name.fromLiteral("left-pad:1.2.0"));

    await toPromise(resolveAndMaterialize(repo, [ref]));

    expect(captured[metadataUrl]).to.deep.equal({});
  });
});

describe("strictRepairError", () => {
  const raise = {
    pkg: "B",
    constraint: "^1.0.0",
    declared: parseVersion("1.0.0"),
    raised: parseVersion("1.6.0"),
    requiredBy: "A@1.0.0",
  };

  it("offers the complete pin set when raises are the only repairs", () => {
    const err = strictRepairError("A:^1.0.0", [], [raise], []) as Error & { help?: string };
    expect(err.message).to.contain("pin '@npm:B:1.6.0'");
    expect(err.help).to.contain("pinning @npm:B:1.6.0");
    expect(err.help).to.contain("repair-free");
  });

  it("does not claim a complete fix when violations or duplicates remain", () => {
    /* Pins are floors: they cannot bring a selection back under a violated
     * upper bound, so the pin set is only 'the fix' when raises stand alone. */
    const violation = { pkg: "C", constraint: "^2.0.0", requiredBy: "A@1.0.0", selected: parseVersion("3.0.0") };
    const err = strictRepairError("A:^1.0.0", [violation], [raise], []) as Error & { help?: string };
    expect(err.help).to.not.contain("repair-free");
    expect(err.help).to.contain("sealed tool install");
  });
});
