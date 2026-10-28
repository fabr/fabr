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
 * The java_installation rule: the jars of every package `deps` hold or reach,
 * each named by its own file name, with the loose files among `deps` as they
 * are.
 */

import { defineRule, FileSet } from "@fabr-build/core";
import { installationOf } from "../JarPackage";

/** The `java_installation` rule. */
export default defineRule({
  requirements(context) {
    return { deps: context.getPackageProperty("deps") };
  },
  evaluateMaterialized(_context, { deps }: { deps: FileSet[] }) {
    return installationOf(deps);
  },
});
