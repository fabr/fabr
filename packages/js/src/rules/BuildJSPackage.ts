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
  declPosn,
  EMPTY_FILESET,
  FileSet,
  FileSource,
  mapEntryOrigin,
  MemoryFile,
  Name,
  NameResolutionError,
  PackageFileSet,
  PropertyMap,
  PropertyMapValue,
  RepositoryRef,
  Requirement,
  RuleRegistration,
  RuleResult,
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
      context.getMap("metadata"),
    ],
    (sources, tests, target, version, depSources, metadata) => {
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

      /* Declared (not resolved) requirements for the generated manifest: each dep
       * source reports the version it was *declared* with — an inline `@npm:pkg:1.2.3`
       * off its own ref, a catalog dep from the catalog's pin — not the version the
       * joint resolution selected. */
      const declaredDeps = context.collectDeclaredRequirements(depSources);

      return Computable.forAll([gathered, seedJson, declaredDeps], ({ deps }, seed, declared) => {
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
          const packageJson = createPackageJson(
            contents,
            seed,
            context.name,
            version?.toString(),
            declared,
            jsTarget,
            metadata
          );
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

/** package.json fields fabr computes from the target itself — a `metadata` key
 * naming one of these would be silently overridden, so it is rejected instead. */
const COMPUTED_PACKAGE_FIELDS = new Set([
  "name",
  "version",
  "type",
  "main",
  "types",
  "bin",
  "dependencies",
  "devDependencies",
]);

/** The error for a metadata key fabr computes itself: attributed through the
 * map's ghost origin to the written entry — even one that arrived through a
 * shared map — with any splice/reference hops named in the message. */
function rejectedMetadataKey(key: string, metadata: PropertyMap): Error {
  const reason = `metadata key '${key}' is set by fabr and cannot be overridden`;
  const origin = mapEntryOrigin(metadata, key);
  if (!origin) {
    return new Error(reason);
  }
  const via = origin.via.map(hop => ` (via '${("ref" in hop ? hop.ref : hop.value).toString()}')`).join("");
  return new NameResolutionError(Name.fromLiteral(key), declPosn(origin.entry), undefined, reason + via);
}

/** Encode a resolved metadata value as its package.json JSON shape: a string
 * stays a string, a sub-map becomes an object (`repository`), a list of
 * sub-maps an array of objects (`maintainers`). */
function encodeMetadataValue(value: PropertyMapValue): unknown {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(encodeMetadataValue);
  }
  return Object.fromEntries([...value].map(([key, sub]) => [key, encodeMetadataValue(sub)]));
}

/**
 * Generate the package.json for the built package: initialized from the source
 * package.json where one exists, overlaid with the declared `metadata` (the
 * descriptive fields — description, license, author, repository, ...), then
 * with what the target computes — its name, version, module type, entry
 * points, and the direct package requirements from its deps (these always win,
 * so metadata may not name one of them).
 */
function createPackageJson(
  files: FileSet,
  seed: Record<string, unknown> | undefined,
  name: string,
  version: string | undefined,
  declared: (Requirement | undefined)[],
  jsTarget: JSTarget,
  metadata: PropertyMap
): MemoryFile {
  const packageJson: Record<string, unknown> = { ...(seed ?? {}) };
  for (const [key, value] of metadata) {
    if (COMPUTED_PACKAGE_FIELDS.has(key)) {
      throw rejectedMetadataKey(key, metadata);
    }
    packageJson[key] = encodeMetadataValue(value);
  }
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

  const { dependencies, devDependencies } = packageDependencies(declared);
  if (Object.keys(dependencies).length > 0) {
    packageJson.dependencies = dependencies;
  }
  if (Object.keys(devDependencies).length > 0) {
    packageJson.devDependencies = devDependencies;
  }

  return MemoryFile.from(JSON.stringify(packageJson, undefined, 2));
}

/**
 * The direct dependencies for the generated package.json — the declared
 * requirements split into `dependencies` and `devDependencies` (@types/* to the
 * latter, per convention). The version each states is the declaration, not what
 * fabr's joint resolution selected: a published manifest says what the package
 * *requires*, and the consumer resolves it.
 */
function packageDependencies(declared: (Requirement | undefined)[]): {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
} {
  const dependencies: Record<string, string> = {};
  const devDependencies: Record<string, string> = {};
  for (const req of declared) {
    if (req) {
      (req.pkg.startsWith("@types/") ? devDependencies : dependencies)[req.pkg] = req.constraint;
    }
  }
  return { dependencies, devDependencies };
}

export const buildJsPackageRule: RuleRegistration = {
  type: "js_package",
  constraints: { [BUILD_OPERATION]: "build" },
  evaluate: buildJsPackage,
};
