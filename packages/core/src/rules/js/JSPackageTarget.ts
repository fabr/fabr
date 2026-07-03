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

import { TargetContext } from "../../model/BuildContext";
import { Computable } from "../../core/Computable";
import { EMPTY_FILESET, FileSet, ILabeledFileSet } from "../../core/FileSet";
import { RepositoryRef, SourceRef } from "../../core/Repository";
import { registerTargetRule } from "../Registry";
import { MemoryFile } from "../../core/MemoryFS";
import { getResultFileSet, writeFileSet } from "../../core/BuildCache";
import { execute, findExecutable } from "../../support/Execute";
import { Flag } from "../../core/Flag";

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
      context.getLabeledFileSets("deps"),
      context.getFlags("deps"),
      context.getFileSet("tests"),
      context.getGlobalString("JS_TARGET"),
      context.getProperty("version"),
      context.getFileSources("deps"),
    ],
    (sources, labeledDeps, flags, tests, target, version, depSources) => {
      /* If there's a 'package.json' in the source list, we can initialize the output package.json from it */
      const packageJsonFile = sources
        .get("package.json")
        .then(file => file?.readString())
        .then(content => (content ? (JSON.parse(content) as Record<string, unknown>) : undefined));

      /* If we have TS files, we get to invoke the compiler */
      const sourceGroups = sources.minus(tests).partition(path => {
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

      const jsTarget = parseJSTarget(target);

      /* Assemble node_modules from the deps: package outputs (identified by a
       * root package.json) are mounted under their package name; repository
       * closures are already node_modules-shaped. */
      const assembly = assembleNodeModules(labeledDeps);

      let compiled: Computable<FileSet>;
      if ("ts" in sourceGroups) {
        const tsdeps = [context.getGlobalTarget("TSC")];
        if (flags.find(f => f.name === "nodejs")) {
          tsdeps.push(context.getGlobalTarget("NODE_TYPES"));
        }

        compiled = Computable.forAll([assembly, ...tsdeps] as const, (deps, typescript, types) => {
          const extraTypes = types ? FileSet.unionAll(...(types as FileSet[])) : undefined;
          return compileTypescript(
            sourceGroups.ts,
            deps.files,
            FileSet.unionAll(...(typescript as FileSet[])),
            extraTypes,
            jsTarget,
            flags,
            context
          );
        });
      } else {
        compiled = Computable.resolve(EMPTY_FILESET);
      }

      return Computable.forAll([compiled, packageJsonFile, assembly], (files, seed, deps) => {
        /* Non-compiled sources are preserved in the output as-is (the source
         * package.json is consumed as the seed rather than copied through) */
        const copied = (sourceGroups.copy ?? EMPTY_FILESET).remap(name => (name === "package.json" ? undefined : name));
        const contents = FileSet.unionAll(files, copied);
        const packageJson = createPackageJson(
          contents,
          seed,
          context.target.name,
          version?.toString(),
          depSources,
          deps.packages,
          jsTarget
        );
        const assembled = FileSet.unionAll(contents, new FileSet(new Map([["package.json", packageJson]])));
        /* Materialize the assembled package as its own cache entry: the
         * target's deliverable is a real on-disk package directory. */
        return context.getCachedOrBuild(assembled.toManifest(), targetDir =>
          writeFileSet(targetDir, assembled).then(() => getResultFileSet(targetDir, "**"))
        );
      });
    }
  );
}

/**
 * Generate the package.json for the built package: initialized from the source
 * package.json where one exists, then overlaid with what the target declares —
 * its name, version, module type, entry points, and the direct package
 * requirements from its deps.
 */
/** A package dependency discovered while assembling node_modules */
interface IPackageInfo {
  name: string;
  version?: string;
}

/**
 * Assemble the node_modules contents from the target's (materialized, labeled)
 * deps: a FileSet with a root package.json is a built package and is mounted
 * under its declared name; anything else (repository closures, plain files) is
 * already node_modules-shaped and passes through unchanged.
 */
function assembleNodeModules(labeledDeps: ILabeledFileSet[]): Computable<{ files: FileSet; packages: IPackageInfo[] }> {
  const packages: IPackageInfo[] = [];
  const mounted = labeledDeps.map(entry =>
    entry.files.get("package.json").then(file => {
      if (!file) {
        return entry;
      }
      return file.readString().then((content): ILabeledFileSet => {
        const packageJson = JSON.parse(content) as { name?: string; version?: string };
        if (!packageJson.name) {
          return entry;
        }
        packages.push({ name: packageJson.name, version: packageJson.version });
        const name = packageJson.name;
        return { label: entry.label, files: entry.files.remap(path => `${name}/${path}`) };
      });
    })
  );
  return Computable.forAll(mounted, (...entries: ILabeledFileSet[]) => ({
    files: FileSet.unionAllLabeled(entries),
    packages,
  }));
}

function createPackageJson(
  files: FileSet,
  seed: Record<string, unknown> | undefined,
  name: string,
  version: string | undefined,
  depSources: SourceRef[],
  depPackages: IPackageInfo[],
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

  /* The direct package requirements, as written (typings split out per convention) */
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
    }
  }
  /* Built package dependencies, at whatever version they declared */
  for (const dep of depPackages) {
    dependencies[dep.name] = dep.version ?? "*";
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

interface JSTarget {
  version: string;
  module: "esm" | "commonjs";
  environment: "node" | "browser";
}

/**
 * Parse a JS target triple
 * @param target
 */
function parseJSTarget(target: string): JSTarget {
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
