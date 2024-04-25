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
import { FileSource } from "../core/FileSet";
import { BuildContext, Constraints } from "../model/BuildContext";

import { ITargetTypeDefinition, ResolvedTarget } from "./Types";

const TARGET_REGISTRY: Record<string, ITargetTypeDefinition[]> = {};

export function getTargetRule(name: string): ITargetTypeDefinition | undefined {
  const candidates = TARGET_REGISTRY[name];
  if (candidates) {
    /* TODO */
    return candidates[0];
  }
}

export function hasTargetType(type: string): boolean {
  return type in TARGET_REGISTRY;
}

export function registerTargetRule(
  name: string,
  constraints: Constraints,
  evaluate: (spec: ResolvedTarget, config: BuildContext) => Computable<FileSource>
): void {
  if (name in TARGET_REGISTRY) {
    TARGET_REGISTRY[name].push({ constraints, evaluate });
  } else {
    TARGET_REGISTRY[name] = [{ constraints, evaluate }];
  }
}
