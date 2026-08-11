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
import { attachHelp, toError, VersionNotFoundError } from "../core/Errors";
import { EMPTY_FILESET, FileSet } from "../core/FileSet";
import { PackageFileSet } from "../core/PackageFileSet";
import { SourceRef } from "../core/Repository";
import { TargetContext } from "../model/BuildContext";
import { BUILD_OPERATION, FILES_OPERATION } from "../model/Constraints";
import { IContentPackage, PackageFormat } from "../resolver/PackageFormat";
import { resolveBarePackage } from "../resolver/PackageResolver";
import { RepositoryReader } from "../core/Repository";

/**
 * The {@link RepositoryReader} serving ONE declared package from content — what
 * a `repository_group` **content route** constructs:
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
 * The route's value is the package; everything package-shaped about it is
 * derived from ONE pure question asked of the ecosystem's format —
 * {@link PackageFormat.readContentPackage}, the manifest read, taken lazily
 * (the content is only materialized when a resolution actually consults this
 * member). The registry mechanics around the answer are ecosystem-free:
 * exactly one version available (a range requirement anywhere in the graph
 * raises to it via the ordinary floor-raise, or fails loudly naming it), its
 * requirements joining the domain's joint resolution like anyone else's, and
 * the resolved dependency edges wired by the delivery driver exactly as for a
 * registry-served package. Read-only by construction: no publish vend
 * (getRepositoryPublishRef), so a publish coordinate routed here is refused
 * by the group's pass-through.
 *
 * The environment key IS the resolution-relevant projection of the content —
 * the declared version and requirements, canonically serialized and hashed —
 * so an edit that changes them invalidates the domain's resolution memo, and
 * nothing else does (a description tweak re-resolves nothing; delivery reads
 * the actual content each run regardless).
 */
export function contentPackageMember<V, C>(
  format: PackageFormat<V, C>,
  context: TargetContext,
  name: string,
  source: SourceRef
): RepositoryReader<V, C> {
  /* Where this route was declared, for error attribution. */
  const site = `content route '${name}' in ${context.name}`;

  /* Re-position a content/manifest error at the declaring route, keeping any
   * attached help (help is a plain assigned property, so it survives copy). */
  const positioned = (err: unknown): Error => {
    const cause = toError(err);
    const help = (cause as { help?: string | string[] }).help;
    const wrapped = new Error(`${site}: ${cause.message}`);
    return help ? attachHelp(wrapped, help) : wrapped;
  };

  let loaded: Computable<{ files: FileSet; content: IContentPackage<V> }> | undefined;
  const load = (): Computable<{ files: FileSet; content: IContentPackage<V> }> =>
    (loaded ??= context
      .materializeSources([source])
      .then(delivered => {
        const files = delivered[0];
        if (!(files instanceof FileSet)) {
          throw new Error(`did not deliver file content`);
        }
        return format.readContentPackage(files).then(content => {
          if (content.name !== undefined && content.name !== name) {
            throw attachHelp(
              new Error(`serves a package that names itself '${content.name}' in its manifest`),
              "the route key and the manifest name must agree — rename the route to the package's real name"
            );
          }
          return { files, content };
        });
      })
      .catch(err => {
        throw positioned(err);
      }));

  const member: RepositoryReader<V, C> = {
    format,
    /* For the resolution memo key: WHICH member serves the name. The content's
     * resolution-relevant identity rides environmentKey — it is not knowable
     * synchronously. */
    identity: `content:${name}`,

    /* Same authority as environmentKey's facts: the context this route was
     * declared under (see RepositoryReader.deliver). */
    deliver: (reference, options, closure): Computable<FileSet> =>
      context.getGlobalString(BUILD_OPERATION).then(operation => {
        /* Files alone: the route's content IS the answer, so no resolution. */
        if (operation === FILES_OPERATION) {
          return resolveBarePackage(member, reference);
        }
        if (!closure) {
          return Computable.resolve<FileSet>(EMPTY_FILESET);
        }
        return closure().then(pkg => {
          if (pkg === undefined) {
            return Computable.resolve<FileSet>(EMPTY_FILESET);
          }
          return operation === "run" ? format.makeRunnable(pkg) : Computable.resolve<FileSet>(pkg);
        });
      }),

    environmentKey: (): Computable<string> =>
      load().then(({ content }) => {
        const requirements = content.requirements
          .map(req => JSON.stringify([req.pkg, req.constraint, req.alias ?? "", req.soft ?? false]))
          .sort();
        const hash = createHash("sha256")
          .update([format.versionToString(content.version), ...requirements].join("\n"))
          .digest("hex");
        return `content:${name}:${hash}`;
      }),

    getRequirements: (pkg, version) =>
      load().then(({ content }) => {
        if (pkg !== name || format.compare(version, content.version) !== 0) {
          /* Typed as unpublished, not failed: the resolver's floor-raise then
           * consults lowestAvailable, which answers with the one version there
           * is — so a range requirement lands on the declared content. */
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

    /* The floor-raise hook: a constraint whose literal minimum is not the
     * declared version raises to it iff it satisfies the range. An unparseable
     * constraint is no raise, not an error (advisory path). */
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
