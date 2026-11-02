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

/* A real tsserver started through a laid-out tsdk, for a registry naming one
 * project. The project's plugin implementation is a fixture recording what it
 * was given: the real one is js-tools', tested there; what is checked here is
 * the wrapper's half — configs served in place of the real ones, only within a
 * registered root, and the units handed to the project's implementation. */

import { expect } from "chai";
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { layOutTsdk } from "./Wrapper";

/** The compiled modules beside this test, whether it runs compiled or from source. */
const COMPILED = __filename.endsWith(".ts") ? path.resolve(__dirname, "../../build/tsserver") : __dirname;

interface IServer {
  request(command: string, args: unknown): Promise<{ success: boolean; body?: unknown; message?: string }>;
  /** Send a request tsserver answers with no response (`open`). */
  send(command: string, args: unknown): void;
  close(): void;
}

function startServer(tsdkLib: string): IServer {
  const child: ChildProcess = spawn(
    process.execPath,
    [path.join(tsdkLib, "tsserver.js"), "--useInferredProjectPerProjectRoot", "--disableAutomaticTypingAcquisition", "--canUseWatchEvents"],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  let buffer = Buffer.alloc(0);
  let seq = 0;
  const pending = new Map<number, (message: { success: boolean; body?: unknown; message?: string }) => void>();
  child.stdout!.on("data", (data: Buffer) => {
    buffer = Buffer.concat([buffer, data]);
    for (;;) {
      const header = /Content-Length: (\d+)\r\n\r\n/.exec(buffer.toString("latin1"));
      if (header === null) {
        return;
      }
      const start = header.index + header[0].length;
      const end = start + Number(header[1]);
      if (buffer.length < end) {
        return;
      }
      const message = JSON.parse(buffer.subarray(start, end).toString("utf8"));
      buffer = buffer.subarray(end);
      if (message.type === "response") {
        pending.get(message.request_seq)?.(message);
        pending.delete(message.request_seq);
      }
    }
  });
  return {
    request: (command, args) =>
      new Promise(resolve => {
        seq += 1;
        pending.set(seq, resolve);
        child.stdin!.write(JSON.stringify({ seq, type: "request", command, arguments: args }) + "\n");
      }),
    send: (command, args) => {
      seq += 1;
      child.stdin!.write(JSON.stringify({ seq, type: "request", command, arguments: args }) + "\n");
    },
    close: () => child.kill(),
  };
}

const FIXTURE_PLUGIN = `
const fs = require("fs");
exports.createLanguageService = (ts, info, units) => {
  fs.appendFileSync(process.env.FABR_TEST_RECORD ?? ${"__dirname + '/record.txt'"}, info.project.getProjectName() + " " + units.map(u => u.config).join(",") + "\\n");
  return info.languageService;
};
`;

describe("tsserver wrapper", () => {
  let root: string;
  let server: IServer | undefined;
  const file = (name: string): string => path.join(root, name);
  const write = (name: string, text: string): void => {
    fs.mkdirSync(path.dirname(file(name)), { recursive: true });
    fs.writeFileSync(file(name), text);
  };
  const document = (config: string): string =>
    JSON.stringify({
      version: 1,
      root: file("project"),
      links: { [file("project/tsconfig.json")]: file(config) },
      units: [{ config: file("project/tsconfig.json"), root: file("project"), table: file("cache/table.json") }],
      plugin: file("plugin/index.js"),
    });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "fabr-wrapper-"));
    const loose = JSON.stringify({ compilerOptions: { strict: false, types: [] }, include: ["src"] });
    const strict = JSON.stringify({ compilerOptions: { strict: true, types: [] }, include: ["src"] });
    write("project/tsconfig.json", loose);
    write("project/src/a.ts", "export function f(x) {\n  return x;\n}\n");
    write("outside/tsconfig.json", strict);
    write("outside/src/a.ts", "export function f(x) {\n  return x;\n}\n");
    write("cache/strict.json", strict);
    write("cache/loose.json", loose);
    write("cache/table.json", "{}");
    write("plugin/index.js", FIXTURE_PLUGIN);
    write("cache/project.json", document("cache/strict.json"));
    write("registry.json", JSON.stringify({ version: 1, projects: [file("cache/project.json")] }));
    const tsdk = layOutTsdk(file("tsdk"), {
      tsserver: require.resolve("typescript/lib/tsserver.js"),
      version: "5.4.5",
      registry: file("registry.json"),
      modules: { wrapper: path.join(COMPILED, "Wrapper.js"), shim: path.join(COMPILED, "Shim.js") },
    });
    server = startServer(tsdk);
  });
  afterEach(() => {
    server?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const diagnosticCodes = async (name: string): Promise<number[]> => {
    server!.send("open", { file: file(name) });
    const result = await server!.request("semanticDiagnosticsSync", { file: file(name) });
    return (result.body as Array<{ code: number }>).map(d => d.code);
  };

  it("serves a registered project's config in place of the real one", async () => {
    expect(await diagnosticCodes("project/src/a.ts")).to.deep.equal([7006]);
    const info = await server!.request("projectInfo", { file: file("project/src/a.ts") });
    expect((info.body as { configFileName: string }).configFileName).to.equal(file("project/tsconfig.json"));
  });

  it("leaves a project under no registered root as it is", async () => {
    expect(await diagnosticCodes("outside/src/a.ts")).to.deep.equal([7006]);
    /* No fabr project's plugin is loaded for it. */
    const record = fs.existsSync(file("plugin/record.txt")) ? fs.readFileSync(file("plugin/record.txt"), "utf8") : "";
    expect(record).to.not.contain(file("outside/tsconfig.json"));
    write("outside/tsconfig.json", JSON.stringify({ compilerOptions: { strict: false, types: [] }, include: ["src"] }));
    server!.send("reloadProjects", {});
    expect(await diagnosticCodes("outside/src/a.ts")).to.deep.equal([]);
  });

  it("hands a registered project's units to its plugin implementation", async () => {
    await diagnosticCodes("project/src/a.ts");
    const record = fs.readFileSync(file("plugin/record.txt"), "utf8").trim().split("\n");
    expect(record).to.include(`${file("project/tsconfig.json")} ${file("project/tsconfig.json")}`);
  });

  it("follows a rewritten registry to a repointed link", async () => {
    expect(await diagnosticCodes("project/src/a.ts")).to.deep.equal([7006]);
    /* The new target is no newer than the old: the link's change is what tsserver must see. */
    write("cache/project.json", document("cache/loose.json"));
    write("registry.json", JSON.stringify({ version: 1, projects: [file("cache/project.json")], at: Date.now() }));
    const deadline = Date.now() + 20000;
    let codes = [7006];
    while (codes.length > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250));
      codes = await diagnosticCodes("project/src/a.ts");
    }
    expect(codes).to.deep.equal([]);
  });
});
