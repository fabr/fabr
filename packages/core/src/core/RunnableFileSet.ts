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

import { spawnSync } from "child_process";
import * as path from "path";
import { EMPTY_FILESET, FileSet, FileSource, IFile } from "./FileSet";
import { FileSetRef } from "./FileSetRef";
import { IProjection } from "./Reference";
import { IProvenanceStep } from "./Provenance";
import type { Repository } from "./Repository";
import { HostLink, SymlinkFile } from "./SymlinkFile";
import { FabrError } from "./Errors";
import { Computable } from "./Computable";
import { ownerName, TREE_MOUNT } from "./BuildCache";
import { registerExitTeardown } from "../support/Execute";

const NO_ENV: ReadonlyMap<string, string> = new Map();

/**
 * A fixed argument of a runnable: text; a program of the host, named on the
 * command line by where it lies; a file of the runnable's install, by its
 * install path; or parts joined into one argument by `join` (`--module-path=`
 * and the jars, joined by `path.delimiter`).
 *
 * A command line made of these is written two ways: as key text
 * ({@link manifestArguments}), which names a host program by its content and
 * command, and as the text a process is started with ({@link toArgv}).
 */
export type RunnableArgument =
  | string
  | HostLink
  | { readonly installFile: string }
  | { readonly join: string; readonly parts: readonly RunnableArgument[] };

/** @return `arg` with each install file in it named within `base`. */
function placedIn(base: string, arg: RunnableArgument): RunnableArgument {
  if (typeof arg === "string" || arg instanceof HostLink || base === "") {
    return arg;
  }
  if ("installFile" in arg) {
    return { installFile: path.posix.join(base, arg.installFile) };
  }
  return { join: arg.join, parts: arg.parts.map(part => placedIn(base, part)) };
}

/** @return the key text of `arg`, as {@link manifestArguments} writes it. */
function argumentKey(arg: RunnableArgument): unknown {
  if (typeof arg === "string") {
    return arg;
  }
  if (arg instanceof HostLink) {
    return { host: arg.contentHash, command: path.basename(arg.location) };
  }
  if ("installFile" in arg) {
    return { installFile: arg.installFile };
  }
  return { join: arg.join, parts: arg.parts.map(argumentKey) };
}

/**
 * Write `args` as key text: text as itself, an install file by its path, a
 * program of the host by its content hash and the command it is run as (never
 * where it lies), and a joined argument as its separator and parts.
 */
export function manifestArguments(args: readonly RunnableArgument[]): string {
  return JSON.stringify(args.map(argumentKey));
}

/**
 * Make the command line `args` are run as: a program of the host at its
 * location, an install file at its path (resolved against `anchor`, the
 * directory the command line is relative to, where one is given), and a
 * joined argument as its parts joined. An install file as the command is
 * given a `./` where it has no `/`, which would otherwise search PATH.
 */
export function toArgv(args: readonly RunnableArgument[], anchor?: string): string[] {
  const text = (arg: RunnableArgument): string => {
    if (typeof arg === "string") {
      return arg;
    }
    if (arg instanceof HostLink) {
      return arg.location;
    }
    if ("installFile" in arg) {
      return anchor === undefined ? arg.installFile : path.resolve(anchor, arg.installFile);
    }
    return arg.parts.map(text).join(arg.join);
  };
  return args.map((arg, index) => {
    const written = text(arg);
    const isInstallFile = index === 0 && typeof arg === "object" && !(arg instanceof HostLink) && "installFile" in arg;
    return isInstallFile && !written.includes("/") ? `./${written}` : written;
  });
}

/**
 * A FileSet that is *runnable*: the assembled, ready-to-launch install of a
 * target (its files, laid out so it can be staged and executed), plus a
 * descriptor of how to launch it. It is what a `BUILD_OPERATION=run` rule
 * yields; a consumer (`fabr run`, a `generate` command stage, a tool a rule
 * runs) stages its files, reduces it to a command line with `toCommandLine`,
 * then resolves argv[0] (via findExecutable) and spawns it under whatever I/O
 * it needs.
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
 * `root`/name), deduped by path (a bin and the file it targets collapse — the
 * bin keeps its name). `RunnableFileSet.forEntry` builds the common single
 * definite-entry runnable (a `js_script`/`script`), as a one-symlink surface.
 */
export class RunnableFileSet extends FileSet {
  constructor(
    files: Iterable<[string, IFile]>,
    /** Fixed leading args, before any the caller appends. */
    public readonly args: readonly RunnableArgument[] = [],
    /** What runs the entry: a program of the host, run where it lies, or a
     * runnable (`NODE`), reached through the cache's tree pool (see
     * {@link launchedBy}). Omitted → the entry is itself executable. */
    public readonly interpreter?: RunnableFileSet | HostLink,
    /** The primary package's mount within the install (e.g. `node_modules/@fabr-build/cli`); a `surface` file resolves to `root`/name. */
    public readonly root: string = "",
    /** The launch surface: package files (by path) + a SymlinkFile per bin (by command → install path). `locate`/`select` search this. */
    public readonly surface: FileSet = EMPTY_FILESET,
    /** The hot-swappable content partition (a `serve` target's `files`): the subset of the
     * install that is the program's *data*, synced in place under watch rather than
     * triggering a relaunch. Empty for an ordinary runnable — everything is program. */
    public readonly served: FileSet = EMPTY_FILESET,
    /** Where the program launches: `caller` — the user's own directory (the npx-like tool
     * persona; the entry is anchored at the install) — or `install` — the staged install
     * root (the app persona: a served program's world is its own content). */
    public readonly launchCwd: "caller" | "install" = "caller",
    /** Environment variables the program is launched with: over the
     * environment its launcher inherits, under any variables the launcher sets
     * itself (a `generate` target's `env`). */
    public readonly env: ReadonlyMap<string, string> = NO_ENV,
    origin?: IProvenanceStep,
    /** Arguments given the interpreter before the entry (`--module-path …`), a
     *  part of one naming a file of this runnable's own install. */
    public readonly interpreterArgs: readonly RunnableArgument[] = [],
    /** A command line undoing what the program starts outside fabr's process
     *  tree (a container an engine runs), run when a launch of it ends however
     *  it ended (see {@link startLaunch}); a part may name a file of this
     *  runnable's install. Empty where there is nothing to undo. */
    public readonly teardown: readonly RunnableArgument[] = []
  ) {
    super(files instanceof FileSet ? files : new Map(files), origin ?? (files instanceof FileSet ? files.origin : undefined));
  }

  /** Make a runnable with a single, definite launch entry — a `js_script`/`script`: a one-symlink surface. */
  public static forEntry(
    files: Iterable<[string, IFile]>,
    entry: string,
    args: readonly RunnableArgument[] = [],
    interpreter?: RunnableFileSet | HostLink
  ): RunnableFileSet {
    const surface = new FileSet(new Map<string, IFile>([[path.posix.basename(entry), new SymlinkFile(entry)]]));
    return new RunnableFileSet(files, args, interpreter, "", surface);
  }

  public withOrigin(origin: IProvenanceStep): RunnableFileSet {
    return new RunnableFileSet(this, this.args, this.interpreter, this.root, this.surface, this.served, this.launchCwd, this.env, origin, this.interpreterArgs, this.teardown);
  }

  /**
   * Get this runnable launched through `interpreter`. A program of the host
   * (an interpreter whose whole command line is one) is run where it lies;
   * any other interpreter is written once to `pool`'s tree pool and reached
   * through the pool's link beside the launch directory ({@link toCommandLine}'s
   * `pool`). Either way its content is in any key this runnable's command line
   * is. `interpreterArgs` go after the interpreter's own args, before this
   * runnable's entry (`java -jar <entry>`), naming files of this runnable's
   * install as its own args do.
   */
  public launchedBy(
    interpreter: RunnableFileSet,
    pool: { ensureTree(files: FileSet): Computable<string> },
    interpreterArgs: readonly RunnableArgument[] = []
  ): Computable<RunnableFileSet> {
    const launched = (by: RunnableFileSet | HostLink): RunnableFileSet =>
      new RunnableFileSet(
        this,
        this.args,
        by,
        this.root,
        this.surface,
        this.served,
        this.launchCwd,
        this.env,
        this.origin,
        [...this.interpreterArgs, ...interpreterArgs],
        this.teardown
      );
    const line = interpreter.toCommandLine();
    if (line.length === 1 && line[0] instanceof HostLink) {
      return Computable.resolve(launched(line[0]));
    }
    return pool.ensureTree(interpreter).then(() => launched(interpreter));
  }

  /** Get this runnable offering a different launch surface — how a projection is
   * applied ({@link selectEntry}), the install and everything else unchanged. */
  public withSurface(surface: FileSet): RunnableFileSet {
    return new RunnableFileSet(this, this.args, this.interpreter, this.root, surface, this.served, this.launchCwd, this.env, this.origin, this.interpreterArgs, this.teardown);
  }

  /**
   * Re-wrap this runnable (the tool) over an enlarged install for serving — the
   * `serve` rule's assembly: same launch surface/interpreter/root, `extraArgs`
   * appended to the fixed args, `served` recorded as the hot content partition,
   * and the launch cwd anchored at the install root (a served program's world
   * is its staged install, not the caller's directory). `env` adds to the
   * variables it is launched with.
   */
  public withServedContent(
    install: FileSet,
    served: FileSet,
    extraArgs: string[],
    env: ReadonlyMap<string, string> = NO_ENV
  ): RunnableFileSet {
    return new RunnableFileSet(
      install,
      [...this.args, ...extraArgs],
      this.interpreter,
      this.root,
      this.surface,
      served,
      "install",
      new Map([...this.env, ...env]),
      undefined,
      this.interpreterArgs,
      this.teardown
    );
  }

  /** Get this runnable with `env` set over the variables it is launched with. */
  public withEnvironment(env: ReadonlyMap<string, string>): RunnableFileSet {
    if (env.size === 0) {
      return this;
    }
    return new RunnableFileSet(this, this.args, this.interpreter, this.root, this.surface, this.served, this.launchCwd, new Map([...this.env, ...env]), this.origin, this.interpreterArgs, this.teardown);
  }

  /** Get this runnable with `teardown` as its teardown (see {@link teardown}). */
  public withTeardown(teardown: readonly RunnableArgument[]): RunnableFileSet {
    return new RunnableFileSet(this, this.args, this.interpreter, this.root, this.surface, this.served, this.launchCwd, this.env, this.origin, this.interpreterArgs, teardown);
  }

  /**
   * Render the manifest of the **program partition** — the install minus the served-content
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
     * basename, or the program of the host selected. The default-entry rules
     * then resolve it with no special case — a selected runnable and a
     * `forEntry` one are the same shape. */
    const host = [...this.surface].find(([, file]) => file instanceof HostLink && file.target === entry);
    return this.withSurface(new FileSet(new Map<string, IFile>([host ?? [path.posix.basename(entry), new SymlinkFile(entry)]])));
  }

  /**
   * Reduce this runnable to a command line: the interpreter (if any) as the
   * command, then the launch entry, the runnable's own fixed args, then the
   * caller's, which are taken as they are. Pure — no filesystem or PATH
   * access; the caller makes it text with {@link toArgv}, resolves argv[0]
   * with findExecutable, relative to the directory it launches in, and spawns.
   * An entry that is a program of the host is that program. Any other names a
   * file of the install, relative to the launch directory: `base` is where the
   * install is staged within it — for a tool staged under a subdir of the
   * launch cwd (e.g. a compiler mounted apart from the workspace it operates
   * on) — and with none, the install is the launch directory itself (the exec
   * step). A runnable interpreter is its own command line, placed in the tree
   * pool, taking this one's entry and arguments as its caller's. `pool` is
   * where the pool is, as a path from the launch directory: {@link TREE_MOUNT}
   * by default, for a launch in a step's working directory.
   * @throws if no single entry resolves — the "which entry?" error, deferred to
   * launch so a projection has the chance to pick one.
   */
  public toCommandLine(callerArgs: readonly RunnableArgument[] = [], opts?: { base?: string; pool?: string }): RunnableArgument[] {
    const base = opts?.base ?? "";
    const entry = this.resolveEntry();
    const own = [
      entry instanceof HostLink ? entry : { installFile: base === "" ? entry : path.posix.join(base, entry) },
      ...this.args.map(arg => placedIn(base, arg)),
      ...callerArgs,
    ];
    const line = [...this.interpreterArgs.map(arg => placedIn(base, arg)), ...own];
    if (this.interpreter instanceof RunnableFileSet) {
      return this.interpreter.toCommandLine(line, { base: path.posix.join(opts?.pool ?? TREE_MOUNT, this.interpreter.toManifestHash()), pool: opts?.pool });
    }
    return this.interpreter === undefined ? own : [this.interpreter, ...line];
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

  /** Get the launch entry: the sole candidate after dedup — its install path,
   * or the program of the host it is — else the "which entry?" error. */
  private resolveEntry(): string | HostLink {
    const byPath = this.installPaths(this.defaultCandidates());
    if (byPath.size === 1) {
      const [[target, name]] = byPath;
      const file = this.surface.getFile(name);
      return file instanceof HostLink ? file : target;
    }
    throw this.ambiguityError([...byPath.values()]);
  }

  /**
   * Make the error for an entry that cannot be chosen: a bare package with no
   * declared bin isn't runnable without naming a file; multiple bins (or an
   * ambiguous projection — `projected`) is a "which one?" instead.
   */
  private ambiguityError(labels: string[], projected = false): Error {
    const declaresBin = [...this.surface].some(([, file]) => file instanceof SymlinkFile);
    if (!projected && !declaresBin) {
      const hint = labels.length ? ` (e.g. <ref>:${labels[0]})` : "";
      return new FabrError(`${this.describe()} is not runnable: it declares no bin — name a file to run${hint}`);
    }
    return new FabrError(
      `${this.describe()} has ${labels.length} candidate entries (${labels.join(", ")}) — name one (e.g. <ref>:${labels[0]})`
    );
  }

  /**
   * Get the default launch candidates when nothing was projected: the sole declared
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

  /** Name this runnable for an error — the primary package name, or "the runnable". */
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
 * package collapses to content (`FileSetRef.select`/`locate`); a ref over a
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

/** A launch of a runnable, as {@link startLaunch} begins it. */
export interface ILaunch {
  /** The environment the program is launched with: `env`'s, with the launch's
   *  identifier as `FABR_LAUNCH` where the runnable has a teardown. */
  readonly env: Record<string, string> | undefined;
  /** End the launch: run the runnable's teardown, once, whatever happened. */
  end(): void;
}

let launches = 0;

/**
 * Begin a launch of `runnable`, staged at `installDir`, with `env` (undefined:
 * fabr's own): where the runnable has a teardown, give the launch an
 * identifier, `<owner>-<n>` ({@link ownerName}), in the environment as
 * `FABR_LAUNCH` for the program and its teardown to name what it starts by,
 * and arrange for the teardown to run when fabr exits, should the launch not
 * have ended first. Whoever ends the launch calls `end`. The teardown runs
 * synchronously, and a failure of it is ignored: it never outranks the
 * program's own outcome.
 */
export function startLaunch(runnable: RunnableFileSet, installDir: string, env: Record<string, string> | undefined): ILaunch {
  if (runnable.teardown.length === 0) {
    return { env, end: () => undefined };
  }
  const launchEnv = { ...(env ?? hostEnvironment()), FABR_LAUNCH: `${ownerName()}-${++launches}` };
  const [command, ...args] = toArgv(runnable.teardown, installDir);
  let ended = false;
  const end = (): void => {
    if (!ended) {
      ended = true;
      release();
      spawnSync(command, args, { env: launchEnv, stdio: "ignore", timeout: 30_000 });
    }
  };
  const release = registerExitTeardown(end);
  return { env: launchEnv, end };
}

/**
 * @return fabr's own environment, for a host program run as the user would run
 * it: a container engine finds its daemon or machine through it, a credential
 * helper its login.
 */
export function hostEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}
