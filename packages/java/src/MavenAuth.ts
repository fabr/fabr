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
 * Credentials for Maven repositories, as Maven itself finds them: the
 * `<servers>` of the user's `~/.m2/settings.xml`, each named by an `<id>`. A
 * `maven_repository` uses the server its `id` names, by default its own name,
 * for every request it makes, reads and uploads alike.
 */

import * as os from "node:os";
import * as path from "node:path";
import { Computable, ExecutionContext, FabrError, PluginKey } from "@fabr-build/core";
import { parseXml, xmlChild, xmlChildren, xmlText, XmlElement } from "./Xml";

/** A server's credentials, as `settings.xml` states them. */
export interface MavenServer {
  readonly username?: string;
  readonly password?: string;
  /** Further headers sent with each request (`<configuration><httpHeaders>`), for a token a server reads from one. */
  readonly headers: ReadonlyMap<string, string>;
}

/** @return the absolute path of the user's `~/.m2/settings.xml`. */
export function userSettingsPath(): string {
  return path.join(os.homedir(), ".m2", "settings.xml");
}

/** Substitute each `${env.NAME}` in `text` with that environment variable, leaving one that is unset as written, as Maven does. */
function interpolated(text: string): string {
  return text.replace(/\$\{env\.([^}]+)\}/g, (written, name: string) => process.env[name] ?? written);
}

/** Read a server's credential field, refusing a password Maven has encrypted with its master password. */
function credential(server: XmlElement, field: string, id: string): string | undefined {
  const text = xmlText(server, field);
  if (text === undefined) {
    return undefined;
  }
  if (/^\{.*\}$/s.test(text.trim())) {
    throw new FabrError(`settings.xml's ${field} for server '${id}' is encrypted with Maven's master password, which fabr cannot read`).withHelp(
      `write it as \${env.NAME}, read from an environment variable`
    );
  }
  return interpolated(text);
}

/** Read the servers a `settings.xml` declares, by id. */
export function parseMavenSettings(text: string, what: string): Map<string, MavenServer> {
  const settings = parseXml(text, what);
  if (settings.name !== "settings") {
    throw new FabrError(`${what} is not Maven settings: its root element is <${settings.name}>`);
  }
  const servers = new Map<string, MavenServer>();
  for (const server of xmlChildren(xmlChild(settings, "servers"), "server")) {
    const id = xmlText(server, "id");
    if (id === undefined) {
      continue;
    }
    const properties = xmlChildren(xmlChild(xmlChild(server, "configuration"), "httpHeaders"), "property");
    const headers = new Map(
      properties.flatMap((property): Array<[string, string]> => {
        const name = xmlText(property, "name");
        const value = xmlText(property, "value");
        return name === undefined || value === undefined ? [] : [[name, interpolated(value)]];
      })
    );
    servers.set(id, { username: credential(server, "username", id), password: credential(server, "password", id), headers });
  }
  return servers;
}

/** The credentials of a run's Maven repositories, read once per run. */
export class MavenAuth {
  constructor(private readonly servers: ReadonlyMap<string, MavenServer>) {}

  /** Load the user's `~/.m2/settings.xml`, where there is one. */
  public static load(execution: ExecutionContext): Computable<MavenAuth> {
    const settings = userSettingsPath();
    return execution.absFileSource
      .get(settings)
      .then(file => file?.readString())
      .then(text => new MavenAuth(text === undefined ? new Map() : parseMavenSettings(text, settings)));
  }

  /**
   * Get the headers a request is sent with that uses the server `id`: basic
   * authentication with its username and password, and any headers its
   * configuration adds; none where `settings.xml` has no server of that id.
   */
  public headersFor(id: string): Record<string, string> {
    const server = this.servers.get(id);
    if (server === undefined) {
      return {};
    }
    const headers = new Map(server.headers);
    if (server.username !== undefined || server.password !== undefined) {
      headers.set("authorization", `Basic ${Buffer.from(`${server.username ?? ""}:${server.password ?? ""}`).toString("base64")}`);
    }
    return Object.fromEntries(headers);
  }
}

/** The Java plugin's per-run state, held on the ExecutionContext and shared by every MavenRepository instance of the run. */
export class JavaPluginContext {
  private mavenAuthMemo?: Computable<MavenAuth>;

  constructor(private readonly execution: ExecutionContext) {}

  /** Get the run's Maven credentials, reading `settings.xml` once per run. */
  public mavenAuth(): Computable<MavenAuth> {
    return (this.mavenAuthMemo ??= MavenAuth.load(this.execution));
  }
}

const JAVA_PLUGIN_KEY = new PluginKey<JavaPluginContext>("@fabr-build/java");

/** Get the run's shared Java plugin context, creating it on first access. */
export function javaPluginContext(execution: ExecutionContext): JavaPluginContext {
  return execution.getOrCreatePluginContext(JAVA_PLUGIN_KEY, () => new JavaPluginContext(execution));
}
