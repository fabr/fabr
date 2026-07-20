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
import { Name } from "./Name";
import { Computable } from "./Computable";
import { EMPTY_FILESET, FileSet, IFile } from "./FileSet";
import { IProvenanceStep } from "./Provenance";
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
 * *projection* is nothing but `surface.find` — bins and files match together, and
 * the result (a narrower FileSet) composes: a further `find` runs on it. `selected` is that
 * narrowed surface once a projection has been applied; absent → not yet
 * projected. `find` is overridden to this projection; other content derivations
 * (`remap`, …) fall back to a plain FileSet.
 *
 * `toCommandLine` resolves the launch entry at launch time (so a projection can
 * pick first): from `selected` if projected, else the **default** — the sole
 * declared bin, or (a bin-less package with) a sole file, else the "which entry?"
 * error. Each candidate resolves to an install path (a symlink → its target, a
 * file → `root`/name), deduped by path (a bin and its own file collapse — the
 * file wins). `RunnableFileSet.forEntry` builds the common single definite-entry
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
    /** The narrowed surface once a projection has been applied; absent → not yet projected (launch uses the default). */
    public readonly selected?: FileSet,
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
    return new RunnableFileSet(this, this.args, this.interpreter, this.root, this.surface, this.selected, this.served, this.launchCwd, origin);
  }

  /**
   * Re-wrap this runnable (the tool) over an enlarged install for serving — the
   * `serve` rule's assembly: same launch surface/interpreter/root, `extraArgs`
   * appended to the fixed args, `served` recorded as the hot content partition,
   * and the launch cwd anchored at the install root (a served program's world
   * is its staged install, not the caller's directory).
   */
  public withServedContent(install: FileSet, served: FileSet, extraArgs: string[]): RunnableFileSet {
    return new RunnableFileSet(install, [...this.args, ...extraArgs], this.interpreter, this.root, this.surface, this.selected, served, "install");
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
   * Projecting into a runnable **selects its launch entry** rather than filtering
   * files: it is `find` on the inner `surface` (or on `selected` if already
   * projected — so `find` composes), keeping the whole install and moving only the
   * entry. Bins (symlinks) and package files are matched together by one ordinary
   * `FileSet.find`. An empty match yields the empty set — lenient, like the base
   * find, so a miss reports through the shared "matched no files" path. The
   * written-name `prefix` renames result files, meaningless here, so it is ignored
   * (this override omits it).
   *
   * A rename projection (`sel -> tmpl`) rides the same path — FileSet.find applies
   * it to the surface names, still re-wrapped as a runnable (`find` on a runnable
   * always yields a runnable). It renames only the find-surface, not the install:
   * a bin still launches by its rename-invariant target. (Renaming a runnable is a
   * degenerate operation — nothing depends on it — but is allowed for uniformity.)
   */
  public find(name: Name): Computable<FileSet> {
    return (this.selected ?? this.surface)
      .find(name)
      .then(matched => (matched.size === 0 ? EMPTY_FILESET : this.withSelected(matched)));
  }

  private withSelected(selected: FileSet): RunnableFileSet {
    return new RunnableFileSet(this, this.args, this.interpreter, this.root, this.surface, selected, this.served, this.launchCwd, this.origin);
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

  /** The launch entry (install path): the sole candidate after dedup, else the "which entry?" error. */
  private resolveEntry(): string {
    const candidates = this.selected ? [...this.selected] : this.defaultCandidates();
    const byPath = new Map<string, string>();
    for (const [name, file] of candidates) {
      const target = file instanceof SymlinkFile ? file.target : this.installPath(name);
      if (!byPath.has(target)) {
        byPath.set(target, name);
      }
    }
    const paths = [...byPath.keys()];
    if (paths.length === 1) {
      return paths[0];
    }
    throw this.ambiguityError([...byPath.values()]);
  }

  /**
   * A bare package with no declared bin isn't runnable without naming a file;
   * multiple bins (or an ambiguous projection) is a "which one?" instead.
   */
  private ambiguityError(labels: string[]): Error {
    const declaresBin = [...this.surface].some(([, file]) => file instanceof SymlinkFile);
    if (this.selected === undefined && !declaresBin) {
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
