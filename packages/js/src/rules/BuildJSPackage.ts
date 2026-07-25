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
  Flag,
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
import { binByConvention, compileJsSources, JSTarget, parseJSTarget, stripPackageJson, withBinShebangs } from "../JSPackage";

function buildJsPackage(context: TargetContext): Computable<RuleResult> {
  return Computable.forAll(
    [
      context.getFileSet("srcs"),
      context.getFileSet("tests"),
      context.getGlobalString("JS_TARGET"),
      context.getProperty("version"),
      context.getFileSources("deps"),
      context.getFileSources("provided_deps"),
      context.getMap("metadata"),
    ],
    (sources, tests, target, version, depSources, providedSources, metadata) => {
      /* If there's a 'package.json' in the source list, we can initialize the output package.json from it */
      const seedJson = sources
        .get("package.json")
        .then(file => file?.readString())
        .then(content => (content ? (JSON.parse(content) as Record<string, unknown>) : undefined));

      const jsTarget = parseJSTarget(target);
      const compileSources = sources.minus(tests);

      /* THE collection point: deps AND provided_deps materialize through one
       * joint resolution (a package needing Node APIs lists `@types/node` among
       * them). `provided_deps` are host-provided, singleton-by-identity peers
       * (the plugin↔core relationship — see `provided_deps` in RATIONALE.md):
       * they take part in resolution, the compile, AND the carried closure exactly
       * like `deps` (flatten + per-name uniqueness already yields the one shared
       * instance the peer wants). They differ only in the generated manifest —
       * `peerDependencies`, not `dependencies` — and in strict-singleton resolution
       * enforcement (deferred). TSC is the compiler's own concern (resolved in
       * js_compile), independent of what it compiles. */
      const gathered = context.collect({ deps: depSources, provided: providedSources });

      /* Declared (not resolved) requirements for the generated manifest: each dep
       * source reports the version it was *declared* with — an inline `@npm:pkg:1.2.3`
       * off its own ref, a catalog dep from the catalog's pin — not the version the
       * joint resolution selected. Provided deps declare `peerDependencies`. */
      const declaredDeps = context.collectDeclaredRequirements(depSources);
      const declaredProvided = context.collectDeclaredRequirements(providedSources);

      return Computable.forAll(
        [gathered, seedJson, declaredDeps, declaredProvided],
        ({ deps, provided }, seed, declared, providedDeclared) => {
        /* Compile against the deps laid out scoped: the sources see only these
         * direct deps, while the transitive closure is reachable only by the
         * deps themselves (assembleScopedNodeModules). Provided deps are on the
         * compile path too (js codes against core's types), just not delivered. */
        /* Source-mode flags (strictness relaxations) ride alongside the file
         * deps; compileJsSources folds them into the compile's tsconfig. */
        const modeFlags = depSources.filter((source): source is Flag => source instanceof Flag);
        const { compiled, copied } = compileJsSources(
          context,
          compileSources,
          [...deps, ...provided],
          jsTarget,
          modeFlags
        );

        /* The package's DIRECT deps as written (built packages as packages,
         * external requirements as inert references, resolved fresh at each
         * consuming collection point) — carried on the delivered package.
         * `provided_deps` are carried too: a carried dep is a reference the
         * consumer re-resolves and flat-mounts (never bundled into this package),
         * and flatten + per-name uniqueness already collapses it to the single
         * shared instance the peer contract wants. Provided differs from a plain
         * dep only in the manifest (peerDependencies, below) and in strict-
         * singleton resolution enforcement (deferred). */
        const carried = [...depSources, ...providedSources].filter(
          (source): source is PackageFileSet | RepositoryRef =>
            source instanceof PackageFileSet || source instanceof RepositoryRef
        );

        /* Delivery shape: add the generated package.json (in memory — its
         * entry points depend on the compiled file list) and wrap with
         * identity + carried deps. This runs in resolution on every evaluation
         * (whether the compile sub-target hit or missed), reconstructing the
         * runtime-only identity each time. */
        const deliver = (built: FileSet): Computable<FileSource> => {
          const contents = FileSet.unionAll(built, stripPackageJson(copied));
          /* Guarantee every declared bin opens with an interpreter line so the
           * installed npm command is launchable — derived from the bin convention,
           * not a hand-written source shebang (see withBinShebangs). */
          return withBinShebangs(contents).then(shebanged => {
            const packageJson = createPackageJson(
              shebanged,
              seed,
              context.name,
              version?.toString(),
              declared,
              providedDeclared,
              jsTarget,
              metadata
            );
            const assembled = FileSet.unionAll(shebanged, new FileSet(new Map([["package.json", packageJson]])));
            return new PackageFileSet(assembled, context.name, version?.toString(), carried);
          });
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
  "peerDependencies",
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
 * points, the direct package requirements from its `deps` (`dependencies`), and
 * from its `provided_deps` (`peerDependencies`) (these always win, so metadata
 * may not name one of them).
 */
function createPackageJson(
  files: FileSet,
  seed: Record<string, unknown> | undefined,
  name: string,
  version: string | undefined,
  declared: (Requirement | undefined)[],
  providedDeclared: (Requirement | undefined)[],
  jsTarget: JSTarget,
  metadata: PropertyMap
): MemoryFile {
  /* The identity leads (the conventional reading order — name, then version),
   * so it is placed before the seed and metadata are copied in; a key keeps
   * its first-placed position, while the computed assignments below still win
   * on value. */
  const packageJson: Record<string, unknown> = { name };
  if (version !== undefined) {
    packageJson.version = version;
  }
  for (const [key, value] of Object.entries(seed ?? {})) {
    if (!(key in packageJson)) {
      packageJson[key] = value;
    }
  }
  for (const [key, value] of metadata) {
    if (COMPUTED_PACKAGE_FIELDS.has(key)) {
      throw rejectedMetadataKey(key, metadata);
    }
    packageJson[key] = encodeMetadataValue(value);
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
  /* provided_deps → peerDependencies: the host supplies the one shared copy. */
  const peerDependencies = peerDependenciesOf(providedDeclared);
  if (Object.keys(peerDependencies).length > 0) {
    packageJson.peerDependencies = peerDependencies;
  }

  return MemoryFile.from(JSON.stringify(packageJson, undefined, 2) + "\n");
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

/**
 * The `peerDependencies` for the generated package.json — the declared
 * requirements of `provided_deps`. Like `dependencies`, the version stated is the
 * declaration (what the package requires of its host), not what resolution pinned;
 * unlike `dependencies` there is no `@types/*` split — a peer is a runtime peer.
 */
function peerDependenciesOf(providedDeclared: (Requirement | undefined)[]): Record<string, string> {
  const peerDependencies: Record<string, string> = {};
  for (const req of providedDeclared) {
    if (req) {
      peerDependencies[req.pkg] = req.constraint;
    }
  }
  return peerDependencies;
}

export const buildJsPackageRule: RuleRegistration = {
  type: "js_package",
  constraints: { [BUILD_OPERATION]: "build" },
  evaluate: buildJsPackage,
};
