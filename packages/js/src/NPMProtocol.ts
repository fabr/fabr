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

/*
 * The npm registry **wire protocol**: the format of what fabr reads from and
 * writes to a registry — metadata documents, platform gates, publish envelopes,
 * reference/version syntax, tarball layout, and registry auth — as pure functions.
 * NPMRepository.ts is the fabr {@link Repository} *over* this protocol: it owns
 * the transport and caching, and delegates every format concern here (and
 * resolution orchestration to core's package resolver).
 */

import {
  attachHelp,
  Computable,
  FileSet,
  HttpResponse,
  ExpectedDigest,
  IProjection,
  isCanonicalFileName,
  isJsonObject,
  Name,
  IContentPackage,
  NpmPlatform,
  PackageFormat,
  parseIntegrity,
  parseJson,
  parseVersion,
  Requirement,
  SEMVER,
  SemverConstraint,
  SemverVersion,
  sendRequest,
  splitOverrideMarker,
  toJsonObject,
  verifyingStream,
} from "@fabr-build/core";
import { otpChallengeOf, OtpProvider } from "./NPMAuth";
import { makeNpmRunnable } from "./JSPackage";
import { declaredDependencies } from "./PackageJson";
import * as crypto from "node:crypto";
import { Transform } from "node:stream";

export interface ISignature {
  keyid: string;
  sig: string;
}

/**
 * A registry version document. Only the fields {@link parseMetadataResponse}
 * validates are typed as what they are; **every other field is `unknown` by
 * construction**, because a published manifest is third-party data that need
 * only satisfy the registry, not our expectations — npm normalizes a good deal
 * of legal-but-odd shape away (`"os": "darwin"` for a one-entry gate,
 * `"dependencies": []` for none), and its own readers tolerate the rest. Read
 * those fields through the normalizer that owns each one — {@link gateEntries}
 * here, `dependencyBlock`/`optionalPeers` in PackageJson.ts — never by asserting the shape
 * npm merely usually produces: a wrong assumption is a TypeError thrown deep in
 * an evaluation, which fails the whole resolution rather than the one package.
 */
export interface INPMPackageMetadata {
  dependencies?: unknown;
  /**
   * Deps npm installs when they can be installed but tolerates the absence of.
   * The dominant use is os/cpu-gated native binaries (esbuild's @esbuild/<plat>,
   * rollup, swc, …): every platform variant is listed here, each self-gated by
   * its own package's `os`/`cpu`, and only the host-matching one(s) are kept.
   */
  optionalDependencies?: unknown;
  /**
   * Host-supplied singleton requirements (the plugin pattern: an eslint plugin
   * peers on eslint). Fabr treats them as ordinary requirements — see
   * getRequirements: the peer/regular distinction exists to work around npm's
   * tolerance of duplicated regular deps, which fabr's strict single-version
   * closures don't have.
   */
  peerDependencies?: unknown;
  /** Per-peer flags; an `optional: true` peer is "if present, must match" —
   * never auto-installed (npm parity), so it contributes no requirement. */
  peerDependenciesMeta?: unknown;
  /**
   * Installability gates declared by a package on itself, in Node's
   * process.platform / process.arch vocabulary (plus glibc/musl for `libc`); each
   * is an allow-list, with a leading `!` negating an entry. Absent/empty means
   * "any". Gated against the TARGET platform (see targetPlatform). `libc` splits
   * rollup/swc/sharp native builds; it is irrelevant to esbuild, whose Go binary
   * is statically linked.
   */
  os?: unknown;
  cpu?: unknown;
  libc?: unknown;
  dist: {
    fileCount?: number;
    /** Validated as a string when present, so the digest readers can rely on it. */
    integrity?: string;
    "npm-signature"?: string;
    shasum?: string;
    signatures?: ISignature[];
    tarball: string;
    unpackedSize?: number;
  };
  name: string;
  version: string;
  /* and potentially lots of other stuff that we don't need */
}

/** The os/cpu/libc gates of a manifest, as written. */
export type PlatformGates = { os?: unknown; cpu?: unknown; libc?: unknown };

/**
 * A gate in npm's list form, whichever way it was written: the list itself, or
 * a bare string for a one-entry gate (`"os": "darwin"` — legal, and published).
 * Anything else contributes no entry, so a gate is readable whatever the JSON.
 */
function gateEntries(gate: unknown): string[] {
  if (typeof gate === "string") {
    return [gate];
  }
  return Array.isArray(gate) ? gate.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * npm's os/cpu gate semantics (npm-install-checks' checkList): the list is an
 * allow-list of process.platform / process.arch values, an entry prefixed `!`
 * negating it. An empty/absent list — or the explicit sole entry `"any"` —
 * imposes no constraint. A value is rejected if explicitly blocked (`!value`);
 * otherwise it must appear in the allow-list, unless the list is negations-only.
 * A gated package on a host whose fact is unknown cannot be confirmed to match.
 * The gate is read as written, in any shape — see {@link gateEntries}.
 */
export function platformGateAdmits(gate: unknown, value: string | undefined): boolean {
  const entries = gateEntries(gate);
  if (entries.length === 0) {
    return true;
  }
  /* npm reads "any" only as a whole gate, never as one entry among several,
   * where it is just a (never-matching) platform name. */
  if (entries.length === 1 && entries[0] === "any") {
    return true;
  }
  if (value === undefined) {
    return false;
  }
  if (entries.some(entry => entry.startsWith("!") && entry.slice(1) === value)) {
    return false;
  }
  const allowed = entries.filter(entry => !entry.startsWith("!"));
  return allowed.length === 0 || allowed.includes(value);
}

/**
 * Whether a package declaring these os/cpu/libc gates in its own metadata may run
 * on the given target platform — the test that keeps only the target-matching
 * native-binary variants out of a package's full set of platform optional
 * dependencies.
 */
export function matchesTargetPlatform(meta: PlatformGates, target: NpmPlatform): boolean {
  return (
    platformGateAdmits(meta.os, target.os) &&
    platformGateAdmits(meta.cpu, target.cpu) &&
    platformGateAdmits(meta.libc, target.libc)
  );
}

/**
 * A human-readable reason a package declaring these os/cpu/libc gates cannot run
 * on the given target platform, or undefined if it can. Optional dependencies are
 * filtered out silently before selection; this is for the other side of npm's
 * contract — a *non-optional* dependency (or a direct requirement) on a package
 * built for another platform, which npm rejects as EBADPLATFORM rather than
 * mounting an unusable install.
 */
export function unsupportedPlatformReason(meta: PlatformGates, target: NpmPlatform): string | undefined {
  const parts: string[] = [];
  if (!platformGateAdmits(meta.os, target.os)) {
    parts.push(`os '${target.os ?? "(unknown)"}' is not in [${gateEntries(meta.os).join(", ")}]`);
  }
  if (!platformGateAdmits(meta.cpu, target.cpu)) {
    parts.push(`cpu '${target.cpu ?? "(unknown)"}' is not in [${gateEntries(meta.cpu).join(", ")}]`);
  }
  if (!platformGateAdmits(meta.libc, target.libc)) {
    parts.push(`libc '${target.libc ?? "(unknown)"}' is not in [${gateEntries(meta.libc).join(", ")}]`);
  }
  return parts.length === 0 ? undefined : parts.join("; ");
}

/**
 * A parsed npm publish address: the package name + exact version an
 * `name:version` coordinate assigns. Purely local currency — a coordinate
 * travels as its written {@link Name} (core's RepositoryRef/RepositoryPublishRef) and each
 * consumer re-parses it here (see {@link splitNameVersion}), the same way the
 * read side re-parses reference names per phase.
 */
export interface NpmPublishIdentity {
  readonly name: string;
  readonly version: string;
}

/**
 * npm's tarball basename: `<name>-<version>.tgz` with the scope included
 * (`@fabr/core-0.1.tgz`), matching `libnpmpublish`. (The on-disk `npm pack`
 * filename flattening and the registry's served basename are different transforms
 * that don't apply to what the client sends.)
 */
export function tarballBasename(name: string, version: string): string {
  return `${name}-${version}.tgz`;
}

/** SRI algorithms fabr will verify against, strongest first — sha1 is accepted
 * only via the legacy `dist.shasum`, never as an SRI entry. */


/** The digest a registry's `dist` metadata promises for a tarball: the strongest
 * SRI in `dist.integrity` (base64), else the legacy sha1 `dist.shasum` (hex).
 * Undefined when `dist` carries neither — nothing to verify against. */
export function expectedTarballDigest(dist: {
  integrity?: string;
  shasum?: string;
}): ExpectedDigest | undefined {
  const sri = dist.integrity ? parseIntegrity(dist.integrity) : undefined;
  if (sri) {
    return sri;
  }
  /* npm-specific, and deliberately not something a written declaration may use:
   * plenty of long-published versions carry only this. */
  if (dist.shasum) {
    return { algorithm: "sha1", encoding: "hex", value: dist.shasum.toLowerCase() };
  }
  return undefined;
}

/**
 * Prepare integrity verification for a streamed tarball. Returns a hashing
 * pass-through to feed the unpacker (`content.pipe(hashing)`, then unpack
 * `hashing`) and a `verify` to call once the stream is fully consumed: it hashes
 * every byte that passed through and throws {@link IntegrityError} on mismatch —
 * inside the fetch `process` callback, so a bad tarball never enters the cache.
 * A `dist` with no usable digest yields an identity pass-through and a no-op
 * `verify` (nothing promised, nothing to check — npm behaves the same).
 */
export function verifyTarballStream(
  dist: { integrity?: string; shasum?: string },
  url: string
): { hashing: Transform; verify: () => void } {
  return verifyingStream(expectedTarballDigest(dist), url);
}

/**
 * The access level a repository's publishes request on a package's FIRST
 * publish (thereafter access is managed registry-side and the field is inert).
 * A property of the publish destination, not the package — public npm and
 * private npm are conceptually two repositories sharing a URL. `null` leaves
 * it to the registry's default (npmjs: restricted for scoped packages, paid).
 */
export type PublishAccess = "public" | "restricted" | null;

/** Convert a declared `access` property value; absent → null (registry default).
 * `private` is accepted as a synonym for npm's wire term `restricted` (npmjs
 * itself calls the feature "private packages"). */
export function toPublishAccess(value: string | undefined): PublishAccess {
  if (value === undefined) {
    return null;
  } else if (value === "private" || value === "restricted") {
    return "restricted";
  } else if (value === "public") {
    return value;
  }
  throw new Error(`invalid access value ${JSON.stringify(value)} (expected "public" or "private"/"restricted")`);
}

/**
 * Upload a packaged tarball + manifest to an npm registry (the publish side effect).
 * Builds the `libnpmpublish` packument envelope — the manifest completed with `_id`
 * and `dist` (sha512 SRI integrity, sha1 shasum, the registry tarball URL), wrapped
 * with `dist-tags`/`versions`/`_attachments` — and PUTs it to the escaped package
 * name with the given credential. Returns whether the upload happened or the
 * version was already present (a 409 — sync is declarative, so already-there is
 * success, reported distinctly); any other non-2xx surfaces the registry's error
 * body. A second-factor challenge (a 2FA account) is answered through `otp`,
 * and the PUT retried with the produced one-time password — twice at most,
 * so a stale cached token gets one fresh re-acquisition and a genuinely
 * refused one fails rather than looping.
 */
export function publishToRegistry(
  registryUrl: string,
  coordinate: NpmPublishIdentity,
  tarball: Buffer,
  manifest: Record<string, unknown>,
  authHeaders: Record<string, string>,
  access: PublishAccess = null,
  otp?: OtpProvider
): Computable<"published" | "already-synced"> {
  const { name, version } = coordinate;
  const tarballName = tarballBasename(name, version);
  const bytes = new Uint8Array(tarball);
  const versionManifest: Record<string, unknown> = {
    ...manifest,
    _id: `${name}@${version}`,
    dist: {
      integrity: `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`,
      shasum: crypto.createHash("sha1").update(bytes).digest("hex"),
      tarball: new URL(`${name}/-/${tarballName}`, registryUrl + "/").href.replace(/^https:\/\//, "http://"),
    },
  };
  const envelope = {
    _id: name,
    name,
    description: manifest.description,
    "dist-tags": { latest: version },
    versions: { [version]: versionManifest },
    access,
    _attachments: {
      [tarballName]: {
        content_type: "application/octet-stream",
        data: tarball.toString("base64"),
        length: tarball.length,
      },
    },
  };
  const escapedName = name.replace(/\//g, "%2f");
  /* The registry only offers the browser (passkey) ceremony — authUrl/doneUrl
   * in the challenge body — to a client advertising it via BOTH npm-auth-type
   * and npm-command; without them a passkey account gets only the inert
   * "upgrade your client" error. The user-agent is not consulted. */
  const headers = {
    "content-type": "application/json",
    "npm-auth-type": "web",
    "npm-command": "publish",
    ...authHeaders,
  };
  const body = JSON.stringify(envelope);
  const attempt = (password?: string): Computable<HttpResponse> =>
    sendRequest(`${registryUrl}/${escapedName}`, {
      method: "PUT",
      headers: password === undefined ? headers : { ...headers, "npm-otp": password },
      body,
    });
  const settle = (response: HttpResponse): "published" | "already-synced" => {
    /* Version already present — success for a declarative sync. Registries
     * disagree on the shape: a 409 conflict, or npmjs's 403 "You cannot
     * publish over the previously published versions". */
    if (
      response.statusCode === 409 ||
      (response.statusCode === 403 && response.body.toString("utf8").includes("cannot publish over"))
    ) {
      return "already-synced";
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const detail = response.body.toString("utf8");
      const error = new Error(`publishing ${name}@${version} to ${registryUrl} failed (${response.statusCode}): ${detail}`);
      /* npmjs's refusal of a restricted scoped publish ("You must sign up for
       * private packages") — restricted is paid, and reaches here only from a
       * repository declared (or defaulted by the registry) that way; the usual
       * remedy is publishing to a public-access repository, not a paid plan. */
      if (detail.includes("private packages")) {
        attachHelp(
          error,
          `restricted (private) packages are a paid npmjs feature; to publish publicly instead, use an ` +
            `npm_repository declared with 'access = public;' (the default @npm)`
        );
      }
      throw error;
    }
    return "published";
  };
  const answerChallenge = (
    response: HttpResponse,
    rejected: string | undefined,
    attemptsLeft: number
  ): Computable<"published" | "already-synced"> | "published" | "already-synced" => {
    const challenge = otpChallengeOf(response);
    if (!challenge || !otp || attemptsLeft <= 0) {
      return settle(response);
    }
    return otp(challenge, rejected).then(password =>
      attempt(password).then(retried => answerChallenge(retried, password, attemptsLeft - 1))
    );
  };
  return attempt().then(response => answerChallenge(response, undefined, 2));
}

/**
 * Interpret a registry response, before it gets anywhere near the cache (error
 * responses must never be cached) — and again when one is read back out of it,
 * so a metadata document is judged by exactly one reader wherever it came from.
 * It's a three-way split — HTTP-level failures
 * (404, 5xx) are already surfaced upstream, so no error-body taxonomy is needed:
 *  - a single-version metadata document (the documented shape: `name` + `version`
 *    + `dist.tarball`) — the thing we asked for; return it;
 *  - a full packument (`versions`) — we resolved the wrong URL, a bug;
 *  - anything else (an error body, non-JSON, a truncated/HTML page) — unusable.
 */
export function parseMetadataResponse(data: string | Buffer, key: string): INPMPackageMetadata {
  return parseJson(data, `response from NPM repository for '${key}'`, toVersionMetadata);
}

/** The converter behind {@link parseMetadataResponse}: the document as metadata,
 * or the reason it is unusable (attributed to the response by the caller). */
function toVersionMetadata(json: unknown): INPMPackageMetadata {
  if (!isJsonObject(json)) {
    throw new Error("expected a JSON object");
  }
  if (isVersionMetadata(json)) {
    /* The document's `name` is what fabr stamps as the delivered package's
     * identity (and so its mount path), so it must be usable as one — thrown
     * from the fetch's process callback, so an invalid document is never
     * cached (the validate-before-cache invariant). Dependency names need no
     * check here: a dep key is only an opaque resolution key and a URL
     * component — it either fails to resolve (an ordinary attributed error) or
     * resolves to a document whose own `name` passes through this same check
     * before it can become an identity. */
    if (!isCanonicalFileName(json.name)) {
      throw new Error(`package name ${JSON.stringify(json.name)} is not usable as an identity`);
    }
    return json;
  }
  if ("versions" in json) {
    throw new Error("a package document, not a single version (wrong URL?)");
  }
  throw new Error("not a package version document");
}

/** Whether a body is a single-version metadata document — `name` + `version` +
 * a `dist.tarball` (a full packument has none of the latter two). The digest
 * fields beside the tarball are optional, but a present one must be a string:
 * they are read as such when the tarball is verified, and this is the one place
 * a document's shape is judged (before it can be cached). */
function isVersionMetadata(response: Record<string, unknown>): response is INPMPackageMetadata & Record<string, unknown> {
  const meta = response as unknown as INPMPackageMetadata;
  return (
    typeof meta.name === "string" &&
    typeof meta.version === "string" &&
    typeof meta.dist === "object" &&
    meta.dist !== null &&
    typeof meta.dist.tarball === "string" &&
    isOptionalString(meta.dist.integrity) &&
    isOptionalString(meta.dist.shasum)
  );
}

/** Whether an optional document field is absent or a string — "if it's there,
 * it must be usable". */
function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

export function isSemverConstraint(text: string): boolean {
  try {
    SEMVER.parseConstraint(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Split an npm `name:version` identity on its **last** colon into the package
 * name and the version tail (a constraint on a read, an exact version on a
 * publish — the caller validates which). Returns undefined when there is no
 * version (no colon, or a leading one), so the caller reports that in its own
 * terms. Operates on the literal path prefix, so a trailing glob/projection is
 * ignored. Shared by requirement parsing (read) and coordinate parsing (publish).
 */
export function splitNameVersion(name: Name): { identifier: string; version: string } | undefined {
  /* A sole trailing glob is folded back into the written text: past the last
   * ':' of a requirement a pattern has no meaning, so the lexer's glob reading
   * of `pkg:1.4.2?` (the override marker) or `pkg:1.14.*` (an x-range) is
   * reversed here — the one place that knows the tail is a version. */
  const prefix = name.getLiteralWithGlobTail() ?? name.getLiteralPathPrefix();
  const idx = prefix.lastIndexOf(":");
  if (idx <= 0) {
    return undefined;
  }
  return { identifier: prefix.substring(0, idx), version: prefix.substring(idx + 1) };
}

/**
 * Split an npm reference name into its identity (`name:version`) and an optional
 * projection into the resolved package. Since neither `:` nor `/` is legal in a
 * registry version, the identity ends at the first `:` or `/` after the
 * `name:version` separator; the remainder (plus any trailing glob) is the
 * projection, named per the written-name rule (`:` strips, `/` retains). A pure
 * parse — no resolution (the split behind NPMRepository.getRepositoryRef).
 */
export function splitNpmReference(name: Name): { requirement: Name; projection?: IProjection } {
  const lit = name.getLiteralPrefix();
  const firstColon = lit.indexOf(":");
  if (firstColon === -1) {
    return { requirement: name }; // no version — parseRequirement reports it
  }
  const nextColon = lit.indexOf(":", firstColon + 1);
  const nextSlash = lit.indexOf("/", firstColon + 1);
  const boundary = nextColon === -1 ? nextSlash : nextSlash === -1 ? nextColon : Math.min(nextColon, nextSlash);
  if (boundary === -1) {
    return { requirement: name }; // identity runs to the end; no projection
  }
  const prefix = lit[boundary] === "/" ? lit.substring(0, boundary) + "/" : "";
  return { requirement: Name.fromLiteral(lit.substring(0, boundary)), projection: { pattern: name.substring(boundary + 1), prefix } };
}

/**
 * The requirement an npm reference identity declares, read off its own
 * `name:version` — the version slot may carry an override marker (a trailing
 * `?` permits a nested alternate, `!` forces the version), exact versions only
 * (a ranged override would reintroduce registry-time nondeterminism).
 */
export function parseNpmRequirement(name: Name): Requirement {
  const split = splitNameVersion(name);
  if (!split) {
    throw new Error(
      `Missing version in package reference '${name.getLiteralPathPrefix()}' (expected '<name>:<version-or-range>')`
    );
  }
  const { identifier: pkg, version: written } = split;
  const { text: constraint, override } = splitOverrideMarker(written);
  if (override !== undefined) {
    if (SEMVER.exactVersion?.(constraint) === undefined) {
      throw attachHelp(
        new Error(`'${written}' is not a valid override for '${pkg}': the '${written.at(-1)}' marker needs an exact version`),
        "markers sanction one concrete version: '@npm:pkg:1.4.2?' permits a nested alternate, '@npm:pkg:2.0.0!' forces the version"
      );
    }
    return { pkg, constraint, override };
  }
  if (!isSemverConstraint(constraint)) {
    throw attachHelp(
      new Error(`'${constraint}' is not a valid version constraint for '${pkg}'`),
      "dist-tags such as 'latest' are not supported: pin a version or range instead"
    );
  }
  return { pkg, constraint };
}

const PACKAGE_JSON = "package.json";

/**
 * Read package content as the npm package its manifest declares — the
 * {@link PackageFormat.readContentPackage} of the npm ecosystem, and the whole
 * of npm's contribution to a `repository_group` content route: the
 * `package.json` at the content root supplies the identity, version and
 * requirements (the shared {@link declaredDependencies} fold — regular deps
 * plus non-optional peers). `optionalDependencies` are dropped: their os/cpu
 * gates live in each *dependency's* own metadata — with whatever registry that
 * name routes to, which a manifest read cannot ask — and npm's optional
 * contract is exactly that absence is tolerated.
 */
function readNpmContentPackage(files: FileSet): Computable<IContentPackage<SemverVersion>> {
  const manifestFile = files.getFile(PACKAGE_JSON);
  if (!manifestFile) {
    return Computable.reject(
      attachHelp(
        new Error(`no ${PACKAGE_JSON} at the content root`),
        "the content must be the package's own root: project into an archive with ':*:**' " +
          "(a git/npm tarball wraps the package in one root directory), or into a directory with ':**'"
      )
    );
  }
  return manifestFile.readString().then(text => {
    const manifest = parseJson(text, PACKAGE_JSON, toJsonObject);
    if (typeof manifest.version !== "string") {
      throw attachHelp(
        new Error(`${PACKAGE_JSON} declares no version`),
        "a content-served package needs a version to take part in version selection — declare one in the manifest"
      );
    }
    return {
      name: typeof manifest.name === "string" ? manifest.name : undefined,
      version: parseVersion(manifest.version),
      requirements: declaredDependencies(manifest).required,
    };
  });
}

/**
 * The name + exact version an npm publish coordinate assigns, re-parsed from
 * the written name (an address is carried as its Name; each consumer parses
 * afresh, as the read side does with reference names). A coordinate pins an
 * exact version, unlike a read requirement's range.
 */
export function parseNpmPublishCoordinate(ref: Name): NpmPublishIdentity {
  const split = splitNameVersion(ref);
  if (!split) {
    const literal = ref.toString();
    throw new Error(`publish coordinate '${literal}' must name a version (e.g. ${literal}:1.0.0)`);
  }
  const { identifier: name, version } = split;
  try {
    parseVersion(version);
  } catch {
    throw new Error(`publish coordinate '${name}' must pin an exact version, got '${version}'`);
  }
  return { name, version };
}

/**
 * The npm ecosystem's {@link PackageFormat} — ONE shared instance: every npm
 * registry holds this object, and sharing it is what admits registries to one
 * `repository_group` (the homogeneity check is object identity). The
 * resolution tag names the persisted-resolution memo shape; bump it when the
 * resolution computation or the document changes behavior.
 */
export const NPM_FORMAT: PackageFormat<SemverVersion, SemverConstraint> = {
  ...SEMVER,
  resolutionTag: "npm:resolve:17",
  splitReference: splitNpmReference,
  parseRequirement: parseNpmRequirement,
  parsePublishCoordinate: parseNpmPublishCoordinate,
  readContentPackage: readNpmContentPackage,
  makeRunnable: makeNpmRunnable,
};

/**
 * npm tarballs wrap the package contents in a single root directory
 * (conventionally "package/", but not reliably so); strip it, so the stored
 * package's files are named relative to the package root.
 */
export function stripArchiveRoot(files: FileSet): FileSet {
  return files.remap(name => {
    const idx = name.indexOf("/");
    return idx === -1 ? undefined : name.substring(idx + 1);
  });
}
