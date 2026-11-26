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
import * as http from "node:http";
import { AddressInfo } from "node:net";
import {
  Computable,
  Credential,
  FileSet,
  MemoryFile,
  Property,
  PublishableFileSet,
  PublishStatus,
  SecureString,
  SILENT_REPORT,
  TargetContext,
} from "@fabr-build/core";
import { MavenPublishRef, packageClassifiedMember, packageMavenMember } from "./MavenPublish";
import { MavenPublishing, MavenRepository, publishingOf } from "./MavenRepository";
import { userSettingsPath } from "./MavenAuth";

const SETTINGS = `<settings><servers>
  <server><id>central</id><username>tokuser</username><password>tokpass</password></server>
  <server><id>releases</id><username>deploy</username><password>pw</password></server>
</servers></settings>`;

/** Make the context a repository named `name` is declared in, reading `settings.xml` as {@link SETTINGS}. */
function repositoryContext(name = "@central"): TargetContext {
  const plugins = new Map<unknown, unknown>();
  return {
    name,
    operation: "build",
    execution: {
      getOrCreatePluginContext: (key: unknown, create: () => unknown) => {
        if (!plugins.has(key)) {
          plugins.set(key, create());
        }
        return plugins.get(key);
      },
      absFileSource: {
        get: (path: string) => Computable.resolve(path === userSettingsPath() ? MemoryFile.from(SETTINGS) : undefined),
      },
    },
  } as unknown as TargetContext;
}

/** A credential that signs every request in as `who`. */
function credentialOf(who: string): Credential {
  return { authorize: () => Computable.resolve(new Map([["authorization", who]])) };
}

/** @return the headers `credential` signs a request to `url` in with. */
function signIn(credential: Credential, url: string): Promise<ReadonlyMap<string, string> | undefined> {
  return new Promise((resolve, reject) => credential.authorize({ method: "PUT", url, headers: new Map() }).then(resolve, reject));
}

/** @return a Property holding `text`. */
function property(text: string): Property {
  return new Property([SecureString.of(text)]);
}

/** @return the message `computable` rejects with, or undefined where it resolves. */
function rejection(computable: Computable<unknown>): Promise<string | undefined> {
  return new Promise(resolve =>
    computable.then(
      () => resolve(undefined),
      err => resolve((err as Error).message)
    )
  );
}

describe("publishingOf", () => {
  const url = SecureString.of("https://nexus.example.com/public");

  it("uploads a deploy repository's files to its url, signed in with its own credential", async () => {
    const publishing = publishingOf(repositoryContext(), url, "@central", credentialOf("own"), {});
    expect([publishing.type, publishing.url.toUnmaskedString(), publishing.serverId]).to.deep.equal([
      "deploy",
      "https://nexus.example.com/public",
      "@central",
    ]);
    expect((await signIn(publishing.credential, "https://nexus.example.com/x"))?.get("authorization")).to.equal("own");
  });

  it("keeps the repository's own credential for publish_url alone, and takes publish_id's server where it is named", async () => {
    const releases = "https://nexus.example.com/releases";
    const moved = publishingOf(repositoryContext(), url, "@central", credentialOf("own"), { url: property(releases) });
    expect((await signIn(moved.credential, releases))?.get("authorization")).to.equal("own");
    const named = publishingOf(repositoryContext(), url, "@central", credentialOf("own"), {
      url: property(releases),
      id: property("releases"),
    });
    expect((await signIn(named.credential, releases))?.get("authorization")).to.equal(
      `Basic ${Buffer.from("deploy:pw").toString("base64")}`
    );
    expect(await signIn(named.credential, "https://elsewhere.example.com/x")).to.deep.equal(new Map());
  });

  it("uploads to the Portal for publish_type = portal, signed in with publish_id's token, sent nowhere else", async () => {
    const portal = publishingOf(repositoryContext(), url, "@central", credentialOf("own"), {
      type: property("portal"),
      id: property("central"),
    });
    expect([portal.type, portal.url.toUnmaskedString()]).to.deep.equal(["portal", "https://central.sonatype.com"]);
    expect((await signIn(portal.credential, "https://central.sonatype.com/api"))?.get("authorization")).to.equal(
      `Bearer ${Buffer.from("tokuser:tokpass").toString("base64")}`
    );
    expect(await signIn(portal.credential, "https://nexus.example.com/public/x")).to.deep.equal(new Map());
  });

  it("refuses staging for publish_type = deploy, and values a property does not take", () => {
    const context = repositoryContext();
    expect(() => publishingOf(context, url, "@central", credentialOf("own"), { staging: property("on") })).to.throw(
      "@central cannot stage what it publishes: only publish_type = portal holds an upload"
    );
    expect(() => publishingOf(context, url, "@central", credentialOf("own"), { type: property("ftp") })).to.throw(
      "@central's publish_type is 'ftp', which is not deploy or portal"
    );
    expect(() => publishingOf(context, url, "@central", credentialOf("own"), { sign: property("yes") })).to.throw(
      "@central's sign is 'yes', which is not on or off"
    );
  });
});

/** A stub Portal and read repository on one origin: what it was sent, and what its reads serve. */
interface StubServer {
  url: string;
  seen: string[];
  close(): void;
}

/**
 * Serve the Portal's API, answering the token check with 404, an upload with
 * a deployment id and each status read `PUBLISHED`, and, under `/public`, a
 * read repository serving each path ending with one of `served`.
 */
function stubServer(served: string[]): Promise<StubServer> {
  return new Promise(resolve => {
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const url = req.url ?? "";
        seen.push(`${req.method} ${url.replace(/\?.*$/, "")}`);
        if (url.includes(`status?id=${"0".repeat(8)}`)) {
          res.writeHead(404).end();
        } else if (url.startsWith("/api/v1/publisher/upload")) {
          res.writeHead(201).end("dep-1");
        } else if (url.startsWith("/api/v1/publisher/status")) {
          res.writeHead(200, { "content-type": "application/json" }).end('{"deploymentState":"PUBLISHED"}');
        } else {
          res.writeHead(served.some(path => url.endsWith(path)) ? 200 : 404).end();
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve({ url, seen, close: () => server.close() });
    });
  });
}

describe("MavenRepository publishing to the Portal", () => {
  const files = (entries: Record<string, string>): FileSet =>
    new FileSet(new Map(Object.entries(entries).map(([name, text]) => [name, MemoryFile.from(text)])));

  /** Make a Portal-backed repository reading from `<url>/public` and uploading to `url`, and its release of a jar and its sources. */
  const release = async (url: string): Promise<{ repository: MavenRepository; carriers: PublishableFileSet[] }> => {
    const context = repositoryContext();
    const readUrl = SecureString.of(`${url}/public`);
    const publishing: MavenPublishing = publishingOf(context, readUrl, "@central", credentialOf("own"), {
      type: property("portal"),
      url: property(url),
      id: property("central"),
    });
    const repository = new MavenRepository(context, readUrl, "@central", [], credentialOf("own"), publishing);
    const ref = (variant?: string): MavenPublishRef =>
      new MavenPublishRef(repository, { name: "com.example/app", version: "1.0.0", variant }, "@central");
    const main = await packageMavenMember({ destination: ref(), content: files({ "app.jar": "JAR" }) }, new Map(), new Set(), [
      ref(),
      ref("sources"),
    ]);
    const sources = await packageClassifiedMember({ destination: ref("sources"), content: files({ "A.java": "" }) }, [
      ref(),
      ref("sources"),
    ]);
    return { repository, carriers: [main, sources] };
  };

  it("checks the token, reads what is published, and uploads the release as one deployment", async () => {
    const server = await stubServer([]);
    try {
      const { repository, carriers } = await release(server.url);
      const statuses: PublishStatus[] = await repository.publishBatch!(carriers, SILENT_REPORT);
      expect(statuses).to.deep.equal(["published", "published"]);
      expect(server.seen[0]).to.equal("POST /api/v1/publisher/status");
      expect(server.seen.filter(request => request.startsWith("HEAD"))).to.have.length(2);
      expect(server.seen.slice(-2)).to.deep.equal(["POST /api/v1/publisher/upload", "POST /api/v1/publisher/status"]);
    } finally {
      server.close();
    }
  });

  it("uploads nothing where everything is published, and refuses a file for a version already published", async () => {
    const synced = await stubServer(["app-1.0.0.pom", "app-1.0.0-sources.jar"]);
    const late = await stubServer(["app-1.0.0.pom"]);
    try {
      const done = await release(synced.url);
      expect(await done.repository.publishBatch!(done.carriers, SILENT_REPORT)).to.deep.equal(["already-synced", "already-synced"]);
      expect(synced.seen.some(request => request.includes("upload"))).to.equal(false);
      const partial = await release(late.url);
      expect(await rejection(partial.repository.publishBatch!(partial.carriers, SILENT_REPORT))).to.match(
        /^cannot publish @central:com\.example\/app\/sources:1\.0\.0: its version is already published on .*, and a published version cannot gain files$/
      );
    } finally {
      synced.close();
      late.close();
    }
  });

  it("publishes one member as a deployment of its own", async () => {
    const server = await stubServer([]);
    try {
      const { repository, carriers } = await release(server.url);
      expect(await repository.publish(carriers[0], SILENT_REPORT)).to.equal("published");
      expect(server.seen.filter(request => request.includes("upload"))).to.have.length(1);
    } finally {
      server.close();
    }
  });
});
