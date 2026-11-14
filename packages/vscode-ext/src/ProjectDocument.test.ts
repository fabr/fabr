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
 */

import { expect } from "chai";
import * as path from "node:path";
import { composeProject, type IServedTarget } from "./ProjectDocument";

/* Paths in the host's form, as the composition makes them. */
const ROOT = path.resolve("/p");
const POOL = path.resolve("/cache/tree");
const STORAGE = path.resolve("/storage");
const INSTALLATION = path.resolve("/fabr");
const PLUGIN = "@fabr-build/js-tools/tsserverPlugin/TsserverPlugin";

function table(rows: Array<[string | null, string | null, string]>): string {
  return JSON.stringify({
    packageRegistryData: rows.map(([name, reference, location]) => [
      name,
      [[reference, { packageLocation: location, packageDependencies: [] }]],
    ]),
  });
}

/* `app` imports the local package `lib` and the pool package `dep`. */
const FILES = new Map<string, string>([
  [path.join(POOL, "app-d/units/build/unit.json"), JSON.stringify({ root: "./app/src/", package: "app", generated: ["x.css.d.ts"] })],
  [path.join(POOL, "app-d/units/build/tsconfig.json"), JSON.stringify({ compilerOptions: { rootDir: "." }, files: ["main.ts"] })],
  [
    path.join(POOL, "app-d/units/build/.pnp.data.json"),
    table([
      [null, null, "./"],
      ["app", "self", "./"],
      ["lib", "aaa", "./../../lib/src/"],
      ["dep", "bbb", "./.fabr-tree/dep-tree/"],
    ]),
  ],
  [path.join(POOL, "lib-d/units/build/unit.json"), JSON.stringify({ root: "./lib/src/", package: "lib", generated: [] })],
  [path.join(POOL, "lib-d/units/build/tsconfig.json"), JSON.stringify({ compilerOptions: { rootDir: "." }, files: ["index.ts"] })],
  [
    path.join(POOL, "lib-d/units/build/.pnp.data.json"),
    table([
      [null, null, "./"],
      ["lib", "self", "./"],
    ]),
  ],
]);

const target = (name: string): IServedTarget => ({
  id: { uri: `fabr:${name}` },
  dataKind: "typescript",
  data: { units: { build: "units/build" }, manifest: "package.json", plugin: PLUGIN },
  fabr: { description: path.join(POOL, `${name}-d`), operation: "build" },
});

describe("project document", () => {
  const composed = composeProject({
    root: ROOT,
    installation: INSTALLATION,
    storage: STORAGE,
    targets: [target("app"), target("lib")],
    readFile: file => {
      const text = FILES.get(file);
      if (text === undefined) {
        throw new Error(`no ${file}`);
      }
      return text;
    },
    resolve: (specifier, from) => `${from}/node_modules/${specifier}.js`,
  });

  it("composes without problems", () => {
    expect(composed.problems).to.deep.equal([]);
  });

  it("shows each unit's config at its root, a package's manifest beside it, and its generated sources", () => {
    expect(composed.document.links).to.deep.equal({
      [path.join(ROOT, "app/src/package.json")]: path.join(POOL, "app-d/package.json"),
      [path.join(ROOT, "app/src/tsconfig.json")]: path.join(STORAGE, "0/tsconfig.json"),
      [path.join(ROOT, "app/src/x.css.d.ts")]: path.join(POOL, "app-d/units/build/generated/x.css.d.ts"),
      [path.join(ROOT, "lib/src/package.json")]: path.join(POOL, "lib-d/package.json"),
      [path.join(ROOT, "lib/src/tsconfig.json")]: path.join(STORAGE, "1/tsconfig.json"),
    });
  });

  it("locates a pool package from the unit's root, and a local one at its own unit, which it references", () => {
    const rows = new Map(JSON.parse(composed.files.get(path.join(STORAGE, "0/.pnp.data.json"))!).packageRegistryData);
    const location = (name: string): string => (rows.get(name) as Array<[string, { packageLocation: string }]>)[0][1].packageLocation;
    expect(location("lib")).to.equal("./../../lib/src/");
    expect(location("dep")).to.equal("./../../../cache/tree/dep-tree/");
    expect(location("app")).to.equal("./");
    expect(JSON.parse(composed.files.get(path.join(STORAGE, "0/tsconfig.json"))!).references).to.deep.equal([
      { path: "../../lib/src" },
    ]);
  });

  it("lists the units, and the plugin resolved from the installation", () => {
    expect(composed.document.units).to.deep.equal([
      {
        config: path.join(ROOT, "app/src/tsconfig.json"),
        root: path.join(ROOT, "app/src"),
        table: path.join(STORAGE, "0/.pnp.data.json"),
        package: "app",
      },
      {
        config: path.join(ROOT, "lib/src/tsconfig.json"),
        root: path.join(ROOT, "lib/src"),
        table: path.join(STORAGE, "1/.pnp.data.json"),
        package: "lib",
      },
    ]);
    expect(composed.document.plugin).to.equal(`${INSTALLATION}/node_modules/${PLUGIN}.js`);
  });

  it("shows a unit whose sources come from two directories at the directory holding both, its generated sources where it places them", () => {
    const files = new Map(FILES);
    files.set(
      path.join(POOL, "app-d/units/build/unit.json"),
      JSON.stringify({ root: "./app/", package: "app", generated: ["src/x.css.d.ts"] })
    );
    const multi = composeProject({
      root: ROOT,
      installation: INSTALLATION,
      storage: STORAGE,
      targets: [target("app"), target("lib")],
      readFile: file =>
        files.get(file) ??
        (() => {
          throw new Error(`no ${file}`);
        })(),
      resolve: (specifier, from) => `${from}/node_modules/${specifier}.js`,
    });
    const links = multi.document.links as Record<string, string>;
    expect(links[path.join(ROOT, "app/tsconfig.json")]).to.equal(path.join(STORAGE, "0/tsconfig.json"));
    expect(links[path.join(ROOT, "app/src/x.css.d.ts")]).to.equal(path.join(POOL, "app-d/units/build/generated/src/x.css.d.ts"));
  });

  it("locates a package whose only unit is its tests' in the pool", () => {
    const files = new Map(FILES);
    files.set(
      path.join(POOL, "app-d/units/build/.pnp.data.json"),
      table([
        [null, null, "./"],
        ["app", "self", "./"],
        ["lib", "aaa", "./.fabr-tree/lib-tree/"],
      ])
    );
    files.set(path.join(POOL, "lib-t/units/test/unit.json"), JSON.stringify({ root: "./lib/src/", package: "lib", generated: [] }));
    files.set(
      path.join(POOL, "lib-t/units/test/tsconfig.json"),
      JSON.stringify({ compilerOptions: { rootDir: "." }, files: ["index.test.ts"] })
    );
    files.set(
      path.join(POOL, "lib-t/units/test/.pnp.data.json"),
      table([
        [null, null, "./"],
        ["lib", "self", "./"],
      ])
    );
    /* Its unit's name is no matter: the operation it is described under is. */
    const libTests: IServedTarget = {
      id: { uri: "fabr:lib?operation=test" },
      dataKind: "typescript",
      data: { units: { build: "units/test" }, plugin: PLUGIN },
      fabr: { description: path.join(POOL, "lib-t"), operation: "test" },
    };
    const composedTests = composeProject({
      root: ROOT,
      installation: INSTALLATION,
      storage: STORAGE,
      targets: [target("app"), libTests],
      readFile: file =>
        files.get(file) ??
        (() => {
          throw new Error(`no ${file}`);
        })(),
      resolve: (specifier, from) => `${from}/node_modules/${specifier}.js`,
    });
    const rows = new Map(JSON.parse(composedTests.files.get(path.join(STORAGE, "0/.pnp.data.json"))!).packageRegistryData);
    expect((rows.get("lib") as Array<[string, { packageLocation: string }]>)[0][1].packageLocation).to.equal(
      "./../../../cache/tree/lib-tree/"
    );
    expect(JSON.parse(composedTests.files.get(path.join(STORAGE, "0/tsconfig.json"))!).references).to.equal(undefined);
  });

  it("reports a target or a unit whose description is not one fabr writes, and composes the rest", () => {
    const damaged = new Map(FILES);
    damaged.set(path.join(POOL, "lib-d/units/build/unit.json"), JSON.stringify({ root: "./lib/src/", package: "lib" }));
    const odd: IServedTarget = { ...target("odd"), data: { units: { build: 3 }, plugin: PLUGIN } };
    const result = composeProject({
      root: ROOT,
      installation: INSTALLATION,
      storage: STORAGE,
      targets: [target("app"), target("lib"), odd],
      readFile: file =>
        damaged.get(file) ??
        (() => {
          throw new Error(`no ${file}`);
        })(),
      resolve: (specifier, from) => `${from}/node_modules/${specifier}.js`,
    });
    expect(result.problems).to.deep.equal([
      "fabr:lib build: unit.json is not a unit's summary",
      "fabr:odd: the target's data names no units",
    ]);
  });

  it("shows two units at one root behind a solution config, the build unit first", () => {
    const tests = new Map(FILES);
    tests.set(path.join(POOL, "app-t/units/test/unit.json"), JSON.stringify({ root: "./app/src/", package: "app", generated: [] }));
    tests.set(
      path.join(POOL, "app-t/units/test/tsconfig.json"),
      JSON.stringify({ compilerOptions: { rootDir: "." }, files: ["main.ts", "main.test.ts"] })
    );
    tests.set(
      path.join(POOL, "app-t/units/test/.pnp.data.json"),
      table([
        [null, null, "./"],
        ["app", "self", "./"],
      ])
    );
    const testTarget: IServedTarget = {
      id: { uri: "fabr:app?operation=test" },
      dataKind: "typescript",
      data: { units: { test: "units/test" }, plugin: PLUGIN },
      fabr: { description: path.join(POOL, "app-t"), operation: "test" },
    };
    const both = composeProject({
      root: ROOT,
      installation: INSTALLATION,
      storage: STORAGE,
      /* The test target first: the order of the units at a root is the composition's. */
      targets: [testTarget, target("app"), target("lib")],
      readFile: file =>
        tests.get(file) ??
        (() => {
          throw new Error(`no ${file}`);
        })(),
      resolve: (specifier, from) => `${from}/node_modules/${specifier}.js`,
    });
    expect(both.problems).to.deep.equal([]);
    const links = both.document.links as Record<string, string>;
    const solution = JSON.parse(both.files.get(links[path.join(ROOT, "app/src/tsconfig.json")])!);
    expect(solution).to.deep.equal({
      files: [],
      references: [{ path: "./tsconfig.fabr-0.json" }, { path: "./tsconfig.fabr-1.json" }],
    });
    expect(JSON.parse(both.files.get(links[path.join(ROOT, "app/src/tsconfig.fabr-0.json")])!).files).to.deep.equal(["main.ts"]);
    expect(JSON.parse(both.files.get(links[path.join(ROOT, "app/src/tsconfig.fabr-1.json")])!).files).to.deep.equal([
      "main.ts",
      "main.test.ts",
    ]);
    expect((both.document.units as Array<{ config: string }>).map(unit => unit.config)).to.deep.equal([
      path.join(ROOT, "app/src/tsconfig.fabr-0.json"),
      path.join(ROOT, "app/src/tsconfig.fabr-1.json"),
      path.join(ROOT, "lib/src/tsconfig.json"),
    ]);
  });
});
