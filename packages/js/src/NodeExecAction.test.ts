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
import { BuildAction, BuildCache, Computable, FileSet, IActionContext, IFile, Log, MemoryFile, PackageFileSet } from "@fabr-build/core";
import { createNodeExecAction, FLAT, PNP, SCOPED } from "./NodeExecAction";

const NULL_LOG: Log = { log: () => undefined };

function toPromise<T>(computable: Computable<T>): Promise<T> {
  return new Promise((resolve, reject) => computable.then(resolve, reject));
}

function pkg(name: string, version = "1.0.0", deps: PackageFileSet[] = []): PackageFileSet {
  return new PackageFileSet(
    new Map<string, IFile>([["index.js", MemoryFile.from(`// ${name}@${version}`)]]),
    name,
    version,
    deps
  );
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
  const ctx = {
    workDir,
    createOutput: () => {
      throw new Error("unused");
    },
    ensureTree: (files: FileSet) => cache.ensureTree(files),
    treePool: cache.treePoolLink,
    /* Neither reported nor bounded: this test is about layout, so the report
     * swallows output (as `-q` would) and both funnels run their work directly. */
    report: { activity: () => undefined, progress: () => undefined },
    admit: <T>(work: () => Computable<T>): Computable<T> => work(),
    processLimit: { run: <T>(work: () => Computable<T>): Computable<T> => work() },
  } as unknown as IActionContext;
  const collected = await toPromise(action.step.run(action.inputs, ctx));
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
      createNodeExecAction(sources, deps, TOOL, "out:**", { layout }).inputs.layout;
    expect(new Set([key(PNP), key(FLAT), key(SCOPED)]).size).to.equal(3);
  });
});
