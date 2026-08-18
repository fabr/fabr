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
import { main, rewriteDeclaration } from "./tsc-driver";

/** A staged workspace: sources, a tsconfig, a manifest, and a store the
 * manifest's locations point into through the same link a build step stages. */
interface IFixture {
  root: string;
  store: string;
  /** Add a package to the store and answer the reference naming it. */
  add(name: string, files: Record<string, string>): string;
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
    add(name, files) {
      const reference = `key${next++}`;
      const entry = path.join(store, reference);
      fs.mkdirSync(entry, { recursive: true });
      fs.writeFileSync(path.join(entry, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
      for (const [file, content] of Object.entries(files)) {
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
  self?: { name: string; location: string }
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
        module: "commonjs",
        moduleResolution: "node",
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

  it("resolves a package's own name and subpaths through its row", () => {
    const lib = work.add("lib", {
      "index.d.ts": 'export * from "./deep";\n',
      "deep.d.ts": "export declare const deep: number;\n",
    });
    stage(work.root, [["lib", lib, [["lib", lib]]]], [["lib", lib]], []);
    fs.writeFileSync(path.join(work.root, "src/index.ts"), 'import { deep } from "lib/deep";\nexport const value: number = deep;\n');

    expect(compile(work.root).status).to.equal(0);
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

  it("refuses to emit a declaration naming a tree it cannot name a package for", () => {
    /* The safety net: a rewrite that misses anything must fail the compile, not
     * ship a pool path that resolves to nothing outside this build. */
    const known = work.add("zustand", { "index.d.ts": "export declare const x: number;\n" });
    stage(work.root, [["zustand", known, [["zustand", known]]]], [["zustand", known]], []);
    const resolver = PnpResolver.load(work.root)!;
    const emitted = path.join(work.root, "build/index.d.ts");

    expect(rewriteDeclaration(emitted, `export declare const s: import("../.fabr-tree/${known}").x;\n`, resolver)).to.contain(
      'import("zustand")'
    );
    expect(() =>
      rewriteDeclaration(emitted, 'export declare const s: import("../.fabr-tree/nosuchkey/deep").x;\n', resolver)
    ).to.throw(/would ship a path into this build.s tree pool/);
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
