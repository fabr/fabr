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

import { IFile, IDir, FileSet } from "./FileSet";

/**
 * Mutable class used be e.g. FS to create and maintain the underlying set of
 * files from which the immutable FileSet is constructed
 */
export class FileSetBuilder {

    constructor() {

    }

    add( name: string, file: IFile ) : void {

    }

    /**
     * @return the top-level FileSet containing the builder's files.
     * 
     * Note: this may be called multiple times, and should return the
     * same FileSet if the builder has not been modified between calls.
     */
    build() : FileSet {

    }
}