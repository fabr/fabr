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
import * as crypto from "node:crypto";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { Computable, FileSet, IntegrityError, MemoryFile, versionToString } from "@fabr-build/core";
import {
  expectedTarballDigest,
  NPM_FORMAT,
  parseMetadataResponse,
  publishToRegistry,
  toPublishAccess,
  verifyTarballStream,
} from "./NPMProtocol";
import { OtpChallenge } from "./NPMAuth";

describe("parseMetadataResponse", () => {
  function doc(overrides: Record<string, unknown>): Buffer {
    return Buffer.from(
      JSON.stringify({ name: "pkg", version: "1.0.0", dist: { tarball: "https://example.com/pkg-1.0.0.tgz" }, ...overrides })
    );
  }

  it("accepts a well-formed version document", () => {
    const meta = parseMetadataResponse(doc({ dependencies: { lodash: "^4.0.0" } }), "pkg/1.0.0");
    expect(meta.name).to.equal("pkg");
  });

  it("rejects a document whose own name is invalid", () => {
    /* The document's name becomes the delivered identity (and mount path).
     * Thrown from the fetch's process callback, so the document never enters
     * the cache — the validate-before-cache invariant. Dependency names are
     * deliberately NOT checked: a dep key either fails to resolve (ordinary
     * error) or resolves to a document validated by this same check. */
    expect(() => parseMetadataResponse(doc({ name: "../evil" }), "pkg/1.0.0")).to.throw(/package name .* is not usable/);
    expect(() => parseMetadataResponse(doc({ dependencies: { "../evil": "^1.0.0" } }), "pkg/1.0.0")).to.not.throw();
  });

  it("rejects a document whose promised digest is not a string", () => {
    /* The digest fields are read as strings when a tarball is verified, so a
     * present-but-unusable one is rejected here rather than crashing there. */
    expect(() =>
      parseMetadataResponse(doc({ dist: { tarball: "https://example.com/pkg-1.0.0.tgz", integrity: 12345 } }), "pkg/1.0.0")
    ).to.throw(/Invalid response/);
  });

  it("accepts the legal-but-odd shapes npm itself normalizes away", () => {
    /* A published manifest need only satisfy the registry: string-form gates
     * and an empty-array dependency block are both real. */
    const meta = parseMetadataResponse(doc({ os: "darwin", dependencies: [] }), "pkg/1.0.0");
    expect(meta.os).to.equal("darwin");
  });
});


describe("expectedTarballDigest", () => {
  it("prefers the strongest SRI algorithm over a weaker one and the legacy shasum", () => {
    expect(expectedTarballDigest({ integrity: "sha256-aaa sha512-bbb", shasum: "ccc" })).to.deep.equal({
      algorithm: "sha512",
      encoding: "base64",
      value: "bbb",
    });
  });

  it("falls back to the legacy sha1 shasum (lowercased) when no SRI is present", () => {
    expect(expectedTarballDigest({ shasum: "ABCDEF01" })).to.deep.equal({
      algorithm: "sha1",
      encoding: "hex",
      value: "abcdef01",
    });
  });

  it("ignores a sha1 SRI entry — sha1 is honored only via shasum", () => {
    expect(expectedTarballDigest({ integrity: "sha1-aaa" })).to.equal(undefined);
  });

  it("is undefined when neither integrity nor shasum is promised", () => {
    expect(expectedTarballDigest({})).to.equal(undefined);
  });
});

describe("verifyTarballStream", () => {
  const bytes = Buffer.from("a plausible tarball payload");
  const sha512 = crypto.createHash("sha512").update(bytes).digest("base64");
  const sha1 = crypto.createHash("sha1").update(bytes).digest("hex");

  /** Feed `bytes` through the hashing pass-through to completion, then verify. */
  async function check(dist: { integrity?: string; shasum?: string }): Promise<void> {
    const { hashing, verify } = verifyTarballStream(dist, "https://example.com/pkg-1.0.0.tgz");
    await new Promise<void>((resolve, reject) => {
      hashing.on("data", () => undefined);
      hashing.on("end", resolve);
      hashing.on("error", reject);
      Readable.from([bytes]).pipe(hashing);
    });
    verify();
  }

  it("passes a tarball matching its sha512 SRI", async () => {
    await check({ integrity: `sha512-${sha512}` });
  });

  it("passes a tarball matching its legacy sha1 shasum", async () => {
    await check({ shasum: sha1 });
  });

  it("passes when the metadata promises no digest", async () => {
    await check({});
  });

  it("throws IntegrityError on a digest mismatch", async () => {
    const wrong = crypto.createHash("sha512").update("something else").digest("base64");
    let thrown: unknown;
    await check({ integrity: `sha512-${wrong}` }).catch(err => (thrown = err));
    expect(thrown).to.be.instanceOf(IntegrityError);
    expect((thrown as IntegrityError).algorithm).to.equal("sha512");
  });
});

/** What one scripted-server request looked like, as the handler saw it. */
interface SeenRequest {
  method?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * A local server whose `script` maps (request, index-so-far) to the reply —
 * lets a test express "401-challenge first, 201 once the otp arrives".
 * (NPMAuth.test.ts keeps its own copy for the doneUrl poll tests.)
 */
function scriptedServer(
  script: (request: SeenRequest, index: number) => { status: number; headers?: Record<string, string>; body: string }
): Promise<{ url: string; seen: SeenRequest[]; close(): void }> {
  return new Promise(resolve => {
    const seen: SeenRequest[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => {
        const request = { method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() };
        const reply = script(request, seen.length);
        seen.push(request);
        res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
        res.end(reply.body);
      });
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        seen,
        close: () => server.close(),
      })
    );
  });
}

const EOTP_BODY = `{"error":"You must provide a one-time pass."}`;
const EOTP_REPLY = { status: 401, headers: { "www-authenticate": "OTP" }, body: EOTP_BODY };

describe("publishToRegistry access", () => {
  const IDENTITY = { name: "@scope/demo", version: "1.0.0" };
  const TARBALL = Buffer.from("tgz-bytes");

  it("defaults the envelope's access to null (the registry decides)", async () => {
    const server = await scriptedServer(() => ({ status: 201, body: "{}" }));
    try {
      await publishToRegistry(server.url, IDENTITY, TARBALL, {}, {});
      expect(JSON.parse(server.seen[0].body).access).to.equal(null);
    } finally {
      server.close();
    }
  });

  it("requests the repository's declared access level", async () => {
    const server = await scriptedServer(() => ({ status: 201, body: "{}" }));
    try {
      await publishToRegistry(server.url, IDENTITY, TARBALL, {}, {}, "public");
      expect(JSON.parse(server.seen[0].body).access).to.equal("public");
    } finally {
      server.close();
    }
  });

  it("attaches the public-repository remedy to npmjs's private-packages refusal", async () => {
    const server = await scriptedServer(() => ({ status: 402, body: `{"error":"You must sign up for private packages"}` }));
    try {
      let thrown: unknown;
      await publishToRegistry(server.url, IDENTITY, TARBALL, {}, {}).catch(err => (thrown = err));
      expect((thrown as Error).message).to.match(/failed \(402\)/);
      expect((thrown as { help?: string }).help).to.match(/access = public/);
    } finally {
      server.close();
    }
  });
});

describe("toPublishAccess", () => {
  it("accepts the two access levels and treats absence as the registry default", () => {
    expect(toPublishAccess("public")).to.equal("public");
    expect(toPublishAccess("private")).to.equal("restricted");
    expect(toPublishAccess("restricted")).to.equal("restricted"); /* npm's wire synonym */
    expect(toPublishAccess(undefined)).to.equal(null);
  });

  it("rejects anything else", () => {
    expect(() => toPublishAccess("sekrit")).to.throw(/invalid access value/);
  });
});

describe("publishToRegistry second factor", () => {
  const IDENTITY = { name: "demo", version: "1.0.0" };
  const TARBALL = Buffer.from("tgz-bytes");
  const AUTH = { authorization: "Bearer tok" };

  it("advertises web-auth capability on the publish request", async () => {
    const server = await scriptedServer(() => ({ status: 201, body: "{}" }));
    try {
      expect(await publishToRegistry(server.url, IDENTITY, TARBALL, {}, AUTH)).to.equal("published");
      /* The registry only offers the passkey ceremony to a client sending both. */
      expect(server.seen[0].headers["npm-auth-type"]).to.equal("web");
      expect(server.seen[0].headers["npm-command"]).to.equal("publish");
    } finally {
      server.close();
    }
  });

  it("answers a challenge with the provided otp and retries", async () => {
    const server = await scriptedServer(request =>
      request.headers["npm-otp"] === "123456" ? { status: 201, body: "{}" } : EOTP_REPLY
    );
    const asked: Array<{ challenge: OtpChallenge; rejected?: string }> = [];
    try {
      const status = await publishToRegistry(server.url, IDENTITY, TARBALL, {}, AUTH, null, (challenge, rejected) => {
        asked.push({ challenge, rejected });
        return Computable.resolve("123456");
      });
      expect(status).to.equal("published");
      expect(asked).to.deep.equal([{ challenge: {}, rejected: undefined }]);
      expect(server.seen.length).to.equal(2);
      expect(server.seen[1].headers["npm-otp"]).to.equal("123456");
      expect(server.seen[1].headers.authorization).to.equal("Bearer tok");
    } finally {
      server.close();
    }
  });

  it("hands the provider the web-auth ceremony URLs when the registry offers them", async () => {
    const webChallenge = {
      status: 401,
      headers: { "www-authenticate": "OTP" },
      body: `{"authUrl":"https://www.npmjs.com/auth/cli/x","doneUrl":"https://registry.npmjs.org/-/v1/done?authId=x"}`,
    };
    const server = await scriptedServer(request =>
      request.headers["npm-otp"] === "ceremony-tok" ? { status: 201, body: "{}" } : webChallenge
    );
    try {
      const status = await publishToRegistry(server.url, IDENTITY, TARBALL, {}, AUTH, null, challenge => {
        expect(challenge.authUrl).to.equal("https://www.npmjs.com/auth/cli/x");
        expect(challenge.doneUrl).to.equal("https://registry.npmjs.org/-/v1/done?authId=x");
        return Computable.resolve("ceremony-tok");
      });
      expect(status).to.equal("published");
    } finally {
      server.close();
    }
  });

  it("re-acquires once when the first otp is refused (a stale cached token)", async () => {
    const server = await scriptedServer(request =>
      request.headers["npm-otp"] === "fresh" ? { status: 201, body: "{}" } : EOTP_REPLY
    );
    const asked: Array<string | undefined> = [];
    try {
      const status = await publishToRegistry(server.url, IDENTITY, TARBALL, {}, AUTH, null, (challenge, rejected) => {
        asked.push(rejected);
        return Computable.resolve(rejected === undefined ? "stale" : "fresh");
      });
      expect(status).to.equal("published");
      expect(asked).to.deep.equal([undefined, "stale"]);
      expect(server.seen.length).to.equal(3);
    } finally {
      server.close();
    }
  });

  it("fails rather than looping when the registry refuses every otp", async () => {
    const server = await scriptedServer(() => EOTP_REPLY);
    const asked: Array<string | undefined> = [];
    try {
      let thrown: unknown;
      await publishToRegistry(server.url, IDENTITY, TARBALL, {}, AUTH, null, (challenge, rejected) => {
        asked.push(rejected);
        return Computable.resolve("refused");
      }).catch(err => (thrown = err));
      expect((thrown as Error).message).to.match(/failed \(401\)/);
      expect(asked.length).to.equal(2);
    } finally {
      server.close();
    }
  });

  it("surfaces the raw challenge without a provider (non-2FA-capable caller)", async () => {
    const server = await scriptedServer(() => EOTP_REPLY);
    try {
      let thrown: unknown;
      await publishToRegistry(server.url, IDENTITY, TARBALL, {}, AUTH).catch(err => (thrown = err));
      expect((thrown as Error).message).to.match(/one-time pass/);
      expect(server.seen.length).to.equal(1);
    } finally {
      server.close();
    }
  });
});

describe("NPM_FORMAT.readContentPackage", () => {
  function packageFiles(manifest: Record<string, unknown>): FileSet {
    return new FileSet(new Map([["package.json", MemoryFile.from(JSON.stringify(manifest))]]));
  }

  async function failure(computable: Computable<unknown>): Promise<Error> {
    try {
      await computable;
    } catch (err) {
      return err as Error;
    }
    throw new Error("expected rejection, but it resolved");
  }

  const MANIFEST = {
    name: "amperize",
    version: "1.2.3",
    dependencies: { xmldom: "^0.6.0", fsevents: "^2.0.0" },
    optionalDependencies: { fsevents: "^2.0.0" },
    peerDependencies: { react: ">=16", ganache: "^7.0.0" },
    peerDependenciesMeta: { ganache: { optional: true } },
  };

  it("reads identity + requirements from the package.json, npm's reading", async () => {
    const content = await NPM_FORMAT.readContentPackage(packageFiles(MANIFEST));
    expect(content.name).to.equal("amperize");
    expect(versionToString(content.version)).to.equal("1.2.3");
    /* Regular dep kept; optionalDependencies dropped (their platform gates are
     * unprobeable in a manifest read, and optional means absence is tolerated)
     * including the fsevents dependencies-entry it overrides; non-optional peer
     * kept, soft; an `optional: true` peer kept too, and marked attach-only —
     * never installed, but a requirement all the same, so the requirer can
     * reach the package when a consumer does provide it. */
    expect(content.requirements).to.deep.equal([
      { pkg: "xmldom", constraint: "^0.6.0" },
      { pkg: "react", constraint: ">=16", soft: true },
      { pkg: "ganache", constraint: "^7.0.0", soft: true, attachOnly: true },
    ]);
  });

  it("requires a package.json at the content root, and says how to project to it", async () => {
    /* The git-tarball shape: manifest one level down, the root not stripped. */
    const files = new FileSet(new Map([["amperize-main/package.json", MemoryFile.from(JSON.stringify(MANIFEST))]]));
    const err = await failure(NPM_FORMAT.readContentPackage(files));
    expect(err.message).to.contain("no package.json at the content root");
    expect((err as { help?: string }).help).to.contain(":*:**");
  });

  it("rejects a manifest with no version", async () => {
    const unversioned: Record<string, unknown> = { ...MANIFEST };
    delete unversioned.version;
    const err = await failure(NPM_FORMAT.readContentPackage(packageFiles(unversioned)));
    expect(err.message).to.contain("package.json declares no version");
  });
});
