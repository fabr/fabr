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

/* The coverage driver converts real V8 coverage: a TypeScript fixture compiled
 * with maps naming sources `fabr:./…` and, unlike js_compile's, no sources
 * embedded (so the driver is shown to read none), run in a node process that
 * loads the module the driver prepared and records its coverage, then
 * converted by the driver's bin, launched as fabr launches it. */

import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as ts from "typescript";
import { virtualLocation } from "../pnp/VirtualPath";
import { physicalPaths } from "./Collect";
import { COVERAGE_DIR_VARIABLE, type ICoverageOptions } from "./Options";

const MATH = `// A comment line
export interface Shape {
  area(): number;
}

export type Pair = [number, number];

/** Adds things. */
export function add(a: number, b: number): number {
  return a + b;
}

export function unused(x: number): number {
  const y = x * 2;
  return y + 1;
}

export function classify(n: number): string {
  if (n > 0) {
    return "positive";
  } else {
    return "non-positive";
  }
}

export const config = {
  name: "demo",
  size: 3,
};

export class Square implements Shape {
  constructor(private side: number) {}

  area(): number {
    return this.side * this.side;
  }

  static unit(): Square {
    return new Square(1);
  }
}

export function withDefault(label: string = "none"): string {
  return label;
}
`;

const NEVER_LOADED = `export function neverLoaded(a: number): number {
  if (a) {
    return 1;
  }
  return 2;
}
`;

const TEST = `const m = require("./out/math.js");
m.add(1, 2);
m.classify(5);
new m.Square(2).area();
m.withDefault("given");
`;

interface ILcovRecord {
  functions: Map<string, number>;
  lines: Map<number, number>;
  branches: Array<[number, number]>;
}

function parseLcov(text: string): Map<string, ILcovRecord> {
  const records = new Map<string, ILcovRecord>();
  let current: ILcovRecord | undefined;
  for (const line of text.split("\n")) {
    const [tag, rest = ""] = line.split(/:(.*)/s);
    if (tag === "SF") {
      current = { functions: new Map(), lines: new Map(), branches: [] };
      records.set(rest, current);
    } else if (tag === "FNDA" && current) {
      const [count, name] = rest.split(",");
      current.functions.set(name, Number(count));
    } else if (tag === "DA" && current) {
      const [line, count] = rest.split(",").map(Number);
      current.lines.set(line, count);
    } else if (tag === "BRDA" && current) {
      const [line, , , count] = rest.split(",").map(Number);
      current.branches.push([line, count]);
    }
  }
  return records;
}

describe("the coverage driver, over real V8 coverage", () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fabr-coverage-")));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Compile `source` as `out/<name>.js` beside a map naming it `fabr:./lib/<name>.ts`. */
  function compile(name: string, source: string): void {
    const { outputText, sourceMapText } = ts.transpileModule(source, {
      fileName: `${name}.ts`,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, sourceMap: true },
    });
    const map = JSON.parse(sourceMapText!) as { sources: string[]; sourcesContent?: unknown };
    map.sources = [`fabr:./lib/${name}.ts`];
    delete map.sourcesContent;
    fs.mkdirSync(path.join(root, "out"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "out", `${name}.js`),
      outputText.replace(/sourceMappingURL=.*$/m, `sourceMappingURL=${name}.js.map`)
    );
    fs.writeFileSync(path.join(root, "out", `${name}.js.map`), JSON.stringify(map));
  }

  /* The driver's compiled bin, launched as fabr launches it (an in-process
   * `import()` of its ES-module library cannot run inside jest's module
   * sandbox): beside this test where it runs compiled, or in the package's
   * build where it runs from its TypeScript source. */
  const driver = [path.join(__dirname, "../bin/fabr-coverage.js"), path.join(__dirname, "../../build/bin/fabr-coverage.js")].find(
    file => fs.existsSync(file)
  )!;

  /** Run the driver with `options` as its options document. */
  function drive(options: ICoverageOptions): void {
    fs.writeFileSync(path.join(root, "coverage.json"), JSON.stringify(options));
    const run = spawnSync(process.execPath, [driver, "--manifest=coverage.json"], { cwd: root });
    assert.equal(run.status, 0, String(run.stderr));
  }

  /**
   * Prepare a run measuring `measured`, run the fixture's test in a process
   * loading the prepared module, and convert what it recorded.
   */
  function measure(measured = ["out/math.js", "out/unused.js"], test = TEST): Map<string, ILcovRecord> {
    compile("math", MATH);
    compile("unused", NEVER_LOADED);
    fs.writeFileSync(path.join(root, "test.js"), test);
    drive({ kind: "prepare", measured, preload: "preload.cjs", table: "table.json" });
    const run = spawnSync(process.execPath, ["test.js"], {
      cwd: root,
      env: {
        NODE_OPTIONS: `--require ${JSON.stringify(path.join(root, "preload.cjs"))}`,
        [COVERAGE_DIR_VARIABLE]: path.join(root, "raw", "0"),
      },
    });
    assert.equal(run.status, 0, String(run.stderr));
    const names = [
      ...new Set(Object.values(JSON.parse(fs.readFileSync(path.join(root, "table.json"), "utf8")) as Record<string, string>)),
    ];
    drive({ kind: "convert", raw: ["raw", "kept"], measured: names, output: "lcov.info" });
    return parseLcov(fs.readFileSync(path.join(root, "lcov.info"), "utf8"));
  }

  it("names each source by its source path, read from the maps alone", () => {
    const records = measure();
    assert.deepEqual([...records.keys()], ["./lib/math.ts", "./lib/unused.ts"]);
  });

  it("measures a file named through a virtual location as the one file beneath it, under its least name", () => {
    const virtual = path.relative(root, path.join(virtualLocation(path.join(root, "out"), "0123abcd"), "math.js"));
    const records = measure([virtual, "out/math.js", "out/unused.js"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "table.json"), "utf8")), {
      [path.join(root, "out", "math.js")]: [virtual, "out/math.js"].sort()[0],
      [path.join(root, "out", "unused.js")]: "out/unused.js",
    });
    assert.equal(records.get("./lib/math.ts")!.functions.get("add"), 1);
  });

  it("names a file loaded through a virtual location by the file beneath it", () => {
    fs.mkdirSync(path.join(root, "out"), { recursive: true });
    const virtual = path.join(virtualLocation(path.join(root, "out"), "0123abcd"), "math.js");
    assert.equal(physicalPaths()(virtual), path.join(root, "out", "math.js"));
  });

  it("records only the measured files, each under its name", () => {
    measure(["out/math.js"]);
    const recorded = fs.readdirSync(path.join(root, "raw", "0"));
    assert.equal(recorded.length, 1);
    const { result } = JSON.parse(fs.readFileSync(path.join(root, "raw", "0", recorded[0]), "utf8")) as {
      result: Array<{ url: string }>;
    };
    assert.deepEqual(
      result.map(script => script.url),
      ["out/math.js"]
    );
  });

  it("measures a process the test starts with a NODE_OPTIONS of its own", () => {
    const starter = `${TEST}require("child_process").execFileSync(process.execPath, ["-e", "require('./out/unused.js').neverLoaded(1)"], {
  cwd: __dirname,
  env: { ...process.env, NODE_OPTIONS: "--no-warnings" },
});
`;
    const unused = measure(undefined, starter).get("./lib/unused.ts")!;
    assert.equal(unused.functions.get("neverLoaded"), 1);
    assert.equal(fs.readdirSync(path.join(root, "raw", "0")).length, 2);
  });

  it("counts statements, not lines of text", () => {
    const math = measure().get("./lib/math.ts")!;
    /* Comments, type declarations, blank lines and closing braces are no
     * statements; the object literal is one. */
    for (const line of [1, 2, 3, 4, 6, 8, 11, 16, 21, 23, 24, 27, 28, 29]) {
      assert.equal(math.lines.has(line), false, `line ${line} is no statement`);
    }
    assert.equal(math.lines.get(10), 1);
    assert.equal(math.lines.get(14), 0);
    assert.equal(math.lines.get(15), 0);
    assert.equal(math.lines.get(20), 1);
    assert.equal(math.lines.get(22), 0);
    assert.equal(math.lines.get(26), 1);
  });

  it("counts every function, a static method included", () => {
    const math = measure().get("./lib/math.ts")!;
    assert.equal(math.functions.get("add"), 1);
    assert.equal(math.functions.get("unused"), 0);
    assert.equal(math.functions.get("area"), 1);
    assert.equal(math.functions.get("unit"), 0);
  });

  it("counts both arms of a branch, and leaves out a parameter's default", () => {
    const math = measure().get("./lib/math.ts")!;
    assert.deepEqual(
      math.branches.filter(([line]) => line === 19),
      [
        [19, 1],
        [19, 0],
      ]
    );
    assert.equal(
      math.branches.some(([line]) => line === 39),
      false
    );
  });

  it("reports a file no process loaded as not run at all", () => {
    const unused = measure().get("./lib/unused.ts")!;
    assert.equal(unused.functions.get("neverLoaded"), 0);
    assert.deepEqual([...unused.lines.values()], [0, 0, 0, 0]);
    assert.deepEqual(
      unused.branches.map(([, count]) => count),
      [0, 0]
    );
  });
});
