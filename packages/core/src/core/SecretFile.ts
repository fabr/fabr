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

import { Computable } from "./Computable";
import { FabrError } from "./Errors";
import { hashString } from "./FSWrapper";
import { FileSet, IFile } from "./FileSet";
import { sniffMime } from "../support/Mime";

/** The mode a secret is given where it is written to user space (`fabr cp`): readable and writable by its owner alone. */
const SECRET_FILE_MODE = 0o600;

/**
 * A file whose content is secret because the place it was read from says so
 * (an SSM `SecureString`). It is held in memory, staged readable by its owner
 * alone, and never stored in the build cache or published. Its `hash` is a
 * digest of its source's `identity` — what it is and which version — never of
 * its content, so a cache key holding it says nothing about the value and stays
 * the same while the source's version does.
 */
export class SecretFile implements IFile {
  public readonly hash: string;
  public readonly mime: string;
  public readonly mode = SECRET_FILE_MODE;

  constructor(
    /** The reference it was read through, which names it in messages (`@aws:ssm:/app/key`). */
    private readonly reference: string,
    /** What identifies the content at its source, changing whenever the content does: an SSM parameter's ARN and version. */
    identity: string,
    private readonly content: Buffer
  ) {
    this.hash = hashString(`secret ${identity}`);
    this.mime = sniffMime(content);
  }

  public readString(encoding: BufferEncoding = "utf8"): Computable<string> {
    return Computable.resolve(this.content.toString(encoding));
  }

  public getDisplayName(): string {
    return this.reference;
  }

  public isSameFile(file: IFile): boolean {
    return file instanceof SecretFile && file.hash === this.hash;
  }

  public getAbsPath(): undefined {
    return undefined;
  }

  public getBuffer(): Computable<Buffer> {
    return Computable.resolve(this.content);
  }
}

/** Throw where `files` holds a secret, naming it and what cannot be done with it (`stored in the build cache`). */
export function refuseSecrets(files: FileSet, refused: string): void {
  for (const [name, file] of files) {
    if (file instanceof SecretFile) {
      throw new FabrError(`'${name}' is a secret (${file.getDisplayName()}), so it cannot be ${refused}`);
    }
  }
}
