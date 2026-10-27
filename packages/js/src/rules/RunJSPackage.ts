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
 * The js_package[run] rule: make a package runnable via its declared bins. It
 * *depends on* js_package[build] (resolves this package under build, cached —
 * never repeating its work), then mounts it (and its resolved dep closure) as
 * node_modules and launches a declared bin under node — so `fabr run @some/pkg`
 * runs its CLI: the sole bin by default, else the one a projection picks
 * (`fabr run pkg:cmd`).
 */

import { BUILD_OVERRIDE, FabrError, PackageFileSet, defineRule } from "@fabr-build/core";
import { makeNpmRunnable } from "../JSPackage";

/** The `js_package` rule, under `run`. */
export default defineRule({
  /* The requirement is this package under build (the ambient operation here is
   * run), so its carried deps resolve at this collection point: a carried @types
   * dep needing @types/node is satisfied by the package's own explicit
   * @types/node dep, in the same batch. The package is made runnable via its
   * generated package.json bin, the same path an external `@npm:` package takes. */
  requirements(context) {
    return { pkg: context.resolveSelfWithOverrides(BUILD_OVERRIDE) };
  },
  evaluateMaterialized(context, { pkg }) {
    const built = pkg.find((source): source is PackageFileSet => source instanceof PackageFileSet);
    if (!built) {
      throw new FabrError("internal: js_package[build] did not yield a package");
    }
    return makeNpmRunnable(context, built);
  },
});
