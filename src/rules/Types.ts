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

import { Computable } from "../core/Computable";
import { FileSet, FileSource } from "../core/FileSet";
import { BuildContext, Constraints } from "../model/BuildContext";
import { Property } from "../model/Property";
import { Target } from "../model/Target";

export enum PropertyType {
  String,
  FileSet,
  StringList,
  FileSetList,
  OutputFileSet,
}

export interface ITargetTypeDefinition {
  constraints: Constraints;

  /**
   * Evaluation function. Note that the type of entity will be
   *   ResolvedType<S>
   * but Typescript currently doesn't seem to be able to track this through the interface.
   * @param entity
   */
  evaluate(entity: ResolvedTarget, context: BuildContext): Computable<FileSource>;
}

/**
 * This is a convenience class wrapper around the actual resolved data to provide a bit of
 * type safety.
 *
 * Note that a type mismatch here is treated as an error, as it indicates a conflict between
 * the rule code and the target definition.
 */
export class ResolvedTarget {
  private values: Record<string, Property | FileSource[]>;

  constructor(values: Record<string, Property | FileSource[]>) {
    this.values = values;
  }

  public getRequiredProperty(name: string): Property {
    const property = this.getProperty(name);
    if (property === undefined) {
      throw new Error("Missing required property " + name);
    }
    return property;
  }

  public getProperty(name: string): Property | undefined {
    const property = this.values[name];
    if (property === undefined || property instanceof Property) {
      return property;
    } else {
      throw new Error("Unexpected files when expecting string property for " + name);
    }
  }

  public getRequiredString(name: string): string {
    return this.getRequiredProperty(name).toString();
  }

  public getFileSources(name: string): FileSource[] {
    const files = this.values[name];
    if (files instanceof Property) {
      throw new Error("Unexpected string property when expecting files for " + name);
    } else {
      return files ?? [];
    }
  }

  public getFileSet(name: string): FileSet {
    const files = this.getFileSources(name);
    if (!files.every(file => file instanceof FileSet)) {
      throw new Error("Files required for property " + name + " but got a repository");
    }
    return FileSet.unionAll(...(files as FileSet[]));
  }
}
