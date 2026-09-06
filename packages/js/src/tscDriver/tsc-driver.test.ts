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
import { toChangeLists, toRunReport } from "../pnp/ReadSet";
import {
  DriverMemo,
  ICompileTelemetry,
  IMemoFile,
  parseDriverMemo,
  planCompile,
  serializeDriverMemo,
  toCompileTelemetry,
} from "./Planning";
import {
  assertDrivableCompiler,
  canonicalizeUnions,
  emittedPathOf,
  emittedSpecifier,
  main,
  relativizeBuildRoot,
  resolutionFor,
  rewriteDeclaration,
} from "./tsc-driver";

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

/**
 * Every fixture this file makes, removed when its test ends. Registered rather
 * than cleaned per caller: a case may make a SECOND fixture mid-test (a
 * downstream consumer resolving what an earlier one emitted), and a helper that
 * makes one has nowhere to put a cleanup of its own.
 */
const fixtures: string[] = [];

afterEach(() => {
  for (const base of fixtures.splice(0)) {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

function fixture(): IFixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-tscdriver-"));
  fixtures.push(base);
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
              [
                [
                  "self",
                  { packageLocation: self.location, packageDependencies: [[self.name, "self"], ...topLevel], linkType: "SOFT" },
                ],
              ],
            ],
          ] as IPnpSerializedState["packageRegistryData"])
        : []),
      ...rows.map(
        ([name, reference, dependencies]): [
          string,
          Array<[string, { packageLocation: string; packageDependencies: Array<[string, PnpDependencyTarget]>; linkType: "HARD" }]>
        ] => [
          name,
          [
            [
              reference,
              {
                packageLocation: `./.fabr-tree/${reference}/`,
                packageDependencies: dependencies,
                linkType: "HARD",
              },
            ],
          ],
        ]
      ),
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
function compile(root: string, argv: string[] = []): { status: number; output: string } {
  const cwd = process.cwd();
  const write = process.stdout.write.bind(process.stdout);
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    process.chdir(root);
    return { status: main(argv), output };
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
      [
        "postprocessing",
        consumer,
        [
          ["postprocessing", consumer],
          ["three", untyped],
        ],
      ],
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
    const declared: Array<[string, PnpDependencyTarget]> = [
      ["three", untyped],
      ["@types/three", sidecar],
    ];
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
        "dist/esm/https.js": "export const marker = 1;\n",
        "dist/cjs/https.js": "module.exports = {};\n",
        "https.d.ts": "export declare const marker: 'the trailing types key';\n",
      },
      { exports: { "./https": { import: "./dist/esm/https.js", require: "./dist/cjs/https.js", types: "./https.d.ts" } } }
    );
    stage(work.root, [["late", late, [["late", late]]]], [["late", late]], []);
    fs.writeFileSync(work.root + "/src/index.ts", 'import { marker } from "late/https";\nexport const which = marker;\n');

    const { status, output } = compile(work.root);
    expect(status, output).to.equal(0);
    expect(fs.readFileSync(path.join(work.root, "build/index.d.ts"), "utf8")).to.contain("the trailing types key");
  });

  it("prefers the declarations beside the format it resolved over a trailing types key", () => {
    /* The same map, but the implementations have their own declarations. Those
     * are this compilation's — the two formats of a dual package need not describe
     * the same shape — so the walk stops at the first key that answers rather
     * than preferring `types` wherever it appears. Reaching for `types` first
     * would hand a CommonJS compile the generic declarations instead. */
    const both = work.add(
      "both",
      {
        "dist/esm/https.js": "export const marker = 1;\n",
        "dist/esm/https.d.ts": "export declare const marker: 'the esm declarations';\n",
        "dist/cjs/https.js": "module.exports = {};\n",
        "dist/cjs/https.d.ts": "export declare const marker: 'the cjs declarations';\n",
        "https.d.ts": "export declare const marker: 'the generic declarations';\n",
      },
      { exports: { "./https": { import: "./dist/esm/https.js", require: "./dist/cjs/https.js", types: "./https.d.ts" } } }
    );
    stage(work.root, [["both", both, [["both", both]]]], [["both", both]], []);
    fs.writeFileSync(work.root + "/src/index.ts", 'import { marker } from "both/https";\nexport const which = marker;\n');

    const { status, output } = compile(work.root);
    expect(status, output).to.equal(0);
    /* The fixture emits CommonJS, so the `require` format's own declarations win. */
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
        "dist/index.mjs": "export const marker = 1;\n",
        "dist/index.cjs": "module.exports = {};\n",
        "dist/index.d.ts": "export declare const marker: 'the single d.ts';\n",
      },
      {
        main: "./dist/index.cjs",
        types: "./dist/index.d.ts",
        exports: { ".": { import: "./dist/index.mjs", require: "./dist/index.cjs" } },
      }
    );
    stage(work.root, [["dual", dual, [["dual", dual]]]], [["dual", dual]], []);
    fs.writeFileSync(work.root + "/src/index.ts", 'import { marker } from "dual";\nexport const which = marker;\n');

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
      { "index.js": "module.exports = {};\n", "index.d.ts": "export declare const marker: 'the legacy entry';\n" },
      { main: "./index.js", types: "./index.d.ts", exports: { "./sub": "./index.js" } }
    );
    stage(work.root, [["closed", closed, [["closed", closed]]]], [["closed", closed]], []);
    fs.writeFileSync(work.root + "/src/index.ts", 'import { marker } from "closed";\nexport const which = marker;\n');

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
      { "esm.js": "export const marker = 1;\n", "esm.d.ts": "export declare const marker: 'the module-sync entry';\n" },
      { type: "module", exports: { ".": { "module-sync": "./esm.js" } } }
    );
    stage(work.root, [["modsync", sync, [["modsync", sync]]]], [["modsync", sync]], []);
    fs.writeFileSync(work.root + "/src/index.ts", 'import { marker } from "modsync";\nexport const which = marker;\n');
    const ran = compile(work.root);
    expect(ran.status, ran.output).to.equal(0);
    expect(fs.readFileSync(path.join(work.root, "build/index.d.ts"), "utf8")).to.contain("the module-sync entry");

    /* And the package that publishes `import` alone says the opposite: node
     * answers ERR_PACKAGE_PATH_NOT_EXPORTED to a require of it, so a CommonJS
     * compilation must not resolve it however plainly its files sit there. */
    const esmOnly = work.add(
      "esmonly",
      { "esm.js": "export const marker = 1;\n", "esm.d.ts": "export declare const marker: 'unreachable';\n" },
      { type: "module", exports: { ".": { import: "./esm.js" } } }
    );
    stage(work.root, [["esmonly", esmOnly, [["esmonly", esmOnly]]]], [["esmonly", esmOnly]], []);
    fs.writeFileSync(work.root + "/src/index.ts", 'import { marker } from "esmonly";\nexport const which = marker;\n');
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
    /* One package, two formats. The fixture emits CommonJS, so the `require`
     * typings are this compilation's — picking the other would type an ESM
     * default import that is not what this project will actually load. */
    const dual = work.add(
      "dual",
      {
        "esm.d.ts": "export declare const marker: 'the esm format';\n",
        "cjs.d.ts": "export declare const marker: 'the cjs format';\n",
      },
      { exports: { ".": { types: { import: "./esm.d.ts", require: "./cjs.d.ts" }, default: "./index.js" } } }
    );
    stage(work.root, [["dual", dual, [["dual", dual]]]], [["dual", dual]], []);
    fs.writeFileSync(work.root + "/src/index.ts", 'import { marker } from "dual";\nexport const which = marker;\n');

    const { status, output } = compile(work.root);
    expect(status, output).to.equal(0);
    expect(fs.readFileSync(path.join(work.root, "build/index.d.ts"), "utf8")).to.contain("the cjs format");
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
    fs.writeFileSync(path.join(work.root, "src/index.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(work.root, "src/util/pad.ts"), "export const pad = (x: string): string => x;\n");
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
          [
            "appcore",
            appcore,
            [
              ["appcore", appcore],
              ["zustand", shared],
            ],
          ],
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

  it("takes the ES-module format when the project emits ES modules", () => {
    /* The mirror of the CommonJS case, and the half a fixture hardcoded to
     * `commonjs` can never reach: the same package, the same map, the other
     * emit, the other format. */
    const dual = work.add(
      "dual",
      {
        "esm.d.ts": "export declare const marker: 'the esm format';\n",
        "cjs.d.ts": "export declare const marker: 'the cjs format';\n",
      },
      { exports: { ".": { types: { import: "./esm.d.ts", require: "./cjs.d.ts" }, default: "./index.js" } } }
    );
    stage(work.root, [["dual", dual, [["dual", dual]]]], [["dual", dual]], [], undefined, "esnext");
    fs.writeFileSync(work.root + "/src/index.ts", 'import { marker } from "dual";\nexport const which = marker;\n');

    const { status, output } = compile(work.root);
    expect(status, output).to.equal(0);
    expect(fs.readFileSync(path.join(work.root, "build/index.d.ts"), "utf8")).to.contain("the esm format");
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
    const closed = work.add(
      "closed",
      { "index.js": "module.exports = {};\n", "sub.js": "module.exports = {};\n" },
      { exports: { ".": "./index.js" } }
    );
    const sidecar = work.add("@types/closed", { "sub.d.ts": "export declare const marker: 'from the sidecar';\n" });
    stage(
      work.root,
      [
        ["closed", closed, [["closed", closed]]],
        ["@types/closed", sidecar, [["@types/closed", sidecar]]],
      ],
      [
        ["closed", closed],
        ["@types/closed", sidecar],
      ],
      []
    );
    fs.writeFileSync(work.root + "/src/index.ts", 'import { marker } from "closed/sub";\nexport const which = marker;\n');

    const { status, output } = compile(work.root);
    expect(status).to.not.equal(0);
    expect(output).to.contain("Cannot find module 'closed/sub'");
  });

  it("reports an unreadable dependency manifest without losing the other diagnostics", () => {
    /* One package's mistake is not the compilation's: the import that touched it
     * fails where it is written, every other diagnostic still arrives, and the
     * reason is stated once. */
    const broken = work.add(
      "broken",
      { "index.js": "module.exports = {};\n" },
      { exports: { ".": "./index.js", import: "./esm.js" } }
    );
    stage(work.root, [["broken", broken, [["broken", broken]]]], [["broken", broken]], []);
    fs.writeFileSync(
      work.root + "/src/index.ts",
      'import { marker } from "broken";\nexport const which: number = marker;\nexport const other: number = "not a number";\n'
    );

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
    const one = work.add("dep", { "index.d.ts": "export declare const marker: 'version one';\n" }, { version: "1.0.0" });
    const two = work.add("dep", { "index.d.ts": "export declare const marker: 'version two';\n" }, { version: "2.0.0" });
    const left = work.add("left", { "index.d.ts": 'export { marker as leftMarker } from "dep";\n' });
    const right = work.add("right", { "index.d.ts": 'export { marker as rightMarker } from "dep";\n' });
    stage(
      work.root,
      [
        [
          "left",
          left,
          [
            ["left", left],
            ["dep", one],
          ],
        ],
        [
          "right",
          right,
          [
            ["right", right],
            ["dep", two],
          ],
        ],
        ["dep", one, [["dep", one]]],
        ["dep", two, [["dep", two]]],
      ],
      [
        ["left", left],
        ["right", right],
      ],
      []
    );
    fs.writeFileSync(
      work.root + "/src/index.ts",
      'import { leftMarker } from "left";\nimport { rightMarker } from "right";\nexport const both = [leftMarker, rightMarker];\n'
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

    expect(
      rewriteDeclaration(emitted, `export declare const s: import("../.fabr-tree/${modern}/dist/client/index.d.ts").x;\n`, resolver)
    ).to.contain('import("modern/client")');
    /* A file the map publishes no name for still leaves the pool — it is named
     * by path, which is the honest answer and not a tree reference. */
    expect(
      rewriteDeclaration(emitted, `export declare const s: import("../.fabr-tree/${modern}/dist/internal.d.ts").y;\n`, resolver)
    ).to.contain('import("modern/dist/internal.d.ts")');
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
    fs.writeFileSync(
      path.join(work.root, "node_modules/left-pad/package.json"),
      JSON.stringify({ name: "left-pad", types: "index.d.ts" })
    );
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
  const MODULE = {
    None: 0,
    CommonJS: 1,
    AMD: 2,
    UMD: 3,
    System: 4,
    ES2015: 5,
    ESNext: 99,
    Node16: 100,
    Node18: 101,
    NodeNext: 199,
    Preserve: 200,
  };
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

describe("emitted output, over where the compile ran", () => {
  /* The automatic JSX runtime's dev variant is the emit that carries a source
   * path into shipped code (`_jsxFileName`), so it is what these compile. The
   * runtime is a fixture package because the emitted import has to resolve —
   * what is under test is the path in the output, not React. */
  const JSX_RUNTIME = {
    "jsx-dev-runtime.d.ts":
      "export declare const jsxDEV: any;\n" +
      "export declare const Fragment: any;\n" +
      "export declare namespace JSX {\n" +
      "  interface Element {}\n" +
      "  interface IntrinsicElements {\n" +
      "    [name: string]: any;\n" +
      "  }\n" +
      "}\n",
    "jsx-dev-runtime.js": "exports.jsxDEV = () => undefined;\nexports.Fragment = undefined;\n",
  };

  /** Compile one `.tsx` under the dev JSX runtime and answer what was emitted. */
  function compileJsx(source: string): { root: string; emitted: string; status: number; output: string } {
    const work = fixture();
    const runtime = work.add("myjsx", JSX_RUNTIME);
    stage(work.root, [["myjsx", runtime, []]], [["myjsx", runtime]], []);
    /* The staged project, plus the jsx options: everything else about it is
     * what every other case here compiles under. */
    const configPath = path.join(work.root, "tsconfig.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.compilerOptions.jsx = "react-jsxdev";
    config.compilerOptions.jsxImportSource = "myjsx";
    config.include = ["./src/**/*.tsx"];
    fs.writeFileSync(configPath, JSON.stringify(config));
    fs.writeFileSync(path.join(work.root, "src", "App.tsx"), source);
    const { status, output } = compile(work.root);
    return { root: work.root, status, output, emitted: fs.readFileSync(path.join(work.root, "build/App.js"), "utf8") };
  }

  const SOURCE = 'export const App = (): unknown => <div className="x">hi</div>;\n';

  it("names the source relative to the project, never by the directory the compile ran in", () => {
    const { root, emitted, status, output } = compileJsx(SOURCE);
    expect(status, output).to.equal(0);
    /* Without this the case would pass on an emit that carries no path at all,
     * proving nothing. */
    expect(emitted).to.contain("_jsxFileName");
    expect(emitted).to.contain("src/App.tsx");
    expect(emitted).to.not.contain(root);
  });

  it("emits the same bytes for the same source compiled in different directories", () => {
    const first = compileJsx(SOURCE);
    const second = compileJsx(SOURCE);
    expect(first.root).to.not.equal(second.root);
    expect(first.emitted).to.equal(second.emitted);
  });
});

/* `--emit-extension .mjs`: what the ES-module format of a dual package is built
 * with, so its tree ships beside the CommonJS format's instead of occupying the
 * same names. The rename has to happen inside the compile, because the
 * specifiers the emitter writes must name the renamed siblings. */
describe("emitting under a renamed extension", () => {
  /** Compile an ES-module project holding `sources` under `--emit-extension
   *  .mjs`, with source maps on, and answer what landed in `build/`. */
  function compileRenamed(sources: Record<string, string>): {
    status: number;
    output: string;
    emitted: string[];
    read: (name: string) => string;
  } {
    const work = fixture();
    stage(work.root, [], [], [], undefined, "esnext");
    const configPath = path.join(work.root, "tsconfig.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.compilerOptions.sourceMap = true;
    config.include = ["./src/**/*.ts", "./src/**/*.mts", "./src/**/*.cts"];
    fs.writeFileSync(configPath, JSON.stringify(config));
    for (const [name, text] of Object.entries(sources)) {
      fs.writeFileSync(path.join(work.root, "src", name), text);
    }
    const { status, output } = compile(work.root, ["--emit-extension", ".mjs"]);
    const build = path.join(work.root, "build");
    return {
      status,
      output,
      emitted: fs.existsSync(build) ? fs.readdirSync(build).sort() : [],
      read: name => fs.readFileSync(path.join(build, name), "utf8"),
    };
  }

  it("renames the JavaScript, its declaration and its map, and repoints the specifiers", () => {
    /* A type crosses the boundary as well as a value, so the specifier has to
     * survive into the declaration too and both emitters can be checked. */
    const { status, output, emitted, read } = compileRenamed({
      "util.ts": "export interface Answer {\n  value: number;\n}\nexport const answer: Answer = { value: 42 };\n",
      "index.ts": "import { answer, Answer } from './util';\nexport const value: Answer = answer;\n",
    });
    expect(status, output).to.equal(0);
    expect(emitted).to.deep.equal(["index.d.mts", "index.mjs", "index.mjs.map", "util.d.mts", "util.mjs", "util.mjs.map"]);
    /* The specifier names the file that was actually emitted — extensionless
     * would not load under node's ES-module resolver, and `./util.js` names
     * the OTHER format's file, which is a second copy of the same module. */
    expect(read("index.mjs")).to.contain('from "./util.mjs"');
    expect(read("index.d.mts")).to.contain('"./util.mjs"');
  });

  it("repoints a renamed file's own source map references", () => {
    const { status, output, read } = compileRenamed({ "index.ts": "export const value = 1;\n" });
    expect(status, output).to.equal(0);
    /* Both halves of the link, or a debugger cannot pair the two: the comment
     * naming the map, and the map's own claim about which file it describes. */
    expect(read("index.mjs")).to.contain("//# sourceMappingURL=index.mjs.map");
    expect(read("index.mjs")).to.not.contain("index.js.map");
    expect(JSON.parse(read("index.mjs.map")).file).to.equal("index.mjs");
  });

  it("leaves a source that pinned its own module format alone", () => {
    /* `.mts`/`.cts` name their format themselves, so the rename must not move
     * them: it applies to the `.js` whose format is the COMPILE's to decide. */
    const { status, output, emitted } = compileRenamed({
      "index.ts": "export const value = 1;\n",
      "legacy.cts": "export const old = 1;\n",
      "modern.mts": "export const now = 1;\n",
    });
    expect(status, output).to.equal(0);
    expect(emitted).to.contain("legacy.cjs");
    expect(emitted).to.contain("legacy.d.cts");
    expect(emitted).to.contain("modern.mjs");
    expect(emitted).to.contain("index.mjs");
  });

  it("accepts only the extension it can emit correctly", () => {
    /* `.cjs` would need the CommonJS emit's specifiers rewritten too, which this
     * driver does not do — so it is refused rather than silently mis-emitted. */
    const work = fixture();
    stage(work.root, [], [], [], undefined, "esnext");
    fs.writeFileSync(path.join(work.root, "src", "index.ts"), "export const value = 1;\n");
    expect(() => compile(work.root, ["--emit-extension", ".cjs"])).to.throw(/accepts '\.mjs'/);
  });

  it("refuses to rename a CommonJS emit, whose specifiers it does not rewrite", () => {
    /* The same failure the `.cjs` rejection guards against, reached from the
     * other side: renaming a CommonJS emit to `.mjs` would ship CommonJS syntax
     * under a name node reads as an ES module, its extensionless `require`s
     * naming files that are not there. Reachable because js_compile's
     * `module_extension` is a declared property. */
    const work = fixture();
    stage(work.root, [], [], [], undefined, "commonjs");
    fs.writeFileSync(path.join(work.root, "src", "index.ts"), "export const value = 1;\n");
    expect(() => compile(work.root, ["--emit-extension", ".mjs"])).to.throw(/needs an ES-module emit/);
  });
});

describe("relativizeBuildRoot", () => {
  it("leaves text naming nothing under the root untouched", () => {
    const text = 'const a = "/elsewhere/src/App.tsx";\n';
    expect(relativizeBuildRoot(text, "/build/root")).to.equal(text);
  });

  it("takes the root however it is spelled, and every occurrence", () => {
    const text = 'a("/build/root/src/a.tsx"); b("/build/root/src/b.tsx");';
    const expected = 'a("src/a.tsx"); b("src/b.tsx");';
    expect(relativizeBuildRoot(text, "/build/root")).to.equal(expected);
    expect(relativizeBuildRoot(text, "/build/root/")).to.equal(expected);
  });
});

describe("canonicalizeUnions", () => {
  /* The real compiler, since the whole pass is a parse: the driver's own
   * `typescript` is what it will run against. */
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ts = require("typescript");
  const canonical = (text: string): string => canonicalizeUnions(ts, "a.d.ts", text);

  it("leaves a declaration holding no union exactly as it was", () => {
    const text = "export declare const value: number;\n";
    expect(canonical(text)).to.equal(text);
  });

  it("puts a union's members in one order however they arrived", () => {
    const orders = [
      'export declare const mode: "strict" | "off" | "moderate";\n',
      'export declare const mode: "off" | "moderate" | "strict";\n',
      'export declare const mode: "moderate" | "strict" | "off";\n',
    ];
    const answers = new Set(orders.map(canonical));
    expect([...answers], "every permutation lands on the same text").to.have.length(1);
    expect([...answers][0]).to.equal('export declare const mode: "moderate" | "off" | "strict";\n');
  });

  it("orders a nested union by what the inner one canonicalizes to", () => {
    /* The outer sort keys on the members' CANONICAL text, so it cannot depend on
     * the order the inner union happened to be printed in. */
    const written = 'export declare const held: ("z" | "a")[] | "m";\n';
    const other = 'export declare const held: ("a" | "z")[] | "m";\n';
    expect(canonical(written)).to.equal(canonical(other));
    expect(canonical(written)).to.equal('export declare const held: "m" | ("a" | "z")[];\n');
  });

  it("moves the members and not the layout around them", () => {
    /* Splicing spans rather than reprinting: every separator, line break and
     * indent stays where the compiler put it. */
    const text = ["export declare const held: {", "    b: 2;", "} | {", "    a: 1;", "};", ""].join("\n");
    expect(canonical(text)).to.equal(["export declare const held: {", "    a: 1;", "} | {", "    b: 2;", "};", ""].join("\n"));
  });

  it("canonicalizes a union the author wrote, like any other", () => {
    /* A `.d.ts` is a generated artifact, and a consumer's compiler re-sorts
     * every union by its own type ids on load, so the written order reaches
     * nobody as meaning. */
    expect(canonical('export type Mode = "b" | "a";\n')).to.equal('export type Mode = "a" | "b";\n');
  });

  it("sorts a type literal's members by name", () => {
    const text = ["export declare const held: {", "    b: number;", "    a: string;", "};", ""].join("\n");
    expect(canonical(text)).to.equal(["export declare const held: {", "    a: string;", "    b: number;", "};", ""].join("\n"));
  });

  it("leaves an interface exactly as it was written", () => {
    /* The boundary of the pass: inference never synthesizes an `interface`, so
     * one is always authored, always round-trips in written order, and is
     * already deterministic — there is nothing to canonicalize. */
    const text = ["export interface Held {", "    b: number;", "    a: string;", "}", ""].join("\n");
    expect(canonical(text)).to.equal(text);
  });

  it("leaves a class's members exactly as they were written", () => {
    const text = ["export declare class Held {", "    b: number;", "    a: string;", "}", ""].join("\n");
    expect(canonical(text)).to.equal(text);
  });

  it("sorts an authored type-literal alias too, which is the cost of the boundary", () => {
    /* The other side of that boundary: a type literal's member order carries
     * the least meaning of any construct, and an interface is where a project
     * that cares about order keeps it. */
    expect(canonical("export type Held = { b: number; a: string; };\n")).to.equal("export type Held = { a: string; b: number; };\n");
  });

  it("never moves a member that has no name", () => {
    /* Overload resolution reads call signatures in order, so permuting them
     * would change meaning rather than bytes. The named members sort among the
     * slots they already occupy; the signatures keep their index exactly. */
    const text = [
      "export declare const held: {",
      "    (a: string): void;",
      "    z: number;",
      "    [key: string]: unknown;",
      "    a: number;",
      "};",
      "",
    ].join("\n");
    expect(canonical(text)).to.equal(
      [
        "export declare const held: {",
        "    (a: string): void;",
        "    a: number;",
        "    [key: string]: unknown;",
        "    z: number;",
        "};",
        "",
      ].join("\n")
    );
  });

  it("carries a member's own doc comment along with it", () => {
    const text = ["export declare const held: {", "    /** b. */", "    b: number;", "    /** a. */", "    a: string;", "};", ""].join(
      "\n"
    );
    expect(canonical(text)).to.equal(
      ["export declare const held: {", "    /** a. */", "    a: string;", "    /** b. */", "    b: number;", "};", ""].join("\n")
    );
  });

  it("canonicalizes a literal nested in a union nested in a literal", () => {
    const text = [
      "export declare const held: {",
      "    outer: {",
      "        d: 1;",
      "        c: 2;",
      '    } | "z" | "y";',
      "    inner: number;",
      "};",
      "",
    ].join("\n");
    expect(canonical(text)).to.equal(
      [
        "export declare const held: {",
        "    inner: number;",
        '    outer: "y" | "z" | {',
        "        c: 2;",
        "        d: 1;",
        "    };",
        "};",
        "",
      ].join("\n")
    );
  });

  it("keeps a `|` that is not a union out of it", () => {
    const text = "export declare const mask: number;\n";
    expect(canonical(`${text}export declare function or(a: number): number;\n`)).to.equal(
      `${text}export declare function or(a: number): number;\n`
    );
  });
});

describe("emittedPathOf", () => {
  const layout = { rootDir: "/work/src", outDir: "/work/build", preserveJsx: false };

  it("re-roots a source into the output directory under its runtime extension", () => {
    expect(emittedPathOf("/work/src/a/b.ts", layout)).to.equal("/work/build/a/b.js");
    expect(emittedPathOf("/work/src/b.tsx", layout)).to.equal("/work/build/b.js");
    expect(emittedPathOf("/work/src/b.mts", layout)).to.equal("/work/build/b.mjs");
    expect(emittedPathOf("/work/src/b.cts", layout)).to.equal("/work/build/b.cjs");
  });

  it("keeps a .tsx extension where the project preserves JSX", () => {
    expect(emittedPathOf("/work/src/b.tsx", { ...layout, preserveJsx: true })).to.equal("/work/build/b.jsx");
    /* Only the JSX extension is affected — a .ts still emits JavaScript. */
    expect(emittedPathOf("/work/src/b.ts", { ...layout, preserveJsx: true })).to.equal("/work/build/b.js");
  });

  it("emits beside the source when the project has no outDir", () => {
    expect(emittedPathOf("/work/src/b.ts", { preserveJsx: false })).to.equal("/work/src/b.js");
  });

  it("names nothing for a source this compile does not emit", () => {
    /* A declaration emits no JavaScript at all... */
    expect(emittedPathOf("/work/src/b.d.ts", layout)).to.equal(undefined);
    /* ...an unknown extension is another producer's artifact... */
    expect(emittedPathOf("/work/src/b.scss", layout)).to.equal(undefined);
    /* ...and a source outside the root is a dependency, named by a package. */
    expect(emittedPathOf("/elsewhere/b.ts", layout)).to.equal(undefined);
    /* An outDir with no rootDir leaves the mapping under-determined. */
    expect(emittedPathOf("/work/src/b.ts", { outDir: "/work/build", preserveJsx: false })).to.equal(undefined);
  });
});

describe("emittedSpecifier", () => {
  it("names a sibling relatively, and says so explicitly", () => {
    expect(emittedSpecifier("/build", "/build/bar.js")).to.equal("./bar.js");
    expect(emittedSpecifier("/build", "/build/dir/index.js")).to.equal("./dir/index.js");
  });

  it("climbs where the target is above the importer", () => {
    expect(emittedSpecifier("/build/deep", "/build/bar.js")).to.equal("../bar.js");
  });
});

describe("ES-module specifier rewriting", () => {
  /** Stage a project emitting `module` over a fixed set of sources, compile it,
   * and answer what was emitted. */
  function compileModules(module: string): { status: number; output: string; js: string; declaration: string } {
    const work = fixture();
    stage(work.root, [], [], [], undefined, module);
    const src = path.join(work.root, "src");
    fs.mkdirSync(path.join(src, "dir"), { recursive: true });
    fs.writeFileSync(path.join(src, "bar.ts"), "export const b = 1;\n");
    fs.writeFileSync(path.join(src, "dir", "index.ts"), "export const d = 2;\n");
    fs.writeFileSync(path.join(src, "side.ts"), "export {};\n");
    fs.writeFileSync(path.join(src, "types.ts"), "export type X = string;\n");
    /* `make`'s return type is never imported by name, so the declaration for
     * anything inferred from it can only be written as an import type. */
    fs.writeFileSync(
      path.join(src, "shape.ts"),
      "export interface Shape {\n  n: number;\n}\nexport const make = (): Shape => ({ n: 1 });\n"
    );
    fs.writeFileSync(
      path.join(src, "foo.ts"),
      'import { b } from "./bar";\n' +
        'import { make } from "./shape";\n' +
        'export * from "./dir";\n' +
        'export type { X } from "./types";\n' +
        'import "./side";\n' +
        'const lazy = (): Promise<unknown> => import("./bar.js");\n' +
        "export const code = 'import { b } from \"./bar\";';\n" +
        "export const thing = make();\n" +
        "export const v = b + lazy.length;\n"
    );
    const { status, output } = compile(work.root);
    return {
      status,
      output,
      js: fs.readFileSync(path.join(work.root, "build/foo.js"), "utf8"),
      declaration: fs.readFileSync(path.join(work.root, "build/foo.d.ts"), "utf8"),
    };
  }

  it("names the emitted file, so node's ESM loader can resolve what tsc wrote", () => {
    const { status, output, js } = compileModules("esnext");
    expect(status, output).to.equal(0);
    expect(js).to.contain('from "./bar.js"');
    /* A directory resolves to its index — the case an extension append gets
     * wrong, and the reason this is driven by resolution. */
    expect(js).to.contain('from "./dir/index.js"');
    /* A side-effect import carries no binding but still has to load. */
    expect(js).to.contain('import "./side.js"');
    expect(js).to.contain('import("./bar.js")');
  });

  it("leaves a specifier that already names the emitted file alone", () => {
    /* The source writes `./bar.js`, which resolves to bar.ts and emits as
     * bar.js: the rewrite is idempotent across both authoring styles. */
    const { js } = compileModules("esnext");
    expect(js).to.not.contain('import("./bar.js.js")');
  });

  it("rewrites a string constant holding import syntax not at all", () => {
    /* The hazard a pass over the emitted text cannot avoid: this is a value, not
     * an import, and changing it would change what the program computes. */
    const { js } = compileModules("esnext");
    expect(js).to.contain("const code = 'import { b } from \"./bar\";'");
  });

  it("corrects the declarations beside the JavaScript", () => {
    const { declaration } = compileModules("esnext");
    expect(declaration).to.contain('from "./types.js"');
    expect(declaration).to.contain('from "./dir/index.js"');
  });

  it("corrects the import types the declaration emitter writes for itself", () => {
    /* Extensionless, this is TS2834 for a consumer resolving node16/nodenext —
     * and under the skipLibCheck such a consumer almost certainly sets, the
     * error is suppressed and the type quietly becomes `any`. */
    const { declaration } = compileModules("esnext");
    expect(declaration).to.contain('import("./shape.js").Shape');
  });

  it("leaves a CommonJS emit as written", () => {
    /* CommonJS resolves an extensionless specifier itself, so there is nothing
     * to correct and nothing fabr should be changing. */
    const { status, output, js } = compileModules("commonjs");
    expect(status, output).to.equal(0);
    expect(js).to.contain('require("./bar")');
    expect(js).to.contain('require("./dir")');
  });
});

/**
 * What the run reports having READ, which is what its cache entry is keyed on
 * (see DESIGN-discovered-deps.md). The names are logical — `<package>/<path>`,
 * no version, no store path — so the step can narrow the same pool against them
 * on a later build.
 */
describe("the tsc driver's dependency report", () => {
  let work: IFixture;

  beforeEach(() => {
    work = fixture();
  });

  /** Compile with a report asked for, and answer what it says was read. */
  function reads(argv: string[] = []): string[] {
    const { status, output } = compile(work.root, ["--deps-report", ".fabr-deps.json", ...argv]);
    expect(status, output).to.equal(0);
    return (JSON.parse(fs.readFileSync(path.join(work.root, ".fabr-deps.json"), "utf8")) as { reads: string[] }).reads;
  }

  it("names the dependency files it read, and leaves out the ones it did not", () => {
    const used = work.add("used", { "index.d.ts": "export declare const value: number;\n" });
    const unused = work.add("unused", { "index.d.ts": "export declare const other: number;\n" });
    stage(
      work.root,
      [
        ["used", used, [["used", used]]],
        ["unused", unused, [["unused", unused]]],
      ],
      [
        ["used", used],
        ["unused", unused],
      ],
      []
    );
    fs.writeFileSync(path.join(work.root, "src/index.ts"), 'import { value } from "used";\nexport const doubled = value * 2;\n');

    const read = reads();
    /* The declaration it opened, under its path name — the route the lookup
     * took, not the content-addressed directory it sits in. */
    expect(read).to.contain("used index.d.ts");
    /* And the manifest resolution consulted to decide that: tsc reads it and
     * `--listFiles` never mentions it, so an `exports` edit would otherwise
     * move the answer with nothing in the key to say so. */
    expect(read).to.contain("used package.json");
    /* Nothing of the package it never opened — the whole point. */
    expect(read.filter(name => name.startsWith("unused "))).to.deep.equal([]);
    /* And nothing outside the discoverable deps: the sources and the compiler's
     * own libs are in the step's anchor, not among them. */
    expect(read.filter(name => name.includes("src/index.ts"))).to.deep.equal([]);
  });

  it("names a dependency's own lookups when the dependency resolved through it", () => {
    const inner = work.add("inner", { "index.d.ts": "export declare const value: number;\n" });
    const outer = work.add("outer", {
      "index.d.ts": 'import { value } from "inner";\nexport declare const doubled: typeof value;\n',
    });
    stage(
      work.root,
      [
        [
          "outer",
          outer,
          [
            ["outer", outer],
            ["inner", inner],
          ],
        ],
        ["inner", inner, [["inner", inner]]],
      ],
      [["outer", outer]],
      []
    );
    fs.writeFileSync(path.join(work.root, "src/index.ts"), 'import { doubled } from "outer";\nexport const value = doubled;\n');

    const read = reads();
    /* `outer`'s typings resolved `inner`, so that lookup is an edge row of its
     * own — and both packages' files were read, `inner`'s under the route it
     * was reached by. */
    expect(read).to.contain("outer inner package.json");
    expect(read).to.contain("outer index.d.ts");
    expect(read).to.contain("outer inner index.d.ts");
  });

  it("states a fallback resolution as two rows: the failing access path and the answer at its route", () => {
    /* The phantom-import case: `postprocessing` needs typings it never
     * declared, and the pool answers with an instance nothing at the top
     * level binds. The access path finds nothing (the requirer binds no such
     * name), and the answer is pinned at the winner's own canonical route —
     * a plain-indexing path, so a different answer moves the key with no pool
     * rule anywhere in replay. */
    const sidecar = work.add("@types/three", { "index.d.ts": "export declare class Widget { spin(): void }\n" });
    const untyped = work.add("three", { "index.js": "module.exports = {};\n" });
    const carrier = work.add("carrier", {
      "index.d.ts": 'import { Widget } from "@types/three";\nexport declare const held: Widget;\n',
    });
    const phantom = work.add("postprocessing", {
      "index.d.ts": 'import { Widget } from "three";\nexport declare function make(): Widget;\n',
    });
    stage(
      work.root,
      [
        /* postprocessing declares `three` and NOT its types, so the sidecar can
         * only come from the pool — where it sits as a transitive, reachable
         * only through `carrier`. */
        [
          "postprocessing",
          phantom,
          [
            ["postprocessing", phantom],
            ["three", untyped],
          ],
        ],
        ["three", untyped, [["three", untyped]]],
        [
          "carrier",
          carrier,
          [
            ["carrier", carrier],
            ["@types/three", sidecar],
          ],
        ],
        ["@types/three", sidecar, [["@types/three", sidecar]]],
      ],
      [
        ["postprocessing", phantom],
        ["three", untyped],
        ["carrier", carrier],
      ],
      [["@types/three", sidecar]]
    );
    fs.writeFileSync(
      path.join(work.root, "src/index.ts"),
      'import { make } from "postprocessing";\nexport const spun = (): void => make().spin();\n'
    );
    const read = reads();
    expect(read, "the access path, which found nothing").to.contain("postprocessing @types/three package.json");
    expect(read, "and the answer, at the winner's canonical route").to.contain("carrier @types/three package.json");
  });

  it("names a read of a coexisting version by the route that reached it", () => {
    /* Two versions of one package coexist. The path name carries the route the
     * lookup took, so a read of either is named for the exact node it came
     * from — which is the whole reason a bare `<package>/<path>` naming could
     * not hold this closure. */
    const hoisted = work.add("dup", { "index.d.ts": "export declare const value: number;\n" });
    const inner = work.add("inner", { "index.d.ts": "export declare const seed: string;\n" });
    /* The nested one resolves a name of its own, so its row is consulted as an
     * ISSUER — which is what puts its surface in the read set. */
    const nested = work.add("dup", {
      "index.d.ts": 'import { seed } from "inner";\nexport declare const value: typeof seed;\n',
    });
    const requirer = work.add("requirer", {
      "index.d.ts": 'import { value } from "dup";\nexport declare const held: typeof value;\n',
    });
    stage(
      work.root,
      [
        ["dup", hoisted, [["dup", hoisted]]],
        /* The nested delivery, its own instance under its own reference. */
        [
          "dup",
          nested,
          [
            ["dup", nested],
            ["inner", inner],
          ],
        ],
        ["inner", inner, [["inner", inner]]],
        [
          "requirer",
          requirer,
          [
            ["requirer", requirer],
            ["dup", nested],
          ],
        ],
      ],
      [
        ["dup", hoisted],
        ["requirer", requirer],
      ],
      []
    );
    fs.writeFileSync(
      path.join(work.root, "src/index.ts"),
      'import { held } from "requirer";\nimport { value } from "dup";\nexport const both = [held, value] as const;\n'
    );

    const read = reads();
    expect(read, "the hoisted one, read directly").to.contain("dup index.d.ts");
    expect(read, "and the nested one, read through its requirer").to.contain("requirer dup index.d.ts");
  });

  it("pins every requirer's binding of a shared package, not only the route that names its files", () => {
    /* `shared` is bound by both `left` and `right`, and its files are named by
     * ONE canonical route. Without a row per edge, the other requirer's binding
     * could rebind alone — a fork serving `right` a different `shared` while
     * `left` keeps its own — with nothing in the key to say so. */
    const shared = work.add("shared", { "index.d.ts": "export declare const value: number;\n" });
    const left = work.add("left", {
      "index.d.ts": 'import { value } from "shared";\nexport declare const l: typeof value;\n',
    });
    const right = work.add("right", {
      "index.d.ts": 'import { value } from "shared";\nexport declare const r: typeof value;\n',
    });
    stage(
      work.root,
      [
        [
          "left",
          left,
          [
            ["left", left],
            ["shared", shared],
          ],
        ],
        [
          "right",
          right,
          [
            ["right", right],
            ["shared", shared],
          ],
        ],
        ["shared", shared, [["shared", shared]]],
      ],
      [
        ["left", left],
        ["right", right],
      ],
      []
    );
    fs.writeFileSync(
      path.join(work.root, "src/index.ts"),
      'import { l } from "left";\nimport { r } from "right";\nexport const both = [l, r] as const;\n'
    );

    const read = reads();
    expect(read, "the files, under their one canonical route").to.contain("left shared index.d.ts");
    expect(read, "the canonical requirer's binding").to.contain("left shared package.json");
    expect(read, "the other requirer's binding, which no file row carries").to.contain("right shared package.json");
  });

  it("encodes a space in a read file's name, keeping the flat spelling exact", () => {
    /* A space is the flat spelling's separator (joinDepsPath), so a file whose
     * own name holds one must ride encoded — a raw join would shear it into a
     * bogus two-part path at the step's split, recording a permanent absence
     * and silently dropping the file from the key. */
    const spacey = work.add("spacey", {
      "index.d.ts": 'import "./read me";\nexport declare const value: number;\n',
      "read me.d.ts": "export {};\n",
    });
    stage(work.root, [["spacey", spacey, [["spacey", spacey]]]], [["spacey", spacey]], []);
    fs.writeFileSync(path.join(work.root, "src/index.ts"), 'import { value } from "spacey";\nexport const held = value;\n');
    expect(reads()).to.contain("spacey read%20me.d.ts");
  });

  it("writes nothing unless a report is asked for", () => {
    stage(work.root, [], [], []);
    fs.writeFileSync(path.join(work.root, "src/index.ts"), "export const value = 1;\n");
    const { status, output } = compile(work.root);
    expect(status, output).to.equal(0);
    expect(fs.existsSync(path.join(work.root, ".fabr-deps.json"))).to.equal(false);
  });
});

/**
 * The frontier wave: given the driver's own memo of the last green build and
 * the names whose bytes moved, check and emit only what the change reaches.
 * Each scenario is a shape the naive "re-check the direct referencers" answer
 * gets wrong.
 */
describe("the tsc driver's wave", () => {
  let work: IFixture;

  beforeEach(() => {
    work = fixture();
  });

  /** Write the fixture's sources, replacing whatever was there. */
  function sources(files: Record<string, string>): void {
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(work.root, "src", name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
  }

  function remove(name: string): void {
    fs.rmSync(path.join(work.root, "src", name));
  }

  /** Every project file, as the wave names them. */
  function projectFiles(): string[] {
    const walk = (dir: string): string[] =>
      fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap(entry => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
    return walk(path.join(work.root, "src")).map(file => path.relative(work.root, file).split(path.sep).join("/"));
  }

  interface IWaveOutcome {
    status: number;
    output: string;
    /** The run's own account of itself. */
    compile: ICompileTelemetry;
    /** The memo the run asked its caller to carry — the next run's base. */
    memo: DriverMemo;
  }

  /** The directory the driver keeps its state in, as fabr names it, and the
   * driver's own memo within it — which fabr never looks at, so these tests
   * play fabr's half by hand. */
  const STATE_DIR = ".fabr-state";
  const STATE_MEMO = "memo";

  /** Put state where a previous run would have left it — the staging fabr does
   * out of the record. */
  function stageState(memo: string): void {
    fs.mkdirSync(path.join(work.root, STATE_DIR), { recursive: true });
    fs.writeFileSync(path.join(work.root, STATE_DIR, STATE_MEMO), memo);
  }

  /** What an incremental run reported: its telemetry, and the memo it left. */
  function outcomeOf(run: { status: number; output: string }): IWaveOutcome {
    const document = JSON.parse(fs.readFileSync(path.join(work.root, ".fabr-deps.json"), "utf8")) as unknown;
    const compiled = toCompileTelemetry(document);
    expect(compiled, "an incremental run reports its account").to.not.equal(undefined);
    const left = path.join(work.root, STATE_DIR, STATE_MEMO);
    expect(fs.existsSync(left), "and leaves the memo it wants carried in the state directory").to.equal(true);
    const memo = parseDriverMemo(fs.readFileSync(left, "utf8"));
    expect(memo, "which parses as this driver's own format").to.not.equal(undefined);
    return { status: run.status, output: run.output, compile: compiled!, memo: memo! };
  }

  /** Compile against a base — the memo staged back into the state directory,
   * and fabr's diff as the two name lists — and answer what the run reported. */
  function wave(memo: DriverMemo, changed: string[], deleted: string[] = [], argv: string[] = []): IWaveOutcome {
    stageState(serializeDriverMemo(memo));
    fs.writeFileSync(path.join(work.root, ".fabr-changes.json"), JSON.stringify({ changed, deleted }));
    return outcomeOf(
      compile(work.root, [
        "--state-dir",
        STATE_DIR,
        "--changes",
        ".fabr-changes.json",
        "--deps-report",
        ".fabr-deps.json",
        ...argv,
      ])
    );
  }

  /** The cold build: no base, so the driver compiles everything — which is
   * exactly what a target key with no record does, and what gives the next
   * run its base. */
  function baseline(argv: string[] = []): IWaveOutcome {
    fs.rmSync(path.join(work.root, STATE_DIR), { recursive: true, force: true });
    return outcomeOf(compile(work.root, ["--state-dir", STATE_DIR, "--deps-report", ".fabr-deps.json", ...argv]));
  }

  /** What is in the output directory, and what it holds. */
  function output(name: string): string {
    return fs.readFileSync(path.join(work.root, "build", name), "utf8");
  }

  /** The specifiers of one kind of edge, for a file of a run's memo. */
  function edgeSpecifiers(memo: DriverMemo, name: string, kind: "use" | "forwarding"): string[] {
    return (memo.get(name)?.[kind] ?? []).map(edge => edge.specifier).sort();
  }

  /** An empty manifest, so the fixture's own resolver exists (a compile without
   * one resolves through the filesystem and records no edges). */
  function stageProject(module = "commonjs"): void {
    stage(work.root, [], [], [], undefined, module);
  }

  it("emits one file for a body edit, and leaves the rest of the output alone", () => {
    stageProject();
    sources({
      "util.ts": "export function pad(text: string): string {\n  return text;\n}\n",
      "index.ts": 'import { pad } from "./util";\nexport const padded = pad("x");\n',
    });
    const base = baseline();
    expect(base.status, base.output).to.equal(0);
    const untouched = output("util.js");

    sources({ "index.ts": 'import { pad } from "./util";\nexport const padded = pad("y");\n' });
    const run = wave(base.memo, ["src/index.ts"]);
    expect(run.status, run.output).to.equal(0);
    /* The frontier stops at the edited file: its declaration came out
     * unchanged, so nothing that imports it can see a difference. */
    expect(run.compile.wave).to.deep.equal(["src/index.ts"]);
    expect(run.compile.emitted.filter(name => name.endsWith(".js"))).to.deep.equal(["build/index.js"]);
    expect(output("util.js"), "an unwaved file's output is not rewritten").to.equal(untouched);

    /* And what it did emit is what a full compile would have. */
    const waved = output("index.js");
    const { status } = compile(work.root);
    expect(status).to.equal(0);
    expect(waved).to.equal(output("index.js"));
  });

  it("re-checks the closure of a signature change, matching a full run's diagnostics", () => {
    stageProject();
    sources({
      "util.ts": "export function pad(text: string): string {\n  return text;\n}\n",
      "index.ts": 'import { pad } from "./util";\nexport const padded = pad("x");\n',
    });
    const base = baseline();
    expect(base.status, base.output).to.equal(0);

    /* A signature change its consumer still satisfies: the closure re-checks
     * and stays green. */
    sources({ "util.ts": "export function pad(text: string, width?: number): string {\n  return text + String(width);\n}\n" });
    const green = wave(base.memo, ["src/util.ts"]);
    expect(green.status, green.output).to.equal(0);
    expect([...green.compile.wave].sort()).to.deep.equal(["src/index.ts", "src/util.ts"]);

    /* And one it does not: the error must surface from the wave exactly as it
     * would from checking everything. */
    sources({ "util.ts": "export function pad(text: number): number {\n  return text;\n}\n" });
    const red = wave(base.memo, ["src/util.ts"]);
    const everything = wave(base.memo, projectFiles());
    expect(red.status, "a red wave fails the run").to.not.equal(0);
    expect(diagnosticKeys(red.compile)).to.deep.equal(diagnosticKeys(everything.compile));
    expect(diagnosticKeys(red.compile)).to.have.lengthOf.greaterThan(0);
  });

  it("reaches a consumer through an interface whose bytes never moved", () => {
    /* `a` declares the type, `b` returns it, `c` uses the result. Changing the
     * type does not move b's declaration bytes at all — a wave that stopped at
     * b would miss c's real error. */
    stageProject();
    sources({
      "a.ts": "export interface Thing {\n  n: number;\n}\n",
      "b.ts": 'import { Thing } from "./a";\nexport function get(): Thing {\n  return { n: 1 };\n}\n',
      "c.ts": 'import { get } from "./b";\nexport const value = get().n;\n',
    });
    const base = baseline();
    expect(base.status, base.output).to.equal(0);
    const surface = output("b.d.ts");
    /* b forwards a's interface — that edge is why c is reachable. */
    expect(edgeSpecifiers(base.memo, "src/b.ts", "forwarding")).to.deep.equal(["./a"]);

    sources({ "a.ts": "export interface Thing {\n  renamed: number;\n}\n" });
    const run = wave(base.memo, ["src/a.ts"]);
    expect(output("b.d.ts"), "b's declaration is byte-identical").to.equal(surface);
    expect([...run.compile.wave].sort()).to.deep.equal(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(run.status, "and c's error surfaces").to.not.equal(0);
    expect(diagnosticKeys(run.compile).some(key => key.startsWith("src/c.ts"))).to.equal(true);
  });

  it("follows a re-export chain", () => {
    stageProject();
    sources({
      "a.ts": "export interface Thing {\n  n: number;\n}\n",
      "mid.ts": 'export * from "./a";\n',
      "c.ts": 'import { Thing } from "./mid";\nexport const value: Thing = { n: 1 };\n',
    });
    const base = baseline();
    expect(base.status, base.output).to.equal(0);
    expect(edgeSpecifiers(base.memo, "src/mid.ts", "forwarding")).to.deep.equal(["./a"]);

    sources({ "a.ts": "export interface Thing {\n  renamed: number;\n}\n" });
    const run = wave(base.memo, ["src/a.ts"]);
    expect([...run.compile.wave].sort()).to.deep.equal(["src/a.ts", "src/c.ts", "src/mid.ts"]);
    expect(run.status, "c's now-wrong literal is reported").to.not.equal(0);
  });

  it("records a forwarding edge the source never wrote", () => {
    /* The non-subset rule: the declaration emitter names the module that
     * DECLARES an inferred type, which here is one the source does not import
     * at all. Scanning imports would miss the edge; scanning emitted text would
     * see it after the rewrite. */
    stageProject();
    sources({
      "deep.ts": "export interface DeepType {\n  value: number;\n}\nexport function make(): DeepType {\n  return { value: 1 };\n}\n",
      "mid.ts": 'export { make } from "./deep";\n',
      "top.ts": 'import { make } from "./mid";\nexport const thing = make();\n',
    });
    const base = baseline();
    expect(base.status, base.output).to.equal(0);
    expect(output("top.d.ts"), "the emitter named the declaring module").to.contain('import("./deep")');
    expect(edgeSpecifiers(base.memo, "src/top.ts", "use"), "which the source never imported").to.deep.equal(["./mid"]);
    expect(edgeSpecifiers(base.memo, "src/top.ts", "forwarding")).to.contain("./deep");

    /* And the wave traverses it: changing the deep type reaches top directly,
     * not only through mid. */
    sources({
      "deep.ts":
        "export interface DeepType {\n  renamed: number;\n}\nexport function make(): DeepType {\n  return { renamed: 1 };\n}\n",
    });
    const run = wave(base.memo, ["src/deep.ts"]);
    expect(run.compile.wave).to.contain("src/top.ts");
  });

  it("re-emits a const enum's referencers with the new value", () => {
    /* Emit is not purely local: a const enum's members are inlined into the
     * files that reference them, which is why the check closure is the emit
     * closure. */
    stageProject();
    sources({
      "levels.ts": "export const enum Level {\n  Low = 1,\n}\n",
      "use.ts": 'import { Level } from "./levels";\nexport const level = Level.Low;\n',
    });
    const base = baseline();
    expect(base.status, base.output).to.equal(0);
    expect(output("use.js")).to.contain("1 /* Level.Low */");

    sources({ "levels.ts": "export const enum Level {\n  Low = 7,\n}\n" });
    const run = wave(base.memo, ["src/levels.ts"]);
    expect(run.status, run.output).to.equal(0);
    expect(run.compile.wave).to.contain("src/use.ts");
    expect(output("use.js"), "the referencer carries the new value").to.contain("7 /* Level.Low */");
  });

  it("expands to everything when a file affecting global scope changes", () => {
    /* Nothing imports a global, so no edge can reach its dependents: the only
     * honest answer is every file. The memo's flag is what lets the planner see
     * this one coming, so it declines to bound at all — no fallback. */
    stageProject();
    sources({
      "env.ts": "declare global {\n  interface FabrGlobals {\n    version: string;\n  }\n}\nexport {};\n",
      "a.ts": "export const value = 1;\n",
      "b.ts": "export const other = 2;\n",
    });
    const base = baseline();
    expect(base.status, base.output).to.equal(0);
    expect(base.memo.get("src/env.ts")!.global, "the flag is recorded for next time").to.equal(true);

    sources({ "env.ts": "declare global {\n  interface FabrGlobals {\n    version: number;\n  }\n}\nexport {};\n" });
    const run = wave(base.memo, ["src/env.ts"]);
    expect(run.status, run.output).to.equal(0);
    expect(run.compile.expanded?.cause).to.equal("src/env.ts");
    expect(run.compile.fellBack, "seen coming, so nothing was redone").to.equal(undefined);
    expect([...run.compile.wave].sort()).to.deep.equal(["src/a.ts", "src/b.ts", "src/env.ts"]);
  });

  it("reports a deleted file's importers, from the base build's edges", () => {
    /* The easy half, and only because the base memo remembers what the deleted
     * file's importers were: the file itself is gone, so nothing current can
     * say who wanted it. */
    stageProject();
    sources({
      "util.ts": "export const pad = (text: string): string => text;\n",
      "index.ts": 'import { pad } from "./util";\nexport const padded = pad("x");\n',
    });
    const base = baseline();
    expect(base.status, base.output).to.equal(0);

    remove("util.ts");
    const run = wave(base.memo, [], ["src/util.ts"]);
    expect(run.compile.wave).to.contain("src/index.ts");
    expect(run.status, "the importer's module is missing").to.not.equal(0);
    expect(run.compile.diagnostics.some(diagnostic => diagnostic.code === 2307 && diagnostic.file === "src/index.ts")).to.equal(true);
    expect(run.memo.has("src/util.ts"), "and nothing current is claimed about the file that went").to.equal(false);
  });

  it("deletes the outputs its memo attributes to a source that has gone", () => {
    /* Only the compiler knew which outputs a source produced, which is why the
     * memo records the attribution: fabr stages the base output tree whole,
     * and correcting it is the driver's own job. */
    stageProject();
    sources({
      "orphan.ts": "export const orphan = 1;\n",
      "index.ts": "export const seen = 0;\n",
    });
    const base = baseline();
    expect(base.status, base.output).to.equal(0);
    expect(base.memo.get("src/orphan.ts")!.outputs, "the attribution is in the memo").to.deep.equal(["orphan.d.ts", "orphan.js"]);
    expect(fs.existsSync(path.join(work.root, "build/orphan.js"))).to.equal(true);

    remove("orphan.ts");
    const run = wave(base.memo, [], ["src/orphan.ts"]);
    expect(run.status, run.output).to.equal(0);
    expect(fs.existsSync(path.join(work.root, "build/orphan.js")), "its output came off").to.equal(false);
    expect(fs.existsSync(path.join(work.root, "build/orphan.d.ts"))).to.equal(false);
    expect(fs.existsSync(path.join(work.root, "build/index.js")), "and the others stayed").to.equal(true);
  });

  it("records specifiers as they were authored, not as the ES-module emit rewrites them", () => {
    /* The recorded form is what a later build re-resolves, so it has to be the
     * source's — `./b.js` is this compile's output namespace, and re-resolving
     * it against a changed tree would answer a different question. */
    stage(work.root, [], [], [], undefined, "esnext");
    sources({
      "b.ts": "export interface Thing {\n  n: number;\n}\nexport const make = (): Thing => ({ n: 1 });\n",
      "a.ts": 'import { make } from "./b";\nexport const thing = make();\n',
    });
    const base = baseline();
    expect(base.status, base.output).to.equal(0);
    expect(output("a.js"), "the emit names the file it wrote").to.contain('from "./b.js"');
    expect(edgeSpecifiers(base.memo, "src/a.ts", "use")).to.deep.equal(["./b"]);
    expect(edgeSpecifiers(base.memo, "src/a.ts", "forwarding")).to.deep.equal(["./b"]);
  });

  it("records a dependency's own forwarding edges, which a cross-package wave walks", () => {
    const inner = work.add("inner", { "index.d.ts": "export interface Value {\n  n: number;\n}\n" });
    const outer = work.add("outer", {
      "index.d.ts": 'import { Value } from "inner";\nexport declare function get(): Value;\n',
    });
    stage(
      work.root,
      [
        [
          "outer",
          outer,
          [
            ["outer", outer],
            ["inner", inner],
          ],
        ],
        ["inner", inner, [["inner", inner]]],
      ],
      [["outer", outer]],
      []
    );
    sources({ "index.ts": 'import { get } from "outer";\nexport const value = get().n;\n' });

    const base = baseline();
    expect(base.status, base.output).to.equal(0);
    /* A declaration file has no body, so what it imports it forwards — and the
     * target is recorded, since no membership check could replay a bare name. */
    expect(base.memo.get("outer index.d.ts")!.forwarding).to.deep.equal([
      { specifier: "inner", target: "outer inner index.d.ts" },
    ]);
    expect(base.memo.get("outer index.d.ts")!.use, "a declaration has no use side").to.deep.equal([]);
    expect(base.memo.get("src/index.ts")!.use).to.deep.equal([{ specifier: "outer", target: "outer index.d.ts" }]);

    /* And the wave crosses it: the inner declaration changing reaches the
     * source that only ever named the outer one. */
    const run = wave(base.memo, ["outer inner index.d.ts"]);
    expect([...run.compile.wave].sort()).to.deep.equal(["outer inner index.d.ts", "outer index.d.ts", "src/index.ts"].sort());
  });

  it("still reports what it read, so the entry keeps its precise key", () => {
    stageProject();
    sources({ "index.ts": "export const value = 1;\n" });
    baseline();
    const document = JSON.parse(fs.readFileSync(path.join(work.root, ".fabr-deps.json"), "utf8")) as {
      reads?: unknown;
      memo?: unknown;
      compile?: unknown;
    };
    expect(document.reads, "the reads channel is untouched by incremental mode").to.be.an("array");
    expect(document.compile).to.be.an("object");
    /* The state is files, not a section of this document — the report says what
     * the run READ, and nothing about what it kept. */
    expect(document.memo, "and the memo does not ride the report").to.equal(undefined);
  });

  /** A hub and its dependers: `util` is what everything names, `aside` the far
   * side of the graph, `index` the file in between. */
  function hubProject(hub: string): IWaveOutcome {
    stageProject();
    sources({
      "util.ts": hub,
      "index.ts": 'import { pad } from "./util";\nexport const padded = pad("x");\n',
      "aside.ts": "export const aside = 9;\n",
    });
    return baseline();
  }

  const HUB = "export function pad(text: string): string {\n  return text;\n}\n";

  it("bounds its program to what the change could reach, and says so", () => {
    /* The bound is the driver's own: the reverse closure of the change over the
     * memo's edges. A body edit moves no declaration, so the wave stays at the
     * changed file — and `aside`, the far side of the graph, was never rooted
     * at all, which the telemetry's account is the only witness of. */
    const base = hubProject(HUB);
    expect(base.status, base.output).to.equal(0);
    sources({ "util.ts": "export function pad(text: string): string {\n  return `${text} `.trim();\n}\n" });
    const run = wave(base.memo, ["src/util.ts"]);

    expect(run.status, run.output).to.equal(0);
    expect(run.compile.fellBack, "the wave stayed inside the bound, so the net did not fire").to.equal(undefined);
    expect([...run.compile.wave], "the wave is the changed file alone").to.deep.equal(["src/util.ts"]);
    expect(run.compile.emitted?.sort(), "and only its output was rewritten").to.deep.equal(["build/util.d.ts", "build/util.js"]);
    expect(run.compile.bound, "rooted at the depender closure, not the project").to.deep.equal({ roots: 2, project: 3 });
  });

  it("does not fall back on a signature change the bound accounted for", () => {
    /* The ordinary path: `index.ts` imports `util.ts`, so the reverse closure
     * puts it in the bound and it is rooted; only `aside` — the far side of the
     * graph — is left out. The declaration moves, the wave reaches the
     * depender, and the program is already holding it: one program, no net. */
    const base = hubProject(HUB);
    sources({ "util.ts": "export function pad(text: string, extra?: number): string {\n  return text + String(extra ?? 0);\n}\n" });
    const run = wave(base.memo, ["src/util.ts"]);

    expect(run.status, run.output).to.equal(0);
    expect(run.compile.fellBack, "a correct bound never trips the net").to.equal(undefined);
    expect([...run.compile.wave].sort(), "and the depender was checked").to.deep.equal(["src/index.ts", "src/util.ts"]);
    /* One program, and its answer is a full compile's. */
    const waved = output("index.js");
    expect(compile(work.root).status).to.equal(0);
    expect(waved).to.equal(output("index.js"));
  });

  it("reds against the bounded program alone", () => {
    /* An error in the changed file is decided against the bounded program: a
     * red run must not pay for a program it never needed. */
    const base = hubProject(HUB);
    sources({ "util.ts": "export function pad(text: string): string {\n  return missing(text);\n}\n" });
    const run = wave(base.memo, ["src/util.ts"]);

    expect(run.status, "a red run is red without a second program").to.not.equal(0);
    expect(run.output).to.contain("util.ts");
    expect(run.output).to.contain("Cannot find name 'missing'");
    expect(run.compile.fellBack, "and nothing was rebuilt to find that out").to.equal(undefined);
  });

  it("re-emits a depender for a shape change it cannot observe, and is right anyway", () => {
    /* A declaration carries its doc comments, so a JSDoc edit moves the shape
     * without moving anything a depender type-checks against. The shape is the
     * only evidence available at that moment, so the wave still reaches the
     * depender — conservative, and still a full compile's answer. */
    const base = hubProject(`/** Pads. */\n${HUB}`);
    sources({ "util.ts": `/** Pads a string, or does not. */\n${HUB}` });
    const run = wave(base.memo, ["src/util.ts"]);

    expect(run.status, run.output).to.equal(0);
    expect(run.compile.fellBack, "the depender was in the bound, so nothing was redone").to.equal(undefined);
    expect([...run.compile.wave].sort()).to.deep.equal(["src/index.ts", "src/util.ts"]);
    const waved = output("index.js");
    expect(compile(work.root).status).to.equal(0);
    expect(waved, "and the depender's output is unchanged, as it must be").to.equal(output("index.js"));
  });

  it("emits the whole project when a changed file BECOMES global", () => {
    /**
     * The one case a correct bound cannot see coming, and so the only routine
     * reason the fallback fires. Global scope is all-or-nothing: the honest wave
     * is every project file, and a bound-rooted program does not hold them. Only
     * PARSING reveals that a file became global, so the planner — which reads
     * the memo's flags, where `aside` was an ordinary module — cannot decline
     * to bound this one in advance: nothing imports `aside`, so its reverse
     * closure is itself.
     *
     * Beyond the fallback firing, this pins that the RERUN does the work: the
     * driver hands the same plan to the new program, so a guard reading the
     * plan rather than what THIS program is rooted at would bail identically —
     * an empty wave, exit 0, and a green entry with nothing in it, which the
     * next build then takes as its base.
     */
    const base = hubProject(HUB);
    expect(base.status, base.output).to.equal(0);
    sources({ "aside.ts": "declare global {\n  interface Window {\n    fabrProbe: number;\n  }\n}\nexport const aside = 9;\n" });
    const run = wave(base.memo, ["src/aside.ts"]);

    expect(run.status, run.output).to.equal(0);
    expect(run.compile.fellBack, "the run was abandoned and redone").to.equal(true);
    /* The fallback program HOLDS every project file, which the abandoned one
     * could not have, however the wave was computed. */
    expect([...run.compile.wave].sort(), "and the wave became every project file").to.deep.equal([
      "src/aside.ts",
      "src/index.ts",
      "src/util.ts",
    ]);
    expect(run.compile.emitted?.length, "which means it emitted, rather than committing an empty delta").to.be.greaterThan(0);
    /* And what it emitted is a full compile's answer. */
    const waved = output("index.js");
    expect(compile(work.root).status).to.equal(0);
    expect(waved).to.equal(output("index.js"));
  });

  it("refuses change lists it cannot read rather than quietly compiling everything", () => {
    /* The changes file is fabr's half of the contract, so a silent full compile
     * would hide a bug behind what looks exactly like working incrementality. */
    stageProject();
    sources({ "index.ts": "export const value = 1;\n" });
    baseline();
    fs.writeFileSync(path.join(work.root, ".fabr-changes.json"), "{ not json");
    expect(() =>
      compile(work.root, ["--state-dir", STATE_DIR, "--changes", ".fabr-changes.json", "--deps-report", ".fabr-deps.json"])
    ).to.throw(/unreadable change lists/);
  });

  it("refuses state handed back with no change lists, which says nothing about what it is good for", () => {
    /* The other half of fabr's contract, and the direction that is a bug: state
     * was kept and then nothing said what moved since. An EMPTY state directory
     * beside change lists is the ordinary cold build and no error at all. */
    stageProject();
    sources({ "index.ts": "export const value = 1;\n" });
    baseline();
    expect(() => compile(work.root, ["--state-dir", STATE_DIR, "--deps-report", ".fabr-deps.json"])).to.throw(/without --changes/);
  });

  it("compiles cold from a memo it cannot read — its own bytes, its own version rule", () => {
    /* The memo is this driver's private format, round-tripped through fabr
     * unread: one it cannot parse is an older format's, and the answer is the
     * same cold compile a missing memo costs — never an error, and never a
     * silent reuse of the stale output tree. */
    stageProject();
    sources({
      "util.ts": "export function pad(text: string): string {\n  return text;\n}\n",
      "index.ts": 'import { pad } from "./util";\nexport const padded = pad("x");\n',
    });
    const base = baseline();
    expect(base.status, base.output).to.equal(0);

    stageState("!tscmemo 999999\nnot this build's format\n");
    fs.writeFileSync(path.join(work.root, ".fabr-changes.json"), JSON.stringify({ changed: ["src/index.ts"], deleted: [] }));
    const run = outcomeOf(
      compile(work.root, ["--state-dir", STATE_DIR, "--changes", ".fabr-changes.json", "--deps-report", ".fabr-deps.json"])
    );
    expect(run.status, run.output).to.equal(0);
    expect([...run.compile.wave].sort(), "everything was compiled").to.deep.equal(["src/index.ts", "src/util.ts"]);
    expect(run.memo.get("src/index.ts"), "and a fresh memo was left").to.not.equal(undefined);
  });
});

/** Diagnostics as comparable keys — file, code and position, which is what two
 * runs must agree on; the message text is the compiler's to word. */
function diagnosticKeys(compiled: ICompileTelemetry): string[] {
  return compiled.diagnostics
    .map(({ file, code, line, character }) => `${file ?? ""}:${line ?? 0}:${character ?? 0} TS${code}`)
    .sort();
}

/**
 * The planner as a pure function: given the memo and fabr's name lists, what
 * does the driver root its program at? White-box, because the end-to-end cases
 * above would still be green if the bound quietly became the whole project —
 * what is asserted here is that it narrows.
 */
describe("the tsc driver's planning", () => {
  const WORLD = { projectFiles: new Set(["src/leaf.ts", "src/middle.ts", "src/top.ts", "src/aside.ts"]), sourceRoot: "src" };

  function memoFile(options: Partial<IMemoFile> = {}): IMemoFile {
    return { global: false, use: [], forwarding: [], ...options };
  }

  /** The chain fixture: a line of three plus one file off to the side, which is
   * what makes "reaches" and "cannot reach" both visible in one graph. */
  function chainMemo(): DriverMemo {
    return new Map([
      ["src/leaf.ts", memoFile()],
      ["src/middle.ts", memoFile({ use: [{ specifier: "./leaf" }], forwarding: [{ specifier: "./leaf" }] })],
      ["src/top.ts", memoFile({ use: [{ specifier: "./middle" }], forwarding: [{ specifier: "./middle" }] })],
      ["src/aside.ts", memoFile()],
    ]);
  }

  it("roots at nothing when nothing changed", () => {
    /* An empty bound is a real answer and not a missing one — nothing changed,
     * so nothing needs checking — which is why the plan spells "root at
     * everything" as an ABSENT bound rather than as an empty one. */
    const plan = planCompile({ changed: [], deleted: [] }, chainMemo(), WORLD.projectFiles, WORLD.sourceRoot);
    expect([...(plan.seeds ?? [])]).to.deep.equal([]);
    expect(plan.roots, "an empty bound, not an absent one").to.not.equal(undefined);
    expect([...plan.roots!]).to.deep.equal([]);
  });

  it("roots at exactly what the change could reach", () => {
    /* `middle` imports `leaf` and `top` imports `middle`, so a change in `leaf`
     * could reach both: they are the bound, and the bound is what the program
     * roots. `aside` is the far side of the graph — nothing a change to `leaf`
     * does can alter what a check of it says — so it is not rooted, and the
     * compiler holds it only if something rooted imports it. */
    const plan = planCompile({ changed: ["src/leaf.ts"], deleted: [] }, chainMemo(), WORLD.projectFiles, WORLD.sourceRoot);
    expect([...(plan.seeds ?? [])]).to.deep.equal(["src/leaf.ts"]);
    expect([...plan.roots!].sort()).to.deep.equal(["src/leaf.ts", "src/middle.ts", "src/top.ts"]);
  });

  it("declines to bound a change to a file that was global", () => {
    /* Global scope is all-or-nothing, so the wave becomes every file and a
     * bounded program could not answer for it. The planner sees this one
     * coming from the memo's own flags and roots at everything up front,
     * rather than leaving the fallback net to pay for a whole program twice. */
    const memo = chainMemo();
    memo.set("src/aside.ts", memoFile({ global: true }));
    const plan = planCompile({ changed: ["src/aside.ts"], deleted: [] }, memo, WORLD.projectFiles, WORLD.sourceRoot);
    expect(plan.roots, "no bound at all, which is how the plan says 'root at everything'").to.equal(undefined);
  });

  it("always roots a file that affects global scope, whatever changed", () => {
    /* An ambient declaration is imported by nothing, so no closure reaches it;
     * left out of the roots its declarations vanish from the compilation. */
    const memo = chainMemo();
    memo.set("src/aside.ts", memoFile({ global: true }));
    const plan = planCompile({ changed: ["src/leaf.ts"], deleted: [] }, memo, WORLD.projectFiles, WORLD.sourceRoot);
    expect([...plan.roots!].sort()).to.deep.equal(["src/aside.ts", "src/leaf.ts", "src/middle.ts", "src/top.ts"]);
  });

  it("plans a full, fresh compile for a change nothing bounds", () => {
    /* The generated tsconfig, the tool's own mount: no edge reaches what
     * changing one affects, and the carried output tree cannot be trusted
     * either — no seeds, no roots, start the emit from nothing. */
    const plan = planCompile({ changed: ["tsconfig.json"], deleted: [] }, chainMemo(), WORLD.projectFiles, WORLD.sourceRoot);
    expect(plan.seeds, "no seeds: the wave is everything").to.equal(undefined);
    expect(plan.roots).to.equal(undefined);
    expect(plan.fresh, "and the emit starts from nothing").to.not.equal(undefined);
    expect(plan.memo.size, "while the memo carries on").to.be.greaterThan(0);
  });

  it("seeds a deleted discoverable dep's dependers", () => {
    /* A dependency bump is a delete plus an add: the deleted name is an
     * ordinary seed — its shape is nothing, which differs from whatever it was
     * — and the merge still drops its memo line. */
    const memo = chainMemo();
    memo.set("dup old.d.ts", memoFile());
    const plan = planCompile({ changed: [], deleted: ["dup old.d.ts"] }, memo, WORLD.projectFiles, WORLD.sourceRoot);
    expect([...(plan.seeds ?? [])]).to.deep.equal(["dup old.d.ts"]);
    expect([...plan.deleted]).to.deep.equal(["dup old.d.ts"]);
  });

  it("seeds the importers an added file may re-bind", () => {
    /* `./util` resolved to `util/index.ts`; a `util.ts` appearing beside it
     * takes the name, and the importer has no edge to the newcomer at all. */
    const memo: DriverMemo = new Map([
      ["src/util/index.ts", memoFile()],
      ["src/index.ts", memoFile({ use: [{ specifier: "./util" }] })],
    ]);
    const world = { projectFiles: new Set(["src/util/index.ts", "src/index.ts", "src/util.ts"]), sourceRoot: "src" };
    const plan = planCompile({ changed: ["src/util.ts"], deleted: [] }, memo, world.projectFiles, world.sourceRoot);
    expect([...(plan.seeds ?? [])].sort()).to.deep.equal(["src/index.ts", "src/util.ts"]);
  });

  it("seeds the importers an added declaration file may re-bind", () => {
    /* The compound extension as a unit: `util.d.ts` inverts to the base `util`
     * (never `util.d`, which no import probes) and captures `./util` ahead of
     * the `util.js` it used to bind — probing order puts `.d.ts` before `.js`. */
    const memo: DriverMemo = new Map([
      ["src/util.js", memoFile()],
      ["src/index.ts", memoFile({ use: [{ specifier: "./util", target: "src/util.js" }] })],
    ]);
    const world = { projectFiles: new Set(["src/util.js", "src/index.ts", "src/util.d.ts"]), sourceRoot: "src" };
    const plan = planCompile({ changed: ["src/util.d.ts"], deleted: [] }, memo, world.projectFiles, world.sourceRoot);
    expect([...(plan.seeds ?? [])].sort()).to.deep.equal(["src/index.ts", "src/util.d.ts"]);
  });

  it("seeds the importers whose failed lookup an added package answers", () => {
    /* The importer's `thing` resolved to nothing — or settled for the `@types`
     * sidecar — so no resolved edge names the package that was asked for. The
     * memo's failed line is the edge to that absence, recorded as the path the
     * lookup took, which is exactly the name its appearance arrives under. */
    const memo: DriverMemo = new Map([
      ["src/index.ts", memoFile({ use: [{ specifier: "thing" }], failed: ["thing package.json"] })],
      ["src/aside.ts", memoFile()],
    ]);
    const world = { projectFiles: new Set(["src/index.ts", "src/aside.ts"]), sourceRoot: "src" };
    const plan = planCompile({ changed: ["thing package.json"], deleted: [] }, memo, world.projectFiles, world.sourceRoot);
    expect([...(plan.seeds ?? [])].sort()).to.deep.equal(["src/index.ts", "thing package.json"]);
    expect([...plan.roots!], "and roots only the asker's closure").to.deep.equal(["src/index.ts"]);
  });

  it("plans a full compile for an appearance nothing in the graph asked for", () => {
    /* A package no file's lookup ever failed on can still appear in the changed
     * list, because the PROGRAM asked: a `@typescript/lib-*` replacement, or a
     * type reference directive's package. Those move the global type
     * environment, no edge reaches what that affects, and left in the seeds
     * the name would wave nothing at all. */
    const plan = planCompile({ changed: ["@typescript/lib-dom package.json"], deleted: [] }, chainMemo(), WORLD.projectFiles, WORLD.sourceRoot);
    expect(plan.seeds, "no seeds: the wave is everything").to.equal(undefined);
    expect(plan.fresh?.reason).to.contain("nothing bounds");
  });

  it("plans a full compile for a manifest that moved with its files untouched", () => {
    /* An `exports` edit re-binds what a specifier names by content no row
     * carries — the bound files' bytes are unchanged, so the manifest row is
     * the ONLY change, and no line of the memo owns it. */
    const memo = chainMemo();
    memo.set("used index.d.ts", memoFile());
    memo.set("src/top.ts", memoFile({ use: [{ specifier: "used", target: "used index.d.ts" }] }));
    const plan = planCompile({ changed: ["used package.json"], deleted: [] }, memo, WORLD.projectFiles, WORLD.sourceRoot);
    expect(plan.seeds).to.equal(undefined);
  });

  it("still bounds a bump whose manifest row rides its files' changes", () => {
    /* A version bump rewrites `package.json` too, and the manifest row has no
     * memo line of its own — but the package's FILES changed with it, and their
     * lines are what wave the dependers. A sibling change is what tells a bump
     * from a manifest moving alone. */
    const memo = chainMemo();
    memo.set("dep index.d.ts", memoFile());
    memo.set("src/top.ts", memoFile({ use: [{ specifier: "dep", target: "dep index.d.ts" }] }));
    const plan = planCompile(
      { changed: ["dep index.d.ts", "dep package.json"], deleted: [] },
      memo,
      WORLD.projectFiles,
      WORLD.sourceRoot
    );
    expect(plan.seeds, "bounded, not cold").to.not.equal(undefined);
    expect([...plan.roots!], "the depender is rooted through the file's line").to.contain("src/top.ts");
  });

  it("keeps a workspace addition nothing imports an ordinary bounded change", () => {
    /* A brand-new source is unclaimed by construction — nothing imports it yet
     * — and benign: the program-level arm is scoped to dependency-space names,
     * which only a recorded absence resolving can produce. */
    const plan = planCompile({ changed: ["src/new.ts"], deleted: [] }, chainMemo(), WORLD.projectFiles, WORLD.sourceRoot);
    expect([...(plan.seeds ?? [])]).to.deep.equal(["src/new.ts"]);
    expect(plan.roots).to.not.equal(undefined);
  });

  it("compiles cold with no source root to classify against", () => {
    const plan = planCompile({ changed: ["src/leaf.ts"], deleted: [] }, chainMemo(), WORLD.projectFiles, undefined);
    expect(plan.seeds).to.equal(undefined);
  });
});

describe("the driver's memo format", () => {
  const FILE = { global: false, use: [], forwarding: [] };

  it("round-trips edges, flags, targets, outputs and failed lookups", () => {
    const memo: DriverMemo = new Map([
      [
        "src/foo.ts",
        {
          global: false,
          use: [{ specifier: "./bar" }, { specifier: "lodash", target: "lodash#abc/index.d.ts" }],
          forwarding: [{ specifier: "./bar" }],
          outputs: ["foo.js", "foo.d.ts"],
          failed: ["thing package.json", "@types/thing package.json"],
        },
      ],
      ["src/bar.ts", { global: true, use: [], forwarding: [] }],
      /* Failed lookups with NOTHING emitted: the outputs section is empty but
       * must still hold its place, or the failures would parse as outputs. */
      ["src/baz.ts", { global: false, use: [{ specifier: "thing" }], forwarding: [], failed: ["thing package.json"] }],
    ]);
    const read = parseDriverMemo(serializeDriverMemo(memo))!;
    expect(read, "a memo this build wrote must read back").to.not.equal(undefined);
    expect(read.get("src/foo.ts")).to.deep.equal(memo.get("src/foo.ts"));
    expect(read.get("src/bar.ts")!.global, "the global-scope flag").to.equal(true);
    expect(read.get("src/bar.ts")!.outputs, "a file that emitted nothing carries none").to.equal(undefined);
    expect(read.get("src/bar.ts")!.failed, "and a file that failed nothing carries none").to.equal(undefined);
    expect(read.get("src/baz.ts")).to.deep.equal(memo.get("src/baz.ts"));
  });

  it("round-trips fields the line's own grammar would otherwise eat", () => {
    /* The field separator, the edge separator, the spec/target split, the flag,
     * and the escape character itself must all survive being data. */
    const awkward = "src/a file with spaces & 100%.ts";
    const memo: DriverMemo = new Map<string, IMemoFile>([
      [
        awkward,
        {
          global: false,
          use: [{ specifier: "pkg|with|pipes", target: "x=y" }, { specifier: "!g" }],
          forwarding: [{ specifier: "./a b" }],
          outputs: ["build/a b|c.js"],
        },
      ],
      ["!g", FILE],
    ]);
    const read = parseDriverMemo(serializeDriverMemo(memo))!;
    expect(read.get(awkward)).to.deep.equal(memo.get(awkward));
    expect(read.get("!g")!.global, "a file NAMED like the flag is not flagged").to.equal(false);
  });

  it("writes identical bytes for identical memos, whatever order they were built in", () => {
    const one: DriverMemo = new Map([
      ["b.ts", FILE],
      ["a.ts", FILE],
    ]);
    const other: DriverMemo = new Map([
      ["a.ts", FILE],
      ["b.ts", FILE],
    ]);
    expect(serializeDriverMemo(one)).to.equal(serializeDriverMemo(other));
  });

  it("refuses a memo written by a format it does not read", () => {
    /* Read against the version this build actually writes rather than a
     * literal, so a bump cannot leave the assertions replacing text that is not
     * there and passing vacuously. */
    const bytes = serializeDriverMemo(new Map([["a.ts", FILE]]));
    const header = bytes.split("\n")[0];
    const version = Number(header.split(" ")[1]);
    expect(version, "the header carries a numeric version").to.be.greaterThan(0);
    const at = (claimed: number): string => bytes.replace(header, header.replace(String(version), String(claimed)));
    expect(parseDriverMemo(at(version)), "the current one reads, or the rest proves nothing").to.not.equal(undefined);
    expect(parseDriverMemo(at(version + 1)), "a newer memo").to.equal(undefined);
    expect(parseDriverMemo(at(version - 1)), "an older memo too").to.equal(undefined);
    expect(parseDriverMemo(bytes.replace("!tscmemo", "!something")), "and a foreign magic").to.equal(undefined);
    expect(parseDriverMemo(""), "nothing at all").to.equal(undefined);
  });

  it("refuses a line that is not one", () => {
    const bytes = serializeDriverMemo(new Map([["a.ts", { ...FILE, use: [{ specifier: "./b" }] }]]));
    const damage = (change: (line: string) => string): DriverMemo | undefined => {
      const [header, ...lines] = bytes.split("\n");
      return parseDriverMemo([header, ...lines.map(change)].join("\n"));
    };
    expect(
      damage(line => line.replace(" |", "")),
      "no edge separator"
    ).to.equal(undefined);
    expect(
      damage(line => line.replace("a.ts", "a%2.ts")),
      "a truncated escape"
    ).to.equal(undefined);
  });
});

describe("the report documents the step reads", () => {
  /* The report is written by the TSC_DRIVER, which a project may swap for one
   * of its own — third-party by this codebase's rule however familiar the
   * shipped one is. A malformed one must be an attributed complaint about the
   * document, never a TypeError inside the step that reads it. */
  it("reads the reads and the edges, and nothing else", () => {
    const edges = [{ from: "", name: "left-pad", to: "left-pad#abc", via: "own" }];
    /* A driver's own state is files in its state directory, so a section
     * claiming to carry it here is just another section the step ignores. */
    const report = toRunReport({ reads: ["a"], edges, memo: "!tscmemo 1\n", compile: { anything: true } });
    expect(report.reads).to.deep.equal(["a"]);
    expect(report.edges).to.deep.equal(edges);
    expect(Object.keys(report).sort()).to.deep.equal(["edges", "reads"]);
  });

  it("takes a report with no edges as one that resolved nothing", () => {
    /* A driver with no module system of its own (a stub, a tool fabr does not
     * resolve for) reports reads and nothing else; each then names its place in
     * the delivered graph. */
    expect(toRunReport({ reads: ["a"] }).edges).to.deep.equal([]);
  });

  it("refuses a report whose shape is wrong, naming what is wrong with it", () => {
    expect(() => toRunReport("not an object")).to.throw(/expected a JSON object/);
    expect(() => toRunReport({ reads: "not a list" })).to.throw(/'reads' to be a list of names/);
    expect(() => toRunReport({ reads: [], edges: "not a list" })).to.throw(/'edges' to be a list of resolutions/);
    expect(() => toRunReport({ reads: [], edges: [{ from: "", name: "x", to: "x#1", via: "guessed" }] })).to.throw(/own\|fallback/);
  });

  it("reads change lists, and refuses what is not one", () => {
    expect(toChangeLists({ changed: ["a"], deleted: [] })).to.deep.equal({ changed: ["a"], deleted: [] });
    expect(toChangeLists({})).to.deep.equal({ changed: [], deleted: [] });
    expect(() => toChangeLists([])).to.throw(/expected a JSON object/);
    expect(() => toChangeLists({ changed: [7] })).to.throw(/'changed' to be a list of names/);
  });
});

describe("assertDrivableCompiler", () => {
  it("accepts the releases carrying the compiler API this driver uses", () => {
    expect(() => assertDrivableCompiler("5.4.5")).to.not.throw();
    expect(() => assertDrivableCompiler("6.0.3")).to.not.throw();
  });

  it("rejects TypeScript 7 as a different job, not a stricter one", () => {
    /* 7's entry point exports version information and nothing else, so an
     * unchecked run dies on an undefined host member instead. */
    expect(() => assertDrivableCompiler("7.0.2")).to.throw(/driver of its own/);
  });

  it("rejects a compiler predating the resolution hooks", () => {
    expect(() => assertDrivableCompiler("4.9.5")).to.throw(/find none of the build's dependencies/);
  });
});
