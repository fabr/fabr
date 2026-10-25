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
import { FSFileSource } from "../core/FSFileSource";
import { isRepository, Materialized, ProjectedPackage, renamedAs, RepositoryRef, SourceRef } from "../core/Repository";
import { ResolutionContext } from "../resolver/Types";
import { PERMISSIVE_RESOLUTION } from "./CollectionPoint";
import { materializeShallow, resolveLists } from "./CollectionPoint";
import { FileSetRef, FileSourceRef } from "../core/FileSetRef";
import { TargetRef, Unbuilt } from "../core/TargetRef";
import { ResolvedTarget } from "./ResolvedTarget";
import { NamespaceRef } from "../core/NamespaceRef";
import { IProjection, Reference } from "../core/Reference";
import { registerReferenceStep } from "../core/Provenance";
import {
  Permissive,
  Requirements,
  resolveRequirements,
  unmaterialized,
} from "./Collection";
import { RunnableFileSet, toRunnable } from "../core/RunnableFileSet";
import { PackageFileSet, ResolvedNode } from "../core/PackageFileSet";
import { BuildAction, BuildResult } from "../core/BuildAction";
import { RuleDefinition, RuleResult, RepositoryProvider, SubTargetInputs } from "../rules/Types";
import { BUILD_OPERATION, Constraints, RUN_OVERRIDE } from "../model/Constraints";
import { TaskDescription } from "../model/BuildEvents";
import { ExecutionContext } from "../model/ExecutionContext";
import {
  CommandPipeline,
  DeclKind,
  declPosn,
  hasMapValue,
  ICommandStage,
  IDecl,
  IMapItemDecl,
  INamespaceDecl,
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
  soleDecl,
} from "../model/AST";
import { EXPAND_TAG, expandOnce, findWithDescent } from "../support/Expand";
import {
  DependencyFailedError,
  NameResolutionError,
  NoRuleFoundError,
  ReferenceFailedError,
} from "../model/Errors";
import { ConflictError, FabrError, IConflictSide, IConflictSource, toError } from "../core/Errors";
import { createPipelineAction, stagePipeline } from "../rules/PipelineAction";
import { closestMatch } from "../support/Suggest";
import { Name, NameConstraint, NamePart, NamePartKind } from "../core/Name";
import { globMatcher } from "../support/Glob";
import { parseName } from "../model/Parser";
import { IPrefixMatch, IPropertyEntry } from "../model/Namespace";
import { Property } from "../model/Property";
import { IModelStep, ISubstitution, MODEL_PROVENANCE } from "../model/ModelProvenance";
import { BuildContext, InternalBuildContext } from "./BuildContext";
import { mergeMapInto, PropertyMap, PropertyMapValue, recordMapOrigin } from "./PropertyMap";
import { IDependencyStack, IUseFrame, useFrameOf, useSiteOf } from "./Stack";
import { NameLabel, ReferenceLabel } from "../model/Errors";
import { IRuleSelection, selectRule } from "./RuleSelection";
import { DeclaredResolvedTarget } from "./ResolvedTarget";
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
import { AnonymousTargetContext, DeclaredTargetContext, TargetContext } from "./TargetContext";

/** Attach a name's remedies to its error as the `help:` line, if there are any. */
function withHints<T extends FabrError>(err: T, hints: string[]): T {
  return hints.length > 0 ? err.withHelp(hints.join("; ")) : err;
}

interface IBuildModel {
  getConfig(constraints: Constraints, execution: ExecutionContext): BuildContext;
  getDecl(name: string): IPropertyEntry | ITargetDecl | INamespaceDecl | undefined;
  getTargetDef(name: string): ITargetDefDecl | undefined;
  getPrefixMatch(name: Name): IPrefixMatch | undefined;
  /** Name enumerations, for nearest-match suggestions and for recognizing a marked target name. */
  getTargets(): { name: string; decl: ITargetDecl }[];
  getProperties(): { name: string; decl: IPropertyDecl }[];
  /** The rule tables and repository providers, built per load from the contributions of core
   * and the active plugins. */
  getTargetRules(type: string): RuleDefinition[];
  getDefaultRules(): RuleDefinition[];
  getRepositoryProvider(type: string): RepositoryProvider | undefined;
}

/**
 * Report `err`, a failure of what a written reference names, as the
 * reference's: a referenced target's failure crossing it records the use site,
 * so the driver can render the dependant chain as "required by <target>
 * <property>" against the written value, and a conflict gets the reference's
 * step on both sides, so the driver traces it back to the written value.
 */
function failureOfReference(step: IModelStep, err: Error): Error {
  if (err instanceof DependencyFailedError || err instanceof NoRuleFoundError) {
    return new ReferenceFailedError(step.value, step.property, step.target, err);
  }
  if (err instanceof ConflictError) {
    const chain = (side: IConflictSide): IConflictSource => ({ provenance: { ...step, parent: side.provenance }, detail: side.detail });
    return new ConflictError(err.kind, err.key, chain(err.left), chain(err.right));
  }
  return err;
}

registerReferenceStep(MODEL_PROVENANCE, {
  failure: (step, err) => failureOfReference(step as IModelStep, err),
  label: step => new ReferenceLabel({ value: (step as IModelStep).value, property: (step as IModelStep).property, target: (step as IModelStep).target }),
});

/**
 * The BuildModel instantiated with a set of constraints (possibly empty): the implementation of
 * both {@link BuildContext} and {@link InternalBuildContext}, where names are looked up and
 * targets resolved and evaluated.
 */
export class BuildContextImpl implements InternalBuildContext {
  public readonly execution: ExecutionContext;
  protected readonly constraints: Constraints;
  private readonly model: IBuildModel;
  private propCache: Map<string, Computable<Property | undefined>>;
  private targetCache: Map<string, Computable<SourceRef[]>>;
  /** The rule-built targets of this configuration, resolved, by name. A
   * target's entry in `targetCache` is the reference to it. */
  private readonly resolvedTargets = new Map<string, Computable<DeclaredResolvedTarget>>();

  constructor(model: IBuildModel, constraints: Constraints, execution: ExecutionContext) {
    this.model = model;
    this.constraints = constraints;
    this.execution = execution;
    this.propCache = new Map();
    this.targetCache = new Map();
    // A name the constraints give a value reads as that value.
    for (const [key, value] of constraints) {
      this.propCache.set(key, Computable.resolve(new Property([value])));
    }
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
   * Get this context as the {@link ResolutionContext} of a collection point
   * entered from the build context itself (`materialize`, `resolve`, a command
   * substitution's tools), named `name`. A target's collection points pass
   * the TargetContext, which satisfies the interface directly.
   */
  private resolutionContext(name = "<command line>"): ResolutionContext {
    return {
      name,
      getGlobalString: name => this.getProperty(name).then(prop => prop.toString()),
      memoize: (tag, key, create) =>
        this.getCachedOrBuild(`memo:${tag} ${key}`, ctx => create(ctx.workDir).then(result => ({ result }))),
      runTask: (task, run) => this.execution.runTask(task, run),
    };
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
      /* A runnable's projection selects an entry rather than files, so the walk
       * does not apply to it: collapse instead. An empty result then meets the
       * same literal-must-resolve judgment as any other projection below. */
      result = Computable.resolve(toRunnable(ref) ?? EMPTY_FILESET);
    } else {
      /* The constructor guarantees at least one projection, so the fold's seed
       * is always the walk over the base. */
      const [first, ...narrowing] = ref.projections;
      result = this.findWithDescent(ref.source, first.pattern, first.prefix);
      for (const projection of narrowing) {
        result = result.then(files => this.findWithDescent(files, projection.pattern, projection.prefix));
      }
    }
    if (ref.miss) {
      /* A ref carries a `miss` only where an empty result is an error: that was
       * judged over the whole written name where the ref was built (see
       * lookupSubstituted). */
      result = result.then(files => {
        if (files.isEmpty()) {
          throw ref.miss!();
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
   * Apply `projection` to `sources`, the sources one name reached: a reference
   * or a package is narrowed, a node gets the projection pending over it, and
   * a container is projected now, descending into archives. `miss` is the
   * error for a literal that selects nothing, judged over all the containers
   * together and only where no reference might still supply the name.
   * `repositoryName` is how a repository among them was written.
   */
  public projectSources(
    sources: Array<SourceRef | Unbuilt>,
    projection: IProjection,
    miss: (() => Error) | undefined,
    repositoryName?: string
  ): Array<SourceRef | Unbuilt> | Computable<Array<SourceRef | Unbuilt>> {
    const { pattern, prefix } = projection;
    const references: Array<SourceRef | Unbuilt> = [];
    const containers: FileSource[] = [];
    for (const source of sources) {
      if (source instanceof TargetRef) {
        /* Projected as what it yields, once it does: the error for a literal selecting nothing goes
         * with it where the name reached nothing else. */
        references.push(source.find(pattern, prefix, sources.length === 1 ? miss : undefined));
      } else if (source instanceof ResolvedNode) {
        /* A node not yet materialized projects as a package in hand does (below): the projection
         * pends over it. */
        references.push(new ProjectedPackage(source, [projection], miss));
      } else if (source instanceof ProjectedPackage) {
        references.push(new ProjectedPackage(source.base, [...source.projections, projection], miss));
      } else if (source instanceof RepositoryRef || source instanceof FileSetRef) {
        references.push(source.find(pattern, prefix));
      } else if (source instanceof NamespaceRef) {
        /* The rest is a requirement identifier followed by an optional projection into the
         * delivered content — the repository vends the ref for the whole name: its identity portion
         * claimed (`esbuild:0.28.1`), the remainder packed in as a projection into the resolved
         * package (`:package.json`), riding the normal find/naming path (any rename facet rides the
         * projection). The written-name rule applies to the projection, not to the requirement
         * itself. */
        /* Stamp the alias the repository was reached by, as written — how the resolution layer
         * renders suggestions and progress in the user's own spelling. */
        references.push(source.getRepositoryRef(pattern, repositoryName));
      } else if (source instanceof PackageFileSet || source instanceof RunnableFileSet) {
        /* A projection into a package or a runnable defers as a FileSetRef, keeping a package's
         * identity and a runnable's launch machinery (its projection names an entry, not files).
         * The base's class decides how the ref collapses when something is demanded of it; an
         * ordinary consumer sees the projected files at its collection point, with this site's miss
         * error for a literal that matches nothing. */
        references.push(new FileSetRef(source, [projection], miss));
      } else {
        /* A container projects on its own terms (FileSource.find): a fileset filters + prefixes (or
         * renames, per the facet). */
        containers.push(source);
      }
    }
    if (containers.length === 0) {
      return references;
    }
    /* Each container projects separately and stays a separate source: only a consumer that merges
     * content unions it. Each projection is applied now through applyProjection, with no miss of
     * its own: the literal-must-resolve judgment is made below, over all the containers together,
     * and only where no reference might still deliver the name. Containers the projection missed
     * are dropped, and one empty set is kept when nothing matched, so the driver can report
     * "matched no files". */
    return Computable.forAll(
      containers.map(container => this.applyProjection(new FileSourceRef(container, [projection]))),
      (...projected: FileSet[]) => projected
    ).then(projected => {
      const matched = projected.filter(set => !set.isEmpty());
      if (matched.length === 0 && references.length === 0 && miss) {
        throw miss();
      }
      return [...references, ...(matched.length > 0 ? matched : [EMPTY_FILESET])];
    });
  }

  /**
   * File a node for `name` that runs `compute` when first depended on, so that
   * a request for `name` made while it is computed, however indirectly,
   * depends on that node.
   */
  private answer(name: string, target: ITargetDecl | undefined, compute: () => Computable<SourceRef[]>): Computable<SourceRef[]> {
    const result = Computable.detached(compute).labelled(new NameLabel(name, target));
    this.targetCache.set(name, result);
    return result;
  }

  /** Check whether this is the configuration of exactly `constraints`. */
  public hasConstraints(constraints: Constraints): boolean {
    return this.constraints.equals(constraints);
  }

  public getContextWithOverrides(overrides?: Constraints): BuildContextImpl {
    /* The model makes its configurations of this class and no other. */
    return this.model.getConfig(this.constraints.with(overrides), this.execution) as BuildContextImpl;
  }

  public getConstraint(name: string): string | undefined {
    return this.constraints.get(name);
  }

  public getConstraints(): Constraints {
    return this.constraints;
  }

  private guardAdmits(guard: readonly NameConstraint[] | undefined, stack?: IDependencyStack): Computable<boolean> {
    if (!guard) {
      return Computable.resolve(true);
    }
    return Computable.forAll(
      guard.map(([key, pattern]) => this.getProperty(key, stack).then(value => this.patternAdmits(pattern, value, stack))),
      (...admitted: boolean[]) => admitted.every(match => match)
    );
  }

  /** Check whether a guard's `pattern`, substituted, matches the property
   * `value` it is written against. */
  private patternAdmits(pattern: Name, value: Property, stack?: IDependencyStack): Computable<boolean> {
    return this.substituteNameVars(pattern, stack).then(substituted => globMatcher(substituted.toGlobString())(value.toString()));
  }

  /** Select the rule that builds `target`, a target of `type`, in this
   * configuration: see {@link selectRule}. */
  private selectRule(type: string, target: TargetContext): Computable<IRuleSelection> {
    return selectRule(this.model.getTargetRules(type), this.model.getDefaultRules(), type, target, {
      read: (key, stack) => this.getOptionalProperty(key, stack),
      admits: (pattern, value, stack) => this.patternAdmits(pattern, value, stack),
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
      /* Nothing is guarded, so there is nothing to decide: every declaration
       * applies, and the tier rule alone picks between them — with no property
       * read. */
      return Computable.resolve(decls.length > 0 ? decls : defaults);
    }
    /* The property being judged is a stack frame while its guards read other
     * properties, so that what a guard reads is attributed to it. The use
     * site is the guarded declaration's own key; `owner` (a target body's
     * property) rides as the frame's target. */
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
        candidates.map(candidate => this.guardAdmits(candidate.name.getConstraints(), frame)),
        (...admitted: boolean[]) => {
          /* An ordinary declaration displaces a `default` one only where it
           * applies, so the tiers are judged in order: the defaults answer
           * exactly when nothing ordinary matched. */
          const matched = candidates.filter((_, i) => admitted[i]);
          const ordinary = matched.filter(candidate => decls.includes(candidate));
          return ordinary.length > 0 ? ordinary : matched;
        }
      ).labelled(new ReferenceLabel({ value: frame.value, property: guarded, target: owner }));
    } catch (err) {
      /* A guard reading an unknown property throws where it is built, not where
       * it settles. */
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
   * Get the help for a name nothing declares: the declared target or property
   * nearest to the part before any `:` projection. A name written on the
   * command line also gets a pointer to `fabr list-targets`.
   */
  private unknownNameHints(written: string, onCommandLine: boolean): string[] {
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
      /* As in resolveTarget: a caller's override outranks a `<k=v>` requirement on the
       * property's value (ambient < requirement < caller), so for a declared property it
       * is passed into the value's lookup rather than added to the ambient constraints.
       * A name the constraints supply is read from the overridden context. Uncached. */
      if (!this.constraints.has(name)) {
        const def = this.model.getDecl(name);
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
    const def = this.model.getDecl(name);
    const entry = def?.kind === DeclKind.Property ? def : undefined;
    if (!entry && !this.propCache.has(name)) {
      const reason = def
        ? `'${name}' names a ${def.kind === DeclKind.Target ? "target" : "namespace"}, not a property`
        : `Unknown property '${name}'`;
      const nearest = def ? undefined : closestMatch(name, this.model.getProperties().map(prop => prop.name));
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
  private getOptionalProperty(name: string, stack?: IDependencyStack): Computable<Property | undefined> {
    const cached = this.propCache.get(name);
    if (cached) {
      /* Already seen */
      return cached;
    }
    const def = this.model.getDecl(name);
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
      /* A caller's override outranks a `<k=v>` requirement written on a
       * property's value (ambient < requirement < caller, see lookupContextFor),
       * so for a property it is passed into the value's lookup rather than added
       * to the ambient constraints. A name the constraints supply and a target
       * are resolved by the overridden context, whose targetCache memoizes them.
       * The property case is uncached, since targetCache keys by bare name; the
       * targets it references stay memoized in their own configurations. */
      const def = this.model.getDecl(name);
      if (!this.constraints.has(name) && def?.kind === DeclKind.Property) {
        /* The fallback is a target, which no written requirement fights. */
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
    } else if (this.constraints.has(name)) {
      /* A constraint overrides how the name resolves — to files as well as to a
       * string (`${name}`, via the pre-forced propCache): resolve the override
       * value as a reference in place of the declared property/target. Parsed as
       * a full reference (not a bare literal), so `-Dchai=@npm:chai:5.0.0` repins
       * a dependency written as a bare `chai`, and a `:`/`<k=v>` on the override
       * is honoured as it would be in a script. */
      return this.answer(name, undefined, () => this.lookupFileValue(parseName(this.constraints.get(name)!), stack));
    } else {
      const def = this.model.getDecl(name);
      if (def?.kind === DeclKind.Target) {
        return this.answer(name, def, () => this.resolveTargetDecl(def, stack));
      } else if (def?.kind === DeclKind.Property) {
        return this.answer(name, undefined, () => this.resolveProperty(name, def, stack, target => this.resolveTargetDecl(target, stack)));
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
    if (this.constraints.has(written)) {
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
   * naming the use `expects` ("a string", "files"); Validate does not check
   * default and top-level properties or sync coordinates.
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
    return this.lookupValues(prop, target, stack, "a string", (value, info) =>
      this.lookupStringValue(value.value, info, callerOverrides)
    );
  }

  /**
   * Look up one written value in a STRING context as its substituted Name. No
   * reference is resolved and no provenance is stamped, but the value's
   * `<k=v>` requirement and any caller override apply as for
   * {@link lookupFileValue} (ambient < requirement < caller, see
   * {@link lookupContextFor}). The Name keeps its rename facet, for REWRITE and
   * projection readers.
   */
  private lookupStringValue(name: Name, info: IDependencyStack, callerOverrides?: Constraints): Computable<Name> {
    return this.getContextWithOverrides(callerOverrides).substituteNameVars(name, info, callerOverrides);
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
      /* Inline form: one block (Validate enforces this for schema'd properties;
       * re-checked here for shared globals, which never pass a targetdef). */
      if (prop.values.length > 1) {
        return Computable.reject(
          new FabrError(`'${prop.name}' must be a single \`{ ... }\` block or bare reference(s), not a mix`)
        );
      }
      const block = prop.values[0];
      return this.lookupMapBlock(isMapValue(block) ? block.entries : [], target, stack, nextSeen, callerOverrides);
    }
    /* Reference form: each value names a block-valued property (resolved
     * recursively under this context, so a shared map's `${...}` sees the
     * consuming build's config), merged left-to-right with later winning; each
     * merged entry's origin gains the written reference as a via-hop. */
    return Computable.forAll(
      prop.values
        .filter(isNameValue)
        .map(value =>
          this.lookupMapReference(
            value.value,
            { property: prop, target, value, next: stack },
            stack,
            nextSeen,
            callerOverrides
          ).then((map): [PropertyMap, INameValue] => [map, value])
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
    return this.referencedProperty(name, info).then(({ prop, name: substituted }) => {
      if (!prop) {
        throw new FabrError(`'${substituted.toString()}' does not name a map property`);
      }
      return this.lookupMapDecl(prop, undefined, stack, seen, callerOverrides);
    });
  }

  /** Look up one block's items in written order: a `key = value;` entry sets its
   * key (strings joined to one string; nested blocks to a sub-map, several to a
   * list of sub-maps — mixing rejected, statically for schema'd properties and
   * re-checked here for shared globals); a `NAME;` splice merges the named map's
   * entries in at that position. Later values win. Each entry records its ghost
   * origin (the written decl, plus via-hops for splices). */
  private lookupMapBlock(
    entries: IMapItemDecl[],
    target: ITargetDecl | undefined,
    stack: IDependencyStack | undefined,
    seen: Set<IPropertyDecl>,
    callerOverrides?: Constraints
  ): Computable<PropertyMap> {
    return Computable.forAll(
      entries.map((item): Computable<PropertyMapValue | PropertyMap> => {
        if (item.kind === DeclKind.MapSplice) {
          return this.lookupMapReference(item.ref, stack, stack, seen, callerOverrides);
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
          if (item.kind === DeclKind.MapSplice) {
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

  public lookupWildcardProperties(
    props: IPropertyDecl[],
    stack?: IDependencyStack,
    callerOverrides?: Constraints
  ): Computable<{ key: Name; decl: IPropertyDecl }[]> {
    const context = this.getContextWithOverrides(callerOverrides);
    return Computable.forAll(
      props.map(prop => context.guardAdmits(prop.name.getConstraints(), stack)),
      (...admitted: boolean[]) => props.filter((_, i) => admitted[i])
    ).then(members =>
      Computable.forAll(
        members.map(prop => context.substituteNameVars(prop.name.withConstraints([]), stack)),
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
    /* A property value roots bare paths at its own decl; an explicit relativeTo
     * (a stdin redirect) overrides. */
    const relativeTo = options?.relativeTo ?? provenance?.property;
    /* Judged on the name as written: a `${NAME}` or a `` `cmd` `` part makes
     * it no literal target name, whatever text it substitutes to. */
    const substituted = name.getSubstitutions().length > 0;
    /* A value written as `ref<k=v>` resolves under this context overridden by its
     * requirement, so the referenced target builds under those constraints and the
     * model step (stamped by that context) records them. */
    return this.lookupContextFor(name, options?.callerOverrides, stack).then(({ context, reference, substitutions }) => {
      const resolved = context.lookupFileSource(reference, relativeTo, stack, substituted);
      if (!provenance) {
        return resolved;
      }
      const { value, property, target } = provenance;
      /* A failure looking the value up is the reference's. A target's own
       * failure is reported as the reference's when the target is built, by
       * the step stamped on it. */
      const step = context.modelStep(value, property, target, substitutions);
      return resolved
        .then(sources => sources.map(source => context.withModelStep(source, step)))
        .catch((err: Error): never => {
          throw failureOfReference(step, err);
        });
    });
  }

  /**
   * Get the context a reference is looked up under, the reference fully
   * substituted with its `<k=v>` stripped, and the substitutions made.
   * Constraints layer lowest to highest as ambient (this), the reference's own
   * `<k=v>` requirement, then the caller's override, so a consumer's explicit
   * override (a rule forcing `BUILD_OPERATION=run` on a tool) wins over a
   * requirement on the same key.
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
      const required: Record<string, string> = Object.create(null);
      for (const [key, value] of substituted.getConstraints()) {
        required[key] = value.toString();
      }
      /* Caller override last, so it wins on a shared key. */
      const merged = Constraints.of(required).with(callerOverrides);
      return { context: this.getContextWithOverrides(merged), reference: substituted.withConstraints([]), substitutions };
    });
  }

  public modelStep(value: INameValue, property: IPropertyDecl, target?: ITargetDecl, substitutions?: readonly ISubstitution[]): IModelStep {
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

  public materialize(ref: INameValue, stack?: IDependencyStack): Computable<FileSource[]> {
    /* Under `run` the name IS the program, so its closure is a sealed install. */
    const options = this.constraints.get(BUILD_OPERATION) === "run" ? PERMISSIVE_RESOLUTION : undefined;
    return this.lookupFileValue(ref.value, stack, { relativeTo: ref })
      .then(sources => materializeShallow(this.resolutionContext(), sources, options))
      .then(delivered => this.applyProjections(delivered));
  }

  /** Look up the sources `name` names. `substituted` says the name as written
   * made substitutions, so it cannot be a marked target's literal name. */
  private lookupFileSource(name: Name, relativeTo: IDecl | undefined, stack?: IDependencyStack, substituted = false): Computable<SourceRef[]> {
    return this.substituteNameVars(name, stack).then((substName): SourceRef[] | Computable<SourceRef[]> => {
      /* A `?` or `!` ending what is otherwise the literal name of a target
       * is a marker on the reference (`foo?` / `foo!`), consumed by the
       * collection it is written in, as one on a version is. Anywhere else a
       * `?` is part of a pattern. */
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

  /** Look up the sources `substName` names, its substitutions already made. */
  private lookupSubstituted(substName: Name, relativeTo: IDecl | undefined, stack?: IDependencyStack): SourceRef[] | Computable<SourceRef[]> {
    if (substName.isEmpty()) {
      return [];
    }
    const targetDep = this.getPrefixTargetIfExists(substName, stack);
    if (targetDep) {
      const { target, rest, name: matchedName, retainedPrefix } = targetDep;
      if (rest.isEmpty()) {
        /* Nothing to project, so a `-> name` here renames what the whole
         * reference delivers: the package rename, the same rule a delivered
         * external one goes through, applied to what the target yields. */
        const renameTo = substName.getRenameTo()?.toString();
        return target.then(sources =>
          renameTo === undefined ? sources : sources.map(source => renamedAs(source, renameTo, substName.toString()))
        );
      } else {
        /* `rest` is the projection after the target; a `sel -> tmpl` rename
         * (final naming) rides on it as a facet (getPrefixMatch/getRepositoryRef
         * carry it through the split — see Name.substring), so find applies it
         * with no special handling here (the rename target's names supersede
         * retainedPrefix). Names into a repository become references, deferred
         * until the consuming collection point resolves them jointly (and
         * finding into an existing reference narrows it); container sources
         * answer immediately. Result names follow the written-name rule: a
         * slash-form reference keeps the written prefix, a colon-form
         * reference strips it. */
        const project = (
          t: Array<SourceRef | Unbuilt>,
          miss: (() => Error) | undefined
        ): Array<SourceRef | Unbuilt> | Computable<Array<SourceRef | Unbuilt>> =>
          this.projectSources(t, { pattern: rest, prefix: retainedPrefix }, miss, matchedName);
        /* The literal-must-resolve error, when it applies here: only in a
         * property context (a CLI name reports through the driver's
         * "matched no files") and only when the WHOLE written name is
         * literal. Judged over `substName`, not over the projection: a
         * glob anywhere earlier (the part that chose the container) means
         * this step is applied to whatever that matched, so its finding
         * nothing is no more an error than the glob matching nothing. */
        const miss =
          relativeTo && !substName.hasGlob()
            ? (): Error => new NameResolutionError(substName, declPosn(useFrameOf(stack)?.value ?? relativeTo), useSiteOf(stack))
            : undefined;
        return target.then(reached => project(reached, miss) as SourceRef[] | Computable<SourceRef[]>);
      }
    } else if (relativeTo) {
      /* Not an identified target; check the filesystem relative to the file
       * the reference is written in. `Name.relativeTo` joins the build-file's
       * dir as a `:` alias — it *locates* the files (works equally for a
       * project-relative dir and a contributed lib file's absolute one), and
       * `find`'s own projection strips it, so results carry their written
       * names directly: `./astro.config.mjs` in `docs/BUILD.fabr` is the file
       * `astro.config.mjs`, not `docs/astro.config.mjs`. A reference climbing
       * out of its dir (`../scripts/gendoc.ts`, a tool a level up) flattens
       * to its tail (`scripts/gendoc.ts`): a flat sandbox has no "above", so
       * the leading `../` strips under FileSet name canonicalization
       * — which also makes two files flattening to one name a
       * checked conflict, not a silent drop. */
      /* A projection over the source filesystem, applied now, with the
       * literal-must-resolve error as its `miss`. A literal naming neither a
       * declaration nor a file is a failed value lookup when written in a
       * build file; typed on the command line (no use frame) it reads and is
       * helped as resolveTarget's `Unknown name` is. */
      const miss = substName.hasGlob()
        ? undefined
        : (): Error => {
            const written = substName.toString();
            const frame = useFrameOf(stack);
            const reason = frame ? undefined : `Unknown name '${written}'`;
            return withHints(
              new NameResolutionError(substName, declPosn(frame?.value ?? relativeTo), useSiteOf(stack), reason),
              this.unknownNameHints(written, !frame)
            );
          };
      /* Express the pattern in the source's own root-relative namespace up
       * front — `find` would rebase internally anyway, but the walker's
       * boundary probes and mounts must live in the same space, or a
       * reference in an absolutely-rooted build file (a plugin's
       * contributed lib) would silently never descend. */
      const fs = relativeTo.source.fs;
      let pattern = substName.relativeTo(relativeTo.source.file);
      if (fs instanceof FSFileSource) {
        pattern = pattern.rebase(fs.root);
      }
      return this.applyProjection(new FileSourceRef(fs, [{ pattern, prefix: "" }], miss)).then(data => [data]);
    } else {
      /* The one reference with no decl to root a bare path at: a constraint
       * override's value (see resolveTarget), whether it came from `-D` or a
       * `<k=v>` requirement — a constraint set carries the value, never where it
       * was written. Only a declared name can answer here. */
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

  /** Get one substituted part's text: a property's value, or a command's
   * stdout. Two identically-written commands run once between them, since they
   * key the same action, which the build cache serves from one in-flight
   * attempt. */
  private substitutedText(
    part: NamePart,
    stack?: IDependencyStack,
    callerOverrides?: Constraints
  ): Computable<{ text: string; substitution?: ISubstitution }> {
    if (part.kind === NamePartKind.CommandSubst) {
      return this.runCommandSubst(part, stack).then(text => ({ text }));
    }
    const read = (context: BuildContextImpl): Computable<{ text: string; substitution?: ISubstitution }> =>
      context.getProperty(part.value, stack, part.constraints === undefined ? undefined : callerOverrides).then(prop => ({
        text: prop.toString(),
        substitution: { name: part.value, value: prop.toString(), origin: prop.origin },
      }));
    if (part.constraints === undefined) {
      return read(this);
    }
    /* `${NAME<k=v>}`: NAME is read under the requirement, whose values are
     * substituted here first. */
    const constraints = part.constraints;
    return Computable.forAll(
      constraints.map(([, value]) => this.substituteNameVars(value, stack, callerOverrides)),
      (...values: Name[]) => {
        const required: Record<string, string> = Object.create(null);
        constraints.forEach(([key], i) => (required[key] = values[i].toString()));
        return Constraints.of(required);
      }
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
   * Run a resolved pipeline and return its stdout as text: stage it exactly as
   * `generate` does, run it as an ordinary build action — so the value is keyed,
   * cached, deduped in flight and reported like any other work — and normalize
   * the bytes ({@link normalizeCommandOutput}).
   *
   * The action belongs to no target (see {@link runOwnAction}) and stages no
   * `srcs`: the pipeline's inputs are whatever its own stages carry.
   * `written` labels the work.
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
      callerOverrides: RUN_OVERRIDE,
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
   * Look up the property a bare reference names, if any: substitute its
   * variables (positioned via `info`), then look the result up. Used to chase a
   * map reference (`metadata = SHARED`) or a command reference
   * (`run = shared_cmd`); each caller decides what a non-property result means.
   * `name` is the substituted reference, for the caller's message.
   */
  private referencedProperty(ref: Name, info?: IDependencyStack): Computable<{ prop?: IPropertyDecl; name: Name }> {
    return this.substituteNameVars(ref, info).then(name => {
      const def = this.model.getDecl(name.toString());
      if (def?.kind !== DeclKind.Property) {
        return { prop: undefined, name };
      }
      /* A chased map/command property is a single value, so it selects like one
       * — and a name whose declarations all guard it out reads as "not a
       * property here", which is what each caller's own fallback is for. */
      return this.getAvailableDecls(def, info).then(applicable => ({ prop: soleDecl(applicable), name }));
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
    /* A sole bare name may reference another command-valued property (chased via
     * the shared referencedProperty primitive — the same reference resolution a
     * map reference uses); else it is a plain `cmd args…` single stage. */
    if (names.length === 1) {
      const value = names[0];
      const info: IUseFrame = { property: prop, target, value, next: stack };
      const nextSeen = new Set(seen).add(prop);
      return this.referencedProperty(value.value, info).then(({ prop: ref }) =>
        ref ? this.getCommandPipeline(ref, undefined, stack, nextSeen) : Computable.resolve<CommandPipeline>([{ command: value, args: [] }])
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
    /* A command substitution can sit in a value with no owning property decl (a
     * global's), and the stack frame is built *from* that decl — so with none,
     * the caller's stack stands as the attribution and only the per-name span is
     * lost, which the written value itself already carries. */
    const position = (value: INameValue): Computable<IPositionedName> =>
      this.substituteNameVars(value.value, prop ? { property: prop, target, value, next: stack } : stack).then(
        name => ({ name, ref: value })
      );
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
  private targetDefOf(type: string): ITargetDefDecl {
    const targetDef = this.model.getTargetDef(type);
    if (!targetDef) {
      throw new FabrError("Targetdef '" + type + "' not found"); /* Can't happen due to earlier checks */
    }
    return targetDef;
  }

  /** Select the rule that builds the target `context` evaluates, of `type`,
   * or throw the error `noRule` makes where none applies. */
  private ruleFor(type: string, context: TargetContext, noRule: (selection: IRuleSelection) => Error): Computable<RuleDefinition> {
    return this.selectRule(type, context).then(selection => {
      if (!selection.rule) {
        throw noRule(selection);
      }
      return selection.rule;
    });
  }

  /** Make the context the declared target `target` is evaluated in, with the
   * target on the stack as under evaluation, and select its rule. */
  private declaredRule(target: ITargetDecl, stack?: IDependencyStack): Computable<{ context: DeclaredTargetContext; rule: RuleDefinition }> {
    const context = new DeclaredTargetContext(target, this.targetDefOf(target.type), this, { evaluating: target, next: stack });
    const noRule = ({ candidates }: IRuleSelection): Error => new NoRuleFoundError(target, this.constraints, candidates);
    return this.ruleFor(target.type, context, noRule).then(rule => ({ context, rule }));
  }

  private resolveTargetDecl(target: ITargetDecl, stack?: IDependencyStack): Computable<SourceRef[]> {
    /* Repositories are not rule-built targets: the provider constructs the
     * instance lazily, interned per context via the target cache. No build
     * events, no build-cache entries of its own. */
    const provider = this.model.getRepositoryProvider(target.type);
    if (provider) {
      const context = new DeclaredTargetContext(target, this.targetDefOf(target.type), this, stack);
      return provider(context).then(
        (provided): SourceRef[] => [isRepository(provided) ? new NamespaceRef(provided, "", undefined, context.name) : provided],
        err => {
          throw new DependencyFailedError(target, err);
        }
      );
    }
    return this.declaredRule(target, stack).then(({ context, rule }): Computable<SourceRef[]> => {
      if (rule.value) {
        return this.evaluateTarget(context, rule);
      }
      /* Resolved here, where the target is referenced: every requirement read, and
       * the lot resolved as one collection — versions selected and the graph
       * wired, nothing fetched or built. What that fails with (a cycle, a
       * name that resolves to nothing, versions that cannot be reconciled)
       * is the target's failure. */
      const resolved = statedRequirements(context, rule)
        .then(required =>
          resolveRequirements(context, required).then(parts =>
            DeclaredResolvedTarget.of(context, parts, () => this.evaluateTarget(context, rule, parts))
          )
        )
        .catch(err => {
          throw context.failure(err);
        });
      this.resolvedTargets.set(context.name, resolved);
      /* What asks for the target: the reference to it, nothing written on it. */
      return resolved.then((): SourceRef[] => [new TargetRef(this, context.name)]);
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
    return this.lookupContextFor(ref.value).then(({ context, reference }) => {
      const name = reference.toString();
      return (
        context.constraints.has(name) ||
        this.model.getDecl(name) !== undefined ||
        (!substituted && this.markedTarget(reference) !== undefined)
      );
    });
  }

  /**
   * Get the marker `name` ends with, and the name without it, where the rest
   * is literally the name of a declared target (`foo!`); undefined otherwise.
   */
  private markedTarget(name: Name): { override: "force" | "alternate"; unmarked: Name } | undefined {
    const override = name.getMarker();
    if (override === undefined) {
      return undefined;
    }
    const unmarked = name.withoutMarker();
    const text = unmarked.toBaseString();
    return text !== "" && this.model.getTargets().some(target => target.name === text) ? { override, unmarked } : undefined;
  }

  public getAction(ref: INameValue, stack?: IDependencyStack): Computable<BuildAction | undefined> {
    return this.lookupContextFor(ref.value, undefined, stack).then(({ context, reference }) =>
      context.actionOfTarget(reference.toString(), stack)
    );
  }

  private actionOfTarget(name: string, stack?: IDependencyStack): Computable<BuildAction | undefined> {
    const def = this.model.getDecl(name);
    if (def?.kind !== DeclKind.Target) {
      throw new FabrError(`'${name}' is not a target that runs a command`);
    }
    return this.declaredRule(def, stack).then(({ context, rule }) => {
      /* A value is content: nothing of it is built. */
      if (rule.value) {
        return undefined;
      }
      /* Where the target was referenced it was resolved, and that is read;
       * one asked for its action alone is resolved here. */
      const resolved = this.resolvedTargets.get(context.name)?.then(target => target.resolved);
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

  public resolve(ref: INameValue, stack?: IDependencyStack): Computable<ResolvedRequirements> {
    return this.lookupFileValue(ref.value, stack, { relativeTo: ref }).then(sources =>
      /* The lot is one requirement, unnamed, resolved as one collection: a
       * target among it as its node, with each entry the reference it was
       * resolved for. */
      resolveLists(this.resolutionContext(), [sources]).then(({ lists: [resolved], references: [written], conflicts }) =>
        ResolvedRequirements.of(resolved, written, conflicts)
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
  private evaluateTarget(context: TargetContext, rule: RuleDefinition, requirements?: ResolvedRequirements): Computable<SourceRef[]> {
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
    /* A sub-target's type must have a targetdef. A missing one means the plugin
     * did not declare the type, an internal inconsistency rather than a user
     * error. */
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
      owner.stack
    );
    return buildContext
      .ruleFor(type, context, () => new FabrError(`No rule found for anonymous target type '${type}'`))
      .then(rule => buildContext.evaluateTarget(context, rule));
  }

  /**
   * Perform `context`'s build action through the cache, reported as the
   * target's work. A target the run was asked to force
   * ({@link ExecutionContext.forceTarget}) is rebuilt rather than served (see
   * {@link forcedBuild}).
   */
  private runAction(action: BuildAction, context: TargetContext): Computable<FileSet> {
    /* An anonymous sub-target keys under its declared owner's identity plus its
     * own label — see {@link BuildAction.targetKey} for what the coordinate
     * includes and excludes. */
    const task = context.taskDescription();
    return this.performAction(action, task, this.forcedBuild(context), action.targetKey(context.getDeclaredContext().target, task.label));
  }

  /**
   * Perform an action that belongs to no target, reported as `task`: a
   * `` `cmd` `` substitution, which may be written in a global. Never forced,
   * since `-f` marks targets.
   */
  private runOwnAction(action: BuildAction, task: TaskDescription): Computable<FileSet> {
    return this.performAction(action, task, false);
  }

  /** Perform `action` through the cache, reporting a miss as `task`: the core of
   * {@link runAction} and {@link runOwnAction}. A caller with no target passes
   * no `targetKey`. */
  private performAction(action: BuildAction, task: TaskDescription, force: boolean, targetKey?: string): Computable<FileSet> {
    const execution = this.execution;
    /* The action IS the task reported: this callback runs only on a miss, so a
     * task exists exactly when something is performed, bracketing the step's
     * own chain. A target with several actions reports each. */
    const create = (ctx: ActionContext): Computable<BuildResult> =>
      execution.runTask(task, report => action.step.run(action, ctx, report));
    /* The cache derives the key (anchor or complete, by the action's shape),
     * the discoverable deps and the change tracking from the action itself. */
    const output = execution.buildCache.getOrCreateAction(action, create, { force, targetKey, processLimit: execution.processLimit });
    const reshape = action.reshape;
    return reshape === undefined ? output : output.then(result => reshape(result));
  }

  /**
   * Check whether `context` belongs to a target the run was asked to force
   * (`-f`, see {@link ExecutionContext.forceTarget}). The question is put to
   * the declared owner, so a forced target's anonymous sub-targets are forced
   * with it, while the declared targets it depends on are served from cache.
   */
  private forcedBuild(context: TargetContext): boolean {
    return this.execution.isForced(context.getDeclaredContext().target);
  }

}

/** State what `rule` requires of the target `context` builds: nothing, for a
 * rule without `requirements`. */
function statedRequirements(context: TargetContext, rule: RuleDefinition): Computable<Requirements | Permissive> {
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
  return new FabrError(`'${name}' is declared, but no declaration of it applies to this configuration`).withHelp(
    `it is declared under ${guards.join(", ")} — add an unguarded declaration, or a 'default ${name} = …;'`
  );
}
