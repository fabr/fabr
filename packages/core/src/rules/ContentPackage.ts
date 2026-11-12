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

import { createHash } from "node:crypto";
import { Computable } from "../core/Computable";
import { FabrError, toError, VersionNotFoundError } from "../core/Errors";
import { FileSet } from "../core/FileSet";
import { PackageFileSet } from "../core/PackageFileSet";
import { SourceRef } from "../core/Repository";
import { TargetContext } from "../context/index";
import { IContentPackage, PackageFormat } from "../resolver/PackageFormat";
import { resolveBarePackage } from "../resolver/PackageResolver";
import { RepositoryReader } from "../core/Repository";

/**
 * Make the {@link RepositoryReader} for a `repository_group` content route:
 * one package, `name`, served from the files `source` names.
 *
 * ```
 * fetch @dl { amperize.tgz = "https://codeload.github.com/…/<sha>" "sha256-…"; }
 *
 * repository_group @deps {
 *     amperize = @dl:amperize.tgz:*:**;
 *     *        = @npm;
 * }
 * ```
 *
 * The package's version and requirements are what `format`'s
 * {@link PackageFormat.readContentPackage} reads from the manifest in the
 * content, which is materialized only when a resolution first asks the
 * reader for something. The reader publishes exactly that one version: a
 * requirement on `name` whose lower bound is another version is answered with
 * it where its constraint allows (`lowestAvailable`), and is otherwise a
 * VersionNotFoundError naming the version there is. Its requirements are
 * resolved with the rest of the resolution's, as a published package's are.
 *
 * `environmentKey` is a hash of the version and requirements the manifest
 * declares, so a resolution memo changes only where they do.
 *
 * Errors reading the content are reported against the route (`content route
 * '<name>' in <group>`): content that is no file set, no usable manifest, or a
 * manifest naming a package other than `name`.
 */
export function contentPackageMember<V, C>(
  format: PackageFormat<V, C>,
  context: TargetContext,
  name: string,
  source: SourceRef
): RepositoryReader<V, C> {
  /* The route, as errors name it. */
  const site = `content route '${name}' in ${context.name}`;

  let loaded: Computable<{ files: FileSet; content: IContentPackage<V> }> | undefined;
  const load = (): Computable<{ files: FileSet; content: IContentPackage<V> }> =>
    (loaded ??= context
      .materializeSources([source])
      .then(delivered => {
        const files = delivered[0];
        if (!(files instanceof FileSet)) {
          throw new FabrError(`did not deliver file content`);
        }
        return format.readContentPackage(files).then(content => {
          if (content.name !== undefined && content.name !== name) {
            throw new FabrError(`serves a package that names itself '${content.name}' in its manifest`).withHelp(
              "the route key and the manifest name must agree — rename the route to the package's real name"
            );
          }
          return { files, content };
        });
      })
      .catch(err => {
        /* Report the error against the route. */
        const cause = toError(err);
        throw new FabrError(`${site}: ${cause.message}`, cause);
      }));

  const member: RepositoryReader<V, C> = {
    format,
    /* Which route this is, for the resolution memo key; what its content
     * declares is in environmentKey. */
    identity: `content:${name}`,

    /* The operation of the configuration the route was declared in. */
    operation: context.operation,

    fetchFiles: (reference): Computable<FileSet> => Computable.resolve(undefined).then(() => resolveBarePackage(member, reference)),

    environmentKey: (): Computable<string> =>
      load().then(({ content }) => {
        const requirements = content.requirements
          .map(req => JSON.stringify([req.name, req.versionConstraint, req.renameTo ?? "", req.provided ?? ""]))
          .sort();
        const hash = createHash("sha256")
          .update([format.versionToString(content.version), ...requirements].join("\n"))
          .digest("hex");
        return `content:${name}:${hash}`;
      }),

    getRequirements: (pkg, version) =>
      load().then(({ content }) => {
        if (pkg !== name || format.compare(version, content.version) !== 0) {
          /* Reject as unpublished: the resolver then asks lowestAvailable,
           * which answers with the declared version where the constraint
           * allows it. */
          return Computable.reject(
            new VersionNotFoundError(
              pkg,
              format.versionToString(version),
              `'${pkg}' is served from declared content at version ${format.versionToString(content.version)} — ` +
                `${format.versionToString(version)} is not available`
            )
          );
        }
        return Computable.resolve(content.requirements);
      }),

    /* Answer with the declared version where it satisfies `constraint`. An
     * unparseable constraint is answered with nothing, not an error. */
    lowestAvailable: (_pkg, constraint) => {
      let parsed: C;
      try {
        parsed = format.parseConstraint(constraint);
      } catch {
        return Computable.resolve(undefined);
      }
      return load().then(({ content }) => (format.satisfies(content.version, parsed) ? content.version : undefined));
    },

    availableVersions: pkg => (pkg === name ? load().then(({ content }) => [content.version]) : Computable.resolve(undefined)),

    fetch: (_pkg, version) => load().then(({ files }) => new PackageFileSet(files, name, format.versionToString(version))),
  };
  return member;
}
