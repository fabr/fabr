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
  Computable,
  Constraints,
  EMPTY_FILESET,
  execute,
  FileSet,
  findExecutable,
  Flag,
  getResultFileSet,
  MemoryFile,
  PackageFileSet,
  registerTargetRule,
  RepositoryRef,
  SourceRef,
  TargetContext,
  writeFileSet,
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
function buildJsPackage(context: TargetContext): Computable<FileSet> {
  /* STUB */
  console.log("Building JS Package");

  return Computable.forAll(
    [
      context.getFileSet("srcs"),
      context.getFileSets("deps"),
      context.getFlags("deps"),
      context.getFileSet("tests"),
      context.getGlobalString("JS_TARGET"),
      context.getProperty("version"),
      context.getFileSources("deps"),
    ],
    (sources, deps, flags, tests, target, version, depSources) => {
      /* If there's a 'package.json' in the source list, we can initialize the output package.json from it */
      const packageJsonFile = sources
        .get("package.json")
        .then(file => file?.readString())
        .then(content => (content ? (JSON.parse(content) as Record<string, unknown>) : undefined));

      const jsTarget = parseJSTarget(target);

      /* Lay the deps out as node_modules contents: every package (and every
       * member of its resolved closure) is mounted at its real package name */
      const nodeModules = assembleNodeModules(deps);

      const compiled = compileJsSources(context, sources.minus(tests), nodeModules, jsTarget, flags);

      return Computable.forAll([compiled, packageJsonFile], (result, seed) => {
        /* Non-compiled sources are preserved in the output as-is (the source
         * package.json is consumed as the seed rather than copied through) */
        const contents = FileSet.unionAll(result.compiled, stripPackageJson(result.copied));
        const packageJson = createPackageJson(contents, seed, context.target.name, version?.toString(), depSources, jsTarget);
        const assembled = FileSet.unionAll(contents, new FileSet(new Map([["package.json", packageJson]])));
        /* Materialize the assembled package as its own cache entry: the
         * target's deliverable is a real on-disk package directory, delivered
         * as a package — root-relative files + identity + its DIRECT deps as
         * written (built packages as packages, external requirements as inert
         * references, resolved fresh at each consuming collection point). */
        const carried = depSources.filter(
          (source): source is PackageFileSet | RepositoryRef =>
            source instanceof PackageFileSet || source instanceof RepositoryRef
        );
        return context
          .getCachedOrBuild(assembled.toManifest(), targetDir =>
            writeFileSet(targetDir, assembled).then(() => getResultFileSet(targetDir, "**"))
          )
          .then(built => new PackageFileSet(built, context.target.name, version?.toString(), carried));
      });
    }
  );
}

export interface ICompiledSources {
  /** The compiler output (js + declarations), named root-relative */
  compiled: FileSet;
  /** Non-compiled sources, passed through unchanged */
  copied: FileSet;
}

/**
 * Compile a JS/TS source tree against a prepared node_modules layout:
 * TypeScript sources are compiled with the toolchain named by the TSC (and,
 * under the nodejs flag, NODE_TYPES) globals, resolved under the given
 * constraint overrides — an operation-specific rule should pass
 * BUILD_OPERATION=build. Anything that isn't compiled is passed through in
 * `copied`. (Note: plain .js sources are currently dropped — transpiling them
 * to the requested target is an open gap.)
 */
export function compileJsSources(
  context: TargetContext,
  sources: FileSet,
  nodeModules: FileSet,
  jsTarget: JSTarget,
  flags: Flag[],
  overrides?: Constraints
): Computable<ICompiledSources> {
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

  let compiled: Computable<FileSet>;
  if ("ts" in sourceGroups) {
    const tsdeps = [context.getGlobalTarget("TSC", overrides)];
    if (flags.find(f => f.name === "nodejs")) {
      tsdeps.push(context.getGlobalTarget("NODE_TYPES", overrides));
    }

    compiled = Computable.forAll(tsdeps, (typescript, types) => {
      const extraTypes = types ? assembleNodeModules(types as FileSet[]) : undefined;
      return compileTypescript(
        sourceGroups.ts,
        nodeModules,
        assembleNodeModules(typescript as FileSet[]),
        extraTypes,
        jsTarget,
        flags,
        context
      );
    });
  } else {
    compiled = Computable.resolve(EMPTY_FILESET);
  }

  return compiled.then(files => ({ compiled: files, copied: sourceGroups.copy ?? EMPTY_FILESET }));
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

function compileTypescript(
  srcs: FileSet,
  deps: FileSet,
  tsc: FileSet,
  extraTypes: FileSet | undefined,
  jsTarget: JSTarget,
  flags: Flag[],
  context: TargetContext
): Computable<FileSet> {
  const runtime = getESRuntime(flags, jsTarget.version);

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
    node_modules: [deps, tsc, extraTypes],
    src: srcs,
    "tsconfig.json": new MemoryFile(Buffer.from(JSON.stringify(tsconfig))),
  });

  return context.getCachedOrBuild(workingDir.toManifest(), targetDir =>
    writeFileSet(targetDir, workingDir)
      .then(() => execute(findExecutable("node"), ["node_modules/typescript/bin/tsc"], targetDir, {}))
      .then(() => getResultFileSet(targetDir, "build:**"))
  );
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

registerTargetRule("js_package", { BUILD_OPERATION: "build" }, buildJsPackage);

/**
 * Resolve all dependencies including transitive for our build target (from the 'deps' property).
 *
 * This is completely awful at the moment: we collect the _direct_ dependencies by the
 * standard resolution process, then we read the package.json from each dep for its
 * transitive dependencies, collate them, and then resolve them all against the default npm repository.
 *
 * There's so many things wrong with this that its not funny, but it
 */
// function resolveNPMDependencies(context: TargetContext): Computable<FileSet> {}
