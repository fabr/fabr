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
  SymlinkFile,
  TARGET,
  TargetContext,
  VersionNotFoundError,
  parseVersion,
} from "@fabr-build/core";
import { NODE_FORMAT, NodeDistribution } from "./NodeDistribution";

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
function release(version: string, platform: string): Promise<Buffer> {
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

function sha256(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * A TargetContext whose fetches are answered from `served` (url → bytes, absent
 * → a 404), each run through the request's own `process` into a real store.
 */
function servingContext(served: Map<string, Buffer>, cache: BuildCache, target: string): TargetContext {
  return {
    name: "@node",
    operation: "build",
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
      const archive = await release(version, platform);
      served.set(`${base}/v${version}/${file}`, archive);
      lines.push(`${sha256(archive)}  ${file}`);
    }
    served.set(`${base}/v${version}/SHASUMS256.txt`, Buffer.from(lines.join("\n") + "\n"));
  }

  function distribution(served: Map<string, Buffer>, target = "arm64-apple-darwin24.0.0"): NodeDistribution {
    return new NodeDistribution(servingContext(served, cache, target), DIST, UNOFFICIAL);
  }

  it("delivers the release for the target platform, its top directory stripped", async () => {
    const served = new Map<string, Buffer>();
    await publish(served, DIST, "24.22.1", ["darwin-arm64", "linux-x64"]);
    const pkg = await toPromise(distribution(served).fetch("node", parseVersion("24.22.1")));
    expect(pkg).to.be.instanceOf(PackageFileSet);
    expect(pkg.packageName).to.equal("node");
    expect(pkg.version).to.equal("24.22.1");
    const files = new Map(pkg);
    expect(await toPromise(pkg.readFile("bin/node"))).to.equal("node 24.22.1 darwin-arm64");
    expect(files.get("bin/node")!.mode & 0o111).to.not.equal(0);
    expect(files.get("bin/npm")).to.be.instanceOf(SymlinkFile);
  });

  it("refuses an archive that does not match its SHASUMS256.txt", async () => {
    const served = new Map<string, Buffer>();
    await publish(served, DIST, "24.22.1", ["darwin-arm64"]);
    served.set(`${DIST}/v24.22.1/node-v24.22.1-darwin-arm64.tar.gz`, await release("24.22.1", "linux-x64"));
    const err = await rejection(distribution(served).fetch("node", parseVersion("24.22.1")));
    expect(err).to.be.instanceOf(IntegrityError);
  });

  it("reports a version with no SHASUMS256.txt as unpublished", async () => {
    const dist = distribution(new Map());
    expect(await rejection(dist.getRequirements("node", parseVersion("24.99.0")))).to.be.instanceOf(VersionNotFoundError);
    expect((await rejection(dist.fetch("node", parseVersion("24.99.0")))).message).to.contain("Node.js 24.99.0 is not published");
  });

  it("requires nothing of a published version", async () => {
    const served = new Map<string, Buffer>();
    await publish(served, DIST, "24.22.1", ["darwin-arm64"]);
    expect(await toPromise(distribution(served).getRequirements("node", parseVersion("24.22.1")))).to.deep.equal([]);
  });

  it("falls back to unofficial builds for a platform nodejs.org does not publish", async () => {
    const served = new Map<string, Buffer>();
    await publish(served, DIST, "24.15.0", ["linux-x64"]);
    await publish(served, UNOFFICIAL, "24.15.0", ["linux-x64-musl"]);
    const pkg = await toPromise(distribution(served, "x86_64-unknown-linux-musl").fetch("node", parseVersion("24.15.0")));
    expect(await toPromise(pkg.readFile("bin/node"))).to.equal("node 24.15.0 linux-x64-musl");
  });

  it("refuses a platform with no release, naming the remedy", async () => {
    const err = await rejection(distribution(new Map(), "x86_64-pc-windows-msvc").fetch("node", parseVersion("24.22.1")));
    expect(err.message).to.contain("not available for 'x86_64-pc-windows-msvc'");
  });

  it("raises an unpublished floor to the lowest published version index.json lists", async () => {
    const served = new Map<string, Buffer>([
      [`${DIST}/index.json`, Buffer.from(JSON.stringify([{ version: "v24.22.1" }, { version: "v24.20.0" }, { version: "v22.23.3" }]))],
    ]);
    const lowest = await toPromise(distribution(served).lowestAvailable("node", "^24.19.0"));
    expect(lowest && lowest.toString()).to.equal(parseVersion("24.20.0").toString());
  });

  it("reads a reference as a version of node and a projection into it", () => {
    const { projection, ...requirement } = NODE_FORMAT.splitReference(Name.fromLiteral("24.22.1:bin/node"));
    expect(requirement).to.deep.equal({ name: "node", versionConstraint: "24.22.1" });
    expect(projection?.pattern.toString()).to.equal("bin/node");
    expect(() => NODE_FORMAT.validateRequirement({ name: "node", versionConstraint: undefined })).to.throw(/Missing version/);
  });

  it("runs the file a projection selects, keeping the release's own symlinks out of the entries", async () => {
    const served = new Map<string, Buffer>();
    await publish(served, DIST, "24.22.1", ["darwin-arm64"]);
    const pkg = await toPromise(distribution(served).fetch("node", parseVersion("24.22.1")));
    const runnable = await toPromise(NODE_FORMAT.makeRunnable(pkg, undefined as never));
    const node = runnable.selectEntry([{ pattern: Name.fromLiteral("bin/node"), prefix: "" }]);
    expect(node?.toCommandLine(["--version"])).to.deep.equal(["bin/node", "--version"]);
    expect(new Map(runnable.surface).has("bin/npm")).to.equal(false);
    expect(new Map(runnable).get("bin/npm")).to.be.instanceOf(SymlinkFile);
  });
});
