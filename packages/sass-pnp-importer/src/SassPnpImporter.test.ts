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

/*
 * Everything here drives the REAL compiler (sass-embedded) and resolves through
 * Yarn's own PnP runtime: the importer's contract is with both, and a stand-in
 * for either would only confirm itself. Sass's own filesystem loader is the
 * oracle for the file search — the same tree loaded through a load path must
 * give the same answer.
 */

import { expect } from "chai";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { type IPnpApi, type ISassImporter, sassPnpImporter } from "./SassPnpImporter";

/** As much of sass-embedded as the tests drive. */
interface ISass {
  compileString(
    source: string,
    options: { url?: URL; importers?: ISassImporter[]; loadPaths?: string[]; syntax?: string }
  ): { css: string; loadedUrls: URL[] };
}

/** As much of Yarn's runtime packages as the tests use: their declarations
 * need a newer `@types/node` than the repo pins. */
interface IYarnPnp {
  hydratePnpSource(source: string, options: { basePath: string; fakeFs: unknown; pnpapiResolution: string }): IPnpApi;
  generateInlinedScript(settings: unknown): string;
}
interface IYarnFslib {
  NodeFS: new () => unknown;
  VirtualFS: new (options: { baseFs: unknown }) => unknown;
}
/* eslint-disable-next-line @typescript-eslint/no-var-requires */
const sass = require("sass-embedded") as ISass;
/* eslint-disable-next-line @typescript-eslint/no-var-requires */
const yarnPnp = require("@yarnpkg/pnp") as IYarnPnp;
/* eslint-disable-next-line @typescript-eslint/no-var-requires */
const { NodeFS, VirtualFS } = require("@yarnpkg/fslib") as IYarnFslib;

type Target = string | [string, string] | null;

/** A package row: where it lives (relative, possibly virtual), what it binds,
 * and its files (written at the location's physical directory). */
interface IPackage {
  readonly name: string;
  readonly reference: string;
  readonly location: string;
  readonly dependencies?: Array<[string, Target]>;
  readonly files: Record<string, string>;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** The physical directory of a relative location, virtual or not. */
function physicalOf(location: string): string {
  const match = /^(.*?)\/__virtual__\/[^/]+\/0\/(.*)$/.exec(location);
  return match === null ? location : `${match[1]}/${match[2]}`;
}

/** A workspace holding `packages`, the top level depending on `topLevel`. */
function workspace(packages: IPackage[], topLevel: Array<[string, Target]>): { root: string; state: Record<string, unknown> } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sass-pnp-")));
  roots.push(root);
  for (const pkg of packages) {
    for (const [name, content] of Object.entries(pkg.files)) {
      const file = path.join(root, physicalOf(pkg.location), name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
  }
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  const byName = new Map<string, Array<[string, unknown]>>();
  for (const pkg of packages) {
    byName.set(pkg.name, [
      ...(byName.get(pkg.name) ?? []),
      [pkg.reference, { packageLocation: pkg.location, packageDependencies: pkg.dependencies ?? [], linkType: "HARD" }],
    ]);
  }
  const state = {
    __info: [],
    dependencyTreeRoots: [],
    enableTopLevelFallback: false,
    ignorePatternData: null,
    fallbackExclusionList: [],
    fallbackPool: [],
    packageRegistryData: [[null, [[null, { packageLocation: "./", packageDependencies: topLevel, linkType: "SOFT" }]]], ...byName],
  };
  return { root, state };
}

/** Yarn's runtime over a workspace's table. */
function yarnApi(root: string, state: Record<string, unknown>): IPnpApi {
  return yarnPnp.hydratePnpSource(JSON.stringify(state), {
    basePath: root,
    fakeFs: new VirtualFS({ baseFs: new NodeFS() }),
    pnpapiResolution: path.join(root, ".pnp.cjs"),
  });
}

/** Compile `source` as the workspace's `src/entry.scss`, through the importer. */
function compile(root: string, state: Record<string, unknown>, source: string): string {
  return sass
    .compileString(source, { url: pathToFileURL(path.join(root, "src", "entry.scss")), importers: [sassPnpImporter({ pnpApi: yarnApi(root, state) })] })
    .css.trim();
}

/** The outcome of `ask` — the CSS, or the fact of a failure. */
function outcome(ask: () => string): string {
  try {
    return ask();
  } catch {
    return "<error>";
  }
}

const rule = (tag: string): string => `.x { v: "${tag}"; }\n`;
const indented = (tag: string): string => `.x\n  v: "${tag}"\n`;

describe("sassPnpImporter, searching a package as Sass searches a load path", () => {
  /* Each layout is one package's files; each request is asked with @use and
   * with @import, through the importer and — as the oracle — through Sass's own
   * load-path search over the very same directory. */
  const layouts: Array<Record<string, string>> = [
    { "colors.scss": rule("plain") },
    { "_colors.scss": rule("partial") },
    { "colors.scss": rule("plain"), "_colors.scss": rule("partial") },
    { "colors.sass": indented("indented") },
    { "colors.css": rule("css") },
    { "colors.scss": rule("scss"), "colors.css": rule("css") },
    { "colors.scss": rule("scss"), "colors.sass": indented("sass") },
    { "colors/_index.scss": rule("index") },
    { "colors/index.sass": indented("indented index") },
    { "colors/_index.scss": rule("index"), "colors/index.scss": rule("index too") },
    { "colors.import.scss": rule("import-only"), "colors.scss": rule("plain") },
    { "colors/index.import.scss": rule("index import-only"), "colors/_index.scss": rule("index") },
    { "_colors.import.scss": rule("partial import-only"), "_colors.scss": rule("partial") },
  ];
  const requests = ["colors", "colors.scss", "_colors", "colors/index"];

  for (const [index, files] of layouts.entries()) {
    it(`agrees with Sass's own search over layout ${index + 1} (${Object.keys(files).join(", ")})`, () => {
      const { root, state } = workspace(
        [{ name: "pkg", reference: "1", location: "./pkgs/pkg/", dependencies: [["pkg", "1"]], files: { "package.json": "{}", ...files } }],
        [["pkg", "1"]]
      );
      for (const request of requests) {
        for (const rule of ["@use", "@import"]) {
          const source = `${rule} "pkg/${request}";\n`;
          const native = outcome(() =>
            sass.compileString(source, { url: pathToFileURL(path.join(root, "src", "entry.scss")), loadPaths: [path.join(root, "pkgs")] }).css.trim()
          );
          expect(outcome(() => compile(root, state, source)), `${source.trim()} over ${Object.keys(files).join(", ")}`).to.equal(native);
        }
      }
    });
  }
});

describe("sassPnpImporter, resolving what a package publishes", () => {
  const resolve = (files: Record<string, string>, source: string): string => {
    const { root, state } = workspace(
      [{ name: "pkg", reference: "1", location: "./pkgs/pkg/", dependencies: [["pkg", "1"]], files }],
      [["pkg", "1"]]
    );
    return outcome(() => compile(root, state, source));
  };

  it("takes the root from exports under the sass condition", () => {
    const files = {
      "package.json": JSON.stringify({ exports: { ".": { sass: "./scss/_main.scss", default: "./index.js" } } }),
      "scss/_main.scss": rule("main"),
      "index.js": "",
    };
    expect(resolve(files, '@use "pkg";')).to.contain('"main"');
  });

  it("takes the root from the sass field, then the style field", () => {
    expect(resolve({ "package.json": JSON.stringify({ sass: "lib/main.scss" }), "lib/main.scss": rule("sass field") }, '@use "pkg";')).to.contain(
      "sass field"
    );
    expect(resolve({ "package.json": JSON.stringify({ style: "lib/main.css" }), "lib/main.css": rule("style field") }, '@use "pkg";')).to.contain(
      "style field"
    );
  });

  it("takes the root's own index when nothing names an entry", () => {
    expect(resolve({ "package.json": "{}", "_index.scss": rule("root index") }, '@use "pkg";')).to.contain("root index");
  });

  it("finds a partial through an exports pattern", () => {
    const files = { "package.json": JSON.stringify({ exports: { "./*": "./src/*" } }), "src/_colors.scss": rule("exported partial") };
    expect(resolve(files, '@use "pkg/colors";')).to.contain("exported partial");
  });

  it("reports two exported candidates for one load as ambiguous", () => {
    const files = { "package.json": JSON.stringify({ exports: { "./*": "./src/*" } }), "src/_colors.scss": rule("a"), "src/colors.scss": rule("b") };
    expect(resolve(files, '@use "pkg/colors";')).to.equal("<error>");
  });

  it("falls through to the package's directory when exports publish nothing for a stylesheet", () => {
    /* A map describing the package's JavaScript is no boundary for its Sass. */
    const files = { "package.json": JSON.stringify({ exports: { ".": "./index.js" } }), "index.js": "", "scss/_colors.scss": rule("unexported") };
    expect(resolve(files, '@use "pkg/scss/colors";')).to.contain("unexported");
  });

  it("accepts the pkg: scheme", () => {
    expect(resolve({ "package.json": "{}", "_colors.scss": rule("pkg scheme") }, '@use "pkg:pkg/colors";')).to.contain("pkg scheme");
  });

  it("refuses webpack's ~ prefix", () => {
    expect(resolve({ "package.json": "{}", "_colors.scss": rule("tilde") }, '@use "~pkg/colors";')).to.equal("<error>");
  });

  it("leaves a name the table does not bind to Sass's load paths", () => {
    const { root, state } = workspace([], []);
    fs.mkdirSync(path.join(root, "styles"));
    fs.writeFileSync(path.join(root, "styles", "_variables.scss"), rule("load path"));
    const css = sass.compileString('@use "variables";', {
      url: pathToFileURL(path.join(root, "src", "entry.scss")),
      importers: [sassPnpImporter({ pnpApi: yarnApi(root, state) })],
      loadPaths: [path.join(root, "styles")],
    }).css;
    expect(css).to.contain("load path");
  });
});

describe("sassPnpImporter, loading from inside a package", () => {
  it("resolves a package's own relative and package loads from the wiring that loaded it", () => {
    /* `theme` is ONE content wired two ways — at two virtual locations over one
     * directory — each binding `tokens` to a different package. `left` and
     * `right` each forward their `theme`; the entry uses both. */
    const theme = {
      "package.json": "{}",
      "_index.scss": '@forward "./parts/palette";\n',
      "parts/_palette.scss": '@use "tokens";\n.palette { v: tokens.$value; }\n',
    };
    const tokens = (value: string): Record<string, string> => ({ "package.json": "{}", "_index.scss": `$value: "${value}";\n` });
    const { root, state } = workspace(
      [
        { name: "theme", reference: "a", location: "./pkgs/__virtual__/aaaa/0/theme/", dependencies: [["tokens", "1"]], files: theme },
        { name: "theme", reference: "b", location: "./pkgs/__virtual__/bbbb/0/theme/", dependencies: [["tokens", "2"]], files: {} },
        { name: "tokens", reference: "1", location: "./pkgs/tokens1/", files: tokens("one") },
        { name: "tokens", reference: "2", location: "./pkgs/tokens2/", files: tokens("two") },
        { name: "left", reference: "1", location: "./pkgs/left/", dependencies: [["theme", "a"]], files: { "package.json": "{}", "_index.scss": '@forward "theme";\n' } },
        { name: "right", reference: "1", location: "./pkgs/right/", dependencies: [["theme", "b"]], files: { "package.json": "{}", "_index.scss": '@forward "theme";\n' } },
      ],
      [
        ["left", "1"],
        ["right", "1"],
      ]
    );
    const css = compile(root, state, '@use "left";\n@use "right";\n');
    expect(css).to.contain('"one"');
    expect(css).to.contain('"two"');
  });

  it("does not let a package load what it does not declare", () => {
    const { root, state } = workspace(
      [
        { name: "user", reference: "1", location: "./pkgs/user/", files: { "package.json": "{}", "_index.scss": '@use "hidden";\n' } },
        { name: "hidden", reference: "1", location: "./pkgs/hidden/", files: { "package.json": "{}", "_index.scss": rule("hidden") } },
      ],
      [
        ["user", "1"],
        ["hidden", "1"],
      ]
    );
    expect(outcome(() => compile(root, state, '@use "user";'))).to.equal("<error>");
  });
});

describe("sassPnpImporter under Yarn's own runtime", () => {
  it("finds the table through node's module.findPnpApi when given none", () => {
    /* A separate process with Yarn's loader preloaded, as `yarn node` runs one:
     * the importer is constructed with no options at all. */
    const { root, state } = workspace(
      [{ name: "pkg", reference: "1", location: "./pkgs/pkg/", dependencies: [["pkg", "1"]], files: { "package.json": "{}", "_colors.scss": rule("under yarn") } }],
      [["pkg", "1"]]
    );
    fs.writeFileSync(path.join(root, ".pnp.cjs"), yarnPnp.generateInlinedScript(settingsOf(state)));
    const importer = fs.existsSync(path.join(__dirname, "index.js")) ? path.join(__dirname, "index.js") : path.join(__dirname, "..", "build", "index.js");
    fs.writeFileSync(
      path.join(root, "src", "run.cjs"),
      [
        `const sass = require(${JSON.stringify(require.resolve("sass-embedded"))});`,
        `const { sassPnpImporter } = require(${JSON.stringify(importer)});`,
        `const { pathToFileURL } = require("node:url");`,
        `process.stdout.write(sass.compileString('@use "pkg/colors";', { url: pathToFileURL(__filename), importers: [sassPnpImporter()] }).css);`,
      ].join("\n")
    );
    const css = execFileSync(process.execPath, ["--require", path.join(root, ".pnp.cjs"), path.join(root, "src", "run.cjs")], {
      cwd: root,
      encoding: "utf8",
    });
    expect(css).to.contain("under yarn");
  });
});

/**
 * A serialized table as the settings Yarn's script generator takes. Yarn
 * writes the top level as a named root workspace (a dependency-tree root
 * located at `./`) and derives the anonymous top-level row from it.
 */
function settingsOf(state: Record<string, unknown>): unknown {
  const registry = state.packageRegistryData as Array<[string | null, Array<[string | null, Record<string, unknown>]>]>;
  const workspace = { name: "root-workspace", reference: "workspace:." };
  const information = (info: Record<string, unknown>): Record<string, unknown> => ({
    packageLocation: info.packageLocation,
    packageDependencies: new Map(info.packageDependencies as Array<[string, Target]>),
    packagePeers: new Set(),
    linkType: info.linkType,
    discardFromLookup: false,
  });
  return {
    enableTopLevelFallback: state.enableTopLevelFallback,
    fallbackExclusionList: [],
    fallbackPool: new Map(),
    ignorePattern: null,
    dependencyTreeRoots: [workspace],
    pnpZipBackend: "js",
    packageRegistry: new Map(
      registry.map(([name, references]) =>
        name === null
          ? [workspace.name, new Map([[workspace.reference, information(references[0][1])]])]
          : [name, new Map(references.map(([reference, info]) => [reference, information(info)]))]
      )
    ),
  };
}
