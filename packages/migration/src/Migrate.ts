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

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PROJECT_FILENAME } from "@fabr-build/core";
import { buildCatalog, Catalog, CATALOG } from "./Catalog";
import { BUILD_FILE, CATALOG_FILE, renderBuildFile, renderCatalogFile, renderProjectFile } from "./Emit";
import { Lockfile, readLockfile } from "./Lockfile";
import { declaredDependencies } from "./Manifest";
import { planTargets } from "./Targets";
import { latestPublished, observe, proposePins } from "./Pins";
import { Report } from "./Report";
import { constraintOf, floorOf } from "./Spec";
import { readWorkspace, Workspace } from "./Workspace";

/** The report's heading for the files a run leaves as they are. */
const KEPT = "Files kept as they are (delete one to have it written again)";

/** The most rounds of resolving and pinning a migration makes. */
const MAX_ROUNDS = 10;

interface MigrateOptions {
  /** Resolve the project and add the pins it needs (otherwise only the manifests' entries are written). */
  readonly pins: boolean;
  /** The build cache the resolution reads registry metadata through. */
  readonly cacheRoot: string;
  /** Where progress is written. */
  readonly progress: (line: string) => void;
}

/**
 * @return the root of fabr's build cache, found as the CLI's
 * `getBuildCacheRoot` finds it: `FABR_CACHE_DIR`, else `fabr` under the
 * platform's cache directory, always absolute. Keep the two in step.
 */
export function defaultCacheRoot(): string {
  const explicit = process.env.FABR_CACHE_DIR;
  if (explicit) {
    return path.resolve(explicit);
  }
  switch (os.platform()) {
    case "darwin":
      return path.resolve(os.homedir(), "Library/Caches", "fabr");
    case "win32":
      return path.resolve(process.env.LOCALAPPDATA ?? process.env.APPDATA ?? path.resolve(os.homedir(), "AppData/Local"), "fabr");
    default:
      return path.resolve(process.env.XDG_CACHE_HOME ?? path.resolve(os.homedir(), ".cache"), "fabr");
  }
}

/**
 * @return `TYPESCRIPT`'s value where the catalog's `typescript` entry is a
 * version fabr's driver drives (5 or 6), otherwise undefined; another
 * version is reported to `report`.
 */
function typescriptOf(catalog: Catalog, report: Report): string | undefined {
  const entry = catalog.entries.get("typescript");
  const constraint = entry === undefined ? undefined : constraintOf(entry.range);
  if (constraint === undefined) {
    return undefined;
  }
  const major = floorOf(constraint).major;
  if (major === 5 || major === 6) {
    return `${CATALOG}:typescript`;
  }
  report.add("Not converted", `TypeScript ${entry!.range}: fabr's TypeScript driver drives 5 and 6, so fabr's default is used`);
  return undefined;
}

/** @return the test framework the project's manifests declare: `vitest` where any declares it, else `jest` where any does, otherwise undefined. */
function testFrameworkOf(workspace: Workspace): string | undefined {
  const declared = [workspace.rootManifest, ...workspace.packages].flatMap(manifest => [...declaredDependencies(manifest).keys()]);
  return declared.includes("vitest") ? "vitest" : declared.includes("jest") ? "jest" : undefined;
}

/** Write `text` to `file` where it does not exist. @return true if it was written, otherwise false. */
function writeNew(file: string, text: string): boolean {
  if (fs.existsSync(file)) {
    return false;
  }
  fs.writeFileSync(file, text);
  return true;
}

/**
 * Write the fabr files of the project at `root` that do not exist yet:
 * `PROJECT.fabr`, a `BUILD.fabr` per package and the catalog file. A file that
 * exists is left as it is and listed in the report, as is a kept
 * `PROJECT.fabr` that does not include the catalog file.
 *
 * With `options.pins`, and only where the catalog file was written, the
 * project is then resolved (see {@link observe}) and pins added to the catalog
 * (see {@link proposePins}), the catalog file rewritten each round, until a
 * round adds none or {@link MAX_ROUNDS} is reached. Packages required only
 * without a lower bound and not in the lockfile are pinned at their latest
 * published version.
 *
 * @return the report: what could not be converted, the files kept, and what
 * resolution left unanswered (failures, targets that did not resolve).
 */
export async function migrate(root: string, options: MigrateOptions): Promise<Report> {
  const report = new Report();
  const workspace = readWorkspace(root);
  const lockfile: Lockfile | undefined = readLockfile(root);
  /* What the catalog's making could not decide is reported where the catalog is written. */
  const catalogReport = new Report();
  const { catalog, addressOf } = buildCatalog(workspace, lockfile, catalogReport);
  const plans = planTargets(workspace, addressOf);

  const buildFiles: string[] = [];
  for (const plan of plans) {
    const file = plan.manifest.dir === "" ? BUILD_FILE : `${plan.manifest.dir}/${BUILD_FILE}`;
    buildFiles.push(file);
    if (writeNew(path.join(root, file), renderBuildFile(plan))) {
      report.addAll(plan.report);
    } else {
      report.add(KEPT, file);
    }
  }
  const projectFile = path.join(root, PROJECT_FILENAME);
  const projectReport = new Report();
  const written = writeNew(
    projectFile,
    renderProjectFile({
      buildFiles,
      ...optional("typescript", typescriptOf(catalog, projectReport)),
      ...optional("testFramework", testFrameworkOf(workspace)),
    })
  );
  if (written) {
    report.addAll(projectReport);
  } else {
    report.add(KEPT, PROJECT_FILENAME);
    if (!fs.readFileSync(projectFile, "utf8").includes(CATALOG_FILE)) {
      report.add(`${PROJECT_FILENAME} does not include ${CATALOG_FILE}`, `add: include ./${CATALOG_FILE};`);
    }
  }

  const catalogFile = path.join(root, CATALOG_FILE);
  const catalogOptions = {
    ...optional("lockfile", lockfile?.file),
    ...optional("registry", workspace.registry),
    scopeRegistries: workspace.scopeRegistries,
  };
  if (!writeNew(catalogFile, renderCatalogFile(catalog, catalogOptions))) {
    report.add(KEPT, CATALOG_FILE);
    return report;
  }
  report.addAll(catalogReport);
  if (!options.pins) {
    return report;
  }
  if (lockfile === undefined) {
    report.add("Not converted", "no lockfile, so nothing is pinned to the versions it installs");
  }

  const targets = plans.map(plan => plan.target);
  for (let round = 1; ; round++) {
    options.progress(`Resolving ${targets.length} target${targets.length === 1 ? "" : "s"} (round ${round})`);
    const observation = await observe(root, options.cacheRoot, targets);
    const unlocked = new Map(
      [...observation.floorless].filter(name => !lockfile?.versions.has(name)).map(name => [name, catalog.repositoryOf(name)])
    );
    const latest = unlocked.size === 0 ? new Map<string, string>() : await latestPublished(root, options.cacheRoot, unlocked);
    const proposal = proposePins(catalog, observation, lockfile, latest);
    if (proposal.added > 0 && round < MAX_ROUNDS) {
      options.progress(`  added ${proposal.added} pin${proposal.added === 1 ? "" : "s"}`);
      fs.writeFileSync(catalogFile, renderCatalogFile(catalog, catalogOptions));
      continue;
    }
    proposal.unanswered.forEach(([heading, line]) => report.add(heading, line));
    observation.failures.forEach(failure => report.add("Resolution failures", failure.replace(/\n/g, "\n  ")));
    observation.failed.forEach(target => report.add("Targets that did not resolve (nothing they reach is pinned)", target));
    if (proposal.added > 0) {
      fs.writeFileSync(catalogFile, renderCatalogFile(catalog, catalogOptions));
      report.add("Not converted", `pinning did not settle in ${MAX_ROUNDS} rounds`);
    }
    return report;
  }
}

/** @return `{ [key]: value }` where `value` is defined, otherwise `{}`. */
function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}
