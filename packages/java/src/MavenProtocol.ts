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
 * The Maven format: how a reference to a Maven artifact is written and read.
 *
 * A package's name is `group/artifact` (`org.slf4j/slf4j-api`), which is also
 * how a target building one is named. A reference may be written that way or
 * as Maven writes a coordinate: `@mvn:org.slf4j/slf4j-api:1.7.36` and
 * `@mvn:org.slf4j:slf4j-api:1.7.36` are the same reference, and anything
 * after the version is a projection into the package. Run, a package starts
 * the `Main-Class` its jar's manifest names.
 */

import { Computable, FabrError, IProjection, markerOnProjection, Name, PackageFormat, Requirement } from "@fabr-build/core";
import { jarMainClass, makeJarRunnable } from "./JarPackage";
import { MAVEN_VERSIONS, MavenConstraint, MavenVersion } from "./MavenVersion";

/** Name a Maven package as fabr does: `group/artifact`. */
export function mavenName(groupId: string, artifactId: string): string {
  return `${groupId}/${artifactId}`;
}

/** Split a Maven package's name into its group and artifact; throws on a name
 *  that is not `group/artifact`. */
export function splitMavenName(name: string): { groupId: string; artifactId: string } {
  const slash = name.indexOf("/");
  if (slash <= 0 || slash === name.length - 1 || name.indexOf("/", slash + 1) !== -1) {
    throw new FabrError(`'${name}' is not a Maven package name (expected '<group>/<artifact>')`);
  }
  return { groupId: name.substring(0, slash), artifactId: name.substring(slash + 1) };
}

/**
 * Split a written reference (after `@mvn:`) into the package, its version,
 * and any projection after the version. The group and artifact are separated
 * by `/` or `:`; the version runs to the next `:` or `/`.
 */
function splitMavenReference(name: Name): Requirement & { projection?: IProjection } {
  const written = name.toBaseString();
  const firstColon = written.indexOf(":");
  const firstSlash = written.indexOf("/");
  /* `group/artifact…` where a slash comes first, else `group:artifact…`. */
  const separator = firstSlash !== -1 && (firstColon === -1 || firstSlash < firstColon) ? firstSlash : firstColon;
  if (separator === -1) {
    return { name: written, versionConstraint: undefined };
  }
  const groupId = written.substring(0, separator);
  const afterGroup = separator + 1;
  const artifactEnd = written.indexOf(":", afterGroup);
  if (artifactEnd === -1) {
    const { artifactId, variant } = splitClassifier(written.substring(afterGroup));
    return { name: mavenName(groupId, artifactId), versionConstraint: undefined, ...variant };
  }
  const { artifactId, variant } = splitClassifier(written.substring(afterGroup, artifactEnd));
  const packageName = mavenName(groupId, artifactId);
  const versionStart = artifactEnd + 1;
  const nextColon = written.indexOf(":", versionStart);
  const nextSlash = written.indexOf("/", versionStart);
  const boundary = nextColon === -1 ? nextSlash : nextSlash === -1 ? nextColon : Math.min(nextColon, nextSlash);
  if (boundary === -1) {
    return { name: packageName, versionConstraint: written.substring(versionStart), ...variant };
  }
  const version = written.substring(versionStart, boundary);
  if (version.endsWith("?") || version.endsWith("!")) {
    throw markerOnProjection(name);
  }
  const prefix = written[boundary] === "/" ? written.substring(0, boundary) + "/" : "";
  return { name: packageName, versionConstraint: version, ...variant, projection: { pattern: name.substring(boundary + 1), prefix } };
}

/**
 * Split an artifact as a reference writes it, `<artifact>/<classifier>`,
 * `<artifact>/<classifier>@<extension>` or `<artifact>@<extension>` where it
 * names a file other than the version's artifact: @return the artifact, and
 * the rest as the requirement's variant (`linux-x86_64`, `bin@zip`, `@zip`).
 */
function splitClassifier(written: string): { artifactId: string; variant: { variant?: string } } {
  const at = written.indexOf("@");
  const named = at === -1 ? written : written.substring(0, at);
  const extension = at === -1 ? "" : written.substring(at);
  const slash = named.indexOf("/");
  const artifactId = slash === -1 ? named : named.substring(0, slash);
  const classifier = slash === -1 ? "" : named.substring(slash + 1);
  return { artifactId, variant: classifier === "" && extension === "" ? {} : { variant: `${classifier}${extension}` } };
}

/**
 * Read a Maven variant: @return the classifier it names, if any, and the
 * extension of its file, `jar` where it names none.
 */
export function mavenVariantOf(variant: string): { classifier?: string; extension: string } {
  const at = variant.indexOf("@");
  const classifier = at === -1 ? variant : variant.substring(0, at);
  return { ...(classifier === "" ? {} : { classifier }), extension: at === -1 ? "jar" : variant.substring(at + 1) };
}

/** @return true if `variant` names a classifier a file's name can hold, an extension, or both, otherwise false. */
function isMavenVariant(variant: string): boolean {
  return /^([A-Za-z0-9][A-Za-z0-9._-]*)?(@[A-Za-z0-9][A-Za-z0-9.]*)?$/.test(variant) && variant !== "";
}

/** Check a Maven reference: a `group/artifact` name, and a valid version or
 *  range, or none, for a BOM to give; an override marker needs an exact version. */
function validateMavenRequirement({ name, versionConstraint, override, variant }: Requirement): void {
  splitMavenName(name);
  if (variant !== undefined && !isMavenVariant(variant)) {
    throw new FabrError(`'${variant}' is not a classifier, an @extension or both, which ${name}/${variant} names`);
  }
  if (versionConstraint === undefined) {
    if (override !== undefined) {
      throw new FabrError(`${name} states no version, so a marker means nothing on it`).withHelp("write the version the marker is for");
    }
    return;
  }
  try {
    MAVEN_VERSIONS.parseConstraint(versionConstraint);
  } catch {
    throw new FabrError(`'${versionConstraint}' is not a valid Maven version or range`).withHelp(
      "write a version (1.7.36) or a range ([1.0,2.0))"
    );
  }
  if (override !== undefined && MAVEN_VERSIONS.exactVersion?.(versionConstraint) === undefined) {
    throw new FabrError(`'${versionConstraint}' is not a valid override for ${name}: a marker needs an exact version`);
  }
}

/**
 * Parse a publish coordinate, `<group>:<artifact>:<version>` (or
 * `<group>/<artifact>:<version>`), whose version is exact, or with a variant
 * after the artifact, `<group>:<artifact>/<classifier>[@<extension>]:<version>`
 * or `<group>:<artifact>@<extension>:<version>`: a file published beside the
 * version's artifact (`-sources.jar`, `-bin.zip`).
 */
export function parseMavenPublishCoordinate(name: Name): { name: string; version: string; variant?: string } {
  const { name: packageName, versionConstraint: version, projection, variant } = splitMavenReference(name);
  const literal = name.toString();
  if (version === undefined || projection !== undefined) {
    /* A fourth part is read as a classifier elsewhere: say how fabr writes one. */
    const tail = projection?.prefix === "" ? projection.pattern.getSimpleName() : undefined;
    const classified = version !== undefined && tail !== undefined && !/[:/]/.test(tail);
    throw new FabrError(`publish coordinate '${literal}' must name a group, an artifact and a version (com.example:app:1.0.0)`).withHelp(
      classified
        ? `a classifier follows the artifact: write '${packageName.replace("/", ":")}/${version}:${tail}'`
        : "a classifier follows the artifact, as in com.example:app/sources:1.0.0"
    );
  }
  if (variant !== undefined && !isMavenVariant(variant)) {
    throw new FabrError(`publish coordinate '${literal}' must name a group, an artifact, a classifier where it has one, and a version (com.example:app/sources:1.0.0)`);
  }
  splitMavenName(packageName);
  if (version.startsWith("[") || version.startsWith("(") || MAVEN_VERSIONS.exactVersion?.(version) === undefined) {
    throw new FabrError(`'${version}' is not an exact version, which a publish coordinate for '${packageName}' must name`).withHelp(
      "write the version itself (1.0.0); a range cannot be published"
    );
  }
  if (/-SNAPSHOT$/i.test(version)) {
    throw new FabrError(`publishing a -SNAPSHOT version (${literal}) is not supported`);
  }
  return { name: packageName, version, ...(variant === undefined ? {} : { variant }) };
}

export const MAVEN_FORMAT: PackageFormat<MavenVersion, MavenConstraint> = {
  ...MAVEN_VERSIONS,
  resolutionTag: "maven:resolve:5",
  splitReference: splitMavenReference,
  validateRequirement: validateMavenRequirement,
  parsePublishCoordinate: parseMavenPublishCoordinate,
  readContentPackage: () => Computable.reject(new FabrError("content cannot be read as a Maven package yet")),
  makeRunnable: (pkg, context) =>
    jarMainClass(pkg).then(mainClass => {
      const name = pkg.packageName ?? "the package";
      if (![...pkg].some(([file]) => file.endsWith(".jar"))) {
        throw new FabrError(`${name} cannot be run: it publishes no jar`);
      }
      if (mainClass === undefined) {
        throw new FabrError(`${name} cannot be run: its jar's manifest names no Main-Class`).withHelp(
          "declare a jar_package with a `main_class`, and this package among its deps"
        );
      }
      return makeJarRunnable(context, [pkg], mainClass);
    }),
};
