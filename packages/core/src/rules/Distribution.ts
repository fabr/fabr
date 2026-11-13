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

import { Computable } from "../core/Computable";
import { FabrError } from "../core/Errors";
import { FileSet, IFile } from "../core/FileSet";
import { Name } from "../core/Name";
import { PackageFileSet, ResolvedNode } from "../core/PackageFileSet";
import { PartialRepositoryRef } from "../core/PartialRepositoryRef";
import { Reference } from "../core/Reference";
import { Repository, RepositoryLookup, RepositoryPublishRef, RepositoryRef } from "../core/Repository";
import { RunnableFileSet } from "../core/RunnableFileSet";
import { SymlinkFile } from "../core/SymlinkFile";
import { TargetContext } from "../context/index";
import { TARGET } from "../model/Constraints";
import { markerOnProjection } from "../resolver/PackageResolver";
import { VersionDomain } from "../resolver/Types";
import { fetchArchive, IDownloadSource, stripArchiveRoot } from "../support/FetchDocument";
import { MemoryCache } from "../support/MemoryCache";

/** The suffix a Windows command carries, which a release's surface leaves off its name. */
const EXE = ".exe";

/**
 * A repository over a distribution: the releases of one program, each built
 * for several platforms (Node.js, a JDK). Every release is a package of one
 * name requiring nothing, so a reference is looked up rather than resolved
 * jointly: an exact version names its release outright, and a range
 * (`@node:22`) the lowest published version satisfying it, read from the
 * distribution's version list. The release for the target platform is found
 * as the reference is resolved, and fetched, its top directory stripped and
 * checked against the digest the distribution states, only when its files
 * are wanted. Under `run` the release is a program (see
 * {@link releaseRunnable}). `@<name>` on its own lists the releases.
 *
 * A subclass states the distribution: its versions, its version list and
 * where each release's archive is, each for the target platform as a triple
 * (`TARGET`), which it names in its own vocabulary as it needs to.
 */
export abstract class Distribution<V, C> implements Repository, RepositoryLookup {
  /** The package every release is (`node`). */
  protected abstract readonly packageName: string;
  /** What a release is called in messages (`Node.js`). */
  protected abstract readonly title: string;
  /** How the distribution's versions are spelled, ordered and constrained. */
  protected abstract readonly domain: VersionDomain<V, C>;
  /** The cache tag a release's archive is kept under. */
  protected abstract readonly archiveTag: string;
  /** What to do where the target platform has no release, as a `help:` line. */
  protected abstract readonly unavailableHelp: string;
  /** Where a release keeps its commands, in the order looked for (`Contents/Home/bin/`, `bin/`). */
  protected abstract readonly binDirectories: readonly string[];

  /** The published versions, by target and whether the list was re-read, as read this run. */
  private readonly versionLists = new MemoryCache<string, V[]>();
  /** Each release's archive for each target, as found this run. */
  private readonly archives = new MemoryCache<string, IDownloadSource>();

  constructor(
    protected readonly context: TargetContext,
    /** The URL the distribution is published under. */
    protected readonly url: string
  ) {}

  protected get name(): string {
    return this.context.name;
  }

  /**
   * List the versions published for the target platform `target`, as the
   * distribution spells them; one that does not parse is left out.
   * `revalidate` re-reads a held list, for a range the held one has no
   * version for, or a listing. Rejects with {@link unavailable} where the
   * distribution publishes nothing for `target`.
   */
  protected abstract listVersions(target: string, revalidate: boolean): Computable<string[]>;

  /**
   * Find the archive of the release `version` (in its canonical spelling) for
   * the target platform `target`, rejecting where it is not published for it
   * ({@link unavailable} where the distribution publishes nothing for
   * `target`). The archive's url is its cache key.
   */
  protected abstract findArchive(version: string, target: string): Computable<IDownloadSource>;

  /** Make the error refusing `target`, a platform the distribution publishes no release for. */
  protected unavailable(target: string): FabrError {
    return new FabrError(`${this.title} releases are not available for '${target}'`).withHelp(this.unavailableHelp);
  }

  /** Vend the reference to the release `name` names (`24.22.1`, `22`), with
   *  any projection after it, or the namespace of every release. */
  public getRepositoryRef(name: Name): RepositoryRef | PartialRepositoryRef {
    if (name.getMarker() !== undefined) {
      throw new FabrError(
        `'${name.toString()}' names a ${this.title} release, which is looked up, not resolved, so an override marker means nothing on it`
      ).withHelp("write the reference without the marker");
    }
    const written = name.toBaseString();
    if (written === "") {
      return new PartialRepositoryRef(this, "");
    }
    const colon = written.indexOf(":");
    const slash = written.indexOf("/");
    const boundary = colon === -1 ? slash : slash === -1 ? colon : Math.min(colon, slash);
    if (boundary === -1) {
      return new RepositoryRef(this, { name: this.packageName, versionConstraint: written, renameTo: name.getRenameTo()?.toString() });
    }
    const version = written.substring(0, boundary);
    if (version.endsWith("?") || version.endsWith("!")) {
      throw markerOnProjection(name);
    }
    const prefix = written[boundary] === "/" ? version + "/" : "";
    return new RepositoryRef(this, { name: this.packageName, versionConstraint: version }).find(name.substring(boundary + 1), prefix);
  }

  public getRepositoryPublishRef(): RepositoryPublishRef {
    throw new FabrError(`${this.name} cannot be published to`);
  }

  /** List the releases published for the target platform, newest first. */
  public children(): Computable<Map<string, Reference>> {
    return this.context
      .getGlobalString(TARGET)
      .then(target => this.publishedVersions(target, true))
      .then(
        versions =>
          new Map(
            [...versions]
              .sort((a, b) => this.domain.compare(b, a))
              .map((version): [string, Reference] => {
                const text = this.domain.versionToString(version);
                return [text, new RepositoryRef(this, { name: this.packageName, versionConstraint: text })];
              })
          )
      );
  }

  /**
   * Resolve `reference` to the node of the release it names for the target
   * platform: a package named {@link packageName} at the version selected,
   * fetched only when its files are wanted. Under `run` its files are the
   * release as a program.
   */
  public resolve(reference: RepositoryRef): Computable<ResolvedNode> {
    return this.context.getGlobalString(TARGET).then(target =>
      this.select(reference.versionConstraint, target).then(selected => {
        const version = this.domain.versionToString(selected);
        return this.archive(version, target).then(source => {
          const key = source.url;
          const release = (): Computable<FileSet> =>
            fetchArchive(this.context, {
              key,
              tag: this.archiveTag,
              report: { resource: this.title, role: "content" },
              source: () => Computable.resolve(source),
              keep: stripArchiveRoot,
            });
          const pkg = (): Computable<PackageFileSet> => release().then(files => new PackageFileSet(files, this.packageName, version));
          const content =
            this.context.operation === "run"
              ? { key: `runnable ${key}`, plain: true as const, files: () => pkg().then(held => this.makeRunnable(held)) }
              : { key, files: pkg };
          return new ResolvedNode(content, this.packageName, version);
        });
      })
    );
  }

  /** Make a release runnable (see {@link releaseRunnable}). */
  public makeRunnable(pkg: PackageFileSet): Computable<RunnableFileSet> {
    return Computable.resolve(releaseRunnable(pkg, this.binDirectories));
  }

  /** Select the version `written` names: itself where it is exact, else the
   *  lowest published version satisfying it, re-reading a held list that has none. */
  private select(written: string | undefined, target: string): Computable<V> {
    let constraint: C;
    try {
      if (written === undefined) {
        throw new FabrError("no version");
      }
      constraint = this.domain.parseConstraint(written);
    } catch {
      return Computable.reject(
        new FabrError(`'${written ?? ""}' is not a ${this.title} version or range`).withHelp(
          `\`fabr ls ${this.name}\` lists the releases published for the target platform`
        )
      );
    }
    const exact = this.domain.exactVersion?.(written);
    if (exact !== undefined) {
      return Computable.resolve(exact);
    }
    const lowest = (versions: V[]): V | undefined => lowestSatisfying(this.domain, versions, constraint);
    return this.publishedVersions(target, false).then(held => {
      const found = lowest(held);
      return found !== undefined
        ? Computable.resolve(found)
        : this.publishedVersions(target, true).then(listed => {
            const relisted = lowest(listed);
            if (relisted === undefined) {
              throw new FabrError(`No ${this.title} release for ${target} satisfies '${written}'`).withHelp(
                `\`fabr ls ${this.name}\` lists the releases published for the target platform`
              );
            }
            return relisted;
          });
    });
  }

  /** List the versions published for `target`, as {@link listVersions} reads them, once a run each way. */
  private publishedVersions(target: string, revalidate: boolean): Computable<V[]> {
    return this.versionLists.getOrCreate(`${revalidate} ${target}`, () =>
      this.listVersions(target, revalidate).then(texts =>
        texts.flatMap(text => {
          try {
            return [this.domain.parseVersion(text)];
          } catch {
            return [];
          }
        })
      )
    );
  }

  /** Find a release's archive for `target`, once a run. */
  private archive(version: string, target: string): Computable<IDownloadSource> {
    return this.archives.getOrCreate(`${version} ${target}`, () => this.findArchive(version, target));
  }
}

/**
 * Find the lowest of `versions` satisfying `constraint`: a stable version
 * only, unless the constraint's own minimum is a prerelease.
 */
function lowestSatisfying<V, C>(domain: VersionDomain<V, C>, versions: V[], constraint: C): V | undefined {
  const stable = (version: V): boolean => domain.isStable?.(version) ?? true;
  const stableOnly = stable(domain.minimumOf(constraint));
  return versions.filter(version => domain.satisfies(version, constraint) && (!stableOnly || stable(version))).sort(domain.compare)[0];
}

/**
 * Make a release runnable: the release is the install, launched directly,
 * and its surface offers every file by path and each command in the first of
 * `binDirectories` holding one by name (`javac`, for `javac.exe` too). A
 * command is an executable file there, or, as Windows archives record no
 * modes, an `.exe`. The release's symlinks (`bin/npm`) stay in the install
 * but are left off the surface: a symlink there is read as a command
 * targeting an install path, and these target paths relative to the link.
 */
export function releaseRunnable(release: FileSet, binDirectories: readonly string[]): RunnableFileSet {
  const files = [...release].filter(([, file]) => !(file instanceof SymlinkFile));
  const inBin = (bin: string, name: string): boolean => name.startsWith(bin) && !name.substring(bin.length).includes("/");
  const bin = binDirectories.find(dir => files.some(([name]) => inBin(dir, name)));
  const commands =
    bin === undefined
      ? []
      : files
          .filter(([name, file]) => inBin(bin, name) && (name.endsWith(EXE) || (file.mode & 0o111) !== 0))
          .map(([name]): [string, IFile] => {
            const command = name.substring(bin.length);
            return [command.endsWith(EXE) ? command.slice(0, -EXE.length) : command, new SymlinkFile(name)];
          });
  return new RunnableFileSet(release, [], undefined, "", new FileSet(new Map([...files, ...commands])));
}
