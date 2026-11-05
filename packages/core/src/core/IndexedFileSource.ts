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
import { BuildCache } from "./BuildCache";
import { Computable } from "./Computable";
import { FSFile, FSFileSource, TreeQuery } from "./FSFileSource";
import { hashFileStreamed, hashString, isDirectoryError, isNotFound, readFileBuffer, stat } from "./FSWrapper";
import { ISourceIndexRow } from "./Manifest";
import { WatchController } from "./WatchController";
import { sniffMime } from "../support/Mime";

/** Minimum gap between index writes under watch — an edit-heavy session
 * rewrites the record at most this often; the tail is best-effort (a dropped
 * row just re-hashes next start). One-shot runs write once, ungated. */
const INDEX_WRITE_INTERVAL_MS = 30_000;

/** How an {@link IndexedFileSource} reads a file and what it watches. */
export interface IndexedReading {
  /**
   * `snapshot`: the one read that hashes a file also copies its bytes into the
   * blob pool, and the file is read from that copy from then on, so its hash
   * and what is staged can never diverge; a row is trusted only while the pool
   * holds its blob. `in-place`: a file is hashed where it lies, as it streams,
   * and nothing is copied.
   */
  readonly read: "snapshot" | "in-place";
  /** `root`: one subscription for the whole tree. `queried`: one per directory a
   *  query covers, for a root that holds far more than is read (the host's `/`). */
  readonly watch: "root" | "queried";
}

/**
 * A FileSource over a directory on disk whose files' hashes are kept in an
 * index: a stat cache whose rows pair a file's hash with the stat it was
 * captured under, persisted through the cache's projects registry. A file whose
 * stat matches its row exactly, once two captures agreed, is served from the
 * row with no read and no hash. Advisory end to end: identical builds with the
 * index present, absent, or damaged.
 */
export class IndexedFileSource extends FSFileSource {
  constructor(
    root: string,
    protected readonly cache: BuildCache,
    private readonly reading: IndexedReading,
    watchController?: WatchController
  ) {
    super(root, watchController);
  }

  /**
   * Ingest the file `filename` (relative to the root) as an FSFile. A file whose
   * stat matches its verified row (and, read as a snapshot, whose blob the pool
   * still holds) is served from the row; anything else is read, hashed and, read
   * as a snapshot, copied into the pool, and its row refreshed.
   */
  public override ingest(filename: string): Computable<FSFile | undefined> {
    const filepath = path.resolve(this.root, filename);
    return this.loadIndex()
      .then(rows =>
        stat(filepath).then(fileStat => {
          if (!fileStat.isFile()) {
            return undefined;
          }
          const fsStat = { size: fileStat.size, mtime: fileStat.mtime, mode: fileStat.mode };
          const held = rows.get(filename);
          /* Only a VERIFIED row is served on a stat match: an unverified one
           * re-hashes here, which is the second capture that verifies it (see
           * recordIndexRow) — or catches a write that landed in the same
           * filesystem-timestamp tick as the recorded one. */
          if (held !== undefined && held.verified && held.size === fileStat.size && held.mtimeMs === fileStat.mtimeMs) {
            const blobPath = this.reading.read === "snapshot" ? this.cache.presentBlob(held.hash) : filepath;
            if (blobPath !== undefined) {
              /* Confirmation is unconditional in ingest — which branch served
               * the hash must not decide whether an echo is judged. */
              this.confirmIngested(filename, held.hash);
              return Computable.resolve(new FSFile(this.root, filename, fsStat, held.hash, held.mime, this.reading.read === "snapshot" ? blobPath : undefined));
            }
          }
          if (this.reading.read === "in-place") {
            return hashFileStreamed(filepath).then(({ hash, mime }) => {
              this.confirmIngested(filename, hash);
              this.recordIndexRow(rows, filename, fileStat.size, fileStat.mtimeMs, hash, mime);
              return new FSFile(this.root, filename, fsStat, hash, mime);
            });
          }
          return readFileBuffer(filepath).then(bytes => {
            const hash = hashString(bytes);
            this.confirmIngested(filename, hash);
            const mime = sniffMime(bytes);
            this.recordIndexRow(rows, filename, fileStat.size, fileStat.mtimeMs, hash, mime);
            return this.cache
              .ensureBlob(hash, bytes, fileStat.mode)
              .then(blobPath => new FSFile(this.root, filename, fsStat, hash, mime, blobPath));
          });
        })
      )
      .catch(err => {
        /* Gone since the event fired, or the path is a directory (a watch event
         * on a directory the tree gained — e.g. a served tool's own cache/output
         * dirs): either way it is not a file, so treat it as absent, not an error.
         * Mirrors the base FSFileSource.ingest. */
        if (isNotFound(err) || isDirectoryError(err)) {
          this.dropIndexRow(filename);
          return undefined;
        }
        throw err;
      });
  }

  protected override watchedDirectoryOf(query: TreeQuery): string {
    return this.reading.watch === "queried" ? query.directory : "";
  }

  /** Note that `filename` was read and holds `hash`, whichever way its hash was
   *  had; a subclass that records what it expects a file to hold judges it here. */
  protected confirmIngested(filename: string, hash: string): void {
    void filename;
    void hash;
  }

  /** This root's rows, shared by every ingest: loaded once, mutated in
   * place, persisted change-gated (see {@link persistIndex}). */
  private indexRows?: Map<string, ISourceIndexRow>;
  private indexLoad?: Computable<Map<string, ISourceIndexRow>>;
  private indexDirty = false;
  private indexWrite?: Computable<void>;
  private lastIndexWrite = 0;

  /**
   * Load this root's rows, once. Once they are loaded they are handed out as a settled
   * constant and the load is dropped: an ingest, made per file per enumeration, must hold
   * no edge to a node that lives as long as this source, or every ingest stays reachable
   * as its dependant.
   */
  private loadIndex(): Computable<Map<string, ISourceIndexRow>> {
    if (this.indexRows !== undefined) {
      return Computable.resolve(this.indexRows);
    }
    this.indexLoad ??= this.cache.readSourceIndex(this.root).then(rows => {
      this.indexRows = rows ?? new Map();
      this.indexLoad = undefined;
      return this.indexRows;
    });
    return this.indexLoad;
  }

  /**
   * Refresh a row from a full-path capture. A fresh or disagreeing capture
   * records **unverified**: a write landing in the same filesystem-timestamp
   * tick as this one is invisible to the stat, so a single capture may not be
   * trusted. A capture that AGREES with the held row is the second observation
   * that **verifies** it — from then on a stat match serves the row without
   * reading (see ingest). No clock takes part: the poison tick is over by the
   * time any later capture compares against the row.
   */
  private recordIndexRow(
    rows: Map<string, ISourceIndexRow>,
    filename: string,
    size: number,
    mtimeMs: number,
    hash: string,
    mime: string
  ): void {
    const held = rows.get(filename);
    if (held !== undefined && held.hash === hash && held.size === size && held.mtimeMs === mtimeMs && held.mime === mime) {
      if (!held.verified) {
        rows.set(filename, { ...held, verified: true });
        this.indexDirty = true;
      }
      return;
    }
    rows.set(filename, { name: filename, hash, size, mtimeMs, mime, verified: false });
    this.indexDirty = true;
  }

  /** Drop a row whose file is gone. Consulted rows only — unconsulted rows are
   * carried forward (a partial build must not shed the rest of the tree). */
  private dropIndexRow(filename: string): void {
    if (this.indexRows?.delete(filename)) {
      this.indexDirty = true;
    }
  }

  /**
   * Persist the index if it changed — a run where every consulted file trusted
   * its row writes nothing. Under watch, gated to at most one write per
   * {@link INDEX_WRITE_INTERVAL_MS} unless `flush` (the close-time drain); a
   * skipped write stays dirty for the next opportunity. Writes serialize
   * behind any still-running one, and a failed write re-marks dirty. Never
   * rejects: the record is an accelerator, not an outcome.
   */
  public persistIndex(flush = false): Computable<void> {
    if (!this.indexDirty || this.indexRows === undefined) {
      return this.indexWrite ?? Computable.resolve(undefined);
    }
    if (!flush && this.watchController !== undefined && Date.now() - this.lastIndexWrite < INDEX_WRITE_INTERVAL_MS) {
      return Computable.resolve(undefined);
    }
    this.indexDirty = false;
    this.lastIndexWrite = Date.now();
    const rows = this.indexRows;
    const previous = this.indexWrite !== undefined && !this.indexWrite.isSettled() ? this.indexWrite : undefined;
    const write = (previous ?? Computable.resolve(undefined))
      .then(() => this.cache.writeSourceIndex(this.root, rows))
      .then(wrote => {
        if (!wrote) {
          this.indexDirty = true;
        }
      });
    this.indexWrite = write;
    return write;
  }
}
