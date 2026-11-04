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
 * Signing requests to AWS services (Signature Version 4) with an account's
 * credentials, found by AWS's own credential chain.
 */

import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { Hash } from "@smithy/hash-node";
import { SignatureV4 } from "@smithy/signature-v4";
import { Computable, FabrError, toError } from "@fabr-build/core";

/** A request to a service, before it is signed. */
export interface IServiceRequest {
  readonly method: "GET" | "HEAD" | "PUT";
  /** `https:`, or `http:` for an endpoint that says so. */
  readonly protocol: string;
  readonly hostname: string;
  readonly port?: number;
  /** The path, already URI-encoded. */
  readonly path: string;
  /** The query parameters, unencoded. */
  readonly query: ReadonlyMap<string, string>;
  /** Headers sent with the request and signed with it, by lowercase name. */
  readonly headers?: ReadonlyMap<string, string>;
}

/** A credential provider, as AWS's credential chain makes one. */
type CredentialProvider = ReturnType<typeof defaultProvider>;

/** Signs requests with the credentials of one account. */
export class RequestSigner {
  private readonly credentials: CredentialProvider;

  /** Find credentials for `profile`, or as the AWS CLI would where it is undefined. The chain is read when a request is first signed. */
  constructor(profile: string | undefined) {
    this.credentials = defaultProvider(profile === undefined ? {} : { profile });
  }

  /** Sign `request` for `service` in `region`, giving the headers it is sent with: its own, and the signature's. */
  public sign(request: IServiceRequest, service: string, region: string): Computable<Record<string, string>> {
    const signer = new SignatureV4({
      credentials: this.credentials,
      region,
      service,
      sha256: Hash.bind(null, "sha256"),
      /* S3's canonical path is the path as sent, not encoded a second time. */
      uriEscapePath: service !== "s3",
    });
    const host = request.port === undefined ? request.hostname : `${request.hostname}:${request.port}`;
    return Computable.from<Record<string, string>>((resolve, reject) => {
      signer
        .sign({
          method: request.method,
          protocol: request.protocol,
          hostname: request.hostname,
          port: request.port,
          path: request.path,
          query: Object.fromEntries(request.query),
          headers: { ...Object.fromEntries(request.headers ?? []), host },
        })
        .then(
          signed => resolve(signed.headers),
          err => reject(new FabrError(`cannot sign a request to ${service} (${toError(err).message})`))
        );
    });
  }
}

/** Encode `text` as AWS's canonical requests encode a URI component: RFC 3986's unreserved characters as they are, everything else as UTF-8 `%XX`. */
export function uriEncode(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Make the URL `request` is sent to, its query encoded as it is signed. */
export function requestUrl(request: IServiceRequest): string {
  const host = request.port === undefined ? request.hostname : `${request.hostname}:${request.port}`;
  const query = [...request.query]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${uriEncode(key)}=${uriEncode(value)}`)
    .join("&");
  return `${request.protocol}//${host}${request.path}${query === "" ? "" : `?${query}`}`;
}
