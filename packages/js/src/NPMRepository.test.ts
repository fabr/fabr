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
  ConflictError,
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
  parseName,
  PackageFileSet,
  parseVersion,
  RepositoryPublishRef,
  RepositoryContext,
  RepositoryRef,
  resolveAndMaterialize,
  materializeAll,
  conflictError,
  ROOT_REQUIRER,
  Selected,
  SemverVersion,
  TARGET,
  versionToString,
} from "@fabr-build/core";
import { flatWinners, NPMRepository } from "./NPMRepository";
import { assembleNodeModules, assembleScopedNodeModules, EdgeMap } from "./JSPackage";
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

  it("gives a rename facet to exactly one half — the projection when there is one", () => {
    /* Which half holds the facet is what decides whether `-> ` means a package
     * rename or a file rename, so the split must never hand it to both. */
    const projected = splitNpmReference(parseName("stream-browserify:3.0.0:lib/*.js -> *.mjs"));
    expect(projected.requirement.getRenameTo()).to.equal(undefined);
    expect(projected.projection?.pattern.getRenameTo()?.toString()).to.equal("*.mjs");

    const identity = splitNpmReference(parseName("stream-browserify:3.0.0 -> stream"));
    expect(identity.projection).to.equal(undefined);
    expect(identity.requirement.getRenameTo()?.toString()).to.equal("stream");
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

/** `marker`, when given, names an extra empty file — a way for a test to tell
 * two otherwise identical tarballs apart by path alone. */
function packageTarball(marker?: string): FileSet {
  const files = new Map<string, IFile>([
    ["package.json", MemoryFile.from("{}")],
    ["index.js", MemoryFile.from("module.exports = {};")],
  ]);
  if (marker !== undefined) {
    files.set(marker, MemoryFile.from(""));
  }
  return new FileSet(files);
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
    /* In-memory passthrough: the full resolve+materialize path exercises the
     * real resolution against the served metadata, uncached. */
    memoize: (_tag: string, _key: string, fn: () => Computable<FileSet>) => fn(),
    notifyProgress: () => undefined,
    execution: fakeExecution(),
  } as unknown as RepositoryContext;
}

function toPromise<T>(computable: Computable<T>): Promise<T> {
  return new Promise((resolve, reject) => computable.then(resolve, reject));
}

/** The error's help lines joined — remedies now ride `help`, not the message. */
function helpText(err: Error): string {
  const help = (err as { help?: string | string[] }).help;
  return Array.isArray(help) ? help.join("\n") : (help ?? "");
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

  it("rejects projecting into a floorless version", async () => {
    const repo = new NPMRepository(REG, fakeContext(FILES_OPERATION, {}, []));
    const ref = new RepositoryRef(repo, Name.fromLiteral("left-pad:*"));

    const err = await rejection(() => resolveAndMaterialize(repo, [ref]));
    expect(err.message).to.match(/without a version lower bound/);
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

  it("reads an npm: alias dependency as a requirement on the aliased package", async () => {
    /* @isaacs/cliui's shape, reached from anything modern via glob@10: the
       constraint is wrap-ansi's, so it joins the joint pin as an ordinary
       requirement on wrap-ansi — the entry name survives as the alias, being
       the name cliui's own code requires. */
    const url = `${REG}/@isaacs%2fcliui/8.0.2`;
    const meta = metadataFor("@isaacs/cliui", "8.0.2", {
      "string-width": "^5.1.2",
      "wrap-ansi-cjs": "npm:wrap-ansi@^7.0.0",
    });
    const repo = new NPMRepository(REG, fakeContext("build", { [url]: meta }, []));

    const requirements = await toPromise(repo.getRequirements("@isaacs/cliui", parseVersion("8.0.2")));

    expect(requirements).to.deep.equal([
      { pkg: "string-width", constraint: "^5.1.2" },
      { pkg: "wrap-ansi", constraint: "^7.0.0", alias: "wrap-ansi-cjs" },
    ]);
  });
});

describe("flatWinners", () => {
  /** A closure member, keyed as the id the edges refer to it by. */
  function members(...ids: string[]): Map<string, Selected<SemverVersion>> {
    return new Map(
      ids.map(id => {
        const at = id.lastIndexOf("@");
        return [id, { pkg: id.substring(0, at), version: parseVersion(id.substring(at + 1)) }];
      })
    );
  }

  function edges(graph: Record<string, Record<string, string>>): EdgeMap {
    return new Map(Object.entries(graph).map(([id, deps]) => [id, new Map(Object.entries(deps))]));
  }

  it("mounts each name the closure's edges ask for", () => {
    const winners = flatWinners({ id: "cli@1.0.0", name: "cli" }, members("cli@1.0.0", "left-pad@1.2.0"),
      edges({ "cli@1.0.0": { "left-pad": "left-pad@1.2.0" } })
    );
    expect([...winners]).to.deep.equal([
      ["cli", "cli@1.0.0"],
      ["left-pad", "left-pad@1.2.0"],
    ]);
  });

  it("mounts an aliased package under the alias only", () => {
    /* Nothing asks for wrap-ansi@7 by its own name — that name belongs to the
       tree's own wrap-ansi@8 — so the aliased copy exists only as the name its
       requirer imports. */
    const winners = flatWinners({ id: "cli@1.0.0", name: "cli" }, members("cli@1.0.0", "@isaacs/cliui@8.0.2", "wrap-ansi@8.1.0", "wrap-ansi@7.0.0"),
      edges({
        "cli@1.0.0": { "@isaacs/cliui": "@isaacs/cliui@8.0.2", "wrap-ansi": "wrap-ansi@8.1.0" },
        "@isaacs/cliui@8.0.2": { "wrap-ansi-cjs": "wrap-ansi@7.0.0" },
      })
    );
    expect([...winners]).to.deep.equal([
      ["cli", "cli@1.0.0"],
      ["@isaacs/cliui", "@isaacs/cliui@8.0.2"],
      ["wrap-ansi", "wrap-ansi@8.1.0"],
      ["wrap-ansi-cjs", "wrap-ansi@7.0.0"],
    ]);
  });

  it("does not mount a member nothing requires under any name", () => {
    const winners = flatWinners({ id: "cli@1.0.0", name: "cli" }, members("cli@1.0.0", "orphan@1.0.0"), edges({ "cli@1.0.0": {} }));
    expect([...winners]).to.deep.equal([["cli", "cli@1.0.0"]]);
  });

  it("keeps the root's own name for the root", () => {
    /* A dependency selecting another version of the root package cannot take
       its name: the delivered package must resolve at its own path. */
    const winners = flatWinners({ id: "cli@1.0.0", name: "cli" }, members("cli@1.0.0", "cli@2.0.0", "dep@1.0.0"),
      edges({ "cli@1.0.0": { dep: "dep@1.0.0" }, "dep@1.0.0": { cli: "cli@2.0.0" } })
    );
    expect(winners.get("cli")).to.equal("cli@1.0.0");
  });

  it("takes the highest version when one name is claimed twice", () => {
    const winners = flatWinners({ id: "cli@1.0.0", name: "cli" }, members("cli@1.0.0", "a@1.0.0", "b@1.0.0", "dep@1.0.0", "dep@2.0.0"),
      edges({
        "cli@1.0.0": { a: "a@1.0.0", b: "b@1.0.0" },
        "a@1.0.0": { dep: "dep@1.0.0" },
        "b@1.0.0": { dep: "dep@2.0.0" },
      })
    );
    expect(winners.get("dep")).to.equal("dep@2.0.0");
  });

  it("rejects two different packages claiming one install name", () => {
    /* Only an alias can reach this — an ordinary edge names its own package —
       and hoisting either would silently break the other's imports. */
    const err = (() => {
      try {
        flatWinners({ id: "cli@1.0.0", name: "cli" }, members("cli@1.0.0", "a@1.0.0", "b@1.0.0", "left-pad@1.0.0", "right-pad@1.0.0"),
          edges({
            "cli@1.0.0": { a: "a@1.0.0", b: "b@1.0.0" },
            "a@1.0.0": { pad: "left-pad@1.0.0" },
            "b@1.0.0": { pad: "right-pad@1.0.0" },
          })
        );
        return undefined;
      } catch (thrown) {
        return thrown as Error & { help?: string };
      }
    })();
    expect(err).to.be.instanceOf(ConflictError);
    expect(err?.message).to.contain("Conflicting packages for pad");
    expect(err?.help).to.contain("alias");
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
       * (env substitution + per-registry keys are covered in NPMAuth.test). */
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

  it("requests the repository's declared access level in the envelope", async () => {
    const server = await captureServer(201, "{}");
    try {
      /* Access is a property of the publish destination (the repository decl),
       * never of the package — the default (no access) leaves it to the registry. */
      const repo = new NPMRepository(`http://127.0.0.1:${server.port}`, npmrcContext(), "public");
      const src = publishFileSet({ "package.json": JSON.stringify({ name: "@fabr/core", version: "0" }) });
      const destination = coord(repo, "@fabr/core:0.1.0");
      const [carrier] = await repo.package([{ destination, content: src }], [destination]);
      await repo.publish(carrier);
      expect(JSON.parse(server.captured()!.body).access).to.equal("public");
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

  it("treats npmjs's 403 over-publish refusal as already-synced too", async () => {
    /* The real npmjs shape for an existing version — a 403, not a 409. Other
     * 403s (permissions, restricted access) stay errors. */
    const server = await captureServer(
      403,
      '{"success":false,"error":"You cannot publish over the previously published versions: 1.0.0."}'
    );
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

describe("override markers", () => {
  /* A conflict fixture: A wants C ~1.5.0 (capped below 2), B wants C ^2.5.0 —
   * jointly unsatisfiable, principal C@2.5.0, repairing fork C@1.5.0. */
  const served: Record<string, FileSet | Error> = {
    [`${REG}/A/1.1.0`]: metadataFor("A", "1.1.0", { C: "~1.5.0" }, { dist: tarballDist("a") }),
    [`${REG}/B/1.2.0`]: metadataFor("B", "1.2.0", { C: "^2.5.0" }, { dist: tarballDist("b") }),
    [`${REG}/C/1.5.0`]: metadataFor("C", "1.5.0", {}, { dist: tarballDist("c1") }),
    [`${REG}/C/2.5.0`]: metadataFor("C", "2.5.0", {}, { dist: tarballDist("c2") }),
    [`${REG}/tarball/a.tgz`]: packageTarball(),
    [`${REG}/tarball/b.tgz`]: packageTarball(),
    [`${REG}/tarball/c1.tgz`]: packageTarball("v1.5.0.marker"),
    [`${REG}/tarball/c2.tgz`]: packageTarball("v2.5.0.marker"),
  };
  function tarballDist(stem: string): Record<string, unknown> {
    return { tarball: `${REG}/tarball/${stem}.tgz`, integrity: "", shasum: "", signatures: [] };
  }
  /* Parsed, not fromLiteral: a written `?` marker arrives as a trailing GLOB
   * part (the lexer's reading), which the version split folds back — the
   * fidelity this harness must exercise. */
  const refsFor = (repo: NPMRepository, names: string[]): RepositoryRef[] =>
    names.map(name => new RepositoryRef(repo, parseName(name)));

  it("a '?' pair — principal and fork — sanctions the coexistence in a strict delivery", async () => {
    const repo = new NPMRepository(REG, fakeContext("build", served, []));
    const delivered = await toPromise(resolveAndMaterialize(repo, refsFor(repo, ["A:1.1.0", "B:1.2.0", "C:2.5.0?", "C:1.5.0?"])));
    expect(delivered).to.have.lengthOf(4);
    /* The alternates themselves deliver nothing — the fork arrives nested
     * inside the canonical closure (under A, whose edge needs it). */
    expect([...delivered[2]].length).to.equal(0);
    expect([...delivered[3]].length).to.equal(0);
    const a = delivered[0] as PackageFileSet;
    const nested = a.dependencies.filter((dep): dep is PackageFileSet => dep instanceof PackageFileSet);
    expect(nested.map(dep => `${dep.packageName}@${dep.version}`)).to.contain("C@1.5.0");
    /* And the linked (scoped) layout can represent it: the winner takes the
     * flat store slot, the sanctioned fork nests under its requirer. */
    const assembled = assembleScopedNodeModules(delivered.filter(set => [...set].length > 0));
    const names = new Set([...assembled].map(([name]) => name));
    expect(names.has(".pkgs/node_modules/C/package.json")).to.equal(true);
    expect(names.has(".pkgs/node_modules/A/node_modules/C/package.json")).to.equal(true);
  });

  it("an exact unmarked pin of the principal completes the sanction too (the catalog form)", async () => {
    const repo = new NPMRepository(REG, fakeContext("build", served, []));
    const delivered = await toPromise(resolveAndMaterialize(repo, refsFor(repo, ["A:1.1.0", "B:1.2.0", "C:2.5.0", "C:1.5.0?"])));
    expect(delivered).to.have.lengthOf(4);
  });

  it("an exact pin OF THE FORK delivers a nested override, so a carried closure still lays out", async () => {
    const repo = new NPMRepository(REG, fakeContext("build", served, []));
    /* The catalog form again, but the unmarked pin names the *fork*: the
     * requirement is answered by C@1.5.0 while the principal stays 2.5.0. */
    const delivered = await toPromise(
      resolveAndMaterialize(repo, refsFor(repo, ["A:1.1.0", "B:1.2.0", "C:1.5.0", "C:2.5.0?"]))
    );
    const packages = delivered.filter(
      (set): set is PackageFileSet => set instanceof PackageFileSet && [...set].length > 0
    );
    const fork = packages.find(pkg => pkg.packageId === "C@1.5.0");
    expect(fork?.isNestedOverride).to.equal(true);
    /* Reached only through a built package's carried deps — nothing here is a
     * root of the assembly, so nothing gets a flat slot by being named. The
     * fork must nest under its carrier and the principal take the flat slot;
     * unflagged, the two read as two deliveries disagreeing and conflict. */
    const carrier = new PackageFileSet(
      new FileSet(new Map([["package.json", MemoryFile.from("{}")]])),
      "P",
      "1.0.0",
      packages
    );
    const names = new Set([...assembleScopedNodeModules([carrier])].map(([name]) => name));
    expect(names.has(".pkgs/node_modules/C/v2.5.0.marker")).to.equal(true);
    expect(names.has(".pkgs/node_modules/P/node_modules/C/v1.5.0.marker")).to.equal(true);
  });

  it("a lone '?' is an incomplete sanction — every shipping version must be written", async () => {
    /* One '?' alone would implicitly bless coexistence with whatever the rest
     * of the tree resolves to; the whole coexisting set must be named, so
     * drift on any side re-errors, phrased as the set mismatch it is. */
    const repo = new NPMRepository(REG, fakeContext("build", served, []));
    const err = await rejection(() => toPromise(resolveAndMaterialize(repo, refsFor(repo, ["A:1.1.0", "B:1.2.0", "C:1.5.0?"]))));
    expect(err.message).to.contain("required C versions: 1.5.0, 2.5.0 — allowed: 1.5.0");
    expect(err.message).to.contain("add @npm:C:2.5.0?");
    /* The suggestion completes the written set — it does not re-suggest the
     * '?' that is already there. */
    expect(helpText(err)).to.contain("@npm:C:2.5.0?");
    expect(helpText(err)).to.not.contain("@npm:C:1.5.0?");
  });

  it("an unsanctioned conflict fails strict with pasteable suggestions", async () => {
    const repo = new NPMRepository(REG, fakeContext("build", served, []));
    const err = await rejection(() => toPromise(resolveAndMaterialize(repo, refsFor(repo, ["A:1.1.0", "B:1.2.0"]))));
    expect(err.message).to.contain("does not satisfy '~1.5.0'");
    /* Resolution-pure, and rendered as the help (the remedy line): the whole
     * coexisting set as '?' sanctions — no unmarked pin, which would be a
     * real direct dependency in a js_package's deps. */
    expect(helpText(err)).to.contain("@npm:C:2.5.0? @npm:C:1.5.0?");
  });

  it("a stale alternate reports the version now required instead", async () => {
    const repo = new NPMRepository(REG, fakeContext("build", served, []));
    const err = await rejection(() => toPromise(resolveAndMaterialize(repo, refsFor(repo, ["A:1.1.0", "B:1.2.0", "C:2.5.0?", "C:1.4.0?"]))));
    expect(err.message).to.contain("required C versions: 1.5.0, 2.5.0 — allowed: 2.5.0, 1.4.0");
    expect(err.message).to.contain("add @npm:C:1.5.0?");
  });

  it("a '!' force substitutes every requirement and coerces the rest", async () => {
    const fetched: string[] = [];
    const repo = new NPMRepository(REG, fakeContext("build", served, fetched));
    const delivered = await toPromise(resolveAndMaterialize(repo, refsFor(repo, ["A:1.1.0", "B:1.2.0", "C:2.5.0!"])));
    expect(delivered).to.have.lengthOf(3);
    /* A's ~1.5.0 was coerced onto 2.5.0: the losing version is neither
     * resolved nor fetched. */
    expect(fetched.some(url => url.includes("/C/1.5.0"))).to.equal(false);
    const a = delivered[0] as PackageFileSet;
    const nested = a.dependencies.filter((dep): dep is PackageFileSet => dep instanceof PackageFileSet);
    expect(nested.map(dep => `${dep.packageName}@${dep.version}`)).to.deep.equal(["C@2.5.0"]);
  });

  it("forcing and permitting the same package is contradictory", async () => {
    const repo = new NPMRepository(REG, fakeContext("build", served, []));
    const err = await rejection(() => toPromise(resolveAndMaterialize(repo, refsFor(repo, ["A:1.1.0", "C:2.5.0!", "C:1.5.0?"]))));
    expect(err.message).to.contain("both forced ('!') and permitted as an alternate ('?')");
  });

  it("two forces at different versions are contradictory too", async () => {
    const repo = new NPMRepository(REG, fakeContext("build", served, []));
    const err = await rejection(() => toPromise(resolveAndMaterialize(repo, refsFor(repo, ["A:1.1.0", "C:2.5.0!", "C:1.5.0!"]))));
    expect(err.message).to.contain("forced ('!') at two different versions");
  });

  it("a marker demands an exact version, not a range", async () => {
    const repo = new NPMRepository(REG, fakeContext("build", served, []));
    const err = await rejection(() => toPromise(resolveAndMaterialize(repo, refsFor(repo, ["C:^1.0.0?"]))));
    expect(err.message).to.contain("needs an exact version");
  });

  const floorlessServed: Record<string, FileSet | Error> = {
    [`${REG}/P/1.0.0`]: metadataFor("P", "1.0.0", { Q: "1.2.0", R: "1.3.0" }, { dist: tarballDist("p") }),
    [`${REG}/Q/1.2.0`]: metadataFor("Q", "1.2.0", { T: "*" }, { dist: tarballDist("q") }),
    [`${REG}/R/1.3.0`]: metadataFor("R", "1.3.0", { T: "*", U: "*" }, { dist: tarballDist("r") }),
    [`${REG}/T`]: new FileSet(new Map([["versions.json", MemoryFile.from(JSON.stringify(["20.0.0", "24.2.0", "25.0.0-rc.1"]))]])),
    [`${REG}/U`]: new FileSet(new Map([["versions.json", MemoryFile.from(JSON.stringify(["3.1.0"]))]])),
    [`${REG}/T/24.2.0`]: metadataFor("T", "24.2.0", {}, { dist: tarballDist("t") }),
    [`${REG}/U/3.1.0`]: metadataFor("U", "3.1.0", {}, { dist: tarballDist("u") }),
    [`${REG}/tarball/p.tgz`]: packageTarball(),
    [`${REG}/tarball/q.tgz`]: packageTarball(),
    [`${REG}/tarball/r.tgz`]: packageTarball(),
    [`${REG}/tarball/t.tgz`]: packageTarball(),
    [`${REG}/tarball/u.tgz`]: packageTarball(),
  };

  it("a repairable resolution failure is ONE error: floorless packages combined, one '?' fix list", async () => {
    /* The jest-30 shape: members require `T: '*'` / `U: '*'`. The whole
     * repairable failure is one fact with one pasteable fix — per-package
     * detail lines inside it, latest-stable `?` suggestions as the help. */
    const repo = new NPMRepository(REG, fakeContext("build", floorlessServed, []));
    const err = await rejection(() => toPromise(resolveAndMaterialize(repo, refsFor(repo, ["P:1.0.0"]))));
    expect(err.message.match(/required only without a version lower bound/g)).to.have.lengthOf(1);
    expect(err.message).to.contain("'T' — required by Q@1.2.0, R@1.3.0");
    expect(err.message).to.contain("'U' — required by R@1.3.0");
    /* The '?' suggestions: latest STABLE (T's rc is skipped), resolution-pure */
    expect(helpText(err)).to.contain("@npm:T:24.2.0?");
    expect(helpText(err)).to.contain("@npm:U:3.1.0?");
    expect(helpText(err)).to.contain("none is a direct dependency");
  });

  it("the one-pass repair set folds in the divergences the completed resolution hits", async () => {
    /* Supplying W's floorless version transitively conflicts on V (P wants
     * ^2, W wants ~1.5): the FIRST error's list must already sanction it —
     * no second round of errors after pasting. */
    const cascade: Record<string, FileSet | Error> = {
      [`${REG}/P/1.0.0`]: metadataFor("P", "1.0.0", { W: "*", V: "^2.5.0" }, { dist: tarballDist("p") }),
      [`${REG}/W`]: new FileSet(new Map([["versions.json", MemoryFile.from(JSON.stringify(["2.0.0"]))]])),
      [`${REG}/W/2.0.0`]: metadataFor("W", "2.0.0", { V: "~1.5.0" }, { dist: tarballDist("w") }),
      [`${REG}/V/1.5.0`]: metadataFor("V", "1.5.0", {}, { dist: tarballDist("v1") }),
      [`${REG}/V/2.5.0`]: metadataFor("V", "2.5.0", {}, { dist: tarballDist("v2") }),
    };
    const repo = new NPMRepository(REG, fakeContext("build", cascade, []));
    const err = await rejection(() => toPromise(resolveAndMaterialize(repo, refsFor(repo, ["P:1.0.0"]))));
    expect(err.message).to.contain("'W' — required by P@1.0.0");
    expect(err.message).to.contain("1 version conflict(s)");
    expect(helpText(err)).to.contain("@npm:W:2.0.0?");
    expect(helpText(err)).to.contain("@npm:V:1.5.0? @npm:V:2.5.0?");
  });

  it("the suggested '?' alternates supply the floorless-only versions (attach-last)", async () => {
    const repo = new NPMRepository(REG, fakeContext("build", floorlessServed, []));
    const delivered = await toPromise(resolveAndMaterialize(repo, refsFor(repo, ["P:1.0.0", "T:24.2.0?", "U:3.1.0?"])));
    expect(delivered).to.have.lengthOf(3);
    /* The alternates deliver nothing of their own; T and U ride inside P's
     * closure as ordinary members — transitive, not direct deps. */
    expect([...delivered[1]].length).to.equal(0);
    expect([...delivered[2]].length).to.equal(0);
    const assembled = assembleScopedNodeModules(delivered.filter(set => [...set].length > 0));
    const names = new Set([...assembled].map(([name]) => name));
    expect(names.has(".pkgs/node_modules/T/package.json")).to.equal(true);
    /* Not linked at the top level — it is not a direct dependency */
    expect(names.has("T")).to.equal(false);
  });

  it("suggests a verified single-version pin where a disjunctive range admits one", async () => {
    /* D requires C '1.x || 3.x'; the root floor >=2.0.0 selects C@2.0.0, which
     * sits in the union's gap — but C@3.0.0 satisfies every requirement, so the
     * suggester verifies and offers the pin rather than a divergence sanction. */
    const disjoint: Record<string, FileSet | Error> = {
      [`${REG}/D/1.0.0`]: metadataFor("D", "1.0.0", { C: "1.x || 3.x" }, { dist: tarballDist("d") }),
      /* The union's literal floor 1.0.0 was never published (whole-closure
       * expansion demands it) — the fork raises to 1.5.0 */
      [`${REG}/C/1.0.0`]: new HttpStatusError(404, `${REG}/C/1.0.0`),
      [`${REG}/C/1.5.0`]: metadataFor("C", "1.5.0", {}, { dist: tarballDist("c1") }),
      [`${REG}/C/2.0.0`]: metadataFor("C", "2.0.0", {}, { dist: tarballDist("c2") }),
      [`${REG}/C/3.0.0`]: metadataFor("C", "3.0.0", {}, { dist: tarballDist("c3") }),
      [`${REG}/C`]: new FileSet(new Map([["versions.json", MemoryFile.from(JSON.stringify(["1.5.0", "2.0.0", "3.0.0"]))]])),
    };
    const repo = new NPMRepository(REG, fakeContext("build", disjoint, []));
    const err = await rejection(() => toPromise(resolveAndMaterialize(repo, refsFor(repo, ["D:1.0.0", 'C:">=2.0.0"']))));
    expect(helpText(err)).to.contain("@npm:C:3.0.0 (satisfies every requirement on C)");
  });
});

describe("merged layout across a batch", () => {
  /* Two roots resolved and delivered together. Only `md` reaches entities@6.0.0,
   * so inside jsdom's delivery entities@4.0.0 is unopposed — the shape that used
   * to lose parse5's requirement (dylan's app_bundle). */
  const dist = (stem: string): Record<string, unknown> => ({
    dist: { tarball: `${REG}/tarball/${stem}.tgz`, integrity: "", shasum: "", signatures: [] },
  });
  const served: Record<string, FileSet | Error> = {
    [`${REG}/jsdom/1.0.0`]: metadataFor("jsdom", "1.0.0", { parse5: "^1.0.0" }, dist("jsdom")),
    [`${REG}/parse5/1.0.0`]: metadataFor("parse5", "1.0.0", { entities: "^4.0.0" }, dist("parse5")),
    [`${REG}/md/1.0.0`]: metadataFor("md", "1.0.0", { entities: "^6.0.0" }, dist("md")),
    [`${REG}/entities/4.0.0`]: metadataFor("entities", "4.0.0", {}, dist("entities4")),
    [`${REG}/entities/6.0.0`]: metadataFor("entities", "6.0.0", {}, dist("entities6")),
    [`${REG}/tarball/jsdom.tgz`]: packageTarball(),
    [`${REG}/tarball/parse5.tgz`]: packageTarball(),
    [`${REG}/tarball/md.tgz`]: packageTarball(),
    [`${REG}/tarball/entities4.tgz`]: packageTarball("v4.marker"),
    [`${REG}/tarball/entities6.tgz`]: packageTarball("v6.marker"),
  };
  const refsFor = (repo: NPMRepository, names: string[]): RepositoryRef[] =>
    names.map(name => new RepositoryRef(repo, parseName(name)));

  it("nests a member's private copy the merged layout needs, not only its own delivery's", async () => {
    const repo = new NPMRepository(REG, fakeContext("build", served, []));
    const delivered = await toPromise(
      resolveAndMaterialize(repo, refsFor(repo, ["jsdom:1.0.0", "md:1.0.0", "entities:4.0.0?", "entities:6.0.0?"]))
    );
    const packages = delivered.filter(set => [...set].length > 0);
    /* parse5 carries the copy its edge binds, even though its own delivery
     * hoisted that very version — the batch is what it must survive. */
    const jsdom = packages[0] as PackageFileSet;
    const parse5 = jsdom.dependencies.find(
      (dep): dep is PackageFileSet => dep instanceof PackageFileSet && dep.packageName === "parse5"
    );
    expect(parse5?.dependencies.map(dep => (dep as PackageFileSet).packageId)).to.deep.equal(["entities@4.0.0"]);
    /* And the consumer's one node_modules puts each requirer on the version it
     * asked for: the batch winner flat, the other nested under parse5. */
    const names = new Set([...assembleNodeModules(packages)].map(([name]) => name));
    expect(names.has("entities/v6.marker")).to.equal(true);
    expect(names.has("parse5/node_modules/entities/v4.marker")).to.equal(true);
  });
});

describe("package rename", () => {
  /* A polyfill shim mounted under the node builtin name it stands in for —
   * the case the rename exists for. */
  const served: Record<string, FileSet | Error> = {
    [`${REG}/stream-browserify/3.0.0`]: metadataFor("stream-browserify", "3.0.0", { "readable-stream": "^2.0.0" }),
    [`${REG}/readable-stream/2.0.0`]: metadataFor("readable-stream", "2.0.0", {}),
    [`${REG}/tarball/3.0.0.tgz`]: packageTarball(),
    [`${REG}/tarball/2.0.0.tgz`]: packageTarball(),
  };
  const refsFor = (repo: NPMRepository, names: string[]): RepositoryRef[] =>
    names.map(name => repo.getRepositoryRef(parseName(name)));

  it("delivers the package under the written name, and mounts it there", async () => {
    const repo = new NPMRepository(REG, fakeContext("build", served, []));
    /* materializeAll, not resolveAndMaterialize: the rename is applied where
     * every delivery is finished (RepositoryRef.deliveredAs), which is the
     * collection point's job, not the repository's. */
    const [delivered] = await toPromise(materializeAll(refsFor(repo, ["stream-browserify:3.0.0 -> stream"])));
    expect((delivered as PackageFileSet).packageName).to.equal("stream");
    /* The mount follows the delivered identity, so a source importing 'stream'
     * resolves the shim — while its own closure keeps its real names. */
    const names = new Set([...assembleScopedNodeModules([delivered as FileSet])].map(([name]) => name));
    expect(names.has(".pkgs/node_modules/stream/package.json")).to.equal(true);
    expect(names.has(".pkgs/node_modules/readable-stream/package.json")).to.equal(true);
    expect(names.has(".pkgs/node_modules/stream-browserify/package.json")).to.equal(false);
  });

  it("is a stamp, not a second requirement: one resolution, one fetch", async () => {
    /* Resolution is by package, so naming the same package twice — once renamed
     * — pins and fetches it once and differs only in what the two deliveries are
     * called. */
    const fetched: string[] = [];
    const repo = new NPMRepository(REG, fakeContext("build", served, fetched));
    const delivered = await toPromise(
      materializeAll(refsFor(repo, ["stream-browserify:3.0.0", "stream-browserify:3.0.0 -> stream"]))
    );
    expect(delivered.map(set => (set as PackageFileSet).packageName)).to.deep.equal(["stream-browserify", "stream"]);
    expect(fetched.filter(url => url.endsWith("/tarball/3.0.0.tgz"))).to.have.lengthOf(1);
  });
});

const npmRefText = (pkg: string, version: string, marker?: "?" | "!"): string => `@npm:${pkg}:${version}${marker ?? ""}`;

describe("conflictError (the strict repair report)", () => {
  /* Floor raises are deliberately absent here: a raised floor is the
   * constraint's plain meaning when its literal minimum was never published,
   * accepted in every delivery mode rather than judged by the strict gate. */
  const violation = { pkg: "C", constraint: "^2.0.0", requiredBy: "A@1.0.0", selected: parseVersion("3.0.0") };
  const duplicates: Array<[string, SemverVersion[]]> = [["D", [parseVersion("1.0.0"), parseVersion("2.0.0")]]];
  const rootEdge = (constraint: string): IRequirementEdge => ({ requiredBy: ROOT_REQUIRER, constraint });
  const selection = (
    pkg: string,
    version: string,
    reachedVia: IRequirementEdge,
    selectedBy?: IRequirementEdge
  ): Selected<SemverVersion> => ({ pkg, version: parseVersion(version), reachedVia, selectedBy: selectedBy ?? reachedVia });
  /* A@1.0.0 and B@1.0.0 both require C; B's floor won, so A's upper bound is
   * the one violated. D coexists: required by A at 1.0.0 and directly at 2. */
  const selections = [
    selection("A", "1.0.0", rootEdge("^1.0.0")),
    selection("B", "1.0.0", rootEdge("^1.0.0")),
    selection("C", "3.0.0", { requiredBy: "A@1.0.0", constraint: "^2.0.0" }, { requiredBy: "B@1.0.0", constraint: "^3.0.0" }),
    selection("D", "1.0.0", { requiredBy: "A@1.0.0", constraint: "^1.0.0" }),
    selection("D", "2.0.0", rootEdge("^2.0.0")),
  ];

  it("reports violations and coexisting versions as structural facts", () => {
    const err = conflictError("A:^1.0.0", [violation], duplicates, selections, versionToString, npmRefText) as Error & {
      help?: string;
    };
    expect(err.message).to.contain("C@3.0.0 does not satisfy '^2.0.0'");
    expect(err.message).to.contain("multiple versions of D (1.0.0, 2.0.0)");
    expect(helpText(err)).to.contain("pin a single version satisfying every requirement");
  });

  it("collapses same-conflict violations to one entry naming the other requirers", () => {
    /* The aws-sdk shape: one widely-declared requirement ('^2.0.0' on C from
     * many siblings) violates once per requirer, but the conflict and its
     * remedy are the same — one full stanza, the rest summarised by name. */
    const requirers = ["A@1.0.0", "B@1.0.0", "E@1.0.0", "F@1.0.0", "G@1.0.0", "H@1.0.0", "I@1.0.0"];
    const violationsFrom = requirers.map(requiredBy => ({ ...violation, requiredBy }));
    const err = conflictError("A:^1.0.0", violationsFrom, [], selections, versionToString, npmRefText);
    expect(err.message).to.contain("C@3.0.0 does not satisfy '^2.0.0' required by A@1.0.0 (and 6 more)");
    expect(err.message).to.contain("'^2.0.0' also required by: B@1.0.0, E@1.0.0, F@1.0.0, G@1.0.0 (+2 more)");
    /* One stanza, not seven: the violation line appears exactly once */
    expect(err.message.match(/does not satisfy/g)).to.have.lengthOf(1);
    /* A distinct conflict (different selected version) keeps its own entry */
    const other = { pkg: "C", constraint: "^2.0.0", requiredBy: "B@1.0.0", selected: parseVersion("3.5.0") };
    const two = conflictError("A:^1.0.0", [violation, other], [], selections, versionToString, npmRefText);
    expect(two.message.match(/does not satisfy/g)).to.have.lengthOf(2);
  });

  it("attributes both sides of a violation to their requirement paths", () => {
    const err = conflictError("A:^1.0.0", [violation], [], selections, versionToString, npmRefText);
    expect(err.message).to.contain("3.0.0 selected by: B@1.0.0 -> C@3.0.0 (^3.0.0)");
    expect(err.message).to.contain("'^2.0.0' required via: A@1.0.0");
  });

  it("attributes each coexisting version to its requirement path", () => {
    const err = conflictError("A:^1.0.0", [], duplicates, selections, versionToString, npmRefText);
    expect(err.message).to.contain("1.0.0 required via: A@1.0.0 -> D@1.0.0 (^1.0.0)");
    expect(err.message).to.contain("2.0.0 required directly ('^2.0.0')");
  });

  it("suppresses a coexisting-versions entry already explained by a violation", () => {
    /* A fork exists exactly because an edge violated, so the multiplicity is
     * the violation restated — one stanza, not two. */
    const cDuplicates: Array<[string, SemverVersion[]]> = [["C", [parseVersion("2.5.0"), parseVersion("3.0.0")]]];
    const err = conflictError("A:^1.0.0", [violation], cDuplicates, selections, versionToString, npmRefText);
    expect(err.message).to.contain("C@3.0.0 does not satisfy '^2.0.0'");
    expect(err.message).to.not.contain("requires multiple versions of C");
  });

  /* Provenance edges are optional (resolutions persisted before they existed),
   * so the bare statement of each repair has to stand on its own. */
  it("states the repairs alone when the resolution carries no provenance", () => {
    const err = conflictError("A:^1.0.0", [violation], duplicates, [{ pkg: "C", version: parseVersion("3.0.0") }], versionToString, npmRefText);
    expect(err.message).to.contain("C@3.0.0 does not satisfy '^2.0.0' required by A@1.0.0");
    expect(err.message).to.not.contain("selected by:");
    expect(err.message).to.not.contain("required via:");
  });
});
