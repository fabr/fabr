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

/**
 * Shared JS-package helpers used across the js rules (not themselves rules):
 * JS target parsing, node_modules assembly, and the TS-compile orchestration
 * that builds the `js_compile` sub-target.
 */

import { BUILD_OPERATION, Computable, EMPTY_FILESET, FileSet, Flag, PackageFileSet, TargetContext } from "@fabr/core";

export interface JSTarget {
  version: string;
  module: "esm" | "commonjs";
  environment: "node" | "browser";
}

/**
 * Parse a JS target triple
 * @param target
 */
export function parseJSTarget(target: string): JSTarget {
  const bits = target.split("-");

  const result: JSTarget = { version: bits[0], module: "commonjs", environment: "node" };

  if (bits.length > 1 && bits[1] === "esm") {
    result.module = "esm";
  }
  if (bits.length > 2 && bits[2] === "browser") {
    result.environment = "browser";
  }
  return result;
}

/**
 * Simplify flags by removing flags that are provided (directly on indirectly) by another flag.
 * @param flags
 */
function simplifyFlags(flags: Flag[]): Flag[] {
  const closure = getFlagProvidesClosure(flags);
  return flags.filter(flag => !closure.has(flag));
}

/**
 * @returns all Flags provided by the input list of Flags, not including the flags themselves
 * (unless they are provided by another flag).
 */
function getFlagProvidesClosure(flags: Flag[]): Set<Flag> {
  const provided = new Set<Flag>();
  const queue: Flag[] = [...flags];
  let elem: Flag | undefined;
  while ((elem = queue.pop())) {
    elem.provides.forEach(p => {
      if (!provided.has(p)) {
        provided.add(p);
        queue.push(p);
      }
    });
  }
  return provided;
}

function getESRuntime(flags: Flag[], defaultRuntime: string): string {
  return simplifyFlags(flags).find(flag => flag.name.startsWith("es"))?.name ?? defaultRuntime;
}

/**
 * @return whether the tree holds compilable TypeScript sources (i.e. the
 * compile step — and hence the TSC toolchain — will be needed at all).
 */
export function hasTypescriptSources(files: FileSet): boolean {
  return [...files].some(([name]) => {
    const lower = name.toLowerCase();
    return (lower.endsWith(".ts") || lower.endsWith(".tsx")) && !lower.endsWith(".d.ts");
  });
}

export interface ICompiledSources {
  /** The compiled tree's output (from the js_compile sub-target); undefined
   * when there are no TypeScript sources to compile */
  compiled?: Computable<FileSet>;
  /** Non-compiled sources, passed through unchanged */
  copied: FileSet;
}

/**
 * Compile a JS/TS source tree by building the `js_compile` sub-target — the
 * single TS compile path shared by the package build and the test run.
 * TypeScript sources yield `compiled` (the sub-target's cached output);
 * anything not compiled is returned in `copied`. `nodeModules` is the
 * already-assembled dependency layout the sources compile against, with the
 * NODE_TYPES delivery (`nodeTypes`, under the nodejs flag) folded in — both
 * resolved jointly by the caller's collection point. TSC is the compiler's
 * own concern, resolved inside js_compile. The sub-target builds under
 * BUILD_OPERATION=build (a compile is a build even for a test target).
 * (Note: plain .js sources are currently dropped — transpiling them is an
 * open gap.)
 */
export function compileJsSources(
  context: TargetContext,
  sources: FileSet,
  nodeModules: FileSet,
  jsTarget: JSTarget,
  flags: Flag[],
  nodeTypes?: FileSet[]
): ICompiledSources {
  const sourceGroups = sources.partition(path => {
    const lower = path.toLowerCase();
    const extidx = lower.lastIndexOf(".");
    if (extidx !== -1) {
      const ext = lower.substring(extidx + 1);
      switch (ext) {
        case "ts":
          if (lower.endsWith(".d.ts")) {
            break; /* Output only */
          }
        /* fallthrough */
        case "tsx":
          return "ts";
        case "js":
        case "jsx":
          return "js";
      }
    }
    return "copy";
  });

  let compiled: Computable<FileSet> | undefined;
  if ("ts" in sourceGroups) {
    /* The deps the sources compile against: the package deps plus (under
     * nodejs) the node @types — resolved jointly by the caller. TSC is added
     * by js_compile itself. */
    const deps = nodeTypes ? FileSet.unionAll(nodeModules, assembleNodeModules(nodeTypes)) : nodeModules;
    compiled = context.subTarget(
      "js_compile",
      { srcs: sourceGroups.ts, deps, runtime: getESRuntime(flags, jsTarget.version) },
      { label: "Compiling", constraints: { [BUILD_OPERATION]: "build" } }
    );
  }

  return { compiled, copied: sourceGroups.copy ?? EMPTY_FILESET };
}

/** @return the files without any root package.json (consumed, not copied through) */
export function stripPackageJson(files: FileSet): FileSet {
  return files.remap(name => (name === "package.json" ? undefined : name));
}

/**
 * Lay out the given (materialized) sources as node_modules contents: each
 * package — and, recursively, every package among its dependencies — is
 * mounted at its real package name (which may differ from the alias it was
 * written as); anything that isn't a package passes through unchanged. The
 * sources must have been materialized (any carried references resolved) by
 * the collection point before they get here.
 */
export function assembleNodeModules(sets: FileSet[]): FileSet {
  const mounts: FileSet[] = [];
  const seen = new Set<PackageFileSet>();
  const mount = (pkg: PackageFileSet): void => {
    if (!seen.has(pkg)) {
      seen.add(pkg);
      mounts.push(mountPackage(pkg));
      for (const dep of pkg.dependencies) {
        if (dep instanceof PackageFileSet) {
          mount(dep);
        }
      }
    }
  };
  for (const set of sets) {
    if (set instanceof PackageFileSet) {
      mount(set);
    } else {
      mounts.push(set);
    }
  }
  return FileSet.unionAll(...mounts);
}

/** @return the package's files renamed under the package's mount point */
function mountPackage(pkg: PackageFileSet): FileSet {
  return pkg.remap(path => `${pkg.packageName}/${path}`);
}
