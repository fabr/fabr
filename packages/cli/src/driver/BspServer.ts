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
  type IDescribing,
  FabrError,
  type IBuildTarget,
  type IDescription,
  type IJavacOptions,
  type ISourceItem,
  type ISourceSpan,
  type Log,
  LogLevel,
  reportFailure,
  targetIdentifier,
  toError,
} from "@fabr-build/core";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { getVersion } from "./Command";

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
function served({ name, operation }: { name: string; operation: string }): string {
  return operation === BUILD ? targetIdentifier(name).uri : `${targetIdentifier(name).uri}?operation=${operation}`;
}

/** BSP's `BuildTargetEventKind`. */
const CREATED = 1;
const CHANGED = 2;
const DELETED = 3;

/** JSON-RPC's error codes this server answers with. */
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

/** A JSON-RPC connection over a pair of streams, framed as LSP frames it. */
export class JsonRpcConnection {
  private buffer = Buffer.alloc(0);
  /** The notifications sent before the client's `build/initialize` was answered, which are sent once it is. */
  private held: unknown[] | undefined = [];

  constructor(
    private readonly output: NodeJS.WritableStream,
    private readonly handle: (method: string, params: unknown) => unknown
  ) {}

  /** Read messages from `input` until it ends, then call `onEnd`. */
  public listen(input: NodeJS.ReadableStream, onEnd: () => void): void {
    input.on("data", (data: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      for (let message = this.next(); message !== undefined; message = this.next()) {
        this.dispatch(message);
      }
    });
    input.on("end", onEnd);
  }

  /** Send the notification `method`: once the client has been answered its `build/initialize`, and until then held. */
  public notify(method: string, params: unknown): void {
    if (this.held !== undefined) {
      this.held.push({ jsonrpc: "2.0", method, params });
    } else {
      this.send({ jsonrpc: "2.0", method, params });
    }
  }

  private next(): { id?: number | string; method?: string; params?: unknown } | undefined {
    const blank = this.buffer.indexOf("\r\n\r\n");
    if (blank < 0) {
      return undefined;
    }
    const length = /^content-length: *(\d+)$/im.exec(this.buffer.subarray(0, blank).toString("latin1"));
    if (length === null) {
      throw new FabrError("a message with no Content-Length");
    }
    const start = blank + 4;
    const end = start + Number(length[1]);
    if (this.buffer.length < end) {
      return undefined;
    }
    const body = this.buffer.subarray(start, end).toString("utf8");
    this.buffer = this.buffer.subarray(end);
    return JSON.parse(body);
  }

  private dispatch(message: { id?: number | string; method?: string; params?: unknown }): void {
    if (message.method === undefined) {
      return;
    }
    const isRequest = message.id !== undefined;
    Promise.resolve()
      .then(() => this.handle(message.method!, message.params))
      .then(
        result => {
          if (isRequest) {
            this.send({ jsonrpc: "2.0", id: message.id, result: result ?? null });
          }
          if (message.method === INITIALIZE && this.held !== undefined) {
            const held = this.held;
            this.held = undefined;
            held.forEach(notification => this.send(notification));
          }
        },
        (err: unknown) => {
          const error = toError(err);
          const code = error instanceof MethodNotFound ? METHOD_NOT_FOUND : INTERNAL_ERROR;
          if (isRequest) {
            this.send({ jsonrpc: "2.0", id: message.id, error: { code, message: error.message } });
          }
        }
      );
  }

  private send(message: unknown): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.output.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.output.write(body);
  }
}

class MethodNotFound extends FabrError {}

/** The request a client opens a connection with, before whose answer the server sends nothing. */
const INITIALIZE = "build/initialize";

/** How long announcements are held for others settling close behind them, in milliseconds. */
const ANNOUNCE_DELAY_MS = 100;

/** BSP's `DiagnosticSeverity`s. */
const DIAGNOSTIC_ERROR = 1;
const DIAGNOSTIC_WARNING = 2;

/** A BSP (and LSP) diagnostic. */
interface IBspDiagnostic {
  range: IBspRange;
  severity: number;
  source: string;
  message: string;
  relatedInformation?: Array<{ location: { uri: string; range: IBspRange }; message: string }>;
}

/** A BSP range: zero-based lines and characters. */
interface IBspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

/** @return the range `loc` covers, or undefined where its offset lies outside its text. */
function rangeOf(loc: ISourceSpan): IBspRange | undefined {
  const start = loc.reader.resolvePosition(loc.offset);
  if (start === undefined) {
    return undefined;
  }
  const end = loc.reader.resolvePosition(loc.endOffset) ?? start;
  return {
    start: { line: start.line - 1, character: start.column - 1 },
    end: { line: end.line - 1, character: end.column - 1 },
  };
}

/** BSP's `StatusCode`s, as a task finishes. */
const TASK_OK = 1;
const TASK_ERROR = 2;
const TASK_CANCELLED = 3;

/** The `dataKind` of a describing task's finish, whose `data` names the targets that could not be described. */
export const DESCRIBE_TASK_DATA_KIND = "fabr-describe";

/**
 * The server: the targets described so far, and the connection they are
 * served over. It belongs to the run, not to a model, so a reloaded model's
 * descriptions replace the last one's.
 */
export class BspServer {
  private readonly served = new Map<string, IServedTarget>();
  private loaded?: () => void;
  private readonly ready = new Promise<void>(resolve => (this.loaded = resolve));
  private readonly connection: JsonRpcConnection;
  private readonly changes = new Map<string, number>();
  private announcement?: NodeJS.Timeout;
  /** The targets whose description failed, by identifier. */
  private readonly failed = new Set<string>();
  /** How many describing tasks have been started, which names the next. */
  private tasks = 0;
  /** The documents each target's last published diagnostics lie in, by target identifier. */
  private readonly published = new Map<string, Set<string>>();
  /** The describing task of a pass not yet finished. */
  private pass?: { id: string };
  /** What ends the run. */
  private end: () => void = () => process.exit(0);

  constructor(
    private readonly sourceRoot: string,
    output: NodeJS.WritableStream = process.stdout
  ) {
    this.connection = new JsonRpcConnection(output, (method, params) => this.request(method, params));
  }

  /** Serve the requests read from `input`, calling `end` when it ends or the client asks the server to exit. */
  public listen(end: () => void, input: NodeJS.ReadableStream = process.stdin): void {
    this.end = end;
    this.connection.listen(input, end);
  }

  /**
   * Serve the targets `describing` describes (see `describeOperation`), each as
   * its description settles and again whenever it changes, the pass as a BSP
   * task, and a failure as diagnostics, reported to `log`. A target it does not
   * describe is withdrawn; one whose description fails keeps what it last
   * served. A later call supersedes this one.
   */
  public serve(describing: IDescribing, log: Log): void {
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
      this.connection.notify("build/taskFinish", { taskId: this.pass, eventTime: Date.now(), status: TASK_CANCELLED, message: "Superseded" });
    }
    const task = this.startTask();
    this.pass = task;
    /* The targets settled so far, and those with nothing to describe, which leave the total. */
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
    for (const target of describing.targets) {
      const uri = served(target);
      target.described.then(
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
    }
    describing.settled.then(() => {
      if (this.pass === task) {
        this.pass = undefined;
        this.finishTask(task);
      }
    });
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
   * BSP diagnostics by the document each lies in.
   */
  private reported(log: Log, err: Error): Map<string, IBspDiagnostic[]> {
    const diagnostics = new Map<string, IBspDiagnostic[]>();
    const collecting: Log = {
      log: (diagnostic, params) => {
        log.log(diagnostic, params);
        const range = params.loc === undefined ? undefined : rangeOf(params.loc);
        if (range === undefined || diagnostic.level < LogLevel.Warn) {
          return;
        }
        const document = this.documentOf(params.loc!);
        const related = (params.notes ?? []).flatMap(note => {
          const at = note.loc === undefined ? undefined : rangeOf(note.loc);
          return at === undefined ? [] : [{ location: { uri: this.documentOf(note.loc!), range: at }, message: note.message }];
        });
        diagnostics.set(document, [
          ...(diagnostics.get(document) ?? []),
          {
            range,
            severity: diagnostic.level === LogLevel.Error ? DIAGNOSTIC_ERROR : DIAGNOSTIC_WARNING,
            source: "fabr",
            message: [diagnostic.message(params), ...(params.help ?? []).map(help => `help: ${help}`)].join("\n"),
            ...(related.length === 0 ? {} : { relatedInformation: related }),
          },
        ]);
      },
    };
    reportFailure(collecting, err);
    return diagnostics;
  }

  /** @return the URI of the document `loc` lies in. */
  private documentOf(loc: ISourceSpan): string {
    return pathToFileURL(path.resolve(this.sourceRoot, loc.file)).toString();
  }

  /**
   * Publish `diagnostics` as the target `uri`'s, by document, replacing what it
   * published before: a document it reports nothing in now is cleared.
   */
  private publish(uri: string, diagnostics: Map<string, IBspDiagnostic[]> | []): void {
    const current = diagnostics instanceof Map ? diagnostics : new Map<string, IBspDiagnostic[]>();
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

  /** Start a describing task, and return its identifier. */
  private startTask(): { id: string } {
    this.tasks += 1;
    const task = { id: `describe-${this.tasks}` };
    this.connection.notify("build/taskStart", { taskId: task, eventTime: Date.now(), message: "Describing targets" });
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
    const targetsOf = (value: unknown): string[] =>
      ((value as { targets?: Array<{ uri: string }> } | undefined)?.targets ?? []).map(target => target.uri);
    switch (method) {
      case "build/initialize":
        return {
          displayName: "fabr",
          version: getVersion(),
          bspVersion: BSP_VERSION,
          capabilities: { buildTargetChangedProvider: true, inverseSourcesProvider: true, dependencySourcesProvider: true },
          /* The project's root, and the fabr installation serving it, which a
           * payload's modules resolve from. */
          data: { root: this.fileUri("./"), installation: installationDirectory() },
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
          items: targetsOf(params).map(uri => ({ target: { uri }, sources: this.byUri(uri)?.sources ?? [], roots: this.byUri(uri)?.roots ?? [] })),
        };
      case "buildTarget/javacOptions":
        await this.ready;
        return {
          items: targetsOf(params).flatMap(uri => {
            const options = this.byUri(uri)?.javacOptions;
            return options === undefined ? [] : [{ target: { uri }, ...options }];
          }),
        };
      case "buildTarget/inverseSources": {
        await this.ready;
        const file = (params as { textDocument?: { uri?: string } } | undefined)?.textDocument?.uri;
        return {
          targets: [...this.served.values()].filter(served => served.sources.some(source => source.uri === file)).map(served => served.target.id),
        };
      }
      case "buildTarget/dependencySources":
        await this.ready;
        return { items: targetsOf(params).map(uri => ({ target: { uri }, sources: [] })) };
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

/** @return the directory of the fabr installation this server runs from: the CLI package's own. */
function installationDirectory(): string {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    if (path.dirname(dir) === dir) {
      return __dirname;
    }
  }
}
