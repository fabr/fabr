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
 * Derived from tar-stream 3.1.7 (https://github.com/mafintosh/tar-stream),
 * distributed under the MIT license:
 *
 *   The MIT License (MIT)
 *
 *   Copyright (c) 2014 Mathias Buus
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in
 *   all copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 *   THE SOFTWARE.
 */

import { Readable, Writable } from "stream";
import {
  decodeBlock,
  decodeLongPath,
  decodePaxRecords,
  GNU_LONG_LINK_PATH,
  headerOf,
  isDescribingBlock,
  isLongPathBlock,
  ITarBlock,
  PAX_GLOBAL_HEADER,
  PAX_HEADER,
  paddingOf,
  TAR_BLOCK_SIZE,
  TarHeader,
} from "./TarHeader";

/**
 * A listener for {@link TarExtract}'s `entry` event: an entry's header, a
 * stream of its content, and the callback to call once that stream has been
 * read to its end (or destroyed), to go on to the next entry.
 */
export type TarEntryListener = (header: TarHeader, content: Readable, next: (err?: Error | null) => void) => void;

type Listener = Parameters<Writable["on"]>[1];

/** What the extractor is reading. */
type Phase =
  /** The next header block. */
  | "header"
  /** A pax or GNU long name header's content. */
  | "describing"
  /** An entry's content, into its stream. */
  | "content"
  /** Bytes to pass over: padding, or content nobody reads. */
  | "skip";

/**
 * Read a tar archive written into it, emitting `entry` per entry (see
 * {@link TarEntryListener}) and `finish` once the archive has ended. Reads
 * ustar and GNU headers, pax records (`x`, and `g`, whose records apply to
 * every later entry) and GNU long names and links (`L`, `K`). An entry's
 * content must be read to its end, or its stream destroyed, and `next` called,
 * before the next is read; until then nothing more is taken from what is
 * written.
 */
export class TarExtract extends Writable {
  /** The bytes written and not yet read, from `offset` into the first. */
  private readonly chunks: Buffer[] = [];
  private offset = 0;
  private buffered = 0;
  private phase: Phase = "header";
  /** The bytes left to read in this phase. */
  private missing = 0;
  /** The padding after the content being read. */
  private padding = 0;
  /** The describing block whose content is being read. */
  private describing: ITarBlock | undefined;
  /** The stream the content being read goes to. */
  private content: TarEntryContent | undefined;
  /** Whether an entry has been emitted whose `next` has not yet been called. */
  private locked = false;
  /** The callback of the write whose bytes are being read. */
  private pendingWrite: ((err?: Error | null) => void) | undefined;
  private updating = false;
  private rerun = false;
  private globalRecords = new Map<string, Buffer>();
  private records: Map<string, Buffer> | undefined;
  private longPath: string | undefined;
  private longLinkPath: string | undefined;

  override on(event: "entry", listener: TarEntryListener): this;
  override on(event: string | symbol, listener: Listener): this;
  override on(event: string | symbol, listener: Listener): this {
    return super.on(event, listener);
  }

  override once(event: "entry", listener: TarEntryListener): this;
  override once(event: string | symbol, listener: Listener): this;
  override once(event: string | symbol, listener: Listener): this {
    return super.once(event, listener);
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (err?: Error | null) => void): void {
    this.pendingWrite = callback;
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    this.update();
  }

  override _final(callback: (err?: Error | null) => void): void {
    callback(this.phase === "header" && this.buffered === 0 ? null : new Error("Unexpected end of data"));
  }

  override _destroy(err: Error | null, callback: (err?: Error | null) => void): void {
    const content = this.content;
    this.content = undefined;
    content?.destroy(err ?? new Error("Premature close"));
    callback(err);
  }

  /** Go on from the stream of the content being read: called when it wants more. */
  private resumeContent(content: TarEntryContent): void {
    if (content === this.content) {
      this.update();
    }
  }

  /** Stop reading into `content`, its stream destroyed: with an error, the extraction fails; without, the rest of its content is passed over. */
  private detachContent(content: TarEntryContent, err: Error | null): void {
    if (content !== this.content) {
      return;
    }
    this.content = undefined;
    if (err) {
      this.destroy(err);
      return;
    }
    this.phase = "skip";
    this.missing += this.padding;
    this.update();
  }

  /** Read on from what has been written, as far as the archive and its readers allow. */
  private update(): void {
    if (this.updating) {
      this.rerun = true;
      return;
    }
    this.updating = true;
    try {
      do {
        this.rerun = false;
        this.step();
      } while (this.rerun && !this.destroyed);
    } finally {
      this.updating = false;
    }
  }

  private step(): void {
    while (!this.destroyed) {
      if (this.phase === "content") {
        const content = this.content!;
        if (this.missing === 0) {
          this.content = undefined;
          content.push(null);
          this.enterSkip(this.padding);
          continue;
        }
        if (this.buffered === 0) {
          break;
        }
        const chunk = this.take(Math.min(this.missing, this.buffered), false);
        this.missing -= chunk.length;
        if (!content.push(chunk)) {
          return;
        }
      } else if (this.phase === "skip") {
        if (this.missing === 0) {
          this.phase = "header";
          continue;
        }
        if (this.buffered === 0) {
          break;
        }
        this.missing -= this.take(Math.min(this.missing, this.buffered), false).length;
      } else if (this.phase === "describing") {
        if (this.buffered < this.missing) {
          break;
        }
        const block = this.describing!;
        this.describing = undefined;
        this.describe(block, this.take(this.missing, true));
        this.enterSkip(paddingOf(block.size));
      } else {
        if (this.locked) {
          return;
        }
        if (this.buffered < TAR_BLOCK_SIZE) {
          break;
        }
        let block: ITarBlock | null;
        try {
          block = decodeBlock(this.take(TAR_BLOCK_SIZE, true));
        } catch (err) {
          this.fail(err as Error);
          return;
        }
        if (block !== null) {
          this.begin(block);
        }
      }
    }
    this.continueWrite(null);
  }

  /** Begin reading what follows `block`: a describing header's content, or an entry. */
  private begin(block: ITarBlock): void {
    if (isDescribingBlock(block.typeflag)) {
      this.describing = block;
      this.phase = "describing";
      this.missing = block.size;
      return;
    }
    const records = new Map(this.globalRecords);
    for (const [key, value] of this.records ?? []) {
      records.set(key, value);
    }
    const header = headerOf(block, records, this.longPath, this.longLinkPath);
    this.records = this.longPath = this.longLinkPath = undefined;
    const content: TarEntryContent = new TarEntryContent(
      () => this.resumeContent(content),
      err => this.detachContent(content, err)
    );
    this.locked = true;
    if (header.type === "directory" || header.size === 0) {
      /* A directory has no body whatever its size field says. */
      content.push(null);
      this.enterSkip(0);
    } else {
      this.content = content;
      this.phase = "content";
      this.missing = header.size;
      this.padding = paddingOf(header.size);
    }
    this.emit("entry", header, content, (err?: Error | null) => this.next(err));
  }

  /** Take a describing block's content into the state the next entry is read with. */
  private describe(block: ITarBlock, content: Buffer): void {
    if (block.typeflag === PAX_HEADER) {
      this.records = decodePaxRecords(content);
    } else if (block.typeflag === PAX_GLOBAL_HEADER) {
      for (const [key, value] of decodePaxRecords(content)) {
        this.globalRecords.set(key, value);
      }
    } else if (block.typeflag === GNU_LONG_LINK_PATH) {
      this.longLinkPath = decodeLongPath(content);
    } else if (isLongPathBlock(block.typeflag)) {
      this.longPath = decodeLongPath(content);
    }
  }

  private next(err?: Error | null): void {
    if (err) {
      this.destroy(err);
      return;
    }
    this.locked = false;
    this.update();
  }

  private enterSkip(size: number): void {
    this.phase = "skip";
    this.missing = size;
  }

  /**
   * Take `size` buffered bytes (at most what is buffered), or as many of them
   * as the first buffered chunk holds unless `whole`.
   */
  private take(size: number, whole: boolean): Buffer {
    const parts: Buffer[] = [];
    let wanted = size;
    while (wanted > 0) {
      const first = this.chunks[0];
      const available = first.length - this.offset;
      const part = first.subarray(this.offset, this.offset + Math.min(available, wanted));
      parts.push(part);
      wanted -= part.length;
      this.buffered -= part.length;
      if (part.length === available) {
        this.chunks.shift();
        this.offset = 0;
      } else {
        this.offset += part.length;
      }
      if (!whole) {
        break;
      }
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  }

  private fail(err: Error): void {
    if (this.pendingWrite) {
      this.continueWrite(err);
    } else {
      this.destroy(err);
    }
  }

  private continueWrite(err: Error | null): void {
    const callback = this.pendingWrite;
    this.pendingWrite = undefined;
    callback?.(err);
  }
}

/** The stream of one entry's content: `onRead` is called when it wants more, `onDestroy` when it is destroyed. */
class TarEntryContent extends Readable {
  constructor(private readonly onRead: () => void, private readonly onDestroy: (err: Error | null) => void) {
    super();
  }

  override _read(): void {
    this.onRead();
  }

  override _destroy(err: Error | null, callback: (err?: Error | null) => void): void {
    this.onDestroy(err);
    callback(err);
  }
}
