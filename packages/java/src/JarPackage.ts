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
 * What the Java rules share: the classpath a set of dependencies makes, the
 * release a compile targets, jar manifests, and the step that writes a jar.
 */

import * as fs from "fs";
import * as path from "path";
import {
  ActionContext,
  BuildAction,
  BuildResult,
  Computable,
  FabrError,
  FileSet,
  fileSetInput,
  Flag,
  getResultFileSet,
  IBuildActionDefinition,
  IFile,
  ITaskReport,
  MemoryFile,
  PackageFileSet,
  packToZip,
  PERMISSIVE_RESOLUTION,
  readZipMember,
  ResolutionContext,
  RunnableFileSet,
  stringConfig,
  TargetContext,
} from "@fabr-build/core";

/** Where a jar's manifest is. */
export const MANIFEST_NAME = "META-INF/MANIFEST.MF";

const JVM_TARGET_PATTERN = /^jvm(\d+)$/;
const SOURCE_FLAG_PATTERN = /^java(\d+)$/;

/**
 * Get the Java release a compile targets: the highest source flag (`java17`)
 * among `deps`, or else `JVM_TARGET`'s (`jvm21`). Throws where the source
 * level is above `JVM_TARGET`, which the JVM cannot run.
 */
export function javaRelease(jvmTarget: string, deps: readonly FileSet[]): number {
  const target = JVM_TARGET_PATTERN.exec(jvmTarget);
  if (!target) {
    throw new FabrError(`'${jvmTarget}' is not a JVM_TARGET`).withHelp("write the Java release the output runs on, as in 'jvm17'");
  }
  const emitted = Number(target[1]);
  const levels = deps
    .filter((dep): dep is Flag => dep instanceof Flag)
    .map(flag => SOURCE_FLAG_PATTERN.exec(flag.name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(match => Number(match[1]));
  if (levels.length === 0) {
    return emitted;
  }
  const source = Math.max(...levels);
  if (source > emitted) {
    throw new FabrError(`the sources are written for Java ${source}, which a JVM_TARGET of ${jvmTarget} cannot run`).withHelp(
      `set JVM_TARGET to jvm${source} or later`
    );
  }
  return source;
}

/** @return `packages` and every package they reach, each once, nearest first. */
function closureOf(packages: readonly PackageFileSet[]): PackageFileSet[] {
  const seen = new Set<PackageFileSet>();
  const queue = [...packages];
  const ordered: PackageFileSet[] = [];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (!seen.has(next)) {
      seen.add(next);
      ordered.push(next);
      queue.push(...next.packages);
    }
  }
  return ordered;
}

/**
 * Get the classpath `deps` make: the jars of every package they hold or
 * reach, nearest first, then any loose jars among them. Each is named where
 * it is laid out, `<package name>/<file>` (a loose jar by its own name), so
 * two packages' jars never collide.
 */
export function classpathOf(deps: readonly FileSet[]): Array<[string, IFile]> {
  const packages = closureOf(deps.filter((dep): dep is PackageFileSet => dep instanceof PackageFileSet));
  const jarsOf = (files: FileSet, under: string): Array<[string, IFile]> =>
    [...files].filter(([name]) => name.endsWith(".jar")).map(([name, file]) => [under === "" ? name : `${under}/${name}`, file]);
  const loose = deps.filter(dep => !(dep instanceof PackageFileSet) && !(dep instanceof Flag));
  return [...packages.flatMap(pkg => jarsOf(pkg, pkg.packageName ?? "")), ...loose.flatMap(files => jarsOf(files, ""))];
}

/**
 * Materialize the target's annotation processors (`processors`). They are a
 * tool of the compile, so they are read when it is evaluated, not as a
 * requirement, and resolved as a collection of their own, permissively.
 */
export function processorsOf(context: TargetContext): Computable<FileSet[]> {
  return context
    .getFileProperty("processors")
    .then(sources => context.materializeSources(sources, PERMISSIVE_RESOLUTION))
    .then(materialized => materialized.filter((source): source is FileSet => source instanceof FileSet));
}

/** @return the class `entry` names (`com/example/Main.java` → `com.example.Main`), or undefined where there is none. */
export function mainClassOf(entry: readonly FileSet[]): string | undefined {
  const names = entry.flatMap(files => [...files].map(([name]) => name));
  if (names.length === 0) {
    return undefined;
  }
  if (names.length > 1 || !names[0].endsWith(".java")) {
    throw new FabrError(`entry must name one .java source, the class the program starts in; it names ${names.join(", ")}`);
  }
  return names[0].slice(0, -".java".length).replace(/\//g, ".");
}

/**
 * Make a jar manifest of `attributes`, in order, each line wrapped at the 72
 * bytes the format allows (a continuation starts with a space).
 */
export function manifestFile(attributes: ReadonlyArray<[string, string]>): IFile {
  const lines = attributes.flatMap(([name, value]) => {
    const line = Buffer.from(`${name}: ${value}`, "utf8");
    const wrapped: string[] = [];
    let start = 0;
    let width = 72;
    while (start < line.length) {
      let end = Math.min(start + width, line.length);
      /* Never split a UTF-8 sequence: back up over continuation bytes. */
      while (end < line.length && (line[end] & 0xc0) === 0x80) {
        end--;
      }
      wrapped.push((start === 0 ? "" : " ") + line.subarray(start, end).toString("utf8"));
      start = end;
      width = 71;
    }
    return wrapped;
  });
  return MemoryFile.from([...lines, "", ""].join("\r\n"));
}

/** Read a manifest's main section: each attribute's value, its continuation lines joined. */
export function manifestAttributes(text: string): Map<string, string> {
  const attributes = new Map<string, string>();
  let last: string | undefined;
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line === "") {
      break;
    }
    if (line.startsWith(" ") && last !== undefined) {
      attributes.set(last, attributes.get(last)! + line.substring(1));
      continue;
    }
    const colon = line.indexOf(": ");
    if (colon > 0) {
      last = line.substring(0, colon);
      attributes.set(last, line.substring(colon + 2));
    }
  }
  return attributes;
}

/** Get the `Main-Class` a package's jar names in its manifest, or undefined where it names none. */
export function jarMainClass(pkg: PackageFileSet): Computable<string | undefined> {
  const jar = [...pkg].find(([name]) => name.endsWith(".jar"));
  if (jar === undefined) {
    return Computable.resolve(undefined);
  }
  return jar[1]
    .getBuffer()
    .then(buffer => readZipMember(buffer, MANIFEST_NAME))
    .then(manifest => (manifest === undefined ? undefined : manifestAttributes(manifest.toString("utf8")).get("Main-Class")));
}

/** Where the classpath's jars are laid out in a runnable's install. */
const LIB_DIR = "lib";
/** The jar `java -jar` starts. */
const LAUNCHER = "launcher.jar";

/**
 * Make `pkg` runnable on `JAVA`, starting `mainClass`, with it and everything
 * it requires on the classpath. The install holds each jar under `lib/` and a
 * launcher jar whose manifest names the class and, relative to itself, the
 * classpath, so `java -jar` starts it from whatever directory.
 */
export function makeJarRunnable(context: ResolutionContext, pkg: PackageFileSet, mainClass: string): Computable<RunnableFileSet> {
  const classpath = classpathOf([pkg]).map(([name, file]): [string, IFile] => [path.posix.join(LIB_DIR, name), file]);
  const manifest = manifestFile([
    ["Manifest-Version", "1.0"],
    ["Created-By", "fabr"],
    ["Main-Class", mainClass],
    ["Class-Path", classpath.map(([name]) => encodeURI(name)).join(" ")],
  ]);
  return packToZip(new FileSet(new Map([[MANIFEST_NAME, manifest]])), { first: [MANIFEST_NAME] }).then(launcher => {
    const install = new FileSet(new Map([...classpath, [LAUNCHER, new MemoryFile(launcher)]]));
    return context.launchedBy(RunnableFileSet.forEntry(install, LAUNCHER), "JAVA", ["-jar"]);
  });
}

/** Write the jar named by the action's `name` from its `files`, the manifest first. */
function runJar(action: BuildAction, ctx: ActionContext, report: ITaskReport): Computable<BuildResult> {
  const name = stringConfig(action, "name");
  return packToZip(fileSetInput(action, "files"), { first: [MANIFEST_NAME] }).then(jar =>
    ctx
      .admit(report, () => {
        fs.writeFileSync(path.join(ctx.workDir, name), jar);
        return getResultFileSet(ctx.workDir, name);
      })
      .then(result => ({ result }))
  );
}

export const JAR_ACTION: IBuildActionDefinition = { id: "java:jar", version: 1, run: runJar };

/** Make the action writing `files` as the jar `name`. */
export function createJarAction(files: FileSet, name: string): BuildAction {
  return new BuildAction(JAR_ACTION, { files }, { name });
}
