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
  BuildAction,
  BuildCache,
  Computable,
  FileSet,
  IFile,
  Log,
  MemoryFile,
  PackageFileSet,
  Semaphore,
  SILENT_REPORT,
} from "@fabr-build/core";
import { createNodeExecAction, NODE_EXEC_ACTION, PNP } from "./NodeExecAction";
import { parseDriverMemo, toCompileTelemetry } from "./tscDriver/Planning";
import { CHANGES_FILE, CHANGES_FLAG, DEPS_REPORT_FILE, STATE_DIR, STATE_DIR_FLAG } from "./pnp/ReadSet";
import { COMPILE_OUT_DIR, COMPILE_SRC_DIR, makeTsConfig } from "./rules/BuildJSCompile";
import { parseJSTarget } from "./JSPackage";

const NULL_LOG: Log = { log: () => undefined };

/**
 * The driver as a program to launch — the real one, compiled, since these cases
 * are about what a real compile does. Found beside this test where the tests
 * run from the built tree (`fabr test`), and in the devchain's output where
 * they run from source (ts-jest). Its own `typescript` resolves from wherever
 * it is found, which is why `@pkg:typescript` is among this package's
 * test_deps.
 */
const TSC_DRIVER = [
  path.resolve(__dirname, "tscDriver/tsc-driver.js"),
  path.resolve(__dirname, "../build/tscDriver/tsc-driver.js"),
].find(candidate => fs.existsSync(candidate));
/** The target key every build in a case shares — what a declared target's identity
 * would compose to, which this test supplies directly. */
const TARGET_KEY = "target-key-under-test";

/** A funnel capacity no case can reach, so nothing here ever waits for a slot. */
const UNBOUNDED = 1024;

function toPromise<T>(computable: Computable<T>): Promise<T> {
  return new Promise((resolve, reject) => computable.then(resolve, reject));
}

/**
 * A compile driven exactly as `js_compile` drives it — the real driver, the
 * real step, the real cache — with the sources under the test's control.
 *
 * What it exists to assert is the CACHE's state as much as the output: that a
 * body edit rebuilds one file and still commits a complete entry, that the
 * memo advances only on green runs, and that a downstream consumer's cutoff
 * still holds over the whole thing.
 */
class Compile {
  public readonly root: string;
  private readonly cache: BuildCache;
  private readonly sources = new Map<string, string>();
  private readonly extras = new Map<string, string>();
  private readonly deps: PackageFileSet[];
  /** What the generated project emits for — the one non-node input a test can
   * move, and the reason a change to it has to recompile everything. */
  private target = "es2021-commonjs-node";
  private isolated = false;
  /** The package identity the sources carry, where a case gives them one. */
  private packageName: string | undefined;
  /** The **narrowest bound** any of this scenario's builds produced: how many
   * project files a compile rooted at, against how many the project has. For
   * the suite's own account of which scenarios exercised the mechanism and
   * which merely ran beside it (see {@link engagement}).
   *
   * Undefined where no build bounded anything — a cold build, a forced one, one
   * with no base — which is the same thing as rooting at every file. */
  public bound: { roots: number; project: number } | undefined;
  /** How many times the compiler actually ran. */
  public runs = 0;

  constructor(root: string, deps: PackageFileSet[] = []) {
    this.root = root;
    this.cache = new BuildCache(path.join(root, "cache"), NULL_LOG);
    this.deps = deps;
  }

  public write(files: Record<string, string>): void {
    for (const [name, content] of Object.entries(files)) {
      this.sources.set(name, content);
    }
  }

  public remove(name: string): void {
    this.sources.delete(name);
  }

  /** Retarget the compile, which rewrites its generated project. `es2021`
   * alone keeps CommonJS; `es2021-esm` asks for the ES-module emit whose
   * specifiers are rewritten. */
  public emit(level: string): void {
    this.target = level.includes("-") ? level : `${level}-commonjs-node`;
  }

  /** Compile under `isolatedModules`, which a project may set for itself and
   * which refuses an ambient const enum outright. */
  public strictModules(): void {
    this.isolated = true;
  }

  /** Give the sources a package identity of their own, so they can import
   * themselves by name — the self row, and the `paths` the declaration emitter
   * reads (see BuildJSCompile.selfReferencePaths). */
  public asPackage(name: string): void {
    this.packageName = name;
  }

  /** Stage an extra file at the workspace root, outside the compiled tree —
   * the shape a mounted tool's own files have. */
  public stage(name: string, content: string): void {
    this.extras.set(name, content);
  }

  /** The action as the rule composes it: the sources under `src/`, the
   * generated project, and the driver mounted apart. */
  private action(): BuildAction {
    const workspace = FileSet.layout({
      [COMPILE_SRC_DIR]: new FileSet(new Map([...this.sources].map(([name, text]) => [name, MemoryFile.from(text)]))),
      ...Object.fromEntries([...this.extras].map(([name, text]) => [name, MemoryFile.from(text)])),
      "tsconfig.json": MemoryFile.from(
        JSON.stringify(
          this.isolated
            ? withIsolatedModules(makeTsConfig(parseJSTarget(this.target), undefined, {}, undefined, this.packageName))
            : makeTsConfig(parseJSTarget(this.target), undefined, {}, undefined, this.packageName)
        )
      ),
    });
    return createNodeExecAction(
      workspace,
      this.deps,
      [process.execPath, TSC_DRIVER!, "--deps-report", DEPS_REPORT_FILE, STATE_DIR_FLAG, STATE_DIR, CHANGES_FLAG, CHANGES_FILE],
      `${COMPILE_OUT_DIR}:**`,
      {
        layout: PNP,
        depsReport: DEPS_REPORT_FILE,
        stateDir: STATE_DIR,
        changes: CHANGES_FILE,
        ...(this.packageName ? { self: { name: this.packageName, location: `./${COMPILE_SRC_DIR}/` } } : {}),
      }
    );
  }

  /** Build once, through the same two-phase demand the framework makes. */
  public async build(options: { force?: boolean } = {}): Promise<FileSet> {
    const built = this.action();
    /* Composed as the framework composes it: the discoverable inputs left out
     * of the anchor, so this test cannot accidentally key on something
     * production would not (or miss something it would — the generated project
     * is in here). */
    return toPromise(
      this.cache.getOrCreateAction(
        built,
        ctx => {
          this.runs++;
          lastCompile = this;
          /* The bound the driver planned is read back off its report — red
           * runs included, whose report is written before the failure — for
           * the suite's own account of the mechanism (see {@link engagement}). */
          return NODE_EXEC_ACTION.run(built, ctx, SILENT_REPORT).then(
            result => {
              this.recordBound(ctx.workDir);
              return result;
            },
            (err: unknown) => {
              this.recordBound(ctx.workDir);
              throw err;
            }
          );
        },
        /* The cache builds the context, exactly as it does in a build — so
         * `force` reaches the step's build state through the same option a
         * forced build uses, and nothing here hands it a base by hand. */
        {
          targetKey: TARGET_KEY,
          processLimit: new Semaphore(UNBOUNDED),
          ...options,
        }
      )
    );
  }

  /** How narrowly the run just finished bounded its program, per the driver's
   * own telemetry. Observation only: nothing here reaches the build. */
  private recordBound(workDir: string): void {
    const report = path.join(workDir, DEPS_REPORT_FILE);
    if (!fs.existsSync(report)) {
      return;
    }
    const telemetry = toCompileTelemetry(JSON.parse(fs.readFileSync(report, "utf8")));
    this.bound = narrowest(this.bound, telemetry?.bound);
  }

  /** The build state as it now stands — the entry the record's `outputs` link
   * names, the base input manifest and the driver's graph — or undefined for a
   * target key with none, which for these cases includes a record missing
   * either half (a green build always records both). The record keeps whatever
   * the driver left in its state directory, any number of files; THIS driver
   * leaves exactly one, which is asserted rather than assumed — it is a fact
   * about the driver, not about the record. */
  public async memo(): Promise<{ base: string; inputs: FileSet; graph: NonNullable<ReturnType<typeof parseDriverMemo>> } | undefined> {
    const record = await toPromise(this.cache.readBuildState(TARGET_KEY));
    const state = [...(record?.incrementalState ?? [])];
    expect(state.length, "state files the driver kept").to.be.at.most(1);
    const [, driver] = state[0] ?? [];
    /* One view over both halves — the tests ask "was this file in the base"
     * without caring which half answered. */
    const inputs =
      record?.inputs === undefined || record.discovered === undefined
        ? undefined
        : FileSet.unionAll(record.inputs, record.discovered.files);
    if (driver === undefined || inputs === undefined) {
      return undefined;
    }
    const graph = parseDriverMemo(await toPromise(driver.readString()));
    return graph === undefined ? undefined : { base: this.baseEntry(), inputs, graph };
  }

  /** The entry key the record points at, read off the link itself — the durable
   * form of "which build this record describes". */
  private baseEntry(): string {
    const link = fs.readlinkSync(path.join(this.root, "cache", "incremental", TARGET_KEY, "outputs"));
    return path.basename(link, ".manifest");
  }
}

/** The diagnostic lines out of a failed build's message — what the compiler
 * said and where, with fabr's own framing dropped. */
function diagnosticLines(message: string): string[] {
  return (
    message
      /* The compiler renders these with colour (fabr's projects set `pretty`), so
       * the escapes come off before anything is matched or compared. */
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;]*m/g, "")
      .split("\n")
      /* Either rendering the compiler may use: the plain `file(line,col)` form
       * and the pretty `file:line:col` one. */
      .filter(line => /\.tsx?[(:]\d+[,:]\d+\)? *-? *error TS\d+/.test(line))
      .map(line => line.trim())
      .sort()
  );
}

/** A project that sets `isolatedModules` for itself — fabr's generated ones do
 * not, so the case has to be built deliberately. */
function withIsolatedModules(project: Record<string, unknown>): Record<string, unknown> {
  return { ...project, compilerOptions: { ...(project.compilerOptions as Record<string, unknown>), isolatedModules: true } };
}

/** How narrowly each scenario bounded its program — the suite's own record of
 * where the mechanism engaged.
 *
 * Every case below asks whether the run produces what a full compile produces,
 * and a run that bounded NOTHING (rooting at every project file, every time)
 * answers that question green while doing none of the work the mechanism
 * exists for. So this is the only thing that says the bound is narrowing rather
 * than merely not breaking. A measurement per case rather than a name per case,
 * because the test name is the runner's business and these files run under two
 * of them. */
const engagement: Array<{ roots: number; project: number } | undefined> = [];

/** The Compile most recently built, for the cases that make their own. */
let lastCompile: Compile | undefined;

/** Record how narrowly the scenario just finished bounded its program. */
function recordEngagement(compile: Compile | undefined): void {
  engagement.push(compile?.bound);
}

/** The narrower of two bounds, by the fraction of the project rooted — what a
 * scenario's several builds come to as one number. */
function narrowest(
  held: { roots: number; project: number } | undefined,
  found: { roots: number; project: number } | undefined
): { roots: number; project: number } | undefined {
  if (held === undefined || found === undefined) {
    return held ?? found;
  }
  return found.roots * held.project < held.roots * found.project ? found : held;
}

/** A dependency package holding one declaration. */
function pkg(name: string, declaration: string): PackageFileSet {
  return new PackageFileSet(
    new Map<string, IFile>([
      ["index.d.ts", MemoryFile.from(declaration)],
      ["package.json", MemoryFile.from(`{"name":"${name}","version":"1.0.0","types":"index.d.ts"}\n`)],
    ]),
    name,
    "1.0.0",
    []
  );
}

async function contentOf(files: FileSet, name: string): Promise<string> {
  return toPromise(files.readFile(name));
}

/** The same sources compiled from nothing, in a store of their own — the oracle
 * every incremental case is measured against. */
async function compiledFromNothing(sources: Record<string, string>, target?: string): Promise<FileSet> {
  const cold = new Compile(fs.mkdtempSync(path.join(os.tmpdir(), "fabr-reference-")));
  if (target !== undefined) {
    cold.emit(target);
  }
  cold.write(sources);
  return cold.build();
}

/**
 * Every incremental scenario. Each is asked the same question — *does the run
 * produce what a full compile of the same sources produces?* — because that is
 * what makes the mechanism an acceleration rather than a second semantics.
 *
 * The root-at-everything state is an internal state the mechanism reaches on its
 * own — a cold or forced build, a change to a non-node input, a global change,
 * the fallback — and each of those has its own case here.
 */
function incrementalScenarios(): void {
  describe("incremental compiles", () => {
    let root: string;
    let compile: Compile;

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-incremental-test-"));
      compile = new Compile(root);
    });

    afterEach(() => {
      /* How narrowly this scenario bounded its program, kept so the suite can
       * say which cases exercised the mechanism and which merely ran beside it —
       * a cold build bounds nothing, and a case that only ever builds cold
       * proves nothing about bounding. */
      recordEngagement(compile);
      fs.rmSync(root, { recursive: true, force: true });
    });

    /** Every output a compile of these sources produces, so a test can say
     * "complete" and mean it. */
    const OUTPUTS = ["index.d.ts", "index.js", "util.d.ts", "util.js"];

    function twoFiles(): void {
      compile.write({
        "util.ts": "export function pad(text: string): string {\n  return text;\n}\n",
        "index.ts": 'import { pad } from "./util";\nexport const padded = pad("x");\n',
      });
    }

    it("leaves a memo of the build it committed", async () => {
      twoFiles();
      const built = await compile.build();
      expect([...built].map(([name]) => name).sort()).to.deep.equal(OUTPUTS);

      const memo = await compile.memo();
      expect(memo, "a green build records what it was made of").to.not.equal(undefined);
      /* Every input, so the next build can diff against it — the sources, the
       * generated project, and the edges the compiler reported. */
      expect(memo!.graph.get("src/index.ts")?.use.map(edge => edge.specifier)).to.deep.equal(["./util"]);
      expect(memo!.inputs.getFile("tsconfig.json"), "including what is not a node of the graph").to.not.equal(undefined);
      /* And it names the entry it describes. */
      expect(memo!.base).to.have.lengthOf(64);
    });

    it("rebuilds one file for a body edit, and still commits the whole output", async () => {
      twoFiles();
      await compile.build();
      const first = (await compile.memo())!.base;

      compile.write({ "index.ts": 'import { pad } from "./util";\nexport const padded = pad("y");\n' });
      const built = await compile.build();
      expect(compile.runs).to.equal(2);
      /* The entry is complete however little was emitted: a later build hitting
       * this key gets the whole output, with no knowledge that a wave produced
       * it from a delta. */
      expect([...built].map(([name]) => name).sort()).to.deep.equal(OUTPUTS);
      expect(await contentOf(built, "index.js")).to.contain('("y")');
      expect(await contentOf(built, "util.js"), "and the file that was not rebuilt is the base's").to.contain("return text");
      expect((await compile.memo())!.base, "the base advances to the entry just committed").to.not.equal(first);
    });

    it("hits without compiling at all when an edit is reverted", async () => {
      twoFiles();
      const original = await compile.build();
      compile.write({ "index.ts": 'import { pad } from "./util";\nexport const padded = pad("y");\n' });
      await compile.build();
      expect(compile.runs).to.equal(2);

      compile.write({ "index.ts": 'import { pad } from "./util";\nexport const padded = pad("x");\n' });
      const reverted = await compile.build();
      expect(compile.runs, "the first entry is still in the store").to.equal(2);
      expect(await contentOf(reverted, "index.js")).to.equal(await contentOf(original, "index.js"));
    });

    it("carries every edit since the last GREEN build, not since the last run", async () => {
      /* A red cycle commits nothing and moves no memo, so its edits are still
       * changed next time. Diffing against the base rather than reacting to
       * events is what makes that work. */
      twoFiles();
      await compile.build();
      const green = (await compile.memo())!.base;

      compile.write({ "index.ts": 'import { pad } from "./util";\nexport const padded: number = pad("x");\n' });
      await compile.build().then(
        () => expect.fail("a type error must fail the build"),
        () => undefined
      );
      expect((await compile.memo())!.base, "a red run moves nothing").to.equal(green);

      /* Now fix that file by editing ANOTHER one: the wave must carry both, or
       * the still-broken file would go unchecked and a red build would commit. */
      compile.write({ "util.ts": "export function pad(text: string): number {\n  return text.length;\n}\n" });
      const built = await compile.build();
      expect(await contentOf(built, "index.js")).to.contain('("x")');
      expect((await compile.memo())!.base).to.not.equal(green);
    });

    it("re-checks the closure of a signature change", async () => {
      twoFiles();
      await compile.build();
      compile.write({ "util.ts": "export function pad(text: string): number {\n  return text.length;\n}\n" });
      await compile.build();
      const built = await compile.build();
      expect(compile.runs, "the third demand hits").to.equal(2);
      /* index.ts was re-emitted as part of the closure, so its declaration
       * carries the changed type through. */
      expect(await contentOf(built, "index.d.ts")).to.contain("number");
    });

    it("re-emits an importer an added file re-binds", async () => {
      /* The one change that reaches a file with no edge to it: `./util` resolved
       * to `util/index.ts`, and a `util.ts` appearing beside it takes the name. */
      compile.write({
        "util/index.ts": "export const pad = (text: string): string => text;\n",
        "index.ts": 'import { pad } from "./util";\nexport const padded = pad("x");\n',
      });
      await compile.build();
      compile.write({ "util.ts": "export const pad = (text: string): number => text.length;\n" });
      const built = await compile.build();
      /* The importer was re-checked and re-emitted against the file that now
       * answers `./util`. */
      expect(await contentOf(built, "index.d.ts")).to.contain("number");
    });

    it("waves only the new file when an addition binds nothing", async () => {
      twoFiles();
      await compile.build();
      compile.write({ "extra.ts": "export const other = 1;\n" });
      const built = await compile.build();
      expect([...built].map(([name]) => name).sort()).to.deep.equal([...OUTPUTS, "extra.d.ts", "extra.js"].sort());
      /* Nothing named `./extra`, so nothing rebinds and the wave is the addition
       * alone — but the entry still holds every output. */
      expect(await contentOf(built, "util.js")).to.contain("return text");
    });

    it("reports a deleted file's importers as broken, exactly as a full compile does", async () => {
      /* Case 1: the dependers still import it. The wave reaches them through
       * the base's edges — a deleted file's shape is nothing, which differs
       * from whatever it was — and they fail to resolve it. A red run commits
       * nothing, so what matters is that the diagnosis is the one a full
       * compile of the same tree gives. */
      twoFiles();
      await compile.build();
      compile.remove("util.ts");
      let reported: string[] = [];
      await compile.build().then(
        () => expect.fail("the importer's module is missing"),
        (err: Error) => {
          reported = diagnosticLines(err.message);
        }
      );
      const cold = new Compile(fs.mkdtempSync(path.join(os.tmpdir(), "fabr-deleted-ref-")));
      cold.write({ "index.ts": 'import { pad } from "./util";\nexport const padded = pad("x");\n' });
      let fromNothing: string[] = [];
      await cold.build().then(
        () => expect.fail("a cold compile of the same tree must fail too"),
        (err: Error) => {
          fromNothing = diagnosticLines(err.message);
        }
      );
      expect(reported, "the same diagnosis a full compile gives").to.deep.equal(fromNothing);
      expect(reported.join("\n"), "and it says so").to.contain("Cannot find module './util'");
    });

    it("subtracts a deleted file's outputs when nothing is left to re-emit", async () => {
      /**
       * Case 2: the depender dropped the import in an EARLIER build, so
       * deleting the file waves nothing at all — no depender to reach, and the
       * file itself emits nothing because it is gone. The commit is a
       * removal-only delta, which the carried entry has to survive: what comes
       * off is what the memo recorded this source emitted.
       */
      compile.write({
        "orphan.ts": "export const orphan = 1;\n",
        "index.ts": 'import { orphan } from "./orphan";\nexport const seen = orphan;\n',
      });
      await compile.build();
      /* The import goes first, in its own build. */
      const dropped = { "orphan.ts": "export const orphan = 1;\n", "index.ts": "export const seen = 0;\n" };
      compile.write(dropped);
      await compile.build();
      expect(await contentOf(await compile.build(), "orphan.js"), "still emitted while it is there").to.contain("orphan");

      compile.remove("orphan.ts");
      const after = await compile.build();
      expect([...after].map(([name]) => name).sort(), "its outputs came off, and index's stayed").to.deep.equal([
        "index.d.ts",
        "index.js",
      ]);
      expect(after.toManifest(), "and the entry is a from-nothing build's").to.equal(
        (await compiledFromNothing({ "index.ts": "export const seen = 0;\n" })).toManifest()
      );
    });

    it("subtracts a deleted file's outputs when it was global too", async () => {
      /* Case 3: a deleted file that affected global scope. The base flag puts
       * the wave over everything (nothing has an edge to a global), and the
       * outputs of the file that went still have to come off. */
      const base = {
        "env.ts": "declare global {\n  const FABR_PROBE: number;\n}\nexport const env = 1;\n",
        "index.ts": "export const value = 2;\n",
      };
      compile.write(base);
      await compile.build();
      compile.remove("env.ts");
      const after = await compile.build();
      expect([...after].map(([name]) => name).sort()).to.deep.equal(["index.d.ts", "index.js"]);
      expect(after.toManifest()).to.equal((await compiledFromNothing({ "index.ts": "export const value = 2;\n" })).toManifest());
    });

    it("produces a full compile's entry after a deletion", async () => {
      /* Case 4: the byte-equality capstone with a deletion in the chain — an
       * edit, then a delete, then an edit, against the same state built from
       * nothing. */
      compile.write({
        "util.ts": "export function pad(text: string): string {\n  return text;\n}\n",
        "gone.ts": "export const gone = 1;\n",
        "index.ts": 'import { pad } from "./util";\nexport const padded = pad("x");\n',
      });
      await compile.build();
      compile.write({ "index.ts": 'import { pad } from "./util";\nexport const padded = pad("y");\n' });
      await compile.build();
      compile.remove("gone.ts");
      await compile.build();
      compile.write({ "util.ts": "export function pad(text: string): string {\n  return `${text} `.trim();\n}\n" });
      const incremental = await compile.build();
      expect(compile.runs).to.equal(4);
      const final = {
        "util.ts": "export function pad(text: string): string {\n  return `${text} `.trim();\n}\n",
        "index.ts": 'import { pad } from "./util";\nexport const padded = pad("y");\n',
      };
      expect(incremental.toManifest()).to.equal((await compiledFromNothing(final)).toManifest());
    });

    it("recompiles everything when the generated project changes, at the same target key", async () => {
      /* Nothing has an edge to the project file, so no closure could bound what
       * changing it affects: the answer is every file. It stays the SAME
       * target key,
       * though — the memo carries on rather than starting over, so the next
       * ordinary edit is incremental again. */
      twoFiles();
      await compile.build();
      expect(await contentOf(await compile.build(), "util.js")).to.contain("function pad");

      compile.emit("es5");
      const retargeted = await compile.build();
      expect(compile.runs).to.equal(2);
      /* Every output carries the new target, not just the one that would have
       * been in a wave. */
      expect(await contentOf(retargeted, "util.js"), "the unedited file was re-emitted too").to.contain("function pad");
      expect(await contentOf(retargeted, "index.js")).to.contain("var ");

      /* And the target key is unchanged: an ordinary edit after it is bounded
       * again, against the memo this run left. */
      expect(await compile.memo(), "the memo is still there to work from").to.not.equal(undefined);
      compile.write({ "index.ts": 'import { pad } from "./util";\nexport const padded = pad("z");\n' });
      const after = await compile.build();
      expect(compile.runs).to.equal(3);
      expect(await contentOf(after, "index.js")).to.contain('("z")');
      expect(await contentOf(after, "util.js"), "carried forward from the run before").to.contain("function pad");
    });

    it("recompiles everything when a staged tool file changes, at the same target key", async () => {
      /* A tool arrives as its assembled install — ordinary per-file content in
       * the staged workspace, no graph edge naming it — so the driver cannot
       * bound what changing it affects: the answer is every file (a swapped
       * compiler must never serve stale waves). Same target key, though: the
       * memo carries on, and the next ordinary edit is incremental again. */
      twoFiles();
      compile.stage("tool/compiler-stamp.js", "// release 1\n");
      await compile.build();
      compile.stage("tool/compiler-stamp.js", "// release 2\n");
      const swapped = await compile.build();
      expect(compile.runs).to.equal(2);
      expect(await contentOf(swapped, "util.js"), "the unedited file was re-emitted too").to.contain("function pad");
      expect(await compile.memo(), "the memo is still there to work from").to.not.equal(undefined);
      compile.write({ "index.ts": 'import { pad } from "./util";\nexport const padded = pad("q");\n' });
      const after = await compile.build();
      expect(compile.runs).to.equal(3);
      expect(await contentOf(after, "index.js")).to.contain('("q")');
    });

    it("re-checks everything when an ambient declaration changes", async () => {
      /* Nothing imports a global, so no edge reaches the files it affects: only a
       * wave over everything can catch this, and the flag recorded for the file
       * is what says so. */
      compile.write({
        "globals.d.ts": "declare const FABR_PROBE: number;\n",
        "index.ts": "export const value = FABR_PROBE * 2;\n",
        "other.ts": "export const other = 1;\n",
      });
      await compile.build();
      expect((await compile.memo())!.graph.get("src/globals.d.ts")?.global, "the flag is recorded for next time").to.equal(true);

      compile.write({ "globals.d.ts": "declare const FABR_PROBE: string;\n" });
      await compile.build().then(
        () => expect.fail("index.ts uses the global as a number"),
        (err: Error) => expect(err.message).to.contain("exited with error code")
      );
    });

    it("re-checks the importers of an imported JSON module", async () => {
      /* A `.json` has no interface artifact of its own, so its shape degrades to
       * its content — coarse, and enough to reach its importers. */
      compile.write({
        "data.json": '{ "n": 1 }\n',
        "index.ts": 'import data from "./data.json";\nexport const value = data.n * 2;\n',
      });
      await compile.build();

      compile.write({ "data.json": '{ "renamed": 1 }\n' });
      await compile.build().then(
        () => expect.fail("the importer reads a field that has gone"),
        (err: Error) => expect(err.message).to.contain("exited with error code")
      );
    });

    it("waves through a package's reference to itself", async () => {
      /* A bare specifier the package table answers with one of THIS compile's own
       * files: the edge records its target, since no membership check could
       * replay a package name. */
      compile.asPackage("mypkg");
      compile.write({
        "util.ts": "export const pad = (text: string): string => text;\n",
        "index.ts": 'import { pad } from "mypkg/util";\nexport const padded = pad("x");\n',
      });
      await compile.build();
      expect((await compile.memo())!.graph.get("src/index.ts")?.use).to.deep.equal([
        { specifier: "mypkg/util", target: "src/util.ts" },
      ]);

      compile.write({ "util.ts": "export const pad = (text: string): number => text.length;\n" });
      const built = await compile.build();
      expect(await contentOf(built, "index.d.ts"), "the self-referencing importer was re-checked").to.contain("number");
    });

    it("re-binds a self-reference an added file captures", async () => {
      /* The addition case for a bare specifier: `mypkg/util` resolved into a
       * directory, and a `util.ts` appearing beside it takes the name. The probe
       * index reaches it through the target the edge recorded — fabr's generated
       * projects map only the package's own name (there is no `baseUrl`), so this
       * is the whole of the in-tree capture surface. */
      compile.asPackage("mypkg");
      compile.write({
        "util/index.ts": "export const pad = (text: string): string => text;\n",
        "index.ts": 'import { pad } from "mypkg/util";\nexport const padded = pad("x");\n',
      });
      await compile.build();

      compile.write({ "util.ts": "export const pad = (text: string): number => text.length;\n" });
      const built = await compile.build();
      expect(await contentOf(built, "index.d.ts"), "the importer now binds the added file").to.contain("number");
    });

    /**
     * **Import cycles**, which are free: all checking happens against ONE
     * program built from the current sources, so a waved file sees its
     * partner's live types rather than a stale artifact, and shapes gate wave
     * MEMBERSHIP without ever gating checking. The oracle throughout is
     * byte-equality with the same sources built from nothing, so a wave that
     * under-carries or a fixpoint that stops early shows up as different bytes
     * rather than as a passing test.
     */
    const CYCLE = {
      "a.ts":
        'import { fromB } from "./b";\nexport interface Thing {\n  n: number;\n}\nexport const fromA = (): Thing => ({ n: fromB() });\n',
      "b.ts":
        'import type { Thing } from "./a";\nexport const fromB = (): number => 1;\nexport const widen = (t: Thing): number => t.n;\n',
      "c.ts": 'import { fromA } from "./a";\nexport const value = fromA();\n',
      /* Outside the cycle and outside every edit below, so the cycle is waved
       * inside a program that is genuinely bounded: a cycle member is always in
       * the bound when its partner is edited (each reaches the other), so
       * without a file the bound leaves out these cases would root at the whole
       * project and prove nothing about the pair. */
      "aside.ts": "export const aside = 1;\n",
    };

    it("carries a body edit inside a cycle no further than it should", async () => {
      compile.write(CYCLE);
      await compile.build();
      const edited = { ...CYCLE, "a.ts": CYCLE["a.ts"].replace("fromB()", "fromB() + 0") };
      compile.write(edited);
      const incremental = await compile.build();
      expect(incremental.toManifest()).to.equal((await compiledFromNothing(edited)).toManifest());
      expect(await contentOf(incremental, "a.js"), "the edited member was re-emitted").to.contain("+ 0");
    });

    it("carries a signature edit inside a cycle to its partner and beyond", async () => {
      compile.write(CYCLE);
      const base = await compile.build();
      /* `fromA`'s result type moves, which its cycle partner and the outside
       * consumer both see — the closure has to cross the cycle to reach them. */
      const edited = { ...CYCLE, "a.ts": CYCLE["a.ts"].replace("(): Thing =>", "(): Thing | undefined =>") };
      compile.write(edited);
      const incremental = await compile.build();
      expect(incremental.toManifest()).to.equal((await compiledFromNothing(edited)).toManifest());
      expect(await contentOf(incremental, "c.d.ts"), "the consumer's own declaration moved with it").to.not.equal(
        await contentOf(base, "c.d.ts")
      );
      expect(await contentOf(incremental, "c.d.ts")).to.contain("undefined");
    });

    it("merges two body edits made in one cycle in a single build", async () => {
      /* Both members changed at once: a walk that marked the first change's
       * closure visited and stopped could miss what the second one reaches. */
      compile.write(CYCLE);
      await compile.build();
      const edited = {
        ...CYCLE,
        "a.ts": CYCLE["a.ts"].replace("fromB()", "fromB() + 0"),
        "b.ts": CYCLE["b.ts"].replace("=> 1;", "=> 2;"),
      };
      compile.write(edited);
      const incremental = await compile.build();
      expect(incremental.toManifest()).to.equal((await compiledFromNothing(edited)).toManifest());
      expect(await contentOf(incremental, "b.js")).to.contain("2");
    });

    it("merges two signature edits pulling opposite ways in one cycle", async () => {
      compile.write(CYCLE);
      await compile.build();
      /* One member's surface widens while the other's narrows, in the same
       * build: the fixpoint has to settle both, and the consumer sees the
       * result of the pair rather than of whichever was walked first. */
      const edited = {
        ...CYCLE,
        "a.ts": CYCLE["a.ts"].replace("(): Thing =>", "(): Thing | undefined =>"),
        "b.ts": CYCLE["b.ts"].replace("export const fromB = (): number => 1;", "export const fromB = (): 1 => 1;"),
      };
      compile.write(edited);
      const incremental = await compile.build();
      expect(incremental.toManifest()).to.equal((await compiledFromNothing(edited)).toManifest());
      expect(await contentOf(incremental, "b.d.ts"), "the narrowed member").to.contain("1");
      expect(await contentOf(incremental, "c.d.ts"), "the widened one, through the consumer").to.contain("undefined");
    });

    /** A cycle of VALUES rather than types: the emitted JavaScript really does
     * require in a circle, so the emit — and, under an ES-module target, the
     * specifier rewrite — has to come out of a partial program exactly as it
     * comes out of a whole one. */
    const VALUE_CYCLE = {
      "even.ts": 'import { isOdd } from "./odd";\nexport const isEven = (n: number): boolean => (n === 0 ? true : isOdd(n - 1));\n',
      "odd.ts": 'import { isEven } from "./even";\nexport const isOdd = (n: number): boolean => (n === 0 ? false : isEven(n - 1));\n',
      "main.ts": 'import { isEven } from "./even";\nexport const four = isEven(4);\n',
      "aside.ts": "export const aside = 1;\n",
    };

    it("emits a value cycle's circular requires as a full compile does", async () => {
      compile.write(VALUE_CYCLE);
      await compile.build();
      const edited = { ...VALUE_CYCLE, "even.ts": VALUE_CYCLE["even.ts"].replace("n - 1", "n - 1 + 0") };
      compile.write(edited);
      const incremental = await compile.build();
      expect(incremental.toManifest()).to.equal((await compiledFromNothing(edited)).toManifest());
      expect(await contentOf(incremental, "even.js"), "and the circle is really there").to.contain('require("./odd")');
    });

    it("rewrites a value cycle's specifiers as a full compile does", async () => {
      compile.emit("es2021-esm-node");
      compile.write(VALUE_CYCLE);
      await compile.build();
      const edited = { ...VALUE_CYCLE, "even.ts": VALUE_CYCLE["even.ts"].replace("n - 1", "n - 1 + 0") };
      compile.write(edited);
      const incremental = await compile.build();
      expect(incremental.toManifest()).to.equal((await compiledFromNothing(edited, "es2021-esm-node")).toManifest());
      /* Both directions of the circle name the files this compile emits. */
      expect(await contentOf(incremental, "even.js")).to.contain('from "./odd.js"');
      expect(await contentOf(incremental, "odd.js")).to.contain('from "./even.js"');
    });

    it("produces what a cold build would, however many cycles it took", async () => {
      /* The doctrine, made executable: delete the cache and the result is the
       * same. Four cycles of the kinds that carry entries forward — a body edit,
       * a signature edit, an addition — then the same sources compiled from
       * nothing at all. */
      twoFiles();
      await compile.build();
      compile.write({ "index.ts": 'import { pad } from "./util";\nexport const padded = pad("y");\n' });
      await compile.build();
      compile.write({ "util.ts": "export function pad(text: string): number {\n  return text.length;\n}\n" });
      await compile.build();
      compile.write({ "extra.ts": 'import { padded } from "./index";\nexport const shown = String(padded);\n' });
      const incremental = await compile.build();
      expect(compile.runs).to.equal(4);
      /* A chain of four builds that each rooted at everything would pass the
       * manifest comparison below while proving nothing about bounding, so the
       * narrowing is asserted here rather than left to the aggregate. */
      expect(compile.bound, "the capstone must bound a program to mean anything").to.not.equal(undefined);
      expect(compile.bound!.roots, "and root at less than the whole project").to.be.lessThan(compile.bound!.project);

      const cold = new Compile(path.join(root, "cold"));
      cold.write({
        "util.ts": "export function pad(text: string): number {\n  return text.length;\n}\n",
        "index.ts": 'import { pad } from "./util";\nexport const padded = pad("y");\n',
        "extra.ts": 'import { padded } from "./index";\nexport const shown = String(padded);\n',
      });
      const fresh = await cold.build();
      expect(cold.runs).to.equal(1);
      /* Name, content and mode of every output — the manifest IS the comparison,
       * since that is what a later build keys and serves. */
      expect(incremental.toManifest()).to.equal(fresh.toManifest());
    });

    it("compiles everything when the build is forced", async () => {
      twoFiles();
      await compile.build();
      const built = await compile.build({ force: true });
      expect(compile.runs).to.equal(2);
      /* Force exists to redo the work, so it is handed no base — and what it
       * commits is a complete entry like any other. */
      expect([...built].map(([name]) => name).sort()).to.deep.equal(OUTPUTS);
    });

    it("emits a union in the same order however much of the program was checked", async () => {
      /**
       * The compiler orders a union's members by **type id**, and ids are handed
       * out as types are first created anywhere in the program — so the printed
       * order records what the checker reached first, and a wave reaches less
       * than a full compile does. That breaks determinism outright, and it costs
       * work: a declaration whose bytes moved is a shape change, so the next wave
       * expands to dependers that had no reason to be re-checked.
       *
       * Nothing imports `aearly`, so the incremental program does not hold it at
       * all, where a full compile checks it first and lets it name `"strict"`
       * first — a wave over a body edit in `zsubject` would otherwise print the
       * three in the order that file's array names them.
       */
      const sources = {
        "pick.ts": "export function pick<T extends string>(values: T[]): T {\n  return values[0];\n}\n",
        "aearly.ts": 'export const early = "strict";\n',
        "zsubject.ts":
          'import { pick } from "./pick";\nexport const mode = pick(["off", "moderate", "strict"]);\nexport const tag = 1;\n',
      };
      compile.write(sources);
      await compile.build();
      const edited = { ...sources, "zsubject.ts": sources["zsubject.ts"].replace("tag = 1", "tag = 2") };
      compile.write(edited);
      const incremental = await compile.build();
      expect(compile.runs).to.equal(2);
      expect(await contentOf(incremental, "zsubject.d.ts"), "one order, and it is not either side's arrival order").to.contain(
        'export declare const mode: "moderate" | "off" | "strict";'
      );
      expect(incremental.toManifest(), "so the wave's bytes ARE the full compile's").to.equal(
        (await compiledFromNothing(edited)).toManifest()
      );
    });

    it("emits an inferred object type's members in the same order too", async () => {
      /**
       * The same root cause as the union case, one construct further on: an
       * inferred object type is commonly a mapped type over a union of key
       * literals, so its properties come out in THAT union's order — type-id
       * order, which is a record of what the checker reached first.
       *
       * `aearly` creates the `"keywords"` literal before `zsubject` is looked
       * at, so a full compile puts `keywords` first while a wave over a body
       * edit in `zsubject` alone puts `title` first.
       */
      const sources = {
        "shape.ts":
          "export function shape<K extends string>(keys: K[]): { [P in K]: number } {\n  return {} as { [P in K]: number };\n}\n",
        "aearly.ts": 'export const early = "keywords";\n',
        "zsubject.ts": 'import { shape } from "./shape";\nexport const value = shape(["title", "keywords"]);\nexport const tag = 1;\n',
      };
      compile.write(sources);
      await compile.build();
      const edited = { ...sources, "zsubject.ts": sources["zsubject.ts"].replace("tag = 1", "tag = 2") };
      compile.write(edited);
      const incremental = await compile.build();
      expect(compile.runs).to.equal(2);
      expect(incremental.toManifest(), "the wave's bytes ARE the full compile's").to.equal(
        (await compiledFromNothing(edited)).toManifest()
      );
    });

    it("leaves an interface in the order the source wrote it", async () => {
      /* The boundary the type-literal sort stops at, pinned so widening the
       * pass to interfaces fails here: inference never synthesizes an
       * `interface`, so one is always authored and already deterministic. */
      compile.write({ "index.ts": "export interface Held {\n  b: number;\n  a: string;\n}\n" });
      const built = await compile.build();
      const emitted = await contentOf(built, "index.d.ts");
      expect(emitted.indexOf("b: number"), "b was written first and stays first").to.be.lessThan(emitted.indexOf("a: string"));
    });

    it("canonicalizes a union the source itself wrote", async () => {
      /* The uniform choice, pinned: a `.d.ts` is a generated artifact and its
       * union order reaches nobody as meaning — a consumer's compiler re-sorts
       * by its own type ids on load — so there is no reason to carry a seam
       * through it where half the unions mean their order and half do not. */
      compile.write({ "index.ts": 'export type Mode = "b" | "a";\nexport declare const held: Mode;\n' });
      const built = await compile.build();
      expect(await contentOf(built, "index.d.ts")).to.contain('export type Mode = "a" | "b";');
    });

    it("pairs a .json with its own shape, not its neighbour's declaration", async () => {
      /**
       * A stem is not a name. `data.ts` and `data.json` may sit side by side —
       * legally, since they emit different files — and both stem to `data`, so
       * pairing a source with its declaration BY STEM gives the `.json` the
       * `.ts`'s declaration. The compiler emits no declaration for a `.json` at
       * all, so its shape is its own content; taking a neighbour's instead means
       * the wave compares the wrong artifact and reads a change where there is
       * none, or misses one where there is. The driver pairs a source with the
       * WRITTEN declaration name at emit time for exactly this reason.
       *
       * Body-only edit, so the wave stays narrow and the pairing is what decides
       * the answer.
       */
      const consumer = (annotation: string): string =>
        `import config from "./data.json";\nimport { label } from "./data";\nexport function run(): void {\n  const held: ${annotation} = config.port;\n  void held;\n  void label;\n}\n`;
      compile.write({
        "data.json": '{ "port": 8080 }\n',
        "data.ts": 'export const label = "data";\n',
        "index.ts": consumer("number"),
      });
      await compile.build();
      compile.write({ "index.ts": consumer("string") });
      let reported: string[] = [];
      try {
        await compile.build();
        expect.fail("the compile must fail: the json's port is a number");
      } catch (error) {
        reported = diagnosticLines((error as Error).message);
      }
      expect(reported.length, `expected one diagnostic, got ${JSON.stringify(reported)}`).to.equal(1);
      expect(reported[0], "the json's own type governed").to.contain("Type 'number' is not assignable to type 'string'");
    });

    it("lets a hand-written declaration govern the .js it types", async () => {
      /**
       * The `allowJs` idiom: a `.js` implementation beside a hand-written
       * `.d.ts` that types it, where the written declaration is the authority
       * and the inferred one must not displace it.
       *
       * The two disagree on purpose here, and in the direction that hides: the
       * written declaration REJECTS what inference accepts, so getting this
       * wrong turns a reported error into a silent pass. The edit is confined to
       * a function body, so the wave is as narrow as it goes and the pairing of
       * `foo.js` with a declaration is what decides the answer.
       */
      const consumer = (annotation: string): string =>
        `import { make } from "./foo";\nexport function run(): void {\n  const held: ${annotation} = make();\n  void held;\n}\n`;
      compile.write({
        "foo.js": "export function make() {\n  return 1;\n}\n",
        "foo.d.ts": "export declare function make(): string;\n",
        "index.ts": consumer("string"),
      });
      await compile.build();
      compile.write({ "index.ts": consumer("number") });
      let reported: string[] = [];
      try {
        await compile.build();
        expect.fail("the compile must fail: the written declaration says string");
      } catch (error) {
        reported = diagnosticLines((error as Error).message);
      }
      expect(reported.length, `expected one diagnostic, got ${JSON.stringify(reported)}`).to.equal(1);
      expect(reported[0], "the project's own declaration governed, not the base build's output for foo.js").to.contain(
        "Type 'string' is not assignable to type 'number'"
      );
    });
  });

  describe("incremental compiles against dependencies", () => {
    let root: string;
    let compile: Compile;

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-incremental-dep-test-"));
      lastCompile = undefined;
    });

    afterEach(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    /* These cases build their own Compiles, so engagement is recorded from the
     * one each case last used rather than from a shared field. */
    afterEach(() => recordEngagement(lastCompile));

    it("still cuts a dependency's unread file off, incrementally", async () => {
      /* The unread-dependency cutoff, over the incremental path: the compile
       * reads `used`'s declaration and never opens `unused`, so editing the
       * latter changes no key — and the run does not happen at all. */
      const used = pkg("used", "export declare const value: number;\n");
      compile = new Compile(root, [used, pkg("unused", "export declare const other: number;\n")]);
      compile.write({ "index.ts": 'import { value } from "used";\nexport const doubled = value * 2;\n' });
      await compile.build();
      expect(compile.runs).to.equal(1);

      const edited = new Compile(root, [used, pkg("unused", "export declare const other: string;\n")]);
      edited.write({ "index.ts": 'import { value } from "used";\nexport const doubled = value * 2;\n' });
      /* A separate Compile over the same store: same target key, same anchor, and the
       * dependency it never read has moved. */
      await edited.build();
      expect(edited.runs, "an unread dependency is not in the key").to.equal(0);
    });

    it("keeps cutting an unread dependency off across an incremental rebuild", async () => {
      /* The regression the record can silently cause: its discoverable lines are
       * what the next entry's key is composed from, so recording them ALL rather
       * than what was read would key every later build on every dependency — and
       * the cutoff would survive exactly one build before quietly dying. */
      const used = pkg("used", "export declare const value: number;\n");
      const source = 'import { value } from "used";\nexport const doubled = value * 2;\n';
      compile = new Compile(root, [used, pkg("unused", "export declare const other: number;\n")]);
      compile.write({ "index.ts": source });
      await compile.build();

      /* A source edit: a real miss, which commits a new entry keyed on whatever
       * the memo said this build read. */
      const edited = new Compile(root, [used, pkg("unused", "export declare const other: number;\n")]);
      edited.write({ "index.ts": `${source}export const tripled = value * 3;\n` });
      await edited.build();
      expect(edited.runs).to.equal(1);

      /* And now the unread dependency moves. Still no key of ours mentions it. */
      const bumped = new Compile(root, [used, pkg("unused", "export declare const other: string;\n")]);
      bumped.write({ "index.ts": `${source}export const tripled = value * 3;\n` });
      await bumped.build();
      expect(bumped.runs, "an unread dependency is still not in the key").to.equal(0);
    });

    /**
     * A project whose files reach each other by the package's OWN name — the
     * self-reference idiom, and the one specifier whose answer depends on where
     * the file asking it sits.
     *
     * A bare name is answered from the PnP row that owns the issuer's directory
     * and from nowhere else (the driver never lets the compiler walk
     * `node_modules`, and `paths` is not consulted for a name). Two rows stand
     * for the sources: the anonymous top-level one at the workspace root, and —
     * where the sources are a package — the self row at the source root, which
     * differs from it in exactly one entry, the package's own name.
     *
     * So `Token` arrives at `neighbour` through an import only the source root's
     * row can answer, and a file that resolved from anywhere else would lose it.
     * A THIRD-PARTY dependency does not test this: both rows carry the same
     * dependency list by construction (`pnpManifestOf`), so `axios` resolves
     * from either position.
     *
     * What these assert: an unrooted file must type its dependers exactly as a
     * full compile does, whatever put it in the program.
     */
    const SELF_REFERENCING_SOURCES = {
      "Token.ts": "export interface Token {\n  id: number;\n}\n",
      "neighbour.ts": 'import { Token } from "subject/Token";\nexport function issue(): Token {\n  return { id: 1 };\n}\n',
      "index.ts": 'import { issue } from "./neighbour";\nexport const id = issue().id;\n',
    };

    it("gives a changed file the real types of an unrooted neighbour, not any", async () => {
      /* A file the bound did not root must still carry its real types into the
       * files that were checked (see {@link SELF_REFERENCING_SOURCES}). Asserted
       * in the direction that matters — the type must be sharp enough to REJECT
       * what a full compile rejects, since the failure mode is silent: an import
       * resolving to nothing degrades to `any`, and `any` is assignable to
       * anything. */
      compile = new Compile(root);
      compile.asPackage("subject");
      compile.write(SELF_REFERENCING_SOURCES);
      await compile.build();
      expect(compile.runs).to.equal(1);

      /* Now edit only `index.ts`, so `neighbour` is outside the bound — and
       * have the edit be an error a full compile reports. */
      compile.write({
        "index.ts": 'import { issue } from "./neighbour";\nexport const id = issue().id;\nexport const wrong: string = issue();\n',
      });
      let reported: string[] = [];
      try {
        await compile.build();
        expect.fail("the compile must fail: a Token is not a string");
      } catch (error) {
        reported = diagnosticLines((error as Error).message);
      }
      expect(reported.length, `expected one diagnostic, got ${JSON.stringify(reported)}`).to.equal(1);
      expect(reported[0], "and it names the real type, which an unresolved import would have made 'any'").to.contain(
        "Type 'Token' is not assignable to type 'string'"
      );
    });

    it("compiles a changed file against an unrooted neighbour's self-referenced types", async () => {
      /* The green half of the same shape, and it bites the same way: what
       * `index` re-exports is typed by what `neighbour` returns, so a neighbour
       * that lost its `Token` would emit `any` here — a wrong answer carrying no
       * diagnostic at all, caught by the bytes rather than by an error. */
      const edit = 'import { issue } from "./neighbour";\nexport const id = issue().id;\nexport const same = issue();\n';
      compile = new Compile(root);
      compile.asPackage("subject");
      compile.write(SELF_REFERENCING_SOURCES);
      await compile.build();
      compile.write({ "index.ts": edit });
      const incremental = await compile.build();
      expect(compile.runs).to.equal(2);
      const cold = new Compile(fs.mkdtempSync(path.join(os.tmpdir(), "fabr-reference-self-")));
      cold.asPackage("subject");
      cold.write({ ...SELF_REFERENCING_SOURCES, "index.ts": edit });
      expect(incremental.toManifest()).to.equal((await cold.build()).toManifest());
    });

    it("gives a neighbour importing the changed file its real type back", async () => {
      /**
       * The mirror of the case above: a cycle, where the neighbour's own import
       * points back at the file that changed. `index` changes and `cycle`
       * imports it, so the reverse closure puts `cycle` in the bound and both
       * are rooted — which is the bound doing its job, since an import of a
       * changed file is exactly what it is defined to catch.
       *
       * What it pins is that the import finds the CHANGED source rather than a
       * stale account of it: a stale one would type `make()` as the old `Token`,
       * and a lost one would type it `any` — which is assignable to a string, so
       * a real error would go unreported.
       */
      const body = (assigned: string): string =>
        `import { make } from "./cycle";\nexport interface Token {\n  id: number;\n}\nexport function run(): void {\n  const held: ${assigned} = make();\n  void held;\n}\n`;
      compile = new Compile(root);
      compile.write({
        "index.ts": body("Token"),
        "cycle.ts": 'import type { Token } from "./index";\nexport function make(): Token {\n  return { id: 1 };\n}\n',
      });
      await compile.build();
      compile.write({ "index.ts": body("string") });
      let reported: string[] = [];
      try {
        await compile.build();
        expect.fail("the compile must fail: a Token is not a string");
      } catch (error) {
        reported = diagnosticLines((error as Error).message);
      }
      expect(reported.length, `expected one diagnostic, got ${JSON.stringify(reported)}`).to.equal(1);
      expect(reported[0], "the neighbour kept the changed file's type").to.contain("is not assignable to type 'string'");
    });

    it("recompiles when a lookup that found nothing is later answered", async () => {
      /**
       * The one change no file the compile read can express. The sources type
       * `thing` through the `@types/thing` sidecar, which answers only because
       * no package of that name is in the compilation. Add the real `thing` —
       * which publishes typings of its own — and resolution stops using the
       * sidecar: a full compile now types from `thing`, and the two disagree.
       *
       * Nothing the base build READ has changed. What moved is a recorded
       * ABSENCE — the failed lookup of `thing`, a path that now resolves — so
       * the entry misses, and the planner explains the arrival through the
       * memo's failed-lookup lines (or cold-plans), rather than committing the
       * base's own output as a green build that would never self-heal.
       */
      const sources = {
        "index.ts": 'import { value } from "thing";\nexport function run(): void {\n  const held: number = value;\n  void held;\n}\n',
      };
      compile = new Compile(root, [pkg("@types/thing", "export declare const value: number;\n")]);
      compile.write(sources);
      await compile.build();
      expect(compile.runs).to.equal(1);

      /* The real package arrives, and it disagrees with the sidecar. */
      const deps = [
        pkg("@types/thing", "export declare const value: number;\n"),
        pkg("thing", "export declare const value: string;\n"),
      ];
      const after = new Compile(root, deps);
      after.write(sources);
      let reported: string[] = [];
      try {
        await after.build();
        expect.fail("the compile must fail: thing's own value is a string");
      } catch (error) {
        reported = diagnosticLines((error as Error).message);
      }
      expect(reported.length, `expected one diagnostic, got ${JSON.stringify(reported)}`).to.equal(1);
      expect(reported[0], "typed from the package, not from the sidecar it superseded").to.contain(
        "Type 'string' is not assignable to type 'number'"
      );
    });

    it("keeps a recorded absence alive across a wave that never re-asks", async () => {
      /* The scenario above with an unrelated edit interposed. A wave's program
       * reads FEWER files than a full compile — the aside edit never resolves
       * `thing`, so this run's reads alone would drop the recorded miss, and
       * the package arriving one build later would invalidate nothing. The
       * selection carry (rows and absences alike) is what keeps the miss
       * alive; this is the case that needs the absences carried too. */
      const sources = {
        "index.ts": 'import { value } from "thing";\nexport function run(): void {\n  const held: number = value;\n  void held;\n}\n',
        "aside.ts": "export const aside = 1;\n",
      };
      const sidecar = pkg("@types/thing", "export declare const value: number;\n");
      compile = new Compile(root, [sidecar]);
      compile.write(sources);
      await compile.build();
      /* The interposed wave, touching only the far side of the graph. */
      compile.write({ ...sources, "aside.ts": "export const aside = 2;\n" });
      await compile.build();
      expect(compile.runs).to.equal(2);

      const after = new Compile(root, [sidecar, pkg("thing", "export declare const value: string;\n")]);
      after.write(sources);
      let reported: string[] = [];
      try {
        await after.build();
        expect.fail("the compile must fail: thing's own value is a string");
      } catch (error) {
        reported = diagnosticLines((error as Error).message);
      }
      expect(reported.join("\n"), "the appearance still reached the file that asked").to.contain(
        "Type 'string' is not assignable to type 'number'"
      );
    });

    it("remembers only the dependency files it read", async () => {
      /* The memo is the next build's diff base and the source of its key: a
       * package's LICENSE has no business in either. */
      const used = new PackageFileSet(
        new Map<string, IFile>([
          ["index.d.ts", MemoryFile.from("export declare const value: number;\n")],
          ["package.json", MemoryFile.from('{"name":"used","version":"1.0.0","types":"index.d.ts"}\n')],
          ["LICENSE", MemoryFile.from("all rights reserved\n")],
        ]),
        "used",
        "1.0.0",
        []
      );
      compile = new Compile(root, [used]);
      compile.write({ "index.ts": 'import { value } from "used";\nexport const doubled = value * 2;\n' });
      await compile.build();

      const lines = [...(await compile.memo())!.inputs].map(([name]) => name);
      expect(lines, "the declaration it read").to.contain("used index.d.ts");
      expect(lines, "and the manifest resolution consulted").to.contain("used package.json");
      expect(lines, "but nothing it never opened").to.not.contain("used LICENSE");
    });

    it("cuts off an unread version of a package that coexists with a read one", async () => {
      /* The closure holds two versions of `dup`: the compile reads the hoisted
       * one and never opens the nested one. A bare naming would collide the two
       * and force the whole target back to keying on everything; instance
       * names give them a name each, so the ordinary cutoff applies to both. */
      const read = pkg("dup", "export declare const value: number;\n");
      const source = 'import { value } from "dup";\nexport const doubled = value * 2;\n';
      const closure = (unread: PackageFileSet): PackageFileSet[] => [
        read,
        new PackageFileSet(
          new Map<string, IFile>([["index.d.ts", MemoryFile.from("export declare const held: number;\n")]]),
          "requirer",
          "1.0.0",
          [unread]
        ),
      ];

      const unread = pkg("dup", "export declare const value: string;\n");
      compile = new Compile(root, closure(unread));
      compile.write({ "index.ts": source });
      await compile.build();
      expect(compile.runs).to.equal(1);
      /* Both versions are in the memo's world, each at its own instance — but
       * only the one the compile opened is among its lines. */
      const lines = [...(await compile.memo())!.inputs].map(([name]) => name);
      expect(lines).to.contain("dup index.d.ts");
      expect(lines, "the nested one was never read").to.not.contain("requirer dup index.d.ts");

      const bumped = new Compile(root, closure(pkg("dup", "export declare const value: 7;\n")));
      bumped.write({ "index.ts": source });
      await bumped.build();
      expect(bumped.runs, "the version it never read is not in the key").to.equal(0);
    });

    it("rebuilds when a dependency it did read changes", async () => {
      compile = new Compile(root, [pkg("used", "export declare const value: number;\n")]);
      compile.write({ "index.ts": 'import { value } from "used";\nexport const doubled = value * 2;\n' });
      await compile.build();

      const bumped = new Compile(root, [pkg("used", "export declare const value: string;\n")]);
      bumped.write({ "index.ts": 'import { value } from "used";\nexport const doubled = value * 2;\n' });
      /* The declaration it read now says something its consumer cannot use, so
       * the compile runs again and reports it. */
      await bumped.build().then(
        () => expect.fail("a dependency it read changed under it"),
        (err: Error) => expect(err.message).to.contain("exited with error code")
      );
      expect(bumped.runs).to.equal(1);
    });

    it("waves only a bumped dependency's dependers, under the instance naming", async () => {
      /* A read dependency's content moving changes its reference, so its graph
       * lines are a delete (the old instance's names) plus an add (the new
       * one's, read when the wave re-resolves) — and the wave is still the old
       * lines' DEPENDERS through the recorded edges, not a full compile.
       * Pinned against a cold build of the identical state, with the bound's
       * own account showing it narrowed. */
      const sources = {
        "uses.ts": 'import { value } from "used";\nexport const doubled = value * 2;\n',
        "apart.ts": "export const separate = 1;\n",
      };
      compile = new Compile(root, [pkg("used", "export declare const value: number;\n")]);
      compile.write(sources);
      await compile.build();
      expect(compile.runs).to.equal(1);

      const bumped = new Compile(root, [pkg("used", "export declare const value: 2 | 4;\n")]);
      bumped.write(sources);
      const incremental = await bumped.build();
      expect(bumped.runs, "the read dependency moved, so the run happened").to.equal(1);
      expect(bumped.bound, "and it was bounded").to.not.equal(undefined);
      expect(bumped.bound!.roots, "at the depender alone").to.equal(1);

      const cold = new Compile(fs.mkdtempSync(path.join(os.tmpdir(), "fabr-dep-bump-ref-")), [
        pkg("used", "export declare const value: 2 | 4;\n"),
      ]);
      cold.write(sources);
      expect(incremental.toManifest()).to.equal((await cold.build()).toManifest());
    });
  });
}

incrementalScenarios();

describe("the incremental suite's own coverage", () => {
  it("actually bounded its programs, in the scenarios that can be bounded", () => {
    /* Every case above would still be green if the driver's planner quietly
     * started rooting at every project file, so this is the only thing that
     * says the mechanism is doing its job rather than merely not breaking.
     *
     * Two floors, because a bound can fail in two directions: that enough
     * scenarios bound their program at ALL (rather than the driver declining to,
     * which is how the mechanism switches itself off), and that enough bound it
     * STRICTLY — rooting at fewer files than the project has, which is the
     * narrowing the whole path exists for.
     *
     * A scenario that bounds nothing has a structural reason: a build that is
     * cold or forced or has no base, a change to a non-node input (which no
     * closure can bound), a global change (which declines a bound by rule), or a
     * demand that hits the cache and runs nothing at all. Those are also the
     * coverage of the root-at-everything program. One that bounds without
     * narrowing is a fixture small enough that the edit reaches every file.
     *
     * A drop below either floor means the mechanism stopped engaging, not that
     * a case got smaller. */
    const bounded = engagement.filter(bound => bound !== undefined);
    const narrowed = bounded.filter(bound => bound!.roots < bound!.project);
    expect(bounded.length, `only ${bounded.length} of ${engagement.length} scenarios bounded their program`).to.be.at.least(28);
    expect(
      narrowed.length,
      `only ${narrowed.length} of ${bounded.length} bounded scenarios rooted at less than the whole project`
    ).to.be.at.least(21);
  });
});

/**
 * **Bound-rooted programs**: an incremental run roots its program at the files
 * a change could reach, and holds the rest as ordinary sources the compiler
 * pulled in through resolution.
 *
 * Every case here is the same question asked once: *does the run produce what a
 * full compile of the same sources produces?* That is what makes the mechanism
 * an acceleration rather than a second semantics, and it is why each fixture
 * compares against a from-scratch build of the identical state rather than
 * against an expectation written by hand.
 *
 * Each states one way a bounded compile could disagree with a full one — through
 * a specifier, a const enum, a cycle, a global, a self-reference, a diagnostic
 * position.
 */
describe("incremental compiles against a bounded program", () => {
  let root: string;
  let compile: Compile;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-bound-test-"));
    compile = new Compile(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** What a cold compile of the CURRENT sources produces, in its own store —
   * the answer every bounded run is measured against. */
  async function fullCompileOf(
    sources: Record<string, string>,
    options: { target?: string; project?: string } = {}
  ): Promise<FileSet> {
    const cold = new Compile(fs.mkdtempSync(path.join(os.tmpdir(), "fabr-bound-ref-")));
    if (options.target !== undefined) {
      cold.emit(options.target);
    }
    if (options.project !== undefined) {
      cold.asPackage(options.project);
    }
    cold.write(sources);
    return cold.build();
  }

  /** Build the base, edit, rebuild against the bound, and answer both the
   * incremental result and what a full compile of the same state gives. */
  async function editAndCompare(
    base: Record<string, string>,
    edit: Record<string, string>,
    options: { target?: string; project?: string } = {}
  ): Promise<{ incremental: FileSet; full: FileSet }> {
    if (options.target !== undefined) {
      compile.emit(options.target);
    }
    if (options.project !== undefined) {
      compile.asPackage(options.project);
    }
    compile.write(base);
    await compile.build();
    compile.write(edit);
    const incremental = await compile.build();
    return { incremental, full: await fullCompileOf({ ...base, ...edit }, options) };
  }

  it("produces what a full compile produces, holding the neighbour it did not touch", async () => {
    const { incremental, full } = await editAndCompare(
      {
        "util.ts": "export function pad(text: string): string {\n  return text;\n}\n",
        "index.ts": 'import { pad } from "./util";\nexport const padded = pad("x");\n',
      },
      { "index.ts": 'import { pad } from "./util";\nexport const padded = pad("y");\n' }
    );
    expect(compile.runs).to.equal(2);
    expect(incremental.toManifest()).to.equal(full.toManifest());
  });

  it("keeps the emitted specifiers naming what this compile emits, not what it read", async () => {
    /* Threat 2: the emitted specifier must name `./util.js` — the file this
     * compile emits — however `util.ts` came to be in the program. It holds
     * because the rewriter resolves against the sources, which are all staged
     * whether or not they were rooted; the fixture is what keeps that true. */
    const { incremental, full } = await editAndCompare(
      {
        "util.ts": "export interface Thing {\n  n: number;\n}\nexport const make = (): Thing => ({ n: 1 });\n",
        "index.ts": 'import { make } from "./util";\nexport const thing = make();\n',
      },
      { "index.ts": 'import { make } from "./util";\nexport const thing = make();\nexport const again = make();\n' },
      { target: "es2021-esm-node" }
    );
    expect(await contentOf(incremental, "index.js"), "the emitted specifier names the emitted file").to.contain('from "./util.js"');
    expect(incremental.toManifest()).to.equal(full.toManifest());
  });

  it("inlines a const enum from the same place a full compile inlines it", async () => {
    /* Threat 1: a referencing file inlines a const enum's VALUES, so the owner
     * has to be in the program as the same kind of thing a full compile has it
     * as — every file the program holds is a source, so it inlines from the
     * source. */
    const base = {
      "levels.ts": "export const enum Level {\n  Low = 1,\n}\n",
      "use.ts": 'import { Level } from "./levels";\nexport const level = Level.Low;\nexport const shown = String(level);\n',
    };
    const { incremental, full } = await editAndCompare(base, {
      "use.ts": 'import { Level } from "./levels";\nexport const level = Level.Low;\nexport const shown = `${String(level)}!`;\n',
    });
    expect(await contentOf(incremental, "use.js"), "inlined, as a full compile inlines it").to.contain("1 /* Level.Low */");
    expect(incremental.toManifest()).to.equal(full.toManifest());
  });

  it("compiles a const enum's owner correctly under isolatedModules too", async () => {
    /* The sharp form of threat 1: `isolatedModules` rejects an ambient const
     * enum outright, so a compile that reached one would fail where a full
     * compile passes. fabr's generated projects do not set it — a project's own
     * can, and this is that project. */
    compile.strictModules();
    const base = {
      "levels.ts": "export const enum Level {\n  Low = 1,\n}\n",
      "use.ts": 'import { Level } from "./levels";\nexport const level = Level.Low;\n',
    };
    compile.write(base);
    await compile.build();
    const edited = 'import { Level } from "./levels";\nexport const level = Level.Low;\nexport const also = Level.Low;\n';
    compile.write({ "use.ts": edited });
    const built = await compile.build();
    expect(compile.runs).to.equal(2);
    /* The question is not what the emit looks like under isolatedModules, but
     * that the bounded run's answer is the full compile's. */
    const cold = new Compile(fs.mkdtempSync(path.join(os.tmpdir(), "fabr-standin-ref-")));
    cold.strictModules();
    cold.write({ ...base, "use.ts": edited });
    expect(built.toManifest()).to.equal((await cold.build()).toManifest());
  });

  it("keeps an incremental build's key from growing", async () => {
    /* Threat 3: what the entry is keyed on must not drift as builds accumulate.
     * A wave opens fewer files than a full compile, so the key is composed from
     * what the base read laid under what this run read — and this is what says
     * the composition neither grows (keying on files nothing opened) nor
     * shrinks (dropping dependencies the output rests on). */
    const deps = [pkg("used", "export declare const value: number;\n")];
    const build = new Compile(root, deps);
    const base = {
      "util.ts": 'import { value } from "used";\nexport const doubled = value * 2;\n',
      "index.ts": 'import { doubled } from "./util";\nexport const shown = String(doubled);\n',
    };
    build.write(base);
    await build.build();
    /* The record keeps the two categories apart, so this is the discoverable
     * half outright rather than the instance-named lines picked out of a union. */
    const discoverableLines = async (): Promise<string[]> => [...(await build.memo())!.inputs].map(([name]) => name);
    const before = await discoverableLines();

    build.write({ "index.ts": 'import { doubled } from "./util";\nexport const shown = `${String(doubled)}!`;\n' });
    await build.build();
    const after = await discoverableLines();
    expect(after, "the read set is what it was").to.deep.equal(before);
    /* And every line of the memo is an INPUT: nothing this compile produced —
     * its own outputs above all — may be recorded as something it read, or the
     * entry's key becomes a function of itself. */
    const recorded = await build.memo();
    expect(
      [...recorded!.inputs].map(([name]) => name).filter(name => name.startsWith("build/")),
      "and no output of this compile is a line, in either half"
    ).to.deep.equal([]);
  });

  it("still sees an unwaved file's global contributions", async () => {
    /* Threat 4: nothing imports a global, so no edge reaches the files a global
     * change affects. The bound declines to narrow at all when a file that
     * affected global scope changes, and this is what says the resulting compile
     * still fails where a full one fails. */
    const base = {
      "globals.d.ts": "declare const FABR_PROBE: number;\n",
      "index.ts": "export const value = FABR_PROBE * 2;\n",
      "other.ts": "export const other = 1;\n",
    };
    compile.write(base);
    await compile.build();
    compile.write({ "globals.d.ts": "declare const FABR_PROBE: string;\n" });
    await compile.build().then(
      () => expect.fail("index.ts uses the global as a number"),
      (err: Error) => expect(err.message).to.contain("exited with error code")
    );
  });

  it("handles a cycle with one member waved and the other only held", async () => {
    /* Threat 5: a cycle whose members are on opposite sides of the wave — one
     * checked and emitted, the other in the program but not built. */
    const base = {
      "a.ts": 'import type { B } from "./b";\nexport interface A {\n  b?: B;\n}\nexport const make = (): A => ({});\n',
      "b.ts": 'import type { A } from "./a";\nexport interface B {\n  a?: A;\n}\nexport const makeB = (): B => ({});\n',
      "index.ts": 'import { make } from "./a";\nimport { makeB } from "./b";\nexport const both = [make(), makeB()];\n',
    };
    const { incremental, full } = await editAndCompare(base, {
      "index.ts": 'import { make } from "./a";\nimport { makeB } from "./b";\nexport const both = [make(), makeB(), make()];\n',
    });
    expect(incremental.toManifest()).to.equal(full.toManifest());
  });

  it("resolves a self-reference through the package table like any other", async () => {
    /* Threat 8, the bare-specifier half: a package's reference to itself is
     * answered by the package table rather than by a path probe, and lands on
     * one of its own files — which the wave may not have rooted. */
    const { incremental, full } = await editAndCompare(
      {
        "util.ts": "export const pad = (text: string): string => text;\n",
        "index.ts": 'import { pad } from "mypkg/util";\nexport const padded = pad("x");\n',
      },
      { "index.ts": 'import { pad } from "mypkg/util";\nexport const padded = pad("y");\n' },
      { project: "mypkg" }
    );
    expect(incremental.toManifest()).to.equal(full.toManifest());
  });

  it("resolves an unrooted neighbour however the specifier was written", async () => {
    /* Threat 8, the relative half: extensionless, `.js`-spelled and directory
     * specifiers must bind exactly what source resolution binds. */
    const { incremental, full } = await editAndCompare(
      {
        "plain.ts": "export const plain = 1;\n",
        "dir/index.ts": "export const inDir = 2;\n",
        "index.ts": 'import { plain } from "./plain";\nimport { inDir } from "./dir";\nexport const sum = plain + inDir;\n',
      },
      {
        "index.ts": 'import { plain } from "./plain";\nimport { inDir } from "./dir";\nexport const sum = plain + inDir + 1;\n',
      }
    );
    expect(incremental.toManifest()).to.equal(full.toManifest());
  });

  it("holds the neighbours of a newly added file", async () => {
    /* Threat 9: an addition is in the wave by definition and what it imports
     * need not be, so the first thing it resolves is a file the bound did not
     * root — reached, like every other such file, by the compiler following the
     * import. */
    const { incremental, full } = await editAndCompare(
      {
        "util.ts": "export const pad = (text: string): string => text;\n",
        "index.ts": 'import { pad } from "./util";\nexport const padded = pad("x");\n',
      },
      { "extra.ts": 'import { pad } from "./util";\nexport const other = pad("z");\n' }
    );
    expect(incremental.toManifest()).to.equal(full.toManifest());
  });

  it("roots an ambient declaration nothing imports, however narrow the bound", async () => {
    /**
     * A project's ambient declarations — the `custom.d.ts` of `declare module
     * "untyped-package";` lines that every real project has — are imported by
     * nothing. So they are in a full compile's program only because the include
     * globs root them, and a bound computed as "what the change can reach" does
     * not reach them. Left out of the roots, nothing pulls them back in: the
     * declarations vanish, and every file in the wave that relied on one goes
     * red with a false diagnostic.
     *
     * The shape here: `ambient.d.ts` declares a module for the untyped `plain`
     * package, `consumer.ts` imports that package, and the edit is confined to
     * `hub.ts` so the bound is as narrow as it can be.
     */
    const base = {
      /* Imported by nothing, and needed by everything that names `plain`. */
      "ambient.d.ts": 'declare module "plain" {\n  export const thing: number;\n}\n',
      "hub.ts": "export function pad(text: string): string {\n  return text;\n}\n",
      /* In the bound whenever `hub` changes shape, and unable to compile at all
       * without the ambient declaration. */
      "consumer.ts": 'import { thing } from "plain";\nimport { pad } from "./hub";\nexport const held = pad(String(thing));\n',
    };
    compile.write(base);
    await compile.build();

    /* A SIGNATURE edit, so the wave reaches `consumer` and re-checks it — which
     * is what makes the missing ambient declaration observable. A body edit
     * would leave `consumer` unchecked and the fault invisible. */
    const edit = { "hub.ts": "export function pad(text: string, extra?: number): string {\n  return text + String(extra ?? 0);\n}\n" };
    compile.write(edit);
    const incremental = await compile.build();
    expect(compile.runs).to.equal(2);
    expect(incremental.toManifest(), "the bounded build is the full build").to.equal(
      (await fullCompileOf({ ...base, ...edit })).toManifest()
    );
  });

  it("reports diagnostics where a full compile reports them", async () => {
    /* Threat 7: a diagnostic's position is read off the file the program holds,
     * so a bounded compile must report the positions a full compile reports —
     * in a file it did not root as much as in one it did. */
    const base = {
      "util.ts": "export function pad(text: string): string {\n  return text;\n}\n",
      "index.ts": 'import { pad } from "./util";\n\n\nexport const padded = pad("x");\n',
    };
    compile.write(base);
    await compile.build();
    const broken = 'import { pad } from "./util";\n\n\nexport const padded: number = pad("x");\n';
    compile.write({ "index.ts": broken });
    const failure = await compile.build().then(
      () => "no failure",
      (err: Error) => err.message
    );
    const cold = new Compile(fs.mkdtempSync(path.join(os.tmpdir(), "fabr-standin-ref-")));
    cold.write({ ...base, "index.ts": broken });
    const reference = await cold.build().then(
      () => "no failure",
      (err: Error) => err.message
    );
    /* The rendered diagnostics, positions and all, from a run that parsed one
     * source and one that parsed both. */
    expect(diagnosticLines(failure)).to.deep.equal(diagnosticLines(reference));
    expect(diagnosticLines(failure), "and it said something").to.not.deep.equal([]);
    expect(diagnosticLines(failure).join("\n"), "at the position the source has, not the declaration's").to.match(
      /index\.tsx?[(:]4[,:]14/
    );
  });

  it("produces a full compile's answer through a chain of cycles of edits", async () => {
    /* The capstone: whatever the chain of edits did — a body edit, a signature
     * edit that moves the wave, and an addition — the result is what building
     * the final state from nothing gives. */
    const base = {
      "util.ts": "export function pad(text: string): string {\n  return text;\n}\n",
      "index.ts": 'import { pad } from "./util";\nexport const padded = pad("x");\n',
    };
    compile.write(base);
    await compile.build();
    compile.write({ "index.ts": 'import { pad } from "./util";\nexport const padded = pad("y");\n' });
    await compile.build();
    compile.write({ "util.ts": "export function pad(text: string): number {\n  return text.length;\n}\n" });
    await compile.build();
    compile.write({ "extra.ts": 'import { padded } from "./index";\nexport const shown = String(padded);\n' });
    const incremental = await compile.build();
    expect(compile.runs).to.equal(4);

    const full = await fullCompileOf({
      "util.ts": "export function pad(text: string): number {\n  return text.length;\n}\n",
      "index.ts": 'import { pad } from "./util";\nexport const padded = pad("y");\n',
      "extra.ts": 'import { padded } from "./index";\nexport const shown = String(padded);\n',
    });
    expect(incremental.toManifest()).to.equal(full.toManifest());
  });
});
