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
 * Loaded into every vitest worker before any test file, as the first of the
 * run's `setupFiles`: makes stylesheet and binary imports yield their stubs
 * (see ../testRunner/Assets). The tests are ES modules, so the seam this
 * needs is `module.registerHooks`, hence the node floor.
 */

import { installAssetHooks } from "../testRunner/Assets";

const MINIMUM_NODE = [22, 15] as const;

const [major, minor] = process.versions.node.split(".").map(Number);
if (!(major > MINIMUM_NODE[0] || (major === MINIMUM_NODE[0] && minor >= MINIMUM_NODE[1]))) {
  throw new Error(
    `The vitest runner needs node ${MINIMUM_NODE.join(".")} or later (this is ${process.versions.node}): ` +
      "it intercepts stylesheet and asset imports via module.registerHooks."
  );
}
installAssetHooks();
