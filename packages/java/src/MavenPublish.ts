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
 * Publishing to a Maven repository, as `mvn deploy` does to a repository
 * manager: each member is its artifact (the one jar, war or ear among its
 * files) and a POM generated from the edges its build bound, laid out at their
 * paths in the repository with `.md5` and `.sha1` checksums beside each, and
 * the package's `maven-metadata.xml` brought up to date when it is uploaded.
 */

import * as crypto from "node:crypto";
import {
  Computable,
  declaredRequirement,
  Dependency,
  dependencyName,
  FabrError,
  FileSet,
  IFile,
  isRepositoryReader,
  MemoryFile,
  PackageFileSet,
  PublishableFileSet,
  PublishMember,
  RepositoryPublishRef,
  RepositoryRef,
} from "@fabr-build/core";
import { MAVEN_FORMAT, splitMavenName } from "./MavenProtocol";
import { MAVEN_VERSIONS } from "./MavenVersion";
import { parseXml, xmlChild, xmlChildren } from "./Xml";

/** The artifact files a member can publish, by extension, and the packaging its POM names for each. */
const ARTIFACT_PACKAGING = new Map([
  ["jar", "jar"],
  ["war", "war"],
  ["ear", "ear"],
]);

/** The checksum files written beside each published file, by extension and algorithm. */
const CHECKSUMS: ReadonlyArray<[string, string]> = [
  ["md5", "md5"],
  ["sha1", "sha1"],
];

/** A dependency as a POM records it. */
export interface PomDependency {
  readonly groupId: string;
  readonly artifactId: string;
  readonly version: string;
  /** `provided` where the consumer supplies it; absent for an ordinary one. */
  readonly scope?: "provided";
  /** True where the consumer may leave it out. */
  readonly optional?: boolean;
}

/** What a POM records about a package. */
export interface Pom {
  readonly groupId: string;
  readonly artifactId: string;
  readonly version: string;
  readonly packaging: string;
  readonly dependencies: readonly PomDependency[];
  /** BOMs whose versions the package's dependencies are managed by, imported into its `dependencyManagement`. */
  readonly imports: readonly PomDependency[];
}

/** @return the path of `file` in a Maven repository, within the version's directory of `groupId:artifactId:version`. */
export function repositoryPath(groupId: string, artifactId: string, version: string, file: string): string {
  return `${groupId.replace(/\./g, "/")}/${artifactId}/${version}/${file}`;
}

/** @return the path of a package's `maven-metadata.xml` in a Maven repository. */
export function metadataPath(groupId: string, artifactId: string): string {
  return `${groupId.replace(/\./g, "/")}/${artifactId}/maven-metadata.xml`;
}

/** Escape `text` for an XML element's content. */
function escaped(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function dependencyXml({ groupId, artifactId, version, scope, optional }: PomDependency, indent: string, extra: string[] = []): string[] {
  return [
    `${indent}<dependency>`,
    `${indent}  <groupId>${escaped(groupId)}</groupId>`,
    `${indent}  <artifactId>${escaped(artifactId)}</artifactId>`,
    `${indent}  <version>${escaped(version)}</version>`,
    ...extra.map(line => `${indent}  ${line}`),
    ...(scope === undefined ? [] : [`${indent}  <scope>${scope}</scope>`]),
    ...(optional ? [`${indent}  <optional>true</optional>`] : []),
    `${indent}</dependency>`,
  ];
}

/** Write `pom` as a `pom.xml`. */
export function pomText(pom: Pom): string {
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">`,
    `  <modelVersion>4.0.0</modelVersion>`,
    `  <groupId>${escaped(pom.groupId)}</groupId>`,
    `  <artifactId>${escaped(pom.artifactId)}</artifactId>`,
    `  <version>${escaped(pom.version)}</version>`,
    ...(pom.packaging === "jar" ? [] : [`  <packaging>${escaped(pom.packaging)}</packaging>`]),
    ...(pom.imports.length === 0
      ? []
      : [
          `  <dependencyManagement>`,
          `    <dependencies>`,
          ...pom.imports.flatMap(bom => dependencyXml(bom, "      ", ["<type>pom</type>", "<scope>import</scope>"])),
          `    </dependencies>`,
          `  </dependencyManagement>`,
        ]),
    ...(pom.dependencies.length === 0
      ? []
      : [`  <dependencies>`, ...pom.dependencies.flatMap(dep => dependencyXml(dep, "    ")), `  </dependencies>`]),
    `</project>`,
  ];
  return lines.join("\n") + "\n";
}

/** Make the checksum files of `bytes` published at `path`, each named `<path>.<algorithm>`. */
export function checksumFiles(path: string, bytes: Buffer): Array<[string, IFile]> {
  return CHECKSUMS.map(([extension, algorithm]) => [
    `${path}.${extension}`,
    MemoryFile.from(crypto.createHash(algorithm).update(bytes).digest("hex")),
  ]);
}

/**
 * Bring a package's `maven-metadata.xml` up to date with `version`: the
 * versions `existing` lists with `version` among them, in Maven's order, the
 * highest of them its latest and release, updated at `now`.
 */
export function mergedMetadata(existing: string | undefined, groupId: string, artifactId: string, version: string, now: Date): string {
  const listed =
    existing === undefined ? [] : xmlChildren(xmlChild(xmlChild(parseXml(existing, "maven-metadata.xml"), "versioning"), "versions"), "version").map(each => each.text);
  const versions = [...new Set([...listed, version])]
    .map(text => MAVEN_VERSIONS.parseVersion(text))
    .sort((a, b) => MAVEN_VERSIONS.compare(a, b))
    .map(parsed => parsed.text);
  const highest = versions[versions.length - 1];
  const lastUpdated = now.toISOString().replace(/[-:T]/g, "").substring(0, 14);
  return (
    [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<metadata>`,
      `  <groupId>${escaped(groupId)}</groupId>`,
      `  <artifactId>${escaped(artifactId)}</artifactId>`,
      `  <versioning>`,
      `    <latest>${escaped(highest)}</latest>`,
      `    <release>${escaped(highest)}</release>`,
      `    <versions>`,
      ...versions.map(each => `      <version>${escaped(each)}</version>`),
      `    </versions>`,
      `    <lastUpdated>${lastUpdated}</lastUpdated>`,
      `  </versioning>`,
      `</metadata>`,
    ].join("\n") + "\n"
  );
}

/**
 * Find the one coordinate the release publishes target `name` at, among
 * `targets`; undefined where it publishes the target nowhere, or at more than
 * one coordinate.
 */
function coordinateOfTarget(targets: ReadonlyMap<string, readonly RepositoryPublishRef[]>, name: string): RepositoryPublishRef | undefined {
  const found = (targets.get(name) ?? []).filter(each => isRepositoryReader(each.source) && each.source.format === MAVEN_FORMAT);
  const distinct = new Map(found.map(each => [`${each.name}:${each.version}`, each]));
  return distinct.size === 1 ? [...distinct.values()][0] : undefined;
}

/** Find the one artifact among a member's files: its jar, war or ear. */
function artifactOf(destination: RepositoryPublishRef, content: FileSet): { file: IFile; extension: string } {
  const artifacts = [...content].filter(([name]) => !name.includes("/") && ARTIFACT_PACKAGING.has(name.substring(name.lastIndexOf(".") + 1)));
  if (artifacts.length !== 1) {
    throw new FabrError(
      `cannot publish ${destination.toString()}: its content must hold one jar, war or ear at its root, and holds ${
        artifacts.length === 0 ? "none" : artifacts.map(([name]) => name).join(", ")
      }`
    );
  }
  const [[name, file]] = artifacts;
  return { file, extension: name.substring(name.lastIndexOf(".") + 1) };
}

/**
 * Make the POM dependency an edge of the member's package declares: what its
 * reference states, with the version its build bound where the reference
 * states none, or for a target of the project, the coordinate the release
 * publishes that target at. A BOM, a package with no artifact, is an import.
 */
function pomDependencyOf(
  destination: RepositoryPublishRef,
  pkg: PackageFileSet,
  dep: Dependency,
  targets: ReadonlyMap<string, readonly RepositoryPublishRef[]>
): Computable<{ dependency?: PomDependency; bom?: PomDependency }> {
  return declaredRequirement(dep).then(declared => {
    if (declared === undefined) {
      return {};
    }
    const provided = pkg.provided.get(dependencyName(dep));
    const scope = provided === "expected" ? { scope: "provided" as const } : provided === "optional" ? { optional: true } : {};
    const { reference } = dep;
    if (reference instanceof RepositoryRef) {
      if (!isRepositoryReader(reference.source) || reference.source.format !== MAVEN_FORMAT) {
        throw new FabrError(`cannot publish ${destination.toString()}: it depends on '${reference.toString()}', which is no Maven package`);
      }
      if (declared.versionConstraint === undefined) {
        throw new FabrError(`cannot publish ${destination.toString()}: no version to record for '${reference.toString()}'`);
      }
      const { groupId, artifactId } = splitMavenName(declared.name);
      const recorded: PomDependency = { groupId, artifactId, version: declared.versionConstraint, ...scope };
      const bound = dep.package;
      return bound instanceof PackageFileSet && bound.isEmpty() ? { bom: recorded } : { dependency: recorded };
    }
    const assigned = coordinateOfTarget(targets, declared.name);
    if (assigned === undefined) {
      throw new FabrError(
        `cannot publish ${destination.toString()}: no version to record for '${declared.name}', which is built in this project`
      ).withHelp(`publish '${declared.name}' in the same sync`);
    }
    const { groupId, artifactId } = splitMavenName(assigned.name);
    return { dependency: { groupId, artifactId, version: assigned.version, ...scope } };
  });
}

/**
 * Package one member for a Maven repository: its artifact and a POM generated
 * from what its package requires, at their repository paths, each with its
 * checksums. Content that is no package (a war's files) has a POM with no
 * dependencies.
 */
export function packageMavenMember(
  member: PublishMember,
  targets: ReadonlyMap<string, readonly RepositoryPublishRef[]>,
  coMembers: ReadonlySet<string>
): Computable<PublishableFileSet> {
  const { destination, content } = member;
  const { groupId, artifactId } = splitMavenName(destination.name);
  const { version } = destination;
  const { file, extension } = artifactOf(destination, content);
  const edges = content instanceof PackageFileSet ? content.dependencies : [];
  return Computable.forAll(
    edges.map(dep => pomDependencyOf(destination, content as PackageFileSet, dep, targets)),
    (...recorded: Array<{ dependency?: PomDependency; bom?: PomDependency }>) => recorded
  ).then(recorded =>
    file.getBuffer().then(bytes => {
      const dependencies = recorded.flatMap(each => (each.dependency === undefined ? [] : [each.dependency]));
      const imports = recorded.flatMap(each => (each.bom === undefined ? [] : [each.bom]));
      const pom = Buffer.from(pomText({ groupId, artifactId, version, packaging: ARTIFACT_PACKAGING.get(extension)!, dependencies, imports }));
      const artifactPath = repositoryPath(groupId, artifactId, version, `${artifactId}-${version}.${extension}`);
      const pomPath = repositoryPath(groupId, artifactId, version, `${artifactId}-${version}.pom`);
      const files: Array<[string, IFile]> = [
        [artifactPath, file],
        ...checksumFiles(artifactPath, bytes),
        [pomPath, new MemoryFile(pom)],
        ...checksumFiles(pomPath, pom),
      ];
      const dependsOn = dependencies.map(dep => `${dep.groupId}/${dep.artifactId}`).filter(name => coMembers.has(name));
      return new PublishableFileSet(files, destination, destination.name, dependsOn);
    })
  );
}
