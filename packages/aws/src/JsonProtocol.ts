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
 * AWS's JSON protocol (`application/x-amz-json-1.1`), which ECR, SSM and
 * Secrets Manager speak: a POST naming its operation in `x-amz-target`, and
 * the error document a refusal answers with.
 */

import { Computable, HttpStatusError, parseJson, sendRequest, toJsonObject } from "@fabr-build/core";
import { IServiceRequest } from "./Signing";
import { IServiceSettings } from "./Types";

/**
 * Make a request for the operation `target` with `body`: to `endpoint` where
 * there is one, else to `host` (`ssm.eu-west-2.amazonaws.com`).
 */
export function jsonRequest(target: string, body: unknown, host: string, endpoint?: URL): IServiceRequest & { readonly body: string } {
  const headers = new Map([
    ["content-type", "application/x-amz-json-1.1"],
    ["x-amz-target", target],
  ]);
  const base =
    endpoint === undefined
      ? { protocol: "https:", hostname: host }
      : { protocol: endpoint.protocol, hostname: endpoint.hostname, ...(endpoint.port === "" ? {} : { port: Number(endpoint.port) }) };
  return {
    ...base,
    method: "POST",
    path: endpoint === undefined ? "/" : `${endpoint.pathname.replace(/\/+$/, "")}/`,
    query: new Map(),
    headers,
    body: JSON.stringify(body),
  };
}

/** What a refusal's error document says: its type (`ResourceNotFoundException`), where it names one, and its message, or the document's text where it is none. */
export interface IServiceError {
  readonly type?: string;
  readonly message: string;
}

/** Read the error document `text` a refusal answers with. */
export function serviceErrorOf(text: string): IServiceError {
  let doc: Record<string, unknown>;
  try {
    doc = parseJson(text, "an error", toJsonObject);
  } catch {
    return { message: text.trim() || "no detail given" };
  }
  const message =
    typeof doc.message === "string" ? doc.message : typeof doc.Message === "string" ? doc.Message : text.trim() || "no detail given";
  return typeof doc.__type === "string" ? { type: doc.__type.replace(/^.*#/, ""), message } : { message };
}

/** Describe `error` in one line: its type and message. */
export function describeServiceError({ type, message }: IServiceError): string {
  return type === undefined ? message : `${type}: ${message}`;
}

/** The error types with which AWS answers a request it is throttling, as the AWS SDK lists them (`THROTTLING_ERROR_CODES`). */
const THROTTLING_ERRORS = new Set([
  "BandwidthLimitExceeded",
  "EC2ThrottledException",
  "LimitExceededException",
  "PriorRequestNotComplete",
  "ProvisionedThroughputExceededException",
  "RequestLimitExceeded",
  "RequestThrottled",
  "RequestThrottledException",
  "SlowDown",
  "ThrottledException",
  "Throttling",
  "ThrottlingException",
  "TooManyRequestsException",
  "TransactionInProgressException",
]);

/** @return true if `error` says the request was throttled, to be tried again later, otherwise false. */
export function isThrottling(error: IServiceError): boolean {
  return error.type !== undefined && THROTTLING_ERRORS.has(error.type);
}

/**
 * Sign `request` for `service` and send it to `url`, answering with the body of
 * a 200. A 5xx, or a throttling error type, rejects as a transient HTTP status,
 * which is retried; any other answer rejects with `refuse` of its text.
 */
export function postServiceRequest(
  settings: IServiceSettings,
  service: string,
  request: IServiceRequest & { readonly body: string },
  url: string,
  refuse: (text: string) => Error
): Computable<Buffer> {
  return settings.signer
    .sign(request, service, settings.region)
    .then(headers => sendRequest(url, { method: "POST", headers, body: request.body }))
    .then(response => {
      if (response.statusCode >= 500) {
        throw new HttpStatusError(response.statusCode, url);
      }
      if (response.statusCode !== 200) {
        const text = response.body.toString("utf8");
        /* Throttling is answered as a 400; it is HTTP's "too many requests", which is retried. */
        if (isThrottling(serviceErrorOf(text))) {
          throw new HttpStatusError(429, url);
        }
        throw refuse(text);
      }
      return response.body;
    });
}
