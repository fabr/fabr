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
 * POMs as a Maven repository publishes them, and the effective POM Maven
 * builds from one: the parent chain inherited, properties interpolated, and
 * `dependencyManagement` (with the BOMs it imports) filling in the versions
 * and scopes the declared dependencies leave out. Profiles are not applied.
 */

import { Computable, FabrError } from "@fabr-build/core";
import { parseXml, XmlElement, xmlChild, xmlChildren, xmlText } from "./Xml";

/** An artifact's address in a Maven repository. */
export interface PomCoordinate {
  readonly groupId: string;
  readonly artifactId: string;
  readonly version: string;
}

export interface PomDependency {
  readonly groupId: string;
  readonly artifactId: string;
  readonly version?: string;
  readonly scope?: string;
  readonly type?: string;
  readonly classifier?: string;
  readonly optional: boolean;
}

/** A POM as written: nothing inherited, interpolated or managed. */
export interface RawPom {
  readonly groupId?: string;
  readonly artifactId: string;
  readonly version?: string;
  readonly packaging?: string;
  readonly parent?: PomCoordinate;
  readonly properties: ReadonlyMap<string, string>;
  readonly dependencies: readonly PomDependency[];
  readonly dependencyManagement: readonly PomDependency[];
}

export interface EffectivePom extends PomCoordinate {
  readonly packaging: string;
  /** The declared dependencies, own and inherited, interpolated and managed. */
  readonly dependencies: readonly PomDependency[];
  /** The managed dependencies, own, inherited and imported, interpolated. */
  readonly dependencyManagement: readonly PomDependency[];
}

/** Load the POM published at a coordinate. */
export type PomLoader = (coordinate: PomCoordinate) => Computable<RawPom>;

/* How deep a parent chain or import nesting may go before it is taken for a cycle. */
const MAX_DEPTH = 32;

function readDependency(element: XmlElement, what: string): PomDependency {
  const groupId = xmlText(element, "groupId");
  const artifactId = xmlText(element, "artifactId");
  if (groupId === undefined || artifactId === undefined) {
    throw new FabrError(`${what}: a dependency is missing its groupId or artifactId`);
  }
  const version = xmlText(element, "version");
  const scope = xmlText(element, "scope");
  const type = xmlText(element, "type");
  const classifier = xmlText(element, "classifier");
  return {
    groupId,
    artifactId,
    ...(version === undefined ? {} : { version }),
    ...(scope === undefined ? {} : { scope }),
    ...(type === undefined ? {} : { type }),
    ...(classifier === undefined ? {} : { classifier }),
    optional: xmlText(element, "optional") === "true",
  };
}

/** Parse a POM's text. Throws, naming `what`, on one with no `artifactId`. */
export function parsePom(text: string, what: string): RawPom {
  const project = parseXml(text, what);
  if (project.name !== "project") {
    throw new FabrError(`${what} is not a POM: its root element is <${project.name}>`);
  }
  const artifactId = xmlText(project, "artifactId");
  if (artifactId === undefined) {
    throw new FabrError(`${what} is not a POM: it has no artifactId`);
  }
  const parentElement = xmlChild(project, "parent");
  let parent: PomCoordinate | undefined;
  if (parentElement !== undefined) {
    const groupId = xmlText(parentElement, "groupId");
    const parentArtifact = xmlText(parentElement, "artifactId");
    const version = xmlText(parentElement, "version");
    if (groupId === undefined || parentArtifact === undefined || version === undefined) {
      throw new FabrError(`${what}: its parent is missing its groupId, artifactId or version`);
    }
    parent = { groupId, artifactId: parentArtifact, version };
  }
  const properties = new Map(xmlChild(project, "properties")?.children.map(property => [property.name, property.text]) ?? []);
  const dependencies = xmlChildren(xmlChild(project, "dependencies"), "dependency").map(element => readDependency(element, what));
  const managed = xmlChildren(xmlChild(xmlChild(project, "dependencyManagement"), "dependencies"), "dependency").map(element =>
    readDependency(element, what)
  );
  const groupId = xmlText(project, "groupId");
  const version = xmlText(project, "version");
  const packaging = xmlText(project, "packaging");
  return {
    ...(groupId === undefined ? {} : { groupId }),
    artifactId,
    ...(version === undefined ? {} : { version }),
    ...(packaging === undefined ? {} : { packaging }),
    ...(parent === undefined ? {} : { parent }),
    properties,
    dependencies,
    dependencyManagement: managed,
  };
}

/** Name a coordinate as Maven writes it: `group:artifact:version`. */
export function coordinateText({ groupId, artifactId, version }: PomCoordinate): string {
  return `${groupId}:${artifactId}:${version}`;
}

/** @return the key `dependencyManagement` matches a dependency by. */
function managementKey(dependency: PomDependency): string {
  return `${dependency.groupId}:${dependency.artifactId}:${dependency.type ?? "jar"}:${dependency.classifier ?? ""}`;
}

/** Load the parent chain of `pom`, nearest first, the POM itself at its head. */
function parentChain(pom: RawPom, load: PomLoader, what: string, depth = 0): Computable<RawPom[]> {
  if (pom.parent === undefined) {
    return Computable.resolve([pom]);
  }
  if (depth >= MAX_DEPTH) {
    throw new FabrError(`${what}: its parent chain is more than ${MAX_DEPTH} deep (a cycle?)`);
  }
  return load(pom.parent).then(parent => parentChain(parent, load, what, depth + 1).then(rest => [pom, ...rest]));
}

/**
 * Make an interpolator over `properties` and the project's own coordinates:
 * `${name}` is replaced by its value, itself interpolated. A reference to
 * nothing known (`${env.HOME}`, `${java.version}`) is left as written.
 */
function interpolator(properties: ReadonlyMap<string, string>, what: string): (text: string) => string {
  const expand = (text: string, seen: ReadonlySet<string>): string =>
    text.replace(/\$\{([^}]+)\}/g, (whole, name: string) => {
      const value = properties.get(name);
      if (value === undefined) {
        return whole;
      }
      if (seen.has(name)) {
        throw new FabrError(`${what}: property '${name}' refers to itself`);
      }
      return expand(value, new Set([...seen, name]));
    });
  return text => expand(text, new Set());
}

function interpolateDependency(dependency: PomDependency, interpolate: (text: string) => string): PomDependency {
  const optionalField = (value: string | undefined): string | undefined => (value === undefined ? undefined : interpolate(value));
  const version = optionalField(dependency.version);
  const scope = optionalField(dependency.scope);
  const type = optionalField(dependency.type);
  const classifier = optionalField(dependency.classifier);
  return {
    groupId: interpolate(dependency.groupId),
    artifactId: interpolate(dependency.artifactId),
    ...(version === undefined ? {} : { version }),
    ...(scope === undefined ? {} : { scope }),
    ...(type === undefined ? {} : { type }),
    ...(classifier === undefined ? {} : { classifier }),
    optional: dependency.optional,
  };
}

/** Merge dependencies by the key `dependencyManagement` matches on, the first of each key winning. */
function mergeManaged(...lists: ReadonlyArray<readonly PomDependency[]>): PomDependency[] {
  const merged = new Map<string, PomDependency>();
  for (const dependency of lists.flat()) {
    if (!merged.has(managementKey(dependency))) {
      merged.set(managementKey(dependency), dependency);
    }
  }
  return [...merged.values()];
}

/**
 * Build the effective POM of `pom`: what its parent chain gives it, its
 * properties interpolated, and its dependencies' missing versions and scopes
 * filled from its `dependencyManagement`, including the BOMs that imports.
 * Throws where a dependency is left with no version.
 */
export function effectivePom(pom: RawPom, load: PomLoader, what: string, depth = 0): Computable<EffectivePom> {
  if (depth >= MAX_DEPTH) {
    throw new FabrError(`${what}: its imported BOMs nest more than ${MAX_DEPTH} deep (a cycle?)`);
  }
  return parentChain(pom, load, what).then(chain => {
    const nearest = <T>(read: (pom: RawPom) => T | undefined): T | undefined => {
      for (const link of chain) {
        const value = read(link);
        if (value !== undefined) {
          return value;
        }
      }
      return undefined;
    };
    const groupId = nearest(link => link.groupId ?? link.parent?.groupId);
    const version = nearest(link => link.version ?? link.parent?.version);
    if (groupId === undefined || version === undefined) {
      throw new FabrError(`${what} states no groupId or version, and inherits none`);
    }
    const properties = new Map<string, string>();
    for (const link of [...chain].reverse()) {
      for (const [name, value] of link.properties) {
        properties.set(name, value);
      }
    }
    const project: Array<[string, string]> = [
      ["groupId", groupId],
      ["artifactId", pom.artifactId],
      ["version", version],
    ];
    for (const [field, value] of project) {
      properties.set(`project.${field}`, value);
      properties.set(`pom.${field}`, value);
    }
    if (pom.parent !== undefined) {
      for (const [field, value] of Object.entries(pom.parent)) {
        properties.set(`project.parent.${field}`, value);
        properties.set(`parent.${field}`, value);
      }
    }
    const interpolate = interpolator(properties, what);
    /* Inherited declarations come after the POM's own, so its own win a shared key. */
    const declared = chain.flatMap(link => link.dependencies).map(dependency => interpolateDependency(dependency, interpolate));
    const managed = mergeManaged(...chain.map(link => link.dependencyManagement.map(dependency => interpolateDependency(dependency, interpolate))));
    const imports = managed.filter(dependency => dependency.scope === "import");
    const own = managed.filter(dependency => dependency.scope !== "import");
    return Computable.forAll(
      imports.map(bom => {
        if (bom.version === undefined) {
          throw new FabrError(`${what}: imported BOM ${bom.groupId}:${bom.artifactId} has no version`);
        }
        const coordinate = { groupId: bom.groupId, artifactId: bom.artifactId, version: bom.version };
        return load(coordinate).then(raw => effectivePom(raw, load, coordinateText(coordinate), depth + 1));
      }),
      (...boms: EffectivePom[]) => {
        const dependencyManagement = mergeManaged(own, ...boms.map(bom => bom.dependencyManagement));
        const byKey = new Map(dependencyManagement.map(dependency => [managementKey(dependency), dependency]));
        const dependencies = mergeManaged(declared).map(dependency => {
          const managedEntry = byKey.get(managementKey(dependency));
          const filledVersion = dependency.version ?? managedEntry?.version;
          const filledScope = dependency.scope ?? managedEntry?.scope;
          if (filledVersion === undefined) {
            throw new FabrError(`${what}: dependency ${dependency.groupId}:${dependency.artifactId} has no version, and none is managed`);
          }
          return { ...dependency, version: filledVersion, ...(filledScope === undefined ? {} : { scope: filledScope }) };
        });
        return {
          groupId,
          artifactId: pom.artifactId,
          version,
          /* Packaging is not inherited: a POM that states none is a jar. */
          packaging: pom.packaging ?? "jar",
          dependencies,
          dependencyManagement,
        };
      }
    );
  });
}

/** The scopes a consumer's classpath takes from a dependency, at compile and at run time. */
const CLASSPATH_SCOPES = new Set(["compile", "runtime"]);

/** A dependency an artifact passes on to whatever uses it, and whether it is an optional provided one. */
export interface PassedOnDependency {
  readonly dependency: PomDependency;
  readonly optional: boolean;
}

/**
 * @return the dependencies an artifact passes on to whatever uses it: its jars
 * with no classifier in compile or runtime scope, and, as optional provided
 * requirements, the ones it marks optional or puts in provided scope (which
 * Maven itself does not pass on), bound only to what the consumer already has.
 */
export function passedOnDependencies(pom: EffectivePom): PassedOnDependency[] {
  return pom.dependencies
    .filter(dependency => (dependency.type ?? "jar") === "jar" && dependency.classifier === undefined)
    .flatMap(dependency => {
      const scope = dependency.scope ?? "compile";
      if (scope === "provided") {
        return [{ dependency, optional: true }];
      }
      return CLASSPATH_SCOPES.has(scope) ? [{ dependency, optional: dependency.optional }] : [];
    });
}
