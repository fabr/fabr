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

import type { IPropertyDecl } from "./AST";

export class Property {
  private values: string[];
  /** The declaration that answered, where one did (a value given as a
   *  constraint has none). Runtime-only: for saying where a value came from. */
  public readonly origin?: IPropertyDecl;
  constructor(values: string[], origin?: IPropertyDecl) {
    this.values = values;
    this.origin = origin;
  }

  public toString(): string {
    return this.values.join(" ");
  }

  public getValues(): string[] {
    return this.values;
  }
}
