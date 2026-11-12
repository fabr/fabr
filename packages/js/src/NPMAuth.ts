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
 * npm registry authentication: the credentials `.npmrc` configures (see
 * {@link NPMAuth}), and answering the second-factor challenge a publish from a
 * 2FA account receives, by browser or terminal prompt ({@link OtpSession},
 * {@link otpChallengeOf}). The publish request itself is in NPMProtocol.ts,
 * which is given the challenge answering as an {@link OtpProvider}.
 */

import * as os from "node:os";
import * as path from "node:path";

import {
  Computable,
  Credential,
  ExecutionContext,
  FabrError,
  HttpResponse,
  parseJson,
  sendRequest,
  toJsonObject,
  UserInteraction,
} from "@fabr-build/core";

/** The credentials `.npmrc` configures for one registry, in the order
 * {@link NPMAuth.getHeadersFor} prefers them. */
interface RegistryAuth {
  authToken?: string;
  /** Base64 `user:pass`, sent as-is. */
  auth?: string;
  username?: string;
  /** Base64-encoded password (npm's `_password`). */
  password?: string;
}

/** Substitute each `${VAR}` with the environment variable's value, or nothing
 *  where it is unset, as npm does (`_authToken=${NPM_TOKEN}`). */
function envSubstitute(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, name: string) => process.env[name] ?? "");
}

/**
 * Parse a `.npmrc` body into its entries by key: each `key = value` line, the
 * value's surrounding quotes stripped and each `${VAR}` substituted. Blank
 * lines, `#` and `;` comments, `[section]` headers and lines with no `=` are
 * skipped; a later entry of a key replaces an earlier one.
 */
export function parseNpmrc(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";") || line.startsWith("[")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    const value = envSubstitute(
      line
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "")
    );
    entries.set(key, value);
  }
  return entries;
}

/** @return the absolute path of the user's `~/.npmrc`. Read it through the
 *  execution's `absFileSource`, not `fs`. */
export function userNpmrcPath(): string {
  return path.join(os.homedir(), ".npmrc");
}

/**
 * The registry credentials a run's `.npmrc` files configure, and the
 * second-factor sessions of its publishes. Only the `//host/path/:` keys
 * (`_authToken`, `_auth`, `username`, `_password`) are read; registry and
 * scope settings such as `@scope:registry` are not.
 */
export class NPMAuth {
  /** Each registry's credentials, by its slash-terminated `//host/path/` key. */
  private readonly registries: Map<string, RegistryAuth>;
  /** Each registry's second-factor session, by registry URL, made on its first
   * challenge. */
  private readonly otpSessions = new Map<string, OtpSession>();

  constructor(entries: Map<string, string>) {
    this.registries = new Map();
    const authOf = (prefix: string): RegistryAuth => {
      /* End every key with `/`, so a key matches a URL only at a path boundary:
       * `//host/npm` must not match `//host/npm-other`. */
      const key = prefix.endsWith("/") ? prefix : `${prefix}/`;
      let auth = this.registries.get(key);
      if (!auth) {
        auth = {};
        this.registries.set(key, auth);
      }
      return auth;
    };
    for (const [key, value] of entries) {
      if (!key.startsWith("//")) {
        continue;
      }
      if (key.endsWith(":_authToken")) {
        authOf(key.slice(0, -":_authToken".length)).authToken = value;
      } else if (key.endsWith(":_auth")) {
        authOf(key.slice(0, -":_auth".length)).auth = value;
      } else if (key.endsWith(":username")) {
        authOf(key.slice(0, -":username".length)).username = value;
      } else if (key.endsWith(":_password")) {
        authOf(key.slice(0, -":_password".length)).password = value;
      }
    }
  }

  /**
   * Load a run's credentials: the user's `~/.npmrc` (through `absFileSource`,
   * unwatched) and the project's `.npmrc` (through `sourceFileSource`, so a
   * change to it is seen under watch), an entry of the project's replacing the
   * user's. Either file may be absent.
   */
  public static load(execution: ExecutionContext): Computable<NPMAuth> {
    return Computable.forAll(
      [
        execution.absFileSource.get(userNpmrcPath()).then(f => f?.readString()),
        execution.sourceFileSource.get(".npmrc").then(f => f?.readString()),
      ],
      NPMAuth.fromSources
    );
  }

  /**
   * Combine `.npmrc` bodies given in increasing precedence: a key in a later
   * body replaces the same key in an earlier one, so pass the user's before the
   * project's, as npm reads them. An absent body is skipped.
   */
  public static fromSources(...sources: (string | undefined)[]): NPMAuth {
    const entries = sources.filter((source): source is string => source !== undefined).flatMap(source => [...parseNpmrc(source)]);
    return new NPMAuth(new Map(entries));
  }

  /** Make the credential signing a request in with what {@link getHeadersFor} gives for its url. */
  public static credential(load: () => Computable<NPMAuth>): Credential {
    return { authorize: request => load().then(auth => new Map(Object.entries(auth.getHeadersFor(request.url)))) };
  }

  /**
   * Get the `Authorization` header to send with a request to `url`, from the
   * registry whose key is the longest prefix of the URL's `//host/path/`: its
   * `_authToken` as a bearer token, else `_auth` as basic, else `username` and
   * the base64 `_password` as basic. Empty where no key matches, the matching
   * one has no usable credential, or `url` does not parse.
   */
  public getHeadersFor(url: string): Record<string, string> {
    let target: string;
    try {
      const parsed = new URL(url);
      target = `//${parsed.host}${parsed.pathname}`;
    } catch {
      return {};
    }
    /* End the target with `/`, as every key is, so a key matches only at a path
     * boundary. */
    const scoped = target.endsWith("/") ? target : `${target}/`;
    let best: RegistryAuth | undefined;
    let bestLength = -1;
    for (const [prefix, auth] of this.registries) {
      if (scoped.startsWith(prefix) && prefix.length > bestLength) {
        best = auth;
        bestLength = prefix.length;
      }
    }
    if (!best) {
      return {};
    }

    if (best.authToken) {
      return { Authorization: `Bearer ${best.authToken}` };
    }
    if (best.auth) {
      return { Authorization: `Basic ${best.auth}` };
    }
    if (best.username !== undefined && best.password !== undefined) {
      const password = Buffer.from(best.password, "base64").toString("utf8");
      return { Authorization: `Basic ${Buffer.from(`${best.username}:${password}`).toString("base64")}` };
    }
    return {};
  }

  /**
   * Make the {@link OtpProvider} answering second-factor challenges from
   * `registryUrl` for a publish. Answers come from the registry's
   * {@link OtpSession}, shared by every publish of the run to that registry.
   * With no `interaction`, answering a challenge fails, with help naming the
   * credentials that publish without one.
   */
  public otpProvider(registryUrl: string, interaction: UserInteraction | undefined): OtpProvider {
    const session = this.sessionFor(registryUrl);
    return (challenge, rejected) => session.obtain(() => this.acquireSecondFactor(challenge, registryUrl, interaction), rejected);
  }

  private sessionFor(registryUrl: string): OtpSession {
    const existing = this.otpSessions.get(registryUrl);
    if (existing) {
      return existing;
    }
    const session = new OtpSession();
    this.otpSessions.set(registryUrl, session);
    return session;
  }

  /**
   * Ask the user for one second-factor answer. A challenge with `authUrl` and
   * `doneUrl` opens `authUrl` in the browser and polls `doneUrl` for the token,
   * which is single-use; any other challenge prompts for a one-time password,
   * which is reusable. Throws where there is no `interaction`.
   */
  private acquireSecondFactor(
    challenge: OtpChallenge,
    registryUrl: string,
    interaction: UserInteraction | undefined
  ): Computable<AcquiredOtp> {
    if (!interaction) {
      throw new FabrError(
        `publishing to ${registryUrl} requires a second factor (2FA), and this run has no terminal to authenticate on`
      ).withHelp(
        `re-run from an interactive terminal to authenticate with your passkey or one-time password, ` +
          `or supply a credential that publishes unattended (a granular access token in .npmrc, or trusted publishing from CI)`
      );
    }
    if (challenge.authUrl && challenge.doneUrl) {
      const doneUrl = replaceDoneUrlOrigin(challenge.doneUrl, registryUrl);
      return interaction
        .openUrl(challenge.authUrl, `Authenticate to ${registryUrl} in your browser`)
        .then(() => pollWebAuthToken(doneUrl, this.getHeadersFor(registryUrl)))
        .then(password => ({ password, reusable: false }));
    }
    return interaction
      .prompt(`Publishing to ${registryUrl} requires a one-time password.\nEnter OTP: `)
      .then(otp => ({ password: otp.trim(), reusable: true }));
  }
}

/**
 * A registry's demand for a second factor on a write (npm's `EOTP`). For an
 * account whose second factor is a passkey or security key it carries
 * `authUrl` and `doneUrl`; without them a typed one-time password is expected.
 */
export interface OtpChallenge {
  /** The browser page that authenticates the user (WebAuthn). */
  authUrl?: string;
  /** The URL polled for the token once the user has authenticated; see
   * {@link pollWebAuthToken}. */
  doneUrl?: string;
}

/**
 * Get the one-time password to answer an {@link OtpChallenge} with. `rejected`
 * is a password the registry just refused, which a provider holding it must
 * not give again.
 */
export type OtpProvider = (challenge: OtpChallenge, rejected?: string) => Computable<string>;

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** Read the `authUrl` and `doneUrl` of a challenge body, throwing where either
 * is not an http(s) URL. */
function toWebAuthUrls(json: unknown): { authUrl: string; doneUrl: string } {
  const doc = toJsonObject(json);
  const { authUrl, doneUrl } = doc;
  if (!isHttpUrl(authUrl) || !isHttpUrl(doneUrl)) {
    throw new FabrError("no web-auth ceremony URLs");
  }
  return { authUrl, doneUrl };
}

/**
 * Read a write's response as a second-factor challenge: a 401 whose
 * `www-authenticate` names `otp` in any case (npmjs sends `OTP`), or whose body
 * mentions a "one-time pass" (for a registry that omits the header). Returns
 * undefined for any other response, a 401 for a bad credential included.
 */
export function otpChallengeOf(response: HttpResponse): OtpChallenge | undefined {
  if (response.statusCode !== 401) {
    return undefined;
  }
  const schemes = response.headers["www-authenticate"] ?? "";
  const body = response.body.toString("utf8");
  if (!/\botp\b/i.test(schemes) && !body.includes("one-time pass")) {
    return undefined;
  }
  try {
    return parseJson(body, "second-factor challenge", toWebAuthUrls);
  } catch {
    /* No URLs, or a body that is not JSON: a challenge for a typed one-time
     * password. */
    return {};
  }
}

/**
 * Rewrite a `doneUrl` naming `registry.npmjs.org` to the protocol and host of
 * `registryUrl`, adding the registry's path prefix where the path lacks it, as
 * npm-profile does: a proxy forwarding npmjs's answer leaves its host in the
 * URL. A `doneUrl` naming any other host, or the registry's own, is returned
 * as it is.
 */
export function replaceDoneUrlOrigin(doneUrl: string, registryUrl: string): string {
  const done = new URL(doneUrl);
  if (done.hostname !== "registry.npmjs.org") {
    return doneUrl;
  }
  const registry = new URL(registryUrl);
  if (registry.host === done.host) {
    return doneUrl;
  }
  done.protocol = registry.protocol;
  done.host = registry.host;
  const prefix = registry.pathname.replace(/\/$/, "");
  if (prefix && done.pathname !== prefix && !done.pathname.startsWith(prefix + "/")) {
    done.pathname = prefix + done.pathname;
  }
  return done.href;
}

/** {@link pollWebAuthToken}'s wait where the registry sends no `retry-after`.
 * npm-profile polls again at once. */
const WEB_AUTH_POLL_MS = 1000;
const WEB_AUTH_TIMEOUT_MS = 300_000;

function delay(ms: number): Computable<void> {
  return Computable.from(resolve => setTimeout(() => resolve(undefined), ms));
}

/** Read the `token` of a completed browser authentication, throwing where it
 * is absent or empty. */
function toWebAuthToken(json: unknown): string {
  const token = toJsonObject(json).token;
  if (typeof token !== "string" || token.length === 0) {
    throw new FabrError("missing token");
  }
  return token;
}

/**
 * Wait for a browser authentication to finish: poll `doneUrl` with the write's
 * credential, as npm does, until it answers 200 with `{token}`, the one-time
 * password to send the write again with. A 202 is polled again after its
 * `retry-after` seconds, or {@link WEB_AUTH_POLL_MS}. Rejects on any other
 * status, or where the next poll would pass `timeoutMs`.
 */
export function pollWebAuthToken(
  doneUrl: string,
  authHeaders: Record<string, string>,
  timeoutMs: number = WEB_AUTH_TIMEOUT_MS
): Computable<string> {
  const deadline = Date.now() + timeoutMs;
  const poll = (): Computable<string> =>
    sendRequest(doneUrl, { method: "GET", headers: authHeaders }).then(response => {
      if (response.statusCode === 200) {
        return parseJson(response.body.toString("utf8"), "web-auth completion response", toWebAuthToken);
      }
      if (response.statusCode === 202) {
        const retryAfter = Number(response.headers["retry-after"]) * 1000;
        const wait = retryAfter > 0 ? retryAfter : WEB_AUTH_POLL_MS;
        if (Date.now() + wait > deadline) {
          throw new FabrError(`browser authentication was not completed within ${Math.round(timeoutMs / 1000)}s`);
        }
        return delay(wait).then(poll);
      }
      throw new FabrError(`browser authentication at ${doneUrl} failed (${response.statusCode}): ${response.body.toString("utf8")}`);
    });
  return poll();
}

/**
 * One second-factor answer. A typed one-time password is `reusable`: the
 * registry accepts it for the rest of its window (about 30s), and the npm CLI
 * reuses it likewise. A browser authentication's token is not: npmjs refuses
 * its second use.
 */
export interface AcquiredOtp {
  password: string;
  reusable: boolean;
}

/**
 * A registry's second-factor answers for the run. A reusable answer is kept
 * for the run's other publishes to the registry; a single-use one is not, so
 * each challenged write asks again. Requests made while an answer is being
 * acquired share that acquisition.
 */
export class OtpSession {
  private cached?: string;
  private pending?: Computable<string>;

  /**
   * Get the session's answer, acquiring one through `acquire` where none is
   * kept or in progress. `rejected` is a password the registry just refused:
   * if it is the kept one it is dropped and another acquired. The caller
   * bounds how often it asks.
   */
  public obtain(acquire: () => Computable<AcquiredOtp>, rejected?: string): Computable<string> {
    if (rejected !== undefined && this.cached === rejected) {
      this.cached = undefined;
      this.pending = undefined;
    }
    if (this.cached !== undefined) {
      return Computable.resolve(this.cached);
    }
    /* A settled acquisition here failed, or gave a single-use answer already
     * used: acquire another. */
    if (this.pending?.isSettled()) {
      this.pending = undefined;
    }
    if (!this.pending) {
      this.pending = acquire().then(acquired => {
        if (acquired.reusable) {
          this.cached = acquired.password;
        }
        return acquired.password;
      });
    }
    return this.pending;
  }
}
