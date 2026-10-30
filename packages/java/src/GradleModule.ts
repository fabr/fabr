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
 * Gradle Module Metadata: the `.module` file Gradle publishes beside a POM,
 * which describes a version as variants, each with its own attributes,
 * dependencies and files. A package whose POM carries Gradle's marker is read
 * from its `.module`: the variant a Java program runs with is selected, and its
 * dependencies and files are the package's.
 */

import { FabrError, parseJson, Requirement, toJsonObject } from "@fabr-build/core";
import { mavenName } from "./MavenProtocol";
import { parseMavenConstraint, rangeExcluding } from "./MavenVersion";

/** The comment Gradle writes in a POM it publishes with a `.module` beside it. */
export const GRADLE_METADATA_MARKER = "do_not_remove: published-with-gradle-metadata";

/** A version's variants, as its `.module` describes them. */
export interface GradleModule {
  /** The module the document describes, `<group>:<module>`, where it says. */
  readonly component?: string;
  readonly variants: readonly GradleVariant[];
}

/** One way of using a version: its attributes, and what it requires and holds. */
export interface GradleVariant {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
  /** The module that holds this variant instead, where another does. */
  readonly availableAt?: { readonly group: string; readonly module: string; readonly version: string };
  readonly dependencies: readonly GradleDependency[];
  readonly dependencyConstraints: readonly GradleDependency[];
  readonly files: readonly GradleFile[];
  /** The capabilities it provides, `<group>:<name>`; none stated is the module's own. */
  readonly capabilities: readonly string[];
}

/** A dependency, or a dependency constraint, of a variant. */
export interface GradleDependency {
  readonly group: string;
  readonly module: string;
  readonly requires?: string;
  readonly strictly?: string;
  readonly prefers?: string;
  /** The versions it rejects: each a version, or a range. */
  readonly rejects: readonly string[];
  readonly attributes: ReadonlyMap<string, string>;
  /** The file of the module it names, by classifier and extension, where it names one beside its artifact. */
  readonly artifactSelector?: { readonly classifier?: string; readonly extension?: string };
  /** Whether it asks for a capability of the module other than its own, such as its test fixtures. */
  readonly requestsCapabilities: boolean;
}

/** A file of a variant: its name, where it is relative to the `.module`, and its SHA-1 where stated. */
export interface GradleFile {
  readonly name: string;
  readonly url: string;
  readonly sha1?: string;
}

/** Read a `.module` document, `text`, published at `what`. */
export function parseGradleModule(text: string, what: string): GradleModule {
  return parseJson(text, what, toGradleModule);
}

/** Convert a `.module` document to its variants. */
export function toGradleModule(json: unknown): GradleModule {
  const document = toJsonObject(json);
  if (typeof document.formatVersion !== "string" || !document.formatVersion.startsWith("1.")) {
    throw new FabrError(`its formatVersion is ${JSON.stringify(document.formatVersion)}, where fabr reads 1.x`);
  }
  const component = document.component === undefined ? undefined : toJsonObject(document.component);
  return {
    ...(component === undefined ? {} : { component: `${stringOf(component.group, "its component's group")}:${stringOf(component.module, "its component's module")}` }),
    variants: arrayOf(document.variants, "variants").map(toVariant),
  };
}

function toVariant(json: unknown): GradleVariant {
  const variant = toJsonObject(json);
  const name = stringOf(variant.name, "a variant's name");
  const availableAt = variant["available-at"];
  return {
    name,
    attributes: attributesOf(variant.attributes),
    ...(availableAt === undefined
      ? {}
      : {
          availableAt: {
            group: stringOf(toJsonObject(availableAt).group, `${name}'s available-at group`),
            module: stringOf(toJsonObject(availableAt).module, `${name}'s available-at module`),
            version: stringOf(toJsonObject(availableAt).version, `${name}'s available-at version`),
          },
        }),
    dependencies: arrayOf(variant.dependencies, `${name}'s dependencies`).map(toDependency),
    dependencyConstraints: arrayOf(variant.dependencyConstraints, `${name}'s dependencyConstraints`).map(toDependency),
    files: arrayOf(variant.files, `${name}'s files`).map(toFile),
    capabilities: arrayOf(variant.capabilities, `${name}'s capabilities`).map(capability => {
      const fields = toJsonObject(capability);
      return `${stringOf(fields.group, `${name}'s capability's group`)}:${stringOf(fields.name, `${name}'s capability's name`)}`;
    }),
  };
}

function toDependency(json: unknown): GradleDependency {
  const dependency = toJsonObject(json);
  const group = stringOf(dependency.group, "a dependency's group");
  const module = stringOf(dependency.module, "a dependency's module");
  const version = dependency.version === undefined ? {} : toJsonObject(dependency.version);
  const selector = toJsonObject(dependency.thirdPartyCompatibility ?? {}).artifactSelector;
  const optional = (value: unknown, what: string): string | undefined => (value === undefined ? undefined : stringOf(value, what));
  const requires = optional(version.requires, `${group}:${module}'s requires`);
  const strictly = optional(version.strictly, `${group}:${module}'s strictly`);
  const prefers = optional(version.prefers, `${group}:${module}'s prefers`);
  const rejects = arrayOf(version.rejects, `${group}:${module}'s rejects`).map(reject => stringOf(reject, `${group}:${module}'s rejects`));
  const classifier = selector === undefined ? undefined : optional(toJsonObject(selector).classifier, `${group}:${module}'s classifier`);
  const extension = selector === undefined ? undefined : optional(toJsonObject(selector).extension, `${group}:${module}'s extension`);
  return {
    group,
    module,
    ...(requires === undefined ? {} : { requires }),
    ...(strictly === undefined ? {} : { strictly }),
    ...(prefers === undefined ? {} : { prefers }),
    rejects,
    attributes: attributesOf(dependency.attributes),
    ...(selector === undefined ? {} : { artifactSelector: { ...(classifier === undefined ? {} : { classifier }), ...(extension === undefined ? {} : { extension }) } }),
    requestsCapabilities: arrayOf(dependency.requestedCapabilities, `${group}:${module}'s requestedCapabilities`).length > 0,
  };
}

function toFile(json: unknown): GradleFile {
  const file = toJsonObject(json);
  const name = stringOf(file.name, "a file's name");
  return { name, url: stringOf(file.url, `${name}'s url`), ...(typeof file.sha1 === "string" ? { sha1: file.sha1 } : {}) };
}

/** Read a variant's or a dependency's attributes, each value as text. */
function attributesOf(json: unknown): ReadonlyMap<string, string> {
  if (json === undefined) {
    return new Map();
  }
  return new Map(Object.entries(toJsonObject(json)).map(([key, value]) => [key, String(value)]));
}

function arrayOf(json: unknown, what: string): unknown[] {
  if (json === undefined) {
    return [];
  }
  if (!Array.isArray(json)) {
    throw new FabrError(`${what} is not a list`);
  }
  return json;
}

function stringOf(json: unknown, what: string): string {
  if (typeof json !== "string") {
    throw new FabrError(`${what} is not a string`);
  }
  return json;
}

/** The attributes a Java program asks of a library's variant, beside the JVM release it runs on. */
const RUNTIME_ATTRIBUTES = new Map([
  ["org.gradle.usage", "java-runtime"],
  ["org.gradle.libraryelements", "jar"],
  ["org.gradle.dependency.bundling", "external"],
  ["org.gradle.jvm.environment", "standard-jvm"],
  ["org.jetbrains.kotlin.platform.type", "jvm"],
]);

/**
 * Select the variant of `module` a Java program on Java `release` runs with,
 * as Gradle matches a runtime classpath's attributes: a library's, or where
 * the module has none, a platform's; providing the module's own capability,
 * not another such as its test fixtures; whose other attributes, where it
 * states them, are what a Java program asks for, and whose JVM version it can
 * run.
 * Of several, the one for the highest JVM version. `what` names the module in
 * a message.
 */
export function runtimeVariant(module: GradleModule, release: number, what: string): GradleVariant {
  const compatible = module.variants.filter(variant => {
    const runsOn = variant.attributes.get("org.gradle.jvm.version");
    const own = variant.capabilities.length === 0 || module.component === undefined || variant.capabilities.includes(module.component);
    return (
      own &&
      [...RUNTIME_ATTRIBUTES].every(([key, value]) => (variant.attributes.get(key) ?? value) === value) &&
      (runsOn === undefined || Number(runsOn) <= release)
    );
  });
  for (const category of ["library", "platform"]) {
    const of = compatible.filter(variant => (variant.attributes.get("org.gradle.category") ?? "library") === category);
    const highest = Math.max(...of.map(variant => Number(variant.attributes.get("org.gradle.jvm.version") ?? 0)));
    const best = of.filter(variant => Number(variant.attributes.get("org.gradle.jvm.version") ?? 0) === highest);
    if (best.length === 1) {
      return best[0];
    }
    if (best.length > 1) {
      throw new FabrError(`${what} has several variants a Java program on Java ${release} could run with: ${best.map(variant => variant.name).join(", ")}`);
    }
  }
  throw new FabrError(`${what} has no variant a Java program on Java ${release} can run with`).withHelp(
    `its variants are ${module.variants.map(variant => variant.name).join(", ")}; its .module may need a later JVM_TARGET`
  );
}

/**
 * @return the requirements `variant` states: each dependency, and each
 * dependency constraint as a floor without a demand, its version what it
 * requires, or strictly, a range or an exact version that is the only one
 * allowed. A variant another module holds requires that module.
 */
export function variantRequirements(variant: GradleVariant): Requirement[] {
  if (variant.availableAt !== undefined) {
    const { group, module, version } = variant.availableAt;
    return [{ name: mavenName(group, module), versionConstraint: version }];
  }
  return [
    ...variant.dependencies
      .filter(dependency => !dependency.requestsCapabilities)
      .map((dependency): Requirement => {
        const selector = dependency.artifactSelector;
        const extension = selector?.extension === undefined || selector.extension === "jar" ? "" : `@${selector.extension}`;
        const variantText = `${selector?.classifier ?? ""}${extension}`;
        return {
          name: mavenName(dependency.group, dependency.module),
          versionConstraint: versionOf(dependency),
          ...(variantText === "" ? {} : { variant: variantText }),
        };
      }),
    ...variant.dependencyConstraints.map((constraint): Requirement => ({ name: mavenName(constraint.group, constraint.module), versionConstraint: versionOf(constraint), bom: true })),
  ];
}

/**
 * @return the Maven version constraint a dependency's version states:
 * `strictly` as a range, an exact one as `[v]`; else `requires`, else
 * `prefers`; with the versions it `rejects` cut out of it.
 */
function versionOf(dependency: GradleDependency): string | undefined {
  const { strictly } = dependency;
  const stated = strictly !== undefined ? (/^[[(]/.test(strictly) ? strictly : `[${strictly}]`) : (dependency.requires ?? dependency.prefers);
  if (dependency.rejects.length === 0) {
    return stated;
  }
  const allowed = rangeExcluding(parseMavenConstraint(stated ?? "(,)"), dependency.rejects.map(parseMavenConstraint));
  if (allowed === undefined) {
    throw new FabrError(`${dependency.group}:${dependency.module} rejects every version it requires`);
  }
  return allowed;
}

/** @return true if a POM's text, `text`, says Gradle published a `.module` beside it, otherwise false. */
export function hasGradleMetadata(text: string): boolean {
  return text.includes(GRADLE_METADATA_MARKER);
}
