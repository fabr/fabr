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

import {
  Computable,
  constraintOf,
  Credential,
  FabrError,
  fetchArchive,
  fetchDocument,
  FileSet,
  IFile,
  isRepositoryReader,
  lowestSatisfying,
  MemoryCache,
  MemoryFile,
  Name,
  PartialRepositoryRef,
  NpmPlatform,
  packageCoordinateOf,
  packageCoordinates,
  PackageFileSet,
  PackagePublishRef,
  packToTarball,
  parseJson,
  parseVersion,
  PublishableFileSet,
  PublishMember,
  PublishStatus,
  readJsonFile,
  Reference,
  Repository,
  RepositoryPublishRef,
  RepositoryReader,
  RepositoryRef,
  RepositoryWriter,
  Requirement,
  resolveBarePackage,
  select,
  Selected,
  SEMVER,
  SemverConstraint,
  SemverVersion,
  stripArchiveRoot,
  TARGET,
  TargetContext,
  toJsonObject,
  tripleToNpm,
  vendPackageRef,
  versionChildren,
  VersionNotFoundError,
  versionToString,
  IVersionMetadata,
  RepositoryImplementation,
  provenanceStatement,
  INTOTO_PAYLOAD_TYPE,
  ISigstoreInstance,
  PUBLIC_SIGSTORE,
  SerializedBundle,
  SIGSTORE_AUDIENCE,
  signDsse,
} from "@fabr-build/core";
import {
  expectedTarballDigest,
  INPMPackageMetadata,
  matchesTargetPlatform,
  platformGateAdmits,
  NPM_FORMAT,
  NpmPublishIdentity,
  parseMetadataResponse,
  toPackumentVersions,
  PublishAccess,
  exchangeIdentity,
  packageVisibility,
  publishToRegistry,
  toPublishAccess,
  tarballBasename,
  unsupportedPlatformReason,
  versionMetadataOf,
} from "./NPMProtocol";
import { declaredDependencies, memberDependencies, rewriteManifest, unresolvableDependencies } from "./PackageJson";
import { installedPackageExtensions, PackageExtensions } from "./PackageExtensions";
import { NPMAuth } from "./NPMAuth";
import { jsPluginContext } from "./JSPluginContext";
import * as crypto from "node:crypto";

const METADATA_FILE = "metadata.json";
const PACKUMENT_FILE = "packument.json";

/** The `accept` header asking for the abbreviated packument npm and pnpm
 *  install from: every version's dependencies, gates and `dist`, without the
 *  READMEs and publish history of the full one. */
const ABBREVIATED_PACKUMENT = "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*";

/** Map each name `assignments` assign exactly one distinct version to that
 *  coordinate; a name assigned several is left out. */
function uniqueAssignments(assignments: readonly NpmPublishIdentity[]): Map<string, NpmPublishIdentity> {
  const byName = new Map<string, Set<string>>();
  for (const { name, version } of assignments) {
    byName.set(name, (byName.get(name) ?? new Set()).add(version));
  }
  return new Map(
    select([...byName], ([name, versions]) =>
      versions.size === 1 ? ([name, { name, version: [...versions][0] }] as const) : undefined
    )
  );
}

/** Map each target `targets` publish at exactly one distinct npm coordinate to
 *  that coordinate; any other target is left out. */
function uniqueTargets(targets: ReadonlyMap<string, readonly RepositoryPublishRef[]>): Map<string, NpmPublishIdentity> {
  return new Map(
    select([...targets], ([target, coordinates]) => {
      const npm = packageCoordinates(coordinates).filter(
        coordinate => isRepositoryReader(coordinate.source) && coordinate.source.format === NPM_FORMAT
      );
      const distinct = new Map(npm.map(({ name, version }) => [`${name}@${version}`, { name, version }]));
      return distinct.size === 1 ? ([target, [...distinct.values()][0]] as const) : undefined;
    })
  );
}

/**
 * Encode a package name as one registry path segment, as npm does on every
 * read: the `/` of a scoped name percent-encoded (`@types/node` →
 * `@types%2fnode`). npmjs accepts the raw slash too, but a registry or proxy
 * routing on path segments answers 404 for it.
 */
function packagePath(pkg: string): string {
  return pkg.replace(/\//g, "%2f");
}

/**
 * The repository an `npm_repository` declaration makes: an npm registry at
 * `url`. As a {@link RepositoryReader} it answers the resolver's reads
 * (packuments, version documents, requirements with the package extensions
 * applied and optional dependencies gated on the target platform) and fetches
 * tarballs; as a {@link RepositoryWriter} it packages and publishes members.
 * Its requests are signed with the credential it is made with, else with
 * `.npmrc`'s for each request's URL.
 */
export class NPMRepository implements Repository, RepositoryWriter, RepositoryReader<SemverVersion, SemverConstraint> {
  public readonly format = NPM_FORMAT;
  private readonly url: string;
  private readonly context: TargetContext;
  /** The access this repository's publishes request (see {@link PublishAccess}). */
  private readonly access: PublishAccess;
  /* Each version document read this run, by "pkg/version". */
  private readonly metadataCache = new MemoryCache<string, INPMPackageMetadata>();
  /** Each package's packument as read this run, and (`revalidatedPackuments`)
   *  as read again for a version it lacked. */
  private readonly packuments = new MemoryCache<string, ReadonlyMap<string, INPMPackageMetadata> | undefined>();
  private readonly revalidatedPackuments = new MemoryCache<string, ReadonlyMap<string, INPMPackageMetadata> | undefined>();
  /** The package extensions applied to every manifest this registry serves:
   * the shipped list unless the constructor is given one. */
  private readonly extensions: () => PackageExtensions;

  /** The credential the registry's requests are signed with: the one it is
   * made with, else `.npmrc`'s for each request's URL. */
  private readonly credential: Credential;

  /** Whether a publish carries a provenance statement where the registry accepts one. */
  private readonly provenance: boolean;

  /** The Sigstore instance provenance statements are signed with. */
  private readonly sigstore: ISigstoreInstance;

  constructor(
    url: string,
    context: TargetContext,
    access: PublishAccess = null,
    extensions?: PackageExtensions,
    credential?: Credential,
    provenance = true,
    sigstore: ISigstoreInstance = PUBLIC_SIGSTORE
  ) {
    this.url = url.replace(/\/+$/, "");
    this.context = context;
    this.access = access;
    this.extensions = extensions === undefined ? installedPackageExtensions : () => extensions;
    this.credential = credential ?? NPMAuth.credential(() => this.npmAuth());
    this.provenance = provenance;
    this.sigstore = sigstore;
  }

  /** The registry's identity, its URL, in the resolution memo key. */
  public get identity(): string {
    return this.url;
  }

  public get name(): string {
    return this.context.name;
  }

  public getRepositoryRef(name: Name): RepositoryRef | PartialRepositoryRef {
    return vendPackageRef(this, this.format, name);
  }

  /** List a package's published versions, from its packument read again.
   *  Rejects for the whole registry or a scope, which cannot be listed. */
  public children({ name: namespace }: PartialRepositoryRef): Computable<Map<string, Reference>> {
    if (namespace === "" || /^@[^/]*$/.test(namespace)) {
      return Computable.reject(
        new FabrError(
          `the registry at ${this.url} cannot list every package ${namespace === "" ? "it holds" : `in ${namespace}`}`
        ).withHelp(`name a package to list its versions, as in '${this.name}:${namespace === "" ? "" : `${namespace}/`}<package>'`)
      );
    }
    return versionChildren(this, this.format, namespace, this.publishedVersions(namespace, true));
  }

  public getRepositoryPublishRef(name: Name): RepositoryPublishRef {
    return new PackagePublishRef(this, this.format.parsePublishCoordinate(name));
  }

  /* Get the run's NPMAuth, loaded once per run and shared by every
   * NPMRepository through the js plugin context. */
  private npmAuth(): Computable<NPMAuth> {
    return jsPluginContext(this.context.execution).npmAuth();
  }

  /**
   * Package the members this registry publishes, without uploading anything.
   * Each member's built `package.json` is rewritten with the name and version
   * its coordinate assigns, and each dependency on a package the release
   * publishes is given that package's version. A dependency's version comes
   * from, in order of preference: this batch's members, then the whole
   * release's npm coordinates (at any npm registry), then a target of the
   * project the release publishes under another name (`targets`), written in
   * npm's alias form. A name is used only where it is assigned one distinct
   * version at that level.
   *
   * Rejects for a member with no `package.json`, or one with a dependency
   * still lacking a version after the rewrite (a package built here that the
   * release does not publish at one version). Each result holds the
   * `<name>-<version>.tgz` of the member's files under `package/`, the
   * rewritten manifest beside it, and the dependencies naming other packages of
   * the release, which order the uploads.
   */
  public package(
    members: PublishMember[],
    release: readonly RepositoryPublishRef[],
    targets: ReadonlyMap<string, readonly RepositoryPublishRef[]> = new Map()
  ): Computable<PublishableFileSet[]> {
    /* The release's coordinates at any repository whose format is
     * NPM_FORMAT, this one or another, each with the name and version it
     * assigns. */
    const npmRelease = packageCoordinates(release).filter(
      coordinate => isRepositoryReader(coordinate.source) && coordinate.source.format === NPM_FORMAT
    );
    /* Later entries win: the release's names over targets', and this batch's
     * over the release's. */
    const published = uniqueTargets(targets);
    const coMembers = new Map([
      ...published,
      ...uniqueAssignments(npmRelease),
      ...uniqueAssignments(members.map(member => packageCoordinateOf(member.destination))),
    ]);
    /* For upload order, every name a dependency may name a package of the
     * release by: the release's names, at whatever versions, and its targets'. */
    const memberNames = new Map([
      ...[...published].map(([target, { name }]): [string, string] => [target, name]),
      ...npmRelease.map(({ name }): [string, string] => [name, name]),
    ]);
    return Computable.forAll(
      members.map(member => this.packageMember(member, coMembers, memberNames)),
      (...carriers: PublishableFileSet[]) => carriers
    );
  }

  private packageMember(
    member: PublishMember,
    coMembers: ReadonlyMap<string, NpmPublishIdentity>,
    memberNames: ReadonlyMap<string, string>
  ): Computable<PublishableFileSet> {
    const identity = packageCoordinateOf(member.destination);
    const { content } = member;
    return content.get("package.json").then(manifestFile => {
      if (!manifestFile) {
        throw new FabrError(`cannot publish ${identity.name}: the built package has no package.json`);
      }
      return readJsonFile(manifestFile, toJsonObject).then(built => {
        const manifest = rewriteManifest(built, identity, coMembers);
        const dangling = unresolvableDependencies(manifest);
        if (dangling.length > 0) {
          throw new FabrError(
            `cannot publish ${identity.name}: no version to record for ${dangling
              .map(dep => `'${dep}'`)
              .join(", ")} — a dependency built here must be published by this sync (at a single version) for its ` +
              `dependants to be resolvable`
          );
        }
        const manifestJson = JSON.stringify(manifest, undefined, 2) + "\n";
        const rooted = new Map<string, IFile>();
        for (const [name, file] of content) {
          if (name !== "package.json") {
            rooted.set(`package/${name}`, file);
          }
        }
        rooted.set("package/package.json", MemoryFile.from(manifestJson));
        /* Write no hardlinks: the registry refuses an upload containing one
         * (415, "Hard link is not allowed"), and packing would otherwise link
         * any two files with the same content. */
        return packToTarball(new FileSet(rooted), { hardlinks: false }).then(tgz => {
          const files = new Map<string, IFile>([
            [tarballBasename(identity.name, identity.version), new MemoryFile(tgz)],
            ["package.json", MemoryFile.from(manifestJson)],
          ]);
          /* Provides the package name, which other members' dependencies name. */
          return new PublishableFileSet(files, member.destination, identity.name, memberDependencies(manifest, memberNames));
        });
      });
    });
  }

  /**
   * Upload an artifact {@link package} made, through {@link publishToRegistry}:
   * its tarball and manifest, with a provenance statement where
   * {@link provenanceOf} makes one. Answers `"already-synced"` where the
   * version is already published.
   *
   * The credential is the token the registry exchanges the run's CI identity
   * for (trusted publishing), where there is one and the registry grants it;
   * else this repository's credential. Where the exchange was refused and the
   * upload then fails, the error carries help naming the refusal.
   */
  public publish(artifact: PublishableFileSet): Computable<PublishStatus> {
    const { name, version } = packageCoordinateOf(artifact.destination);
    const tgzFile = artifact.get(tarballBasename(name, version));
    const manifestFile = artifact.get("package.json");
    const provider = this.context.execution.identityProvider;
    const trusted = provider ? exchangeIdentity(this.url, name, provider) : Computable.resolve(undefined);
    return Computable.forAll([tgzFile, manifestFile, this.npmAuth(), trusted], (tgz, manifest, auth, offered) => {
      if (!tgz || !manifest) {
        throw new FabrError(`internal error: publish artifact for ${name}@${version} is missing its tarball or manifest`);
      }
      const signedIn =
        offered && "token" in offered
          ? Computable.resolve(new Map([["authorization", `Bearer ${offered.token}`]]))
          : this.credential.authorize({ method: "PUT", url: this.url, headers: new Map() });
      return Computable.forAll([tgz.getBuffer(), manifest.readString(), signedIn], (data, manifestJson, headers) => {
        const authHeaders = Object.fromEntries(headers ?? []);
        const manifest = JSON.parse(manifestJson) as Record<string, unknown>;
        return this.provenanceOf(name, version, data, manifest, authHeaders).then(provenance => ({
          data,
          manifest,
          auth,
          authHeaders,
          provenance,
          refused: offered && "refused" in offered ? offered.refused : undefined,
        }));
      });
    }).then(({ data, manifest, auth, authHeaders, provenance, refused }) =>
      publishToRegistry(
        this.url,
        { name, version },
        data,
        manifest,
        authHeaders,
        this.access,
        auth.otpProvider(this.url, this.context.execution.interaction),
        provenance
      ).catch(err => {
        if (refused !== undefined && err instanceof FabrError) {
          err.withHelp(
            `trusted publishing was refused for ${name}: ${refused}; configure this job's workflow or pipeline as its ` +
              `trusted publisher on the registry (\`npm trust\`), or give a credential for ${this.url} in .npmrc`
          );
        }
        throw err;
      })
    );
  }
  /**
   * Sign a provenance statement for the tarball `data` of `name@version`, where
   * the registry accepts one for this publish: this repository asks for one,
   * the job states its build, its source repository is public, and the package
   * is public, or new and published public. Undefined where it does not apply;
   * any failure once it applies is an error.
   */
  private provenanceOf(
    name: string,
    version: string,
    data: Buffer,
    manifest: Record<string, unknown>,
    headers: Record<string, string>
  ): Computable<SerializedBundle | undefined> {
    const provider = this.context.execution.identityProvider;
    const build = provider?.build;
    if (!this.provenance || !provider || !build) {
      return Computable.resolve(undefined);
    }
    return build
      .isPublicSource()
      .then(isPublic => (isPublic ? packageVisibility(this.url, name, headers) : false))
      .then(visible => {
        if (visible === false || (visible === undefined && this.access !== "public")) {
          return undefined;
        }
        if (manifest.repository === undefined) {
          throw new FabrError(`cannot publish ${name}@${version} with provenance: its package.json names no repository`).withHelp(
            `add the repository to the target's metadata (\`metadata = { repository = ${build.sourceRepository}; }\`), ` +
              `or turn provenance off for ${this.name} (\`provenance = off;\`)`
          );
        }
        const subject = {
          name: NPM_FORMAT.purl!(name, version),
          digest: { sha512: crypto.createHash("sha512").update(data).digest("hex") },
        };
        const statement = Buffer.from(JSON.stringify(provenanceStatement(subject, build)));
        return provider.token(SIGSTORE_AUDIENCE).then(token => signDsse(statement, INTOTO_PAYLOAD_TYPE, token, this.sigstore));
      });
  }

  /**
   * Get the platform being built for in npm's `{os, cpu, libc}` values: the
   * TARGET property's triple, converted by `tripleToNpm`, which drops what npm
   * has no value for. Used only for the os/cpu/libc gates.
   */
  private targetPlatform(): Computable<NpmPlatform> {
    return this.context.getGlobalString(TARGET).then(triple => tripleToNpm(triple));
  }

  /**
   * Get what a resolution depends on besides its roots, for its memo key: the
   * target platform, which decides which optional dependencies are kept, and
   * the digest of the package extensions, which add requirements.
   */
  public environmentKey(): Computable<string> {
    const extensions = this.extensions().digest;
    return this.targetPlatform().then(target => `${target.os ?? "?"}-${target.cpu ?? "?"}-${target.libc ?? "?"} ext:${extensions}`);
  }

  /**
   * The operation of the configuration this instance was made in. A rule
   * reading a property under BUILD_OVERRIDE reaches the `build` instance even
   * where the rule was selected under `run`.
   */
  public get operation(): string {
    return this.context.operation;
  }

  /** Fetch the package's own files at the reference's lower bound, with no
   * closure (RepositoryReader implementation). */
  public fetchFiles(reference: RepositoryRef): Computable<FileSet> {
    return Computable.resolve(undefined).then(() => resolveBarePackage(this, reference));
  }

  /**
   * Read the requirements of `pkg@version`, from its metadata with this
   * registry's package extensions applied ({@link declaredDependencies}): its
   * `dependencies`, its `peerDependencies` as provided requirements
   * (`"optional"` where `peerDependenciesMeta` marks them so, else
   * `"expected"`), and those of its `optionalDependencies` whose own gates
   * admit the target platform ({@link keepIfTargetMatches}).
   */
  public getRequirements(pkg: string, version: SemverVersion): Computable<Requirement[]> {
    return this.getVersionEntry(pkg, versionToString(version)).then(meta => {
      /* Read with this registry's package extensions applied. */
      const { required, optional } = declaredDependencies(this.extensions().extend(pkg, version, meta));
      if (optional.length === 0) {
        return Computable.resolve(required);
      }
      /* Each optional dependency's gates are in its own metadata, read at the
       * constraint's lower bound: a package's platform is the same in every
       * version. */
      return this.targetPlatform().then(target =>
        Computable.forAll(
          optional.map(req => this.keepIfTargetMatches(req, target)),
          (...kept) => [...required, ...kept.filter((req): req is Requirement => req !== undefined)]
        )
      );
    });
  }

  /**
   * Check a finished resolution's selections against the target platform,
   * rejecting where one's os/cpu/libc gates refuse it (npm's EBADPLATFORM),
   * naming the package and what required it. Optional dependencies were
   * already filtered, so a refusal is of a non-optional dependency or a direct
   * requirement.
   */
  public validateSelections(selections: Selected<SemverVersion>[]): Computable<void> {
    return this.targetPlatform().then(target =>
      Computable.forAll(
        selections.map(sel =>
          this.gatedMetadata(sel.publishedName ?? sel.name, versionToString(sel.version), target).then(meta => ({ sel, meta }))
        ),
        (...entries) => {
          for (const { sel, meta } of entries) {
            const reason = unsupportedPlatformReason(meta, target);
            if (reason) {
              throw new FabrError(
                `${sel.name}@${versionToString(sel.version)} is not supported for the target platform (${reason}), ` +
                  `required by ${sel.reachedVia?.requiredBy ?? "a direct requirement"}`
              );
            }
          }
          return undefined;
        }
      )
    );
  }

  /**
   * Find the lowest published version of `pkg` satisfying `constraint`, for
   * the resolver to raise a lower bound that was never published to. A
   * prerelease is a candidate only where the constraint names one. Reads the
   * packument held for the run, and where nothing in it satisfies the
   * constraint, reads it again once. Answers undefined where nothing
   * satisfies, where `constraint` does not parse, or where the registry has no
   * such package (without reading again).
   */
  public lowestAvailable(pkg: string, constraint: string): Computable<SemverVersion | undefined> {
    let parsed: SemverConstraint;
    try {
      parsed = SEMVER.parseConstraint(constraint);
    } catch {
      return Computable.resolve(undefined);
    }
    const pick = (versions: SemverVersion[] | undefined): SemverVersion | undefined => versions && lowestSatisfying(versions, parsed);
    return this.publishedVersions(pkg, false).then(versions => {
      const found = pick(versions);
      if (found || versions === undefined) {
        return Computable.resolve<SemverVersion | undefined>(found);
      }
      return this.publishedVersions(pkg, true).then(pick);
    });
  }

  /** List the package's published versions, for suggesting a remedy: the
   *  packument held for the run, not read again. */
  public availableVersions(pkg: string): Computable<SemverVersion[] | undefined> {
    return this.publishedVersions(pkg, false);
  }

  /** List the package's published versions, from its packument, or undefined if
   * the registry has no such package. Unparseable version strings are skipped. */
  private publishedVersions(pkg: string, forceRevalidate: boolean): Computable<SemverVersion[] | undefined> {
    return this.packument(pkg, forceRevalidate).then(versions =>
      versions === undefined
        ? undefined
        : [...versions.keys()].flatMap(text => {
            try {
              return [parseVersion(text)];
            } catch {
              return [];
            }
          })
    );
  }

  /**
   * Read the package's abbreviated packument: each published version's
   * metadata, by version, or undefined where the registry answers 404. A
   * cached packument is served for every version it lists; `forceRevalidate`
   * reads it from the registry again, for a version it lacks. Each of the two
   * is read at most once per run.
   */
  private packument(pkg: string, forceRevalidate: boolean): Computable<ReadonlyMap<string, INPMPackageMetadata> | undefined> {
    const held = forceRevalidate ? this.revalidatedPackuments : this.packuments;
    return held.getOrCreate(pkg, () => {
      const url = `${this.url}/${packagePath(pkg)}`;
      const what = `package document for ${pkg} from ${this.url}`;
      return fetchDocument<ReadonlyMap<string, INPMPackageMetadata>>(this.context, {
        url,
        file: PACKUMENT_FILE,
        tag: "npm:packument:2",
        /* An index read: one per package a resolution walks. */
        report: { resource: "package document", role: "index" },
        convert: text => parseJson(text, what, toPackumentVersions),
        /* Cache only the fields fabr reads. */
        keep: versions => JSON.stringify({ versions: Object.fromEntries(versions) }),
        headers: () => Computable.resolve({ accept: ABBREVIATED_PACKUMENT }),
        credential: this.credential,
        options: forceRevalidate ? { forceRevalidate: true } : undefined,
      });
    });
  }

  /**
   * Read an optional dependency's os/cpu/libc gates at its constraint's lower
   * bound, and return it where they admit `target`, else undefined. As npm
   * does, it is left out silently where it cannot be judged: its constraint
   * does not parse or has no lower bound, or its metadata cannot be read or
   * its gates evaluated.
   */
  private keepIfTargetMatches(req: Requirement, target: NpmPlatform): Computable<Requirement | undefined> {
    let probeVersion: string;
    try {
      const constraint = constraintOf(SEMVER, req.versionConstraint);
      if (SEMVER.isFloorless(constraint)) {
        return Computable.resolve(undefined);
      }
      probeVersion = versionToString(SEMVER.minimumOf(constraint));
    } catch {
      return Computable.resolve(undefined);
    }
    /* Use catch, not a rejection handler on then(): a throw while judging the
     * gates must be caught too. */
    return this.gatedMetadata(req.name, probeVersion, target)
      .then(meta => (matchesTargetPlatform(meta, target) ? req : undefined))
      .catch(() => undefined);
  }

  /**
   * Get what the registry publishes about one exact version besides its files:
   * its licence and the tarball's digest, read from the version's own
   * document, since the abbreviated packument leaves out the licence.
   */
  public getVersionMetadata(pkg: string, version: SemverVersion): Computable<IVersionMetadata> {
    return this.versionDocument(pkg, versionToString(version)).then(versionMetadataOf);
  }

  /** Get an exact package version's metadata: its packument entry, or for a
   *  version that entry cannot fully answer, the version's own document. */
  private getVersionEntry(pkg: string, version: string): Computable<INPMPackageMetadata> {
    const entry = (versions: ReadonlyMap<string, INPMPackageMetadata> | undefined): INPMPackageMetadata | undefined =>
      versions?.get(version);
    return (
      this.packument(pkg, false)
        .then(versions => (entry(versions) !== undefined ? entry(versions) : this.packument(pkg, true).then(entry)))
        /* Where the packument cannot be read, read the version's own document. */
        .catch(() => undefined)
        .then(meta => meta ?? this.versionDocument(pkg, version))
    );
  }

  /**
   * Get an exact package version's metadata for judging it against `target`:
   * as {@link getVersionEntry} gives it, except that the abbreviated packument
   * leaves out `libc`. Where an entry has no `libc`, declares `os` or `cpu`,
   * both admit `target`, and `target` has a libc, the version's own document
   * is read instead, so its `libc` gate is judged too.
   */
  private gatedMetadata(pkg: string, version: string, target: NpmPlatform): Computable<INPMPackageMetadata> {
    return this.getVersionEntry(pkg, version).then(meta =>
      meta.libc === undefined &&
      target.libc !== undefined &&
      (meta.os !== undefined || meta.cpu !== undefined) &&
      platformGateAdmits(meta.os, target.os) &&
      platformGateAdmits(meta.cpu, target.cpu)
        ? this.versionDocument(pkg, version)
        : meta
    );
  }

  /**
   * Fetch the metadata document for an exact package version, kept in the
   * build cache and never refreshed. Rejects with a VersionNotFoundError where
   * the registry answers 404. The cache keeps it although npmjs serves it with
   * `max-age=300`: its one field that changes is `deprecated`. Read
   * `deprecated` through a revalidating fetch, not this one.
   */
  private versionDocument(pkg: string, version: string): Computable<INPMPackageMetadata> {
    const key = pkg + "/" + version;
    return this.metadataCache.getOrCreate(key, () => {
      const metadataUrl = `${this.url}/${packagePath(pkg)}/${version}`;
      return fetchDocument(this.context, {
        url: metadataUrl,
        file: METADATA_FILE,
        tag: "npm:metadata:1",
        /* An index read: one per package version the resolution reads. */
        report: { resource: "metadata", role: "index" },
        convert: text => parseMetadataResponse(text, key),
        keep: meta => JSON.stringify(meta),
        credential: this.credential,
      }).then(meta => {
        /* The registry's 404: typed, so the resolver can raise a lower bound
         * that was never published. */
        if (meta === undefined) {
          throw new VersionNotFoundError(pkg, version, `NPM package ${pkg}@${version} not found at ${this.url}`);
        }
        return meta;
      });
    });
  }

  public fetch(pkg: string, version: SemverVersion): Computable<PackageFileSet> {
    const exact = versionToString(version);
    /* Key by registry and version, not tarball URL: a package fetched before
     * is then had without reading its metadata, where the URL is. */
    return fetchArchive(this.context, {
      key: `${this.identity} ${pkg}@${exact}`,
      tag: "npm:package:1",
      report: { resource: "package", role: "content" },
      source: () =>
        this.getVersionEntry(pkg, exact).then(meta =>
          Computable.resolve({
            url: meta.dist.tarball,
            expected: expectedTarballDigest(meta.dist),
            credential: this.credential,
          })
        ),
      keep: stripArchiveRoot,
    }).then(files => new PackageFileSet(files, pkg, exact));
  }
}

/** Make the repository an `npm_repository` declaration declares, or a
 * namespace makes with `url` and `credential`: the declaration's own `url`
 * takes precedence, and `credential` replaces `.npmrc`'s. Rejects where there
 * is no URL, or `provenance` is neither `on` nor `off`. */
function createRepository(context: TargetContext, url?: string, credential?: Credential): Computable<Repository> {
  return Computable.forAll(
    [context.getProperty("url"), context.getString("access"), context.getString("provenance")],
    (declared, access, provenance) => {
      const at = declared?.toString() ?? url;
      if (at === undefined) {
        throw new FabrError("Missing required property url");
      }
      if (provenance !== undefined && provenance !== "on" && provenance !== "off") {
        throw new FabrError(`invalid provenance value ${JSON.stringify(provenance)} (expected "on" or "off")`);
      }
      return new NPMRepository(at, context, toPublishAccess(access), undefined, credential, provenance !== "off");
    }
  );
}

/** The implementation JS.fabr's `repository` declaration names. */
export default { provider: createRepository } satisfies RepositoryImplementation;
