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
import { Computable } from "../core/Computable";
import { VersionNotFoundError } from "../core/Errors";
import { FileSet } from "../core/FileSet";
import { MemoryFile } from "../core/MemoryFS";
import { Name } from "../core/Name";
import { PackageFileSet } from "../core/PackageFileSet";
import { SourceRef } from "../core/Repository";
import { RunnableFileSet } from "../core/RunnableFileSet";
import { TargetContext } from "../model/BuildContext";
import { IContentPackage, PackageFormat } from "../resolver/PackageFormat";
import { parseVersion, SEMVER, SemverConstraint, SemverVersion, versionToString } from "../resolver/Semver";
import { PackageRegistry } from "../resolver/PackageResolver";
import { contentPackageMember } from "./ContentPackage";

/** A minimal format for driving the member: `pkg.json` manifests over semver
 * (`{"name": …, "version": …, "deps": {…}}`). */
const FORMAT: PackageFormat<SemverVersion, SemverConstraint> = {
  ...SEMVER,
  resolutionTag: "test:resolve:1",
  splitReference: (name: Name) => ({ requirement: name }),
  parseRequirement: () => {
    throw new Error("not used");
  },
  parsePublishCoordinate: () => {
    throw new Error("not used");
  },
  readContentPackage: (files: FileSet): Computable<IContentPackage<SemverVersion>> =>
    files.readFile("pkg.json").then(text => {
      const meta = JSON.parse(text) as { name?: string; version: string; deps?: Record<string, string> };
      return {
        name: meta.name,
        version: parseVersion(meta.version),
        requirements: Object.entries(meta.deps ?? {}).map(([pkg, constraint]) => ({ pkg, constraint })),
      };
    }),
  makeRunnable: (pkg: PackageFileSet) => Computable.reject<RunnableFileSet>(new Error(`cannot run '${pkg.packageName}'`)),
};

/** The TargetContext surface the member uses: the declaring target's
 * name, and source settlement — here, each source IS its delivered fileset. */
function contextFor(): TargetContext {
  return {
    name: "@deps",
    materializeSources: (sources: SourceRef[]) => Computable.resolve(sources),
  } as unknown as TargetContext;
}

function packageFiles(manifest: Record<string, unknown>, extra: Record<string, string> = {}): FileSet {
  const entries: [string, MemoryFile][] = [
    ["pkg.json", MemoryFile.from(JSON.stringify(manifest))],
    ...Object.entries(extra).map(([name, content]): [string, MemoryFile] => [name, MemoryFile.from(content)]),
  ];
  return new FileSet(new Map(entries));
}

function memberFor(files: FileSet, name = "mylib"): PackageRegistry<SemverVersion, SemverConstraint> {
  return contentPackageMember(FORMAT, contextFor(), name, files);
}

async function failure(computable: Computable<unknown>): Promise<Error> {
  try {
    await computable;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected rejection, but it resolved");
}

const MANIFEST = { name: "mylib", version: "1.2.3", deps: { "left-pad": "^1.0.0" } };

describe("ContentPackageMember", () => {
  it("answers the declared version's requirements from the manifest", async () => {
    const requirements = await memberFor(packageFiles(MANIFEST)).getRequirements("mylib", parseVersion("1.2.3"));
    expect(requirements).to.deep.equal([{ pkg: "left-pad", constraint: "^1.0.0" }]);
  });

  it("rejects another version as unpublished — the resolver's raisable signal", async () => {
    const err = await failure(memberFor(packageFiles(MANIFEST)).getRequirements("mylib", parseVersion("1.0.0")));
    expect(err).to.be.instanceOf(VersionNotFoundError);
    expect(err.message).to.contain("declared content at version 1.2.3");
  });

  it("raises a floor to the declared version iff it satisfies the range", async () => {
    const member = memberFor(packageFiles(MANIFEST));
    expect(versionToString((await member.lowestAvailable!("mylib", "^1.0.0"))!)).to.equal("1.2.3");
    expect(await member.lowestAvailable!("mylib", "^2.0.0")).to.equal(undefined);
    /* An unparseable constraint is no raise, not an error (advisory path). */
    expect(await member.lowestAvailable!("mylib", "not-a-range")).to.equal(undefined);
  });

  it("lists exactly the one declared version, for its own name only", async () => {
    const member = memberFor(packageFiles(MANIFEST));
    const versions = await member.availableVersions!("mylib");
    expect(versions!.map(versionToString)).to.deep.equal(["1.2.3"]);
    expect(await member.availableVersions!("left-pad")).to.equal(undefined);
  });

  it("keys the resolution environment on the version + requirements, nothing else", async () => {
    const key = await memberFor(packageFiles(MANIFEST)).environmentKey();
    expect(key).to.contain("content:mylib:");
    const bumped = await memberFor(packageFiles({ ...MANIFEST, version: "1.2.4" })).environmentKey();
    expect(bumped).to.not.equal(key);
    const repinned = await memberFor(packageFiles({ ...MANIFEST, deps: { "left-pad": "^1.3.0" } })).environmentKey();
    expect(repinned).to.not.equal(key);
    /* Content that does not shape the resolution must not invalidate its memo
     * — extra files, or manifest fields beyond the identity/requirements. */
    const extra = await memberFor(packageFiles({ ...MANIFEST, description: "words" }, { "lib/index.js": "42" })).environmentKey();
    expect(extra).to.equal(key);
  });

  it("delivers the content as the identified package", async () => {
    const files = packageFiles(MANIFEST, { "lib/index.js": "42" });
    const pkg = await memberFor(files).fetch("mylib", parseVersion("1.2.3"));
    expect(pkg).to.be.instanceOf(PackageFileSet);
    expect(pkg.packageName).to.equal("mylib");
    expect(pkg.version).to.equal("1.2.3");
    expect(await pkg.readFile("lib/index.js")).to.equal("42");
  });

  it("rejects a manifest that names a different package", async () => {
    const err = await failure(memberFor(packageFiles(MANIFEST), "mylib-fork").availableVersions!("mylib-fork"));
    expect(err.message).to.contain("content route 'mylib-fork' in @deps");
    expect(err.message).to.contain("names itself 'mylib'");
  });

  it("positions a manifest-read failure at the declaring route", async () => {
    const empty = new FileSet(new Map());
    const err = await failure(memberFor(empty).availableVersions!("mylib"));
    expect(err.message).to.contain("content route 'mylib' in @deps");
    expect(err.message).to.contain("pkg.json");
  });

  it("is read-only: no publish vend for the group's pass-through to delegate to", () => {
    const member = memberFor(packageFiles(MANIFEST));
    expect(member.identity).to.equal("content:mylib");
    expect("getRepositoryPublishRef" in member).to.equal(false);
  });
});
