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
import { checkPomMetadata, checksumFiles, mergedMetadata, metadataPath, pomText, repositoryPath } from "./MavenPublish";

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
      dependencyManagement: [{ groupId: "org.junit", artifactId: "junit-bom", version: "5.11.4", type: "pom", scope: "import", optional: false }],
    });
    expect(pom).to.contain("<groupId>com.example</groupId>\n  <artifactId>app</artifactId>\n  <version>1.0.0</version>\n");
    expect(pom).not.to.contain("<packaging>");
    expect(pom).to.contain(
      "      <dependency>\n        <groupId>org.junit</groupId>\n        <artifactId>junit-bom</artifactId>\n        <version>5.11.4</version>\n" +
        "        <type>pom</type>\n        <scope>import</scope>\n      </dependency>\n"
    );
    expect(pom).to.contain("<artifactId>jakarta.servlet-api</artifactId>\n      <version>6.0.0</version>\n      <scope>provided</scope>\n");
    expect(pom).to.contain("<artifactId>extra</artifactId>\n      <version>2.0</version>\n      <optional>true</optional>\n");
  });

  it("names a packaging other than jar, and leaves out what a package has none of", () => {
    const pom = pomText({ groupId: "com.example", artifactId: "shop", version: "1.0", packaging: "war", metadata: new Map(), dependencies: [], dependencyManagement: [] });
    expect(pom).to.contain("<packaging>war</packaging>");
    expect(pom).not.to.contain("<dependencies>");
    expect(pom).not.to.contain("<dependencyManagement>");
  });

  it("escapes what XML would read as markup", () => {
    expect(pomText({ groupId: "a&b", artifactId: "c<d", version: "1", packaging: "jar", metadata: new Map(), dependencies: [], dependencyManagement: [] })).to.contain(
      "<groupId>a&amp;b</groupId>\n  <artifactId>c&lt;d</artifactId>"
    );
  });
});

describe("POM metadata", () => {
  const pom = (metadata: Map<string, unknown>): string =>
    pomText({ groupId: "g", artifactId: "a", version: "1", packaging: "jar", metadata: metadata as never, dependencies: [], dependencyManagement: [] });

  it("writes a string as an element, a block as nested elements, and a list element around its items", () => {
    const text = pom(
      new Map<string, unknown>([
        ["name", ["Greeter", "app"]],
        ["scm", new Map([["url", ["https://example.com/g"]]])],
        ["licenses", [new Map([["name", ["Apache-2.0"]]]), new Map([["name", ["MIT"]]])]],
        ["developers", new Map([["id", ["nk"]], ["roles", ["lead", "dev"]]])],
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
    expect(() => checkPomMetadata("app", new Map([["build", new Map()]]))).to.throw(/cannot set <build>: a published POM does not carry it/);
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
    const existing = mergedMetadata(mergedMetadata(undefined, "com.example", "app", "1.10.0", now), "com.example", "app", "1.2.0", now);
    const metadata = mergedMetadata(existing, "com.example", "app", "1.9.0", now);
    expect(metadata).to.contain("<version>1.2.0</version>\n      <version>1.9.0</version>\n      <version>1.10.0</version>");
    expect(metadata).to.contain("<latest>1.10.0</latest>");
    expect(mergedMetadata(metadata, "com.example", "app", "1.9.0", now)).to.equal(metadata);
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
