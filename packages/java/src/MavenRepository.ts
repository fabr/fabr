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

/**
 * The `maven_repository` repository: a Maven repository laid out as Maven
 * Central is (`<group path>/<artifact>/<version>/<artifact>-<version>.pom`).
 * A package's requirements are the dependencies its effective POM passes on
 * (see {@link passedOnDependencies}), and its files are its artifact as
 * published (`slf4j-api-1.7.36.jar`), checked against the repository's
 * `.sha1`; a `pom`-packaged artifact has no files.
 */

import {
  Computable,
  FabrError,
  fetchDocument,
  fetchFile,
  FileSet,
  MemoryCache,
  Name,
  NamespaceRef,
  PackageFileSet,
  Reference,
  Repository,
  RepositoryPublishRef,
  RepositoryReader,
  RepositoryRef,
  RepositoryRegistration,
  Requirement,
  resolveBarePackage,
  TargetContext,
  vendPackageRef,
  versionChildren,
  VersionNotFoundError,
} from "@fabr-build/core";
import { MAVEN_FORMAT, mavenName, splitMavenName } from "./MavenProtocol";
import { MavenConstraint, MavenVersion, MAVEN_VERSIONS } from "./MavenVersion";
import { coordinateText, EffectivePom, effectivePom, parsePom, passedOnDependencies, PomCoordinate, RawPom } from "./Pom";
import { parseXml, xmlChild, xmlChildren } from "./Xml";

const METADATA_FILE = "maven-metadata.xml";

/** The file extension an artifact of each packaging is published with, where it is not `jar`. */
const PACKAGING_EXTENSIONS = new Map([
  ["war", "war"],
  ["ear", "ear"],
  ["rar", "rar"],
  ["aar", "aar"],
]);

/** Convert a `maven-metadata.xml` to the versions it lists. */
function toMetadataVersions(text: string, what: string): string[] {
  const metadata = parseXml(text, what);
  if (metadata.name !== "metadata") {
    throw new FabrError(`${what} is not Maven metadata: its root element is <${metadata.name}>`);
  }
  return xmlChildren(xmlChild(xmlChild(metadata, "versioning"), "versions"), "version").map(version => version.text);
}

/** Convert a `.sha1` file to the digest it states (the first word, as some name the file after it). */
function toSha1(text: string, what: string): string {
  const match = /^\s*([0-9a-fA-F]{40})\b/.exec(text);
  if (!match) {
    throw new FabrError(`${what} states no SHA-1 digest`);
  }
  return match[1].toLowerCase();
}

/** @return the lowest of `versions` satisfying `constraint`, preferring a stable one. */
function lowestSatisfying(versions: readonly MavenVersion[], constraint: MavenConstraint): MavenVersion | undefined {
  const satisfying = versions.filter(version => MAVEN_VERSIONS.satisfies(version, constraint)).sort(MAVEN_VERSIONS.compare);
  return satisfying.find(version => MAVEN_VERSIONS.isStable?.(version) !== false) ?? satisfying[0];
}

export class MavenRepository implements Repository, RepositoryReader<MavenVersion, MavenConstraint> {
  public readonly format = MAVEN_FORMAT;
  private readonly versions = new MemoryCache<string, MavenVersion[] | undefined>();
  private readonly poms = new MemoryCache<string, RawPom | undefined>();
  private readonly effectivePoms = new MemoryCache<string, EffectivePom>();

  constructor(
    private readonly context: TargetContext,
    private readonly url: string
  ) {}

  public get identity(): string {
    return this.url;
  }

  public get name(): string {
    return this.context.name;
  }

  public get operation(): string {
    return this.context.operation;
  }

  public getRepositoryRef(name: Name): RepositoryRef | NamespaceRef {
    return vendPackageRef(this, this.format, name);
  }

  /** List a package's published versions. A group, or the whole repository, cannot be listed. */
  public children({ name }: NamespaceRef): Computable<Map<string, Reference>> {
    if (!name.includes("/")) {
      return Computable.reject(
        new FabrError(`the repository at ${this.url} cannot list ${name === "" ? "every package it holds" : `the packages in ${name}`}`).withHelp(
          `name a package to list its versions, as in '${this.name}:${name === "" ? "<group>" : name}:<artifact>'`
        )
      );
    }
    return versionChildren(this, this.format, name, this.publishedVersions(name));
  }

  public getRepositoryPublishRef(): RepositoryPublishRef {
    throw new FabrError(`${this.name} cannot be published to yet`);
  }

  /** Name the environment a resolution depends on: none, as no artifact is chosen by platform. */
  public environmentKey(): Computable<string> {
    return Computable.resolve("");
  }

  /** Get the requirements of a package: what its effective POM passes on, its
   *  optional and provided-scope dependencies as optional provided requirements. */
  public getRequirements(name: string, version: MavenVersion): Computable<Requirement[]> {
    return this.effectivePomOf(name, version.text).then(pom =>
      passedOnDependencies(pom).map(({ dependency, optional }) => ({
        name: mavenName(dependency.groupId, dependency.artifactId),
        versionConstraint: dependency.version,
        ...(optional ? { provided: "optional" as const } : {}),
      }))
    );
  }

  public lowestAvailable(name: string, constraint: string): Computable<MavenVersion | undefined> {
    let parsed: MavenConstraint;
    try {
      parsed = MAVEN_VERSIONS.parseConstraint(constraint);
    } catch {
      return Computable.resolve(undefined);
    }
    return this.publishedVersions(name).then(versions => versions && lowestSatisfying(versions, parsed));
  }

  public availableVersions(name: string): Computable<MavenVersion[] | undefined> {
    return this.publishedVersions(name);
  }

  public fetchFiles(reference: RepositoryRef): Computable<FileSet> {
    return Computable.resolve(undefined).then(() => resolveBarePackage(this, reference));
  }

  /** Fetch a package's artifact, checked against its `.sha1`: nothing for a `pom`-packaged one. */
  public fetch(name: string, version: MavenVersion): Computable<PackageFileSet> {
    const coordinate = this.coordinateOf(name, version.text);
    return this.effectivePomOf(name, version.text).then(pom => {
      if (pom.packaging === "pom") {
        return new PackageFileSet([], name, version.text);
      }
      const file = `${coordinate.artifactId}-${coordinate.version}.${PACKAGING_EXTENSIONS.get(pom.packaging) ?? "jar"}`;
      const artifactUrl = `${this.versionUrl(coordinate)}/${file}`;
      return fetchFile(this.context, {
        key: `${this.identity} ${coordinateText(coordinate)}`,
        tag: "maven:artifact:1",
        report: { resource: "artifact", role: "content" },
        name: file,
        source: () =>
          this.sha1Of(artifactUrl).then(sha1 => ({
            url: artifactUrl,
            expected: sha1 === undefined ? undefined : { algorithm: "sha1", encoding: "hex" as const, value: sha1 },
          })),
      }).then(files => new PackageFileSet(files, name, version.text));
    });
  }

  private coordinateOf(name: string, version: string): PomCoordinate {
    return { ...splitMavenName(name), version };
  }

  private artifactUrl({ groupId, artifactId }: { groupId: string; artifactId: string }): string {
    return `${this.url}/${groupId.replace(/\./g, "/")}/${artifactId}`;
  }

  private versionUrl(coordinate: PomCoordinate): string {
    return `${this.artifactUrl(coordinate)}/${coordinate.version}`;
  }

  /** Build the effective POM of a package; a version with no POM is not published. */
  private effectivePomOf(name: string, version: string): Computable<EffectivePom> {
    const coordinate = this.coordinateOf(name, version);
    return this.effectivePoms.getOrCreate(coordinateText(coordinate), () =>
      this.requiredPom(coordinate).then(raw => effectivePom(raw, parent => this.requiredPom(parent), coordinateText(coordinate)))
    );
  }

  private requiredPom(coordinate: PomCoordinate): Computable<RawPom> {
    return this.pom(coordinate).then(raw => {
      if (raw === undefined) {
        throw new VersionNotFoundError(
          mavenName(coordinate.groupId, coordinate.artifactId),
          coordinate.version,
          `${coordinateText(coordinate)} is not published at ${this.url}`
        );
      }
      return raw;
    });
  }

  /** Read the POM published at a coordinate, or undefined where there is none. */
  private pom(coordinate: PomCoordinate): Computable<RawPom | undefined> {
    const url = `${this.versionUrl(coordinate)}/${coordinate.artifactId}-${coordinate.version}.pom`;
    return this.poms.getOrCreate(url, () =>
      fetchDocument(this.context, {
        url,
        file: "pom.xml",
        tag: "maven:pom:1",
        report: { resource: "POM", role: "index" },
        convert: text => parsePom(text, url),
      })
    );
  }

  /** Read the SHA-1 published beside an artifact, or undefined where there is none. */
  private sha1Of(artifactUrl: string): Computable<string | undefined> {
    const url = `${artifactUrl}.sha1`;
    return fetchDocument(this.context, {
      url,
      file: "sha1",
      tag: "maven:sha1:1",
      report: { resource: "checksum", role: "index" },
      convert: text => toSha1(text, url),
    });
  }

  /** List a package's published versions, from its `maven-metadata.xml`, or
   *  undefined where the repository has no such package. */
  private publishedVersions(name: string): Computable<MavenVersion[] | undefined> {
    const url = `${this.artifactUrl(splitMavenName(name))}/${METADATA_FILE}`;
    return this.versions.getOrCreate(url, () =>
      fetchDocument(this.context, {
        url,
        file: METADATA_FILE,
        tag: "maven:metadata:1",
        report: { resource: "version list", role: "index" },
        convert: text => toMetadataVersions(text, url),
        options: { immutable: false },
      }).then(listed =>
        listed?.flatMap(text => {
          try {
            return [MAVEN_VERSIONS.parseVersion(text)];
          } catch {
            return [];
          }
        })
      )
    );
  }
}

function createRepository(context: TargetContext): Computable<Repository> {
  return context.getRequiredString("url").then(url => new MavenRepository(context, url.replace(/\/+$/, "")));
}

export const mavenRepositoryRegistration: RepositoryRegistration = { type: "maven_repository", provider: createRepository };
