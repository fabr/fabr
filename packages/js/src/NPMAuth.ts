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
 * Registry **authentication**, all of it in one place. {@link NPMAuth} is the
 * run's auth authority (one shared instance, memoized on the js plugin
 * context), combining:
 *  - the configured credential — the auth-relevant `.npmrc` contents (project +
 *    user files, `${VAR}` substitution, "the Authorization header for this URL"
 *    by longest nerf-dart prefix match; registry/scope config like
 *    `@scope:registry` is deliberately out of scope);
 *  - answering the second-factor challenge a 2FA account's write receives
 *    (the browser/passkey ceremony via {@link pollWebAuthToken}, or a terminal
 *    prompt), with one answer per registry reused across the run's publishes
 *    ({@link OtpSession}).
 * The wire-level challenge shape lives here too ({@link otpChallengeOf}); the
 * publish operation itself (envelope, PUT, challenge-retry loop) stays in
 * NPMProtocol.ts, with the challenge-answering injected as an {@link OtpProvider}.
 */

import * as os from "node:os";
import * as path from "node:path";

import {
  attachHelp,
  Computable,
  ExecutionContext,
  HttpResponse,
  parseJson,
  sendRequest,
  toJsonObject,
  UserInteraction,
} from "@fabr-build/core";

/** The npm auth mechanisms configurable per registry, in precedence order. */
interface RegistryAuth {
  authToken?: string;
  /** Base64 `user:pass`, sent as-is. */
  auth?: string;
  username?: string;
  /** Base64-encoded password (npm's `_password`). */
  password?: string;
}

/** Substitute `${VAR}` with the environment value (empty when unset), as npm does
 *  — so `_authToken=${NPM_TOKEN}` picks up the CI token, and an unset var yields no
 *  credential rather than a literal `${…}`. */
function envSubstitute(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, name: string) => process.env[name] ?? "");
}

/**
 * Parse a `.npmrc` body into its key→value entries: `key = value` lines, skipping
 * blanks, `#`/`;` comments and `[section]` headers; surrounding quotes stripped and
 * `${VAR}` substituted (the ini shape npm uses).
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
    const value = envSubstitute(line.slice(eq + 1).trim().replace(/^["']|["']$/g, ""));
    entries.set(key, value);
  }
  return entries;
}

/** The absolute path of the user `~/.npmrc` — read through a FileSource (the
 *  execution's absolute source), not a raw `fs` read. */
export function userNpmrcPath(): string {
  return path.join(os.homedir(), ".npmrc");
}

export class NPMAuth {
  /** registry key (`//host/path/`) → its auth fields. */
  private readonly registries: Map<string, RegistryAuth>;
  /** registry URL → its second-factor session (created on first challenge). */
  private readonly otpSessions = new Map<string, OtpSession>();

  constructor(entries: Map<string, string>) {
    this.registries = new Map();
    const authOf = (prefix: string): RegistryAuth => {
      /* npm's nerf-dart keys are slash-terminated; normalize so prefix matching
       * respects path boundaries (`//host/npm` must not credential `//host/npm-other`). */
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
   * Load the combined config for a run: the project `.npmrc` (read through the
   * source FS, so it participates in watch-mode invalidation) and the user
   * `~/.npmrc` (absolute FS, unwatched), project overriding user. Reads straight
   * off the {@link ExecutionContext}'s FileSources, so it is shared per run rather
   * than per repository instance (see the js plugin context).
   */
  public static load(execution: ExecutionContext): Computable<NPMAuth> {
    return Computable.forAll(
      [execution.absFileSource.get(userNpmrcPath()).then(f => f?.readString()),
       execution.sourceFileSource.get(".npmrc").then(f => f?.readString())], 
       NPMAuth.fromSources);
  }

  /**
   * Combine `.npmrc` sources given in **increasing precedence** — a duplicate key
   * from a later source wins (so pass user before project, per npm precedence).
   * Any source may be absent.
   */
  public static fromSources(...sources: (string | undefined)[]): NPMAuth {
    const entries = sources
      .filter((source): source is string => source !== undefined)
      .flatMap(source => [...parseNpmrc(source)]);
    return new NPMAuth(new Map(entries));
  }

  /**
   * Get `Authorization` headers (if needed) to send with a request to `url`, from the
   * most specific matching registry's credential */
  public getHeadersFor(url: string): Record<string,string> {
    let target: string;
    try {
      const parsed = new URL(url);
      target = `//${parsed.host}${parsed.pathname}`;
    } catch {
      return {};
    }
    /* Match a slash-terminated target against slash-terminated prefixes, so a
     * prefix only matches at a path boundary — not `//host/npm` ⊃ `//host/npm-x`. */
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
   * Answer a write's second-factor challenges for `registryUrl` — the
   * {@link OtpProvider} a publish injects into its retry loop. Answers go
   * through the registry's {@link OtpSession}, so the run's several publishes
   * ask the human once, re-acquiring only when the registry refuses a reused
   * token.
   */
  public otpProvider(registryUrl: string, interaction: UserInteraction | undefined): OtpProvider {
    const session = this.sessionFor(registryUrl);
    return (challenge, rejected) =>
      session.obtain(() => this.acquireSecondFactor(challenge, registryUrl, interaction), rejected);
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
   * Ask the human for one second-factor answer: a passkey/security-key account
   * gets the browser ceremony (open the challenge's authUrl, poll its doneUrl
   * for the outcome token — single-use), an authenticator-code account a
   * terminal prompt (reusable within the code's window). Without a terminal
   * there is nobody to ask — a typed error names the unattended alternatives
   * instead.
   */
  private acquireSecondFactor(
    challenge: OtpChallenge,
    registryUrl: string,
    interaction: UserInteraction | undefined
  ): Computable<AcquiredOtp> {
    if (!interaction) {
      throw attachHelp(
        new Error(`publishing to ${registryUrl} requires a second factor (2FA), and this run has no terminal to authenticate on`),
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
 * A registry's demand for a second factor on a write (npm's `EOTP`): a 401
 * whose `www-authenticate` names `otp` (any case — npmjs sends `OTP`), or —
 * for registries that omit the header — whose body mentions a one-time pass.
 * When the account's second factor is browser-based (a passkey/security key)
 * the body additionally carries the ceremony's `authUrl`/`doneUrl` pair; a
 * bare challenge means a typed-in OTP (an authenticator code) is expected.
 */
export interface OtpChallenge {
  /** Browser page that performs the authentication ceremony (WebAuthn). */
  authUrl?: string;
  /** Endpoint to poll for the ceremony's outcome token; see {@link pollWebAuthToken}. */
  doneUrl?: string;
}

/**
 * Produce the one-time password to answer an {@link OtpChallenge} with — by
 * browser ceremony, prompt, or a cached token from an earlier answer in the
 * same run. `rejected` is a token the registry just refused, so a provider
 * serving cached tokens knows to discard that one and acquire afresh.
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

/** The `authUrl`/`doneUrl` pair of a web-auth challenge body; throws if absent. */
function toWebAuthUrls(json: unknown): { authUrl: string; doneUrl: string } {
  const doc = toJsonObject(json);
  const { authUrl, doneUrl } = doc;
  if (!isHttpUrl(authUrl) || !isHttpUrl(doneUrl)) {
    throw new Error("no web-auth ceremony URLs");
  }
  return { authUrl, doneUrl };
}

/**
 * Interpret a write response as a second-factor challenge, if it is one.
 * Anything else — including an ordinary bad-credential 401 — is not the
 * challenge's business and returns undefined for the caller's normal handling.
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
    /* A challenge without ceremony URLs (a typed-OTP account, or a non-JSON
     * body) is still a challenge — just one with nothing to open. */
    return {};
  }
}

/**
 * npmjs's web-auth `doneUrl` names the canonical registry host even when the
 * write went to a proxy/mirror that forwards its responses, and polling the
 * canonical host would miss the session — so rewrite exactly that host to the
 * registry origin the write used (preserving any path prefix the registry is
 * mounted under). Any other host is intentional and left alone. Mirrors
 * npm-profile's behavior.
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

/** {@link pollWebAuthToken}'s wait when the registry sends no `retry-after`
 * (npm-profile re-polls immediately then, trusting the registry always sends
 * one; a floor keeps a misbehaving registry from being hammered). */
const WEB_AUTH_POLL_MS = 1000;
const WEB_AUTH_TIMEOUT_MS = 300_000;

function delay(ms: number): Computable<void> {
  return Computable.from(resolve => setTimeout(() => resolve(undefined), ms));
}

/** The `{token}` of a completed web-auth ceremony; throws if absent. */
function toWebAuthToken(json: unknown): string {
  const token = toJsonObject(json).token;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("missing token");
  }
  return token;
}

/**
 * Wait out a browser authentication ceremony: poll the challenge's `doneUrl`
 * (with the same credential as the write, per the reference client) until the
 * registry reports it complete — 200 with `{token}`, the one-time password the
 * original write is then retried with. A 202 means still pending, re-polled
 * after its `retry-after` (seconds); the ceremony is bounded so an abandoned
 * browser tab fails the publish rather than hanging it forever.
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
          throw new Error(`browser authentication was not completed within ${Math.round(timeoutMs / 1000)}s`);
        }
        return delay(wait).then(poll);
      }
      throw new Error(
        `browser authentication at ${doneUrl} failed (${response.statusCode}): ${response.body.toString("utf8")}`
      );
    });
  return poll();
}

/**
 * One acquired second-factor answer, with its lifetime: a typed authenticator
 * code is `reusable` (the registry accepts it for the rest of its ~30s window,
 * so a multi-package sync types it once — npm CLI parity), while a web
 * ceremony's token is single-use (npmjs refuses its second use) and must be
 * acquired per challenged write.
 */
export interface AcquiredOtp {
  password: string;
  reusable: boolean;
}

/**
 * A registry's second-factor answers for the run. A reusable answer (a typed
 * OTP) is cached for the run's other publishes to the same registry; a
 * single-use one (a browser ceremony token) is never cached — each challenged
 * write runs its own ceremony against its own challenge's fresh URLs (caching
 * one would burn the retry on a dead token and leave only the refusal's bare
 * challenge to re-acquire from). Concurrent publishes hitting the challenge
 * together still join one in-flight acquisition rather than each opening a
 * browser tab.
 */
export class OtpSession {
  private cached?: string;
  private pending?: Computable<string>;

  /**
   * The session's current answer, acquiring one via `acquire` when there is
   * none. `rejected` is a password the registry just refused: if it is the
   * cached one, it is discarded and a fresh acquisition started (a *freshly*
   * acquired refusal is not retried here — the caller bounds its attempts).
   */
  public obtain(acquire: () => Computable<AcquiredOtp>, rejected?: string): Computable<string> {
    if (rejected !== undefined && this.cached === rejected) {
      this.cached = undefined;
      this.pending = undefined;
    }
    if (this.cached !== undefined) {
      return Computable.resolve(this.cached);
    }
    /* A settled chain here is spent: a failed acquisition, or a single-use
     * success already consumed by whoever joined it (a reusable success fills
     * `cached`, which short-circuits above) — drop it so this caller acquires
     * afresh instead of joining the past. */
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
