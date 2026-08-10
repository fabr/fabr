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
import { ConflictError, ExecutionError } from "./Errors";
import { FileSet, IFile } from "./FileSet";
import { FSFile } from "./FSFileSource";
import { copyFile, deleteFile, hardlink, hashFile, mkdir, readOnlyPermissions, rename, symlink, walkTree, writeFile } from "./FSWrapper";
import { Name } from "./Name";
import { SymlinkFile } from "./SymlinkFile";
import { describeSystemError, killLiveChildren } from "../support/Execute";
import { globMatcher } from "../support/Glob";

/** Temp trees in use, so the exit hook can remove whatever is still live when
 * the process ends. */
const liveTempTrees = new Set<string>();
let tempExitHookInstalled = false;

/**
 * Register an already-created temp tree for removal when fabr exits, and return
 * it. Callers release it on their normal path ({@link removeTempTree}); this is
 * the backstop for the paths that never reach that call, and it is load-bearing
 * rather than paranoia: fabr routes its own termination signals through
 * `process.exit` (so the build-step group sweep and the run supervisor's child
 * kill still run), and `process.exit` runs no Computable continuation — a
 * `finally` that removes the tree is skipped entirely, which is how every
 * interrupted `fabr run`/`fabr shell` used to leave a full staged install
 * behind. WHERE the tree lives is the cache's business, not this module's (see
 * {@link BuildCache.createWorkDir}); only its disposal is handled here.
 */
export function registerTempTree(dir: string): string {
  if (!tempExitHookInstalled) {
    tempExitHookInstalled = true;
    process.on("exit", () => {
      /* This hook registers before Execute's kill hooks (the cache's work tree
       * is registered at construction, before anything spawns), so exit-order
       * alone would remove these trees out from under still-running children.
       * Kill them first — a child must never outlive the install it runs in. */
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

/** Release a temp tree: remove it and forget it. Idempotent (a tree already
 * released, or already gone, is fine). */
export function removeTempTree(dir: string): void {
  liveTempTrees.delete(dir);
  rmTempTree(dir);
}

/** Best-effort removal: cleanup never outranks the outcome of whatever was
 * using the tree, and this also runs from the exit hook, where a throw would
 * turn a tidy exit into a crash. */
function rmTempTree(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* The owning process's work tree is reaped on a later run; nothing else to
     * do from here. */
  }
}

/**
 * Materialize a FileSet into `targetDir` (additive — only the given files are
 * written; nothing else in the tree is touched). By default a cache-backed file
 * is **hardlinked** (cheap, shares the blob) — correct for an ephemeral staged
 * tree fabr owns. Pass `copy: true` when the destination is durable user-space
 * (`fabr cp`): the file is copied so an edit of it can never write through to
 * the shared cache blob.
 */
export function writeFileSet(targetDir: string, files: FileSet, options?: { copy?: boolean }): Computable<void> {
  const root = path.resolve(targetDir);
  let realRoot: string | undefined;
  /* Staging is fail-on-clobber: a hardlink/symlink already refuses to overwrite,
   * and an in-memory write uses `wx`, so two staged names that map to one path on
   * the target filesystem — most often names differing only in case on a
   * case-insensitive one — surface as a clear error here instead of one file
   * silently overwriting the other (which, for a cache-bound install, would store
   * one file's bytes under the other's hash). Let the filesystem be the detector:
   * exclusive create is atomic and only collides on a genuinely case-folding fs.
   * A `copy` (`fabr cp`) is user space and mirrors system `cp` — overwrite. */
  const stage = (op: Computable<void>, name: string): Computable<void> =>
    op.catch((err: unknown) => {
      if (!options?.copy && (err as NodeJS.ErrnoException)?.code === "EEXIST") {
        /* Two staged names fold to one path on a case-insensitive filesystem.
         * Find the earlier-written variant (an O(N) scan, only on this error
         * path) to name both sides, and attribute each through the install's
         * lazy merge provenance so the diagnostic traces back to the source
         * (e.g. the offending npm package and its resolution chain). */
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
  /* Resolve every name first, so the directories can be created as ONE
   * concurrent batch of distinct paths ahead of the writes. Creating them
   * per-file instead is both quadratic-ish in calls (a node_modules install is
   * ~6 files per directory, so most calls create nothing) and synchronous —
   * which matters far more than the wasted calls, because this event loop is
   * also the build's scheduler: while a tree stages, no other target can be
   * evaluated and no other action can start. Measured on a two-target dylan
   * build: 30,716 `mkdirSync` calls over 5,085 distinct directories, ~0.9s of
   * blocked loop. The writes below need every parent to exist (the symlink arm
   * additionally reads the real path of one), hence a barrier and not a
   * per-file dependency. */
  const staged = [...files].map(([name, file]) => contained(root, name, file));
  return Computable.forAll(
    [...new Set(staged.map(entry => entry.dirname))].map(dir => mkdir(dir)),
    () => undefined
  ).then(() => writeStaged(staged));

  /* Deferred until the directories exist: an operation below STARTS when it is
   * constructed, so building them in the loop above would race the mkdirs. */
  function writeStaged(entries: typeof staged): Computable<void> {
    const operations: Computable<void>[] = [];
    for (const { name, file, targetName, dirname } of entries) {
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
          operations.push(stage(symlink(file.target, targetName), name));
        }
      } else if (filepath) {
        /* A hardlink shares the read-only cache blob's mode (0o444/0o555). A copy
         * (`fabr cp`) is durable user space, so reapply the file's real mode —
         * restoring writability and the exact original bits the blob dropped. */
        operations.push(
          stage(
            options?.copy
              ? copyFile(filepath, targetName).then(() => fs.chmodSync(targetName, file.mode & 0o7777))
              : hardlink(filepath, targetName),
            name
          )
        );
      } else {
        /* An in-memory file mirrors what a blob-backed file gets in the same
         * context: a copy (`fabr cp`) exports at its real mode (writable, durable
         * user space), while a staged file matches the read-only 0o444/0o555 of the
         * hardlinked blobs beside it (exec-if-executable, so a generated tool runs). */
        const mode = options?.copy ? file.mode & 0o7777 : readOnlyPermissions(file.mode);
        operations.push(
          stage(
            file
              .getBuffer()
              .then(buffer => writeFile(targetName, buffer, { exclusive: !options?.copy }))
              .then(() => fs.chmodSync(targetName, mode)),
            name
          )
        );
      }
    }
    return Computable.forAll(operations, () => {});
  }
}

/** A staged entry with its resolved destination and that destination's parent,
 * containment asserted. Resolving up front is what lets the distinct parents be
 * created as one batch before any write starts. */
function contained(root: string, name: string, file: IFile): { name: string; file: IFile; targetName: string; dirname: string } {
  const targetName = path.resolve(root, name);
  assertContained(root, targetName, name);
  return { name, file, targetName, dirname: path.dirname(targetName) };
}

/** Belt-and-braces backstop for the FileSet canonical-name invariant: names are
 * canonicalized at construction (no `../`, no absolute paths — see
 * canonicalFileName), so a resolved write target always stays inside the staged
 * root. But staging is the boundary where a violated invariant becomes
 * filesystem damage, so containment is asserted here regardless of producer. */
function assertContained(root: string, targetName: string, name: string): void {
  if (targetName !== root && !targetName.startsWith(root + path.sep)) {
    throw new Error(`Internal error: file name '${name}' resolves outside the staging directory '${root}'`);
  }
}

/** Monotonic across the whole process, so no two temp siblings ever share a name
 * — a per-call counter (reset to 0 each sync) would reuse `<pid>-0`, `<pid>-1`, …
 * every call, and a temp left behind by one failed sync would then collide (EEXIST)
 * with every later sync in the same process. */
let tempCounter = 0;

/**
 * Update an already-staged tree in place to match `after`: write files that are
 * new or changed (judged by content hash against `before`), remove files that
 * are gone, leave the rest untouched — the incremental complement of
 * {@link writeFileSet}, for a tree with a live consumer (a served install, any
 * continuously-materialized output). Each write goes to a temp sibling and is
 * renamed into place, so a concurrent reader (the running program, an fs
 * watcher) never observes a half-written file — and an existing hardlink into
 * the cache is never written through (the link is replaced; the blob stays
 * untouched). Writes and file removals run concurrently, but **directory
 * pruning is deferred to a final phase, once the whole tree has settled**: a
 * removal that empties a directory must not rmdir it while a sibling write is
 * still renaming a new file into that same directory (which left renames failing
 * ENOENT — content-hashed shards replace a directory's entire contents wholesale,
 * so removes and writes routinely target the same dir). Resolves to the applied
 * delta counts, for progress reporting.
 */
export function syncFileSet(targetDir: string, before: FileSet, after: FileSet): Computable<{ written: number; removed: number }> {
  const root = path.resolve(targetDir);
  let realRoot: string | undefined;
  /* Resolve and containment-check every name up front — before anything touches
   * the filesystem, which is the point of a backstop guard — and take the
   * distinct parents from the same pass. */
  const changed = [...after]
    .filter(([name, file]) => before.getFile(name)?.hash !== file.hash)
    .map(([name, file]) => contained(root, name, file));
  const gone = [...before].filter(([name]) => after.getFile(name) === undefined).map(([name, file]) => contained(root, name, file));
  /* The parents of everything about to be written, created as one concurrent
   * batch ahead of the writes — same reasoning as writeFileSet, on a smaller
   * scale (only the changed files are written here). */
  return Computable.forAll(
    [...new Set(changed.map(entry => entry.dirname))].map(dir => mkdir(dir)),
    () => undefined
  ).then(() => applySync());

  /* Deferred until the directories exist, since a write starts as it is
   * constructed and the symlink arm reads its parent's real path. */
  function applySync(): Computable<{ written: number; removed: number }> {
    const writes = [];
    for (const { file, targetName, dirname } of changed) {
      const temp = `${targetName}.fabr-sync-${process.pid}-${tempCounter++}`;
      const filepath = file.getAbsPath();
      if (file instanceof SymlinkFile) {
        /* Same containment guard as writeFileSet: a target escaping the staged
         * tree is silently not staged. */
        realRoot ??= fs.realpathSync(root);
        const resolved = path.resolve(fs.realpathSync(dirname), file.target);
        if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep)) {
          continue;
        }
        writes.push(stageWrite(temp, targetName, symlink(file.target, temp)));
      } else if (filepath) {
        writes.push(stageWrite(temp, targetName, hardlink(filepath, temp)));
      } else {
        /* A served install is nominally hardlink output, so an in-memory file
         * matches the read-only 0o444/0o555 of the blobs beside it; chmod the temp
         * before the atomic rename so it never appears at the wrong mode. */
        writes.push(
          stageWrite(
            temp,
            targetName,
            file
              .getBuffer()
              .then(buffer => writeFile(temp, buffer))
              .then(() => fs.chmodSync(temp, readOnlyPermissions(file.mode)))
          )
        );
      }
    }
    /* Unlink the gone files (concurrent with the writes — disjoint names), and note
     * their parent directories as prune candidates for after everything settles. */
    const removals = [];
    const prunable = new Set<string>();
    for (const { targetName, dirname } of gone) {
      removals.push(asExecutionError(deleteFile(targetName)));
      prunable.add(dirname);
    }
    const written = writes.length;
    const removed = removals.length;
    return Computable.forAll([...writes, ...removals], () => {})
      .then(() => pruneEmptyDirs(root, prunable))
      .then(() => ({ written, removed }));
  }
}

/** Finish one staged write: `create` has produced the temp sibling; rename it
 * atomically over the target. On any failure, remove the temp best-effort so a
 * partial sync leaves no debris behind (a stale temp would otherwise linger, and
 * — before the counter went process-monotonic — poison later syncs).
 *
 * Exported for the write-back path, which replaces a user's file under exactly
 * the same rule: the destination may be a hardlink into the blob pool, so it is
 * replaced rather than written through. */
export function stageWrite(temp: string, targetName: string, create: Computable<void>): Computable<void> {
  return asExecutionError(
    create.then(() => rename(temp, targetName)).catch(err => {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        /* best-effort — never outrank the original failure */
      }
      throw err;
    })
  );
}

/** Prune directories emptied by removals, walking up from each candidate towards
 * (but never reaching) the staged root — a non-empty parent just stops the walk.
 * Best-effort and run only after every write/removal has settled, so an rmdir can
 * never race a concurrent create into the same directory. */
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

/**
 * Classify failures of a staging operation as execution errors (mechanical
 * failures of the build step, reported grouped per target).
 */
function asExecutionError<T>(operation: Computable<T>): Computable<T> {
  return operation.catch(err => {
    throw new ExecutionError(describeSystemError(err));
  });
}

/**
 * Collect the files a build step wrote under `targetDir` that the `output`
 * projection selects, naming each by its projected name; delete everything the
 * projection drops. `output` is either a plain `dir:glob` string (select under
 * `dir`, name relative to it) or a {@link Name} projection — a selector with the
 * usual `:`-strip / slash-retain rule, optionally carrying a `sel -> tmpl`
 * rename. The two are the same primitive: a `dir:glob` string is exactly the
 * degenerate no-rename projection, so both compile to one `path -> name?`
 * function ({@link outputProjector}). A rename can collapse two written files
 * onto one output name — a {@link ConflictError}, mirroring FileSet.rename.
 *
 * Several selectors may be given, for a step whose output is genuinely two
 * unrelated things (the test run's report *and* the snapshot files it
 * refreshed): a file is kept if ANY selects it, named by the first that does.
 * They are alternatives of one projection, not successive passes — everything
 * unselected is still deleted exactly once.
 */
export function getResultFileSet(targetDir: string, output: Name | string | ReadonlyArray<Name | string>): Computable<FileSet> {
  const project = outputProjector(output);
  const result = new Map<string, IFile>();
  /* Source path each output name came from, for a rename-collision message. */
  const source = new Map<string, string>();
  const ops: Computable<void>[] = [];

  /* Walk without following symlinks (walkTree recurses real dirs only): the work
   * dir may contain symlinks — a scoped node_modules links its direct deps into a
   * hidden store — and following them would visit each linked file twice and risk
   * cycles. Keep selected files, prune everything else — a symlink by removing the
   * link itself, never its target. Directories are neither collected nor deleted;
   * the emptied work dir is discarded by the caller. */
  return walkTree(targetDir, (entry, abspath) => {
    if (entry.isDirectory()) {
      return;
    }
    const rel = path.relative(targetDir, abspath);
    const name = entry.isFile() ? project(rel) : undefined;
    if (name !== undefined) {
      ops.push(
        hashFile(abspath).then(({ hash, mime }) => {
          /* A work-dir output is path-backed (content at its on-disk rel, not at
           * a blob hash), so it can't be a BuildFile — storeContent then ingests
           * it into the pool by rename. The FileSet key is the *projected* name;
           * the file itself stays anchored at its real location. */
          const file = new FSFile(targetDir, rel, fs.statSync(abspath), hash, mime);
          const existing = result.get(name);
          if (existing && !existing.isSameFile(file)) {
            throw new ConflictError(
              "collected files",
              name,
              { provenance: undefined, detail: source.get(name) ?? existing.getDisplayName() },
              { provenance: undefined, detail: rel }
            );
          }
          result.set(name, file);
          source.set(name, rel);
        })
      );
    } else {
      ops.push(asExecutionError(deleteFile(abspath)));
    }
  }).then(() => Computable.forAll(ops, () => new FileSet(result)));
}

/**
 * Compile an `output` selector to a `workDir-relative path -> result name`
 * function (undefined ⇒ not selected). A {@link Name} owns what its projection
 * means (glob-select, `:`-strip, `-> tmpl` rename), so it is just its
 * {@link Name.makeProjector}. A `dir:glob` string is the degenerate case:
 * strip the `dir/` prefix and name results relative to it — equivalent to the
 * colon projection, without needing the model parser to build a Name here.
 */
function outputProjector(output: Name | string | ReadonlyArray<Name | string>): (rel: string) => string | undefined {
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
  const prefix = colon === -1 ? "" : output.substring(0, colon) + path.sep;
  const matcher = globMatcher(colon === -1 ? output : output.substring(colon + 1));
  return rel => {
    if (prefix !== "" && !rel.startsWith(prefix)) {
      return undefined;
    }
    const inner = rel.substring(prefix.length);
    return matcher(inner) ? inner : undefined;
  };
}
