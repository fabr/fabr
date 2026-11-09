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
 *
 * Derived from tar-stream 3.1.7 (MIT, Copyright (c) 2014 Mathias Buus); the
 * license's permission notice is in TarHeader.ts.
 */

import { constants } from "fs";
import { Readable, Writable } from "stream";
import { encodeEntryHeader, paddingOf, TarEntryHeader, TarEntryType, TarHeader } from "./TarHeader";

/** The two zero blocks that end an archive. */
const END_OF_TAR = Buffer.alloc(1024);

/** A callback told when an entry has been written into the archive, or why it was not. */
export type TarEntryCallback = (err?: Error | null) => void;

/**
 * A tar archive, written as it is read: each {@link entry} in the order made,
 * then the end-of-archive marker once {@link finalize} is called. A header is
 * written as one ustar block where it fits, else with a pax header before it
 * carrying what does not, and its `pax` records and `xattrs`.
 */
export class TarPack extends Readable {
  /** The entries made and not yet written, the one being written first. */
  private readonly queue: TarEntrySink[] = [];
  private finalizing = false;
  private finalized = false;
  /** The callback of a content write waiting for the archive to be read. */
  private drain: (() => void) | undefined;

  /**
   * Add an entry to the archive. Its content is `content` where given, else
   * what is written to the returned stream, which must be exactly `size` bytes
   * and is held until the entries before it are written. An entry other than a
   * file has no content. Omitted fields default: `type` from `mode`'s file-type
   * bits (a file where it has none), `mode` 0o755 for a directory and 0o644
   * otherwise, ids 0, `mtime` now (in whole seconds), and the text fields empty.
   * @param callback told when the entry has been written, or why it was not.
   */
  entry(header: TarEntryHeader, content?: Buffer | string | TarEntryCallback, callback?: TarEntryCallback): Writable {
    if (this.finalized || this.destroyed) {
      throw new Error("already finalized or destroyed");
    }
    if (typeof content === "function") {
      callback = content;
      content = undefined;
    }
    const body = typeof content === "string" ? Buffer.from(content) : content;
    const type = header.type ?? typeOfMode(header.mode ?? 0);
    const hasContent = type === "file" || type === "contiguous-file";
    const full: TarHeader = {
      name: header.name,
      type,
      mode: header.mode ?? (type === "directory" ? 0o755 : 0o644),
      uid: header.uid ?? 0,
      gid: header.gid ?? 0,
      size: hasContent ? body?.length ?? header.size ?? 0 : 0,
      mtime: header.mtime ?? new Date(Math.floor(Date.now() / 1000) * 1000),
      linkname: header.linkname ?? "",
      uname: header.uname ?? "",
      gname: header.gname ?? "",
      devmajor: header.devmajor ?? 0,
      devminor: header.devminor ?? 0,
      pax: header.pax ?? new Map(),
      xattrs: header.xattrs ?? new Map(),
    };
    const sink: TarEntrySink = new TarEntrySink(full, hasContent, callback ?? (() => undefined), {
      write: bytes => this.push(bytes),
      writeContent: (bytes, onDrain) => this.writeContent(bytes, onDrain),
      done: () => this.entryDone(sink),
      fail: err => this.destroy(err),
      isDestroyed: () => this.destroyed,
    });
    this.queue.push(sink);
    if (this.queue.length === 1) {
      sink.activate();
    }
    if (body !== undefined) {
      sink.end(body);
    }
    return sink;
  }

  /** End the archive once every entry made has been written. */
  finalize(): void {
    if (this.queue.length > 0) {
      this.finalizing = true;
      return;
    }
    if (this.finalized) {
      return;
    }
    this.finalized = true;
    this.push(END_OF_TAR);
    this.push(null);
  }

  /** Write `bytes` of the entry being written, and call `onDrain` once the archive's reader wants more. */
  private writeContent(bytes: Buffer, onDrain: () => void): void {
    if (this.push(bytes)) {
      onDrain();
    } else {
      this.drain = onDrain;
    }
  }

  /** Go on to the entry after `sink`, which has been written or abandoned. */
  private entryDone(sink: TarEntrySink): void {
    const at = this.queue.indexOf(sink);
    if (at === -1) {
      return;
    }
    this.queue.splice(at, 1);
    if (at === 0 && this.queue.length > 0) {
      this.queue[0].activate();
    } else if (this.queue.length === 0 && this.finalizing) {
      this.finalize();
    }
  }

  override _read(): void {
    const drain = this.drain;
    this.drain = undefined;
    drain?.();
  }

  override _destroy(err: Error | null, callback: (err?: Error | null) => void): void {
    for (const sink of [...this.queue]) {
      sink.destroy(err ?? new Error("tar pack destroyed"));
    }
    this._read();
    callback(err);
  }
}

/** What an entry's stream does to its archive. */
interface ITarArchive {
  /** Write header or padding bytes. */
  write(bytes: Buffer): void;
  /** Write content bytes, and call `onDrain` once the archive's reader wants more. */
  writeContent(bytes: Buffer, onDrain: () => void): void;
  /** Go on to the next entry: this one has been written or abandoned. */
  done(): void;
  /** Fail the archive. */
  fail(err: Error): void;
  isDestroyed(): boolean;
}

/** The stream an entry's content is written to; it writes into its archive once the entries before it are written. */
class TarEntrySink extends Writable {
  private written = 0;
  private finished = false;
  private active = false;
  private reported = false;
  /** The callback of `_construct`, held until it is this entry's turn to be written. */
  private opening: ((err?: Error | null) => void) | undefined;

  constructor(
    private readonly header: TarHeader,
    private readonly hasContent: boolean,
    private readonly callback: TarEntryCallback,
    private readonly archive: ITarArchive
  ) {
    super();
  }

  /** Begin writing the entry into the archive: its turn has come. */
  activate(): void {
    this.active = true;
    if (this.opening) {
      this.open();
    }
  }

  override _construct(callback: (err?: Error | null) => void): void {
    this.opening = callback;
    if (this.active) {
      this.open();
    }
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (err?: Error | null) => void): void {
    if (!this.hasContent) {
      callback(chunk.length > 0 ? new Error("No body allowed for this entry") : null);
      return;
    }
    this.written += chunk.length;
    if (this.written > this.header.size) {
      callback(new Error("Size mismatch"));
      return;
    }
    this.archive.writeContent(chunk, () => callback());
  }

  override _final(callback: (err?: Error | null) => void): void {
    if (this.written !== this.header.size) {
      callback(new Error("Size mismatch"));
      return;
    }
    this.finish();
    callback();
  }

  override _destroy(err: Error | null, callback: (err?: Error | null) => void): void {
    if (!this.finished) {
      const failure = err ?? new Error("tar entry destroyed");
      this.archive.done();
      this.report(failure);
      this.archive.fail(failure);
    }
    callback(err);
  }

  private open(): void {
    const opening = this.opening!;
    this.opening = undefined;
    if (this.archive.isDestroyed()) {
      opening(new Error("pack stream destroyed"));
      return;
    }
    this.archive.write(encodeEntryHeader(this.header));
    if (!this.hasContent) {
      this.finish();
    }
    opening();
  }

  private finish(): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    const padding = paddingOf(this.header.size);
    if (padding > 0) {
      this.archive.write(END_OF_TAR.subarray(0, padding));
    }
    this.archive.done();
    this.report(null);
  }

  private report(err: Error | null): void {
    if (!this.reported) {
      this.reported = true;
      this.callback(err);
    }
  }
}

/** @return the entry type `mode`'s file-type bits name: a file where they name none of the others. */
function typeOfMode(mode: number): TarEntryType {
  switch (mode & constants.S_IFMT) {
    case constants.S_IFBLK:
      return "block-device";
    case constants.S_IFCHR:
      return "character-device";
    case constants.S_IFDIR:
      return "directory";
    case constants.S_IFIFO:
      return "fifo";
    case constants.S_IFLNK:
      return "symlink";
    default:
      return "file";
  }
}
