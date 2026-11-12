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
 * The js_package[run] rule: make the package that js_package[build] builds
 * runnable by the bins its `package.json` declares (every executable directly
 * under `bin/`). The package and every package it requires are installed as
 * `node_modules` and the bin is launched under node: the sole bin, or the one
 * a projection names (`fabr run pkg:cmd`).
 */

import { BUILD_OVERRIDE, FabrError, PackageFileSet, defineRule } from "@fabr-build/core";
import { makeNpmRunnable } from "../JSPackage";

/** The `js_package` rule, under `run`. */
export default defineRule({
  /* Require this package under `build`, in this target's `run` collection, so
   * the packages it requires resolve together there. */
  requirements(context) {
    return { run: { pkg: context.resolveSelfWithOverrides(BUILD_OVERRIDE) } };
  },
  evaluateMaterialized(context, { pkg }) {
    const built = pkg.find((source): source is PackageFileSet => source instanceof PackageFileSet);
    if (!built) {
      throw new FabrError("internal: js_package[build] did not yield a package");
    }
    return makeNpmRunnable(context, built);
  },
});
