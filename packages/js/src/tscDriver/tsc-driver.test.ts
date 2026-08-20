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
import type { IPnpSerializedState, PnpDependencyTarget } from "../PnPManifest";
import { PnpResolver } from "../pnp/PnPResolver";
import { main, resolutionFor, rewriteDeclaration } from "./tsc-driver";

/** A staged workspace: sources, a tsconfig, a manifest, and a store the
 * manifest's locations point into through the same link a build step stages. */
interface IFixture {
  root: string;
  store: string;
  /** Add a package to the store and answer the reference naming it. `manifest`
   * carries whatever the case is about (`exports`, `imports`, `types`); files
   * are written at whatever depth their names give. */
  add(name: string, files: Record<string, string>, manifest?: Record<string, unknown>): string;
}

function fixture(): IFixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-tscdriver-"));
  const root = path.join(base, "work");
  const store = path.join(base, "store");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(store, { recursive: true });
  fs.symlinkSync(store, path.join(root, ".fabr-tree"));
  let next = 0;
  return {
    root,
    store,
    add(name, files, manifest = {}) {
      const reference = `key${next++}`;
      const entry = path.join(store, reference);
      fs.mkdirSync(entry, { recursive: true });
      fs.writeFileSync(path.join(entry, "package.json"), JSON.stringify({ name, version: "1.0.0", ...manifest }));
      for (const [file, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(entry, file)), { recursive: true });
        fs.writeFileSync(path.join(entry, file), content);
      }
      return reference;
    },
  };
}

/** Write the workspace's project and manifest. */
function stage(
  root: string,
  rows: Array<[string, string, Array<[string, PnpDependencyTarget]>]>,
  topLevel: Array<[string, PnpDependencyTarget]>,
  fallbackPool: Array<[string, PnpDependencyTarget]>,
  self?: { name: string; location: string },
  module = "commonjs"
): void {
  const state: IPnpSerializedState = {
    __info: [],
    dependencyTreeRoots: [],
    enableTopLevelFallback: true,
    ignorePatternData: null,
    fallbackExclusionList: [],
    fallbackPool,
    packageRegistryData: [
      [null, [[null, { packageLocation: "./", packageDependencies: topLevel, linkType: "SOFT" }]]],
      ...(self
        ? ([
            [
              self.name,
              [["self", { packageLocation: self.location, packageDependencies: [[self.name, "self"], ...topLevel], linkType: "SOFT" }]],
            ],
          ] as IPnpSerializedState["packageRegistryData"])
        : []),
      ...rows.map(([name, reference, dependencies]): [string, Array<[string, { packageLocation: string; packageDependencies: Array<[string, PnpDependencyTarget]>; linkType: "HARD" }]>] => [
        name,
        [[reference, { packageLocation: `./.fabr-tree/${reference}/`, packageDependencies: dependencies, linkType: "HARD" }]],
      ]),
    ],
  };
  fs.writeFileSync(path.join(root, ".pnp.data.json"), JSON.stringify(state, undefined, 2));
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        declaration: true,
        outDir: "build",
        rootDir: "src",
        strict: true,
        /* Off, so a dependency's OWN typings are checked here: the fixture is
         * about what a package can resolve, and fabr's real tsconfig (which
         * skips them) would report the same failure only later, where the
         * degraded type leaks into the consumer's code. */
        skipLibCheck: false,
        module,
        /* `moduleResolution` deliberately unstated, as fabr's generated project
         * leaves it: the driver supplies the value this compiler accepts. */
        target: "es2021",
        types: [],
        pretty: false,
      },
      include: ["./src/**/*.ts"],
    })
  );
}

/** Run the driver in `root`, capturing what it writes where tsc writes its
 * diagnostics. */
function compile(root: string): { status: number; output: string } {
  const cwd = process.cwd();
  const write = process.stdout.write.bind(process.stdout);
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    process.chdir(root);
    return { status: main([]), output };
  } finally {
    process.stdout.write = write;
    process.chdir(cwd);
  }
}

describe("the tsc driver", () => {
  let work: IFixture;

  beforeEach(() => {
    work = fixture();
  });

  afterEach(() => {
    fs.rmSync(path.dirname(work.root), { recursive: true, force: true });
  });

  it("resolves a package through the manifest and emits like the CLI", () => {
    const left = work.add("left-pad", { "index.d.ts": "export declare function pad(text: string): string;\n" });
    stage(work.root, [["left-pad", left, [["left-pad", left]]]], [["left-pad", left]], [["left-pad", left]]);
    fs.writeFileSync(path.join(work.root, "src/index.ts"), 'import { pad } from "left-pad";\nexport const padded = pad("x");\n');

    const { status, output } = compile(work.root);
    expect(output).to.equal("");
    expect(status).to.equal(0);
    /* Declarations and JavaScript, at the project's own outDir. */
    expect(fs.existsSync(path.join(work.root, "build/index.js"))).to.equal(true);
    expect(fs.readFileSync(path.join(work.root, "build/index.d.ts"), "utf8")).to.contain("padded");
  });

  it("takes a dependency's types from the fallback pool when the dependency itself declares none", () => {
    /* The dylan regression, synthesized: `postprocessing`'s typings import
     * `three`, which ships no types of its own; the types live in a SIDECAR
     * (`@types/three`) that only the consumer declared. A hoisted install
     * forgave that ambiently — a table must forgive it deliberately, or every
     * such package stops typechecking. */
    const consumer = work.add("postprocessing", {
      "index.d.ts": 'import { Widget } from "three";\nexport declare function make(): Widget;\n',
    });
    const untyped = work.add("three", { "index.js": "module.exports = {};\n" });
    const sidecar = work.add("@types/three", { "index.d.ts": "export declare class Widget { spin(): void }\n" });
    const rows: Array<[string, string, Array<[string, PnpDependencyTarget]>]> = [
      /* postprocessing declares `three` and NOT its types — the phantom edge. */
      ["postprocessing", consumer, [["postprocessing", consumer], ["three", untyped]]],
      ["three", untyped, [["three", untyped]]],
      ["@types/three", sidecar, [["@types/three", sidecar]]],
    ];
    const declared: Array<[string, PnpDependencyTarget]> = [
      ["postprocessing", consumer],
      ["three", untyped],
      ["@types/three", sidecar],
    ];
    fs.writeFileSync(
      path.join(work.root, "src/index.ts"),
      'import { make } from "postprocessing";\nexport const spun = () => make().spin();\n'
    );

    stage(work.root, rows, declared, declared);
    const withPool = compile(work.root);
    expect(withPool.output).to.equal("");
    expect(withPool.status).to.equal(0);

    /* And with the pool emptied it fails exactly where it should: the sidecar
     * is reachable to nobody, so the phantom edge has no types. */
    fs.rmSync(path.join(work.root, "build"), { recursive: true, force: true });
    stage(work.root, rows, declared, []);
    const strict = compile(work.root);
    expect(strict.status).to.not.equal(0);
    /* Reported exactly as the compiler reports a typeless dependency anywhere
     * else — including its own advice to add the sidecar. */
    expect(strict.output, strict.output).to.contain("error TS7016: Could not find a declaration file for module 'three'");
  });

  it("takes the sidecar's own subpath, not its root, for a subpath import", () => {
    /* Dropping the subpath would hand `three/examples/x` the declarations for
       `three` itself — a different module, silently. */
    const untyped = work.add("three", { "index.js": "module.exports = {};\n", "examples/loader.js": "module.exports = {};\n" });
    const sidecar = work.add("@types/three", {
      "index.d.ts": "export declare const root: 'the root types';\n",
      "examples/loader.d.ts": "export declare const loader: 'the subpath types';\n",
    });
    const rows: Array<[string, string, Array<[string, PnpDependencyTarget]>]> = [
      ["three", untyped, [["three", untyped]]],
      ["@types/three", sidecar, [["@types/three", sidecar]]],
    ];
    const declared: Array<[string, PnpDependencyTarget]> = [["three", untyped], ["@types/three", sidecar]];
    stage(work.root, rows, declared, declared);
    fs.writeFileSync(work.root + "/src/index.ts", 'import { loader } from "three/examples/loader";\nexport const which = loader;\n');

    const { status, output } = compile(work.root);
    expect(status, output).to.equal(0);
    expect(fs.readFileSync(path.join(work.root, "build/index.d.ts"), "utf8")).to.contain("the subpath types");
  });

  it("resolves a package's own name and subpaths through its row", () => {
    const lib = work.add("lib", {
      "index.d.ts": 'export * from "./deep";\n',
      "deep.d.ts": "export declare const deep: number;\n",
    });
    stage(work.root, [["lib", lib, [["lib", lib]]]], [["lib", lib]], []);
    fs.writeFileSync(path.join(work.root, "src/index.ts"), 'import { deep } from "lib/deep";\nexport const value: number = deep;\n');

    expect(compile(work.root).status).to.equal(0);
  });

  it("resolves a package that publishes its files through an exports map", () => {
    /* A modern package: no `main`, no `types`, nothing at the package root — the
     * map is the only statement of what it has, so without reading it there is
     * nothing to resolve at all. */
    const modern = work.add(
      "modern",
      {
        "dist/index.d.ts": "export declare const root: 'the main entry';\n",
        "dist/client/index.d.ts": "export declare const client: 'the client entry';\n",
        "dist/internal/secret.d.ts": "export declare const secret: string;\n",
      },
      {
        exports: {
          ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
          "./client": { types: "./dist/client/index.d.ts", default: "./dist/client/index.js" },
        },
      }
    );
    stage(work.root, [["modern", modern, [["modern", modern]]]], [["modern", modern]], []);
    fs.writeFileSync(
      work.root + "/src/index.ts",
      'import { root } from "modern";\nimport { client } from "modern/client";\nexport const both = [root, client];\n'
    );

    const { status, output } = compile(work.root);
    expect(status, output).to.equal(0);
    const emitted = fs.readFileSync(path.join(work.root, "build/index.d.ts"), "utf8");
    expect(emitted).to.contain("the main entry");
    expect(emitted).to.contain("the client entry");

    /* And what the map does not publish has no name, however plainly the file
     * is there: a deep import a hoisted tree would have resolved fails here,
     * which is the whole point of the package having written a map. */
    fs.writeFileSync(work.root + "/src/index.ts", 'import { secret } from "modern/dist/internal/secret";\nexport const s = secret;\n');
    const deep = compile(work.root);
    expect(deep.status).to.not.equal(0);
    expect(deep.output).to.contain("Cannot find module 'modern/dist/internal/secret'");
  });

  it("reaches a types condition the package lists after its implementations", () => {
    /* aws-jwt-verify's shape: the only declaration file is at the package root,
     * behind a `types` key listed LAST — bad practice, and the compiler handles
     * it, because a condition names an implementation while the question asked
     * is about declarations. Reading the first matching condition and stopping
     * leaves the package untyped. */
    const late = work.add(
      "late",
      {
        "dist/esm/https.js": "export const face = 1;\n",
        "dist/cjs/https.js": "module.exports = {};\n",
        "https.d.ts": "export declare const face: 'the trailing types key';\n",
      },
      { exports: { "./https": { import: "./dist/esm/https.js", require: "./dist/cjs/https.js", types: "./https.d.ts" } } }
    );
    stage(work.root, [["late", late, [["late", late]]]], [["late", late]], []);
    fs.writeFileSync(work.root + "/src/index.ts", 'import { face } from "late/https";\nexport const which = face;\n');

    const { status, output } = compile(work.root);
    expect(status, output).to.equal(0);
    expect(fs.readFileSync(path.join(work.root, "build/index.d.ts"), "utf8")).to.contain("the trailing types key");
  });

  it("prefers the declarations beside the face it resolved over a trailing types key", () => {
    /* The same map, but the implementations have their own declarations. Those
     * are this compilation's — the two faces of a dual package need not describe
     * the same shape — so the walk stops at the first key that answers rather
     * than preferring `types` wherever it appears. Reaching for `types` first
     * would hand a CommonJS compile the generic declarations instead. */
    const both = work.add(
      "both",
      {
        "dist/esm/https.js": "export const face = 1;\n",
        "dist/esm/https.d.ts": "export declare const face: 'the esm declarations';\n",
        "dist/cjs/https.js": "module.exports = {};\n",
        "dist/cjs/https.d.ts": "export declare const face: 'the cjs declarations';\n",
        "https.d.ts": "export declare const face: 'the generic declarations';\n",
      },
      { exports: { "./https": { import: "./dist/esm/https.js", require: "./dist/cjs/https.js", types: "./https.d.ts" } } }
    );
    stage(work.root, [["both", both, [["both", both]]]], [["both", both]], []);
    fs.writeFileSync(work.root + "/src/index.ts", 'import { face } from "both/https";\nexport const which = face;\n');

    const { status, output } = compile(work.root);
    expect(status, output).to.equal(0);
    /* The fixture emits CommonJS, so the `require` face's own declarations win. */
    expect(fs.readFileSync(path.join(work.root, "build/index.d.ts"), "utf8")).to.contain("the cjs declarations");
  });

  it("types a package whose declarations the strict rule cannot see, since it runs", () => {
    /* The shape half the ecosystem's build tools emit: dual `.mjs`/`.cjs`, ONE
     * `.d.ts`, no `types` condition. Node loads `dist/index.cjs` from a require
     * without complaint, so refusing to compile it would fail an import that
     * executes — the declarations are found under their plain name instead of
     * the `.d.cts` the format-tagged rule wants. */
    const dual = work.add(
      "dual",
      {
        "dist/index.mjs": "export const face = 1;\n",
        "dist/index.cjs": "module.exports = {};\n",
        "dist/index.d.ts": "export declare const face: 'the single d.ts';\n",
      },
      {
        main: "./dist/index.cjs",
        types: "./dist/index.d.ts",
        exports: { ".": { import: "./dist/index.mjs", require: "./dist/index.cjs" } },
      }
    );
    stage(work.root, [["dual", dual, [["dual", dual]]]], [["dual", dual]], []);
    fs.writeFileSync(work.root + "/src/index.ts", 'import { face } from "dual";\nexport const which = face;\n');

    const { status, output } = compile(work.root);
    expect(status, output).to.equal(0);
    expect(fs.readFileSync(path.join(work.root, "build/index.d.ts"), "utf8")).to.contain("the single d.ts");
  });

  it("takes typings from types/main only for an entry the map actually publishes", () => {
    /* The other half of the same rule. `main` and `types` are dead the moment a
     * map exists — node never reads them — so they may fill in declarations for
     * something the map published, and must never resurrect something it did
     * not. A require of this package answers ERR_PACKAGE_PATH_NOT_EXPORTED, and
     * so must the compile. */
    const closed = work.add(
      "closed",
      { "index.js": "module.exports = {};\n", "index.d.ts": "export declare const face: 'the legacy entry';\n" },
      { main: "./index.js", types: "./index.d.ts", exports: { "./sub": "./index.js" } }
    );
    stage(work.root, [["closed", closed, [["closed", closed]]]], [["closed", closed]], []);
    fs.writeFileSync(work.root + "/src/index.ts", 'import { face } from "closed";\nexport const which = face;\n');

    const { status, output } = compile(work.root);
    expect(status).to.not.equal(0);
    expect(output).to.contain("Cannot find module 'closed'");
  });

  it("resolves an ESM entry a require may load, and refuses one it may not", () => {
    /* `module-sync` is how a package says its ESM entry is synchronously
     * loadable — node 22 and later require() exactly these. The compilation
     * emits CommonJS, and this still runs, so it still compiles. */
    const sync = work.add(
      "modsync",
      { "esm.js": "export const face = 1;\n", "esm.d.ts": "export declare const face: 'the module-sync entry';\n" },
      { type: "module", exports: { ".": { "module-sync": "./esm.js" } } }
    );
    stage(work.root, [["modsync", sync, [["modsync", sync]]]], [["modsync", sync]], []);
    fs.writeFileSync(work.root + "/src/index.ts", 'import { face } from "modsync";\nexport const which = face;\n');
    const ran = compile(work.root);
    expect(ran.status, ran.output).to.equal(0);
    expect(fs.readFileSync(path.join(work.root, "build/index.d.ts"), "utf8")).to.contain("the module-sync entry");

    /* And the package that publishes `import` alone says the opposite: node
     * answers ERR_PACKAGE_PATH_NOT_EXPORTED to a require of it, so a CommonJS
     * compilation must not resolve it however plainly its files sit there. */
    const esmOnly = work.add(
      "esmonly",
      { "esm.js": "export const face = 1;\n", "esm.d.ts": "export declare const face: 'unreachable';\n" },
      { type: "module", exports: { ".": { import: "./esm.js" } } }
    );
    stage(work.root, [["esmonly", esmOnly, [["esmonly", esmOnly]]]], [["esmonly", esmOnly]], []);
    fs.writeFileSync(work.root + "/src/index.ts", 'import { face } from "esmonly";\nexport const which = face;\n');
    const refused = compile(work.root);
    expect(refused.status).to.not.equal(0);
    expect(refused.output).to.contain("Cannot find module 'esmonly'");
  });

  it("finds the typings beside the implementation an exports map names", () => {
    /* The commonest real shape: a map with no `types` condition at all, whose
     * typings are the `.d.ts` sitting beside the `.js` it publishes. Finding
     * that sibling is the compiler's own rule, and it still applies — which is
     * the point of handing it the file rather than resolving all the way here. */
    const sibling = work.add(
      "sibling",
      { "dist/index.js": "module.exports = {};\n", "dist/index.d.ts": "export declare const found: 'the sibling typings';\n" },
      { exports: { ".": "./dist/index.js" } }
    );
    stage(work.root, [["sibling", sibling, [["sibling", sibling]]]], [["sibling", sibling]], []);
    fs.writeFileSync(work.root + "/src/index.ts", 'import { found } from "sibling";\nexport const which = found;\n');

    const { status, output } = compile(work.root);
    expect(status, output).to.equal(0);
    expect(fs.readFileSync(path.join(work.root, "build/index.d.ts"), "utf8")).to.contain("the sibling typings");
  });

  it("takes the export condition matching the module system the project emits", () => {
    /* One package, two faces. The fixture emits CommonJS, so the `require`
     * typings are this compilation's — picking the other would type an ESM
     * default import that is not what this project will actually load. */
    const dual = work.add(
      "dual",
      {
        "esm.d.ts": "export declare const face: 'the esm face';\n",
        "cjs.d.ts": "export declare const face: 'the cjs face';\n",
      },
      { exports: { ".": { types: { import: "./esm.d.ts", require: "./cjs.d.ts" }, default: "./index.js" } } }
    );
    stage(work.root, [["dual", dual, [["dual", dual]]]], [["dual", dual]], []);
    fs.writeFileSync(work.root + "/src/index.ts", 'import { face } from "dual";\nexport const which = face;\n');

    const { status, output } = compile(work.root);
    expect(status, output).to.equal(0);
    expect(fs.readFileSync(path.join(work.root, "build/index.d.ts"), "utf8")).to.contain("the cjs face");
  });

  it("resolves a dependency's own #private specifiers through its imports map", () => {
    /* A package's typings referring to itself by a private name. Nothing but the
     * package's own manifest can answer one, and the compiler under classic
     * resolution does not read it at all. */
    const inner = work.add(
      "inner",
      {
        "index.d.ts": 'export { Widget } from "#state";\n',
        "src/state.d.ts": "export declare class Widget { spin(): void }\n",
      },
      { imports: { "#state": "./src/state.d.ts" } }
    );
    stage(work.root, [["inner", inner, [["inner", inner]]]], [["inner", inner]], []);
    fs.writeFileSync(work.root + "/src/index.ts", 'import { Widget } from "inner";\nexport const spin = (w: Widget) => w.spin();\n');

    const { status, output } = compile(work.root);
    expect(status, output).to.equal(0);
  });

  it("never resolves out of the workspace, whatever an ancestor directory holds", () => {
    /* Holds by construction now: a bare specifier is answered by the table
     * alone, so there is no walk up through ancestors fabr does not own for a
     * stray `node_modules` (the classic `~/node_modules` accident) to answer.
     * Kept as the regression that says so. */
    const ancestor = path.join(path.dirname(work.root), "node_modules/ghost");
    fs.mkdirSync(ancestor, { recursive: true });
    fs.writeFileSync(path.join(ancestor, "package.json"), JSON.stringify({ name: "ghost", types: "index.d.ts" }));
    fs.writeFileSync(path.join(ancestor, "index.d.ts"), "export declare const from: 'the ancestor';\n");
    fs.writeFileSync(path.join(work.root, "src/index.ts"), 'import { from } from "ghost";\nexport const where: string = from;\n');

    stage(work.root, [], [], []);
    const stray = compile(work.root);
    expect(stray.status, stray.output).to.not.equal(0);
    expect(stray.output).to.contain("Cannot find module 'ghost'");

    /* And with a row for that name, the TABLE's package answers — never the
     * one that happens to sit above the workspace. Unannotated, so the emitted
     * declaration carries whichever literal type answered. */
    fs.writeFileSync(path.join(work.root, "src/index.ts"), 'import { from } from "ghost";\nexport const where = from;\n');
    const declared = work.add("ghost", { "index.d.ts": "export declare const from: 'the table';\n" });
    stage(work.root, [["ghost", declared, [["ghost", declared]]]], [["ghost", declared]], []);
    const tabled = compile(work.root);
    expect(tabled.status, tabled.output).to.equal(0);
    expect(fs.readFileSync(path.join(work.root, "build/index.d.ts"), "utf8")).to.contain('"the table"');
  });

  it("resolves the sources' own package name, bare and by subpath, through its row", () => {
    /* A package's references to ITSELF are a row like any other — the sources'
     * own name, located at the staged source tree — which is what lets the
     * compiler answer them without searching for a package that is not
     * installed anywhere. */
    fs.mkdirSync(path.join(work.root, "src/util"), { recursive: true });
    fs.writeFileSync(path.join(work.root, "src/index.ts"), 'export const value = 1;\n');
    fs.writeFileSync(path.join(work.root, "src/util/pad.ts"), 'export const pad = (x: string): string => x;\n');
    fs.writeFileSync(
      path.join(work.root, "src/app.ts"),
      'import { value } from "mylib";\nimport { pad } from "mylib/util/pad";\nexport const both = pad(String(value));\n'
    );
    stage(work.root, [], [], [], { name: "mylib", location: "./src/" });

    const { status, output } = compile(work.root);
    expect(status, output).to.equal(0);
    expect(fs.existsSync(path.join(work.root, "build/app.js"))).to.equal(true);
  });

  it("reports an undeclared package as the compiler would", () => {
    stage(work.root, [], [], []);
    fs.writeFileSync(path.join(work.root, "src/index.ts"), 'import { x } from "nowhere";\nexport const y = x;\n');

    const { status, output } = compile(work.root);
    expect(status).to.not.equal(0);
    expect(output).to.contain("Cannot find module 'nowhere'");
  });

  it("ships a package name where the emitter would have written this build's layout", () => {
    /* The declaration emitter synthesizes a specifier for a type it cannot
     * otherwise name — an inferred generic from a dependency, the zustand
     * `UseStore<Model>` shape — from the resolved file's PATH. With no
     * node_modules segment to read a package name out of, it writes the store
     * path: this build's layout, baked into a shipped artifact, and dead in
     * every consumer (where it resolves relative to wherever the .d.ts lands). */
    const zustand = work.add("zustand", {
      "index.d.ts": "export declare class UseStore<T> { getState(): T }\nexport declare function create<T>(): UseStore<T>;\n",
    });
    stage(work.root, [["zustand", zustand, [["zustand", zustand]]]], [["zustand", zustand]], []);
    fs.writeFileSync(
      path.join(work.root, "src/index.ts"),
      'import { create } from "zustand";\nexport interface Model { count: number }\nexport const store = create<Model>();\n'
    );

    expect(compile(work.root).status).to.equal(0);
    const declaration = fs.readFileSync(path.join(work.root, "build/index.d.ts"), "utf8");
    expect(declaration, declaration).to.contain('import("zustand")');
    expect(declaration, declaration).to.not.contain(".fabr-tree");

    /* And it survives the trip: a consumer resolving that declaration through
     * ITS own table gets the type back, where the path would have collapsed to
     * `unknown` and taken every property access with it. */
    const downstream = fixture();
    try {
      const appcore = downstream.add("appcore", { "index.d.ts": declaration });
      const shared = downstream.add("zustand", {
        "index.d.ts": "export declare class UseStore<T> { getState(): T }\nexport declare function create<T>(): UseStore<T>;\n",
      });
      stage(
        downstream.root,
        [
          ["appcore", appcore, [["appcore", appcore], ["zustand", shared]]],
          ["zustand", shared, [["zustand", shared]]],
        ],
        [["appcore", appcore]],
        []
      );
      fs.writeFileSync(
        path.join(downstream.root, "src/index.ts"),
        'import { store } from "appcore";\nexport const count: number = store.getState().count;\n'
      );
      const consumer = compile(downstream.root);
      expect(consumer.status, consumer.output).to.equal(0);
    } finally {
      fs.rmSync(path.dirname(downstream.root), { recursive: true, force: true });
    }
  });

  it("takes the ES-module face when the project emits ES modules", () => {
    /* The mirror of the CommonJS case, and the half a fixture hardcoded to
     * `commonjs` can never reach: the same package, the same map, the other
     * emit, the other face. */
    const dual = work.add(
      "dual",
      { "esm.d.ts": "export declare const face: 'the esm face';\n", "cjs.d.ts": "export declare const face: 'the cjs face';\n" },
      { exports: { ".": { types: { import: "./esm.d.ts", require: "./cjs.d.ts" }, default: "./index.js" } } }
    );
    stage(work.root, [["dual", dual, [["dual", dual]]]], [["dual", dual]], [], undefined, "esnext");
    fs.writeFileSync(work.root + "/src/index.ts", 'import { face } from "dual";\nexport const which = face;\n');

    const { status, output } = compile(work.root);
    expect(status, output).to.equal(0);
    expect(fs.readFileSync(path.join(work.root, "build/index.d.ts"), "utf8")).to.contain("the esm face");
  });

  it("types a dependency that exists only as its @types package", () => {
    /* The DefinitelyTyped shape for an API that is not an npm package at all
       (`@types/aws-lambda`), and for one a project types without installing
       (`@types/ffprobe`): the declarations ARE the dependency, and the name has
       no row of its own. Nothing here can fail to load, because nothing here
       loads. */
    const sidecar = work.add(
      "@types/ffprobe",
      { "index.d.ts": "export declare function probe(): 'the sidecar types';\n" },
      { main: "", types: "index.d.ts" }
    );
    stage(work.root, [["@types/ffprobe", sidecar, [["@types/ffprobe", sidecar]]]], [["@types/ffprobe", sidecar]], []);
    fs.writeFileSync(work.root + "/src/index.ts", 'import { probe } from "ffprobe";\nexport const which = probe();\n');

    const { status, output } = compile(work.root);
    expect(status, output).to.equal(0);
    expect(fs.readFileSync(path.join(work.root, "build/index.d.ts"), "utf8")).to.contain("the sidecar types");
  });

  it("refuses a subpath the map does not publish, whatever the sidecar offers", () => {
    /* An `@types` package describes a module the program can LOAD. It may fill
     * in declarations for a name the package published and left untyped; it may
     * not be what makes an unpublished name resolvable, or the compile would
     * accept an import node answers with ERR_PACKAGE_PATH_NOT_EXPORTED. */
    const closed = work.add("closed", { "index.js": "module.exports = {};\n", "sub.js": "module.exports = {};\n" }, { exports: { ".": "./index.js" } });
    const sidecar = work.add("@types/closed", { "sub.d.ts": "export declare const face: 'from the sidecar';\n" });
    stage(
      work.root,
      [
        ["closed", closed, [["closed", closed]]],
        ["@types/closed", sidecar, [["@types/closed", sidecar]]],
      ],
      [["closed", closed], ["@types/closed", sidecar]],
      []
    );
    fs.writeFileSync(work.root + "/src/index.ts", 'import { face } from "closed/sub";\nexport const which = face;\n');

    const { status, output } = compile(work.root);
    expect(status).to.not.equal(0);
    expect(output).to.contain("Cannot find module 'closed/sub'");
  });

  it("reports an unreadable dependency manifest without losing the other diagnostics", () => {
    /* One package's mistake is not the compilation's: the import that touched it
     * fails where it is written, every other diagnostic still arrives, and the
     * reason is stated once. */
    const broken = work.add("broken", { "index.js": "module.exports = {};\n" }, { exports: { ".": "./index.js", import: "./esm.js" } });
    stage(work.root, [["broken", broken, [["broken", broken]]]], [["broken", broken]], []);
    fs.writeFileSync(work.root + "/src/index.ts", 'import { face } from "broken";\nexport const which: number = face;\nexport const other: number = "not a number";\n');

    const { status, output } = compile(work.root);
    expect(status).to.not.equal(0);
    expect(output).to.contain("cannot be mixed");
    expect(output).to.contain("broken");
    /* The unrelated error in the project's own code still reported. */
    expect(output).to.contain("not assignable to type 'number'");
  });

  it("keys a resolution by the package that asked, not by the specifier alone", () => {
    /* Two consumers, one name, two versions — the arrangement the table exists
     * to keep apart. Serving the first asker's answer to the second is silent
     * cross-version type leakage. */
    /* Distinct versions, or the compiler's own packageId dedup collapses the two
       into one module before the resolver's answer matters. */
    const one = work.add("dep", { "index.d.ts": "export declare const face: 'version one';\n" }, { version: "1.0.0" });
    const two = work.add("dep", { "index.d.ts": "export declare const face: 'version two';\n" }, { version: "2.0.0" });
    const left = work.add("left", { "index.d.ts": 'export { face as leftFace } from "dep";\n' });
    const right = work.add("right", { "index.d.ts": 'export { face as rightFace } from "dep";\n' });
    stage(
      work.root,
      [
        ["left", left, [["left", left], ["dep", one]]],
        ["right", right, [["right", right], ["dep", two]]],
        ["dep", one, [["dep", one]]],
        ["dep", two, [["dep", two]]],
      ],
      [["left", left], ["right", right]],
      []
    );
    fs.writeFileSync(
      work.root + "/src/index.ts",
      'import { leftFace } from "left";\nimport { rightFace } from "right";\nexport const both = [leftFace, rightFace];\n'
    );

    const { status, output } = compile(work.root);
    expect(status, output).to.equal(0);
    const emitted = fs.readFileSync(path.join(work.root, "build/index.d.ts"), "utf8");
    expect(emitted, emitted).to.contain("version one");
    expect(emitted, emitted).to.contain("version two");
  });

  it("ships the name a package publishes for a file, not where the file sits", () => {
    /* The reverse of resolution, and it needs the map just as much: the emitter
     * knows only the path it resolved, and under an `exports` map the path is
     * not a specifier any consumer could write. */
    const modern = work.add(
      "modern",
      { "dist/client/index.d.ts": "export declare const x: number;\n", "dist/internal.d.ts": "export declare const y: number;\n" },
      { exports: { ".": "./dist/index.d.ts", "./client": "./dist/client/index.d.ts" } }
    );
    stage(work.root, [["modern", modern, [["modern", modern]]]], [["modern", modern]], []);
    const resolver = PnpResolver.load(work.root, ["types", "require", "node"])!;
    const emitted = path.join(work.root, "build/index.d.ts");

    expect(rewriteDeclaration(emitted, `export declare const s: import("../.fabr-tree/${modern}/dist/client/index.d.ts").x;\n`, resolver)).to.contain(
      'import("modern/client")'
    );
    /* A file the map publishes no name for still leaves the pool — it is named
     * by path, which is the honest answer and not a tree reference. */
    expect(rewriteDeclaration(emitted, `export declare const s: import("../.fabr-tree/${modern}/dist/internal.d.ts").y;\n`, resolver)).to.contain(
      'import("modern/dist/internal.d.ts")'
    );
  });

  it("refuses to emit a declaration naming a tree it cannot name a package for", () => {
    /* The safety net: a rewrite that misses anything must fail the compile, not
     * ship a pool path that resolves to nothing outside this build. */
    const known = work.add("zustand", { "index.d.ts": "export declare const x: number;\n" });
    stage(work.root, [["zustand", known, [["zustand", known]]]], [["zustand", known]], []);
    const resolver = PnpResolver.load(work.root, ["types", "import"])!;
    const emitted = path.join(work.root, "build/index.d.ts");

    expect(rewriteDeclaration(emitted, `export declare const s: import("../.fabr-tree/${known}").x;\n`, resolver)).to.contain(
      'import("zustand")'
    );
    expect(() =>
      rewriteDeclaration(emitted, 'export declare const s: import("../.fabr-tree/nosuchkey/deep").x;\n', resolver)
    ).to.throw(/would ship a path into this build.s tree pool/);
  });

  it("leaves a project that states its own module resolution alone", () => {
    /* The driver SUPPLIES the option; it does not impose it. Overriding would
     * stop this being a drop-in for an ordinary tsconfig — and the proof is a
     * setting the driver would never choose: `node16` resolution against a
     * CommonJS emit, which the compiler answers with TS5110. */
    stage(work.root, [], [], []);
    const config = path.join(work.root, "tsconfig.json");
    const project = JSON.parse(fs.readFileSync(config, "utf8")) as { compilerOptions: Record<string, unknown> };
    project.compilerOptions.moduleResolution = "node16";
    fs.writeFileSync(config, JSON.stringify(project));
    fs.writeFileSync(path.join(work.root, "src/index.ts"), "export const x = 1;\n");

    const { output } = compile(work.root);
    expect(output).to.contain("TS5110");
  });

  it("compiles without a manifest at all, resolving through the filesystem", () => {
    /* The classic layout runs through this same driver: no table, no overrides,
     * ordinary compiler behaviour — which is what keeps one compiler for both. */
    fs.rmSync(path.join(work.root, ".fabr-tree"));
    stage(work.root, [], [], []);
    fs.rmSync(path.join(work.root, ".pnp.data.json"));
    fs.mkdirSync(path.join(work.root, "node_modules/left-pad"), { recursive: true });
    fs.writeFileSync(path.join(work.root, "node_modules/left-pad/package.json"), JSON.stringify({ name: "left-pad", types: "index.d.ts" }));
    fs.writeFileSync(path.join(work.root, "node_modules/left-pad/index.d.ts"), "export declare function pad(text: string): string;\n");
    fs.writeFileSync(path.join(work.root, "src/index.ts"), 'import { pad } from "left-pad";\nexport const padded = pad("x");\n');

    expect(compile(work.root).status).to.equal(0);
  });
});

/**
 * Which module resolution a project gets when it states none. Written against
 * stand-in compilers because the answer turns on the compiler's VERSION, and a
 * repo can only pin one — the branch that matters most is the one for a release
 * this tree does not build against.
 */
describe("resolutionFor", () => {
  const MODULE = { None: 0, CommonJS: 1, AMD: 2, UMD: 3, System: 4, ES2015: 5, ESNext: 99, Node16: 100, Node18: 101, NodeNext: 199, Preserve: 200 };
  const RESOLUTION = { Node10: 2, Node16: 3, NodeNext: 99, Bundler: 100 };
  const compiler = (version: string): Parameters<typeof resolutionFor>[0] =>
    ({ version, ModuleKind: MODULE, ModuleResolutionKind: RESOLUTION } as unknown as Parameters<typeof resolutionFor>[0]);

  it("gives a CommonJS project node10 before TypeScript 6 and bundler from 6", () => {
    /* The one combination the compilers disagree about: before 6, `bundler`
     * may not be paired with a CommonJS emit at all; from 6, `node10` is a
     * deprecation error. Same project, opposite answers. */
    expect(resolutionFor(compiler("5.4.5"), { module: MODULE.CommonJS })).to.equal(RESOLUTION.Node10);
    expect(resolutionFor(compiler("5.9.3"), { module: MODULE.CommonJS })).to.equal(RESOLUTION.Node10);
    expect(resolutionFor(compiler("6.0.3"), { module: MODULE.CommonJS })).to.equal(RESOLUTION.Bundler);
    expect(resolutionFor(compiler("7.0.0"), { module: MODULE.CommonJS })).to.equal(RESOLUTION.Bundler);
  });

  it("gives an ES-module project bundler under every compiler", () => {
    /* No disagreement to work around: `bundler` pairs with an ES emit on both
     * sides of 6, so the version never enters into it. */
    expect(resolutionFor(compiler("5.4.5"), { module: MODULE.ESNext })).to.equal(RESOLUTION.Bundler);
    expect(resolutionFor(compiler("6.0.3"), { module: MODULE.ESNext })).to.equal(RESOLUTION.Bundler);
  });

  it("lets the node* family answer for itself, including kinds added later", () => {
    /* Those emits require the matching resolution — anything else is TS5109 or
     * TS5110 — so the version rule does not apply to them at all. `nodenext`
     * tracks node; every other member of the family pairs with Node16, which is
     * what a `node18` (or a future `node20`) needs. */
    expect(resolutionFor(compiler("5.4.5"), { module: MODULE.Node16 })).to.equal(RESOLUTION.Node16);
    expect(resolutionFor(compiler("5.9.3"), { module: MODULE.Node18 })).to.equal(RESOLUTION.Node16);
    expect(resolutionFor(compiler("6.0.3"), { module: MODULE.NodeNext })).to.equal(RESOLUTION.NodeNext);
  });

  it("gives the legacy module systems node10, which every compiler accepts", () => {
    /* `bundler` pairs only with an ES-module, `preserve` or (from 6) CommonJS
       emit; offering it to these is TS5095, i.e. a compile that fails outright
       where stock tsc succeeds. */
    for (const module of [MODULE.None, MODULE.AMD, MODULE.UMD, MODULE.System]) {
      expect(resolutionFor(compiler("5.4.5"), { module })).to.equal(RESOLUTION.Node10);
      expect(resolutionFor(compiler("6.0.3"), { module })).to.equal(RESOLUTION.Node10);
    }
    /* `preserve` is an ES-module emit for this purpose. */
    expect(resolutionFor(compiler("5.4.5"), { module: MODULE.Preserve })).to.equal(RESOLUTION.Bundler);
  });

  it("treats an unstated module as the CommonJS it may default to", () => {
    /* The conservative branch: node10 is legal under every compiler, so an
     * unknown emit cannot be given a pairing the compiler would reject. */
    expect(resolutionFor(compiler("5.4.5"), {})).to.equal(RESOLUTION.Node10);
    expect(resolutionFor(compiler("6.0.3"), {})).to.equal(RESOLUTION.Bundler);
  });
});

describe("rewriteDeclaration, over every form a declaration can carry a path in", () => {
  /* The emitter SYNTHESIZES only `import("…")`, but a declaration carries paths
   * in written forms too — and `treeReferenceIn` shares this regex, so a form
   * the pattern misses is both unrewritten and unguarded: it ships. */
  let work: IFixture;

  beforeEach(() => {
    work = fixture();
  });

  afterEach(() => {
    fs.rmSync(path.dirname(work.root), { recursive: true, force: true });
  });

  it("rewrites each of them to the package name", () => {
    const zustand = work.add("zustand", { "index.d.ts": "export declare const x: number;\n" });
    stage(work.root, [["zustand", zustand, [["zustand", zustand]]]], [["zustand", zustand]], []);
    const resolver = PnpResolver.load(work.root, ["types", "require"])!;
    const emitted = path.join(work.root, "build/index.d.ts");
    const forms = [
      `export declare const a: import("../.fabr-tree/${zustand}").x;`,
      `export * from "../.fabr-tree/${zustand}";`,
      `declare const b: typeof require("../.fabr-tree/${zustand}");`,
      `/// <reference path="../.fabr-tree/${zustand}" />`,
    ];
    for (const form of forms) {
      expect(rewriteDeclaration(emitted, `${form}\n`, resolver), form).to.contain('"zustand"');
      expect(rewriteDeclaration(emitted, `${form}\n`, resolver), form).to.not.contain(".fabr-tree");
    }
  });
});
