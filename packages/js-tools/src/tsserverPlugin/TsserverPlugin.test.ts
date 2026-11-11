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

/* The plugin in a real tsserver ProjectService: a fixture holding two units —
 * `app`, and the local package `lib` it imports — inside an outer project whose
 * own node_modules has a decoy of `app`'s dependency `dep`, a package only it
 * has, and a manifest listing both. */

import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as ts from "typescript";
import type { IPnpSerializedState } from "../pnp/PnPState";
import { createLanguageService, type IPluginCreateInfo, type IServerTypeScript, type ITypeScriptUnit } from "./TsserverPlugin";

interface IFixture {
  root: string;
  units: ITypeScriptUnit[];
  file(name: string): string;
}

function write(root: string, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
}

function table(rows: Array<[string | null, string | null, string, Array<[string, string]>]>): string {
  const state: IPnpSerializedState = {
    __info: [],
    dependencyTreeRoots: [],
    enableTopLevelFallback: false,
    ignorePatternData: null,
    fallbackExclusionList: [],
    fallbackPool: [],
    packageRegistryData: rows.map(([name, reference, location, dependencies]) => [
      name,
      [[reference, { packageLocation: location, packageDependencies: dependencies, linkType: name === null ? "SOFT" : "HARD" }]],
    ]),
  };
  return JSON.stringify(state);
}

const OPTIONS = { strict: true, module: "commonjs", moduleResolution: "bundler", target: "es2021", types: [], typeRoots: [] };

function makeFixture(): IFixture {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "fabr-tsserver-"));
  write(root, {
    "package.json": JSON.stringify({ name: "outer", dependencies: { dep: "1.0.0", "outer-only": "1.0.0" } }),
    "node_modules/dep/package.json": JSON.stringify({ name: "dep", version: "9.9.9", types: "index.d.ts" }),
    "node_modules/dep/index.d.ts": "export declare const decoy: string;\n",
    "node_modules/outer-only/package.json": JSON.stringify({ name: "outer-only", version: "1.0.0", types: "index.d.ts" }),
    "node_modules/outer-only/index.d.ts": "export declare const outerValue: number;\n",
    "store/dep/package.json": JSON.stringify({ name: "dep", version: "1.0.0", types: "index.d.ts" }),
    "store/dep/index.d.ts": "export declare const real: number;\n",
    /* `exclude` stated: unstated, it is the config's outDir, which here holds
     * the sources. */
    "lib/tsconfig.json": JSON.stringify({
      compilerOptions: { ...OPTIONS, composite: true, rootDir: "src", outDir: "." },
      include: ["src"],
      exclude: [],
    }),
    "lib/package.json": JSON.stringify({ name: "lib", exports: { ".": { types: "./index.d.ts", default: "./index.js" } } }),
    "lib/src/index.ts": 'import { helper } from "./internal";\nexport const libValue: number = helper();\n',
    "lib/src/internal.ts": "export function helper(): number {\n  return 1;\n}\n",
    "lib/.pnp.data.json": table([
      [null, null, "./", []],
      ["lib", "self", "./src/", []],
    ]),
    "app/tsconfig.json": JSON.stringify({ compilerOptions: OPTIONS, include: ["src"], references: [{ path: "../lib" }] }),
    "app/src/main.ts": 'import { real } from "dep";\nimport { libValue } from "lib";\nexport const total: number = real + libValue;\n',
    "app/src/other.ts": "export const other = 1;\n",
    "app/.pnp.data.json": table([
      [
        null,
        null,
        "./",
        [
          ["dep", "1.0.0"],
          ["lib", "local"],
        ],
      ],
      ["dep", "1.0.0", "../store/dep/", [["dep", "1.0.0"]]],
      ["lib", "local", "../lib/", [["lib", "local"]]],
    ]),
  });
  const unit = (name: string, pkg?: string): ITypeScriptUnit => ({
    config: path.join(root, name, "tsconfig.json"),
    root: path.join(root, name),
    table: path.join(root, name, ".pnp.data.json"),
    ...(pkg === undefined ? {} : { package: pkg }),
  });
  return { root, units: [unit("app"), unit("lib", "lib")], file: name => path.join(root, name) };
}

const LOGGER = {
  close: () => {},
  hasLevel: () => false,
  loggingEnabled: () => false,
  perftrc: () => {},
  info: () => {},
  startGroup: () => {},
  endGroup: () => {},
  msg: () => {},
  getLogFileName: () => undefined,
};

/** Make a ProjectService whose one global plugin is the fabr plugin over `units`. */
function projectService(units: ITypeScriptUnit[], serverMode = ts.LanguageServiceMode.Semantic): ts.server.ProjectService {
  const plugin = (): { create(info: IPluginCreateInfo): unknown } => ({
    create: info => createLanguageService(ts as unknown as IServerTypeScript, info, units),
  });
  const host: ts.server.ServerHost = {
    ...ts.sys,
    setTimeout,
    clearTimeout,
    setImmediate,
    clearImmediate,
    watchFile: () => ({ close: () => {} }),
    watchDirectory: () => ({ close: () => {} }),
    require: () => ({ module: plugin, error: undefined }),
  } as unknown as ts.server.ServerHost;
  return new ts.server.ProjectService({
    host,
    logger: LOGGER as unknown as ts.server.Logger,
    cancellationToken: ts.server.nullCancellationToken,
    useSingleInferredProject: false,
    useInferredProjectPerProjectRoot: false,
    typingsInstaller: ts.server.nullTypingsInstaller,
    globalPlugins: ["fabr"],
    pluginProbeLocations: ["/"],
    allowLocalPluginLoads: false,
    serverMode,
    session: undefined,
  });
}

function open(service: ts.server.ProjectService, file: string, text?: string): ts.LanguageService {
  service.openClientFile(file, text);
  return service.getDefaultProjectForFile(ts.server.toNormalizedPath(file), true)!.getLanguageService();
}

function positionOf(file: string, needle: string): number {
  return fs.readFileSync(file, "utf8").indexOf(needle) + 1;
}

function messages(diagnostics: readonly ts.Diagnostic[]): string[] {
  return diagnostics.map(d => `TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
}

describe("tsserver plugin", () => {
  let fixture: IFixture;
  beforeEach(() => {
    fixture = makeFixture();
  });
  afterEach(() => {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  it("resolves a unit's imports through its table, not the node_modules above it", () => {
    const main = fixture.file("app/src/main.ts");
    const service = open(projectService(fixture.units), main);
    expect(messages(service.getSemanticDiagnostics(main))).to.deep.equal([]);
    const dep = service.getDefinitionAtPosition(main, positionOf(main, '"dep"'));
    expect(dep?.map(d => d.fileName)).to.deep.equal([fixture.file("store/dep/index.d.ts")]);
  });

  it("reads a local package from its source, unsaved edits included", () => {
    const main = fixture.file("app/src/main.ts");
    const projects = projectService(fixture.units);
    const service = open(projects, main);
    const lib = service.getDefinitionAtPosition(main, positionOf(main, '"lib"'));
    expect(lib?.map(d => d.fileName)).to.deep.equal([fixture.file("lib/src/index.ts")]);
    open(projects, fixture.file("lib/src/index.ts"), "export const renamed: number = 1;\n");
    expect(messages(service.getSemanticDiagnostics(main))).to.deep.equal([`TS2305 Module '"lib"' has no exported member 'libValue'.`]);
  });

  it("leaves a package's JavaScript out of the program, as the build does", () => {
    write(fixture.root, {
      "store/untyped/package.json": JSON.stringify({ name: "untyped", version: "1.0.0", main: "index.js" }),
      "store/untyped/index.js": "module.exports = class Untyped { constructor() { this.name = 1; } };\n",
      "app/tsconfig.json": JSON.stringify({ compilerOptions: { ...OPTIONS, allowJs: true, noImplicitAny: false }, include: ["src"] }),
      "app/.pnp.data.json": table([
        [null, null, "./", [["untyped", "1.0.0"]]],
        ["untyped", "1.0.0", "../store/untyped/", [["untyped", "1.0.0"]]],
      ]),
    });
    const main = fixture.file("app/src/main.ts");
    const service = open(
      projectService(fixture.units),
      main,
      'import Untyped = require("untyped");\nexport const missing = new Untyped().missing;\n'
    );
    expect(messages(service.getSemanticDiagnostics(main))).to.deep.equal([]);
    expect(service.getProgram()!.getSourceFile(fixture.file("store/untyped/index.js"))).to.equal(undefined);
  });

  it("keeps a unit's program where a package's import is typed by an @types package it declares in its place", () => {
    write(fixture.root, {
      "store/dep/index.d.ts":
        'import type { Phantom } from "phantom";\nexport declare const real: number;\nexport declare const ghost: Phantom;\n',
      "store/types-phantom/package.json": JSON.stringify({ name: "@types/phantom", version: "1.0.0", types: "index.d.ts" }),
      "store/types-phantom/index.d.ts": "export interface Phantom { a: number; }\n",
      "app/.pnp.data.json": table([
        [
          null,
          null,
          "./",
          [
            ["dep", "1.0.0"],
            ["lib", "local"],
          ],
        ],
        [
          "dep",
          "1.0.0",
          "../store/dep/",
          [
            ["dep", "1.0.0"],
            ["@types/phantom", "1.0.0"],
          ],
        ],
        ["@types/phantom", "1.0.0", "../store/types-phantom/", [["@types/phantom", "1.0.0"]]],
        ["lib", "local", "../lib/", [["lib", "local"]]],
      ]),
    });
    const main = fixture.file("app/src/main.ts");
    const service = open(projectService(fixture.units), main);
    expect(messages(service.getSemanticDiagnostics(main))).to.deep.equal([]);
    expect(service.getDefinitionAtPosition(main, positionOf(main, '"dep"'))?.map(d => d.fileName)).to.deep.equal([
      fixture.file("store/dep/index.d.ts"),
    ]);
  });

  it("reads a local package whose sources come from two directories from its source", () => {
    write(fixture.root, {
      /* A solution of the package's two units, as the editor shows them. */
      "multi/tsconfig.json": JSON.stringify({
        files: [],
        references: [{ path: "./tsconfig.build.json" }, { path: "./tsconfig.test.json" }],
      }),
      "multi/tsconfig.build.json": JSON.stringify({
        compilerOptions: { ...OPTIONS, composite: true, rootDir: ".", outDir: ".", rootDirs: ["./src", "./types"] },
        files: ["src/index.ts", "types/extra.d.ts", "types/self.ts"],
        exclude: [],
      }),
      "multi/package.json": JSON.stringify({
        name: "multi",
        exports: { ".": { types: "./index.d.ts", default: "./index.js" }, "./theme.scss": "./theme.scss" },
      }),
      "multi/src/index.ts": "export const multiValue: number = 1;\n",
      "multi/src/theme.scss": "$accent: red;\n",
      "app/src/ambient.d.ts": 'declare module "*.scss";\n',
      "app/src/styles.ts": 'import theme from "multi/theme.scss";\nexport const styles: unknown = theme;\n',
      "multi/types/extra.d.ts": "declare const extra: number;\n",
      "multi/types/self.ts": 'import { multiValue } from "multi";\nexport const again: number = multiValue;\n',
      "multi/tsconfig.test.json": JSON.stringify({
        compilerOptions: { ...OPTIONS, rootDir: ".", outDir: ".", rootDirs: ["./src", "./types"] },
        files: ["src/index.ts", "types/extra.d.ts", "types/self.ts", "types/self.test.ts"],
        exclude: [],
      }),
      "multi/types/self.test.ts": 'import { multiValue } from "multi";\nexport const checked: number = multiValue;\n',
      "app/src/main.ts": 'import { multiValue } from "multi";\nexport const total: number = multiValue;\n',
      "multi/.pnp.data.json": table([
        [null, null, "./", [["multi", "self"]]],
        ["multi", "self", "./", [["multi", "self"]]],
      ]),
      "app/tsconfig.json": JSON.stringify({
        compilerOptions: OPTIONS,
        include: ["src"],
        references: [{ path: "../lib" }, { path: "../multi/tsconfig.build.json" }],
      }),
      "app/.pnp.data.json": table([
        [
          null,
          null,
          "./",
          [
            ["dep", "1.0.0"],
            ["lib", "local"],
            ["multi", "local"],
          ],
        ],
        ["dep", "1.0.0", "../store/dep/", [["dep", "1.0.0"]]],
        ["lib", "local", "../lib/", [["lib", "local"]]],
        ["multi", "local", "../multi/", [["multi", "local"]]],
      ]),
    });
    const units = [
      ...fixture.units,
      {
        config: fixture.file("multi/tsconfig.build.json"),
        root: fixture.file("multi"),
        table: fixture.file("multi/.pnp.data.json"),
        package: "multi",
      },
    ];
    const main = fixture.file("app/src/main.ts");
    const service = open(projectService(units), main);
    expect(messages(service.getSemanticDiagnostics(main))).to.deep.equal([]);
    expect(service.getDefinitionAtPosition(main, positionOf(main, '"multi"'))?.map(d => d.fileName)).to.deep.equal([
      fixture.file("multi/src/index.ts"),
    ]);
    /* A file it ships as it is lies in one of its directories, at its name in the package. */
    const styles = fixture.file("app/src/styles.ts");
    expect(messages(open(projectService(units), styles).getSemanticDiagnostics(styles))).to.deep.equal([]);
    /* The package imports itself by name, as its build does, and so do its
     * tests, a unit of their own. */
    const tests = {
      config: fixture.file("multi/tsconfig.test.json"),
      root: fixture.file("multi"),
      table: fixture.file("multi/.pnp.data.json"),
      package: "multi",
    };
    for (const file of [fixture.file("multi/types/self.ts"), fixture.file("multi/types/self.test.ts")]) {
      expect(messages(open(projectService([...units, tests]), file).getSemanticDiagnostics(file))).to.deep.equal([]);
    }
  });

  it("resolves an import the compile renames by its rewrite rules, as the build does", () => {
    write(fixture.root, {
      "app/tsconfig.json": JSON.stringify({
        compilerOptions: { ...OPTIONS, rootDir: "src" },
        include: ["src"],
        references: [{ path: "../lib" }],
      }),
      "app/src/styles.css.ts": "declare const styles: { title: string };\nexport default styles;\n",
      "app/src/main.ts": 'import styles from "./styles.module.scss";\nexport const title: string = styles.title;\n',
    });
    /* The stylesheet rule js_compile writes: a module stylesheet names its class map. */
    const rewrites = [
      {
        pattern:
          "^(?:(?:(?!(?:^|\\/)\\.{1,2}(?:\\/|$))((?:(?!(?:^|\\/)\\.{1,2}(?:\\/|$)).)*?)\\/)?(?!\\.{1,2}(?:\\/|$))(?=.)([^/]*?)\\.module\\.scss\\/?)$",
        replacement: "$1/$2.css.js",
      },
    ];
    const main = fixture.file("app/src/main.ts");
    const units = fixture.units.map(unit => (unit.package === undefined ? { ...unit, rewrites } : unit));
    expect(messages(open(projectService(units), main).getSemanticDiagnostics(main))).to.deep.equal([]);
    expect(messages(open(projectService(fixture.units), main).getSemanticDiagnostics(main))).to.deep.equal([
      "TS2307 Cannot find module './styles.module.scss' or its corresponding type declarations.",
    ]);
  });

  it("finishes a unit's diagnostics as the compile does: an import of a missing file a pattern let through is an error", () => {
    write(fixture.root, {
      "app/src/ambient.d.ts": 'declare module "*.css";\n',
      "app/src/styles.css": "a { color: red; }\n",
      "app/src/main.ts": 'import "./styles.css";\nimport "./missing.css";\nexport const x = 1;\n',
      "app/src/other.ts": 'import { x } from "./main";\nexport const y = x;\n',
    });
    const main = fixture.file("app/src/main.ts");
    const projects = projectService(fixture.units);
    const service = open(projects, main);
    const reported = messages(service.getSemanticDiagnostics(main));
    expect(reported.map(message => message.slice(0, 8))).to.deep.equal(["TS79001 "]);
    expect(reported[0]).to.contain("missing.css");
    /* Each file's diagnostics report its own imports alone. */
    expect(messages(service.getSemanticDiagnostics(fixture.file("app/src/other.ts")))).to.deep.equal([]);
    /* An edit of the file reports the import again, at its place in the new text. */
    projects.getScriptInfo(main)!.editContent(0, 0, "\n");
    expect(messages(service.getSemanticDiagnostics(main)).map(message => message.slice(0, 8))).to.deep.equal(["TS79001 "]);
  });

  it("resolves a subpath a local package publishes by a wildcard to its source", () => {
    write(fixture.root, {
      /* The config a unit's description writes: its sources at its root, its outputs beside them. */
      "wild/tsconfig.json": JSON.stringify({
        compilerOptions: { ...OPTIONS, composite: true, rootDir: ".", outDir: "." },
        files: ["index.ts", "sub.ts"],
        exclude: [],
      }),
      "wild/package.json": JSON.stringify({
        name: "wild",
        exports: { ".": { types: "./index.d.ts", default: "./index.js" }, "./*": { types: "./*.d.ts", default: "./*.js" } },
      }),
      "wild/index.ts": "export const top = 1;\n",
      "wild/sub.ts": "export const subValue: number = 2;\n",
      "wild/.pnp.data.json": table([
        [null, null, "./", []],
        ["wild", "self", "./", []],
      ]),
      "app/tsconfig.json": JSON.stringify({
        compilerOptions: OPTIONS,
        include: ["src"],
        references: [{ path: "../lib" }, { path: "../wild" }],
      }),
      "app/src/main.ts": 'import { subValue } from "wild/sub";\nexport const total: number = subValue;\n',
      "app/.pnp.data.json": table([
        [null, null, "./", [["wild", "local"]]],
        ["wild", "local", "../wild/", [["wild", "local"]]],
      ]),
    });
    const units = [
      ...fixture.units,
      {
        config: fixture.file("wild/tsconfig.json"),
        root: fixture.file("wild"),
        table: fixture.file("wild/.pnp.data.json"),
        package: "wild",
      },
    ];
    const main = fixture.file("app/src/main.ts");
    const service = open(projectService(units), main);
    expect(messages(service.getSemanticDiagnostics(main))).to.deep.equal([]);
    expect(service.getDefinitionAtPosition(main, positionOf(main, '"wild/sub"'))?.map(d => d.fileName)).to.deep.equal([
      fixture.file("wild/sub.ts"),
    ]);
  });

  it("resolves an import whose file was created after it failed", () => {
    const main = fixture.file("app/src/main.ts");
    const projects = projectService(fixture.units);
    const service = open(projects, main, 'import { later } from "./later";\nexport const x = later;\n');
    expect(messages(service.getSemanticDiagnostics(main))).to.deep.equal([
      "TS2307 Cannot find module './later' or its corresponding type declarations.",
    ]);
    write(fixture.root, { "app/src/later.ts": "export const later = 1;\n" });
    projects.getScriptInfo(main)!.editContent(0, 0, " ");
    expect(messages(service.getSemanticDiagnostics(main))).to.deep.equal([]);
  });

  it("fails an import only the outer project has, as the build would", () => {
    const main = fixture.file("app/src/main.ts");
    const service = open(
      projectService(fixture.units),
      main,
      'import { outerValue } from "outer-only";\nexport const x = outerValue;\n'
    );
    expect(messages(service.getSemanticDiagnostics(main))).to.deep.equal([
      "TS2307 Cannot find module 'outer-only' or its corresponding type declarations.",
    ]);
  });

  it("leaves a project that is no unit as tsserver has it", () => {
    write(fixture.root, {
      "tsconfig.json": JSON.stringify({
        compilerOptions: { ...OPTIONS, moduleResolution: "node10", types: undefined, typeRoots: undefined },
        include: ["outer.ts"],
      }),
      "outer.ts": 'import { decoy } from "dep";\nexport const y: string = decoy;\n',
    });
    const outer = fixture.file("outer.ts");
    const service = open(projectService(fixture.units), outer);
    expect(messages(service.getSemanticDiagnostics(outer))).to.deep.equal([]);
    expect(service.getDefinitionAtPosition(outer, positionOf(outer, '"dep"'))?.map(d => d.fileName)).to.deep.equal([
      fixture.file("node_modules/dep/index.d.ts"),
    ]);
  });

  it("offers auto-imports only from what the unit can import", () => {
    const other = fixture.file("app/src/other.ts");
    const projects = projectService(fixture.units);
    open(projects, fixture.file("app/src/main.ts"));
    const offered = (word: string): string[] => {
      const text = `export const probe = ${word}`;
      const service = open(projects, other, text);
      const completions = service.getCompletionsAtPosition(other, text.length, {
        includeCompletionsForModuleExports: true,
        includePackageJsonAutoImports: "auto",
      });
      return (completions?.entries ?? []).filter(entry => entry.name === word).map(entry => entry.source ?? "(in scope)");
    };
    expect(offered("libValue")).to.deep.equal(["lib"]);
    expect(offered("real")).to.deep.equal(["dep"]);
    expect(offered("outerValue")).to.deep.equal([]);
    expect(offered("decoy")).to.deep.equal([]);
    expect(offered("helper")).to.deep.equal([]);
  });

  it("resolves a file in the syntax server by the unit whose config lists it, where two share a root", () => {
    write(fixture.root, {
      "store/testdep/package.json": JSON.stringify({ name: "testdep", version: "1.0.0", types: "index.d.ts" }),
      "store/testdep/index.d.ts": "export declare const checked: number;\n",
      "app/src/main.test.ts": 'import { checked } from "testdep";\nexport const ran: number = checked;\n',
      /* The build's unit lists its sources, not the tests, as a unit's config does. */
      "app/tsconfig.json": JSON.stringify({
        compilerOptions: OPTIONS,
        files: ["src/main.ts", "src/other.ts"],
        references: [{ path: "../lib" }],
      }),
      /* The tests' unit: the build's sources and the tests, with a dependency the build has not. */
      "app/tsconfig.test.json": JSON.stringify({
        compilerOptions: OPTIONS,
        files: ["src/main.ts", "src/other.ts", "src/main.test.ts"],
      }),
      "app/.pnp.test.json": table([
        [
          null,
          null,
          "./",
          [
            ["dep", "1.0.0"],
            ["lib", "local"],
            ["testdep", "1.0.0"],
          ],
        ],
        ["dep", "1.0.0", "../store/dep/", [["dep", "1.0.0"]]],
        ["lib", "local", "../lib/", [["lib", "local"]]],
        ["testdep", "1.0.0", "../store/testdep/", [["testdep", "1.0.0"]]],
      ]),
    });
    const tests = {
      config: fixture.file("app/tsconfig.test.json"),
      root: fixture.file("app"),
      table: fixture.file("app/.pnp.test.json"),
    };
    const test = fixture.file("app/src/main.test.ts");
    const service = open(projectService([...fixture.units, tests], ts.LanguageServiceMode.PartialSemantic), test);
    expect(service.getDefinitionAtPosition(test, positionOf(test, '"testdep"'))?.map(d => d.fileName)).to.deep.equal([
      fixture.file("store/testdep/index.d.ts"),
    ]);
  });

  it("reads each unit's config once to resolve by importer in the syntax server", () => {
    const main = fixture.file("app/src/main.ts");
    const service = projectService(fixture.units, ts.LanguageServiceMode.PartialSemantic);
    const configs = new Set(fixture.units.map(unit => unit.config));
    const reads = new Map<string, number>();
    const readFile = ts.sys.readFile;
    ts.sys.readFile = (file, encoding) => {
      if (configs.has(file)) {
        reads.set(file, (reads.get(file) ?? 0) + 1);
      }
      return readFile.call(ts.sys, file, encoding);
    };
    try {
      open(service, main);
    } finally {
      ts.sys.readFile = readFile;
    }
    expect([...reads.values()]).to.deep.equal(fixture.units.map(() => 1));
  });

  it("leaves a unit whose PnP table is missing as tsserver has it", () => {
    fs.rmSync(fixture.file("app/.pnp.data.json"));
    const main = fixture.file("app/src/main.ts");
    const service = open(projectService(fixture.units), main);
    const dep = service.getDefinitionAtPosition(main, positionOf(main, '"dep"'));
    expect(dep?.map(d => d.fileName)).to.deep.equal([fixture.file("node_modules/dep/index.d.ts")]);
  });

  it("resolves by importer in the syntax server", () => {
    const main = fixture.file("app/src/main.ts");
    const service = open(projectService(fixture.units, ts.LanguageServiceMode.PartialSemantic), main);
    const dep = service.getDefinitionAtPosition(main, positionOf(main, '"dep"'));
    expect(dep?.map(d => d.fileName)).to.deep.equal([fixture.file("store/dep/index.d.ts")]);
  });

  it("resolves an import in the syntax server from a package no unit holds, through a unit whose table locates it", () => {
    write(fixture.root, {
      "store/inner/package.json": JSON.stringify({ name: "inner", version: "1.0.0", types: "index.d.ts" }),
      "store/inner/index.d.ts": "export declare const deep: number;\n",
      "store/dep/index.d.ts": 'import { deep } from "inner";\nexport declare const real: typeof deep;\n',
      "app/.pnp.data.json": table([
        [
          null,
          null,
          "./",
          [
            ["dep", "1.0.0"],
            ["lib", "local"],
          ],
        ],
        [
          "dep",
          "1.0.0",
          "../store/dep/",
          [
            ["dep", "1.0.0"],
            ["inner", "1.0.0"],
          ],
        ],
        ["inner", "1.0.0", "../store/inner/", [["inner", "1.0.0"]]],
        ["lib", "local", "../lib/", [["lib", "local"]]],
      ]),
    });
    const dep = fixture.file("store/dep/index.d.ts");
    const service = open(projectService(fixture.units, ts.LanguageServiceMode.PartialSemantic), dep);
    expect(service.getDefinitionAtPosition(dep, positionOf(dep, '"inner"'))?.map(d => d.fileName)).to.deep.equal([
      fixture.file("store/inner/index.d.ts"),
    ]);
  });
});
