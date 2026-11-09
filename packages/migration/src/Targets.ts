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

import * as path from "path";
import { CATALOG, CatalogAddress } from "./Catalog";
import { importedPackage, scanSources, SourceScan } from "./Imports";
import { DEPENDENCY_BLOCKS, declaredDependencies, Manifest } from "./Manifest";
import { Report } from "./Report";
import { parseSpec } from "./Spec";
import { importsLocalFile, readTsconfigs, TsconfigOptions } from "./Tsconfig";
import { Workspace } from "./Workspace";

/** A package's `js_package` target, as the migration writes it. */
export interface TargetPlan {
  readonly manifest: Manifest;
  /** The target's name: the package's. */
  readonly target: string;
  readonly srcs: ReadonlyArray<string>;
  readonly tests: ReadonlyArray<string>;
  readonly deps: ReadonlyArray<string>;
  readonly provided: ReadonlyArray<string>;
  readonly optionalProvided: ReadonlyArray<string>;
  /** What the plan could not decide for the target. */
  readonly report: Report;
}

const TEST_FILE = /(?:^|\/)(?:__tests__\/.*|[^/]*\.(?:test|spec)\.[^/.]+)$/;

/** @return the `@types` package DefinitelyTyped publishes `name`'s types under. */
export function typesPackageOf(name: string): string {
  return `@types/${name.startsWith("@") ? name.slice(1).replace("/", "__") : name}`;
}

/** @return the package whose types the `@types` package `types` holds (the inverse of {@link typesPackageOf}). */
export function packageOfTypes(types: string): string {
  const name = types.replace(/^@types\//, "");
  const scoped = name.indexOf("__");
  return scoped < 0 ? name : `@${name.slice(0, scoped)}/${name.slice(scoped + 2)}`;
}

/** Plan the `js_package` target of each package of `workspace`. */
export function planTargets(
  workspace: Workspace,
  addressOf: (manifest: Manifest, name: string) => CatalogAddress | undefined
): TargetPlan[] {
  const targets = new Map<string, string>();
  for (const manifest of workspace.packages) {
    targets.set(manifest.name ?? manifest.dir, manifest.name ?? (manifest.dir === "" ? path.basename(workspace.root) : manifest.dir));
  }
  const packageDirs = new Set(workspace.packages.map(manifest => path.join(workspace.root, manifest.dir)));
  const root = workspace.rootManifest;
  const rootDeclared = declaredDependencies(root);
  /* A root `@types` package whose package the root does not declare is ambient
   * (`@types/node`, `@types/jest`), used by every package with TypeScript sources. */
  const rootAmbient = [...rootDeclared.keys()].filter(
    name => name.startsWith("@types/") && ![...rootDeclared.keys()].some(other => typesPackageOf(other) === name)
  );

  return workspace.packages.map(manifest => {
    const target = targets.get(manifest.name ?? manifest.dir)!;
    const report = new Report();
    const from = manifest.dir === "" ? "package.json" : `${manifest.dir}/package.json`;
    if (manifest.name === undefined) {
      report.add("Packages with no name (the target is named by its directory)", manifest.dir);
    }
    const dir = path.join(workspace.root, manifest.dir);
    const tsconfigs = readTsconfigs(dir);
    const scan = scanSources(
      dir,
      new Set([...packageDirs].filter(other => other !== dir && other.startsWith(`${dir}${path.sep}`))),
      specifier => [...tsconfigs.values()].some(options => importsLocalFile(specifier, options))
    );
    const reference = (name: string): string | undefined => {
      if (name !== manifest.name && targets.has(name)) {
        return targets.get(name)!;
      }
      const address = addressOf(manifest, name) ?? (manifest !== root ? addressOf(root, name) : undefined);
      if (address === undefined) {
        return undefined;
      }
      return address.address === name ? `${CATALOG}:${name}` : `${CATALOG}:${address.address} -> ${name}`;
    };

    const deps = new Set<string>();
    const provided = new Set<string>();
    const optionalProvided = new Set<string>();
    const peers = manifest.blocks.get("peerDependencies") ?? new Map<string, string>();
    for (const [name] of peers) {
      const ref = reference(name);
      if (ref !== undefined) {
        (manifest.optionalPeers.has(name) ? optionalProvided : provided).add(ref);
      }
    }
    for (const block of DEPENDENCY_BLOCKS) {
      if (block === "peerDependencies") {
        continue;
      }
      for (const [name, text] of manifest.blocks.get(block) ?? []) {
        if (peers.has(name)) {
          continue;
        }
        const ref = reference(name);
        if (ref !== undefined) {
          deps.add(ref);
        } else if (parseSpec(name, text).kind === "workspace") {
          report.add("Dependencies not converted", `${name}: '${text}' in ${from} (no workspace package of that name)`);
        }
      }
    }

    if (manifest !== root) {
      cascade(manifest, scan, ambientOf(tsconfigs, rootAmbient), reference, deps, report, from);
    }
    if (scan.files.length === 0) {
      report.add("Packages with no sources found (srcs left for you to write)", target);
    }
    const globs = sourceGlobs(scan);
    if (globs.outside.length > 0) {
      report.add("Test files outside src/ (add them to tests)", `${target}: ${globs.outside.slice(0, 3).join(", ")}${globs.outside.length > 3 ? `, and ${globs.outside.length - 3} more` : ""}`);
    }
    return { manifest, target, report, srcs: globs.srcs, tests: globs.tests, deps: [...deps], provided: [...provided], optionalProvided: [...optionalProvided] };
  });
}

/**
 * @return the packages a workspace package's TypeScript sources use without importing
 * them: what its tsconfigs' `types` name (an `@types` package, or the package
 * itself), or where its `tsconfig.json` sets no `types`, the root's `@types`
 * packages that are no package's companion (`rootAmbient`), every one of
 * which the compiler then includes.
 */
function ambientOf(tsconfigs: ReadonlyMap<string, TsconfigOptions>, rootAmbient: ReadonlyArray<string>): string[] {
  if (tsconfigs.get("tsconfig.json")?.types === undefined) {
    return [...rootAmbient];
  }
  return [
    ...new Set(
      [...tsconfigs.values()].flatMap(options =>
        (options.types ?? []).flatMap(type => {
          const name = importedPackage(type) ?? type;
          return name.startsWith("@types/") ? [name] : [typesPackageOf(name)];
        })
      )
    ),
  ];
}

/**
 * Add to `deps` the root's dependencies `manifest`'s sources reach without
 * declaring them, which a package manager makes visible by hoisting: what
 * they import (with its `@types` companion), and the `ambient` packages where
 * the sources are TypeScript. An import nothing declares is reported, unless
 * the root declares its `@types` package alone (`aws-lambda`).
 */
function cascade(
  manifest: Manifest,
  scan: SourceScan,
  ambient: ReadonlyArray<string>,
  reference: (name: string) => string | undefined,
  deps: Set<string>,
  report: Report,
  from: string
): void {
  const declared = declaredDependencies(manifest);
  /* Whether the package can write a reference to `name`: its own dependency, the root's, or another workspace package. */
  const referable = (name: string): boolean => reference(name) !== undefined;
  const bring = (name: string, why: string): void => {
    const ref = reference(name);
    if (ref !== undefined && !declared.has(name) && !deps.has(ref)) {
      deps.add(ref);
      report.add("Root dependencies added to a package (hoisted, so it uses them undeclared)", `${manifest.name ?? manifest.dir}: ${name} (${why})`);
    }
  };
  for (const name of [...scan.imports].sort()) {
    if (name === manifest.name) {
      continue;
    }
    if (!declared.has(name) && !referable(name)) {
      if (referable(typesPackageOf(name)) || declared.has(typesPackageOf(name))) {
        bring(typesPackageOf(name), `the types of ${name}`);
        continue;
      }
      report.add("Imports nothing declares (add the dependency)", `${name}, imported in ${path.dirname(from) === "." ? "the root" : path.dirname(from)}`);
      continue;
    }
    bring(name, "imported");
    if (referable(typesPackageOf(name))) {
      bring(typesPackageOf(name), `the types of ${name}`);
    }
  }
  if (scan.files.some(file => /\.[cm]?tsx?$/.test(file))) {
    /* A `types` entry with no `@types` package is a package carrying its own (`@playwright/test`). */
    ambient
      .map(name => (referable(name) ? name : packageOfTypes(name)))
      .filter(referable)
      .forEach(name => bring(name, "ambient types"));
  }
}

/** @return the `srcs` and `tests` globs covering the files `scan` found, by
 * extension: the files in `src/`, under `src:`, where there are any, and the
 * test files outside it; otherwise every file. */
function sourceGlobs(scan: SourceScan): { srcs: string[]; tests: string[]; outside: string[] } {
  const inSrc = scan.files.filter(file => file.startsWith("src/"));
  const base = inSrc.length > 0 ? "src:" : "";
  const files = inSrc.length > 0 ? inSrc : scan.files;
  const outside = inSrc.length > 0 ? scan.files.filter(file => !file.startsWith("src/") && TEST_FILE.test(file)) : [];
  const extensions = new Set(files.map(file => path.extname(file)));
  const srcs = [...extensions].sort().map(ext => `${base}**/*${ext}`);
  const tests = new Set<string>();
  for (const file of files.filter(file => TEST_FILE.test(file))) {
    const ext = path.extname(file);
    const kind = /\.spec\.[^/.]+$/.test(file) ? "spec" : /\.test\.[^/.]+$/.test(file) ? "test" : undefined;
    tests.add(kind === undefined ? `${base}**/__tests__/**/*${ext}` : `${base}**/*.${kind}${ext}`);
  }
  return { srcs, tests: [...tests].sort(), outside };
}
