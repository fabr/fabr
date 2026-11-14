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
import { fileURLToPath, pathToFileURL } from "node:url";
import { startFabrWatch, STUB_TSC, STUB_TSC_CONFIG, type WatchSession } from "./harness";

/** A BSP client over a session's stdio. */
function bspClient(
  session: WatchSession,
  protocol?: "lsp"
): {
  request(method: string, params: unknown): Promise<Record<string, unknown>>;
  notify(method: string, params: unknown): void;
  notification(method: string): Promise<Record<string, unknown>>;
  drain(method: string): Promise<void>;
  queued(method: string): Array<Record<string, unknown>>;
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
      const tag = /^Fabr-Protocol: *(\S+)$/im.exec(buffer.subarray(0, blank).toString())?.[1];
      buffer = buffer.subarray(blank + 4 + Number(length[1]));
      /* A client answers to its own protocol's frames alone. */
      if (tag !== protocol) {
        continue;
      }
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
    session.stdin.write(`Content-Length: ${body.length}\r\n${protocol === undefined ? "" : `Fabr-Protocol: ${protocol}\r\n`}\r\n`);
    session.stdin.write(body);
  };
  return {
    request: (method, params) =>
      new Promise(resolve => {
        id += 1;
        pending.set(id, resolve);
        write({ jsonrpc: "2.0", id, method, params });
      }),
    notify: (method, params) => write({ jsonrpc: "2.0", method, params }),
    notification: method => {
      const already = notified.get(method)?.shift();
      return already !== undefined ? Promise.resolve(already) : new Promise(resolve => waiting.set(method, resolve));
    },
    /* Take the notifications `method` received and not yet taken. */
    queued: method => {
      const taken = notified.get(method) ?? [];
      notified.delete(method);
      return taken;
    },
    /* Drop the notifications `method` received so far, once those still in flight have arrived. */
    drain: method =>
      new Promise(resolve =>
        setTimeout(() => {
          notified.delete(method);
          resolve();
        }, 500)
      ),
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
      "fabr_plugin greeter { srcs = ./plugin/src:**/*.ts; exports = ./plugin/src:index.ts; libs = ./plugin/GREET.fabr; }\n" +
      "js_package multi { srcs = ./multi/src:**/*.ts ./multi:extra.d.ts ./multi:README.md; exports = ./multi/src:index.ts; }\n" +
      "js_script gen_tool { entry = ./gen.js; }\n" +
      "generate gen { run = gen_tool > index.ts; }\n" +
      "js_package made { srcs = gen:index.ts; exports = gen:index.ts; }\n" +
      "js_package user { srcs = ./user/src:**/*.ts; deps = made; }\n" +
      "js_package alias { srcs = ./alias/src:**/*.ts; deps = lib -> lib2; }\n",
    "plugin/GREET.fabr": "targetdef greeting {\n  text = STRING;\n}\n",
    "plugin/src/index.ts": "export const greeterValue = 1;\n",
    "gen.js": 'console.log("export const madeValue = 1;");\n',
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
    await client.request("build/initialize", {
      displayName: "test",
      version: "0",
      bspVersion: "2.1.0",
      rootUri: "",
      capabilities: {},
    });
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
    expect(app.data).to.deep.equal({
      units: { build: "units/build" },
      manifest: "package.json",
      plugin: "@fabr-build/js-tools/tsserverPlugin/TsserverPlugin",
    });
    const tests = targets.get("fabr:app?operation=test")!;
    expect(tests.tags).to.deep.equal(["test"]);
    expect(tests.data.units).to.deep.equal({ test: "units/test" });
  });

  it("reports describing as a task: its progress over the targets it describes, and none failed", async () => {
    const finished = (await client.notification("build/taskFinish")) as {
      status: number;
      dataKind: string;
      data: { failed: string[] };
    };
    expect(finished).to.deep.include({ status: 1, dataKind: "fabr-describe", data: { failed: [] } });
    const progress = (await client.notification("build/taskProgress")) as { progress: number; total: number };
    expect(progress.total).to.be.at.least(targets.size);
  });

  it("lists a unit's sources: the build's without its tests, the tests' with them", async () => {
    const sources = async (uri: string): Promise<string[]> => {
      const { items } = (await client.request("buildTarget/sources", { targets: [{ uri }] })) as {
        items: Array<{ sources: Array<{ uri: string }> }>;
      };
      return items[0].sources.map(source => source.uri.replace(/^.*\/app\/src\//, ""));
    };
    expect(await sources("fabr:app")).to.deep.equal(["main.ts"]);
    expect(await sources("fabr:app?operation=test")).to.deep.equal(["main.test.ts", "main.ts"]);
  });

  it("describes each unit over the directory its sources come from, with the compile's own table", () => {
    expect(read("fabr:app", "units/build/unit.json")).to.deep.equal({
      root: "./app/src/",
      package: "app",
      generated: [],
      rewrites: [],
      resources: [],
    });
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
    const rows = new Map(
      read("fabr:app", "units/build/.pnp.data.json").packageRegistryData as Array<
        [string | null, Array<[string, { packageLocation: string }]>]
      >
    );
    expect([...rows.keys()]).to.include.members([null, "app", "lib"]);
    /* `lib` is described, not built: its row is at its own unit's root. */
    expect(rows.get("lib")![0][1].packageLocation).to.equal("./../../lib/src/");
  });

  it("builds no package to describe the packages that require it", () => {
    expect(session.stderr).to.not.match(/Compiling (app|lib)\b/);
  });

  it("describes a plugin as its own target over the package it is built as", async () => {
    const greeter = targets.get("fabr:greeter")!;
    expect(greeter.dependencies).to.deep.equal([]);
    const { items } = (await client.request("buildTarget/sources", { targets: [{ uri: "fabr:greeter" }] })) as {
      items: Array<{ sources: Array<{ uri: string }> }>;
    };
    expect(items[0].sources.map(source => source.uri.replace(/^.*\//, ""))).to.deep.equal(["GREET.fabr"]);
    expect(read("fabr:greeter", "extends/units/build/unit.json")).to.deep.equal({
      root: "./plugin/src/",
      package: "greeter",
      generated: [],
      rewrites: [],
      resources: [],
    });
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
    const table = read("fabr:user", "units/build/.pnp.data.json") as {
      packageRegistryData: Array<[string | null, Array<[string, { packageLocation: string }]>]>;
    };
    const location = table.packageRegistryData.find(([name]) => name === "made")![1][0][1].packageLocation;
    expect(location).to.match(/^\.\/\.fabr-tree\/[0-9a-f]+\/$/);
    const tree = path.join(path.dirname(targets.get("fabr:user")!.fabr.description), path.basename(location));
    expect(fs.readdirSync(tree).sort()).to.deep.equal(["index.ts", "package.json"]);
    expect(fs.readFileSync(path.join(tree, "index.ts"), "utf8")).to.equal("export const madeValue = 1;\n");
    expect(JSON.parse(fs.readFileSync(path.join(tree, "package.json"), "utf8"))).to.deep.include({ types: "index.ts" });
  });

  it("locates a package taken under another name at its own unit", () => {
    const table = read("fabr:alias", "units/build/.pnp.data.json") as {
      packageRegistryData: Array<[string | null, Array<[string, { packageLocation: string }]>]>;
    };
    expect(table.packageRegistryData.find(([name]) => name === "lib2")![1][0][1].packageLocation).to.equal("./../../lib/src/");
  });

  it("holds the files a package ships as they are in its description, where a step reading the package finds them", () => {
    expect(fs.readFileSync(path.join(targets.get("fabr:lib")!.fabr.description, "_colours.scss"), "utf8")).to.equal("$accent: red;\n");
  });

  it("describes a package's manifest from its declared entry points", () => {
    const manifest = read("fabr:lib", "package.json");
    expect(manifest.name).to.equal("lib");
    expect(manifest.exports).to.deep.equal({
      ".": { types: "./index.d.ts", default: "./index.js" },
      "./package.json": "./package.json",
    });
  });

  it("announces the targets a change describes anew", async () => {
    /* What the first descriptions announced is no answer to the change. */
    await client.drain("buildTarget/didChange");
    session.write("lib/src/extra.ts", "export const extra = 1;\n");
    const changes: Array<{ target: { uri: string }; kind: number }> = [];
    while (new Set(changes.map(change => change.target.uri)).size < 4) {
      changes.push(...((await client.notification("buildTarget/didChange")) as { changes: typeof changes }).changes);
    }
    /* `lib`'s sources changed, and so did its package, which `app`'s and `alias`'s
     * units' tables name. */
    expect([...new Set(changes.map(change => change.target.uri))].sort()).to.deep.equal([
      "fabr:alias",
      "fabr:app",
      "fabr:app?operation=test",
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
    "gen.js": 'console.error("generator broke");\nprocess.exit(3);\n',
    "user/src/main.ts": 'import { made } from "made";\nexport const used = made;\n',
    "PROJECT.fabr":
      "plugin @fabr-build/js;\n\n" +
      STUB_TSC_CONFIG +
      "\njs_script gen_tool { entry = ./gen.js; }\n" +
      "generate gen { run = gen_tool > index.ts; }\n" +
      "js_package made { srcs = gen:index.ts; exports = gen:index.ts; }\n" +
      "js_package user { srcs = ./user/src:**/*.ts; deps = made; }\n",
  };
  let session: WatchSession;
  let client: ReturnType<typeof bspClient>;
  const served = async (): Promise<string[]> =>
    ((await client.request("workspace/buildTargets", {})) as { targets: Array<{ id: { uri: string } }> }).targets
      .map(target => target.id.uri)
      .sort();

  beforeAll(async () => {
    session = startFabrWatch(project, ["-DJS_TARGET=es2020", "build-server"]);
    client = bspClient(session);
    await client.request("build/initialize", {
      displayName: "test",
      version: "0",
      bspVersion: "2.1.0",
      rootUri: "",
      capabilities: {},
    });
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
    expect(published.diagnostics.map(diagnostic => diagnostic.range.start.line)).to.deep.equal([
      STUB_TSC_CONFIG.split("\n").length + 3,
    ]);
    expect(published.diagnostics[0].message).to.match(/^Failed to build gen/);
  });

  it("describes both once the failed target is fixed", async () => {
    session.write("gen.js", 'console.log("export const made = 1;");\n');
    expect(await client.notification("build/taskFinish")).to.deep.include({ status: 1, data: { failed: [] } });
    expect(await client.notification("build/publishDiagnostics")).to.deep.include({
      buildTarget: { uri: "fabr:made" },
      diagnostics: [],
    });
    await client.drain("buildTarget/didChange");
    expect(await served()).to.deep.equal(["fabr:made", "fabr:user"]);
  });
});

/* A pass finishes once each of its targets is served: one that fails last is
 * counted, and named as failed, by the pass's own finish. */
describe("e2e: build-server with a target that fails after the rest", () => {
  const project = {
    ...STUB_TSC,
    "gen.js": 'setTimeout(() => {\n  console.error("generator broke");\n  process.exit(3);\n}, 1000);\n',
    "other/src/main.ts": "export const other = 1;\n",
    "PROJECT.fabr":
      "plugin @fabr-build/js;\n\n" +
      STUB_TSC_CONFIG +
      "\njs_script gen_tool { entry = ./gen.js; }\n" +
      "generate gen { run = gen_tool > index.ts; }\n" +
      "js_package made { srcs = gen:index.ts; exports = gen:index.ts; }\n" +
      "js_package other { srcs = ./other/src:**/*.ts; }\n",
  };
  let session: WatchSession;
  let client: ReturnType<typeof bspClient>;

  beforeAll(async () => {
    session = startFabrWatch(project, ["-DJS_TARGET=es2020", "build-server"]);
    client = bspClient(session);
    await client.request("build/initialize", {
      displayName: "test",
      version: "0",
      bspVersion: "2.1.0",
      rootUri: "",
      capabilities: {},
    });
  });
  afterAll(() => session.stop());

  it("names the failure in the pass's finish, its progress complete before it", async () => {
    const finished = (await client.notification("build/taskFinish")) as { status: number; data: { failed: string[] } };
    expect(finished).to.deep.include({ status: 2, data: { failed: ["fabr:made"] } });
    /* Every progress was sent before the finish, so all of them have arrived. */
    const progress = client.queued("build/taskProgress") as Array<{ progress: number; total: number }>;
    const last = progress[progress.length - 1];
    expect(last.progress).to.equal(last.total);
  });
});

/* A project whose build files fail to load from the start is answered from no
 * model, rather than left waiting for one. */
describe("e2e: build-server over a project that never loads", () => {
  const project = { "PROJECT.fabr": "broken {\n" };
  let session: WatchSession;
  let bsp: ReturnType<typeof bspClient>;
  let lsp: ReturnType<typeof bspClient>;

  beforeAll(async () => {
    session = startFabrWatch(project, ["build-server"]);
    bsp = bspClient(session);
    lsp = bspClient(session, "lsp");
    await bsp.request("build/initialize", { displayName: "test", version: "0", bspVersion: "2.1.0", rootUri: "", capabilities: {} });
    await lsp.request("initialize", { processId: null, rootUri: null, capabilities: {} });
  });
  afterAll(() => session.stop());

  it("answers the targets and a build file's names with none", async () => {
    expect(await bsp.request("workspace/buildTargets", {})).to.deep.equal({ targets: [] });
    const uri = pathToFileURL(path.join(fs.realpathSync(session.dir), "PROJECT.fabr")).toString();
    expect(await lsp.request("textDocument/definition", { textDocument: { uri }, position: { line: 0, character: 1 } })).to.deep.equal(
      []
    );
  });
});

/* A reload serves the reloaded model's descriptions alone: the model it
 * replaced no longer answers a change to what it read. */
describe("e2e: build-server across a reload", () => {
  const config = (dir: string): string =>
    "plugin @fabr-build/js;\n\n" + STUB_TSC_CONFIG + `\njs_package lib { srcs = ./${dir}/src:**/*.ts; }\n`;
  const project = {
    ...STUB_TSC,
    "lib/src/index.ts": "export const a = 1;\n",
    "lib2/src/index.ts": "export const b = 1;\n",
    "PROJECT.fabr": config("lib"),
  };
  let session: WatchSession;
  let client: ReturnType<typeof bspClient>;
  const sources = async (): Promise<string[]> => {
    const answer = (await client.request("buildTarget/sources", { targets: [{ uri: "fabr:lib" }] })) as {
      items: Array<{ sources: Array<{ uri: string }> }>;
    };
    return (answer.items[0]?.sources ?? [])
      .map(source =>
        path
          .relative(fs.realpathSync.native(session.dir), fs.realpathSync.native(fileURLToPath(source.uri)))
          .split(path.sep)
          .join("/")
      )
      .sort();
  };
  const until = async (holds: (found: string[]) => boolean): Promise<string[]> => {
    for (;;) {
      const found = await sources();
      if (holds(found)) {
        return found;
      }
      await client.notification("buildTarget/didChange");
    }
  };

  beforeAll(async () => {
    session = startFabrWatch(project, ["-DJS_TARGET=es2020", "build-server"]);
    client = bspClient(session);
    await client.request("build/initialize", {
      displayName: "test",
      version: "0",
      bspVersion: "2.1.0",
      rootUri: "",
      capabilities: {},
    });
  });
  afterAll(() => session.stop());

  it("leaves a change to the sources of a model it replaced unserved", async () => {
    await until(found => found.includes("lib/src/index.ts"));
    session.write("PROJECT.fabr", config("lib2"));
    await until(found => found.includes("lib2/src/index.ts"));
    session.write("lib/src/stale.ts", "export const stale = 1;\n");
    session.write("lib2/src/fresh.ts", "export const fresh = 1;\n");
    await until(found => found.includes("lib2/src/fresh.ts"));
    await client.drain("buildTarget/didChange");
    expect(await sources()).to.deep.equal(["lib2/src/fresh.ts", "lib2/src/index.ts"]);
  });
});

/* The server sends nothing before it has answered the client's
 * `build/initialize`, however far it has got by then. */
describe("e2e: build-server before a client is initialized", () => {
  let session: WatchSession;
  afterAll(() => session.stop());

  it("holds what it describes until it has answered the client's build/initialize", async () => {
    session = startFabrWatch(
      {
        ...STUB_TSC,
        "lib/src/index.ts": "export const libValue = 1;\n",
        "PROJECT.fabr": "plugin @fabr-build/js;\n\n" + STUB_TSC_CONFIG + "\njs_package lib { srcs = ./lib/src:**/*.ts; }\n",
      },
      ["-DJS_TARGET=es2020", "build-server"]
    );
    await session.waitFor("Watching for changes");
    let received = "";
    session.stdout.on("data", (data: Buffer) => (received += data.toString("utf8")));
    const client = bspClient(session);
    await client.request("build/initialize", {
      displayName: "test",
      version: "0",
      bspVersion: "2.1.0",
      rootUri: "",
      capabilities: {},
    });
    await client.notification("build/taskFinish");
    const messages = received
      .split(/Content-Length: *\d+\r\n\r\n/)
      .filter(body => body !== "")
      .map(body => JSON.parse(body) as { id?: number; method?: string });
    expect(messages[0].id).to.equal(1);
    expect(messages.slice(1).map(message => message.method)).to.include.members(["build/taskStart", "build/taskFinish"]);
  });
});

/* The Language Server Protocol for the build files, served beside BSP over
 * the one connection, its frames tagged `Fabr-Protocol: lsp`. */
describe("e2e: build-server's language server", () => {
  const project = {
    ...STUB_TSC,
    "lib/src/index.ts": "export const libValue = 1;\n",
    "app/src/main.test.ts": "export const checked = 1;\n",
    "PROJECT.fabr":
      "plugin @fabr-build/js;\n\n" +
      STUB_TSC_CONFIG +
      "\n# The library.\njs_package lib { srcs = ./lib/src:**/*.ts; }\n" +
      "LIBS = lib;\n" +
      "js_package app { srcs = ./lib/src:**/*.ts; tests = ./app/src:**/*.test.ts; deps = ${LIBS}; }\n",
  };
  let session: WatchSession;
  let bsp: ReturnType<typeof bspClient>;
  let lsp: ReturnType<typeof bspClient>;
  let uri: string;
  let text: string;
  const position = (needle: string): { line: number; character: number } => {
    const offset = text.indexOf(needle) + 1;
    const before = text.slice(0, offset).split("\n");
    return { line: before.length - 1, character: before[before.length - 1].length };
  };

  beforeAll(async () => {
    session = startFabrWatch(project, ["-DJS_TARGET=es2020", "build-server"]);
    bsp = bspClient(session);
    lsp = bspClient(session, "lsp");
    await bsp.request("build/initialize", { displayName: "test", version: "0", bspVersion: "2.1.0", rootUri: "", capabilities: {} });
    await bsp.notification("build/taskFinish");
    const file = path.join(fs.realpathSync(session.dir), "PROJECT.fabr");
    uri = pathToFileURL(file).toString();
    text = fs.readFileSync(file, "utf8");
    const initialized = await lsp.request("initialize", { processId: null, rootUri: null, capabilities: {} });
    expect(initialized).to.deep.include({
      capabilities: {
        textDocumentSync: 1,
        definitionProvider: true,
        hoverProvider: true,
        documentSymbolProvider: true,
        completionProvider: { triggerCharacters: ["{", "$"] },
        codeLensProvider: {},
      },
    });
    lsp.notify("initialized", {});
  });
  afterAll(() => session.stop());

  it("lists a build file's declarations", async () => {
    const symbols = (await lsp.request("textDocument/documentSymbol", { textDocument: { uri } })) as unknown as Array<{
      name: string;
      detail?: string;
    }>;
    expect(symbols.map(symbol => symbol.name)).to.include.members(["lib", "LIBS", "app"]);
  });

  it("finds where a reference and a substitution are declared", async () => {
    const definition = (needle: string): Promise<Array<{ targetUri: string; targetRange: { start: { line: number } } }>> =>
      lsp.request("textDocument/definition", { textDocument: { uri }, position: position(needle) }) as never;
    expect((await definition("lib;")).map(link => link.targetRange.start.line)).to.deep.equal([position("lib {").line]);
    expect((await definition("LIBS}")).map(link => link.targetRange.start.line)).to.deep.equal([position("LIBS =").line]);
  });

  it("offers the properties a target's type declares, where one is named", async () => {
    const items = (await lsp.request("textDocument/completion", {
      textDocument: { uri },
      position: position("srcs = ./lib/src"),
    })) as unknown as Array<{ label: string }>;
    expect(items.map(item => item.label)).to.include.members(["srcs", "deps", "exports"]);
  });

  it("puts a target's operations above it, as commands naming the target, Test only where it has tests", async () => {
    /* Test is offered where the test target is served, as its description settles. */
    while (
      !((await bsp.request("workspace/buildTargets", {})) as { targets: Array<{ id: { uri: string } }> }).targets.some(
        target => target.id.uri === "fabr:app?operation=test"
      )
    ) {
      await bsp.notification("buildTarget/didChange");
    }
    const lenses = (await lsp.request("textDocument/codeLens", { textDocument: { uri } })) as unknown as Array<{
      command: { title: string; command: string; arguments: string[] };
    }>;
    const of = (name: string): string[][] =>
      lenses
        .filter(lens => lens.command.arguments[0].replace(/\?.*/, "") === `fabr:${name}`)
        .map(lens => [lens.command.title, lens.command.command, lens.command.arguments[0]]);
    expect(of("lib")).to.deep.equal([["Build", "fabr.build", "fabr:lib"]]);
    expect(of("app")).to.deep.equal([
      ["Build", "fabr.build", "fabr:app"],
      ["Test", "fabr.test", "fabr:app?operation=test"],
    ]);
  });

  it("documents what a reference names", async () => {
    const hover = (await lsp.request("textDocument/hover", { textDocument: { uri }, position: position("lib;") })) as {
      contents: { value: string };
    };
    expect(hover.contents.value).to.equal("`js_package lib`\n\nThe library.");
  });

  it("publishes the syntax errors of a build file as typed, before it is saved", async () => {
    await lsp.drain("textDocument/publishDiagnostics");
    lsp.notify("textDocument/didOpen", { textDocument: { uri, languageId: "fabr", version: 1, text: text + "broken {\n" } });
    const typed = (await lsp.notification("textDocument/publishDiagnostics")) as { uri: string; diagnostics: unknown[] };
    expect(typed.uri).to.equal(uri);
    expect(typed.diagnostics.length).to.be.greaterThan(0);
    lsp.notify("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [{ text }] });
    expect(await lsp.notification("textDocument/publishDiagnostics")).to.deep.equal({ uri, diagnostics: [] });
    lsp.notify("textDocument/didClose", { textDocument: { uri } });
  });

  it("publishes the errors of a build file saved broken, and clears them once it is fixed", async () => {
    await lsp.drain("textDocument/publishDiagnostics");
    session.write("PROJECT.fabr", text + "broken {\n");
    const broken = (await lsp.notification("textDocument/publishDiagnostics")) as {
      uri: string;
      diagnostics: Array<{ message: string }>;
    };
    expect(broken.uri).to.equal(uri);
    expect(broken.diagnostics.length).to.be.greaterThan(0);
    session.write("PROJECT.fabr", text);
    const fixed = (await lsp.notification("textDocument/publishDiagnostics")) as { uri: string; diagnostics: unknown[] };
    expect(fixed).to.deep.equal({ uri, diagnostics: [] });
  });
});

/* Building and testing a target over BSP: a compile request, and a test
 * request whose tests are each reported as they finished. */
describe("e2e: build-server building and testing targets", () => {
  const project = {
    ...STUB_TSC,
    "PROJECT.fabr":
      "plugin @fabr-build/js;\n\n" + STUB_TSC_CONFIG + "\njs_package thing { srcs = src:**/*.ts; tests = src:**/*.test.ts; }\n",
    "src/index.ts": "export const one = 1;\n",
    "src/thing.test.ts":
      'const assert = require("node:assert");\n' +
      'describe("thing", () => { it("passes", () => { assert.equal(1, 1); }); it("fails on purpose", () => { assert.equal(1, 2); }); });\n',
  };
  let session: WatchSession;
  let client: ReturnType<typeof bspClient>;
  jest.setTimeout(120000);

  beforeAll(async () => {
    session = startFabrWatch(project, ["-DJS_TARGET=es2020", "build-server"]);
    client = bspClient(session);
    await client.request("build/initialize", {
      displayName: "test",
      version: "0",
      bspVersion: "2.1.0",
      rootUri: "",
      capabilities: {},
    });
    await client.notification("build/taskFinish");
  });
  afterAll(() => session.stop());

  it("builds a target a compile request names", async () => {
    expect(await client.request("buildTarget/compile", { targets: [{ uri: "fabr:thing" }], originId: "c1" })).to.deep.equal({
      originId: "c1",
      statusCode: 1,
    });
  });

  it("tests a target a test request names, reporting each test's outcome", async () => {
    await client.drain("build/taskFinish");
    const result = await client.request("buildTarget/test", { targets: [{ uri: "fabr:thing?operation=test" }], originId: "t1" });
    expect(result).to.deep.equal({ originId: "t1", statusCode: 2 });
    const finishes: Array<{ dataKind?: string; data?: { displayName?: string; status?: number; passed?: number; failed?: number } }> =
      [];
    for (;;) {
      const finish = (await client.notification("build/taskFinish")) as (typeof finishes)[number];
      finishes.push(finish);
      if (finish.dataKind === undefined) {
        break;
      }
    }
    const outcomes = finishes
      .filter(finish => finish.dataKind === "test-finish")
      .map(finish => [finish.data!.displayName, finish.data!.status]);
    expect(outcomes.sort()).to.deep.equal([
      ["fails on purpose", 2],
      ["passes", 1],
    ]);
    expect(finishes.find(finish => finish.dataKind === "test-report")?.data).to.deep.include({ passed: 1, failed: 1 });
  });
});
