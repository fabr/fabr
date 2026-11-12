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

import { Computable } from "./Computable";

/** A request as a credential sees it: what is sent, before the credential's own headers. */
export interface IRequestHead {
  readonly method: string;
  readonly url: string;
  readonly headers: ReadonlyMap<string, string>;
}

/** What a server's 401 asked for: its `WWW-Authenticate` challenges, as sent. */
export interface IAuthChallenge {
  readonly challenges: readonly string[];
}

/**
 * A sign-in for requests: a token added to every request, or a signature over
 * each. A repository a namespace makes is given one (see RepositoryProvider);
 * core's HTTP layer asks it for each request it sends and, where the server
 * answers 401, once more with the server's challenge.
 */
export interface Credential {
  /**
   * Make the headers a request is sent with, by lowercase name. Called first
   * with no challenge; called again with the challenge where the server
   * answered 401, giving the headers to retry with, or undefined to give up.
   */
  authorize(request: IRequestHead, challenge?: IAuthChallenge): Computable<ReadonlyMap<string, string> | undefined>;
}

/** Make a credential that authorizes the requests to `origin` as `credential`
 *  does, and adds nothing to any other request (nor retries its 401). */
export function onlyTo(origin: string, credential: Credential): Credential {
  return {
    authorize: (request, challenge) =>
      new URL(request.url).origin === origin
        ? credential.authorize(request, challenge)
        : Computable.resolve(challenge === undefined ? new Map() : undefined),
  };
}

/**
 * A token fetched when first needed and held, shared by every request that
 * asks while it is being fetched, and fetched again where a challenge says the
 * one held is no longer accepted, or where its fetch failed.
 */
export class RenewableToken<T> {
  /** The token's fetch, and whether it failed. */
  private held?: { token: Computable<T>; attempt: { failed: boolean } };

  constructor(private readonly fetch: () => Computable<T>) {}

  /** Get the token held, fetching it the first time or where its fetch failed. */
  public current(): Computable<T> {
    return this.held === undefined || this.held.attempt.failed ? this.renewed() : this.held.token;
  }

  /** Get the token for a request: the one held, or, answering `challenge`, a
   *  fresh one, unless a fetch is already under way. */
  public forRequest(challenge?: IAuthChallenge): Computable<T> {
    if (challenge === undefined || (this.held !== undefined && !this.held.token.isSettled())) {
      return this.current();
    }
    return this.renewed();
  }

  /** Fetch the token again, and hold the fetch. */
  private renewed(): Computable<T> {
    const attempt = { failed: false };
    const token = this.fetch().catch((err: Error) => {
      attempt.failed = true;
      throw err;
    });
    this.held = { token, attempt };
    return token;
  }
}
