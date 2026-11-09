#!/usr/bin/env node
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
 * The `fabr-migrate` command: write the fabr files that build the npm, yarn or
 * pnpm project in a directory (the working directory by default).
 */

import * as path from "path";
import { defaultCacheRoot, migrate } from "../Migrate";

const USAGE = `usage: fabr-migrate [--no-pins] [<project directory>]

Experimental: a best-effort starting point, whose output is for you to review
and finish.

Writes PROJECT.fabr, a BUILD.fabr per workspace package and CATALOG.fabr, the
catalog of registry dependencies, leaving any that exist as they are. Where it
writes the catalog, the project is then resolved, and the catalog pinned to what
the lockfile installs where fabr's resolution needs it.

  --no-pins  write the manifests' entries only; resolve nothing`;

function main(args: string[]): Promise<number> {
  let pins = true;
  const dirs: string[] = [];
  for (const arg of args) {
    if (arg === "--no-pins") {
      pins = false;
    } else if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      return Promise.resolve(0);
    } else if (arg.startsWith("-")) {
      console.error(`fabr-migrate: unknown option '${arg}'\n${USAGE}`);
      return Promise.resolve(2);
    } else {
      dirs.push(arg);
    }
  }
  if (dirs.length > 1) {
    console.error(USAGE);
    return Promise.resolve(2);
  }
  const root = path.resolve(dirs[0] ?? ".");
  return migrate(root, { pins, cacheRoot: defaultCacheRoot(), progress: line => console.error(line) }).then(report => {
    console.log(report.isEmpty ? "Converted with nothing to report." : report.render().join("\n"));
    return 0;
  });
}

main(process.argv.slice(2)).then(
  code => process.exit(code),
  (err: unknown) => {
    console.error(`fabr-migrate: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
);
