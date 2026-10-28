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
import { checksumFiles, mergedMetadata, metadataPath, pomText, repositoryPath } from "./MavenPublish";

describe("pomText", () => {
  it("records the coordinate, the dependencies with their scope, and the BOMs as imports", () => {
    const pom = pomText({
      groupId: "com.example",
      artifactId: "app",
      version: "1.0.0",
      packaging: "jar",
      dependencies: [
        { groupId: "org.slf4j", artifactId: "slf4j-api", version: "1.7.36" },
        { groupId: "jakarta.servlet", artifactId: "jakarta.servlet-api", version: "6.0.0", scope: "provided" },
        { groupId: "com.example", artifactId: "extra", version: "2.0", optional: true },
      ],
      imports: [{ groupId: "org.junit", artifactId: "junit-bom", version: "5.11.4" }],
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
    const pom = pomText({ groupId: "com.example", artifactId: "shop", version: "1.0", packaging: "war", dependencies: [], imports: [] });
    expect(pom).to.contain("<packaging>war</packaging>");
    expect(pom).not.to.contain("<dependencies>");
    expect(pom).not.to.contain("<dependencyManagement>");
  });

  it("escapes what XML would read as markup", () => {
    expect(pomText({ groupId: "a&b", artifactId: "c<d", version: "1", packaging: "jar", dependencies: [], imports: [] })).to.contain(
      "<groupId>a&amp;b</groupId>\n  <artifactId>c&lt;d</artifactId>"
    );
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
