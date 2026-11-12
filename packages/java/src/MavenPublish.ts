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
 * files) and a POM generated from the dependencies its package carries, laid
 * out at their paths in the repository with `.md5` and `.sha1` checksums
 * beside each, and the package's `maven-metadata.xml` brought up to date when
 * it is uploaded.
 */

import XMLBuilder from "fast-xml-builder";
import * as crypto from "node:crypto";
import {
  compareText,
  Computable,
  declaredRequirement,
  Dependency,
  dependencyName,
  FabrError,
  FileSet,
  IFile,
  isRepositoryReader,
  MemoryFile,
  MetadataMap,
  MetadataValue,
  PackageFileSet,
  PublishableFileSet,
  PublishMember,
  packToZip,
  PackagePublishRef,
  packageCoordinateOf,
  packageCoordinates,
  RepositoryPublishRef,
  RepositoryRef,
  RepositoryWriter,
} from "@fabr-build/core";
import { MAVEN_FORMAT, mavenVariantOf, splitMavenName } from "./MavenProtocol";
import { MAVEN_VERSIONS, MavenVersion } from "./MavenVersion";
import { PomDependency } from "./Pom";
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

/** POM elements the generator writes itself, which `metadata` cannot give. */
const GENERATED_ELEMENTS = new Set([
  "modelVersion",
  "groupId",
  "artifactId",
  "version",
  "packaging",
  "dependencies",
  "dependencyManagement",
]);

/** POM elements that only mean something to a build, which a published POM does not carry. */
const BUILD_ELEMENTS = new Set([
  "parent",
  "modules",
  "properties",
  "build",
  "reporting",
  "profiles",
  "repositories",
  "pluginRepositories",
  "distributionManagement",
]);

/** POM elements that hold a list, with the name of each element in it. */
const LIST_ELEMENTS = new Map([
  ["licenses", "license"],
  ["developers", "developer"],
  ["contributors", "contributor"],
  ["mailingLists", "mailingList"],
  ["otherArchives", "otherArchive"],
  ["roles", "role"],
]);

/** What a POM records about a package. */
export interface Pom {
  readonly groupId: string;
  readonly artifactId: string;
  readonly version: string;
  readonly packaging: string;
  /** Further elements: the package's `metadata`. */
  readonly metadata: MetadataMap;
  readonly dependencies: readonly PomDependency[];
  /** The BOMs the package's dependencies are managed by, each imported (`type` pom, `scope` import). */
  readonly dependencyManagement: readonly PomDependency[];
}

/** @return the path of `file` in a Maven repository, within the version's directory of `groupId:artifactId:version`. */
export function repositoryPath(groupId: string, artifactId: string, version: string, file: string): string {
  return `${groupId.replace(/\./g, "/")}/${artifactId}/${version}/${file}`;
}

/** @return the path of a package's `maven-metadata.xml` in a Maven repository. */
export function metadataPath(groupId: string, artifactId: string): string {
  return `${groupId.replace(/\./g, "/")}/${artifactId}/maven-metadata.xml`;
}

const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: "@_", format: true, indentBy: "  " });

/** @return the XML document whose root element is `root`'s one entry: an element's children by name, a repeated one as a list, its attributes prefixed `@_`. */
function xmlDocument(root: Record<string, unknown>): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build(root)}`;
}

/** @return the `<dependency>` element of `dependency`, leaving out the default type (`jar`) and scope (`compile`). */
function dependencyElement({
  groupId,
  artifactId,
  version,
  type,
  classifier,
  scope,
  optional,
}: PomDependency): Record<string, unknown> {
  return {
    groupId,
    artifactId,
    ...(version === undefined ? {} : { version }),
    ...(type === undefined || type === "jar" ? {} : { type }),
    ...(classifier === undefined ? {} : { classifier }),
    ...(scope === undefined || scope === "compile" ? {} : { scope }),
    ...(optional ? { optional: "true" } : {}),
  };
}

/**
 * Check a package's `metadata` can be written into its POM: no element the
 * generator writes, none only a build reads, and names XML takes. `failure`
 * makes the error for a problem under one of its entries, by that entry's key.
 */
export function checkPomMetadata(
  name: string,
  metadata: MetadataMap,
  failure: (key: string, message: string) => Error = (_key, message) => new FabrError(message)
): void {
  const check = (entry: string, map: MetadataMap): void => {
    for (const [key, value] of map) {
      if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) {
        throw failure(entry, `${name}'s metadata key '${key}' is not a POM element name`);
      }
      if (isMapList(value)) {
        if (!LIST_ELEMENTS.has(key)) {
          throw failure(
            entry,
            `${name}'s metadata gives <${key}> several blocks, and only a list element (${[...LIST_ELEMENTS.keys()].join(", ")}) takes them`
          );
        }
        value.forEach(item => check(entry, item));
      } else if (!isStrings(value)) {
        check(entry, value);
      }
    }
  };
  for (const [key, value] of metadata) {
    if (GENERATED_ELEMENTS.has(key)) {
      throw failure(key, `${name}'s metadata cannot set <${key}>: fabr writes it into the POM`);
    }
    if (BUILD_ELEMENTS.has(key)) {
      throw failure(key, `${name}'s metadata cannot set <${key}>: a published POM does not carry it`);
    }
    check(key, new Map([[key, value]]));
  }
}

function isStrings(value: MetadataValue): value is readonly string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === "string");
}

function isMapList(value: MetadataValue): value is readonly MetadataMap[] {
  return Array.isArray(value) && !isStrings(value);
}

/** @return the content of the POM element one `metadata` entry under `key` writes. */
function metadataElement(key: string, value: MetadataValue): unknown {
  const child = LIST_ELEMENTS.get(key);
  if (child !== undefined) {
    return { [child]: isStrings(value) ? [...value] : (isMapList(value) ? value : [value as MetadataMap]).map(mapElement) };
  }
  return isStrings(value) ? value.join(" ") : mapElement(value as MetadataMap);
}

function mapElement(map: MetadataMap): Record<string, unknown> {
  return Object.fromEntries([...map].map(([key, value]) => [key, metadataElement(key, value)]));
}

/** Write `pom` as a `pom.xml`. */
export function pomText(pom: Pom): string {
  return xmlDocument({
    project: {
      "@_xmlns": "http://maven.apache.org/POM/4.0.0",
      "@_xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
      "@_xsi:schemaLocation": "http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd",
      modelVersion: "4.0.0",
      groupId: pom.groupId,
      artifactId: pom.artifactId,
      version: pom.version,
      ...(pom.packaging === "jar" ? {} : { packaging: pom.packaging }),
      ...mapElement(pom.metadata),
      ...(pom.dependencyManagement.length === 0
        ? {}
        : { dependencyManagement: { dependencies: { dependency: pom.dependencyManagement.map(dependencyElement) } } }),
      ...(pom.dependencies.length === 0 ? {} : { dependencies: { dependency: pom.dependencies.map(dependencyElement) } }),
    },
  });
}

/** Make the checksum files of `bytes` published at `path`, each named `<path>.<algorithm>`. */
export function checksumFiles(path: string, bytes: Buffer): Array<[string, IFile]> {
  return CHECKSUMS.map(([extension, algorithm]) => [
    `${path}.${extension}`,
    MemoryFile.from(crypto.createHash(algorithm).update(bytes).digest("hex")),
  ]);
}

/**
 * Split a member's files for upload around `marker`, the file that marks the
 * member published: `before`, every file but the marker and its checksums, and
 * `last`, the marker's checksums then the marker itself, each in code-unit
 * order. Whatever else a publish uploads (the package's `maven-metadata.xml`)
 * goes between the two, so the marker is present only once all of it is.
 */
export function uploadOrder(paths: Iterable<string>, marker: string): { before: string[]; last: string[] } {
  const all = [...paths].sort(compareText);
  const ofMarker = (path: string): boolean => path === marker || CHECKSUMS.some(([extension]) => path === `${marker}.${extension}`);
  return {
    before: all.filter(path => !ofMarker(path)),
    last: [...all.filter(path => ofMarker(path) && path !== marker), ...all.filter(path => path === marker)],
  };
}

/** @return `text` parsed as a Maven version, or undefined where it is none. */
function parsedVersion(text: string): MavenVersion | undefined {
  try {
    return MAVEN_VERSIONS.parseVersion(text);
  } catch {
    return undefined;
  }
}

/**
 * Bring a package's `maven-metadata.xml` up to date with `version`: the
 * versions `existing` lists with `version` among them, in Maven's order, the
 * highest of them its latest and release, updated at `now`. A listed entry
 * that is no Maven version is kept where it is, the versions sorted around it.
 */
export function mergedMetadata(existing: string | undefined, groupId: string, artifactId: string, version: string, now: Date): string {
  const listed =
    existing === undefined
      ? []
      : xmlChildren(xmlChild(xmlChild(parseXml(existing, "maven-metadata.xml"), "versioning"), "versions"), "version").map(
          each => each.text
        );
  const entries = [...new Set([...listed, version])].map(text => ({ text, parsed: parsedVersion(text) }));
  const sorted = entries.flatMap(({ parsed }) => (parsed === undefined ? [] : [parsed])).sort((a, b) => MAVEN_VERSIONS.compare(a, b));
  let next = 0;
  const versions = entries.map(({ text, parsed }) => (parsed === undefined ? text : sorted[next++].text));
  const highest = sorted[sorted.length - 1].text;
  const lastUpdated = now.toISOString().replace(/[-:T]/g, "").substring(0, 14);
  return xmlDocument({
    metadata: {
      groupId,
      artifactId,
      versioning: { latest: highest, release: highest, versions: { version: versions }, lastUpdated },
    },
  });
}

/**
 * Find the one coordinate the release publishes target `name` at, among
 * `targets`; undefined where it publishes the target nowhere, or at more than
 * one coordinate.
 */
function coordinateOfTarget(
  targets: ReadonlyMap<string, readonly RepositoryPublishRef[]>,
  name: string
): PackagePublishRef | undefined {
  const found = packageCoordinates(targets.get(name) ?? []).filter(
    each => isRepositoryReader(each.source) && each.source.format === MAVEN_FORMAT && variantOf(each) === undefined
  );
  const distinct = new Map(found.map(each => [`${each.name}:${each.version}`, each]));
  return distinct.size === 1 ? [...distinct.values()][0] : undefined;
}

/** Find the one artifact among a member's files: its jar, war or ear. */
function artifactOf(destination: RepositoryPublishRef, content: FileSet): { file: IFile; extension: string } {
  const artifacts = [...content].filter(
    ([name]) => !name.includes("/") && ARTIFACT_PACKAGING.has(name.substring(name.lastIndexOf(".") + 1))
  );
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
 * Make the POM entry for one of the member package's dependencies, `dep`:
 * - for a repository's reference, the version {@link declaredRequirement}
 *   records, as a `<dependency>`, or where the bound package has no files (a
 *   BOM), as a `bom` entry to import in `<dependencyManagement>`;
 * - for a target of the project, the coordinate the release publishes that
 *   target at.
 *
 * Nothing where nothing is declared for it. Throws where a reference records
 * no version, or the release publishes the target at no one coordinate.
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
    /* An expected provided requirement is `provided`-scoped, an optional one
     * `optional`. One passed on to a consumer's run collection alone is
     * `runtime`-scoped; one passed on to its compile alone is compile-scoped
     * (Maven's default), as Gradle writes `compileOnlyApi`, Maven having no
     * scope for it. */
    const scope =
      provided === "expected" ? { scope: "provided" } : pkg.usedFor.get(dependencyName(dep)) === "run" ? { scope: "runtime" } : {};
    const optional = provided === "optional";
    const { reference } = dep;
    if (reference instanceof RepositoryRef) {
      if (declared.versionConstraint === undefined) {
        throw new FabrError(`cannot publish ${destination.toString()}: no version to record for '${reference.toString()}'`);
      }
      const { groupId, artifactId } = splitMavenName(declared.name);
      const bound = dep.package;
      return bound instanceof PackageFileSet && bound.isEmpty()
        ? { bom: { groupId, artifactId, version: declared.versionConstraint, type: "pom", scope: "import", optional: false } }
        : {
            dependency: {
              groupId,
              artifactId,
              version: declared.versionConstraint,
              ...variantFields(declared.variant),
              ...scope,
              optional,
            },
          };
    }
    const assigned = coordinateOfTarget(targets, declared.name);
    if (assigned === undefined) {
      throw new FabrError(
        `cannot publish ${destination.toString()}: no version to record for '${declared.name}', which is built in this project`
      ).withHelp(`publish '${declared.name}' in the same sync`);
    }
    const { groupId, artifactId } = splitMavenName(assigned.name);
    return { dependency: { groupId, artifactId, version: assigned.version, ...scope, optional } };
  });
}

/**
 * Package one member for a Maven repository: its artifact and a POM generated
 * from what its package requires (see {@link pomDependencyOf}), with its
 * package's `metadata`, at their repository paths, each with its checksums.
 * Content that is no package (a war's files) has a POM with no dependencies.
 *
 * `targets` holds each target's publish coordinates in the release, by
 * target name; `coMembers` the names of the packages this destination
 * publishes in the same sync; `release` every coordinate the release
 * publishes. The result is uploaded after the members among `coMembers` it
 * depends on and after its version's variants in `release`. Throws where the
 * content holds no one artifact, or its `metadata` cannot be written into a
 * POM.
 */
export function packageMavenMember(
  member: PublishMember,
  targets: ReadonlyMap<string, readonly RepositoryPublishRef[]>,
  coMembers: ReadonlySet<string>,
  release: readonly RepositoryPublishRef[]
): Computable<PublishableFileSet> {
  const { content } = member;
  const destination = packageCoordinateOf(member.destination);
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
      const dependencyManagement = recorded.flatMap(each => (each.bom === undefined ? [] : [each.bom]));
      const metadata = content instanceof PackageFileSet ? content.metadata : new Map<string, MetadataValue>();
      checkPomMetadata(destination.toString(), metadata);
      const pom = Buffer.from(
        pomText({
          groupId,
          artifactId,
          version,
          packaging: ARTIFACT_PACKAGING.get(extension)!,
          metadata,
          dependencies,
          dependencyManagement,
        })
      );
      const artifactPath = repositoryPath(groupId, artifactId, version, `${artifactId}-${version}.${extension}`);
      const pomPath = repositoryPath(groupId, artifactId, version, `${artifactId}-${version}.pom`);
      const files: Array<[string, IFile]> = [
        [artifactPath, file],
        ...checksumFiles(artifactPath, bytes),
        [pomPath, new MemoryFile(pom)],
        ...checksumFiles(pomPath, pom),
      ];
      const dependsOn = [
        ...dependencies.map(dep => `${dep.groupId}/${dep.artifactId}`).filter(name => coMembers.has(name)),
        ...packageCoordinates(release)
          .filter(each => each.name === destination.name && each.version === version && variantOf(each) !== undefined)
          .map(each => variantToken(each)),
      ];
      return new PublishableFileSet(files, destination, destination.name, dependsOn);
    })
  );
}

/** @return the `<classifier>` and `<type>` a POM dependency on `variant` states. */
function variantFields(variant: string | undefined): { classifier?: string; type?: string } {
  if (variant === undefined) {
    return {};
  }
  const { classifier, extension } = mavenVariantOf(variant);
  return { ...(classifier === undefined ? {} : { classifier }), ...(extension === "jar" ? {} : { type: extension }) };
}

/**
 * A Maven publish coordinate: a version of a package, or, with a variant, a
 * file published beside the version's artifact (`-sources.jar`, `-bin.zip`).
 */
export class MavenPublishRef extends PackagePublishRef {
  /** The variant of a file published beside the artifact (`sources`, `bin@zip`), or undefined for the artifact itself. */
  public readonly variant?: string;

  constructor(
    source: RepositoryWriter,
    coordinate: { readonly name: string; readonly version: string; readonly variant?: string },
    repositoryName?: string
  ) {
    super(source, coordinate, repositoryName);
    this.variant = coordinate.variant;
  }

  public override withRepositoryName(repositoryName: string): MavenPublishRef {
    return new MavenPublishRef(this.source, this, repositoryName);
  }

  protected override coordinate(): string {
    return this.variant === undefined ? super.coordinate() : `${this.name}/${this.variant}:${this.version}`;
  }
}

/** @return the variant `destination` publishes a file as, or undefined for a version's artifact. */
export function variantOf(destination: RepositoryPublishRef): string | undefined {
  return destination instanceof MavenPublishRef ? destination.variant : undefined;
}

/** @return the name a variant's member is ordered by: its version's artifact is uploaded after it. */
function variantToken(destination: RepositoryPublishRef): string {
  return `${destination.name}:${variantOf(destination)}`;
}

/** @return the path of the file a variant's member `destination` publishes, or of a version's artifact with `extension`. */
export function publishedFilePath(destination: PackagePublishRef, extension = "jar"): string {
  const { groupId, artifactId } = splitMavenName(destination.name);
  const variant = variantOf(destination);
  const { classifier, extension: published } = variant === undefined ? { classifier: undefined, extension } : mavenVariantOf(variant);
  const { version } = destination;
  return repositoryPath(
    groupId,
    artifactId,
    version,
    `${artifactId}-${version}${classifier === undefined ? "" : `-${classifier}`}.${published}`
  );
}

/**
 * Package a variant's member for a Maven repository: its content as the file
 * published beside its version's artifact, with its checksums. Content that is
 * one file of the variant's extension is that file; any other is packed into a
 * jar or zip, and refused for another extension. Its version's artifact must
 * be published by the same release, which uploads it after this.
 */
export function packageClassifiedMember(
  member: PublishMember,
  release: readonly RepositoryPublishRef[]
): Computable<PublishableFileSet> {
  const { content } = member;
  const destination = packageCoordinateOf(member.destination);
  if (
    !packageCoordinates(release).some(
      each => each.name === destination.name && each.version === destination.version && variantOf(each) === undefined
    )
  ) {
    const { groupId, artifactId } = splitMavenName(destination.name);
    return Computable.reject(
      new FabrError(
        `cannot publish ${destination.toString()}: the release publishes no ${groupId}:${artifactId}:${destination.version} for it to be beside`
      ).withHelp(`publish ${groupId}:${artifactId}:${destination.version} in the same sync`)
    );
  }
  const { extension } = mavenVariantOf(variantOf(destination)!);
  const files = [...content];
  const single = files.length === 1 && !files[0][0].includes("/") && files[0][0].endsWith(`.${extension}`) ? files[0][1] : undefined;
  if (single === undefined && extension !== "jar" && extension !== "zip") {
    return Computable.reject(
      new FabrError(
        `cannot publish ${destination.toString()}: its content must be one .${extension} file, which fabr cannot pack it into`
      )
    );
  }
  const packed = single !== undefined ? Computable.resolve(single) : packToZip(content).then(zip => new MemoryFile(zip) as IFile);
  return packed.then(file =>
    file.getBuffer().then(bytes => {
      const path = publishedFilePath(destination);
      return new PublishableFileSet([[path, file], ...checksumFiles(path, bytes)], destination, variantToken(destination));
    })
  );
}
