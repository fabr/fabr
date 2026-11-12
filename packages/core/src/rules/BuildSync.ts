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

import { RequiredSources, TargetContext, Unmaterialized } from "../context/index";
import { BUILD_OPERATION, BUILD_OVERRIDE, Constraints } from "../model/Constraints";
import { SyncSources } from "../context/Collection";
import { Computable, ComputableSource } from "../core/Computable";
import { EMPTY_FILESET, FileSet, FileSource, IFile } from "../core/FileSet";
import { RepositoryPublishRef, RepositoryWriter, SourceRef } from "../core/Repository";
import { soleWholeTarget } from "../core/TargetRef";
import { refuseNamespaces } from "../core/NamespaceRef";
import { PublishableFileSet } from "../core/PublishableFileSet";
import { refuseSecrets } from "../core/SecretFile";
import { Name, NAME_COMPONENT_SEPARATOR, NAME_LEVEL_SEPARATOR } from "../core/Name";
import { FabrError, helpOf, toError } from "../core/Errors";
import { declPosn, IPropertyDecl } from "../model/AST";
import { DependencyFailedError, NameResolutionError } from "../model/Errors";
import { RuleImplementation, RuleResult } from "./Types";

/**
 * The `sync[build]` rule: a release, each member a `coordinate = content`
 * property publishing its content at a destination ({@link syncPackages}).
 * Under `files` the default files rule returns its build, so
 * `fabr cat release/@npm/x/1.0.0/package.json` names the same file as that
 * reference written in a build file.
 */
export default {
  /* Each member's content is a requirement keyed by {@link Member.content},
   * built under `build` whatever the sync is built under (an attachment's under
   * its own operation), read for publishing (SyncSources: a package keeps the
   * requirements its build bound, nothing is resolved here), and materialized
   * only for the members a name reaches. */
  requirements(context) {
    return members(context).then(table => ({
      build: new Map(
        [...table.values()].map((member): [string, Computable<SyncSources>] => [
          member.content,
          context
            .getFileProperty(
              contentKey(member.decl),
              member.operation === undefined ? BUILD_OVERRIDE : Constraints.of({ [BUILD_OPERATION]: member.operation })
            )
            .then(sources => new SyncSources(sources)),
        ])
      ),
    }));
  },
  evaluate(context, requirements) {
    return syncPackages(context, requirements);
  },
} satisfies RuleImplementation;

/** One member of a release. */
interface Member {
  /** The publish reference the member's coordinate vends: its destination and validated name. */
  readonly assigned: RepositoryPublishRef;
  /** The member's property decl, which declares its content: an attachment's
   *  is the declared member's it is published beside. */
  readonly decl: IPropertyDecl;
  /** The key of the requirement its content is read as. */
  readonly content: string;
  /** The operation an attachment's content is built under; undefined for a declared member, built under `build`. */
  readonly operation?: string;
}

/**
 * Order a release's carriers so each comes after every carrier that provides a
 * token it depends on (`provides`/`dependsOn`, tokens the destination chooses:
 * npm's are package names), across all destinations, so a consumer installing
 * mid-release finds every dependency published. A dependant follows every
 * carrier providing its token (a package at two major versions, or at two
 * registries). A dependency cycle is broken where the walk meets it, not
 * reported. Carriers otherwise keep their order.
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
 * The file source a release is. Its names are the member coordinates in slash
 * form (`@npm:x:1.0.0` is `@npm/x/1.0.0`), and its content is each member's
 * carrier, the artifact as uploaded, packaged only when a name reaches it.
 *
 * - A member named literally and in full yields its carrier itself, a
 *   {@link PublishableFileSet}: `fabr sync release/@npm/x/1.0.0` publishes
 *   that member alone.
 * - Any other name (a projection into a member, a glob) yields files: the
 *   members it reaches laid out under their coordinates, then projected as in
 *   any container, so `release/@npm/x/1.0.0/package.json` and
 *   `release:@npm:x:1.0.0:package.json` name the same file.
 */
export class SyncSource implements FileSource {
  /** Each member's carrier, by coordinate (slash form), packaged at most once. */
  private readonly packaged = new Map<string, Computable<PublishableFileSet>>();

  constructor(
    private readonly context: TargetContext,
    /** Each member, by coordinate (slash form), in declaration order. */
    private readonly table: Map<string, Member>,
    /** The members' content by {@link contentKey}, each materialized when first asked for. */
    private readonly content: Unmaterialized<Record<string, RequiredSources>>
  ) {}

  /**
   * Find what `name` names: a member's carrier where it names one literally
   * (with no rename), else the files of the members it reaches, projected. A
   * literal reaching no member rejects, listing the members; a glob reaching
   * none returns the empty set.
   */
  public find(name: Name, prefix = ""): ComputableSource<FileSet> {
    const literal = name.getRenameTo() === undefined ? name.getSimpleName() : undefined;
    const named = literal === undefined ? undefined : memberPath(literal);
    if (named !== undefined && this.table.has(named)) {
      return this.packageMembers([named]).then(([carrier]) => carrier);
    }
    const touched = this.touchedBy(name, prefix);
    if (touched.length === 0) {
      return name.hasGlob() ? Computable.resolve(EMPTY_FILESET) : Computable.reject(this.unknownMember(name));
    }
    return this.packageMembers(touched).then(carriers => this.laidOut(touched, carriers).find(name, prefix));
  }

  /**
   * Look up a file of a member's artifact exactly, packaging the member. A
   * member's coordinate itself is no file, as a directory is not.
   * @return the file, or undefined where `name` is under no member or names nothing in it.
   */
  public get(name: string): ComputableSource<IFile | undefined> {
    for (const path of this.table.keys()) {
      if (name.startsWith(path + NAME_COMPONENT_SEPARATOR)) {
        return this.packageMembers([path]).then(([carrier]) => carrier.get(name.substring(path.length + 1)));
      }
    }
    return Computable.resolve(undefined);
  }

  /**
   * Package the carriers of the members `name` reaches, as {@link find} selects
   * them, or of every member where no name is given, in
   * {@link publishOrder}. This is what `fabr sync` uploads: each carrier keeps
   * its own destination, which a union of several would lose.
   */
  public members(name?: Name, prefix = ""): Computable<PublishableFileSet[]> {
    const selected = name === undefined ? [...this.table.keys()] : this.touchedBy(name, prefix);
    return this.packageMembers(selected).then(carriers => publishOrder(carriers));
  }

  /**
   * List the members a pattern could reach: those it matches, and those any of
   * its leading component sequences matches, which it may reach into (a `**`
   * at any depth among them). The list may hold a member the projection then
   * selects nothing from, never miss one it selects from.
   */
  private touchedBy(name: Name, prefix: string): string[] {
    const projector = name.makeProjector(prefix);
    const prefixes = name.componentPrefixes().map(part => part.makeProjector());
    return [...this.table.keys()].filter(
      path => projector(path) !== undefined || prefixes.some(reaches => reaches(path) !== undefined)
    );
  }

  /** Lay `carriers` out as one FileSet, each under its coordinate in `paths`. */
  private laidOut(paths: string[], carriers: ReadonlyArray<PublishableFileSet>): FileSet {
    return FileSet.unionAll(...carriers.map((carrier, i) => carrier.mountedAt(paths[i])));
  }

  /**
   * Package the members at `paths`, each at most once: those not yet packaged
   * go through one {@link packageBatch}, so members asked for together are
   * packaged together.
   */
  private packageMembers(paths: string[]): Computable<PublishableFileSet[]> {
    const missing = paths.filter(path => !this.packaged.has(path));
    if (missing.length > 0) {
      const batch = this.packageBatch(missing);
      missing.forEach((path, i) =>
        this.packaged.set(
          path,
          batch.then(carriers => carriers[i])
        )
      );
    }
    return Computable.forAll(
      paths.map(path => this.packaged.get(path)!),
      (...carriers: PublishableFileSet[]) => carriers
    );
  }

  /**
   * Materialize the content of the members at `paths`, and package them with
   * one `package` call per destination ({@link RepositoryWriter.package}),
   * given every coordinate of the whole release and the targets it publishes.
   * How a member's manifest refers to its co-members is the destination's
   * choice. Rejects where a member's content is a namespace or holds a secret.
   */
  private packageBatch(paths: string[]): Computable<PublishableFileSet[]> {
    const release = [...this.table.values()].map(member => member.assigned);
    const materialized = Computable.forAll(
      paths.map(path =>
        this.content.materialize(this.member(path).content).then(sources => {
          const files = refuseNamespaces(sources);
          files.forEach(set => refuseSecrets(set, `published (sync member '${path}')`));
          return files;
        })
      ),
      (...content: FileSet[][]) => content
    );
    return Computable.forAll([this.publishedTargets(), materialized], (targets, content) => ({ targets, content })).then(
      ({ targets, content }) => {
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
                batch.map(({ path, index }) => ({
                  destination: this.member(path).assigned,
                  content: content[index].length === 1 ? content[index][0] : FileSet.unionAll(...content[index]),
                })),
                release,
                targets
              )
              .then(packed => batch.forEach(({ index }, i) => (carriers[index] = packed[i])))
          ),
          () => carriers
        );
      }
    );
  }

  /**
   * Find the targets the whole release publishes: for each member whose content
   * is a reference to one target and no more, that target's name with the
   * member's coordinate. Only the written references are read: nothing is
   * built or resolved.
   */
  private publishedTargets(): Computable<Map<string, RepositoryPublishRef[]>> {
    const members = [...this.table.values()].filter(member => member.operation === undefined);
    return Computable.forAll(
      members.map(member => this.context.getFileProperty(contentKey(member.decl), BUILD_OVERRIDE)),
      (...contents: SourceRef[][]) => {
        const targets = new Map<string, RepositoryPublishRef[]>();
        contents.forEach((sources, index) => {
          const only = soleWholeTarget(sources);
          if (only !== undefined) {
            targets.set(only.name, [...(targets.get(only.name) ?? []), members[index].assigned]);
          }
        });
        return targets;
      }
    );
  }

  /** Get the member at `path`, a key taken from {@link table}. */
  private member(path: string): Member {
    return this.table.get(path)!;
  }

  /** Make the error for a literal naming no member, listing the members there are. */
  private unknownMember(name: Name): Error {
    const declared = [...this.table.keys()].sort();
    return new FabrError(`${this.context.name} has no member matching '${name.toString()}'`).withHelp(
      declared.length > 0 ? `it declares: ${declared.join(", ")}` : "it declares no members"
    );
  }
}

/** Spell a coordinate as a name in the release namespace: the alias separator
 *  is a path separator, so `@npm:x:1.0.0` is addressed as `@npm/x/1.0.0`, and a
 *  directory's coordinate names the directory (`@aws:s3:site:v3/` is
 *  `@aws/s3/site/v3`). */
function memberPath(coordinate: string): string {
  return coordinate.replaceAll(NAME_LEVEL_SEPARATOR, NAME_COMPONENT_SEPARATOR).replace(/\/+$/, "");
}

/**
 * Evaluate a `sync` target. Its body is a set of `coordinate = content`
 * members, each coordinate in its destination's form (npm:
 * `@repo:name:version`). Every coordinate is looked up as a publish reference
 * and validated before any content is built; a bad destination or address
 * rejects, positioned at the coordinate.
 *
 * @return the release as a {@link SyncSource}, which packages a member only
 * when a name reaches it: `fabr build`, `ls` and `cat` show the artifacts, and
 * `fabr sync` uploads them. Nothing is uploaded here.
 */
function syncPackages(context: TargetContext, content: Unmaterialized<Record<string, RequiredSources>>): Computable<RuleResult> {
  return members(context).then(table => new SyncSource(context, table, content));
}

/**
 * Read the sync's members by coordinate (slash form), validating each
 * coordinate: those it declares, then the attachments their repositories
 * publish beside them ({@link attachmentsOf}).
 */
function members(context: TargetContext): Computable<Map<string, Member>> {
  return declaredMembers(context).then(declared => attachmentsOf(context, declared));
}

/**
 * Add to `declared` the attachments each member's repository publishes beside
 * it ({@link RepositoryWriter.attachments}): each where the member's content is
 * one target, whole, whose type has a rule for the attachment's operation, and
 * the sync declares no member at its coordinate.
 */
function attachmentsOf(context: TargetContext, declared: Map<string, Member>): Computable<Map<string, Member>> {
  const all = [...declared.values()];
  return Computable.forAll(
    all.map(member => context.getFileProperty(contentKey(member.decl), BUILD_OVERRIDE)),
    (...contents: SourceRef[][]) => {
      const table = new Map(declared);
      all.forEach((member, index) => {
        const target = soleWholeTarget(contents[index])?.name;
        for (const { destination, operation } of member.assigned.source.attachments?.(member.assigned) ?? []) {
          const path = memberPath(destination.toString());
          if (target !== undefined && !table.has(path) && context.hasTargetRule(target, operation)) {
            table.set(path, { assigned: destination, decl: member.decl, content: `${member.content} ${operation}`, operation });
          }
        }
      });
      return table;
    }
  );
}

/** Read the members the sync declares by coordinate (slash form), validating each coordinate. */
function declaredMembers(context: TargetContext): Computable<Map<string, Member>> {
  return context.getWildcardProperties().then(props =>
    Computable.forAll(
      props.map(prop => validateMember(context, prop)),
      (...declared: Member[]) => declared
    ).then(declared => {
      const table = new Map<string, Member>();
      for (const member of declared) {
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
      return table;
    })
  );
}

/**
 * Throw where a member's coordinate is a path prefix of another's: with both
 * `@npm/x/1.0.0` and `@npm/x/1.0.0/extra` declared,
 * `release/@npm/x/1.0.0/extra` could name the deeper member or a projection
 * into the shorter one. A `fetch` table applies the same rule.
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
 * Look up one member's coordinate as a publish reference: the repository is
 * looked up, and vends the reference, validating the address, or refuses.
 * Rejects with a {@link NameResolutionError} at the written coordinate where
 * the coordinate fails (no such repository, not a publish destination, a
 * malformed address); a repository's own failure (a DependencyFailedError) is
 * passed through as it is.
 */
function validateMember(context: TargetContext, prop: { key: Name; decl: IPropertyDecl }): Computable<Member> {
  return context
    .lookupPublishRef(prop.key)
    .then((assigned): Member => ({ assigned, decl: prop.decl, content: contentKey(prop.decl) }))
    .catch(err => {
      if (err instanceof DependencyFailedError) {
        throw err;
      }
      const error = toError(err);
      throw new NameResolutionError(prop.key, declPosn(prop.decl), undefined, error.message).withHelp(helpOf(error));
    });
}

/** @return the key of a member's content requirement: its coordinate as written, the property its content is read from. */
function contentKey(decl: IPropertyDecl): string {
  return decl.name.toBaseString();
}
