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
import { NamespaceRef, parseName, RefSource, Repository, RepositoryRef, vendPackageRef } from "@fabr-build/core";
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

  it("reads a quoted range as the version", () => {
    expect(refOf('com.example:lib:"[1.0,2.0)"').versionConstraint).to.equal("[1.0,2.0)");
  });

  it("reads a reference with no version as a namespace", () => {
    for (const written of ["org.slf4j/slf4j-api", "org.slf4j:slf4j-api", "org.slf4j"]) {
      expect(vend(written)).to.be.instanceOf(NamespaceRef);
    }
    expect((vend("org.slf4j:slf4j-api") as NamespaceRef).name).to.equal("org.slf4j/slf4j-api");
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

describe("splitMavenName", () => {
  it("splits group from artifact, and refuses anything else", () => {
    expect(splitMavenName("org.slf4j/slf4j-api")).to.deep.equal({ groupId: "org.slf4j", artifactId: "slf4j-api" });
    expect(() => splitMavenName("slf4j-api")).to.throw(/not a Maven package name/);
    expect(() => splitMavenName("a/b/c")).to.throw(/not a Maven package name/);
  });
});
