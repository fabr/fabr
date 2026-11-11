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

import { TargetContext } from "@fabr-build/core";
import { RequestSigner } from "./Signing";

/** The region an account's regional services are in where it declares none. */
export const DEFAULT_REGION = "us-east-1";

/** What an account gives the services under it. */
export interface IAccountSettings {
  /** The account's declared name (`@aws`), for messages. */
  readonly name: string;
  readonly context: TargetContext;
  readonly signer: RequestSigner;
  /** What identifies the credentials `signer` signs with: the profile, and the access key's ID where the environment gives one. Part of the key of what is kept from a read with them. */
  readonly credentials: string;
  /** The region of the account's regional services. */
  readonly region: string;
  readonly endpoint?: URL;
  /** The account's ID, where it is declared. */
  readonly accountId?: string;
  /** The repository type each AWS service or CodeArtifact format is read and published as (AWS_REPOSITORY_TYPES). */
  readonly repositoryTypes: ReadonlyMap<string, string>;
}

/** What an account's requests to one of its services are signed and sent with. */
export type IServiceSettings = Pick<IAccountSettings, "signer" | "region" | "endpoint">;
