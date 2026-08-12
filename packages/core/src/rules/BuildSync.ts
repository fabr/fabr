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
import { Computable, ComputableSource } from "../core/Computable";
import { EMPTY_FILESET, FileSet, FileSource, IFile } from "../core/FileSet";
import { RepositoryPublishRef, RepositoryWriter, SourceRef } from "../core/Repository";
import { PublishableFileSet } from "../core/PublishableFileSet";
import { Name, NAME_COMPONENT_SEPARATOR, NAME_LEVEL_SEPARATOR } from "../core/Name";
import { attachHelp, toError } from "../core/Errors";
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
 * A release as a **namespace**: its names are the declared member coordinates
 * (slash form — `@npm:x:1.0.0` is addressed as `@npm/x/1.0.0`, the alias
 * separator being a path separator) and its contents are the wire artifacts,
 * **packaged on demand**. The same shape as a `fetch` table (see FetchSource),
 * and for the same reason: the declaration is a *list of outputs*, not an
 * instruction to make all of them, so naming one member packages that member
 * and no other. Coordinate validation stays eager (see {@link syncPackages}) —
 * it is a name lookup, and every packaging needs the release-wide assignments
 * as context, which is exactly what validation produces.
 *
 * Two things can be named, and they mean different things — the distinction any
 * namespace has, and the same one a repository reference makes between
 * `@npm:esbuild:0.28.1` and `@npm:esbuild:0.28.1:package.json`:
 *
 * - a **member**, named literally and in full, yields that member's carrier
 *   itself — the entity, still a {@link PublishableFileSet}, so
 *   `fabr sync release/@npm/x/1.0.0` publishes exactly that one;
 * - anything else — a projection into a member, or a glob — yields **files**,
 *   the touched members' artifacts laid out under their coordinates and
 *   projected by the ordinary written-name rule, so
 *   `release/@npm/x/1.0.0/package.json` and `release:@npm:x:1.0.0:package.json`
 *   name a file exactly as they would in any container.
 *
 * Being a namespace rather than one flat FileSet is what makes those names mean
 * the same thing under every operation: there is no separate `files` view to
 * disagree with the build (see {@link syncRule}).
 */
export class SyncSource implements FileSource {
  /** Coordinate (slash form) -> the carrier, packaged at most once however many
   *  references name it. */
  private readonly packaged = new Map<string, Computable<PublishableFileSet>>();

  constructor(
    private readonly context: TargetContext,
    /** Coordinate (slash form) -> its member, in declaration order. */
    private readonly table: Map<string, Member>
  ) {}

  public find(name: Name, prefix = ""): ComputableSource<FileSet> {
    /* Naming a member outright yields the entity, not a view of it — an
     * ordinary find result, a carrier being a FileSet (find's own contract:
     * "a source with its own notion of a named part may yield something
     * else"). A rename or a glob is not a name in that sense and falls
     * through to the files case. */
    const literal = name.getRenameTo() === undefined ? name.getSimpleName() : undefined;
    const named = literal === undefined ? undefined : memberPath(literal);
    if (named !== undefined && this.table.has(named)) {
      return this.packageMembers([named]).then(([carrier]) => carrier);
    }
    const touched = this.touchedBy(name, prefix);
    if (touched.length === 0) {
      /* A closed namespace can tell "no such member" from "matched nothing", so
       * a literal miss says so with the table; a glob stays lenient, as
       * everywhere. */
      return name.hasGlob() ? Computable.resolve(EMPTY_FILESET) : Computable.reject(this.unknownMember(name));
    }
    return this.packageMembers(touched).then(carriers => this.laidOut(touched, carriers).find(name, prefix));
  }

  /**
   * Exact file lookup within a member — how a projection walker's descent probe
   * lands on an artifact. A member coordinate itself is no file (it names a
   * namespace entry, as a directory would), so only a name *under* one resolves.
   */
  public get(name: string): ComputableSource<IFile | undefined> {
    for (const path of this.table.keys()) {
      if (name.startsWith(path + NAME_COMPONENT_SEPARATOR)) {
        return this.packageMembers([path]).then(([carrier]) =>
          carrier.get(name.substring(path.length + 1))
        );
      }
    }
    return Computable.resolve(undefined);
  }

  /**
   * The carriers a name selects, packaged, in publish order (deps-first via
   * {@link publishOrder}); every member when no name narrows it. THE selection
   * primitive — {@link find} is this plus a layout, and takes the same names,
   * so `members()` and `members(**)` are the same selection by construction.
   *
   * It exists beside `find` for arity alone, not for type: a carrier IS a
   * FileSet, which is exactly how `find` hands back something publishable when
   * a name picks ONE member. But `find` answers with one FileSet, and a
   * selection of several members is several carriers — union them and the
   * per-member `destination` an upload goes through is gone. So `fabr sync`
   * takes the entities; everything else takes their content. (Enumerating a
   * namespace generically — what a bare `ls release` wants — is its own
   * pending design; this is the release's own answer meanwhile.)
   */
  public members(name?: Name, prefix = ""): Computable<PublishableFileSet[]> {
    const selected = name === undefined ? [...this.table.keys()] : this.touchedBy(name, prefix);
    return this.packageMembers(selected).then(carriers => publishOrder(carriers));
  }

  /**
   * The members a pattern could reach: those it names or matches outright, plus
   * those it addresses *into* — judged by whether any component-prefix of the
   * pattern matches the coordinate, which admits a `**` at any depth. An
   * over-approximation on purpose: packaging a member the projection then
   * discards costs work, missing one would lose files.
   */
  private touchedBy(name: Name, prefix: string): string[] {
    const projector = name.makeProjector(prefix);
    const prefixes = name.componentPrefixes().map(part => part.makeProjector());
    return [...this.table.keys()].filter(
      path => projector(path) !== undefined || prefixes.some(reaches => reaches(path) !== undefined)
    );
  }

  /** The given carriers as one FileSet under their coordinates — the release's
   *  file namespace, built for exactly the members a projection touches. */
  private laidOut(paths: string[], carriers: ReadonlyArray<PublishableFileSet>): FileSet {
    return FileSet.unionAll(...carriers.map((carrier, i) => carrier.rename(name => `${paths[i]}/${name}`)));
  }

  /**
   * Package these members, memoized per coordinate: whatever is already in hand
   * is reused, and everything new goes through ONE collection point and one
   * `package()` batch per destination — so members demanded together still
   * resolve and package together.
   */
  private packageMembers(paths: string[]): Computable<PublishableFileSet[]> {
    const missing = paths.filter(path => !this.packaged.has(path));
    if (missing.length > 0) {
      const batch = this.packageBatch(missing);
      missing.forEach((path, i) => this.packaged.set(path, batch.then(carriers => carriers[i])));
    }
    return Computable.forAll(
      paths.map(path => this.packaged.get(path)!),
      (...carriers: PublishableFileSet[]) => carriers
    );
  }

  /**
   * Build these members' content through one collection point, then hand each
   * destination its whole batch to `package` jointly (the write-side dual of the
   * read side's per-repository joint resolution), with the **full** release's
   * assignments as context — every packaging policy (npm's co-member version
   * rewriting, unresolvable-dependency errors) is the destination's, and it is
   * the assignments it needs for that, never the other members' content. Which
   * is what makes packaging one member at a time sound.
   */
  private packageBatch(paths: string[]): Computable<PublishableFileSet[]> {
    /* Keyed by coordinate — a user-supplied key, hence a Map — so members
     * sharing a package name stay distinct. */
    const sources = new Map<string, Computable<SourceRef[]>>();
    for (const path of paths) {
      sources.set(path, this.context.getFileProperty(this.member(path).decl.name.toBaseString(), BUILD_OVERRIDE));
    }
    const release = [...this.table.values()].map(member => member.assigned);
    return this.context.collect(sources).then(content => {
      const batches = new Map<RepositoryWriter, { path: string; index: number }[]>();
      paths.forEach((path, index) => {
        const writer = this.member(path).assigned.source;
        batches.set(writer, [...(batches.get(writer) ?? []), { path, index }]);
      });
      const carriers: PublishableFileSet[] = new Array(paths.length);
      return Computable.forAll(
        [...batches].map(([writer, batch]) =>
          writer
            .package(
              batch.map(({ path }) => ({
                destination: this.member(path).assigned,
                /* Every path's key was set above, so the lookup can't miss. */
                content: FileSet.unionAll(...(content.get(path) ?? [])),
              })),
              release
            )
            .then(packed => batch.forEach(({ index }, i) => (carriers[index] = packed[i])))
        ),
        () => carriers
      );
    });
  }

  /** Every caller reaches a member by a key taken from {@link table}. */
  private member(path: string): Member {
    return this.table.get(path)!;
  }

  private unknownMember(name: Name): Error {
    const declared = [...this.table.keys()].sort();
    return attachHelp(
      new Error(`${this.context.name} has no member matching '${name.toString()}'`),
      declared.length > 0 ? `it declares: ${declared.join(", ")}` : "it declares no members"
    );
  }
}

/** A coordinate as a name in the release namespace: the alias separator is a
 *  path separator, so `@npm:x:1.0.0` is addressed as `@npm/x/1.0.0`. */
function memberPath(coordinate: string): string {
  return coordinate.replaceAll(NAME_LEVEL_SEPARATOR, NAME_COMPONENT_SEPARATOR);
}

/**
 * Evaluate a `sync` target — the write-side collection point. Its body is a set
 * of `coordinate = content` members (reference-keyed bindings; the coordinate's
 * shape is the destination's — npm: `@repo:name:version`): each key resolves to
 * a vended publish ref (destination + validated address), and each member's
 * content is built under `BUILD_OPERATION=build` (identityless content). Every
 * coordinate is resolved and validated HERE, before any content is built —
 * cheap (a name lookup, no fetch), so a bad destination or version fails fast
 * positioned at the offending coordinate, and the resulting assignments are the
 * release-wide context each packaging needs.
 *
 * The result is the release as a {@link SyncSource} — a namespace of members
 * packaged on demand, NOT a pre-built set of carriers: `fabr sync` names the
 * whole release (or one member), while `fabr build`/`ls`/`cat` inspect the wire
 * artifacts member by member — the dry-run — packaging only what is named. No
 * upload happens here; that is the driver's job.
 */
function syncPackages(context: TargetContext): Computable<RuleResult> {
  return context.getWildcardProperties().then(props =>
    Computable.forAll(
      props.map(prop => validateMember(context, prop)),
      (...members: Member[]) => members
    ).then(members => {
      const table = new Map<string, Member>();
      for (const member of members) {
        const path = memberPath(member.assigned.toString());
        const clash = table.get(path);
        if (clash) {
          throw new NameResolutionError(
            member.decl.name,
            declPosn(member.decl),
            undefined,
            `'${member.assigned.toString()}' is already published by this sync (declared as '${clash.decl.name}')`
          );
        }
        table.set(path, member);
      }
      rejectShadowedMembers(context.name, table);
      return new SyncSource(context, table);
    })
  );
}

/**
 * A member coordinate may not be a path prefix of another — with both
 * `@npm/x/1.0.0` and `@npm/x/1.0.0/extra` declared, `release/@npm/x/1.0.0/extra`
 * would be ambiguous between the deeper member and a projection into the
 * shorter one. Rejected at declaration so the ambiguity is impossible by
 * construction (the same rule a `fetch` table applies to its downloads).
 */
function rejectShadowedMembers(declaredName: string, table: ReadonlyMap<string, Member>): void {
  const sorted = [...table.keys()].sort();
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startsWith(sorted[i - 1] + NAME_COMPONENT_SEPARATOR)) {
      const member = table.get(sorted[i])!;
      throw new NameResolutionError(
        member.decl.name,
        declPosn(member.decl),
        undefined,
        `'${sorted[i]}' in ${declaredName} is nested under member '${sorted[i - 1]}': a reference to it would be ` +
          `ambiguous with a projection into the shorter coordinate`
      );
    }
  }
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

/* No files rule of its own: packaging IS the fileset, so there is nothing a
 * files view could skip, and the generic files rule (a build passthrough)
 * serves it — which is what makes `fabr cat release/@npm/x/1.0.0/package.json`
 * and the same reference written in a build script name the same thing. */
export const syncRule: RuleRegistration = {
  type: "sync",
  constraints: { [BUILD_OPERATION]: "build" },
  evaluate: syncPackages,
};
