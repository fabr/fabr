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
 * `fabr build-server`: the project's described targets served over the Build
 * Server Protocol (https://build-server-protocol.github.io/docs/specification),
 * JSON-RPC over stdin and stdout. Every target is described, under watch, as
 * each of its operations would build it where that operation's rule describes
 * it; a description is served as its rule wrote it, its paths made `file:`
 * URIs (a project path from the project root, a file of the description from
 * its directory) and its target given a `fabr` field naming the directory its
 * description's files are in. Each target is served as soon as it is
 * described, and every target described, described anew or no longer
 * described is announced with `buildTarget/didChange`, those settling close
 * together in one notification.
 *
 * Stdout carries the protocol and nothing else; diagnostics go to stderr.
 */

import {
  Computable,
  ComputableHandle,
  getTestReport,
  type IDescribing,
  type ITestReport,
  type SourceRef,
  type IBuildTarget,
  type IDescription,
  type IJavacOptions,
  type ISourceItem,
  type ExecutionContext,
  type Log,
  reportFailure,
  targetIdentifier,
  toError,
} from "@fabr-build/core";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { getVersion, installationDirectory } from "./Command";
import { type JsonRpcConnection, MethodNotFound } from "./JsonRpc";
import { collectingLog, type IProtocolDiagnostic } from "./ProtocolDiagnostics";
import { toDocumentParams, toTargetsParams } from "./ProtocolParams";

/** The BSP version this server speaks. */
export const BSP_VERSION = "2.1.0";

/** A target as served: its description made absolute, and where its files are. */
interface IServedTarget {
  target: IBuildTarget & { fabr: { description: string; operation: string } };
  sources: ISourceItem[];
  roots: string[];
  javacOptions?: IJavacOptions;
}

/** The build operation, under which a target is served by its plain identifier. */
const BUILD = "build";

/** @return the identifier a target is served under: `fabr:<name>` as it builds, `fabr:<name>?operation=<operation>` otherwise. */
export function served({ name, operation }: { name: string; operation: string }): string {
  return operation === BUILD ? targetIdentifier(name).uri : `${targetIdentifier(name).uri}?operation=${operation}`;
}

/** BSP's `BuildTargetEventKind`. */
const CREATED = 1;
const CHANGED = 2;
const DELETED = 3;

/** How long announcements are held for others settling close behind them, in milliseconds. */
const ANNOUNCE_DELAY_MS = 100;

/** What the server builds or tests a target with, by its name, in the model it serves. */
export interface IServedOperations {
  build(name: string): Computable<SourceRef[][]>;
  test(name: string): Computable<SourceRef[][]>;
}

/** The languages of the targets the server builds and tests. */
const LANGUAGE_IDS = ["typescript", "javascript", "java"];

/** A range at a document's start, where a test's location names only its file. */
const ZERO_RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

/** BSP's `TestStatus` of each outcome a test report records. */
const TEST_STATUSES: Record<ITestReport["results"]["tests"][number]["status"], number> = { passed: 1, failed: 2, pending: 3, other: 3, skipped: 5 };

/** @return a promise of what `computable` first settles to. */
function settled<T>(computable: Computable<T>): Promise<T> {
  return new Promise((resolve, reject) => computable.once(resolve, reject));
}

/** BSP's `StatusCode`s, as a task finishes. */
const TASK_OK = 1;
const TASK_ERROR = 2;
const TASK_CANCELLED = 3;

/** The `dataKind` of a describing task's start and finish: a finish's `data` names the targets that could not be described. */
export const DESCRIBE_TASK_DATA_KIND = "fabr-describe";

/**
 * The server: the targets described so far, and the connection they are
 * served over. It belongs to the run, not to a model, so a reloaded model's
 * descriptions replace the last one's.
 */
export class BspServer {
  private readonly served = new Map<string, IServedTarget>();
  private loaded?: () => void;
  /** Settled once a model is served, or the first cycle ends without one: what a request about the targets waits for until then. */
  private readonly ready = new Promise<void>(resolve => (this.loaded = resolve));
  private readonly changes = new Map<string, number>();
  private announcement?: NodeJS.Timeout;
  /** The targets whose description failed, by identifier. */
  private readonly failed = new Set<string>();
  /** How many describing tasks have been started, which names the next. */
  private tasks = 0;
  /** The documents each target's last published diagnostics lie in, by target identifier. */
  private readonly published = new Map<string, Set<string>>();
  /** The build and test operations of the model served, and the log their failures are reported to. */
  private operations?: IServedOperations;
  private log?: Log;
  /** Each target served's name, by identifier. */
  private names = new Map<string, string>();
  /** The describing task of a pass not yet finished. */
  private pass?: { id: string };
  /** What serves the current model's descriptions: reseated by each `serve`, which detaches a superseded model's. */
  private readonly serving = new ComputableHandle<void>();

  /** Serve BSP over `connection`, for the project at `sourceRoot`, calling `end` when the client asks the server to exit. */
  constructor(
    private readonly sourceRoot: string,
    private readonly connection: JsonRpcConnection,
    private readonly end: () => void
  ) {
    connection.serve("bsp", (method, params) => this.request(method, params));
  }

  /**
   * Serve the targets `describing` describes (see `describeOperation`), each as
   * its description settles and again whenever it changes, the pass as a BSP
   * task, and a failure as diagnostics, reported to `log`. A target it does not
   * describe is withdrawn; one whose description fails keeps what it last
   * served. A later call supersedes this one.
   */
  public serve(describing: IDescribing, log: Log, operations: IServedOperations): void {
    this.operations = operations;
    this.log = log;
    this.names = new Map(describing.targets.map(target => [served(target), target.name]));
    const identifiers = new Set(describing.targets.map(served));
    for (const uri of [...this.served.keys()].filter(uri => !identifiers.has(uri))) {
      this.offer(uri, undefined);
    }
    for (const uri of [...this.failed].filter(uri => !identifiers.has(uri))) {
      this.failed.delete(uri);
    }
    for (const uri of [...this.published.keys()].filter(uri => !identifiers.has(uri))) {
      this.publish(uri, []);
    }
    this.loaded?.();
    /* A pass started before this one and not ended is superseded. */
    if (this.pass !== undefined) {
      this.connection.notify("build/taskFinish", {
        taskId: this.pass,
        eventTime: Date.now(),
        status: TASK_CANCELLED,
        message: "Superseded",
        dataKind: DESCRIBE_TASK_DATA_KIND,
        data: { failed: [] },
      });
    }
    const task = this.startTask();
    this.pass = task;
    /* The targets settled so far, and those with nothing to describe, which the total leaves out. */
    const reached = new Set<string>();
    const nothing = new Set<string>();
    const progress = (): void =>
      this.connection.notify("build/taskProgress", {
        taskId: task,
        eventTime: Date.now(),
        progress: reached.size - nothing.size,
        total: identifiers.size - nothing.size,
        unit: "targets",
      });
    const reach = (uri: string, described: boolean): void => {
      if (this.pass === task && !reached.has(uri)) {
        reached.add(uri);
        if (!described) {
          nothing.add(uri);
        }
        progress();
      }
    };
    progress();
    const offered = describing.targets.map(target => {
      const uri = served(target);
      return target.described.then(
        pooled => {
          this.offer(uri, pooled === undefined ? undefined : this.toServed(target.name, target.operation, pooled.directory, pooled.description));
          this.publish(uri, []);
          this.settleFailure(uri, false);
          reach(uri, pooled !== undefined);
        },
        err => {
          this.publish(uri, this.reported(log, toError(err)));
          this.settleFailure(uri, true);
          reach(uri, true);
        }
      );
    });
    /* The pass finishes once every target is served as it settled: after each
     * `offered` tail, never before one, and also where serving one failed. */
    const finish = (): void => {
      if (this.pass === task) {
        this.pass = undefined;
        this.finishTask(task);
      }
    };
    this.serving.seat(Computable.forAll(offered, finish, finish));
  }

  /** Record whether the target `uri` failed, reporting a change once no pass is under way as a describing task of its own. */
  private settleFailure(uri: string, failed: boolean): void {
    const changed = failed !== this.failed.has(uri);
    if (failed) {
      this.failed.add(uri);
    } else {
      this.failed.delete(uri);
    }
    if (changed && this.pass === undefined) {
      this.finishTask(this.startTask());
    }
  }

  /**
   * Report `err` to `log`, and return what it reported with a position, as
   * diagnostics by the document each lies in.
   */
  private reported(log: Log, err: Error): Map<string, IProtocolDiagnostic[]> {
    const diagnostics = new Map<string, IProtocolDiagnostic[]>();
    reportFailure(collectingLog(this.sourceRoot, log, diagnostics), err);
    return diagnostics;
  }

  /**
   * Publish `diagnostics` as the target `uri`'s, by document, replacing what it
   * published before: a document it reports nothing in now is cleared.
   */
  private publish(uri: string, diagnostics: Map<string, IProtocolDiagnostic[]> | []): void {
    const current = diagnostics instanceof Map ? diagnostics : new Map<string, IProtocolDiagnostic[]>();
    const before = this.published.get(uri) ?? new Set<string>();
    for (const document of new Set([...before, ...current.keys()])) {
      this.connection.notify("build/publishDiagnostics", {
        textDocument: { uri: document },
        buildTarget: { uri },
        diagnostics: current.get(document) ?? [],
        reset: true,
      });
    }
    if (current.size === 0) {
      this.published.delete(uri);
    } else {
      this.published.set(uri, new Set(current.keys()));
    }
  }

  /**
   * Build or test the targets a `buildTarget/compile` or `buildTarget/test`
   * request names, as one task: a build's failure published as diagnostics, as
   * a description's is; each test's outcome reported as a `test-start` and
   * `test-finish` beneath the task, then each target's `test-report`.
   *
   * @return the request's result: its `originId`, and whether every target succeeded.
   */
  private async perform(operation: "build" | "test", { targets, originId }: { targets: string[]; originId?: string }): Promise<unknown> {
    const operations = this.operations;
    const log = this.log;
    if (operations === undefined || log === undefined) {
      return { originId, statusCode: TASK_ERROR };
    }
    this.tasks += 1;
    const task = { id: `${operation}-${this.tasks}` };
    const named = targets.map(uri => ({ uri, name: this.names.get(uri) }));
    this.connection.notify("build/taskStart", {
      taskId: task,
      originId,
      eventTime: Date.now(),
      message: `${operation === "build" ? "Building" : "Testing"} ${named.map(({ uri, name }) => name ?? uri).join(", ")}`,
    });
    const outcomes = await Promise.all(
      named.map(({ uri, name }) =>
        name === undefined
          ? Promise.resolve({ uri, error: new Error(`${uri} is not served`) as Error | undefined, report: undefined as ITestReport | undefined })
          : settled(operations[operation](name)).then(
              results => (operation === "test" ? settled(getTestReport(results.flat())) : Promise.resolve(undefined)).then(report => ({ uri, error: undefined, report })),
              (err: unknown) => ({ uri, error: toError(err) as Error | undefined, report: undefined as ITestReport | undefined })
            )
      )
    );
    let tests = 0;
    for (const { uri, error, report } of outcomes) {
      if (error !== undefined) {
        this.publish(uri, this.reported(log, error));
      } else {
        this.publish(uri, []);
      }
      if (operation === "test" && report !== undefined) {
        for (const test of report.results.tests) {
          tests += 1;
          const testTask = { id: `${task.id}/${tests}`, parents: [task.id] };
          const location = test.filePath === undefined ? undefined : { uri: this.fileUri(`./${test.filePath}`), range: ZERO_RANGE };
          const identity = { displayName: test.name, ...(location === undefined ? {} : { location }) };
          this.connection.notify("build/taskStart", { taskId: testTask, originId, eventTime: Date.now(), dataKind: "test-start", data: identity });
          this.connection.notify("build/taskFinish", {
            taskId: testTask,
            originId,
            eventTime: Date.now(),
            status: test.status === "failed" ? TASK_ERROR : TASK_OK,
            dataKind: "test-finish",
            data: {
              ...identity,
              status: TEST_STATUSES[test.status],
              ...(test.message === undefined ? {} : { message: test.trace === undefined ? test.message : `${test.message}\n${test.trace}` }),
            },
          });
        }
        const { summary } = report.results;
        this.connection.notify("build/taskFinish", {
          taskId: { id: `${task.id}/${uri}`, parents: [task.id] },
          originId,
          eventTime: Date.now(),
          status: summary.failed > 0 ? TASK_ERROR : TASK_OK,
          dataKind: "test-report",
          data: {
            originId,
            target: { uri },
            passed: summary.passed,
            failed: summary.failed,
            ignored: summary.pending + summary.other,
            cancelled: 0,
            skipped: summary.skipped,
            time: summary.stop - summary.start,
          },
        });
      }
    }
    const statusCode = outcomes.every(({ error, report }) => error === undefined && !(report !== undefined && report.results.summary.failed > 0))
      ? TASK_OK
      : TASK_ERROR;
    this.connection.notify("build/taskFinish", { taskId: task, originId, eventTime: Date.now(), status: statusCode });
    return { originId, statusCode };
  }

  /** Answer the requests waiting for a model once one of `execution`'s cycles has ended, whether or not it served one. */
  public attach(execution: ExecutionContext): void {
    execution.onBuildEvent(event => {
      if (event.kind === "cycle-end") {
        this.loaded?.();
      }
    });
  }

  /** @return true if the target `uri` names is served, otherwise false. */
  public isServed(uri: string): boolean {
    return this.served.has(uri);
  }

  /** Start a describing task, and return its identifier. */
  private startTask(): { id: string } {
    this.tasks += 1;
    const task = { id: `describe-${this.tasks}` };
    this.connection.notify("build/taskStart", { taskId: task, eventTime: Date.now(), message: "Describing targets", dataKind: DESCRIBE_TASK_DATA_KIND, data: {} });
    return task;
  }

  /** Finish `task`, once every change it made is announced, naming the targets that failed. */
  private finishTask(task: { id: string }): void {
    this.flushAnnouncement();
    const failed = [...this.failed].sort();
    this.connection.notify("build/taskFinish", {
      taskId: task,
      eventTime: Date.now(),
      status: failed.length === 0 ? TASK_OK : TASK_ERROR,
      message: failed.length === 0 ? "Described the targets" : `Could not describe ${failed.length} ${failed.length === 1 ? "target" : "targets"}`,
      dataKind: DESCRIBE_TASK_DATA_KIND,
      data: { failed },
    });
  }

  /** Make `description`, target `name`'s under `operation`, whose tree lies at `directory`, as served: its paths absolute. */
  private toServed(name: string, operation: string, directory: string, description: IDescription): IServedTarget {
    const uri = (written: string): string =>
      written.startsWith("./") ? this.fileUri(written) : URI_SCHEME.test(written) ? written : fileUri(directory, written);
    return {
      target: {
        ...description.target,
        id: { uri: served({ name, operation }) },
        displayName: operation === BUILD ? name : `${name} (${operation})`,
        ...(description.target.baseDirectory === undefined ? {} : { baseDirectory: uri(description.target.baseDirectory) }),
        fabr: { description: directory, operation },
      },
      sources: description.sources.map(source => ({ ...source, uri: uri(source.uri) })),
      roots: (description.roots ?? []).map(uri),
      ...(description.javacOptions === undefined
        ? {}
        : {
            javacOptions: {
              options: description.javacOptions.options,
              classpath: description.javacOptions.classpath.map(uri),
              classDirectory: uri(description.javacOptions.classDirectory),
            },
          }),
    };
  }

  /** Serve `target` as `uri`, or where it is undefined serve nothing there, announcing the change. */
  private offer(uri: string, target: IServedTarget | undefined): void {
    const before = this.served.get(uri);
    if (target === undefined) {
      if (before !== undefined) {
        this.served.delete(uri);
        this.announce(uri, DELETED);
      }
      return;
    }
    if (before === undefined || JSON.stringify(before) !== JSON.stringify(target)) {
      this.served.set(uri, target);
      this.announce(uri, before === undefined ? CREATED : CHANGED);
    }
  }

  /** Announce that the target `uri` was `kind`, with the changes settling close behind it. */
  private announce(uri: string, kind: number): void {
    const earlier = this.changes.get(uri);
    /* Created and then changed is still created; deleted and served again, changed. */
    this.changes.set(uri, earlier === CREATED && kind === CHANGED ? CREATED : earlier === DELETED && kind === CREATED ? CHANGED : kind);
    this.announcement ??= setTimeout(() => this.flushAnnouncement(), ANNOUNCE_DELAY_MS);
  }

  /** Announce the changes held, if any. */
  private flushAnnouncement(): void {
    if (this.announcement !== undefined) {
      clearTimeout(this.announcement);
      this.announcement = undefined;
    }
    if (this.changes.size === 0) {
      return;
    }
    const changes = [...this.changes].map(([changed, changeKind]) => ({ target: { uri: changed }, kind: changeKind }));
    this.changes.clear();
    this.connection.notify("buildTarget/didChange", { changes });
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "build/initialize":
        return {
          displayName: "fabr",
          version: getVersion(),
          bspVersion: BSP_VERSION,
          capabilities: {
            buildTargetChangedProvider: true,
            inverseSourcesProvider: true,
            dependencySourcesProvider: true,
            compileProvider: { languageIds: LANGUAGE_IDS },
            testProvider: { languageIds: LANGUAGE_IDS },
          },
          /* The project's root, and the fabr installation serving it, which a
           * payload's modules resolve from. */
          data: { root: this.fileUri("./"), installation: installationDirectory() ?? __dirname },
        };
      case "build/initialized":
      case "workspace/reload":
        return null;
      case "build/shutdown":
        return null;
      case "build/exit":
        this.end();
        return null;
      case "workspace/buildTargets":
        await this.ready;
        return { targets: [...this.served.values()].map(served => served.target) };
      case "buildTarget/sources":
        await this.ready;
        return {
          items: toTargetsParams(params).targets.map(uri => ({ target: { uri }, sources: this.byUri(uri)?.sources ?? [], roots: this.byUri(uri)?.roots ?? [] })),
        };
      case "buildTarget/javacOptions":
        await this.ready;
        return {
          items: toTargetsParams(params).targets.flatMap(uri => {
            const options = this.byUri(uri)?.javacOptions;
            return options === undefined ? [] : [{ target: { uri }, ...options }];
          }),
        };
      case "buildTarget/inverseSources": {
        await this.ready;
        const file = toDocumentParams(params).uri;
        return {
          targets: [...this.served.values()].filter(served => served.sources.some(source => source.uri === file)).map(served => served.target.id),
        };
      }
      case "buildTarget/compile":
        await this.ready;
        return this.perform("build", toTargetsParams(params));
      case "buildTarget/test":
        await this.ready;
        return this.perform("test", toTargetsParams(params));
      case "buildTarget/dependencySources":
        await this.ready;
        return { items: toTargetsParams(params).targets.map(uri => ({ target: { uri }, sources: [] })) };
      default:
        throw new MethodNotFound(`${method} is not served`);
    }
  }

  private byUri(uri: string): IServedTarget | undefined {
    return this.served.get(uri);
  }

  /** @return `written`, a project path (`./<path>`), as a `file:` URI; a directory keeps its trailing slash. */
  private fileUri(written: string): string {
    return fileUri(this.sourceRoot, written);
  }
}

/** A URI's scheme, as a written path that is already a URI begins. */
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** @return `written`, a path relative to `directory`, as a `file:` URI; a directory keeps its trailing slash. */
function fileUri(directory: string, written: string): string {
  const uri = pathToFileURL(path.join(directory, written)).href;
  return written.endsWith("/") && !uri.endsWith("/") ? `${uri}/` : uri;
}

