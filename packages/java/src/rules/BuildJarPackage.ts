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
 * The jar_package[build] rule: compile the sources against the resolved deps,
 * running the annotation processors, and package the classes and resources
 * as a jar: a package named as the target is, requiring its `deps` and its
 * provided ones.
 */

import * as path from "path";
import {
  BUILD_OVERRIDE,
  Computable,
  defineRule,
  Dependency,
  dependencyName,
  FabrError,
  EMPTY_FILESET,
  FileSet,
  PackageFileSet,
  PropertyMap,
  Provided,
  RuleResult,
  TargetContext,
} from "@fabr-build/core";
import { checkMainClass, createJarAction, MANIFEST_NAME, manifestFile, processorsOf } from "../JarPackage";

interface JarInputs {
  srcs: FileSet[];
  resources: FileSet[];
  dependencies: FileSet[];
  provided: FileSet[];
  optional_provided: FileSet[];
  compile_deps: FileSet[];
}

/** The edges to the packages among the requirements the jar passes on. */
interface JarEdges {
  dependencies: ReadonlyArray<Dependency<PackageFileSet>>;
  provided: ReadonlyArray<Dependency<PackageFileSet>>;
  optional_provided: ReadonlyArray<Dependency<PackageFileSet>>;
}

/** The `jar_package` rule, under `build`. */
export default defineRule({
  /* `dependencies`, `provided` and `optional_provided` are what the package
   * passes on; `compile_deps` is compiled against and private to the build. */
  requirements(context) {
    return {
      srcs: context.getFileProperty("srcs"),
      resources: context.getFileProperty("resources"),
      dependencies: context.getPackageProperty("deps"),
      provided: context.getPackageProperty("provided_deps"),
      optional_provided: context.getPackageProperty("optional_provided_deps"),
      compile_deps: context.getPackageProperty("compile_deps"),
    };
  },
  evaluateResolved(context, requirements) {
    return Computable.forAll(
      [
        requirements.materializeAll(),
        requirements.packages("dependencies"),
        requirements.packages("provided"),
        requirements.packages("optional_provided"),
        context.getProperty("main_class"),
        context.getMap("manifest"),
      ],
      (inputs, dependencies, provided, optional_provided, mainClass, manifest) =>
        buildJar(context, inputs, { dependencies, provided, optional_provided }, manifestAttributesOf(context.name, mainClass?.toString(), manifest))
    );
  },
});

/** @return the name of the jar a target builds: the last part of its name (`org.slf4j/slf4j-api` → `slf4j-api.jar`). */
export function jarNameOf(target: string): string {
  return `${path.posix.basename(target)}.jar`;
}

/** Make the target's package: `files`, requiring what `edges` lead to, the provided ones named so. */
function packageOf(context: TargetContext, files: FileSet, edges: JarEdges): PackageFileSet {
  return new PackageFileSet(
    files,
    context.name,
    undefined,
    [...edges.dependencies, ...edges.provided, ...edges.optional_provided],
    undefined,
    new Map([
      ...edges.provided.map((dep): [string, Provided] => [dependencyName(dep), "expected"]),
      ...edges.optional_provided.map((dep): [string, Provided] => [dependencyName(dep), "optional"]),
    ])
  );
}

/** What a jar's manifest says besides what fabr writes: the class it starts in, checked against the jar, and the attributes `manifest` writes. */
interface JarAttributes {
  mainClass?: string;
  written: Array<[string, string]>;
}

/**
 * @return the attributes the jar's manifest is given: `main_class` as its
 * `Main-Class`, and each of `manifest`'s entries, a string, in order. A
 * `Main-Class` may come from either, not both, and `Manifest-Version` is the
 * format's.
 */
function manifestAttributesOf(name: string, mainClass: string | undefined, manifest: PropertyMap): JarAttributes {
  const written = [...manifest].map(([key, value]): [string, string] => {
    if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
      throw new FabrError(`${name}'s manifest attribute '${key}' is a string, not a block`);
    }
    return [key, (value as string[]).join(" ")];
  });
  const keys = written.map(([key]) => key.toLowerCase());
  if (keys.includes("manifest-version")) {
    throw new FabrError(`${name}'s manifest cannot set Manifest-Version: the jar format's own`);
  }
  if (mainClass !== undefined && keys.includes("main-class")) {
    throw new FabrError(`${name} names its Main-Class twice, as main_class and in its manifest`).withHelp("keep one of them");
  }
  return { mainClass, written };
}

function buildJar(context: TargetContext, inputs: JarInputs, edges: JarEdges, attributes: JarAttributes): Computable<RuleResult> {
  const { mainClass } = attributes;
  const { srcs, resources } = inputs;
  const sources = FileSet.unionAll(...srcs);
  const runtime = [...inputs.dependencies, ...inputs.provided, ...inputs.optional_provided];
  const compileDeps = [...inputs.dependencies, ...inputs.provided, ...inputs.optional_provided, ...inputs.compile_deps];
  const classes = sources.isEmpty()
    ? Computable.resolve(EMPTY_FILESET)
    : processorsOf(context).then(processors =>
        context.subTarget(
          "java_compile",
          { srcs: sources, deps: compileDeps, ...(processors.length === 0 ? {} : { processors }) },
          { label: "Compiling", constraints: BUILD_OVERRIDE }
        )
      );
  return classes.then(compiled =>
    (mainClass === undefined ? Computable.resolve(undefined) : checkMainClass(context.name, mainClass, compiled, runtime)).then(() => {
    const manifest = manifestFile([
      ["Manifest-Version", "1.0"],
      ["Created-By", "fabr"],
      ...(mainClass === undefined ? [] : [["Main-Class", mainClass] as [string, string]]),
      ...attributes.written,
    ]);
    const contents = FileSet.unionAll(compiled, ...resources, new FileSet(new Map([[MANIFEST_NAME, manifest]])));
    return createJarAction(contents, jarNameOf(context.name)).withReshape(files => packageOf(context, files, edges));
    })
  );
}
