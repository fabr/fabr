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
import { Repository } from "../core/Repository";
import { Constraints, RepositoryContext } from "../model/BuildContext";

import { IRuleDefinition } from "./Types";

const TARGET_REGISTRY: Record<string, IRuleDefinition[]> = {};

/**
 * Select the rule for the given target type under the given configuration:
 * every constraint the rule declares must match (by value), and the most
 * specific matching rule (most constraints) wins; a rule registered with no
 * constraints acts as a wildcard. Selection applies uniformly to declared and
 * anonymous targets.
 */
export function getTargetRule(name: string, constraints: Constraints): IRuleDefinition | undefined {
  const candidates = TARGET_REGISTRY[name];
  if (!candidates) {
    return undefined;
  }
  let best: IRuleDefinition | undefined;
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
  return type in TARGET_REGISTRY || type in REPOSITORY_REGISTRY;
}

/**
 * Register a rule for a target type: a single evaluate function that yields
 * either final content or a BuildAction (see ITargetTypeDefinition / RuleResult).
 */
export function registerRule(
  name: string,
  constraints: Constraints,
  evaluate: IRuleDefinition["evaluate"]
): void {
  const definition: IRuleDefinition = { constraints, evaluate };
  if (name in TARGET_REGISTRY) {
    TARGET_REGISTRY[name].push(definition);
  } else {
    TARGET_REGISTRY[name] = [definition];
  }
}

/**
 * Repositories are not rule-built targets: a repository type registers a
 * provider that lazily constructs the Repository instance for a declaration,
 * per BuildContext (its configuration resolves under that context's
 * constraints).
 */
export type RepositoryProvider = (context: RepositoryContext) => Computable<Repository>;

const REPOSITORY_REGISTRY: Record<string, RepositoryProvider> = {};

export function registerRepositoryProvider(name: string, provider: RepositoryProvider): void {
  REPOSITORY_REGISTRY[name] = provider;
}

export function getRepositoryProvider(name: string): RepositoryProvider | undefined {
  return REPOSITORY_REGISTRY[name];
}
