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

/**
 * Building and testing a project's targets from the editor, over BSP's
 * `buildTarget/compile` and `buildTarget/test`: the Build and Test commands,
 * and the Testing view, whose items are the project's test targets and,
 * once run, the tests each ran.
 */

import * as vscode from "vscode";
import type { JsonRpcClient } from "./JsonRpcClient";
import type { IServedTarget } from "./ProjectDocument";
import { isRecord } from "./ProtocolDiagnostics";

/** The command building a target, given its identifier or choosing one. */
export const BUILD_COMMAND = "fabr.build";

/** The command testing a target, given its identifier or choosing one. */
export const TEST_COMMAND = "fabr.test";

/** A project's server, and the targets it serves. */
export interface IServedProject {
  root: string;
  client: JsonRpcClient;
  targets: IServedTarget[];
}

/** BSP's `StatusCode` of a request that succeeded. */
const STATUS_OK = 1;

/** BSP's `TestStatus` of a test that failed. */
const TEST_FAILED = 2;

/** A test's outcome, as the data of a `test-finish` task finish reports it. */
interface ITestFinish {
  displayName: string;
  status: number;
  message?: string;
  location?: { uri: string };
}

/** @return the `originId` of `params`, a `build/taskFinish`'s, and the test finish it reports, or undefined where it reports none. */
function toTestFinish(params: unknown): { originId: string; finish: ITestFinish } | undefined {
  if (!isRecord(params) || typeof params.originId !== "string" || params.dataKind !== "test-finish" || !isRecord(params.data)) {
    return undefined;
  }
  const { displayName, status, message, location } = params.data;
  if (typeof displayName !== "string" || typeof status !== "number") {
    return undefined;
  }
  return {
    originId: params.originId,
    finish: {
      displayName,
      status,
      ...(typeof message === "string" ? { message } : {}),
      ...(isRecord(location) && typeof location.uri === "string" ? { location: { uri: location.uri } } : {}),
    },
  };
}

/**
 * Register the Build and Test commands and the Testing view over `projects`,
 * the projects being served, by root. A test request that fails is written to
 * `output`, its target's item reported as failed.
 *
 * @return what to dispose of when the extension ends, and what refreshes the
 * Testing view's targets once those served change.
 */
export function registerTargetCommands(
  projects: ReadonlyMap<string, IServedProject>,
  output: vscode.OutputChannel
): vscode.Disposable & { refresh(): void } {
  let origins = 0;
  const controller = vscode.tests.createTestController("fabr", "Fabr");
  /* What receives a request's test finishes, by its originId. */
  const listening = new Map<string, (finish: ITestFinish) => void>();
  /* The clients whose `build/taskFinish` notifications are listened to. */
  const listened = new Set<JsonRpcClient>();
  const listen = (client: JsonRpcClient): void => {
    if (listened.has(client)) {
      return;
    }
    listened.add(client);
    client.onNotification("build/taskFinish", params => {
      const finished = toTestFinish(params);
      if (finished !== undefined) {
        listening.get(finished.originId)?.(finished.finish);
      }
    });
  };
  const testTargets = (): Array<{ project: IServedProject; target: IServedTarget }> =>
    [...projects.values()].flatMap(project =>
      project.targets.filter(target => target.fabr?.operation === "test").map(target => ({ project, target }))
    );
  const projectOf = (uri: string): IServedProject | undefined =>
    [...projects.values()].find(project => project.targets.some(target => target.id.uri === uri));
  const choose = async (operation: string, given: unknown): Promise<string | undefined> => {
    if (typeof given === "string") {
      return given;
    }
    const choices = [...projects.values()]
      .flatMap(project => project.targets.filter(target => target.fabr?.operation === operation))
      .map(target => target.id.uri);
    return vscode.window.showQuickPick(choices, { placeHolder: `The target to ${operation}` });
  };

  /* Each test target an item of the Testing view, kept as the targets served change. */
  controller.resolveHandler = async () => {
    controller.items.replace(
      testTargets().map(({ target }) =>
        controller.createTestItem(target.id.uri, (target as { displayName?: string }).displayName ?? target.id.uri)
      )
    );
  };
  controller.refreshHandler = async () => controller.resolveHandler?.(undefined);

  /** Test the targets of `items`, reporting each test's outcome to `run` beneath its target's item. */
  const test = async (items: readonly vscode.TestItem[], run: vscode.TestRun): Promise<void> => {
    for (const item of items) {
      const project = projectOf(item.id);
      if (project === undefined) {
        run.skipped(item);
        continue;
      }
      listen(project.client);
      origins += 1;
      const originId = `fabr-test-${origins}`;
      run.started(item);
      listening.set(originId, finish => {
        const id = `${item.id}#${finish.location?.uri ?? ""}#${finish.displayName}`;
        const child =
          item.children.get(id) ??
          controller.createTestItem(id, finish.displayName, finish.location ? vscode.Uri.parse(finish.location.uri) : undefined);
        item.children.add(child);
        if (finish.status === TEST_FAILED) {
          run.failed(child, new vscode.TestMessage(finish.message ?? "failed"));
        } else {
          run.passed(child);
        }
      });
      const result = await project.client
        .request<{ statusCode: number }>("buildTarget/test", { targets: [{ uri: item.id }], originId })
        .then(undefined, (err: unknown) => {
          output.appendLine(`fabr: ${String(err)}`);
          return { statusCode: 0 };
        });
      listening.delete(originId);
      if (result.statusCode === STATUS_OK) {
        run.passed(item);
      } else {
        run.failed(item, new vscode.TestMessage("Tests failed: see the tests beneath, and the Fabr output"));
      }
    }
  };
  controller.createRunProfile("Run", vscode.TestRunProfileKind.Run, async request => {
    const run = controller.createTestRun(request);
    const requested = request.include ?? itemsOf(controller.items);
    /* A test is run by running its target. */
    await test([...new Set(requested.map(item => item.parent ?? item))], run);
    run.end();
  });

  const perform = async (operation: "build" | "test", given: unknown): Promise<void> => {
    const uri = await choose(operation, given);
    const project = uri === undefined ? undefined : projectOf(uri);
    if (uri === undefined || project === undefined) {
      return;
    }
    if (operation === "test") {
      await controller.resolveHandler?.(undefined);
      const item = controller.items.get(uri);
      if (item === undefined) {
        void vscode.window.showErrorMessage(`${uri} has no tests to run`);
        return;
      }
      const run = controller.createTestRun(new vscode.TestRunRequest([item]));
      await test([item], run);
      run.end();
      return;
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Building ${uri}` }, async () => {
      const result = await project.client.request<{ statusCode: number }>("buildTarget/compile", { targets: [{ uri }] });
      if (result.statusCode === STATUS_OK) {
        void vscode.window.showInformationMessage(`Built ${uri}`);
      } else {
        void vscode.window.showErrorMessage(`Building ${uri} failed: see the Problems view and the Fabr output`);
      }
    });
  };

  const disposable = vscode.Disposable.from(
    controller,
    vscode.commands.registerCommand(BUILD_COMMAND, (uri?: unknown) => perform("build", uri)),
    vscode.commands.registerCommand(TEST_COMMAND, (uri?: unknown) => perform("test", uri))
  );
  return { dispose: () => disposable.dispose(), refresh: () => void controller.resolveHandler?.(undefined) };
}

/** @return the items of `items`. */
function itemsOf(items: vscode.TestItemCollection): vscode.TestItem[] {
  const all: vscode.TestItem[] = [];
  items.forEach(item => all.push(item));
  return all;
}
