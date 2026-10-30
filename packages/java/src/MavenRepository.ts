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
 * `.sha1`; a `pom`-packaged artifact has no files. Under `doc` and `sources`
 * a package is answered with the contents of its `-javadoc` or `-sources` jar.
 */

import {
  compareText,
  Computable,
  DOC_OPERATION,
  FabrError,
  fetchArchive,
  fetchDocument,
  fetchFile,
  FileSet,
  HttpRequest,
  HttpResponse,
  IFile,
  MemoryCache,
  MemoryFile,
  Name,
  NamespaceRef,
  PackageFileSet,
  PublishableFileSet,
  PublishAttachment,
  PublishMember,
  PublishStatus,
  Reference,
  Repository,
  RepositoryPublishRef,
  RepositoryReader,
  RepositoryRef,
  RepositoryRegistration,
  RepositoryWriter,
  Requirement,
  resolveBarePackage,
  sendRequest,
  SOURCES_OPERATION,
  TargetContext,
  vendPackageRef,
  versionChildren,
  VersionNotFoundError,
} from "@fabr-build/core";
import { MAVEN_FORMAT, mavenName, parseMavenPublishCoordinate, splitMavenName } from "./MavenProtocol";
import { javaPluginContext } from "./MavenAuth";
import {
  checksumFiles,
  classifierOf,
  MavenPublishRef,
  mergedMetadata,
  metadataPath,
  packageClassifiedMember,
  packageMavenMember,
  publishedFilePath,
  repositoryPath,
} from "./MavenPublish";
import { MavenConstraint, MavenVersion, MAVEN_VERSIONS } from "./MavenVersion";
import { coordinateText, EffectivePom, effectivePom, parsePom, passedOnDependencies, PomCoordinate, RawPom } from "./Pom";
import { parseXml, xmlChild, xmlChildren } from "./Xml";

const METADATA_FILE = "maven-metadata.xml";

/** The classifier of the jar a version publishes for each operation it answers with one. */
const CLASSIFIERS = new Map([
  [DOC_OPERATION, "javadoc"],
  [SOURCES_OPERATION, "sources"],
]);

/** The operation that answers with each classifier's jar. */
const OPERATIONS = new Map([...CLASSIFIERS].map(([operation, classifier]) => [classifier, operation]));

/** @return the classifiers `auto_attach`, `value`, lists, each one a jar an operation answers with. */
function autoAttachOf(repository: string, value: { toString(): string } | undefined): string[] {
  const classifiers = value === undefined ? [] : value.toString().split(/\s+/).filter(word => word !== "");
  const unknown = classifiers.find(classifier => !OPERATIONS.has(classifier));
  if (unknown !== undefined) {
    throw new FabrError(`${repository}'s auto_attach names '${unknown}', which is not ${[...OPERATIONS.keys()].join(" or ")}`);
  }
  return [...new Set(classifiers)];
}

/** The manifest of a classified jar, which belongs to the jar rather than to its contents. */
const CLASSIFIED_MANIFEST = "META-INF/MANIFEST.MF";

/**
 * @return the BOM dependencies of a `pom`-packaged package: each jar its
 * effective `dependencyManagement` gives a version, once per package. A
 * package of any other packaging manages only its own build, and has none.
 */
function bomDependencies(pom: EffectivePom): Requirement[] {
  if (pom.packaging !== "pom") {
    return [];
  }
  const managed = new Map<string, Requirement>();
  for (const dependency of pom.dependencyManagement) {
    const name = mavenName(dependency.groupId, dependency.artifactId);
    if (dependency.version === undefined || dependency.classifier !== undefined || (dependency.type ?? "jar") !== "jar" || managed.has(name)) {
      continue;
    }
    managed.set(name, { name, versionConstraint: dependency.version, bom: true });
  }
  return [...managed.values()];
}

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

export class MavenRepository implements Repository, RepositoryReader<MavenVersion, MavenConstraint>, RepositoryWriter {
  public readonly format = MAVEN_FORMAT;
  private readonly versions = new MemoryCache<string, MavenVersion[] | undefined>();
  private readonly poms = new MemoryCache<string, RawPom | undefined>();
  private readonly effectivePoms = new MemoryCache<string, EffectivePom>();

  constructor(
    private readonly context: TargetContext,
    private readonly url: string,
    /** The id of the `settings.xml` server whose credentials it uses. */
    private readonly serverId: string,
    /** The classifiers of the jars published beside each artifact a sync publishes here: `sources`, `javadoc`. */
    private readonly autoAttach: readonly string[] = []
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

  /**
   * Vend the publish coordinate `name` names: `<group>:<artifact>:<version>`,
   * the version exact, or `<group>:<artifact>:<classifier>:<version>`.
   */
  public getRepositoryPublishRef(name: Name): RepositoryPublishRef {
    return new MavenPublishRef(this, parseMavenPublishCoordinate(name));
  }

  /**
   * @return the jars published beside an artifact published at `destination`
   * (RepositoryWriter implementation): one for each of `auto_attach`'s
   * classifiers, built under the operation that answers with it.
   */
  public attachments(destination: RepositoryPublishRef): PublishAttachment[] {
    if (classifierOf(destination) !== undefined) {
      return [];
    }
    return this.autoAttach.map(classifier => ({
      destination: new MavenPublishRef(this, { name: destination.name, version: destination.version, classifier }, destination.repositoryName),
      operation: OPERATIONS.get(classifier)!,
    }));
  }

  /**
   * Package this destination's members (RepositoryWriter implementation): each
   * its artifact and a POM generated from what its package requires, with
   * checksums, at their paths in the repository. A dependency on a target of
   * the project records the coordinate the release publishes it at.
   */
  public package(
    members: PublishMember[],
    release: readonly RepositoryPublishRef[],
    targets: ReadonlyMap<string, readonly RepositoryPublishRef[]>
  ): Computable<PublishableFileSet[]> {
    const coMembers = new Set(members.filter(member => classifierOf(member.destination) === undefined).map(member => member.destination.name));
    return Computable.forAll(
      members.map(member =>
        classifierOf(member.destination) === undefined ? packageMavenMember(member, targets, coMembers, release) : packageClassifiedMember(member, release)
      ),
      (...carriers: PublishableFileSet[]) => carriers
    );
  }

  /**
   * Upload a packaged member (RepositoryWriter implementation), as `mvn deploy`
   * does: each file `PUT` at its path, the POM last but for the package's
   * `maven-metadata.xml`, which is read, merged and `PUT` after them. A member
   * whose POM is already there is already synced.
   */
  public publish(artifact: PublishableFileSet): Computable<PublishStatus> {
    const { name, version } = artifact.destination;
    const { groupId, artifactId } = splitMavenName(name);
    const classified = classifierOf(artifact.destination) !== undefined;
    /* What marks the member published: a version's POM, or a classified jar itself. */
    const marker = classified ? publishedFilePath(artifact.destination, "jar") : repositoryPath(groupId, artifactId, version, `${artifactId}-${version}.pom`);
    return this.request(marker, { method: "GET" }).then(existing => {
      if (existing.statusCode === 200) {
        return Computable.resolve<PublishStatus>("already-synced");
      }
      if (existing.statusCode !== 404) {
        throw this.failure("reading", marker, existing);
      }
      /* The marker goes up last, so a member is published only once all of it is there. */
      const files = [...artifact].sort(([a], [b]) => Number(a.startsWith(marker)) - Number(b.startsWith(marker)) || compareText(a, b));
      const uploads = files.reduce<Computable<void>>(
        (previous, [path, file]) => previous.then(() => file.getBuffer().then(bytes => this.put(path, bytes))),
        Computable.resolve(undefined)
      );
      return classified
        ? uploads.then((): PublishStatus => "published")
        : uploads.then(() => this.updateMetadata(groupId, artifactId, version)).then((): PublishStatus => "published");
    });
  }

  /** Bring a package's `maven-metadata.xml` up to date with a version just uploaded. */
  private updateMetadata(groupId: string, artifactId: string, version: string): Computable<void> {
    const path = metadataPath(groupId, artifactId);
    return this.request(path, { method: "GET" }).then(response => {
      if (response.statusCode !== 200 && response.statusCode !== 404) {
        throw this.failure("reading", path, response);
      }
      const existing = response.statusCode === 200 ? response.body.toString("utf8") : undefined;
      const merged = Buffer.from(mergedMetadata(existing, groupId, artifactId, version, new Date()));
      return [[path, MemoryFile.from(merged.toString("utf8"))] as [string, IFile], ...checksumFiles(path, merged)].reduce<Computable<void>>(
        (previous, [each, file]) => previous.then(() => file.getBuffer().then(bytes => this.put(each, bytes))),
        Computable.resolve(undefined)
      );
    });
  }

  /** `PUT` `bytes` at `path` in the repository. */
  private put(path: string, bytes: Buffer): Computable<void> {
    return this.request(path, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: bytes }).then(response => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw this.failure("uploading", path, response);
      }
    });
  }

  /** Make a request to `path` in the repository, with its credentials. */
  private request(path: string, request: HttpRequest): Computable<HttpResponse> {
    return this.headers().then(headers => sendRequest(`${this.url}/${path}`, { ...request, headers: { ...headers, ...request.headers } }));
  }

  /** Get the headers each request to this repository is sent with: its server's credentials from `settings.xml`. */
  private headers(): Computable<Record<string, string>> {
    return javaPluginContext(this.context.execution)
      .mavenAuth()
      .then(auth => auth.headersFor(this.serverId));
  }

  private failure(doing: string, path: string, response: HttpResponse): FabrError {
    const detail = response.body.toString("utf8").trim();
    return new FabrError(`${doing} ${this.url}/${path} failed (${response.statusCode})${detail === "" ? "" : `: ${detail}`}`);
  }

  /** Name the environment a resolution depends on: none, as no artifact is chosen by platform. */
  public environmentKey(): Computable<string> {
    return Computable.resolve("");
  }

  /**
   * Get the requirements of a package: what its effective POM passes on; and,
   * for a BOM (a `pom`-packaged package), the jars its `dependencyManagement`
   * manages, as its BOM dependencies.
   */
  public getRequirements(name: string, version: MavenVersion): Computable<Requirement[]> {
    return this.effectivePomOf(name, version.text).then(pom => [
      ...passedOnDependencies(pom).map(dependency => ({
        name: mavenName(dependency.groupId, dependency.artifactId),
        versionConstraint: dependency.version,
      })),
      ...bomDependencies(pom),
    ]);
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

  /**
   * Fetch a package's artifact, checked against its `.sha1`. A `pom`-packaged
   * package has one only where a jar is published beside its POM, as a
   * dependency on it fetches the jar whatever the POM's packaging says;
   * otherwise (a BOM, an aggregator) it has none.
   */
  public fetch(name: string, version: MavenVersion): Computable<PackageFileSet> {
    const coordinate = this.coordinateOf(name, version.text);
    return this.effectivePomOf(name, version.text).then(pom => {
      const file = `${coordinate.artifactId}-${coordinate.version}.${PACKAGING_EXTENSIONS.get(pom.packaging) ?? "jar"}`;
      const artifactUrl = `${this.versionUrl(coordinate)}/${file}`;
      const fetchArtifact = (sha1: () => Computable<string | undefined>): Computable<PackageFileSet> =>
        fetchFile(this.context, {
          key: `${this.identity} ${coordinateText(coordinate)}`,
          tag: "maven:artifact:1",
          report: { resource: "artifact", role: "content" },
          name: file,
          source: () =>
            Computable.forAll([sha1(), this.headers()], (expected, headers) => ({
              url: artifactUrl,
              expected: expected === undefined ? undefined : { algorithm: "sha1", encoding: "hex" as const, value: expected },
              headers,
            })),
        }).then(files => new PackageFileSet(files, name, version.text));
      if (pom.packaging !== "pom") {
        return fetchArtifact(() => this.sha1Of(artifactUrl));
      }
      return this.sha1Of(artifactUrl).then(sha1 =>
        sha1 === undefined ? new PackageFileSet([], name, version.text) : fetchArtifact(() => Computable.resolve(sha1))
      );
    });
  }

  /**
   * Fetch what a version publishes for `doc` or `sources` (RepositoryReader
   * implementation): the contents of its `-javadoc` or `-sources` jar, checked
   * against its `.sha1`, less the jar's own manifest.
   */
  public fetchFor(name: string, version: MavenVersion, operation: string): Computable<FileSet> {
    const classifier = CLASSIFIERS.get(operation);
    const coordinate = this.coordinateOf(name, version.text);
    if (classifier === undefined) {
      return Computable.reject(new FabrError(`${this.url} publishes nothing for '${operation}' beside ${coordinateText(coordinate)}`));
    }
    const url = `${this.versionUrl(coordinate)}/${coordinate.artifactId}-${coordinate.version}-${classifier}.jar`;
    return this.sha1Of(url).then(sha1 => {
      if (sha1 === undefined) {
        throw new FabrError(`${coordinateText(coordinate)} publishes no ${classifier} jar`).withHelp(
          `${this.url} has no ${coordinate.artifactId}-${coordinate.version}-${classifier}.jar beside it`
        );
      }
      return fetchArchive(this.context, {
        key: `${this.identity} ${coordinateText(coordinate)} ${classifier}`,
        tag: "maven:classified:1",
        report: { resource: `${classifier} jar`, role: "content" },
        source: () => this.headers().then(headers => ({ url, expected: { algorithm: "sha1", encoding: "hex" as const, value: sha1 }, headers })),
        keep: files => files.remap(entry => (entry === CLASSIFIED_MANIFEST ? undefined : entry)),
      });
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
        headers: () => this.headers(),
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
      headers: () => this.headers(),
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
        headers: () => this.headers(),
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
  return Computable.forAll(
    [context.getRequiredString("url"), context.getProperty("id"), context.getProperty("auto_attach")],
    (url, id, autoAttach) => new MavenRepository(context, url.replace(/\/+$/, ""), id?.toString() ?? context.name, autoAttachOf(context.name, autoAttach))
  );
}

export const mavenRepositoryRegistration: RepositoryRegistration = { type: "maven_repository", provider: createRepository };

/** The implementation JAVA.fabr's `repository` declaration names. */
export default createRepository;
