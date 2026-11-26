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
import {
  Computable,
  FileSet,
  HttpRequest,
  HttpResponse,
  MemoryFile,
  readZipMembers,
  SecureString,
  SILENT_REPORT,
} from "@fabr-build/core";
import { checkPortalToken, deploymentDone, errorLines, portalCredential, publishToPortal, Send, Wait } from "./CentralPortal";

const PORTAL = SecureString.of("https://central.sonatype.com");

interface Sent {
  url: string;
  request: HttpRequest;
}

/** A stub Portal: what was sent to it, and the functions that send to it and wait. */
interface StubPortal {
  sent: Sent[];
  send: Send;
  wait: Wait;
}

/** A status the stub Portal answers a read with: a document, a response of another status, or a request that fails. */
type StubStatus = { deploymentState: string; errors?: unknown } | { statusCode: number } | "unreachable";

/** Make a stub Portal answering an upload with `id` and each status read with the next of `states`, recording what is sent. */
function stubPortal(id: string, states: StubStatus[], uploadStatus = 201): StubPortal {
  const sent: Sent[] = [];
  const send = (url: SecureString, request: HttpRequest): Computable<HttpResponse> => {
    sent.push({ url: url.toUnmaskedString(), request });
    const answer = (statusCode: number, body: string): HttpResponse => ({ statusCode, headers: {}, body: Buffer.from(body) });
    if (url.toUnmaskedString().includes("/upload")) {
      return Computable.resolve(answer(uploadStatus, uploadStatus === 201 ? id : "bad bundle"));
    }
    const next = states.shift()!;
    if (next === "unreachable") {
      return Computable.reject(new Error("connection reset"));
    }
    return Computable.resolve(
      "statusCode" in next ? answer(next.statusCode, "busy") : answer(200, JSON.stringify({ deploymentId: id, ...next }))
    );
  };
  return { sent, send, wait: () => Computable.resolve(undefined) };
}

const release = new FileSet(
  new Map([
    ["com/example/app/1.0.0/app-1.0.0.jar", MemoryFile.from("JAR")],
    ["com/example/app/1.0.0/app-1.0.0.pom", MemoryFile.from("<project/>")],
  ])
);

/** @return the message `computable` rejects with, or undefined where it resolves. */
function rejection(computable: Computable<unknown>): Promise<string | undefined> {
  return new Promise(resolve =>
    computable.then(
      () => resolve(undefined),
      err => resolve((err as Error).message)
    )
  );
}

describe("the Publisher Portal", () => {
  it("is signed in with the user token as Bearer base64 of username:password", async () => {
    const credential = portalCredential(() => Computable.resolve({ username: "user", password: "pass" }));
    const headers = await credential.authorize({ url: "https://central.sonatype.com/api", method: "POST", headers: new Map() });
    expect(headers?.get("authorization")).to.equal(`Bearer ${Buffer.from("user:pass").toString("base64")}`);
  });

  it("is done with a staged deployment once validated or further, and with any other once it is on its way to Central", () => {
    expect(deploymentDone("VALIDATED", true)).to.equal(true);
    expect(deploymentDone("PUBLISHED", true)).to.equal(true);
    expect(deploymentDone("VALIDATED", false)).to.equal(false);
    expect(deploymentDone("PUBLISHING", false)).to.equal(true);
    expect(deploymentDone("PUBLISHED", false)).to.equal(true);
    expect(deploymentDone("VALIDATING", true)).to.equal(false);
  });

  it("uploads a release as one zipped bundle, then reads its status until it is on its way to Central", async () => {
    const portal = stubPortal("dep-1", [
      { deploymentState: "PENDING" },
      { deploymentState: "VALIDATING" },
      { deploymentState: "PUBLISHING" },
    ]);
    const annotations: string[] = [];
    await publishToPortal(
      PORTAL,
      portalCredential(() => Computable.resolve({ username: "u", password: "p" })),
      release,
      "@mvn:com.example/app:1.0.0",
      false,
      { ...SILENT_REPORT, annotate: text => annotations.push(text) },
      portal.send,
      portal.wait
    );
    expect(portal.sent.map(({ url }) => url)).to.deep.equal([
      "https://central.sonatype.com/api/v1/publisher/upload?publishingType=AUTOMATIC&name=%40mvn%3Acom.example%2Fapp%3A1.0.0",
      "https://central.sonatype.com/api/v1/publisher/status?id=dep-1",
      "https://central.sonatype.com/api/v1/publisher/status?id=dep-1",
      "https://central.sonatype.com/api/v1/publisher/status?id=dep-1",
    ]);
    expect(annotations).to.deep.equal(["deployment dep-1"]);
    const upload = portal.sent[0].request;
    const boundary = /boundary=(.*)$/.exec(upload.headers!["content-type"])![1];
    const body = upload.body as Buffer;
    expect(body.toString("latin1")).to.contain(
      `--${boundary}\r\nContent-Disposition: form-data; name="bundle"; filename="bundle.zip"`
    );
    const zip = body.subarray(body.indexOf("\r\n\r\n") + 4, body.lastIndexOf(`\r\n--${boundary}--`));
    const members = await readZipMembers(zip, () => true);
    expect([...members.keys()].sort()).to.deep.equal(["com/example/app/1.0.0/app-1.0.0.jar", "com/example/app/1.0.0/app-1.0.0.pom"]);
  });

  it("stops at validation under staging, asking the Portal to hold the deployment", async () => {
    const portal = stubPortal("dep-2", [{ deploymentState: "VALIDATING" }, { deploymentState: "VALIDATED" }]);
    await publishToPortal(
      PORTAL,
      portalCredential(() => Computable.resolve({ username: "u", password: "p" })),
      release,
      "release",
      true,
      SILENT_REPORT,
      portal.send,
      portal.wait
    );
    expect(portal.sent[0].url).to.contain("publishingType=USER_MANAGED");
    expect(portal.sent).to.have.length(3);
  });

  it("fails with the Portal's errors where it fails the deployment, and with its answer where it refuses the upload", async () => {
    const credential = portalCredential(() => Computable.resolve({ username: "u", password: "p" }));
    const failed = stubPortal("dep-3", [
      {
        deploymentState: "FAILED",
        errors: { "pkg:maven/com.example/app@1.0.0": ["Javadocs must be provided but not found in entries"] },
      },
    ]);
    expect(
      await rejection(publishToPortal(PORTAL, credential, release, "r", false, SILENT_REPORT, failed.send, failed.wait))
    ).to.equal(
      "the Publisher Portal failed deployment dep-3:\n  pkg:maven/com.example/app@1.0.0: Javadocs must be provided but not found in entries"
    );
    const refused = stubPortal("dep-4", [], 400);
    expect(
      await rejection(publishToPortal(PORTAL, credential, release, "r", false, SILENT_REPORT, refused.send, refused.wait))
    ).to.match(/^uploading to https:\/\/central\.sonatype\.com\/api\/v1\/publisher\/upload\?.* failed \(400\): bad bundle$/);
  });

  it("shows errors of any shape, one line per message", () => {
    expect(errorLines("broken")).to.deep.equal(["broken"]);
    expect(errorLines({ a: ["x", "y"], b: "z" })).to.deep.equal(["a: x", "a: y", "b: z"]);
    expect(errorLines(undefined)).to.deep.equal([]);
  });

  it("is asked whether it takes the token before anything is uploaded, and its refusal says which server's token", async () => {
    const credential = portalCredential(() => Computable.resolve({ username: "u", password: "p" }));
    const answering =
      (statusCode: number): Send =>
      () =>
        Computable.resolve({ statusCode, headers: {}, body: Buffer.from('{"error":{"message":"Invalid token"}}') });
    expect(await rejection(checkPortalToken(PORTAL, credential, "central", answering(404)))).to.equal(undefined);
    expect(await rejection(checkPortalToken(PORTAL, credential, "central", answering(401)))).to.match(
      /^signing in to https:\/\/central\.sonatype\.com\/api\/v1\/publisher\/status\?id=0{8}-.* failed \(401\): \{"error":\{"message":"Invalid token"\}\}$/
    );
  });

  it("reads a deployment's status again where a read fails for now, and names the deployment where it cannot be read", async () => {
    const credential = portalCredential(() => Computable.resolve({ username: "u", password: "p" }));
    const recovers = stubPortal("dep-5", [{ statusCode: 502 }, "unreachable", { deploymentState: "PUBLISHED" }]);
    expect(
      await rejection(publishToPortal(PORTAL, credential, release, "r", false, SILENT_REPORT, recovers.send, recovers.wait))
    ).to.equal(undefined);
    const lost = stubPortal("dep-6", [
      { statusCode: 502 },
      { statusCode: 503 },
      "unreachable",
      { statusCode: 429 },
      { statusCode: 500 },
    ]);
    expect(await rejection(publishToPortal(PORTAL, credential, release, "r", false, SILENT_REPORT, lost.send, lost.wait))).to.match(
      /^deployment dep-6 was uploaded, and its status could not be read: reading .* failed \(500\): busy$/
    );
    const refused = stubPortal("dep-7", [{ statusCode: 404 }]);
    expect(
      await rejection(publishToPortal(PORTAL, credential, release, "r", false, SILENT_REPORT, refused.send, refused.wait))
    ).to.match(/^deployment dep-7 was uploaded, and its status could not be read/);
  });

  it("refuses an upload answered with no deployment id", async () => {
    const credential = portalCredential(() => Computable.resolve({ username: "u", password: "p" }));
    const portal = stubPortal("", []);
    expect(
      await rejection(publishToPortal(PORTAL, credential, release, "r", false, SILENT_REPORT, portal.send, portal.wait))
    ).to.match(/gave no deployment id$/);
  });

  it("reads a deployment's status as many times as validation takes", async () => {
    const credential = portalCredential(() => Computable.resolve({ username: "u", password: "p" }));
    const later: Wait = () => Computable.from<void>(resolve => void setImmediate(resolve));
    const slow = stubPortal("dep-8", [...Array(700).fill({ deploymentState: "VALIDATING" }), { deploymentState: "PUBLISHED" }]);
    expect(await rejection(publishToPortal(PORTAL, credential, release, "r", false, SILENT_REPORT, slow.send, later))).to.equal(
      undefined
    );
    expect(slow.sent).to.have.length(702);
    const stuck = stubPortal("dep-10", Array(800).fill({ deploymentState: "VALIDATING" }));
    expect(await rejection(publishToPortal(PORTAL, credential, release, "r", false, SILENT_REPORT, stuck.send, later))).to.equal(
      "deployment dep-10 was uploaded, and is still VALIDATING after an hour"
    );
  });

  it("names the deployment where a status document cannot be read", async () => {
    const credential = portalCredential(() => Computable.resolve({ username: "u", password: "p" }));
    const portal = stubPortal("dep-9", [{ deploymentState: 3 as unknown as string }]);
    expect(
      await rejection(publishToPortal(PORTAL, credential, release, "r", false, SILENT_REPORT, portal.send, portal.wait))
    ).to.match(/^deployment dep-9 was uploaded, and its status could not be read: .*deploymentState/);
  });
});
