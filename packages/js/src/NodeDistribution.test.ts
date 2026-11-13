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

import { Readable } from "node:stream";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { expect } from "chai";
import {
  BuildCache,
  Computable,
  FileSet,
  HttpStatusError,
  IFetchRequest,
  IFile,
  IntegrityError,
  LogFormatter,
  LogLevel,
  MemoryFile,
  Name,
  PackageFileSet,
  packToTarball,
  packToZip,
  parseName,
  PartialRepositoryRef,
  RepositoryRef,
  ResolvedNode,
  RunnableFileSet,
  SymlinkFile,
  TARGET,
  TargetContext,
  VersionNotFoundError,
  toArgv,
} from "@fabr-build/core";
import { NodeDistribution } from "./NodeDistribution";

const DIST = "https://dist.test";
const UNOFFICIAL = "https://unofficial.test";

function toPromise<T>(computable: Computable<T>): Promise<T> {
  return new Promise((resolve, reject) => computable.then(resolve, reject));
}

function rejection(computable: Computable<unknown>): Promise<Error> {
  return toPromise(computable).then(
    () => {
      throw new Error("expected a rejection");
    },
    (err: Error) => err
  );
}

/** A release archive as nodejs.org lays one out: everything under one top directory. */
function archive(version: string, platform: string): Promise<Buffer> {
  const top = `node-v${version}-${platform}`;
  const files = new FileSet(
    new Map<string, IFile>([
      [`${top}/bin/node`, new MemoryFile(Buffer.from(`node ${version} ${platform}`), 0o755)],
      [`${top}/bin/npm`, new SymlinkFile("../lib/node_modules/npm/bin/npm-cli.js")],
      [`${top}/lib/node_modules/npm/bin/npm-cli.js`, MemoryFile.from("// npm")],
    ])
  );
  return toPromise(packToTarball(files)).then(tar => zlib.gzipSync(tar));
}

/** A Windows release as nodejs.org lays one out: a zip whose top directory holds `node.exe`, with no modes recorded. */
function windowsArchive(version: string, platform: string): Promise<Buffer> {
  const top = `node-v${version}-${platform}`;
  const files = new FileSet(
    new Map<string, IFile>([
      [`${top}/node.exe`, MemoryFile.from(`node ${version} ${platform}`)],
      [`${top}/npm.cmd`, MemoryFile.from("@echo npm")],
      [`${top}/README.md`, MemoryFile.from("# Node.js")],
    ])
  );
  return toPromise(packToZip(files));
}

function sha256(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * A TargetContext whose fetches are answered from `served` (url → bytes, absent
 * → a 404), each run through the request's own `process` into a real store.
 */
function servingContext(served: Map<string, Buffer>, cache: BuildCache, target: string, operation: string): TargetContext {
  return {
    name: "@node",
    operation,
    getGlobalString: (name: string) =>
      name === TARGET ? Computable.resolve(target) : Computable.reject(new Error(`unexpected property: ${name}`)),
    fetch: (_key: string, _tag: string, request: () => Computable<IFetchRequest>) =>
      request().then(({ url, process }): Computable<FileSet> => {
        const body = served.get(url);
        if (body === undefined) {
          return Computable.reject(new HttpStatusError(404, url));
        }
        return process(Readable.from([body]), { targetDir: "unused", createOutput: () => cache.getTemporaryWriteStream() });
      }),
  } as unknown as TargetContext;
}

describe("NodeDistribution", () => {
  let cacheDir: string;
  let cache: BuildCache;
  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-node-dist-"));
    cache = new BuildCache(cacheDir, new LogFormatter(LogLevel.Info, () => undefined));
  });
  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  /** Serve `version` from `base` for each platform, with its SHASUMS256.txt. */
  async function publish(served: Map<string, Buffer>, base: string, version: string, platforms: string[]): Promise<void> {
    const lines: string[] = [];
    for (const platform of platforms) {
      const file = `node-v${version}-${platform}.tar.gz`;
      const bytes = await archive(version, platform);
      served.set(`${base}/v${version}/${file}`, bytes);
      lines.push(`${sha256(bytes)}  ${file}`);
    }
    served.set(`${base}/v${version}/SHASUMS256.txt`, Buffer.from(lines.join("\n") + "\n"));
  }

  function distribution(served: Map<string, Buffer>, target = "arm64-apple-darwin24.0.0", operation = "build"): NodeDistribution {
    return new NodeDistribution(servingContext(served, cache, target, operation), [DIST, UNOFFICIAL]);
  }

  /** Resolve `written` (after `@node:`) in `dist` to the node it names. */
  function resolve(dist: NodeDistribution, written: string): Computable<ResolvedNode> {
    return dist.resolve(dist.getRepositoryRef(Name.fromLiteral(written)) as RepositoryRef);
  }

  /** Fetch the files of the release `written` names. */
  function release(dist: NodeDistribution, written: string): Computable<FileSet> {
    return resolve(dist, written).then(node => node.content.files() as Computable<FileSet>);
  }

  it("delivers the release for the target platform, its top directory stripped", async () => {
    const served = new Map<string, Buffer>();
    await publish(served, DIST, "24.22.1", ["darwin-arm64", "linux-x64"]);
    const pkg = await toPromise(release(distribution(served), "24.22.1"));
    expect(pkg).to.be.instanceOf(PackageFileSet);
    expect((pkg as PackageFileSet).packageName).to.equal("node");
    expect((pkg as PackageFileSet).version).to.equal("24.22.1");
    const files = new Map(pkg);
    expect(await toPromise(pkg.readFile("bin/node"))).to.equal("node 24.22.1 darwin-arm64");
    expect(files.get("bin/node")!.mode & 0o111).to.not.equal(0);
    expect(files.get("bin/npm")).to.be.instanceOf(SymlinkFile);
  });

  it("refuses an archive that does not match its SHASUMS256.txt", async () => {
    const served = new Map<string, Buffer>();
    await publish(served, DIST, "24.22.1", ["darwin-arm64"]);
    served.set(`${DIST}/v24.22.1/node-v24.22.1-darwin-arm64.tar.gz`, await archive("24.22.1", "linux-x64"));
    const err = await rejection(release(distribution(served), "24.22.1"));
    expect(err).to.be.instanceOf(IntegrityError);
  });

  it("reports a version with no SHASUMS256.txt as unpublished, as it is resolved", async () => {
    const err = await rejection(resolve(distribution(new Map()), "24.99.0"));
    expect(err).to.be.instanceOf(VersionNotFoundError);
    expect(err.message).to.contain("Node.js 24.99.0 is not published");
  });

  it("resolves an exact version without reading the version list", async () => {
    const served = new Map<string, Buffer>();
    await publish(served, DIST, "24.22.1", ["darwin-arm64"]);
    const node = await toPromise(resolve(distribution(served), "24.22.1"));
    expect(node.packageName).to.equal("node");
    expect(node.version).to.equal("24.22.1");
    expect(node.dependencies).to.deep.equal([]);
  });

  it("falls back to unofficial builds for a platform nodejs.org does not publish", async () => {
    const served = new Map<string, Buffer>();
    await publish(served, DIST, "24.15.0", ["linux-x64"]);
    await publish(served, UNOFFICIAL, "24.15.0", ["linux-x64-musl"]);
    const pkg = await toPromise(release(distribution(served, "x86_64-unknown-linux-musl"), "24.15.0"));
    expect(await toPromise(pkg.readFile("bin/node"))).to.equal("node 24.15.0 linux-x64-musl");
  });

  it("runs a Windows release's node.exe as the node command", async () => {
    const served = new Map<string, Buffer>();
    const zip = await windowsArchive("24.22.1", "win-arm64");
    served.set(`${DIST}/v24.22.1/node-v24.22.1-win-arm64.zip`, zip);
    served.set(`${DIST}/v24.22.1/SHASUMS256.txt`, Buffer.from(`${sha256(zip)}  node-v24.22.1-win-arm64.zip\n`));
    const runnable = (await toPromise(release(distribution(served, "aarch64-pc-windows-msvc", "run"), "24.22.1"))) as RunnableFileSet;
    const node = runnable.selectEntry([{ pattern: Name.fromLiteral("node"), prefix: "" }]);
    expect(node && toArgv(node.toCommandLine(["--version"]))).to.deep.equal(["./node.exe", "--version"]);
    expect(runnable.selectEntry([{ pattern: Name.fromLiteral("npm"), prefix: "" }])).to.equal(undefined);
    expect(await toPromise(runnable.readFile("node.exe"))).to.equal("node 24.22.1 win-arm64");
  });

  it("names a platform as node does, its SHASUMS256.txt deciding whether it is published", async () => {
    const served = new Map<string, Buffer>();
    await publish(served, DIST, "24.22.1", ["linux-ppc64le", "aix-ppc64", "linux-s390x"]);
    for (const [target, platform] of [
      ["powerpc64le-unknown-linux-gnu", "linux-ppc64le"],
      ["powerpc64-ibm-aix7.2", "aix-ppc64"],
      ["s390x-ibm-linux-gnu", "linux-s390x"],
    ]) {
      const pkg = await toPromise(release(distribution(served, target), "24.22.1"));
      expect(await toPromise(pkg.readFile("bin/node"))).to.equal(`node 24.22.1 ${platform}`);
    }
    const err = await rejection(resolve(distribution(served, "powerpc64-unknown-linux-gnu"), "24.22.1"));
    expect(err.message).to.equal("Node.js 24.22.1 is not published for powerpc64-unknown-linux-gnu");
  });

  it("looks in no tree but the ones declared", async () => {
    const served = new Map<string, Buffer>();
    await publish(served, DIST, "24.15.0", ["linux-x64"]);
    await publish(served, UNOFFICIAL, "24.15.0", ["linux-x64-musl"]);
    const alone = new NodeDistribution(servingContext(served, cache, "x86_64-unknown-linux-musl", "build"), [DIST]);
    const err = await rejection(alone.resolve(alone.getRepositoryRef(Name.fromLiteral("24.15.0")) as RepositoryRef));
    expect(err.message).to.equal("Node.js 24.15.0 is not published for x86_64-unknown-linux-musl");
  });

  it("refuses a platform with no release, naming the remedy", async () => {
    const err = await rejection(resolve(distribution(new Map(), "x86_64-unknown-freebsd"), "24.22.1"));
    expect(err.message).to.contain("not available for 'x86_64-unknown-freebsd'");
  });

  it("selects the lowest published version a range admits, from index.json", async () => {
    const served = new Map<string, Buffer>([
      [`${DIST}/index.json`, Buffer.from(JSON.stringify([{ version: "v24.22.1" }, { version: "v24.20.0" }, { version: "v22.23.3" }]))],
    ]);
    await publish(served, DIST, "24.20.0", ["darwin-arm64"]);
    await publish(served, DIST, "22.23.3", ["darwin-arm64"]);
    expect((await toPromise(resolve(distribution(served), "^24.19.0"))).version).to.equal("24.20.0");
    expect((await toPromise(resolve(distribution(served), "22"))).version).to.equal("22.23.3");
    expect((await rejection(resolve(distribution(served), "23"))).message).to.contain(
      "No Node.js release for arm64-apple-darwin24.0.0 satisfies '23'"
    );
  });

  it("lists the versions index.json lists, newest first", async () => {
    const served = new Map<string, Buffer>([
      [`${DIST}/index.json`, Buffer.from(JSON.stringify([{ version: "v22.23.3" }, { version: "v24.22.1" }]))],
    ]);
    const children = await toPromise(distribution(served).children());
    expect([...children.keys()]).to.deep.equal(["24.22.1", "22.23.3"]);
  });

  it("reads a reference as a version of node and a projection into it, and refuses a marker", () => {
    const dist = distribution(new Map());
    const ref = dist.getRepositoryRef(Name.fromLiteral("24.22.1:bin/node")) as RepositoryRef;
    expect([ref.name, ref.versionConstraint]).to.deep.equal(["node", "24.22.1"]);
    expect(ref.projections.map(projection => projection.pattern.toString())).to.deep.equal(["bin/node"]);
    expect(dist.getRepositoryRef(Name.fromLiteral(""))).to.be.instanceOf(PartialRepositoryRef);
    expect(() => dist.getRepositoryRef(parseName("24.22.1!"))).to.throw(/override marker means nothing/);
  });

  it("runs the file a projection selects or the command it names, keeping the release's own symlinks out of the entries", async () => {
    const served = new Map<string, Buffer>();
    await publish(served, DIST, "24.22.1", ["darwin-arm64"]);
    const runnable = (await toPromise(release(distribution(served, undefined, "run"), "24.22.1"))) as RunnableFileSet;
    for (const entry of ["bin/node", "node"]) {
      const node = runnable.selectEntry([{ pattern: Name.fromLiteral(entry), prefix: "" }]);
      expect(node && toArgv(node.toCommandLine(["--version"]))).to.deep.equal(["bin/node", "--version"]);
    }
    expect(new Map(runnable.surface).has("bin/npm")).to.equal(false);
    expect(runnable.selectEntry([{ pattern: Name.fromLiteral("npm"), prefix: "" }])).to.equal(undefined);
    expect(new Map(runnable).get("bin/npm")).to.be.instanceOf(SymlinkFile);
  });
});
