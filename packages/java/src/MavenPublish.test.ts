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
import * as openpgp from "openpgp";
import {
  Computable,
  FileSet,
  MemoryFile,
  PackageFileSet,
  PublishableFileSet,
  PublishStatus,
  readZipMembers,
  RepositoryCollection,
  RepositoryReader,
  RepositoryRef,
  RepositoryWriter,
  TargetContext,
} from "@fabr-build/core";
import { MAVEN_FORMAT } from "./MavenProtocol";
import { defaultKeyPath, KEY_VARIABLE, loadSigner, PASSPHRASE_VARIABLE, signerFor } from "./MavenSigning";
import {
  checkPomMetadata,
  checksumFiles,
  MavenPublishRef,
  mergedMetadata,
  metadataPath,
  packageClassifiedMember,
  packageMavenMember,
  pomText,
  publishedFilePath,
  repositoryPath,
  uploadOrder,
  variantOf,
  deploymentName,
} from "./MavenPublish";

describe("pomText", () => {
  it("records the coordinate, the dependencies with their scope, and the BOMs imported in dependencyManagement", () => {
    const pom = pomText({
      groupId: "com.example",
      artifactId: "app",
      version: "1.0.0",
      packaging: "jar",
      metadata: new Map(),
      dependencies: [
        { groupId: "org.slf4j", artifactId: "slf4j-api", version: "1.7.36", optional: false },
        { groupId: "jakarta.servlet", artifactId: "jakarta.servlet-api", version: "6.0.0", scope: "provided", optional: false },
        { groupId: "com.example", artifactId: "extra", version: "2.0", optional: true },
      ],
      dependencyManagement: [
        { groupId: "org.junit", artifactId: "junit-bom", version: "5.11.4", type: "pom", scope: "import", optional: false },
      ],
    });
    expect(pom).to.contain("<groupId>com.example</groupId>\n  <artifactId>app</artifactId>\n  <version>1.0.0</version>\n");
    expect(pom).not.to.contain("<packaging>");
    expect(pom).to.contain(
      "      <dependency>\n        <groupId>org.junit</groupId>\n        <artifactId>junit-bom</artifactId>\n        <version>5.11.4</version>\n" +
        "        <type>pom</type>\n        <scope>import</scope>\n      </dependency>\n"
    );
    expect(pom).to.contain(
      "<artifactId>jakarta.servlet-api</artifactId>\n      <version>6.0.0</version>\n      <scope>provided</scope>\n"
    );
    expect(pom).to.contain("<artifactId>extra</artifactId>\n      <version>2.0</version>\n      <optional>true</optional>\n");
  });

  it("names a packaging other than jar, and leaves out what a package has none of", () => {
    const pom = pomText({
      groupId: "com.example",
      artifactId: "shop",
      version: "1.0",
      packaging: "war",
      metadata: new Map(),
      dependencies: [],
      dependencyManagement: [],
    });
    expect(pom).to.contain("<packaging>war</packaging>");
    expect(pom).not.to.contain("<dependencies>");
    expect(pom).not.to.contain("<dependencyManagement>");
  });

  it("escapes what XML would read as markup", () => {
    expect(
      pomText({
        groupId: "a&b",
        artifactId: "c<d",
        version: "1",
        packaging: "jar",
        metadata: new Map(),
        dependencies: [],
        dependencyManagement: [],
      })
    ).to.contain("<groupId>a&amp;b</groupId>\n  <artifactId>c&lt;d</artifactId>");
  });
});

describe("POM metadata", () => {
  const pom = (metadata: Map<string, unknown>): string =>
    pomText({
      groupId: "g",
      artifactId: "a",
      version: "1",
      packaging: "jar",
      metadata: metadata as never,
      dependencies: [],
      dependencyManagement: [],
    });

  it("writes a string as an element, a block as nested elements, and a list element around its items", () => {
    const text = pom(
      new Map<string, unknown>([
        ["name", ["Greeter", "app"]],
        ["scm", new Map([["url", ["https://example.com/g"]]])],
        ["licenses", [new Map([["name", ["Apache-2.0"]]]), new Map([["name", ["MIT"]]])]],
        [
          "developers",
          new Map([
            ["id", ["nk"]],
            ["roles", ["lead", "dev"]],
          ]),
        ],
      ])
    );
    expect(text).to.contain("  <name>Greeter app</name>\n");
    expect(text).to.contain("  <scm>\n    <url>https://example.com/g</url>\n  </scm>\n");
    expect(text).to.contain(
      "  <licenses>\n    <license>\n      <name>Apache-2.0</name>\n    </license>\n    <license>\n      <name>MIT</name>\n    </license>\n  </licenses>\n"
    );
    expect(text).to.contain(
      "  <developers>\n    <developer>\n      <id>nk</id>\n      <roles>\n        <role>lead</role>\n        <role>dev</role>\n      </roles>\n    </developer>\n  </developers>\n"
    );
  });

  it("refuses an element fabr writes, one only a build reads, and several blocks for an element that is no list", () => {
    expect(() => checkPomMetadata("app", new Map([["version", ["2"]]]))).to.throw(/cannot set <version>: fabr writes it/);
    expect(() => checkPomMetadata("app", new Map([["build", new Map()]]))).to.throw(
      /cannot set <build>: a published POM does not carry it/
    );
    expect(() => checkPomMetadata("app", new Map([["scm", [new Map(), new Map()]]]))).to.throw(/gives <scm> several blocks/);
  });
});

describe("mergedMetadata", () => {
  const now = new Date("2026-10-28T09:15:30Z");

  it("starts a package's metadata at its first version", () => {
    const metadata = mergedMetadata(undefined, "com.example", "app", "1.0.0", now);
    expect(metadata).to.contain("<latest>1.0.0</latest>\n    <release>1.0.0</release>");
    expect(metadata).to.contain("<versions>\n      <version>1.0.0</version>\n    </versions>");
    expect(metadata).to.contain("<lastUpdated>20261028091530</lastUpdated>");
  });

  it("adds a version to those listed, in Maven's order, the highest its latest", () => {
    const existing = mergedMetadata(
      mergedMetadata(undefined, "com.example", "app", "1.10.0", now),
      "com.example",
      "app",
      "1.2.0",
      now
    );
    const metadata = mergedMetadata(existing, "com.example", "app", "1.9.0", now);
    expect(metadata).to.contain("<version>1.2.0</version>\n      <version>1.9.0</version>\n      <version>1.10.0</version>");
    expect(metadata).to.contain("<latest>1.10.0</latest>");
    expect(mergedMetadata(metadata, "com.example", "app", "1.9.0", now)).to.equal(metadata);
  });

  it("keeps a listed entry that is no Maven version where it is, sorting the versions around it", () => {
    const existing = mergedMetadata(undefined, "com.example", "app", "2.0.0", now).replace(
      "<version>2.0.0</version>",
      "<version>2.0.0</version>\n      <version>${odd}</version>\n      <version>1.0.0</version>"
    );
    const metadata = mergedMetadata(existing, "com.example", "app", "1.5.0", now);
    expect(metadata).to.contain(
      "<version>1.0.0</version>\n      <version>${odd}</version>\n      <version>1.5.0</version>\n      <version>2.0.0</version>"
    );
    expect(metadata).to.contain("<latest>2.0.0</latest>");
  });
});

describe("uploadOrder", () => {
  it("uploads the marker last, after its checksums and signature, and everything else before them", () => {
    const pom = "com/example/app/1.0.0/app-1.0.0.pom";
    const jar = "com/example/app/1.0.0/app-1.0.0.jar";
    const paths = [`${pom}.sha1`, pom, `${jar}.md5`, jar, `${pom}.md5`, `${jar}.sha1`, `${jar}.asc`, `${pom}.asc`];
    expect(uploadOrder(paths, pom)).to.deep.equal({
      before: [jar, `${jar}.asc`, `${jar}.md5`, `${jar}.sha1`],
      last: [`${pom}.asc`, `${pom}.md5`, `${pom}.sha1`, pom],
    });
  });
});

describe("repository paths and checksums", () => {
  it("lays a version's files out under its group's directories", () => {
    expect(repositoryPath("com.example", "app", "1.0.0", "app-1.0.0.jar")).to.equal("com/example/app/1.0.0/app-1.0.0.jar");
    expect(metadataPath("com.example", "app")).to.equal("com/example/app/maven-metadata.xml");
  });

  it("writes an md5 and a sha1 beside a file", async () => {
    const files = checksumFiles("a/b.jar", Buffer.from("hello"));
    expect(files.map(([name]) => name)).to.deep.equal(["a/b.jar.md5", "a/b.jar.sha1"]);
    const texts = await Promise.all(files.map(([, file]) => new Promise<string>(resolve => file.readString().then(resolve))));
    expect(texts).to.deep.equal(["5d41402abc4b2a76b9719d911017c592", "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d"]);
  });
});

describe("classified members", () => {
  /* A writer to vend refs from: these tests only package. */
  const writer: RepositoryWriter = {
    package: () => Computable.resolve<PublishableFileSet[]>([]),
    publish: () => Computable.resolve<PublishStatus>("published"),
  };
  const ref = (variant?: string): MavenPublishRef =>
    new MavenPublishRef(writer, { name: "com.example/app", version: "1.0.0", variant }, "@corp");
  const files = (entries: Record<string, string>): FileSet =>
    new FileSet(new Map(Object.entries(entries).map(([name, text]) => [name, MemoryFile.from(text)])));

  it("are named with their classifier after the artifact", () => {
    expect(ref("sources").toString()).to.equal("@corp:com.example/app/sources:1.0.0");
    expect(ref().toString()).to.equal("@corp:com.example/app:1.0.0");
    expect(variantOf(ref("sources"))).to.equal("sources");
    expect(ref("sources").withRepositoryName("@other").toString()).to.equal("@other:com.example/app/sources:1.0.0");
  });

  it("name a Portal deployment in Maven coordinates, by the last artifact, counting versions", () => {
    const carrier = (destination: MavenPublishRef): PublishableFileSet => new PublishableFileSet([], destination);
    const lib = new MavenPublishRef(writer, { name: "com.example/lib", version: "2.0.0" }, "@corp");
    expect(deploymentName([carrier(ref("sources")), carrier(ref("javadoc")), carrier(ref())])).to.equal("com.example:app:1.0.0");
    expect(deploymentName([carrier(lib), carrier(ref("sources")), carrier(ref())])).to.equal("com.example:app:1.0.0 and 1 more");
  });

  it("pack a tree of files as the jar beside the artifact, with its checksums", async () => {
    const carrier = await packageClassifiedMember(
      { destination: ref("sources"), content: files({ "com/example/App.java": "class App {}" }) },
      [ref(), ref("sources")]
    );
    expect([...carrier].map(([name]) => name).sort()).to.deep.equal([
      "com/example/app/1.0.0/app-1.0.0-sources.jar",
      "com/example/app/1.0.0/app-1.0.0-sources.jar.md5",
      "com/example/app/1.0.0/app-1.0.0-sources.jar.sha1",
    ]);
    const jar = await carrier.get("com/example/app/1.0.0/app-1.0.0-sources.jar");
    const members = await readZipMembers(await jar!.getBuffer(), () => true);
    expect(members.get("com/example/App.java")?.toString()).to.equal("class App {}");
  });

  it("lay out a variant's file by its classifier and extension", () => {
    expect(publishedFilePath(ref("sources"))).to.equal("com/example/app/1.0.0/app-1.0.0-sources.jar");
    expect(publishedFilePath(ref("bin@zip"))).to.equal("com/example/app/1.0.0/app-1.0.0-bin.zip");
    expect(publishedFilePath(ref("@tar.gz"))).to.equal("com/example/app/1.0.0/app-1.0.0.tar.gz");
  });

  it("pack a tree as a zip, take one file of the extension as it is, and refuse to pack another", async () => {
    const zipped = await packageClassifiedMember({ destination: ref("bin@zip"), content: files({ "bin/run.sh": "run" }) }, [
      ref(),
      ref("bin@zip"),
    ]);
    expect([...zipped].map(([name]) => name)).to.include("com/example/app/1.0.0/app-1.0.0-bin.zip");
    const tarball = await packageClassifiedMember({ destination: ref("bin@tar.gz"), content: files({ "made.tar.gz": "TGZ" }) }, [
      ref(),
      ref("bin@tar.gz"),
    ]);
    expect(await (await tarball.get("com/example/app/1.0.0/app-1.0.0-bin.tar.gz"))!.readString()).to.equal("TGZ");
    const refused = await packageClassifiedMember({ destination: ref("bin@tar.gz"), content: files({ "bin/run.sh": "run" }) }, [
      ref(),
      ref("bin@tar.gz"),
    ]).then(
      () => undefined,
      err => (err as Error).message
    );
    expect(refused).to.match(/its content must be one \.tar\.gz file/);
  });

  it("take content that is one jar as that jar", async () => {
    const carrier = await packageClassifiedMember({ destination: ref("javadoc"), content: files({ "made.jar": "JAR" }) }, [
      ref(),
      ref("javadoc"),
    ]);
    expect(await (await carrier.get("com/example/app/1.0.0/app-1.0.0-javadoc.jar"))!.readString()).to.equal("JAR");
  });

  it("scope a dependency passed on to what runs the package alone as runtime, and one passed on to what compiles against it alone as compile", async () => {
    const reader = {
      format: MAVEN_FORMAT,
      identity: "test",
      operation: "build",
      getRequirements: () => Computable.resolve([]),
      fetchFiles: () => Computable.resolve(new FileSet(new Map())),
      fetch: () => Computable.reject(new Error("not fetched")),
    } as unknown as RepositoryReader<unknown, unknown>;
    const edge = (name: string): { reference: RepositoryRef } => ({
      reference: new RepositoryRef(reader, { name, versionConstraint: "1.0" }),
    });
    const pkg = new PackageFileSet(
      files({ "app.jar": "JAR" }),
      "com.example/app",
      "1.0.0",
      [edge("com.example/lib"), edge("com.example/driver"), edge("com.example/annotations")],
      undefined,
      undefined,
      undefined,
      new Map([
        ["com.example/driver", "run"],
        ["com.example/annotations", "build"],
      ])
    );
    const member = await packageMavenMember({ destination: ref(), content: pkg }, new Map(), new Set(), [ref()]);
    const pom = await (await member.get("com/example/app/1.0.0/app-1.0.0.pom"))!.readString();
    expect(pom).to.contain("<artifactId>driver</artifactId>\n      <version>1.0</version>\n      <scope>runtime</scope>\n");
    expect(pom).to.contain("<artifactId>annotations</artifactId>\n      <version>1.0</version>\n    </dependency>");
    expect(pom).to.contain("<artifactId>lib</artifactId>\n      <version>1.0</version>\n    </dependency>");
  });

  it("record a dependency a catalog states as the requirement the catalog declares for it", async () => {
    const catalog = {
      declaredRequirement: () => Computable.resolve({ name: "com.example/lib", versionConstraint: "2.0" }),
    } as unknown as RepositoryCollection;
    const pkg = new PackageFileSet(files({ "app.jar": "JAR" }), "com.example/app", "1.0.0", [
      { reference: new RepositoryRef(catalog, { name: "com.example/lib", versionConstraint: undefined }) },
    ]);
    const member = await packageMavenMember({ destination: ref(), content: pkg }, new Map(), new Set(), [ref()]);
    const pom = await (await member.get("com/example/app/1.0.0/app-1.0.0.pom"))!.readString();
    expect(pom).to.contain(
      "<groupId>com.example</groupId>\n      <artifactId>lib</artifactId>\n      <version>2.0</version>\n    </dependency>"
    );
  });

  it("need their version's artifact in the same release, which is uploaded after them", async () => {
    const failure = await packageClassifiedMember({ destination: ref("sources"), content: files({ "A.java": "" }) }, [
      ref("sources"),
    ]).then(
      () => undefined,
      err => (err as Error).message
    );
    expect(failure).to.match(/the release publishes no com\.example:app:1\.0\.0 for it to be beside/);
    const main = await packageMavenMember({ destination: ref(), content: files({ "app.jar": "JAR" }) }, new Map(), new Set(), [
      ref(),
      ref("sources"),
    ]);
    const sources = await packageClassifiedMember({ destination: ref("sources"), content: files({ "A.java": "" }) }, [
      ref(),
      ref("sources"),
    ]);
    expect(main.dependsOn).to.deep.equal([sources.provides]);
  });
});

describe("signed members", () => {
  const writer: RepositoryWriter = {
    package: () => Computable.resolve<PublishableFileSet[]>([]),
    publish: () => Computable.resolve<PublishStatus>("published"),
  };
  const ref = (variant?: string): MavenPublishRef =>
    new MavenPublishRef(writer, { name: "com.example/app", version: "1.0.0", variant }, "@corp");
  const files = (entries: Record<string, string>): FileSet =>
    new FileSet(new Map(Object.entries(entries).map(([name, text]) => [name, MemoryFile.from(text)])));

  /** @return true if `signature` is a valid signature of `file`'s bytes by `publicKey`, otherwise false. */
  const verifies = async (carrier: FileSet, file: string, publicKey: string): Promise<boolean> => {
    const bytes = await (await carrier.get(file))!.getBuffer();
    const armoredSignature = await (await carrier.get(`${file}.asc`))!.readString();
    const { signatures } = await openpgp.verify({
      message: await openpgp.createMessage({ binary: new Uint8Array(bytes) }),
      signature: await openpgp.readSignature({ armoredSignature }),
      verificationKeys: await openpgp.readKey({ armoredKey: publicKey }),
    });
    return signatures[0].verified.then(
      () => true,
      () => false
    );
  };

  it("publish a signature beside the artifact, the POM and a classified jar, and none beside a checksum", async () => {
    const { privateKey, publicKey } = await openpgp.generateKey({ userIDs: [{ name: "Test" }], format: "armored" });
    const sign = await signerFor(Buffer.from(privateKey), undefined, "the test key");
    const main = await packageMavenMember(
      { destination: ref(), content: files({ "app.jar": "JAR" }) },
      new Map(),
      new Set(),
      [ref(), ref("sources")],
      sign
    );
    const sources = await packageClassifiedMember(
      { destination: ref("sources"), content: files({ "A.java": "" }) },
      [ref(), ref("sources")],
      sign
    );
    const base = "com/example/app/1.0.0/app-1.0.0";
    expect([...main].map(([name]) => name).filter(name => name.endsWith(".asc"))).to.deep.equal([
      `${base}.jar.asc`,
      `${base}.pom.asc`,
    ]);
    expect([...sources].map(([name]) => name).filter(name => name.endsWith(".asc"))).to.deep.equal([`${base}-sources.jar.asc`]);
    expect(await verifies(main, `${base}.jar`, publicKey)).to.equal(true);
    expect(await verifies(main, `${base}.pom`, publicKey)).to.equal(true);
    expect(await verifies(sources, `${base}-sources.jar`, publicKey)).to.equal(true);
  });

  it("sign with a key its passphrase unlocks, and refuse an encrypted key without the right one", async () => {
    const { privateKey, publicKey } = await openpgp.generateKey({
      userIDs: [{ name: "Test" }],
      passphrase: "secret",
      format: "armored",
    });
    const sign = await signerFor(Buffer.from(privateKey), "secret", "the test key");
    const main = await packageMavenMember(
      { destination: ref(), content: files({ "app.jar": "JAR" }) },
      new Map(),
      new Set(),
      [ref()],
      sign
    );
    expect(await verifies(main, "com/example/app/1.0.0/app-1.0.0.jar", publicKey)).to.equal(true);
    const failure = (passphrase: string | undefined): Promise<string | undefined> =>
      new Promise(resolve =>
        signerFor(Buffer.from(privateKey), passphrase, "the test key").then(
          () => resolve(undefined),
          err => resolve((err as Error).message)
        )
      );
    expect(await failure(undefined)).to.match(/the signing key in the test key is encrypted, and no passphrase is given/);
    expect(await failure("wrong")).to.match(/the passphrase given does not unlock the signing key in the test key/);
  });

  it("take the key from MAVEN_GPG_KEY before ~/maven-signing-key.key, and refuse where neither gives one", async () => {
    const fromVariable = await openpgp.generateKey({ userIDs: [{ name: "Variable" }], format: "armored" });
    const fromFile = await openpgp.generateKey({ userIDs: [{ name: "File" }], format: "armored" });
    const context = (file: string | undefined): TargetContext =>
      ({
        name: "@corp",
        execution: {
          absFileSource: {
            get: (path: string) =>
              Computable.resolve(path === defaultKeyPath() && file !== undefined ? MemoryFile.from(file) : undefined),
          },
        },
      }) as unknown as TargetContext;
    const signedBy = async (file: string | undefined, publicKey: string): Promise<boolean> => {
      const sign = await loadSigner(context(file));
      const signature = await sign(Buffer.from("JAR"));
      const { signatures } = await openpgp.verify({
        message: await openpgp.createMessage({ binary: new Uint8Array(Buffer.from("JAR")) }),
        signature: await openpgp.readSignature({ armoredSignature: signature }),
        verificationKeys: await openpgp.readKey({ armoredKey: publicKey }),
      });
      return signatures[0].verified.then(
        () => true,
        () => false
      );
    };
    const saved = [process.env[KEY_VARIABLE], process.env[PASSPHRASE_VARIABLE]];
    try {
      delete process.env[PASSPHRASE_VARIABLE];
      process.env[KEY_VARIABLE] = fromVariable.privateKey;
      expect(await signedBy(fromFile.privateKey, fromVariable.publicKey)).to.equal(true);
      delete process.env[KEY_VARIABLE];
      expect(await signedBy(fromFile.privateKey, fromFile.publicKey)).to.equal(true);
      const failure = await new Promise<string | undefined>(resolve =>
        loadSigner(context(undefined)).then(
          () => resolve(undefined),
          err => resolve((err as Error).message)
        )
      );
      expect(failure).to.equal("@corp signs what it publishes, and no signing key is given");
    } finally {
      for (const [variable, value] of [
        [KEY_VARIABLE, saved[0]],
        [PASSPHRASE_VARIABLE, saved[1]],
      ] as const) {
        if (value === undefined) {
          delete process.env[variable];
        } else {
          process.env[variable] = value;
        }
      }
    }
  });

  it("refuse a key that is not one", async () => {
    const failure = await new Promise<string | undefined>(resolve =>
      signerFor(Buffer.from("not a key"), undefined, "the test key").then(
        () => resolve(undefined),
        err => resolve((err as Error).message)
      )
    );
    expect(failure).to.match(/the signing key in the test key could not be read/);
  });
});
