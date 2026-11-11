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
 */

/**
 * A target's description, as a rule's `describe` makes it: what tools other than
 * fabr — an editor, a language server — are told about it, in the Build Server
 * Protocol's own shapes (https://build-server-protocol.github.io/docs/specification).
 * A rule's `describe` makes one with {@link describeTarget}, adding its
 * language's payload, and yields it as {@link DESCRIPTION_FILE} beside whatever
 * files the payload names.
 *
 * A description is content, so it names nothing on the machine it was made
 * on: a project file or directory is written `./<path from the project root>`
 * (its source path), a file of the description itself by its name within it.
 * Whoever serves a description makes them absolute.
 */

import * as path from "path";
import { Computable } from "../core/Computable";
import { FileSet } from "../core/FileSet";
import { MemoryFile } from "../core/MemoryFS";
import type { ResolvedRequirements } from "../context/Collection";
import { TargetRef } from "../core/TargetRef";
import type { TargetContext } from "../context/TargetContext";
import { FabrError } from "../core/Errors";
import { isJsonObject } from "./Json";

/** The name a target's description has among its `describe` result's files. */
export const DESCRIPTION_FILE = "describe.json";

/** The operations a target is described under: those that compile something. */
export const DESCRIBED_OPERATIONS: readonly string[] = ["build", "test"];

/** Where a description of a target made from a package (its `extends`) holds
 * that package's own description. */
export const DESCRIPTION_EXTENDS = "extends";

/** The scheme a described target's identifier is written in: `fabr:<target name>`. */
export const TARGET_URI_SCHEME = "fabr";

/** BSP's `BuildTargetIdentifier`. */
export interface IBuildTargetIdentifier {
  uri: string;
}

/** BSP's `BuildTargetCapabilities`. */
export interface IBuildTargetCapabilities {
  canCompile: boolean;
  canTest: boolean;
  canRun: boolean;
  canDebug: boolean;
}

/** BSP's `BuildTarget`. */
export interface IBuildTarget {
  id: IBuildTargetIdentifier;
  displayName: string;
  baseDirectory?: string;
  tags: string[];
  languageIds: string[];
  dependencies: IBuildTargetIdentifier[];
  capabilities: IBuildTargetCapabilities;
  dataKind?: string;
  data?: unknown;
}

/** BSP's `SourceItem`; `kind` 1 is a file, 2 a directory. */
export interface ISourceItem {
  uri: string;
  kind: 1 | 2;
  generated: boolean;
}

/** BSP's `JavacOptionsItem`, without its target: how a Java compiler is invoked
 * on the target's sources. `classpath` and `classDirectory` are written as a
 * description writes a path. */
export interface IJavacOptions {
  options: string[];
  classpath: string[];
  classDirectory: string;
}

/** A target's description: its BSP target, its sources, and the answers to
 * the language requests BSP makes of a target of its kind. */
export interface IDescription {
  target: IBuildTarget;
  sources: ISourceItem[];
  /** BSP's `SourcesItem.roots`: the directories the sources are named from. */
  roots: string[];
  /** The answer to `buildTarget/javacOptions`. */
  javacOptions?: IJavacOptions;
}

/** What a plugin's `describe` rule adds to what core states of every target. */
export interface IDescribeOptions {
  /** The target's sources, as the rule read them: each file of the project's
   * own tree among them is listed. */
  sources: FileSet[];
  /** BSP's tags: `library`, `application`, `test`, …. */
  tags?: string[];
  /** The languages of the sources, by LSP language identifier. */
  languageIds?: string[];
  /** The kind of `data`, BSP's own (`jvm`, `cpp`) or a plugin's. */
  dataKind?: string;
  /** The language payload. */
  data?: unknown;
  /** How a Java compiler is invoked on the sources. */
  javacOptions?: IJavacOptions;
}

/** @return the identifier the description of target `name` has. */
export function targetIdentifier(name: string): IBuildTargetIdentifier {
  return { uri: `${TARGET_URI_SCHEME}:${name}` };
}

/**
 * Describe the target `context` evaluates: its identifier and name, the
 * directory of the file declaring it, which operations its type has rules for,
 * the targets among `requirements` (what its rule was given), and the sources
 * `options` names with the directories they are named from, with the payload
 * and answers `options` gives.
 */
export function describeTarget(
  context: TargetContext,
  requirements: ResolvedRequirements,
  options: IDescribeOptions
): Computable<IDescription> {
  const declared = context.getDeclaredContext();
  const name = declared.name;
  return Computable.resolve(undefined).then(() => {
    const dependencies = new Set<string>();
    for (const references of requirements.references.values()) {
      for (const reference of references) {
        /* A target under another operation may require its own build: a test
         * target its package's. */
        if (reference instanceof TargetRef) {
          dependencies.add(reference.name);
        }
      }
    }
    const file = declared.target.source.file;
    const target: IBuildTarget = {
      id: targetIdentifier(name),
      displayName: name,
      baseDirectory: projectPath(path.posix.dirname(file)),
      tags: options.tags ?? [],
      languageIds: options.languageIds ?? [],
      dependencies: [...dependencies].sort().map(targetIdentifier),
      capabilities: {
        canCompile: context.hasTargetRule(name, "build"),
        canTest: context.hasTargetRule(name, "test"),
        canRun: context.hasTargetRule(name, "run"),
        canDebug: false,
      },
      ...(options.dataKind === undefined ? {} : { dataKind: options.dataKind }),
      ...(options.data === undefined ? {} : { data: options.data }),
    };
    const sources = new Set<string>();
    const roots = new Set<string>();
    for (const set of options.sources) {
      for (const [name, sourcePath] of set.sourcePaths) {
        if (sourcePath.startsWith("./")) {
          sources.add(sourcePath);
          if (sourcePath.endsWith(`/${name}`)) {
            roots.add(sourcePath.slice(0, sourcePath.length - name.length));
          }
        }
      }
    }
    return {
      target,
      sources: [...sources].sort().map((uri): ISourceItem => ({ uri, kind: 1, generated: false })),
      roots: [...roots].sort(),
      ...(options.javacOptions === undefined ? {} : { javacOptions: options.javacOptions }),
    };
  });
}

/** @return true if `value` is an array of strings, otherwise false. */
function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(each => typeof each === "string");
}

/** @return true if `value` is an array of objects each with a string `uri`, otherwise false. */
function isIdentifiers(value: unknown): value is IBuildTargetIdentifier[] {
  return Array.isArray(value) && value.every(each => isJsonObject(each) && typeof each.uri === "string");
}

/** Convert a description as a `describe` result's {@link DESCRIPTION_FILE} holds it. */
export function toDescription(json: unknown): IDescription {
  if (!isJsonObject(json) || !isJsonObject(json.target)) {
    throw new FabrError("expected a description with a target");
  }
  const target = json.target;
  const capabilities = target.capabilities;
  if (
    !isIdentifiers([target.id]) ||
    typeof target.displayName !== "string" ||
    (target.baseDirectory !== undefined && typeof target.baseDirectory !== "string") ||
    !isStrings(target.tags) ||
    !isStrings(target.languageIds) ||
    !isIdentifiers(target.dependencies) ||
    !isJsonObject(capabilities) ||
    !["canCompile", "canTest", "canRun", "canDebug"].every(key => typeof capabilities[key] === "boolean") ||
    (target.dataKind !== undefined && typeof target.dataKind !== "string")
  ) {
    throw new FabrError("expected a description's target to be a BSP build target");
  }
  if (
    !Array.isArray(json.sources) ||
    !json.sources.every(
      each =>
        isJsonObject(each) &&
        typeof each.uri === "string" &&
        (each.kind === 1 || each.kind === 2) &&
        typeof each.generated === "boolean"
    )
  ) {
    throw new FabrError("expected a description's sources to be BSP source items");
  }
  if (!isStrings(json.roots)) {
    throw new FabrError("expected a description's roots to be strings");
  }
  const javac = json.javacOptions;
  if (
    javac !== undefined &&
    !(isJsonObject(javac) && isStrings(javac.options) && isStrings(javac.classpath) && typeof javac.classDirectory === "string")
  ) {
    throw new FabrError("expected a description's javacOptions to be BSP javac options");
  }
  return json as unknown as IDescription;
}

/** @return `description` as the file a `describe` result holds it in. */
export function descriptionFile(description: IDescription): FileSet {
  return FileSet.layout({ [DESCRIPTION_FILE]: MemoryFile.from(JSON.stringify(description, null, 2) + "\n") });
}

/** @return `dir`, a directory relative to the project root, as a description writes it. */
function projectPath(dir: string): string {
  return dir === "." || dir === "" ? "./" : `./${dir}/`;
}
