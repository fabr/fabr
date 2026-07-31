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
 * resolution (MVS), materialization, and caching, and delegates every format
 * concern here.
 */

import {
  attachHelp,
  Computable,
  FileSet,
  HttpResponse,
  IntegrityError,
  IProjection,
  isCanonicalFileName,
  isJsonObject,
  Name,
  parseJson,
  NpmPlatform,
  SEMVER,
  sendRequest,
} from "@fabr-build/core";
import { otpChallengeOf, OtpProvider } from "./NPMAuth";
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
 * those fields through the normalizer that owns each one — {@link gateEntries},
 * {@link dependencyBlock}, {@link optionalPeers} — never by asserting the shape
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
 * A manifest dependency block (`dependencies`, `optionalDependencies`, …) as a
 * name→constraint map. npm normalizes away anything that isn't an object of
 * strings — `"dependencies": []` is published and means "none" — and so do we:
 * a block that isn't an object, and any entry whose constraint isn't a string,
 * contributes nothing. (Reading them positionally instead would manufacture
 * requirements on packages named `0`, `1`, … that no registry can resolve.)
 */
export function dependencyBlock(block: unknown): Map<string, string> {
  const entries = new Map<string, string>();
  if (isJsonObject(block)) {
    for (const [name, constraint] of Object.entries(block)) {
      if (typeof constraint === "string") {
        entries.set(name, constraint);
      }
    }
  }
  return entries;
}

/** The peers a `peerDependenciesMeta` block marks `optional: true`. */
export function optionalPeers(block: unknown): Set<string> {
  const names = new Set<string>();
  if (isJsonObject(block)) {
    for (const [name, flags] of Object.entries(block)) {
      if (isJsonObject(flags) && flags.optional === true) {
        names.add(name);
      }
    }
  }
  return names;
}

/** The dependency-manifest fields whose entries can name a release co-member. */
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

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
const SRI_ALGORITHMS = ["sha512", "sha384", "sha256"] as const;

/** The digest a registry's `dist` metadata promises for a tarball: the strongest
 * SRI in `dist.integrity` (base64), else the legacy sha1 `dist.shasum` (hex).
 * Undefined when `dist` carries neither — nothing to verify against. */
export function expectedTarballDigest(dist: {
  integrity?: string;
  shasum?: string;
}): { algorithm: string; encoding: "base64" | "hex"; value: string } | undefined {
  if (dist.integrity) {
    const entries = dist.integrity.trim().split(/\s+/);
    for (const algorithm of SRI_ALGORITHMS) {
      const match = entries.find(entry => entry.startsWith(`${algorithm}-`));
      if (match) {
        return { algorithm, encoding: "base64", value: match.slice(algorithm.length + 1) };
      }
    }
  }
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
  const expected = expectedTarballDigest(dist);
  const hash = expected ? crypto.createHash(expected.algorithm) : undefined;
  const hashing = new Transform({
    transform(chunk, _encoding, callback): void {
      hash?.update(chunk);
      callback(undefined, chunk);
    },
  });
  const verify = (): void => {
    if (!expected || !hash) {
      return;
    }
    const actual = hash.digest(expected.encoding);
    if (actual !== expected.value) {
      throw new IntegrityError(url, expected.algorithm, expected.value, actual);
    }
  };
  return { hashing, verify };
}

/**
 * Rewrite the built manifest for publication: assign the coordinate's name/version,
 * and rewrite any dependency that names a release co-member to that member's
 * assigned version. Returns a fresh object (never mutates the input).
 */
export function rewriteManifest(
  manifest: Record<string, unknown>,
  coordinate: NpmPublishIdentity,
  memberVersions: ReadonlyMap<string, string>
): Record<string, unknown> {
  /* The assigned identity leads (a versionless built manifest has no `version`
   * to overwrite in place — appending it last would read oddly). */
  const result: Record<string, unknown> = Object.assign(Object.create(null), {
    name: coordinate.name,
    version: coordinate.version,
  });
  for (const [key, value] of Object.entries(manifest)) {
    if (!(key in result)) {
      result[key] = value;
    }
  }
  for (const field of DEPENDENCY_FIELDS) {
    const deps = result[field];
    if (isJsonObject(deps)) {
      /* A peerDependency pins exact; the rest take a caret range (see
       * {@link rewriteCoMemberField}). */
      result[field] = rewriteCoMemberField(deps, memberVersions, field === "peerDependencies");
    }
  }
  return result;
}

/**
 * Rewrite one dependency block's co-member entries to the members' assigned
 * versions. A `peerDependencies` entry pins **exact**: a peer is singleton-by-
 * identity (a `provided_deps` peer), so the consumer must
 * supply the EXACT co-member instance the package was built against, not merely
 * a semver-compatible one — a range can't express "the same loaded module".
 * Every other field takes a caret range. (A stable inter-package ABI might later
 * widen the others too; the peer stays exact regardless, since identity-compat
 * is strictly stronger than API-compat.)
 */
function rewriteCoMemberField(
  deps: Record<string, unknown>,
  memberVersions: ReadonlyMap<string, string>,
  exact: boolean
): Record<string, unknown> {
  /* Entries fabr doesn't rewrite are passed through as published, whatever they
   * are — this rewrites a manifest, it doesn't validate one. */
  const rewritten: Record<string, unknown> = { ...deps };
  for (const dep of Object.keys(rewritten)) {
    const memberVersion = memberVersions.get(dep);
    if (memberVersion !== undefined) {
      rewritten[dep] = exact ? memberVersion : `^${memberVersion}`;
    }
  }
  return rewritten;
}

/** The release members this manifest depends on (for deps-first upload ordering). */
export function memberDependencies(manifest: Record<string, unknown>, memberNames: ReadonlySet<string>): string[] {
  const names = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    for (const dep of dependencyBlock(manifest[field]).keys()) {
      if (memberNames.has(dep)) {
        names.add(dep);
      }
    }
  }
  return [...names];
}

/* The manifest fields whose entries the consumer's install actually resolves —
 * where an unresolvable version is fatal. devDependencies deliberately excluded
 * (never installed from a published package). */
const INSTALLED_DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];

/**
 * The install-relevant dependencies of a rewritten manifest that remain
 * unresolvable — a `*` constraint after co-member rewriting. A built-but-versionless
 * dep declares `*` (its version exists only at publish); if the sync doesn't
 * publish it (or publishes it at several versions, so no single rewrite exists),
 * the `*` survives to here — and a published package with an unconstrained
 * dependency is broken for every consumer, so the caller must reject it.
 */
export function unresolvableDependencies(manifest: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const field of INSTALLED_DEPENDENCY_FIELDS) {
    for (const [dep, constraint] of dependencyBlock(manifest[field])) {
      if (constraint === "*") {
        names.push(dep);
      }
    }
  }
  return names;
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
 * The package owning a path within a mounted closure, per the node_modules
 * naming convention consumers mount packages with ("@scope/name/..." or
 * "name/...").
 */
export function npmPackageOfPath(path: string): string {
  const parts = path.split("/");
  return parts[0].startsWith("@") && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0];
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
  const prefix = name.getLiteralPathPrefix();
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
