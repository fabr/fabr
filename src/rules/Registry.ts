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
import { Repository } from "../core/Repository";
import { Constraints, TargetContext } from "../model/BuildContext";

import { ITargetTypeDefinition } from "./Types";

const TARGET_REGISTRY: Record<string, ITargetTypeDefinition[]> = {};

/**
 * Select the rule for the given target type under the given configuration:
 * every constraint the rule declares must match (by value), and the most
 * specific matching rule (most constraints) wins; a rule registered with no
 * constraints acts as a wildcard.
 */
export function getTargetRule(name: string, constraints: Constraints): ITargetTypeDefinition | undefined {
  const candidates = TARGET_REGISTRY[name];
  if (!candidates) {
    return undefined;
  }
  let best: ITargetTypeDefinition | undefined;
  let bestCount = -1;
  for (const candidate of candidates) {
    const entries = Object.entries(candidate.constraints);
    if (entries.length > bestCount && entries.every(([key, value]) => constraints[key] === value)) {
      best = candidate;
      bestCount = entries.length;
    }
  }
  return best;
}

export function hasTargetType(type: string): boolean {
  return type in TARGET_REGISTRY;
}

export function registerTargetRule(
  name: string,
  constraints: Constraints,
  evaluate: (target: TargetContext) => Computable<FileSource | Repository>
): void {
  if (name in TARGET_REGISTRY) {
    TARGET_REGISTRY[name].push({ constraints, evaluate });
  } else {
    TARGET_REGISTRY[name] = [{ constraints, evaluate }];
  }
}
