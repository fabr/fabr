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
import { SecureString } from "../core/SecureString";

/** A property's value as read in one configuration: its words, and where
 *  they came from. */
export class Property {
  private values: SecureString[];
  /** The declaration that gave the value, where one did (a value given as a
   *  constraint has none). Runtime-only, for provenance. */
  public readonly origin?: IPropertyDecl;
  constructor(values: SecureString[], origin?: IPropertyDecl) {
    this.values = values;
    this.origin = origin;
  }

  /** @return the words joined by spaces, their masked runs kept. */
  public toString(): SecureString {
    return SecureString.join(this.values, " ");
  }

  /** @return the words as output shows them, joined by spaces. */
  public toDisplayString(): string {
    return this.toString().toDisplayString();
  }

  /** @return the words, their masked runs kept. */
  public getValues(): SecureString[] {
    return this.values;
  }
}
