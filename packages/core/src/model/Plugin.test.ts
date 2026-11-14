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
import { pathToFileURL } from "url";
import {
  coreVersionError,
  hostCoreResolver,
  implementationLoader,
  matchOptionalLibs,
  PluginPackage,
  resolvePackageFrom,
  resolvePlugin,
  toPluginLibs,
} from "./Plugin";
import { BuildCache } from "../core/BuildCache";
import { MemoryFile } from "../core/MemoryFS";
import { Name } from "../core/Name";
import { RunnableFileSet } from "../core/RunnableFileSet";
import { SymlinkFile } from "../core/SymlinkFile";
import { DeclKind, IPluginDecl } from "./AST";
import type { BuildModel } from "./BuildModel";
import { Constraints } from "./Constraints";
import { ExecutionContext } from "./ExecutionContext";
import { LogFormatter, LogLevel } from "../support/Log";
import { INameValue, syntheticValue } from "./AST";
import { parseName } from "./Parser";
import { EMPTY_FILESET, FileSet, IFile } from "../core/FileSet";
import { StringReader } from "../support/StringReader";
import { Computable } from "../core/Computable";

/* A name of no significance to either test runner's module resolution — jest
 * maps `@fabr-build/core` itself by name, so the resolution rules are exercised
 * through a package it doesn't intercept. */
const SHARED = "@test/shared";

/** Write a resolvable package under `root`, and @return its directory. */
function writePackage(root: string, name: string): string {
  const dir = path.join(root, "node_modules", ...name.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, main: "index.js" }));
  fs.writeFileSync(path.join(dir, "index.js"), "module.exports = {};");
  return dir;
}

describe("plugin package resolution", () => {
  let dir: string;

  beforeEach(() => {
    /* Realpath up front: on darwin os.tmpdir() is itself symlinked, and every
     * resolution below is compared as a realpath. */
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fabr-plugin-")));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("finds a copy hoisted above the consumer", () => {
    const consumer = writePackage(dir, "@test/plugin");
    const shared = writePackage(dir, SHARED);
    expect(resolvePackageFrom(SHARED, consumer)).to.equal(path.join(shared, "index.js"));
  });

  it("finds a consumer's own nested copy in preference to a hoisted one", () => {
    const consumer = writePackage(dir, "@test/plugin");
    writePackage(dir, SHARED);
    const nested = writePackage(consumer, SHARED);
    expect(resolvePackageFrom(SHARED, consumer)).to.equal(path.join(nested, "index.js"));
  });

  it("reads a symlinked copy as the one package it points at", () => {
    const consumer = writePackage(dir, "@test/plugin");
    const real = writePackage(path.join(dir, "elsewhere"), SHARED);
    const link = path.join(dir, "node_modules", ...SHARED.split("/"));
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(real, link, "dir");
    expect(resolvePackageFrom(SHARED, consumer)).to.equal(path.join(real, "index.js"));
  });

  it("resolves nothing when there is no copy to find", () => {
    const consumer = writePackage(dir, "@test/plugin");
    expect(resolvePackageFrom(SHARED, consumer)).to.equal(undefined);
  });
});

describe("the host's core, for plugins", () => {
  const HOST = "/host/node_modules/@fabr-build/core/index.js";

  it("answers a request for core with the host's copy, and passes every other on", () => {
    const asked: string[] = [];
    const resolve = hostCoreResolver(HOST);
    const next = (specifier: string): { url: string } => {
      asked.push(specifier);
      return { url: `file:///elsewhere/${specifier}` };
    };
    const context = { conditions: [], importAttributes: {}, parentURL: undefined };
    expect(resolve("@fabr-build/core", context, next)).to.deep.equal({
      url: pathToFileURL(HOST).href,
      format: "commonjs",
      shortCircuit: true,
    });
    expect(resolve("sax", context, next)).to.deep.equal({ url: "file:///elsewhere/sax" });
    expect(asked).to.deep.equal(["sax"]);
  });

  it("refuses a plugin whose declared range for core excludes the host's version", () => {
    const err = coreVersionError("@test/plugin", "0.3.1", "0.4.0");
    expect(err?.message).to.equal("Plugin '@test/plugin' requires @fabr-build/core 0.3.1, but this fabr's is 0.4.0");
    expect(coreVersionError("@test/plugin", "^0.3.0", "0.3.4")).to.equal(undefined);
  });

  it("accepts a plugin or host that states no version", () => {
    expect(coreVersionError("@test/plugin", undefined, "0.4.0")).to.equal(undefined);
    expect(coreVersionError("@test/plugin", "0.3.1", undefined)).to.equal(undefined);
  });
});

describe("implementations a declaration names", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fabr-implementation-")));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Write a package `name` exporting `rules/*` from `lib/`, and @return its manifest. */
  function writeExporting(name: string): string {
    const root = path.join(dir, "node_modules", ...name.split("/"));
    fs.mkdirSync(path.join(root, "lib"), { recursive: true });
    const manifest = path.join(root, "package.json");
    fs.writeFileSync(manifest, JSON.stringify({ name, exports: { "./rules/*": "./lib/*.js" } }));
    fs.writeFileSync(path.join(root, "lib", "Thing.js"), "exports.default = { from: __filename };");
    fs.writeFileSync(path.join(root, "lib", "Bare.js"), "exports.other = 1;");
    return manifest;
  }

  const reference = (written: string): INameValue =>
    syntheticValue(parseName(written), { fs: EMPTY_FILESET, file: "TEST.fabr", reader: new StringReader(written) }, 0, written.length);

  /** @return a package's `package.json` as a plugin's that is in hand. */
  const inHand = (manifest: string) => (): Computable<string> => Computable.resolve(manifest);

  it("loads an entry through the package's own exports, under the name the project uses for it", async () => {
    const manifest = writeExporting("@test/plugin");
    const load = implementationLoader(new Map([["@test/alias", inHand(manifest)]]));
    expect(await load(reference("@test/alias:rules/Thing"))).to.deep.equal({
      from: path.join(path.dirname(manifest), "lib", "Thing.js"),
    });
  });

  it("refuses a package the project does not use, and an entry with no default export", async () => {
    const load = implementationLoader(new Map([["@test/plugin", inHand(writeExporting("@test/plugin"))]]));
    const failure = (written: string): Computable<string> =>
      load(reference(written)).then(
        () => "loaded",
        (err: Error) => err.message
      );
    expect(await failure("@test/other:rules/Thing")).to.match(
      /'@test\/other' is neither @fabr-build\/core nor a plugin this project uses/
    );
    expect(await failure("@test/plugin:rules/Bare")).to.match(/'@test\/plugin:rules\/Bare' has no default export/);
  });
});

describe("a plugin's package.json", () => {
  it("lists its .fabr files as a path or a list of them", () => {
    expect(toPluginLibs({ libs: "lib/JS.fabr" })).to.deep.equal({ libs: ["lib/JS.fabr"], optionalLibs: [] });
    expect(toPluginLibs({ libs: ["lib/A.fabr", "lib/B.fabr"] })).to.deep.equal({
      libs: ["lib/A.fabr", "lib/B.fabr"],
      optionalLibs: [],
    });
    expect(toPluginLibs({})).to.deep.equal({ libs: [], optionalLibs: [] });
  });

  it("lists its optional libs likewise", () => {
    expect(toPluginLibs({ libs: "lib/A.fabr", optional_libs: ["lib/b.fabr", "lib/c.fabr"] })).to.deep.equal({
      libs: ["lib/A.fabr"],
      optionalLibs: ["lib/b.fabr", "lib/c.fabr"],
    });
  });

  it("refuses libs that are not paths", () => {
    expect(() => toPluginLibs({ libs: [1] })).to.throw(/"@fabr-build\/plugin".libs is not a path or a list of them/);
    expect(() => toPluginLibs({ optional_libs: {} })).to.throw(/"@fabr-build\/plugin".optional_libs is not a path or a list of them/);
    expect(() => toPluginLibs("lib/JS.fabr")).to.throw();
  });
});

describe("a plugin's optional libs", () => {
  const plugin: PluginPackage = {
    name: "@test/plugin",
    files: [],
    optionalLibs: [
      { name: "lib/b.fabr", file: "/p/lib/b.fabr" },
      { name: "lib/a.fabr", file: "/p/lib/a.fabr" },
      { name: "extra/c.fabr", file: "/p/extra/c.fabr" },
    ],
    code: () => Computable.resolve("/p/package.json"),
  };
  const match = (written: string): string[] => matchOptionalLibs(plugin, parseName(written));

  it("names one by its path within the package", () => {
    expect(match("lib/a.fabr")).to.deep.equal(["/p/lib/a.fabr"]);
    expect(match("./lib/a.fabr")).to.deep.equal(["/p/lib/a.fabr"]);
  });

  it("names every one a pattern matches, in canonical order", () => {
    expect(match("lib/*.fabr")).to.deep.equal(["/p/lib/a.fabr", "/p/lib/b.fabr"]);
    expect(match("**/*.fabr")).to.deep.equal(["/p/extra/c.fabr", "/p/lib/a.fabr", "/p/lib/b.fabr"]);
  });

  it("names nothing it does not list", () => {
    expect(match("lib/d.fabr")).to.deep.equal([]);
  });
});

describe("a plugin made as a program", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-plugin-program-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reads its .fabr files from the package the program installs, behind its link", async () => {
    /* As a node_modules install lays a package out: its files in an
     * instance directory, linked from `node_modules/<name>`. */
    const manifest = JSON.stringify({ name: "@acme/greeter", "@fabr-build/plugin": { libs: ["lib/GREET.fabr"] } });
    const lib = MemoryFile.from("default greeting = hi;\n");
    const install = new FileSet(
      new Map<string, IFile>([
        ["node_modules/.fabr/greeter/package.json", MemoryFile.from(manifest)],
        ["node_modules/.fabr/greeter/lib/GREET.fabr", lib],
        ["node_modules/@acme/greeter", new SymlinkFile("../.fabr/greeter")],
      ])
    );
    const surface = new FileSet(
      new Map<string, IFile>([
        ["package.json", MemoryFile.from(manifest)],
        ["lib/GREET.fabr", lib],
      ])
    );
    const program = new RunnableFileSet(install, [], undefined, "node_modules/@acme/greeter", surface);
    const log = new LogFormatter(LogLevel.Info, () => undefined);
    const execution = new ExecutionContext(new BuildCache(root, log), log, EMPTY_FILESET, EMPTY_FILESET);
    const model = { getConfig: () => ({ materialize: () => Computable.resolve([program]) }) } as unknown as BuildModel;
    const source = { fs: EMPTY_FILESET, file: "PROJECT.fabr", reader: new StringReader("plugin greeter;") };
    const decl: IPluginDecl = { kind: DeclKind.Plugin, source, offset: 7, endOffset: 14, name: parseName("greeter") };
    const match = {
      decl: { kind: DeclKind.Property, decls: [], defaults: [] },
      name: "greeter",
      retainedPrefix: "",
      rest: Name.fromLiteral(""),
    };
    const resolution = await new Promise<Awaited<ReturnType<typeof resolvePlugin>>>((resolve, reject) =>
      resolvePlugin(model, decl, match as never, {
        execution,
        host: Constraints.of({}),
        libsOf: () => Computable.reject(new Error("not a fabr_plugin")),
      }).then(resolve, reject)
    );
    const plugin = resolution.resolved as PluginPackage;
    expect(plugin, String(resolution.resolved)).to.not.be.instanceOf(Error);
    expect(plugin.files).to.deep.equal(["@acme/greeter:lib/GREET.fabr"]);
    expect(plugin.contents?.getFile("@acme/greeter/lib/GREET.fabr")).to.equal(lib);
  });
});
