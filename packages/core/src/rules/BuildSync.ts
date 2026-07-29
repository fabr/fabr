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

import { TargetContext } from "../model/BuildContext";
import { BUILD_OPERATION, BUILD_OVERRIDE } from "../model/Constraints";
import { Computable } from "../core/Computable";
import { FileSet } from "../core/FileSet";
import { RepositoryPublishRef, RepositoryWriter, SourceRef } from "../core/Repository";
import { PublishableFileSet } from "../core/PublishableFileSet";
import { Name } from "../core/Name";
import { toError } from "../core/Errors";
import { declPosn, IPropertyDecl } from "../model/AST";
import { DependencyFailedError, NameResolutionError } from "../model/Errors";
import { RuleRegistration, RuleResult } from "./Types";

interface Member {
  /** The vended publish ref this member is assigned — destination + validated name. */
  readonly assigned: RepositoryPublishRef;
  /** The member's property decl. Its `name` — the written coordinate's canonical
   *  string (`@npm:X:1.0.1`) — is the member's identity in the build's namespace
   *  (unique per decl, distinguishing members that share a package name) and
   *  locates the right-hand side content. */
  readonly decl: IPropertyDecl;
}

/**
 * Order a release's carriers so a member comes after every member providing a
 * token it depends on (`provides`/`dependsOn` — opaque, minted ecosystem-side;
 * npm's are package names) — uploaded in this order, a consumer that installs
 * mid-release never sees a dangling dependency. Global across destinations,
 * which no single destination could do: a member may depend on a co-member
 * published to a different registry. Several members may provide one token (a
 * package at two major lines, or at two registries) — a dependant follows them
 * all; a dependency cycle (shouldn't happen for real packages) is tolerated —
 * broken at the back-edge — rather than an error.
 */
export function publishOrder(carriers: ReadonlyArray<PublishableFileSet>): PublishableFileSet[] {
  const byToken = new Map<string, PublishableFileSet[]>();
  for (const carrier of carriers) {
    if (carrier.provides !== undefined) {
      byToken.set(carrier.provides, [...(byToken.get(carrier.provides) ?? []), carrier]);
    }
  }
  const ordered: PublishableFileSet[] = [];
  const done = new Set<PublishableFileSet>();
  const active = new Set<PublishableFileSet>();
  const visit = (carrier: PublishableFileSet): void => {
    if (done.has(carrier) || active.has(carrier)) {
      return;
    }
    active.add(carrier);
    for (const dep of carrier.dependsOn) {
      for (const depCarrier of byToken.get(dep) ?? []) {
        visit(depCarrier);
      }
    }
    active.delete(carrier);
    done.add(carrier);
    ordered.push(carrier);
  };
  carriers.forEach(visit);
  return ordered;
}

/**
 * Evaluate a `sync` target — the write-side collection point. Its body is a set
 * of `coordinate = content` members (reference-keyed bindings; the coordinate's
 * shape is the destination's — npm: `@repo:name:version`): each key resolves to
 * a vended publish ref (destination + validated address), and each member's
 * content is built under `BUILD_OPERATION=build` (identityless content). The
 * rule is pure aggregation — "here are the outputs to make": it
 * partitions the members by destination and hands each destination its whole
 * batch to `package` jointly (the write-side dual of the read side's
 * per-repository joint resolution), with the full release's assignments as
 * context — every packaging policy (npm's co-member version rewriting,
 * unresolvable-dependency errors) is the destination's. The result IS the
 * carriers, one source per member, in publish order (deps-first via
 * {@link publishOrder} — the `fabr sync` verb uploads in list order, and
 * `fabr build`/`ls`/`cat` inspect the wire artifacts member by member: the
 * dry-run). No upload happens here — that is the driver's job.
 */
function syncPackages(context: TargetContext): Computable<RuleResult> {
  return context.getWildcardProperties().then(props =>
    /* Phase 1 — resolve and validate every coordinate before any content is built:
     * coordinate resolution is a name lookup (no fetch), so a bad destination or
     * version fails fast, positioned at the offending coordinate (NameResolutionError). */
    Computable.forAll(
      props.map(prop => validateMember(context, prop)),
      (...members: Member[]) => members
    ).then(members => {
      /* Phase 2 — gather every member's content through ONE collection point
       * (keyed by the member's decl name — the written coordinate — so members
       * sharing a package name stay distinct). Content builds here, only once
       * all coordinates are good. */
      const sources: Record<string, Computable<SourceRef[]>> = {};
      for (const member of members) {
        sources[member.decl.name] = context.getFileProperty(member.decl.name, BUILD_OVERRIDE);
      }
      const release = members.map(member => member.assigned);
      return context.collect(sources).then(content => {
        /* Phase 3 — one package() batch per destination, the release-wide
         * assignments as context; carriers come back parallel to each batch and
         * are reassembled into declaration order. */
        const batches = new Map<RepositoryWriter, { member: Member; index: number }[]>();
        members.forEach((member, index) =>
          batches.set(member.assigned.source, [...(batches.get(member.assigned.source) ?? []), { member, index }])
        );
        const carriers: PublishableFileSet[] = new Array(members.length);
        return Computable.forAll(
          [...batches].map(([writer, batch]) =>
            writer
              .package(
                batch.map(({ member }) => ({
                  destination: member.assigned,
                  content: FileSet.unionAll(...content[member.decl.name]),
                })),
                release
              )
              .then(packed => batch.forEach(({ index }, i) => (carriers[index] = packed[i])))
          ),
          () => publishOrder(carriers)
        );
      });
    })
  );
}

/**
 * Resolve one member's coordinate to a vended publish ref: the repository alias
 * resolves, and the destination vends (validating shape) or refuses (read-only).
 * A failure of the coordinate itself (no such repository, not a publish
 * destination, a malformed address) is positioned at the written coordinate via
 * {@link NameResolutionError}; a genuine repository build failure passes through
 * with its own attribution.
 */
function validateMember(context: TargetContext, prop: { key: Name; decl: IPropertyDecl }): Computable<Member> {
  return context
    .resolvePublishRef(prop.key)
    .then(assigned => ({ assigned, decl: prop.decl }))
    .catch(err => {
      if (err instanceof DependencyFailedError) {
        throw err;
      }
      throw new NameResolutionError(prop.key, declPosn(prop.decl), undefined, toError(err).message);
    });
}

/**
 * The files view of a release (`BUILD_OPERATION=files` — what ls/cat build):
 * the same carriers the build yields, laid out as ONE FileSet with each
 * member's wire artifacts under its coordinate as a directory
 * (`@npm/name/1.0.0/…`). The alias separator is a path separator, so the
 * ordinary written-name rule then addresses a member's file
 * (`release:@npm:name:1.0.0:package.json`) or subtree with plain projections —
 * no bespoke namespace. Delegates to the build (`getTargetWithOverrides`, not
 * re-run), so the view is of exactly the dry-run artifacts.
 */
function syncFiles(context: TargetContext): Computable<RuleResult> {
  return context.context.getTargetWithOverrides(context.name, BUILD_OVERRIDE).then(sources => {
    const carriers = sources.filter((source): source is PublishableFileSet => source instanceof PublishableFileSet);
    return FileSet.unionAll(
      ...carriers.map(carrier => {
        /* destination.toString() is the full written coordinate (the resolver
         * attached the repository's declared name at vend time). */
        const dir = carrier.destination.toString().replaceAll(":", "/");
        return carrier.rename(name => `${dir}/${name}`);
      })
    );
  });
}

export const syncRule: RuleRegistration = {
  type: "sync",
  constraints: { [BUILD_OPERATION]: "build" },
  evaluate: syncPackages,
};
export const syncFilesRule: RuleRegistration = {
  type: "sync",
  constraints: { [BUILD_OPERATION]: "files" },
  evaluate: syncFiles,
};
