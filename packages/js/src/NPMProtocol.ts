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
 * The npm registry's formats: metadata documents, platform gates, reference
 * and version syntax, publish envelopes and tarball names, plus the publish,
 * visibility and trusted-publishing requests. Registry auth is in NPMAuth.ts;
 * the transport and caching are NPMRepository.ts's.
 */

import {
  Computable,
  FabrError,
  FileSet,
  HttpResponse,
  ExpectedDigest,
  IProjection,
  isCanonicalFileName,
  isJsonObject,
  markerOf,
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
  markerOnProjection,
  sendRequest,
  toJsonObject,
  ILicense,
  IVersionMetadata,
  IdentityProvider,
  SerializedBundle,
} from "@fabr-build/core";
import { otpChallengeOf, OtpProvider } from "./NPMAuth";
import { makeNpmRunnable } from "./JSPackage";
import { declaredDependencies } from "./PackageJson";
import { installedPackageExtensions } from "./PackageExtensions";
import * as crypto from "node:crypto";

export interface ISignature {
  keyid: string;
  sig: string;
}

/**
 * A registry version document. Only the fields {@link parseMetadataResponse}
 * validates are typed; every other field is `unknown`, since npm publishes
 * shapes its docs do not describe (`"os": "darwin"` for a one-entry gate,
 * `"dependencies": []` for none). Read those fields through the function that
 * normalizes each one ({@link gateEntries} here, `dependencyBlock` and
 * `optionalPeers` in PackageJson.ts), never by asserting a shape.
 */
export interface INPMPackageMetadata {
  dependencies?: unknown;
  /**
   * Dependencies npm installs where it can and does without otherwise. Most are
   * platform variants of a native binary (esbuild's `@esbuild/<platform>`),
   * each gated by its own package's `os`/`cpu`; only those matching the target
   * platform are kept.
   */
  optionalDependencies?: unknown;
  /** Peer dependencies, read as provided requirements (see
   * NPMRepository.getRequirements). */
  peerDependencies?: unknown;
  /** Per-peer flags. A peer marked `optional: true` is never installed for the
   * package, but is still a requirement (`provided: "optional"`), bound to
   * what a consumer provides. */
  peerDependenciesMeta?: unknown;
  /**
   * The platforms the package installs on, in Node's `process.platform` and
   * `process.arch` values (and `glibc`/`musl` for `libc`): each an allow-list
   * in which a leading `!` negates an entry, absent or empty meaning any.
   * Checked against the TARGET platform by {@link platformGateAdmits}.
   */
  os?: unknown;
  cpu?: unknown;
  libc?: unknown;
  dist: {
    fileCount?: number;
    /** A string where present: {@link isVersionMetadata} checks it. */
    integrity?: string;
    "npm-signature"?: string;
    shasum?: string;
    signatures?: ISignature[];
    tarball: string;
    unpackedSize?: number;
  };
  name: string;
  version: string;
  /** The licence declared, an SPDX expression where the manifest follows npm's
   * docs; read by {@link versionMetadataOf}. Absent from an abbreviated packument. */
  license?: unknown;
  /** The licence in its older spelling: a list of `{ type, url }`. */
  licenses?: unknown;
  /* Fields fabr does not read are left untyped. */
}

/** The os/cpu/libc gates of a manifest, as written. */
export type PlatformGates = { os?: unknown; cpu?: unknown; libc?: unknown };

/**
 * Read a gate as a list of entries: the list as written, or a bare string as a
 * one-entry list (`"os": "darwin"`, which npm accepts). A non-string entry, or
 * a value of any other type, contributes no entry.
 */
function gateEntries(gate: unknown): string[] {
  if (typeof gate === "string") {
    return [gate];
  }
  return Array.isArray(gate) ? gate.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * @return true if `value` passes `gate`, otherwise false, as npm-install-checks'
 * `checkList` judges an os/cpu gate. An empty or absent gate, or one whose sole
 * entry is `"any"`, admits every value. Otherwise a value is refused where an
 * entry `!value` names it, and must appear among the entries without `!`
 * unless there are none. An undefined `value` (the platform does not say)
 * passes no other gate. The gate is read by {@link gateEntries}.
 */
export function platformGateAdmits(gate: unknown, value: string | undefined): boolean {
  const entries = gateEntries(gate);
  if (entries.length === 0) {
    return true;
  }
  /* As in npm, "any" admits everything only as the sole entry; among others it
   * is a platform name that matches nothing. */
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
 * @return true if a package declaring these os/cpu/libc gates may run on
 * `target`, otherwise false.
 */
export function matchesTargetPlatform(meta: PlatformGates, target: NpmPlatform): boolean {
  return (
    platformGateAdmits(meta.os, target.os) && platformGateAdmits(meta.cpu, target.cpu) && platformGateAdmits(meta.libc, target.libc)
  );
}

/**
 * Explain why a package declaring these os/cpu/libc gates cannot run on
 * `target`, one clause per failing gate, or return undefined if it can. Used
 * for a non-optional dependency or a direct requirement, which npm refuses as
 * EBADPLATFORM.
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

/** The package name and exact version a `name:version` publish coordinate
 * assigns. */
export interface NpmPublishIdentity {
  readonly name: string;
  readonly version: string;
}

/**
 * Get the tarball name a publish sends: `<name>-<version>.tgz` with the scope
 * included (`@fabr/core-0.1.tgz`), as `libnpmpublish` names it. `npm pack`'s
 * file name and the registry's served name are spelled differently.
 */
export function tarballBasename(name: string, version: string): string {
  return `${name}-${version}.tgz`;
}

/**
 * Read what a version's own document publishes besides its files
 * ({@link IVersionMetadata}): its licence — `license` as a string or, in
 * older manifests, an object or a `licenses` list of `{ type, url }` — and the
 * strongest digest `dist` carries.
 */
export function versionMetadataOf(meta: INPMPackageMetadata): IVersionMetadata {
  const licenses: ILicense[] = [];
  const declared = (value: unknown): void => {
    if (typeof value === "string" && value.trim() !== "") {
      licenses.push({ text: value.trim() });
    } else if (isJsonObject(value) && typeof value.type === "string") {
      licenses.push({ text: value.type, ...(typeof value.url === "string" ? { url: value.url } : {}) });
    }
  };
  declared(meta.license);
  (Array.isArray(meta.licenses) ? meta.licenses : [meta.licenses]).forEach(declared);
  const digest = expectedTarballDigest(meta.dist);
  return { licenses, hashes: digest === undefined ? [] : [digest] };
}

/** Get the digest a version's `dist` metadata gives for its tarball: the
 * strongest SRI hash in `dist.integrity` (base64), else the sha1
 * `dist.shasum` (hex), else undefined. */
export function expectedTarballDigest(dist: { integrity?: string; shasum?: string }): ExpectedDigest | undefined {
  const sri = dist.integrity ? parseIntegrity(dist.integrity) : undefined;
  if (sri) {
    return sri;
  }
  /* Many older versions carry only `shasum`. */
  if (dist.shasum) {
    return { algorithm: "sha1", encoding: "hex", value: dist.shasum.toLowerCase() };
  }
  return undefined;
}

/**
 * The access a repository's publishes request for a package. The registry
 * reads it on a package's first publish only. `null` leaves it to the
 * registry's default (npmjs: restricted for a scoped package, a paid feature).
 */
export type PublishAccess = "public" | "restricted" | null;

/** Convert a declared `access` property value: absent is null, and `private`
 * is a synonym for npm's `restricted`. Throws for any other value. */
export function toPublishAccess(value: string | undefined): PublishAccess {
  if (value === undefined) {
    return null;
  } else if (value === "private" || value === "restricted") {
    return "restricted";
  } else if (value === "public") {
    return value;
  }
  throw new FabrError(`invalid access value ${JSON.stringify(value)} (expected "public" or "private"/"restricted")`);
}

/** The outcome of offering a CI identity for a package's publish: the registry's
 * publish token for it, or the registry's reason for refusing one. */
export type TrustedPublishing = { token: string } | { refused: string };

/**
 * Exchange the CI job's identity for a token publishing `name` to the registry
 * at `registryUrl` (npm's trusted publishing): an identity token `provider`
 * issues for the audience `npm:<registry host>`, posted to the registry's
 * exchange endpoint.
 *
 * A non-2xx answer other than 429 or 5xx (no trusted publisher configured for
 * the package, or one naming another repository or workflow) is returned as
 * `refused`, with the registry's message and the status. Rejects where the
 * identity token cannot be had, the registry cannot be reached, or it answers
 * 429 or 5xx.
 */
export function exchangeIdentity(registryUrl: string, name: string, provider: IdentityProvider): Computable<TrustedPublishing> {
  const escapedName = name.replace(/\//g, "%2f");
  return provider
    .token(`npm:${new URL(registryUrl).hostname}`)
    .then(idToken =>
      sendRequest(`${registryUrl}/-/npm/v1/oidc/token/exchange/package/${escapedName}`, {
        method: "POST",
        headers: { authorization: `Bearer ${idToken}`, accept: "application/json" },
      })
    )
    .then(({ statusCode, body }): TrustedPublishing => {
      if (statusCode >= 200 && statusCode < 300) {
        return { token: parseJson(body, `trusted publishing response for ${name} from ${registryUrl}`, toExchangedToken) };
      }
      if (statusCode === 429 || statusCode >= 500) {
        throw new FabrError(`trusted publishing for ${name} at ${registryUrl} failed (${statusCode}): ${registryMessage(body)}`);
      }
      return { refused: `${registryMessage(body)} (${statusCode})` };
    });
}

/** Make the envelope attachment carrying a provenance bundle: its JSON as text. */
function provenanceAttachment(bundle: SerializedBundle): { content_type: string; data: string; length: number } {
  const data = JSON.stringify(bundle);
  return { content_type: bundle.mediaType, data, length: data.length };
}

/**
 * Look up whether the package `name` on the registry at `registryUrl` is
 * public, asking with `headers`' credential. Answers undefined where the
 * registry answers 404, and rejects on any other non-2xx answer.
 */
export function packageVisibility(
  registryUrl: string,
  name: string,
  headers: Record<string, string>
): Computable<boolean | undefined> {
  return sendRequest(`${registryUrl}/-/package/${name.replace(/\//g, "%2f")}/visibility`, {
    method: "GET",
    headers: { ...headers, accept: "application/json" },
  }).then(({ statusCode, body }) => {
    if (statusCode === 404) {
      return undefined;
    }
    if (statusCode < 200 || statusCode >= 300) {
      throw new FabrError(`reading the visibility of ${name} at ${registryUrl} failed (${statusCode}): ${registryMessage(body)}`);
    }
    return parseJson(body, `visibility of ${name} from ${registryUrl}`, json => toJsonObject(json).public === true);
  });
}

/** Convert the exchange's response, `{ "token": "<token>" }`, to the token. */
function toExchangedToken(json: unknown): string {
  const token = toJsonObject(json).token;
  if (typeof token !== "string" || token === "") {
    throw new FabrError("expected a 'token' string");
  }
  return token;
}

/** Get the message of a registry's error response: its JSON `message` or
 *  `error`, else the body as text. */
function registryMessage(body: Buffer): string {
  const text = body.toString("utf8").trim();
  try {
    const json: unknown = JSON.parse(text);
    if (isJsonObject(json)) {
      for (const field of ["message", "error"]) {
        const message = json[field];
        if (typeof message === "string") {
          return message;
        }
      }
    }
  } catch {
    /* Not JSON: the text is the message. */
  }
  return text;
}

/**
 * Publish a packaged tarball and its manifest to an npm registry. Sends the
 * envelope `libnpmpublish` sends (the manifest completed with `_id` and
 * `dist`: sha512 integrity, sha1 shasum and the tarball's registry URL,
 * wrapped with `dist-tags`, `versions`, `access` and `_attachments`) as a PUT
 * to the escaped package name, with `authHeaders`' credential. `provenance`,
 * a signed provenance bundle for the tarball, is attached beside it.
 *
 * - Answers `"published"` on a 2xx answer.
 * - Answers `"already-synced"` where the version is already published: a 409,
 *   or npmjs's 403 "cannot publish over".
 * - A second-factor challenge is answered through `otp` and the PUT sent again
 *   with the one-time password it gives, at most twice; `otp` is told the
 *   password last refused.
 * - Rejects on any other non-2xx answer, with the registry's response body;
 *   npmjs's refusal of a restricted package carries help naming
 *   `access = public`.
 */
export function publishToRegistry(
  registryUrl: string,
  coordinate: NpmPublishIdentity,
  tarball: Buffer,
  manifest: Record<string, unknown>,
  authHeaders: Record<string, string>,
  access: PublishAccess = null,
  otp?: OtpProvider,
  provenance?: SerializedBundle
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
      ...(provenance ? { [`${name}-${version}.sigstore`]: provenanceAttachment(provenance) } : {}),
    },
  };
  const escapedName = name.replace(/\//g, "%2f");
  /* Send both npm-auth-type and npm-command: the registry offers the browser
   * (passkey) challenge, with authUrl/doneUrl in its body, only to a client
   * sending both, and otherwise answers a passkey account with an "upgrade
   * your client" error. It does not read the user-agent. */
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
    /* The version is already published: a 409, or npmjs's 403 "You cannot
     * publish over the previously published versions". */
    if (
      response.statusCode === 409 ||
      (response.statusCode === 403 && response.body.toString("utf8").includes("cannot publish over"))
    ) {
      return "already-synced";
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const detail = response.body.toString("utf8");
      const error = new FabrError(`publishing ${name}@${version} to ${registryUrl} failed (${response.statusCode}): ${detail}`);
      /* npmjs's refusal of a restricted scoped publish: "You must sign up for
       * private packages". */
      if (detail.includes("private packages")) {
        error.withHelp(
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
 * Parse a registry's version document: one fetched, before it is cached, and
 * one read back from the cache. `key` names the document in an error.
 *
 * Returns a single-version document (`name`, `version` and `dist.tarball`,
 * any `dist.integrity` and `dist.shasum` strings, a `name` usable as a file
 * name). Throws for a full packument (one with `versions`: the wrong URL), and
 * for anything else (an error body, non-JSON, an HTML page). HTTP failures are
 * reported before this is called.
 */
export function parseMetadataResponse(data: string | Buffer, key: string): INPMPackageMetadata {
  return parseJson(data, `response from NPM repository for '${key}'`, toVersionMetadata);
}

/** @return `meta` with only the fields fabr reads, as a packument entry is
 * kept: the name, version, dependency blocks and platform gates, and of
 * `dist` the tarball URL and its digests. Absent fields stay absent. */
function readFieldsOf(meta: INPMPackageMetadata): INPMPackageMetadata {
  const { name, version, dist, dependencies, optionalDependencies, peerDependencies, peerDependenciesMeta, os, cpu, libc } = meta;
  const { tarball, integrity, shasum } = dist;
  const read: Omit<INPMPackageMetadata, "name" | "version" | "dist"> = {
    dependencies,
    optionalDependencies,
    peerDependencies,
    peerDependenciesMeta,
    os,
    cpu,
    libc,
  };
  return {
    name,
    version,
    dist: { tarball, ...(integrity === undefined ? {} : { integrity }), ...(shasum === undefined ? {} : { shasum }) },
    ...Object.fromEntries(Object.entries(read).filter(([, value]) => value !== undefined)),
  };
}

/**
 * Convert a packument to its published versions, by version, each reduced to
 * the fields fabr reads ({@link readFieldsOf}). An entry that is not usable
 * version metadata is left out, so that version is fetched from its own
 * document when asked for. Throws where the document has no `versions` object
 * (an error body, or the wrong URL).
 */
export function toPackumentVersions(json: unknown): Map<string, INPMPackageMetadata> {
  if (!isJsonObject(json) || !isJsonObject(json.versions)) {
    throw new FabrError("no versions");
  }
  const versions = new Map<string, INPMPackageMetadata>();
  for (const [version, entry] of Object.entries(json.versions)) {
    try {
      versions.set(version, readFieldsOf(toVersionMetadata(entry)));
    } catch {
      /* Looked up from its own document when asked for. */
    }
  }
  return versions;
}

/** Convert a version document to metadata, or throw the reason it is unusable
 * (the caller names the document). See {@link parseMetadataResponse}. */
function toVersionMetadata(json: unknown): INPMPackageMetadata {
  if (!isJsonObject(json)) {
    throw new FabrError("expected a JSON object");
  }
  if (isVersionMetadata(json)) {
    /* The document's `name` becomes the package's name, and so a path it is
     * installed at: refuse one that is not a canonical file name. Dependency
     * names need no check: each is only a lookup key, and the document it
     * finds is checked here in turn. */
    if (!isCanonicalFileName(json.name)) {
      throw new FabrError(`package name ${JSON.stringify(json.name)} is not usable as an identity`);
    }
    return json;
  }
  if ("versions" in json) {
    throw new FabrError("a package document, not a single version (wrong URL?)");
  }
  throw new FabrError("not a package version document");
}

/** @return true if a document is a single version's metadata, otherwise false:
 * it has a string `name` and `version`, a `dist` object with a string
 * `tarball`, and `dist.integrity` and `dist.shasum` each absent or a string. */
function isVersionMetadata(response: Record<string, unknown>): response is INPMPackageMetadata & Record<string, unknown> {
  const { name, version, dist } = response;
  return (
    typeof name === "string" &&
    typeof version === "string" &&
    isJsonObject(dist) &&
    typeof dist.tarball === "string" &&
    isOptionalString(dist.integrity) &&
    isOptionalString(dist.shasum)
  );
}

/** @return true if an optional document field is absent or a string, otherwise
 * false. */
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
 * Split a written npm `name:version` on its last colon into the package name
 * and the version text, which the caller validates (a constraint in a
 * reference, an exact version in a publish coordinate). Returns undefined
 * where there is no version: no colon, or only a leading one.
 */
function splitWrittenNameVersion(written: string): { identifier: string; version: string } | undefined {
  const idx = written.lastIndexOf(":");
  if (idx <= 0) {
    return undefined;
  }
  return { identifier: written.substring(0, idx), version: written.substring(idx + 1) };
}

/**
 * Split an npm reference name into its requirement (`name:version`) and an
 * optional projection into the package. The requirement ends at the first `:`
 * or `/` after the first colon, neither being legal in a version; the rest is
 * the projection, whose names keep the prefix after a `/` and drop it after a
 * `:`. Throws where a requirement with a projection ends in a `?` or `!`
 * marker. Nothing is resolved.
 */
export function splitNpmReference(name: Name): Requirement & { projection?: IProjection } {
  /* Read the whole written text, not its literal prefix: what the lexer read as
   * a glob in the version (`pkg:1.4.2?`, `pkg:1.14.*`) is version text. */
  const written = name.toBaseString();
  const firstColon = written.indexOf(":");
  const nextColon = firstColon === -1 ? -1 : written.indexOf(":", firstColon + 1);
  const nextSlash = firstColon === -1 ? -1 : written.indexOf("/", firstColon + 1);
  const boundary = nextColon === -1 ? nextSlash : nextSlash === -1 ? nextColon : Math.min(nextColon, nextSlash);
  if (boundary === -1) {
    /* No projection. A missing version is validateRequirement's to report. */
    return npmIdentity(written);
  }
  const prefix = written[boundary] === "/" ? written.substring(0, boundary) + "/" : "";
  const identity = npmIdentity(written.substring(0, boundary));
  if (identity.versionConstraint?.endsWith("?") === true || identity.versionConstraint?.endsWith("!") === true) {
    throw markerOnProjection(name);
  }
  return { ...identity, projection: { pattern: name.substring(boundary + 1), prefix } };
}

/** Split a written `name:version` into a requirement on the package, its
 * version constraint the text after the last colon, or none where there is no
 * version. */
function npmIdentity(written: string): Requirement {
  const split = splitWrittenNameVersion(written);
  if (!split) {
    return { name: written, versionConstraint: undefined };
  }
  return { name: split.identifier, versionConstraint: split.version };
}

/**
 * Check an npm requirement, throwing where it is unusable: it must state a
 * valid semver version or range (a dist-tag is refused). A `?` or `!` marker
 * needs an exact version, except that a `?` may state none, sanctioning every
 * version of the package.
 */
export function validateNpmRequirement({ name: pkg, versionConstraint: constraint, override }: Requirement): void {
  if (constraint === undefined && override === "alternate") {
    return;
  }
  if (constraint === undefined) {
    throw new FabrError(`Missing version in package reference '${pkg}' (expected '<name>:<version-or-range>')`);
  }
  if (override !== undefined) {
    if (SEMVER.exactVersion?.(constraint) === undefined) {
      const marker = markerOf(override);
      throw new FabrError(
        `'${constraint}${marker}' is not a valid override for '${pkg}': the '${marker}' marker needs an exact version`
      ).withHelp(
        "'@npm:pkg:1.4.2?' permits that version as a nested alternate, '@npm:pkg?' permits every version, '@npm:pkg:2.0.0!' forces the version"
      );
    }
    return;
  }
  if (!isSemverConstraint(constraint)) {
    throw new FabrError(`'${constraint}' is not a valid version constraint for '${pkg}'`).withHelp(
      "dist-tags such as 'latest' are not supported: pin a version or range instead"
    );
  }
}

const PACKAGE_JSON = "package.json";

/**
 * Read package content as the npm package its manifest declares (npm's
 * {@link PackageFormat.readContentPackage}, used by a `repository_group`
 * content route). The `package.json` at the content root gives the name,
 * version and requirements: {@link declaredDependencies} over the manifest
 * with the package extensions applied: dependencies and peers, leaving out
 * every name `optionalDependencies` lists. Rejects where there is no `package.json` at the root
 * or it declares no version.
 */
function readNpmContentPackage(files: FileSet): Computable<IContentPackage<SemverVersion>> {
  const manifestFile = files.getFile(PACKAGE_JSON);
  if (!manifestFile) {
    return Computable.reject(
      new FabrError(`no ${PACKAGE_JSON} at the content root`).withHelp(
        "the content must be the package's own root: project into an archive with ':*:**' " +
          "(a git/npm tarball wraps the package in one root directory), or into a directory with ':**'"
      )
    );
  }
  return manifestFile.readString().then(text => {
    const manifest = parseJson(text, PACKAGE_JSON, toJsonObject);
    if (typeof manifest.version !== "string") {
      throw new FabrError(`${PACKAGE_JSON} declares no version`).withHelp(
        "a content-served package needs a version to take part in version selection — declare one in the manifest"
      );
    }
    const name = typeof manifest.name === "string" ? manifest.name : undefined;
    const version = parseVersion(manifest.version);
    return {
      name,
      version,
      requirements: declaredDependencies(installedPackageExtensions().extend(name, version, manifest)).required,
    };
  });
}

/**
 * Parse the name and exact version a written npm publish coordinate assigns,
 * throwing where it names no version or a version that is not exact.
 */
export function parseNpmPublishCoordinate(ref: Name): NpmPublishIdentity {
  const split = splitWrittenNameVersion(ref.toBaseString());
  if (!split) {
    const literal = ref.toString();
    throw new FabrError(`publish coordinate '${literal}' must name a version (e.g. ${literal}:1.0.0)`);
  }
  const { identifier: name, version } = split;
  try {
    parseVersion(version);
  } catch {
    throw new FabrError(`'${version}' is not an exact package version, which a publish coordinate for '${name}' must name`).withHelp(
      "write it as major.minor.patch (1.0.0), optionally followed by a prerelease (1.0.0-beta.1); a range cannot be published"
    );
  }
  return { name, version };
}

/**
 * The npm ecosystem's {@link PackageFormat}. Every npm registry holds this one
 * object: a `repository_group` admits registries whose formats are the same
 * object. Bump `resolutionTag` when what a resolution computes or its
 * persisted document changes. A peer dependency binds to the build's selection
 * of its package even outside its declared range (`providedMismatch:
 * "tolerate"`), as Yarn and pnpm install it (they warn).
 */
export const NPM_FORMAT: PackageFormat<SemverVersion, SemverConstraint> = {
  ...SEMVER,
  providedMismatch: "tolerate",
  name: "npm",
  resolutionTag: "npm:resolve:32",
  splitReference: splitNpmReference,
  validateRequirement: validateNpmRequirement,
  parsePublishCoordinate: parseNpmPublishCoordinate,
  readContentPackage: readNpmContentPackage,
  makeRunnable: (pkg, context) => makeNpmRunnable(context, pkg),
  purl: (name, version) => `pkg:npm/${name.split("/").map(encodeURIComponent).join("/")}@${encodeURIComponent(version)}`,
};
