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
import { Computable, Conflicts, Dependency, EMPTY_FILESET, PackageFileSet, PackageGraphBuilder, RefSource, RepositoryRef, ResolvedNode, TargetRef, TargetSource } from "@fabr-build/core";
import { renderDependencyTrees } from "./DepsTree";

/** A reference as a registry would vend it; nothing here resolves one. */
function reference(name: string, versionConstraint?: string): RepositoryRef {
  return new RepositoryRef({} as RefSource, { name, versionConstraint });
}

/** A reference to a target; nothing here resolves one. */
function target(name: string): TargetRef {
  return new TargetRef({} as TargetSource, name);
}

/** A target's node, resolved and unbuilt, in `configuration` (as a message
 * shows it; empty for the ambient one), with `dependencies`: as the edge the
 * reference to the target makes. */
function node(name: string, configuration: string, dependencies: Dependency[] = []): Dependency {
  return {
    reference: target(name),
    package: new ResolvedNode(
      { key: `built ${name} ${configuration}`, files: () => Computable.resolve(EMPTY_FILESET), builds: name, configuration },
      name,
      undefined,
      dependencies,
      { kind: "target" }
    ),
  };
}

/** A package delivered for `name:constraint`, at `version`, as the edge that
 * reference makes. */
function delivered(name: string, version: string, constraint: string, dependencies: Array<Dependency<PackageFileSet>> = []): Dependency<PackageFileSet> {
  return { reference: reference(name, constraint), package: new PackageFileSet([], name, version, dependencies) };
}

function rendered(parts: Array<[string, Dependency[]]>, title = "app"): string[] {
  return renderDependencyTrees([{ title, parts: new Map(parts) }]);
}

describe("renderDependencyTrees", () => {
  it("draws a section per part, with requested and selected versions", () => {
    const leaf = delivered("leaf", "1.2.0", "^1.0.0");
    const lines = rendered([
      ["deps", [delivered("exact", "2.0.0", "2.0.0", [leaf]), { reference: target("local"), package: new PackageFileSet([], "local", undefined, []) }]],
      ["test_deps", [delivered("chai", "4.5.0", "^4.0.0")]],
    ]);
    expect(lines).to.deep.equal([
      "app",
      "deps",
      "├── exact:2.0.0",
      "│   └── leaf:^1.0.0 -> 1.2.0",
      "└── local",
      "test_deps",
      "└── chai:^4.0.0 -> 4.5.0",
    ]);
  });

  it("marks the versions that conflict, and lists them under the tree", () => {
    const lines = renderDependencyTrees([
      {
        title: "app",
        parts: new Map([["deps", [delivered("left", "1.0.0", "1.0.0", [delivered("react", "17.0.2", "^17.0.0")]), delivered("react", "18.3.1", "^18.0.0")]]]),
        conflicts: new Conflicts(
          new Map([["react", new Set(["17.0.2", "18.3.1"])]]),
          pkg => pkg.packageName === "react",
          () => Computable.resolve(undefined)
        ),
      },
    ]);
    expect(lines).to.deep.equal([
      "app",
      "deps",
      "├── left:1.0.0",
      "│   └── react:^17.0.0 -> 17.0.2 (!)",
      "└── react:^18.0.0 -> 18.3.1 (!)",
      "",
      "(!) conflicting in app:",
      "  react: 17.0.2, 18.3.1",
      "",
      "(!) - conflicting versions: refused where the target is built",
    ]);
  });

  it("names a target's node with the configuration it is built in, as the conflict note does", () => {
    /* One target under two configurations is two nodes: each line says which,
     * and the ambient configuration adds nothing to the name. */
    const base = node("base", "");
    const release = node("base", "JS_TARGET=es2022");
    const lines = renderDependencyTrees([
      {
        title: "app",
        parts: new Map([["deps", [node("lib", "", [base]), node("lib2", "", [release])]]]),
        conflicts: new Conflicts(
          new Map([["base", new Set(["<build #00000000>", "<build JS_TARGET=es2022 #11111111>"])]]),
          pkg => pkg.packageName === "base",
          () => Computable.resolve(undefined)
        ),
      },
    ]);
    expect(lines).to.deep.equal([
      "app",
      "deps",
      "├── lib",
      "│   └── base (!)",
      "└── lib2",
      "    └── base<JS_TARGET=es2022> (!)",
      "",
      "(!) conflicting in app:",
      "  base: base, base<JS_TARGET=es2022>",
      "",
      "(!) - conflicting versions: refused where the target is built",
    ]);
  });

  it("leaves out parts holding no package, and says so when none does", () => {
    expect(rendered([["srcs", []]])).to.deep.equal(["app", "No dependencies"]);
    expect(rendered([])).to.deep.equal(["app", "No dependencies"]);
  });

  it("omits the heading of an unnamed part", () => {
    expect(rendered([["", [delivered("glob", "10.0.0", "10.0.0")]]], "@npm:glob:10.0.0")).to.deep.equal(["@npm:glob:10.0.0", "└── glob:10.0.0"]);
  });

  it("expands a repeated subtree once, across parts, and terminates on a cycle", () => {
    const builder = new PackageGraphBuilder();
    const a = builder.node([], "a", "1.0.0");
    const b = builder.node([], "b", "1.0.0");
    const toA = { reference: reference("a", "1.0.0"), package: a };
    const toB = { reference: reference("b", "1.0.0"), package: b };
    builder.wire(a, [toB]);
    builder.wire(b, [toA]);
    builder.seal();
    expect(rendered([["deps", [toA]], ["test_deps", [toB]]])).to.deep.equal([
      "app",
      "deps",
      "└── a:1.0.0",
      "    └── b:1.0.0",
      "        └── a:1.0.0 (*)",
      "test_deps",
      "└── b:1.0.0 (*)",
      "",
      "(*) - subtree shown above",
    ]);
  });

  it("marks provided requirements and edges nothing is installed for", () => {
    const react = delivered("react", "18.3.1", ">=18");
    const widget = new PackageFileSet(
      [],
      "widget",
      "1.0.0",
      [react, { reference: reference("fsevents", "~2.3.2") }],
      undefined,
      new Map([["react", "expected"]])
    );
    expect(rendered([["deps", [{ reference: reference("widget", "1.0.0"), package: widget }]]])).to.deep.equal([
      "app",
      "deps",
      "└── widget:1.0.0",
      "    ├── react:>=18 -> 18.3.1 (p)",
      "    └── fsevents:~2.3.2 (n)",
      "",
      "(p) - provided requirement, bound by the consumer",
      "(n) - not installed",
    ]);
  });

  it("paints packages built in the project, and explains the colour", () => {
    /* Only a package a target produced is painted. One a registry or the fabr
     * installation delivered is not the project's. */
    const registry = { reference: reference("chai", "^4.0.0"), package: new PackageFileSet([], "chai", "4.5.0", [], { kind: "package-resolution" }) };
    const local = { reference: target("local"), package: new PackageFileSet([], "local", undefined, [], { kind: "target" }) };
    const lines = renderDependencyTrees(
      [{ title: "app", parts: new Map([["deps", [local, registry]]]) }],
      (code, text) => `<${code}>${text}</>`
    );
    expect(lines).to.deep.equal([
      "<1>app</>",
      "<1>deps</>",
      "<2>├── </><36>local</>",
      "<2>└── </>chai<2>:^4.0.0 -></> 4.5.0",
      "",
      "<2><36>name</> - built in this project</>",
    ]);
  });

  it("separates the blocks of several names", () => {
    const lines = renderDependencyTrees([
      { title: "one", parts: new Map([["deps", [delivered("x", "1.0.0", "1.0.0")]]]) },
      { title: "two", parts: new Map() },
    ]);
    expect(lines).to.deep.equal(["one", "deps", "└── x:1.0.0", "", "two", "No dependencies"]);
  });
});
