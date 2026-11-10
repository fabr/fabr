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
 * The VS Code extension: for each workspace folder holding a fabr project, it
 * starts the project's own fabr serving it (`fabr build-server`), shows the
 * editor's TypeScript server the project's units through the wrapper the
 * extension points `js/ts.tsdk.path` at, and shares the server with the Java
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
import { serveBuildFiles } from "./BuildFiles";
import { type IServedProject, registerTargetCommands } from "./TargetCommands";
import { JsonRpcClient } from "./JsonRpcClient";
import { relayBuildServer } from "./BspRelay";
import { composeProject, type IServedTarget } from "./ProjectDocument";
import { isRecord, type IProtocolDiagnostic, toDiagnostic, toProtocolDiagnostics } from "./ProtocolDiagnostics";
import { DOCUMENT_VERSION, registeredDocuments, updateRegistry, writeAtomically } from "./tsserver/Registry";
import { layOutTsdk } from "./tsserver/Wrapper";

/** The file a fabr project's root holds. */
const PROJECT_FILE = "PROJECT.fabr";

/** Where the extension keeps what every window's TypeScript server reads (`FABR_VSCODE_HOME` overriding). */
const HOME = process.env.FABR_VSCODE_HOME ?? path.join(os.homedir(), ".fabr", "vscode");
const REGISTRY = path.join(HOME, "registry.json");

/** The command sharing a project's server at a socket, given the project's root URI and the socket's path. */
const CONNECT_BUILD_SERVER_COMMAND = "_fabr.connectBuildServer";

const servers: ChildProcess[] = [];
/** What each project's server shows in the editor, disposed of when it ends. */
const served: vscode.Disposable[] = [];
/** Each project's server and the targets it serves, by the project's root. */
const projects = new Map<string, IServedProject>();
/** What refreshes the Testing view's targets. */
let refreshTests = (): void => undefined;
const documents: string[] = [];
/** Each project's server, by the project's root, once it is initialized: its client and its `build/initialize` result. */
const initializedServers = new Map<string, Promise<{ client: JsonRpcClient; initialized: unknown }>>();
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
  for (const disposable of served) {
    disposable.dispose();
  }
  for (const relay of relays) {
    void relay.then(server => server.close(), () => undefined);
  }
  updateRegistry(REGISTRY, names => names.filter(name => !documents.includes(name)));
}

function start(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Fabr");
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  status.text = "fabr: starting";
  status.show();
  const problems = vscode.languages.createDiagnosticCollection("fabr");
  const buildFileProblems = vscode.languages.createDiagnosticCollection("fabr-build-files");
  context.subscriptions.push(output, status, problems, buildFileProblems);
  context.subscriptions.push(vscode.commands.registerCommand(SHOW_OUTPUT_COMMAND, () => output.show(true)));
  const commands = registerTargetCommands(projects, output);
  refreshTests = commands.refresh;
  context.subscriptions.push(commands);
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
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const root = folder.uri.fsPath;
    if (fs.existsSync(path.join(root, PROJECT_FILE))) {
      serveProject(root, output, status, problems, buildFileProblems);
    }
  }
}

/** The outcome of pointing the `tsdk`, once this activation has started to: see {@link pointTsdk}. */
let pointing: Promise<boolean> | undefined;

/**
 * Lay out the wrapper's `tsdk` over VS Code's bundled TypeScript, and point the
 * user's `js/ts.tsdk.path` at it, restarting the TypeScript server where that
 * changed a setting. Done once per activation, when a project first has
 * TypeScript or JavaScript units to serve.
 *
 * @return true if it changed a setting, and so restarted the server, otherwise false.
 */
function pointTsdk(output: vscode.OutputChannel): Promise<boolean> {
  pointing ??= layOutAndPoint(output);
  return pointing;
}

async function layOutAndPoint(output: vscode.OutputChannel): Promise<boolean> {
  const typescript = path.join(vscode.env.appRoot, "extensions", "node_modules", "typescript");
  const manifest: unknown = JSON.parse(fs.readFileSync(path.join(typescript, "package.json"), "utf8"));
  const version = isRecord(manifest) && typeof manifest.version === "string" ? manifest.version : undefined;
  if (version === undefined) {
    output.appendLine(`fabr: VS Code's TypeScript at ${typescript} states no version`);
    return false;
  }
  const tsdk = layOutTsdk(path.join(HOME, "tsdk"), { tsserver: path.join(typescript, "lib", "tsserver.js"), version, registry: REGISTRY });
  if (!fs.existsSync(REGISTRY)) {
    writeAtomically(REGISTRY, JSON.stringify({ version: DOCUMENT_VERSION, projects: [] }));
  }
  const settings = vscode.workspace.getConfiguration();
  const keys = ["js/ts.tsdk.path", "typescript.tsdk"].filter(key => settings.inspect<string>(key)?.globalValue !== tsdk);
  if (keys.length === 0) {
    return false;
  }
  /* A server started before the settings named the tsdk runs without the wrapper. */
  try {
    await Promise.all(keys.map(key => settings.update(key, tsdk, vscode.ConfigurationTarget.Global)));
    await vscode.commands.executeCommand("typescript.restartTsServer");
    return true;
  } catch (err) {
    output.appendLine(`fabr: cannot point the TypeScript server at ${tsdk}: ${String(err)}`);
    return false;
  }
}

/** @return true if VS Code's TypeScript support is running, so that a TypeScript server may have started, otherwise false. */
function typeScriptActive(): boolean {
  return vscode.extensions.getExtension("vscode.typescript-language-features")?.isActive === true;
}

/** Start the server of the project at `root`, and keep its document current. */
function serveProject(
  root: string,
  output: vscode.OutputChannel,
  status: vscode.StatusBarItem,
  problems: vscode.DiagnosticCollection,
  buildFileProblems: vscode.DiagnosticCollection
): void {
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
  const client = new JsonRpcClient(server.stdin!, server.stdout!);
  /* The project's build files, through the language server the same process carries. */
  const buildFiles = serveBuildFiles(root, new JsonRpcClient(server.stdin!, server.stdout!, "lsp"), buildFileProblems);
  served.push(buildFiles);
  server.on("exit", () => {
    buildFiles.dispose();
    /* `problems` is every project's: only what this one's server reported is cleared. */
    reported.forEach((_, uri) => problems.delete(vscode.Uri.parse(uri)));
  });
  const storage = path.join(HOME, "projects", crypto.createHash("sha256").update(root).digest("hex").slice(0, 16));
  const document = path.join(storage, "document.json");
  documents.push(document);
  let installation = "";
  let projectRoot = root;
  /* The document tsserver last read, and the paths it served: at first, what
   * an earlier session left, listed at once so that a server starting now
   * reads it rather than starting without it. */
  let written = readIfPresent(document);
  let shown = linksOf(written);
  if (written !== undefined) {
    const listed = registeredDocuments(REGISTRY).includes(document);
    updateRegistry(REGISTRY, names => (names.includes(document) ? names : [...names, document]));
    if (shown !== "") {
      /* A TypeScript server started before the document was listed found none of its paths, and none of its watching. */
      void pointTsdk(output).then(changed =>
        !changed && !listed && typeScriptActive() ? vscode.commands.executeCommand("typescript.restartTsServer") : undefined
      );
    }
  }
  let ready: (server: { client: JsonRpcClient; initialized: unknown }) => void = () => {};
  initializedServers.set(root, new Promise(resolve => (ready = resolve)));
  /* What the status shows: the describing task's progress, the targets it failed to describe, and the targets composed. */
  let progress: { done: number; total: number } | undefined;
  /* The describing task under way: only its progress and finish are the pass's. */
  let describing: string | undefined;
  let failed: string[] = [];
  let shownTargets: number | undefined;
  /* True if a refresh waits for the running describing task to finish: what
   * the task changes is composed once, when it does, since each composition
   * may reload or restart tsserver. */
  let held = false;
  /* True once a describing pass has finished. */
  let described = false;
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
    const published = toPublishDiagnostics(params);
    if (published === undefined) {
      output.appendLine(`fabr: ignored a build/publishDiagnostics that is not one: ${JSON.stringify(params)}`);
      return;
    }
    const { textDocument, buildTarget, diagnostics } = published;
    const byTarget = reported.get(textDocument.uri) ?? new Map<string, vscode.Diagnostic[]>();
    byTarget.set(buildTarget.uri, diagnostics.map(toDiagnostic));
    reported.set(textDocument.uri, byTarget);
    /* Several targets report a failure they share: shown once. */
    const shown = new Map([...byTarget.values()].flat().map(diagnostic => [`${diagnostic.range.start.line}:${diagnostic.range.start.character}:${diagnostic.message}`, diagnostic]));
    problems.set(vscode.Uri.parse(textDocument.uri), [...shown.values()]);
  });
  client.onNotification("build/taskStart", params => {
    const notice = toTaskNotice(params);
    if (notice.dataKind === DESCRIBE_TASK_DATA_KIND) {
      describing = notice.task;
    }
  });
  client.onNotification("build/taskProgress", params => {
    const notice = toTaskNotice(params);
    if (notice.task !== undefined && notice.task === describing) {
      progress = { done: notice.progress ?? 0, total: notice.total ?? 0 };
      showStatus();
    }
  });
  client.onNotification("build/taskFinish", params => {
    const notice = toTaskNotice(params);
    if (notice.dataKind !== DESCRIBE_TASK_DATA_KIND || notice.task !== describing) {
      return;
    }
    describing = undefined;
    progress = undefined;
    /* A superseded pass is followed by the pass replacing it, whose finish ends the hold. */
    const superseded = notice.status === TASK_CANCELLED;
    if (!superseded) {
      failed = notice.failed;
      described = true;
    }
    showStatus();
    if (!superseded && held) {
      held = false;
      requestRefresh();
    }
  });
  const refresh = async (): Promise<void> => {
    const { targets } = await client.request<{ targets: IServedTarget[] }>("workspace/buildTargets", {});
    projects.set(root, { root, client, targets });
    refreshTests();
    buildFiles.refreshLenses();
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
    shownTargets = targets.length;
    showStatus();
    /* A document tsserver already read, and the registry still lists, is left as it is. */
    const text = JSON.stringify(composed.document, null, 2);
    if (text === written && registeredDocuments(REGISTRY).includes(document)) {
      return;
    }
    writeAtomically(document, text);
    written = text;
    updateRegistry(REGISTRY, names => (names.includes(document) ? names : [...names, document]));
    /* A file tsserver already opened keeps the config it found, so a change in
     * which paths are served takes a restart; anything else, a reload. Pointing
     * the tsdk restarts it already. */
    const links = linksOf(text);
    const restarted = links !== "" && (await pointTsdk(output));
    if (!restarted) {
      await vscode.commands.executeCommand(links === shown ? "typescript.reloadProjects" : "typescript.restartTsServer");
    }
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
  /* Until the server is initialized a change waits, and until its first
   * describing pass ends a refresh does: one composed from a pass still
   * running would replace a whole document with part of one. */
  let started = false;
  client.onNotification("buildTarget/didChange", () => {
    if (!started) {
      return;
    }
    if (describing !== undefined) {
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
      started = true;
      if (described) {
        requestRefresh();
      } else {
        held = true;
      }
    })
    .catch(err => {
      output.appendLine(`fabr: ${String(err)}`);
      status.text = "fabr: failed";
    });
}

/** @return `params` as a `build/publishDiagnostics`'s, or undefined where they are not one: a diagnostic that is no diagnostic is left out. */
function toPublishDiagnostics(params: unknown): IPublishDiagnostics | undefined {
  if (!isRecord(params) || !isRecord(params.textDocument) || !isRecord(params.buildTarget)) {
    return undefined;
  }
  const { textDocument, buildTarget } = params;
  if (typeof textDocument.uri !== "string" || typeof buildTarget.uri !== "string") {
    return undefined;
  }
  return { textDocument: { uri: textDocument.uri }, buildTarget: { uri: buildTarget.uri }, diagnostics: toProtocolDiagnostics(params.diagnostics) };
}

/** What `build/publishDiagnostics` carries. */
interface IPublishDiagnostics {
  textDocument: { uri: string };
  buildTarget: { uri: string };
  diagnostics: IProtocolDiagnostic[];
}

/** The `dataKind` of a describing task's finish, whose `data` names the targets that could not be described. */
const DESCRIBE_TASK_DATA_KIND = "fabr-describe";

/** BSP's `StatusCode` of a task that was cancelled. */
const TASK_CANCELLED = 3;

/** What a task notification says, as the status and the refresh read it. */
interface ITaskNotice {
  task?: string;
  dataKind?: string;
  status?: number;
  progress?: number;
  total?: number;
  failed: string[];
}

/** @return what `params`, a `build/taskStart`, `taskProgress` or `taskFinish`'s, says, each field left out where it is not of its type. */
function toTaskNotice(params: unknown): ITaskNotice {
  const record = isRecord(params) ? params : {};
  const taskId = isRecord(record.taskId) ? record.taskId : {};
  const data = isRecord(record.data) ? record.data : {};
  const number = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
  return {
    ...(typeof taskId.id === "string" ? { task: taskId.id } : {}),
    ...(typeof record.dataKind === "string" ? { dataKind: record.dataKind } : {}),
    ...(number(record.status) === undefined ? {} : { status: number(record.status) }),
    ...(number(record.progress) === undefined ? {} : { progress: number(record.progress) }),
    ...(number(record.total) === undefined ? {} : { total: number(record.total) }),
    failed: Array.isArray(data.failed) ? data.failed.filter((name): name is string => typeof name === "string") : [],
  };
}

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

/** @return `file`'s text, or undefined where there is none. */
function readIfPresent(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** @return the paths `text`, a project's document, serves, or "" where it names none. */
function linksOf(text: string | undefined): string {
  try {
    return Object.keys((JSON.parse(text ?? "{}") as { links?: Record<string, string> }).links ?? {}).join("\n");
  } catch {
    return "";
  }
}
