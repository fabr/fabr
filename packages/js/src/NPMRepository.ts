import {
  attachHelp,
  BUILD_OPERATION,
  Computable,
  FILES_OPERATION,
  FileSet,
  HttpStatusError,
  IRequirementEdge,
  IResolutionOrigin,
  IFile,
  MemoryFile,
  MetadataFetchError,
  Name,
  NpmPlatform,
  PACKAGE_RESOLUTION_PROVENANCE,
  PackageFileSet,
  packToTarball,
  PackageRegistry,
  parseVersion,
  PublishableFileSet,
  RepositoryPublishRef,
  RepositoryReader,
  RepositoryWriter,
  PublishMember,
  PublishStatus,
  readStream,
  Repository,
  RepositoryContext,
  RepositoryRef,
  RepositoryRegistration,
  Requirement,
  RequirementResolutionError,
  Resolution,
  ResolvedRoot,
  resolveMVS,
  ROOT_REQUIRER,
  RunnableFileSet,
  Selected,
  SEMVER,
  SemverVersion,
  TARGET,
  tripleToNpm,
  unpackStream,
  versionToString,
} from "@fabr-build/core";
import { makeNpmRunnable } from "./JSPackage";
import {
  INPMPackageMetadata,
  isSemverConstraint,
  matchesTargetPlatform,
  memberDependencies,
  NpmPublishIdentity,
  npmPackageOfPath,
  parseMetadataResponse,
  publishToRegistry,
  rewriteManifest,
  splitNameVersion,
  splitNpmReference,
  stripArchiveRoot,
  tarballBasename,
  unresolvableDependencies,
  unsupportedPlatformReason,
} from "./NPMProtocol";
import { NPMConfig } from "./NPMConfig";
import { jsPluginContext } from "./JSPluginContext";

const METADATA_FILE = "metadata.json";
const RESOLUTION_FILE = "resolution.json";

/** Serialized form of one selection in a persisted resolution document */
interface IResolutionEntry {
  pkg: string;
  version: string;
  selectedBy?: IRequirementEdge;
  reachedVia?: IRequirementEdge;
  reachableFrom?: number[];
}

/** Serialized form of a persisted joint resolution */
interface IResolutionDoc {
  roots: Requirement[];
  selections: IResolutionEntry[];
}

function requirementKey(req: Requirement): string {
  return `${req.pkg}:${req.constraint}`;
}

/**
 * npm's private {@link Resolution}: the joint version selection + reachable tree,
 * plus the operation it was resolved under (so materialize delivers the same
 * package-vs-runnable shape without a second context read). `selections`/`rootIndex`
 * are empty under the `files` operation, where materialize fetches per-reference.
 */
interface NpmResolution extends Resolution {
  readonly roots: ResolvedRoot[];
  readonly operation: string;
  readonly selections: Selected<SemverVersion>[];
  /** requirementKey → index into the resolution's roots (the space `reachableFrom` indexes). */
  readonly rootIndex: Map<string, number>;
}

/** name → version for the names `assignments` assign exactly one distinct
 *  version — the names a manifest dependency can be unambiguously rewritten to. */
function uniqueAssignments(assignments: readonly NpmPublishIdentity[]): Map<string, string> {
  const byName = new Map<string, Set<string>>();
  for (const { name, version } of assignments) {
    byName.set(name, (byName.get(name) ?? new Set()).add(version));
  }
  return new Map([...byName].flatMap(([name, versions]) => (versions.size === 1 ? [[name, [...versions][0]] as const] : [])));
}

export class NPMRepository implements Repository, RepositoryReader, RepositoryWriter, PackageRegistry<SemverVersion> {
  private readonly url: string;
  private readonly context: RepositoryContext;
  /* In-process memo over the persistent metadata cache, keyed by "pkg/version" */
  private readonly metadataCache: Map<string, Computable<INPMPackageMetadata>>;

  constructor(url: string, context: RepositoryContext) {
    this.url = url.replace(/\/+$/, "");
    this.context = context;
    this.metadataCache = new Map();
  }

  /* The combined project + user `.npmrc`, loaded once per run and shared across
   * every NPMRepository instance (held on the ExecutionContext via the js plugin
   * context, not per instance); the project part is read through the source FS,
   * so it re-settles if it changes in watch mode. */
  private npmConfig(): Computable<NPMConfig> {
    return jsPluginContext(this.context.execution).npmConfig();
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
    return this.npmConfig().then(config => config.getHeadersFor(url));
  }

  public getRepositoryRef(name: Name): RepositoryRef {
    const { requirement, projection } = splitNpmReference(name);
    const ref = new RepositoryRef(this, requirement);
    return projection ? ref.find(projection.pattern, projection.prefix) : ref;
  }

  public getRepositoryPublishRef(name: Name): RepositoryPublishRef {
    this.coordinateIdentity(name); /* validate the address shape up front */
    return new RepositoryPublishRef(this, name);
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
     * their identities re-parsed from the written name; an address in some other
     * ecosystem's namespace (a file path, say) has no name/version and is
     * ignored. */
    const npmRelease = release
      .filter(coordinate => coordinate.source instanceof NPMRepository)
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
      return manifestFile.getBuffer().then(buffer => {
        const manifest = rewriteManifest(JSON.parse(buffer.toString("utf8")), identity, memberVersions);
        const dangling = unresolvableDependencies(manifest);
        if (dangling.length > 0) {
          throw new Error(
            `cannot publish ${identity.name}: no version to record for ${dangling
              .map(dep => `'${dep}'`)
              .join(", ")} — a dependency built here must be published by this sync (at a single version) for its ` +
              `dependants to be resolvable`
          );
        }
        const manifestJson = JSON.stringify(manifest, undefined, 2);
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
    return Computable.forAll([tgzFile, manifestFile, this.npmConfig()], (tgz, manifest, config) => {
      if (!tgz || !manifest) {
        throw new Error(`internal error: publish artifact for ${name}@${version} is missing its tarball or manifest`);
      }
      return Computable.forAll([tgz.getBuffer(), manifest.readString()], (data, manifestJson) => ({ data, manifestJson, config }));
    }).then(({ data, manifestJson, config }) =>
      publishToRegistry(this.url, identity, data, JSON.parse(manifestJson), config.getHeadersFor(this.url))
    );
  }

  /**
   * Phase 1 — resolve a batch of references jointly (one minimal-version-selection
   * over all root requirements, so shared packages agree on a version and user
   * overrides dominate per max-of-minimums) WITHOUT fetching. Returns the
   * selection tree; `materialize` fetches a subset of it on demand.
   *
   * Under `files` the consumer wants each package's own files standalone — no
   * closure, no joint resolution — so resolution is a no-op that just records the
   * root names (fetch happens per-reference in materialize). This is what lets
   * `fabr cat @npm:pkg:ver:file` succeed when the closure is unresolvable here.
   *
   * Only semver versions/ranges are accepted: dist-tags (e.g. 'latest') are
   * mutable pointers and would make the build non-deterministic, so they are
   * deliberately not supported — every document we fetch is immutable, cacheable
   * indefinitely with no refresh policy.
   */
  public resolve(references: RepositoryRef[]): Computable<Resolution> {
    /* The operation is a property of this collection point, read from the context
     * (this instance is interned per BuildContext, so it reflects the config these
     * references were consumed under). */
    return this.context.getGlobalString(BUILD_OPERATION).then(operation => {
      const requirements = references.map(reference => {
        try {
          return this.parseRequirement(reference.name);
        } catch (err) {
          throw new RequirementResolutionError([reference], asError(err));
        }
      });
      const roots: ResolvedRoot[] = references.map((reference, index) => ({ reference, name: requirements[index].pkg }));
      if (operation === FILES_OPERATION) {
        return Computable.resolve<NpmResolution>({ roots, operation, selections: [], rootIndex: new Map() });
      }
      /* Canonicalize the roots so the resolution (and its memo key, and the
       * reachableFrom indices) are independent of reference order */
      const byKey = new Map(requirements.map(req => [requirementKey(req), req]));
      const rootKeys = [...byKey.keys()].sort();
      const rootReqs = rootKeys.map(key => byKey.get(key)!);
      const rootIndex = new Map(rootKeys.map((key, index) => [key, index]));
      return this.getJointResolution(rootReqs, rootKeys)
        .then(selections => {
          checkSingleVersions(selections, rootKeys.join(", "));
          return { roots, operation, selections, rootIndex } satisfies NpmResolution;
        })
        .catch(err => this.attributeMetadataFailure(err, references, requirements));
    });
  }

  /**
   * Phase 2 — fetch + assemble the requested references (a subset of `resolution`).
   * Only the closure reachable from the requested roots is fetched, from the
   * pre-resolved tree — so a subset materialization keeps the joint pin. The
   * operation (captured in the resolution) decides the shape: run → each root
   * becomes a runnable, otherwise the plain packages.
   */
  public materialize(references: RepositoryRef[], resolution: Resolution): Computable<FileSet[]> {
    const resolved = resolution as NpmResolution;
    if (resolved.operation === FILES_OPERATION) {
      return Computable.forAll(
        references.map(reference => this.attributedTo(reference, () => this.resolveBarePackage(reference))),
        (...delivered: FileSet[]) => delivered
      );
    }
    const { selections, rootIndex, operation } = resolved;
    const requirements = references.map(reference => this.parseRequirement(reference.name));
    const requestedRoots = new Set(requirements.map(req => rootIndex.get(requirementKey(req))!));
    /* Fetch only the selections reachable from the requested roots (indexed by
     * their position in `selections`, so assembleClosure can pick each root's
     * reachable subset). */
    const needed = selections.flatMap((sel, selIndex) =>
      sel.reachableFrom?.some(root => requestedRoots.has(root)) ? [{ sel, selIndex }] : []
    );
    return Computable.forAll(
      needed.map(({ sel }) => this.fetch(sel.pkg, sel.version)),
      (...fetched: PackageFileSet[]) => {
        const packages = new Map<number, PackageFileSet>(needed.map(({ selIndex }, k) => [selIndex, fetched[k]]));
        const assembled = requirements.map(req =>
          this.assembleClosure(req, rootIndex.get(requirementKey(req))!, selections, packages)
        );
        return operation === "run"
          ? Computable.forAll(
              assembled.map(pkg => this.makeRunnable(pkg)),
              (...delivered: FileSet[]) => delivered
            )
          : assembled;
      }
    ).catch(err => this.attributeMetadataFailure(err, references, requirements));
  }

  /**
   * A metadata failure names the root package whose closure reached it (the
   * resolver's first-reacher chain): attribute it to the written reference(s)
   * requiring that root, whose carried provenance lets the driver point at the
   * requirement as written.
   */
  private attributeMetadataFailure(err: unknown, references: RepositoryRef[], requirements: Requirement[]): never {
    if (err instanceof MetadataFetchError) {
      const culpable = references.filter((_, index) => requirements[index].pkg === err.rootPkg);
      if (culpable.length > 0) {
        throw new RequirementResolutionError(culpable, err);
      }
    }
    throw asError(err);
  }

  /**
   * Run one reference's own delivery, attributing any failure to it (the
   * per-reference analogue of the batch attribution).
   */
  private attributedTo(reference: RepositoryRef, deliver: () => Computable<FileSet>): Computable<FileSet> {
    try {
      return deliver().catch(err => {
        throw new RequirementResolutionError([reference], asError(err));
      });
    } catch (err) {
      throw new RequirementResolutionError([reference], asError(err));
    }
  }

  /**
   * Make an already-resolved npm package launchable, keeping the exact closure
   * it carries (no re-resolution). Shared by this repository's own `run`
   * delivery and by a catalog delegating a jointly-pinned member.
   */
  public makeRunnable(pkg: PackageFileSet): Computable<RunnableFileSet> {
    return makeNpmRunnable(pkg);
  }

  /**
   * Assemble the delivery for one root requirement: its own package, carrying
   * the reachable members of the joint closure as resolved dependencies, all
   * stamped with the resolution's provenance.
   */
  private assembleClosure(
    req: Requirement,
    index: number,
    selections: Selected<SemverVersion>[],
    packages: Map<number, PackageFileSet>
  ): PackageFileSet {
    const origin: IResolutionOrigin<SemverVersion> = {
      kind: PACKAGE_RESOLUTION_PROVENANCE,
      repository: this.url,
      root: req,
      selections,
      versionToString,
      packageOfPath: npmPackageOfPath,
    };
    const reachable = selections.flatMap((sel, selIndex) =>
      sel.reachableFrom?.includes(index) ? [{ sel, files: packages.get(selIndex)! }] : []
    );
    const root = reachable.find(entry => entry.sel.pkg === req.pkg);
    if (!root) {
      /* Can't happen: a root requirement is always reachable from itself */
      throw new Error(`Resolution of ${requirementKey(req)} does not contain its own root package`);
    }
    const dependencies = reachable.filter(entry => entry !== root).map(entry => entry.files.withOrigin(origin));
    /* The plain resolved package with its joint closure carried; the operation's
     * delivery shape (a runnable under `run`) is applied upstream in `deliver`. */
    return new PackageFileSet(root.files, root.files.packageName, root.files.version, dependencies, origin);
  }

  /**
   * Deliver a single package's own files, resolved standalone — the `files`
   * operation's delivery (see resolve). A top-level root's minimal-version
   * selection is simply its constraint's lower bound (nothing else constrains
   * it), so this is exactly the version the joint path would give the root, but
   * reached without walking — or fetching — the dependency closure. The result
   * is a bare PackageFileSet (no carried dependencies); any projection is
   * applied afterwards by the collection point (RepositoryRef.finishMaterialize).
   */
  private resolveBarePackage(reference: RepositoryRef): Computable<FileSet> {
    const req = this.parseRequirement(reference.name);
    const constraint = SEMVER.parseConstraint(req.constraint);
    if (SEMVER.isUnconstrained(constraint)) {
      throw new Error(
        `Cannot resolve the files of '${req.pkg}' from an unconstrained version ('${req.constraint}'): ` +
          "pin a version or range to project into a package"
      );
    }
    const version = SEMVER.minimumOf(constraint);
    const edge: IRequirementEdge = { requiredBy: ROOT_REQUIRER, constraint: req.constraint };
    const selection: Selected<SemverVersion> = { pkg: req.pkg, version, selectedBy: edge, reachedVia: edge, reachableFrom: [0] };
    const origin: IResolutionOrigin<SemverVersion> = {
      kind: PACKAGE_RESOLUTION_PROVENANCE,
      repository: this.url,
      root: req,
      selections: [selection],
      versionToString,
      packageOfPath: npmPackageOfPath,
    };
    return this.fetch(req.pkg, version).then(pkg => new PackageFileSet(pkg, pkg.packageName, pkg.version, [], origin));
  }

  /** The requirement a reference declares, read straight off its own `name:version`
   *  (a manifest records the declared constraint). Undefined for a versionless ref. */
  public declaredRequirement(ref: RepositoryRef): Computable<Requirement | undefined> {
    const split = splitNameVersion(ref.name);
    return Computable.resolve(split ? { pkg: split.identifier, constraint: split.version } : undefined);
  }

  private parseRequirement(name: Name): Requirement {
    const split = splitNameVersion(name);
    if (!split) {
      throw new Error(
        `Missing version in package reference '${name.getLiteralPathPrefix()}' (expected '<name>:<version-or-range>')`
      );
    }
    const { identifier: pkg, version: constraint } = split;
    if (!isSemverConstraint(constraint)) {
      throw attachHelp(
        new Error(`'${constraint}' is not a valid version constraint for '${pkg}'`),
        "dist-tags such as 'latest' are not supported: pin a version or range instead"
      );
    }
    return { pkg, constraint };
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
   * PackageRegistry implementation: the requirements of pkg@version are its
   * declared `dependencies`, plus the `optionalDependencies` that are installable
   * on the target. The dominant use of the latter is os/cpu-gated native binaries
   * (esbuild's @esbuild/<platform> engine): all variants are listed, and only the
   * target-matching one(s) are kept. peerDependencies remain ignored.
   */
  public getRequirements(pkg: string, version: SemverVersion): Computable<Requirement[]> {
    return this.getVersionMetadata(pkg, versionToString(version)).then(meta => {
      /* npm's rule: an entry in optionalDependencies overrides the same name in
       * dependencies, so a dep listed in both is optional (os/cpu-gated, dropped
       * if the target doesn't match). @parcel/watcher lists its per-platform native
       * binaries in both — treating them as required would reject the ones for
       * other platforms as EBADPLATFORM. */
      const optionalNames = new Set(Object.keys(meta.optionalDependencies ?? {}));
      const required = Object.entries(meta.dependencies ?? {})
        .filter(([dep]) => !optionalNames.has(dep))
        .map(([dep, constraint]) => ({ pkg: dep, constraint }));
      const optional = Object.entries(meta.optionalDependencies ?? {}).map(([dep, constraint]) => ({ pkg: dep, constraint }));
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
      if (SEMVER.isUnconstrained(constraint)) {
        return Computable.resolve(undefined);
      }
      probeVersion = versionToString(SEMVER.minimumOf(constraint));
    } catch {
      return Computable.resolve(undefined);
    }
    return this.getVersionMetadata(req.pkg, probeVersion).then(
      meta => (matchesTargetPlatform(meta, target) ? req : undefined),
      () => undefined
    );
  }

  /**
   * Resolutions are persisted in the build cache: under minimal version selection
   * the result is a pure function of the (canonically ordered) root requirements
   * and the (immutable) declared metadata of the packages they reach, so a cached
   * resolution can only become wrong if a requirement itself changes — which
   * changes the cache key. Failed resolutions are not cached (the error
   * propagates before anything is written), so transient repository problems
   * don't poison the cache.
   */
  private getJointResolution(roots: Requirement[], rootKeys: string[]): Computable<Selected<SemverVersion>[]> {
    /* The resolution depends on the target platform (it filters os/cpu/libc-gated
     * optional deps), so the memo key must carry it — otherwise a resolution
     * computed for one target would be served for another. */
    return this.targetPlatform().then(target => {
      const targetKey = `${target.os ?? "?"}-${target.cpu ?? "?"}-${target.libc ?? "?"}`;
      return this.context
        .memoize("npm:resolve:4", `${this.url} ${targetKey} ${rootKeys.join(" ")}`, () => {
          /* A memo miss means real resolution work on behalf of the consumer */
          this.context.notifyProgress({ kind: "repository-resolve", repository: this.context.target, requirements: rootKeys });
          return resolveMVS(roots, SEMVER, this).then(resolution => {
            if (resolution.errors.length > 0) {
              throw new Error(`Unable to resolve ${rootKeys.join(", ")}:\n  ${resolution.errors.join("\n  ")}`);
            }
            return this.verifiedResolutionDoc(roots, resolution.selections, target);
          });
        })
        .then(files => files.readFile(RESOLUTION_FILE))
        .then(data => {
          const doc = JSON.parse(data) as IResolutionDoc;
          return doc.selections.map(entry => ({
            pkg: entry.pkg,
            version: parseVersion(entry.version),
            selectedBy: entry.selectedBy,
            reachedVia: entry.reachedVia,
            reachableFrom: entry.reachableFrom,
          }));
        });
    });
  }

  /**
   * Validate the resolved closure against the target platform, then serialize it.
   * Optional deps were already filtered to the target, so any os/cpu/libc mismatch
   * remaining is a *non-optional* dependency (or a direct requirement) on a
   * package for another platform — npm's EBADPLATFORM — and is an error rather
   * than an unusable install. Each selection's metadata was fetched during the
   * resolution walk, so these are cache hits. (Override TARGET with -D to resolve
   * for a different platform.)
   */
  private verifiedResolutionDoc(
    roots: Requirement[],
    selections: Selected<SemverVersion>[],
    target: NpmPlatform
  ): Computable<FileSet> {
    return Computable.forAll(
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
        const doc: IResolutionDoc = {
          roots,
          selections: selections.map(sel => ({
            pkg: sel.pkg,
            version: versionToString(sel.version),
            selectedBy: sel.selectedBy,
            reachedVia: sel.reachedVia,
            reachableFrom: sel.reachableFrom,
          })),
        };
        return new FileSet(new Map([[RESOLUTION_FILE, MemoryFile.from(JSON.stringify(doc, undefined, 2))]]));
      }
    );
  }

  /**
   * Fetch the metadata document for an exact package version. The registry
   * contract is that these are immutable once published, so they are persisted
   * in the build cache and never refreshed.
   */
  private getVersionMetadata(pkg: string, version: string): Computable<INPMPackageMetadata> {
    const key = pkg + "/" + version;
    let result = this.metadataCache.get(key);
    if (!result) {
      const metadataUrl = `${this.url}/${key}`;
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
        .then(data => JSON.parse(data) as INPMPackageMetadata)
        .catch(err => {
          /* Translate the registry's HTTP 404 into the fact it means. */
          if (err instanceof HttpStatusError && err.statusCode === 404) {
            throw new Error(`NPM package ${pkg}@${version} not found at ${this.url}`);
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

  private fetch(pkg: string, version: SemverVersion): Computable<PackageFileSet> {
    return this.getVersionMetadata(pkg, versionToString(version)).then(meta =>
      this.authHeadersFor(meta.dist.tarball)
        .then(headers =>
          this.context.fetch(
            meta.dist.tarball,
            "npm:tarball:1",
            (content, targetDir) => unpackStream(content, targetDir).then(stripArchiveRoot),
            "package",
            headers
          )
        )
        .then(files => new PackageFileSet(files, meta.name, meta.version))
    );
  }
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Consumers mount the resolved closure as a flat node_modules, which can only
 * host a single version of each package; check for multiple selected versions
 * (of different majors) and fail with something actionable rather than letting
 * the FileSet union report an opaque path conflict.
 */
function checkSingleVersions(selections: Selected<SemverVersion>[], root: string): void {
  const byPkg = new Map<string, SemverVersion[]>();
  for (const sel of selections) {
    byPkg.set(sel.pkg, [...(byPkg.get(sel.pkg) ?? []), sel.version]);
  }
  for (const [pkg, versions] of byPkg) {
    if (versions.length > 1) {
      throw new Error(
        `Unable to resolve ${root}: requires multiple versions of ${pkg} (${versions
          .map(versionToString)
          .join(", ")}), which the flat package layout cannot represent`
      );
    }
  }
}

function createRepository(context: RepositoryContext): Computable<NPMRepository> {
  return context.getRequiredString("url").then(url => new NPMRepository(url, context));
}

export const npmRepositoryRegistration: RepositoryRegistration = { type: "npm_repository", provider: createRepository };
