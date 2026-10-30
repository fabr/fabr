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
import { Requirement } from "@fabr-build/core";
import { hasGradleMetadata, parseGradleModule, runtimeVariant, toGradleModule, variantRequirements } from "./GradleModule";

/* Guava's shape: a jre and an android flavour of each usage, and documentation. */
const GUAVA = toGradleModule({
  formatVersion: "1.1",
  variants: [
    {
      name: "jreApiElements",
      attributes: { "org.gradle.category": "library", "org.gradle.usage": "java-api", "org.gradle.jvm.environment": "standard-jvm", "org.gradle.jvm.version": 8 },
    },
    {
      name: "jreRuntimeElements",
      attributes: { "org.gradle.category": "library", "org.gradle.usage": "java-runtime", "org.gradle.jvm.environment": "standard-jvm", "org.gradle.jvm.version": 8 },
      dependencies: [{ group: "com.google.guava", module: "failureaccess", version: { requires: "1.0.2" } }],
      files: [{ name: "guava-33.3.1-jre.jar", url: "guava-33.3.1-jre.jar", sha1: "abc" }],
    },
    {
      name: "androidRuntimeElements",
      attributes: { "org.gradle.category": "library", "org.gradle.usage": "java-runtime", "org.gradle.jvm.environment": "android" },
    },
    {
      name: "sourcesElements",
      attributes: { "org.gradle.category": "documentation", "org.gradle.usage": "java-runtime", "org.gradle.docstype": "sources" },
    },
  ],
});

describe("Gradle Module Metadata", () => {
  it("is read where the POM carries Gradle's marker", () => {
    expect(hasGradleMetadata("<project><!-- do_not_remove: published-with-gradle-metadata --></project>")).to.equal(true);
    expect(hasGradleMetadata("<project></project>")).to.equal(false);
  });

  it("selects the runtime library variant for the standard JVM, and its files", () => {
    const variant = runtimeVariant(GUAVA, 21, "guava");
    expect(variant.name).to.equal("jreRuntimeElements");
    expect(variant.files).to.deep.equal([{ name: "guava-33.3.1-jre.jar", url: "guava-33.3.1-jre.jar", sha1: "abc" }]);
    expect(variantRequirements(variant)).to.deep.equal([{ name: "com.google.guava/failureaccess", versionConstraint: "1.0.2" }]);
  });

  it("selects the variant for the highest JVM version a program can run, and refuses where there is none", () => {
    const module = toGradleModule({
      formatVersion: "1.1",
      variants: [
        { name: "java8", attributes: { "org.gradle.usage": "java-runtime", "org.gradle.jvm.version": 8 } },
        { name: "java17", attributes: { "org.gradle.usage": "java-runtime", "org.gradle.jvm.version": 17 } },
        { name: "java25", attributes: { "org.gradle.usage": "java-runtime", "org.gradle.jvm.version": 25 } },
      ],
    });
    expect(runtimeVariant(module, 21, "m").name).to.equal("java17");
    expect(runtimeVariant(module, 11, "m").name).to.equal("java8");
    const late = toGradleModule({ formatVersion: "1.1", variants: [{ name: "java25", attributes: { "org.gradle.usage": "java-runtime", "org.gradle.jvm.version": 25 } }] });
    expect(() => runtimeVariant(late, 21, "m")).to.throw(/m has no variant a Java program on Java 21 can run with/);
  });

  it("selects the variant of the module's own capability, not its test fixtures'", () => {
    const module = toGradleModule({
      formatVersion: "1.1",
      component: { group: "com.example", module: "lib", version: "1.0" },
      variants: [
        { name: "runtimeElements", attributes: { "org.gradle.usage": "java-runtime" } },
        {
          name: "testFixturesRuntimeElements",
          attributes: { "org.gradle.usage": "java-runtime" },
          capabilities: [{ group: "com.example", name: "lib-test-fixtures", version: "1.0" }],
        },
      ],
    });
    expect(runtimeVariant(module, 21, "lib").name).to.equal("runtimeElements");
  });

  it("selects a platform's variant where the module is no library, and refuses an ambiguous choice", () => {
    const platform = toGradleModule({
      formatVersion: "1.1",
      variants: [
        { name: "apiElements", attributes: { "org.gradle.category": "platform", "org.gradle.usage": "java-api" } },
        {
          name: "runtimeElements",
          attributes: { "org.gradle.category": "platform", "org.gradle.usage": "java-runtime" },
          dependencyConstraints: [{ group: "com.example", module: "core", version: { requires: "2.0" } }],
        },
      ],
    });
    const variant = runtimeVariant(platform, 21, "bom");
    expect(variantRequirements(variant)).to.deep.equal([{ name: "com.example/core", versionConstraint: "2.0", bom: true }]);
    const twice = toGradleModule({ formatVersion: "1.1", variants: [{ name: "a" }, { name: "b" }] });
    expect(() => runtimeVariant(twice, 21, "m")).to.throw(/several variants .*: a, b/);
  });

  it("reads strictly as a range or an exact version, prefers where nothing else is stated, and an artifact selector as a variant", () => {
    const variant = runtimeVariant(
      toGradleModule({
        formatVersion: "1.1",
        variants: [
          {
            name: "runtime",
            attributes: { "org.gradle.usage": "java-runtime" },
            dependencies: [
              { group: "g", module: "exact", version: { strictly: "1.2", requires: "1.2" } },
              { group: "g", module: "range", version: { strictly: "[1.0,2.0)" } },
              { group: "g", module: "preferred", version: { prefers: "3.1" } },
              { group: "g", module: "managed" },
              { group: "g", module: "native", version: { requires: "4.1" }, thirdPartyCompatibility: { artifactSelector: { name: "native", type: "jar", classifier: "linux-x86_64" } } },
              { group: "g", module: "dist", version: { requires: "1" }, thirdPartyCompatibility: { artifactSelector: { name: "dist", type: "zip", extension: "zip" } } },
              { group: "g", module: "fixtures", version: { requires: "1" }, requestedCapabilities: [{ group: "g", name: "fixtures-test-fixtures" }] },
            ],
          },
        ],
      }),
      21,
      "m"
    );
    expect(variantRequirements(variant)).to.deep.equal([
      { name: "g/exact", versionConstraint: "[1.2]" },
      { name: "g/range", versionConstraint: "[1.0,2.0)" },
      { name: "g/preferred", versionConstraint: "3.1" },
      { name: "g/managed", versionConstraint: undefined },
      { name: "g/native", versionConstraint: "4.1", variant: "linux-x86_64" },
      { name: "g/dist", versionConstraint: "1", variant: "@zip" },
    ]);
  });

  it("cuts the versions a dependency rejects out of what it requires", () => {
    const requirementsOf = (version: Record<string, unknown>): Requirement[] =>
      variantRequirements(
        runtimeVariant(
          toGradleModule({
            formatVersion: "1.1",
            variants: [{ name: "runtime", attributes: { "org.gradle.usage": "java-runtime" }, dependencies: [{ group: "g", module: "m", version }] }],
          }),
          21,
          "x"
        )
      );
    expect(requirementsOf({ requires: "1.0", rejects: ["1.2", "[1.5,1.6)"] })).to.deep.equal([{ name: "g/m", versionConstraint: "[1.0,1.2),(1.2,1.5),[1.6,)" }]);
    expect(requirementsOf({ strictly: "[1.0,2.0)", rejects: ["1.0"] })).to.deep.equal([{ name: "g/m", versionConstraint: "(1.0,2.0)" }]);
    expect(requirementsOf({ rejects: ["2.0"] })).to.deep.equal([{ name: "g/m", versionConstraint: "(,2.0),(2.0,)" }]);
    expect(() => requirementsOf({ strictly: "1.0", rejects: ["1.0"] })).to.throw(/g:m rejects every version it requires/);
  });

  it("reads a variant another module holds as a requirement of that module", () => {
    const variant = runtimeVariant(
      toGradleModule({
        formatVersion: "1.1",
        variants: [
          {
            name: "jvmRuntimeElements-published",
            attributes: { "org.gradle.usage": "java-runtime", "org.jetbrains.kotlin.platform.type": "jvm" },
            "available-at": { url: "../../core-jvm/1.9.0/core-jvm-1.9.0.module", group: "org.example", module: "core-jvm", version: "1.9.0" },
          },
          { name: "jsRuntimeElements-published", attributes: { "org.gradle.usage": "kotlin-runtime", "org.jetbrains.kotlin.platform.type": "js" } },
        ],
      }),
      21,
      "core"
    );
    expect(variantRequirements(variant)).to.deep.equal([{ name: "org.example/core-jvm", versionConstraint: "1.9.0" }]);
  });

  it("refuses a document of another format version, or of the wrong shape, naming it", () => {
    expect(() => parseGradleModule('{"formatVersion": "2.0", "variants": []}', "m.module")).to.throw(/m\.module.*formatVersion is "2\.0"/);
    expect(() => parseGradleModule('{"formatVersion": "1.1", "variants": {}}', "m.module")).to.throw(/variants is not a list/);
  });
});
