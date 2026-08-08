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
  FileSet,
  HttpStatusError,
  IFile,
  isJsonObject,
  lowestSatisfying,
  MemoryFile,
  Name,
  isPackageRegistry,
  MaterializeOptions,
  materializePackages,
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
  RegistryAdapter,
  Repository,
  RepositoryContext,
  RepositoryPublishRef,
  RepositoryReader,
  RepositoryRef,
  RepositoryRegistration,
  RepositoryWriter,
  Requirement,
  Resolution,
  resolvePackages,
  RunnableFileSet,
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
  declaredRequirementOf,
  VersionNotFoundError,
  versionToString,
} from "@fabr-build/core";
import { makeNpmRunnable } from "./JSPackage";
import {
  INPMPackageMetadata,
  matchesTargetPlatform,
  NPM_LANGUAGE,
  NpmPublishIdentity,
  parseMetadataResponse,
  PublishAccess,
  publishToRegistry,
  toPublishAccess,
  splitNameVersion,
  stripArchiveRoot,
  tarballBasename,
  unsupportedPlatformReason,
  verifyTarballStream,
} from "./NPMProtocol";
import { dependencyBlock, dependencyRequirement, memberDependencies, optionalPeers, rewriteManifest, unresolvableDependencies } from "./PackageJson";
import { NPMAuth } from "./NPMAuth";
import { jsPluginContext } from "./JSPluginContext";

const METADATA_FILE = "metadata.json";
const VERSIONS_FILE = "versions.json";

/** name → version for the names `assignments` assign exactly one distinct
 *  version — the names a manifest dependency can be unambiguously rewritten to. */
function uniqueAssignments(assignments: readonly NpmPublishIdentity[]): Map<string, string> {
  const byName = new Map<string, Set<string>>();
  for (const { name, version } of assignments) {
    byName.set(name, (byName.get(name) ?? new Set()).add(version));
  }
  return new Map(select([...byName], ([name, versions]) => (versions.size === 1 ? ([name, [...versions][0]] as const) : undefined)));
}

/** The version names a packument lists — the only thing fabr reads one for.
 *  A document with no `versions` map is not a packument (an error body, or the
 *  wrong URL), and says nothing about what is published. */
function toPublishedVersions(json: unknown): string[] {
  if (!isJsonObject(json) || !isJsonObject(json.versions)) {
    throw new Error("no versions");
  }
  return Object.keys(json.versions);
}

/**
 * A package name as ONE registry path segment: npm percent-encodes the `/` of a
 * scoped name (`@types/node` → `@types%2fnode`) on every read. npmjs also
 * accepts the raw slash, but a registry or proxy routing on path segments reads
 * that as a package `@types` with a sub-resource, and answers 404.
 */
function packagePath(pkg: string): string {
  return pkg.replace(/\//g, "%2f");
}

/**
 * The repository an `npm_repository` declaration builds: the
 * {@link RegistryAdapter} for the npm ecosystem — metadata, packuments,
 * tarballs, the publish PUT, and npm's per-name policies (dependency-block
 * reading, os/cpu/libc gating, platform validation). Its reader face hands
 * each reference batch to the package resolver
 * (resolvePackages/materializePackages) with itself as the registry the
 * resolution reads from.
 */
export class NPMRepository implements Repository, RepositoryReader, RepositoryWriter, RegistryAdapter<SemverVersion, SemverConstraint> {
  public readonly language = NPM_LANGUAGE;
  private readonly url: string;
  private readonly context: RepositoryContext;
  /** The access level this repository's publishes request (see {@link PublishAccess}). */
  private readonly access: PublishAccess;
  /* In-process memo over the persistent metadata cache, keyed by "pkg/version" */
  private readonly metadataCache: Map<string, Computable<INPMPackageMetadata>>;

  constructor(url: string, context: RepositoryContext, access: PublishAccess = null) {
    this.url = url.replace(/\/+$/, "");
    this.context = context;
    this.access = access;
    this.metadataCache = new Map();
  }

  /** The registry's stable identity — its url — for the resolution memo key. */
  public get identity(): string {
    return this.url;
  }

  public getRepositoryRef(name: Name): RepositoryRef {
    return vendPackageRef(this, this.language, name);
  }

  public getRepositoryPublishRef(name: Name): RepositoryPublishRef {
    this.validateCoordinate(name); /* validate the address shape up front */
    return new RepositoryPublishRef(this, name);
  }

  public resolve(references: RepositoryRef[]): Computable<Resolution> {
    return resolvePackages(this.context, this, references);
  }

  public materialize(references: RepositoryRef[], resolution: Resolution, options?: MaterializeOptions): Computable<FileSet[]> {
    return materializePackages(this.context, this, references, resolution, options);
  }

  public declaredRequirement(ref: RepositoryRef): Computable<Requirement | undefined> {
    return declaredRequirementOf(this.language, ref);
  }

  /* The run's registry-auth authority (the combined project + user `.npmrc`,
   * plus the per-registry second-factor sessions), loaded once per run and
   * shared across every NPMRepository instance (held on the ExecutionContext
   * via the js plugin context, not per instance); the project `.npmrc` is read
   * through the source FS, so it re-settles if it changes in watch mode. */
  private npmAuth(): Computable<NPMAuth> {
    return jsPluginContext(this.context.execution).npmAuth();
  }

  /**
   * The `Authorization` header for a request to `url`, from the combined `.npmrc`
   * — used for both reads (private packages / a private registry) and the publish
   * write. Auth is keyed per registry (longest-prefix match), so a request to a
   * host with no configured credential — a public registry, or a tarball CDN whose
   * url came from registry metadata — is anonymous, with no risk of leaking a
   * credential off-registry.
   */
  private authHeadersFor(url: string): Computable<Record<string, string>> {
    return this.npmAuth().then(auth => auth.getHeadersFor(url));
  }

  /** Validate a publish coordinate's shape at vend time (see RegistryAdapter). */
  public validateCoordinate(name: Name): void {
    this.coordinateIdentity(name);
  }

  /** The name + exact version a publish coordinate assigns, re-parsed from the
   *  written name (an address is carried as its Name; each consumer parses
   *  afresh, as the read side does with reference names). */
  private coordinateIdentity(ref: Name): NpmPublishIdentity {
    const split = splitNameVersion(ref);
    if (!split) {
      const literal = ref.toString();
      throw new Error(`publish coordinate '${literal}' must name a version (e.g. ${literal}:1.0.0)`);
    }
    const { identifier: name, version } = split;
    /* A coordinate pins an exact version (unlike a read requirement's range). */
    try {
      parseVersion(version);
    } catch {
      throw new Error(`publish coordinate '${name}' must pin an exact version, got '${version}'`);
    }
    return { name, version };
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
     * their identities re-parsed from the written name. A destination is npm
     * iff its repository SPEAKS npm — language identity, which homogeneity
     * makes answer for every coordinate in the repository, whichever registry
     * a group routes it to. An address in some other ecosystem's namespace (a
     * file path, say) has no name/version and is ignored. */
    const npmRelease = release
      .filter(coordinate => isPackageRegistry(coordinate.source) && coordinate.source.language === NPM_LANGUAGE)
      .map(coordinate => this.coordinateIdentity(coordinate.name));
    /* Later entries win the merge: own-batch assignments over release-wide. (A
     * name can't be batch-unique but release-ambiguous *and missing* from the
     * batch map — own coordinates are a subset of the release's.) */
    const memberVersions = new Map([
      ...uniqueAssignments(npmRelease),
      ...uniqueAssignments(members.map(member => this.coordinateIdentity(member.destination.name))),
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
    const identity = this.coordinateIdentity(member.destination.name);
    const { content } = member;
    return content.get("package.json").then(manifestFile => {
      if (!manifestFile) {
        throw new Error(`cannot publish ${identity.name}: the built package has no package.json`);
      }
      return readJsonFile(manifestFile, toJsonObject).then(built => {
        const manifest = rewriteManifest(built, identity, memberVersions);
        const dangling = unresolvableDependencies(manifest);
        if (dangling.length > 0) {
          throw new Error(
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
        return packToTarball(new FileSet(rooted)).then(tgz => {
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
   * Upload a packaged artifact to this registry (the one side effect): reads the
   * sidecar manifest, hashes the tarball for `dist.integrity`/`shasum`, builds
   * the `libnpmpublish` packument envelope, and PUTs it to the escaped package
   * name; a 409 (version already present) is the already-synced status. Pure
   * upload mechanics — release orchestration (ordering, skipping) is the generic
   * layer's. The credential is resolved here — the repository owns its own
   * authentication — from the environment or the per-registry `.npmrc`.
   */
  public publish(artifact: PublishableFileSet): Computable<PublishStatus> {
    const identity = this.coordinateIdentity(artifact.destination.name);
    const { name, version } = identity;
    const tgzFile = artifact.get(tarballBasename(name, version));
    const manifestFile = artifact.get("package.json");
    return Computable.forAll([tgzFile, manifestFile, this.npmAuth()], (tgz, manifest, auth) => {
      if (!tgz || !manifest) {
        throw new Error(`internal error: publish artifact for ${name}@${version} is missing its tarball or manifest`);
      }
      return Computable.forAll([tgz.getBuffer(), manifest.readString()], (data, manifestJson) => ({ data, manifestJson, auth }));
    }).then(({ data, manifestJson, auth }) =>
      publishToRegistry(
        this.url,
        identity,
        data,
        JSON.parse(manifestJson),
        auth.getHeadersFor(this.url),
        this.access,
        auth.otpProvider(this.url, this.context.execution.interaction)
      )
    );
  }

  /**
   * Make an already-resolved npm package launchable, keeping the exact closure
   * it carries (no re-resolution) — the domain dispatches here for its `run`
   * delivery and for a catalog delegating a jointly-pinned member.
   */
  public makeRunnable(pkg: PackageFileSet): Computable<RunnableFileSet> {
    return makeNpmRunnable(pkg);
  }

  /**
   * The platform we are building for, projected to npm's {os, cpu, libc}
   * vocabulary — read off the TARGET property (a clang/LLVM triple; `default
   * TARGET = ${HOST}`) via the same property surface every rule sees, then run
   * through core's lossy `tripleToNpm`. Native selection consumes the triple
   * verbatim; this projection is only what the npm os/cpu/libc gate matches on.
   */
  private targetPlatform(): Computable<NpmPlatform> {
    return this.context.getGlobalString(TARGET).then(triple => tripleToNpm(triple));
  }

  /**
   * What an npm resolution is computed *for* beyond its roots: the target
   * platform, which gates which optional deps exist — an input to the graph,
   * not only to delivery, so the domain folds it into the resolution memo key.
   */
  public environmentKey(): Computable<string> {
    return this.targetPlatform().then(target => `${target.os ?? "?"}-${target.cpu ?? "?"}-${target.libc ?? "?"}`);
  }

  /**
   * PackageRegistry implementation: the requirements of pkg@version are its
   * declared `dependencies` and (non-optional) `peerDependencies`, plus the
   * `optionalDependencies` that are installable on the target. The dominant use
   * of the latter is os/cpu-gated native binaries (esbuild's @esbuild/<platform>
   * engine): all variants are listed, and only the target-matching one(s) are
   * kept. Peers are **soft** (attach-first) requirements:
   * satisfied by any selection in range whatever its resolution key — a wide
   * multi-major peer range must not spawn its floor as a coexisting major —
   * demanding their minimum only when the converged tree selects nothing for
   * the package. "Shared, one instance" holds by construction in a strict
   * closure (one version per name, flat mount) — the peer/regular distinction
   * only exists to work around duplicate-tolerant regular deps, which fabr
   * doesn't have. A violated peer surfaces as an ordinary violation (strict error, or
   * a sealed-tool fork — npm's --legacy-peer-deps posture). An
   * `optional: true` peer ("if present, must match") is never auto-installed,
   * npm parity; devDependencies stay ignored.
   */
  public getRequirements(pkg: string, version: SemverVersion): Computable<Requirement[]> {
    return this.getVersionMetadata(pkg, versionToString(version)).then(meta => {
      /* npm's rule: an entry in optionalDependencies overrides the same name in
       * dependencies, so a dep listed in both is optional (os/cpu-gated, dropped
       * if the target doesn't match). @parcel/watcher lists its per-platform native
       * binaries in both — treating them as required would reject the ones for
       * other platforms as EBADPLATFORM. */
      const optionalDeps = dependencyBlock(meta.optionalDependencies);
      const optionalPeerNames = optionalPeers(meta.peerDependenciesMeta);
      const peers = [...dependencyBlock(meta.peerDependencies)]
        .filter(([dep]) => !optionalPeerNames.has(dep) && !optionalDeps.has(dep))
        .map(([dep, spec]) => ({ ...dependencyRequirement(dep, spec), soft: true }));
      const required = [
        ...[...dependencyBlock(meta.dependencies)]
          .filter(([dep]) => !optionalDeps.has(dep))
          .map(([dep, spec]) => dependencyRequirement(dep, spec)),
        ...peers,
      ];
      const optional = [...optionalDeps].map(([dep, spec]) => dependencyRequirement(dep, spec));
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
        selections.map(sel => this.getVersionMetadata(sel.pkg, versionToString(sel.version)).then(meta => ({ sel, meta }))),
        (...entries) => {
          for (const { sel, meta } of entries) {
            const reason = unsupportedPlatformReason(meta, target);
            if (reason) {
              throw new Error(
                `${sel.pkg}@${versionToString(sel.version)} is not supported for the target platform (${reason}), ` +
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
   * The floor-raise hook (see PackageRegistry): the lowest *published* version
   * of `pkg` satisfying `constraint`, consulted only when the constraint's own
   * minimum turned out unpublished. Reads the **packument** — the registry's
   * mutable per-package version list — through the mutable-fetch TTL cache
   * (origin-derived freshness, revalidated when stale, never frozen); if the
   * cached list satisfies nothing, that is evidence it may be stale, so it is
   * force-revalidated once before giving up. Deterministic modulo registry
   * append — the one sanctioned relaxation, confined to this repair path.
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

  /** The registry's version list for repair suggestions (see RegistryAdapter):
   *  the packument read, without the staleness retry (suggestions are advisory). */
  public availableVersions(pkg: string): Computable<SemverVersion[] | undefined> {
    return this.publishedVersions(pkg, false);
  }

  /** The package's published version list, from its packument (a mutable
   * pointer document — fetched with a freshness lifetime, not frozen), or
   * undefined if the registry has no such package (its 404 for the packument —
   * the package-level counterpart of getVersionMetadata's VersionNotFoundError,
   * and no more an error here than an empty list would be). Unparseable version
   * strings are skipped. */
  private publishedVersions(pkg: string, forceRevalidate: boolean): Computable<SemverVersion[] | undefined> {
    const url = `${this.url}/${packagePath(pkg)}`;
    return this.authHeadersFor(url)
      .then(headers =>
        this.context.fetch(
          url,
          "npm:packument:1",
          content =>
            readStream(content).then(data => {
              /* The reader throws on anything unusable, so an invalid document
               * is never cached. */
              const versions = parseJson(data, `package document for ${pkg} from ${this.url}`, toPublishedVersions);
              return new FileSet(new Map([[VERSIONS_FILE, MemoryFile.from(JSON.stringify(versions))]]));
            }),
          "version list",
          headers,
          forceRevalidate ? { immutable: false, forceRevalidate: true } : { immutable: false }
        )
      )
      .then(files => files.readFile(VERSIONS_FILE))
      .then(
        data =>
          (JSON.parse(data) as string[]).flatMap(text => {
            try {
              return [parseVersion(text)];
            } catch {
              return [];
            }
          }),
        err => {
          if (err instanceof HttpStatusError && err.statusCode === 404) {
            return undefined;
          }
          throw err;
        }
      );
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
      const constraint = SEMVER.parseConstraint(req.constraint);
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
    return this.getVersionMetadata(req.pkg, probeVersion)
      .then(meta => (matchesTargetPlatform(meta, target) ? req : undefined))
      .catch(() => undefined);
  }

  /**
   * Fetch the metadata document for an exact package version, persisted in the
   * build cache and never refreshed. Note the immutability here is a *content*
   * contract fabr asserts, not an HTTP one: npmjs serves version docs with only
   * `max-age=300` (unlike tarballs, which it marks `cache-control: immutable`
   * for a year), because a version doc has exactly one mutable field —
   * `deprecated`. The dependency-relevant fields can never change (a version
   * number is never republished), and fabr reads nothing else; if deprecation
   * warnings are ever surfaced, that read must go through the non-immutable
   * fetch path (like the packument), not this cache-forever one.
   */
  private getVersionMetadata(pkg: string, version: string): Computable<INPMPackageMetadata> {
    const key = pkg + "/" + version;
    let result = this.metadataCache.get(key);
    if (!result) {
      const metadataUrl = `${this.url}/${packagePath(pkg)}/${version}`;
      result = this.authHeadersFor(metadataUrl)
        .then(headers =>
          this.context.fetch(
            metadataUrl,
            "npm:metadata:1",
            content =>
              readStream(content).then(data => {
                const meta = parseMetadataResponse(data, key);
                return new FileSet(new Map([[METADATA_FILE, MemoryFile.from(JSON.stringify(meta))]]));
              }),
            "metadata",
            headers
          )
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
    return this.getVersionMetadata(pkg, versionToString(version)).then(meta =>
      this.authHeadersFor(meta.dist.tarball)
        .then(headers =>
          this.context.fetch(
            meta.dist.tarball,
            "npm:tarball:1",
            (content, { createOutput }) => {
              /* Verify the tarball against the registry's promised digest as it
               * streams: a mismatch throws before the entry commits, so tampered
               * or truncated-but-valid content never enters the immutable cache. */
              const { hashing, verify } = verifyTarballStream(meta.dist, meta.dist.tarball);
              content.on("error", err => hashing.destroy(err instanceof Error ? err : new Error(String(err))));
              content.pipe(hashing);
              return unpackStream(hashing, createOutput).then(files => {
                verify();
                return stripArchiveRoot(files);
              });
            },
            "package",
            headers
          )
        )
        .then(files => new PackageFileSet(files, meta.name, meta.version))
    );
  }
}

function createRepository(context: RepositoryContext): Computable<Repository> {
  return Computable.forAll(
    [context.getRequiredString("url"), context.getString("access")],
    (url, access) => new NPMRepository(url, context, toPublishAccess(access))
  );
}

export const npmRepositoryRegistration: RepositoryRegistration = { type: "npm_repository", provider: createRepository };
