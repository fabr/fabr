/*
 * Copyright (c) 2022 Nathan Keynes <nkeynes@deadcoderemoval.net>
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

import { Computable } from "./Computable";
import { hashString } from "./FSWrapper";
import { DEFAULT_FILE_MODE, IFile } from "./FileSet";
import { sniffMime } from "../support/Mime";

export class MemoryFile implements IFile {
  private content: Buffer;
  public hash: string;
  public readonly mime: string;

  /** An in-memory file is a non-executable regular file unless a producer asks
   * otherwise (e.g. a rule stamping a generated script executable). */
  constructor(buffer: Buffer, public mode: number = DEFAULT_FILE_MODE) {
    this.content = buffer;
    this.hash = hashString(buffer);
    this.mime = sniffMime(buffer);
  }

  public static from(content: string, encoding: BufferEncoding = "utf8"): MemoryFile {
    return new MemoryFile(Buffer.from(content, encoding));
  }

  public readString(encoding: BufferEncoding = "utf8"): Computable<string> {
    return Computable.resolve(this.content.toString(encoding));
  }
  public getDisplayName(): string {
    /* An in-memory file has no path; a generic label keeps conflict diagnostics
     * (which fall back to getDisplayName when provenance is absent) from crashing. */
    return "<generated file>";
  }
  public isSameFile(file: IFile): boolean {
    return file instanceof MemoryFile && file.content === this.content;
  }

  public getAbsPath(): undefined {
    return undefined;
  }

  public getBuffer(): Computable<Buffer> {
    return Computable.resolve(this.content);
  }
}
