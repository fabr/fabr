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

import { INamespaceDecl, IPropertyDecl, ITargetDecl, ITargetDefDecl } from "./AST";
import { IPrefixMatch, Namespace } from "./Namespace";
import { BuildContext, Constraints } from "./BuildContext";
import { ExecutionContext } from "./ExecutionContext";
import { Name } from "./Name";
import { IRuleDefinition, PluginContribution, RepositoryProvider } from "../rules/Types";

/**
 * The most specific rule among `candidates` matching the given configuration:
 * every constraint the rule declares must match (by value), and the most
 * specific match (most constraints) wins; a rule with no constraints acts as a
 * wildcard. Returns undefined if none match.
 */
function selectMostSpecific(candidates: IRuleDefinition[], constraints: Constraints): IRuleDefinition | undefined {
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

/**
 * Build model holds the generalized model-as-it-is-written in the build files.
 *
 * It primarily exists to maintain a cache from constraint sets to active
 */
export class BuildModel {
  private root: Namespace;
  private configs: BuildContext[] = [];
  /**
   * The rules and repository providers available to this model — indexed from
   * core's base contribution plus each active plugin's, so they reflect exactly
   * the declared plugin set (not process-global registration). Held directly by
   * the model (rather than in a separate registry) because rules are model-level
   * knowledge, on the same footing as targets/properties — and a future language
   * surface for defining rules would add to these same tables.
   */
  private readonly targetRules: Record<string, IRuleDefinition[]> = {};
  private readonly defaultRules: IRuleDefinition[] = [];
  private readonly repositories: Record<string, RepositoryProvider> = {};

  constructor(root: Namespace, contributions: PluginContribution[]) {
    this.root = root;
    for (const contribution of contributions) {
      for (const rule of contribution.rules ?? []) {
        const definition: IRuleDefinition = { constraints: rule.constraints, evaluate: rule.evaluate };
        if (rule.type === undefined) {
          this.defaultRules.push(definition);
        } else {
          (this.targetRules[rule.type] ??= []).push(definition);
        }
      }
      for (const repository of contribution.repositories ?? []) {
        this.repositories[repository.type] = repository.provider;
      }
    }
  }

  /**
   * Select the rule for the given target type under the given configuration.
   * A type-specific rule is preferred over a default (all-types) rule — the type
   * dimension dominates the constraint dimension — so the default rules are only
   * consulted when no type-specific rule matches. Uniform for declared and
   * anonymous targets.
   */
  public getTargetRule(type: string, constraints: Constraints): IRuleDefinition | undefined {
    return selectMostSpecific(this.targetRules[type] ?? [], constraints) ?? selectMostSpecific(this.defaultRules, constraints);
  }

  public getRepositoryProvider(type: string): RepositoryProvider | undefined {
    return this.repositories[type];
  }

  /**
   * @return the build configuration under the given (possibly empty set of)
   * constraints, evaluating within the given execution context. The model
   * itself is purely the declarations as written; everything runtime (the
   * build cache, progress observers) rides in the ExecutionContext.
   */
  public getConfig(constraints: Constraints, execution: ExecutionContext): BuildContext {
    /* Todo: hash the constraints instead of linearly scanning */
    for (const config of this.configs) {
      if (config.execution === execution && config.hasConstraints(constraints)) {
        return config;
      }
    }
    const config = new BuildContext(this, constraints, execution);
    this.configs.push(config);
    return config;
  }

  public getDecl(name: string): IPropertyDecl | ITargetDecl | INamespaceDecl | undefined {
    return this.root.getDecl(name);
  }

  public getTargetDef(name: string): ITargetDefDecl | undefined {
    return this.root.getTargetDef(name);
  }

  public getPrefixMatch(name: Name): IPrefixMatch | undefined {
    return this.root.getPrefixMatch(name);
  }
}
