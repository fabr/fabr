/*
 * Copyright (c) 2022 Nathan Keynes <nkeynes@deadcoderemoval.net>
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

import { Computable } from "../core/Computable";
import { loadProject } from "../model/Loader";
import { defaultLog } from "../support/Log";
import { Options } from "./Command";
import { getSourceRoot, getBuildCacheRoot, PROJECT_FILENAME } from "./Environment";

export async function runFabr(options: Options): Promise<void> {
  const log = defaultLog;

  const sourceRoot = await getSourceRoot();
  const buildRoot = getBuildCacheRoot();

  const load = loadProject(sourceRoot, PROJECT_FILENAME, log);

  return load.then(model => {
    const config = model.getConfig(options.properties);
    const targets = options.targets.map(targetName => config.getTarget(targetName));
    Computable.forAll(targets, () => {
      console.log("Done");
      console.log(targets);
      process.exit(0);
    });
  });
}
