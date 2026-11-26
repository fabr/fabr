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
 * Publishing to Maven Central through its Publisher Portal
 * (https://central.sonatype.org/publish/publish-portal-api/): a release's
 * files, in Maven's repository layout, zipped and uploaded as one deployment,
 * which the Portal validates and then publishes, or under staging holds until
 * someone publishes it from the Portal.
 */

import * as crypto from "node:crypto";
import {
  Computable,
  Credential,
  FabrError,
  FileSet,
  HttpRequest,
  HttpResponse,
  ITaskReport,
  packToZip,
  parseJson,
  SecureString,
  sendRequest,
  shownUrl,
  toJsonObject,
  urlJoin,
} from "@fabr-build/core";

/** The URL of Maven Central's Publisher Portal. */
export const DEFAULT_PORTAL_URL = "https://central.sonatype.com";

/** The page of the Portal that lists an account's deployments. */
const DEPLOYMENTS_PAGE = `${DEFAULT_PORTAL_URL}/publishing/deployments`;

/** How long to wait between two reads of a deployment's status. */
const POLL_INTERVAL_MS = 5000;
/** How long to wait for a deployment to be validated before giving up. */
const POLL_LIMIT_MS = 60 * 60 * 1000;
/** How many reads of a deployment's status in a row may fail before giving up. */
const POLL_RETRIES = 5;
/** The id the token check asks about, which names no deployment. */
const NO_DEPLOYMENT = "00000000-0000-0000-0000-000000000000";

/** Sends one request and reads its whole response, as {@link sendRequest} does. */
export type Send = (url: SecureString, request: HttpRequest) => Computable<HttpResponse>;

/** Waits `ms` milliseconds. */
export type Wait = (ms: number) => Computable<void>;

/** A deployment's status, as the Portal's status endpoint states it. */
export interface DeploymentStatus {
  /** `PENDING`, `VALIDATING`, `VALIDATED`, `PUBLISHING`, `PUBLISHED` or `FAILED`. */
  readonly state: string;
  /** Why a `FAILED` deployment failed, as the Portal gives it. */
  readonly errors?: unknown;
}

/** Convert the Portal's status document. */
export function toDeploymentStatus(json: unknown): DeploymentStatus {
  const document = toJsonObject(json);
  if (typeof document.deploymentState !== "string") {
    throw new FabrError("expected a deploymentState");
  }
  return { state: document.deploymentState, errors: document.errors };
}

/**
 * @return true if a deployment in `state` has gone as far as an upload asks:
 * validated or further, under staging; on its way to Central, otherwise.
 */
export function deploymentDone(state: string, staging: boolean): boolean {
  return state === "PUBLISHING" || state === "PUBLISHED" || (staging && state === "VALIDATED");
}

/** @return the `multipart/form-data` body uploading `zip` as the Portal's one `bundle` part, separated by `boundary`. */
export function multipartBody(zip: Buffer, boundary: string): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="bundle"; filename="bundle.zip"\r\n' +
        "Content-Type: application/octet-stream\r\n\r\n"
    ),
    zip,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

/** @return the lines a failed deployment's errors are shown as: one per message, named by what it is about. */
export function errorLines(errors: unknown): string[] {
  if (typeof errors === "string") {
    return [errors];
  }
  if (Array.isArray(errors)) {
    return errors.flatMap(errorLines);
  }
  if (errors !== null && typeof errors === "object") {
    return Object.entries(errors).flatMap(([about, messages]) => errorLines(messages).map(message => `${about}: ${message}`));
  }
  return errors === undefined ? [] : [JSON.stringify(errors)];
}

/** Make the credential the Portal takes: its user token's username and password, as `Bearer` base64 of `username:password`. */
export function portalCredential(token: () => Computable<{ username: string; password: string }>): Credential {
  return {
    authorize: (_request, challenge) =>
      challenge !== undefined
        ? Computable.resolve<ReadonlyMap<string, string> | undefined>(undefined)
        : token().then(
            ({ username, password }) =>
              new Map([["authorization", `Bearer ${Buffer.from(`${username}:${password}`).toString("base64")}`]])
          ),
  };
}

/** Make the error for a failed request to the Portal, with the response's body as its detail. */
function failure(doing: string, url: SecureString, response: HttpResponse): FabrError {
  const detail = response.body.toString("utf8").trim();
  return new FabrError(`${doing} ${shownUrl(url)} failed (${response.statusCode})${detail === "" ? "" : `: ${detail}`}`);
}

/**
 * Check the Portal at `portal` takes `credential`, the token of the
 * `settings.xml` server `server`, by asking the status of a deployment that
 * does not exist. Rejects where it refuses the token, or cannot be reached.
 */
export function checkPortalToken(
  portal: SecureString,
  credential: Credential,
  server: string,
  send: Send = sendRequest
): Computable<void> {
  const status = urlJoin(portal, `api/v1/publisher/status?id=${NO_DEPLOYMENT}`);
  return send(status, { method: "POST", credential }).then(response => {
    if (response.statusCode === 401 || response.statusCode === 403) {
      throw failure("signing in to", status, response).withHelp(
        `check the Publisher Portal user token settings.xml gives server '${server}'`
      );
    }
  });
}

/** @return true if a failed read of a deployment's status may succeed if made again, otherwise false. */
function transient(response: HttpResponse): boolean {
  return response.statusCode === 429 || response.statusCode >= 500;
}

/**
 * Upload `files`, a release in Maven's repository layout, to the Portal at
 * `portal` as one deployment named `name`, and wait until it has been
 * validated (under `staging`) or is on its way to Central (otherwise). The
 * deployment's id is added to `report`'s annotation. Rejects where the upload
 * fails, the Portal fails the deployment (with its errors), its status cannot
 * be read, or it is still not done after an hour; once uploaded, an error
 * names the deployment, which the Portal may still publish.
 */
export function publishToPortal(
  portal: SecureString,
  credential: Credential,
  files: FileSet,
  name: string,
  staging: boolean,
  report: ITaskReport,
  send: Send = sendRequest,
  wait: Wait = ms => Computable.from<void>(resolve => void setTimeout(resolve, ms))
): Computable<void> {
  const query = `publishingType=${staging ? "USER_MANAGED" : "AUTOMATIC"}&name=${encodeURIComponent(name)}`;
  const upload = urlJoin(portal, `api/v1/publisher/upload?${query}`);
  const boundary = `fabr-${crypto.randomBytes(12).toString("hex")}`;
  return packToZip(files)
    .then(zip =>
      send(upload, {
        method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        body: multipartBody(zip, boundary),
        credential,
      })
    )
    .then(response => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw failure("uploading to", upload, response);
      }
      const id = response.body.toString("utf8").trim();
      if (id === "") {
        throw new FabrError(`uploading to ${shownUrl(upload)} gave no deployment id`).withHelp(
          `see whether the upload is among the deployments at ${DEPLOYMENTS_PAGE}`
        );
      }
      report.annotate(`deployment ${id}`);
      const status = urlJoin(portal, `api/v1/publisher/status?id=${encodeURIComponent(id)}`);
      const unknown = (reason: string): FabrError =>
        new FabrError(`deployment ${id} was uploaded, and ${reason}`).withHelp(
          `see how it went at ${DEPLOYMENTS_PAGE}; it may be published still`
        );
      /* One cell, each read started from the last one's callback, so the
       * chain does not deepen however many reads it takes. */
      return Computable.from<void>((resolve, reject) => {
        const read = (waited: number, failed: number): void => {
          const again = (reason: string): void => {
            if (failed + 1 >= POLL_RETRIES) {
              reject(unknown(`its status could not be read: ${reason}`));
            } else {
              wait(POLL_INTERVAL_MS).once(() => read(waited + POLL_INTERVAL_MS, failed + 1), reject);
            }
          };
          send(status, { method: "POST", credential }).once(
            answer => {
              if (answer.statusCode !== 200) {
                const reason = failure("reading", status, answer).message;
                return transient(answer) ? again(reason) : reject(unknown(`its status could not be read: ${reason}`));
              }
              let state: string;
              let errors: unknown;
              try {
                ({ state, errors } = parseJson(answer.body, `the status of deployment ${id}`, toDeploymentStatus));
              } catch (err) {
                return reject(unknown(`its status could not be read: ${(err as Error).message}`));
              }
              if (state === "FAILED") {
                const lines = errorLines(errors);
                return reject(
                  new FabrError(
                    `the Publisher Portal failed deployment ${id}${lines.length === 0 ? "" : `:\n${lines.map(line => `  ${line}`).join("\n")}`}`
                  )
                );
              }
              if (deploymentDone(state, staging)) {
                return resolve(undefined);
              }
              if (waited >= POLL_LIMIT_MS) {
                return reject(unknown(`is still ${state} after an hour`));
              }
              wait(POLL_INTERVAL_MS).once(() => read(waited + POLL_INTERVAL_MS, 0), reject);
            },
            err => again(err.message)
          );
        };
        read(0, 0);
      });
    });
}
