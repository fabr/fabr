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

import { DeclKind, INamespaceDecl, IPropertyDecl, ITargetDecl, ITargetDefDecl } from "./AST";
import { IPrefixMatch, IPropertyEntry, Namespace } from "./Namespace";
import { BuildContext } from "./BuildContext";
import { BUILD_OPERATION, Constraints } from "./Constraints";
import { ExecutionContext } from "./ExecutionContext";
import { Name } from "../core/Name";
import { parseName } from "./Parser";
import { IRuleDefinition, PluginContribution, RepositoryProvider } from "../rules/Types";

/**
 * The most specific rule among `candidates` matching the given configuration:
 * every constraint the rule declares must match (by value), and the most
 * specific match (most constraints) wins; a rule with no constraints acts as a
 * wildcard. Returns undefined if none match.
 */
function selectMostSpecific(
  candidates: IRuleDefinition[],
  constraints: Constraints,
  ruleSet: string
): IRuleDefinition | undefined {
  const matching = candidates.filter(candidate =>
    Object.entries(candidate.constraints).every(([key, value]) => constraints.get(key) === value)
  );
  if (matching.length === 0) {
    return undefined;
  }
  let best = matching[0];
  let bestCount = Object.keys(best.constraints).length;
  let tiedAt: IRuleDefinition | undefined;
  for (let i = 1; i < matching.length; i++) {
    const count = Object.keys(matching[i].constraints).length;
    if (count > bestCount) {
      best = matching[i];
      bestCount = count;
      tiedAt = undefined;
    } else if (count === bestCount) {
      tiedAt = matching[i];
    }
  }
  if (tiedAt) {
    /* Two equally-specific rules both match — the selection would be an arbitrary
     * registration-order accident, so reject it rather than silently pick one. */
    const show = (rule: IRuleDefinition): string => `{${Object.entries(rule.constraints).map(([k, v]) => `${k}=${v}`).join(", ")}}`;
    throw new Error(`Ambiguous ${ruleSet} rule selection: ${show(best)} and ${show(tiedAt)} are equally specific`);
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
  private readonly targetRules: Map<string, IRuleDefinition[]> = new Map();
  private readonly defaultRules: IRuleDefinition[] = [];
  private readonly repositories: Map<string, RepositoryProvider> = new Map();

  constructor(root: Namespace, contributions: PluginContribution[]) {
    this.root = root;
    for (const contribution of contributions) {
      for (const rule of contribution.rules ?? []) {
        const definition: IRuleDefinition = { constraints: rule.constraints, evaluate: rule.evaluate };
        if (rule.type === undefined) {
          this.defaultRules.push(definition);
        } else {
          const rules = this.targetRules.get(rule.type) ?? [];
          rules.push(definition);
          this.targetRules.set(rule.type, rules);
        }
      }
      for (const repository of contribution.repositories ?? []) {
        /* A repository type names a resolution mechanism; two contributions
         * claiming the same type is a plugin conflict, not a silent last-wins
         * override — reject it. */
        if (this.repositories.has(repository.type)) {
          throw new Error(`Duplicate repository type '${repository.type}' registered by more than one plugin`);
        }
        this.repositories.set(repository.type, repository.provider);
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
    return (
      selectMostSpecific(this.targetRules.get(type) ?? [], constraints, `'${type}'`) ??
      selectMostSpecific(this.defaultRules, constraints, "default")
    );
  }

  public getRepositoryProvider(type: string): RepositoryProvider | undefined {
    return this.repositories.get(type);
  }

  /** @return every declared targetdef (the build vocabulary), in declaration
   * order — for diagnostic listing (`fabr list-targetdefs`). */
  public getTargetDefs(): ITargetDefDecl[] {
    return this.root.getTargetDefs();
  }

  /** @return every buildable target declared in the project, with its
   * fully-qualified name — for diagnostic listing (`fabr list-targets`).
   * Repository instances (`npm_repository @npm`, `catalog @dep`) share the
   * target-decl shape but are not buildable targets, so they are excluded (a
   * type is a repository iff it has a registered provider). */
  public getTargets(): { name: string; decl: ITargetDecl }[] {
    return this.root.getTargets().filter(target => !this.repositories.has(target.decl.type));
  }

  /** @return every declared target — repository instances (`npm_repository
   * @npm`, `catalog @dep`) included — in declaration order. The docs listing
   * (`fabr list-all`), which documents repositories alongside ordinary lib
   * targets; {@link getTargets} excludes them as not buildable. */
  public getDeclaredTargets(): { name: string; decl: ITargetDecl }[] {
    return this.root.getTargets();
  }

  /** @return every property declared in the project (effective set — a `default`
   * counts unless overridden), for documenting the configuration surface
   * (`fabr list-targetdefs --json` emits the documented ones). */
  public getProperties(): { name: string; decl: IPropertyDecl }[] {
    return this.root.getProperties();
  }

  /** @return the BUILD_OPERATION values for which a type-specific rule is
   * registered for `type` — the operations that type supports (`build`,
   * `test`, `run`, …). A rule that constrains no operation is a wildcard,
   * reported as `"*"` (it applies to any operation). Default (all-types)
   * rules are excluded: they apply everywhere and so say nothing about a
   * particular type. */
  public getOperations(type: string): string[] {
    const ops = new Set<string>();
    for (const rule of this.targetRules.get(type) ?? []) {
      ops.add(rule.constraints[BUILD_OPERATION] ?? "*");
    }
    return [...ops].sort();
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

  public getDecl(name: string): IPropertyEntry | ITargetDecl | INamespaceDecl | undefined {
    return this.root.getDecl(name);
  }

  /** @return the target this name declares, or undefined if it names something
   * else (a property, a namespace) or nothing at all — for a caller that needs
   * a target's *type* (and so what can be done with it) before asking for it. */
  public getTargetDecl(name: string): ITargetDecl | undefined {
    const decl = this.root.getDecl(name);
    return decl?.kind === DeclKind.Target ? decl : undefined;
  }

  public getTargetDef(name: string): ITargetDefDecl | undefined {
    return this.root.getTargetDef(name);
  }

  public getPrefixMatch(name: Name): IPrefixMatch | undefined {
    return this.root.getPrefixMatch(name);
  }

  /**
   * The declared target a written reference builds — its literal prefix, read
   * exactly as resolution reads it, so `pkg:bin/x.js` and `pkg<BUILD_TYPE=release>`
   * both name `pkg`. Undefined when the reference names no declared target at
   * all (an external requirement, a bare path, an unknown name).
   *
   * This is for a caller holding a name it was *given* and needing to say
   * something about the target behind it before building — the CLI's `-f`,
   * which marks what the command line named. Asking the model keeps that
   * reading in the one place that owns it: a driver splitting the name itself
   * would be a second, divergent answer to what a reference means.
   */
  public getReferencedTarget(name: string): ITargetDecl | undefined {
    const match = this.getPrefixMatch(parseName(name).withConstraints([]));
    return match && this.getTargetDecl(match.name);
  }
}
