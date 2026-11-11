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

import { expect } from "chai";
import { bundleFromJSON, isBundleWithDsseEnvelope, SerializedBundle } from "@sigstore/bundle";
import * as crypto from "node:crypto";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { preAuthEncoding, signDsse } from "./Sigstore";

/** A certificate for the fake Fulcio to issue (its key is not the requester's). */
const CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIBJzCBzgIJAJfJvFEElpo7MAoGCCqGSM49BAMCMBsxGTAXBgNVBAMMEGZhYnIt
dGVzdC1mdWxjaW8wIBcNMjYxMTExMDI0MzAxWhgPMjEyNjEwMTgwMjQzMDFaMBsx
GTAXBgNVBAMMEGZhYnItdGVzdC1mdWxjaW8wWTATBgcqhkjOPQIBBggqhkjOPQMB
BwNCAASixLPyPpMtg39bfwejfBKj1fZfJH4IYZh8DuVlD4eeBDQ/QjcYynjEQnvu
i5oBWk0tSGCd0oy2JZXic3fOO7uuMAoGCCqGSM49BAMCA0gAMEUCIQD8lycWVf8S
07g74WFv3ck8l+7FcyjjHWIjU6S31EwhtAIgZPDNsOQR9elPe7TNMzUFq6SzylrL
SZmsJo0cKcK3owM=
-----END CERTIFICATE-----
`;

interface IReceived {
  url?: string;
  body: Record<string, unknown>;
}

/** Serve a fake Sigstore instance: Fulcio issuing {@link CERTIFICATE} and
 *  Rekor logging an entry, each answering with `status` where given. */
function fakeSigstore(
  status: { fulcio?: number; rekor?: number } = {}
): Promise<{ url: string; received: IReceived[]; close: () => void }> {
  return new Promise(resolve => {
    const received: IReceived[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", c => chunks.push(c));
      req.on("end", () => {
        received.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
        if (req.url === "/api/v2/signingCert") {
          res.writeHead(status.fulcio ?? 201, { "content-type": "application/json" });
          res.end(JSON.stringify({ signedCertificateEmbeddedSct: { chain: { certificates: [CERTIFICATE, "intermediate"] } } }));
        } else {
          res.writeHead(status.rekor ?? 201, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              "24296fb24b8ad77a": {
                body: Buffer.from(JSON.stringify({ apiVersion: "0.0.1", kind: "dsse" })).toString("base64"),
                integratedTime: 1700000000,
                logID: "c0ffee",
                logIndex: 42,
                verification: {
                  signedEntryTimestamp: Buffer.from("timestamp").toString("base64"),
                  inclusionProof: { logIndex: 41, treeSize: 100, rootHash: "abcd", hashes: ["ef01"], checkpoint: "checkpoint\n" },
                },
              },
            })
          );
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve({ url, received, close: () => server.close() });
    });
  });
}

/** Make an unsigned JWT whose payload is `claims`. */
function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part(claims)}.signature`;
}

function sign(token: string, url: string): Promise<SerializedBundle> {
  return new Promise((resolve, reject) =>
    signDsse(Buffer.from('{"_type":"statement"}'), "application/vnd.in-toto+json", token, { fulcioUrl: url, rekorUrl: url }).then(
      resolve,
      reject
    )
  );
}

describe("signDsse", () => {
  const token = jwt({ sub: "repo:acme/widgets:ref:refs/tags/v1.0.0", aud: "sigstore" });

  it("proves possession of an ephemeral key to Fulcio with the token's subject", async () => {
    const sigstore = await fakeSigstore();
    try {
      await sign(token, sigstore.url);
      const request = sigstore.received[0].body as {
        credentials: { oidcIdentityToken: string };
        publicKeyRequest: { publicKey: { algorithm: string; content: string }; proofOfPossession: string };
      };
      expect(sigstore.received[0].url).to.equal("/api/v2/signingCert");
      expect(request.credentials.oidcIdentityToken).to.equal(token);
      expect(request.publicKeyRequest.publicKey.algorithm).to.equal("ECDSA");
      const { content } = request.publicKeyRequest.publicKey;
      const proof = Buffer.from(request.publicKeyRequest.proofOfPossession, "base64");
      expect(crypto.verify("sha256", Buffer.from("repo:acme/widgets:ref:refs/tags/v1.0.0"), content, proof)).to.equal(true);
    } finally {
      sigstore.close();
    }
  });

  it("signs the DSSE encoding of the payload with that key, logs the envelope and bundles it all", async () => {
    const sigstore = await fakeSigstore();
    try {
      const serialized = await sign(token, sigstore.url);
      const publicKey = (sigstore.received[0].body as { publicKeyRequest: { publicKey: { content: string } } }).publicKeyRequest
        .publicKey.content;
      const bundle = bundleFromJSON(serialized);
      expect(bundle.mediaType).to.equal("application/vnd.dev.sigstore.bundle.v0.3+json");
      expect(isBundleWithDsseEnvelope(bundle)).to.equal(true);
      const envelope = isBundleWithDsseEnvelope(bundle) ? bundle.content.dsseEnvelope : undefined;
      expect(envelope!.payload.toString()).to.equal('{"_type":"statement"}');
      expect(envelope!.payloadType).to.equal("application/vnd.in-toto+json");
      const signed = preAuthEncoding("application/vnd.in-toto+json", Buffer.from('{"_type":"statement"}'));
      expect(crypto.verify("sha256", signed, publicKey, envelope!.signatures[0].sig)).to.equal(true);

      const rekor = sigstore.received[1];
      expect(rekor.url).to.equal("/api/v1/log/entries");
      const spec = rekor.body as { kind: string; spec: { proposedContent: { envelope: string; verifiers: string[] } } };
      expect(spec.kind).to.equal("dsse");
      expect(JSON.parse(spec.spec.proposedContent.envelope)).to.deep.equal(serialized.dsseEnvelope);
      expect(Buffer.from(spec.spec.proposedContent.verifiers[0], "base64").toString()).to.equal(CERTIFICATE);

      expect(serialized.verificationMaterial.certificate?.rawBytes).to.equal(
        new crypto.X509Certificate(CERTIFICATE).raw.toString("base64")
      );
      expect(serialized.verificationMaterial.tlogEntries).to.deep.equal([
        {
          logIndex: "42",
          logId: { keyId: Buffer.from("c0ffee", "hex").toString("base64") },
          kindVersion: { kind: "dsse", version: "0.0.1" },
          integratedTime: "1700000000",
          inclusionPromise: { signedEntryTimestamp: Buffer.from("timestamp").toString("base64") },
          inclusionProof: {
            logIndex: "41",
            rootHash: Buffer.from("abcd", "hex").toString("base64"),
            treeSize: "100",
            hashes: [Buffer.from("ef01", "hex").toString("base64")],
            checkpoint: { envelope: "checkpoint\n" },
          },
          canonicalizedBody: Buffer.from(JSON.stringify({ apiVersion: "0.0.1", kind: "dsse" })).toString("base64"),
        },
      ]);
    } finally {
      sigstore.close();
    }
  });

  it("fails where Fulcio refuses, and logs nothing", async () => {
    const sigstore = await fakeSigstore({ fulcio: 401 });
    try {
      const err = await sign(token, sigstore.url).then(
        () => undefined,
        (e: Error) => e
      );
      expect(err?.message).to.match(/^Fulcio at .* failed \(401\)/);
      expect(err?.message).to.not.contain(token);
      expect(sigstore.received.map(r => r.url)).to.deep.equal(["/api/v2/signingCert"]);
    } finally {
      sigstore.close();
    }
  });

  it("fails where Rekor refuses", async () => {
    const sigstore = await fakeSigstore({ rekor: 500 });
    try {
      const err = await sign(token, sigstore.url).then(
        () => undefined,
        (e: Error) => e
      );
      expect(err?.message).to.match(/^Rekor at .* failed \(500\)/);
    } finally {
      sigstore.close();
    }
  });

  it("proves possession with a verified email, and refuses an unverified one", async () => {
    const sigstore = await fakeSigstore();
    try {
      await sign(jwt({ sub: "subject", email: "ci@acme.example", email_verified: true }), sigstore.url);
      const request = sigstore.received[0].body as { publicKeyRequest: { publicKey: { content: string }; proofOfPossession: string } };
      const proof = Buffer.from(request.publicKeyRequest.proofOfPossession, "base64");
      expect(crypto.verify("sha256", Buffer.from("ci@acme.example"), request.publicKeyRequest.publicKey.content, proof)).to.equal(
        true
      );
      const err = await sign(jwt({ email: "ci@acme.example" }), sigstore.url).then(
        () => undefined,
        (e: Error) => e
      );
      expect(err?.message).to.equal("the identity token for Sigstore names an email its issuer has not verified");
    } finally {
      sigstore.close();
    }
  });
});
