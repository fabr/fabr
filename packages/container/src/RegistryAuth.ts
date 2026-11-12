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

import * as os from "node:os";
import * as path from "node:path";
import {
  Computable,
  executeInternalCapture,
  ExecutionContext,
  FabrError,
  findExecutable,
  hostEnvironment,
  isJsonObject,
  parseJson,
  PluginKey,
  Semaphore,
} from "@fabr-build/core";

/** A registry's credential, as an auth file holds one. */
export interface IRegistryCredential {
  readonly username: string;
  readonly password: string;
}

/**
 * @return the auth files credentials are read from, in podman's order
 * (containers-auth.json(5)), then Docker's.
 */
function authFilePaths(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const home = os.homedir();
  return [
    ...(platform === "linux" && env.XDG_RUNTIME_DIR ? [path.join(env.XDG_RUNTIME_DIR, "containers", "auth.json")] : []),
    ...(platform === "darwin" ? [path.join(home, ".config", "containers", "auth.json")] : []),
    path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "containers", "auth.json"),
    path.join(home, ".docker", "config.json"),
  ].filter((file, index, all) => all.indexOf(file) === index);
}

/** What an auth file holds: credentials by registry host, the helper that holds a host's, and the helper that holds the rest. */
interface IAuthFile {
  /** Each registry host's credential, by host (an entry filed under `https://index.docker.io/v1/` is `index.docker.io`'s). */
  readonly credentials: ReadonlyMap<string, IRegistryCredential>;
  /** The helper holding each host's credential (`credHelpers`). */
  readonly helpers: ReadonlyMap<string, string>;
  /** The helper holding every other registry's credential (`credsStore`). */
  readonly store?: string;
}

/**
 * Read an auth file: `auths` keyed by a host, or by a URL or `host/path`
 * (Docker's `https://index.docker.io/v1/`), each with its base64
 * `user:password`; `credHelpers` by host; `credsStore`.
 */
export function parseAuthFile(text: string, what: string): IAuthFile {
  const doc = parseJson(text, what, json => (isJsonObject(json) ? json : {}));
  const credentials = new Map<string, IRegistryCredential>();
  const helpers = new Map<string, string>();
  if (isJsonObject(doc.credHelpers)) {
    for (const [key, helper] of Object.entries(doc.credHelpers)) {
      if (typeof helper === "string") {
        helpers.set(hostOf(key), helper);
      }
    }
  }
  if (isJsonObject(doc.auths)) {
    for (const [key, value] of Object.entries(doc.auths)) {
      const auth = isJsonObject(value) && typeof value.auth === "string" ? value.auth : undefined;
      const decoded = auth === undefined ? "" : Buffer.from(auth, "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      if (colon !== -1) {
        credentials.set(hostOf(key), { username: decoded.substring(0, colon), password: decoded.substring(colon + 1) });
      }
    }
  }
  return { credentials, helpers, ...(typeof doc.credsStore === "string" ? { store: doc.credsStore } : {}) };
}

/** @return the host an auth file's key names: `https://index.docker.io/v1/` is `index.docker.io`. */
function hostOf(key: string): string {
  return key.replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "");
}

/**
 * The registry credentials of a run: read from the auth files (the first that
 * names a registry), or asked of the credential helper holding them, Docker's
 * `docker-credential-<name>` on `PATH`, each once a run.
 */
export class RegistryAuth {
  private readonly asked = new Map<string, Computable<IRegistryCredential | undefined>>();

  constructor(
    private readonly files: readonly IAuthFile[],
    private readonly limit: Semaphore
  ) {}

  /** Load the user's auth files, where there are any. */
  public static load(execution: ExecutionContext): Computable<RegistryAuth> {
    const paths = authFilePaths();
    return Computable.forAll(
      paths.map(file => execution.absFileSource.get(file).then(found => found?.readString())),
      (...texts: Array<string | undefined>) =>
        new RegistryAuth(
          texts.flatMap((text, index) => (text === undefined ? [] : [parseAuthFile(text, paths[index])])),
          execution.processLimit
        )
    );
  }

  /**
   * Get the credential for the registry `server` names, as `docker login`
   * filed it (a host, or Docker Hub's `https://index.docker.io/v1/`):
   * written in the first auth file naming its host, else asked of that
   * file's helper for it, else of a `credsStore`; undefined where none holds one.
   */
  public credentialFor(server: string): Computable<IRegistryCredential | undefined> {
    let found = this.asked.get(server);
    if (found === undefined) {
      const host = hostOf(server);
      const file = this.files.find(each => each.credentials.has(host) || each.helpers.has(host));
      const store = this.files.find(each => each.store !== undefined)?.store;
      found =
        file?.credentials.get(host) !== undefined
          ? Computable.resolve(file.credentials.get(host))
          : file !== undefined
            ? askHelper(this.limit, file.helpers.get(host)!, server)
            : store !== undefined
              ? askHelper(this.limit, store, server)
              : Computable.resolve(undefined);
      this.asked.set(server, found);
    }
    return found;
  }
}

/**
 * Ask the credential helper `helper` (`docker-credential-<helper>`, Docker's
 * protocol) for `server`'s credential: `get` with the server on stdin answers
 * `{ "Username", "Secret" }`. A helper that holds none says so and exits non-zero.
 * It runs with fabr's own environment, as `docker` runs it: it may need `HOME`
 * or a cloud login's settings.
 */
function askHelper(limit: Semaphore, helper: string, server: string): Computable<IRegistryCredential | undefined> {
  const program = `docker-credential-${helper}`;
  let found: string;
  try {
    found = findExecutable(program);
  } catch {
    return Computable.reject(
      new FabrError(`the credential for ${server} is held by '${program}', which is not on PATH`).withHelp(
        `install it, or put its directory on PATH`
      )
    );
  }
  return executeInternalCapture(limit, found, ["get"], server, hostEnvironment()).then(({ status, stdout, stderr }) => {
    if (status !== 0) {
      if (/credentials not found/i.test(stdout + stderr)) {
        return undefined;
      }
      throw new FabrError(`'${program} get' failed for ${server}: ${(stderr || stdout).trim()}`);
    }
    return parseJson(stdout, `the answer of '${program}'`, json => {
      const answer = isJsonObject(json) ? json : {};
      if (typeof answer.Username !== "string" || typeof answer.Secret !== "string") {
        throw new FabrError("it holds no 'Username' and 'Secret'");
      }
      return { username: answer.Username, password: answer.Secret };
    });
  });
}

/** The container plugin's per-run state, held on the ExecutionContext and shared by every repository of the run. */
class ContainerPluginContext {
  private authMemo?: Computable<RegistryAuth>;

  constructor(private readonly execution: ExecutionContext) {}

  /** Get the run's registry credentials, reading the auth files once per run. */
  public registryAuth(): Computable<RegistryAuth> {
    return (this.authMemo ??= RegistryAuth.load(this.execution));
  }
}

const CONTAINER_PLUGIN_KEY = new PluginKey<ContainerPluginContext>("@fabr-build/container");

/** Get the run's shared container plugin context, creating it on first access. */
export function containerPluginContext(execution: ExecutionContext): ContainerPluginContext {
  return execution.getOrCreatePluginContext(CONTAINER_PLUGIN_KEY, () => new ContainerPluginContext(execution));
}
