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
import { FileSet } from "../../core/FileSet";
import { registerTargetRule } from "../Registry";
import { MemoryFile } from "../../core/MemoryFS";
import { getResultFileSet, writeFileSet } from "../../core/BuildCache";
import { execute } from "../../support/Execute";
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
      context.getFileSet("deps"),
      context.getFlags("deps"),
      context.getFileSet("tests"),
      context.getGlobalString("JS_TARGET"),
    ],
    (sources, deps, flags, tests, target) => {
      /* If there's a 'package.json' in the source list, we can initialize the output package.json from it */
      const packageJsonFile = sources
        .get("package.json")
        .then(file => file?.readString())
        .then(content => content && JSON.parse(content));

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

      if ("ts" in sourceGroups) {
        const tsdeps = [context.getGlobalTarget("TSC")];
        if (flags.find(f => f.name === "nodejs")) {
          tsdeps.push(context.getGlobalTarget("NODE_TYPES"));
        }

        return Computable.forAll(tsdeps, (typescript, types) => {
          const extraTypes = types ? FileSet.unionAll(...(types as FileSet[])) : undefined;
          return compileTypescript(
            sourceGroups.ts,
            deps,
            FileSet.unionAll(...(typescript as FileSet[])),
            extraTypes,
            target,
            flags,
            context
          );
        });
      }

      return new Computable<FileSet>();
    }
  );
}

function compileTypescript(
  srcs: FileSet,
  deps: FileSet,
  tsc: FileSet,
  extraTypes: FileSet | undefined,
  target: string,
  flags: Flag[],
  context: TargetContext
): Computable<FileSet> {
  const jsTarget = parseJSTarget(target);
  const runtime = getESRuntime(flags, jsTarget.version);

  const tsconfig = {
    compilerOptions: {
      declaration: true,
      declarationMap: true,
      outDir: "build",
      rootDir: "src",
      target: jsTarget.version,
      lib: [runtime],
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
  console.log(workingDir.toManifest());

  return context.getCachedOrBuild(workingDir.toManifest(), targetDir =>
    writeFileSet(targetDir, workingDir)
      .then(() => execute("/home/nkeynes/.nvm/versions/node/v20.10.0/bin/node", ["node_modules/typescript/bin/tsc"], targetDir, {}))
      .then(() => getResultFileSet(targetDir, "build/**"))
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

registerTargetRule("js_package", {}, buildJsPackage);

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
