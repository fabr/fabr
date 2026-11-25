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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  dependenciesOn,
  EMPTY_FILESET,
  FileSet,
  IChangedFiles,
  IFile,
  ITestReport,
  MemoryFile,
  PackageFileSet,
} from "@fabr-build/core";
import { IPackageLayout, ReadName } from "./Layout";
import {
  type ITestFramework,
  recordOf,
  selectCompiledSetupFile,
  selectCompiledTestFiles,
  snapshotWriteBacks,
  TEST_FRAMEWORKS,
  testTargetOf,
} from "./TestPipeline";
import { filesToRun, readsOf, withArtifactsOf } from "./TestRunAction";

/** A FileSet with the given names (contents irrelevant to selection). */
function fileSetOf(...names: string[]): FileSet {
  return new FileSet(new Map<string, IFile>(names.map(name => [name, MemoryFile.from("")])));
}

describe("selectCompiledTestFiles", () => {
  it("picks the .js outputs whose stem is a declared test, out of the actual compiled tree", () => {
    /* The tree also carries the sourcemap, declarations, a non-test source, and a
     * non-test .js — none of which should be selected. */
    const tree = fileSetOf("a/foo.test.js", "a/foo.test.js.map", "a/foo.test.d.ts", "a/foo.js", "b/bar.test.js");
    const stems = new Set(["a/foo.test", "b/bar.test"]);
    expect(selectCompiledTestFiles(tree, stems)).to.deep.equal(["a/foo.test.js", "b/bar.test.js"]);
  });

  it("includes a .js test source's compiled output, not only .ts/.tsx (the M2 case)", () => {
    /* A `foo.test.js` source → stem `foo.test` → compiled `foo.test.js`,
     * selected because js_compile emitted it, not by predicting the name from a
     * `.ts` source. */
    const tree = fileSetOf("foo.test.js");
    expect(selectCompiledTestFiles(tree, new Set(["foo.test"]))).to.deep.equal(["foo.test.js"]);
  });

  it("returns empty when no compiled .js matches a declared test (so the caller errors, not greens)", () => {
    const tree = fileSetOf("foo.js", "foo.d.ts");
    expect(selectCompiledTestFiles(tree, new Set(["foo.test"]))).to.deep.equal([]);
  });

  it("leaves out the root setup script declared among the tests", () => {
    const tree = fileSetOf("setupTests.js", "a/foo.test.js", "helpers/setupTests.js");
    const stems = new Set(["setupTests", "a/foo.test", "helpers/setupTests"]);
    expect(selectCompiledTestFiles(tree, stems)).to.deep.equal(["a/foo.test.js", "helpers/setupTests.js"]);
  });

  it("picks up a .mts/.cts test's compiled .mjs/.cjs output", () => {
    const tree = fileSetOf("a.test.mjs", "b.test.cjs", "a.test.d.mts");
    expect(selectCompiledTestFiles(tree, new Set(["a.test", "b.test"]))).to.deep.equal(["a.test.mjs", "b.test.cjs"]);
  });
});

/** A source-tree FileSet: names as declared, each locatable back to `root` —
 * the provenance an FS query attaches (see FSFileSource's source-tree step). */
function sourceSetOf(root: string, ...names: string[]): FileSet {
  return new FileSet(new Map<string, IFile>(names.map(name => [name, MemoryFile.from("")])), {
    kind: "source-tree",
    root,
    paths: new Map(names.map(name => [name, name])),
  } as never);
}

describe("snapshotWriteBacks", () => {
  it("rekeys a refreshed record to the SOURCE name, in the tests' own namespace", () => {
    /* A runner may name a record after the compiled file it ran (jest's own
     * default, so perfectly conforming). Rekeying it here to the source name is
     * what makes the correspondence a pure naming rule — and it is also what
     * reaches the tree, so a record lands as `<test file>.snap`, jest's
     * convention, unchanged. Nothing here is a host path. */
    const tests = sourceSetOf("/proj", "a/foo.test.tsx");
    const snapshots = fileSetOf("a/__snapshots__/foo.test.js.snap");
    const [candidate] = snapshotWriteBacks(snapshots, tests, EMPTY_FILESET);
    expect([...candidate.files].map(([name]) => name)).to.deep.equal(["a/__snapshots__/foo.test.tsx.snap"]);
    expect(candidate.origin).to.equal(tests.origin);
  });

  it("states the correspondence as one rewrite, which names the test a record belongs to", () => {
    /* The driver applies this and nothing else — it needs no notion of what a
     * snapshot is, and the names cannot drift from the relationship because
     * there is only one statement of it. */
    const tests = sourceSetOf("/proj", "a/foo.test.tsx", "bar.test.ts");
    const snapshots = fileSetOf("a/__snapshots__/foo.test.tsx.snap", "__snapshots__/bar.test.ts.snap");
    const [candidate] = snapshotWriteBacks(snapshots, tests, EMPTY_FILESET);
    const belongs = candidate.belongsTo.makeProjector();
    expect(belongs("a/__snapshots__/foo.test.tsx.snap")).to.equal("a/foo.test.tsx");
    /* At the tree root the `**` captures nothing and the separator normalizes. */
    expect(belongs("__snapshots__/bar.test.ts.snap")).to.equal("bar.test.ts");
  });

  it("does not offer a record the run reproduced unchanged", () => {
    /* Changed-ness is decided HERE, where both sides are already hashed — the
     * staged input the run was given, and what it wrote — rather than by reading
     * the user's file at write time. So an unchanged record is never offered,
     * which is what lets the write itself be unconditional and keeps a no-op
     * update run from touching the tree at all. */
    const tests = sourceSetOf("/proj", "a/foo.test.tsx");
    const name = "a/__snapshots__/foo.test.js.snap";
    const recorded = new FileSet(new Map<string, IFile>([[name, MemoryFile.from("recorded: one")]]));
    /* Same name, same bytes: the run put back exactly what it was given. */
    expect(snapshotWriteBacks(recorded, tests, recorded)).to.deep.equal([]);
    /* Different bytes under that name: a real change, and offered. */
    const refreshed = new FileSet(new Map<string, IFile>([[name, MemoryFile.from("recorded: two")]]));
    expect(snapshotWriteBacks(refreshed, tests, recorded)).to.have.lengthOf(1);
    /* A record that did not exist has nothing to compare against. */
    expect(snapshotWriteBacks(refreshed, tests, EMPTY_FILESET)).to.have.lengthOf(1);
  });

  it("prefers the source-named record when both it and a compiled-named one were collected", () => {
    /* A runner that found the checked-in record rewrites THAT file; the
     * unchanged staged copy and a stray compiled-named one both share the stem,
     * so the exact name decides rather than iteration order. */
    const tests = sourceSetOf("/proj", "foo.test.ts");
    const wanted = MemoryFile.from("chosen");
    const snapshots = new FileSet(
      new Map<string, IFile>([
        ["__snapshots__/foo.test.js.snap", MemoryFile.from("other")],
        ["__snapshots__/foo.test.ts.snap", wanted],
      ])
    );
    expect([...snapshotWriteBacks(snapshots, tests, EMPTY_FILESET)[0].files][0][1]).to.equal(wanted);
  });

  it("offers nothing for a test with no refreshed record", () => {
    const tests = sourceSetOf("/proj", "foo.test.ts", "bar.test.ts");
    const snapshots = fileSetOf("__snapshots__/foo.test.js.snap");
    expect([...snapshotWriteBacks(snapshots, tests, EMPTY_FILESET)[0].files].map(([name]) => name)).to.deep.equal([
      "__snapshots__/foo.test.ts.snap",
    ]);
  });

  it("offers a record for a test with no source location, and lets the driver find it unplaceable", () => {
    /* A generated test. Nothing here has to notice: the offer is stated the same
     * way either way, and it is the driver — the one that resolves inputs to
     * places on disk — that discovers there is nowhere to write it and says so.
     * Skipping it here would put the failure in the layer that cannot report it. */
    const tests = fileSetOf("generated.test.ts");
    const snapshots = fileSetOf("__snapshots__/generated.test.js.snap");
    const [candidate] = snapshotWriteBacks(snapshots, tests, EMPTY_FILESET);
    expect([...candidate.files].map(([name]) => name)).to.deep.equal(["__snapshots__/generated.test.ts.snap"]);
    expect(candidate.origin).to.equal(undefined);
  });

  it("ignores collected files that are not records", () => {
    const tests = sourceSetOf("/proj", "foo.test.ts");
    expect(snapshotWriteBacks(fileSetOf("ctrf-report.json", "foo.snap"), tests, EMPTY_FILESET)).to.deep.equal([]);
  });
});

describe("records named for the compiled test file (playwright)", () => {
  const records = TEST_FRAMEWORKS.get("playwright")!.records;
  const compiledOf = new Map([
    ["tests/login.spec.ts", "tests/login.spec.js"],
    ["tests/nested/cart.spec.tsx", "tests/nested/cart.spec.js"],
  ]);
  const withContent = (rows: Array<[string, string]>): FileSet =>
    new FileSet(new Map<string, IFile>(rows.map(([name, text]) => [name, MemoryFile.from(text)])));

  it("finds a record's test by a directory that is, or begins with, the test's file name, never by the file itself", () => {
    const renames = new Map([["tests/login.spec.ts", "tests/login.spec.js"]]);
    expect(recordOf("tests/login.spec.ts-snapshots/home-chromium-linux.png", renames)).to.deep.equal({
      test: "tests/login.spec.ts",
      name: "tests/login.spec.js-snapshots/home-chromium-linux.png",
    });
    /* `{testFilePath}` as a directory of a custom snapshotPathTemplate. */
    expect(recordOf("__screenshots__/tests/login.spec.ts/home.png", renames)?.name).to.equal(
      "__screenshots__/tests/login.spec.js/home.png"
    );
    /* A longer name sharing the prefix is another test's. */
    expect(recordOf("tests/login.spec.tsx-snapshots/a.png", renames)).to.equal(undefined);
    expect(recordOf("tests/login.spec.ts", renames)).to.equal(undefined);
  });

  it("pairs a record with the test its directories lead to, where two tests share a compiled name", () => {
    const toSource = new Map([
      ["tests/a/login.spec.js", "tests/a/login.spec.ts"],
      ["tests/b/login.spec.js", "tests/b/login.spec.tsx"],
    ]);
    expect(recordOf("tests/a/login.spec.js-snapshots/x.png", toSource)).to.deep.equal({
      test: "tests/a/login.spec.js",
      name: "tests/a/login.spec.ts-snapshots/x.png",
    });
    expect(recordOf("tests/b/login.spec.js-snapshots/x.png", toSource)?.name).to.equal("tests/b/login.spec.tsx-snapshots/x.png");
  });

  it("stages the declared records under the compiled file's name", () => {
    const staged = records.stage(
      fileSetOf("tests/login.spec.ts-snapshots/home.png", "tests/nested/cart.spec.tsx-snapshots/a.txt"),
      compiledOf
    );
    expect([...staged].map(([name]) => name)).to.deep.equal([
      "tests/login.spec.js-snapshots/home.png",
      "tests/nested/cart.spec.js-snapshots/a.txt",
    ]);
  });

  it("collects the directories named for each compiled test, and each staged record by name", () => {
    const staged = fileSetOf("custom/home.png");
    expect(records.collected(staged, compiledOf)).to.deep.equal([
      "**/login.spec.js-*/**",
      "**/login.spec.js/**",
      "**/cart.spec.js-*/**",
      "**/cart.spec.js/**",
      "custom/home.png",
    ]);
  });

  it("offers each changed record back under the source's name, beside its own test", () => {
    const tests = sourceSetOf("/proj", "tests/login.spec.ts", "tests/nested/cart.spec.tsx");
    const staged = withContent([["tests/login.spec.js-snapshots/home.png", "old"]]);
    const collected = withContent([
      ["tests/login.spec.js-snapshots/home.png", "new"],
      ["tests/login.spec.js-snapshots/menu.png", "created"],
      ["tests/nested/cart.spec.js-snapshots/a.txt", "created"],
    ]);
    const candidates = records.writeBacks(collected, staged, tests, compiledOf);
    expect(candidates.map(({ files }) => [...files].map(([name]) => name))).to.deep.equal([
      ["tests/login.spec.ts-snapshots/home.png", "tests/login.spec.ts-snapshots/menu.png"],
      ["tests/nested/cart.spec.tsx-snapshots/a.txt"],
    ]);
    /* Each file belongs to its test, which the driver locates to place it. */
    const [login, cart] = candidates.map(({ belongsTo }) => belongsTo.makeProjector());
    expect(login("tests/login.spec.ts-snapshots/home.png")).to.equal("tests/login.spec.ts");
    expect(cart("tests/nested/cart.spec.tsx-snapshots/a.txt")).to.equal("tests/nested/cart.spec.tsx");
    expect(candidates[0].origin).to.equal(tests.origin);
  });

  it("offers nothing for a record the run left as staged", () => {
    const tests = sourceSetOf("/proj", "tests/login.spec.ts");
    const staged = withContent([["tests/login.spec.js-snapshots/home.png", "same"]]);
    expect(records.writeBacks(staged, staged, tests, compiledOf)).to.deep.equal([]);
  });

  it("finds the test of a record a template places under the test's path", () => {
    const tests = sourceSetOf("/proj", "tests/login.spec.ts", "other/login.spec.ts");
    const collected = withContent([["__screenshots__/tests/login.spec.js/home.png", "new"]]);
    const [candidate] = records.writeBacks(
      collected,
      EMPTY_FILESET,
      tests,
      new Map([
        ["tests/login.spec.ts", "tests/login.spec.js"],
        ["other/login.spec.ts", "other/login.spec.js"],
      ])
    );
    expect(candidate.belongsTo.makeProjector()("__screenshots__/tests/login.spec.ts/home.png")).to.equal("tests/login.spec.ts");
  });
});

describe("testTargetOf", () => {
  const framework = (name: string): ITestFramework => TEST_FRAMEWORKS.get(name)!;

  it("pins the module format the framework loads, keeping the target's own ES level and environment", () => {
    expect(testTargetOf({ version: "es2022", module: "dual", environment: "browser" }, framework("vitest"))).to.deep.equal({
      version: "es2022",
      module: "esm",
      environment: "browser",
    });
  });

  it("raises an ES level below the framework's minimum to the minimum, and leaves a higher one", () => {
    expect(testTargetOf({ version: "es2015", module: "commonjs", environment: "node" }, framework("playwright")).version).to.equal(
      "es2017"
    );
    expect(testTargetOf({ version: "es2022", module: "commonjs", environment: "node" }, framework("playwright")).version).to.equal(
      "es2022"
    );
  });
});

describe("selectCompiledSetupFile", () => {
  it("finds the conventional script at the tree root, whatever it compiled from", () => {
    for (const compiled of ["setupTests.js", "setupTests.cjs", "setupTests.mjs"]) {
      expect(selectCompiledSetupFile(fileSetOf(compiled, "a/thing.js")), compiled).to.equal(compiled);
    }
  });

  it("is undefined for a target that has none", () => {
    expect(selectCompiledSetupFile(fileSetOf("a/thing.js", "a/thing.test.js"))).to.equal(undefined);
  });

  it("ignores one nested inside the tree", () => {
    /* Rooted, so an ordinary source that happens to be named this — a helper
     * for one directory's tests — cannot quietly become suite-wide setup. */
    expect(selectCompiledSetupFile(fileSetOf("helpers/setupTests.js", "a/thing.js"))).to.equal(undefined);
  });

  it("ignores a non-JS file of the same stem", () => {
    expect(selectCompiledSetupFile(fileSetOf("setupTests.d.ts", "setupTests.js.map"))).to.equal(undefined);
  });

  it("rejects two at the root rather than picking one", () => {
    /* Silently choosing would leave the other's polyfills mysteriously absent. */
    expect(() => selectCompiledSetupFile(fileSetOf("setupTests.js", "setupTests.cjs"))).to.throw("more than one");
  });
});

describe("filesToRun", () => {
  const report = (failed: number): ITestReport => ({
    results: {
      tool: { name: "fixture" },
      summary: { tests: 1, passed: 1 - failed, failed, pending: 0, skipped: 0, other: 0, start: 0, stop: 1 },
      tests: [],
    },
  });
  const kept = new Map([
    ["a.test.js", { report: report(0), reads: new Set(["build/a.test.js", "build/a.js"]) }],
    ["b.test.js", { report: report(0), reads: new Set(["build/b.test.js", "build/b.js"]) }],
  ]);
  const files = ["a.test.js", "b.test.js"];
  const changes = (changed: string[], added: string[] = [], deleted: string[] = []): IChangedFiles => ({ changed, added, deleted });

  it("runs the files whose reads changed, and no others", () => {
    expect(filesToRun(files, changes(["build/a.js"]), kept, false).rerun).to.deep.equal(["a.test.js"]);
    expect(filesToRun(files, changes(["build/c.js"]), kept, false).rerun).to.deep.equal([]);
  });

  it("runs the files whose deps rows changed — a package's file, or a lookup's answer", () => {
    const rows = new Map([
      ["a.test.js", { report: report(0), reads: new Set(["build/a.test.js"]), deps: new Set(["lib index.js", "lib package.json"]) }],
      ["b.test.js", { report: report(0), reads: new Set(["build/b.test.js"]), deps: new Set(["opt package.json"]) }],
    ]);
    expect(filesToRun(files, changes(["lib index.js"]), rows, false).rerun).to.deep.equal(["a.test.js"]);
    expect(filesToRun(files, changes([], ["opt package.json"]), rows, false).rerun, "the probed package appeared").to.deep.equal([
      "b.test.js",
    ]);
    expect(filesToRun(files, changes([], [], ["lib index.js"]), rows, false).rerun, "the package's file went").to.deep.equal([
      "a.test.js",
    ]);
    expect(filesToRun(files, changes(["lib other.js"]), rows, false).rerun).to.deep.equal([]);
  });

  it("runs every file where nothing is kept to compare with, or one of the step's own files was added or deleted", () => {
    expect(filesToRun(files, undefined, kept, false).rerun).to.deep.equal(files);
    expect(filesToRun(files, changes([]), undefined, false).rerun).to.deep.equal(files);
    expect(filesToRun(files, changes([], ["build/c.js"]), kept, false).rerun).to.deep.equal(files);
    expect(filesToRun(files, changes([], [], ["build/c.js"]), kept, false).rerun).to.deep.equal(files);
  });

  it("runs again, in a measured run, a file whose coverage is not kept", () => {
    expect(filesToRun(files, changes([]), kept, true).rerun).to.deep.equal(files);
    const recorded = FileSet.layout({ "coverage-1-0.json": MemoryFile.from('{"result":[]}') });
    const measured = new Map([...kept].map(([file, run]) => [file, { ...run, coverage: recorded }]));
    expect(filesToRun(files, changes(["build/a.js"]), measured, true).rerun).to.deep.equal(["a.test.js"]);
  });

  it("runs again a file that failed, one with no record, and one whose runner did not say what it read", () => {
    const partial = new Map([
      ["a.test.js", { report: report(1), reads: new Set(["build/a.test.js"]) }],
      ["c.test.js", { report: report(0) }],
    ]);
    expect(filesToRun([...files, "c.test.js"], changes([]), partial, false).rerun).to.deep.equal([
      "a.test.js",
      "b.test.js",
      "c.test.js",
    ]);
  });
});

describe("readsOf", () => {
  const x = new PackageFileSet(new Map(), "x", "1.0.0");
  const y = new PackageFileSet(new Map(), "y", "1.0.0", dependenciesOn(x));
  const cwd = path.resolve("/work/build");
  const names = new Map<string, ReadName>([
    ["a.test.js", { file: "build/a.test.js" }],
    ["node_modules/y/index.js", { route: ["y"], path: "index.js", package: y }],
    ["node_modules/x/index.js", { route: ["y", "x"], path: "index.js", package: x }],
    ["node_modules/x/sub.js", { route: ["y", "x"], path: "sub.js", package: x }],
  ]);
  const layout: IPackageLayout = {
    files: EMPTY_FILESET,
    trees: new Map(),
    members: [y],
    namesReads: true,
    nameRead: read => names.get(path.relative(cwd, read).split(path.sep).join("/")),
    locate: () => undefined,
  };

  it("takes a package's lookup of itself as answered by the package", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-reads-"));
    try {
      const document = path.join(dir, "reads.json");
      fs.writeFileSync(
        document,
        JSON.stringify({
          files: ["a.test.js", "node_modules/y/index.js", "node_modules/x/index.js", "node_modules/x/sub.js"],
          lookups: [
            { from: "a.test.js", name: "y", to: "node_modules/y/index.js" },
            { from: "node_modules/y/index.js", name: "x", to: "node_modules/x/index.js" },
            { from: "node_modules/x/index.js", name: "x", to: "node_modules/x/sub.js" },
          ],
        })
      );
      const named = readsOf(document, cwd, layout);
      expect(named).to.not.equal(undefined);
      expect([...named!.deps].sort()).to.deep.equal(
        ["y index.js", "y package.json", "y x index.js", "y x sub.js", "y x x package.json", "y x package.json"].sort()
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records a lookup nothing answered as its row, and no reads where the layout names none", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-reads-"));
    try {
      const document = path.join(dir, "reads.json");
      fs.writeFileSync(document, JSON.stringify({ files: ["a.test.js"], lookups: [{ from: "a.test.js", name: "opt" }] }));
      expect([...readsOf(document, cwd, layout)!.deps]).to.deep.equal(["opt package.json"]);
      expect(readsOf(document, cwd, { ...layout, namesReads: false })).to.equal(undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a found directory within a package as the least name the package holds under it", () => {
    const z = new PackageFileSet(
      new Map<string, IFile>(["package.json", "lib/b.js", "lib/a/c.js", "README.md"].map(name => [name, MemoryFile.from("")])),
      "z",
      "1.0.0"
    );
    const probed = new Map<string, ReadName>([
      ["node_modules/z", { route: ["z"], path: "", package: z }],
      ["node_modules/z/lib", { route: ["z"], path: "lib", package: z }],
      ["node_modules/z/empty", { route: ["z"], path: "empty", package: z }],
    ]);
    const zLayout: IPackageLayout = {
      ...layout,
      members: [z],
      nameRead: read => probed.get(path.relative(cwd, read).split(path.sep).join("/")),
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-reads-"));
    try {
      const document = path.join(dir, "reads.json");
      fs.writeFileSync(document, JSON.stringify({ files: ["node_modules/z/", "node_modules/z/lib/"], lookups: [] }));
      expect([...readsOf(document, cwd, zLayout)!.deps].sort()).to.deep.equal(["z README.md", "z lib/a/c.js"]);
      fs.writeFileSync(document, JSON.stringify({ files: ["node_modules/z/empty/"], lookups: [] }));
      expect(readsOf(document, cwd, zLayout), "a directory holding none of the package's files").to.equal(undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("withArtifactsOf", () => {
  it("names each attachment where the target's result holds it, and leaves out one outside the run's directory", () => {
    const report: ITestReport = {
      results: {
        tool: { name: "fixture" },
        summary: { tests: 1, passed: 0, failed: 1, pending: 0, skipped: 0, other: 0, start: 0, stop: 0 },
        tests: [
          {
            name: "a",
            status: "failed",
            duration: 0,
            attachments: [
              { name: "trace", contentType: "application/zip", path: "a-chromium/trace.zip" },
              { name: "stray", contentType: "text/plain", path: "../elsewhere.txt" },
            ],
          },
          { name: "b", status: "passed", duration: 0 },
        ],
      },
    };
    const [a, b] = withArtifactsOf(report, "artifacts/tests/a.spec.js").results.tests;
    expect(a.attachments).to.deep.equal([
      { name: "trace", contentType: "application/zip", path: "artifacts/tests/a.spec.js/a-chromium/trace.zip" },
    ]);
    expect(b.attachments).to.equal(undefined);
  });
});
