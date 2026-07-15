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
 * The js_package[run] rule: make a package runnable via its declared bin. It
 * *depends on* js_package[build] (resolves this package under build, cached —
 * never repeating its work), requires it to declare exactly one bin/ executable,
 * then mounts it (and its resolved dep closure) as node_modules and launches
 * that bin under node — so `fabr run @some/pkg` runs its CLI. A package with no
 * bin, or more than one, is not (unambiguously) runnable.
 */

import {
  BUILD_OPERATION,
  Computable,
  Constraints,
  PackageFileSet,
  RuleRegistration,
  RuleResult,
  TargetContext,
} from "@fabr-build/core";
import { makeNpmRunnable } from "../JSPackage";

/* The package is built under build, since the ambient operation here is run. */
const BUILD_OP: Constraints = { [BUILD_OPERATION]: "build" };

function runJsPackage(context: TargetContext): Computable<RuleResult> {
  return context.context.getTargetWithOverrides(context.name, BUILD_OP).then((buildResult): Computable<RuleResult> => {
    const built = buildResult.find((s): s is PackageFileSet => s instanceof PackageFileSet);
    if (!built) {
      throw new Error("internal: js_package[build] did not yield a package");
    }
    /* Resolve the package's carried deps at this collection point (a carried
     * @types dep needing @types/node is satisfied by the package's own explicit
     * @types/node dep, in the same batch), then make the fully-resolved package
     * runnable via its generated package.json bin: the same path an external
     * `@npm:` package takes. */
    return context.collect({ pkg: [built] }).then(({ pkg }) => makeNpmRunnable(pkg[0] as PackageFileSet));
  });
}

export const runJsPackageRule: RuleRegistration = {
  type: "js_package",
  constraints: { [BUILD_OPERATION]: "run" },
  evaluate: runJsPackage,
};
