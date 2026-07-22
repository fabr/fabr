import { Readable } from "stream";
import * as path from "node:path";
import { FetchOptions, IActionContext } from "../core/BuildCache";
import { Computable } from "../core/Computable";
import { EMPTY_FILESET, FileSet, FileSource } from "../core/FileSet";
import {
  CollectionOptions,
  isRepository,
  MaterializeOptions,
  RepositoryPublishRef,
  materializeLists,
  materializeShallow,
  Repository,
  RepositoryRef,
  SourceRef,
} from "../core/Repository";
import { FileSetRef } from "../core/FileSetRef";
import { RunnableFileSet } from "../core/RunnableFileSet";
import { PackageFileSet } from "../core/PackageFileSet";
import { Requirement } from "../resolver/Types";
import { Flag } from "../core/Flag";
import {
  IProvenanceStep,
  IRenderContext,
  registerProvenanceDescriber,
  registerProvenanceRenderer,
} from "../core/Provenance";
import { BuildAction, BuildActionInput, BuildActionInputs, IRuleDefinition, RepositoryProvider } from "../rules/Types";
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
  INamedDecl,
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
} from "./AST";
import { IDiagnosticNote } from "../support/Log";
import type { StageStreams } from "../support/Execute";
import {
  DependencyFailedError,
  IUseSite,
  NameResolutionError,
  NoRuleFoundError,
  ReferenceFailedError,
} from "./Errors";
import { attachHelp, ConflictError, IConflictSide, IConflictSource } from "../core/Errors";
import { Name, RewriteFn, makeRewrite } from "../core/Name";
import { parseName } from "./Parser";
import { IPrefixMatch } from "./Namespace";
import { Property } from "./Property";

/**
 * A set of (scalar) property constraints defining a build configuration.
 * Values are plain strings by design, so that constraint sets compare by value.
 */
export type Constraints = Record<string, string>;

/**
 * The resolved value of a MAP property: an ordered key -> value map whose
 * values are each one string (a string-valued entry's values, space-joined), a
 * sub-map (one nested block), or a list of sub-maps (several blocks — an array
 * of objects, `maintainers`-style). Never a mix within one entry. The map is
 * ecosystem-neutral; the consuming rule interprets/encodes the values.
 */
export type PropertyMapValue = string | PropertyMap | PropertyMap[];
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

/**
 * The distinguished constraint carrying the requested operation ('build',
 * 'test', ...): `fabr test foo` is sugar for constraining BUILD_OPERATION=test.
 * Rule selection matches against it, so a target type provides an operation by
 * registering a rule constrained to it. Note that an operation-specific rule
 * is responsible for explicitly requesting BUILD_OPERATION=build for its
 * dependencies (the constraint otherwise propagates).
 */
export const BUILD_OPERATION = "BUILD_OPERATION";

/**
 * The platform triple (clang/LLVM form, e.g. `arm64-apple-macosx15.0`,
 * `x86_64-linux-gnu`) fabr is actually running on — a driver-injected fact, not
 * meant to be overridden. Native rules consume it verbatim; the npm gate reads a
 * lossy {os,cpu,libc} projection off it.
 */
export const HOST = "HOST";

/**
 * The platform triple we are *building for*. `default TARGET = ${HOST};` (STD.fabr),
 * overridable per build (`-D TARGET=…`) or per reference (`ref<TARGET=…>`) to
 * cross-compile. Repository/native selection gates on this, not HOST. Running a
 * target (`BUILD_OPERATION=run`) forces TARGET back to HOST — you can only execute
 * what was built for the machine you're on, and it makes build *tools* resolve
 * host-side automatically.
 */
export const TARGET = "TARGET";

/**
 * The `files` operation: "give me the output files, and do no more than that."
 * A weaker form of `build` — it has no type-specific rules of its own; a generic
 * default rule (see rules/DefaultFilesRule) delegates it to the target's `build`
 * result. Its value is that a consumer reading the operation off its context can
 * do strictly less work when only the files are wanted: notably an `@npm:`
 * repository delivers a package's own files without resolving its dependency
 * closure. The driver's `ls`/`cat` verbs resolve under it.
 */
export const FILES_OPERATION = "files";

interface IResolvedFileSource {
  sources: SourceRef[];
  /** The declaration the name resolved to, if it named a target or property */
  decl?: ITargetDecl | IPropertyDecl;
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
registerProvenanceDescriber(TARGET_PROVENANCE, step => (step as ITargetOrigin).decl.name);

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
  return target ? `${target.name} ${property.name}` : property.name;
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
  const entries = Object.entries(step.constraints).filter(
    ([key, value]) => !context.elideConstraintKeys?.has(key) && (deeper ? deeper.constraints[key] !== value : true)
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
  getDecl(name: string): IPropertyDecl | ITargetDecl | INamespaceDecl | undefined;
  getTargetDef(name: string): ITargetDefDecl | undefined;
  getPrefixMatch(name: Name): IPrefixMatch | undefined;
  /** The model's registry: rule selection and repository providers ride the
   * model (built per load from core + active plugins), not a global. */
  getTargetRule(type: string, constraints: Constraints): IRuleDefinition | undefined;
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
  private propCache: Record<string, Computable<Property>>;
  private targetCache: Record<string, Computable<SourceRef[]>>;

  constructor(model: IBuildModel, constraints: Constraints, execution: ExecutionContext) {
    this.model = model;
    this.constraints = constraints;
    this.execution = execution;
    this.propCache = {};
    this.targetCache = {};
    // Pre-force the constraints so we don't have to check this later.
    Object.keys(constraints).forEach(key => (this.propCache[key] = Computable.resolve(new Property([constraints[key]]))));
  }

  public hasConstraints(constraints: Constraints): boolean {
    const k1 = Object.keys(this.constraints);
    const k2 = Object.keys(constraints);
    return k1.length === k2.length && k1.every(k => k in constraints && constraints[k] === this.constraints[k]);
  }

  public getPropertyWithOverrides(name: string, overrides: Constraints): Computable<Property> {
    return this.getContextWithOverrides(overrides).getProperty(name);
  }

  public getTargetWithOverrides(name: string, overrides: Constraints): Computable<SourceRef[]> {
    return this.getContextWithOverrides(overrides).getTarget(name);
  }

  public getContextWithOverrides(overrides: Constraints): BuildContext {
    const combined = { ...this.constraints, ...overrides };
    return this.model.getConfig(combined, this.execution);
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
    return this.constraints[name];
  }

  /** The full constraint set this context resolves under (read-only). */
  public getConstraints(): Constraints {
    return this.constraints;
  }

  public getProperty(name: string, stack?: IDependencyStack): Computable<Property> {
    this.assertNonCircularProperty(name, stack);
    if (name in this.propCache) {
      /* Already seen */
      const result = this.propCache[name];
      if (result === null) {
        throw new Error("Circular dependency at '" + name + "'");
      } else {
        return result;
      }
    } else {
      const def = this.model.getDecl(name);
      if (!def || def.kind !== DeclKind.Property) {
        throw new Error("Unresolved property name '" + name + "'"); /* TODO: actual error reporting */
      }
      const result = this.resolveStringProperty(def, undefined, stack);
      this.propCache[name] = result;
      return result;
    }
  }

  public getTarget(name: string, stack?: IDependencyStack): Computable<SourceRef[]> {
    this.assertNonCircularTarget(name, stack);
    if (name in this.targetCache) {
      /* Already seen */
      return this.targetCache[name];
    } else if (name in this.constraints) {
      /* A constraint overrides how the name resolves — to files as well as to a
       * string (`${name}`, via the pre-forced propCache): resolve the override
       * value as a reference in place of the declared property/target. This is
       * why `-Dchai=@npm:chai:5.0.0` repins a dependency written as a bare `chai`. */
      const result = this.resolveFileSource(Name.fromLiteral(this.constraints[name]), undefined, stack).then(
        resolved => resolved.sources
      );
      this.targetCache[name] = result;
      return result;
    } else {
      const def = this.model.getDecl(name);
      if (def?.kind === DeclKind.Target) {
        const result = this.resolveTarget(def, stack);
        this.targetCache[name] = result;
        return result;
      } else if (def?.kind === DeclKind.Property) {
        const result = this.resolveFileProperty(def, undefined, stack);
        this.targetCache[name] = result;
        return result;
      } else {
        throw new Error("Unresolved name '" + name + "'"); /* TODO: actual error reporting */
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
  ): { target: Computable<SourceRef[]>; rest: Name; decl: ITargetDecl | IPropertyDecl; retainedPrefix: string } | undefined {
    const result = this.model.getPrefixMatch(name);
    if (result) {
      return {
        target: this.getTarget(result.decl.name, stack),
        rest: result.rest,
        decl: result.decl,
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
    process: (content: Readable, targetDir: string) => Computable<FileSet>,
    headers?: Record<string, string>,
    options?: FetchOptions
  ): Computable<FileSet> {
    return this.execution.buildCache.getOrFetch(url, tag, process, headers, options);
  }

  /**
   * Resolve a property's values to their substituted Names (facets intact) —
   * the shared core of {@link resolveStringProperty} (which stringifies) and
   * {@link resolveRewrite} (which reads the rename template facet). References
   * are NOT resolved: a REWRITE/STRING value is inert, never a collection point.
   */
  public resolveNameProperty(prop: IPropertyDecl, target?: ITargetDecl, stack?: IDependencyStack): Computable<Name[]> {
    /* Each value must be a name; a map block or command pipeline used as a string
     * is rejected (the backstop for the paths Validate doesn't cover — default/
     * top-level properties, sync coordinates). */
    return Computable.forAll(
      prop.values.map(value =>
        isNameValue(value)
          ? this.substituteNameVars(value.value, { property: prop, target, context: this, value, next: stack })
          : Computable.reject<Name>(nonNameValueError(prop, value, "a string"))
      ),
      (...resolved) => resolved
    );
  }

  public resolveStringProperty(prop: IPropertyDecl, target?: ITargetDecl, stack?: IDependencyStack): Computable<Property> {
    return this.resolveNameProperty(prop, target, stack).then(names => new Property(names.map(name => name.toString())));
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
  public resolveMap(prop: IPropertyDecl, target?: ITargetDecl, stack?: IDependencyStack): Computable<PropertyMap> {
    return this.resolveMapDecl(prop, target, stack, new Set());
  }

  private resolveMapDecl(
    prop: IPropertyDecl,
    target: ITargetDecl | undefined,
    stack: IDependencyStack | undefined,
    seen: Set<IPropertyDecl>
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
      return this.resolveBlock(isMapValue(block) ? block.entries : [], target, stack, nextSeen);
    }
    /* Reference form: each value names a block-valued property (resolved
     * recursively under this context, so a shared map's `${...}` sees the
     * consuming build's config), merged left-to-right with later winning; each
     * merged entry's origin gains the written reference as a via-hop. */
    return Computable.forAll(
      prop.values.filter(isNameValue).map(value =>
        this.resolveMapReference(value.value, { property: prop, target, context: this, value, next: stack }, stack, nextSeen).then(
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
    seen: Set<IPropertyDecl>
  ): Computable<PropertyMap> {
    return this.referencedProperty(name, info).then(({ prop, name: substituted }) => {
      if (!prop) {
        throw new Error(`'${substituted.toString()}' does not name a map property`);
      }
      return this.resolveMapDecl(prop, undefined, stack, seen);
    });
  }

  /** Resolve one block's items in written order: a `key = value;` entry sets its
   * key (strings joined to one string; nested blocks to a sub-map, several to a
   * list of sub-maps — mixing rejected, statically for schema'd properties and
   * re-checked here for shared globals); a `NAME;` splice merges the named map's
   * entries in at that position. Later values win. Each entry records its ghost
   * origin (the written decl, plus via-hops for splices). */
  private resolveBlock(
    entries: IMapItemDecl[],
    target: ITargetDecl | undefined,
    stack: IDependencyStack | undefined,
    seen: Set<IPropertyDecl>
  ): Computable<PropertyMap> {
    return Computable.forAll(
      entries.map((item): Computable<PropertyMapValue | PropertyMap> => {
        if (item.kind === DeclKind.MapSplice) {
          return this.resolveMapReference(item.ref, stack, stack, seen);
        }
        const blocks = item.values.filter(isMapValue);
        if (blocks.length === 0) {
          return this.resolveStringProperty(item, target, stack).then(prop => prop.toString());
        }
        if (blocks.length < item.values.length) {
          return Computable.reject(new Error(`map value '${item.name}' is either strings or maps, not a mix`));
        }
        return Computable.forAll(
          blocks.map(value => this.resolveBlock(value.entries, target, stack, seen)),
          (...maps: PropertyMap[]) => (maps.length === 1 ? maps[0] : maps)
        );
      }),
      (...resolved: (PropertyMapValue | PropertyMap)[]) => {
        const map: PropertyMap = new Map();
        entries.forEach((item, i) => {
          if (item.kind === DeclKind.MapSplice) {
            mergeMapInto(map, resolved[i] as PropertyMap, item);
          } else {
            map.set(item.name, resolved[i] as PropertyMapValue);
            recordMapOrigin(map, item.name, { entry: item, via: [] });
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
  public resolveRewrite(prop: IPropertyDecl, target?: ITargetDecl, stack?: IDependencyStack): Computable<RewriteFn> {
    return this.resolveNameProperty(prop, target, stack).then(makeRewrite);
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
    /* Each value must be a name (reference); a map block or command pipeline read
     * as files is rejected. */
    return Computable.forAll(
      prop.values.map(value => {
        if (!isNameValue(value)) {
          return Computable.reject<SourceRef[]>(nonNameValueError(prop, value, "files"));
        }
        const info: IDependencyStack = { property: prop, target, context: this, value, next: stack };
        /* A value written as `ref<k=v>` resolves under this context overridden
         * by its delta, so the referenced target builds under those constraints
         * and the model-ref step (stamped by that context) records them. */
        return this.resolvingContextFor(value.value, callerOverrides, info)
          .then(({ context, reference }) =>
            context.resolveFileSource(reference, prop, info).then(resolved =>
              resolved.sources.map(source => context.withModelRef(source, value, prop, target))
            )
          )
          .catch(err => {
            /* A referenced target's failure crossing this written reference
             * (it failed to build, or no rule matched it): record the use
             * site, so the driver can render the dependant chain as
             * "required by <target> <property>" against the written value. */
            if (err instanceof DependencyFailedError || err instanceof NoRuleFoundError) {
              throw new ReferenceFailedError(value, prop, target, err);
            }
            /* A conflict raised *during* this value's resolution (e.g. a rename
             * projection collapsing two files onto one name, or a union across
             * its containers) is thrown before withModelRef stamps the result,
             * so its sides lack this reference's step. Chain it on now, so the
             * driver traces the conflict back to the written value (the rename
             * expression included). */
            if (err instanceof ConflictError) {
              throw this.withConflictModelRef(err, value, prop, target);
            }
            throw err;
          });
      }),
      (...resolved) => resolved.flat()
    );
  }

  /**
   * The context a reference resolves under, plus the reference with its
   * constraint delta stripped. Constraints layer lowest-to-highest as **ambient
   * (this) → the reference's own `<k=v>` delta → the caller's override**: the
   * reference delta overrides the ambient config (its whole point), but a
   * consumer's *explicit* override — e.g. a rule forcing `BUILD_OPERATION=run`
   * on the tool it needs — is the operative requirement and wins over a stray
   * delta on the same key. A `ref<k=v>` is returned pre-substituted (bare parts),
   * so resolution proceeds on the parts and the merged context governs the build.
   */
  private resolvingContextFor(
    name: Name,
    callerOverrides?: Constraints,
    stack?: IDependencyStack
  ): Computable<{ context: BuildContext; reference: Name }> {
    if (!name.hasConstraints()) {
      const context = callerOverrides ? this.getContextWithOverrides(callerOverrides) : this;
      return Computable.resolve({ context, reference: name });
    }
    return this.substituteNameVars(name, stack).then(substituted => {
      const overrides: Constraints = {};
      for (const [key, value] of substituted.getConstraints()) {
        overrides[key] = value.toString();
      }
      /* Caller override last, so it wins on a shared key. */
      const merged = callerOverrides ? { ...overrides, ...callerOverrides } : overrides;
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
   */
  public resolveName(name: string, stack?: IDependencyStack): Computable<SourceRef[]> {
    return this.resolvingContextFor(parseName(name), undefined, stack)
      .then(({ context, reference }) => context.resolveFileSource(reference, undefined, stack))
      .then(resolved => materializeShallow(resolved.sources));
  }

  private resolveFileSource(
    name: Name,
    relativeTo: INamedDecl | undefined,
    stack?: IDependencyStack
  ): Computable<IResolvedFileSource> {
    return this.substituteNameVars(name, stack).then((substName): IResolvedFileSource | Computable<IResolvedFileSource> => {
      if (substName.isEmpty()) {
        return { sources: [] };
      } else {
        const targetDep = this.getPrefixTargetIfExists(substName, stack);
        if (targetDep) {
          const { target, rest, decl, retainedPrefix } = targetDep;
          if (rest.isEmpty()) {
            return target.then(sources => ({ sources, decl }));
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
               * "matched no files") and only for a literal projection. */
              const miss =
                relativeTo && !rest.hasGlob()
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
                  references.push(source.getRepositoryRef(rest));
                } else if (source instanceof PackageFileSet) {
                  /* A projection into a package DEFERS (a FileSetRef): applied
                   * eagerly it would erase the package identity conversion
                   * needs (a package entry's projection selects the bin of the
                   * runnable it becomes). Ordinary consumers see the projected
                   * files when the ref manifests at their collection point,
                   * carrying this site's miss error for a literal that matches
                   * nothing. */
                  references.push(new FileSetRef(source, [{ pattern: rest, prefix: retainedPrefix }], miss));
                } else {
                  /* A container projects on its own terms (FileSource.find): a
                   * fileset filters + prefixes (or renames, per the facet); a
                   * runnable re-points its entry. */
                  containers.push(source);
                }
              }
              if (containers.length === 0) {
                return { sources: references, decl };
              }
              /* Each container projects separately and STAYS a separate source
               * (findAll never merges — union, and its ConflictError, is the
               * act of a consumer that merges content). Containers the
               * projection missed are dropped; one empty set is kept when
               * nothing matched, so an empty outcome still reaches the
               * driver's "matched no files" report. */
              return FileSet.findAll(containers, rest, retainedPrefix).then(projected => {
                const matched = projected.filter(set => !set.isEmpty());
                /* Same literal-must-resolve rule for a projection into built
                 * content, but only when no deferred reference might still
                 * deliver the name. */
                if (matched.length === 0 && references.length === 0 && miss) {
                  throw miss();
                }
                return { sources: [...references, ...(matched.length > 0 ? matched : [EMPTY_FILESET])], decl };
              });
            });
          }
        } else if (relativeTo) {
          /* Not an identified target; check the filesystem relative to the file the
           * reference is written in. The build-file's directory is prepended to
           * *locate* the files, but the result name is the path relative to that
           * dir (its written name): `./astro.config.mjs` in `docs/BUILD.fabr` is
           * the file `astro.config.mjs`, not `docs/astro.config.mjs` — the dir is a
           * retained prefix, exactly like a colon-form projection. */
          const baseName = relativeTo.source.file;
          const dir = path.posix.dirname(baseName);
          return relativeTo.source.fs.find(substName.relativeTo(baseName)).then(data => {
            if (data.isEmpty() && !substName.hasGlob()) {
              throw new NameResolutionError(substName, declPosn(stack?.value ?? relativeTo), useSiteOf(stack));
            }
            /* Name each file relative to the build file's dir, then drop any leading
             * `../`. A flat sandbox has no "above", so a reference climbing out of
             * its dir (`../scripts/gendoc.ts`, a tool a level up) flattens to its
             * tail (`scripts/gendoc.ts`) — the rule is simply "a leading `../` is
             * stripped", independent of where the build file sits (RATIONALE.md).
             * `path.posix.relative` normalizes both sides, so the glob walk's
             * pre-normalized names and a single file's literal `dir/../x` agree. Two
             * files flattening to one name collide at the consuming union — a clear
             * error, by design, not a silent drop. */
            const named = data.remap(fileName => path.posix.relative(dir, fileName).replace(/^(?:\.\.\/)+/, ""));
            return { sources: [named] };
          });
        } else {
          /* A command-line name that names no known target (no decl to resolve
           * a bare path against) */
          throw new Error(`Unknown target '${name.toString()}'`);
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
      return { prop: def?.kind === DeclKind.Property ? def : undefined, name };
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
      return provider(new RepositoryContext(target, this)).then(
        (repository): SourceRef[] => [repository],
        err => {
          throw new DependencyFailedError(target, err);
        }
      );
    }
    const rule = this.model.getTargetRule(target.type, this.constraints);
    if (!rule) {
      throw new NoRuleFoundError(target, this.constraints);
    }
    return this.evaluateTarget(new DeclaredTargetContext(target, this, stack), rule);
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
    const def = this.model.getDecl(name);
    if (def?.kind !== DeclKind.Target) {
      throw new Error(`'${name}' is not a target that runs a command`);
    }
    const rule = this.model.getTargetRule(def.type, this.constraints);
    if (!rule) {
      throw new NoRuleFoundError(def, this.constraints);
    }
    const context = new DeclaredTargetContext(def, this, stack);
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
    inputs: BuildActionInputs,
    options?: { label?: string; constraints?: Constraints }
  ): Computable<SourceRef[]> {
    const buildContext = options?.constraints ? this.getContextWithOverrides(options.constraints) : this;
    const rule = this.model.getTargetRule(type, buildContext.constraints);
    if (!rule) {
      throw new Error(`No rule found for anonymous target type '${type}'`);
    }
    const context = new AnonymousTargetContext(buildContext, inputs, owner.getDeclaredContext(), options?.label ?? type, owner.stack);
    return buildContext.evaluateTarget(context, rule);
  }

  /**
   * Run a build action through the cache: the key is the step's identity plus
   * the canonical manifest of its (already-resolved) inputs — sound by
   * construction, since the step consumes nothing else. A miss is the moment
   * real work happens: the evaluation announces its (declared) target as
   * building.
   */
  public runAction(action: BuildAction, context: TargetContext): Computable<FileSet> {
    const key = `rule:${action.step.id}:${action.step.version}\n${manifestEvalInputs(action.inputs)}`;
    const cache = this.execution.buildCache;
    return this.getCachedOrBuild(key, targetDir => {
      context.announceBuilding();
      /* The cache owns the scratch dir and the content store, so the action's
       * context — work dir + streaming-output factory — is assembled here, at the
       * bridge between the cache's create callback and the step. */
      const actionContext: IActionContext = {
        workDir: targetDir,
        createOutput: () => cache.getTemporaryWriteStream(),
        quiet: this.execution.quiet,
      };
      return action.step.run(action.inputs, actionContext);
    });
  }

  private findTargetInStack(target: string, stack?: IDependencyStack): IDependencyStack | undefined {
    let node = stack;
    while (node) {
      if (node.target && node.target.name === target && node.context === this) {
        return node;
      }
      node = node.next;
    }
  }

  private findPropertyInStack(property: string, stack?: IDependencyStack): IDependencyStack | undefined {
    let node = stack;
    while (node) {
      if (node.property.name === property && node.context === this) {
        return node;
      }
      node = node.next;
    }
  }

  private assertNonCircularProperty(property: string, stack?: IDependencyStack): void {
    const entry = this.findPropertyInStack(property, stack);
    if (entry) {
      throw new Error("Circular dependency resolving " + property + "\n" + stringifyDependencyStack(stack, entry));
    }
  }

  private assertNonCircularTarget(target: string, stack?: IDependencyStack): void {
    const entry = this.findTargetInStack(target, stack);
    if (entry) {
      throw new Error("Circular dependency resolving " + target + "\n" + stringifyDependencyStack(stack, entry));
    }
  }
}

/**
 * Construct a human readable dump of the stack.
 * @param stack start of the start to show.
 * @param end If supplied, the last entry of the stack to show.
 */
function stringifyDependencyStack(stack?: IDependencyStack, end?: IDependencyStack): string {
  let result = "";
  let node = stack;
  while (node && node !== end) {
    result += "    " + stringifyDependencyStackEntry(node) + "\n";
    node = node.next;
  }
  return result;
}

function stringifyDependencyStackEntry(entry: IDependencyStack): string {
  let name;
  if (entry.target) {
    name = entry.target.name + "." + entry.property.name;
  } else {
    name = entry.property.name;
  }
  return `at ${name} (${stringifyLoc(entry.value)})`;
}

function stringifyLoc(decl: IDecl): string {
  const loc = decl.source.reader.resolvePosition(decl.offset);
  return `${decl.source.file}:${loc?.line}:${loc?.column}`;
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
 * (`getProperty`, `getFileSources`) and `announceBuilding` differ between the
 * two implementations. Everything else — materialization, flag extraction,
 * collection, globals, sub-targets — derives from those and is shared here.
 */
/** Pick the RunnableFileSet out of a resolved source list, or throw naming the
 * property/global that was expected to yield one. Shared by getGlobalRunnable
 * (a global) and getRunnableProperty (a FILES property). */
function asRunnable(sources: readonly unknown[], name: string): RunnableFileSet {
  const runnable = sources.find((source): source is RunnableFileSet => source instanceof RunnableFileSet);
  if (!runnable) {
    throw new Error(`'${name}' must name a runnable (its BUILD_OPERATION=run result)`);
  }
  return runnable;
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

/** The requirement one dep source declares (see {@link TargetContext.collectDeclaredRequirements}). */
function declaredRequirementOf(source: SourceRef): Computable<Requirement | undefined> {
  if (source instanceof RepositoryRef) {
    return source.source.declaredRequirement(source);
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

  constructor(context: BuildContext, stack?: IDependencyStack) {
    this.context = context;
    this.stack = stack;
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
  public abstract getFileSources(name: string, overrides?: Constraints): Computable<SourceRef[]>;

  /** Resolve a REWRITE property to its name-mapping function (see
   * resolveRewrite); the empty rewrite (no such property) maps nothing. */
  public abstract getRewrite(name: string, overrides?: Constraints): Computable<RewriteFn>;

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
   * `name`, under which the right-hand side content resolves via `getFileSources`).
   * Enumeration only — no content is gathered, so a rule can validate every
   * coordinate before building anything. Ordinary schema properties are not
   * returned; an anonymous target has none. */
  public abstract getWildcardProperties(): Computable<{ key: Name; decl: IPropertyDecl }[]>;

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
      [this.getGlobalRunnable(stage.command.name.toString()), this.resolveStdin(stage.stdin), this.expandArgs(stage.args, srcs)],
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
          const names = [...matched].map(([fileName]) => fileName).sort((a, b) => a.localeCompare(b));
          if (names.length === 0) {
            throw new NameResolutionError(arg.name, declPosn(arg.ref), useSiteOf(this.stack), "no files in 'srcs' match this glob");
          }
          return names;
        });
      }),
      (...expanded: string[][]) => expanded.flat()
    );
  }

  /** Resolve a stage's `< source` to a single-file set (streamed to stdin), or
   * undefined if the stage takes no stdin. */
  private resolveStdin(stdin: IPositionedName | undefined): Computable<FileSet | undefined> {
    if (!stdin) {
      return Computable.resolve(undefined);
    }
    return this.getGlobalTarget(stdin.name.toString()).then(sources => {
      const set = FileSet.unionAll(...sources.filter((source): source is FileSet => source instanceof FileSet));
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
      return repository.getRepositoryPublishRef(match.rest).withRepositoryName(match.decl.name);
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

  public getFlags(name: string, overrides?: Constraints): Computable<Flag[]> {
    return this.getFileSources(name, overrides).then(sources => sources.filter(source => source instanceof Flag) as Flag[]);
  }

  /**
   * Resolve a FILES property to its individual (fully materialized) FileSets —
   * one per contributing source, before any merging.
   *
   * Note: each call is its own materialization. THE collection point of an
   * evaluation is singular by design — a rule whose external requirements
   * span several properties/globals must gather them through one `collect`
   * call so they resolve jointly; per-property materialization is only
   * appropriate when the property is the evaluation's sole requirement
   * surface (or holds no external references at all, e.g. srcs).
   */
  public getFileSets(name: string, overrides?: Constraints): Computable<FileSet[]> {
    return this.getFileSources(name, overrides)
      .then(sources => materializeLists([sources]))
      .then(([resolved]) => resolved.filter((source): source is FileSet => source instanceof FileSet));
  }

  public getFileSet(name: string, overrides?: Constraints): Computable<FileSet> {
    return this.getFileSets(name, overrides).then(sets => FileSet.unionAll(...sets));
  }

  /**
   * THE collection point of this evaluation: materialize several named
   * source lists (properties via getFileSources, globals via
   * getGlobalSources, or already-gathered arrays) through a SINGLE joint
   * materialization, so every deferred reference they carry — however many
   * properties and globals it spans — is partitioned into one batch per
   * repository and resolved together, with the consumer's own pins
   * participating across the lot. Results come back per name, filtered to
   * materialized FileSets (flags and other non-content sources drop out).
   *
   * `options.resolutionMode = "permissive"` declares this collection point's
   * deliveries sealed program installs (a runnable-definer's assembly) —
   * resolution repairs are accepted rather than errors; see MaterializeOptions.
   * `options.keepProjected` delivers projection-pending FileSetRefs
   * unmanifested, for a consumer that reinterprets them (see FileSetRef); by
   * default they manifest to their plain projected files. Rule code only: the
   * judgments are structural, never user configuration.
   */
  public collect(
    parts: Record<string, SourceRef[] | Computable<SourceRef[]>>,
    options: CollectionOptions & { keepProjected: true }
  ): Computable<Record<string, (FileSet | FileSetRef)[]>>;
  public collect(
    parts: Record<string, SourceRef[] | Computable<SourceRef[]>>,
    options?: MaterializeOptions
  ): Computable<Record<string, FileSet[]>>;
  public collect(
    parts: Record<string, SourceRef[] | Computable<SourceRef[]>>,
    options?: CollectionOptions
  ): Computable<Record<string, (FileSet | FileSetRef)[]>> {
    const names = Object.keys(parts);
    return Computable.forAll(
      names.map(name => {
        const value = parts[name];
        return value instanceof Computable ? value : Computable.resolve(value);
      }),
      (...lists: SourceRef[][]) =>
        materializeLists(lists, options).then(partitions => {
          const result: Record<string, (FileSet | FileSetRef)[]> = {};
          names.forEach((name, i) => {
            result[name] = partitions[i].filter(
              (source): source is FileSet | FileSetRef => source instanceof FileSet || source instanceof FileSetRef
            );
          });
          return result;
        })
    );
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
   * accessors (getFileSet, getRequiredString, …) as any target. The delegation
   * itself is unrestricted (whatever rule selection picks, whatever it
   * yields — see buildSubTarget); this narrows to the common case, one
   * FileSet, because the caller wires the result straight into inputs or
   * reshaping. A delegate yielding anything else is an error *here*, at the
   * expectation, not in the mechanism.
   */
  public subTarget(
    type: string,
    inputs: BuildActionInputs,
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
    return this.getContext(overrides).getProperty(name, this.stack);
  }

  public getGlobalTarget(name: string, overrides?: Constraints): Computable<(FileSource | Repository)[]> {
    return this.getContext(overrides)
      .getTarget(name, this.stack)
      .then(sources => materializeLists([sources]))
      /* Default materialization manifests any projection-pending FileSetRef,
       * so the delivered list holds only content and repositories. */
      .then(([resolved]) => resolved as (FileSource | Repository)[]);
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
    return { [BUILD_OPERATION]: "run", ...(host ? { [TARGET]: host } : {}), ...extra };
  }

  /**
   * Resolve a global that names a **runnable tool** (e.g. `TSC`) to its host
   * runnable — see getRunnableProperty; this is the global-property counterpart.
   */
  public getGlobalRunnable(name: string): Computable<RunnableFileSet> {
    return this.getGlobalTarget(name, this.runOverrides()).then(sources => asRunnable(sources, name));
  }

  /**
   * Resolve a FILES **property** that names a **runnable tool to execute now**
   * (e.g. a `run` target's `tool`): resolved under runOverrides (BUILD_OPERATION=run
   * with TARGET pinned to HOST, so the tool is its *host* binary even in a
   * cross-build — a build-time tool executes on this machine), and asserted to be a
   * RunnableFileSet. The caller launches it via `toCommandLine`. The host-pinning is
   * internal by design: a consumer resolving a tool to run it needn't restate it.
   */
  public getRunnableProperty(name: string): Computable<RunnableFileSet> {
    return this.getFileSets(name, this.runOverrides()).then(sources => asRunnable(sources, name));
  }

  /**
   * The unmaterialized counterpart of getGlobalTarget: the global's sources
   * with any repository references still inert, for feeding into `collect`
   * so they resolve jointly with the evaluation's other requirements.
   */
  public getGlobalSources(name: string, overrides?: Constraints): Computable<SourceRef[]> {
    return this.getContext(overrides).getTarget(name, this.stack);
  }

  protected getContext(overrides?: Constraints): BuildContext {
    return overrides ? this.context.getContextWithOverrides(overrides) : this.context;
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
  private readonly props: Record<string, IPropertyDecl>;
  /** The build cycle in which this target last announced itself building, so a
   * watch rebuild (a new cycle) re-announces while a single cycle announces once
   * however many sub-actions miss the cache. */
  private announcedGeneration = -1;

  constructor(target: ITargetDecl, context: BuildContext, stack?: IDependencyStack) {
    super(context, stack);
    this.target = target;
    this.props = {};
    target.properties.forEach(prop => {
      this.props[prop.name] = prop;
    });
  }

  public get name(): string {
    return this.target.name;
  }

  public getProperty(name: string, overrides?: Constraints): Computable<Property | undefined> {
    const prop = this.props[name];
    if (!prop) {
      return Computable.resolve(undefined);
    }
    return this.getContext(overrides).resolveStringProperty(prop, this.target, this.stack);
  }

  public getFileSources(name: string, overrides?: Constraints): Computable<SourceRef[]> {
    const prop = this.props[name];
    if (!prop) {
      return Computable.resolve([]);
    }
    /* Resolve on the ambient context and pass the caller's explicit override
     * through, so it is applied *last* (winning over any per-reference delta) —
     * rather than pre-baked, where a reference's own <k=v> would override it. */
    return this.context.resolveFileProperty(prop, this.target, this.stack, overrides);
  }

  public getRewrite(name: string, overrides?: Constraints): Computable<RewriteFn> {
    const prop = this.props[name];
    if (!prop) {
      return Computable.resolve(() => undefined);
    }
    return this.getContext(overrides).resolveRewrite(prop, this.target, this.stack);
  }

  public getMap(name: string, overrides?: Constraints): Computable<PropertyMap> {
    const prop = this.props[name];
    if (!prop) {
      return Computable.resolve(new Map());
    }
    return this.getContext(overrides).resolveMap(prop, this.target, this.stack);
  }

  public getDeclaredContext(): this {
    return this;
  }

  public getWildcardProperties(): Computable<{ key: Name; decl: IPropertyDecl }[]> {
    const keyed = this.target.properties.filter(
      (prop): prop is IPropertyDecl & { keyRef: Name } => prop.keyRef !== undefined
    );
    /* Enumeration only: substitute the coordinate keys and hand back their decls;
     * content is gathered later so coordinates can be validated first. */
    return Computable.forAll(
      keyed.map(prop => this.context.substituteNameVars(prop.keyRef, this.stack)),
      (...keys: Name[]) => keys.map((key, i) => ({ key, decl: keyed[i] }))
    );
  }

  protected getCommandStages(name: string): Computable<IResolvedCommandStage[]> {
    const prop = this.props[name];
    if (!prop) {
      return Computable.resolve([]);
    }
    return this.context.resolveCommand(prop, this.target, this.stack);
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
 */
export class AnonymousTargetContext extends TargetContext {
  private readonly inputs: BuildActionInputs;
  private readonly declared: DeclaredTargetContext;
  private readonly label: string;

  constructor(
    context: BuildContext,
    inputs: BuildActionInputs,
    declared: DeclaredTargetContext,
    label: string,
    stack?: IDependencyStack
  ) {
    super(context, stack);
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

  /** An anonymous sub-target has no declaration body, so no command. */
  protected getCommandStages(): Computable<IResolvedCommandStage[]> {
    return Computable.resolve([]);
  }

  public getProperty(name: string): Computable<Property | undefined> {
    const value = this.inputs[name];
    if (value === undefined) {
      return Computable.resolve(undefined);
    }
    return Computable.resolve(new Property((Array.isArray(value) ? value : [value]) as string[]));
  }

  public getFileSources(name: string): Computable<SourceRef[]> {
    const value = this.inputs[name];
    if (value === undefined) {
      return Computable.resolve([]);
    }
    return Computable.resolve((Array.isArray(value) ? value : [value]) as SourceRef[]);
  }

  /** Sub-targets take concrete inputs, not REWRITE property declarations, so the
   * rewrite is always empty here. */
  public getRewrite(): Computable<RewriteFn> {
    return Computable.resolve(() => undefined);
  }

  /** Sub-targets take concrete inputs, not MAP property declarations, so the
   * map is always empty here. */
  public getMap(): Computable<PropertyMap> {
    return Computable.resolve(new Map());
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
     * umbrella event (it belongs to the same declared target). */
    this.declared.announceBuilding();
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

/**
 * @return the canonical manifest of a build step's input bag: keys in
 * sorted order, FileSets by their content manifests, strings as JSON values.
 * This is the input half of every evaluate cache key.
 */
function manifestEvalInputs(inputs: BuildActionInputs): string {
  return Object.keys(inputs)
    .sort((a, b) => a.localeCompare(b))
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
  return "{\n" + value.toManifest() + "\n}";
}

/**
 * The narrow runtime surface a repository provider works against: the
 * declaration's configuration properties, resolve-phase caching (memos and
 * fetches — distinct from evaluate entries, and never announced as
 * building), and progress attribution to the repository's own declaration.
 */
export class RepositoryContext {
  public readonly target: ITargetDecl;
  private readonly context: BuildContext;
  private readonly props: Record<string, IPropertyDecl>;

  constructor(target: ITargetDecl, context: BuildContext) {
    this.target = target;
    this.context = context;
    this.props = {};
    target.properties.forEach(prop => {
      this.props[prop.name] = prop;
    });
  }

  public getRequiredString(name: string): Computable<string> {
    const prop = this.props[name];
    if (!prop) {
      throw new Error("Missing required property " + name);
    }
    return this.context.resolveStringProperty(prop, this.target).then(prop => prop.toString());
  }

  /**
   * Resolve a FILES property of this repository's declaration to its deferred
   * sources — external references (as inert RepositoryRefs, not yet resolved or
   * fetched) and any local targets (evaluated/built during resolution). The
   * primitive a repository provider reads a property through; `overrides` layer
   * over the ambient config (e.g. a catalog forces `BUILD_OPERATION=build` so its
   * members resolve as mountable packages). A missing property is the empty set.
   */
  public getFileSources(name: string, overrides?: Constraints): Computable<SourceRef[]> {
    const prop = this.props[name];
    if (!prop) {
      return Computable.resolve([]);
    }
    return this.context.resolveFileProperty(prop, this.target, undefined, overrides);
  }

  /**
   * A global (build-config) property this repository resolves under — the same
   * property surface every rule sees (constraints are pre-forced into it; there
   * is no separate "constraint" notion outside BuildContext's own reporting).
   * This instance is interned per BuildContext, so the value reflects what the
   * references were consumed with — e.g. the build verb (`BUILD_OPERATION`,
   * which decides whether the repository delivers a plain package or a runnable).
   */
  public getGlobalString(name: string): Computable<string> {
    return this.context.getProperty(name).then(prop => prop.toString());
  }

  /**
   * Resolve-phase memoization: results of pure resolution work (e.g. a joint
   * version selection), persisted under `memo:<tag> <key>`. The tag is a
   * stable `name:version` — bump the version when the computation's behavior
   * changes.
   */
  public memoize(tag: string, key: string, create: (targetDir: string) => Computable<FileSet>): Computable<FileSet> {
    return this.context.getCachedOrBuild(`memo:${tag} ${key}`, create);
  }

  /**
   * Download through the cache (see BuildCache.getOrFetch); an actual fetch
   * (a miss) is announced as progress, attributed to this repository. The
   * optional `resource` is a human noun for what is being fetched (e.g.
   * "metadata", "package"), carried on the progress event for display.
   * `options.immutable = false` declares a mutable pointer document (see
   * FetchOptions) — cached per HTTP caching semantics and revalidated,
   * instead of frozen forever.
   */
  public fetch(
    url: string,
    tag: string,
    process: (content: Readable, targetDir: string) => Computable<FileSet>,
    resource?: string,
    headers?: Record<string, string>,
    options?: FetchOptions
  ): Computable<FileSet> {
    return this.context.getCachedOrFetch(
      url,
      tag,
      (content, targetDir) => {
        this.notifyProgress({ kind: "fetch", url, target: this.target, resource });
        return process(content, targetDir);
      },
      headers,
      options
    );
  }

  /**
   * The run's fixed surroundings — the build cache, log, source/absolute
   * FileSources (for config a repository consults, e.g. a `.npmrc` read through
   * the source FS so it participates in watch-mode invalidation), and per-plugin
   * state (see {@link ExecutionContext.getOrCreatePluginContext}). Shared by every
   * BuildContext of the run, so it is where a plugin keeps state common to its
   * per-context instances.
   */
  public get execution(): ExecutionContext {
    return this.context.execution;
  }

  public notifyProgress(event: ProgressEvent): void {
    this.context.execution.notifyProgress(event);
  }
}
