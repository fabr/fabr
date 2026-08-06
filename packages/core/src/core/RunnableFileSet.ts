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

import * as path from "path";
import { EMPTY_FILESET, FileSet, FileSource, IFile } from "./FileSet";
import { FileSetRef, IProjection } from "./FileSetRef";
import { IProvenanceStep } from "./Provenance";
import type { Repository } from "./Repository";
import { SymlinkFile } from "./SymlinkFile";

/**
 * A FileSet that is *runnable*: the assembled, ready-to-launch install of a
 * target (its files, laid out so it can be staged and executed), plus a
 * descriptor of how to launch it. It is what a `BUILD_OPERATION=run` rule
 * yields; a consumer (`fabr run`, the generic `run` target, golden tests) stages
 * its files, reduces it to a command line with `toCommandLine`, then resolves
 * argv[0] (via findExecutable) and spawns it under whatever I/O it needs.
 *
 * The launchable entries live in an inner **`surface`** FileSet: the primary
 * package's files (findable by path, e.g. `bin/tsc`) unioned with a `SymlinkFile`
 * per declared bin (findable by command, e.g. `tsc`, whose target is the bin's
 * install path; a bin takes precedence over a file — it wins its command name and
 * a same-path dedup). A **bin is thus just a symlink in a FileSet**, so a
 * *projection* is nothing but a `locate` over the surface — bins and files match
 * together.
 *
 * A runnable carries **no reference state**: projecting one yields an ordinary
 * pending {@link FileSetRef} (which composes by accumulating), and what that ref
 * means is decided by THIS class when a consumer demands something of it —
 * `selectEntry` for a launcher ({@link toRunnable}), `select`/`locate` for
 * content. So this class only ever describes a runnable whose entry is already
 * decided.
 *
 * `toCommandLine` resolves the launch entry from the surface: the sole declared
 * bin, or (a bin-less package with) a sole file, else the "which entry?" error.
 * Each candidate resolves to an install path (a symlink → its target, a file →
 * `root`/name), deduped by path (a bin and its own file collapse — the file
 * wins). `RunnableFileSet.forEntry` builds the common single definite-entry
 * runnable (a `js_script`/`script`), as a one-symlink surface.
 */
export class RunnableFileSet extends FileSet {
  constructor(
    files: Iterable<[string, IFile]>,
    /** Fixed leading args, before any the caller appends. */
    public readonly args: string[] = [],
    /** A PATH tool that runs the entry (e.g. "node"); omitted → the entry is itself executable. */
    public readonly interpreter?: string,
    /** The primary package's mount within the install (e.g. `node_modules/@fabr-build/cli`); a `surface` file resolves to `root`/name. */
    public readonly root: string = "",
    /** The launch surface: package files (by path) + a SymlinkFile per bin (by command → install path). `find` searches this. */
    public readonly surface: FileSet = EMPTY_FILESET,
    /** The hot-swappable content partition (a `serve` target's `files`): the subset of the
     * install that is the program's *data*, synced in place under watch rather than
     * triggering a relaunch. Empty for an ordinary runnable — everything is program. */
    public readonly served: FileSet = EMPTY_FILESET,
    /** Where the program launches: `caller` — the user's own directory (the npx-like tool
     * persona; the entry is anchored at the install) — or `install` — the staged install
     * root (the app persona: a served program's world is its own content). */
    public readonly launchCwd: "caller" | "install" = "caller",
    origin?: IProvenanceStep
  ) {
    super(new Map(files), origin ?? (files instanceof FileSet ? files.origin : undefined));
  }

  /** A runnable with a single, definite launch entry — a `js_script`/`script`: a one-symlink surface. */
  public static forEntry(
    files: Iterable<[string, IFile]>,
    entry: string,
    args: string[] = [],
    interpreter?: string
  ): RunnableFileSet {
    const surface = new FileSet(new Map<string, IFile>([[path.posix.basename(entry), new SymlinkFile(entry)]]));
    return new RunnableFileSet(files, args, interpreter, "", surface);
  }

  public withOrigin(origin: IProvenanceStep): RunnableFileSet {
    return new RunnableFileSet(this, this.args, this.interpreter, this.root, this.surface, this.served, this.launchCwd, origin);
  }

  /** This runnable offering a different launch surface — how a projection is
   * applied ({@link selectEntry}), the install and everything else unchanged. */
  public withSurface(surface: FileSet): RunnableFileSet {
    return new RunnableFileSet(this, this.args, this.interpreter, this.root, surface, this.served, this.launchCwd, this.origin);
  }

  /**
   * Re-wrap this runnable (the tool) over an enlarged install for serving — the
   * `serve` rule's assembly: same launch surface/interpreter/root, `extraArgs`
   * appended to the fixed args, `served` recorded as the hot content partition,
   * and the launch cwd anchored at the install root (a served program's world
   * is its staged install, not the caller's directory).
   */
  public withServedContent(install: FileSet, served: FileSet, extraArgs: string[]): RunnableFileSet {
    return new RunnableFileSet(install, [...this.args, ...extraArgs], this.interpreter, this.root, this.surface, served, "install");
  }

  /**
   * Manifest of the **program partition** — the install minus the served-content
   * names. With no served partition this is the whole-install manifest. What a
   * supervisor keys restarts on (content-only changes sync in place instead);
   * a name in `served` IS the served file — a same-name collision with the
   * program install would already have been a ConflictError at assembly.
   */
  public programManifest(): string {
    return this.served.isEmpty() ? this.toManifest() : this.minus(this.served).toManifest();
  }

  /**
   * Apply a reference's projections, **selecting the launch entry** rather than
   * filtering files: the install is kept whole and only the entry moves. Bins
   * (symlinks) and package files are matched together by one ordinary `locate`,
   * whose keys are install paths — so the result is this runnable offering that
   * one entry, and nothing downstream needs to know it was ever projected.
   *
   * @return undefined when the projection matched nothing — lenient, so a miss
   * reports through the shared "matched no files" path rather than as a runnable
   * that fails at launch.
   * @throws the "which entry?" error when it matched several. Ambiguity is
   * judged here, at the point a launcher is demanded, so a reference that
   * narrows further ({@link FileSetRef.find}) still gets its chance.
   */
  public selectEntry(projections: ReadonlyArray<IProjection>): RunnableFileSet | undefined {
    const located = this.locate(projections);
    if (located.size === 0) {
      return undefined;
    }
    if (located.size > 1) {
      throw this.ambiguityError([...located.values()], true);
    }
    const [entry] = [...located.keys()];
    /* A one-symlink surface: the selected install path, addressed by its own
     * basename. The default-entry rules then resolve it with no special case —
     * a selected runnable and a `forEntry` one are the same shape. */
    return this.withSurface(new FileSet(new Map<string, IFile>([[path.posix.basename(entry), new SymlinkFile(entry)]])));
  }

  /**
   * Reduce this runnable to a command line: the interpreter (if any) as the
   * command, then the launch entry, the runnable's own fixed args, then the
   * caller's. Pure — no filesystem or PATH access; the caller resolves argv[0]
   * with findExecutable and spawns. `base` prepends a (relative) mount prefix to
   * the entry — for a tool staged under a subdir of the launch cwd (e.g. a
   * compiler mounted apart from the workspace it operates on). `anchor` (the
   * staged install dir) instead makes the entry absolute, for launching with a
   * cwd *other* than the install (fabr run, in the user's directory); with
   * neither, the entry stays install-relative (the exec step, cwd == install).
   * @throws if no single entry resolves — the "which entry?" error, deferred to
   * launch so a projection has the chance to pick one.
   */
  public toCommandLine(callerArgs: string[] = [], opts?: { anchor?: string; base?: string }): string[] {
    const resolved = this.resolveEntry();
    const based = opts?.base ? path.posix.join(opts.base, resolved) : resolved;
    const entry = opts?.anchor ? path.resolve(opts.anchor, based) : based;
    return [...(this.interpreter ? [this.interpreter] : []), entry, ...this.args, ...callerArgs];
  }

  /**
   * Locate against the launch **surface** rather than the raw install: a runnable
   * is addressed by what it offers to launch — its files by path AND a declared
   * bin by command name — so `pkg:tsc` and `pkg:bin/tsc` both resolve, the bin
   * winning its name.
   *
   * Keys are install paths, so a matched bin reports the file it TARGETS rather
   * than the command it matched under: a caller joining its mount point onto the
   * symlink's own name would point at nothing. Dedup by that path (first wins,
   * bins being first) so a bin and the file it targets are one result, as at
   * launch.
   */
  public locate(projections: ReadonlyArray<IProjection>): Map<string, string> {
    const projected = this.surface.locate(projections);
    const matched: Array<[string, IFile]> = [...projected.keys()].map(name => [name, this.surface.getFile(name)!]);
    const located = new Map<string, string>();
    for (const [path, name] of this.installPaths(matched)) {
      located.set(path, projected.get(name)!);
    }
    return located;
  }

  /**
   * Select as content what {@link locate} selects as positions: the *installed*
   * files the projection picks, under their projected names. A bin yields the
   * file it TARGETS (`pkg:tsc` → the contents of `bin/tsc`, called `tsc`).
   *
   * Overridden because a runnable is addressed by its launch surface, not by its
   * install paths — the base implementation would match `pkg:tsc` against
   * `node_modules/typescript/bin/tsc` and find nothing, so the one written
   * reference would mean different things depending on which reading a consumer
   * asked for.
   */
  public select(projections: ReadonlyArray<IProjection>): FileSet {
    /* The base implementation over the SURFACE — so renaming and its collision
     * check are the ordinary ones, and only the namespace differs. */
    const selected = this.surface.select(projections);
    const files = new Map<string, IFile>();
    for (const [name, entry] of selected) {
      /* A bin is a symlink into the install, and content means the file it
       * TARGETS — extracting the link verbatim would point into the container
       * this reading just discarded (locate reports that same file's path,
       * rather than the command's, for the same reason). A target that isn't in
       * the install stays a symlink, for the staging layer to judge. */
      const target = entry instanceof SymlinkFile ? this.getFile(entry.target) : undefined;
      files.set(name, target ?? entry);
    }
    return new FileSet(files);
  }

  /**
   * Resolve surface names to the install paths they launch — a declared bin to
   * the file it TARGETS, a plain file to its own place under `root` — keyed by
   * path so a bin and the file it points at are one entry. First wins, and the
   * surface puts bins first, so a bin keeps its name in the result.
   */
  private installPaths(candidates: Iterable<[string, IFile]>): Map<string, string> {
    const byPath = new Map<string, string>();
    for (const [name, file] of candidates) {
      const target = file instanceof SymlinkFile ? file.target : this.installPath(name);
      if (!byPath.has(target)) {
        byPath.set(target, name);
      }
    }
    return byPath;
  }

  /** The launch entry (install path): the sole candidate after dedup, else the "which entry?" error. */
  private resolveEntry(): string {
    const byPath = this.installPaths(this.defaultCandidates());
    const paths = [...byPath.keys()];
    if (paths.length === 1) {
      return paths[0];
    }
    throw this.ambiguityError([...byPath.values()]);
  }

  /**
   * A bare package with no declared bin isn't runnable without naming a file;
   * multiple bins (or an ambiguous projection — `projected`) is a "which one?"
   * instead.
   */
  private ambiguityError(labels: string[], projected = false): Error {
    const declaresBin = [...this.surface].some(([, file]) => file instanceof SymlinkFile);
    if (!projected && !declaresBin) {
      const hint = labels.length ? ` (e.g. <ref>:${labels[0]})` : "";
      return new Error(`${this.describe()} is not runnable: it declares no bin — name a file to run${hint}`);
    }
    return new Error(
      `${this.describe()} has ${labels.length} candidate entries (${labels.join(", ")}) — name one (e.g. <ref>:${labels[0]})`
    );
  }

  /**
   * The default launch candidates when nothing was projected: the sole declared
   * bin, or (for a bin-less package) a sole file — anything else needs narrowing,
   * so hand back the ambiguous set (the bins, else all files) for the error.
   */
  private defaultCandidates(): [string, IFile][] {
    const bins = [...this.surface].filter(([, file]) => file instanceof SymlinkFile);
    if (bins.length === 1) {
      return bins;
    }
    if (bins.length === 0 && this.surface.size === 1) {
      return [...this.surface];
    }
    return bins.length > 0 ? bins : [...this.surface];
  }

  private installPath(rel: string): string {
    return this.root ? `${this.root}/${rel}` : rel;
  }

  /** A short identifier for errors — the primary package name, or "the runnable". */
  private describe(): string {
    return this.root ? `'${this.root.replace(/^node_modules\//, "")}'` : "the runnable";
  }
}

/**
 * Collapse a resolved source to the runnable it denotes: a runnable is itself,
 * and a pending projection *over* a runnable selects an entry within it (see
 * {@link RunnableFileSet.selectEntry}).
 *
 * This is the one place that reading is applied. A ref stays inert data — how a
 * projection applies is decided by the **base's** class, at the point a consumer
 * demands something of it, never by the producer that suspended it. A ref over a
 * package collapses to content (`FileSetRef.flat`/`locate`); a ref over a
 * runnable collapses to a launcher, here.
 *
 * @return undefined when the source is not (a projection over) a runnable, and
 * equally when it is one whose projection matched nothing. The two are
 * deliberately one answer — "no runnable to launch" — which the callers
 * distinguish, where it matters, by whether any content resolved at all.
 */
export function toRunnable(source: FileSource | Repository | FileSetRef): RunnableFileSet | undefined {
  if (source instanceof RunnableFileSet) {
    return source;
  }
  if (source instanceof FileSetRef && source.source instanceof RunnableFileSet) {
    return source.source.selectEntry(source.projections);
  }
  return undefined;
}
