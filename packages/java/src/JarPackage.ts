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
  readZipMembers,
  ResolutionContext,
  ArgumentPart,
  RunnableArgument,
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

/**
 * @return the package a Java source declares (`package com.example;` →
 * `com.example`), or "" for the unnamed package: its first declaration,
 * after any comments and package annotations.
 */
export function packageOf(source: string): string {
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, " ");
  const declared = /^\s*(?:@[\w.]+\s*(?:\([^)]*\))?\s*)*package\s+([\w$]+(?:\s*\.\s*[\w$]+)*)\s*;/.exec(code);
  return declared === null ? "" : declared[1].replace(/\s+/g, "");
}

/** A module descriptor's name in a jar: at its root, or for a release of a multi-release jar. */
function isDescriptor(name: string): boolean {
  return name === "module-info.class" || /^META-INF\/versions\/\d+\/module-info\.class$/.test(name);
}

/**
 * @return what `jar` is to the module system: an `explicit` module (it holds a
 * module descriptor), an `automatic` one its manifest names
 * (`Automatic-Module-Name`), or undefined for neither.
 */
export function moduleKindOf(jar: IFile): Computable<"explicit" | "automatic" | undefined> {
  return jar
    .getBuffer()
    .then(buffer => readZipMembers(buffer, name => isDescriptor(name) || name === MANIFEST_NAME))
    .then(members => {
      if ([...members.keys()].some(isDescriptor)) {
        return "explicit";
      }
      const manifest = members.get(MANIFEST_NAME);
      return manifest !== undefined && manifestAttributes(manifest.toString("utf8")).has("Automatic-Module-Name") ? "automatic" : undefined;
    });
}

/** @return true if `jar` is a module, explicit or automatic, otherwise false: what a module's compile puts on the module path. */
export function isModularJar(jar: IFile): Computable<boolean> {
  return moduleKindOf(jar).then(kind => kind !== undefined);
}

/** @return the name of the class file `className` is compiled to (`com.example.Main` → `com/example/Main.class`). */
export function classFileOf(className: string): string {
  return `${className.replace(/\./g, "/")}.class`;
}

/**
 * Check that `mainClass` is a class the jar holds (`classes`) or one of the
 * jars it runs with (`deps`) does, reporting it as `name`'s otherwise.
 */
export function checkMainClass(name: string, mainClass: string, classes: FileSet, deps: readonly FileSet[]): Computable<void> {
  const classFile = classFileOf(mainClass);
  if (classes.getFile(classFile) !== undefined) {
    return Computable.resolve(undefined);
  }
  return Computable.forAll(
    classpathOf(deps).map(([, jar]) => jar.getBuffer().then(buffer => readZipMember(buffer, classFile))),
    (...found) => {
      if (found.every(member => member === undefined)) {
        throw new FabrError(`${name}'s main_class '${mainClass}' is no class of its sources or of what it requires`);
      }
    }
  );
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

/** Where a program's own compiled classes are laid out in its install. */
const CLASSES_DIR = "classes";

/** What a Java program runs with besides its packages: its own classes, its arguments and the JVM's. */
export interface JavaProgramOptions {
  /** Classes compiled for the program itself, first on the classpath. */
  classes?: FileSet;
  /** Arguments given the program, before the caller's. */
  args?: readonly string[];
  /** Arguments given the JVM, before the program. */
  jvmArgs?: readonly string[];
  /** Java agents the program runs with: each one's own jar is given the JVM
   *  as a `-javaagent`, and what it requires joins the classpath. */
  agents?: readonly FileSet[];
}

/** Where a program's jars go: on the module path, where it runs as a module, and on the classpath. */
interface Placement {
  modulePath?: Array<[string, IFile]>;
  classpath: Array<[string, IFile]>;
}

/**
 * Make a program runnable on `JAVA`, starting `mainClass`, with `deps` and
 * everything they require, after any `classes` of its own. The install holds
 * each jar under `lib/` and a launcher jar whose manifest names the class and,
 * relative to itself, the classpath, so `java -jar` starts it from whatever
 * directory. A program whose own code is a module (its classes, or else its
 * own jar, hold a module descriptor) runs as one: it and the jars that are
 * modules go on the module path, the rest on the launcher's classpath.
 */
export function makeJarRunnable(
  context: ResolutionContext,
  deps: readonly FileSet[],
  mainClass: string,
  { classes, args = [], jvmArgs = [], agents = [] }: JavaProgramOptions = {}
): Computable<RunnableFileSet> {
  const jars = classpathOf([...deps, ...agents]).map(([name, file]): [string, IFile] => [path.posix.join(LIB_DIR, name), file]);
  /* Each agent's own jar, where the classpath lays it out: its package's, or a loose jar by its name. */
  const agentArgs: RunnableArgument[] = agents.flatMap(agent =>
    [...agent]
      .filter(([name]) => name.endsWith(".jar"))
      .map(([name]): RunnableArgument => [
        "-javaagent:",
        { installPath: path.posix.join(LIB_DIR, agent instanceof PackageFileSet && agent.packageName !== undefined ? `${agent.packageName}/${name}` : name) },
      ])
  );
  const ownClasses = classes !== undefined && !classes.isEmpty();
  const programJar = jars[0]?.[1];
  const modular = ownClasses
    ? Computable.resolve(classes.getFile("module-info.class") !== undefined)
    : programJar === undefined
      ? Computable.resolve(false)
      : moduleKindOf(programJar).then(kind => kind === "explicit");
  return modular
    .then(
      (isModule): Placement | Computable<Placement> =>
        isModule
          ? Computable.forAll(
              jars.map(([, file]) => isModularJar(file)),
              (...modules: boolean[]): Placement => ({
                modulePath: jars.filter((_, index) => modules[index]),
                classpath: jars.filter((_, index) => !modules[index]),
              })
            )
          : { classpath: jars }
    )
    .then(({ modulePath, classpath }) => {
      const own = !ownClasses ? [] : [`${CLASSES_DIR}/`];
      const manifest = manifestFile([
        ["Manifest-Version", "1.0"],
        ["Created-By", "fabr"],
        ["Main-Class", mainClass],
        ["Class-Path", [...(modulePath === undefined ? own : []), ...classpath.map(([name]) => encodeURI(name))].join(" ")],
      ]);
      /* `-jar` loads the launcher's Main-Class from the module path's modules where they are resolved. */
      const moduleArgs: RunnableArgument[] =
        modulePath === undefined
          ? []
          : [
              "--module-path",
              [...(ownClasses ? [CLASSES_DIR] : []), ...modulePath.map(([name]) => name)].flatMap((installPath, index): ArgumentPart[] =>
                index === 0 ? [{ installPath }] : [path.delimiter, { installPath }]
              ),
              "--add-modules",
              "ALL-MODULE-PATH",
            ];
      return packToZip(new FileSet(new Map([[MANIFEST_NAME, manifest]])), { first: [MANIFEST_NAME] }).then(launcher => {
        const install = FileSet.unionAll(
          new FileSet(new Map([...jars, [LAUNCHER, new MemoryFile(launcher)]])),
          ownClasses ? classes.mountedAt(CLASSES_DIR) : new FileSet(new Map())
        );
        return context.launchedBy(RunnableFileSet.forEntry(install, LAUNCHER, [...args]), "JAVA", [...jvmArgs, ...agentArgs, ...moduleArgs, "-jar"]);
      });
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

export const JAR_ACTION: IBuildActionDefinition = { id: "java:jar", version: 4, run: runJar };

/** Make the action writing `files` as the jar `name`. */
export function createJarAction(files: FileSet, name: string): BuildAction {
  return new BuildAction(JAR_ACTION, { files }, { name });
}
