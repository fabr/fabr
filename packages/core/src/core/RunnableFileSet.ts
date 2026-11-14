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
  string | HostLink | { readonly installFile: string } | { readonly join: string; readonly parts: readonly RunnableArgument[] };

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
 * given a `./` where it is relative and has no `/`, which would otherwise
 * search PATH.
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
    return isInstallFile && !written.includes("/") && !path.isAbsolute(written) ? `./${written}` : written;
  });
}

/**
 * A FileSet that can be run: a target's install, laid out to be staged and
 * run, with how to launch it. A `BUILD_OPERATION=run` rule yields one; a
 * consumer (`fabr run`, a `generate` stage, a tool a rule runs) stages its
 * files, makes a command line with {@link toCommandLine}, finds argv[0] with
 * findExecutable, and spawns it.
 *
 * What can be launched is its `surface`: the primary package's files, by path
 * (`bin/tsc`), and a SymlinkFile per declared bin, by command (`tsc`), naming
 * the bin's install path. Where a bin and a file share a name or an install
 * path, the bin is the one found. A projection over a runnable is a pending
 * {@link FileSetRef}: {@link toRunnable} reads it as a launch entry
 * ({@link selectEntry}), and `select` and `locate` read it as files.
 *
 * {@link toCommandLine} launches the default entry: the sole declared bin, or
 * the sole file of a package declaring none; anything else is the "which
 * entry?" error. {@link forEntry} makes a runnable with one entry.
 */
export class RunnableFileSet extends FileSet {
  constructor(
    files: Iterable<[string, IFile]>,
    /** Fixed leading args, before any the caller appends. */
    public readonly args: readonly RunnableArgument[] = [],
    /** What runs the entry: a program of the host, run where it lies, or a
     * runnable (`NODE`), reached through the cache's tree pool (see
     * {@link launchedBy}). Absent where the entry is itself executable. */
    public readonly interpreter?: RunnableFileSet | HostLink,
    /** The primary package's mount within the install (e.g. `node_modules/@fabr-build/cli`); a `surface` file resolves to `root`/name. */
    public readonly root: string = "",
    /** The launch surface: the package's files by path, and a SymlinkFile per bin, by command, naming its install path. */
    public readonly surface: FileSet = EMPTY_FILESET,
    /** The part of the install that is the program's content (a `serve`
     * target's `files`), which watch mode syncs into the running program in
     * place, without a restart. Empty for an ordinary runnable. */
    public readonly served: FileSet = EMPTY_FILESET,
    /** Where the program launches: `caller`, in the user's own directory, the
     * entry named within the staged install; or `install`, at the staged
     * install's root (a served program). */
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

  /** Make a runnable whose one launch entry is `entry` (a `js_script` or `script`): a surface of one symlink. */
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
    return new RunnableFileSet(
      this,
      this.args,
      this.interpreter,
      this.root,
      this.surface,
      this.served,
      this.launchCwd,
      this.env,
      origin,
      this.interpreterArgs,
      this.teardown
    );
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

  /** Get this runnable offering `surface` as its launch surface, all else
   * unchanged ({@link selectEntry}). */
  public withSurface(surface: FileSet): RunnableFileSet {
    return new RunnableFileSet(
      this,
      this.args,
      this.interpreter,
      this.root,
      surface,
      this.served,
      this.launchCwd,
      this.env,
      this.origin,
      this.interpreterArgs,
      this.teardown
    );
  }

  /**
   * Make this runnable (the tool) over `install`, for serving (the `serve`
   * rule): `extraArgs` after its own args, `served` as its served content,
   * launched at the install's root, `env` added to its variables. Its surface,
   * interpreter and root are kept.
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
    return new RunnableFileSet(
      this,
      this.args,
      this.interpreter,
      this.root,
      this.surface,
      this.served,
      this.launchCwd,
      new Map([...this.env, ...env]),
      this.origin,
      this.interpreterArgs,
      this.teardown
    );
  }

  /** Get this runnable with `teardown` as its teardown (see {@link teardown}). */
  public withTeardown(teardown: readonly RunnableArgument[]): RunnableFileSet {
    return new RunnableFileSet(
      this,
      this.args,
      this.interpreter,
      this.root,
      this.surface,
      this.served,
      this.launchCwd,
      this.env,
      this.origin,
      this.interpreterArgs,
      teardown
    );
  }

  /**
   * Render the manifest of the install less the served content: a supervisor
   * restarts the program where this changes, and syncs a change to the served
   * content in place.
   */
  public programManifest(): string {
    return this.served.isEmpty() ? this.toManifest() : this.minus(this.served).toManifest();
  }

  /**
   * Select the launch entry `projections` name: this runnable, its install
   * whole, offering only that entry. Bins and package files are matched
   * together ({@link locate}).
   *
   * @return undefined where the projections match nothing, which the caller
   * reports as a reference matching no files.
   * @throws the "which entry?" error where they match several.
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
    /* A surface of one entry, as `forEntry` makes: the selected install path,
     * named by its basename, or the program of the host selected. */
    const host = [...this.surface].find(([, file]) => file instanceof HostLink && file.target === entry);
    return this.withSurface(new FileSet(new Map<string, IFile>([host ?? [path.posix.basename(entry), new SymlinkFile(entry)]])));
  }

  /**
   * Make the command line this runnable is run with: the interpreter, if any,
   * and `interpreterArgs`, then the launch entry, this runnable's args, and
   * `callerArgs` as they are. Reads no filesystem or PATH: the caller makes it
   * text with {@link toArgv}, finds argv[0] with findExecutable relative to the
   * launch directory, and spawns it.
   *
   * An entry that is a program of the host is that program. Any other entry,
   * and every install file among the arguments, is named relative to the
   * launch directory: under `base`, where the install is staged within it (a
   * compiler mounted apart from the workspace it works on), or with no `base`,
   * with the install as the launch directory. A runnable interpreter makes the
   * command line itself, as staged in the tree pool, with this line as its
   * caller's arguments; `pool` is the pool's path from the launch directory,
   * {@link TREE_MOUNT} by default.
   * @throws the "which entry?" error where no single entry resolves.
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
      return this.interpreter.toCommandLine(line, {
        base: path.posix.join(opts?.pool ?? TREE_MOUNT, this.interpreter.toManifestHash()),
        pool: opts?.pool,
      });
    }
    return this.interpreter === undefined ? own : [this.interpreter, ...line];
  }

  /**
   * Locate the files `projections` select on the launch surface, not the
   * install: a file by path and a bin by command, so `pkg:tsc` and
   * `pkg:bin/tsc` both match. Each result is keyed by its install path, a bin
   * by the file it names, and a bin and the file it names are one result,
   * under the bin's name.
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
   * Select as files what {@link locate} locates: the installed files the
   * projections pick on the launch surface, under the names they give them. A
   * bin yields the file it names (`pkg:tsc` is the content of `bin/tsc`, named
   * `tsc`); a bin naming no file of the install stays a symlink.
   */
  public select(projections: ReadonlyArray<IProjection>): FileSet {
    /* The base implementation over the surface, with its usual conflict
     * check. */
    const selected = this.surface.select(projections);
    const files = new Map<string, IFile>();
    for (const [name, entry] of selected) {
      /* A bin's link would point into the install, which is not part of the
       * result: take the file it names. */
      const target = entry instanceof SymlinkFile ? this.getFile(entry.target) : undefined;
      files.set(name, target ?? entry);
    }
    return new FileSet(files);
  }

  /**
   * Get the install path each of `candidates` launches, a bin the file it names
   * and a file its place under `root`, mapped to the candidate's name. Where
   * two give one path the first is kept; a surface lists its bins first, so a
   * bin keeps its name.
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
 * Get the runnable `source` denotes: a runnable itself, or a pending
 * projection over one, which selects an entry in it
 * ({@link RunnableFileSet.selectEntry}).
 *
 * @return undefined where `source` is neither, and where it is a projection
 * over a runnable that matched nothing. A caller tells the two apart, where it
 * must, by whether any content resolved.
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
