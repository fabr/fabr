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
import {
  ActionContext,
  BuildAction,
  BuildCache,
  Computable,
  FileSet,
  IBuildState,
  IFile,
  Log,
  MemoryFile,
  PackageFileSet,
  PackageGraphBuilder,
  Semaphore,
  SILENT_REPORT,
  manifestFileInputs,
  reachablePackages,
} from "@fabr-build/core";
import { assembleNodeModules, assembleScopedNodeModules } from "./JSPackage";
import { createNodeExecAction, FLAT, NODE_EXEC_ACTION, PNP, SCOPED } from "./NodeExecAction";
import { pnpManifestOf, referenceOf } from "./PnPManifest";
import {
  CHANGES_FILE,
  CHANGES_FLAG,
  DEPS_REPORT_FILE,
  DEPS_REPORT_FLAG,
  IResolutionEdge,
  STATE_DIR,
  STATE_DIR_FLAG,
} from "./pnp/ReadSet";

const NULL_LOG: Log = { log: () => undefined };

/** A funnel capacity no case can reach, so nothing here ever waits for a slot. */
const UNBOUNDED = 1024;

function toPromise<T>(computable: Computable<T>): Promise<T> {
  return new Promise((resolve, reject) => computable.then(resolve, reject));
}

/** A package at a version, its one file naming it — the layout fixture, where
 * what varies between packages is the version. */
function pkg(name: string, version = "1.0.0", deps: PackageFileSet[] = []): PackageFileSet {
  return new PackageFileSet(new Map<string, IFile>([["index.js", MemoryFile.from(`// ${name}@${version}`)]]), name, version, deps);
}

/** A package as something to RESOLVE and READ: typings plus a manifest, at one
 * version, its declarations' content the thing that varies. Kept apart from
 * {@link pkg} deliberately — the discovery cases turn on a read file's bytes
 * moving under an unchanged version, which is the opposite axis. */
function declPkg(name: string, content = "1", deps: PackageFileSet[] = []): PackageFileSet {
  return new PackageFileSet(
    new Map<string, IFile>([
      ["index.d.ts", MemoryFile.from(`// ${name} ${content}\n`)],
      ["package.json", MemoryFile.from(`{"name":"${name}","version":"1.0.0"}\n`)],
    ]),
    name,
    "1.0.0",
    deps
  );
}

/** A package's instance name, as the read report spells it. */
function instanceOf(pkg: PackageFileSet): string {
  return `${pkg.packageName}#${referenceOf(pkg)}`;
}

/** A delivered graph from a `{ "name@version": { alias: "dep@version" } }`
 * sketch, cycles included — the shape `declPkg` cannot build, since a cyclic
 * graph has to be wired after its nodes exist. */
function delivered(
  graph: Record<string, Record<string, string>>,
  rootId: string,
  content: (id: string) => string = id => id
): PackageFileSet {
  const builder = new PackageGraphBuilder();
  const nodes = new Map<string, PackageFileSet>();
  for (const id of Object.keys(graph)) {
    const [name, version] = id.split("@");
    nodes.set(id, builder.node(new Map<string, IFile>([["index.js", MemoryFile.from(`// ${content(id)}\n`)]]), name, version));
  }
  for (const [id, deps] of Object.entries(graph)) {
    builder.wire(
      nodes.get(id)!,
      Object.values(deps).map(dep => nodes.get(dep)!)
    );
  }
  builder.seal();
  return nodes.get(rootId)!;
}

/**
 * The cache seam a step is run against here.
 *
 * Nothing is reported (output is swallowed, as `-q` would) and the funnel is
 * wide enough never to queue: these tests are about layout and keying. No
 * target key, so a step asking for a build state is told there is none.
 */
function actionContext(cache: BuildCache, workDir: string): ActionContext {
  return new ActionContext(cache, new Semaphore(UNBOUNDED), workDir);
}

/** What the tool reported about the workspace it was run in. */
interface IObserved {
  listing: string[];
  /** Where `.fabr-tree` really points, when the step staged one. */
  pool?: string;
  /** The staged dependency table, when there is one. */
  table?: { packageRegistryData: Array<[string | null, Array<[string | null, { packageLocation: string; linkType: string }]>]> };
  /** Which of the table's rows resolve to a real directory from where the tool
   * stood — the only question the table and the mount jointly answer. */
  resolves?: Record<string, boolean>;
}

/**
 * Run an action for real, in a work dir, with the cache seam the step needs.
 *
 * The "tool" reports the workspace from INSIDE the run rather than the test
 * inspecting it afterwards, because output collection sweeps the work dir of
 * everything the action did not declare — so what is asserted is what the tool
 * was actually given, which is the only thing that matters.
 */
async function run(action: BuildAction, root: string): Promise<{ observed: IObserved; cache: BuildCache }> {
  const cache = new BuildCache(path.join(root, "cache"), NULL_LOG);
  const workDir = fs.mkdtempSync(path.join(root, "work-"));
  const collected = (await toPromise(action.step.run(action, actionContext(cache, workDir), SILENT_REPORT))).result;
  const report = await toPromise(collected.readFile("observed.json"));
  return { observed: JSON.parse(report) as IObserved, cache };
}

/**
 * The tool: walk everything staged (following the pool link one level, to see
 * that a package's files are really there), and write the report as the
 * action's single collected output.
 */
const OBSERVE = `const fs = require("fs"), path = require("path");
const listing = [];
const walk = (dir, base) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = base + entry.name;
    if (name === "out") continue;
    listing.push(entry.isDirectory() ? name + "/" : name);
    if (entry.isDirectory()) walk(path.join(dir, entry.name), name + "/");
  }
};
walk(".", "");
const observed = { listing };
if (fs.existsSync(".fabr-tree")) observed.pool = fs.realpathSync(".fabr-tree");
if (fs.existsSync(".pnp.data.json")) {
  observed.table = JSON.parse(fs.readFileSync(".pnp.data.json", "utf8"));
  observed.resolves = {};
  for (const [name, rows] of observed.table.packageRegistryData) {
    if (name !== null) observed.resolves[name] = fs.existsSync(path.join(rows[0][1].packageLocation, "index.js"));
  }
}
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/observed.json", JSON.stringify(observed));
`;
/* `process.execPath`, not "node": `fabr test` runs a suite with a clean env, so
 * there is no PATH for a bare command to be found on. */
const TOOL = [process.execPath, "-e", OBSERVE];

describe("createNodeExecAction layouts", () => {
  let root: string;

  beforeEach(() => {
    /* One temp root holding both the cache and the work dir: a tree's files are
     * hardlinked out of the blob pool, so they must share a filesystem. */
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-nodeexec-test-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const sources = new FileSet(new Map<string, IFile>([["src/index.ts", MemoryFile.from("export const x = 1;")]]));

  it("pnp: stages a table and one pool mount, and no node_modules", async () => {
    const dep = pkg("left-pad", "1.0.0", [pkg("b4a")]);
    const { observed, cache } = await run(
      createNodeExecAction(sources, [dep], TOOL, "out:**", { layout: PNP, label: "compile" }),
      root
    );
    expect(observed.listing).to.not.include("node_modules/");
    expect(observed.listing).to.include(".pnp.data.json");
    /* One symlink to the pool, and every package the table names materialized
     * in it — by the step, on this miss, not by the rule at evaluate. */
    expect(observed.pool).to.equal(fs.realpathSync(cache.treePath));
    expect(fs.readdirSync(cache.treePath)).to.have.lengthOf(2);
    /* Every row resolves from where the tool stood: the table and the mount
     * agree, which is the whole of what this arm owes its tool. */
    expect(observed.resolves).to.deep.equal({ "left-pad": true, b4a: true });
  });

  it("pnp: gives the staged sources their own row when they are a package", async () => {
    const { observed } = await run(
      createNodeExecAction(sources, [pkg("left-pad")], TOOL, "out:**", {
        layout: PNP,
        self: { name: "mylib", location: "./src/" },
      }),
      root
    );
    const self = observed.table!.packageRegistryData.find(([name]) => name === "mylib");
    expect(self?.[1][0][1].packageLocation).to.equal("./src/");
    /* SOFT, like the top-level row: a place in this build, not a materialized
     * package (which is what keeps it out of the pool-facing queries). */
    expect(self?.[1][0][1].linkType).to.equal("SOFT");
  });

  it("flat: hoists every package at the mount point", async () => {
    const { observed } = await run(
      createNodeExecAction(sources, [pkg("left-pad", "1.0.0", [pkg("b4a")])], TOOL, "out:**", { layout: FLAT }),
      root
    );
    expect(observed.listing).to.include("node_modules/left-pad/index.js");
    /* Transitives visible — the permissive arrangement, which is the point of
     * this one. */
    expect(observed.listing).to.include("node_modules/b4a/index.js");
    expect(observed.listing).to.not.include(".pnp.data.json");
  });

  it("scoped: exposes only the direct deps, the closure behind them", async () => {
    const { observed } = await run(
      createNodeExecAction(sources, [pkg("left-pad", "1.0.0", [pkg("b4a")])], TOOL, "out:**", { layout: SCOPED }),
      root
    );
    /* The direct dep is a link into the hidden area; the transitive one is not
     * reachable from the top level at all. */
    expect(observed.listing).to.include("node_modules/left-pad");
    expect(observed.listing).to.not.include("node_modules/b4a");
    expect(observed.listing).to.include("node_modules/.pkgs/node_modules/b4a/index.js");
  });

  it("keys the layout, so one arrangement is never served for another", () => {
    const deps = [pkg("left-pad")];
    const key = (layout: typeof PNP | typeof FLAT | typeof SCOPED): unknown =>
      createNodeExecAction(sources, deps, TOOL, "out:**", { layout }).options.layout;
    expect(new Set([key(PNP), key(FLAT), key(SCOPED)]).size).to.equal(3);
  });
});

/**
 * Whether the step went to the build-state record at all — the read the context
 * defers until a step asks for it.
 */
class CountingCache extends BuildCache {
  public stateReads = 0;

  public readBuildState(targetKey: string): Computable<IBuildState | undefined> {
    this.stateReads++;
    return super.readBuildState(targetKey);
  }
}

describe("the js exec step's build state", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-node-state-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A tool that only produces the output its action collects. */
  const TOUCH = `const fs = require("fs"); fs.mkdirSync("out", { recursive: true }); fs.writeFileSync("out/x.js", "");`;

  /** Run one action against a target key that HAS a record to read, and answer
   * how many times the step went looking for it. */
  async function stateReads(options: Parameters<typeof createNodeExecAction>[4]): Promise<number> {
    const cache = new CountingCache(path.join(root, "cache"), NULL_LOG);
    const workDir = fs.mkdtempSync(path.join(root, "work-"));
    const built = createNodeExecAction(
      FileSet.layout({ "tool.js": MemoryFile.from(TOUCH) }),
      [pkg("left-pad")],
      [process.execPath, "tool.js"],
      "out:**",
      options
    );
    const context = new ActionContext(cache, new Semaphore(UNBOUNDED), workDir, "target-key-for-state", false);
    await toPromise(NODE_EXEC_ACTION.run(built, context, SILENT_REPORT));
    return cache.stateReads;
  }

  it("goes unread by a layout that cannot compile incrementally", async () => {
    /* The record is only ever of use to the incremental pnp arm, so no other
     * arm may pay for reading it. */
    expect(await stateReads({ layout: FLAT }), "flat").to.equal(0);
    expect(await stateReads({ layout: SCOPED }), "scoped").to.equal(0);
    expect(await stateReads({ layout: PNP }), "pnp, but not incremental").to.equal(0);
  });

  it("is read once by an incremental pnp compile, however many accessors it asks", async () => {
    /* The contrast that keeps the case above from passing vacuously — and the
     * coherence pin: this compile asks for all four of `lastInputs`,
     * `lastDiscovered`, `incrementalState` and `previousOutputs`, and they must
     * describe ONE build, so they answer from one memoized read rather than
     * four. */
    expect(await stateReads({ layout: PNP, depsReport: DEPS_REPORT_FILE, stateDir: STATE_DIR, changes: CHANGES_FILE })).to.equal(1);
  });

  /** The target key these carry a record forward under. */
  const RECORD_KEY = "target-key-for-record";

  /**
   * A tool that keeps `kept` files of its own: it reports what it was handed
   * back and what fabr's diff said, then writes a fresh generation of each kept
   * file — OVER the previous one, which is what makes the writable-copy staging
   * observable rather than assumed.
   *
   * A stub rather than the real driver on purpose: what these pin is fabr's
   * half of a swappable contract, so the tool must be free to keep two files,
   * or none, which the shipped driver never does.
   */
  function stateTool(kept: string[]): string {
    return `const fs = require("fs"), path = require("path");
const arg = flag => { const at = process.argv.indexOf(flag); return at < 0 ? undefined : process.argv[at + 1]; };
const dir = arg("--state-dir");
const walk = (at, base) => fs.existsSync(at) ? fs.readdirSync(at, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(path.join(at, entry.name), base + entry.name + "/") : [base + entry.name]) : [];
const seen = walk(dir, "").sort();
/* The change lists are named on every invocation; whether the FILE is there is
 * what says there was a base to diff. */
const changes = arg("--changes");
const hasChanges = changes !== undefined && fs.existsSync(changes);
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/seen.json", JSON.stringify({
  seen,
  handed: Object.fromEntries(seen.map(name => [name, fs.readFileSync(path.join(dir, name), "utf8")])),
  changes: hasChanges ? JSON.parse(fs.readFileSync(changes, "utf8")).changed : null,
}));
/* Reporting is a capability of its own: this tool reports only where it was
 * told to, and keeps its state either way. */
const reportPath = arg("--deps-report");
if (reportPath !== undefined) fs.writeFileSync(reportPath, JSON.stringify({ reads: [], edges: [] }));
for (const name of ${JSON.stringify(kept)}) {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), "v" + seen.length);
}
`;
  }

  /** What {@link stateTool} reported about the run it was given. */
  interface ISeen {
    seen: string[];
    handed: Record<string, string>;
    changes: string[] | null;
  }

  /**
   * One build of {@link stateTool} against {@link RECORD_KEY}, through the same
   * two-phase demand the framework makes — so the record is written and read
   * back by the cache and nothing here hands the step a base by hand.
   *
   * `version` is an ordinary source file's content: changing it is what makes
   * the next call a miss, and the one name fabr's diff should report.
   */
  async function keepState(
    kept: string[],
    version: string,
    cache: BuildCache,
    reports = true
  ): Promise<{ seen: ISeen; state?: FileSet }> {
    const reporting = reports ? [DEPS_REPORT_FLAG, DEPS_REPORT_FILE] : [];
    const action = createNodeExecAction(
      FileSet.layout({ "tool.js": MemoryFile.from(stateTool(kept)), "src/v.txt": MemoryFile.from(version) }),
      [pkg("left-pad")],
      [process.execPath, "tool.js", ...reporting, STATE_DIR_FLAG, STATE_DIR, CHANGES_FLAG, CHANGES_FILE],
      "out:**",
      {
        layout: PNP,
        ...(reports ? { depsReport: DEPS_REPORT_FILE } : {}),
        stateDir: STATE_DIR,
        changes: CHANGES_FILE,
      }
    );
    const built = await toPromise(
      cache.getOrCreateAction(action, ctx => NODE_EXEC_ACTION.run(action, ctx, SILENT_REPORT), {
        targetKey: RECORD_KEY,
        processLimit: new Semaphore(UNBOUNDED),
      })
    );
    const record = await toPromise(cache.readBuildState(RECORD_KEY));
    return { seen: JSON.parse(await toPromise(built.readFile("seen.json"))) as ISeen, state: record?.incrementalState };
  }

  it("keeps every file a tool leaves in its state directory, and hands them all back", async () => {
    /* The whole point of the record being FILES: a tool may keep any number of
     * them, at any paths it likes, and fabr neither reads nor counts them. */
    const cache = new BuildCache(path.join(root, "cache"), NULL_LOG);
    const first = await keepState(["graph", "notes/aside"], "1", cache);
    expect(first.seen.seen, "a cold run is handed nothing").to.deep.equal([]);
    expect([...(first.state ?? [])].map(([name]) => name).sort(), "and both are recorded, under their own names").to.deep.equal([
      "graph",
      "notes/aside",
    ]);

    const second = await keepState(["graph", "notes/aside"], "2", cache);
    expect(second.seen.seen, "the next run gets all of them back, at the same paths").to.deep.equal(["graph", "notes/aside"]);
    expect(second.seen.handed.graph, "holding what the previous run wrote").to.equal("v0");
    /* Written over in place: the state directory is staged as WRITABLE COPIES,
     * so a tool overwriting its own previous state neither fails on a read-only
     * hardlink nor writes through into the shared blob. */
    expect(await toPromise(second.state!.readFile("graph")), "and the fresh generation is what is kept").to.equal("v2");
  });

  it("keeps a state file out of the namespace an emitted file of the same name lives in", async () => {
    /* Collection projects every pattern into ONE FileSet, and a `dir:glob`
     * pattern STRIPS its directory — so a state file would land beside the
     * emitted files and collide there. The state directory is collected by a
     * prefix-retaining pattern instead, which is the whole of what keeps the
     * two namespaces apart. */
    const cache = new BuildCache(path.join(root, "cache"), NULL_LOG);
    const built = await keepState(["seen.json"], "1", cache);
    /* Parsed, so the collision would show as a failure to read the run's own
     * report rather than as a subtly wrong name. */
    expect(built.seen.seen, "the emitted file is what the caller gets back").to.deep.equal([]);
    expect([...(built.state ?? [])].map(([name]) => name)).to.deep.equal(["seen.json"]);
    expect(await toPromise(built.state!.readFile("seen.json")), "and the state file is what the record kept").to.equal("v0");
  });

  it("records no state for a tool that keeps none, and still tells it what moved", async () => {
    /* Zero files is a legal record, and the two halves are independent: a tool
     * that keeps nothing of its own still wants fabr's diff. */
    const cache = new BuildCache(path.join(root, "cache"), NULL_LOG);
    const first = await keepState([], "1", cache);
    expect(first.state, "nothing kept, so no kept half at all").to.equal(undefined);
    const record = path.join(root, "cache", "incremental", RECORD_KEY);
    expect(fs.existsSync(path.join(record, "state")), "and no `state` file in the record").to.equal(false);
    expect(fs.existsSync(path.join(record, "inputs")), "while the input manifest is recorded as ever").to.equal(true);

    const second = await keepState([], "2", cache);
    expect(second.seen.changes, "so the next run is still told what moved").to.deep.equal(["src/v.txt"]);
  });

  it("keeps state for a tool that reports no reads, and diffs it against the whole closure", async () => {
    /* The third capability is independent of the other two: a tool may keep a
     * self-validating state of its own (tsc's own `.tsbuildinfo` is one) and
     * report nothing. Its entry then keys on the whole deps manifest, so the
     * diff base widens to match — anything narrower would omit a dependency
     * change from the next run's change lists and have it skip real work. */
    const cache = new BuildCache(path.join(root, "cache"), NULL_LOG);
    const first = await keepState(["graph"], "1", cache, false);
    expect(await toPromise(first.state!.readFile("graph")), "the state is kept with no report in sight").to.equal("v0");

    const second = await keepState(["graph"], "2", cache, false);
    expect(second.seen.seen, "and handed back to the next run").to.deep.equal(["graph"]);
    expect(second.seen.changes, "which is told what moved, as a reporting run would be").to.deep.equal(["src/v.txt"]);
  });
});

/**
 * The tool: writes the run report it was handed, and an output naming it. A
 * real driver derives its reads and its edges from the program it built and the
 * resolutions it performed; what matters here is the other half — that a
 * reported run is what the entry is keyed on.
 */
const REPORT_TOOL = `const fs = require("fs");
const flag = process.argv.indexOf("${DEPS_REPORT_FLAG}");
fs.writeFileSync(process.argv[flag + 1], process.argv[flag + 2]);
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/result.txt", "built");
`;

/** What a run reports: the files it opened, and how each name it asked for
 * resolved. */
interface IReport {
  reads: string[];
  edges: IResolutionEdge[];
}

/** The compilation resolving a name against its own direct deps — the
 * commonest edge, and the one the sources themselves make. */
function rootEdge(name: string, to: PackageFileSet): IResolutionEdge {
  return { from: "", name, to: instanceOf(to), via: "own" };
}

/**
 * The anchor, standing in for the key the framework composes: constant across
 * every build below precisely because the packages are *discoverable* and so
 * are not in it (that omission is BuildContext's, and is tested there). The JS
 * half is what these exercise — translating the report back to the input
 * packages, and keying the entry on the selection.
 */
const ANCHOR = "rule:js:exec:test\nfiles={tool}";

/** A tool that reports nothing — the assembled-layout case, where the run
 * discovers no reads and the entry is keyed on the whole deps manifest. */
const PLAIN_TOOL = `const fs = require("fs");
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/result.txt", "built");
`;

/** What {@link PLAIN_TOOL} is given: nothing to report, since it writes no
 * report at all. */
const NOTHING: IReport = { reads: [], edges: [] };

describe("js_compile discovered dependencies", () => {
  let root: string;
  let cache: BuildCache;
  let runs: number;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-jsdeps-test-"));
    cache = new BuildCache(path.join(root, "cache"), NULL_LOG);
    runs = 0;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function action(deps: PackageFileSet[], report: IReport, tool = REPORT_TOOL): BuildAction {
    return createNodeExecAction(
      FileSet.layout({ "tool.js": MemoryFile.from(tool) }),
      deps,
      [process.execPath, "tool.js", ...(tool === REPORT_TOOL ? [DEPS_REPORT_FLAG, DEPS_REPORT_FILE, JSON.stringify(report)] : [])],
      "out:**",
      tool === REPORT_TOOL ? { layout: PNP, depsReport: DEPS_REPORT_FILE } : { layout: PNP }
    );
  }

  /** Demand the action through the cache exactly as the framework does. */
  function build(deps: PackageFileSet[], report: IReport, tool = REPORT_TOOL): Promise<FileSet> {
    const built = action(deps, report, tool);
    return toPromise(
      cache.getOrCreate(
        ANCHOR,
        ctx => {
          runs++;
          return NODE_EXEC_ACTION.run(built, ctx, SILENT_REPORT);
        },
        { discoverable: built.discoverable }
      )
    );
  }

  /** What a compile that resolved `used` and opened its typings reports: the
   * files by the paths that reached them, and the resolution it performed to
   * get there. */
  function report(used: PackageFileSet): IReport {
    return {
      reads: ["used index.d.ts", "used package.json"],
      edges: [rootEdge("used", used)],
    };
  }

  it("does not rebuild when a dependency it never opened changes", async () => {
    const used = declPkg("used");
    const first = await build([used, declPkg("unused")], report(used));
    expect(runs).to.equal(1);
    /* The unused package's content — and so its identity, its reference in the
     * table and its tree — all change. None of it is in the key, because none
     * of it was read. */
    const second = await build([used, declPkg("unused", "edited")], report(used));
    expect(runs).to.equal(1);
    expect(await toPromise(second.readFile("result.txt"))).to.equal(await toPromise(first.readFile("result.txt")));
  });

  it("does not rebuild when an unrelated dependency is added to the closure", async () => {
    const used = declPkg("used");
    await build([used, declPkg("unused")], report(used));
    await build([used, declPkg("unused", "1", [declPkg("extra")])], report(used));
    expect(runs).to.equal(1);
  });

  it("does not rebuild when an unrelated dependency is added at the roots", async () => {
    /* A path states where the run looked, so a name nothing resolved is
     * not in the key at all — an added root is as free as an added transitive.
     * (What an added root CAN change without moving a byte is the automatic
     * `@types` inclusions, and those are written into the tsconfig, which is an
     * ordinary anchor input — see BuildJSCompile's automaticTypes.) */
    const used = declPkg("used");
    await build([used, declPkg("unused")], report(used));
    await build([used, declPkg("unused"), declPkg("added")], report(used));
    expect(runs).to.equal(1);
  });

  it("does not rebuild when a read dependency's version bumps with identical bytes", async () => {
    /* A path name is the delivered NAME, which a republish does not move, and
     * the key is the content found there — so a byte-identical republish still
     * replays and hits. The instance name in the report moves (the reference
     * covers the version); nothing in any key does. */
    const used = declPkg("used");
    await build([used, declPkg("unused")], report(used));
    expect(runs).to.equal(1);
    const bumped = new PackageFileSet(used, "used", "2.0.0", []);
    await build([bumped, declPkg("unused")], report(bumped));
    expect(runs).to.equal(1);
  });

  it("rebuilds when a file it read changes", async () => {
    const used = declPkg("used");
    await build([used, declPkg("unused")], report(used));
    const edited = declPkg("used", "edited");
    await build([edited, declPkg("unused")], report(edited));
    expect(runs).to.equal(2);
  });

  it("keys a read whose file name contains a space exactly", async () => {
    /* A space is the flat spelling's separator, so this read rides encoded
     * (`read%20me.d.ts` — joinDepsPath). A raw split would shear it into a
     * two-part path that resolves to nothing: a permanent absence, silently
     * dropping the file from the key — its edits would keep hitting. */
    const spaced = (content: string): PackageFileSet =>
      new PackageFileSet(new Map([["read me.d.ts", MemoryFile.from(content)]]), "used", "1.0.0", []);
    const reportOf = (pkg: PackageFileSet): IReport => ({
      reads: ["used read%20me.d.ts"],
      edges: [rootEdge("used", pkg)],
    });
    const one = spaced("v1");
    await build([one], reportOf(one));
    expect(runs).to.equal(1);
    const same = spaced("v1");
    await build([same], reportOf(same));
    expect(runs, "an identical delivery replays and hits").to.equal(1);
    const edited = spaced("v2");
    await build([edited], reportOf(edited));
    expect(runs, "editing the spaced file is a different key").to.equal(2);
  });

  it("rebuilds when a name it resolved is re-bound over a surviving instance", async () => {
    /* The hazard the path exists for: `used` binds a second version while the
     * first survives byte-identical under another package. Nothing about the
     * old instance moved, so naming what was read would answer from it; the
     * path `used index.d.ts` lands somewhere else and the key follows. */
    const first = declPkg("used", "v1");
    const second = declPkg("used", "v2");
    await build([first, declPkg("keeper")], report(first));
    expect(runs).to.equal(1);
    const built = await build([second, declPkg("keeper", "1", [first])], report(second));
    expect(runs, "the re-bind must not be answered from the old entry").to.equal(2);
    expect(built).to.not.equal(undefined);
  });

  it("does not rebuild when a dependency's bindings change but nothing resolved through them", async () => {
    /* `used` gains an edge, its own files unchanged. The compile opened its
     * declarations and resolved nothing from inside it — no edge from `used` in
     * the report — so what `used` can resolve is not a fact this run used. */
    const libs = [declPkg("lib-a"), declPkg("lib-b")];
    const one = declPkg("used", "1", [libs[0]]);
    await build([one, declPkg("unused", "1", [libs[1]])], report(one));
    expect(runs).to.equal(1);
    const both = declPkg("used", "1", libs);
    await build([both, declPkg("unused", "1", [libs[1]])], report(both));
    expect(runs).to.equal(1);
  });

  it("rebuilds when a name resolved from INSIDE a dependency re-binds", async () => {
    /* The same fact the other way round: this run did resolve `lib` from
     * `used`, so the path records that hop and a different `lib` there is a
     * different key. */
    const through = (lib: PackageFileSet): IReport => {
      const used = declPkg("used", "1", [lib]);
      return {
        reads: ["used index.d.ts", "used lib index.d.ts"],
        edges: [rootEdge("used", used), { from: instanceOf(used), name: "lib", to: instanceOf(lib), via: "own" }],
      };
    };
    const build2 = (lib: PackageFileSet): Promise<FileSet> => build([declPkg("used", "1", [lib])], through(lib));
    await build2(declPkg("lib", "one"));
    expect(runs).to.equal(1);
    await build2(declPkg("lib", "one"));
    expect(runs, "the same closure replays and hits").to.equal(1);
    await build2(declPkg("lib", "two"));
    expect(runs, "a different binding at that hop is a different key").to.equal(2);
  });

  it("rebuilds when an import that fell back is later declared", async () => {
    /* The phantom import: `used` imports `shared` without declaring it, so the
     * pool answers. That is TWO ordinary paths — `used shared`, which finds
     * nothing, and `shared`, which finds what answered instead — so `used`
     * declaring it later moves the first out of the key's absent section, even
     * though the pool's answer and every byte read are unchanged. Recording
     * only where the file was found could not see this. */
    const phantom = (declared: boolean): { deps: PackageFileSet[]; report: IReport } => {
      const shared = declPkg("shared");
      const used = declPkg("used", "1", declared ? [shared] : []);
      return {
        deps: [used, shared],
        report: {
          reads: declared
            ? ["used index.d.ts", "used shared index.d.ts"]
            : ["used index.d.ts", "shared index.d.ts", "used shared package.json"],
          edges: [
            rootEdge("used", used),
            { from: instanceOf(used), name: "shared", to: instanceOf(shared), via: declared ? "own" : "fallback" },
          ],
        },
      };
    };
    const loose = phantom(false);
    await build(loose.deps, loose.report);
    expect(runs).to.equal(1);
    await build(loose.deps, loose.report);
    expect(runs, "unchanged, so the absence still holds and the entry hits").to.equal(1);
    const declared = phantom(true);
    await build(declared.deps, declared.report);
    expect(runs, "the lookup finds an edge now, so the key moved").to.equal(2);
  });

  it("keys a fallback answer at the winner's own canonical route", async () => {
    /* The pool answers with a TRANSITIVE nothing at the top level binds. The
     * answer is pinned at the winning instance's canonical route — a
     * plain-indexing path the reporter converted to (the cache replays, it
     * never resolves a pool) — so the winner's manifest moving is a different
     * key even while every declaration read and the access-path absence stand
     * untouched. */
    const through = (manifest: string): { deps: PackageFileSet[]; report: IReport } => {
      const shared = new PackageFileSet(
        new Map<string, IFile>([
          ["index.d.ts", MemoryFile.from("// shared\n")],
          ["package.json", MemoryFile.from(manifest)],
        ]),
        "shared",
        "1.0.0",
        []
      );
      const carrier = declPkg("carrier", "1", [shared]);
      const used = declPkg("used");
      return {
        deps: [used, carrier],
        report: {
          reads: ["used index.d.ts", "carrier shared index.d.ts", "used shared package.json", "carrier shared package.json"],
          edges: [
            rootEdge("used", used),
            rootEdge("carrier", carrier),
            { from: instanceOf(used), name: "shared", to: instanceOf(shared), via: "fallback" },
          ],
        },
      };
    };
    const one = through('{"name":"shared","version":"1.0.0"}\n');
    await build(one.deps, one.report);
    expect(runs).to.equal(1);
    const same = through('{"name":"shared","version":"1.0.0"}\n');
    await build(same.deps, same.report);
    expect(runs, "an identical delivery replays and hits").to.equal(1);
    /* Only the answerer's manifest moves: the declaration read is unchanged
     * and `used` still binds nothing, so without the answer row this would
     * wrongly hit. */
    const flipped = through('{"name":"shared","version":"2.0.0"}\n');
    await build(flipped.deps, flipped.report);
    expect(runs, "a different answer is a different key").to.equal(2);
  });

  it("tells a forked name's instances apart by the path that found each", async () => {
    /* Two versions of one name in one delivery: `forked` and `requirer forked`
     * are different paths, so each read is stated exactly — an unchanged fork
     * pair hits, and either instance's bytes moving misses. */
    const fork = (oldBytes: string): PackageFileSet[] => {
      const nested = declPkg("forked", oldBytes);
      return [declPkg("forked", "new"), declPkg("requirer", "1", [nested])];
    };
    const forkReport = (deps: PackageFileSet[]): IReport => {
      const nested = (deps[1].dependencies as PackageFileSet[])[0];
      return {
        reads: ["forked index.d.ts", "requirer forked index.d.ts"],
        edges: [
          rootEdge("forked", deps[0]),
          rootEdge("requirer", deps[1]),
          { from: instanceOf(deps[1]), name: "forked", to: instanceOf(nested), via: "own" },
        ],
      };
    };
    let deps = fork("old");
    await build(deps, forkReport(deps));
    expect(runs).to.equal(1);
    deps = fork("old");
    await build(deps, forkReport(deps));
    expect(runs, "both paths replay, the entry hits").to.equal(1);
    deps = fork("edited");
    await build(deps, forkReport(deps));
    expect(runs, "the nested instance's bytes moving is a miss").to.equal(2);
  });

  it("keeps the report out of the step's output", async () => {
    const used = declPkg("used");
    const files = await build([used, declPkg("unused")], report(used));
    /* Collected only so it can be read before the sweep — a tool's bookkeeping
     * is not part of what the target produced. */
    expect([...files].map(([name]) => name)).to.deep.equal(["result.txt"]);
  });

  it("keys a non-reporting run on the whole deps manifest: a hit when nothing moved", async () => {
    /* Reporting is a soundness gate, not a key shape. A run that discovers
     * nothing is keyed on everything it could have read — the deps input's own
     * manifest — so an unchanged closure hits. */
    await build([declPkg("used"), declPkg("unused")], NOTHING, PLAIN_TOOL);
    expect(runs).to.equal(1);
    await build([declPkg("used"), declPkg("unused")], NOTHING, PLAIN_TOOL);
    expect(runs, "nothing moved, so the whole-deps key still matches").to.equal(1);
  });

  it("keys a non-reporting run on the whole deps manifest: a miss when any dep moves", async () => {
    /* The other half, and the price of reporting nothing: with no reads to
     * narrow by, a change anywhere in the closure moves the key — including a
     * package a reporting run would have shown was never opened. */
    await build([declPkg("used"), declPkg("unused")], NOTHING, PLAIN_TOOL);
    expect(runs).to.equal(1);
    await build([declPkg("used"), declPkg("unused", "edited")], NOTHING, PLAIN_TOOL);
    expect(runs, "the closure moved, so the key did").to.equal(2);
  });

  it("cannot let a non-reporting run's key mislead a reporting one: different anchors", () => {
    /* A non-reporting run's entry lives under the whole-deps key, which would
     * be a wrong answer for a reporting run keyed on a narrower read set. It
     * can never be offered one: `depsReport` is not a discoverable input, so it
     * stays in the anchor and the two modes never share one. */
    const used = declPkg("used");
    const reporting = action([used], report(used));
    const plain = action([used], NOTHING, PLAIN_TOOL);
    expect(reporting.actionKey()).to.not.equal(plain.actionKey());
  });

  it("keys on the reads whatever else the delivery holds, so a hit survives a fresh cache", async () => {
    const used = declPkg("used");
    await build([used, declPkg("unused")], report(used));
    /* A second cache over the same store: the entry is found by replaying the
     * remembered paths, not from anything held in memory. */
    cache = new BuildCache(path.join(root, "cache"), NULL_LOG);
    await build([used, declPkg("unused", "edited-again")], report(used));
    expect(runs).to.equal(1);
  });
});

describe("the js exec step's discoverable deps", () => {
  it("declares deps into the discoverable deps once, for every layout", () => {
    /* Keying never branches on layout or on reporting: they are structural
     * on the constructed action, and the mount/layout options stay in the
     * anchor. */
    const built = createNodeExecAction(FileSet.layout({}), [declPkg("left-pad")], ["node"], "out:**");
    expect(Object.keys(built.discoverable ?? {})).to.deep.equal(["deps"]);
  });
});

/**
 * A closure with no finite `node_modules` encoding — a cross-generation version
 * cycle. Only PnP can deliver one (the table expresses it; no tree does), and
 * keying needs no tree, so it gets discovery like everything else: instance
 * names for the report, content for the key, the whole-deps manifest for a
 * non-reporting run. The assemblers still refuse it, because an install
 * genuinely has no layout for it.
 */
describe("a closure with no finite tree encoding", () => {
  /* a@1 → b@1 → a@2 → b@2 → a@1: every hop needs a version other than the one
   * visible where it sits, and each nesting is forced. */
  const cycle = (content: (id: string) => string = id => id): PackageFileSet =>
    delivered(
      {
        "a@1.0.0": { b: "b@1.0.0" },
        "b@1.0.0": { a: "a@2.0.0" },
        "a@2.0.0": { b: "b@2.0.0" },
        "b@2.0.0": { a: "a@1.0.0" },
      },
      "a@1.0.0",
      content
    );

  it("gets discovery like everything else, keyed soundly", () => {
    const closure = cycle();
    /* Every instance is distinctly referenced — both generations of `a` apart,
     * which is what lets a report and a manifest name them without a tree. */
    const generations = reachablePackages([closure]).filter(pkg => pkg.packageName === "a");
    expect(generations).to.have.lengthOf(2);
    expect(referenceOf(generations[0])).to.not.equal(referenceOf(generations[1]));
    /* And two different closures key differently: the non-reporting fallback
     * is the whole deps manifest, which a cyclic graph manifests fine. */
    const keyOf = (deps: PackageFileSet[]): string => manifestFileInputs({ deps });
    expect(keyOf([cycle()])).to.equal(keyOf([cycle()]));
    expect(keyOf([cycle(id => `${id}-edited`)])).to.not.equal(keyOf([cycle()]));
  });

  it("still builds under PnP, which materializes no tree", async () => {
    const manifest = pnpManifestOf([cycle()], undefined);
    expect(manifest.packages.length, "every instance still gets a row").to.be.greaterThan(0);
  });

  it("is refused by both assemblers, which cannot lay it out", () => {
    expect(() => assembleNodeModules([cycle()]), "flat").to.throw(/Cannot lay out this dependency closure/);
    expect(() => assembleScopedNodeModules([cycle()]), "scoped").to.throw();
  });
});
