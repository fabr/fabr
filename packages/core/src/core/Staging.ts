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
 * Staging: moving FileSets between the in-memory graph and real on-disk trees —
 * write a set out (an action's work dir, a runnable's install), keep a live
 * tree tracking successive snapshots (a served install), and collect what a
 * tool wrote back into a FileSet. Deliberately apart from the BuildCache: these
 * are filesystem-materialization primitives with no knowledge of cache keys or
 * the blob pool (they meet the cache only in that staged files are often
 * hardlinks into it — which is why replacement is by rename, never an in-place
 * write).
 */

import * as fs from "fs";
import * as path from "path";
import { Computable } from "./Computable";
import { ExecutionError } from "./Errors";
import { FileSet, IFile } from "./FileSet";
import { FSFile } from "./FSFileSource";
import { copyFile, deleteFile, hardlink, hashFile, rename, symlink, walkTree, writeFile } from "./FSWrapper";
import { SymlinkFile } from "./SymlinkFile";
import { describeSystemError } from "../support/Execute";
import { globMatcher } from "../support/Glob";

/**
 * Materialize a FileSet into `targetDir` (additive — only the given files are
 * written; nothing else in the tree is touched). By default a cache-backed file
 * is **hardlinked** (cheap, shares the blob) — correct for an ephemeral staged
 * tree fabr owns. Pass `copy: true` when the destination is durable user-space
 * (`fabr cp`): the file is copied so an edit of it can never write through to
 * the shared cache blob.
 */
export function writeFileSet(targetDir: string, files: FileSet, options?: { copy?: boolean }): Computable<void> {
  const operations = [];
  let realRoot: string | undefined;
  for (const [name, file] of files) {
    const targetName = path.resolve(targetDir, name);
    const dirname = path.dirname(targetName);
    fs.mkdirSync(dirname, { recursive: true });
    const filepath = file.getAbsPath();
    if (file instanceof SymlinkFile) {
      /* Security: a symlink whose target escapes the staged tree (via `..`, an
       * absolute path, or a symlinked parent component) could point at — or,
       * written-through, clobber — files outside it. Resolve the target against
       * the *real* parent directory (path.resolve is purely lexical and would not
       * follow symlinks in the path), and only stage it if it stays within the
       * real root. */
      realRoot ??= fs.realpathSync(path.resolve(targetDir));
      const resolved = path.resolve(fs.realpathSync(dirname), file.target);
      if (resolved === realRoot || resolved.startsWith(realRoot + path.sep)) {
        operations.push(asExecutionError(symlink(file.target, targetName)));
      }
    } else if (filepath) {
      operations.push(asExecutionError(options?.copy ? copyFile(filepath, targetName) : hardlink(filepath, targetName)));
    } else {
      operations.push(asExecutionError(file.getBuffer().then(buffer => writeFile(targetName, buffer))));
    }
  }
  return Computable.forAll(operations, () => {});
}

/**
 * Update an already-staged tree in place to match `after`: write files that are
 * new or changed (judged by content hash against `before`), remove files that
 * are gone, leave the rest untouched — the incremental complement of
 * {@link writeFileSet}, for a tree with a live consumer (a served install, any
 * continuously-materialized output). Each write goes to a temp sibling and is
 * renamed into place, so a concurrent reader (the running program, an fs
 * watcher) never observes a half-written file — and an existing hardlink into
 * the cache is never written through (the link is replaced; the blob stays
 * untouched). Removals prune now-empty parent directories best-effort. Resolves
 * to the applied delta counts, for progress reporting.
 */
export function syncFileSet(targetDir: string, before: FileSet, after: FileSet): Computable<{ written: number; removed: number }> {
  const operations = [];
  let realRoot: string | undefined;
  let written = 0;
  let removed = 0;
  let tempCounter = 0;
  for (const [name, file] of after) {
    if (before.getFile(name)?.hash === file.hash) {
      continue;
    }
    const targetName = path.resolve(targetDir, name);
    const dirname = path.dirname(targetName);
    fs.mkdirSync(dirname, { recursive: true });
    const temp = `${targetName}.fabr-sync-${process.pid}-${tempCounter++}`;
    const filepath = file.getAbsPath();
    if (file instanceof SymlinkFile) {
      /* Same containment guard as writeFileSet: a target escaping the staged
       * tree is silently not staged. */
      realRoot ??= fs.realpathSync(path.resolve(targetDir));
      const resolved = path.resolve(fs.realpathSync(dirname), file.target);
      if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep)) {
        continue;
      }
      operations.push(asExecutionError(symlink(file.target, temp).then(() => rename(temp, targetName))));
    } else if (filepath) {
      operations.push(asExecutionError(hardlink(filepath, temp).then(() => rename(temp, targetName))));
    } else {
      operations.push(
        asExecutionError(
          file
            .getBuffer()
            .then(buffer => writeFile(temp, buffer))
            .then(() => rename(temp, targetName))
        )
      );
    }
    written++;
  }
  for (const [name] of before) {
    if (after.getFile(name) === undefined) {
      operations.push(asExecutionError(removeStaged(targetDir, name)));
      removed++;
    }
  }
  return Computable.forAll(operations, () => ({ written, removed }));
}

/** Remove one synced-away file and prune its now-empty parent dirs (best-effort,
 * never past the staged root — a non-empty parent just stops the walk). */
function removeStaged(targetDir: string, name: string): Computable<void> {
  const root = path.resolve(targetDir);
  return deleteFile(path.resolve(root, name)).then(() => {
    for (let dir = path.dirname(path.resolve(root, name)); dir !== root && dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
      try {
        fs.rmdirSync(dir);
      } catch {
        break;
      }
    }
  });
}

/**
 * Classify failures of a staging operation as execution errors (mechanical
 * failures of the build step, reported grouped per target).
 */
function asExecutionError<T>(operation: Computable<T>): Computable<T> {
  return operation.catch(err => {
    throw new ExecutionError(describeSystemError(err));
  });
}

export function getResultFileSet(targetDir: string, pattern: string): Computable<FileSet> {
  /* A "dir:glob" pattern matches under dir, and names the results relative to
   * it (consistent with the source-name convention) */
  const colon = pattern.indexOf(":");
  const rootDir = colon === -1 ? targetDir : path.resolve(targetDir, pattern.substring(0, colon));
  const matcher = globMatcher(colon === -1 ? pattern : pattern.substring(colon + 1));
  const result = new Map<string, IFile>();
  const ops: Computable<void>[] = [];

  /* Walk without following symlinks (walkTree recurses real dirs only): the work
   * dir may contain symlinks — a scoped node_modules links its direct deps into a
   * hidden store — and following them would visit each linked file twice and risk
   * cycles. Keep matching files, prune everything else — a symlink by removing the
   * link itself, never its target. Directories are neither collected nor deleted;
   * the emptied work dir is discarded by the caller. */
  return walkTree(targetDir, (entry, abspath) => {
    if (entry.isDirectory()) {
      return;
    }
    const relpath = path.relative(rootDir, abspath);
    if (entry.isFile() && !relpath.startsWith("..") && matcher(relpath)) {
      ops.push(
        hashFile(abspath).then(hash => {
          /* A work-dir output is path-backed (content at its relpath, not at a
           * blob hash), so it can't be a BuildFile — storeContent then ingests
           * it into the pool by rename. */
          result.set(relpath, new FSFile(rootDir, relpath, fs.statSync(abspath), hash));
        })
      );
    } else {
      ops.push(asExecutionError(deleteFile(abspath)));
    }
  }).then(() => Computable.forAll(ops, () => new FileSet(result)));
}
