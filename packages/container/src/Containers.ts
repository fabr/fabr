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

import { spawnSync } from "child_process";
import { Computable, executeInternalCapture, isReapable, ownerName, registerExitTeardown, Semaphore } from "@fabr-build/core";

/**
 * Containers fabr starts are named `fabr-<owner>-<n>`, the owner this
 * process's (`<host>-<pid>`, {@link ownerName}), so a later run can tell
 * whose each is and remove those of a process that is gone.
 */
const PREFIX = "fabr-";

let started = 0;

/** @return the name of a new container this process starts. */
export function containerName(): string {
  return `${PREFIX}${ownerName()}-${++started}`;
}

/** @return this host's part of an owner name, for a launcher naming its container after its own pid. */
export function ownerHost(): string {
  return ownerName().replace(/-\d+$/, "");
}

/** @return the owner a container's name names, or undefined where it is no name fabr gave. */
export function ownerOfContainer(name: string): string | undefined {
  const match = /^fabr-(.+-\d+)-[^-]+$/.exec(name);
  return match === null ? undefined : match[1];
}

/**
 * Remove the container `name` with `engine` when fabr exits, where it is not
 * removed before; return the release, for once it is.
 */
export function removeOnExit(engine: string, name: string, env: Record<string, string>): () => void {
  return registerExitTeardown(() => {
    spawnSync(engine, ["rm", "-f", name], { env, stdio: "ignore", timeout: 10_000 });
  });
}

/** Each engine's reaping this run, so it is done once. */
const reaped = new Map<string, Computable<void>>();

/**
 * Remove, once a run, the containers `engine` holds that a fabr process of
 * this host which is gone left: one killed before it could remove them.
 */
export function reapContainers(limit: Semaphore, engine: string, env: Record<string, string>): Computable<void> {
  let done = reaped.get(engine);
  if (done === undefined) {
    done = executeInternalCapture(limit, engine, ["ps", "-a", "--filter", `name=${PREFIX}`, "--format", "{{.Names}}"], "", env).then(
      ({ status, stdout }) => {
        const dead =
          status !== 0
            ? []
            : stdout.split("\n").filter(name => {
                const owner = ownerOfContainer(name.trim());
                return owner !== undefined && isReapable(owner);
              });
        return dead.length === 0
          ? Computable.resolve(undefined)
          : executeInternalCapture(limit, engine, ["rm", "-f", ...dead.map(name => name.trim())], "", env).then(() => undefined);
      }
    );
    reaped.set(engine, done);
  }
  return done;
}
