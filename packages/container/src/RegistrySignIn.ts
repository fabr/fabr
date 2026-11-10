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

import { Computable, Credential, FabrError, IAuthChallenge, IRequestHead, isJsonObject, parseJson, sendRequest, TargetContext } from "@fabr-build/core";
import { containerPluginContext, IRegistryCredential } from "./RegistryAuth";

/**
 * Signing in to a registry as it asks, from its 401's challenge: with a
 * bearer token fetched for the request's scopes, with the registry's own
 * credential where there is one or else anonymously, or with that credential
 * itself (`Basic`). Once the registry has named its token realm, a request
 * needing scopes no token is held for has one fetched before it is sent. A
 * token is kept for its scopes; one the registry no longer accepts is fetched
 * again, once however many requests meet it together.
 */
export class RegistrySignIn implements Credential {
  /** The token for each set of scopes, by the scopes joined. */
  private readonly tokens = new Map<string, Computable<string>>();
  /** The registry's `Bearer` challenge, once it has made one. */
  private realm?: IBearerChallenge;
  /** The `Basic` header, once the registry has asked for one. */
  private basic?: string;

  constructor(
    /** The registry's base URL, the requests' scopes read from what follows it. */
    private readonly registry: string,
    /** Get the registry's credential, where it may need one: asked for only when it does. */
    private readonly credentialOf: () => Computable<IRegistryCredential | undefined>
  ) {}

  public authorize(request: IRequestHead, challenge?: IAuthChallenge): Computable<ReadonlyMap<string, string> | undefined> {
    if (challenge === undefined) {
      const scopes = scopesOf(request, this.registry);
      const held = this.tokens.get(scopes.join(" "));
      if (held !== undefined || (this.realm !== undefined && scopes.length > 0)) {
        return bearer(held ?? this.fetchToken(this.realm!, scopes));
      }
      return Computable.resolve(this.basic === undefined ? new Map() : new Map([["authorization", this.basic]]));
    }
    const asked = challenge.challenges.map(parseChallenge).find(each => each !== undefined);
    if (asked === undefined) {
      return Computable.reject(new FabrError(`${this.registry} asks for authentication fabr cannot give (${challenge.challenges.join(", ")})`));
    }
    if (asked.scheme === "basic") {
      return this.credentialOf().then(credential => {
        if (credential === undefined) {
          return undefined;
        }
        this.basic = basicAuthorization(credential);
        return new Map([["authorization", this.basic]]);
      });
    }
    this.realm = asked;
    const scopes = asked.scope === undefined ? scopesOf(request, this.registry) : asked.scope.split(" ");
    const fetching = this.tokens.get(scopes.join(" "));
    return bearer(fetching !== undefined && !fetching.isSettled() ? fetching : this.fetchToken(asked, scopes));
  }

  /** Fetch a token for `scopes`, and hold it for them. */
  private fetchToken(challenge: IBearerChallenge, scopes: readonly string[]): Computable<string> {
    const token = this.credentialOf().then(credential => this.token(challenge, scopes, credential));
    this.tokens.set(scopes.join(" "), token);
    return token;
  }

  /** Fetch a token for `scopes` from the realm `challenge` names, signed in with `credential` where there is one. */
  private token(challenge: IBearerChallenge, scopes: readonly string[], credential: IRegistryCredential | undefined): Computable<string> {
    const query = new URLSearchParams(challenge.service === undefined ? [] : [["service", challenge.service]]);
    scopes.forEach(scope => query.append("scope", scope));
    const url = `${challenge.realm}?${query.toString()}`;
    return sendRequest(url, { method: "GET", headers: credential === undefined ? {} : { authorization: basicAuthorization(credential) } }).then(response => {
      if (response.statusCode !== 200) {
        throw new FabrError(`${challenge.realm} refused a token for ${scopes.join(", ")} (${response.statusCode})`).withHelp(
          credential === undefined ? `log in to ${new URL(this.registry).host} with \`docker login\` or \`podman login\`` : "check the credential is for this registry and allowed this access"
        );
      }
      return parseJson(response.body, `token from ${challenge.realm}`, toToken);
    });
  }
}

/** Make the sign-in to the registry at `registry` with the credential podman's and Docker's auth files hold for `server` (by default, its host). */
export function authFileSignIn(context: TargetContext, registry: string, server: string = new URL(registry).host): RegistrySignIn {
  return new RegistrySignIn(registry, () =>
    containerPluginContext(context.execution)
      .registryAuth()
      .then(auth => auth.credentialFor(server))
  );
}

/**
 * @return the scopes a request to the registry at `registry` needs, read from
 * its path (`/v2/<repository>/manifests|blobs|tags/…`): pulling for a read,
 * pulling and pushing for anything else, and pulling the repository a blob is
 * mounted from (`?from=`); none for a request to no repository.
 */
export function scopesOf({ method, url }: Pick<IRequestHead, "method" | "url">, registry: string): string[] {
  const target = new URL(url);
  const base = new URL(registry);
  if (target.origin !== base.origin) {
    return [];
  }
  const path = target.pathname.substring(base.pathname.replace(/\/+$/, "").length);
  /* A repository's name may itself hold `blobs` or `manifests`, so the request's kind is read from the end. */
  const match = /^\/v2\/(.+)\/(?:manifests\/[^/]+|blobs\/(?:uploads\/[^/]*|[^/]+)|tags\/list)$/.exec(path);
  if (match === null) {
    return [];
  }
  const repository = match[1];
  const reading = method === "GET" || method === "HEAD";
  const from = target.searchParams.get("from");
  return [`repository:${repository}:${reading ? "pull" : "pull,push"}`, ...(from === null || from === repository ? [] : [`repository:${from}:pull`])];
}

/** Make the headers a request carries `token` with. */
function bearer(token: Computable<string>): Computable<ReadonlyMap<string, string>> {
  return token.then(value => new Map([["authorization", `Bearer ${value}`]]));
}

function basicAuthorization({ username, password }: IRegistryCredential): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

/** How a registry asks requests to be authenticated. */
type IChallenge = IBearerChallenge | { readonly scheme: "basic" };

/** A registry's `Bearer` challenge: where to get a token, and for what. */
interface IBearerChallenge {
  readonly scheme: "bearer";
  readonly realm: string;
  readonly service?: string;
  /** The scopes the token must grant, where the challenge says (space-separated). */
  readonly scope?: string;
}

/** Read a `WWW-Authenticate` challenge: `Bearer realm="…",service="…",scope="…"`, or `Basic`; undefined for any other scheme. */
export function parseChallenge(header: string | undefined): IChallenge | undefined {
  if (/^\s*Basic\b/i.test(header ?? "")) {
    return { scheme: "basic" };
  }
  const match = /^\s*Bearer\s+(.*)$/i.exec(header ?? "");
  if (match === null) {
    return undefined;
  }
  const params = new Map<string, string>();
  for (const param of match[1].matchAll(/([a-zA-Z_]+)\s*=\s*(?:"([^"]*)"|([^,\s]*))/g)) {
    params.set(param[1].toLowerCase(), param[2] ?? param[3]);
  }
  const realm = params.get("realm");
  if (realm === undefined) {
    return undefined;
  }
  const service = params.get("service");
  const scope = params.get("scope");
  return { scheme: "bearer", realm, ...(service === undefined ? {} : { service }), ...(scope === undefined ? {} : { scope }) };
}

/** Read a token realm's answer: its `token`, else its `access_token`. */
function toToken(json: unknown): string {
  const token = isJsonObject(json) ? (typeof json.token === "string" ? json.token : json.access_token) : undefined;
  if (typeof token !== "string" || token === "") {
    throw new FabrError("the answer holds no token");
  }
  return token;
}
