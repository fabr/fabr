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

/**
 * STS, as far as finding which account the credentials sign in to:
 * `GetCallerIdentity`, which any credentials may call.
 */

import { FabrError } from "@fabr-build/core";
import { readDocument } from "./S3Protocol";
import { IServiceRequest } from "./Signing";

/** The name STS's requests are signed for. */
export const STS_SERVICE = "sts";

/** Make the `GetCallerIdentity` request: to `endpoint` where there is one, else to STS in `region`. */
export function identityRequest(region: string, endpoint?: URL): IServiceRequest & { readonly body: string } {
  const base =
    endpoint === undefined
      ? { protocol: "https:", hostname: `sts.${region}.amazonaws.com`, path: "/" }
      : {
          protocol: endpoint.protocol,
          hostname: endpoint.hostname,
          ...(endpoint.port === "" ? {} : { port: Number(endpoint.port) }),
          path: `${endpoint.pathname.replace(/\/+$/, "")}/`,
        };
  return {
    ...base,
    method: "POST",
    query: new Map(),
    headers: new Map([["content-type", "application/x-www-form-urlencoded; charset=utf-8"]]),
    body: "Action=GetCallerIdentity&Version=2011-06-15",
  };
}

/** Read the account ID a `GetCallerIdentity` answer gives. Throws, naming `what`, where it gives none. */
export function parseCallerAccount(text: string, what: string): string {
  let account: string | undefined;
  readDocument(text, what, "a GetCallerIdentity answer", "GetCallerIdentityResponse", (path, value) => {
    if (path === "GetCallerIdentityResponse/GetCallerIdentityResult/Account") {
      account = value.trim();
    }
  });
  if (account === undefined || !/^\d{12}$/.test(account)) {
    throw new FabrError(`${what} gives no account ID`);
  }
  return account;
}
