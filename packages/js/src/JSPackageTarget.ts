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

import {
  BUILD_OPERATION,
  Computable,
  EMPTY_FILESET,
  createExecAction,
  FileSet,
  FileSource,
  Flag,
  MemoryFile,
  PackageFileSet,
  registerRule,
  RepositoryRef,
  TargetContext,
  RuleResult,
  SourceRef,
} from "@fabr/core";

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
 * Build a javascript (Node/NPM compatible) package.
 *
 *
 * all<T extends readonly unknown[] | []>(values: T): Promise<{ -readonly [P in keyof T]: Awaited<T[P]>; }>;
 *
 * type Awaited<T> = T extends null | undefined ? T : // special case for `null | undefined` when not in `--strictNullChecks` mode
    T extends object & { then(onfulfilled: infer F, ...args: infer _): any; } ? // `await` only unwraps object types with a callable `then`. Non-object types are not unwrapped
        F extends ((value: infer V, ...args: infer _) => any) ? // if the argument to `then` is callable, extracts the first argument
            Awaited<V> : // recursively unwrap the value
        never : // the argument to `then` was not callable
    T; // non-object or non-thenable
 * 
 * @param spec
 * @param context
 */
function buildJsPackage(context: TargetContext): Computable<RuleResult> {
  return Computable.forAll(
    [
      context.getFileSet("srcs"),
      context.getFlags("deps"),
      context.getFileSet("tests"),
      context.getGlobalString("JS_TARGET"),
      context.getProperty("version"),
      context.getFileSources("deps"),
    ],
    (sources, flags, tests, target, version, depSources) => {
      /* If there's a 'package.json' in the source list, we can initialize the output package.json from it */
      const seedJson = sources
        .get("package.json")
        .then(file => file?.readString())
        .then(content => (content ? (JSON.parse(content) as Record<string, unknown>) : undefined));

      const jsTarget = parseJSTarget(target);
      const compileSources = sources.minus(tests);
      const needsTsc = hasTypescriptSources(compileSources);

      /* THE collection point: the deps and the node @types (under nodejs)
       * materialize through one joint resolution, so e.g. the NODE_TYPES pin
       * satisfies an unconstrained @types/node arriving via the deps. TSC is
       * the compiler's own concern (resolved in js_compile), independent of
       * what it compiles. */
      const gathered = context.collect({
        deps: depSources,
        ...(needsTsc && flags.find(f => f.name === "nodejs") ? { nodeTypes: context.getGlobalSources("NODE_TYPES") } : {}),
      });

      return Computable.forAll([gathered, seedJson], ({ deps, nodeTypes }, seed) => {
        /* Lay the deps out as node_modules contents: every package (and every
         * member of its resolved closure) is mounted at its real package name */
        const nodeModules = assembleNodeModules(deps);
        const { compiled, copied } = compileJsSources(context, compileSources, nodeModules, jsTarget, flags, nodeTypes);

        /* The package's DIRECT deps as written (built packages as packages,
         * external requirements as inert references, resolved fresh at each
         * consuming collection point) — carried on the delivered package. */
        const carried = depSources.filter(
          (source): source is PackageFileSet | RepositoryRef =>
            source instanceof PackageFileSet || source instanceof RepositoryRef
        );

        /* Delivery shape: add the generated package.json (in memory — its
         * entry points depend on the compiled file list) and wrap with
         * identity + carried deps. This runs in resolution on every evaluation
         * (whether the compile sub-target hit or missed), reconstructing the
         * runtime-only identity each time. */
        const deliver = (built: FileSet): FileSource => {
          const contents = FileSet.unionAll(built, stripPackageJson(copied));
          const packageJson = createPackageJson(contents, seed, context.name, version?.toString(), depSources, jsTarget);
          const assembled = FileSet.unionAll(contents, new FileSet(new Map([["package.json", packageJson]])));
          return new PackageFileSet(assembled, context.name, version?.toString(), carried);
        };

        /* With TS sources the compile is a sub-target (its output wrapped
         * here); without, there is nothing to build — the package is the
         * copied files + package.json, assembled in memory. */
        return compiled ? compiled.then(deliver) : deliver(EMPTY_FILESET);
      });
    }
  );
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

/**
 * The js_compile rule: the one TS-compile path, a self-contained target
 * `{ srcs = FILES; deps = FILES }`. `deps` is the node_modules the sources are
 * compiled against (package deps + any @types, already resolved by the caller
 * so `getFileSet` here is a no-op materialization). It resolves its *own*
 * toolchain — `TSC` (a build tool, independent of what it compiles) — and its
 * own `JS_TARGET`, derives the tsconfig, lays out the tsc working directory
 * and yields the `exec` action that runs the compiler (output: `build/**`).
 * The `runtime` input carries the ES lib level (from the target's `es*` flags,
 * which can't survive materialization into `deps`).
 */
function compileTypescript(context: TargetContext): Computable<RuleResult> {
  return Computable.forAll(
    [
      context.getFileSet("srcs"),
      context.getFileSet("deps"),
      context.getRequiredString("runtime"),
      context.getGlobalString("JS_TARGET"),
      context.getGlobalTarget("TSC"),
    ],
    (srcs, deps, runtime, target, tscSources) => {
      const jsTarget = parseJSTarget(target);
      const modules = FileSet.unionAll(deps, assembleNodeModules(tscSources.filter((s): s is FileSet => s instanceof FileSet)));
      const tsconfig = {
        compilerOptions: {
          declaration: true,
          declarationMap: true,
          outDir: "build",
          rootDir: "src",
          /* Strict by default; TODO: needs a way to flag it off per target */
          strict: true,
          target: jsTarget.version,
          lib: jsTarget.environment === "browser" ? [runtime, "dom"] : [runtime],
          module: jsTarget.module === "esm" ? "esnext" : "commonjs",
          moduleResolution: "node",
        },
        exclude: ["node_modules"],
        include: ["./src/**/*.ts"],
      };

      const workingDir = FileSet.layout({
        node_modules: modules,
        src: srcs,
        "tsconfig.json": new MemoryFile(Buffer.from(JSON.stringify(tsconfig))),
      });

      return createExecAction(workingDir, ["node", "node_modules/typescript/bin/tsc"], "build:**", "compile");
    }
  );
}

registerRule("js_compile", {}, compileTypescript);

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

/**
 * Generate the package.json for the built package: initialized from the source
 * package.json where one exists, then overlaid with what the target declares —
 * its name, version, module type, entry points, and the direct package
 * requirements from its deps.
 */
function createPackageJson(
  files: FileSet,
  seed: Record<string, unknown> | undefined,
  name: string,
  version: string | undefined,
  depSources: SourceRef[],
  jsTarget: JSTarget
): MemoryFile {
  const packageJson: Record<string, unknown> = { ...(seed ?? {}) };
  packageJson.name = name;
  if (version !== undefined) {
    packageJson.version = version;
  }
  packageJson.type = jsTarget.module === "esm" ? "module" : "commonjs";
  const names = new Set([...files].map(([filename]) => filename));
  if (names.has("index.js")) {
    packageJson.main = "index.js";
  }
  if (names.has("index.d.ts")) {
    packageJson.types = "index.d.ts";
  }

  /* The direct package requirements, as written (typings split out per
   * convention); a built package dep carries its identity directly, at
   * whatever version it declared */
  const dependencies: Record<string, string> = {};
  const devDependencies: Record<string, string> = {};
  for (const source of depSources) {
    if (source instanceof RepositoryRef) {
      const requirement = source.name.toString();
      const idx = requirement.lastIndexOf(":");
      if (idx > 0) {
        const pkg = requirement.substring(0, idx);
        const constraint = requirement.substring(idx + 1);
        (pkg.startsWith("@types/") ? devDependencies : dependencies)[pkg] = constraint;
      }
    } else if (source instanceof PackageFileSet) {
      dependencies[source.packageName] = source.version ?? "*";
    }
  }
  if (Object.keys(dependencies).length > 0) {
    packageJson.dependencies = dependencies;
  }
  if (Object.keys(devDependencies).length > 0) {
    packageJson.devDependencies = devDependencies;
  }

  return MemoryFile.from(JSON.stringify(packageJson, undefined, 2));
}

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

registerRule("js_package", { BUILD_OPERATION: "build" }, buildJsPackage);
