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
 * `fabr_home`: packages installed with fabr itself, found as node finds them
 * from fabr's own code — the way plugins are. Its declaration declares the
 * namespace of its name (STD.fabr: `fabr_home @fabr-build { }`), so
 * `@fabr-build/<package>` resolves here unless the project declares the name.
 *
 * A delivery is the installed package's files (less its nested `node_modules`)
 * with, as its dependencies, the installed packages node would load for it.
 */

import * as path from "node:path";
import { Computable } from "../core/Computable";
import { toError } from "../core/Errors";
import { FileSet, FileSource, IFile } from "../core/FileSet";
import { Name, NamePartKind } from "../core/Name";
import { PackageFileSet, PackageGraphBuilder } from "../core/PackageFileSet";
import { IProvenanceStep, registerProvenanceDescriber, registerProvenanceRenderer } from "../core/Provenance";
import { Repository, RepositoryLookup, RepositoryPublishRef, RepositoryRef } from "../core/Repository";
import { isJsonObject, readJsonFile, toJsonObject } from "../support/Json";
import type { TargetContext } from "../model/BuildContext";
import { RepositoryRegistration } from "./Types";

/** Where lookups of the packages installed with fabr start: fabr's own code,
 *  from which the plugin loader finds plugins too. */
export const INSTALLED_FROM = __dirname;

export const FABR_HOME_PROVENANCE = "fabr-home";

/** A package delivered from fabr's installation, and where it is installed. */
interface IFabrHomeOrigin extends IProvenanceStep {
  kind: typeof FABR_HOME_PROVENANCE;
  directory: string;
}

registerProvenanceRenderer(FABR_HOME_PROVENANCE, step => [
  { message: `installed with fabr, at ${(step as IFabrHomeOrigin).directory}` },
]);
registerProvenanceDescriber(FABR_HOME_PROVENANCE, step => (step as IFabrHomeOrigin).directory);

/** What an installed package's manifest says: its version, and the names it
 *  depends on — a name in both blocks being optional, as npm reads it. */
interface IInstalledManifest {
  readonly version?: string;
  readonly required: string[];
  readonly optional: string[];
}

function toInstalledManifest(json: unknown): IInstalledManifest {
  const manifest = toJsonObject(json);
  if (manifest.version !== undefined && typeof manifest.version !== "string") {
    throw new Error("'version' is not a string");
  }
  const names = (field: string): string[] => {
    const block = manifest[field];
    return isJsonObject(block) ? Object.keys(block) : [];
  };
  const optional = names("optionalDependencies");
  return { version: manifest.version, required: names("dependencies").filter(name => !optional.includes(name)), optional };
}

/**
 * The directory of the package `name` as node loads it from `from`, or
 * undefined if node finds none. A package whose `exports` hides its
 * `package.json` cannot be read as installed, and says so.
 */
function locate(name: string, from: string): string | undefined {
  try {
    return path.dirname(require.resolve(`${name}/package.json`, { paths: [from] }));
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "MODULE_NOT_FOUND") {
      return undefined;
    }
    throw code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
      ? new Error(`${name} does not publish its package.json (its "exports" leaves it out), so it cannot be read as installed`)
      : err;
  }
}

/** The package installed at `directory`, read through `files` (a source over
 *  absolute paths): its manifest, and its files less its `node_modules`. */
function readInstalled(files: FileSource, directory: string): Computable<{ manifest: IInstalledManifest; files: FileSet }> {
  const prefix = `${path.relative("/", directory)}/`;
  const everything = new Name([
    { kind: NamePartKind.Literal, value: `${directory}/` },
    { kind: NamePartKind.Glob, value: "**" },
  ]);
  return Computable.forAll(
    [files.find(everything), files.get(path.join(directory, "package.json"))],
    (tree: FileSet, manifest: IFile | undefined) => {
      if (manifest === undefined) {
        throw new Error(`${directory} has no package.json`);
      }
      return readJsonFile(manifest, toInstalledManifest).then(read => ({
        manifest: read,
        files: tree.remap(name => {
          const own = name.startsWith(prefix) ? name.substring(prefix.length) : "node_modules";
          return own === "node_modules" || own.startsWith("node_modules/") ? undefined : own;
        }),
      }));
    }
  );
}

/**
 * The installed package `name` at `directory`, with every package it brings
 * with it wired as its dependencies — each located as node locates it from the
 * requiring package's own directory. A missing required dependency is an
 * installation fault; a missing optional one is simply absent.
 */
function installedPackage(files: FileSource, name: string, directory: string): Computable<PackageFileSet> {
  const found = new Map<string, { name: string; version?: string; files: FileSet; deps: Array<[string, string]> }>();
  const started = new Set<string>();
  const visit = (pkgName: string, pkgDir: string): Computable<void> => {
    if (started.has(pkgDir)) {
      return Computable.resolve(undefined);
    }
    started.add(pkgDir);
    return readInstalled(files, pkgDir).then(({ manifest, files: own }) => {
      const deps: Array<[string, string]> = [];
      found.set(pkgDir, { name: pkgName, version: manifest.version, files: own, deps });
      for (const [dep, optional] of [...manifest.required.map(dep => [dep, false] as const), ...manifest.optional.map(dep => [dep, true] as const)]) {
        const depDir = locate(dep, pkgDir);
        if (depDir === undefined && !optional) {
          throw new Error(`${pkgName} requires ${dep}, which is not installed with fabr (looked from ${pkgDir})`);
        }
        if (depDir !== undefined && !deps.some(([held]) => held === dep)) {
          deps.push([dep, depDir]);
        }
      }
      return Computable.forAll(
        deps.map(([dep, depDir]) => visit(dep, depDir)),
        () => Computable.resolve(undefined)
      );
    });
  };
  return visit(name, directory).then(() => {
    const builder = new PackageGraphBuilder();
    const nodes = new Map<string, PackageFileSet>();
    for (const [pkgDir, pkg] of found) {
      const origin: IFabrHomeOrigin = { kind: FABR_HOME_PROVENANCE, directory: pkgDir };
      nodes.set(pkgDir, builder.node(pkg.files, pkg.name, pkg.version, origin));
    }
    for (const [pkgDir, { deps }] of found) {
      builder.wire(
        nodes.get(pkgDir)!,
        deps.map(([dep, depDir]) => {
          const node = nodes.get(depDir)!;
          return node.packageName === dep ? node : node.withPackageName(dep);
        })
      );
    }
    builder.seal();
    return Computable.resolve(nodes.get(directory)!);
  });
}

/**
 * The repository a `fabr_home` declaration answers its namespace with: a
 * reference names a package in the namespace (`sass-pnp-importer` for
 * `@fabr-build/sass-pnp-importer`), with an optional `:projection` into it.
 */
export class FabrHomeRepository implements Repository, RepositoryLookup {
  /** `files` is a source over absolute paths (the run's absolute-path source);
   *  packages are looked up as node looks them up from `resolveFrom`. */
  constructor(
    private readonly namespace: string,
    private readonly files: FileSource,
    private readonly resolveFrom: string = INSTALLED_FROM
  ) {}

  public getRepositoryRef(name: Name): RepositoryRef {
    const literal = name.getLiteralPrefix();
    const colon = literal.indexOf(":");
    return colon === -1
      ? RepositoryRef.written(this, name)
      : new RepositoryRef(this, { name: literal.substring(0, colon), versionConstraint: undefined }).find(name.substring(colon + 1));
  }

  public getRepositoryPublishRef(name: Name): RepositoryPublishRef {
    throw new Error(`fabr's installation is not a publish destination (cannot sync to '${name.toString()}')`);
  }

  public deliver(reference: RepositoryRef): Computable<FileSet> {
    const name = `${this.namespace}/${reference.name}`;
    try {
      const directory = locate(name, this.resolveFrom);
      if (directory === undefined) {
        throw new Error(`${name} is not installed with fabr (looked from ${this.resolveFrom})`);
      }
      return installedPackage(this.files, name, directory);
    } catch (err) {
      return Computable.reject(toError(err));
    }
  }
}

/** A `fabr_home` repository type looking packages up from `resolveFrom` —
 *  fabr's own code by default; tests look up from within a fixture. */
export function fabrHomeRegistration(resolveFrom: string = INSTALLED_FROM): RepositoryRegistration {
  return {
    type: "fabr_home",
    declaresNamespace: true,
    provider: (context: TargetContext) =>
      Computable.resolve(new FabrHomeRepository(context.name, context.execution.absFileSource, resolveFrom)),
  };
}
