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

/*
 * PnpResolver against Yarn's own PnP runtime, as a conformance oracle: one
 * manifest, staged once, loaded into both, and every query enumerated from the
 * manifest asked of both. Results must be identical — values exactly, failures
 * by `pnpCode` (or node's `code` where node's algorithm failed). A deliberate
 * difference is listed in KNOWN_DIVERGENCES with its reason; anything else
 * fails.
 */

import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FileSet, IFile, MemoryFile, PACKAGE_RESOLUTION_PROVENANCE, PackageFileSet } from "@fabr-build/core";
import { type IPnpSerializedState, type ISelfPackage, pnpManifestOf, PnpDependencyTarget, TREE_MOUNT, treeMountOf } from "../PnPManifest";
import type { IPnpApi, PackageLocator, ResolveRequestOptions } from "./PnPApi";
import { PnpResolver } from "./PnPResolver";
import { resolveVirtual } from "./VirtualPath";

/** As much of `@yarnpkg/pnp` and `@yarnpkg/fslib` as the oracle uses, typed
 * here: their own declarations need a newer `@types/node` than this repo
 * pins. */
interface IYarnPnp {
  hydratePnpSource(source: string, options: { basePath: string; fakeFs: unknown; pnpapiResolution: string }): IPnpApi;
}
interface IYarnFslib {
  NodeFS: new () => unknown;
  VirtualFS: new (options: { baseFs: unknown }) => unknown;
}
/* eslint-disable-next-line @typescript-eslint/no-var-requires */
const { hydratePnpSource } = require("@yarnpkg/pnp") as IYarnPnp;
/* eslint-disable-next-line @typescript-eslint/no-var-requires */
const { NodeFS, VirtualFS } = require("@yarnpkg/fslib") as IYarnFslib;

/** One query's outcome, comparable across the two implementations. */
type Outcome = { value: unknown } | { error: string };

function outcome(ask: () => unknown): Outcome {
  try {
    return { value: normalize(ask()) };
  } catch (err: unknown) {
    const failure = err as { pnpCode?: string; code?: string };
    return { error: failure.pnpCode ?? failure.code ?? "Error" };
  }
}

/** `ask` with process warnings dropped: Yarn's runtime warns on a fallback
 * resolution, and the test environment's `emitWarning` rejects the error
 * object it is handed. */
function silenced<T>(ask: () => T): T {
  const emitWarning = process.emitWarning;
  process.emitWarning = () => undefined;
  try {
    return ask();
  } finally {
    process.emitWarning = emitWarning;
  }
}

/** Maps and Sets as sorted arrays, so deep equality compares contents. */
function normalize(value: unknown): unknown {
  if (value instanceof Map) {
    return [...value].map(([key, entry]) => [key, normalize(entry)]).sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1));
  }
  if (value instanceof Set) {
    return [...value].sort();
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, normalize(entry)])
    );
  }
  return value;
}

/**
 * A difference fabr keeps on purpose: `applies` recognizes the query (and the
 * two outcomes), `reason` says why. Adding one is a design decision.
 */
interface IKnownDivergence {
  readonly reason: string;
  applies(query: IQuery, yarn: Outcome, fabr: Outcome, both: IPair): boolean;
}

interface IQuery {
  readonly api: string;
  readonly args: unknown[];
}

const KNOWN_DIVERGENCES: IKnownDivergence[] = [
  {
    reason:
      "an issuer outside the manifest's tree is refused, where Yarn hands it to node's own node_modules search: " +
      "fabr's table is the whole world a build resolves in, and node's walk would find whatever is lying around",
    applies: (query, _yarn, fabr) =>
      (query.api === "resolveToUnqualified" || query.api === "resolveRequest") &&
      "error" in fabr &&
      fabr.error === "BUILTIN_NODE_RESOLUTION_FAILED",
  },
  {
    reason:
      "a symlinked tree pool's realpath is attributed to the row located through the link: fabr stages the pool " +
      "as one link, and a compiler that does not preserve symlinks names files by their real path",
    applies: (query, _yarn, _fabr, both) => query.args.some(arg => typeof arg === "string" && poolRealpath(both) !== undefined && arg.startsWith(poolRealpath(both)!)),
  },
  {
    reason:
      "realpath keeps a virtual location virtual by resolving the part before the virtual segment " +
      "(`<real pool>/__virtual__/<hash>/0/<tree>`) where Yarn re-derives the depth from the pool link " +
      "(`<pool>/__virtual__/<hash>/1/<real pool>/<tree>`) — the same file, and only fabr's spelling still names its row",
    applies: (query, yarn, fabr) =>
      (query.api === "resolveUnqualified" || query.api === "resolveRequest") &&
      "value" in yarn &&
      "value" in fabr &&
      typeof yarn.value === "string" &&
      typeof fabr.value === "string" &&
      fabr.value.includes("/__virtual__/") &&
      fs.realpathSync(resolveVirtual(yarn.value)) === fs.realpathSync(resolveVirtual(fabr.value)),
  },
];

/** The real path of a workspace's tree pool, where the pool is a link. */
function poolRealpath(both: IPair): string | undefined {
  const pool = path.join(both.root, TREE_MOUNT);
  const real = fs.existsSync(pool) ? fs.realpathSync(pool) : undefined;
  return real === undefined || real === pool ? undefined : `${real}/`;
}

/** Both runtimes over one staged manifest. */
interface IPair {
  readonly root: string;
  readonly state: IPnpSerializedState;
  readonly yarn: IPnpApi;
  readonly fabr: IPnpApi;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A fresh workspace, by its real path (the runtime's paths are compared as
 * strings, so a symlinked tmpdir would differ in spelling only). */
function workspace(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fabr-pnpcompat-")));
  roots.push(root);
  return root;
}

/** Load `state` into both runtimes, its files already staged under `root`. */
function pair(root: string, state: IPnpSerializedState): IPair {
  const text = JSON.stringify(state);
  const yarn = hydratePnpSource(text, {
    basePath: root,
    fakeFs: new VirtualFS({ baseFs: new NodeFS() }),
    pnpapiResolution: path.join(root, ".pnp.cjs"),
  });
  const fabr = new PnpResolver(JSON.parse(text) as IPnpSerializedState, root, []);
  return { root, state, yarn, fabr };
}

/** Ask both, and compare. Returns the mismatches rather than asserting one at
 * a time, so a run reports every divergence at once. */
function compare(both: IPair, queries: IQuery[]): string[] {
  const mismatches: string[] = [];
  for (const query of queries) {
    const call = (api: IPnpApi): unknown => (api as unknown as Record<string, (...args: unknown[]) => unknown>)[query.api](...query.args);
    const yarn = outcome(() => silenced(() => call(both.yarn)));
    const fabr = outcome(() => call(both.fabr));
    if (JSON.stringify(yarn) === JSON.stringify(fabr)) {
      continue;
    }
    if (KNOWN_DIVERGENCES.some(known => known.applies(query, yarn, fabr, both))) {
      continue;
    }
    const shown = (value: unknown): string => JSON.stringify(value)?.split(both.root).join("<root>") ?? "undefined";
    mismatches.push(`${query.api}(${query.args.map(shown).join(", ")}): yarn ${shown(yarn)}, fabr ${shown(fabr)}`);
  }
  return mismatches;
}

/** Every query the manifest suggests, over the given subpaths and requests. */
function queriesFor(both: IPair): IQuery[] {
  const { root, state } = both;
  const locations = new Set<string>();
  const names = new Set<string>(["unknown-package", "@scope/unknown"]);
  const locators: PackageLocator[] = [{ name: null, reference: null }];
  for (const [name, references] of state.packageRegistryData) {
    if (name !== null) {
      names.add(name);
    }
    for (const [reference, info] of references) {
      locations.add(path.join(root, info.packageLocation));
      if (name !== null && reference !== null) {
        locators.push({ name, reference });
      }
      for (const [dependency] of info.packageDependencies) {
        names.add(dependency);
      }
    }
  }
  for (const [name] of state.fallbackPool) {
    names.add(name);
  }
  const issuers = [...locations].flatMap(location => [
    location,
    path.join(location, "index.js"),
    path.join(location, "lib", "deep", "x.js"),
  ]);
  issuers.push(path.join(root, "src", "a.js"), path.join(path.dirname(root), "outside", "x.js"));
  const real = poolRealpath(both);
  if (real !== undefined) {
    const pool = `${path.join(root, TREE_MOUNT)}/`;
    issuers.push(...issuers.filter(issuer => issuer.startsWith(pool)).map(issuer => real + issuer.slice(pool.length)));
  }
  const requests = [...names].flatMap(name => [
    name,
    `${name}/`,
    `${name}/lib/`,
    `${name}/lib/a`,
    `${name}/lib/a.js`,
    `${name}/sub`,
    `${name}/missing`,
    `${name}/package.json`,
  ]);
  requests.push("fs", "node:fs", "./lib/a", "../x", "/abs/x", "#internal", "#dep", "#missing");
  const requestOptions: ResolveRequestOptions[] = [
    {},
    { considerBuiltins: false },
    { conditions: new Set(["import"]) },
    { conditions: new Set(["sass", "style"]), extensions: [] },
    { extensions: [".js"] },
  ];
  const queries: IQuery[] = [
    { api: "getDependencyTreeRoots", args: [] },
    { api: "getAllLocators", args: [] },
    ...locators.map(locator => ({ api: "getPackageInformation", args: [locator] })),
    { api: "getPackageInformation", args: [{ name: "unknown-package", reference: "nothing" }] },
    ...issuers.map(issuer => ({ api: "findPackageLocator", args: [issuer] })),
    ...issuers.map(issuer => ({ api: "resolveVirtual", args: [issuer] })),
  ];
  for (const issuer of issuers) {
    for (const request of requests) {
      if (!request.startsWith("#")) {
        queries.push({ api: "resolveToUnqualified", args: [request, issuer] });
        queries.push({ api: "resolveToUnqualified", args: [request, issuer, { considerBuiltins: false }] });
      }
      for (const options of requestOptions) {
        queries.push({ api: "resolveRequest", args: [request, issuer, options] });
      }
    }
  }
  for (const location of locations) {
    for (const suffix of ["", "index", "index.js", "lib/a", "sub", "missing"]) {
      queries.push({ api: "resolveUnqualified", args: [path.join(location, suffix)] });
      queries.push({ api: "resolveUnqualified", args: [path.join(location, suffix), { extensions: [".json"] }] });
    }
  }
  return queries;
}

/** The files a fixture package carries, with its own manifest fields. */
function packageFiles(name: string, version: string, fields: Record<string, unknown> = {}): Map<string, string> {
  return new Map([
    ["package.json", JSON.stringify({ name, version, ...fields })],
    ["index.js", `module.exports = ${JSON.stringify(`${name}@${version}`)};\n`],
    ["lib/a.js", "module.exports = 'a';\n"],
    ["lib/b.json", "{}\n"],
    ["lib/deep/x.js", "module.exports = 'x';\n"],
    ["sub/index.js", "module.exports = 'sub';\n"],
    ["_partial.scss", "a { b: c }\n"],
    ["features/f.js", "module.exports = 'f';\n"],
  ]);
}

/** Write files at a (possibly virtual) location's physical directory. */
function writeAt(root: string, location: string, files: Map<string, string>): void {
  const directory = resolveVirtual(path.join(root, location));
  for (const [name, content] of files) {
    fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    fs.writeFileSync(path.join(directory, name), content);
  }
}

type Row = [string | null, string | null, string, Array<[string, PnpDependencyTarget]>, Partial<{ soft: boolean; discard: boolean; peers: string[] }>?];

/** A hand-written manifest: rows as `[name, reference, location, deps, flags]`,
 * each HARD row staged with its fixture files. */
function handWritten(
  root: string,
  rows: Row[],
  extra: Partial<Pick<IPnpSerializedState, "fallbackPool" | "fallbackExclusionList" | "enableTopLevelFallback">> = {},
  fields: Map<string, Record<string, unknown>> = new Map()
): IPnpSerializedState {
  const registry = new Map<string | null, Array<[string | null, IPnpSerializedState["packageRegistryData"][0][1][0][1]]>>();
  for (const [name, reference, location, dependencies, flags] of rows) {
    const held = registry.get(name) ?? [];
    registry.set(name, held);
    held.push([
      reference,
      {
        packageLocation: location,
        packageDependencies: dependencies,
        linkType: flags?.soft === true || name === null ? "SOFT" : "HARD",
        ...(flags?.discard === true ? { discardFromLookup: true } : {}),
        ...(flags?.peers ? { packagePeers: flags.peers } : {}),
      },
    ]);
    if (name !== null && flags?.soft !== true) {
      writeAt(root, location, packageFiles(name, "1.0.0", fields.get(`${name}#${reference}`) ?? {}));
    }
  }
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.js"), "");
  return {
    __info: [],
    dependencyTreeRoots: [],
    enableTopLevelFallback: extra.enableTopLevelFallback ?? true,
    ignorePatternData: null,
    fallbackExclusionList: extra.fallbackExclusionList ?? [],
    fallbackPool: extra.fallbackPool ?? [],
    packageRegistryData: [...registry],
  };
}

/** Stage fabr's own manifest for a delivered graph: each content's physical
 * tree once, where its rows' locations resolve. */
function generated(root: string, roots: FileSet[], self?: ISelfPackage, linkedPool = false): IPnpSerializedState {
  const manifest = pnpManifestOf(roots, self);
  if (linkedPool) {
    fs.mkdirSync(path.join(root, "store"));
    fs.symlinkSync(path.join(root, "store"), path.join(root, TREE_MOUNT));
  }
  for (const pkg of manifest.packages) {
    const files = new Map<string, string>();
    for (const [name, file] of pkg as FileSet) {
      files.set(name, ((file as MemoryFile).getBuffer().value as Buffer).toString("utf8"));
    }
    writeAt(root, manifest.mountOf(pkg), files);
  }
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.js"), "");
  return manifest.state;
}

/** A delivered package with the fixture files. */
function delivered(name: string, version: string, deps: PackageFileSet[] = [], fields: Record<string, unknown> = {}): PackageFileSet {
  const files = new Map<string, IFile>([...packageFiles(name, version, fields)].map(([file, text]) => [file, MemoryFile.from(text)]));
  return new PackageFileSet(files, name, version, deps).withOrigin({ kind: PACKAGE_RESOLUTION_PROVENANCE });
}

function expectConformant(both: IPair): void {
  expect(compare(both, queriesFor(both))).to.deep.equal([]);
}

describe("PnpResolver conforms to Yarn's PnP runtime", () => {
  describe("over hand-written manifests", () => {
    it("answers own bindings, aliases, peers and the fallback pool", () => {
      const root = workspace();
      const state = handWritten(
        root,
        [
          [null, null, "./", [["app", "1"], ["alias", ["real", "1"]], ["pooled", "1"]]],
          ["app", "1", "./pkgs/app/", [["app", "1"], ["dep", "1"], ["peer", null], ["alias", ["real", "1"]]]],
          ["dep", "1", "./pkgs/dep/", [["dep", "1"]]],
          ["real", "1", "./pkgs/real/", [["real", "1"]]],
          ["pooled", "1", "./pkgs/pooled/", [["pooled", "1"]]],
          ["loner", "1", "./pkgs/loner/", [["loner", "1"]]],
          ["peer", "1", "./pkgs/peer/", [["peer", "1"]]],
        ],
        { fallbackPool: [["pooled", "1"], ["peer", "1"]], fallbackExclusionList: [["loner", ["1"]]] }
      );
      expectConformant(pair(root, state));
    });

    it("answers with the top-level fallback disabled", () => {
      const root = workspace();
      const state = handWritten(
        root,
        [
          [null, null, "./", [["app", "1"]]],
          ["app", "1", "./pkgs/app/", [["app", "1"]]],
        ],
        { enableTopLevelFallback: false, fallbackPool: [["app", "1"]] }
      );
      expectConformant(pair(root, state));
    });

    it("answers nested package locations, discarded rows and named soft rows", () => {
      const root = workspace();
      const state = handWritten(root, [
        [null, null, "./", [["outer", "1"], ["ws", "1"]]],
        ["outer", "1", "./pkgs/outer/", [["outer", "1"], ["inner", "1"]]],
        ["inner", "1", "./pkgs/outer/lib/inner/", [["inner", "1"]]],
        ["hidden", "1", "./pkgs/hidden/", [["hidden", "1"]], { discard: true }],
        ["ws", "1", "./src/", [["ws", "1"], ["outer", "1"]], { soft: true }],
      ]);
      expectConformant(pair(root, state));
    });

    it("answers exports and imports maps under every condition set", () => {
      const root = workspace();
      const fields = new Map<string, Record<string, unknown>>([
        ["patterned#1", { exports: { ".": "./index.js", "./lib/*": "./lib/*.js", "./sub": null } }],
        ["conditional#1", { exports: { ".": { import: "./lib/a.js", require: "./index.js", default: "./index.js" } } }],
        ["styled#1", { exports: { ".": { sass: "./_partial.scss", default: "./index.js" }, "./package.json": "./package.json" } }],
        ["fallback#1", { exports: { ".": ["./nope.js", "./index.js"] } }],
        ["mixed#1", { exports: { ".": "./index.js", import: "./lib/a.js" } }],
        ["slashed#1", { exports: { "./features/": "./features/" } }],
        ["mains#1", { main: "./lib/a" }],
        ["importing#1", { imports: { "#internal": "./lib/a.js", "#dep": "dep" } }],
      ]);
      const names = [...fields.keys()].map(key => key.split("#")[0]);
      const state = handWritten(
        root,
        [
          [null, null, "./", names.map((name): [string, string] => [name, "1"])],
          ...names.map((name): Row => [name, "1", `./pkgs/${name}/`, [[name, "1"], ["dep", "1"]]]),
          ["dep", "1", "./pkgs/dep/", [["dep", "1"]]],
        ],
        {},
        fields
      );
      /* A nested package.json scopes the files below it: `#internal` from
       * `lib/deep/x.js` is answered by `lib/`'s map, not the package root's. */
      fs.writeFileSync(path.join(root, "pkgs/importing/lib/package.json"), JSON.stringify({ imports: { "#internal": "./deep/x.js" } }));
      expectConformant(pair(root, state));
    });
  });

  describe("over fabr's own manifests", () => {
    it("answers a graph with aliases and a self row", () => {
      const root = workspace();
      const real = delivered("stream-browserify", "3.0.0");
      const user = delivered("user", "1.0.0", [real.withPackageName("stream"), delivered("leaf", "1.0.0")]);
      const state = generated(root, [user, real], { name: "self-pkg", location: "./src/" });
      expectConformant(pair(root, state));
    });

    it("answers one content wired two ways through its virtual locations", () => {
      const root = workspace();
      const shared = (dep: PackageFileSet): PackageFileSet =>
        new PackageFileSet(new Map([...delivered("shared", "1.0.0")]), "shared", "1.0.0", [dep]).withOrigin({
          kind: PACKAGE_RESOLUTION_PROVENANCE,
        });
      const left = delivered("left", "1.0.0", [shared(delivered("dep", "1.0.0"))]);
      const right = delivered("right", "1.0.0", [shared(delivered("dep", "2.0.0"))]);
      const state = generated(root, [left, right]);
      expectConformant(pair(root, state));
    });

    it("answers through a linked tree pool, as fabr stages one", () => {
      const root = workspace();
      const shared = (dep: PackageFileSet): PackageFileSet =>
        new PackageFileSet(new Map([...delivered("shared", "1.0.0")]), "shared", "1.0.0", [dep]).withOrigin({
          kind: PACKAGE_RESOLUTION_PROVENANCE,
        });
      const left = delivered("left", "1.0.0", [shared(delivered("dep", "1.0.0"))]);
      const right = delivered("right", "1.0.0", [shared(delivered("dep", "2.0.0"))]);
      const state = generated(root, [left, right], undefined, true);
      expectConformant(pair(root, state));
      /* And fabr's realpath spelling of a virtual file still names its row. */
      const resolver = new PnpResolver(state, root, []);
      const wiring = left.packages[0];
      const file = resolver.resolveRequest("shared/index.js", path.join(root, treeMountOf(left), "index.js"));
      expect(file).to.equal(path.join(root, "store", "__virtual__", file!.split("/__virtual__/")[1]));
      expect(resolver.findPackageLocator(file!)).to.deep.equal({ name: "shared", reference: resolver.findPackageLocator(path.join(root, pnpManifestOf([left, right]).mountOf(wiring)))!.reference });
    });

    it("answers seeded random graphs", () => {
      for (let seed = 1; seed <= 12; seed++) {
        const root = workspace();
        const state = generated(root, randomGraph(seed));
        const mismatches = compare(pair(root, state), queriesFor(pair(root, state)));
        expect(mismatches, `seed ${seed}`).to.deep.equal([]);
      }
    });
  });
});

/**
 * A small delivered graph from `seed`: a few names at a few versions, random
 * acyclic edges, the occasional alias, and one content wired two ways.
 */
function randomGraph(seed: number): PackageFileSet[] {
  let state = seed;
  const next = (bound: number): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % bound;
  };
  const names = ["a", "b", "@s/c", "d", "e"];
  const built: PackageFileSet[] = [];
  for (let index = 0; index < 8; index++) {
    const name = names[next(names.length)];
    const version = `${1 + next(2)}.0.0`;
    const candidates = built.filter(pkg => pkg.packageName !== name);
    const deps: PackageFileSet[] = [];
    for (let edge = next(3); edge > 0 && candidates.length > 0; edge--) {
      const dep = candidates[next(candidates.length)];
      if (!deps.some(held => held.packageName === dep.packageName)) {
        deps.push(next(5) === 0 ? dep.withPackageName(`${dep.packageName.replace("@s/", "")}-alias`) : dep);
      }
    }
    const fields = next(3) === 0 ? { exports: { ".": "./index.js", "./lib/*": "./lib/*.js" } } : {};
    const exists = built.find(pkg => pkg.packageName === name && pkg.version === version);
    built.push(
      exists !== undefined
        ? new PackageFileSet(new Map([...exists]), name, version, deps).withOrigin({ kind: PACKAGE_RESOLUTION_PROVENANCE })
        : delivered(name, version, deps, fields)
    );
  }
  return built.slice(-3);
}
