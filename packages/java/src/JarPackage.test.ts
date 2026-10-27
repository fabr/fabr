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
import { FileSet, Flag, MemoryFile, PackageFileSet, packToZip, RefSource, RepositoryRef } from "@fabr-build/core";
import { checkMainClass, classFileOf, classpathOf, jarMainClass, javaRelease, MANIFEST_NAME, manifestAttributes, manifestFile, packageOf } from "./JarPackage";

const files = (...names: string[]): FileSet => new FileSet(new Map(names.map(name => [name, MemoryFile.from(name)])));

describe("javaRelease", () => {
  it("compiles for JVM_TARGET, or for the highest source flag at or below it", () => {
    expect(javaRelease("jvm21", [])).to.equal(21);
    expect(javaRelease("jvm21", [new Flag("java11", []), new Flag("java17", [])])).to.equal(17);
    expect(() => javaRelease("jvm17", [new Flag("java21", [])])).to.throw(/written for Java 21/);
    expect(() => javaRelease("java17", [])).to.throw(/not a JVM_TARGET/);
  });
});

describe("packageOf", () => {
  it("reads the package a source declares, past comments and package annotations", () => {
    expect(packageOf("package com.example;\nclass A {}")).to.equal("com.example");
    expect(packageOf("/* licence */\n// note\n@Deprecated\npackage com . example ;\n")).to.equal("com.example");
    expect(packageOf("// package not.this;\nclass A {}")).to.equal("");
    expect(packageOf("import x.Y;\nclass A {}")).to.equal("");
  });
});

describe("checkMainClass", () => {
  it("accepts a class the jar holds or one a package it requires holds, and refuses any other", async () => {
    expect(classFileOf("com.example.Main")).to.equal("com/example/Main.class");
    await checkMainClass("app", "com.example.Main", files("com/example/Main.class"), []);
    const jar = await packToZip(files("org/lib/Main.class"));
    const lib = new PackageFileSet(new FileSet(new Map([["lib-1.0.jar", new MemoryFile(jar)]])), "org/lib", "1.0");
    await checkMainClass("app", "org.lib.Main", files(), [lib]);
    let refused: Error | undefined;
    await checkMainClass("app", "com.example.Missing", files("com/example/Main.class"), [lib]).catch((err: Error) => (refused = err));
    expect(refused?.message).to.match(/main_class 'com.example.Missing' is no class/);
  });
});

describe("classpathOf", () => {
  it("lays out every jar a package reaches under its package's name, nearest first", () => {
    const leaf = new PackageFileSet(files("leaf-1.0.jar", "leaf-1.0.pom"), "org.example/leaf", "1.0");
    const reference = new RepositoryRef({} as RefSource, { name: "org.example/leaf", versionConstraint: "1.0" });
    const app = new PackageFileSet(files("app.jar"), "com.example/app", undefined, [{ reference, package: leaf }]);
    expect(classpathOf([app, files("local.jar"), new Flag("java17", [])]).map(([name]) => name)).to.deep.equal([
      "com.example/app/app.jar",
      "org.example/leaf/leaf-1.0.jar",
      "local.jar",
    ]);
  });
});

describe("manifests", () => {
  it("wraps long attributes at 72 bytes, and reads them back whole", async () => {
    const classpath = Array.from({ length: 20 }, (_, index) => `lib/org.example/library-${index}/library-${index}-1.0.jar`).join(" ");
    const text = await manifestFile([
      ["Manifest-Version", "1.0"],
      ["Class-Path", classpath],
    ]).readString();
    expect(text.split("\r\n").every(line => Buffer.byteLength(line) <= 72)).to.equal(true);
    expect(manifestAttributes(text).get("Class-Path")).to.equal(classpath);
  });

  it("reads the Main-Class a package's jar names", async () => {
    const jar = await packToZip(new FileSet(new Map([[MANIFEST_NAME, manifestFile([["Main-Class", "com.example.Tool"]])]])));
    const pkg = new PackageFileSet(new FileSet(new Map([["tool-1.0.jar", new MemoryFile(jar)]])), "com.example/tool", "1.0");
    expect(await jarMainClass(pkg)).to.equal("com.example.Tool");
  });
});
