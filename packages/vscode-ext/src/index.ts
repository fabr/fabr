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

/**
 * The VS Code extension: for each workspace folder holding a fabr project, the
 * project's own fabr serving it (`fabr build-server`), and the editor's
 * TypeScript server shown the project's units through the wrapper the
 * extension points `js/ts.tsdk.path` at, and the server shared with the Java
 * language server's fabr importer, which asks for it with
 * {@link CONNECT_BUILD_SERVER_COMMAND}.
 */

import { type ChildProcess, spawn } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { BspClient } from "./BspClient";
import { relayBuildServer } from "./BspRelay";
import { composeProject, type IServedTarget } from "./ProjectDocument";
import { DOCUMENT_VERSION } from "./tsserver/Registry";
import { layOutTsdk } from "./tsserver/Wrapper";

/** The file a fabr project's root holds. */
const PROJECT_FILE = "PROJECT.fabr";

/** Where the extension keeps what every window's TypeScript server reads (`FABR_VSCODE_HOME` overriding). */
const HOME = process.env.FABR_VSCODE_HOME ?? path.join(os.homedir(), ".fabr", "vscode");
const REGISTRY = path.join(HOME, "registry.json");

/** The command sharing a project's server at a socket, given the project's root URI and the socket's path. */
const CONNECT_BUILD_SERVER_COMMAND = "_fabr.connectBuildServer";

const servers: ChildProcess[] = [];
const documents: string[] = [];
/** Each project's server, by the project's root, once it is initialized: its client and its `build/initialize` result. */
const initializedServers = new Map<string, Promise<{ client: BspClient; initialized: unknown }>>();
const relays: Array<Promise<net.Server>> = [];

export function activate(context: vscode.ExtensionContext): void {
  if (vscode.workspace.isTrusted) {
    start(context);
  } else {
    context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => start(context)));
  }
}

export function deactivate(): void {
  for (const server of servers) {
    server.kill();
  }
  for (const relay of relays) {
    void relay.then(server => server.close(), () => undefined);
  }
  updateRegistry(names => names.filter(name => !documents.includes(name)));
}

function start(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Fabr");
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  status.text = "fabr: starting";
  status.show();
  const problems = vscode.languages.createDiagnosticCollection("fabr");
  context.subscriptions.push(output, status, problems);
  context.subscriptions.push(vscode.commands.registerCommand(SHOW_OUTPUT_COMMAND, () => output.show(true)));
  context.subscriptions.push(
    vscode.commands.registerCommand(CONNECT_BUILD_SERVER_COMMAND, (rootUri: string, socket: string) => {
      const root = vscode.Uri.parse(rootUri).fsPath.replace(/\/$/, "");
      const found = [...initializedServers].find(([projectRoot]) => root === projectRoot || root.startsWith(projectRoot + path.sep));
      if (found === undefined) {
        output.appendLine(`fabr: no fabr project at ${root} to share`);
        return;
      }
      const relayed = found[1].then(({ client, initialized }) => relayBuildServer(client, initialized, socket));
      relays.push(relayed);
      relayed.catch(err => output.appendLine(`fabr: cannot share ${root}'s build server at ${socket}: ${String(err)}`));
    })
  );
  pointTsdk(output);
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const root = folder.uri.fsPath;
    if (fs.existsSync(path.join(root, PROJECT_FILE))) {
      serveProject(root, output, status, problems);
    }
  }
}

/** Lay out the wrapper's `tsdk` over VS Code's bundled TypeScript, and point the user's `js/ts.tsdk.path` at it. */
function pointTsdk(output: vscode.OutputChannel): void {
  const typescript = path.join(vscode.env.appRoot, "extensions", "node_modules", "typescript");
  const version = (JSON.parse(fs.readFileSync(path.join(typescript, "package.json"), "utf8")) as { version: string }).version;
  const tsdk = layOutTsdk(path.join(HOME, "tsdk"), { tsserver: path.join(typescript, "lib", "tsserver.js"), version, registry: REGISTRY });
  if (!fs.existsSync(REGISTRY)) {
    writeAtomically(REGISTRY, JSON.stringify({ version: DOCUMENT_VERSION, projects: [] }));
  }
  const settings = vscode.workspace.getConfiguration();
  const keys = ["js/ts.tsdk.path", "typescript.tsdk"].filter(key => settings.inspect<string>(key)?.globalValue !== tsdk);
  /* A server started before the tsdk was laid out runs without the wrapper. */
  void Promise.all(keys.map(key => settings.update(key, tsdk, vscode.ConfigurationTarget.Global)))
    .then(() => vscode.commands.executeCommand("typescript.restartTsServer"))
    .then(undefined, err => output.appendLine(`fabr: cannot point the TypeScript server at ${tsdk}: ${String(err)}`));
}

/** Start the server of the project at `root`, and keep its document current. */
function serveProject(root: string, output: vscode.OutputChannel, status: vscode.StatusBarItem, problems: vscode.DiagnosticCollection): void {
  const { argv, env } = commandFor(root);
  const [command, ...args] = argv;
  const server = spawn(command, [...args, "build-server"], { cwd: root, stdio: ["pipe", "pipe", "pipe"], env });
  servers.push(server);
  server.stderr!.on("data", (data: Buffer) => output.append(data.toString("utf8")));
  server.on("exit", code => {
    if (code === COMMAND_NOT_FOUND) {
      notFound(`${[command, ...args].join(" ")} could not run a command it needs`, output, status);
    } else {
      status.text = `fabr: server exited (${code ?? "signal"})`;
    }
  });
  server.on("error", err => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      notFound(`${command} was not found`, output, status);
    } else {
      output.appendLine(`fabr: cannot start ${command}: ${err.message}`);
      status.text = "fabr: not started";
    }
  });
  const client = new BspClient(server.stdin!, server.stdout!);
  const storage = path.join(HOME, "projects", crypto.createHash("sha256").update(root).digest("hex").slice(0, 16));
  const document = path.join(storage, "document.json");
  documents.push(document);
  let installation = "";
  let projectRoot = root;
  let shown = "";
  let ready: (server: { client: BspClient; initialized: unknown }) => void = () => {};
  initializedServers.set(root, new Promise(resolve => (ready = resolve)));
  /* What the status shows: the describing task's progress, the targets it failed to describe, and the targets composed. */
  let progress: { done: number; total: number } | undefined;
  let failed: string[] = [];
  let shownTargets: number | undefined;
  /* True if targets changed while a describing task ran: composed once it
   * finishes, as each composition restarts tsserver. */
  let held = false;
  const showStatus = (): void => {
    const plural = (count: number): string => `${count} ${count === 1 ? "target" : "targets"}`;
    if (progress !== undefined) {
      status.text = `fabr: initializing ${progress.done}/${plural(progress.total)}`;
    } else if (shownTargets !== undefined) {
      status.text = `fabr: ${plural(shownTargets)}${failed.length === 0 ? "" : `, ${failed.length} failed`}`;
    }
    status.tooltip = failed.length === 0 ? undefined : `Could not describe ${failed.join(", ")}: see the Fabr output.`;
    status.command = failed.length === 0 ? undefined : SHOW_OUTPUT_COMMAND;
  };
  /* Each document's diagnostics by the target reporting them, as BSP publishes them. */
  const reported = new Map<string, Map<string, vscode.Diagnostic[]>>();
  client.onNotification("build/publishDiagnostics", params => {
    const { textDocument, buildTarget, diagnostics } = params as IPublishDiagnostics;
    const byTarget = reported.get(textDocument.uri) ?? new Map<string, vscode.Diagnostic[]>();
    byTarget.set(buildTarget.uri, diagnostics.map(toDiagnostic));
    reported.set(textDocument.uri, byTarget);
    /* Several targets report a failure they share: shown once. */
    const shown = new Map([...byTarget.values()].flat().map(diagnostic => [`${diagnostic.range.start.line}:${diagnostic.range.start.character}:${diagnostic.message}`, diagnostic]));
    problems.set(vscode.Uri.parse(textDocument.uri), [...shown.values()]);
  });
  client.onNotification("build/taskProgress", params => {
    const { progress: done, total } = params as { progress?: number; total?: number };
    progress = { done: done ?? 0, total: total ?? 0 };
    showStatus();
  });
  client.onNotification("build/taskFinish", params => {
    const { dataKind, data } = params as { dataKind?: string; data?: { failed?: string[] } };
    progress = undefined;
    if (dataKind === DESCRIBE_TASK_DATA_KIND) {
      failed = data?.failed ?? [];
    }
    showStatus();
    if (held) {
      held = false;
      requestRefresh();
    }
  });
  const refresh = async (): Promise<void> => {
    const { targets } = await client.request<{ targets: IServedTarget[] }>("workspace/buildTargets", {});
    const composed = composeProject({
      root: projectRoot,
      installation,
      storage,
      targets,
      readFile: file => fs.readFileSync(file, "utf8"),
      resolve: (specifier, from) => require.resolve(specifier, { paths: [from] }),
    });
    for (const problem of composed.problems) {
      output.appendLine(`fabr: ${problem}`);
    }
    for (const [file, text] of composed.files) {
      writeAtomically(file, text);
    }
    writeAtomically(document, JSON.stringify(composed.document, null, 2));
    updateRegistry(names => (names.includes(document) ? names : [...names, document]));
    shownTargets = targets.length;
    showStatus();
    /* A file tsserver already opened keeps the config it found, so a change in
     * which paths are served takes a restart; anything else, a reload. */
    const links = Object.keys(composed.document.links as Record<string, string>).join("\n");
    await vscode.commands.executeCommand(links === shown ? "typescript.reloadProjects" : "typescript.restartTsServer");
    shown = links;
  };
  /* One refresh at a time: a change announced during one is taken up by one more after it. */
  let refreshing: Promise<void> | undefined;
  let again = false;
  const requestRefresh = (): void => {
    if (refreshing !== undefined) {
      again = true;
      return;
    }
    refreshing = refresh()
      .catch(err => output.appendLine(`fabr: ${String(err)}`))
      .finally(() => {
        refreshing = undefined;
        if (again) {
          again = false;
          requestRefresh();
        }
      });
  };
  client.onNotification("buildTarget/didChange", () => {
    if (progress !== undefined) {
      held = true;
    } else {
      requestRefresh();
    }
  });
  void client
    .request<{ data?: { root?: string; installation?: string } }>("build/initialize", {
      displayName: "Fabr for VS Code",
      version: "0.1.0",
      bspVersion: "2.1.0",
      rootUri: vscode.Uri.file(root).toString(),
      capabilities: { languageIds: ["typescript", "javascript", "java"] },
    })
    .then(initialized => {
      installation = initialized.data?.installation ?? "";
      projectRoot = initialized.data?.root === undefined ? root : vscode.Uri.parse(initialized.data.root).fsPath.replace(/\/$/, "");
      client.notify("build/initialized", {});
      ready({ client, initialized });
      requestRefresh();
      return refreshing;
    })
    .catch(err => {
      output.appendLine(`fabr: ${String(err)}`);
      status.text = "fabr: failed";
    });
}

/** What `build/publishDiagnostics` carries. */
interface IPublishDiagnostics {
  textDocument: { uri: string };
  buildTarget: { uri: string };
  diagnostics: IBspDiagnostic[];
}

/** A BSP diagnostic, as LSP shapes one. */
interface IBspDiagnostic {
  range: IBspRange;
  severity?: number;
  message: string;
  relatedInformation?: Array<{ location: { uri: string; range: IBspRange }; message: string }>;
}

/** A BSP range: zero-based lines and characters. */
interface IBspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

/** @return `range` as VS Code's. */
function toRange(range: IBspRange): vscode.Range {
  return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
}

/** @return `diagnostic`, a BSP one, as VS Code's. */
function toDiagnostic(diagnostic: IBspDiagnostic): vscode.Diagnostic {
  /* BSP's severities count from 1 (error), VS Code's from 0. */
  const severity = [vscode.DiagnosticSeverity.Error, vscode.DiagnosticSeverity.Warning, vscode.DiagnosticSeverity.Information, vscode.DiagnosticSeverity.Hint][
    (diagnostic.severity ?? 1) - 1
  ];
  const shown = new vscode.Diagnostic(toRange(diagnostic.range), diagnostic.message, severity ?? vscode.DiagnosticSeverity.Error);
  shown.source = "fabr";
  shown.relatedInformation = diagnostic.relatedInformation?.map(
    related => new vscode.DiagnosticRelatedInformation(new vscode.Location(vscode.Uri.parse(related.location.uri), toRange(related.location.range)), related.message)
  );
  return shown;
}

/** The `dataKind` of a describing task's finish, whose `data` names the targets that could not be described. */
const DESCRIBE_TASK_DATA_KIND = "fabr-describe";

/** The command showing the Fabr output channel. */
const SHOW_OUTPUT_COMMAND = "fabr.showOutput";

/** The exit status of a shell that could not find a command. */
const COMMAND_NOT_FOUND = 127;

/**
 * Report that the server's command, or one it runs (`node`), was not found on
 * the PATH VS Code was given — which, started outside a shell, is the
 * system's alone where VS Code could not read the login shell's in time.
 */
function notFound(what: string, output: vscode.OutputChannel, status: vscode.StatusBarItem): void {
  const message = `fabr: ${what}, on VS Code's PATH (${process.env.PATH ?? ""}). Start VS Code from a shell, or set fabr.command to fabr's bin/fabr.js, which runs on VS Code's own Node.js.`;
  output.appendLine(message);
  status.text = "fabr: command not found";
  status.tooltip = message;
  void vscode.window.showErrorMessage(message, "Open Settings").then(choice => {
    if (choice === "Open Settings") {
      void vscode.commands.executeCommand("workbench.action.openSettings", "fabr.command");
    }
  });
}

/**
 * @return the command running the project's own fabr, and the environment it
 * runs in: the `fabr.command` setting, else the fabr installed in the
 * project's `node_modules`, else `fabr` on the PATH. A fabr entry script (the
 * installed one, or a setting naming a lone `.js` file) runs on VS Code's own
 * Node.js, so that starting it needs nothing from the PATH.
 */
function commandFor(root: string): { argv: string[]; env?: NodeJS.ProcessEnv } {
  const configured = (vscode.workspace.getConfiguration("fabr", vscode.Uri.file(root)).get<string[]>("command") ?? []).map(part =>
    part.replace(/^\.\//, `${root}/`)
  );
  const installed = path.join(root, "node_modules", INSTALLED_ENTRY);
  const entry = configured.length === 1 && SCRIPT.test(configured[0]) ? configured[0] : configured.length === 0 && fs.existsSync(installed) ? installed : undefined;
  if (entry !== undefined) {
    return { argv: [process.execPath, entry], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } };
  }
  return { argv: configured.length > 0 ? configured : ["fabr"] };
}

/** Where fabr's entry script lies in an installation's `node_modules`. */
const INSTALLED_ENTRY = "@fabr-build/cli/bin/fabr.js";

/** A JavaScript file, which runs on Node.js. */
const SCRIPT = /\.[cm]?js$/;

/** Rewrite the registry's document list through `change`, replacing the file whole. */
function updateRegistry(change: (names: string[]) => string[]): void {
  let names: string[] = [];
  try {
    names = (JSON.parse(fs.readFileSync(REGISTRY, "utf8")) as { projects?: string[] }).projects ?? [];
  } catch {
    names = [];
  }
  /* Rewritten even when unchanged: a changed document is announced by the registry changing. */
  writeAtomically(REGISTRY, JSON.stringify({ version: DOCUMENT_VERSION, projects: change(names), at: Date.now() }, null, 2));
}

function writeAtomically(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text);
  fs.renameSync(temporary, file);
}
