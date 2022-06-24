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

import { Name } from "../model/Name";
import { Computable } from "./Computable";

export interface FileSet {
  /**
   * Find all files in the FileSet that match the given Name, returning a new FileSet with the results.
   * @param name
   */
  find(name: Name): FileSet;

  /**
   * Find all files in the FileSet that match the given Name, relative to the given filename
   * @param relativeTo
   * @param name
   */
  findRelative(relativeTo: string, name: Name): FileSet;

  /**
   * Read the contents of the given file as a string
   * @param file
   * @param encoding Optional encoding to use for the file (default UTF8)
   */
  readFileAsString(file: string, encoding?: BufferEncoding): Computable<string>;

  /**
   * @return a string representing the given file, suitable for logging or other
   * human-readable output (it may or may not be a legal OS path).
   */
  getDisplayName(file: string): string;
}
