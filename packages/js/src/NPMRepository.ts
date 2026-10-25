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
import {
  FabrError,
  IFetchContext,
  resolveBarePackage,
  Computable,
  FileSet,
  HttpStatusError,
  IFile,
  lowestSatisfying,
  MemoryFile,
  Name,
  NamespaceRef,
  isRepositoryReader,
  NpmPlatform,
  PackageFileSet,
  packToTarball,
  parseJson,
  parseVersion,
  readJsonFile,
  PublishableFileSet,
  PublishMember,
  PublishStatus,
  readStream,
  Reference,
  RepositoryReader,
  Repository,
  TargetContext,
  RepositoryPublishRef,
  RepositoryRef,
  RepositoryRegistration,
  RepositoryWriter,
  Requirement,
  Selected,
  select,
  SEMVER,
  SemverConstraint,
  SemverVersion,
  TARGET,
  toJsonObject,
  tripleToNpm,
  unpackStream,
  vendPackageRef,
  versionChildren,
  VersionNotFoundError,
  versionToString,
  constraintOf,
} from "@fabr-build/core";
import {
  INPMPackageMetadata,
  matchesTargetPlatform,
  platformGateAdmits,
  NPM_FORMAT,
  NpmPublishIdentity,
  parseMetadataResponse,
  toPackumentVersions,
  PublishAccess,
  publishToRegistry,
  toPublishAccess,
  stripArchiveRoot,
  tarballBasename,
  unsupportedPlatformReason,
  verifyTarballStream,
} from "./NPMProtocol";
import { declaredDependencies, memberDependencies, rewriteManifest, unresolvableDependencies } from "./PackageJson";
import { installedPackageExtensions, PackageExtensions } from "./PackageExtensions";
import { NPMAuth } from "./NPMAuth";
import { jsPluginContext } from "./JSPluginContext";

const METADATA_FILE = "metadata.json";
const PACKUMENT_FILE = "packument.json";

/** What a packument is asked for as: the abbreviated form npm and pnpm install
 *  from — every version's dependencies, gates and `dist`, without the
 *  READMEs and publish history of the full one. */
const ABBREVIATED_PACKUMENT = "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*";

/** Map name → version for the names `assignments` assign exactly one distinct
 *  version — the names a manifest dependency can be unambiguously rewritten to. */
function uniqueAssignments(assignments: readonly NpmPublishIdentity[]): Map<string, string> {
  const byName = new Map<string, Set<string>>();
  for (const { name, version } of assignments) {
    byName.set(name, (byName.get(name) ?? new Set()).add(version));
  }
  return new Map(select([...byName], ([name, versions]) => (versions.size === 1 ? ([name, [...versions][0]] as const) : undefined)));
}

/**
 * Encode a package name as ONE registry path segment: npm percent-encodes the
 * `/` of a scoped name (`@types/node` → `@types%2fnode`) on every read. npmjs
 * also accepts the raw slash, but a registry or proxy routing on path segments
 * reads that as a package `@types` with a sub-resource, and answers 404.
 */
function packagePath(pkg: string): string {
  return pkg.replace(/\//g, "%2f");
}

/**
 * The repository an `npm_repository` declaration builds: the
 * {@link RepositoryReader} for the npm ecosystem — metadata, packuments,
 * tarballs, the publish PUT, and npm's per-name policies (dependency-block
 * reading, os/cpu/libc gating, platform validation). Its reader face hands
 * each reference batch to the package resolver
 * (resolvePackages/packageClosure) with itself as the registry the
 * resolution reads from.
 */
export class NPMRepository
  implements Repository, RepositoryWriter, RepositoryReader<SemverVersion, SemverConstraint>
{
  public readonly format = NPM_FORMAT;
  private readonly url: string;
  private readonly context: TargetContext;
  /** The access level this repository's publishes request (see {@link PublishAccess}). */
  private readonly access: PublishAccess;
  /* In-process memo over the persistent metadata cache, keyed by "pkg/version" */
  private readonly metadataCache: Map<string, Computable<INPMPackageMetadata>>;
  /** Each package's packument as read this run, and as re-read when it lacked a
   *  version asked for. */
  private readonly packuments = new Map<string, Computable<ReadonlyMap<string, INPMPackageMetadata> | undefined>>();
  private readonly revalidatedPackuments = new Map<string, Computable<ReadonlyMap<string, INPMPackageMetadata> | undefined>>();
  /** The repairs applied to every manifest this registry serves; the shipped
   * list unless a caller supplies one. */
  private readonly extensions: () => PackageExtensions;

  constructor(url: string, context: TargetContext, access: PublishAccess = null, extensions?: PackageExtensions) {
    this.url = url.replace(/\/+$/, "");
    this.context = context;
    this.access = access;
    this.metadataCache = new Map();
    this.extensions = extensions === undefined ? installedPackageExtensions : () => extensions;
  }

  /** The registry's stable identity — its url — for the resolution memo key. */
  public get identity(): string {
    return this.url;
  }

  public get name(): string {
    return this.context.name;
  }

  public getRepositoryRef(name: Name): RepositoryRef | NamespaceRef {
    return vendPackageRef(this, this.format, name);
  }

  /** List a package's published versions, read afresh from its packument.
   *  Neither the registry's every package nor a scope's can be listed. */
  public children({ name: namespace }: NamespaceRef): Computable<Map<string, Reference>> {
    if (namespace === "" || /^@[^/]*$/.test(namespace)) {
      return Computable.reject(
        new FabrError(`the registry at ${this.url} cannot list every package ${namespace === "" ? "it holds" : `in ${namespace}`}`).withHelp(
          `name a package to list its versions, as in '${this.name}:${namespace === "" ? "" : `${namespace}/`}<package>'`
        )
      );
    }
    return versionChildren(this, this.format, namespace, this.publishedVersions(namespace, true));
  }

  public getRepositoryPublishRef(name: Name): RepositoryPublishRef {
    return new RepositoryPublishRef(this, this.format.parsePublishCoordinate(name));
  }

  /* Get the run's registry-auth authority (the combined project + user
   * `.npmrc`, plus the per-registry second-factor sessions), loaded once per
   * run and shared across every NPMRepository instance (held on the
   * ExecutionContext via the js plugin context, not per instance); the project
   * `.npmrc` is read through the source FS, so it re-settles if it changes in
   * watch mode. */
  private npmAuth(): Computable<NPMAuth> {
    return jsPluginContext(this.context.execution).npmAuth();
  }

  /**
   * Get the `Authorization` header for a request to `url`, from the combined
   * `.npmrc` — used for both reads (private packages / a private registry) and
   * the publish write. Auth is keyed per registry (longest-prefix match), so a
   * request to a host with no configured credential — a public registry, or a
   * tarball CDN whose url came from registry metadata — is anonymous, with no
   * risk of leaking a credential off-registry.
   */
  private authHeadersFor(url: string): Computable<Record<string, string>> {
    return this.npmAuth().then(auth => auth.getHeadersFor(url));
  }

  /**
   * Package this registry's members into the npm wire form (pure — the dry-run
   * artifacts), jointly. Each member's built `package.json` is the final
   * manifest: rewritten with its assigned name/version and, for any dependency
   * naming a release member, that member's assigned version. The rewrite map
   * prefers **this destination's own assignments** — a dependant published
   * alongside one line of a package that the release assigns different versions
   * at different registries declares *its* registry's line, since that is what
   * its consumers will resolve — falling back to the release-wide assignment for
   * names this batch doesn't cover (the maintained-in-sync twin published
   * elsewhere). At either scope a name only rewrites when assigned a single
   * distinct version; any install-relevant dependency still versionless after
   * rewriting (a built package this sync does not publish, or one it publishes
   * at conflicting versions with none at this destination) is unresolvable for
   * every consumer, so packaging fails. Each member's files are laid out under
   * `package/` and gzip-tarred; its carrier holds that `.tgz` plus the rewritten
   * manifest as a sidecar (sans `dist`, which `publish` injects) and the
   * co-member dependency names for deps-first upload ordering.
   */
  public package(members: PublishMember[], release: readonly RepositoryPublishRef[]): Computable<PublishableFileSet[]> {
    /* The npm-shaped slice of the release: coordinates addressed to ANY npm
     * destination (so a cross-registry npm twin participates in the rewrite),
     * each with the name and version it assigns. A destination is npm
     * iff its repository SPEAKS npm — format identity, which homogeneity
     * makes answer for every coordinate in the repository, whichever registry
     * a group routes it to. An address in some other ecosystem's namespace (a
     * file path, say) has no name/version and is ignored. */
    const npmRelease = release
      .filter(coordinate => isRepositoryReader(coordinate.source) && coordinate.source.format === NPM_FORMAT);
    /* Later entries win the merge: own-batch assignments over release-wide. (A
     * name can't be batch-unique but release-ambiguous *and missing* from the
     * batch map — own coordinates are a subset of the release's.) */
    const memberVersions = new Map([
      ...uniqueAssignments(npmRelease),
      ...uniqueAssignments(members.map(member => member.destination)),
    ]);
    const memberNames = new Set(npmRelease.map(identity => identity.name));
    return Computable.forAll(
      members.map(member => this.packageMember(member, memberVersions, memberNames)),
      (...carriers: PublishableFileSet[]) => carriers
    );
  }

  private packageMember(
    member: PublishMember,
    memberVersions: ReadonlyMap<string, string>,
    memberNames: ReadonlySet<string>
  ): Computable<PublishableFileSet> {
    const identity = member.destination;
    const { content } = member;
    return content.get("package.json").then(manifestFile => {
      if (!manifestFile) {
        throw new FabrError(`cannot publish ${identity.name}: the built package has no package.json`);
      }
      return readJsonFile(manifestFile, toJsonObject).then(built => {
        const manifest = rewriteManifest(built, identity, memberVersions);
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
        /* No hardlinks: the registry rejects an upload containing one (415,
         * "Hard link is not allowed"), and fabr's content-hash dedup would emit
         * one for any two identical files in the package. The wire format's
         * constraints are this destination's to know. */
        return packToTarball(new FileSet(rooted), { hardlinks: false }).then(tgz => {
          const files = new Map<string, IFile>([
            [tarballBasename(identity.name, identity.version), new MemoryFile(tgz)],
            ["package.json", MemoryFile.from(manifestJson)],
          ]);
          /* provides = the package name (what a co-member's dependsOn references). */
          return new PublishableFileSet(files, member.destination, identity.name, memberDependencies(manifest, memberNames));
        });
      });
    });
  }

  /**
   * Upload a packaged artifact to this registry (the one side effect): reads
   * the sidecar manifest, hashes the tarball for `dist.integrity`/`shasum`,
   * builds the `libnpmpublish` packument envelope, and PUTs it to the escaped
   * package name; a 409, or npmjs's 403 "cannot publish over" (version already
   * present), is the already-synced status. Pure upload mechanics — release
   * orchestration (ordering, skipping) is the generic layer's. The credential
   * is resolved here — the repository owns its own authentication — from the
   * per-registry `.npmrc` (with `${VAR}` substitution).
   */
  public publish(artifact: PublishableFileSet): Computable<PublishStatus> {
    const { name, version } = artifact.destination;
    const tgzFile = artifact.get(tarballBasename(name, version));
    const manifestFile = artifact.get("package.json");
    return Computable.forAll([tgzFile, manifestFile, this.npmAuth()], (tgz, manifest, auth) => {
      if (!tgz || !manifest) {
        throw new FabrError(`internal error: publish artifact for ${name}@${version} is missing its tarball or manifest`);
      }
      return Computable.forAll([tgz.getBuffer(), manifest.readString()], (data, manifestJson) => ({ data, manifestJson, auth }));
    }).then(({ data, manifestJson, auth }) =>
      publishToRegistry(
        this.url,
        { name, version },
        data,
        JSON.parse(manifestJson),
        auth.getHeadersFor(this.url),
        this.access,
        auth.otpProvider(this.url, this.context.execution.interaction)
      )
    );
  }

  /**
   * Get the platform we are building for, projected to npm's {os, cpu, libc}
   * vocabulary — read off the TARGET property (a clang/LLVM triple;
   * `default TARGET = ${HOST}`) via the same property surface every rule sees,
   * then run through core's lossy `tripleToNpm`. Native selection consumes the
   * triple verbatim; this projection is only what the npm os/cpu/libc gate
   * matches on.
   */
  private targetPlatform(): Computable<NpmPlatform> {
    return this.context.getGlobalString(TARGET).then(triple => tripleToNpm(triple));
  }

  /**
   * Name what an npm resolution is computed *for* beyond its roots: the target
   * platform, which gates which optional deps exist, and the package
   * extensions, which add requirements — inputs to the graph, not only to
   * delivery, so the domain folds them into the resolution memo key.
   */
  public environmentKey(): Computable<string> {
    const extensions = this.extensions().digest;
    return this.targetPlatform().then(target => `${target.os ?? "?"}-${target.cpu ?? "?"}-${target.libc ?? "?"} ext:${extensions}`);
  }

  /**
   * RepositoryReader implementation: the operation of the configuration this
   * instance was made in. Instances are interned per BuildContext, so a rule
   * reading a FILES property under BUILD_OVERRIDE reaches a build-configured
   * instance even when the rule itself was selected under `run`.
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
   * Read the requirements of pkg@version (RepositoryReader implementation): its
   * declared `dependencies` and `peerDependencies` (the shared manifest
   * reading, {@link declaredDependencies}), plus the `optionalDependencies`
   * that are installable on the target. The dominant use of the latter is
   * os/cpu-gated native binaries (esbuild's @esbuild/<platform> engine): all
   * variants are listed, and only the target-matching one(s) are kept. Peers
   * are **provided** requirements (the `provided_deps` relationship — the
   * consumer's tree supplies them): an "expected" one demands its minimum
   * only when the converged tree selects nothing for the package, an
   * "optional" one never. A peer the build's selection is outside the range
   * of binds that selection anyway (the format shares provided requirements):
   * recorded as data, never repaired by a private copy.
   */
  public getRequirements(pkg: string, version: SemverVersion): Computable<Requirement[]> {
    return this.getVersionMetadata(pkg, versionToString(version)).then(meta => {
      /* Read with this registry's package extensions applied. */
      const { required, optional } = declaredDependencies(this.extensions().extend(pkg, version, meta));
      if (optional.length === 0) {
        return Computable.resolve(required);
      }
      /* The os/cpu gate is declared in the *dependency's* own metadata, so each
       * candidate must be probed. The match is version-stable (a package's target
       * platform doesn't change across releases), so probing the constraint's
       * minimum decides correctly whatever version selection ultimately picks. */
      return this.targetPlatform().then(target =>
        Computable.forAll(
          optional.map(req => this.keepIfTargetMatches(req, target)),
          (...kept) => [...required, ...kept.filter((req): req is Requirement => req !== undefined)]
        )
      );
    });
  }

  /**
   * Validate a finished resolution's selections against the target platform.
   * Optional deps were already filtered to the target, so any
   * os/cpu/libc mismatch remaining is a *non-optional* dependency (or a direct
   * requirement) on a package for another platform — npm's EBADPLATFORM — and
   * is an error rather than an unusable install. Each selection's metadata was
   * fetched during the resolution walk, so these are cache hits. (Override
   * TARGET with -D to resolve for a different platform.)
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
   * Find, as the floor-raise hook (see RepositoryReader), the lowest
   * *published* version of `pkg` satisfying `constraint`, consulted only when
   * the constraint's own minimum turned out unpublished. Reads the
   * **packument** — the registry's per-package version list, held for the run
   * (see {@link packument}); if the held list satisfies nothing, that is
   * evidence it may be stale, so it is re-read once before giving up.
   * Deterministic modulo registry append.
   *
   * A package the registry has never heard of (a typo'd name) has no published
   * versions at all, which is a definite answer rather than a stale one: it
   * skips the revalidation and reports no raise, leaving the caller's original
   * "not found" the failure the resolver reports.
   */
  public lowestAvailable(pkg: string, constraint: string): Computable<SemverVersion | undefined> {
    let parsed: SemverConstraint;
    try {
      parsed = SEMVER.parseConstraint(constraint);
    } catch {
      return Computable.resolve(undefined);
    }
    /* npm-consistent candidates: no prerelease unless the constraint opts in
     * (lowestSatisfying) — the raise must never silently pin an -rc. */
    const pick = (versions: SemverVersion[] | undefined): SemverVersion | undefined =>
      versions && lowestSatisfying(versions, parsed);
    return this.publishedVersions(pkg, false).then(versions => {
      const found = pick(versions);
      if (found || versions === undefined) {
        return Computable.resolve<SemverVersion | undefined>(found);
      }
      return this.publishedVersions(pkg, true).then(pick);
    });
  }

  /** List the registry's versions for repair suggestions (see
   *  RepositoryReader): the packument read, without the staleness retry
   *  (suggestions are advisory). */
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
   * Read the package's abbreviated packument — each published version's
   * metadata, by version — or undefined if the registry has no such package
   * (its 404). A version's entry never changes once published, so a held
   * packument is kept for every version it lists; `forceRevalidate` re-reads
   * it, for a caller asking about a version it lacks. Read once per run either
   * way.
   */
  private packument(pkg: string, forceRevalidate: boolean): Computable<ReadonlyMap<string, INPMPackageMetadata> | undefined> {
    const held = forceRevalidate ? this.revalidatedPackuments : this.packuments;
    let result = held.get(pkg);
    if (result === undefined) {
      const url = `${this.url}/${packagePath(pkg)}`;
      const what = `package document for ${pkg} from ${this.url}`;
      result = this.context
        .fetch(
          url,
          "npm:packument:2",
          () =>
            this.authHeadersFor(url).then(headers => ({
              url,
              headers: { ...headers, accept: ABBREVIATED_PACKUMENT },
              process: (content: Readable) =>
                readStream(content).then(data => {
                  /* The reader throws on anything unusable, so an invalid document
                   * is never cached; what is kept is only what fabr reads. */
                  const versions = parseJson(data, what, toPackumentVersions);
                  return new FileSet(new Map([[PACKUMENT_FILE, MemoryFile.from(JSON.stringify({ versions: Object.fromEntries(versions) }))]]));
                }),
            })),
          /* An index read: a resolution makes one of these per package it
           * walks, and the resolve that asked is the item worth recording. */
          { resource: "package document", role: "index" },
          forceRevalidate ? { forceRevalidate: true } : undefined
        )
        .then(files => files.readFile(PACKUMENT_FILE))
        .then(
          data => parseJson(data, what, toPackumentVersions) as ReadonlyMap<string, INPMPackageMetadata> | undefined,
          err => {
            if (err instanceof HttpStatusError && err.statusCode === 404) {
              return undefined;
            }
            throw err;
          }
        );
      held.set(pkg, result);
      /* A transient failure is read again when next asked, not kept for the run. */
      result.catch(() => held.delete(pkg));
    }
    return result;
  }

  /**
   * Probe an optional dependency's os/cpu/libc gates, returning it as a requirement
   * only if the target satisfies them (else undefined). A candidate that can't be
   * probed — unparseable pin, no version to probe, or an unreachable/unpublished
   * metadata document — is dropped non-fatally, per npm's optional-dependency
   * contract (a genuinely-needed absence surfaces at the consumer's own runtime
   * check, e.g. esbuild's "missing platform binary" error). A future refinement:
   * a matched-but-unfetchable probe deserves a diagnostic once the progress layer
   * carries warnings; a plain platform mismatch stays silent.
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
    /* Catch rather than a rejection handler: a probe that cannot be evaluated
     * (malformed gates in a fetched document) is as non-fatal as one that could
     * not be fetched, and a handler passed to then() does not see the success
     * callback's own throw. */
    return this.gatedMetadata(req.name, probeVersion, target)
      .then(meta => (matchesTargetPlatform(meta, target) ? req : undefined))
      .catch(() => undefined);
  }

  /** Get an exact package version's metadata: its packument entry, or for a
   *  version that entry cannot fully answer, the version's own document. */
  private getVersionMetadata(pkg: string, version: string): Computable<INPMPackageMetadata> {
    const entry = (versions: ReadonlyMap<string, INPMPackageMetadata> | undefined): INPMPackageMetadata | undefined => versions?.get(version);
    return this.packument(pkg, false)
      .then(versions => (entry(versions) !== undefined ? entry(versions) : this.packument(pkg, true).then(entry)))
      /* The packument only saves requests: where it cannot be read at all, the
       * version's own document answers as it would have anyway. */
      .catch(() => undefined)
      .then(meta => meta ?? this.versionDocument(pkg, version));
  }

  /**
   * Get an exact package version's metadata for judging it against `target`:
   * as {@link getVersionMetadata} gives it, except that an abbreviated
   * packument leaves out `libc`. A platform-gated version (one declaring `os` or
   * `cpu`) whose gates admit a target that has a libc is read whole from its
   * own document, so its `libc` gate is judged too; any other cannot be decided
   * by `libc`.
   */
  private gatedMetadata(pkg: string, version: string, target: NpmPlatform): Computable<INPMPackageMetadata> {
    return this.getVersionMetadata(pkg, version).then(meta =>
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
   * Fetch the metadata document for an exact package version, persisted in the
   * build cache and never refreshed, for a version its packument cannot fully
   * answer for (see {@link getVersionMetadata}). Note the immutability here is a *content*
   * contract fabr asserts, not an HTTP one: npmjs serves version docs with only
   * `max-age=300` (unlike tarballs, which it marks `cache-control: immutable`
   * for a year), because a version doc has exactly one mutable field —
   * `deprecated`. The dependency-relevant fields can never change (a version
   * number is never republished), and fabr reads nothing else; if deprecation
   * warnings are ever surfaced, that read must go through a revalidating
   * fetch, not this cache-forever one.
   */
  private versionDocument(pkg: string, version: string): Computable<INPMPackageMetadata> {
    const key = pkg + "/" + version;
    let result = this.metadataCache.get(key);
    if (!result) {
      const metadataUrl = `${this.url}/${packagePath(pkg)}/${version}`;
      result = this.context
        .fetch(
          metadataUrl,
          "npm:metadata:1",
          () =>
            this.authHeadersFor(metadataUrl).then(headers => ({
              url: metadataUrl,
              headers,
              process: (content: Readable) =>
                readStream(content).then(data => {
                  const meta = parseMetadataResponse(data, key);
                  return new FileSet(new Map([[METADATA_FILE, MemoryFile.from(JSON.stringify(meta))]]));
                }),
            })),
          /* As the version list: one per package version considered. */
          { resource: "metadata", role: "index" }
        )
        .then(files => files.readFile(METADATA_FILE))
        /* Re-validated on the way out, not asserted: the cache entry is the
         * document as fetched, so it is judged by the same reader whether it
         * arrives from the registry or from disk — one place decides what a
         * usable metadata document is. */
        .then(data => parseMetadataResponse(data, key))
        .catch(err => {
          /* Translate the registry's HTTP 404 into the fact it means — typed,
           * so the resolver can distinguish an unpublished version (raisable)
           * from an unreachable registry. */
          if (err instanceof HttpStatusError && err.statusCode === 404) {
            throw new VersionNotFoundError(pkg, version, `NPM package ${pkg}@${version} not found at ${this.url}`);
          }
          throw err;
        });
      this.metadataCache.set(key, result);
      /* Evict the memo on failure so a transient transport error (dropped
       * connection, timeout) is retried, not cached for the whole run. This is a
       * deliberate side-effect observer: `.catch` returns a *new*, discarded
       * computable — the returned `result` is unchanged and still rejects for
       * callers; only the map entry is dropped. It is attached *after* set() on
       * purpose — a synchronous rejection would otherwise run before set() and
       * evict nothing, leaving set() to cache the failure. */
      result.catch(() => this.metadataCache.delete(key));
    }
    return result;
  }

  public fetch(pkg: string, version: SemverVersion): Computable<PackageFileSet> {
    const exact = versionToString(version);
    /* Kept by registry and version, not by tarball url: a published version
     * never changes, so a package fetched before is had without reading its
     * metadata, which is only where the url is. */
    return this.context
      .fetch(
        `${this.identity} ${pkg}@${exact}`,
        "npm:package:1",
        () =>
          this.getVersionMetadata(pkg, exact).then(meta =>
            this.authHeadersFor(meta.dist.tarball).then(headers => ({
              url: meta.dist.tarball,
              headers,
              process: (content: Readable, { createOutput }: IFetchContext) => {
                /* Verify the tarball against the registry's promised digest as it
                 * streams: a mismatch throws before the entry commits, so tampered
                 * or truncated-but-valid content never enters the immutable cache. */
                const { hashing, verify } = verifyTarballStream(meta.dist, meta.dist.tarball);
                content.on("error", err => hashing.destroy(err instanceof Error ? err : new FabrError(String(err))));
                content.pipe(hashing);
                return unpackStream(hashing, createOutput).then(files => {
                  verify();
                  return stripArchiveRoot(files);
                });
              },
            }))
          ),
        { resource: "package", role: "content" }
      )
      .then(files => new PackageFileSet(files, pkg, exact));
  }
}

function createRepository(context: TargetContext): Computable<Repository> {
  return Computable.forAll(
    [context.getRequiredString("url"), context.getString("access")],
    (url, access) => new NPMRepository(url, context, toPublishAccess(access))
  );
}

export const npmRepositoryRegistration: RepositoryRegistration = { type: "npm_repository", provider: createRepository };
