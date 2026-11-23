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
 * The fabr socket: the channel from a process fabr starts as a build step back
 * to this fabr, one per fabr process, on a Unix-domain socket or a named pipe
 * on Windows. Each connection is a {@link JsonRpcConnection} whose default
 * protocol is `fabr`, the socket's own. Each build-step process is registered
 * as it starts ({@link registerProcess}) and finds the socket and its token in
 * its environment as `FABR_SOCKET=<path>#<token>`; a connection opens with
 * `fabr/initialize`, whose token names the process the connection is for.
 *
 * Process slots are its first methods: a process fabr starts owns one slot of
 * fabr's process limit, and `slots/acquire` asks for further ones (`count`,
 * one by default, taken together), answered when they are granted.
 * `slots/release` ends a request, giving back its slots or withdrawing it
 * while it waits, and closing the connection gives back every slot it holds
 * and withdraws every request not yet answered. The first request of a
 * process's connections is lent the slot the process owns, and that slot,
 * given back, goes to the oldest request waiting. docs'
 * reference/fabr-socket.md is the protocol as clients see it.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { Computable } from "../core/Computable";
import {
  IConnectionLimits,
  IMessageContext,
  InvalidParams,
  InvalidRequest,
  JsonRpcConnection,
  MethodNotFound,
  RequestCancelled,
  ServerNotInitialized,
} from "./JsonRpc";

/** The variable naming the socket and the process's token to a build-step process, `<path>#<token>`. */
export const FABR_SOCKET_VARIABLE = "FABR_SOCKET";

/** The version of the protocol this server speaks, given in the answer to `fabr/initialize`. */
const PROTOCOL_VERSION = 1;

/** The longest socket path every platform accepts, in bytes (macOS's `sun_path` is 104). */
const MAX_SOCKET_PATH = 100;

/** The largest header part and message body a connection reads; a frame over either closes it. */
const LIMITS: IConnectionLimits = { maxHeaderBytes: 8192, maxBodyBytes: 1 << 20 };

/** The prefix of the directory each fabr process makes for its socket, followed by its pid. */
const SOCKET_DIR_PREFIX = "fabr-socket-";

/** A request's id: JSON-RPC allows a string or a number. */
type RequestId = string | number;

/** A registered build-step process: the slot it owns, and how it takes further slots of the limit. */
interface IProcess {
  /** Take `count` slots of the limit for `work`, withdrawn from the queue if `signal` aborts before it starts. */
  readonly admit: (work: () => Computable<void>, count: number, signal: AbortSignal) => Computable<void>;
  /** Whether the process's own slot is free to lend. */
  ownFree: boolean;
  /** Its requests not yet granted, oldest first. */
  readonly waiting: ISlotRequest[];
  readonly connections: Set<Connection>;
}

/** One `slots/acquire`. */
interface ISlotRequest {
  readonly connection: Connection;
  readonly id: RequestId;
  /** Answer the request, once granted. */
  readonly answer: (result: unknown) => void;
  /** Answer the request with an error, once withdrawn. */
  readonly refuse: (error: Error) => void;
  /** Which slot it holds, once granted: the process's own, or one of the limit's, given back by `release`. */
  slot?: "own" | "limit";
  /** Give back the limit's slots, once granted them. */
  release?: () => void;
  /** Withdraw its wait for the limit's slots, while it waits. */
  readonly waitForLimit: AbortController;
  /** Whether it has been withdrawn before it was granted. */
  withdrawn: boolean;
}

/** A process registered with the socket, as its step holds it. */
export interface IRegisteredProcess {
  /** The variables to add to the process's environment. */
  readonly env: Readonly<Record<string, string>>;
  /** Unregister it, as it exits: close its connections and give back every slot they hold. */
  unregister(): void;
}

/** The socket's server: its path and the registered processes, by token. */
interface IServer {
  readonly path: string;
  readonly processes: Map<string, IProcess>;
}

let started: Computable<IServer | undefined> | undefined;

/**
 * Register a build-step process about to start, whose further slots are
 * taken through `admit` (the step's funnel), `count` at a time as each
 * request asks. Where the socket cannot be opened, the process gets no
 * variable and takes no slots.
 */
export function registerProcess(
  admit: (work: () => Computable<void>, count: number, signal: AbortSignal) => Computable<void>
): Computable<IRegisteredProcess> {
  started ??= startServer();
  return started.then((server): IRegisteredProcess => {
    if (server === undefined) {
      return { env: {}, unregister: () => undefined };
    }
    const token = crypto.randomBytes(16).toString("hex");
    const registered: IProcess = { admit, ownFree: true, waiting: [], connections: new Set() };
    server.processes.set(token, registered);
    return {
      env: { [FABR_SOCKET_VARIABLE]: `${server.path}#${token}` },
      unregister: () => {
        server.processes.delete(token);
        for (const connection of [...registered.connections]) {
          connection.close();
        }
      },
    };
  });
}

/**
 * Make the directory the socket listens in, removing first those of this
 * user's fabr processes that have died.
 * @return where the socket listens: a named pipe on Windows, else a socket in
 *   a new directory of this process's own, which only this user can open, in
 *   the system's temporary directory, or in `/tmp` where that would make the
 *   path too long. The directory is removed as this process exits.
 */
function socketPath(): string {
  const name = "fabr.sock";
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\fabr-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  }
  /* The directory mkdtemp makes adds six characters. */
  const fits = (base: string): boolean =>
    Buffer.byteLength(path.join(base, `${SOCKET_DIR_PREFIX}${process.pid}-XXXXXX`, name)) <= MAX_SOCKET_PATH;
  const base = fits(os.tmpdir()) ? os.tmpdir() : "/tmp";
  reapDeadSocketDirs(base);
  const dir = fs.mkdtempSync(path.join(base, `${SOCKET_DIR_PREFIX}${process.pid}-`));
  process.once("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, name);
}

/** Remove the socket directories in `base` that this user's fabr processes left when they died. */
function reapDeadSocketDirs(base: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(base);
  } catch {
    return;
  }
  for (const entry of entries) {
    const pid = new RegExp(`^${SOCKET_DIR_PREFIX}(\\d+)-`).exec(entry)?.[1];
    if (pid === undefined || Number(pid) === process.pid || isAlive(Number(pid))) {
      continue;
    }
    const dir = path.join(base, entry);
    try {
      const stat = fs.lstatSync(dir);
      if (stat.isDirectory() && stat.uid === process.getuid?.()) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      /* Another process's to remove, or gone already. */
    }
  }
}

/** @return true if a process `pid` is running, otherwise false. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Start the server; resolve undefined where it cannot listen. An error of the server's once it is listening is ignored; each connection handles its own. */
function startServer(): Computable<IServer | undefined> {
  return Computable.from<IServer | undefined>(resolve => {
    try {
      const socket = socketPath();
      const server: IServer = { path: socket, processes: new Map() };
      const listener = net.createServer(stream => {
        stream.unref();
        new Connection(server, stream);
      });
      let listening = false;
      listener.on("error", () => {
        if (!listening) {
          resolve(undefined);
        }
      });
      listener.listen(socket, () => {
        listening = true;
        listener.unref();
        resolve(server);
      });
    } catch {
      resolve(undefined);
    }
  });
}

/** One client's connection: the JSON-RPC connection it is read through, the process its token named, and the slot requests it made, by id. */
class Connection {
  private registered?: IProcess;
  private readonly requests = new Map<RequestId, ISlotRequest>();
  private closed = false;

  constructor(
    private readonly server: IServer,
    private readonly stream: net.Socket
  ) {
    const rpc = new JsonRpcConnection(stream, "fabr", LIMITS);
    rpc.serve("fabr", (method, params, context) => this.handle(method, params, context));
    rpc.listen(stream, () => this.end());
    stream.on("close", () => this.end());
    stream.on("error", () => this.end());
  }

  /** Close the connection, giving back what it holds. */
  public close(): void {
    this.end();
    this.stream.destroy();
  }

  /** @return the process the connection's token named. */
  public get process(): IProcess {
    return this.registered!;
  }

  /** Answer a message of the fabr protocol. */
  private handle(method: string, params: unknown, { id, signal }: IMessageContext): unknown {
    const fields = (params !== null && typeof params === "object" ? params : {}) as Record<string, unknown>;
    if (method === "fabr/initialize") {
      if (this.registered !== undefined) {
        throw new InvalidRequest("the connection is initialized already");
      }
      const registered = this.server.processes.get(String(fields.token));
      if (registered === undefined) {
        throw new InvalidParams("unknown token: the process it was given to has finished, or it was never fabr's");
      }
      this.registered = registered;
      registered.connections.add(this);
      return { server: { name: "fabr" }, protocol: PROTOCOL_VERSION, capabilities: { slots: {} } };
    }
    if (this.registered === undefined) {
      throw new ServerNotInitialized("send fabr/initialize first");
    }
    if (method === "slots/acquire" && id !== undefined) {
      /* A granted request keeps its id until it is released. */
      if (this.requests.has(id)) {
        throw new InvalidRequest(`request ${JSON.stringify(id)} still holds its slots on this connection`);
      }
      const count = fields.count ?? 1;
      if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
        throw new InvalidParams("a slot request's count is a whole number, 1 or more");
      }
      return this.acquire(this.registered, id, count, signal);
    }
    if (method === "slots/release") {
      /* Done with the request, whichever state it is in: a granted one gives
       * its slots back, a waiting one is withdrawn as a cancel withdraws it. */
      const request = this.requests.get(fields.id as RequestId);
      if (request?.slot !== undefined) {
        this.requests.delete(request.id);
        giveBack(request);
      } else if (request !== undefined) {
        this.cancel(request);
      }
      return undefined;
    }
    throw new MethodNotFound(`fabr serves no method '${method}'`);
  }

  /**
   * Grant `id` the process's own slot where it is free, whatever its `count`,
   * else wait for `count` slots of the limit together. A cancel (`signal`)
   * withdraws it while it waits.
   * @return the request's answer: resolved when it is granted, rejected as cancelled where it is withdrawn.
   */
  private acquire(registered: IProcess, id: RequestId, count: number, signal: AbortSignal): Promise<unknown> {
    return new Promise((answer, refuse) => {
      const request: ISlotRequest = { connection: this, id, answer, refuse, waitForLimit: new AbortController(), withdrawn: false };
      this.requests.set(id, request);
      signal.addEventListener("abort", () => {
        if (request.slot === undefined && !request.withdrawn) {
          this.cancel(request);
        }
      });
      if (registered.ownFree) {
        registered.ownFree = false;
        grant(request, "own");
        return;
      }
      registered.waiting.push(request);
      /* Held until given back; given back at once where the request was
       * granted the process's own slot meanwhile, or withdrawn. */
      void registered
        .admit(
          () =>
            Computable.from<void>(resolve => {
              if (request.withdrawn || request.slot !== undefined) {
                resolve();
                return;
              }
              registered.waiting.splice(registered.waiting.indexOf(request), 1);
              request.release = () => resolve();
              grant(request, "limit");
            }),
          count,
          request.waitForLimit.signal
        )
        /* Withdrawn from the queue: nothing was taken. */
        .catch(() => undefined);
    });
  }

  /** Withdraw a request not yet granted, answering it as cancelled. */
  private cancel(request: ISlotRequest): void {
    this.requests.delete(request.id);
    withdraw(request);
    request.refuse(new RequestCancelled("cancelled"));
  }

  /** Give back every slot this connection holds and withdraw its requests, once. */
  private end(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.registered?.connections.delete(this);
    for (const request of this.requests.values()) {
      if (request.slot === undefined) {
        withdraw(request);
      } else {
        giveBack(request);
      }
    }
    this.requests.clear();
  }
}

/** Grant `request` its slots, answering it. */
function grant(request: ISlotRequest, slot: "own" | "limit"): void {
  request.slot = slot;
  /* Answered with the process's own slot, it no longer waits for the limit's. */
  if (slot === "own") {
    request.waitForLimit.abort();
  }
  request.answer({});
}

/** Withdraw a request not yet granted. */
function withdraw(request: ISlotRequest): void {
  request.withdrawn = true;
  request.waitForLimit.abort();
  const waiting = request.connection.process.waiting;
  const index = waiting.indexOf(request);
  if (index >= 0) {
    waiting.splice(index, 1);
  }
}

/** Give back a granted slot: the process's own to its oldest waiting request, or kept free; one of the limit's to the limit. */
function giveBack(request: ISlotRequest): void {
  if (request.slot === "own") {
    const registered = request.connection.process;
    const next = registered.waiting.shift();
    if (next === undefined) {
      registered.ownFree = true;
    } else {
      grant(next, "own");
    }
  } else {
    request.release?.();
  }
}
