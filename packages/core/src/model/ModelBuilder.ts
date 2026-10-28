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

import {
  DeclKind,
  declPosn,
  IBuildFileContents,
  INameValue,
  IPluginDecl,
  IPropertyDecl,
  IRepositoryDecl,
  IRuleBlock,
  IRuleDecl,
  isRuleBlock,
  ITargetDecl,
  ITargetDefDecl,
  PropertyType,
} from "./AST";
import { IPrefixMatch, IPropertyEntry, Namespace } from "./Namespace";
import { BuildModel } from "./BuildModel";
import { NamespaceBuilder } from "./NamespaceBuilder";
import { BuildContext } from "../context/index";
import { BuildContextImpl } from "../context/BuildContextImpl";
import { BUILD_OPERATION, Constraints } from "./Constraints";
import { ExecutionContext } from "./ExecutionContext";
import { Name } from "../core/Name";
import { parseName } from "./Parser";
import {
  RuleBlockDefinition,
  RuleDefinition,
  PluginContribution,
  RepositoryProvider,
  SelectableRule,
  RuleImplementation,
} from "../rules/Types";
import { FabrError, MultiError, toError } from "../core/Errors";
import { compareText } from "../support/Functional";
import { Computable } from "../core/Computable";
import { NameConstraint } from "../core/Name";
import { Diagnostic, ErrorTrackingLog, ISourcePosition, Log } from "../support/Log";
import { BuildFilesInvalidError, DependencyFailedError, ReferenceFailedError } from "./Errors";
import { checkPluginFile, implementationLoader, PluginPackage } from "./Plugin";
import { validateRuleBlock } from "./Validate";

const DIAG_RULE_UNKNOWN_TYPE = Diagnostic.Error<{ type: string; loc: ISourcePosition }>("A rule for unknown target type '{type}'");
const DIAG_RULE_TARGET_PROPERTY = Diagnostic.Error<{ type: string; key: string; loc: ISourcePosition }>(
  "A rule for '{type}' selects on its property '{key}', which '{type}' does not declare as a STRING"
);
const DIAG_REPOSITORY_UNKNOWN_TYPE = Diagnostic.Error<{ type: string; loc: ISourcePosition }>(
  "A repository of unknown target type '{type}'"
);
const DIAG_REPOSITORY_DUPLICATE = Diagnostic.Error<{ type: string; loc: ISourcePosition }>("Duplicate repository type '{type}'");

/** A `plugin <name>;` naming no plugin fabr can use, with the reason as its detail. */
const DIAG_PLUGIN_UNUSABLE = Diagnostic.Error<{ detail: string; loc: ISourcePosition }>("{detail}");

/**
 * Load what the package entry `implementation` names, a `rule` or `repository`
 * declaration's: the module's default export.
 */
export type LoadImplementation = (implementation: INameValue) => Computable<unknown>;

/**
 * A rule declared in a `.fabr` file: selected from its declaration, its
 * implementation loaded the first time it is selected ({@link definition}).
 */
export class DeclaredRule implements SelectableRule {
  public readonly type?: string;
  public readonly properties: Record<string, string>;
  public readonly targetProperties: Record<string, string>;
  private loaded?: Computable<RuleDefinition>;

  constructor(
    public readonly decl: IRuleDecl,
    private readonly load: LoadImplementation
  ) {
    this.type = decl.type;
    this.properties = guardRecord(decl.properties);
    this.targetProperties = guardRecord(decl.targetProperties);
  }

  /** @return the rule, its implementation loaded; a rule written in `.fabr` loads nothing. */
  public definition(): Computable<RuleDefinition | RuleBlockDefinition> {
    const { decl } = this;
    if (isRuleBlock(decl.implementation)) {
      const selectable = { type: this.type, properties: this.properties, targetProperties: this.targetProperties };
      return Computable.resolve({ ...selectable, decl: decl as IRuleDecl & { implementation: IRuleBlock } });
    }
    const entry = decl.implementation;
    this.loaded ??= loadedImplementation(this.load, entry, "rule").then(implementation => {
      if (typeof implementation !== "object" || implementation === null || typeof (implementation as RuleImplementation).evaluate !== "function") {
        throw new FabrError(`'${entry.value.toString()}' is not a rule implementation (no evaluate)`);
      }
      const { requirements, value, evaluate } = implementation as RuleImplementation;
      return { type: this.type, properties: this.properties, targetProperties: this.targetProperties, requirements, value, evaluate };
    });
    return this.loaded;
  }
}

/** @return a guard, as a rule's record of patterns. */
function guardRecord(guard: NameConstraint[]): Record<string, string> {
  return Object.fromEntries(guard.map(([key, pattern]) => [key, pattern.toString()]));
}

/** Load the implementation `implementation` names, attributing a failure to it. */
function loadedImplementation(load: LoadImplementation, implementation: INameValue, what: string): Computable<unknown> {
  const failed = (err: unknown): never => {
    /* A plugin that failed to build is that build's failure, its tree intact. */
    if (isBuildFailure(err)) {
      throw err;
    }
    throw new FabrError(`The ${what} implementation '${implementation.value.toString()}' could not be loaded: ${toError(err).message}`);
  };
  try {
    return load(implementation).then(loaded => loaded, failed);
  } catch (err) {
    return failed(err);
  }
}

/** @return true if `err` is a target's failure to build (rendered as its failure tree), otherwise false. */
function isBuildFailure(err: unknown): err is Error {
  return err instanceof DependencyFailedError || err instanceof ReferenceFailedError || err instanceof MultiError;
}

/**
 * Make the provider of a repository type `decl` declares: its implementation,
 * loaded the first time an instance is constructed, is the provider.
 */
function declaredProvider(decl: IRepositoryDecl, load: LoadImplementation): RepositoryProvider {
  let provider: Computable<RepositoryProvider> | undefined;
  return context => {
    provider ??= loadedImplementation(load, decl.implementation, "repository").then(implementation => {
      if (typeof implementation !== "function") {
        throw new FabrError(`'${decl.implementation.value.toString()}' is not a repository implementation (not a function)`);
      }
      return implementation as RepositoryProvider;
    });
    return provider.then(made => made(context));
  };
}

/**
 * The {@link BuildModel} as it is made: the loader adds each round's files
 * ({@link addFiles}) and the plugins their `plugin` declarations resolve to
 * ({@link addPlugin}), and checks the whole once loading ends ({@link finish});
 * everything else holds it as the read-only {@link BuildModel}.
 */
export class ModelBuilder implements BuildModel {
  /** What the files added so far declare, collated; {@link root} reads it. */
  private readonly builder: NamespaceBuilder;
  private readonly root: Namespace;
  private configs: BuildContextImpl[] = [];
  /**
   * The rules and repository providers available to this model: those core's
   * contribution lists, and those the files added declare.
   */
  private readonly targetRules: Map<string, SelectableRule[]> = new Map();
  private readonly defaultRules: SelectableRule[] = [];
  private readonly repositories: Map<string, RepositoryProvider> = new Map();
  /** The rules the contributions list, checked against their types by {@link validate}. */
  private readonly contributedRules: RuleDefinition[] = [];
  /** The rules and repository types the files declare, checked against their types by {@link validate}. */
  private readonly declaredRules: DeclaredRule[] = [];
  private readonly declaredRepositories: IRepositoryDecl[] = [];
  /** The package each plugin's implementations are loaded from, by its package's own name. */
  private readonly packages = new Map<string, () => Computable<string>>();
  /** The first `plugin` declaration of each name the files added make. */
  private readonly pluginDecls = new Map<string, IPluginDecl>();
  /** The names of the `plugin` declarations resolved, to a plugin or not. */
  private readonly resolvedPlugins = new Set<string>();
  /** Loads the implementations `rule` and `repository` declarations name. */
  private readonly load: LoadImplementation;
  /** What the model reports through, counting its errors: held until {@link finish} reports them to `out`. */
  private readonly log: ErrorTrackingLog;
  /** The diagnostics reported about what was added, each a report to make. */
  private readonly held: Array<(log: Log) => void> = [];
  /** The errors reported elsewhere about what was added: reading its files, resolving its plugins. */
  private reported = 0;
  /** The plugins that failed to build, whose failures {@link finish} rejects with. */
  private readonly failedBuilds: Error[] = [];

  /**
   * Make a model of no files, with the rules and repositories of
   * `contributions`, whose declared implementations `load` loads: by default,
   * from core and the plugins added. What is added to it gets wrong is
   * reported through `out` when it is finished, so a model made and dropped
   * reports nothing.
   */
  constructor(
    private readonly out: Log,
    contributions: PluginContribution[],
    load?: LoadImplementation
  ) {
    this.load = load ?? implementationLoader(this.packages);
    const held = this.held;
    this.log = new ErrorTrackingLog({
      log(diagnostic, params) {
        held.push(log => log.log(diagnostic, params));
      },
    });
    this.builder = new NamespaceBuilder(this.log);
    this.root = this.builder.toNamespace();
    for (const contribution of contributions) {
      for (const rule of contribution.rules ?? []) {
        this.contributedRules.push(rule);
        this.addRule(rule);
      }
      for (const repository of contribution.repositories ?? []) {
        /* A repository type names a resolution mechanism; two contributions
         * claiming the same type is a plugin conflict, not a silent last-wins
         * override — reject it. */
        if (this.repositories.has(repository.type)) {
          throw new FabrError(`Duplicate repository type '${repository.type}' registered by more than one plugin`);
        }
        this.repositories.set(repository.type, repository.provider);
      }
    }
  }

  /**
   * Add the declarations of `files` to the model, `reported` errors having been
   * reported reading them. A name they declare that the model already declares
   * is the ordinary conflict. Nothing is checked against a targetdef until
   * {@link validate}, so a file may use a type a file added later declares.
   * A plugin's files (`fromPlugin`) may declare only defaults, and no
   * `fabr_plugin`, so nothing they add changes what was read before them.
   */
  public addFiles(files: IBuildFileContents[], { fromPlugin, reported = 0 }: { fromPlugin: boolean; reported?: number }): void {
    this.reported += reported;
    for (const file of files) {
      if (fromPlugin) {
        checkPluginFile(file, this.log);
      }
      for (const decl of file.plugins) {
        if (!this.pluginDecls.has(decl.name.toString())) {
          this.pluginDecls.set(decl.name.toString(), decl);
        }
      }
      file.properties.forEach(prop => this.builder.addDecl(prop));
      file.defaults.forEach(decl => this.builder.addDefaultDecl(decl));
      file.targetdefs.forEach(def => this.builder.addDecl(def));
      file.targets.forEach(target => this.builder.addDecl(target));
      for (const decl of file.rules) {
        const rule = new DeclaredRule(decl, this.load);
        this.declaredRules.push(rule);
        this.addRule(rule);
      }
      for (const decl of file.repositories) {
        if (this.repositories.has(decl.type)) {
          this.log.log(DIAG_REPOSITORY_DUPLICATE, { type: decl.type, loc: declPosn(decl) });
        } else {
          this.declaredRepositories.push(decl);
          this.repositories.set(decl.type, declaredProvider(decl, this.load));
        }
      }
    }
  }

  /**
   * Add what the `plugin` declaration `decl` resolved to, `reported` errors
   * having been reported resolving it: a plugin package, whose
   * implementations are then loaded from it, or the reason it names none,
   * which is reported here. A second plugin of one package's name is an error.
   */
  public addPlugin(decl: IPluginDecl, resolved: PluginPackage | Error, reported = 0): void {
    this.resolvedPlugins.add(decl.name.toString());
    this.reported += reported;
    if (isBuildFailure(resolved)) {
      this.log.log(DIAG_PLUGIN_UNUSABLE, { detail: `Plugin '${decl.name.toString()}' could not be built`, loc: declPosn(decl) });
      this.failedBuilds.push(resolved);
    } else if (resolved instanceof Error) {
      this.log.log(DIAG_PLUGIN_UNUSABLE, { detail: resolved.message, loc: declPosn(decl) });
    } else if (this.packages.has(resolved.name)) {
      this.log.log(DIAG_PLUGIN_UNUSABLE, { detail: `Plugin '${decl.name.toString()}' is a second plugin named '${resolved.name}'`, loc: declPosn(decl) });
    } else {
      let code: Computable<string> | undefined;
      this.packages.set(resolved.name, () => (code ??= resolved.code(this)));
    }
  }

  /** @return each `plugin` declaration not yet resolved, in name order. */
  public pendingPlugins(): IPluginDecl[] {
    return [...this.pluginDecls.entries()]
      .filter(([name]) => !this.resolvedPlugins.has(name))
      .sort(([a], [b]) => compareText(a, b))
      .map(([, decl]) => decl);
  }

  /**
   * Finish the model: report each `plugin` declaration still pending as naming
   * nothing, check the whole ({@link validate}), and @return the model, or
   * throw if anything added held an error: the failures of plugins that did
   * not build, or else a {@link BuildFilesInvalidError} for errors already
   * reported, which only halts. What is wrong is reported first.
   */
  public finish(): BuildModel {
    for (const decl of this.pendingPlugins()) {
      this.log.log(DIAG_PLUGIN_UNUSABLE, { detail: `Plugin '${decl.name.toString()}' names nothing the project declares`, loc: declPosn(decl) });
    }
    this.validate();
    this.held.splice(0).forEach(report => report(this.out));
    if (this.failedBuilds.length > 0) {
      throw MultiError.of(this.failedBuilds);
    }
    const errorCount = this.reported + this.log.errorCount;
    if (errorCount > 0) {
      throw new BuildFilesInvalidError(errorCount);
    }
    return this;
  }

  /**
   * Check every declaration added against the targetdefs added: each target
   * against its type, and each rule and repository type against the type it is
   * for. A rule or repository type that fails is reported and withdrawn.
   */
  private validate(): void {
    this.builder.validate();
    for (const rule of this.contributedRules) {
      if (rule.type !== undefined) {
        this.assertTargetProperties(rule.type, rule);
      }
    }
    for (const rule of this.declaredRules) {
      const { decl } = rule;
      if (isRuleBlock(decl.implementation)) {
        validateRuleBlock(decl, decl.implementation, type => this.root.getTargetDef(type), this.log);
      }
      if (decl.type === undefined) {
        continue;
      }
      const def = this.root.getTargetDef(decl.type);
      const key = decl.targetProperties.map(([name]) => name).find(name => (def?.properties.get(name) ?? def?.properties.get("*"))?.type !== PropertyType.String);
      if (def === undefined) {
        this.log.log(DIAG_RULE_UNKNOWN_TYPE, { type: decl.type, loc: declPosn(decl) });
      } else if (key !== undefined) {
        this.log.log(DIAG_RULE_TARGET_PROPERTY, { type: decl.type, key, loc: declPosn(decl) });
      } else {
        continue;
      }
      this.targetRules.set(decl.type, (this.targetRules.get(decl.type) ?? []).filter(other => other !== rule));
    }
    for (const decl of this.declaredRepositories) {
      if (this.root.getTargetDef(decl.type) === undefined) {
        this.log.log(DIAG_REPOSITORY_UNKNOWN_TYPE, { type: decl.type, loc: declPosn(decl) });
        this.repositories.delete(decl.type);
      }
    }
  }

  /** Add `rule` to the table selection reads for its type. */
  private addRule(rule: SelectableRule): void {
    if (rule.type === undefined) {
      this.defaultRules.push(rule);
    } else {
      this.targetRules.set(rule.type, [...(this.targetRules.get(rule.type) ?? []), rule]);
    }
  }

  /**
   * Check that a type-specific rule guards only on what its type declares: each
   * of its `targetProperties` must be a STRING property of the type's targetdef.
   * A type with no targetdef has no schema to check against.
   */
  private assertTargetProperties(type: string, rule: RuleDefinition): void {
    const schema = this.root.getTargetDef(type)?.properties;
    if (!schema) {
      return;
    }
    for (const key of Object.keys(rule.targetProperties ?? {})) {
      if ((schema.get(key) ?? schema.get("*"))?.type !== PropertyType.String) {
        throw new FabrError(`A rule for '${type}' selects on its property '${key}', which '${type}' does not declare as a STRING`);
      }
    }
  }

  public getTargetRules(type: string): SelectableRule[] {
    return this.targetRules.get(type) ?? [];
  }

  public getDefaultRules(): SelectableRule[] {
    return this.defaultRules;
  }

  public getRuleDefinition(rule: SelectableRule): Computable<RuleDefinition | RuleBlockDefinition> {
    return rule instanceof DeclaredRule ? rule.definition() : Computable.resolve(rule as RuleDefinition);
  }

  public getRepositoryProvider(type: string): RepositoryProvider | undefined {
    return this.repositories.get(type);
  }

  public getTargetDefs(): ITargetDefDecl[] {
    return this.root.getTargetDefs();
  }

  public getTargets(): { name: string; decl: ITargetDecl }[] {
    return this.root.getTargets().filter(target => !this.repositories.has(target.decl.type));
  }

  public getDeclaredTargets(): { name: string; decl: ITargetDecl }[] {
    return this.root.getTargets();
  }

  public getProperties(): { name: string; decl: IPropertyDecl }[] {
    return this.root.getProperties();
  }

  public getOperations(type: string): string[] {
    return [...new Set(this.getTargetRules(type).map(rule => rule.properties[BUILD_OPERATION] ?? "*"))].sort();
  }

  public getConfig(constraints: Constraints, execution: ExecutionContext): BuildContext {
    /* Todo: hash the constraints instead of linearly scanning */
    for (const config of this.configs) {
      if (config.execution === execution && config.hasConstraints(constraints)) {
        return config;
      }
    }
    const config = new BuildContextImpl(this, constraints, execution);
    this.configs.push(config);
    return config;
  }

  public getDecl(name: string): IPropertyEntry | ITargetDecl | undefined {
    return this.root.getDecl(name);
  }

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

  public getReferencedTarget(name: string): ITargetDecl | undefined {
    const match = this.getPrefixMatch(parseName(name).withConstraints([]));
    return match && this.getTargetDecl(match.name);
  }
}

/**
 * Make the model of `files` alone, with the rules and repositories of
 * `contributions` and those the files declare, whose implementations `load`
 * loads: for a test, which reads what is wrong from `log` and is given the
 * model whatever it holds.
 */
export function toBuildModel(files: IBuildFileContents[], log: Log, contributions: PluginContribution[], load?: LoadImplementation): BuildModel {
  const model = new ModelBuilder(log, contributions, load);
  model.addFiles(files, { fromPlugin: false });
  try {
    return model.finish();
  } catch (err) {
    if (err instanceof BuildFilesInvalidError) {
      return model;
    }
    throw err;
  }
}
