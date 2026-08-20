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
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { IPnpPackageInfo, IPnpSerializedState } from "../PnPManifest";
import type { ExportsValue } from "./PackageExports";
import { PnpResolver, splitSpecifier, typesPackageName } from "./PnPResolver";

const ROOT = path.resolve("/workspace");

/** A manifest of the shape the generator emits, with the rows a test names. */
function manifest(
  rows: Array<[string, string, Record<string, string>]>,
  fallback: Record<string, string> = {},
  topLevel: Record<string, string> = {}
): IPnpSerializedState {
  return {
    __info: [],
    dependencyTreeRoots: [],
    enableTopLevelFallback: true,
    ignorePatternData: null,
    fallbackExclusionList: [],
    fallbackPool: Object.entries(fallback),
    packageRegistryData: [
      [null, [[null, { packageLocation: "./", packageDependencies: Object.entries(topLevel), linkType: "SOFT" }]]],
      ...rows.map(([name, reference, dependencies]): [string, Array<[string, IPnpPackageInfo]>] => [
        name,
        [
          [
            reference,
            {
              packageLocation: `./.fabr-tree/${reference}/`,
              packageDependencies: Object.entries(dependencies),
              linkType: "HARD" as const,
            },
          ],
        ],
      ]),
    ],
  };
}

describe("splitSpecifier", () => {
  it("splits a package name from its subpath, scoped names included", () => {
    expect(splitSpecifier("three")).to.deep.equal({ name: "three", subpath: "" });
    expect(splitSpecifier("three/examples/loader")).to.deep.equal({ name: "three", subpath: "examples/loader" });
    expect(splitSpecifier("@radix-ui/react-slot")).to.deep.equal({ name: "@radix-ui/react-slot", subpath: "" });
    expect(splitSpecifier("@radix-ui/react-slot/dist/x")).to.deep.equal({ name: "@radix-ui/react-slot", subpath: "dist/x" });
  });

  it("declines anything that is not a package reference", () => {
    /* Relative, rooted and subpath-import specifiers are the compiler's to
     * resolve against the filesystem — the table never sees them. */
    expect(splitSpecifier("./sibling")).to.equal(undefined);
    expect(splitSpecifier("../up")).to.equal(undefined);
    expect(splitSpecifier("/abs/path")).to.equal(undefined);
    expect(splitSpecifier("#internal")).to.equal(undefined);
  });
});

describe("typesPackageName", () => {
  it("names the sidecar in npm's mangled spelling", () => {
    expect(typesPackageName("three")).to.equal("@types/three");
    expect(typesPackageName("@babel/traverse")).to.equal("@types/babel__traverse");
  });
});

describe("PnpResolver", () => {
  it("answers a package with what its own row binds", () => {
    const resolver = new PnpResolver(
      manifest([
        ["postprocessing", "ref-pp", { postprocessing: "ref-pp", three: "ref-three" } ],
        ["three", "ref-three", { three: "ref-three" }],
      ]),
      ROOT,
      []
    );
    const issuer = path.join(ROOT, ".fabr-tree/ref-pp/index.d.ts");
    expect(resolver.locationOf("three", issuer)).to.equal(path.join(ROOT, ".fabr-tree/ref-three"));
  });

  it("falls back to the declared surface for a name the issuer never declared", () => {
    /* The postprocessing/three case: a package's typings import a peer it did
     * not declare, whose types the CONSUMER declared. A tree forgave this
     * ambiently; the pool forgives it deliberately, and only within the surface
     * the consumer wrote down. */
    const resolver = new PnpResolver(
      manifest(
        [
          ["postprocessing", "ref-pp", { postprocessing: "ref-pp" }],
          ["@types/three", "ref-types", { "@types/three": "ref-types" }],
        ],
        { "@types/three": "ref-types" },
        { "@types/three": "ref-types" }
      ),
      ROOT,
      []
    );
    const issuer = path.join(ROOT, ".fabr-tree/ref-pp/index.d.ts");
    expect(resolver.locationOf("@types/three", issuer)).to.equal(path.join(ROOT, ".fabr-tree/ref-types"));
    /* With no pool, the same lookup finds nothing — the fallback is the whole
     * difference. */
    const strict = new PnpResolver(
      manifest([["postprocessing", "ref-pp", { postprocessing: "ref-pp" }]], {}, {}),
      ROOT,
      []
    );
    expect(strict.locationOf("@types/three", issuer)).to.equal(undefined);
  });

  it("treats a file under no package location as the compilation itself", () => {
    const resolver = new PnpResolver(manifest([["left-pad", "ref-lp", {}]], {}, { "left-pad": "ref-lp" }), ROOT, []);
    expect(resolver.locationOf("left-pad", path.join(ROOT, "src/index.ts"))).to.equal(path.join(ROOT, ".fabr-tree/ref-lp"));
  });

  it("gives an unsatisfied peer no binding, so it falls back like any undeclared name", () => {
    const state = manifest([["plugin", "ref-plugin", { plugin: "ref-plugin" }]], { react: "ref-react" }, {});
    state.packageRegistryData[1][1][0][1].packageDependencies.push(["react", null]);
    state.packageRegistryData.push([
      "react",
      [["ref-react", { packageLocation: "./.fabr-tree/ref-react/", packageDependencies: [], linkType: "HARD" }]],
    ]);
    const resolver = new PnpResolver(state, ROOT, []);
    expect(resolver.locationOf("react", path.join(ROOT, ".fabr-tree/ref-plugin/index.js"))).to.equal(
      path.join(ROOT, ".fabr-tree/ref-react")
    );
  });

  it("gives the pool to a delivered package and withholds it from the sources", () => {
    /* The split that decides where strictness pays. A DELIVERED package that
       imports what it never declared is npm's problem, not this build's — no
       amount of refusing fixes `reactcss`, and it resolves everywhere else. The
       SOURCES are the opposite: an undeclared import there means the package
       this build is about to publish is broken, and its author can fix it. */
    const resolver = new PnpResolver(
      manifest(
        [
          ["postprocessing", "ref-pp", { postprocessing: "ref-pp" }],
          ["three", "ref-three", { three: "ref-three" }],
        ],
        { three: "ref-three" },
        {}
      ),
      ROOT,
      []
    );
    expect(resolver.locationOf("three", path.join(ROOT, ".fabr-tree/ref-pp/index.js"))).to.equal(
      path.join(ROOT, ".fabr-tree/ref-three")
    );
    /* The same name, asked from the sources, is not answered: their declared
       surface is exactly what this project wrote down. */
    expect(resolver.locationOf("three", path.join(ROOT, "src/index.ts"))).to.equal(undefined);
  });

  it("withholds the pool from a package the manifest excludes", () => {
    /* The manifest bars the packages this project built. Their own row still
       answers everything they declared — the exclusion is about the pool, not
       about the package. */
    const state = manifest(
      [
        ["@shorthand/ui", "ref-ui", { "@shorthand/ui": "ref-ui", lodash: "ref-lodash" }],
        ["lodash", "ref-lodash", {}],
        ["three", "ref-three", {}],
      ],
      { three: "ref-three" },
      {}
    );
    state.fallbackExclusionList = [["@shorthand/ui", ["ref-ui"]]];
    const resolver = new PnpResolver(state, ROOT, []);
    const inside = path.join(ROOT, ".fabr-tree/ref-ui/index.js");
    /* Declared: answered by its own row. */
    expect(resolver.locationOf("lodash", inside)).to.equal(path.join(ROOT, ".fabr-tree/ref-lodash"));
    /* Undeclared: not answered, though the pool holds it. */
    expect(resolver.locationOf("three", inside)).to.equal(undefined);
  });

  it("merges the tables of rows that share a location, so both names work inside it", () => {
    /* An alias and the real package are one directory; a file inside it cannot
     * say which row it is, and both spellings must resolve. */
    const state = manifest([
      ["stream", "ref-alias", { stream: "ref-alias" }],
      ["stream-browserify", "ref-real", { "stream-browserify": "ref-real" }],
    ]);
    state.packageRegistryData[2][1][0][1].packageLocation = "./.fabr-tree/ref-alias/";
    const resolver = new PnpResolver(state, ROOT, []);
    const inside = path.join(ROOT, ".fabr-tree/ref-alias/index.js");
    expect(resolver.locationOf("stream", inside)).to.equal(path.join(ROOT, ".fabr-tree/ref-alias"));
    expect(resolver.locationOf("stream-browserify", inside)).to.equal(path.join(ROOT, ".fabr-tree/ref-alias"));
  });
});

describe("PnpResolver, resolving a specifier in full", () => {
  /** The conditions a compiler resolves under, which is the world these cases
   * are written in. */
  const CONDITIONS = ["types", "import", "node"];
  let store: string;

  beforeEach(() => {
    store = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-pnpexports-"));
  });

  afterEach(() => {
    fs.rmSync(store, { recursive: true, force: true });
  });

  /** A package in the store under `reference`, carrying the manifest fields a
   * case is about. */
  function pkg(reference: string, json: { exports?: ExportsValue; imports?: ExportsValue } = {}): void {
    fs.mkdirSync(path.join(store, reference), { recursive: true });
    fs.writeFileSync(path.join(store, reference, "package.json"), JSON.stringify({ name: reference, version: "1.0.0", ...json }));
  }

  /** A resolver over `store`, with a row per package named and every name
   * declared by the top level. */
  function resolving(...names: Array<[string, string]>): PnpResolver {
    const rows = names.map(([name, reference]): [string, string, Record<string, string>] => [name, reference, { [name]: reference }]);
    const declared = Object.fromEntries(names);
    const state = manifest(rows, declared, declared);
    /* Locations relative to the store, which is where the fixture writes the
     * manifests this reads. */
    for (const [, references] of state.packageRegistryData) {
      for (const [, info] of references) {
        info.packageLocation = info.packageLocation.replace("./.fabr-tree/", "./");
      }
    }
    return new PnpResolver(state, store, CONDITIONS);
  }

  const from = (): string => path.join(store, "src/index.ts");

  it("hands back the directory for a package that publishes no exports", () => {
    pkg("ref-plain");
    const resolver = resolving(["plain", "ref-plain"]);
    expect(resolver.resolveSpecifier("plain", from())).to.equal(path.join(store, "ref-plain"));
    /* And a subpath appended to it, for the caller to probe — which is all node
     * ever did before `exports` existed. */
    expect(resolver.resolveSpecifier("plain/deep/thing", from())).to.equal(path.join(store, "ref-plain/deep/thing"));
  });

  it("answers with the file a package's exports map publishes", () => {
    pkg("ref-modern", {
      exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" }, "./client": "./dist/client/index.js" },
    });
    const resolver = resolving(["modern", "ref-modern"]);
    expect(resolver.resolveSpecifier("modern", from())).to.equal(path.join(store, "ref-modern/dist/index.d.ts"));
    expect(resolver.resolveSpecifier("modern/client", from())).to.equal(path.join(store, "ref-modern/dist/client/index.js"));
  });

  it("refuses a subpath the package does not publish, rather than probing for it", () => {
    /* The difference an exports map makes: the file is right there, and has no
     * name. Falling back to the path would resolve something the package's own
     * consumers cannot resolve. */
    pkg("ref-modern", { exports: { ".": "./dist/index.js" } });
    const resolver = resolving(["modern", "ref-modern"]);
    expect(resolver.resolveSpecifier("modern/dist/index.js", from())).to.equal(undefined);
    expect(resolver.resolveSpecifier("modern/internal", from())).to.equal(undefined);
  });

  it("answers a private #specifier from the map of the package that wrote it", () => {
    pkg("ref-private", { imports: { "#state": "./src/state.js", "#helper": "helper/deep" } });
    pkg("ref-helper", { exports: { "./deep": "./lib/deep.js" } });
    const resolver = resolving(["private", "ref-private"], ["helper", "ref-helper"]);
    const inside = path.join(store, "ref-private/src/app.js");
    expect(resolver.resolveSpecifier("#state", inside)).to.equal(path.join(store, "ref-private/src/state.js"));
    /* A redirection to another package resolves from the same issuer, so it
     * sees exactly what the package that wrote it may see. */
    expect(resolver.resolveSpecifier("#helper", inside)).to.equal(path.join(store, "ref-helper/lib/deep.js"));
    /* And a `#` name means nothing outside the package that declared it. */
    expect(resolver.resolveSpecifier("#state", from())).to.equal(undefined);
  });

  it("names a file by the subpath its package publishes, not by where it sits", () => {
    pkg("ref-modern", { exports: { ".": "./dist/index.d.ts", "./client": "./dist/client/index.d.ts" } });
    const resolver = resolving(["modern", "ref-modern"]);
    expect(resolver.packageOf(path.join(store, "ref-modern/dist/client/index.d.ts"))).to.deep.equal({
      name: "modern",
      subpath: "client",
    });
    expect(resolver.packageOf(path.join(store, "ref-modern/dist/index.d.ts"))).to.deep.equal({ name: "modern", subpath: "" });
    /* A file with no published name keeps its path: unnameable either way, and
     * the path at least says which file it was. */
    expect(resolver.packageOf(path.join(store, "ref-modern/dist/internal.d.ts"))).to.deep.equal({
      name: "modern",
      subpath: "dist/internal.d.ts",
    });
  });

  it("reports which package an invalid exports map belongs to", () => {
    pkg("ref-broken", { exports: { ".": "./index.js", import: "./esm.js" } });
    const resolver = resolving(["broken", "ref-broken"]);
    expect(() => resolver.resolveSpecifier("broken", from())).to.throw(/ref-broken.package.json: .*cannot be mixed/);
  });
});
