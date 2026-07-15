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
 * The js_package[build] rule: build a Node/NPM-compatible package — compile
 * its TypeScript sources against the resolved deps, generate its package.json,
 * and deliver it as a PackageFileSet carrying identity and direct deps.
 */

import {
  BUILD_OPERATION,
  Computable,
  EMPTY_FILESET,
  FileSet,
  FileSource,
  MemoryFile,
  PackageFileSet,
  RepositoryRef,
  RuleRegistration,
  RuleResult,
  SourceRef,
  TargetContext,
} from "@fabr-build/core";
import { binByConvention, compileJsSources, JSTarget, parseJSTarget, stripPackageJson } from "../JSPackage";

function buildJsPackage(context: TargetContext): Computable<RuleResult> {
  return Computable.forAll(
    [
      context.getFileSet("srcs"),
      context.getFileSet("tests"),
      context.getGlobalString("JS_TARGET"),
      context.getProperty("version"),
      context.getFileSources("deps"),
    ],
    (sources, tests, target, version, depSources) => {
      /* If there's a 'package.json' in the source list, we can initialize the output package.json from it */
      const seedJson = sources
        .get("package.json")
        .then(file => file?.readString())
        .then(content => (content ? (JSON.parse(content) as Record<string, unknown>) : undefined));

      const jsTarget = parseJSTarget(target);
      const compileSources = sources.minus(tests);

      /* THE collection point: the deps materialize through one joint resolution
       * (a package needing Node APIs lists `@types/node` among them). TSC is the
       * compiler's own concern (resolved in js_compile), independent of what it
       * compiles. */
      const gathered = context.collect({ deps: depSources });

      return Computable.forAll([gathered, seedJson], ({ deps }, seed) => {
        /* Compile against the deps laid out scoped: the sources see only these
         * direct deps, while the transitive closure is reachable only by the
         * deps themselves (assembleScopedNodeModules). */
        const { compiled, copied } = compileJsSources(context, compileSources, deps, jsTarget);

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

  const bin = binByConvention(names);
  if (Object.keys(bin).length > 0) {
    packageJson.bin = bin;
  }

  const { dependencies, devDependencies } = packageDependencies(depSources);
  if (Object.keys(dependencies).length > 0) {
    packageJson.dependencies = dependencies;
  }
  if (Object.keys(devDependencies).length > 0) {
    packageJson.devDependencies = devDependencies;
  }

  return MemoryFile.from(JSON.stringify(packageJson, undefined, 2));
}

/**
 * The direct package requirements for the generated package.json: npm refs as
 * written, built-package deps by their identity, with @types/* split into
 * devDependencies per convention.
 */
function packageDependencies(depSources: SourceRef[]): {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
} {
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
  return { dependencies, devDependencies };
}

export const buildJsPackageRule: RuleRegistration = {
  type: "js_package",
  constraints: { [BUILD_OPERATION]: "build" },
  evaluate: buildJsPackage,
};
