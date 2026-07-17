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

/*
 * npm's `.npmrc` config, as far as fabr needs it: per-registry authentication.
 * Combines the project `.npmrc` (read through the source FS, so it is watched)
 * with the user `~/.npmrc`, with `${VAR}` environment substitution as npm does it,
 * and answers "the Authorization header for a request to this URL" by longest
 * registry-prefix match (npm's "nerf dart"). Registry/scope config (`@scope:registry`)
 * is deliberately out of scope — auth only.
 */

import * as os from "node:os";
import * as path from "node:path";

import { Computable, ExecutionContext } from "@fabr-build/core";

/** The npm auth mechanisms configurable per registry, in precedence order. */
interface RegistryAuth {
  authToken?: string;
  /** Base64 `user:pass`, sent as-is. */
  auth?: string;
  username?: string;
  /** Base64-encoded password (npm's `_password`). */
  password?: string;
}

/** Substitute `${VAR}` with the environment value (empty when unset), as npm does
 *  — so `_authToken=${NPM_TOKEN}` picks up the CI token, and an unset var yields no
 *  credential rather than a literal `${…}`. */
function envSubstitute(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, name: string) => process.env[name] ?? "");
}

/**
 * Parse a `.npmrc` body into its key→value entries: `key = value` lines, skipping
 * blanks, `#`/`;` comments and `[section]` headers; surrounding quotes stripped and
 * `${VAR}` substituted (the ini shape npm uses).
 */
export function parseNpmrc(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";") || line.startsWith("[")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    const value = envSubstitute(line.slice(eq + 1).trim().replace(/^["']|["']$/g, ""));
    entries.set(key, value);
  }
  return entries;
}

/** The absolute path of the user `~/.npmrc` — read through a FileSource (the
 *  execution's absolute source), not a raw `fs` read. */
export function userNpmrcPath(): string {
  return path.join(os.homedir(), ".npmrc");
}

export class NPMConfig {
  /** registry key (`//host/path/`) → its auth fields. */
  private readonly registries: Map<string, RegistryAuth>;

  constructor(entries: Map<string, string>) {
    this.registries = new Map();
    const authOf = (prefix: string): RegistryAuth => {
      /* npm's nerf-dart keys are slash-terminated; normalize so prefix matching
       * respects path boundaries (`//host/npm` must not credential `//host/npm-other`). */
      const key = prefix.endsWith("/") ? prefix : `${prefix}/`;
      let auth = this.registries.get(key);
      if (!auth) {
        auth = {};
        this.registries.set(key, auth);
      }
      return auth;
    };
    for (const [key, value] of entries) {
      if (!key.startsWith("//")) {
        continue;
      }
      if (key.endsWith(":_authToken")) {
        authOf(key.slice(0, -":_authToken".length)).authToken = value;
      } else if (key.endsWith(":_auth")) {
        authOf(key.slice(0, -":_auth".length)).auth = value;
      } else if (key.endsWith(":username")) {
        authOf(key.slice(0, -":username".length)).username = value;
      } else if (key.endsWith(":_password")) {
        authOf(key.slice(0, -":_password".length)).password = value;
      }
    }
  }

  /**
   * Load the combined config for a run: the project `.npmrc` (read through the
   * source FS, so it participates in watch-mode invalidation) and the user
   * `~/.npmrc` (absolute FS, unwatched), project overriding user. Reads straight
   * off the {@link ExecutionContext}'s FileSources, so it is shared per run rather
   * than per repository instance (see the js plugin context).
   */
  public static load(execution: ExecutionContext): Computable<NPMConfig> {
    return Computable.forAll(
      [execution.absFileSource.get(userNpmrcPath()).then(f => f?.readString()),
       execution.sourceFileSource.get(".npmrc").then(f => f?.readString())], 
       NPMConfig.fromSources);
  }

  /**
   * Combine `.npmrc` sources given in **increasing precedence** — a duplicate key
   * from a later source wins (so pass user before project, per npm precedence).
   * Any source may be absent.
   */
  public static fromSources(...sources: (string | undefined)[]): NPMConfig {
    const entries = sources
      .filter((source): source is string => source !== undefined)
      .flatMap(source => [...parseNpmrc(source)]);
    return new NPMConfig(new Map(entries));
  }

  /**
   * Get `Authorization` headers (if needed) to send with a request to `url`, from the
   * most specific matching registry's credential */
  public getHeadersFor(url: string): Record<string,string> {
    let target: string;
    try {
      const parsed = new URL(url);
      target = `//${parsed.host}${parsed.pathname}`;
    } catch {
      return {};
    }
    /* Match a slash-terminated target against slash-terminated prefixes, so a
     * prefix only matches at a path boundary — not `//host/npm` ⊃ `//host/npm-x`. */
    const scoped = target.endsWith("/") ? target : `${target}/`;
    let best: RegistryAuth | undefined;
    let bestLength = -1;
    for (const [prefix, auth] of this.registries) {
      if (scoped.startsWith(prefix) && prefix.length > bestLength) {
        best = auth;
        bestLength = prefix.length;
      }
    }
    if (!best) {
      return {};
    }

    if (best.authToken) {
      return { Authorization: `Bearer ${best.authToken}` };
    }
    if (best.auth) {
      return { Authorization: `Basic ${best.auth}` };
    }
    if (best.username !== undefined && best.password !== undefined) {
      const password = Buffer.from(best.password, "base64").toString("utf8");
      return { Authorization: `Basic ${Buffer.from(`${best.username}:${password}`).toString("base64")}` };
    }
    return {};
  }
}
