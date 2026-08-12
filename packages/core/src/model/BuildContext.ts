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

import { Readable } from "stream";
import { FetchOptions, IActionContext, IFetchContext } from "../core/BuildCache";
import { Computable, ComputableSource } from "../core/Computable";
import { EMPTY_FILESET, FileSet, FileSource, IFile } from "../core/FileSet";
import { FSFileSource } from "../core/FSFileSource";
import {
  isRepository,
  Materialized,
  MaterializeOptions,
  RepositoryPublishRef,
  materializeAll,
  materializeLists,
  materializeShallow,
  ResolutionContext,
  renamedDelivery,
  Repository,
  RepositoryRef,
  PERMISSIVE_RESOLUTION,
  SourceRef,
} from "../core/Repository";
import { FileSetRef, FileSourceRef } from "../core/FileSetRef";
import { RunnableFileSet, toRunnable } from "../core/RunnableFileSet";
import { PackageFileSet } from "../core/PackageFileSet";
import { Requirement } from "../resolver/Types";
import { declaredRequirementFrom } from "../resolver/PackageResolver";
import { Flag } from "../core/Flag";
import {
  IProvenanceStep,
  IRenderContext,
  registerProvenanceDescriber,
  registerProvenanceRenderer,
} from "../core/Provenance";
import { BuildAction, BuildActionInput, BuildActionInputs, IRuleDefinition, RepositoryProvider, SubTargetInputs } from "../rules/Types";
import { BUILD_OPERATION, Constraints, HOST, RUN_OVERRIDE, TARGET } from "./Constraints";
import { ExecutionContext, ProgressEvent } from "./ExecutionContext";
import { ITargetOrigin, TARGET_PROVENANCE } from "./Target";
import {
  CommandPipeline,
  DeclKind,
  declPosn,
  hasMapValue,
  ICommandStage,
  IDecl,
  IMapItemDecl,
  IMapSpliceDecl,
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
  declName,
} from "./AST";
import { IDiagnosticNote } from "../support/Log";
import { EXPAND_TAG, expandOnce, findWithDescent } from "../support/Expand";
import type { StageStreams } from "../support/Execute";
import {
  CircularDependencyError,
  DependencyFailedError,
  IUseSite,
  NameResolutionError,
  NoRuleFoundError,
  ReferenceFailedError,
} from "./Errors";
import { attachHelp, ConflictError, IConflictSide, IConflictSource, toError } from "../core/Errors";
import { closestMatch } from "../support/Suggest";
import { Name, NameConstraint, RewriteFn, makeRewrite } from "../core/Name";
import { globMatcher } from "../support/Glob";
import { parseName } from "./Parser";
import { IPrefixMatch, IPropertyEntry } from "./Namespace";
import { Property } from "./Property";

/**
 * The resolved value of a MAP property: an ordered key -> value map whose
 * values are each a **list of strings** (a string-valued entry's values, kept as
 * written — like any other property value, not space-joined), a sub-map (one
 * nested block), or a list of sub-maps (several blocks — an array of objects,
 * `maintainers`-style). Never a mix within one entry. The map is ecosystem-neutral;
 * the consuming rule interprets/encodes the values (a scalar field joins the list,
 * an array field keeps it — that shape choice is the consumer's, not the model's).
 */
export type PropertyMapValue = string[] | PropertyMap | PropertyMap[];
export type PropertyMap = Map<string, PropertyMapValue>;

/**
 * Ghost provenance for one resolved map entry: the written `key = value;` decl
 * the value came from, plus the chain of reference hops it arrived through —
 * each an in-block `NAME;` splice or a top-level bare-reference value, outermost
 * first ("via 'FABR_METADATA'"). Runtime-only, per the provenance doctrine:
 * carried in a WeakMap beside the resolved map (never on it), so it can never
 * reach equality, manifests, or an encoder's output.
 */
export interface MapEntryOrigin {
  entry: IPropertyDecl;
  via: (IMapSpliceDecl | INameValue)[];
}

const MAP_ORIGINS = new WeakMap<PropertyMap, Map<string, MapEntryOrigin>>();

/** The origin of a resolved map's entry, if the map came from `resolveMap`
 * (a hand-built plain Map has none). */
export function mapEntryOrigin(map: PropertyMap, key: string): MapEntryOrigin | undefined {
  return MAP_ORIGINS.get(map)?.get(key);
}

function recordMapOrigin(map: PropertyMap, key: string, origin: MapEntryOrigin): void {
  let origins = MAP_ORIGINS.get(map);
  if (!origins) {
    origins = new Map();
    MAP_ORIGINS.set(map, origins);
  }
  origins.set(key, origin);
}

/** Merge `source`'s entries into `target` (later wins), threading each entry's
 * origin with the written reference `hop` prepended to its via-chain. */
function mergeMapInto(target: PropertyMap, source: PropertyMap, hop: IMapSpliceDecl | INameValue): void {
  for (const [key, value] of source) {
    target.set(key, value);
    const origin = mapEntryOrigin(source, key);
    if (origin) {
      recordMapOrigin(target, key, { entry: origin.entry, via: [hop, ...origin.via] });
    }
  }
}

interface IResolvedFileSource {
  sources: SourceRef[];
}

/** Attach a name's remedies to its error as the `help:` line, if there are any. */
function withHints<T extends Error>(err: T, hints: string[]): T {
  return hints.length > 0 ? attachHelp(err, hints.join("; ")) : err;
}

export const MODEL_REF_PROVENANCE = "model-ref";

/**
 * Provenance step for a FileSet that was included by writing a name in a
 * property value: the written value (with its source position), and the
 * constraint set in effect for the resolution. Steps chain along the data
 * path — each resolution hop wraps the sets it resolves — so nested property
 * expansions produce multi-hop chains without any explicit stack capture.
 */
export interface IModelRefStep extends IProvenanceStep {
  kind: typeof MODEL_REF_PROVENANCE;
  value: INameValue;
  constraints: Constraints;
  /** The property the value was written in, and its owning target (absent for
   * a global/default property) — the "required by <target> <property>" facts */
  property: IPropertyDecl;
  target?: ITargetDecl;
}

registerProvenanceRenderer(MODEL_REF_PROVENANCE, (step, context) => renderModelRef(step as IModelRefStep, context));
registerProvenanceRenderer(TARGET_PROVENANCE, step => {
  const target = (step as ITargetOrigin).decl;
  return [{ message: `built by ${target.type} '${target.name}'`, loc: declPosn(target) }];
});

/* Short attribution ("the name it was written as") for one-line messages */
registerProvenanceDescriber(MODEL_REF_PROVENANCE, step => (step as IModelRefStep).value.value.toString());
registerProvenanceDescriber(TARGET_PROVENANCE, step => declName((step as ITargetOrigin).decl));

function renderModelRef(step: IModelRefStep, context: IRenderContext): IDiagnosticNote[] {
  const verb = context.stepIndex === 0 ? "from" : "via";
  return [
    {
      message: `${verb} '${step.value.value.toString()}' (${describeUseSite(step.property, step.target)})`,
      loc: declPosn(step.value),
      label: constraintText(step, context),
    },
  ];
}

/** "required by <target> <property>" without the leading verb: the use-site
 * attribution shared by model-ref notes and the driver's dependant chain. */
export function describeUseSite(property: IPropertyDecl, target: ITargetDecl | undefined): string {
  return target ? `${declName(target)} ${property.name.toBaseString()}` : property.name.toBaseString();
}

/**
 * Describe the constraint set a reference was resolved under, but only where
 * it is informative: the deepest model step shows its (non-empty) constraints,
 * other steps show only the entries that differ from the next model step
 * down the chain (i.e. override boundaries), and the caller's ambient keys
 * (context.elideConstraintKeys) are omitted throughout. Undefined when there
 * is nothing to say.
 */
export function constraintText(step: IModelRefStep, context: IRenderContext): string | undefined {
  const deeper = findNextModelRef(step.parent);
  const entries = [...step.constraints].filter(
    ([key, value]) => !context.elideConstraintKeys?.has(key) && (deeper ? deeper.constraints.get(key) !== value : true)
  );
  if (entries.length === 0) {
    return undefined;
  }
  return `with ${entries.map(([key, value]) => `${key}=${value}`).sort().join(" ")}`;
}

function findNextModelRef(step: IProvenanceStep | undefined): IModelRefStep | undefined {
  for (let current = step; current; current = current.parent) {
    if (current.kind === MODEL_REF_PROVENANCE) {
      return current as IModelRefStep;
    }
  }
  return undefined;
}

interface IBuildModel {
  getConfig(constraints: Constraints, execution: ExecutionContext): BuildContext;
  getDecl(name: string): IPropertyEntry | ITargetDecl | INamespaceDecl | undefined;
  getTargetDef(name: string): ITargetDefDecl | undefined;
  getPrefixMatch(name: Name): IPrefixMatch | undefined;
  /** Name enumerations, for nearest-match suggestions on an unresolved name. */
  getTargets(): { name: string; decl: ITargetDecl }[];
  getProperties(): { name: string; decl: IPropertyDecl }[];
  /** The model's registry: rule selection and repository providers ride the
   * model (built per load from core + active plugins), not a global. */
  getTargetRule(type: string, constraints: Constraints): IRuleDefinition | undefined;
  /** The operations a type has a rule for — what a target of it can be asked
   * to do, which is what makes an unsupported request explainable. */
  getOperations(type: string): string[];
  getRepositoryProvider(type: string): RepositoryProvider | undefined;
}

/** The use site recorded on a dependency-stack node, when one exists. */
function useSiteOf(stack: IDependencyStack | undefined): IUseSite | undefined {
  return stack ? { value: stack.value, property: stack.property, target: stack.target } : undefined;
}

interface IDependencyStack {
  target?: ITargetDecl;
  property: IPropertyDecl;
  context: BuildContext;
  value: INameValue;
  next?: IDependencyStack;
}

/**
 * A command name after variable substitution: the resolved {@link Name} paired
 * with the {@link INameValue} it was written as. `ref` is the model-ref/stack
 * currency the rest of the model speaks (`ref.value` the *written* form, for
 * provenance rendering and error spans); `name` is the substituted value that
 * then resolves to a runnable or globs over `srcs`. Internal to the two-step
 * command resolution ({@link BuildContext.resolveCommand} substitutes,
 * {@link TargetContext.getCommandProperty} resolves) — a rule sees only the
 * fully-resolved {@link ResolvedCommandStage}.
 */
interface IPositionedName {
  name: Name;
  ref: INameValue;
}

/**
 * One {@link ICommandStage} with every name variable-substituted and the
 * bare-name chase applied (see {@link BuildContext.resolveCommand}) — the
 * intermediate {@link TargetContext.getCommandProperty} then resolves to a
 * {@link ResolvedCommandStage}. Not rule-facing.
 */
interface IResolvedCommandStage {
  command: IPositionedName;
  args: IPositionedName[];
  stdin?: IPositionedName;
  stdout?: IPositionedName;
  stderr?: IPositionedName;
  both?: IPositionedName;
}

/**
 * One fully-resolved pipeline stage a `generate` rule consumes (see
 * {@link TargetContext.getCommandProperty}): its command resolved to a
 * `runnable`, `args` globbed over `srcs`, `stdin` to a single-file set, and the
 * `stdout`/`stderr`/`both` redirect target names (shared {@link StageStreams}).
 * The rule mounts each `runnable` and turns the stage into a run spec; nothing
 * here is positional (errors were raised during resolution).
 */
export interface ResolvedCommandStage extends StageStreams {
  runnable: RunnableFileSet;
  args: string[];
  stdin?: FileSet;
}

/** A fully-resolved command pipeline — the rule-facing counterpart of the parsed
 * {@link CommandPipeline}, yielded by {@link TargetContext.getCommandProperty}. */
export type ResolvedCommandPipeline = ResolvedCommandStage[];

/**
 * A property's sources, marked as wanted CONTAINED: `collect` delivers them with
 * their projections still pending, for a consumer that will place the container
 * and locate within it ({@link FileSet.locate}) rather than extract the files.
 *
 * The mark rides on the property's *list* rather than each ref, because the ref
 * a projection ends up on is not known at property-read time: a local target's
 * projection is already a FileSetRef, while an external one is still a
 * RepositoryRef and only becomes a FileSetRef once materialized. The list is the
 * thing the reading rule actually has an opinion about.
 *
 * Collection policy is the DRIVER's, so it lives here in the model: the delivery
 * machinery (materializeAll) knows only MaterializeOptions and never applies
 * projections.
 */
export class ContainedSources {
  constructor(public readonly sources: SourceRef[]) {}
}

/**
 * What a collected part settles to: a part marked {@link ContainedSources} keeps
 * its projections pending and so may hold refs, everything else is finished to
 * plain content. Per key, so a rule that contains one property does not have to
 * re-narrow the others.
 */
export type Collected<P> = {
  [K in keyof P]: P[K] extends ContainedSources | Computable<ContainedSources> ? (FileSet | FileSetRef)[] : FileSet[];
};

/** A collect part: a plain source list (extracted, the default) or one marked
 * contained. */
export type CollectPart = SourceRef[] | ContainedSources | Computable<SourceRef[] | ContainedSources>;

/**
 * A BuildContext is (effectively) the BuildModel instantiated with an explicit set of additional
 * constraints (which may be the empty set).
 *
 * As a practical matter, this is where everything is actually resolved and evaluated.
 */
export class BuildContext {
  /** The run's fixed runtime surroundings, shared by every config of the run */
  public readonly execution: ExecutionContext;
  protected readonly constraints: Constraints;
  private readonly model: IBuildModel;
  private propCache: Map<string, Computable<Property>>;
  private targetCache: Map<string, Computable<SourceRef[]>>;

  constructor(model: IBuildModel, constraints: Constraints, execution: ExecutionContext) {
    this.model = model;
    this.constraints = constraints;
    this.execution = execution;
    this.propCache = new Map();
    this.targetCache = new Map();
    // Pre-force the constraints so we don't have to check this later.
    for (const [key, value] of constraints) {
      this.propCache.set(key, Computable.resolve(new Property([value])));
    }
  }

  /**
   * The contents of an archive file, expanded through the build cache: keyed on
   * the file's content hash under EXPAND_TAG (same `memo:` convention as
   * TargetContext.memoize), so one archive is expanded once however many
   * selectors project into it, identical bytes share the expansion across runs,
   * and an unpack-semantics change is a tag bump. Name resolution — and so
   * namespace traversal — is this context's job, which is why expansion meets
   * the cache here and nowhere else.
   */
  public expandArchive(file: IFile): Computable<FileSet> {
    return this.getCachedOrBuild(`memo:${EXPAND_TAG} ${file.hash}`, () => expandOnce(file));
  }

  /**
   * This context as the resolution layer's consuming-side surface (see
   * {@link ResolutionContext}) — for collection points entered from the
   * BuildContext itself (the CLI's resolveName, command/tool resolution). A
   * TargetContext satisfies the interface directly and passes itself instead.
   */
  public resolutionContext(): ResolutionContext {
    return {
      getGlobalString: name => this.getProperty(name).then(prop => prop.toString()),
      memoize: (tag, key, create) => this.getCachedOrBuild(`memo:${tag} ${key}`, create),
      notifyProgress: event => this.execution.notifyProgress(event),
    };
  }

  /**
   * Project `source` by `pattern` with archive descent — the namespace walk
   * (Expand's findWithDescent) bound to this context's cached expansion. The
   * one production caller is {@link manifest}: every projection applies by
   * being a (possibly instantly-manifested) suspension.
   */
  private findWithDescent(source: FileSource, pattern: Name, prefix: string): ComputableSource<FileSet> {
    return findWithDescent(source, pattern, prefix, file => this.expandArchive(file));
  }

  /**
   * Resume the walk over a pending ref — THE projection-application path,
   * whether the ref travelled from a collection point or was constructed and
   * manifested in the same breath (the resolver's eager arms): apply the
   * suspended projections — each on the (possibly narrowed) base's own terms
   * via polymorphic `find`, descending into archives where a projection
   * crosses one — and enforce the ref's literal-must-resolve `miss`. The ref
   * itself is pure data; applying it is the resolver's job.
   */
  public manifest(ref: FileSourceRef): ComputableSource<FileSet> {
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
      /* `miss` present already means "empty is an error here" — the glob
       * judgment was made once, over the whole written name, where the ref was
       * built (see resolveFileSource). */
      result = result.then(files => {
        if (files.isEmpty()) {
          throw ref.miss!();
        }
        return files;
      });
    }
    return result;
  }

  /**
   * Resume the walk over a delivery's results: finish each pending ref and pass
   * everything else through — the model-side counterpart of materializeAll,
   * which delivers entities and never projects. Generic so a caller keeps its
   * own element type (a contained consumer's `FileSet | FileSetRef` settles
   * to plain FileSets; a collection's `Materialized` to content + repositories).
   */
  public finishDelivered<S extends FileSource | Repository>(resolved: ReadonlyArray<S | FileSetRef>): Computable<(S | FileSet)[]> {
    return Computable.forAll(
      resolved.map(source => (source instanceof FileSetRef ? this.manifest(source) : Computable.resolve(source))),
      (...finished: (S | FileSet)[]) => finished
    );
  }

  public hasConstraints(constraints: Constraints): boolean {
    return this.constraints.equals(constraints);
  }

  public getTargetWithOverrides(name: string, overrides: Constraints): Computable<SourceRef[]> {
    /* Through getTarget's callerOverrides so a property's value requirement cannot
     * beat the explicit override (a direct target decl folds as before). */
    return this.getTarget(name, undefined, overrides);
  }

  /**
   * Build the target named by a whole reference — a target name plus an optional
   * `<k=v>` requirement (`mylib<BUILD_TYPE=release>`). The requirement re-roots the
   * build config for that target exactly as it would in a build script; a plain
   * name resolves as {@link getTarget}. This is what the CLI's `build`/`test`/
   * `sync`/`shell` verbs use so a constrained reference works on the command line
   * as it does in a script. (A `:projection` doesn't apply — these verbs build the
   * whole target — so the reference is used only for its name and constraints.)
   */
  public getTargetRef(name: string, stack?: IDependencyStack): Computable<SourceRef[]> {
    return this.resolvingContextFor(parseName(name), undefined, stack).then(({ context, reference }) =>
      context.getTarget(reference.toString(), stack)
    );
  }

  /**
   * The context for this one overridden by the given constraints — the
   * receiver itself when there are none: contexts are interned by constraint
   * set, so an undefined/empty override resolves to the same instance (which
   * is what lets callers pass an optional override straight through without
   * conditioning on it).
   */
  public getContextWithOverrides(overrides?: Constraints): BuildContext {
    return this.model.getConfig(this.constraints.with(overrides), this.execution);
  }

  /**
   * The raw value of a configuration constraint, or undefined if unset. Unlike
   * getProperty this never consults declarations or throws — it reads only the
   * scalar constraint set the context was instantiated with. This is how every
   * driver-injected global a rule or repository selects on is read: the build
   * verb (`getConstraint(BUILD_OPERATION) ?? "build"`) and the host fact
   * (`HOST`) alike.
   */
  public getConstraint(name: string): string | undefined {
    return this.constraints.get(name);
  }

  /** The full constraint set this context resolves under (read-only). */
  public getConstraints(): Constraints {
    return this.constraints;
  }

  /**
   * Whether a property declaration's constraint guard — its key's `<k=v>` facet,
   * which in *decl* position means "only where the configuration matches" —
   * admits this configuration:
   * every pair's pattern must match the value of the property it names (a
   * conjunction — disjunction is a second declaration). An absent guard admits
   * everything.
   *
   * The configuration is read as a PROPERTY, not as a raw constraint, because
   * that is what it is: `TARGET` is a `default` property rather than an injected
   * constraint, a `-D` or `<k=v>` override rides the same read (the constructor
   * pre-forces the constraint set into the property cache), and a project's own
   * flag (`default TRACING = off;`) is then guardable with no further design. A
   * guard naming a property nothing declares is the ordinary unknown-property
   * error — a typo in a guard must not quietly mean "never".
   */
  public guardAdmits(guard: readonly NameConstraint[] | undefined, stack?: IDependencyStack): Computable<boolean> {
    if (!guard) {
      return Computable.resolve(true);
    }
    return Computable.forAll(
      guard.map(([key, pattern]) =>
        this.substituteNameVars(pattern, stack).then(substituted =>
          this.getProperty(key, stack).then(value => globMatcher(substituted.toGlobString())(value.toString()))
        )
      ),
      (...admitted: boolean[]) => admitted.every(match => match)
    );
  }

  /**
   * The declarations of a property that **apply in this configuration**: those
   * whose guard admits it, from the tier that answered — ordinary declarations
   * if any of them matched, else the `default` ones. This is the whole of what a
   * guard decides; what to do with more than one is the reader's business (see
   * {@link mergedDecls} / {@link soleDecl}), because that depends on the shape
   * of the read and not on the property.
   *
   * Empty is not an error: it means the property is unwritten *here*, so a
   * caller falls back exactly as it does for a property never mentioned. Guards
   * filter and never rank, so there is no most-specific tie-break among what
   * comes back.
   */
  public getAvailableDecls(entry: IPropertyEntry | undefined, stack?: IDependencyStack): Computable<IPropertyDecl[]> {
    if (!entry) {
      return Computable.resolve([]);
    }
    const { decls, defaults } = entry;
    const candidates = [...decls, ...defaults];
    if (!candidates.some(candidate => candidate.name.hasConstraints())) {
      /* Nothing is guarded, so there is nothing to decide: every declaration
       * applies, and the tier rule alone picks between them. This is the shape
       * of almost every property — one plain declaration, a `default` global
       * nobody overrode, or an override that supersedes one — and taking it
       * without evaluating a guard is what keeps an unguarded property free of
       * a guard's costs, its property reads included. */
      return Computable.resolve(decls.length > 0 ? decls : defaults);
    }
    try {
      return Computable.forAll(
        candidates.map(candidate => this.guardAdmits(candidate.name.getConstraints(), stack)),
        (...admitted: boolean[]) => {
          /* An ordinary declaration displaces a `default` one only where it
           * applies, so the tiers are judged in order: the defaults answer
           * exactly when nothing ordinary matched. */
          const matched = candidates.filter((_, i) => admitted[i]);
          const ordinary = matched.filter(candidate => decls.includes(candidate));
          return ordinary.length > 0 ? ordinary : matched;
        }
      );
    } catch (err) {
      /* A guard reading an unknown property throws where it is built, not where
       * it settles. */
      return Computable.reject(toError(err));
    }
  }

  /**
   * The unresolved-name error for `name`: positioned at the referencing value
   * when a dependency stack is present (a name written in a build file), a
   * plain message otherwise (a command-line name — nothing to point at), with
   * the given hints (a nearest-match suggestion etc.) as its `help:` line.
   */
  private unresolvedNameError(name: string, stack: IDependencyStack | undefined, reason: string, hints: string[]): Error {
    const err = stack
      ? new NameResolutionError(Name.fromLiteral(name), declPosn(stack.value), useSiteOf(stack), reason)
      : new Error(reason);
    return withHints(err, hints);
  }

  /**
   * The help for a name nothing declares, wherever it was written: the nearest
   * declared name — targets and config properties alike, since a bare name may
   * resolve to either — matched against the head of a `:` projection, that
   * being the name got wrong. A name written on the command line also gets the
   * pointer to the verb that lists them; one written in a build file does not
   * (it is not a shell away from checking).
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
    this.assertNonCircularProperty(name, stack);
    if (callerOverrides) {
      /* Mirror getTarget's override path: a caller's explicit override outranks a
       * `<k=v>` requirement on the property's value (ambient < requirement < caller), so
       * for a declared property it threads into the SAME value resolution rather than
       * folding into ambient (which a requirement would beat); a constrained name has no
       * written requirement to fight, so it keeps the ambient fold. Uncached, as there. */
      if (!this.constraints.has(name)) {
        const def = this.model.getDecl(name);
        if (def?.kind === DeclKind.Property) {
          return this.getAvailableDecls(def, stack).then(applicable =>
            this.resolveStringProperty(unmatchedIfAbsent(soleDecl(applicable), name, def), undefined, stack, callerOverrides)
          );
        }
      }
      return this.getContextWithOverrides(callerOverrides).getProperty(name, stack);
    }
    const cached = this.propCache.get(name);
    if (cached) {
      /* Already seen */
      return cached;
    }
    const def = this.model.getDecl(name);
    if (!def || def.kind !== DeclKind.Property) {
      const reason = def
        ? `'${name}' names a ${def.kind === DeclKind.Target ? "target" : "namespace"}, not a property`
        : `Unknown property '${name}'`;
      const nearest = def ? undefined : closestMatch(name, this.model.getProperties().map(prop => prop.name));
      throw this.unresolvedNameError(name, stack, reason, nearest ? [`did you mean '${nearest}'?`] : []);
    }
    const result = this.getAvailableDecls(def, stack).then(applicable =>
      this.resolveStringProperty(unmatchedIfAbsent(soleDecl(applicable), name, def), undefined, stack)
    );
    this.propCache.set(name, result);
    return result;
  }

  public getTarget(name: string, stack?: IDependencyStack, callerOverrides?: Constraints): Computable<SourceRef[]> {
    this.assertNonCircularTarget(name, stack);
    if (callerOverrides) {
      /* A caller's explicit override must outrank a `<k=v>` requirement written on
       * a property's value (ambient < requirement < caller override — see
       * resolvingContextFor), so for a property it rides into the SAME value
       * resolution the per-target property path uses, rather than being folded
       * into a context's ambient set (which a requirement would beat). The other
       * branches — a `-D` repin, a direct target decl — have no written requirement
       * to fight, so they keep the ambient fold, delegating to the overridden
       * context (whose own targetCache memoizes them). The property case is
       * uncached here: targetCache keys by bare name, and the referenced
       * targets' builds stay memoized in their own constraint contexts. */
      const def = this.model.getDecl(name);
      if (!this.constraints.has(name) && def?.kind === DeclKind.Property) {
        this.assertNonCircularProperty(name, stack);
        return this.getAvailableDecls(def, stack).then(applicable =>
          this.resolveFileProperty(unmatchedIfAbsent(mergedDecls(applicable), name, def), undefined, stack, callerOverrides)
        );
      }
      return this.getContextWithOverrides(callerOverrides).getTarget(name, stack);
    }
    const cached = this.targetCache.get(name);
    if (cached) {
      /* Already seen */
      return cached;
    } else if (this.constraints.has(name)) {
      /* A constraint overrides how the name resolves — to files as well as to a
       * string (`${name}`, via the pre-forced propCache): resolve the override
       * value as a reference in place of the declared property/target. Parsed as
       * a full reference (not a bare literal), so `-Dchai=@npm:chai:5.0.0` repins
       * a dependency written as a bare `chai`, and a `:`/`<k=v>` on the override
       * is honoured as it would be in a script. */
      const result = this.resolveFileValue(parseName(this.constraints.get(name)!), stack);
      this.targetCache.set(name, result);
      return result;
    } else {
      const def = this.model.getDecl(name);
      if (def?.kind === DeclKind.Target) {
        const result = this.resolveTarget(def, stack);
        this.targetCache.set(name, result);
        return result;
      } else if (def?.kind === DeclKind.Property) {
        /* A global FILES property resolved as a target: its stack nodes carry no
         * `target`, so the target-cycle check above never fires — the property
         * check is what turns `A = B; B = A;` into a positioned cycle error
         * instead of unbounded recursion. */
        this.assertNonCircularProperty(name, stack);
        const result = this.getAvailableDecls(def, stack).then(applicable =>
          this.resolveFileProperty(unmatchedIfAbsent(mergedDecls(applicable), name, def), undefined, stack)
        );
        this.targetCache.set(name, result);
        return result;
      } else {
        const hints: string[] = [];
        if (name.includes(":")) {
          /* getTarget resolves whole declared names only (the build/test CLI
           * path) — a ':' here is a file projection, which those verbs don't
           * take. */
          hints.push("'build' and 'test' take whole target names; a ':' projection into a target's files applies to ls, cat, and run");
        }
        hints.push(...this.unknownNameHints(name, !stack));
        throw this.unresolvedNameError(name, stack, `Unknown name '${name}'`, hints);
      }
    }
  }

  /**
   * Find and return a target from the literal prefix of the given name, along with
   * the matched declaration, a new Name representing the unmatched suffix, and
   * the written prefix to retain in result names (the written-name rule:
   * "mylib/lib/*" retains "mylib/", "mylib:lib/*" retains nothing).
   * If no such target can be found, returns undefined.
   *
   * Note: target names are not pattern matched against globs (ie only the literal prefix
   * of the name is looked up)
   */
  public getPrefixTargetIfExists(
    name: Name,
    stack?: IDependencyStack
  ): { target: Computable<SourceRef[]>; rest: Name; name: string; retainedPrefix: string } | undefined {
    const result = this.model.getPrefixMatch(name);
    if (result) {
      return {
        target: this.getTarget(result.name, stack),
        rest: result.rest,
        name: result.name,
        retainedPrefix: result.retainedPrefix,
      };
    }
    return undefined;
  }

  public getCachedOrBuild(manifest: string, create: (targetDir: string) => Computable<FileSet>): Computable<FileSet> {
    return this.execution.buildCache.getOrCreate(manifest, create);
  }

  public getCachedOrFetch(
    url: string,
    tag: string,
    process: (content: Readable, ctx: IFetchContext) => Computable<FileSet>,
    headers?: Record<string, string>,
    options?: FetchOptions
  ): Computable<FileSet> {
    return this.execution.buildCache.getOrFetch(url, tag, process, headers, options);
  }

  /**
   * The shared per-property skeleton behind both the string and file contexts:
   * for each value reject a non-name (a map block / command pipeline) with a
   * context-appropriate message (`expects` names the consuming use — "a string",
   * "files"), build that value's dependency-stack node, and hand it to a
   * context-specific `tail` ({@link resolveStringValue} / {@link
   * resolveFileValue}). Each value must be a name; the guard is the backstop for
   * the paths Validate doesn't cover (default/top-level properties, sync
   * coordinates).
   */
  private resolveValues<T>(
    prop: IPropertyDecl,
    target: ITargetDecl | undefined,
    stack: IDependencyStack | undefined,
    expects: string,
    tail: (value: INameValue, info: IDependencyStack) => Computable<T>
  ): Computable<T[]> {
    return Computable.forAll(
      prop.values.map(value =>
        isNameValue(value)
          ? tail(value, { property: prop, target, context: this, value, next: stack })
          : Computable.reject<T>(nonNameValueError(prop, value, expects))
      ),
      (...resolved: T[]) => resolved
    );
  }

  /**
   * Resolve a property's values to their substituted Names — the shared core of
   * {@link resolveStringProperty} (which stringifies) and {@link resolveRewrite}
   * (which reads the rename template facet). References are NOT resolved: a
   * REWRITE/STRING value is inert, never a collection point.
   */
  public resolveNameProperty(
    prop: IPropertyDecl,
    target?: ITargetDecl,
    stack?: IDependencyStack,
    callerOverrides?: Constraints
  ): Computable<Name[]> {
    return this.resolveValues(prop, target, stack, "a string", (value, info) =>
      this.resolveStringValue(value.value, info, callerOverrides)
    );
  }

  /**
   * Resolve one written value in a STRING context to its substituted Name. A
   * STRING is inert — no references are resolved and no provenance is stamped —
   * but it flows through the SAME context resolution as {@link resolveFileValue}
   * (the value's `<k=v>` requirement, and any caller override, re-root the resolving
   * context via {@link resolvingContextFor}), so overrides layer uniformly
   * (ambient < requirement < caller) across the string and file contexts, and
   * conditional properties, which gate a value on that context, will read the
   * two symmetrically. The returned Name keeps its rename facet (only the
   * constraints facet is consumed here), for REWRITE/projection readers.
   */
  private resolveStringValue(name: Name, info: IDependencyStack, callerOverrides?: Constraints): Computable<Name> {
    /* A STRING's value IS its content, so — unlike a file reference, whose name
     * is an address resolved under ambient while the requirement/override re-roots
     * the *referenced target's* build — they must reach the value's
     * own `${...}` substitution. So substitute the original name (facet stripped)
     * under the merged context, not resolvingContextFor's ambient-substituted
     * reference. */
    return this.resolvingContextFor(name, callerOverrides, info).then(({ context }) =>
      context.substituteNameVars(name.withConstraints([]), info)
    );
  }

  public resolveStringProperty(
    prop: IPropertyDecl,
    target?: ITargetDecl,
    stack?: IDependencyStack,
    callerOverrides?: Constraints
  ): Computable<Property> {
    return this.resolveNameProperty(prop, target, stack, callerOverrides).then(
      names => new Property(names.map(name => name.toString()))
    );
  }

  /**
   * Resolve a MAP property to an ordered key -> value map. A MAP is a distinct,
   * structured value (not a string): its value is EITHER one inline `{ key =
   * value; ... }` block OR bare reference(s) to other block-valued properties
   * (`metadata = SHARED;`, the FILES-list `test_deps = chai` idiom — a map is
   * name-chased, not `${}`-interpolated). Within a block, an entry's value is
   * either strings — resolved like a scalar STRING (substituted, space-joined
   * into one string) — or nested block(s): one block is a sub-map, several are a
   * list of maps (`maintainers = { ... } { ... };`), never a mix. The map is
   * ecosystem-neutral, so the consuming rule interprets the values (esbuild
   * `define` code text, package.json metadata, ...). Keys retain declaration
   * order. References merge left-to-right, later value winning (extension via an
   * inline block + reference is deferred). An empty property yields an empty map.
   */
  public resolveMap(
    prop: IPropertyDecl,
    target?: ITargetDecl,
    stack?: IDependencyStack,
    callerOverrides?: Constraints
  ): Computable<PropertyMap> {
    return this.resolveMapDecl(prop, target, stack, new Set(), callerOverrides);
  }

  private resolveMapDecl(
    prop: IPropertyDecl,
    target: ITargetDecl | undefined,
    stack: IDependencyStack | undefined,
    seen: Set<IPropertyDecl>,
    callerOverrides?: Constraints
  ): Computable<PropertyMap> {
    if (seen.has(prop)) {
      return Computable.reject(new Error(`Circular map reference at '${prop.name}'`));
    }
    const nextSeen = new Set(seen).add(prop);
    if (hasMapValue(prop)) {
      /* Inline form: one block (Validate enforces this for schema'd properties;
       * re-checked here for shared globals, which never pass a targetdef). */
      if (prop.values.length > 1) {
        return Computable.reject(
          new Error(`'${prop.name}' must be a single \`{ ... }\` block or bare reference(s), not a mix`)
        );
      }
      const block = prop.values[0];
      return this.resolveMapBlock(isMapValue(block) ? block.entries : [], target, stack, nextSeen, callerOverrides);
    }
    /* Reference form: each value names a block-valued property (resolved
     * recursively under this context, so a shared map's `${...}` sees the
     * consuming build's config), merged left-to-right with later winning; each
     * merged entry's origin gains the written reference as a via-hop. */
    return Computable.forAll(
      prop.values.filter(isNameValue).map(value =>
        this.resolveMapReference(value.value, { property: prop, target, context: this, value, next: stack }, stack, nextSeen, callerOverrides).then(
          (map): [PropertyMap, INameValue] => [map, value]
        )
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
   * the named block-valued property and resolve it, `seen`-guarded. */
  private resolveMapReference(
    name: Name,
    info: IDependencyStack | undefined,
    stack: IDependencyStack | undefined,
    seen: Set<IPropertyDecl>,
    callerOverrides?: Constraints
  ): Computable<PropertyMap> {
    return this.referencedProperty(name, info).then(({ prop, name: substituted }) => {
      if (!prop) {
        throw new Error(`'${substituted.toString()}' does not name a map property`);
      }
      return this.resolveMapDecl(prop, undefined, stack, seen, callerOverrides);
    });
  }

  /** Resolve one block's items in written order: a `key = value;` entry sets its
   * key (strings joined to one string; nested blocks to a sub-map, several to a
   * list of sub-maps — mixing rejected, statically for schema'd properties and
   * re-checked here for shared globals); a `NAME;` splice merges the named map's
   * entries in at that position. Later values win. Each entry records its ghost
   * origin (the written decl, plus via-hops for splices). */
  private resolveMapBlock(
    entries: IMapItemDecl[],
    target: ITargetDecl | undefined,
    stack: IDependencyStack | undefined,
    seen: Set<IPropertyDecl>,
    callerOverrides?: Constraints
  ): Computable<PropertyMap> {
    return Computable.forAll(
      entries.map((item): Computable<PropertyMapValue | PropertyMap> => {
        if (item.kind === DeclKind.MapSplice) {
          return this.resolveMapReference(item.ref, stack, stack, seen, callerOverrides);
        }
        const blocks = item.values.filter(isMapValue);
        if (blocks.length === 0) {
          /* A scalar entry keeps its value list (like any property), so a consumer
           * can serialize it as an array or join it per its own schema. */
          return this.resolveStringProperty(item, target, stack, callerOverrides).then(prop => prop.getValues());
        }
        if (blocks.length < item.values.length) {
          return Computable.reject(new Error(`map value '${item.name}' is either strings or maps, not a mix`));
        }
        return Computable.forAll(
          blocks.map(value => this.resolveMapBlock(value.entries, target, stack, seen, callerOverrides)),
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

  /**
   * Resolve a REWRITE property to a name-mapping function: each value is either
   * a `sel -> tmpl` rename (selected paths replay into the template) or a bare
   * constant (every path maps to it). Values are tried in written order,
   * first match wins; undefined means no value matched (the rule decides what
   * that means — passthrough, a default, or an error).
   */
  public resolveRewrite(
    prop: IPropertyDecl,
    target?: ITargetDecl,
    stack?: IDependencyStack,
    callerOverrides?: Constraints
  ): Computable<RewriteFn> {
    return this.resolveNameProperty(prop, target, stack, callerOverrides).then(makeRewrite);
  }

  /**
   * Resolve a single-valued projection property to its substituted Name (see
   * {@link TargetContext.getProjection}). A projection is one selector; more than
   * one value is a declaration error caught here.
   */
  public resolveProjection(
    prop: IPropertyDecl,
    target?: ITargetDecl,
    stack?: IDependencyStack,
    callerOverrides?: Constraints
  ): Computable<Name | undefined> {
    return this.resolveNameProperty(prop, target, stack, callerOverrides).then(names => {
      if (names.length > 1) {
        throw new Error(`property '${prop.name}' is a projection and takes a single value (found ${names.length})`);
      }
      return names[0];
    });
  }

  /**
   * Resolve a FILES property to its sources. Each resolved source is wrapped
   * with a model-ref provenance step recording the written value and the
   * constraints in effect — chained onto whatever provenance it already
   * carried, so that nested resolutions accumulate multi-hop chains.
   */
  public resolveFileProperty(
    prop: IPropertyDecl,
    target?: ITargetDecl,
    stack?: IDependencyStack,
    callerOverrides?: Constraints
  ): Computable<SourceRef[]> {
    return this.resolveValues(prop, target, stack, "files", (value, info) =>
      this.resolveFileValue(value.value, info, { callerOverrides, provenance: { value, property: prop, target } })
    ).then(lists => lists.flat());
  }

  /**
   * Resolve one file reference to its sources — the single choke point every
   * file resolution flows through: a property value ({@link resolveFileProperty}),
   * a `-D` constraint override ({@link getTarget}), a CLI `ls`/`cat`/`run` name
   * ({@link resolveName}), a command stage's tool or its `< stdin` redirect. The
   * reference's `<k=v>` requirement (and any caller
   * override) re-roots the resolving context (see {@link resolvingContextFor}),
   * under which it resolves to sources — target-prefix + `:`/glob projection etc.
   * ({@link resolveFileSource}), `relativeTo` rooting a bare path at the build
   * file it was written in. For a property value (`provenance` present) each
   * source is stamped with a model-ref step and a referenced target's failure /
   * mid-resolution conflict is wrapped against the written value; the
   * property-less callers carry no written value, so they stamp none (CLI/
   * override provenance origins are future work).
   */
  public resolveFileValue(
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
    /* A value written as `ref<k=v>` resolves under this context overridden by its
     * requirement, so the referenced target builds under those constraints and the
     * model-ref step (stamped by that context) records them. */
    return this.resolvingContextFor(name, options?.callerOverrides, stack).then(({ context, reference }) => {
      const resolved = context.resolveFileSource(reference, relativeTo, stack);
      if (!provenance) {
        return resolved.then(result => result.sources);
      }
      const { value, property, target } = provenance;
      return resolved
        .then(result => result.sources.map(source => context.withModelRef(source, value, property, target)))
        .catch(err => {
          /* A referenced target's failure crossing this written reference (it
           * failed to build, or no rule matched it): record the use site, so the
           * driver can render the dependant chain as "required by <target>
           * <property>" against the written value. */
          if (err instanceof DependencyFailedError || err instanceof NoRuleFoundError) {
            throw new ReferenceFailedError(value, property, target, err);
          }
          /* A conflict raised *during* this value's resolution (e.g. a rename
           * projection collapsing two files onto one name, or a union across its
           * containers) is thrown before withModelRef stamps the result, so its
           * sides lack this reference's step. Chain it on now, so the driver
           * traces the conflict back to the written value (the rename expression
           * included). */
          if (err instanceof ConflictError) {
            throw this.withConflictModelRef(err, value, property, target);
          }
          throw err;
        });
    });
  }

  /**
   * The context a reference resolves under, plus the reference with its
   * constraints stripped. They layer lowest-to-highest as **ambient (this) → the
   * reference's own `<k=v>` requirement → the caller's override**: the
   * requirement overrides the ambient config (its whole point), but a
   * consumer's *explicit* override — e.g. a rule forcing `BUILD_OPERATION=run`
   * on the tool it needs — is the operative requirement and wins over a stray
   * requirement on the same key. The reference is returned **fully substituted**
   * with its `<k=v>` stripped (bare parts), so resolution proceeds on the parts
   * and the merged context governs the build — and so every entry point that
   * routes through here (build/test/sync target names, file values, CLI names)
   * gets `${...}` substitution uniformly, not only the ones carrying a requirement.
   */
  private resolvingContextFor(
    name: Name,
    callerOverrides?: Constraints,
    stack?: IDependencyStack
  ): Computable<{ context: BuildContext; reference: Name }> {
    return this.substituteNameVars(name, stack).then(substituted => {
      if (!substituted.hasConstraints()) {
        return { context: this.getContextWithOverrides(callerOverrides), reference: substituted };
      }
      const required: Record<string, string> = Object.create(null);
      for (const [key, value] of substituted.getConstraints()) {
        required[key] = value.toString();
      }
      /* Caller override last, so it wins on a shared key. */
      const merged = Constraints.of(required).with(callerOverrides);
      return { context: this.getContextWithOverrides(merged), reference: substituted.withConstraints([]) };
    });
  }

  private modelRefStep(value: INameValue, property: IPropertyDecl, target?: ITargetDecl): IModelRefStep {
    return { kind: MODEL_REF_PROVENANCE, value, constraints: this.constraints, property, target };
  }

  private withModelRef(source: SourceRef, value: INameValue, property: IPropertyDecl, target?: ITargetDecl): SourceRef {
    const step = this.modelRefStep(value, property, target);
    if (source instanceof FileSet || source instanceof RepositoryRef) {
      return source.withStep(step);
    }
    return source;
  }

  /** Chain this reference's model-ref step onto both sides of a conflict raised
   * mid-resolution (before withModelRef ran), so the driver attributes it to the
   * written value. */
  private withConflictModelRef(
    err: ConflictError,
    value: INameValue,
    property: IPropertyDecl,
    target?: ITargetDecl
  ): ConflictError {
    const step = this.modelRefStep(value, property, target);
    const chain = (side: IConflictSide): IConflictSource => ({
      provenance: { ...step, parent: side.provenance },
      detail: side.detail,
    });
    return new ConflictError(err.kind, err.key, chain(err.left), chain(err.right));
  }

  /**
   * Resolve the Names as they appear in a target property list to their respective targets
   * (potentially causing them to be queued for evaluation), along with the declaration
   * the name resolved to (if it named a target or property rather than plain files).
   * @param name
   */
  /**
   * Resolve a name (target reference, projection, glob or bare path) to its
   * sources — the whole-name entry the CLI uses so `fabr ls`/`cat` reuse the
   * model's reference semantics (target-prefix + `:`/glob projection) rather
   * than splitting the name themselves. This IS a collection point: any external
   * reference the name resolves to (`@npm:esbuild:0.28.1`) is materialized here,
   * so a top-level external name resolves like any other. It is *shallow*
   * (`materializeShallow`): a verb wants the named entity's own content, not the
   * dependency closure a delivered package carries — that closure is discarded by
   * ls/cat and would re-resolve under the wrong operation (see materializeShallow).
   *
   * `ref` is the parsed name *as the value decl it was written in* — for a CLI
   * name, one the driver synthesizes over the command line ({@link
   * syntheticValue}), sited at the invocation directory. The decl is the whole
   * input: its `value` is the reference and its siting is what makes a bare
   * path resolve — the same arm that resolves `./packages` written in a build
   * file, rooting at the file's own directory.
   *
   * `options` is the calling verb's judgment of what it will do with the result
   * (see MaterializeOptions): `run` names a program to launch, so it passes
   * PERMISSIVE_RESOLUTION; the file verbs (ls/cat/cp) take the strict default.
   */
  public resolveName(
    ref: INameValue,
    stack?: IDependencyStack,
    options?: MaterializeOptions
  ): Computable<(FileSource | Repository)[]> {
    return this.resolveFileValue(ref.value, stack, { relativeTo: ref })
      .then(sources => materializeShallow(this.resolutionContext(), sources, options))
      .then(delivered => this.finishDelivered(delivered));
  }

  private resolveFileSource(
    name: Name,
    relativeTo: IDecl | undefined,
    stack?: IDependencyStack
  ): Computable<IResolvedFileSource> {
    return this.substituteNameVars(name, stack).then((substName): IResolvedFileSource | Computable<IResolvedFileSource> => {
      if (substName.isEmpty()) {
        return { sources: [] };
      } else {
        const targetDep = this.getPrefixTargetIfExists(substName, stack);
        if (targetDep) {
          const { target, rest, name: matchedName, retainedPrefix } = targetDep;
          if (rest.isEmpty()) {
            /* Nothing to project, so a `-> name` here renames what the whole
             * reference delivers: the package rename, the same rule a delivered
             * external one goes through — applied now rather than at a
             * collection point, a built package being in hand already. */
            const renameTo = substName.getRenameTo();
            return target.then(sources => ({
              sources: renameTo
                ? sources.map(source => renamedDelivery(source, renameTo, substName.toString()))
                : sources,
            }));
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
            return target.then((t): IResolvedFileSource | Computable<IResolvedFileSource> => {
              const references: SourceRef[] = [];
              const containers: FileSource[] = [];
              /* The literal-must-resolve error, when it applies here: only in a
               * property context (a CLI name reports through the driver's
               * "matched no files") and only when the WHOLE written name is
               * literal. Judged over `substName`, not over the projection: a
               * glob anywhere earlier (the part that chose the container) means
               * this step is applied to whatever that matched, so its finding
               * nothing is no more an error than the glob matching nothing. */
              const miss =
                relativeTo && !substName.hasGlob()
                  ? (): Error => new NameResolutionError(substName, declPosn(stack?.value ?? relativeTo), useSiteOf(stack))
                  : undefined;
              for (const source of t) {
                if (source instanceof RepositoryRef || source instanceof FileSetRef) {
                  references.push(source.find(rest, retainedPrefix));
                } else if (isRepository(source)) {
                  /* The rest is a requirement identifier followed by an optional
                   * projection into the delivered content — the repository vends
                   * the ref for the whole name: its identity portion claimed
                   * (`esbuild:0.28.1`), the remainder packed in as a projection
                   * into the resolved package (`:package.json`), riding the
                   * normal find/naming path (any rename facet rides the
                   * projection). The written-name rule applies to the
                   * projection, not to the requirement itself. */
                  /* Stamp the alias the repository was reached by, as written —
                   * how the resolution layer renders suggestions and progress in
                   * the user's own spelling. */
                  references.push(source.getRepositoryRef(rest).withRepositoryName(matchedName));
                } else if (source instanceof PackageFileSet || source instanceof RunnableFileSet) {
                  /* A projection into a package or a runnable DEFERS (a
                   * FileSetRef): applied eagerly it would erase what the
                   * consumer's reading needs — a package's identity (a package
                   * entry's projection selects the bin of the runnable it
                   * becomes), a runnable's launch machinery (its projection
                   * names an ENTRY, not files). The ref stays inert either way;
                   * the base's class decides how it collapses, at the point
                   * something is demanded of it. Ordinary consumers see the
                   * projected files when the ref manifests at their collection
                   * point, carrying this site's miss error for a literal that
                   * matches nothing. */
                  references.push(new FileSetRef(source, [{ pattern: rest, prefix: retainedPrefix }], miss));
                } else {
                  /* A container projects on its own terms (FileSource.find): a
                   * fileset filters + prefixes (or renames, per the facet). */
                  containers.push(source);
                }
              }
              if (containers.length === 0) {
                return { sources: references };
              }
              /* Each container projects separately and STAYS a separate source
               * (never merged — union, and its ConflictError, is the act of a
               * consumer that merges content). Each is an eagerly-applied
               * suspension — construct the ref, manifest it now — so the ONE
               * application path (manifest: polymorphic find + archive
               * descent) serves eager and deferred alike. No per-ref miss: the
               * literal-must-resolve judgment here is JOINT (below) — over all
               * containers and only when no deferred reference might still
               * deliver the name. Containers the projection missed are
               * dropped; one empty set is kept when nothing matched, so an
               * empty outcome still reaches the driver's "matched no files"
               * report. */
              return Computable.forAll(
                containers.map(container => this.manifest(new FileSourceRef(container, [{ pattern: rest, prefix: retainedPrefix }]))),
                (...projected: FileSet[]) => projected
              ).then(projected => {
                const matched = projected.filter(set => !set.isEmpty());
                if (matched.length === 0 && references.length === 0 && miss) {
                  throw miss();
                }
                return { sources: [...references, ...(matched.length > 0 ? matched : [EMPTY_FILESET])] };
              });
            });
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
          /* An eagerly-applied suspension over the source filesystem, its
           * literal-must-resolve error carried as the ref's `miss` — judged by
           * manifest, the one application path. A literal naming neither a
           * declaration nor a file: written in a build file that is a failed
           * value resolution; typed on the command line (no stack) it is the
           * very mistake getTarget reports for the build/test verbs, so it
           * reads the same and suggests the same way — one wording for one
           * mistake, whichever verb was used. */
          const miss = substName.hasGlob()
            ? undefined
            : (): Error => {
                const written = substName.toString();
                const reason = stack ? undefined : `Unknown name '${written}'`;
                return withHints(
                  new NameResolutionError(substName, declPosn(stack?.value ?? relativeTo), useSiteOf(stack), reason),
                  this.unknownNameHints(written, !stack)
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
          return this.manifest(new FileSourceRef(fs, [{ pattern, prefix: "" }], miss)).then(data => ({ sources: [data] }));
        } else {
          /* The one reference with no decl to root a bare path at: a constraint
           * override's value (see getTarget), whether it came from `-D` or a
           * `<k=v>` requirement — a constraint set carries the value, never where it
           * was written. Only a declared name can answer here. */
          const written = name.toString();
          throw this.unresolvedNameError(written, undefined, `Unknown name '${written}'`, this.unknownNameHints(written, true));
        }
      }
    });
  }

  public substituteNameVars(name: Name, stack?: IDependencyStack): Computable<Name> {
    const vars = name.getVariables();
    return Computable.forAll(
      vars.map(varName => this.getProperty(varName, stack)),
      (...resolvedVars) => {
        const substName = name.substitute(
          vars,
          resolvedVars.map(prop => prop.toString())
        );
        return substName;
      }
    );
  }

  /**
   * Resolve a bare reference to the property it names, if any: substitute its
   * variables (positioned via `info`) then look the result up. The single
   * primitive behind chasing one same-kind property from another — a map
   * reference (`metadata = SHARED`) or a command reference (`run = shared_cmd`);
   * each caller decides what a non-property result means (an error, or a
   * fallback). `name` is the substituted reference, for the caller's message.
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

  /**
   * Resolve a COMMAND property to its pipeline with every command/arg/redirect
   * name variable-substituted — the command analogue of resolveNameProperty. A
   * sole bare name that references another command-valued property is chased
   * (mirroring the map-reference chase), so a reusable command can be defined
   * once and referenced; anything else folds to a single `cmd args…` stage.
   * Each resolved name keeps its written {@link INameValue} as `ref` for
   * provenance and error positioning.
   */
  public resolveCommand(
    prop: IPropertyDecl,
    target?: ITargetDecl,
    stack?: IDependencyStack
  ): Computable<IResolvedCommandStage[]> {
    return this.getCommandPipeline(prop, target, stack, new Set()).then(stages =>
      Computable.forAll(
        stages.map(stage => this.resolveCommandStage(stage, prop, target, stack)),
        (...resolved: IResolvedCommandStage[]) => resolved
      )
    );
  }

  /** The raw (unsubstituted) pipeline of a command property: its parsed
   * pipeline, a single `cmd args…` stage, or — when the sole value references
   * another command-valued property — that property's pipeline (chased,
   * `seen`-guarded, mirroring resolveMapDecl). */
  private getCommandPipeline(
    prop: IPropertyDecl,
    target: ITargetDecl | undefined,
    stack: IDependencyStack | undefined,
    seen: Set<IPropertyDecl>
  ): Computable<CommandPipeline> {
    if (seen.has(prop)) {
      return Computable.reject(new Error(`Circular command reference at '${prop.name}'`));
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
      const info: IDependencyStack = { property: prop, target, context: this, value, next: stack };
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
  private resolveCommandStage(
    stage: ICommandStage,
    prop: IPropertyDecl,
    target: ITargetDecl | undefined,
    stack: IDependencyStack | undefined
  ): Computable<IResolvedCommandStage> {
    const position = (value: INameValue): Computable<IPositionedName> =>
      this.substituteNameVars(value.value, { property: prop, target, context: this, value, next: stack }).then(name => ({
        name,
        ref: value,
      }));
    const positionOpt = (value: INameValue | undefined): Computable<IPositionedName | undefined> =>
      value ? position(value) : Computable.resolve(undefined);
    return Computable.forAll(
      [
        position(stage.command),
        Computable.forAll(stage.args.map(position), (...args: IPositionedName[]) => args),
        positionOpt(stage.stdin),
        positionOpt(stage.stdout),
        positionOpt(stage.stderr),
        positionOpt(stage.both),
      ],
      (command, args, stdin, stdout, stderr, both): IResolvedCommandStage => ({ command, args, stdin, stdout, stderr, both })
    );
  }

  private resolveTarget(target: ITargetDecl, stack?: IDependencyStack): Computable<SourceRef[]> {
    const targetDef = this.model.getTargetDef(target.type);
    if (!targetDef) {
      throw new Error("Targetdef '" + target.type + "' not found"); /* Can't happen due to earlier checks */
    }
    /* Repositories are not rule-built targets: the provider constructs the
     * instance lazily, interned per context via the target cache. No build
     * events, no build-cache entries of its own. */
    const provider = this.model.getRepositoryProvider(target.type);
    if (provider) {
      return provider(new DeclaredTargetContext(target, targetDef, this, stack)).then(
        (repository): SourceRef[] => [repository],
        err => {
          throw new DependencyFailedError(target, err);
        }
      );
    }
    const rule = this.model.getTargetRule(target.type, this.constraints);
    if (!rule) {
      throw new NoRuleFoundError(target, this.constraints, this.model.getOperations(target.type));
    }
    return this.evaluateTarget(new DeclaredTargetContext(target, targetDef, this, stack), rule);
  }

  /**
   * Resolve a declared target to the {@link BuildAction} its rule yields, WITHOUT
   * running it — the basis for `fabr shell`, which stages the action's sandbox
   * and drops the user into a shell there instead of executing. The target's
   * *inputs* build as usual (they are what fills the sandbox: `srcs`, tool
   * mounts); only the target's own action is withheld. Resolves undefined when
   * the target's rule yields plain content (a flag, a passthrough) — there is no
   * command to shell into. Errors are wrapped to the target, as in a normal build.
   */
  public resolveActionForShell(name: string, stack?: IDependencyStack): Computable<BuildAction | undefined> {
    return this.resolvingContextFor(parseName(name), undefined, stack).then(({ context, reference }) =>
      context.resolveActionForShellDecl(reference.toString(), stack)
    );
  }

  private resolveActionForShellDecl(name: string, stack?: IDependencyStack): Computable<BuildAction | undefined> {
    const def = this.model.getDecl(name);
    if (def?.kind !== DeclKind.Target) {
      throw new Error(`'${name}' is not a target that runs a command`);
    }
    const targetDef = this.model.getTargetDef(def.type);
    if (!targetDef) {
      throw new Error("Targetdef '" + def.type + "' not found"); /* Can't happen due to earlier checks */
    }
    const rule = this.model.getTargetRule(def.type, this.constraints);
    if (!rule) {
      throw new NoRuleFoundError(def, this.constraints, this.model.getOperations(def.type));
    }
    const context = new DeclaredTargetContext(def, targetDef, this, stack);
    return rule
      .evaluate(context)
      .then(result => (result instanceof BuildAction ? result : undefined))
      .catch(err => {
        throw context.failure(err);
      });
  }

  /**
   * The shared evaluation core, uniform for declared and anonymous targets:
   * run the rule's evaluate, execute a yielded BuildAction through the cache,
   * stamp the producing target's provenance, and make the target the error
   * boundary (any failure wrapped to identify it). A target's sources always
   * flow as a list, so a rule's scalar result is just the one-element case; a
   * plural result (a `sync`'s member carriers) yields each element as its own
   * source, each stamped. No reporting happens here — the model layer doesn't
   * log; the driver renders the failure tree.
   */
  private evaluateTarget(context: TargetContext, rule: IRuleDefinition): Computable<SourceRef[]> {
    return rule
      .evaluate(context)
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

  /**
   * Build an anonymous target of the given (typically internal) type with the
   * given concrete inputs — the delegation a rule composes sub-builds with
   * (compile → run, object → link): "a <type> of these inputs, however the
   * system of rules builds one". It is an ordinary target: same evaluation
   * core, same rule selection (under the owner's constraints, with explicit
   * overrides available), same result contract — the delegate's sources, as
   * evaluated, unrestricted — its own context (bag-backed), provenance and
   * error boundary. It differs from a declared target only in having no
   * namespace entry and in receiving its inputs directly.
   */
  public buildSubTarget(
    owner: TargetContext,
    type: string,
    inputs: SubTargetInputs,
    options?: { label?: string; constraints?: Constraints }
  ): Computable<SourceRef[]> {
    const buildContext = this.getContextWithOverrides(options?.constraints);
    /* A sub-target type is part of the build vocabulary like any other: it must
     * be a registered targetdef, not merely a code-registered rule. A missing
     * targetdef is an internal inconsistency (the rule package forgot to declare
     * the type), never a user error — so a plain Error, not a diagnostic. Unlike
     * a declared target, a sub-target doesn't route through resolveTarget (it has
     * no decl), so the rule is checked here too rather than downstream. */
    const targetDef = this.model.getTargetDef(type);
    if (!targetDef) {
      throw new Error(`Internal error: sub-target type '${type}' has no registered targetdef`);
    }
    const rule = this.model.getTargetRule(type, buildContext.constraints);
    if (!rule) {
      throw new Error(`No rule found for anonymous target type '${type}'`);
    }
    const context = new AnonymousTargetContext(
      buildContext,
      targetDef,
      inputs,
      owner.getDeclaredContext(),
      options?.label,
      owner.stack
    );
    return buildContext.evaluateTarget(context, rule);
  }

  /**
   * Run a build action through the cache: the key is the step's identity plus
   * the canonical manifest of its (already-resolved) inputs — sound by
   * construction, since the step consumes nothing else. A miss is the moment
   * real work happens, and is announced as such (staging begins immediately;
   * the announcement marks a cache miss with work begun, never a hit). The
   * machine-wide bound is NOT taken here: step code holds no execution slot —
   * a slot is acquired around each process the step runs, inside the context's
   * {@link IActionContext.execute}/{@link IActionContext.executePipeline} —
   * so a step waiting on its processes (or on many of them in parallel) can
   * never hold a slot while waiting for one, and the funnel is deadlock-free
   * by construction. Steps still never run actions of their own (composition
   * is via sub-targets, whose actions complete before their output becomes
   * another action's inputs).
   */
  public runAction(action: BuildAction, context: TargetContext): Computable<FileSet> {
    const key = `rule:${action.step.id}:${action.step.version}\n${manifestEvalInputs(action.inputs)}`;
    const cache = this.execution.buildCache;
    const execution = this.execution;
    return this.getCachedOrBuild(key, targetDir => {
      context.announceBuilding();
      /* The cache owns the scratch dir and the content store, so the action's
       * context — work dir, streaming-output factory, and the run's execution
       * funnel — is assembled here, at the bridge between the cache's create
       * callback and the step. */
      const actionContext: IActionContext = {
        workDir: targetDir,
        createOutput: () => cache.getTemporaryWriteStream(),
        quiet: execution.quiet,
        processLimit: execution.processLimit,
      };
      return action.step.run(action.inputs, actionContext);
    });
  }

  private findTargetInStack(target: string, stack?: IDependencyStack): IDependencyStack | undefined {
    let node = stack;
    while (node) {
      if (node.target && declName(node.target) === target && node.context === this) {
        return node;
      }
      node = node.next;
    }
  }

  /** Only global-property nodes (no `target`) participate: a target property is
   * not in the `${}`/reference namespace, so it can never close a cycle — and it
   * may legitimately reference a same-named global. */
  private findPropertyInStack(property: string, stack?: IDependencyStack): IDependencyStack | undefined {
    let node = stack;
    while (node) {
      if (node.property.name.toBaseString() === property && node.target === undefined && node.context === this) {
        return node;
      }
      node = node.next;
    }
  }

  private assertNonCircularProperty(property: string, stack?: IDependencyStack): void {
    const entry = this.findPropertyInStack(property, stack);
    if (entry) {
      throw new CircularDependencyError(property, cycleFrom(stack, entry));
    }
  }

  private assertNonCircularTarget(target: string, stack?: IDependencyStack): void {
    const entry = this.findTargetInStack(target, stack);
    if (entry) {
      throw new CircularDependencyError(target, cycleFrom(stack, entry));
    }
  }
}

/**
 * The cycle's use sites, closing reference (the head of the stack, which named
 * an already-resolving name) first through to the entry that re-entered it. A
 * self-reference closes on the stack head itself, giving one site.
 */
function cycleFrom(stack: IDependencyStack | undefined, entry: IDependencyStack): IUseSite[] {
  const sites: IUseSite[] = [];
  let node = stack;
  while (node) {
    sites.push({ value: node.value, property: node.property, target: node.target });
    if (node === entry) {
      break;
    }
    node = node.next;
  }
  return sites;
}

/**
 * @return the distinct targets on the dependency stack (nearest requester
 * first, the given target itself excluded): the chain of demand that led to
 * this target being evaluated. Empty for a target requested directly.
 */
function requestingTargets(target: ITargetDecl, stack?: IDependencyStack): ITargetDecl[] {
  const result: ITargetDecl[] = [];
  for (let node = stack; node; node = node.next) {
    if (node.target && node.target !== target && !result.includes(node.target)) {
      result.push(node.target);
    }
  }
  return result;
}

/**
 * The context a rule's evaluate runs in: property and global resolution
 * for the target under evaluation, plus sub-target composition. Evaluate code
 * deliberately has no work directory and no cache access — all content work
 * goes through the BuildActions it yields (or the sub-targets it builds).
 *
 * A rule cannot tell whether it is building a declared or an anonymous target:
 * the interface is uniform, and only the two raw-value primitives
 * (`getProperty`, `getFileProperty`) and `announceBuilding` differ between the
 * two implementations. Everything else — materialization, flag extraction,
 * collection, globals, sub-targets — derives from those and is shared here.
 */
/** Pick the RunnableFileSet out of a resolved source list, or throw naming the
 * property/global that was expected to yield one. Shared by getGlobalRunnable
 * (a global) and getRunnableProperty (a FILES property). */
function asRunnable(sources: ReadonlyArray<FileSource | Repository | FileSetRef>, name: string): RunnableFileSet {
  for (const source of sources) {
    /* A projected runnable arrives pending; demanding a launcher is exactly the
     * point it collapses (a projection that matched nothing yields no runnable,
     * so it reports as "not a runnable" like any other non-runnable value). */
    const runnable = toRunnable(source);
    if (runnable) {
      return runnable;
    }
  }
  throw new Error(`'${name}' must name a runnable (its BUILD_OPERATION=run result)`);
}

/**
 * The error for reading a map (block-valued) property in a non-map context.
 * Enforcement lives in the readers, not the targetdef schema: each resolve
 * function refuses a value shape it cannot mean, rather than silently yielding
 * an empty result (`version = 1.0-${MAP}` interpolating to "1.0-", `deps = MAP`
 * contributing no files). The help line teaches the one sanctioned idiom.
 */
function mapInWrongContextError(prop: IPropertyDecl, context: string): Error {
  return attachHelp(
    new Error(`'${prop.name}' is a map and cannot be used as ${context}`),
    `a map is referenced by bare name from a MAP property (\`metadata = ${prop.name};\`); ` +
      `it cannot be \${...}-interpolated or read as files`
  );
}

function commandInWrongContextError(prop: IPropertyDecl): Error {
  return attachHelp(
    new Error(`'${prop.name}' contains a pipeline operator ('|', '<', '>', '2>', '&>'), which is only valid in a COMMAND property`),
    "quote it to use the character literally (e.g. `'|'`)"
  );
}

/** The rejection for a non-name value where a name/reference was required — a map
 * block or a command pipeline, each explained. `context` names the consuming use
 * in the map message ("a string", "files"). Resolution wants a name; anything else
 * is reported here rather than enumerating each excluded kind at the call site. */
function nonNameValueError(prop: IPropertyDecl, value: IMapValue | ICommandValue, context: string): Error {
  return isMapValue(value) ? mapInWrongContextError(prop, context) : commandInWrongContextError(prop);
}

/**
 * How a reader combines the declarations of one property that a configuration
 * admits: `"union"` for a list-shaped read (FILES, REWRITE — the values simply
 * concatenate, in written order), `"single"` for a scalar one, where two
 * matching declarations are an error rather than a silent join.
 */
/**
 * The applicable declarations as ONE — their values concatenated in written
 * order: what a list-shaped read (FILES, REWRITE) makes of several, which is
 * just the semantics a single declaration's value list already has.
 */
function mergedDecls(applicable: IPropertyDecl[]): IPropertyDecl | undefined {
  if (applicable.length <= 1) {
    return applicable[0];
  }
  /* One decl standing for the lot: the values in written order, and no guard
   * left to re-read (this IS the result of reading them). Its position is the
   * first contributor's, which is where a value error should point when the
   * diagnosis is "this property", not "this value" — a per-value error carries
   * its own value span regardless. */
  return {
    ...applicable[0],
    name: applicable[0].name.withConstraints([]),
    values: applicable.flatMap(decl => decl.values),
  };
}

/**
 * The single applicable declaration — what a scalar read (STRING, MAP, COMMAND,
 * a projection) requires. Two is the error it is: a scalar cannot silently join
 * them the way a list can, and guards are never ranked, so there is no tie to
 * break.
 */
function soleDecl(applicable: IPropertyDecl[]): IPropertyDecl | undefined {
  if (applicable.length > 1) {
    throw ambiguousDeclsError(applicable);
  }
  return applicable[0];
}

/** One declaration's guard as it was written (`<TARGET=*-linux-*, BUILD_TYPE=release>`),
 * for a message that has to say which declarations it is talking about. */
function guardText(decl: IPropertyDecl): string {
  return `<${decl.name
    .getConstraints()
    .map(([key, value]) => `${key}=${value.toString()}`)
    .join(", ")}>`;
}

/**
 * The selected declaration, or a hard error if every guard excluded this
 * configuration. A *global* has no default tier to fall back to (unlike a
 * target's property, which has its targetdef's declared default), so a property
 * written only under guards that do not match is simply not supplied here — and
 * saying that is far more use than the "unknown property" it is not.
 */
function unmatchedIfAbsent(selected: IPropertyDecl | undefined, name: string, entry: IPropertyEntry): IPropertyDecl {
  if (selected) {
    return selected;
  }
  const guards = [...entry.decls, ...entry.defaults].map(guardText);
  throw attachHelp(
    new Error(`'${name}' is declared, but no declaration of it applies to this configuration`),
    `it is declared under ${guards.join(", ")} — add an unguarded declaration, or a 'default ${name} = …;'`
  );
}

/** Two guards admitting one configuration, where only one value is wanted. Names
 * both, since the fix is to make them disjoint (or to write the fallback in the
 * targetdef's `default`), and neither is more wrong than the other. */
function ambiguousDeclsError(chosen: IPropertyDecl[]): Error {
  const guards = chosen.map(guardText).join(" and ");
  return attachHelp(
    new Error(`'${chosen[0].name}' is declared for this configuration by ${chosen.length} guards (${guards}), but takes a single value`),
    "guards are never ranked against each other, so make them disjoint — a fallback belongs in the targetdef's `default`"
  );
}

/** The requirement one dep source declares (see {@link TargetContext.collectDeclaredRequirements}). */
function declaredRequirementOf(source: SourceRef): Computable<Requirement | undefined> {
  if (source instanceof RepositoryRef) {
    return declaredRequirementFrom(source.source, source);
  }
  if (source instanceof PackageFileSet) {
    /* A built-package dep is versionless until publish, contributing `*` (rewritten at sync). */
    return Computable.resolve({ pkg: source.packageName, constraint: source.version ?? "*" });
  }
  /* A plain source dep (a compile input, not a package) carries no identity. */
  return Computable.resolve(undefined);
}

export abstract class TargetContext {
  public readonly context: BuildContext;
  public readonly stack?: IDependencyStack;
  /** The schema of the type being built — carried by every target, declared or
   * anonymous, so that a property's declared default is available wherever the
   * target supplies no value of its own. */
  protected readonly targetDef: ITargetDefDecl;

  constructor(context: BuildContext, targetDef: ITargetDefDecl, stack?: IDependencyStack) {
    this.context = context;
    this.targetDef = targetDef;
    this.stack = stack;
  }

  /**
   * The declared default for `name` as a property decl, or undefined if the
   * schema declares none. Every accessor consults this on the path where the
   * target supplies no value — an unwritten property on a declared target, an
   * absent key in a sub-target's input bag — so a default reaches both. A
   * sub-target therefore *omits* a key to take the default and passes an explicit
   * empty value to suppress it. The `*` wildcard entry carries no default: it
   * types keys the schema never named, so there is no property to default.
   */
  protected declaredDefault(name: string): IPropertyDecl | undefined {
    return this.targetDef.properties.get(name)?.default;
  }

  /** The name of the (declared) target being built — what a rule refers to
   * itself as; for an anonymous sub-target, its declared owner's name. */
  public abstract get name(): string;

  /** The raw value of a scalar property — resolved from the model, or read
   * from the anonymous target's input bag. */
  public abstract getProperty(name: string, overrides?: Constraints): Computable<Property | undefined>;

  /** The unmaterialized sources of a FILES property — resolved from the model
   * (references still inert), or the anonymous target's already-materialized
   * input (for which materialization is the identity). */
  public abstract getFileProperty(name: string, overrides?: Constraints): Computable<SourceRef[]>;

  /** Resolve a REWRITE property to its name-mapping function (see
   * resolveRewrite); the empty rewrite (no such property) maps nothing. */
  /**
   * A FILES property read as CONTAINED: the same sources, marked so a `collect`
   * leaves their projections pending instead of extracting the files. Use it
   * where the rule will place the container and locate within it
   * ({@link FileSet.locate}) — an entry that must keep working among its
   * siblings — and the plain {@link getFileProperty} everywhere else.
   *
   * Per property rather than per collect, because a rule commonly wants one
   * property contained and the rest extracted, and both must go through the one
   * collection point to resolve jointly.
   */
  public getContainedFileProperty(name: string, overrides?: Constraints): Computable<ContainedSources> {
    return this.getFileProperty(name, overrides).then(sources => new ContainedSources(sources));
  }

  public abstract getRewrite(name: string, overrides?: Constraints): Computable<RewriteFn>;

  /** Resolve a single-valued projection property (a selector + optional `-> tmpl`
   * rename, e.g. `generate`'s `output`) to its substituted Name — the input a
   * step applies via {@link Name.makeProjector}. Undefined when the property is
   * absent; a multi-value property is an error (a projection is one selector). */
  public abstract getProjection(name: string, overrides?: Constraints): Computable<Name | undefined>;

  /** Resolve a MAP property to its ordered key -> string map (see
   * resolveMap); an absent property yields an empty map. */
  public abstract getMap(name: string, overrides?: Constraints): Computable<PropertyMap>;

  /** Announce the declared target this evaluation belongs to as building
   * (once) — see DeclaredTargetContext; an anonymous target delegates to its
   * declared owner. */
  public abstract announceBuilding(): void;

  /** The declared target context this evaluation ultimately belongs to
   * (itself, for a declared target). */
  public abstract getDeclaredContext(): DeclaredTargetContext;

  /** Stamp the target's provenance onto a delivered FileSet: the declared
   * target's TARGET_PROVENANCE step; an anonymous target adds none (its
   * declared owner's stamp covers the composed result). */
  public abstract stampProvenance(result: FileSet): FileSet;

  /** Wrap a failure into this target's error boundary — a DependencyFailedError
   * identifying the declared target (an anonymous sub-target additionally
   * carries its action-verb label, for "Compiling X failed" rendering). */
  public abstract failure(err: Error): DependencyFailedError;

  /** The wildcard (reference-keyed) properties written in this target's body — the
   * members of a `sync` (`@npm:@fabr/core:${VERSION} = core`): each property's
   * coordinate `key` (the parsed reference, variables substituted) plus its `decl`
   * (for the written span, so a rule can attribute a per-member error, and for its
   * `name`, under which the right-hand side content resolves via `getFileProperty`).
   * Enumeration only — no content is gathered, so a rule can validate every
   * coordinate before building anything. Ordinary schema properties are not
   * returned; an anonymous target has none. `overrides` set the context the
   * coordinate's `${...}` substitutes under, uniform with the other accessors. */
  public abstract getWildcardProperties(overrides?: Constraints): Computable<{ key: Name; decl: IPropertyDecl }[]>;

  /** The substituted-name pipeline of a COMMAND property (see
   * {@link BuildContext.resolveCommand}): its parsed stages (or the single stage a
   * bare `cmd args…` folds to, or a chased command-property reference), variables
   * substituted, each name carrying its written span. Internal — the rule-facing
   * form is {@link getCommandProperty}. Empty if absent; declared targets only. */
  protected abstract getCommandStages(name: string): Computable<IResolvedCommandStage[]>;

  /**
   * The fully-resolved pipeline of a COMMAND property, ready for a `generate`
   * rule: each stage's command resolved to a runnable, its args globbed over
   * `srcs` (failglob), its `< source` to a single-file set, and its redirect
   * targets to content names. Empty if the property is absent. The one command
   * resolution surface a rule needs — substitution + the chase happen underneath
   * ({@link getCommandStages}).
   */
  public getCommandProperty(name: string, srcs: FileSet): Computable<ResolvedCommandPipeline> {
    return this.getCommandStages(name).then(stages =>
      Computable.forAll(
        stages.map(stage => this.resolveStage(stage, srcs)),
        (...resolved: ResolvedCommandStage[]) => resolved
      )
    );
  }

  /** Resolve one substituted stage: command → runnable, args → globs over
   * `srcs`, `< source` → single file, redirect targets → content names. */
  private resolveStage(stage: IResolvedCommandStage, srcs: FileSet): Computable<ResolvedCommandStage> {
    return Computable.forAll(
      [this.resolveCommandRunnable(stage.command), this.resolveStdin(stage.stdin), this.expandArgs(stage.args, srcs)],
      (runnable: RunnableFileSet, stdin: FileSet | undefined, args: string[]): ResolvedCommandStage => ({
        runnable,
        args,
        stdin,
        stdout: stage.stdout?.name.toString(),
        stderr: stage.stderr?.name.toString(),
        both: stage.both?.name.toString(),
      })
    );
  }

  /** Expand a stage's args over the staged `srcs`: a glob arg matches file names
   * in `srcs` (failglob — an empty match is a positioned error); a literal arg
   * passes through. */
  private expandArgs(args: IPositionedName[], srcs: FileSet): Computable<string[]> {
    return Computable.forAll(
      args.map(arg => {
        if (!arg.name.hasGlob()) {
          return Computable.resolve([arg.name.toString()]);
        }
        return srcs.find(arg.name).then(matched => {
          const names = [...matched].map(([fileName]) => fileName).sort();
          if (names.length === 0) {
            throw new NameResolutionError(arg.name, declPosn(arg.ref), useSiteOf(this.stack), "no files in 'srcs' match this glob");
          }
          return names;
        });
      }),
      (...expanded: string[][]) => expanded.flat()
    );
  }

  /** Resolve a stage's command to the runnable it names, under runOverrides (the
   * tool executes on this machine — see getRunnableProperty). The command is a
   * written reference, resolved through the ordinary file core (not a
   * declared-name lookup like {@link getGlobalRunnable}'s), so it may be a target
   * or global (`gendoc`, `TSC`), an external requirement (`@npm:typia:9.7.1`), a
   * projection into either (`@pkg:typescript:tsc`), or a path rooted at the build
   * file it was written in. */
  private resolveCommandRunnable(command: IPositionedName): Computable<RunnableFileSet> {
    return this.context
      .resolveFileValue(command.name, this.stack, { relativeTo: command.ref, callerOverrides: this.runOverrides() })
      .then(sources => materializeLists(this.context.resolutionContext(), [sources], PERMISSIVE_RESOLUTION))
      .then(([resolved]) => this.context.finishDelivered(resolved))
      .then(resolved => asRunnable(resolved, command.name.toString()));
  }

  /** Resolve a stage's `< source` to a single-file set (streamed to stdin), or
   * undefined if the stage takes no stdin. Resolved through the file core (like a
   * FILES value), so a `< src/input.txt` path — rooted at the build file it was
   * written in — works, not only a declared name. */
  private resolveStdin(stdin: IPositionedName | undefined): Computable<FileSet | undefined> {
    if (!stdin) {
      return Computable.resolve(undefined);
    }
    return this.context
      .resolveFileValue(stdin.name, this.stack, { relativeTo: stdin.ref })
      .then(sources => materializeLists(this.context.resolutionContext(), [sources]))
      .then(([resolved]) => this.context.finishDelivered(resolved))
      .then(resolved => {
        const set = FileSet.unionAll(...resolved.filter((source): source is FileSet => source instanceof FileSet));
        const files = [...set];
        if (files.length !== 1) {
          throw new NameResolutionError(
            stdin.name,
            declPosn(stdin.ref),
            useSiteOf(this.stack),
            `stdin source must resolve to exactly one file (got ${files.length})`
          );
        }
        return new FileSet(new Map([[files[0][0], files[0][1]]]));
      });
  }

  /**
   * Resolve a *write* coordinate — a `sync` member's `@npm:@fabr/core:0.1`,
   * which names where content goes rather than content to read (and may not
   * exist on the registry yet) — to a vended publish ref: the repository alias
   * splits off (the same prefix match the read path uses) and the repository
   * vends a ref for the remainder ({@link Repository.getRepositoryPublishRef} — which throws,
   * without fetching anything, if the address is malformed or the repository is
   * not a publish destination). The reference is expected already
   * variable-substituted (`getWildcardProperties` does that for a sync's keys).
   */
  public resolvePublishRef(name: Name): Computable<RepositoryPublishRef> {
    const match = this.context.getPrefixTargetIfExists(name, this.stack);
    if (!match) {
      return Computable.reject(new Error(`'${name.toString()}' does not name a repository`));
    }
    return match.target.then(sources => {
      const repository = sources.find((source): source is Repository => isRepository(source));
      if (!repository) {
        throw new Error(`'${name.toString()}' does not name a repository`);
      }
      return repository.getRepositoryPublishRef(match.rest).withRepositoryName(match.name);
    });
  }

  public getRequiredProperty(name: string, overrides?: Constraints): Computable<Property> {
    return this.getProperty(name, overrides).then(prop => {
      if (!prop) {
        throw new Error("Missing required property " + name);
      }
      return prop;
    });
  }

  public getRequiredString(name: string, overrides?: Constraints): Computable<string> {
    return this.getRequiredProperty(name, overrides).then(prop => prop.toString());
  }

  /** An optional STRING property; undefined when not written and no default. */
  public getString(name: string, overrides?: Constraints): Computable<string | undefined> {
    return this.getProperty(name, overrides).then(prop => prop?.toString());
  }

  /**
   * Resolve-phase memoization: results of pure resolution work (e.g. a joint
   * version selection), persisted under `memo:<tag> <key>`. The tag is a
   * stable `name:version` — bump the version when the computation's behavior
   * changes. Distinct from evaluate entries, and never announced as building.
   */
  public memoize(tag: string, key: string, create: (targetDir: string) => Computable<FileSet>): Computable<FileSet> {
    return this.context.getCachedOrBuild(`memo:${tag} ${key}`, create);
  }

  /**
   * Settle deferred sources (as {@link getFileProperty} returns them) to their
   * delivered content: references resolve and fetch, pending projections apply
   * (with archive descent), plain content passes through — the collection-point
   * machinery bound to this context. This is how a content-backed registry
   * member (a `repository_group` content route) reads the declared source it
   * serves, at resolve time.
   */
  public materializeSources(sources: SourceRef[]): Computable<(FileSource | Repository | FileSet)[]> {
    return materializeAll(this, sources).then(delivered => this.context.finishDelivered(delivered));
  }

  /**
   * The run's fixed surroundings — the build cache, log, source/absolute
   * FileSources (for config a repository consults, e.g. a `.npmrc` read through
   * the source FS so it participates in watch-mode invalidation), and per-plugin
   * state. Shared by every BuildContext of the run.
   */
  public get execution(): ExecutionContext {
    return this.context.execution;
  }

  /**
   * Download through the cache (see BuildCache.getOrFetch); an actual fetch
   * (a miss) is announced as progress, attributed to this evaluation's declared
   * target. The optional `resource` is a human noun for what is being fetched
   * (e.g. "metadata", "package"), carried on the progress event for display.
   * `options.immutable = false` declares a mutable pointer document (see
   * FetchOptions) — cached per HTTP caching semantics and revalidated,
   * instead of frozen forever.
   */
  public fetch(
    url: string,
    tag: string,
    process: (content: Readable, ctx: IFetchContext) => Computable<FileSet>,
    resource?: string,
    headers?: Record<string, string>,
    options?: FetchOptions
  ): Computable<FileSet> {
    return this.context.getCachedOrFetch(
      url,
      tag,
      (content, ctx) => {
        this.notifyProgress({ kind: "fetch", url, target: this.getDeclaredContext().target, resource });
        return process(content, ctx);
      },
      headers,
      options
    );
  }

  public getFlags(name: string, overrides?: Constraints): Computable<Flag[]> {
    return this.getFileProperty(name, overrides).then(sources => sources.filter(source => source instanceof Flag) as Flag[]);
  }

  /**
   * Resolve several named FILES properties to their materialized FileSets (one
   * list per property, per contributing source, before any merging) through a
   * SINGLE joint materialization — the common-case sugar for {@link collect}:
   * `getFileSetProperties(["srcs", "deps"])` yields `{ srcs, deps }`, both
   * resolved together so their references pin jointly. This IS the evaluation's
   * collection point; naming every file property in the one call is what makes
   * it singular by design (there is no per-property materializer left to
   * fragment it). `overrides` apply uniformly to the batch. Reach for the
   * underlying {@link getFileProperty} + {@link collect} only when you also need
   * the raw sources (a manifest via {@link collectDeclaredRequirements}), must
   * merge or mix in a global, or feed a shared helper.
   */
  public getFileSetProperties<const N extends readonly string[]>(
    names: N,
    overrides?: Constraints
  ): Computable<{ [K in N[number]]: FileSet[] }> {
    const parts: Record<string, Computable<SourceRef[]>> = {};
    for (const name of names) {
      parts[name] = this.getFileProperty(name, overrides);
    }
    return this.collect(parts) as Computable<{ [K in N[number]]: FileSet[] }>;
  }

  /**
   * THE collection point of this evaluation: materialize several named
   * source lists (properties via getFileProperty, globals via
   * getGlobalFileProperty, or already-gathered arrays) through a SINGLE joint
   * materialization, so every deferred reference they carry — however many
   * properties and globals it spans — is partitioned into one batch per
   * repository and resolved together, with the consumer's own pins
   * participating across the lot. Results come back per name, filtered to
   * materialized FileSets (a Flag extends FileSet and rides through as a
   * fileless set — read it via getFlags; only non-FileSet sources drop out).
   *
   * `parts` may be a plain record (the usual fixed developer-written part
   * names) or a Map, which returns a Map — required when the part names are
   * user-supplied (a sync's written coordinates), per the user-keyed
   * dictionaries rule.
   *
   * `options.resolutionMode = "permissive"` declares this collection point's
   * deliveries sealed program installs (a runnable-definer's assembly) —
   * resolution repairs are accepted rather than errors; see MaterializeOptions.
   * A part read through {@link getContainedFileProperty} keeps its projections
   * pending, for a consumer that reinterprets them (see FileSetRef); every other
   * part manifests to its plain projected files. Rule code only: the judgments
   * are structural, never user configuration.
   */
  public collect<P extends Record<string, CollectPart>>(
    parts: P,
    options?: MaterializeOptions
  ): Computable<Collected<P>>;
  /* A Map's keys are user-supplied, so there is nothing static to map over: a
   * plain Map settles to content, and one holding a contained part types as the
   * union throughout, for the caller to narrow. */
  public collect(
    parts: Map<string, SourceRef[] | Computable<SourceRef[]>>,
    options?: MaterializeOptions
  ): Computable<Map<string, FileSet[]>>;
  public collect(
    parts: Map<string, CollectPart>,
    options?: MaterializeOptions
  ): Computable<Map<string, (FileSet | FileSetRef)[]>>;
  public collect(
    parts: Record<string, CollectPart> | Map<string, CollectPart>,
    options?: MaterializeOptions
  ): Computable<Record<string, (FileSet | FileSetRef)[]> | Map<string, (FileSet | FileSetRef)[]>> {
    const entries = parts instanceof Map ? [...parts] : Object.entries(parts);
    return Computable.forAll(
      entries.map(([, value]) => (value instanceof Computable ? value : Computable.resolve(value))),
      (...values: Array<SourceRef[] | ContainedSources>) => {
        /* Which parts asked to stay in their containers — per property, since a
         * rule commonly wants one contained (`entry`) and the rest extracted. */
        const contained = values.map(value => value instanceof ContainedSources);
        const lists = values.map(value => (value instanceof ContainedSources ? value.sources : value));
        return materializeLists(this.context.resolutionContext(), lists, options).then(partitions => {
          /* The delivery machinery returns entities with their projections
           * pending; the context — the driver — finishes the walk here, except
           * for the parts whose consumer reinterprets the pending refs. */
          const settled = Computable.forAll(
            partitions.map((partition, index) =>
              contained[index]
                ? Computable.resolve(partition)
                : this.context.finishDelivered(partition)
            ),
            (...finished: Materialized[][]) => finished
          );
          return settled.then(all => {
            const filtered = all.map(partition =>
              partition.filter((source): source is FileSet | FileSetRef => source instanceof FileSet || source instanceof FileSetRef)
            );
            if (parts instanceof Map) {
              return new Map(entries.map(([name], i) => [name, filtered[i]]));
            }
            const result: Record<string, (FileSet | FileSetRef)[]> = {};
            entries.forEach(([name], i) => {
              result[name] = filtered[i];
            });
            return result;
          });
        });
      }
    );
  }

  /**
   * Manifest any pending refs among `sources` — the settling step of a
   * consumer that collected a contained part but wants plain content for a
   * particular part after all: the walk resumed by the context, cached
   * expansion and all (see BuildContext.finishDelivered).
   */
  public manifestAll(sources: ReadonlyArray<FileSet | FileSetRef>): Computable<FileSet[]> {
    return this.context.finishDelivered(sources);
  }

  /**
   * The declared requirement each of `sources` states — the sibling of
   * {@link collect}: where collect materializes sources to content, this reads
   * their declared identity, for generating a manifest (a lockfile-free dependency
   * list records what was *declared*, not what resolution pinned). A repository
   * reference asks its own repository (npm reads `pkg:1.2.3` off the ref; a catalog
   * looks the member up and delegates to its source); a built-package dep is
   * versionless until publish (`*`); anything else declares nothing. The result is
   * parallel to `sources`, undefined where a source declares nothing to record.
   */
  public collectDeclaredRequirements(sources: SourceRef[]): Computable<(Requirement | undefined)[]> {
    return Computable.forAll(sources.map(declaredRequirementOf), (...requirements) => requirements);
  }

  /**
   * Build an anonymous target of the given internal type with concrete
   * inputs, returning its cached output — how a rule composes a sub-build
   * (e.g. the compiled tree consumed by both the package and the test run).
   * The sub-target's rule reads those inputs through the same context
   * accessors (getFileSetProperties, getRequiredString, …) as any target. The delegation
   * itself is unrestricted (whatever rule selection picks, whatever it
   * yields — see buildSubTarget); this narrows to the common case, one
   * FileSet, because the caller wires the result straight into inputs or
   * reshaping. A delegate yielding anything else is an error *here*, at the
   * expectation, not in the mechanism.
   */
  public subTarget(
    type: string,
    inputs: SubTargetInputs,
    options?: { label?: string; constraints?: Constraints }
  ): Computable<FileSet> {
    return this.context.buildSubTarget(this, type, inputs, options).then(result => {
      if (result.length === 1 && result[0] instanceof FileSet) {
        return result[0];
      }
      throw new Error(`Anonymous target type '${type}' did not produce a single file content`);
    });
  }

  /** Emit a progress event on behalf of this target (see ProgressEvent) */
  public notifyProgress(event: ProgressEvent): void {
    this.context.execution.notifyProgress(event);
  }

  public getGlobalString(name: string, overrides?: Constraints): Computable<string> {
    return this.getGlobalProperty(name, overrides).then(prop => prop.toString());
  }

  public getGlobalProperty(name: string, overrides?: Constraints): Computable<Property> {
    return this.context.getProperty(name, this.stack, overrides);
  }

  /**
   * The constraint overrides for resolving a target in order to *run* it: force
   * BUILD_OPERATION=run and pin TARGET back to HOST. You run on the machine
   * you're on, so a runnable is always for the host — and this is what makes a
   * build *tool* (resolved under run) select its host binary even inside a
   * cross-build, where the ambient TARGET is some other platform. HOST is a
   * driver-injected fact; if it is somehow unset, TARGET is left to propagate.
   */
  public runOverrides(extra?: Constraints): Constraints {
    const host = this.context.getConstraint(HOST);
    return RUN_OVERRIDE.with(host ? Constraints.of({ [TARGET]: host }) : undefined).with(extra);
  }

  /**
   * Resolve a global that names a **runnable tool** (e.g. `TSC`) to its host
   * runnable — see getRunnableProperty; this is the global-property counterpart.
   */
  public getGlobalRunnable(name: string): Computable<RunnableFileSet> {
    /* A tool resolves *apart* from the workspace's collection point — its pins
     * deliberately don't co-resolve with what it builds — so it materializes on
     * its own here rather than through `collect`. */
    return this.context
      .getTarget(name, this.stack, this.runOverrides())
      .then(sources => materializeLists(this.context.resolutionContext(), [sources], PERMISSIVE_RESOLUTION))
      .then(([resolved]) => this.context.finishDelivered(resolved))
      .then(resolved => asRunnable(resolved, name));
  }

  /**
   * Resolve a FILES **property** that names a **runnable tool to execute now**
   * (e.g. a `run` target's `tool`): resolved under runOverrides (BUILD_OPERATION=run
   * with TARGET pinned to HOST, so the tool is its *host* binary even in a
   * cross-build — a build-time tool executes on this machine), and asserted to be a
   * RunnableFileSet. The caller launches it via `toCommandLine`. The host-pinning is
   * internal by design: a consumer resolving a tool to run it needn't restate it.
   *
   * `fallbackGlobal` names the project-wide default to use when the target
   * declares none (`test_runner`, else `JS_TEST_RUNNER`) — the per-target
   * override of a project-wide tool choice, which the targetdef schema has no
   * way to express (it types properties, it does not value them).
   */
  public getRunnableProperty(name: string, fallbackGlobal?: string): Computable<RunnableFileSet> {
    return this.getFileProperty(name, this.runOverrides()).then(sources => {
      if (sources.length === 0 && fallbackGlobal !== undefined) {
        return this.getGlobalRunnable(fallbackGlobal);
      }
      return materializeLists(this.context.resolutionContext(), [sources], PERMISSIVE_RESOLUTION)
        .then(([resolved]) => this.context.finishDelivered(resolved))
        .then(resolved => asRunnable(resolved, name));
    });
  }

  /**
   * A global (build-config) FILES property's unmaterialized sources — the global
   * counterpart of {@link getFileProperty}, with any repository references still
   * inert, for feeding into `collect` so they resolve jointly with the
   * evaluation's other requirements. Overrides ride as callerOverrides (caller
   * precedence over a requirement on the global's value).
   */
  public getGlobalFileProperty(name: string, overrides?: Constraints): Computable<SourceRef[]> {
    return this.context.getTarget(name, this.stack, overrides);
  }
}

/**
 * A declared target's context: properties resolve from its `ITargetDecl`, and
 * it owns the "is building" announcement (fired once, at the first actual
 * cache miss beneath it — an evaluation is only *potentially* a build, since
 * it may be served entirely from cache or produce content with no build).
 */
export class DeclaredTargetContext extends TargetContext {
  public readonly target: ITargetDecl;
  private readonly props: Map<string, IPropertyDecl[]>;
  /** The build cycle in which this target last announced itself building, so a
   * watch rebuild (a new cycle) re-announces while a single cycle announces once
   * however many sub-actions miss the cache. */
  private announcedGeneration = -1;

  constructor(target: ITargetDecl, targetDef: ITargetDefDecl, context: BuildContext, stack?: IDependencyStack) {
    super(context, targetDef, stack);
    this.target = target;
    /* Collate the body's declarations by name: a property may be written more
     * than once, its declarations told apart by their guards (Validate rejects
     * any other repeat), and which of them apply is decided per read. */
    this.props = new Map();
    for (const prop of target.properties) {
      const existing = this.props.get(prop.name.toBaseString());
      if (existing) {
        existing.push(prop);
      } else {
        this.props.set(prop.name.toBaseString(), [prop]);
      }
    }
  }

  /**
   * The declarations of `name` that apply here: whichever of this target body's
   * declarations of it this configuration admits, else the schema's declared
   * default — exactly the two tiers a global has, so both go through the one
   * filter ({@link BuildContext.getAvailableDecls}). Empty when neither exists,
   * or when every guard excluded this configuration and the schema declares no
   * default: a guard makes the property unwritten *here*, so what follows is
   * what follows for a target that never mentioned it. Each accessor then says
   * what it makes of more than one.
   */
  private availableFor(name: string): Computable<IPropertyDecl[]> {
    const declared = this.declaredDefault(name);
    return this.context.getAvailableDecls(
      { kind: DeclKind.Property, decls: this.props.get(name) ?? [], defaults: declared ? [declared] : [] },
      this.stack
    );
  }

  public get name(): string {
    return declName(this.target);
  }

  /* Every accessor resolves on the ambient context and threads the caller's
   * override through as callerOverrides, so it is applied *last* (winning over
   * any per-reference `<k=v>` requirement) — the uniform ambient < requirement <
   * caller layering, rather than pre-baking the override into ambient (where it
   * would beat it). */
  public getProperty(name: string, overrides?: Constraints): Computable<Property | undefined> {
    return this.availableFor(name).then(applicable => {
      const prop = soleDecl(applicable);
      return prop ? this.context.resolveStringProperty(prop, this.target, this.stack, overrides) : undefined;
    });
  }

  public getFileProperty(name: string, overrides?: Constraints): Computable<SourceRef[]> {
    return this.availableFor(name).then(applicable => {
      const prop = mergedDecls(applicable);
      return prop ? this.context.resolveFileProperty(prop, this.target, this.stack, overrides) : [];
    });
  }

  public getRewrite(name: string, overrides?: Constraints): Computable<RewriteFn> {
    return this.availableFor(name).then(applicable => {
      const prop = mergedDecls(applicable);
      return prop ? this.context.resolveRewrite(prop, this.target, this.stack, overrides) : (): undefined => undefined;
    });
  }

  public getProjection(name: string, overrides?: Constraints): Computable<Name | undefined> {
    return this.availableFor(name).then(applicable => {
      const prop = soleDecl(applicable);
      return prop ? this.context.resolveProjection(prop, this.target, this.stack, overrides) : undefined;
    });
  }

  public getMap(name: string, overrides?: Constraints): Computable<PropertyMap> {
    return this.availableFor(name).then(applicable => {
      const prop = soleDecl(applicable);
      return prop ? this.context.resolveMap(prop, this.target, this.stack, overrides) : new Map();
    });
  }

  public getDeclaredContext(): this {
    return this;
  }

  public getWildcardProperties(overrides?: Constraints): Computable<{ key: Name; decl: IPropertyDecl }[]> {
    /* EVERY property the targetdef does not explicitly declare is a member —
     * a reference-shaped name carries its parsed keyRef, and a bare identifier
     * (`lodash = @npm;`) IS its own key. The schema's `*` entry is the wildcard
     * TYPE declaration, not a property named `*`, so a literal `*` member (a
     * group's catch-all route) is a member like any other. */
    const declared = this.target.properties.filter(
      prop => prop.name.toBaseString() === "*" || !this.targetDef.properties.has(prop.name.toBaseString())
    );
    /* Enumeration only: substitute the member keys (under any caller override,
     * so their `${...}` resolves consistently with every other name) and hand
     * back their decls; content is gathered later so keys can be validated
     * first. A member key is an address, not a build reference — it carries
     * no `<k=v>` requirement to layer against the override — so setting the context
     * (getContextWithOverrides) is equivalent here to threading callerOverrides. */
    const context = this.context.getContextWithOverrides(overrides);
    /* A member is enumerated, never looked up by name, so its guard is applied
     * per declaration rather than through the tiers: members do not combine
     * (each is its own key), so there is nothing to union or to call ambiguous —
     * a guard here just decides whether the member exists in this configuration.
     * (A *reference*-keyed member — a `sync` coordinate — cannot carry one: the
     * key's own `<…>` is read in decl position too, so it guards the member.) */
    return Computable.forAll(
      declared.map(prop => context.guardAdmits(prop.name.getConstraints(), this.stack)),
      (...admitted: boolean[]) => declared.filter((_, i) => admitted[i])
    ).then(members =>
      Computable.forAll(
        members.map(prop => context.substituteNameVars(prop.name.withConstraints([]), this.stack)),
        (...keys: Name[]) => keys.map((key, i) => ({ key, decl: members[i] }))
      )
    );
  }

  protected getCommandStages(name: string): Computable<IResolvedCommandStage[]> {
    return this.availableFor(name).then(applicable => {
      const prop = soleDecl(applicable);
      return prop ? this.context.resolveCommand(prop, this.target, this.stack) : [];
    });
  }

  public stampProvenance(result: FileSet): FileSet {
    const step: ITargetOrigin = { kind: TARGET_PROVENANCE, decl: this.target, parent: result.origin };
    return result.withOrigin(step);
  }

  public failure(err: Error): DependencyFailedError {
    return new DependencyFailedError(this.target, err);
  }

  public announceBuilding(): void {
    const generation = this.context.execution.buildGeneration;
    if (this.announcedGeneration === generation) {
      return;
    }
    this.announcedGeneration = generation;
    this.notifyProgress({
      kind: "target-build",
      target: this.target,
      operation: this.context.getConstraint(BUILD_OPERATION) ?? "build",
      constraints: this.context.getConstraints(),
      requiredBy: requestingTargets(this.target, this.stack),
    });
  }
}

/**
 * An anonymous (sub-)target's context: it has no declaration — its properties
 * come from the concrete input bag the caller supplied (a FileSet is a
 * SourceRef; a string wraps as a Property), so materialization/collection over
 * them are no-ops. It carries only the declared owner it was built under and
 * an action-verb `label` ("Compiling"): failures attribute to the declared
 * target with that label, provenance is left to the declared owner's stamp,
 * and the build announcement delegates to the declared owner.
 *
 * The label is **optional**, and its absence is meaningful: a sub-target with
 * one is a distinguishable step *within* the target's work ("Compiling X"), one
 * without simply IS that work, decomposed for structure rather than for
 * display — so it announces nothing of its own (the umbrella "Testing X"
 * already says it) and its failures attribute to the declared target plainly.
 */
export class AnonymousTargetContext extends TargetContext {
  private readonly inputs: SubTargetInputs;
  private readonly declared: DeclaredTargetContext;
  private readonly label: string | undefined;

  constructor(
    context: BuildContext,
    targetDef: ITargetDefDecl,
    inputs: SubTargetInputs,
    declared: DeclaredTargetContext,
    label: string | undefined,
    stack?: IDependencyStack
  ) {
    super(context, targetDef, stack);
    this.inputs = inputs;
    this.declared = declared;
    this.label = label;
  }

  public get name(): string {
    return this.declared.name;
  }

  /** An anonymous sub-target has no declaration body, so no wildcard properties. */
  public getWildcardProperties(): Computable<{ key: Name; decl: IPropertyDecl }[]> {
    return Computable.resolve([]);
  }

  /* Every accessor takes the caller's bag entry when present and falls back to
   * the type's declared default when absent — so a sub-target of a type whose
   * schema declares defaults gets them exactly as a written target of that type
   * would, rather than silently seeing an empty property. A default resolves
   * against no target decl: it was written in the targetdef, and `${...}` in a
   * property value substitutes from globals in any case, so the decl only ever
   * served to position errors — which for a sub-target belong to its declared
   * owner (see `failure`). */

  /** A sub-target has no declaration body of its own, so a command can only come
   * from the type's declared default. */
  protected getCommandStages(name: string): Computable<IResolvedCommandStage[]> {
    const decl = this.declaredDefault(name);
    return decl ? this.context.resolveCommand(decl, undefined, this.stack) : Computable.resolve([]);
  }

  public getProperty(name: string, overrides?: Constraints): Computable<Property | undefined> {
    const value = this.inputs[name];
    if (value === undefined) {
      const decl = this.declaredDefault(name);
      return decl
        ? this.context.resolveStringProperty(decl, undefined, this.stack, overrides)
        : Computable.resolve(undefined);
    }
    return Computable.resolve(new Property((Array.isArray(value) ? value : [value]) as string[]));
  }

  public getFileProperty(name: string, overrides?: Constraints): Computable<SourceRef[]> {
    const value = this.inputs[name];
    if (value === undefined) {
      const decl = this.declaredDefault(name);
      return decl ? this.context.resolveFileProperty(decl, undefined, this.stack, overrides) : Computable.resolve([]);
    }
    return Computable.resolve((Array.isArray(value) ? value : [value]) as SourceRef[]);
  }

  /** Sub-targets take concrete inputs, not REWRITE property declarations, so a
   * rewrite can only come from the type's declared default. */
  public getRewrite(name: string, overrides?: Constraints): Computable<RewriteFn> {
    const decl = this.declaredDefault(name);
    return decl ? this.context.resolveRewrite(decl, undefined, this.stack, overrides) : Computable.resolve(() => undefined);
  }

  /** A sub-target's projection input, if the caller supplied a Name in the bag
   * (a bare selector or a `-> tmpl` rename), else the type's declared default.
   * A bag entry that is not a Name declares none — and takes no default, having
   * been supplied. */
  public getProjection(name: string, overrides?: Constraints): Computable<Name | undefined> {
    const value = this.inputs[name];
    if (value === undefined) {
      const decl = this.declaredDefault(name);
      return decl ? this.context.resolveProjection(decl, undefined, this.stack, overrides) : Computable.resolve(undefined);
    }
    return Computable.resolve(value instanceof Name ? value : undefined);
  }

  /** Sub-targets take concrete inputs, not MAP property declarations, so a map
   * can only come from the type's declared default. */
  public getMap(name: string, overrides?: Constraints): Computable<PropertyMap> {
    const decl = this.declaredDefault(name);
    return decl ? this.context.resolveMap(decl, undefined, this.stack, overrides) : Computable.resolve(new Map());
  }

  public getDeclaredContext(): DeclaredTargetContext {
    return this.declared;
  }

  public stampProvenance(result: FileSet): FileSet {
    /* No own provenance step: the declared owner stamps the composed result. */
    return result;
  }

  public failure(err: Error): DependencyFailedError {
    return new DependencyFailedError(this.declared.target, err, this.label);
  }

  public announceBuilding(): void {
    /* The umbrella "Building X" (the declared target, once), then this specific
     * step ("Compiling X") attributed to it. A sub-target is a target too: it
     * announces the same event, carrying its own constraints/operation, plus the
     * action-verb `label` that distinguishes it. Its requiredBy is left to the
     * umbrella event (it belongs to the same declared target). An unlabelled
     * sub-target *is* the umbrella's work and says nothing further. */
    this.declared.announceBuilding();
    if (this.label !== undefined) {
      this.notifyProgress({
        kind: "target-build",
        target: this.declared.target,
        operation: this.context.getConstraint(BUILD_OPERATION) ?? "build",
        constraints: this.context.getConstraints(),
        requiredBy: [],
        label: this.label,
      });
    }
  }
}

/**
 * @return the canonical manifest of a build step's input bag: keys in
 * sorted order, FileSets by their content manifests, strings as JSON values.
 * This is the input half of every evaluate cache key.
 */
function manifestEvalInputs(inputs: BuildActionInputs): string {
  return Object.keys(inputs)
    .sort()
    .map(name => `${name}=${manifestEvalInput(inputs[name])}`)
    .join("\n");
}

function manifestEvalInput(value: BuildActionInput): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(element => manifestEvalInput(element)).join(",") + "]";
  }
  /* A Name (a projection input) manifests by its canonical text — selector plus
   * any `<constraints>` / `-> tmpl` facet all round-trip through toGlobString.
   * It is the canonical form specifically because it is lossless: `toString`
   * renders a quoted `'*'` and a wildcard `*` alike, which would collide two
   * different projections onto one cache key. */
  if (value instanceof Name) {
    return JSON.stringify(value.toGlobString());
  }
  return "{\n" + value.toManifest() + "\n}";
}

