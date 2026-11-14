/*
 * Copyright (c) 2026 Nathan Keynes <nkeynes@deadcoderemoval.net>
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

import { ActionContext, ICreateOptions } from "../core/BuildCache";
import { Computable, ComputableSource } from "../core/Computable";
import { EMPTY_FILESET, FileSet, FileSource, IFile } from "../core/FileSet";
import {
  isRepository,
  isRepositoryReader,
  Materialized,
  ProjectedPackage,
  renamedAs,
  Repository,
  RepositoryRef,
  Resolved,
  SourceRef,
} from "../core/Repository";
import { ResolutionContext } from "../resolver/Types";
import { PERMISSIVE_RESOLUTION } from "./CollectionPoint";
import { materializeShallow, materializeShallowEach, resolveLists } from "./CollectionPoint";
import { FileSetRef, FileSourceRef } from "../core/FileSetRef";
import { soleWholeTarget, TargetNode, TargetRef, TargetSource, Unbuilt } from "../core/TargetRef";
import { ResolvedTarget } from "./ResolvedTarget";
import { PartialRepositoryRef } from "../core/PartialRepositoryRef";
import { IProjection, jointMiss, Miss, Reference } from "../core/Reference";
import { registerReferenceStep } from "../core/Provenance";
import {
  DEPENDENCIES_KEY,
  EXTENDS_KEY,
  OPTIONAL_PROVIDED_KEY,
  PackageSources,
  ResolutionSpec,
  PROVIDED_KEY,
  Read,
  RequiredSources,
  specEntries,
  resolveRequirements,
  unmaterialized,
  Unmaterialized,
} from "./Collection";
import { RunnableFileSet, toRunnable } from "../core/RunnableFileSet";
import { Builds, Dependency, isPackage, PackageFileSet, ResolvedNode } from "../core/PackageFileSet";
import { BuildAction, BuildResult } from "../core/BuildAction";
import {
  TargetRules,
  RuleBlockDefinition,
  RuleDefinition,
  RuleResult,
  RepositoryImplementation,
  RepositoryProvider,
  SelectableRule,
  SubTargetInputs,
} from "../rules/Types";
import { BUILD_OPERATION, Constraints, COVERAGE, HOST, operationOf, RUN_OVERRIDE, TARGET } from "../model/Constraints";
import { TaskDescription } from "../model/BuildEvents";
import { ExecutionContext } from "../model/ExecutionContext";
import {
  CommandPipeline,
  DeclKind,
  declName,
  declPosn,
  hasMapValue,
  ICommandStage,
  IDecl,
  IMapItemDecl,
  ISpliceDecl,
  ICommandValue,
  IMapValue,
  INameValue,
  IPropertyDecl,
  isCommandValue,
  isMapValue,
  isNameValue,
  ITargetDecl,
  ITargetDefDecl,
  guardText,
  mergedDecls,
  parameterProperty,
  soleDecl,
} from "../model/AST";
import { EXPAND_TAG, expandOnce, findWithDescent } from "../support/Expand";
import { DependencyFailedError, NameResolutionError, NoRuleFoundError, ReferenceFailedError } from "../model/Errors";
import { ConflictError, FabrError, IConflictSide, IConflictSource, toError } from "../core/Errors";
import { hasTestFailures } from "../support/TestResult";
import { createPipelineAction, stagePipeline } from "../core/PipelineAction";
import { closestMatch } from "../support/Suggest";
import { Name, NAME_COMPONENT_SEPARATOR, NameConstraint, NamePart, NamePartKind } from "../core/Name";
import { COMMAND_LINE_FILE } from "../core/Constants";
import { globMatcher } from "../support/Glob";
import { applyPatternEdit } from "../support/PatternEdit";
import { parseName } from "../model/Parser";
import { IPrefixMatch, IPropertyEntry, Namespace, writtenSeparator } from "../model/Namespace";
import { Property } from "../model/Property";
import { IModelStep, ISubstitution, MODEL_PROVENANCE } from "../model/ModelProvenance";
import { BuildContext, InternalBuildContext, IRepositoryMember, ISplicedEntry } from "./BuildContext";
import { mergeMapInto, PropertyMap, PropertyMapValue, recordMapOrigin } from "./PropertyMap";
import { IDependencyStack, IUseFrame, useFrameOf, useSiteOf } from "./Stack";
import { NameLabel, ReferenceLabel } from "../model/Errors";
import { IncompleteRef, isIncompleteRef, NamespaceRef, sourceOf } from "../core/NamespaceRef";
import { IRuleSelection, selectRule } from "./RuleSelection";
import { DeclaredResolvedTarget, BlockTargetNode, passedOn } from "./ResolvedTarget";
import {
  collectRunnable,
  captureStages,
  ICommandStageLookup,
  IPositionedName,
  normalizeCommandOutput,
  MaterializedCommandStage,
  SUBST_CAPTURE,
} from "./Commands";
import { ResolvedRequirements } from "./Collection";
import type { Credential } from "../core/Credential";
import {
  AnonymousTargetContext,
  DeclaredTargetContext,
  enclosingRules,
  MemberTargetContext,
  ScopedTargetContext,
  TargetContext,
} from "./TargetContext";

/** Attach a name's remedies to its error as the `help:` line, if there are any. */
function withHints<T extends FabrError>(err: T, hints: string[]): T {
  return hints.length > 0 ? err.withHelp(hints.join("; ")) : err;
}

/** The build model as a configuration reads it. */
interface IBuildModel {
  getConfig(constraints: Constraints, execution: ExecutionContext): BuildContext;
  getDecl(name: string): IPropertyEntry | ITargetDecl | undefined;
  getPrivateScope(file: string): Namespace | undefined;
  getPrivateFiles(name: string): string[];
  getTargetDef(name: string): ITargetDefDecl | undefined;
  getPrefixMatch(name: Name, file?: string): IPrefixMatch | undefined;
  /** Get every declared target, for nearest-match suggestions. */
  getTargets(): { name: string; decl: ITargetDecl }[];
  /** Get every declared property, for nearest-match suggestions. */
  getProperties(): { name: string; decl: IPropertyDecl }[];
  /** Get the rules declared for targets of `type`, from core and the plugins in use. */
  getTargetRules(type: string): TargetRules[];
  /** Get the rules declared for targets of any type. */
  getDefaultRules(): SelectableRule[];
  /** Get the operations `type` has rules of its own for, `*` for a rule of any operation. */
  getOperations(type: string): string[];
  /** Get a selected rule with its implementation, loaded where it was declared. */
  getRuleDefinition(rule: SelectableRule): Computable<RuleDefinition>;
  hasRepositoryType(type: string): boolean;
  getRepositoryImplementation(type: string): Computable<RepositoryImplementation> | undefined;
}

/** Resolve the requirements the repository type `implementation` states for the declaration `context` evaluates, as a target's are. */
function requirementsOf(
  implementation: Computable<RepositoryImplementation>,
  context: TargetContext
): Computable<ResolvedRequirements> {
  return implementation.then(made => resolveRequirements(context, made.requirements?.(context) ?? {}));
}

/** Make what the repository type `implementation` provides for the declaration `context` evaluates, given its `requirements`. */
function provided(
  implementation: Computable<RepositoryImplementation>,
  context: TargetContext,
  requirements: Computable<ResolvedRequirements>,
  url?: string,
  credential?: Credential
): ReturnType<RepositoryProvider> {
  return implementation.then(made => requirements.then(resolved => made.provider(context, url, credential, resolved)));
}

/**
 * Get `err`, a failure of what the written reference `step` records names, as
 * the reference's failure: a target's failure (`DependencyFailedError`,
 * `NoRuleFoundError`) is wrapped in a `ReferenceFailedError` naming the use
 * site, and a `ConflictError` gets `step` added to the provenance of both
 * sides. Any other error is returned as it is.
 */
function failureOfReference(step: IModelStep, err: Error): Error {
  if (err instanceof DependencyFailedError || err instanceof NoRuleFoundError) {
    return new ReferenceFailedError(step.value, step.property, step.target, err);
  }
  if (err instanceof ConflictError) {
    const chain = (side: IConflictSide): IConflictSource => ({
      provenance: { ...step, parent: side.provenance },
      detail: side.detail,
    });
    return new ConflictError(err.kind, err.key, chain(err.left), chain(err.right));
  }
  return err;
}

/* A model step attributes a failure, and labels a cycle, by the written reference. */
registerReferenceStep(MODEL_PROVENANCE, {
  failure: (step, err) => failureOfReference(step as IModelStep, err),
  label: step =>
    new ReferenceLabel({
      value: (step as IModelStep).value,
      property: (step as IModelStep).property,
      target: (step as IModelStep).target,
    }),
});

/**
 * A configuration: the build model with a set of constraints (possibly none)
 * applied, implementing both {@link BuildContext} and
 * {@link InternalBuildContext}. It looks names up, reads and substitutes
 * properties, resolves targets and repositories (each memoised by name), and
 * evaluates targets with their rules. The model holds one per constraint set
 * ({@link getContextWithOverrides}, {@link inConfiguration}); a build file
 * that declares private names sees it through a {@link FileScopedContext}
 * ({@link inFile}).
 */
export class BuildContextImpl implements InternalBuildContext {
  public readonly execution: ExecutionContext;
  protected readonly constraints: Constraints;
  public readonly model: IBuildModel;
  /** The value of each property read here with no caller override, by name. */
  private propCache: Map<string, Computable<Property | undefined>>;
  /** What each name resolves to here with no caller override ({@link resolveTarget}), by name. */
  private targetCache: Map<string, Computable<SourceRef[]>>;
  /** This configuration as each build file declaring private names sees it, by the file's name. */
  private readonly fileScopes = new Map<string, FileScopedContext>();
  /** The rule-built targets of this configuration, resolved, by name. A
   * target's entry in `targetCache` is the reference to it. */
  private readonly resolvedTargets = new Map<string, Computable<ResolvedTarget>>();
  /** The resolved requirements of each repository declaration, by its name. */
  private readonly resolvedRepositories = new Map<string, Computable<ResolvedRequirements>>();

  constructor(model: IBuildModel, constraints: Constraints, execution: ExecutionContext) {
    this.model = model;
    this.constraints = constraints;
    this.execution = execution;
    this.propCache = new Map();
    this.targetCache = new Map();
  }

  /** @return true if this configuration's constraints give `name` a value,
   *  which is then read in place of any declaration of it, otherwise false. */
  protected constrains(name: string): boolean {
    return this.constraints.has(name);
  }

  /**
   * Get this configuration as seen from the build file `file`: where the file
   * declares private names, a configuration that looks those up first (one per
   * file); otherwise this one.
   */
  public inFile(file: string | undefined): BuildContextImpl {
    const names = file === undefined ? undefined : this.model.getPrivateScope(file);
    if (names === undefined) {
      return this;
    }
    let scoped = this.fileScopes.get(file!);
    if (scoped === undefined) {
      scoped = new FileScopedContext(this.model, this.constraints, this.execution, file!, names, this);
      this.fileScopes.set(file!, scoped);
    }
    return scoped;
  }

  /**
   * Expand an archive file through the build cache, keyed on its content hash
   * under EXPAND_TAG, so an archive is expanded once however many projections
   * reach into it.
   */
  private expandArchive(file: IFile): Computable<FileSet> {
    return this.getCachedOrBuild(`memo:${EXPAND_TAG} ${file.hash}`, () => expandOnce(file).then(result => ({ result })));
  }

  /**
   * Make the {@link ResolutionContext} for a collection point this
   * configuration enters itself (`materialize`, `resolve`, a command
   * substitution's tools), named `name` in progress output.
   */
  private resolutionContext(name = "<command line>"): ResolutionContext {
    const context: ResolutionContext = {
      name,
      operation: operationOf(this.getConstraints()),
      getGlobalString: name => this.getProperty(name).then(prop => prop.toString()),
      launchedBy: (runnable, interpreter, interpreterArgs) =>
        this.resolveTarget(interpreter, undefined, this.runOverrides())
          .then(sources => collectRunnable(this, context, sources, interpreter))
          .then(launcher => runnable.launchedBy(launcher, this.execution.buildCache, interpreterArgs)),
      memoize: (tag, key, create) =>
        this.getCachedOrBuild(`memo:${tag} ${key}`, ctx => create(ctx.workDir).then(result => ({ result }))),
      runTask: (task, run) => this.execution.runTask(task, run),
    };
    return context;
  }

  /**
   * Project `source` by `pattern`, descending into archives through this
   * context's cached expansion ({@link expandArchive}).
   */
  private findWithDescent(source: FileSource, pattern: Name, prefix: string): ComputableSource<FileSet> {
    return findWithDescent(source, pattern, prefix, file => this.expandArchive(file));
  }

  /**
   * Apply a pending ref's projections in order, each over what the one before
   * selected and descending into archives where it crosses one, and throw the
   * ref's `miss` where the result is empty. A projection over a runnable
   * selects its entry instead ({@link toRunnable}).
   */
  private applyProjection(ref: FileSourceRef): ComputableSource<FileSet> {
    let result: ComputableSource<FileSet>;
    if (ref instanceof FileSetRef && ref.source instanceof RunnableFileSet) {
      /* A projection over a runnable selects its entry. An entry not found is
       * the empty set, judged by `miss` below as any other projection is. */
      result = Computable.resolve(toRunnable(ref) ?? EMPTY_FILESET);
    } else {
      /* A ref always has at least one projection. */
      const [first, ...narrowing] = ref.projections;
      result = this.findWithDescent(ref.source, first.pattern, first.prefix);
      for (const projection of narrowing) {
        result = result.then(files => this.findWithDescent(files, projection.pattern, projection.prefix));
      }
    }
    if (ref.miss) {
      /* A ref has a `miss` only where selecting nothing may be an error,
       * decided from the written name (see lookupSubstituted). It returns the
       * error once every source the name reached has reported selecting
       * nothing. */
      result = result.then(files => {
        const err = ref.miss!(!files.isEmpty());
        if (err !== undefined) {
          throw err;
        }
        return files;
      });
    }
    return result;
  }

  public applyProjections(sources: ReadonlyArray<Materialized>): Computable<Array<FileSource | FileSet>> {
    return Computable.forAll(
      sources.map(source => (source instanceof FileSetRef ? this.applyProjection(source) : Computable.resolve(source))),
      (...applied: Array<FileSource | FileSet>) => applied
    );
  }

  /**
   * Apply `projection` to `sources`, the sources one written name reached, and
   * return the projected sources, each kept separate:
   * - a {@link TargetRef}, {@link RepositoryRef} or {@link FileSetRef} has the
   *   projection added to it (`find`), applied once it is built or fetched;
   * - a {@link ResolvedNode} becomes, and a {@link ProjectedPackage} stays, a
   *   `ProjectedPackage` with the projection pending;
   * - a package or a runnable in hand becomes a {@link FileSetRef} with the
   *   projection pending;
   * - a {@link NamespaceRef} makes the member the pattern's first part names,
   *   and the rest is projected on that ({@link projectThrough});
   * - a {@link PartialRepositoryRef} is completed by the pattern into the
   *   reference its repository vends for the whole name, `repositoryName`
   *   being how the repository was written;
   * - any other source (a container) is projected now, descending into
   *   archives. A container that selects nothing is dropped, and where none
   *   selects anything one empty set is kept in their place.
   *
   * `miss` makes the error for a literal name that selects nothing. Each
   * target, node, package or runnable in hand and namespace member answers it
   * with its own share ({@link jointMiss}), the containers with one between
   * them, and the error is raised once every share has answered and none
   * selected anything. The result is a Computable where a container or a
   * namespace member must be waited on.
   */
  public projectSources(
    sources: Array<SourceRef | Unbuilt>,
    projection: IProjection,
    miss: Miss | undefined,
    repositoryName?: string
  ): Array<SourceRef | Unbuilt> | Computable<Array<SourceRef | Unbuilt>> {
    const { pattern, prefix } = projection;
    /* Each projected source, or a Computable of them where a namespace's member must be made first. */
    const references: Array<SourceRef | Unbuilt | Computable<Array<SourceRef | Unbuilt>>> = [];
    const containers: FileSource[] = [];
    const participant: () => Miss | undefined = miss === undefined ? () => undefined : jointMiss(miss);
    for (const source of sources) {
      if (source instanceof TargetRef) {
        /* Projected over what the target builds, which answers its share of the miss. */
        references.push(source.find(pattern, prefix, participant()));
      } else if (source instanceof ResolvedNode) {
        references.push(new ProjectedPackage(source, [projection], participant()));
      } else if (source instanceof ProjectedPackage) {
        references.push(new ProjectedPackage(source.base, [...source.projections, projection], participant()));
      } else if (source instanceof RepositoryRef || source instanceof FileSetRef) {
        references.push(source.find(pattern, prefix));
      } else if (source instanceof NamespaceRef) {
        references.push(this.projectThrough(source, projection, participant()));
      } else if (source instanceof PartialRepositoryRef) {
        /* The pattern, after the separator it was written with, completes the reference: the
         * repository vends the reference for the whole name, its requirement (`esbuild:0.28.1`)
         * and any projection into the package after it (`:package.json`, a rename riding on it).
         * Result names follow the projection, not the requirement. */
        references.push(source.getRepositoryRef(pattern, writtenSeparator(prefix), repositoryName));
      } else if (source instanceof PackageFileSet || source instanceof RunnableFileSet) {
        /* Pending as a FileSetRef keeps the package's identity, and the runnable's launch
         * descriptor (a runnable's projection selects an entry, not files). */
        references.push(new FileSetRef(source, [projection], participant()));
      } else {
        /* A container projects by its own `find`, which also applies a rename. */
        containers.push(source);
      }
    }
    if (containers.length === 0) {
      return references.some(reference => reference instanceof Computable)
        ? had(references)
        : (references as Array<SourceRef | Unbuilt>);
    }
    /* Each container is projected now and stays a separate source. They answer one share of the
     * miss together, below. The empty set kept where none selects anything is what the driver
     * reports as "matched no files". */
    const answer = participant();
    return Computable.forAll(
      containers.map(container => this.applyProjection(new FileSourceRef(container, [projection]))),
      (...projected: FileSet[]) => projected
    ).then(projected => {
      const matched = projected.filter(set => !set.isEmpty());
      const err = answer?.(matched.length > 0);
      if (err !== undefined) {
        throw err;
      }
      return had(references).then(held => [...held, ...(matched.length > 0 ? matched : [EMPTY_FILESET])]);
    });
  }

  /**
   * Project `projection` through the namespace `namespace` names: its
   * pattern's first part, up to its first `:` or `/`, names the member, and
   * the rest is projected on the member once it is made, after the separator
   * it was written with. A pattern naming the member alone is the member. An
   * empty first part, or a pattern that is no literal and names no member
   * before a separator, rejects with the namespace's refusal.
   */
  private projectThrough(
    namespace: NamespaceRef,
    projection: IProjection,
    miss: Miss | undefined
  ): Computable<Array<SourceRef | Unbuilt>> {
    const { pattern, prefix } = projection;
    const literal = pattern.getLiteralPrefix();
    const end = literal.search(/[:/]/);
    const first = end === -1 ? literal : literal.substring(0, end);
    if (first === "" || (end === -1 && literal !== pattern.toString())) {
      return Computable.reject(namespace.refused());
    }
    return namespace.get(first, writtenSeparator(prefix)).then(member => {
      if (end === -1) {
        return [member];
      }
      const rest = { pattern: pattern.substring(end + 1), prefix: literal[end] === "/" ? `${prefix}${first}/` : "" };
      return this.projectSources([member], rest, miss);
    });
  }

  /**
   * File a node for `name` in the target cache that runs `compute` when first
   * depended on, so that a request for `name` made while it is computed,
   * however indirectly, depends on that node (and a cycle through it is
   * found).
   */
  private answer(name: string, target: ITargetDecl | undefined, compute: () => Computable<SourceRef[]>): Computable<SourceRef[]> {
    const result = Computable.detached(compute).labelled(new NameLabel(name, target));
    this.targetCache.set(name, result);
    return result;
  }

  /** @return true if this is the configuration of exactly `constraints`, otherwise false. */
  public hasConstraints(constraints: Constraints): boolean {
    return this.constraints.equals(constraints);
  }

  public getRunContext(): BuildContextImpl {
    return this.getContextWithOverrides(this.runOverrides());
  }

  public getContextWithOverrides(overrides?: Constraints): BuildContextImpl {
    /* The model makes its configurations of this class and no other. */
    return this.model.getConfig(this.constraints.with(overrides), this.execution) as BuildContextImpl;
  }

  public runOverrides(extra?: Constraints): Constraints {
    const host = this.getConstraint(HOST);
    const measured = this.getConstraint(COVERAGE) !== undefined;
    return RUN_OVERRIDE.with(Constraints.of({ ...(measured ? { [COVERAGE]: "off" } : {}), ...(host ? { [TARGET]: host } : {}) })).with(
      extra
    );
  }

  public getConstraint(name: string): string | undefined {
    return this.constraints.get(name);
  }

  public getConstraints(): Constraints {
    return this.constraints;
  }

  public inConfiguration(constraints: Constraints): BuildContextImpl {
    return this.model.getConfig(constraints, this.execution) as BuildContextImpl;
  }

  public getTargetOperations(name: string): string[] {
    const decl = this.lookupDecl(name);
    return decl?.kind === DeclKind.Target ? this.model.getOperations(decl.type) : [];
  }

  public substituteName(value: INameValue, stack?: IDependencyStack): Computable<Name> {
    return this.inFile(value.source.file).substituteNameVars(value.value, stack);
  }

  /** Look up the declaration of `name` in the scope this configuration's names are looked up in. */
  public lookupDecl(name: string): IPropertyEntry | ITargetDecl | undefined {
    return this.model.getDecl(name);
  }

  /** Make the context the declared target `target` is evaluated in. */
  protected targetContextFor(target: ITargetDecl, stack?: IDependencyStack): DeclaredTargetContext {
    return new DeclaredTargetContext(target, this.targetDefOf(target.type), this, stack);
  }

  /** @return true if each key of `guard` has a value its pattern matches, otherwise false. */
  private guardAdmits(guard: readonly NameConstraint[] | undefined, stack?: IDependencyStack): Computable<boolean> {
    if (!guard) {
      return Computable.resolve(true);
    }
    return Computable.forAll(
      guard.map(([key, pattern]) => this.getProperty(key, stack).then(value => this.patternAdmits(pattern, value, stack))),
      (...admitted: boolean[]) => admitted.every(match => match)
    );
  }

  /** @return true if a guard's `pattern`, substituted, matches the property
   * `value` it is written against, otherwise false. */
  private patternAdmits(pattern: Name, value: Property, stack?: IDependencyStack): Computable<boolean> {
    return this.substituteNameVars(pattern, stack).then(substituted => globMatcher(substituted.toGlobString())(value.toString()));
  }

  /** Select the rule that builds `target`, a target of `type`, in this
   * configuration: see {@link selectRule}. */
  private selectRule(type: string, target: TargetContext): Computable<IRuleSelection> {
    /* Read where the target is evaluated: a private target's names are not its file's. */
    const config = target.getDeclaredContext().configurationOf(this.constraints) as BuildContextImpl;
    return selectRule(this.model.getTargetRules(type), this.model.getDefaultRules(), target, {
      read: (key, stack) => config.getOptionalProperty(key, stack),
      admits: (pattern, value, stack) => config.patternAdmits(pattern, value, stack),
    });
  }

  public getAvailableDecls(
    entry: IPropertyEntry | undefined,
    stack?: IDependencyStack,
    owner?: ITargetDecl
  ): Computable<IPropertyDecl[]> {
    if (!entry) {
      return Computable.resolve([]);
    }
    const { decls, defaults } = entry;
    const candidates = [...decls, ...defaults];
    if (!candidates.some(candidate => candidate.name.hasConstraints())) {
      /* With no guard, every declaration applies: the ordinary ones where
       * there are any, else the defaults. No property is read. */
      return Computable.resolve(decls.length > 0 ? decls : defaults);
    }
    /* The guards are read with the property on the stack (its first
     * declaration's key as the use site, `owner` as its target), so what a
     * guard reads is attributed to the property. */
    const guarded = candidates[0];
    const frame: IUseFrame = {
      property: guarded,
      target: owner,
      value: {
        kind: DeclKind.NameValue,
        source: guarded.source,
        offset: guarded.offset,
        endOffset: guarded.endOffset ?? guarded.offset,
        value: guarded.name,
      },
      next: stack,
    };
    try {
      return Computable.forAll(
        candidates.map(candidate => this.inFile(candidate.source.file).guardAdmits(candidate.name.getConstraints(), frame)),
        (...admitted: boolean[]) => {
          /* The ordinary declarations that apply, else the `default` ones that do. */
          const matched = candidates.filter((_, i) => admitted[i]);
          const ordinary = matched.filter(candidate => decls.includes(candidate));
          return ordinary.length > 0 ? ordinary : matched;
        }
      ).labelled(new ReferenceLabel({ value: frame.value, property: guarded, target: owner }));
    } catch (err) {
      /* A guard reading an unknown property throws as its read is made, not
       * when it settles. */
      return Computable.reject(toError(err));
    }
  }

  /**
   * Make the unresolved-name error for `name`: positioned at the referencing
   * value where the stack has a use frame (a name written in a build file),
   * else a plain message (a command-line name), with `hints` as its `help:`
   * line.
   */
  private unresolvedNameError(name: string, stack: IDependencyStack | undefined, reason: string, hints: string[]): Error {
    const frame = useFrameOf(stack);
    const err = frame
      ? new NameResolutionError(Name.fromLiteral(name), declPosn(frame.value), useSiteOf(frame), reason)
      : new FabrError(reason);
    return withHints(err, hints);
  }

  /**
   * Get the help for a name nothing declares: the files that declare it
   * privately, else the declared target or property nearest to the part
   * before any `:` projection. A name written on the command line also gets a
   * pointer to `fabr list-targets`.
   */
  private unknownNameHints(written: string, onCommandLine: boolean): string[] {
    const files = this.model.getPrivateFiles(written.split(":")[0]);
    if (files.length > 0) {
      return [`'${written.split(":")[0]}' is private to ${files.join(", ")}`];
    }
    const nearest = closestMatch(written.split(":")[0], [
      ...this.model.getTargets().map(target => target.name),
      ...this.model.getProperties().map(prop => prop.name),
    ]);
    const listing = "'fabr list-targets' shows the available targets";
    if (nearest) {
      return [onCommandLine ? `did you mean '${nearest}'? (${listing})` : `did you mean '${nearest}'?`];
    }
    return onCommandLine ? [listing] : [];
  }

  public getProperty(name: string, stack?: IDependencyStack, callerOverrides?: Constraints): Computable<Property> {
    if (callerOverrides) {
      /* A caller's override outranks a `<k=v>` written on the property's value
       * (ambient < the value's requirement < caller), so for a declared property it
       * is passed to the value's lookup, not merged into this configuration. Any
       * other name is read in the overridden configuration. Not cached. */
      if (!this.constrains(name)) {
        const def = this.lookupDecl(name);
        if (def?.kind === DeclKind.Property) {
          return this.getContextWithOverrides(callerOverrides)
            .getAvailableDecls(def, stack)
            .then(applicable =>
              this.lookupStringProperty(unmatchedIfAbsent(soleDecl(applicable), name, def), undefined, stack, callerOverrides)
            );
        }
      }
      return this.getContextWithOverrides(callerOverrides).getProperty(name, stack);
    }
    const def = this.lookupDecl(name);
    const entry = def?.kind === DeclKind.Property ? def : undefined;
    if (!entry && !this.constrains(name)) {
      const reason = def
        ? `'${name}' names a ${def.kind === DeclKind.Target ? "target" : "namespace"}, not a property`
        : `Unknown property '${name}'`;
      const nearest = def
        ? undefined
        : closestMatch(
            name,
            this.model.getProperties().map(prop => prop.name)
          );
      throw this.unresolvedNameError(name, stack, reason, nearest ? [`did you mean '${nearest}'?`] : []);
    }
    return this.getOptionalProperty(name, stack).then(value => {
      if (value === undefined) {
        /* Only a declared property can be without a value: a name a constraint
         * supplies always has one. */
        throw entry ? unmatchedError(name, entry) : new FabrError(`'${name}' has no value`);
      }
      return value;
    });
  }

  /**
   * Get the property `name` as {@link getProperty} does, but undefined where it
   * has no value in this configuration: nothing declares it as a property (and
   * no constraint supplies it), or no declaration of it applies here.
   */
  public getOptionalProperty(name: string, stack?: IDependencyStack): Computable<Property | undefined> {
    const cached = this.propCache.get(name);
    if (cached) {
      return cached;
    }
    if (this.constrains(name)) {
      const supplied = Computable.resolve<Property | undefined>(new Property([this.constraints.get(name)!]));
      this.propCache.set(name, supplied);
      return supplied;
    }
    const def = this.lookupDecl(name);
    if (def?.kind !== DeclKind.Property) {
      return Computable.resolve(undefined);
    }
    const result = Computable.detached<Property | undefined>(() =>
      this.getAvailableDecls(def, stack).then(applicable => {
        const decl = soleDecl(applicable);
        return decl ? this.lookupStringProperty(decl, undefined, stack) : undefined;
      })
    ).labelled(new NameLabel(name));
    this.propCache.set(name, result);
    return result;
  }

  public resolveTarget(name: string, stack?: IDependencyStack, callerOverrides?: Constraints): Computable<SourceRef[]> {
    if (callerOverrides) {
      /* A caller's override outranks a `<k=v>` written on a property's value
       * (ambient < the value's requirement < caller, see lookupContextFor), so
       * for a property it is passed to the value's lookup, not merged into this
       * configuration, and the result is not cached. A name the constraints
       * supply, and a target, are resolved and cached by the overridden
       * configuration. */
      const def = this.lookupDecl(name);
      if (!this.constrains(name) && def?.kind === DeclKind.Property) {
        /* A fallback target has no written value for the override to outrank. */
        return this.resolveProperty(
          name,
          def,
          stack,
          () => this.getContextWithOverrides(callerOverrides).resolveTarget(name, stack),
          callerOverrides
        );
      }
      return this.getContextWithOverrides(callerOverrides).resolveTarget(name, stack);
    }
    const cached = this.targetCache.get(name);
    if (cached) {
      return cached;
    } else if (this.constrains(name)) {
      /* A constraint given for the name replaces its declaration here too, as
       * for its string value (getOptionalProperty): the value is parsed as a
       * whole reference and looked up, so `-Dchai=@npm:chai:5.0.0` replaces a
       * dependency written as `chai`, and a `:` projection or `<k=v>` in the
       * value applies. */
      return this.answer(name, undefined, () => this.lookupFileValue(parseName(this.constraints.get(name)!), stack));
    } else {
      const def = this.lookupDecl(name);
      if (def?.kind === DeclKind.Target) {
        return this.answer(name, def, () => this.resolveTargetDecl(def, stack));
      } else if (def?.kind === DeclKind.Property) {
        return this.answer(name, undefined, () =>
          this.resolveProperty(name, def, stack, target => this.resolveTargetDecl(target, stack))
        );
      } else {
        const hints: string[] = [];
        hints.push(...this.unknownNameHints(name, !useFrameOf(stack)));
        throw this.unresolvedNameError(name, stack, `Unknown name '${name}'`, hints);
      }
    }
  }

  /**
   * Resolve the property `name` (the entry `def`) to the sources its
   * applicable declarations name, read under `callerOverrides`; where none
   * applies and it has a `default` target, to what `fallback` resolves that
   * target to.
   */
  private resolveProperty(
    name: string,
    def: IPropertyEntry,
    stack: IDependencyStack | undefined,
    fallback: (target: ITargetDecl) => Computable<SourceRef[]>,
    callerOverrides?: Constraints
  ): Computable<SourceRef[]> {
    return this.getContextWithOverrides(callerOverrides)
      .getAvailableDecls(def, stack)
      .then(applicable => {
        const merged = mergedDecls(applicable);
        if (merged === undefined && def.fallbackTarget !== undefined) {
          return fallback(def.fallbackTarget);
        }
        return this.lookupFileProperty(unmatchedIfAbsent(merged, name, def), undefined, stack, callerOverrides);
      });
  }

  public getPrefixTargetIfExists(
    name: Name,
    stack?: IDependencyStack
  ): { target: Computable<SourceRef[]>; rest: Name; name: string; retainedPrefix: string } | undefined {
    const result = this.model.getPrefixMatch(name);
    if (result) {
      return {
        target: this.resolveTarget(result.name, stack),
        rest: result.rest,
        name: result.name,
        retainedPrefix: result.retainedPrefix,
      };
    }
    /* A name nothing declares, which this configuration was given a value
     * for: it names what the value names. */
    const written = name.toString();
    if (this.constrains(written)) {
      return { target: this.resolveTarget(written, stack), rest: Name.fromLiteral(""), name: written, retainedPrefix: "" };
    }
    return undefined;
  }

  public getCachedOrBuild(
    manifest: string,
    create: (ctx: ActionContext) => Computable<BuildResult>,
    options?: ICreateOptions
  ): Computable<FileSet> {
    return this.execution.buildCache.getOrCreate(manifest, create, { processLimit: this.execution.processLimit, ...options });
  }

  /**
   * Look up each of `prop`'s values with `tail` ({@link lookupStringValue} or
   * {@link lookupFileValue}), handing it the value's use frame. A value that is
   * not a name (a map block or a command pipeline) is refused with a message
   * naming the use `expects` ("a string", "files"). This is the only check of
   * that for `default` and global properties and sync coordinates, which
   * Validate does not see.
   */
  private lookupValues<T>(
    prop: IPropertyDecl,
    target: ITargetDecl | undefined,
    stack: IDependencyStack | undefined,
    expects: string,
    tail: (value: INameValue, info: IDependencyStack) => Computable<T>
  ): Computable<T[]> {
    return Computable.forAll(
      prop.values.map(value =>
        isNameValue(value)
          ? tail(value, { property: prop, target, value, next: stack }).labelled(new ReferenceLabel({ value, property: prop, target }))
          : Computable.reject<T>(nonNameValueError(prop, value, expects))
      ),
      (...resolved: T[]) => resolved
    );
  }

  public lookupNameProperty(
    prop: IPropertyDecl,
    target?: ITargetDecl,
    stack?: IDependencyStack,
    callerOverrides?: Constraints
  ): Computable<Name[]> {
    return this.lookupValues(prop, target, stack, "a string", (value, info) => this.lookupStringValue(value, info, callerOverrides));
  }

  /**
   * Look up one written value in a STRING context as its substituted Name. No
   * reference is resolved and no provenance is stamped. A caller override
   * applies; a `<k=v>` written on the value is part of its text, not a
   * requirement. The Name keeps its rename facet, for REWRITE and projection
   * readers.
   */
  private lookupStringValue(value: INameValue, info: IDependencyStack, callerOverrides?: Constraints): Computable<Name> {
    return this.getContextWithOverrides(callerOverrides)
      .inFile(value.source.file)
      .substituteNameVars(value.value, info, callerOverrides);
  }

  public lookupStringProperty(
    prop: IPropertyDecl,
    target?: ITargetDecl,
    stack?: IDependencyStack,
    callerOverrides?: Constraints
  ): Computable<Property> {
    return this.lookupNameProperty(prop, target, stack, callerOverrides).then(
      names =>
        new Property(
          names.map(name => name.toString()),
          prop
        )
    );
  }

  public lookupMap(
    prop: IPropertyDecl,
    target?: ITargetDecl,
    stack?: IDependencyStack,
    callerOverrides?: Constraints
  ): Computable<PropertyMap> {
    return this.lookupMapDecl(prop, target, stack, new Set(), callerOverrides);
  }

  public lookupGlobalMap(name: string, stack?: IDependencyStack, callerOverrides?: Constraints): Computable<PropertyMap> {
    return this.lookupMapReference(Name.fromLiteral(name), stack, stack, new Set(), callerOverrides);
  }

  /** Look up the MAP property `prop` as {@link lookupMap} does, `seen` holding
   * the properties already on the chain of map references. */
  private lookupMapDecl(
    prop: IPropertyDecl,
    target: ITargetDecl | undefined,
    stack: IDependencyStack | undefined,
    seen: Set<IPropertyDecl>,
    callerOverrides?: Constraints
  ): Computable<PropertyMap> {
    if (seen.has(prop)) {
      return Computable.reject(new FabrError(`Circular map reference at '${prop.name}'`));
    }
    const nextSeen = new Set(seen).add(prop);
    if (hasMapValue(prop)) {
      /* One `{ … }` block. Validate checks this for a target's property; a
       * global is checked only here. */
      if (prop.values.length > 1) {
        return Computable.reject(new FabrError(`'${prop.name}' must be a single \`{ ... }\` block or bare reference(s), not a mix`));
      }
      const block = prop.values[0];
      return this.lookupMapBlock(isMapValue(block) ? block.entries : [], target, stack, nextSeen, callerOverrides);
    }
    /* References: each value names a block-valued property, looked up in this
     * configuration (so a shared map's `${...}` reads the consumer's), and the
     * maps are merged in written order, a later entry replacing an earlier one.
     * Each merged entry's origin records the written reference it came through. */
    return Computable.forAll(
      prop.values.filter(isNameValue).map(value =>
        this.inFile(value.source.file)
          .lookupMapReference(value.value, { property: prop, target, value, next: stack }, stack, nextSeen, callerOverrides)
          .then((map): [PropertyMap, INameValue] => [map, value])
      ),
      (...maps: [PropertyMap, INameValue][]) => {
        const merged: PropertyMap = new Map();
        for (const [map, value] of maps) {
          mergeMapInto(merged, map, value);
        }
        return merged;
      }
    );
  }

  /** Chase a map reference (a top-level bare value or an in-block splice) to
   * the named block-valued property and look it up, `seen`-guarded. */
  private lookupMapReference(
    name: Name,
    info: IDependencyStack | undefined,
    stack: IDependencyStack | undefined,
    seen: Set<IPropertyDecl>,
    callerOverrides?: Constraints
  ): Computable<PropertyMap> {
    return this.referencedProperty(name, info).then(({ prop, property, name: substituted, context }) => {
      if (!prop) {
        /* A property nothing sets here is an empty map. */
        if (property) {
          return new Map();
        }
        throw new FabrError(`'${substituted.toString()}' does not name a map property`);
      }
      return context.lookupMapDecl(prop, undefined, stack, seen, callerOverrides);
    });
  }

  /** Look up one block's items in written order: a `key = value;` entry sets its
   * key (strings to their word list; a nested block to a sub-map, several to a
   * list of sub-maps; strings and blocks mixed are an error, which Validate
   * checks only for a target's property); a `NAME;` splice merges the named
   * map's entries in at that position. A later value replaces an earlier one.
   * Each entry records its origin ({@link recordMapOrigin}): the written entry,
   * and the splices it came through. */
  private lookupMapBlock(
    entries: IMapItemDecl[],
    target: ITargetDecl | undefined,
    stack: IDependencyStack | undefined,
    seen: Set<IPropertyDecl>,
    callerOverrides?: Constraints
  ): Computable<PropertyMap> {
    return Computable.forAll(
      entries.map((item): Computable<PropertyMapValue | PropertyMap> => {
        if (item.kind === DeclKind.Splice) {
          return this.inFile(item.source.file).lookupMapReference(item.ref, stack, stack, seen, callerOverrides);
        }
        const blocks = item.values.filter(isMapValue);
        if (blocks.length === 0) {
          /* A scalar entry keeps its value list (like any property), so a consumer
           * can serialize it as an array or join it per its own schema. */
          return this.lookupStringProperty(item, target, stack, callerOverrides).then(prop => prop.getValues());
        }
        if (blocks.length < item.values.length) {
          return Computable.reject(new FabrError(`map value '${item.name}' is either strings or maps, not a mix`));
        }
        return Computable.forAll(
          blocks.map(value => this.lookupMapBlock(value.entries, target, stack, seen, callerOverrides)),
          (...maps: PropertyMap[]) => (maps.length === 1 ? maps[0] : maps)
        );
      }),
      (...resolved: (PropertyMapValue | PropertyMap)[]) => {
        const map: PropertyMap = new Map();
        entries.forEach((item, i) => {
          if (item.kind === DeclKind.Splice) {
            mergeMapInto(map, resolved[i] as PropertyMap, item);
          } else {
            map.set(item.name.toBaseString(), resolved[i] as PropertyMapValue);
            recordMapOrigin(map, item.name.toBaseString(), { entry: item, via: [] });
          }
        });
        return map;
      }
    );
  }

  public lookupSplice(splice: ISpliceDecl, stack?: IDependencyStack): Computable<ISplicedEntry[]> {
    return this.inFile(splice.source.file).splicedEntries(splice.ref, stack, new Set());
  }

  /** Look up the entries of the map property `name` names, as declarations, chasing references to other maps `seen`-guarded. */
  private splicedEntries(name: Name, stack: IDependencyStack | undefined, seen: Set<IPropertyDecl>): Computable<ISplicedEntry[]> {
    return this.referencedProperty(name, stack).then(({ prop, property, name: substituted, context }) => {
      if (!prop) {
        /* A property nothing sets here supplies nothing. */
        if (property) {
          return [];
        }
        throw new FabrError(`'${substituted.toString()}' does not name a map property, so it cannot be spliced`);
      }
      return context.mapEntries(prop, stack, seen);
    });
  }

  /** Look up the entries of the MAP property `prop` as declarations, in written order (see {@link lookupMapDecl}). */
  private mapEntries(prop: IPropertyDecl, stack: IDependencyStack | undefined, seen: Set<IPropertyDecl>): Computable<ISplicedEntry[]> {
    if (seen.has(prop)) {
      return Computable.reject(new FabrError(`Circular map reference at '${prop.name}'`));
    }
    const nextSeen = new Set(seen).add(prop);
    const flat = (lists: ISplicedEntry[][]): ISplicedEntry[] => lists.flat();
    if (hasMapValue(prop)) {
      if (prop.values.length > 1) {
        return Computable.reject(new FabrError(`'${prop.name}' must be a single \`{ ... }\` block or bare reference(s), not a mix`));
      }
      const block = prop.values[0];
      return Computable.forAll(
        (isMapValue(block) ? block.entries : []).map(item =>
          item.kind === DeclKind.Splice
            ? this.inFile(item.source.file).splicedEntries(item.ref, stack, nextSeen)
            : Computable.resolve([{ decl: item, context: this }])
        ),
        (...lists: ISplicedEntry[][]) => flat(lists)
      );
    }
    return Computable.forAll(
      prop.values
        .filter(isNameValue)
        .map(value => this.inFile(value.source.file).splicedEntries(value.value, { property: prop, value, next: stack }, nextSeen)),
      (...lists: ISplicedEntry[][]) => flat(lists)
    );
  }

  public lookupWildcardProperties(
    props: IPropertyDecl[],
    stack?: IDependencyStack,
    callerOverrides?: Constraints
  ): Computable<{ key: Name; decl: IPropertyDecl }[]> {
    const context = this.getContextWithOverrides(callerOverrides);
    return Computable.forAll(
      props.map(prop => context.inFile(prop.source.file).guardAdmits(prop.name.getConstraints(), stack)),
      (...admitted: boolean[]) => props.filter((_, i) => admitted[i])
    ).then(members =>
      Computable.forAll(
        members.map(prop => context.inFile(prop.source.file).substituteNameVars(prop.name.withConstraints([]), stack)),
        (...keys: Name[]) => keys.map((key, i) => ({ key, decl: members[i] }))
      )
    );
  }

  public lookupProjection(
    prop: IPropertyDecl,
    target?: ITargetDecl,
    stack?: IDependencyStack,
    callerOverrides?: Constraints
  ): Computable<Name | undefined> {
    return this.lookupNameProperty(prop, target, stack, callerOverrides).then(names => {
      if (names.length > 1) {
        throw new FabrError(`property '${prop.name}' is a projection and takes a single value (found ${names.length})`);
      }
      return names[0];
    });
  }

  public lookupFileProperty(
    prop: IPropertyDecl,
    target?: ITargetDecl,
    stack?: IDependencyStack,
    callerOverrides?: Constraints
  ): Computable<SourceRef[]> {
    return this.lookupValues(prop, target, stack, "files", (value, info) =>
      this.lookupFileValue(value.value, info, { callerOverrides, provenance: { value, property: prop, target } })
    ).then(lists => lists.flat());
  }

  public lookupFileValue(
    name: Name,
    stack: IDependencyStack | undefined,
    options?: {
      callerOverrides?: Constraints;
      relativeTo?: IDecl;
      provenance?: { value: INameValue; property: IPropertyDecl; target?: ITargetDecl };
    }
  ): Computable<SourceRef[]> {
    const provenance = options?.provenance;
    /* A bare path is rooted at the property's declaration, unless `relativeTo`
     * says otherwise (a stdin redirect). */
    const relativeTo = options?.relativeTo ?? provenance?.property;
    /* Judged on the name as written: a `${NAME}` or a `` `cmd` `` part makes
     * it no literal target name, whatever text it substitutes to. */
    const substituted = name.getSubstitutions().length > 0;
    /* A value written as `ref<k=v>` is looked up in this configuration with its
     * requirement applied, so the target it names builds under those
     * constraints and the model step (made by that configuration) records them. */
    return this.inFile(relativeTo?.source.file)
      .lookupContextFor(name, options?.callerOverrides, stack)
      .then(({ context, reference, substitutions }) => {
        const resolved = context.lookupFileSource(reference, relativeTo, stack, substituted);
        if (!provenance) {
          return resolved;
        }
        const { value, property, target } = provenance;
        /* A failure looking the value up is the reference's. A target's own
         * failure becomes the reference's when the target is built, through the
         * step stamped on it. */
        const step = context.modelStep(value, property, target, substitutions);
        return resolved
          .then(sources => sources.map(source => context.withModelStep(source, step)))
          .catch((err: Error): never => {
            throw failureOfReference(step, err);
          });
      });
  }

  /**
   * Get the configuration a reference is looked up in, the reference fully
   * substituted with its `<k=v>` stripped, and the substitutions made.
   * Constraints apply lowest to highest as this configuration's, the
   * reference's own `<k=v>`, then `callerOverrides`, so a caller's override (a
   * rule forcing `BUILD_OPERATION=run` on a tool) wins over a requirement on
   * the same key.
   */
  private lookupContextFor(
    name: Name,
    callerOverrides?: Constraints,
    stack?: IDependencyStack
  ): Computable<{ context: BuildContextImpl; reference: Name; substitutions: ISubstitution[] }> {
    return this.substituteTraced(name, stack).then(({ name: substituted, substitutions }) => {
      if (!substituted.hasConstraints()) {
        return { context: this.getContextWithOverrides(callerOverrides), reference: substituted, substitutions };
      }
      /* Caller override last, so it wins on a shared key. */
      const merged = constraintsOf(substituted.getConstraints()).with(callerOverrides);
      return { context: this.getContextWithOverrides(merged), reference: substituted.withConstraints([]), substitutions };
    });
  }

  public modelStep(
    value: INameValue,
    property: IPropertyDecl,
    target?: ITargetDecl,
    substitutions?: readonly ISubstitution[]
  ): IModelStep {
    return {
      kind: MODEL_PROVENANCE,
      value,
      constraints: this.constraints,
      property,
      target,
      ...(substitutions !== undefined && substitutions.length > 0 ? { substitutions } : {}),
    };
  }

  /** Stamp `step`, the written reference `source` was found by, on it. */
  private withModelStep(source: SourceRef, step: IModelStep): SourceRef {
    if (source instanceof FileSet || source instanceof Reference) {
      return source.withStep(step);
    }
    return source;
  }

  public materialize(ref: INameValue, stack?: IDependencyStack): Computable<Array<FileSource | IncompleteRef>> {
    return this.materializeWith(ref, stack, (context, sources, options) =>
      materializeShallow(context, sources, options).then(materialized => ({ materialized, failures: [] }))
    ).then(({ sources }) => sources);
  }

  public materializeEach(ref: INameValue): Computable<{ sources: Array<FileSource | IncompleteRef>; failures: Error[] }> {
    return this.materializeWith(ref, undefined, materializeShallowEach);
  }

  /** Materialize what `ref` names with `shallow`, for {@link materialize} and
   * {@link materializeEach}. */
  private materializeWith(
    ref: INameValue,
    stack: IDependencyStack | undefined,
    shallow: typeof materializeShallowEach
  ): Computable<{ sources: Array<FileSource | IncompleteRef>; failures: Error[] }> {
    /* Under `run` the name is a program, whose closure is collected permissively. */
    const options = this.constraints.get(BUILD_OPERATION) === "run" ? PERMISSIVE_RESOLUTION : undefined;
    return this.lookupFileValue(ref.value, stack, { relativeTo: ref }).then(found => {
      const sources = found.map(versionsOf);
      const incomplete = sources.filter(isIncompleteRef);
      return shallow(
        this.resolutionContext(),
        sources.filter(source => !isIncompleteRef(source)),
        options
      ).then(({ materialized, failures }) =>
        this.applyProjections(materialized).then(content => ({
          sources: [...content, ...incomplete] as Array<FileSource | IncompleteRef>,
          failures,
        }))
      );
    });
  }

  /** Look up the sources `name` names, after substituting it. A name ending
   * in `?` or `!` whose rest is a declared target's name is a reference to the
   * target with that marker, unless `substituted` says the written name made
   * substitutions. */
  private lookupFileSource(
    name: Name,
    relativeTo: IDecl | undefined,
    stack?: IDependencyStack,
    substituted = false
  ): Computable<SourceRef[]> {
    return this.substituteNameVars(name, stack).then((substName): SourceRef[] | Computable<SourceRef[]> => {
      /* `foo?` / `foo!`, `foo` a declared target: a marker on the reference
       * to it, for the collection it is written in. Where `foo` resolves to
       * anything but references to targets (a flag), the name is looked up as
       * written. */
      const marked = substituted ? undefined : this.markedTarget(substName);
      if (marked !== undefined) {
        const found = this.lookupSubstituted(marked.unmarked, relativeTo, stack);
        return (found instanceof Computable ? found : Computable.resolve(found)).then(
          (sources): SourceRef[] | Computable<SourceRef[]> =>
            sources.length > 0 && sources.every(source => source instanceof TargetRef)
              ? sources.map(source => (source as TargetRef).marked(marked.override))
              : this.lookupSubstituted(substName, relativeTo, stack)
        );
      }
      return this.lookupSubstituted(substName, relativeTo, stack);
    });
  }

  /**
   * Look up the sources `substName` names, its substitutions already made:
   * - where a declared name, or a name the constraints give a value, is a
   *   prefix of it ({@link getPrefixTargetIfExists}), what that name resolves
   *   to, renamed by a `-> name` written on the whole reference, or with the
   *   rest of the name projected over it ({@link projectSources});
   * - otherwise, where it is written in a build file (`relativeTo`), the files
   *   it selects relative to that file's directory, as one set;
   * - otherwise (a constraint's value, which has nothing to root a path at),
   *   it throws `Unknown name`.
   *
   * A literal name written in a build file that selects nothing is an error:
   * a {@link NameResolutionError}, or `Unknown name` with suggestions where no
   * use frame is on the stack (a name on the command line). A name with a glob
   * that selects nothing is no error.
   */
  private lookupSubstituted(
    substName: Name,
    relativeTo: IDecl | undefined,
    stack?: IDependencyStack
  ): SourceRef[] | Computable<SourceRef[]> {
    if (substName.isEmpty()) {
      return [];
    }
    const targetDep = this.getPrefixTargetIfExists(substName, stack);
    if (targetDep) {
      const { target, rest, name: matchedName, retainedPrefix } = targetDep;
      if (rest.isEmpty()) {
        /* With nothing to project, a `-> name` renames what the name resolves
         * to, as it renames a registry's package ({@link renamedAs}). */
        const renameTo = substName.getRenameTo()?.toString();
        return target.then(sources =>
          renameTo === undefined ? sources : sources.map(source => renamedAs(source, renameTo, substName.toString()))
        );
      } else {
        /* `rest`, the name after the declared prefix, is projected over what
         * the prefix resolves to. A rename (`sel -> tmpl`) rides on `rest`
         * (Name.substring keeps it) and is applied by `find`, its names taking
         * the place of `retainedPrefix`. A slash-form reference keeps the
         * written prefix in result names, a colon-form one does not. */
        const project = (
          t: Array<SourceRef | Unbuilt>,
          miss: Miss | undefined
        ): Array<SourceRef | Unbuilt> | Computable<Array<SourceRef | Unbuilt>> =>
          this.projectSources(t, { pattern: rest, prefix: retainedPrefix }, miss, matchedName);
        /* Selecting nothing is an error only for a name with a declaration
         * to report at (`relativeTo`; otherwise the driver reports "matched
         * no files"), and only where the whole of `substName` is literal, not
         * just `rest`: after a glob, the projection applies to whatever the
         * glob matched, and finding nothing there is no error. */
        const miss: Miss | undefined =
          relativeTo && !substName.hasGlob()
            ? selected =>
                selected
                  ? undefined
                  : new NameResolutionError(substName, declPosn(useFrameOf(stack)?.value ?? relativeTo), useSiteOf(stack))
            : undefined;
        return target.then(reached => project(reached, miss) as SourceRef[] | Computable<SourceRef[]>);
      }
    } else if (relativeTo) {
      /* A path relative to the build file's directory, projected now over the
       * source the file was read through: the project's tree, or for a
       * plugin's lib file its package's files. `Name.relativeTo` adds the directory as a `:`
       * prefix, which `find` strips, so a result keeps the name as written:
       * `./astro.config.mjs` in `docs/BUILD.fabr` is the file
       * `astro.config.mjs`. A leading `../` is dropped by FileSet's name
       * canonicalization (`../scripts/gendoc.ts` is `scripts/gendoc.ts`), so
       * two files that flatten to one name conflict. */
      /* A literal naming neither a declaration nor a file: a failed lookup of
       * the value in a build file, or `Unknown name` with suggestions on the
       * command line (no use frame), as in resolveTarget. */
      const miss: Miss | undefined = substName.hasGlob()
        ? undefined
        : selected => {
            if (selected) {
              return undefined;
            }
            const written = substName.toString();
            const frame = useFrameOf(stack);
            const reason = frame ? undefined : `Unknown name '${written}'`;
            return withHints(
              new NameResolutionError(substName, declPosn(frame?.value ?? relativeTo), useSiteOf(stack), reason),
              this.unknownNameHints(written, !frame)
            );
          };
      /* An absolute path names no target: written `/x` anywhere (on the Windows
       * command line, `\\server\share` too, read as `//server/share`), or
       * `C:\x` on the command line on Windows (read as `C:/x`). */
      const onCommandLine = relativeTo.source.file.split(NAME_COMPONENT_SEPARATOR).at(-1) === COMMAND_LINE_FILE;
      const windowsPath = onCommandLine && process.platform === "win32" && WINDOWS_ABSOLUTE.test(substName.toString());
      if (isAbsoluteName(substName) || windowsPath) {
        throw new NameResolutionError(
          substName,
          declPosn(useFrameOf(stack)?.value ?? relativeTo),
          useSiteOf(stack),
          `'${substName.toString()}' is an absolute path, which names no target`
        );
      }
      const pattern = substName.relativeTo(relativeTo.source.file);
      return this.applyProjection(new FileSourceRef(relativeTo.source.fs, [{ pattern, prefix: "" }], miss)).then(data => [data]);
    } else {
      /* A constraint's value (see resolveTarget), from `-D` or a `<k=v>`,
       * carries no declaration to root a path at: only a declared name
       * answers it. */
      const written = substName.toString();
      throw this.unresolvedNameError(written, undefined, `Unknown name '${written}'`, this.unknownNameHints(written, true));
    }
  }

  /** Substitute every `${NAME}` and command in `name`. `callerOverrides` is the
   * reader's override, applied over a `${NAME<k=v>}`'s requirement. */
  private substituteNameVars(name: Name, stack?: IDependencyStack, callerOverrides?: Constraints): Computable<Name> {
    return this.substituteTraced(name, stack, callerOverrides).then(({ name: substituted }) => substituted);
  }

  /** Substitute `name` as {@link substituteNameVars} does, also answering what
   * each `${NAME}` gave and where that came from. */
  private substituteTraced(
    name: Name,
    stack?: IDependencyStack,
    callerOverrides?: Constraints
  ): Computable<{ name: Name; substitutions: ISubstitution[] }> {
    const parts = name.getSubstitutions();
    if (parts.length === 0) {
      return Computable.resolve({ name, substitutions: [] });
    }
    return Computable.forAll(
      parts.map(part => this.substitutedText(part, stack, callerOverrides)),
      (...texts: Array<{ text: string; substitution?: ISubstitution }>) => ({
        name: name.substitute(new Map(parts.map((part, i) => [part, texts[i].text]))),
        substitutions: texts.flatMap(({ substitution }) => (substitution === undefined ? [] : [substitution])),
      })
    );
  }

  /** Get one substituted part's text, with what it substituted: a property's
   * value (with its pattern edit applied), or a command's stdout. Two
   * identically-written commands are one action to the build cache, so run
   * once. */
  private substitutedText(
    part: NamePart,
    stack?: IDependencyStack,
    callerOverrides?: Constraints
  ): Computable<{ text: string; substitution?: ISubstitution }> {
    if (part.kind === NamePartKind.CommandSubst) {
      return this.runCommandSubst(part, stack).then(text => ({ text }));
    }
    const edit = part.edit;
    const read = (context: BuildContextImpl): Computable<{ text: string; substitution?: ISubstitution }> =>
      context.getProperty(part.value, stack, part.constraints === undefined ? undefined : callerOverrides).then(prop => {
        const text = edit === undefined ? prop.toString() : applyPatternEdit(prop.toString(), edit);
        return { text, substitution: { name: part.value, value: text, origin: prop.origin } };
      });
    if (part.constraints === undefined) {
      return read(this);
    }
    /* `${NAME<k=v>}`: NAME is read under the requirement, whose values are
     * substituted here first. */
    const constraints = part.constraints;
    return Computable.forAll(
      constraints.map(([, value]) => this.substituteNameVars(value, stack, callerOverrides)),
      (...values: Name[]) => constraintsOf(constraints.map(([key], i): NameConstraint => [key, values[i]]))
    ).then(required => read(this.getContextWithOverrides(required)));
  }

  /**
   * Run one `` `cmd` `` substitution and return the text it produced: look up
   * the pipeline the parser attached and run it for its output
   * ({@link runResolvedCommand}).
   */
  private runCommandSubst(part: NamePart, stack?: IDependencyStack): Computable<string> {
    const pipeline = part.command;
    if (pipeline === undefined || pipeline.length === 0) {
      return Computable.reject(new FabrError(`Malformed command substitution '${part.value}'`));
    }
    const written = useFrameOf(stack);
    return Computable.forAll(
      pipeline.map(stage => this.lookupCommandStage(stage, written?.property, written?.target, stack)),
      (...substituted: ICommandStageLookup[]) => substituted
    ).then(substituted => this.runResolvedCommand(substituted, part.value, stack));
  }

  /**
   * Materialize each looked-up stage's command as a runnable and run the
   * pipeline for its output ({@link captureOutput}). `written` names the command
   * in errors and in the work item it reports as.
   */
  private runResolvedCommand(substituted: ICommandStageLookup[], written: string, stack?: IDependencyStack): Computable<string> {
    return Computable.forAll(
      substituted.map(stage => this.materializeSubstStage(stage, written, stack)),
      (...resolved: MaterializedCommandStage[]) => resolved
    ).then(stages => this.captureOutput(stages, written));
  }

  /**
   * Run a resolved pipeline and return its stdout as text: stage it as
   * `generate` does, perform it as a build action through the cache, and
   * normalize the output ({@link normalizeCommandOutput}). The action belongs
   * to no target ({@link runOwnAction}) and stages no `srcs`, only what its
   * stages carry. `written` labels the work.
   */
  private captureOutput(stages: MaterializedCommandStage[], written: string): Computable<string> {
    if (stages.length === 0) {
      return Computable.resolve("");
    }
    const captured = captureStages(stages);
    const { files, specs } = stagePipeline(captured, EMPTY_FILESET);
    const action = createPipelineAction(files, specs, captured[0].stdin, undefined);
    return this.runOwnAction(action, { kind: "command-subst", command: written })
      .then(output => output.get(SUBST_CAPTURE))
      .then(file => (file ? file.readString() : ""))
      .then(normalizeCommandOutput);
  }

  /** Materialize one stage for execution: its command as a runnable, its args
   * taken literally. A substitution has no `srcs`, so unlike a `generate` stage
   * no arg is glob-expanded. */
  private materializeSubstStage(
    stage: ICommandStageLookup,
    written: string,
    stack?: IDependencyStack
  ): Computable<MaterializedCommandStage> {
    if (stage.stdin !== undefined) {
      return Computable.reject(new FabrError(`'< ' is not available in a command substitution (in \`${written}\`)`));
    }
    return this.lookupFileValue(stage.command.name, stack, {
      relativeTo: stage.command.ref,
      callerOverrides: this.runOverrides(),
    })
      .then(sources => collectRunnable(this, this.resolutionContext(`\`${written}\``), sources, stage.command.name.toString()))
      .then(runnable => ({
        runnable,
        args: stage.args.map(arg => arg.name.toString()),
        stdout: stage.stdout?.name.toString(),
        stderr: stage.stderr?.name.toString(),
        mergedTo: stage.mergedTo,
      }));
  }

  /**
   * Look up the property the bare reference `ref` names: substitute it
   * (positioned by `info`) and find the one declaration of it that applies
   * here (see {@link ReferencedProperty}). Chases a map reference (`metadata =
   * SHARED`) or a command reference (`run = shared_cmd`); the caller decides
   * what a name that is no property means.
   */
  public referencedProperty(ref: Name, info?: IDependencyStack): Computable<ReferencedProperty> {
    return this.substituteNameVars(ref, info).then((name): Computable<ReferencedProperty> | ReferencedProperty => {
      const def = this.lookupDecl(name.toString());
      if (def?.kind !== DeclKind.Property) {
        return { prop: undefined, property: false, name, context: this };
      }
      /* A map or command property takes one declaration, as a scalar does; with
       * none applying here it is unset. */
      return this.getAvailableDecls(def, info).then(applicable => ({
        prop: soleDecl(applicable),
        property: true,
        name,
        context: this,
      }));
    });
  }

  public lookupCommand(prop: IPropertyDecl, target?: ITargetDecl, stack?: IDependencyStack): Computable<ICommandStageLookup[]> {
    return this.getCommandPipeline(prop, target, stack, new Set()).then(stages =>
      Computable.forAll(
        stages.map(stage => this.lookupCommandStage(stage, prop, target, stack)),
        (...resolved: ICommandStageLookup[]) => resolved
      )
    );
  }

  /** Get the raw (unsubstituted) pipeline of a command property: its parsed
   * pipeline, a single `cmd args…` stage, or — when the sole value references
   * another command-valued property — that property's pipeline (chased,
   * `seen`-guarded, mirroring lookupMapDecl). */
  private getCommandPipeline(
    prop: IPropertyDecl,
    target: ITargetDecl | undefined,
    stack: IDependencyStack | undefined,
    seen: Set<IPropertyDecl>
  ): Computable<CommandPipeline> {
    if (seen.has(prop)) {
      return Computable.reject(new FabrError(`Circular command reference at '${prop.name}'`));
    }
    const commandValue = prop.values.find(isCommandValue);
    if (commandValue !== undefined) {
      return Computable.resolve(commandValue.pipeline);
    }
    const names = prop.values.filter(isNameValue);
    if (names.length === 0) {
      return Computable.resolve([]);
    }
    /* A sole bare name may name another command-valued property
     * ({@link referencedProperty}); otherwise it is a one-stage `cmd`. */
    if (names.length === 1) {
      const value = names[0];
      const info: IUseFrame = { property: prop, target, value, next: stack };
      const nextSeen = new Set(seen).add(prop);
      /* A property nothing sets here is no command. */
      return this.inFile(value.source.file)
        .referencedProperty(value.value, info)
        .then(({ prop: ref, property, context }) =>
          ref
            ? context.getCommandPipeline(ref, undefined, stack, nextSeen)
            : Computable.resolve<CommandPipeline>(property ? [] : [{ command: value, args: [] }])
        );
    }
    const [command, ...args] = names;
    return Computable.resolve([{ command, args }]);
  }

  /** Substitute every name of one stage, keeping each written {@link INameValue}
   * as the resolved name's `ref`. */
  private lookupCommandStage(
    stage: ICommandStage,
    prop: IPropertyDecl | undefined,
    target: ITargetDecl | undefined,
    stack: IDependencyStack | undefined
  ): Computable<ICommandStageLookup> {
    /* A command substitution in a value with no property (a global's) uses the
     * caller's stack as it stands, with no use frame per name. */
    const position = (value: INameValue): Computable<IPositionedName> =>
      this.substituteName(value, prop ? { property: prop, target, value, next: stack } : stack).then(name => ({ name, ref: value }));
    const positionOpt = (value: INameValue | undefined): Computable<IPositionedName | undefined> =>
      value ? position(value) : Computable.resolve(undefined);
    return Computable.forAll(
      [
        position(stage.command),
        Computable.forAll(stage.args.map(position), (...args: IPositionedName[]) => args),
        positionOpt(stage.stdin),
        positionOpt(stage.stdout),
        positionOpt(stage.stderr),
      ],
      (command, args, stdin, stdout, stderr): ICommandStageLookup => ({
        site: prop && { property: prop, target },
        command,
        args,
        stdin,
        stdout,
        stderr,
        mergedTo: stage.mergedTo,
      })
    );
  }

  /** Get the targetdef of the declared type `type`. */
  protected targetDefOf(type: string): ITargetDefDecl {
    const targetDef = this.model.getTargetDef(type);
    if (!targetDef) {
      throw new FabrError("Targetdef '" + type + "' not found"); /* Can't happen due to earlier checks */
    }
    return targetDef;
  }

  /** Select the rule that builds the target `context` evaluates, of `type`,
   * or throw the error `noRule` makes where none applies. */
  protected ruleFor(type: string, context: TargetContext, noRule: (selection: IRuleSelection) => Error): Computable<RuleDefinition> {
    return this.selectRule(type, context).then(selection => {
      if (!selection.rule) {
        throw noRule(selection);
      }
      return this.model.getRuleDefinition(selection.rule).catch(err => {
        throw context.failure(err);
      });
    });
  }

  /** Make the context the declared target `target` is evaluated in, with the
   * target on the stack as under evaluation, and select its rule. */
  public declaredRule(
    target: ITargetDecl,
    stack?: IDependencyStack
  ): Computable<{ context: DeclaredTargetContext; rule: RuleDefinition }> {
    const context = this.targetContextFor(target, { evaluating: target, next: stack });
    const noRule = ({ candidates }: IRuleSelection): Error => new NoRuleFoundError(target, this.constraints, candidates);
    return this.ruleFor(target.type, context, noRule).then(rule => ({ context, rule }));
  }

  /**
   * Resolve the declared target `target`:
   * - a repository declaration to what its type's provider makes
   *   ({@link sourceOf}), once its requirements are resolved and kept in
   *   `resolvedRepositories`; a failure is a `DependencyFailedError` for it;
   * - a target whose rule is a value (a flag) to the value;
   * - any other to a {@link TargetRef}, the target resolved by its rule
   *   ({@link resolveByRule}).
   */
  private resolveTargetDecl(target: ITargetDecl, stack?: IDependencyStack): Computable<SourceRef[]> {
    /* A repository has no rule and no build action of its own; the target
     * cache holds one per configuration. */
    const implementation = this.model.getRepositoryImplementation(target.type);
    if (implementation) {
      const context = this.targetContextFor(target, stack);
      const requirements = requirementsOf(implementation, context);
      this.resolvedRepositories.set(declName(target), requirements);
      return provided(implementation, context, requirements).then(
        (provided): SourceRef[] => [sourceOf(provided, context.name)],
        err => {
          throw new DependencyFailedError(target, err);
        }
      );
    }
    return this.declaredRule(target, stack).then(({ context, rule }): Computable<SourceRef[]> => {
      if (rule.value) {
        return this.evaluateTarget(context, rule);
      }
      return this.resolveByRule(context, rule);
    });
  }

  /** Resolve the target `context` evaluates with `rule`, and @return the reference to it. */
  protected resolveByRule(context: DeclaredTargetContext, rule: RuleDefinition): Computable<SourceRef[]> {
    return this.holdResolved(context, this.resolvedTargetByRule(context, rule));
  }

  /** Hold `resolved` as what the target `context` evaluates resolves to, and @return the reference to it. */
  protected holdResolved(context: DeclaredTargetContext, resolved: Computable<ResolvedTarget>): Computable<SourceRef[]> {
    const name = declName(context.target);
    this.resolvedTargets.set(name, resolved);
    /* A reference to the target with nothing written on it. */
    return resolved.then((): SourceRef[] => [new TargetRef(this, name)]);
  }

  /** Resolve the target `context` evaluates with `rule`. */
  protected resolvedTargetByRule(context: DeclaredTargetContext, rule: RuleDefinition): Computable<ResolvedTarget> {
    /* Every requirement is read and the lot resolved as one collection:
     * versions selected and the graph wired, nothing fetched or built. What
     * that fails with (a cycle, a name that resolves to nothing, versions that
     * cannot be reconciled) is the target's failure. */
    return this.resolvedWith(
      context,
      rule,
      statedRequirements(context, rule).then(required => resolveRequirements(context, required))
    );
  }

  /** Make the resolved target `context` evaluates with `rule`, whose requirements resolve to `requirements`. A failure is the target's. */
  protected resolvedWith(
    context: DeclaredTargetContext,
    rule: RuleDefinition,
    requirements: Computable<ResolvedRequirements>
  ): Computable<ResolvedTarget> {
    return requirements
      .then(resolved =>
        DeclaredResolvedTarget.of(
          context,
          resolved,
          () => this.evaluateTarget(context, rule, resolved),
          rule.describe === undefined ? undefined : () => this.describeWith(context, rule, resolved)
        )
      )
      .catch(err => {
        throw context.failure(err);
      });
  }

  public resolvedTarget(name: string): Computable<ResolvedTarget> {
    const resolved = this.resolvedTargets.get(name);
    if (resolved === undefined) {
      throw new FabrError(`internal: '${name}' is referred to before it is resolved`);
    }
    return resolved;
  }

  public isDeclared(ref: INameValue): Computable<boolean> {
    /* A marker counts only on a name written literally, as in lookupFileSource. */
    const substituted = ref.value.getSubstitutions().length > 0;
    return this.inFile(ref.source.file)
      .lookupContextFor(ref.value)
      .then(({ context, reference }) => {
        const name = reference.toString();
        return (
          context.constraints.has(name) ||
          this.lookupDecl(name) !== undefined ||
          (!substituted && this.markedTarget(reference) !== undefined)
        );
      });
  }

  /**
   * Get the marker `name` ends with, and the name without it, where the rest
   * is literally the name of a target declared where names are looked up here
   * (`foo!`), not a repository; undefined otherwise.
   */
  private markedTarget(name: Name): { override: "force" | "alternate"; unmarked: Name } | undefined {
    const override = name.getMarker();
    if (override === undefined) {
      return undefined;
    }
    const unmarked = name.withoutMarker();
    const text = unmarked.toBaseString();
    const decl = text === "" ? undefined : this.lookupDecl(text);
    return decl?.kind === DeclKind.Target && !this.model.hasRepositoryType(decl.type) ? { override, unmarked } : undefined;
  }

  public getAction(ref: INameValue, stack?: IDependencyStack): Computable<BuildAction | undefined> {
    return this.inFile(ref.source.file)
      .lookupContextFor(ref.value, undefined, stack)
      .then(({ context, reference }) => context.actionOfTarget(reference.toString(), stack));
  }

  /**
   * Get the build action the rule of the declared target `name` yields, not
   * performed: undefined where the rule is a value or yields content. The
   * target's requirements are read from its resolution where it has been
   * resolved, and are resolved here otherwise. A name that is no target throws.
   */
  private actionOfTarget(name: string, stack?: IDependencyStack): Computable<BuildAction | undefined> {
    const def = this.lookupDecl(name);
    if (def?.kind !== DeclKind.Target) {
      throw new FabrError(`'${name}' is not a target that runs a command`);
    }
    return this.declaredRule(def, stack).then(({ context, rule }): Computable<BuildAction | undefined> | undefined => {
      /* A value is content: nothing of it is built. */
      if (rule.value) {
        return undefined;
      }
      const resolved = this.resolvedTargets.get(declName(context.target))?.then(target => target.resolved);
      const applied = (parts?: ResolvedRequirements): Computable<BuildAction | undefined> =>
        this.applyRule(context, rule, parts)
          .then(result => (result instanceof BuildAction ? result : undefined))
          .catch(err => {
            throw context.failure(err);
          });
      /* A resolution read here failed as the target's already. */
      return resolved === undefined ? applied() : resolved.then(applied);
    });
  }

  public describe(ref: INameValue, stack?: IDependencyStack): Computable<FileSet | undefined> {
    return this.inFile(ref.source.file)
      .lookupContextFor(ref.value, undefined, stack)
      .then(({ context, reference }) => context.describeTarget(reference.toString(), stack));
  }

  /**
   * Describe the declared target `name` with its rule ({@link describeWith}):
   * undefined where the rule is a value or describes nothing. A name that is
   * no target throws.
   */
  private describeTarget(name: string, stack?: IDependencyStack): Computable<FileSet | undefined> {
    const def = this.lookupDecl(name);
    if (def?.kind !== DeclKind.Target) {
      throw new FabrError(`'${name}' is not a target`);
    }
    return this.declaredRule(def, stack).then(({ context, rule }): Computable<FileSet | undefined> | undefined => {
      if (rule.value || rule.describe === undefined) {
        return undefined;
      }
      /* A target already resolved has its requirements read from there. */
      const resolved = this.resolvedTargets.get(declName(context.target))?.then(target => target.resolved);
      return resolved === undefined
        ? this.describeWith(context, rule)
        : resolved.then(parts => this.describeWith(context, rule, parts));
    });
  }

  /**
   * Describe a target with `rule`, over `resolved`, its requirements, or where
   * none are given over the rule's requirements resolved here: a yielded
   * BuildAction is performed through the cache, and the files the description
   * is made of are returned as one set.
   */
  private describeWith(context: TargetContext, rule: RuleDefinition, resolved?: ResolvedRequirements): Computable<FileSet> {
    const describe = rule.describe!;
    const held =
      resolved === undefined
        ? statedRequirements(context, rule).then(required => resolveRequirements(context, required))
        : Computable.resolve(resolved);
    return held
      .then(requirements => describe(context, unmaterialized(this, requirements)))
      .then(result => (result instanceof BuildAction ? this.runAction(result, context) : result))
      .then(result =>
        FileSet.unionAll(...(Array.isArray(result) ? result : [result]).filter((part): part is FileSet => part instanceof FileSet))
      )
      .catch(err => {
        throw context.failure(err);
      });
  }

  public resolve(ref: INameValue, stack?: IDependencyStack): Computable<ResolvedRequirements> {
    return this.inFile(ref.source.file)
      .lookupContextFor(ref.value, undefined, stack)
      .then(
        ({ context, reference }) => context.repositoryRequirements(reference.toString(), stack) ?? this.resolveDenoted(ref, stack)
      );
  }

  /**
   * Resolve the requirements of the repository `name` declares, as its
   * declaration resolves them, if it declares one.
   */
  private repositoryRequirements(name: string, stack?: IDependencyStack): Computable<ResolvedRequirements> | undefined {
    const decl = this.lookupDecl(name);
    if (decl?.kind !== DeclKind.Target || !this.model.hasRepositoryType(decl.type)) {
      return undefined;
    }
    return this.resolveTarget(name, stack).then(() => this.resolvedRepositories.get(declName(decl))!);
  }

  /** Resolve what `ref` denotes, as one unnamed requirement. */
  private resolveDenoted(ref: INameValue, stack?: IDependencyStack): Computable<ResolvedRequirements> {
    return this.lookupFileValue(ref.value, stack, { relativeTo: ref }).then(sources =>
      /* The lot is one requirement, unnamed, resolved as one collection: a
       * target among it as its node, with each entry the reference it was
       * resolved for. */
      resolveLists(this.resolutionContext(), [sources]).then(({ lists: [resolved], references: [written], conflicts, collection }) =>
        ResolvedRequirements.of(resolved, written, conflicts, collection)
      )
    );
  }

  /**
   * Apply a rule to a target: evaluate it over `resolved`, the target's
   * requirements, or where none are given over the rule's requirements resolved
   * here.
   */
  private applyRule(context: TargetContext, rule: RuleDefinition, resolved?: ResolvedRequirements): Computable<RuleResult> {
    const held =
      resolved === undefined
        ? statedRequirements(context, rule).then(required => resolveRequirements(context, required))
        : Computable.resolve(resolved);
    return held.then(requirements => rule.evaluate(context, unmaterialized(this, requirements)));
  }

  /**
   * Evaluate a declared or anonymous target with `rule`: apply the rule, perform
   * a yielded BuildAction through the cache, stamp each FileSet result with the
   * target's provenance, and wrap any failure to identify the target. A plural
   * result (a `sync`'s member carriers) yields each element as its own source.
   */
  protected evaluateTarget(
    context: TargetContext,
    rule: RuleDefinition,
    requirements?: ResolvedRequirements
  ): Computable<SourceRef[]> {
    return this.applyRule(context, rule, requirements)
      .then(result => (result instanceof BuildAction ? this.runAction(result, context) : result))
      .then(result =>
        (Array.isArray(result) ? result : [result]).map(source =>
          source instanceof FileSet ? context.stampProvenance(source) : source
        )
      )
      .catch(err => {
        throw context.failure(err);
      });
  }

  public buildSubTarget(
    owner: TargetContext,
    type: string,
    inputs: SubTargetInputs,
    options?: { label?: string; constraints?: Constraints }
  ): Computable<SourceRef[]> {
    const buildContext = this.getContextWithOverrides(options?.constraints);
    /* A sub-target's type without a targetdef is a plugin's internal error. */
    const targetDef = this.model.getTargetDef(type);
    if (!targetDef) {
      throw new FabrError(`Internal error: sub-target type '${type}' has no registered targetdef`);
    }
    const context = new AnonymousTargetContext(
      buildContext,
      targetDef,
      inputs,
      owner.getDeclaredContext(),
      options?.label,
      owner.stack,
      owner
    );
    return buildContext
      .ruleFor(type, context, () => new FabrError(`No rule found for anonymous target type '${type}'`))
      .then(rule => buildContext.evaluateTarget(context, rule));
  }

  public hasRepositoryType(type: string): boolean {
    return this.model.hasRepositoryType(type) && this.model.getTargetDef(type) !== undefined;
  }

  public makeRepository(
    owner: TargetContext,
    type: string,
    { name, properties = {}, url, credential }: IRepositoryMember
  ): Computable<Repository> {
    const implementation = this.model.getRepositoryImplementation(type);
    const targetDef = this.model.getTargetDef(type);
    const written = `${owner.name}:${name}`;
    if (implementation === undefined || targetDef === undefined) {
      return Computable.reject(new FabrError(`'${written}' is a ${type}, which no plugin in use defines`));
    }
    const context = new MemberTargetContext(this, targetDef, properties, owner.getDeclaredContext(), name, owner.stack, owner);
    return provided(implementation, context, requirementsOf(implementation, context), url, credential).then(made => {
      if (!isRepository(made)) {
        throw new FabrError(`internal: '${written}' is a ${type}, which makes no repository`);
      }
      return made;
    });
  }

  public describeSubTarget(
    owner: TargetContext,
    type: string,
    inputs: SubTargetInputs,
    options?: { label?: string; constraints?: Constraints }
  ): Computable<FileSet | undefined> {
    const buildContext = this.getContextWithOverrides(options?.constraints);
    const targetDef = this.model.getTargetDef(type);
    if (!targetDef) {
      throw new FabrError(`Internal error: sub-target type '${type}' has no registered targetdef`);
    }
    const context = new AnonymousTargetContext(
      buildContext,
      targetDef,
      inputs,
      owner.getDeclaredContext(),
      options?.label,
      owner.stack,
      owner
    );
    return buildContext
      .ruleFor(type, context, () => new FabrError(`No rule found for anonymous target type '${type}'`))
      .then(rule => (rule.describe === undefined ? undefined : buildContext.describeWith(context, rule)));
  }

  /**
   * Perform `context`'s build action through the cache, reported as the
   * target's work. A target the run was asked to force
   * ({@link ExecutionContext.forceTarget}) is rebuilt rather than served (see
   * {@link forcedBuild}).
   */
  private runAction(action: BuildAction, context: TargetContext): Computable<FileSet> {
    /* A sub-target's build state is keyed by its declared owner and its own
     * label ({@link BuildAction.targetKey}). */
    const task = context.taskDescription();
    return this.performAction(action, task, {
      force: this.forcedBuild(context),
      targetKey: action.targetKey(context.getDeclaredContext().target, task.label),
    });
  }

  /**
   * Perform an action that belongs to no target, reported as `task`: a
   * `` `cmd` `` substitution, which may be written in a global. Never forced,
   * since `-f` marks targets.
   */
  private runOwnAction(action: BuildAction, task: TaskDescription): Computable<FileSet> {
    return this.performAction(action, task, {});
  }

  /**
   * Perform `action` through the build cache, reported as `task` where the
   * cache does not hold it, and @return its output with the action's
   * `reshape` applied (to a cached output as to a new one). `options.force`
   * performs it whether or not the cache holds it; `targetKey` names the
   * target's build state, absent for an action of no target. Where the run
   * retries failed tests (`--retry-failed`), a cached output with failed
   * tests is performed again, once.
   */
  private performAction(
    action: BuildAction,
    task: TaskDescription,
    options: { force?: boolean; retry?: boolean; targetKey?: string }
  ): Computable<FileSet> {
    const execution = this.execution;
    /* Run only where the cache misses, so a task is reported for each action
     * performed, and only then. */
    const create = (ctx: ActionContext): Computable<BuildResult> =>
      execution.runTask(task, report => action.step.run(action, ctx, report));
    /* The cache derives the key (anchor or complete, by the action's shape),
     * the discoverable deps and the change tracking from the action itself. */
    const outcome = execution.buildCache.getOrCreateAction(action, create, { ...options, processLimit: execution.processLimit });
    const reshape = action.reshape;
    const delivered = (files: FileSet): Computable<FileSet> =>
      reshape === undefined ? Computable.resolve(files) : Computable.resolve(files).then(reshape);
    /* A failed test run served from the cache is performed again, once, under
     * `--retry-failed`, from its own last run: the step decides what it
     * reruns. */
    return outcome.then(({ files, created }) =>
      execution.retryFailed && !created && !options.retry
        ? hasTestFailures(files).then(failed =>
            failed ? this.performAction(action, task, { ...options, retry: true }) : delivered(files)
          )
        : delivered(files)
    );
  }

  /**
   * @return true if `context` belongs to a target the run was asked to force
   * (`-f`, see {@link ExecutionContext.forceTarget}), otherwise false. A
   * sub-target is asked about by its declared owner, so it is forced with the
   * owner, while the declared targets the owner depends on are not.
   */
  private forcedBuild(context: TargetContext): boolean {
    return this.execution.isForced(context.getDeclaredContext().target);
  }
}

/** State what `rule` requires of the target `context` builds: nothing, for a
 * rule without `requirements`. */
function statedRequirements(context: TargetContext, rule: RuleDefinition): Computable<ResolutionSpec> {
  const stated = rule.requirements?.(context) ?? {};
  return stated instanceof Computable ? stated : Computable.resolve(stated);
}

/**
 * Make the error for reading a map (block-valued) property in a non-map
 * context, where it would otherwise yield an empty result (`version =
 * 1.0-${MAP}` interpolating to "1.0-", `deps = MAP` contributing no files).
 */
function mapInWrongContextError(prop: IPropertyDecl, context: string): Error {
  return new FabrError(`'${prop.name}' is a map and cannot be used as ${context}`).withHelp(
    `a map is referenced by bare name from a MAP property (\`metadata = ${prop.name};\`); ` +
      `it cannot be \${...}-interpolated or read as files`
  );
}

function commandInWrongContextError(prop: IPropertyDecl): Error {
  return new FabrError(
    `'${prop.name}' contains a pipeline operator ('|', '<', '>', '2>', '&>'), which is only valid in a COMMAND property`
  ).withHelp("quote it to use the character literally (e.g. `'|'`)");
}

/** Make the error for a non-name value where a name was required: a map block or
 * a command pipeline, each explained. `context` names the consuming use in the map
 * message ("a string", "files"). */
function nonNameValueError(prop: IPropertyDecl, value: IMapValue | ICommandValue, context: string): Error {
  return isMapValue(value) ? mapInWrongContextError(prop, context) : commandInWrongContextError(prop);
}

/**
 * Get the selected declaration, or throw {@link unmatchedError} where no
 * declaration of the property, ordinary or `default`, applies to this
 * configuration.
 */
function unmatchedIfAbsent(selected: IPropertyDecl | undefined, name: string, entry: IPropertyEntry): IPropertyDecl {
  if (selected) {
    return selected;
  }
  throw unmatchedError(name, entry);
}

/** Make the error for a property that is declared, but none of whose
 * declarations applies to this configuration. */
function unmatchedError(name: string, entry: IPropertyEntry): Error {
  const guards = [...entry.decls, ...entry.defaults].map(guardText);
  /* A private declaration has no `default` tier. */
  const remedy = entry.decls.some(decl => decl.private)
    ? "add an unguarded declaration"
    : `add an unguarded declaration, or a 'default ${name} = …;'`;
  return new FabrError(`'${name}' is declared, but no declaration of it applies to this configuration`).withHelp(
    `it is declared under ${guards.join(", ")} — ${remedy}`
  );
}

/**
 * @return `source`, or, where it is a reference to a registry's package that
 * states no version, has no marker and selects no files, a
 * {@link PartialRepositoryRef} naming the package's published versions
 * (`fabr ls @mvn:g:a`), where the registry can list them.
 */
function versionsOf(source: SourceRef): SourceRef {
  return source instanceof RepositoryRef &&
    source.versionConstraint === undefined &&
    source.override === undefined &&
    source.projections.length === 0 &&
    isRepositoryReader(source.source) &&
    isRepository(source.source) &&
    source.source.children !== undefined
    ? new PartialRepositoryRef(source.source, source.name, undefined, source.repositoryName)
    : source;
}

/** Make the error for `rule` selected for a target inside its own application. */
function recursiveRuleError(rule: RuleBlockDefinition): FabrError {
  const { decl } = rule;
  const guards = [
    ...decl.properties.map(([key, pattern]) => `${key}=${pattern.toString()}`),
    ...decl.targetProperties.map(([key, pattern]) => `${decl.param}.${key}=${pattern.toString()}`),
  ];
  const head = `${decl.type === undefined ? "default rule" : `rule ${decl.type}`} ${decl.param}${guards.length > 0 ? `<${guards.join(", ")}>` : ""}`;
  return new FabrError(`'${head}' is applied inside its own application`).withHelp(
    "a target its block declares, or one made from it, is matched by the same rule again, which would apply it without end"
  );
}

/**
 * What a reference to a property names (see `referencedProperty`): the one
 * declaration of it that applies here (`prop`), none where nothing sets it
 * here; whether the name is a property at all (`property`); the name as
 * substituted; and the configuration its values are looked up in.
 */
interface ReferencedProperty {
  readonly prop?: IPropertyDecl;
  readonly property: boolean;
  readonly name: Name;
  readonly context: BuildContextImpl;
}

/** @return the constraints a reference requires (`ref<k=v>`), if it requires any. */
function requirementOf(name: Name): Constraints | undefined {
  return name.hasConstraints() ? constraintsOf(name.getConstraints()) : undefined;
}

/** Make the {@link Constraints} `constraints`, each value's text the key's value. */
function constraintsOf(constraints: readonly NameConstraint[]): Constraints {
  const required: Record<string, string> = Object.create(null);
  for (const [key, value] of constraints) {
    required[key] = value.toString();
  }
  return Constraints.of(required);
}

/** What the result of a rule's block and the block's targets it reaches require ({@link RuleScope.lookupBlockRequirements}). */
interface BlockRequirements {
  /** What the result reference names, under {@link RESULT_KEY}, and each requirement of each target reached that its rule states for `build`, named `<target>.<requirement>`. */
  readonly build: ReadonlyMap<string, RequiredSources>;
  /** Each requirement of each target reached that its rule states for `run`, named as in `build`. */
  readonly run: ReadonlyMap<string, RequiredSources>;
  /** What the result reference names. */
  readonly result: ReadonlyArray<SourceRef>;
  /** The requirement name each key of `build` and `run` stands for. */
  readonly names: ReadonlyMap<string, string>;
  /** Each target reached, by name, with whether its rule collects permissively, what it declares it builds and the advisories it declares its build fixes. */
  readonly reachedTargets: ReadonlyMap<string, Pick<ResolutionSpec, "permissive" | "result" | "fixes">>;
}

/** The name of what a block's result reference names among the requirements of a rule written in `.fabr`: no `<target>.<requirement>`. */
const RESULT_KEY = "result";

/**
 * @return what the target `node` stands for builds, as its rule declares it:
 * `"files"` where it is plain, the package its rule declares (renamed where it
 * was) at the node's version where the rule states none, or undefined where
 * the rule declares nothing or `node` is no target's node.
 */
function builtBy(node: Unbuilt | undefined): Builds | undefined {
  if (!(node instanceof ResolvedNode)) {
    return undefined;
  }
  const { declared, plain } = node.content;
  if (plain === true || declared === "files") {
    return "files";
  }
  return declared === undefined ? undefined : { ...declared, version: declared.version ?? node.version };
}

/** A Windows absolute path as the command line reads one (`C:/x`). */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:\//;

/** @return true if `name` is written as an absolute path, starting `/`,
 * otherwise false. In a build file `C:/x` is a projection out of `C` on every host. */
function isAbsoluteName(name: Name): boolean {
  return name.toString().startsWith("/");
}

/** @return the sources of a requirement as read. */
function sourcesOf(read: Read): SourceRef[] {
  return Array.isArray(read) ? read : read.sources;
}

/**
 * Make the definition of a rule written in `.fabr`, `block`: a rule as any
 * other, its implementation the block's application to each target it is
 * selected for ({@link RuleScope}).
 */
export function blockRuleDefinition(block: RuleBlockDefinition): RuleDefinition {
  const scopeOf = (context: TargetContext): RuleScope =>
    context.ruleState(block, () => {
      /* A rule selected inside its own application would apply without end:
       * its block's targets are made anew in each application. */
      if (enclosingRules(context).some(enclosing => enclosing.decl === block.decl)) {
        throw context.failure(recursiveRuleError(block));
      }
      return new RuleScope(block, context);
    });
  return {
    type: block.type,
    properties: block.properties,
    targetProperties: block.targetProperties,
    requirements: context => Computable.resolve(undefined).then(() => scopeOf(context).requirements(context.stack)),
    evaluate: (context, requirements) => scopeOf(context).evaluate(requirements),
  };
}

/**
 * One application of a rule written in `.fabr`: its block, applied to the
 * target it matched (`matched`), in that target's configuration. It is the
 * rule's implementation for that target:
 * - {@link requirements} states what the block's result and the block's
 *   targets it reaches require, so they all resolve as the matched target's
 *   one collection;
 * - {@link evaluate} builds the matched target from them.
 *
 * It also answers the names the block scopes: the block's configurations,
 * made on demand, two per constraint set ({@link config}); the block's
 * targets, resolved there; the matched target as `<param>`; and its
 * properties as `<param>.<name>` (the `aliased*` methods).
 */
class RuleScope {
  /** The block's configurations made so far. */
  private readonly configs: ScopedBuildContext[] = [];
  /** The state the rules of the block's targets keep, per configuration and target. */
  private readonly states = new Map<ScopedBuildContext, Map<string, Map<object, unknown>>>();
  /** The configuration the result is built in, once computed. */
  private resultConstraints?: Computable<Constraints>;
  /** What the block looks up for the matched target, once started. */
  private lookedUp?: Computable<BlockRequirements>;
  /** The matched target's requirements as resolved, where it has no resolved target to read them from (a target a rule's code made). */
  private given?: ResolvedRequirements;
  /** The configuration the rule applies in: the matched target's. */
  private readonly constraints: Constraints;

  constructor(
    public readonly rule: RuleBlockDefinition,
    public readonly matched: TargetContext
  ) {
    this.constraints = matched.taskDescription().constraints;
  }

  /** The rule's parameter, the name the block gives the matched target. */
  public get param(): string {
    return this.rule.decl.param;
  }

  /**
   * Get the block's configuration of `constraints`, made on first use over the
   * rule file's configuration of them; with `unresolved`, the one in which
   * each of the block's targets is its node with its requirements left
   * unresolved ({@link ScopedBuildContext.unresolved}).
   */
  public config(constraints: Constraints, unresolved = false): ScopedBuildContext {
    const held = this.configs.find(config => config.unresolved === unresolved && config.hasConstraints(constraints));
    if (held !== undefined) {
      return held;
    }
    const parent = (this.matched.getDeclaredContext().configurationOf(constraints) as BuildContextImpl).inFile(
      this.rule.decl.source.file
    );
    const config = new ScopedBuildContext(parent.model, constraints, parent.execution, this, parent, unresolved);
    this.configs.push(config);
    return config;
  }

  /** Get the configuration the result is built in: the matched target's, with the `<k=v>` written on the result reference applied once substituted. Done once. */
  public resultConfiguration(): Computable<Constraints> {
    return (this.resultConstraints ??= this.config(this.constraints)
      .substituteName(this.rule.decl.implementation.result)
      .then(name => this.constraints.with(requirementOf(name))));
  }

  /**
   * State what the matched target requires: what the block looks up for it
   * ({@link lookupBlockRequirements}), collected permissively. Where the
   * result is one whole target, it is what the matched target is made from
   * (`extends`), so the matched target builds and passes on what the result
   * does; otherwise the matched target builds files.
   */
  public requirements(stack?: IDependencyStack): Computable<ResolutionSpec> {
    return this.lookupBlockRequirements(stack).then(({ build, run, result }) => {
      const whole = soleWholeTarget([...result]);
      if (whole === undefined) {
        return { build: new Map(build), run: new Map(run), permissive: true, result: "files" as const };
      }
      const rest = [...build].filter(([key]) => key !== RESULT_KEY);
      return whole.nodes().then(([node]): ResolutionSpec => ({
        build: new Map<string, RequiredSources>([[EXTENDS_KEY, new PackageSources([whole])], ...rest]),
        run: new Map(run),
        permissive: true,
        result: builtBy(node),
      }));
    });
  }

  /**
   * Build the matched target from `requirements`, its requirements resolved:
   * what it is made from where the result is one whole target, with what the
   * result reference wrote on it (a `-> name`) applied, and otherwise the files
   * the result names, as one set.
   */
  public evaluate(requirements: Unmaterialized<Record<string, RequiredSources>>): Computable<RuleResult> {
    this.given = requirements.resolved;
    return requirements.resolved.sources.has(EXTENDS_KEY)
      ? requirements.materialize(EXTENDS_KEY)
      : requirements.materialize(RESULT_KEY).then((sets): FileSet => (sets.length === 1 ? sets[0] : FileSet.unionAll(...sets)));
  }

  /** Get the matched target's requirements as resolved, which hold what each target of the block the result reaches requires. */
  private collection(): Computable<ResolvedRequirements> {
    const { matched } = this;
    if (matched instanceof DeclaredTargetContext) {
      return matched.resolvedSelf().then(target => target.resolved);
    }
    return this.given === undefined
      ? Computable.reject(new FabrError(`internal: the requirements of '${matched.name}' are read before it is evaluated`))
      : Computable.resolve(this.given);
  }

  /** Get the requirements of the block's target `name`, which the result reaches: its part of the matched target's, with how its rule collects and what it declares it builds (`reached`). */
  public requirementsOf(
    name: string,
    reached: Pick<ResolutionSpec, "permissive" | "result" | "fixes">
  ): Computable<ResolvedRequirements> {
    return this.collection().then(collected => collected.ofTarget(name, reached));
  }

  /** Get the state `rule` keeps for the block's target `name` in the configuration of `constraints`, made by `make` on first use: one in each configuration, however the target is looked up there. */
  public ruleState<T>(name: string, constraints: Constraints, rule: object, make: () => T): T {
    const config = this.config(constraints);
    const byTarget = this.states.get(config) ?? new Map<string, Map<object, unknown>>();
    this.states.set(config, byTarget);
    const byRule = byTarget.get(name) ?? new Map<object, unknown>();
    byTarget.set(name, byRule);
    if (!byRule.has(rule)) {
      byRule.set(rule, make());
    }
    return byRule.get(rule) as T;
  }

  /** Resolve the block's target `name` in the block's ordinary configuration of `constraints`, and @return it resolved. */
  public resolvedTarget(name: string, constraints: Constraints, stack?: IDependencyStack): Computable<ResolvedTarget> {
    const config = this.config(constraints);
    return config.resolveTarget(name, stack).then(() => config.resolvedTarget(name));
  }

  /**
   * Look up what the block's result and every target of the block it reaches
   * require, in the configuration the result is built in: the targets the
   * result names, and those named by what each of them requires, however
   * read. They are read in the unresolved configuration, so nothing here
   * waits on the targets this answers. Done once. Each requirement is named
   * `<target>.<requirement>` (`names` gives the requirement each key stands
   * for), in the order the block declares its targets, after what the result
   * reference itself names, under {@link RESULT_KEY}. A target named under
   * other constraints is not reached.
   */
  public lookupBlockRequirements(stack?: IDependencyStack): Computable<BlockRequirements> {
    /* Held before it runs, so a request made while it runs depends on it. */
    return (this.lookedUp ??= Computable.detached(() => this.lookupReached(stack)));
  }

  /** Look up what {@link lookupBlockRequirements} returns. */
  private lookupReached(stack?: IDependencyStack): Computable<BlockRequirements> {
    interface Requires {
      readonly permissive: boolean;
      readonly result?: Builds;
      readonly fixes?: ReadonlyArray<string>;
      /** Each requirement, with the operation its collection is resolved for. */
      readonly entries: ReadonlyArray<[string, Read, string]>;
    }
    return this.resultConfiguration().then(constraints => {
      const at = this.config(constraints, true);
      const named = (sources: ReadonlyArray<SourceRef>): ITargetDecl[] => [
        ...new Set(
          sources.flatMap(source =>
            source instanceof TargetRef && source.source === at.nodes ? (this.rule.localTarget(source.name) ?? []) : []
          )
        ),
      ];
      /* What each target requires, read once; undefined for a value rule's. */
      const read = new Map<ITargetDecl, Computable<Requires | undefined>>();
      const requirementsOf = (target: ITargetDecl): Computable<Requires | undefined> => {
        const held = read.get(target);
        if (held !== undefined) {
          return held;
        }
        const requires = at.declaredRule(target, stack).then(({ context, rule }): Computable<Requires | undefined> => {
          if (rule.value) {
            return Computable.resolve(undefined);
          }
          return statedRequirements(context, rule).then(stated => {
            const entries = specEntries(stated);
            return Computable.forAll(
              entries.map(([, required]) => (required instanceof Computable ? required : Computable.resolve(required))),
              (...values: Read[]): Requires => ({
                permissive: stated.permissive === true,
                result: stated.result,
                fixes: stated.fixes,
                entries: entries.map(([name, , operation], index): [string, Read, string] => [name, values[index], operation]),
              })
            );
          });
        });
        read.set(target, requires);
        return requires;
      };
      /* `reached` with the targets reached from `frontier` added, each with what it requires. */
      const reach = (
        frontier: ReadonlyArray<ITargetDecl>,
        reached: ReadonlyMap<ITargetDecl, Requires | undefined>
      ): Computable<ReadonlyMap<ITargetDecl, Requires | undefined>> =>
        frontier.length === 0
          ? Computable.resolve(reached)
          : Computable.forAll(frontier.map(requirementsOf), (...found: Array<Requires | undefined>) => found).then(found => {
              const next = new Map(reached);
              frontier.forEach((target, index) => next.set(target, found[index]));
              const further = found
                .flatMap(each => named((each?.entries ?? []).flatMap(([, value]) => sourcesOf(value))))
                .filter(target => !next.has(target));
              return reach([...new Set(further)], next);
            });
      const { targets } = this.rule.decl.implementation;
      return this.result(constraints, stack, true).then(sources =>
        reach(named(sources), new Map()).then(reached => {
          const build = new Map<string, RequiredSources>([[RESULT_KEY, sources]]);
          const run = new Map<string, RequiredSources>();
          const names = new Map<string, string>([[RESULT_KEY, RESULT_KEY]]);
          const reachedTargets = new Map<string, Pick<ResolutionSpec, "permissive" | "result" | "fixes">>();
          for (const target of targets) {
            const found = reached.get(target);
            if (found !== undefined) {
              const local = declName(target);
              reachedTargets.set(local, { permissive: found.permissive, result: found.result, fixes: found.fixes });
              for (const [name, value, operation] of found.entries) {
                (operation === "run" ? run : build).set(`${local}.${name}`, value);
                names.set(`${local}.${name}`, name);
              }
            }
          }
          return { build, run, result: sources, names, reachedTargets };
        })
      );
    });
  }

  /**
   * Make the node of the block's target `context` evaluates with `rule`, for
   * the unresolved configuration, its requirements left unresolved. Its
   * dependencies are the references among its `dependencies`, `provided` and
   * `optional_provided` requirements, unbound, except that a reference to
   * another of the block's targets is bound to that one's node; what it passes
   * on is what any target's node passes on ({@link passedOn}), its `extends`
   * read as material; and its build is the target's in the block's ordinary
   * configuration of `constraints`. Every requirement is read, as resolving a
   * target reads them, so a cycle among the block's targets is found here. A
   * failure is the target's.
   */
  public blockTargetNode(context: DeclaredTargetContext, rule: RuleDefinition, constraints: Constraints): Computable<TargetNode> {
    const name = declName(context.target);
    const target = (): Computable<ResolvedTarget> => this.resolvedTarget(name, constraints, context.stack);
    const edgesOf = (sources: ReadonlyArray<SourceRef>): Computable<Dependency[]> =>
      Computable.forAll(
        sources.map((source): Computable<Dependency[]> =>
          source instanceof RepositoryRef
            ? Computable.resolve([{ reference: source }])
            : source instanceof TargetRef
              ? source
                  .nodes()
                  .then(nodes =>
                    nodes
                      .filter((node): node is ResolvedNode => isPackage(node))
                      .map((pkg): Dependency => ({ reference: source, package: pkg }))
                  )
              : Computable.resolve([])
        ),
        (...edges: Dependency[][]) => edges.flat()
      );
    return statedRequirements(context, rule)
      .then(stated => {
        const entries = specEntries(stated);
        return Computable.forAll(
          entries.map(([, required]) => (required instanceof Computable ? required : Computable.resolve(required))),
          (...values: Read[]) => ({ result: stated.result, lists: new Map(entries.map(([key], index) => [key, values[index]])) })
        );
      })
      .then(({ result, lists }) => {
        /* What the target is made from is read as material, joining no
         * resolution, as any target's is. */
        const made = lists.get(EXTENDS_KEY);
        const material =
          made === undefined || sourcesOf(made).length === 0
            ? Computable.resolve<ReadonlyArray<Resolved>>([])
            : resolveRequirements(context, { build: new Map([[EXTENDS_KEY, made]]) }).then(
                resolved => resolved.sources.get(EXTENDS_KEY) ?? []
              );
        const transitive = [DEPENDENCIES_KEY, PROVIDED_KEY, OPTIONAL_PROVIDED_KEY];
        const edges = Computable.forAll(
          transitive.map(key => edgesOf(sourcesOf(lists.get(key) ?? []))),
          (...each: Dependency[][]) => new Map(transitive.map((key, index) => [key, each[index]]))
        );
        return Computable.forAll([material, edges] as const, (madeFrom, byName) =>
          BlockTargetNode.of(
            context,
            passedOn(madeFrom, key => byName.get(key) ?? []),
            target,
            result
          )
        );
      })
      .catch(err => {
        throw context.failure(err);
      });
  }

  /** Resolve the block's target `name` in the block's ordinary configuration of `constraints`. */
  public resolveLocalTarget(name: string, constraints: Constraints, stack?: IDependencyStack): Computable<SourceRef[]> {
    return this.config(constraints).resolveTarget(name, stack);
  }

  /** Look up what the block's result names, in the block's configuration of `constraints` (the unresolved one, with `unresolved`). */
  public result(constraints: Constraints, stack?: IDependencyStack, unresolved = false): Computable<SourceRef[]> {
    const result = this.rule.decl.implementation.result;
    return this.config(constraints, unresolved).lookupFileValue(result.value, stack, { relativeTo: result });
  }

  /** Read the matched target's property `name` for files, as `<param>.name` (see {@link DeclaredTargetContext.aliasedFiles}). */
  public aliasedFiles(
    name: string,
    reader: Constraints,
    alias: Constraints | undefined,
    stack?: IDependencyStack
  ): Computable<SourceRef[]> {
    const { matched } = this;
    return matched instanceof DeclaredTargetContext
      ? matched.aliasedFiles(name, reader, alias, stack)
      : matched.getFileProperty(name, alias);
  }

  /** Get the matched target's one declaration of `name` that applies, with the configuration its values are looked up in, for reading as a map or command property. A target a rule's code made rejects. */
  public aliasedDecl(
    name: string,
    reader: Constraints,
    alias: Constraints | undefined,
    stack?: IDependencyStack
  ): Computable<{ prop?: IPropertyDecl; context: BuildContextImpl }> {
    const { matched } = this;
    if (!(matched instanceof DeclaredTargetContext)) {
      return Computable.reject(
        new FabrError(
          `'${this.param}.${name}' is a property of a target a rule's code made, which has no declaration to read as a map or command`
        )
      );
    }
    return matched
      .aliasedDecl(name, reader, alias, stack)
      .then(({ prop, context }) => ({ prop, context: context as BuildContextImpl }));
  }

  /** Read the matched target's STRING property `name`, with `overrides` applied. */
  public aliasedString(name: string, overrides?: Constraints): Computable<Property | undefined> {
    return this.matched.getProperty(name, overrides);
  }

  /** @return the parameter's value as a property: an alias of the matched target, whose text is the target's name (`${<param>}`). */
  public matchedName(): Property {
    return new Property([this.matched.name]);
  }

  /** Resolve the matched target in the configuration of `constraints`, as `<param>` names it. A target a rule's code made rejects. */
  public resolveMatched(constraints: Constraints, stack?: IDependencyStack): Computable<SourceRef[]> {
    const { matched } = this;
    if (!(matched instanceof DeclaredTargetContext)) {
      return Computable.reject(new FabrError(`'${this.param}' is a target a rule's code made, which a reference cannot name`));
    }
    return matched.resolveIn(constraints, stack);
  }

  /** @return the property of the parameter a value written as `name` reads in full (`pkg.args`), if it reads one. */
  public wholeAlias(name: Name): string | undefined {
    const property = parameterProperty(name, this.param);
    return property !== undefined && name.withConstraints([]).toString() === `${this.param}.${property}` ? property : undefined;
  }
}

/** A prefix of a name matched by a declaration a scope holds: see {@link IPrefixMatch}. */
type ScopedMatch = Pick<IPrefixMatch, "name" | "rest" | "retainedPrefix">;

/**
 * A configuration in which a scope's own names are looked up first. A name the
 * scope declares ({@link ownDecl}, {@link ownPrefixMatch}) is read, resolved
 * and cached here, and a constraint of that name does not replace it. Every
 * other name is passed to `parent`, the configuration of the same constraints
 * outside the scope. A subclass says what the scope declares.
 */
abstract class ScopedConfiguration extends BuildContextImpl {
  constructor(
    model: IBuildModel,
    constraints: Constraints,
    execution: ExecutionContext,
    protected readonly parent: BuildContextImpl
  ) {
    super(model, constraints, execution);
  }

  /** @return the scope's own declaration of `name`, or undefined where it declares none. */
  protected abstract ownDecl(name: string): IPropertyEntry | ITargetDecl | undefined;

  /** @return the scope's own match for a prefix of `name`, or undefined where none of its names is one. */
  protected abstract ownPrefixMatch(name: Name): ScopedMatch | undefined;

  /** @return true if the scope declares `name`, otherwise false. */
  protected owns(name: string): boolean {
    return this.ownDecl(name) !== undefined;
  }

  public lookupDecl(name: string): IPropertyEntry | ITargetDecl | undefined {
    return this.ownDecl(name) ?? this.parent.lookupDecl(name);
  }

  protected constrains(name: string): boolean {
    return !this.owns(name) && super.constrains(name);
  }

  public resolveTarget(name: string, stack?: IDependencyStack, callerOverrides?: Constraints): Computable<SourceRef[]> {
    return this.owns(name)
      ? super.resolveTarget(name, stack, callerOverrides)
      : this.parent.resolveTarget(name, stack, callerOverrides);
  }

  public resolvedTarget(name: string): Computable<ResolvedTarget> {
    return this.owns(name) ? super.resolvedTarget(name) : this.parent.resolvedTarget(name);
  }

  public getProperty(name: string, stack?: IDependencyStack, callerOverrides?: Constraints): Computable<Property> {
    return this.owns(name) ? super.getProperty(name, stack, callerOverrides) : this.parent.getProperty(name, stack, callerOverrides);
  }

  public getOptionalProperty(name: string, stack?: IDependencyStack): Computable<Property | undefined> {
    return this.owns(name) ? super.getOptionalProperty(name, stack) : this.parent.getOptionalProperty(name, stack);
  }

  public getPrefixTargetIfExists(
    name: Name,
    stack?: IDependencyStack
  ): { target: Computable<SourceRef[]>; rest: Name; name: string; retainedPrefix: string } | undefined {
    const match = this.ownPrefixMatch(name);
    if (match === undefined) {
      return this.parent.getPrefixTargetIfExists(name, stack);
    }
    return { target: this.resolveTarget(match.name, stack), rest: match.rest, name: match.name, retainedPrefix: match.retainedPrefix };
  }
}

/**
 * A configuration of a rule's block ({@link RuleScope}), over `parent`, the
 * configuration of the same constraints as the rule's file sees it. The
 * block's own names and the rule's parameter are looked up here, and every
 * other name in `parent`:
 * - `<param>` is the matched target, and `${<param>}` its name;
 * - `<param>.<name>` is the matched target's property `name`, read as the
 *   reader asks (files, strings, a map or command), and a `NAME;`
 *   splice of `<param>` supplies each of its properties;
 * - a target of the block resolves in the result's configuration as part of
 *   the matched target's collection where the result reaches it, and alone
 *   otherwise (a tool the block runs, or another configuration).
 *
 * In the `unresolved` configuration each of the block's targets is instead its
 * node with its requirements left unresolved ({@link RuleScope.blockTargetNode}).
 */
class ScopedBuildContext extends ScopedConfiguration {
  constructor(
    model: IBuildModel,
    constraints: Constraints,
    execution: ExecutionContext,
    private readonly scope: RuleScope,
    parent: BuildContextImpl,
    /** True in the configuration where each of the block's targets is its
     * node with its requirements left unresolved, so what they require is
     * looked up without waiting on any of them. */
    public readonly unresolved: boolean
  ) {
    super(model, constraints, execution, parent);
  }

  /** The node made for each of the block's targets in this configuration, by name. */
  private readonly blockTargetNodes = new Map<string, Computable<TargetNode>>();

  /** Where a reference to one of the block's targets in the unresolved configuration finds its node. */
  public readonly nodes: TargetSource = {
    resolvedTarget: name =>
      this.blockTargetNodes.get(name) ??
      Computable.reject(new FabrError(`internal: '${name}' is referred to before its node is made`)),
  };

  protected resolveByRule(context: DeclaredTargetContext, rule: RuleDefinition): Computable<SourceRef[]> {
    if (!(context instanceof ScopedTargetContext) || !this.scope.rule.declares(context.target)) {
      return super.resolveByRule(context, rule);
    }
    return this.scope.resultConfiguration().then((constraints): Computable<SourceRef[]> => {
      if (!this.hasConstraints(constraints)) {
        /* Outside the result's configuration a target of the block resolves alone. */
        return this.unresolved
          ? this.scope.resolveLocalTarget(declName(context.target), this.constraints, context.stack)
          : super.resolveByRule(context, rule);
      }
      if (this.unresolved) {
        const name = declName(context.target);
        const node = this.scope.blockTargetNode(context, rule, this.constraints);
        this.blockTargetNodes.set(name, node);
        return node.then((): SourceRef[] => [new TargetRef(this.nodes, name)]);
      }
      /* A target the result reaches is resolved as part of the one collection;
       * any other, a tool the block runs, resolves alone. */
      const local = declName(context.target);
      return this.holdResolved(
        context,
        this.scope.lookupBlockRequirements(context.stack).then(({ reachedTargets }) => {
          const reached = reachedTargets.get(local);
          return reached === undefined
            ? this.resolvedTargetByRule(context, rule)
            : this.resolvedWith(context, rule, this.scope.requirementsOf(local, reached));
        })
      );
    });
  }

  public getContextWithOverrides(overrides?: Constraints): BuildContextImpl {
    return this.scope.config(this.constraints.with(overrides), this.unresolved);
  }

  public inConfiguration(constraints: Constraints): BuildContextImpl {
    return this.scope.config(constraints, this.unresolved);
  }

  protected ownDecl(name: string): IPropertyEntry | ITargetDecl | undefined {
    return this.scope.rule.local(name);
  }

  /** @return true if `name` is the rule's parameter or one the block declares, otherwise false. */
  protected owns(name: string): boolean {
    return name === this.scope.param || super.owns(name);
  }

  /** @return the block's match for `name` where its first part is the parameter or one the block declares, otherwise undefined. */
  protected ownPrefixMatch(name: Name): ScopedMatch | undefined {
    const literal = name.getLiteralPathPrefix();
    const first = literal.split(/[:/]/)[0];
    if (first === "" || !this.owns(first)) {
      return undefined;
    }
    const matched = literal.substring(0, first.length + 1);
    const colon = matched.lastIndexOf(":");
    return {
      name: first,
      rest: name.substring(first.length + 1),
      retainedPrefix: colon === -1 ? matched : matched.substring(colon + 1),
    };
  }

  public inFile(file: string | undefined): BuildContextImpl {
    return file === undefined || file === this.scope.rule.decl.source.file ? this : this.parent.inFile(file);
  }

  protected targetContextFor(target: ITargetDecl, stack?: IDependencyStack): DeclaredTargetContext {
    return this.scope.rule.declares(target)
      ? new ScopedTargetContext(target, this.targetDefOf(target.type), this, stack, this.scope)
      : super.targetContextFor(target, stack);
  }

  public resolveTarget(name: string, stack?: IDependencyStack, callerOverrides?: Constraints): Computable<SourceRef[]> {
    if (name === this.scope.param) {
      return this.scope.resolveMatched(this.constraints.with(callerOverrides), stack);
    }
    return super.resolveTarget(name, stack, callerOverrides);
  }

  public getProperty(name: string, stack?: IDependencyStack, callerOverrides?: Constraints): Computable<Property> {
    if (name === this.scope.param) {
      return Computable.resolve(this.scope.matchedName());
    }
    const property = parameterProperty(name, this.scope.param);
    if (property !== undefined) {
      return this.scope.aliasedString(property, callerOverrides).then(value => {
        if (value === undefined) {
          throw new FabrError(`'${name}' has no value`);
        }
        return value;
      });
    }
    return super.getProperty(name, stack, callerOverrides);
  }

  public getOptionalProperty(name: string, stack?: IDependencyStack): Computable<Property | undefined> {
    if (name === this.scope.param) {
      return Computable.resolve(this.scope.matchedName());
    }
    const property = parameterProperty(name, this.scope.param);
    if (property !== undefined) {
      return this.scope.aliasedString(property);
    }
    return super.getOptionalProperty(name, stack);
  }

  public lookupFileValue(
    name: Name,
    stack: IDependencyStack | undefined,
    options?: {
      callerOverrides?: Constraints;
      relativeTo?: IDecl;
      provenance?: { value: INameValue; property: IPropertyDecl; target?: ITargetDecl };
    }
  ): Computable<SourceRef[]> {
    const property = parameterProperty(name, this.scope.param);
    if (property === undefined) {
      return super.lookupFileValue(name, stack, options);
    }
    /* `<param>.<property>`, then any projection into what it names. */
    const read = this.scope.aliasedFiles(property, this.constraints.with(options?.callerOverrides), requirementOf(name), stack);
    const written = `${this.scope.param}.${property}`;
    const rest = name.withConstraints([]).substring(written.length + 1);
    if (rest.isEmpty()) {
      return read;
    }
    const matched = name.getLiteralPathPrefix().substring(0, written.length + 1);
    const colon = matched.lastIndexOf(":");
    const prefix = colon === -1 ? matched : matched.substring(colon + 1);
    return read.then(
      sources => this.projectSources(sources, { pattern: rest, prefix }, undefined) as SourceRef[] | Computable<SourceRef[]>
    );
  }

  public lookupNameProperty(
    prop: IPropertyDecl,
    target?: ITargetDecl,
    stack?: IDependencyStack,
    callerOverrides?: Constraints
  ): Computable<Name[]> {
    const aliases = prop.values.map(value => (isNameValue(value) ? this.scope.wholeAlias(value.value) : undefined));
    if (aliases.every(alias => alias === undefined)) {
      return super.lookupNameProperty(prop, target, stack, callerOverrides);
    }
    /* A value that is `<param>.<property>` reads that property's values, each a name. */
    return Computable.forAll(
      prop.values.map((value, index) => {
        const alias = aliases[index];
        return alias === undefined
          ? super.lookupNameProperty({ ...prop, values: [value] }, target, stack, callerOverrides)
          : this.scope
              .aliasedString(alias, requirementOf((value as INameValue).value))
              .then(found => (found?.getValues() ?? []).map(text => Name.fromLiteral(text)));
      }),
      (...lists: Name[][]) => lists.flat()
    );
  }

  /** Look up what `splice` supplies, the rule's parameter being the matched target as a map of its properties, each read as `<param>.name`. */
  public lookupSplice(splice: ISpliceDecl, stack?: IDependencyStack): Computable<ISplicedEntry[]> {
    if (splice.ref.toString() !== this.scope.param) {
      return super.lookupSplice(splice, stack);
    }
    const site = { source: splice.source, offset: splice.offset, endOffset: splice.endOffset };
    return this.scope.matched.getPropertyNames().then(names =>
      names.map((name): ISplicedEntry => ({
        decl: {
          kind: DeclKind.Property,
          ...site,
          name: Name.fromLiteral(name),
          values: [{ kind: DeclKind.NameValue, ...site, value: Name.fromLiteral(`${this.scope.param}.${name}`) }],
        },
        context: this,
      }))
    );
  }

  public referencedProperty(ref: Name, info?: IDependencyStack): Computable<ReferencedProperty> {
    const alias = this.scope.wholeAlias(ref);
    if (alias !== undefined) {
      /* The parameter's property, set by the target or not. */
      return this.scope
        .aliasedDecl(alias, this.constraints, requirementOf(ref), info)
        .then(({ prop, context }) => ({ prop, property: true, name: ref, context }));
    }
    /* A property the block does not declare has its values looked up where the file's names are. */
    return super
      .referencedProperty(ref, info)
      .then(found =>
        found.prop !== undefined && !this.scope.rule.declaresProperty(found.prop) ? { ...found, context: this.parent } : found
      );
  }
}

/**
 * A configuration as the build file `file` sees it: the names the file
 * declares privately (`names`) are looked up here first, and every other name
 * in `parent`. A target is evaluated in `parent` ({@link targetContextFor}),
 * so the file's private names are seen only by values written in the file.
 */
class FileScopedContext extends ScopedConfiguration {
  constructor(
    model: IBuildModel,
    constraints: Constraints,
    execution: ExecutionContext,
    private readonly file: string,
    private readonly names: Namespace,
    parent: BuildContextImpl
  ) {
    super(model, constraints, execution, parent);
  }

  protected ownDecl(name: string): IPropertyEntry | ITargetDecl | undefined {
    return this.names.getDecl(name);
  }

  /** @return the file's match for a prefix of `name`: a private name where it
   *  is the longest declared prefix (a public name declared under it is matched
   *  as itself), otherwise undefined. */
  protected ownPrefixMatch(name: Name): ScopedMatch | undefined {
    const match = this.model.getPrefixMatch(name, this.file);
    return match !== undefined && this.names.getDecl(match.name) === match.decl ? match : undefined;
  }

  public inFile(file: string | undefined): BuildContextImpl {
    return file === undefined || file === this.file ? this : this.parent.inFile(file);
  }

  public getContextWithOverrides(overrides?: Constraints): BuildContextImpl {
    return this.parent.getContextWithOverrides(overrides).inFile(this.file);
  }

  public inConfiguration(constraints: Constraints): BuildContextImpl {
    return this.parent.inConfiguration(constraints).inFile(this.file);
  }

  protected targetContextFor(target: ITargetDecl, stack?: IDependencyStack): DeclaredTargetContext {
    return new DeclaredTargetContext(target, this.targetDefOf(target.type), this.parent, stack);
  }
}

/** Wait for each of `references` that is a Computable, and @return them all in order, flattened. */
function had(
  references: ReadonlyArray<SourceRef | Unbuilt | Computable<Array<SourceRef | Unbuilt>>>
): Computable<Array<SourceRef | Unbuilt>> {
  return Computable.forAll(
    references.map(reference =>
      reference instanceof Computable ? reference : Computable.resolve<Array<SourceRef | Unbuilt>>([reference])
    ),
    (...held: Array<Array<SourceRef | Unbuilt>>) => held.flat()
  );
}
