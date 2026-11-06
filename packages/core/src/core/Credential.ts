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

import type { Computable } from "./Computable";

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
 * What signs a request in: a token added to every request, or a signature
 * over each. A repository made by a namespace is handed one (see
 * RepositoryProvider); core's HTTP layer asks it for each request it sends
 * and, where the server answers 401, once more with the server's challenge.
 */
export interface Credential {
  /**
   * Make the headers a request is sent with, by lowercase name. Called first
   * with no challenge; called again with the challenge where the server
   * answered 401, giving the headers to retry with, or undefined to give up.
   */
  authorize(request: IRequestHead, challenge?: IAuthChallenge): Computable<ReadonlyMap<string, string> | undefined>;
}
