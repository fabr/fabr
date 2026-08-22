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
 * Pure (esbuild-independent) helpers behind the js_bundle rule: computing the
 * externalized-dependency name set, mapping each entry to its output name via
 * the `output` REWRITE, and assembling the fabr-level options document handed to
 * the standalone bundle driver (see bundleDriver/bundle-driver.ts — resolved as
 * the JS_BUNDLER runnable declared in JS.fabr). Everything here runs in the
 * host during evaluation; the esbuild invocation itself is the driver's job.
 * Kept apart from the driver so it can import @fabr-build/core and be
 * unit-tested under jest (the driver runs standalone in the bundle build step
 * and must not depend on core at runtime).
 */

import { FileSet, PackageFileSet, RepositoryRef, RewriteFn } from "@fabr-build/core";
import { JSTarget, soleModuleFormat } from "./JSPackage";

/** Where esbuild writes and the rule collects the bundle output from. */
export const BUNDLE_OUTDIR = "out";

/** The default OUTPUT name for an entry: every spelling the pipeline compiles
 * or links (`.ts`/`.tsx`/`.jsx`/`.mts`/`.cts`/`.mjs`/`.cjs`) maps to `.js` —
 * the bundle is a fresh file esbuild always writes as `.js`, so even a
 * module-flavoured entry (`.mts`, `.mjs`) yields a plain `.js` bundle name.
 * Anything else keeps its name (and fails the `.js` check downstream). */
export function compiledName(name: string): string {
  return name.replace(/\.(?:tsx?|jsx|[cm]ts|[cm]js)$/i, ".js");
}

export interface IBundleEntrySource {
  path: string;
  name: string;
}

export interface IBundleEntry {
  in: string;
  out: string;
}

/**
 * The options document fabr writes for the bundle driver — a plain, esbuild-free
 * description of the build. The driver maps it onto esbuild's BuildOptions and
 * owns the resolver plugin (membership + single-variant). Serialized to JSON, so
 * it stays content-addressed with no host paths.
 */
export interface IBundleOptions {
  /** Entry points to bundle, each with its output name. */
  entries: IBundleEntry[];
  /** Package names (dependency closure) to externalize — their imports survive
   * verbatim; a bundled source importing one of these is left as-is. */
  external: string[];
  /** esbuild platform, from JS_TARGET's environment component. */
  platform: "browser" | "node";
  /** esbuild output format: esm, or (for non-esm) iife in the browser else cjs. */
  format: "esm" | "cjs" | "iife";
  /** esbuild target ES level (JS_TARGET's version component). */
  target: string;
  /** Minify per BUILD_TYPE. */
  minify: boolean;
  /** Linked external sourcemap (`//# sourceMappingURL=`) per BUILD_TYPE, or none. */
  sourcemap: "linked" | false;
  /** Where the driver writes outputs, relative to the working directory. */
  outdir: string;
  /** esbuild `define`: identifier -> replacement code text (the `defines` MAP,
   * verbatim). Omitted when no defines were declared. */
  define?: Record<string, string>;
}

/** Every package name reachable from the given roots — the roots themselves plus
 * their whole dependency closure, deduped. RepositoryRef dependencies (external
 * requirements a package still carries inertly) contribute their package name;
 * built-package dependencies recurse. */
export function collectClosureNames(roots: FileSet[]): Set<string> {
  const names = new Set<string>();
  const visit = (pkg: PackageFileSet): void => {
    if (names.has(pkg.packageName)) {
      return;
    }
    names.add(pkg.packageName);
    for (const dep of pkg.dependencies) {
      if (dep instanceof PackageFileSet) {
        visit(dep);
      } else {
        names.add(refPackageName(dep));
      }
    }
  };
  for (const set of roots) {
    if (set instanceof PackageFileSet) {
      visit(set);
    }
  }
  return names;
}

/** The direct (top-level, i.e. property-listed) package names among the roots. */
function directNames(roots: FileSet[]): Set<string> {
  const names = new Set<string>();
  for (const set of roots) {
    if (set instanceof PackageFileSet) {
      names.add(set.packageName);
    }
  }
  return names;
}

/**
 * The package names to externalize (left runtime-provided, not bundled). A
 * package is externalized only when it is provided MORE directly than it is
 * bundled — its directness in `deps` outranks its directness in `srcs`, where
 * direct (property-listed) = 2, transitive (closure-only) = 1, absent = 0:
 *
 *   direct src   + direct dep    -> bundled     (an explicit srcs entry isn't overridden)
 *   transitive src + transitive dep -> bundled  (neither side names it explicitly)
 *   transitive src + direct dep  -> externalized (the explicit dep wins)
 *   direct src   + transitive dep -> bundled    (the explicit srcs entry wins)
 *   (absent from srcs, present in deps -> externalized, the ordinary external case)
 *
 * So externalization requires an explicit deps declaration that out-ranks how the
 * package entered srcs; identity is what matters, not which import reached it.
 */
export function computeExternalNames(srcs: FileSet[], deps: FileSet[]): string[] {
  const srcsDirect = directNames(srcs);
  const srcsAll = collectClosureNames(srcs);
  const depsDirect = directNames(deps);
  const external: string[] = [];
  for (const name of collectClosureNames(deps)) {
    const depLevel = depsDirect.has(name) ? 2 : 1;
    if (depLevel > srcLevel(name, srcsDirect, srcsAll)) {
      external.push(name);
    }
  }
  return external;
}

/** How directly a package sits in `srcs`: direct (property-listed) = 2,
 * transitive (closure-only) = 1, absent = 0. */
function srcLevel(name: string, direct: Set<string>, all: Set<string>): number {
  if (direct.has(name)) {
    return 2;
  }
  return all.has(name) ? 1 : 0;
}

/** The package name of an inert external requirement — its reference with the
 * trailing `:version` constraint stripped (`@types/node:20.12.7` → `@types/node`). */
function refPackageName(ref: RepositoryRef): string {
  const requirement = ref.name.toString();
  const idx = requirement.lastIndexOf(":");
  return idx > 0 ? requirement.substring(0, idx) : requirement;
}

/**
 * Map each entry to its bundle entry pair. `path` is where the file is staged —
 * for a loose source its compiled name at the bundle root, for one located
 * inside a mounted container the path under that mount. `name` is what the
 * reference CALLS it, and the output is derived from that: any compiled/linked
 * spelling becomes `.js` ({@link compiledName}), then the `output` REWRITE
 * renames it (first matching value; unmatched → unchanged). The final name
 * must end in `.js` — the
 * driver hands esbuild the extensionless stem, which it re-appends.
 * @throws if an output name doesn't end in `.js`.
 */
export function computeBundleEntries(entries: IBundleEntrySource[], rewrite: RewriteFn): IBundleEntry[] {
  return entries.map(({ path, name }) => {
    const compiled = compiledName(name);
    const output = rewrite(compiled) ?? compiled;
    if (!output.endsWith(".js")) {
      throw new Error(
        `js_bundle output '${output}' (from entry '${name}') must end in '.js' — rename it with an 'output' rewrite (output = <selector> -> <name>.js;)`
      );
    }
    return { in: path, out: output.slice(0, -".js".length) };
  });
}

/**
 * Assemble the driver options from the target's JS_TARGET / BUILD_TYPE and the
 * computed entries + external set. Format follows the module/environment: esm
 * stays esm; a non-esm browser bundle is an IIFE (self-contained script), a
 * non-esm node bundle is CommonJS. Minify/sourcemap track BUILD_TYPE (cmake-style):
 * debug → sourcemap only, relwithdebinfo → both, release → minify only.
 */
export function buildBundleOptions(
  jsTarget: JSTarget,
  buildType: string,
  entries: IBundleEntry[],
  external: string[],
  defines: Record<string, string>
): IBundleOptions {
  /* A bundle is a single artifact, so a `dual` target reads as its sole format. */
  const format = soleModuleFormat(jsTarget.module) === "esm" ? "esm" : jsTarget.environment === "browser" ? "iife" : "cjs";
  const minify = buildType === "release" || buildType === "relwithdebinfo";
  const sourcemap: "linked" | false = buildType === "release" ? false : "linked";
  return {
    entries,
    external,
    platform: jsTarget.environment,
    format,
    target: jsTarget.version,
    minify,
    sourcemap,
    outdir: BUNDLE_OUTDIR,
    ...(Object.keys(defines).length > 0 ? { define: defines } : {}),
  };
}
