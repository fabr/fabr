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
import * as path from "node:path";
import { startFabrWatch, STUB_TSC, STUB_TSC_CONFIG, type WatchSession } from "./harness";

/** A BSP client over a session's stdio. */
function bspClient(session: WatchSession): {
  request(method: string, params: unknown): Promise<Record<string, unknown>>;
  notification(method: string): Promise<Record<string, unknown>>;
  drain(method: string): Promise<void>;
} {
  let buffer = Buffer.alloc(0);
  let id = 0;
  const pending = new Map<number, (result: Record<string, unknown>) => void>();
  const notified = new Map<string, Array<Record<string, unknown>>>();
  const waiting = new Map<string, (params: Record<string, unknown>) => void>();
  session.stdout.on("data", (data: Buffer) => {
    buffer = Buffer.concat([buffer, data]);
    for (;;) {
      const blank = buffer.indexOf("\r\n\r\n");
      const length = blank < 0 ? null : /content-length: *(\d+)/i.exec(buffer.subarray(0, blank).toString());
      if (length === null || buffer.length < blank + 4 + Number(length[1])) {
        return;
      }
      const message = JSON.parse(buffer.subarray(blank + 4, blank + 4 + Number(length[1])).toString());
      buffer = buffer.subarray(blank + 4 + Number(length[1]));
      if (message.id !== undefined) {
        pending.get(message.id)?.(message.result ?? { error: message.error });
      } else if (waiting.has(message.method)) {
        waiting.get(message.method)!(message.params);
        waiting.delete(message.method);
      } else {
        notified.set(message.method, [...(notified.get(message.method) ?? []), message.params]);
      }
    }
  });
  const write = (message: unknown): void => {
    const body = Buffer.from(JSON.stringify(message));
    session.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    session.stdin.write(body);
  };
  return {
    request: (method, params) =>
      new Promise(resolve => {
        id += 1;
        pending.set(id, resolve);
        write({ jsonrpc: "2.0", id, method, params });
      }),
    notification: method => {
      const already = notified.get(method)?.shift();
      return already !== undefined ? Promise.resolve(already) : new Promise(resolve => waiting.set(method, resolve));
    },
    /* Drop the notifications `method` received so far, once those still in flight have arrived. */
    drain: method => new Promise(resolve => setTimeout(() => {
      notified.delete(method);
      resolve();
    }, 500)),
  };
}

/* Targets described as their rules would build them, served by `fabr
 * build-server`: each package as it builds — its BSP target, its compilation
 * unit over the real directory its sources come from, with the compile's own
 * table, and the manifest its build would write, made without building it —
 * and a package with tests as its test run compiles them, too. */
describe("e2e: build-server", () => {
  const project = {
    ...STUB_TSC,
    "lib/src/index.ts": "export const libValue = 1;\n",
    "lib/styles/_colours.scss": "$accent: red;\n",
    "multi/src/index.ts": "export const multiValue = 1;\n",
    "multi/extra.d.ts": "declare const extra: number;\n",
    "multi/README.md": "# multi\n",
    "app/src/main.ts": 'import { libValue } from "lib";\nexport const total = libValue;\n',
    "app/src/main.test.ts": 'import { total } from "./main";\nexport const checked = total;\n',
    "PROJECT.fabr":
      "plugin @fabr-build/js;\n\n" +
      STUB_TSC_CONFIG +
      "\njs_package lib { srcs = ./lib/src:**/*.ts; exports = ./lib/src:index.ts; resources = ./lib/styles:*.scss; }\n" +
      "js_package app { srcs = ./app/src:**/*.ts; tests = ./app/src:**/*.test.ts; deps = lib; }\n" +
      "fabr_plugin greeter { srcs = lib; libs = ./plugin/GREET.fabr; }\n" +
      "js_package multi { srcs = ./multi/src:**/*.ts ./multi:extra.d.ts ./multi:README.md; exports = ./multi/src:index.ts; }\n" +
      "script gen_tool { entry = ./gen.sh; }\n" +
      "generate gen { run = gen_tool > index.ts; }\n" +
      "js_package made { srcs = gen:index.ts; exports = gen:index.ts; }\n" +
      "js_package user { srcs = ./user/src:**/*.ts; deps = made; }\n" +
      "js_package alias { srcs = ./alias/src:**/*.ts; deps = lib -> lib2; }\n",
    "plugin/GREET.fabr": "targetdef greeting {\n  text = STRING;\n}\n",
    "gen.sh": "echo 'export const madeValue = 1;'\n",
    "user/src/main.ts": 'import { madeValue } from "made";\nexport const used = madeValue;\n',
    "alias/src/main.ts": 'import { libValue } from "lib2";\nexport const aliased = libValue;\n',
  };
  interface ITarget {
    id: { uri: string };
    tags: string[];
    dependencies: Array<{ uri: string }>;
    dataKind: string;
    data: { units: Record<string, string>; manifest?: string; plugin: string };
    fabr: { description: string };
  }
  let session: WatchSession;
  let client: ReturnType<typeof bspClient>;
  let targets: Map<string, ITarget>;
  const read = (target: string, file: string): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(path.join(targets.get(target)!.fabr.description, file), "utf8"));

  beforeAll(async () => {
    session = startFabrWatch(project, ["-DJS_TARGET=es2020", "build-server"]);
    client = bspClient(session);
    await client.request("build/initialize", { displayName: "test", version: "0", bspVersion: "2.1.0", rootUri: "", capabilities: {} });
    /* Each target is served as it is described: wait for the eight. */
    for (;;) {
      const served = (await client.request("workspace/buildTargets", {})) as { targets: ITarget[] };
      targets = new Map(served.targets.map(target => [target.id.uri, target]));
      if (targets.size === 8) {
        break;
      }
      await client.notification("buildTarget/didChange");
    }
  });
  afterAll(() => session.stop());

  it("serves each package as it builds, and a package with tests as its tests compile", () => {
    expect([...targets.keys()].sort()).to.deep.equal([
      "fabr:alias",
      "fabr:app",
      "fabr:app?operation=test",
      "fabr:greeter",
      "fabr:lib",
      "fabr:made",
      "fabr:multi",
      "fabr:user",
    ]);
    const app = targets.get("fabr:app")!;
    expect(app.tags).to.deep.equal(["library"]);
    expect(app.dependencies).to.deep.equal([{ uri: "fabr:lib" }]);
    expect(app.dataKind).to.equal("typescript");
    expect(app.data).to.deep.equal({ units: { build: "units/build" }, manifest: "package.json", plugin: "@fabr-build/js-tools/tsserverPlugin/TsserverPlugin" });
    const tests = targets.get("fabr:app?operation=test")!;
    expect(tests.tags).to.deep.equal(["test"]);
    expect(tests.data.units).to.deep.equal({ test: "units/test" });
  });

  it("reports describing as a task: its progress over the targets it describes, and none failed", async () => {
    const finished = (await client.notification("build/taskFinish")) as { status: number; dataKind: string; data: { failed: string[] } };
    expect(finished).to.deep.include({ status: 1, dataKind: "fabr-describe", data: { failed: [] } });
    const progress = (await client.notification("build/taskProgress")) as { progress: number; total: number };
    expect(progress.total).to.be.at.least(targets.size);
  });

  it("lists a unit's sources: the build's without its tests, the tests' with them", async () => {
    const sources = async (uri: string): Promise<string[]> => {
      const { items } = (await client.request("buildTarget/sources", { targets: [{ uri }] })) as { items: Array<{ sources: Array<{ uri: string }> }> };
      return items[0].sources.map(source => source.uri.replace(/^.*\/app\/src\//, ""));
    };
    expect(await sources("fabr:app")).to.deep.equal(["main.ts"]);
    expect(await sources("fabr:app?operation=test")).to.deep.equal(["main.test.ts", "main.ts"]);
  });

  it("describes each unit over the directory its sources come from, with the compile's own table", () => {
    expect(read("fabr:app", "units/build/unit.json")).to.deep.equal({ root: "./app/src/", package: "app", generated: [], rewrites: [], resources: [] });
    const build = read("fabr:app", "units/build/tsconfig.json");
    expect(build.files).to.deep.equal(["main.ts"]);
    expect(build.exclude).to.deep.equal([]);
    expect(build.compilerOptions).to.deep.include({ rootDir: ".", outDir: ".", composite: true, moduleResolution: "bundler" });
    /* The node runner's globals are a source of the test compile, which no project file holds. */
    expect(read("fabr:app?operation=test", "units/test/tsconfig.json").files).to.deep.equal([
      "@types/fabr-test-globals/index.d.ts",
      "main.test.ts",
      "main.ts",
    ]);
    expect(read("fabr:app?operation=test", "units/test/unit.json").generated).to.deep.equal(["@types/fabr-test-globals/index.d.ts"]);
    const rows = new Map(read("fabr:app", "units/build/.pnp.data.json").packageRegistryData as Array<[string | null, Array<[string, { packageLocation: string }]>]>);
    expect([...rows.keys()]).to.include.members([null, "app", "lib"]);
    /* `lib` is described, not built: its row is at its own unit's root. */
    expect(rows.get("lib")![0][1].packageLocation).to.equal("./../../lib/src/");
  });

  it("builds no package to describe the packages that require it", () => {
    expect(session.stderr).to.not.match(/Compiling (app|lib)\b/);
  });

  it("describes a plugin as its own target over the package it is made from", async () => {
    const greeter = targets.get("fabr:greeter")!;
    expect(greeter.dependencies).to.deep.equal([{ uri: "fabr:lib" }]);
    const { items } = (await client.request("buildTarget/sources", { targets: [{ uri: "fabr:greeter" }] })) as { items: Array<{ sources: Array<{ uri: string }> }> };
    expect(items[0].sources.map(source => source.uri.replace(/^.*\//, ""))).to.deep.equal(["GREET.fabr"]);
    expect(read("fabr:greeter", "extends/units/build/unit.json")).to.deep.equal({ root: "./lib/src/", package: "lib", generated: [], rewrites: [], resources: [] });
  });

  it("describes a unit whose sources come from two directories at the directory holding both, as one tree", () => {
    expect(read("fabr:multi", "units/build/unit.json")).to.deep.equal({
      root: "./multi/",
      package: "multi",
      generated: [],
      rewrites: [],
      resources: ["README.md"],
    });
    const config = read("fabr:multi", "units/build/tsconfig.json");
    /* The README is a file of the package the compile does not compile. */
    expect(config.files).to.deep.equal(["extra.d.ts", "src/index.ts"]);
    /* The root by its entries alone: a wildcard there would also name the unit's node_modules. */
    expect(config.compilerOptions).to.deep.include({
      paths: { multi: ["./index", "./src/index"], "multi/*": ["./src/*"], "multi/extra": ["./extra", "./src/extra"] },
    });
  });

  it("installs a package whose sources are all generated in the pool, read from its sources", () => {
    const table = read("fabr:user", "units/build/.pnp.data.json") as { packageRegistryData: Array<[string | null, Array<[string, { packageLocation: string }]>]> };
    const location = table.packageRegistryData.find(([name]) => name === "made")![1][0][1].packageLocation;
    expect(location).to.match(/^\.\/\.fabr-tree\/[0-9a-f]+\/$/);
    const tree = path.join(path.dirname(targets.get("fabr:user")!.fabr.description), path.basename(location));
    expect(fs.readdirSync(tree).sort()).to.deep.equal(["index.ts", "package.json"]);
    expect(fs.readFileSync(path.join(tree, "index.ts"), "utf8")).to.equal("export const madeValue = 1;\n");
    expect(JSON.parse(fs.readFileSync(path.join(tree, "package.json"), "utf8"))).to.deep.include({ types: "index.ts" });
  });

  it("locates a package taken under another name at its own unit", () => {
    const table = read("fabr:alias", "units/build/.pnp.data.json") as { packageRegistryData: Array<[string | null, Array<[string, { packageLocation: string }]>]> };
    expect(table.packageRegistryData.find(([name]) => name === "lib2")![1][0][1].packageLocation).to.equal("./../../lib/src/");
  });

  it("holds the files a package ships as they are in its description, where a step reading the package finds them", () => {
    expect(fs.readFileSync(path.join(targets.get("fabr:lib")!.fabr.description, "_colours.scss"), "utf8")).to.equal("$accent: red;\n");
  });

  it("describes a package's manifest from its declared entry points", () => {
    const manifest = read("fabr:lib", "package.json");
    expect(manifest.name).to.equal("lib");
    expect(manifest.exports).to.deep.equal({ ".": { types: "./index.d.ts", default: "./index.js" }, "./package.json": "./package.json" });
  });

  it("announces the targets a change describes anew", async () => {
    /* What the first descriptions announced is no answer to the change. */
    await client.drain("buildTarget/didChange");
    session.write("lib/src/extra.ts", "export const extra = 1;\n");
    const changes: Array<{ target: { uri: string }; kind: number }> = [];
    while (new Set(changes.map(change => change.target.uri)).size < 5) {
      changes.push(...((await client.notification("buildTarget/didChange")) as { changes: typeof changes }).changes);
    }
    /* `lib`'s sources changed, and so did its package, which `app`'s and `alias`'s
     * units' tables name and `greeter` is made from. */
    expect([...new Set(changes.map(change => change.target.uri))].sort()).to.deep.equal([
      "fabr:alias",
      "fabr:app",
      "fabr:app?operation=test",
      "fabr:greeter",
      "fabr:lib",
    ]);
    expect(changes.every(change => change.kind === 2)).to.equal(true);
  });
});

/* A target whose description fails leaves the rest described: what requires
 * it is described without it, and fixing it describes both anew. */
describe("e2e: build-server with a target that fails to describe", () => {
  const project = {
    ...STUB_TSC,
    "gen.sh": "echo 'generator broke' >&2\nexit 3\n",
    "user/src/main.ts": 'import { made } from "made";\nexport const used = made;\n',
    "PROJECT.fabr":
      "plugin @fabr-build/js;\n\n" +
      STUB_TSC_CONFIG +
      "\nscript gen_tool { entry = ./gen.sh; }\n" +
      "generate gen { run = gen_tool > index.ts; }\n" +
      "js_package made { srcs = gen:index.ts; exports = gen:index.ts; }\n" +
      "js_package user { srcs = ./user/src:**/*.ts; deps = made; }\n",
  };
  let session: WatchSession;
  let client: ReturnType<typeof bspClient>;
  const served = async (): Promise<string[]> =>
    ((await client.request("workspace/buildTargets", {})) as { targets: Array<{ id: { uri: string } }> }).targets.map(target => target.id.uri).sort();

  beforeAll(async () => {
    session = startFabrWatch(project, ["-DJS_TARGET=es2020", "build-server"]);
    client = bspClient(session);
    await client.request("build/initialize", { displayName: "test", version: "0", bspVersion: "2.1.0", rootUri: "", capabilities: {} });
  });
  afterAll(() => session.stop());

  it("describes what requires the failed target without it, and names the failure", async () => {
    expect(await client.notification("build/taskFinish")).to.deep.include({ status: 2, data: { failed: ["fabr:made"] } });
    expect(await served()).to.deep.equal(["fabr:user"]);
    /* Published against the declaration that failed, `gen`'s. */
    const published = (await client.notification("build/publishDiagnostics")) as {
      textDocument: { uri: string };
      buildTarget: { uri: string };
      diagnostics: Array<{ range: { start: { line: number } }; message: string }>;
    };
    expect(published.textDocument.uri).to.match(/\/PROJECT\.fabr$/);
    expect(published.buildTarget.uri).to.equal("fabr:made");
    expect(published.diagnostics.map(diagnostic => diagnostic.range.start.line)).to.deep.equal([STUB_TSC_CONFIG.split("\n").length + 3]);
    expect(published.diagnostics[0].message).to.match(/^Failed to build gen/);
  });

  it("describes both once the failed target is fixed", async () => {
    session.write("gen.sh", "echo 'export const made = 1;'\n");
    expect(await client.notification("build/taskFinish")).to.deep.include({ status: 1, data: { failed: [] } });
    expect(await client.notification("build/publishDiagnostics")).to.deep.include({ buildTarget: { uri: "fabr:made" }, diagnostics: [] });
    await client.drain("buildTarget/didChange");
    expect(await served()).to.deep.equal(["fabr:made", "fabr:user"]);
  });
});

/* The server sends nothing before it has answered the client's
 * `build/initialize`, however far it has got by then. */
describe("e2e: build-server before a client is initialized", () => {
  let session: WatchSession;
  afterAll(() => session.stop());

  it("holds what it describes until it has answered the client's build/initialize", async () => {
    session = startFabrWatch(
      { ...STUB_TSC, "lib/src/index.ts": "export const libValue = 1;\n", "PROJECT.fabr": "plugin @fabr-build/js;\n\n" + STUB_TSC_CONFIG + "\njs_package lib { srcs = ./lib/src:**/*.ts; }\n" },
      ["-DJS_TARGET=es2020", "build-server"]
    );
    await session.waitFor("Watching for changes");
    let received = "";
    session.stdout.on("data", (data: Buffer) => (received += data.toString("utf8")));
    const client = bspClient(session);
    await client.request("build/initialize", { displayName: "test", version: "0", bspVersion: "2.1.0", rootUri: "", capabilities: {} });
    await client.notification("build/taskFinish");
    const messages = received
      .split(/Content-Length: *\d+\r\n\r\n/)
      .filter(body => body !== "")
      .map(body => JSON.parse(body) as { id?: number; method?: string });
    expect(messages[0].id).to.equal(1);
    expect(messages.slice(1).map(message => message.method)).to.include.members(["build/taskStart", "build/taskFinish"]);
  });
});
