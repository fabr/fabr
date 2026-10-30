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
import { FabrError, NamespaceRef, parseName, RefSource, Repository, RepositoryRef, vendPackageRef } from "@fabr-build/core";
import { MAVEN_FORMAT, splitMavenName } from "./MavenProtocol";

const vend = (written: string): RepositoryRef | NamespaceRef => vendPackageRef({} as RefSource & Repository, MAVEN_FORMAT, parseName(written));

function refOf(written: string): RepositoryRef {
  const ref = vend(written);
  if (!(ref instanceof RepositoryRef)) {
    throw new Error(`'${written}' names a namespace`);
  }
  return ref;
}

const projectionsOf = (ref: RepositoryRef): string[][] => ref.projections.map(p => [p.pattern.toBaseString(), p.prefix]);

describe("MAVEN_FORMAT", () => {
  it("reads a coordinate written with a slash or with colons as one reference", () => {
    for (const written of ["org.slf4j/slf4j-api:1.7.36", "org.slf4j:slf4j-api:1.7.36"]) {
      const ref = refOf(written);
      expect(ref.name).to.equal("org.slf4j/slf4j-api");
      expect(ref.versionConstraint).to.equal("1.7.36");
      expect(ref.projections).to.deep.equal([]);
    }
  });

  it("reads what follows the version as a projection", () => {
    const stripped = refOf("org.slf4j:slf4j-api:1.7.36:META-INF/*");
    expect(stripped.versionConstraint).to.equal("1.7.36");
    expect(projectionsOf(stripped)).to.deep.equal([["META-INF/*", ""]]);
    const kept = refOf("org.slf4j/slf4j-api:1.7.36/META-INF/*");
    expect(projectionsOf(kept)).to.deep.equal([["META-INF/*", "org.slf4j/slf4j-api:1.7.36/"]]);
  });

  it("reads a classifier after the artifact as the variant, with a version or without", () => {
    for (const written of ["io.netty:netty-transport-native-epoll/linux-x86_64:4.1.110.Final", "io.netty/netty-transport-native-epoll/linux-x86_64:4.1.110.Final"]) {
      const ref = refOf(written);
      expect([ref.name, ref.variant, ref.versionConstraint]).to.deep.equal(["io.netty/netty-transport-native-epoll", "linux-x86_64", "4.1.110.Final"]);
      expect(ref.toString()).to.equal("io.netty/netty-transport-native-epoll/linux-x86_64:4.1.110.Final");
      expect(ref.localName).to.equal("io.netty/netty-transport-native-epoll/linux-x86_64");
    }
    const versionless = vend("io.netty:netty-transport-native-epoll/linux-x86_64") as RepositoryRef;
    expect([versionless.name, versionless.variant, versionless.versionConstraint]).to.deep.equal(["io.netty/netty-transport-native-epoll", "linux-x86_64", undefined]);
    /* What follows the version is still a projection. */
    expect(projectionsOf(refOf("io.netty:netty-transport-native-epoll/linux-x86_64:4.1.110.Final:META-INF/*"))).to.deep.equal([["META-INF/*", ""]]);
  });

  it("refuses a variant that is no classifier", () => {
    expect(() => MAVEN_FORMAT.validateRequirement(refOf("io.netty:netty-transport-native-epoll/a/b:4.1.110.Final"))).to.throw(/'a\/b' is not a classifier/);
  });

  it("reads a quoted range as the version", () => {
    expect(refOf('com.example:lib:"[1.0,2.0)"').versionConstraint).to.equal("[1.0,2.0)");
  });

  it("reads a package with no version as a requirement, for a BOM to give its version, and a group as a namespace", () => {
    for (const written of ["org.slf4j/slf4j-api", "org.slf4j:slf4j-api"]) {
      const ref = vend(written);
      expect(ref).to.be.instanceOf(RepositoryRef);
      expect([(ref as RepositoryRef).name, (ref as RepositoryRef).versionConstraint]).to.deep.equal(["org.slf4j/slf4j-api", undefined]);
    }
    expect(vend("org.slf4j")).to.be.instanceOf(NamespaceRef);
    expect(() => MAVEN_FORMAT.validateRequirement({ name: "org.slf4j/slf4j-api", versionConstraint: undefined, override: "force" })).to.throw(/states no version/);
  });

  it("takes a marker on an exact version, and refuses one on a range or a projection", () => {
    expect(refOf("org.yaml:snakeyaml:2.2!").override).to.equal("force");
    expect(() => MAVEN_FORMAT.validateRequirement(refOf('org.yaml:snakeyaml:"[2.2,3)"!'))).to.throw(/a marker needs an exact version/);
    expect(() => refOf("org.yaml:snakeyaml:2.2!:META-INF/*")).to.throw(/override marker means nothing/);
  });

  it("refuses a malformed version, and a name that is not group/artifact", () => {
    expect(() => MAVEN_FORMAT.validateRequirement(refOf('org.yaml:snakeyaml:"[2.2"'))).to.throw(/not a valid Maven version or range/);
    expect(() => MAVEN_FORMAT.validateRequirement({ name: "snakeyaml", versionConstraint: "2.2" })).to.throw(/not a Maven package name/);
  });
});

describe("parseMavenPublishCoordinate", () => {
  it("reads a coordinate with an exact version, written with colons or a slash", () => {
    for (const written of ["com.example:app:1.0.0", "com.example/app:1.0.0"]) {
      expect(MAVEN_FORMAT.parsePublishCoordinate(parseName(written))).to.deep.equal({ name: "com.example/app", version: "1.0.0" });
    }
  });

  it("refuses a coordinate with no version, a range, a projection, or a -SNAPSHOT", () => {
    expect(() => MAVEN_FORMAT.parsePublishCoordinate(parseName("com.example:app"))).to.throw(/must name a group, an artifact and a version/);
    expect(() => MAVEN_FORMAT.parsePublishCoordinate(parseName('com.example:app:"[1.0,2.0)"'))).to.throw(/not an exact version/);
    expect(() => MAVEN_FORMAT.parsePublishCoordinate(parseName("com.example:app:1.0.0:META-INF/*"))).to.throw(/must name a group/);
    expect(() => MAVEN_FORMAT.parsePublishCoordinate(parseName("com.example:app:1.0.0-SNAPSHOT"))).to.throw(/-SNAPSHOT version/);
  });

  it("reads a classifier written after the artifact, and refuses one that is no classifier", () => {
    for (const written of ["com.example:app/sources:1.0.0", "com.example/app/sources:1.0.0"]) {
      expect(MAVEN_FORMAT.parsePublishCoordinate(parseName(written))).to.deep.equal({ name: "com.example/app", version: "1.0.0", classifier: "sources" });
    }
    expect(() => MAVEN_FORMAT.parsePublishCoordinate(parseName("com.example:app/-x:1.0.0"))).to.throw(/a classifier where it has one/);
    expect(() => MAVEN_FORMAT.parsePublishCoordinate(parseName("com.example:app/a/b:1.0.0"))).to.throw(/a classifier where it has one/);
  });

  it("says how to write a classifier, given one as a fourth part", () => {
    let help: string[] = [];
    try {
      MAVEN_FORMAT.parsePublishCoordinate(parseName("com.example:app:sources:1.0.0"));
    } catch (err) {
      help = (err as FabrError).help ?? [];
    }
    expect(help).to.deep.equal(["a classifier follows the artifact: write 'com.example:app/sources:1.0.0'"]);
  });
});

describe("splitMavenName", () => {
  it("splits group from artifact, and refuses anything else", () => {
    expect(splitMavenName("org.slf4j/slf4j-api")).to.deep.equal({ groupId: "org.slf4j", artifactId: "slf4j-api" });
    expect(() => splitMavenName("slf4j-api")).to.throw(/not a Maven package name/);
    expect(() => splitMavenName("a/b/c")).to.throw(/not a Maven package name/);
  });
});
