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

import { bundleToJSON, envelopeToJSON, SerializedBundle, toDSSEBundle, TransparencyLogEntry } from "@sigstore/bundle";
import * as crypto from "node:crypto";
import { Computable } from "../core/Computable";
import { FabrError } from "../core/Errors";
import { HttpResponse, sendRequest } from "../core/Fetch";
import { isJsonObject, parseJson, toJsonObject } from "./Json";
import { jwtClaims } from "./Jwt";

export type { SerializedBundle };

/** A Sigstore instance: its certificate authority (Fulcio) and transparency log (Rekor). */
export interface ISigstoreInstance {
  readonly fulcioUrl: string;
  readonly rekorUrl: string;
}

/** Sigstore's public-good instance. */
export const PUBLIC_SIGSTORE: ISigstoreInstance = {
  fulcioUrl: "https://fulcio.sigstore.dev",
  rekorUrl: "https://rekor.sigstore.dev",
};

/** The audience of the identity token Fulcio is given. */
export const SIGSTORE_AUDIENCE = "sigstore";

/**
 * Sign `payload`, of the DSSE payload type `payloadType`, as the CI job
 * `identityToken` (issued for {@link SIGSTORE_AUDIENCE}) names: an ephemeral
 * key, a certificate binding it to that identity from `instance`'s Fulcio, and
 * the signature recorded in its Rekor log. Resolves to the Sigstore bundle
 * (v0.3) holding the DSSE envelope, the certificate and the log entry. Any
 * failure is an error; nothing is signed without being logged.
 */
export function signDsse(
  payload: Buffer,
  payloadType: string,
  identityToken: string,
  instance: ISigstoreInstance = PUBLIC_SIGSTORE
): Computable<SerializedBundle> {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const sign = (data: Buffer): Buffer => crypto.sign("sha256", data, privateKey);
  return Computable.resolve(undefined)
    .then(() => {
      const proofOfPossession = sign(Buffer.from(identitySubject(identityToken))).toString("base64");
      return requestCertificate(instance.fulcioUrl, identityToken, publicKey.export({ format: "pem", type: "spki" }).toString(), proofOfPossession);
    })
    .then(certificate => {
      const bundle = toDSSEBundle({
        artifact: payload,
        artifactType: payloadType,
        signature: sign(preAuthEncoding(payloadType, payload)),
        certificate: new crypto.X509Certificate(certificate).raw,
        certificateChain: false,
      });
      return recordEntry(instance.rekorUrl, JSON.stringify(envelopeToJSON(bundle.content.dsseEnvelope)), certificate).then(entry => {
        bundle.verificationMaterial.tlogEntries = [entry];
        return bundleToJSON(bundle);
      });
    });
}

/** Get the identity `token` names, which Fulcio has the requester prove it
 *  holds the key for by signing: its verified `email`, else its `sub`. */
function identitySubject(token: string): string {
  const claims = jwtClaims(token, "the identity token for Sigstore");
  if (typeof claims.email === "string") {
    if (claims.email_verified !== true) {
      throw new FabrError("the identity token for Sigstore names an email its issuer has not verified");
    }
    return claims.email;
  }
  if (typeof claims.sub === "string") {
    return claims.sub;
  }
  throw new FabrError("the identity token for Sigstore names no subject");
}

/** Make DSSE's pre-authentication encoding of `payload`: what is signed. */
export function preAuthEncoding(payloadType: string, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`DSSEv1 ${Buffer.byteLength(payloadType)} ${payloadType} ${payload.length} `), payload]);
}

/** Ask Fulcio at `fulcioUrl` for a certificate binding `publicKey` (PEM) to
 *  the identity `identityToken` names; resolves to the leaf certificate (PEM). */
function requestCertificate(fulcioUrl: string, identityToken: string, publicKey: string, proofOfPossession: string): Computable<string> {
  return post(`${fulcioUrl}/api/v2/signingCert`, {
    credentials: { oidcIdentityToken: identityToken },
    publicKeyRequest: { publicKey: { algorithm: "ECDSA", content: publicKey }, proofOfPossession },
  }).then(response => parseJson(checked(response, "Fulcio", fulcioUrl), `certificate from Fulcio at ${fulcioUrl}`, toLeafCertificate));
}

/** Convert Fulcio's response to the leaf of the certificate chain it issued,
 *  with the certificate timestamp embedded or detached. */
function toLeafCertificate(json: unknown): string {
  const response = toJsonObject(json);
  const issued = response.signedCertificateEmbeddedSct ?? response.signedCertificateDetachedSct;
  const chain = isJsonObject(issued) && isJsonObject(issued.chain) ? issued.chain.certificates : undefined;
  if (!Array.isArray(chain) || typeof chain[0] !== "string") {
    throw new FabrError("expected a certificate chain");
  }
  return chain[0];
}

/** Record a DSSE `envelope` (JSON), signed with the key `certificate` (PEM)
 *  certifies, in the Rekor log at `rekorUrl`; resolves to its entry. */
function recordEntry(rekorUrl: string, envelope: string, certificate: string): Computable<TransparencyLogEntry> {
  return post(`${rekorUrl}/api/v1/log/entries`, {
    apiVersion: "0.0.1",
    kind: "dsse",
    spec: { proposedContent: { envelope, verifiers: [Buffer.from(certificate).toString("base64")] } },
  }).then(response => parseJson(checked(response, "Rekor", rekorUrl), `log entry from Rekor at ${rekorUrl}`, toLogEntry));
}

/** Convert Rekor's response, `{ "<uuid>": <entry> }`, to the bundle's form of the entry. */
function toLogEntry(json: unknown): TransparencyLogEntry {
  const entries = Object.values(toJsonObject(json));
  if (entries.length !== 1 || !isJsonObject(entries[0])) {
    throw new FabrError("expected one entry");
  }
  const entry = entries[0];
  const { body, logID, logIndex, integratedTime } = entry;
  if (typeof body !== "string" || typeof logID !== "string" || typeof logIndex !== "number" || typeof integratedTime !== "number") {
    throw new FabrError("expected an entry's body, logID, logIndex and integratedTime");
  }
  const kind = toJsonObject(JSON.parse(Buffer.from(body, "base64").toString("utf8")));
  const verification = isJsonObject(entry.verification) ? entry.verification : {};
  const { signedEntryTimestamp, inclusionProof: proof } = verification;
  return {
    logIndex: logIndex.toString(),
    logId: { keyId: Buffer.from(logID, "hex") },
    integratedTime: integratedTime.toString(),
    kindVersion: { kind: String(kind.kind), version: String(kind.apiVersion) },
    inclusionPromise: typeof signedEntryTimestamp === "string" ? { signedEntryTimestamp: Buffer.from(signedEntryTimestamp, "base64") } : undefined,
    inclusionProof: isJsonObject(proof) ? toInclusionProof(proof) : undefined,
    canonicalizedBody: Buffer.from(body, "base64"),
  };
}

/** Convert a Rekor entry's inclusion proof to the bundle's form. */
function toInclusionProof(proof: Record<string, unknown>): TransparencyLogEntry["inclusionProof"] {
  const { logIndex, treeSize, rootHash, hashes, checkpoint } = proof;
  if (
    typeof logIndex !== "number" ||
    typeof treeSize !== "number" ||
    typeof rootHash !== "string" ||
    typeof checkpoint !== "string" ||
    !Array.isArray(hashes) ||
    hashes.some(hash => typeof hash !== "string")
  ) {
    throw new FabrError("expected an inclusion proof's logIndex, treeSize, rootHash, hashes and checkpoint");
  }
  return {
    logIndex: logIndex.toString(),
    treeSize: treeSize.toString(),
    rootHash: Buffer.from(rootHash, "hex"),
    hashes: (hashes as string[]).map(hash => Buffer.from(hash, "hex")),
    checkpoint: { envelope: checkpoint },
  };
}

/** POST `body` as JSON to `url`. */
function post(url: string, body: unknown): Computable<HttpResponse> {
  return sendRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
}

/** Get `response`'s body where it succeeded, else throw the failure `service` at `url` reported. */
function checked(response: HttpResponse, service: string, url: string): Buffer {
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new FabrError(`${service} at ${url} failed (${response.statusCode}): ${response.body.toString("utf8").trim()}`);
  }
  return response.body;
}
