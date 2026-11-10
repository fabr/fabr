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

import { compareText } from "@fabr-build/core";
import { CATALOG, Catalog, CatalogEntry, entryReference, NPM } from "./Catalog";
import { TargetPlan } from "./Targets";
import { rangeText } from "./Spec";

/** The file the catalog is written to. */
export const CATALOG_FILE = "CATALOG.fabr";

/** The file a package's target is written to, in its directory. */
export const BUILD_FILE = "BUILD.fabr";

/** Lay out `property = values;` with one value per line where they do not fit on one. */
function listProperty(indent: string, property: string, values: ReadonlyArray<string>): string[] {
  const lead = `${indent}${property} = `;
  const oneLine = `${lead}${values.join(" ")};`;
  if (oneLine.length <= 100) {
    return [oneLine];
  }
  const pad = " ".repeat(lead.length);
  return values.map((value, at) => `${at === 0 ? lead : pad}${value}${at === values.length - 1 ? ";" : ""}`);
}

/** The options of the catalog file. */
interface CatalogFileOptions {
  /** The lockfile the pins were read against, named in the header. */
  readonly lockfile?: string;
  /** The default registry, where it is not npm's. */
  readonly registry?: string;
  /** Each scope's registry: scope -> URL. */
  readonly scopeRegistries: ReadonlyMap<string, string>;
}

/** Render the catalog file: the registries, and the catalog's entries and `?` alternates. */
export function renderCatalogFile(catalog: Catalog, options: CatalogFileOptions): string {
  const lines = [
    `# Written by fabr-migrate from package.json${options.lockfile === undefined ? "" : ` and ${options.lockfile}`}.`,
    "",
  ];
  if (options.registry !== undefined) {
    lines.push(`NPM_REPOSITORY_URL = ${options.registry};`, "");
  }
  for (const [scope, url] of [...options.scopeRegistries].sort(([a], [b]) => compareText(a, b))) {
    lines.push(`npm_repository ${catalog.scopeRegistries.get(scope) ?? NPM} {`, `  url = ${url};`, "}", "");
  }
  const lockfile = options.lockfile ?? "the lockfile";
  const entries = [...catalog.entries.values()].sort((a, b) => compareText(a.address, b.address));
  const sections: Array<[string | undefined, CatalogEntry[]]> = [
    [undefined, entries.filter(entry => entry.pin === undefined)],
    [`Raised to the versions ${lockfile} installs, where the declared floors give lower ones.`, entries.filter(entry => entry.pin === "raise")],
    [`Required only without a lower bound: the versions ${lockfile} installs.`, entries.filter(entry => entry.pin === "floorless")],
  ];
  const values: string[] = [];
  for (const [heading, listed] of sections) {
    if (listed.length === 0) {
      continue;
    }
    if (heading !== undefined) {
      values.push("", `# ${heading}`);
    }
    for (const entry of listed) {
      if (entry.note !== undefined) {
        values.push(`# ${entry.note}`);
      }
      values.push(entryReference(entry));
    }
  }
  if (catalog.alternates.size > 0) {
    values.push("", `# Packages that ship at several versions, as ${lockfile} installs them.`);
  }
  for (const [name, versions] of [...catalog.alternates].sort(([a], [b]) => compareText(a, b))) {
    values.push([...versions].sort().map(version => `${catalog.repositoryOf(name)}:${name}:${rangeText(version)}?`).join(" "));
  }
  if (values.length > 0) {
    const last = values.map(value => value !== "" && !value.startsWith("#")).lastIndexOf(true);
    lines.push(`catalog ${CATALOG} {`, "  deps =", ...values.map((value, at) => (value === "" ? "" : `    ${value}${at === last ? ";" : ""}`)), "}");
  }
  return `${lines.join("\n")}\n`;
}

/** The options of the project file. */
interface ProjectFileOptions {
  /** The packages' build files, relative to the project root. */
  readonly buildFiles: ReadonlyArray<string>;
  /** `TYPESCRIPT`'s value, where the catalog holds a compiler fabr can drive. */
  readonly typescript?: string;
  /** `JS_TEST_FRAMEWORK`'s value, where the project uses one. */
  readonly testFramework?: string;
}

/** Render `PROJECT.fabr`: the js plugin, the catalog file, the packages' build files. */
export function renderProjectFile(options: ProjectFileOptions): string {
  const lines = [
    "# Written by fabr-migrate.",
    "plugin @fabr-build/js;",
    "",
    "# The registry dependencies, with the pins the project needs.",
    `include ./${CATALOG_FILE};`,
    "",
    ...options.buildFiles.map(file => `include ./${file};`),
  ];
  if (options.typescript !== undefined || options.testFramework !== undefined) {
    lines.push("");
  }
  if (options.typescript !== undefined) {
    lines.push(`TYPESCRIPT = ${options.typescript};`);
  }
  if (options.testFramework !== undefined) {
    lines.push(`JS_TEST_FRAMEWORK = ${options.testFramework};`);
  }
  return `${lines.join("\n")}\n`;
}

/** Render a package's build file: its `js_package` target. */
export function renderBuildFile(plan: TargetPlan): string {
  const lines = ["# Written by fabr-migrate from package.json.", `js_package ${plan.target} {`];
  if (plan.srcs.length === 0) {
    lines.push("  # TODO: no sources were found; write `srcs`.");
  }
  const properties: Array<[string, ReadonlyArray<string>]> = [
    ["srcs", plan.srcs],
    ["tests", plan.tests],
    ["deps", [...plan.deps].sort(compareText)],
    ["provided_deps", [...plan.provided].sort(compareText)],
    ["optional_provided_deps", [...plan.optionalProvided].sort(compareText)],
  ];
  for (const [property, values] of properties) {
    if (values.length > 0) {
      lines.push(...listProperty("  ", property, values));
    }
  }
  if (plan.manifest.version !== undefined) {
    lines.push(`  version = ${plan.manifest.version};`);
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}
