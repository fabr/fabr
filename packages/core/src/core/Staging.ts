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

/**
 * Staging: writing FileSets out to directories on disk (an action's work dir, a
 * runnable's install), keeping a directory in step with successive FileSets (a
 * served install), and collecting what a tool wrote as a FileSet. Nothing here
 * knows cache keys or the blob pool, but staged files are often hardlinks into
 * the pool: replace a staged file by rename, never write into it.
 */

import * as fs from "fs";
import * as path from "path";
import { Computable } from "./Computable";
import { mapComputable } from "../support/Functional";
import { ConflictError, ExecutionError, FabrError } from "./Errors";
import { FileSet, IFile } from "./FileSet";
import { FSFile } from "./FSFileSource";
import {
  copyFile,
  deleteFile,
  hardlink,
  hashFile,
  mkdir,
  readOnlyPermissions,
  rename,
  symlink,
  walkTree,
  writeFile,
} from "./FSWrapper";
import { Name } from "./Name";
import { HostLink, SymlinkFile } from "./SymlinkFile";
import { describeSystemError, killLiveChildren } from "../support/Execute";
import { globMatcher } from "../support/Glob";
import { toPosix } from "../support/Paths";

/** Temp trees in use, so the exit hook can remove whatever is still live when
 * the process ends. */
const liveTempTrees = new Set<string>();
let tempExitHookInstalled = false;

/**
 * Register an already-created temp tree for removal when fabr exits, and
 * return it. Callers release it on their normal path ({@link removeTempTree});
 * the exit hook removes whatever is still registered, after killing live child
 * processes. Register anything that must be removed on exit: `process.exit`
 * (which fabr's signal handlers call) runs no Computable continuation, so a
 * `finally` that removes the tree never runs. Where the tree lives is the
 * cache's choice ({@link BuildCache.createWorkDir}).
 */
export function registerTempTree(dir: string): string {
  if (!tempExitHookInstalled) {
    tempExitHookInstalled = true;
    process.on("exit", () => {
      /* Kill live children first: this hook is installed before Execute's
       * (the cache registers its work tree before anything spawns), so would
       * otherwise remove the trees while children still run in them. */
      killLiveChildren();
      for (const tree of liveTempTrees) {
        rmTempTree(tree);
      }
      liveTempTrees.clear();
    });
  }
  liveTempTrees.add(dir);
  return dir;
}

/** Release a temp tree: remove it and forget it. A tree already released,
 * or already gone, is fine. */
export function removeTempTree(dir: string): void {
  liveTempTrees.delete(dir);
  rmTempTree(dir);
}

/** Remove `dir` and everything under it, ignoring any failure. Never throw
 * here: it also runs from the exit hook. */
function rmTempTree(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* A later run reaps a dead process's work tree. */
  }
}

/**
 * Write `files` into `targetDir`, leaving anything else there untouched.
 *
 * By default a file with content on disk is hardlinked (sharing the cache's
 * read-only blob), and an in-memory file is written read-only to match; a
 * path that already exists fails the write with a {@link ConflictError}, which
 * names both sides where two names fold to one path on a case-insensitive
 * filesystem. With `copy: true`, for a destination the user owns (`fabr cp`), each
 * file is copied at its own mode, overwriting what is there, so an edit of it
 * cannot write into a cache blob.
 *
 * A {@link SymlinkFile} whose target resolves outside `targetDir` is skipped
 * without a word; a {@link HostLink} is staged as a link to its program. Any
 * other filesystem failure rejects as an {@link ExecutionError}.
 */
export function writeFileSet(targetDir: string, files: FileSet, options?: { copy?: boolean }): Computable<void> {
  const root = path.resolve(targetDir);
  let realRoot: string | undefined;
  /* Every write but a copy's fails where the path exists (a link refuses to
   * overwrite, an in-memory write is exclusive), so two names that fold to one
   * path are reported rather than one overwriting the other. A copy overwrites,
   * as `cp` does. */
  const stage = (op: Computable<void>, name: string): Computable<void> =>
    op.catch((err: unknown) => {
      if (!options?.copy && (err as NodeJS.ErrnoException)?.code === "EEXIST") {
        /* Two staged names fold to one path on a case-insensitive filesystem.
         * Find the other name to report both, each attributed through the
         * set's provenance. */
        const folded = name.toLowerCase();
        let other: string | undefined;
        for (const [candidate] of files) {
          if (candidate !== name && candidate.toLowerCase() === folded) {
            other = candidate;
            break;
          }
        }
        throw new ConflictError(
          "case-colliding names",
          name,
          { provenance: files.origin, detail: other ?? "an existing file at that path" },
          { provenance: files.origin, detail: name }
        );
      }
      throw new ExecutionError(describeSystemError(err));
    });
  /* Resolve every name first, create the distinct parent directories
   * together, and only then write. Do not mkdir synchronously per file: that
   * blocks the event loop the build is scheduled on. */
  const staged = [...files].map(([name, file]) => contained(root, name, file));
  return mapComputable(new Set(staged.map(entry => entry.dirname)), dir => mkdir(dir)).then(() => writeStaged(staged));

  /* Run once the directories exist: the symlink check reads a parent's real
   * path. */
  function writeStaged(entries: typeof staged): Computable<void> {
    return mapComputable(entries, ({ name, file, targetName, dirname }) => {
      const filepath = file.getAbsPath();
      if (file instanceof HostLink) {
        /* Staged unchecked, the one link that leads out of the tree: only fabr
         * makes a HostLink, naming a program it found on this host. */
        return stage(symlink(file.location, targetName), name);
      }
      if (file instanceof SymlinkFile) {
        /* Security: stage a symlink only where its target stays within the
         * tree, so nothing written through it can reach outside. Resolve the
         * target against the parent's real path: path.resolve alone is lexical
         * and does not follow a symlinked parent. */
        realRoot ??= fs.realpathSync(path.resolve(targetDir));
        const resolved = path.resolve(fs.realpathSync(dirname), file.target);
        const inside = resolved === realRoot || resolved.startsWith(realRoot + path.sep);
        return inside ? stage(symlink(file.target, targetName), name) : undefined;
      }
      if (filepath) {
        /* A hardlink has the read-only blob's mode (0o444/0o555); a copy is
         * given the file's own mode. */
        return stage(
          options?.copy
            ? copyFile(filepath, targetName).then(() => fs.chmodSync(targetName, file.mode & 0o7777))
            : hardlink(filepath, targetName),
          name
        );
      }
      /* As a file on disk would be: a copy at its own mode, a staged file
       * read-only like the blobs beside it (stagedPermissions). */
      const mode = options?.copy ? file.mode & 0o7777 : stagedPermissions(file.mode);
      return stage(
        file
          .getBuffer()
          .then(buffer => writeFile(targetName, buffer, { exclusive: !options?.copy }))
          .then(() => fs.chmodSync(targetName, mode)),
        name
      );
    }).then(() => undefined);
  }
}

/** Get the read-only mode an in-memory file of `mode` is staged with: the blobs' modes (0o444, or 0o555 where executable), or its owner's bits alone where `mode` grants nothing to anyone else (a secret). */
function stagedPermissions(mode: number): number {
  const readOnly = readOnlyPermissions(mode);
  return (mode & 0o077) === 0 ? readOnly & 0o700 : readOnly;
}

/** Make a staged entry with its resolved destination and that destination's
 * parent, asserting the destination lies within `root`. */
function contained(root: string, name: string, file: IFile): { name: string; file: IFile; targetName: string; dirname: string } {
  const targetName = path.resolve(root, name);
  assertContained(root, targetName, name);
  return { name, file, targetName, dirname: path.dirname(targetName) };
}

/** Assert a resolved write target lies within the staged root. A FileSet's
 * names are canonical (no `../`, no absolute path; see canonicalFileName), so
 * this fails only on an internal error. */
function assertContained(root: string, targetName: string, name: string): void {
  if (targetName !== root && !targetName.startsWith(root + path.sep)) {
    throw new FabrError(`Internal error: file name '${name}' resolves outside the staging directory '${root}'`);
  }
}

/** Counter for temp-sibling names, never reused in the process. */
let tempCounter = 0;

/**
 * Update `targetDir`, staged as `before`, to hold `after`: write each file that
 * is new or whose content hash changed, remove each file `after` lacks, and
 * leave the rest. Each write goes to a temp sibling renamed into place, so a
 * reader (the running program, a watcher) never sees a half-written file and a
 * hardlink into the cache is replaced, never written into. Directories the
 * removals empty are removed once every write and removal has finished. A
 * name may change between a file (or symlink) and a directory: what is in the
 * write's way is removed first.
 *
 * Resolves to the number of files written and removed. A {@link SymlinkFile}
 * whose target resolves outside `targetDir` is skipped and not counted
 * (`written` counts only what was written). Filesystem failures reject as an
 * {@link ExecutionError}.
 */
export function syncFileSet(targetDir: string, before: FileSet, after: FileSet): Computable<{ written: number; removed: number }> {
  const root = path.resolve(targetDir);
  let realRoot: string | undefined;
  /* Resolve and check every name before anything touches the filesystem. */
  const changed = [...after]
    .filter(([name, file]) => before.getFile(name)?.hash !== file.hash)
    .map(([name, file]) => contained(root, name, file));
  const gone = [...before].filter(([name]) => after.getFile(name) === undefined).map(([name, file]) => contained(root, name, file));
  /* A removal is in the way where a write needs its name as a directory (a
   * file or symlink becoming a directory) or lies under a name written as a
   * file (a directory becoming one): remove those, and the directories they
   * empty, before anything else. */
  const writtenNames = new Set(changed.map(entry => entry.targetName));
  const writtenDirs = new Set(changed.flatMap(entry => ancestorsWithin(root, entry.targetName)));
  const inTheWay = gone.filter(
    entry => writtenDirs.has(entry.targetName) || ancestorsWithin(root, entry.targetName).some(dir => writtenNames.has(dir))
  );
  const removedLater = gone.filter(entry => !inTheWay.includes(entry));
  /* Then create the parents of everything to be written, together. */
  return mapComputable(inTheWay, ({ targetName }) => asExecutionError(deleteFile(targetName)))
    .then(() => pruneEmptyDirs(root, new Set(inTheWay.map(entry => entry.dirname))))
    .then(() => mapComputable(new Set(changed.map(entry => entry.dirname)), dir => mkdir(dir)))
    .then(() => applySync());

  /* Run once the directories exist: the symlink check reads a parent's real
   * path. */
  function applySync(): Computable<{ written: number; removed: number }> {
    /* As in writeFileSet, a symlink whose target leaves the tree is skipped. */
    const written = changed.filter(({ file, dirname }) => {
      if (!(file instanceof SymlinkFile) || file instanceof HostLink) {
        return true;
      }
      realRoot ??= fs.realpathSync(root);
      const resolved = path.resolve(fs.realpathSync(dirname), file.target);
      return resolved === realRoot || resolved.startsWith(realRoot + path.sep);
    });
    const writes = mapComputable(written, ({ file, targetName }) => {
      const temp = `${targetName}.fabr-sync-${process.pid}-${tempCounter++}`;
      const filepath = file.getAbsPath();
      if (file instanceof HostLink) {
        return stageWrite(temp, targetName, symlink(file.location, temp));
      }
      if (file instanceof SymlinkFile) {
        return stageWrite(temp, targetName, symlink(file.target, temp));
      }
      if (filepath) {
        return stageWrite(temp, targetName, hardlink(filepath, temp));
      }
      /* Read-only like the blobs beside it; chmod the temp before the rename so
       * the file never appears at another mode. */
      return stageWrite(
        temp,
        targetName,
        file
          .getBuffer()
          .then(buffer => writeFile(temp, buffer))
          .then(() => fs.chmodSync(temp, stagedPermissions(file.mode)))
      );
    });
    /* Remove the gone files alongside the writes (their names are disjoint).
     * Prune their parents only after both finish: a removal can empty a
     * directory a write is still renaming a file into. */
    const removals = mapComputable(removedLater, ({ targetName }) => asExecutionError(deleteFile(targetName)));
    return Computable.forAll([writes, removals], () => undefined)
      .then(() => pruneEmptyDirs(root, new Set(removedLater.map(entry => entry.dirname))))
      .then(() => ({ written: written.length, removed: gone.length }));
  }
}

/** Finish one staged write: once `create` has made `temp`, rename it over
 * `targetName`. On any failure, remove `temp` where possible and reject as an
 * {@link ExecutionError}. Use it for any write that may land on a hardlink into
 * the blob pool (the write-back path does). */
export function stageWrite(temp: string, targetName: string, create: Computable<void>): Computable<void> {
  return asExecutionError(
    create
      .then(() => rename(temp, targetName))
      .catch(err => {
        try {
          fs.rmSync(temp, { force: true });
        } catch {
          /* best-effort — never outrank the original failure */
        }
        throw err;
      })
  );
}

/** Remove each candidate directory that is empty, and each parent it leaves
 * empty, up to but not including `root`. The walk stops at the first
 * directory that cannot be removed. Run only once no write into the tree is in
 * progress. */
/** @return the directories strictly between `root` and `targetName`, nearest
 * first. */
function ancestorsWithin(root: string, targetName: string): string[] {
  const dirs: string[] = [];
  for (let dir = path.dirname(targetName); dir !== root && dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
    dirs.push(dir);
  }
  return dirs;
}

function pruneEmptyDirs(root: string, candidates: Set<string>): void {
  for (const start of candidates) {
    for (let dir = start; dir !== root && dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
      try {
        fs.rmdirSync(dir);
      } catch {
        break;
      }
    }
  }
}

/** Reject with an {@link ExecutionError} where `operation` fails. */
function asExecutionError<T>(operation: Computable<T>): Computable<T> {
  return operation.catch(err => {
    throw new ExecutionError(describeSystemError(err));
  });
}

/**
 * Collect the files a build step wrote under `targetDir` that `output`
 * selects, each named as `output` projects it, and delete every other file
 * there (a symlink is removed, never its target; directories stay). `output`
 * is a `dir:glob` string (select under `dir`, named relative to it), a
 * {@link Name} projection (`:`-strip, slash-retain, and an optional
 * `sel -> tmpl` rename), or several of these, of which the first to select a
 * file names it (the test run's report and the snapshots it refreshed).
 *
 * Rejects with a {@link ConflictError} where two different files are given
 * one name, and with an {@link ExecutionError} where a deletion fails.
 */
export function getResultFileSet(targetDir: string, output: OutputSelection): Computable<FileSet> {
  return getResultFileSets(targetDir, [output]).then(([files]) => files);
}

/** What {@link getResultFileSet} selects by: a projection, or several of
 * which the first to select a file names it. */
export type OutputSelection = Name | string | ReadonlyArray<Name | string>;

/**
 * Collect as {@link getResultFileSet} does for several selections at once,
 * returning one set per selection, each naming the files it selects as it
 * projects them; a file two select is in both sets. Only what no selection
 * selects is deleted.
 */
export function getResultFileSets(targetDir: string, selections: ReadonlyArray<OutputSelection>): Computable<FileSet[]> {
  const projectors = selections.map(outputProjector);
  const results = selections.map(() => new Map<string, IFile>());
  /* The path each output name came from, per selection, for a conflict message. */
  const sources = selections.map(() => new Map<string, string>());
  /* Every non-directory entry of the tree, with the name each selection collects
   * it under (none: that selection drops it). */
  const found: Array<{ abspath: string; rel: string; names: Array<string | undefined> }> = [];

  /* Walk without following symlinks (walkTree recurses into real directories
   * only): a linked file would be visited twice, and a link may form a cycle.
   * Only regular files are collected; a symlink is deleted as a link. */
  return walkTree(targetDir, (entry, abspath) => {
    if (!entry.isDirectory()) {
      const rel = toPosix(path.relative(targetDir, abspath));
      found.push({ abspath, rel, names: projectors.map(project => (entry.isFile() ? project(rel) : undefined)) });
    }
  })
    .then(() =>
      mapComputable(found, ({ abspath, rel, names }) => {
        if (names.every(name => name === undefined)) {
          return asExecutionError(deleteFile(abspath));
        }
        return hashFile(abspath).then(({ hash, mime }) => {
          /* A file at its place in the work dir (storeContent later moves it
           * into the pool), keyed in the set by its projected name. */
          const file = new FSFile(abspath, rel, fs.statSync(abspath), hash, mime);
          names.forEach((name, i) => {
            if (name === undefined) {
              return;
            }
            const existing = results[i].get(name);
            if (existing && !existing.isSameFile(file)) {
              throw new ConflictError(
                "collected files",
                name,
                { provenance: undefined, detail: sources[i].get(name) ?? existing.getDisplayName() },
                { provenance: undefined, detail: rel }
              );
            }
            results[i].set(name, file);
            sources[i].set(name, rel);
          });
        });
      })
    )
    .then(() => results.map(result => new FileSet(result)));
}

/**
 * Make a function from a path relative to the work dir to the name `output`
 * collects it under, or undefined where `output` does not select it. A
 * {@link Name} is its own {@link Name.makeProjector}; a `dir:glob` string
 * selects what the glob matches under `dir/` and names it relative to `dir`;
 * a list tries each in turn.
 */
function outputProjector(output: OutputSelection): (rel: string) => string | undefined {
  if (typeof output !== "string" && !(output instanceof Name)) {
    const projectors = output.map(one => outputProjector(one));
    return rel => {
      for (const project of projectors) {
        const name = project(rel);
        if (name !== undefined) {
          return name;
        }
      }
      return undefined;
    };
  }
  if (output instanceof Name) {
    return output.makeProjector();
  }
  const colon = output.indexOf(":");
  const prefix = colon === -1 ? "" : output.substring(0, colon) + "/";
  const matcher = globMatcher(colon === -1 ? output : output.substring(colon + 1));
  return rel => {
    if (prefix !== "" && !rel.startsWith(prefix)) {
      return undefined;
    }
    const inner = rel.substring(prefix.length);
    return matcher(inner) ? inner : undefined;
  };
}
