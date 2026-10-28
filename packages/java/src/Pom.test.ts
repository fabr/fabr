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
import { Computable } from "@fabr-build/core";
import { coordinateText, EffectivePom, effectivePom, parsePom, passedOnDependencies, PomCoordinate } from "./Pom";
import { parseXml } from "./Xml";

/* jackson-databind's shape: versions come from a parent's properties, and the
 * parent's dependencyManagement imports a BOM. */
const POMS = new Map([
  [
    "com.example:base:1.0",
    `<?xml version="1.0" encoding="UTF-8"?>
<!-- the shared parent -->
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>base</artifactId>
  <version>1.0</version>
  <packaging>pom</packaging>
  <properties>
    <annotations.version>\${project.version}.1</annotations.version>
    <junit.version>5.9.2</junit.version>
  </properties>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>com.example</groupId>
        <artifactId>bom</artifactId>
        <version>\${bom.version}</version>
        <type>pom</type>
        <scope>import</scope>
      </dependency>
      <dependency>
        <groupId>org.junit</groupId>
        <artifactId>junit</artifactId>
        <version>\${junit.version}</version>
        <scope>test</scope>
      </dependency>
    </dependencies>
  </dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>org.junit</groupId>
      <artifactId>junit</artifactId>
    </dependency>
  </dependencies>
</project>`,
  ],
  [
    "com.example:bom:2.0",
    `<project>
  <groupId>com.example</groupId>
  <artifactId>bom</artifactId>
  <version>2.0</version>
  <packaging>pom</packaging>
  <dependencyManagement>
    <dependencies>
      <dependency><groupId>com.example</groupId><artifactId>core</artifactId><version>2.0.3</version></dependency>
      <dependency><groupId>com.example</groupId><artifactId>annotations</artifactId><version>9.9</version></dependency>
    </dependencies>
  </dependencyManagement>
</project>`,
  ],
  [
    "com.example:databind:1.5",
    `<project>
  <parent>
    <groupId>com.example</groupId>
    <artifactId>base</artifactId>
    <version>1.0</version>
  </parent>
  <artifactId>databind</artifactId>
  <version>1.5</version>
  <properties>
    <bom.version>2.0</bom.version>
  </properties>
  <dependencies>
    <dependency><groupId>com.example</groupId><artifactId>annotations</artifactId><version>\${annotations.version}</version></dependency>
    <dependency><groupId>com.example</groupId><artifactId>core</artifactId></dependency>
    <dependency><groupId>com.example</groupId><artifactId>runtime-only</artifactId><version>1</version><scope>runtime</scope></dependency>
    <dependency><groupId>com.example</groupId><artifactId>servlet</artifactId><version>1</version><scope>provided</scope></dependency>
    <dependency><groupId>com.example</groupId><artifactId>extra</artifactId><version>1</version><optional>true</optional></dependency>
    <dependency><groupId>com.example</groupId><artifactId>natives</artifactId><version>1</version><classifier>linux-x86_64</classifier></dependency>
  </dependencies>
</project>`,
  ],
]);

function load(coordinate: PomCoordinate): Computable<ReturnType<typeof parsePom>> {
  const text = POMS.get(coordinateText(coordinate));
  if (text === undefined) {
    return Computable.reject(new Error(`no POM for ${coordinateText(coordinate)}`));
  }
  return Computable.resolve(parsePom(text, coordinateText(coordinate)));
}

async function effective(coordinate: string, text = POMS.get(coordinate)!): Promise<EffectivePom> {
  return effectivePom(parsePom(text, coordinate), load, coordinate);
}

const listed = (pom: EffectivePom, dependencies = pom.dependencies): string[] =>
  dependencies.map(dependency => `${dependency.groupId}:${dependency.artifactId}:${dependency.version} ${dependency.scope ?? "compile"}`);

describe("effectivePom", () => {
  it("inherits, interpolates late and fills versions from imported BOMs", async () => {
    const pom = await effective("com.example:databind:1.5");
    expect([pom.groupId, pom.artifactId, pom.version, pom.packaging]).to.deep.equal(["com.example", "databind", "1.5", "jar"]);
    expect(listed(pom)).to.deep.equal([
      /* ${annotations.version} is the parent's, read with the child's project.version. */
      "com.example:annotations:1.5.1 compile",
      "com.example:core:2.0.3 compile",
      "com.example:runtime-only:1 runtime",
      "com.example:servlet:1 provided",
      "com.example:extra:1 compile",
      "com.example:natives:1 compile",
      /* Inherited from the parent, its version and scope managed there. */
      "org.junit:junit:5.9.2 test",
    ]);
  });

  it("passes on compile and runtime jars, and not optional, provided, test or classified ones", async () => {
    const pom = await effective("com.example:databind:1.5");
    expect(passedOnDependencies(pom).map(dependency => dependency.artifactId)).to.deep.equal(["annotations", "core", "runtime-only"]);
  });

  it("refuses a dependency that is left without a version", async () => {
    const orphan = `<project><groupId>g</groupId><artifactId>a</artifactId><version>1</version>
      <dependencies><dependency><groupId>x</groupId><artifactId>y</artifactId></dependency></dependencies></project>`;
    const refused = await effective("g:a:1", orphan).then(
      () => undefined,
      (err: Error) => err.message
    );
    expect(refused).to.match(/x:y has no version, and none is managed/);
  });

  it("refuses a property that refers to itself", async () => {
    const looped = `<project><groupId>g</groupId><artifactId>a</artifactId><version>1</version>
      <properties><v>\${v}</v></properties>
      <dependencies><dependency><groupId>x</groupId><artifactId>y</artifactId><version>\${v}</version></dependency></dependencies></project>`;
    const refused = await effective("g:a:1", looped).then(
      () => undefined,
      (err: Error) => err.message
    );
    expect(refused).to.match(/property 'v' refers to itself/);
  });
});

describe("parsePom", () => {
  it("refuses a document that is not a POM", () => {
    expect(() => parsePom("<metadata/>", "x.pom")).to.throw(/x.pom is not a POM/);
    expect(() => parsePom("<project><groupId>g</groupId></project>", "x.pom")).to.throw(/no artifactId/);
  });
});

describe("parseXml", () => {
  it("reads text with entities and CDATA, past comments, attributes and declarations", () => {
    const root = parseXml(
      `<?xml version="1.0"?>\n<!DOCTYPE project>\n<a x="1 > 0" y='z'><!-- c --><b>&lt;one&gt; &amp; &#65;&#x42;</b><c><![CDATA[<raw>]]></c><d/></a>`,
      "doc"
    );
    expect(root.name).to.equal("a");
    expect(root.children.map(child => [child.name, child.text])).to.deep.equal([
      ["b", "<one> & AB"],
      ["c", "<raw>"],
      ["d", ""],
    ]);
  });

  it("reads the XHTML entities Maven's own reader defines", () => {
    expect(parseXml("<a>x&nbsp;&copy;</a>", "pom.xml").text).to.equal("x\u00a0\u00a9");
  });

  it("names the document and line of a malformed one, and refuses entities it does not know", () => {
    expect(() => parseXml("<a>\n<b></a>", "pom.xml")).to.throw(/^pom.xml is not well-formed XML \(line 2\): /);
    expect(() => parseXml("<a>&bogus;</a>", "pom.xml")).to.throw(/^pom.xml is not well-formed XML \(line 1\): /);
    expect(() => parseXml('<!DOCTYPE a [<!ENTITY e "x">]><a>&e;</a>', "pom.xml")).to.throw(/internal subset/);
    expect(() => parseXml("<a/><b/>", "pom.xml")).to.throw(/not well-formed XML/);
    expect(() => parseXml("", "pom.xml")).to.throw(/no root element/);
  });
});
