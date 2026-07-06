import { Readable } from "stream";
import { Computable } from "../core/Computable";
import { FileSet, FileSource } from "../core/FileSet";
import { isRepository, materializeAll, Repository, RepositoryRef, SourceRef } from "../core/Repository";
import { Flag } from "../core/Flag";
import {
  IProvenanceStep,
  IRenderContext,
  registerProvenanceDescriber,
  registerProvenanceRenderer,
} from "../core/Provenance";
import { getRepositoryProvider, getTargetRule } from "../rules/Registry";
import { BuildAction, BuildActionInput, BuildActionInputs, IRuleDefinition } from "../rules/Types";
import { ExecutionContext, ProgressEvent } from "./ExecutionContext";
import { ITargetOrigin, TARGET_PROVENANCE } from "./Target";
import {
  DeclKind,
  IDecl,
  INamedDecl,
  INamespaceDecl,
  IPropertyDecl,
  ITargetDecl,
  ITargetDefDecl,
  IValue,
} from "./AST";
import { Name } from "./Name";
import { IPrefixMatch } from "./Namespace";
import { Property } from "./Property";

/**
 * A set of (scalar) property constraints defining a build configuration.
 * Values are plain strings by design, so that constraint sets compare by value.
 */
export type Constraints = Record<string, string>;

/**
 * The distinguished constraint carrying the requested operation ('build',
 * 'test', ...): `fabr test foo` is sugar for constraining BUILD_OPERATION=test.
 * Rule selection matches against it, so a target type provides an operation by
 * registering a rule constrained to it. Note that an operation-specific rule
 * is responsible for explicitly requesting BUILD_OPERATION=build for its
 * dependencies (the constraint otherwise propagates).
 */
export const BUILD_OPERATION = "BUILD_OPERATION";

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
  value: IValue;
  constraints: Constraints;
}

registerProvenanceRenderer(MODEL_REF_PROVENANCE, (step, context) => renderModelRef(step as IModelRefStep, context));
registerProvenanceRenderer(TARGET_PROVENANCE, step => {
  const target = (step as ITargetOrigin).decl;
  return [`${stringifyLoc(target)}: built by ${target.type} '${target.name}'`];
});

/* Short attribution ("the name it was written as") for one-line messages */
registerProvenanceDescriber(MODEL_REF_PROVENANCE, step => (step as IModelRefStep).value.value.toString());
registerProvenanceDescriber(TARGET_PROVENANCE, step => (step as ITargetOrigin).decl.name);

function renderModelRef(step: IModelRefStep, context: IRenderContext): string[] {
  const value = step.value;
  const header = `${stringifyLoc(value)}: ${context.stepIndex === 0 ? "from" : "via"} '${value.value.toString()}':`;
  const pos = value.source.reader.resolvePosition(value.offset);
  const lines = pos ? [header, pos.lineText, " ".repeat(pos.column - 1) + "^"] : [header];
  lines.push(...constraintLines(step));
  return lines;
}

/**
 * Describe the constraint set a reference was resolved under, but only where
 * it is informative: the deepest model step shows its (non-empty) constraints,
 * and other steps show only the entries that differ from the next model step
 * down the chain (i.e. override boundaries).
 */
function constraintLines(step: IModelRefStep): string[] {
  const deeper = findNextModelRef(step.parent);
  const entries = Object.entries(step.constraints).filter(([key, value]) => (deeper ? deeper.constraints[key] !== value : true));
  if (entries.length === 0) {
    return [];
  }
  return [`with ${entries.map(([key, value]) => `${key}=${value}`).sort().join(" ")}`];
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
}

/**
 * Failure of a target, as propagated to its dependants: carries the failed
 * target's declaration and the underlying cause, so that whoever ultimately
 * reports the failure (the driver) can attribute each cause to its target
 * exactly once and render dependants' failures tersely.
 */
export class DependencyFailedError extends Error {
  public readonly target: ITargetDecl;
  public readonly cause: Error;
  /**
   * Set when the failure is an anonymous sub-target's build step: the action
   * verb (e.g. "Compiling"). `target` is then the *declared* target it
   * belongs to, so the driver renders "Compiling X failed" against it and
   * collapses the intermediate hop.
   */
  public readonly label?: string;

  constructor(target: ITargetDecl, cause: Error, label?: string) {
    super(`dependency '${target.name}' failed`);
    this.target = target;
    this.cause = cause;
    this.label = label;
  }
}

interface IDependencyStack {
  target?: ITargetDecl;
  property: IPropertyDecl;
  context: BuildContext;
  value: IValue;
  next?: IDependencyStack;
}

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

  /** @return the BUILD_OPERATION this configuration is evaluating under */
  public getOperation(): string {
    return this.constraints[BUILD_OPERATION] ?? "build";
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
    } else {
      const def = this.model.getDecl(name);
      if (def?.kind === DeclKind.Target) {
        const result = this.resolveTarget(def, stack).then((target): SourceRef[] => [target]);
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
    process: (content: Readable, targetDir: string) => Computable<FileSet>
  ): Computable<FileSet> {
    return this.execution.buildCache.getOrFetch(url, tag, process);
  }

  public resolveStringProperty(prop: IPropertyDecl, target?: ITargetDecl, stack?: IDependencyStack): Computable<Property> {
    return Computable.forAll(
      prop.values.map(value => this.substituteNameVars(value.value, { property: prop, target, context: this, value, next: stack })),
      (...resolved) => new Property(resolved.map(name => name.toString()))
    );
  }

  /**
   * Resolve a FILES property to its sources. Each resolved source is wrapped
   * with a model-ref provenance step recording the written value and the
   * constraints in effect — chained onto whatever provenance it already
   * carried, so that nested resolutions accumulate multi-hop chains.
   */
  public resolveFileProperty(prop: IPropertyDecl, target?: ITargetDecl, stack?: IDependencyStack): Computable<SourceRef[]> {
    return Computable.forAll(
      prop.values.map(value =>
        this.resolveFileSource(value.value, prop, { property: prop, target, context: this, value, next: stack }).then(resolved =>
          resolved.sources.map(source => this.withModelRef(source, value))
        )
      ),
      (...resolved) => resolved.flat()
    );
  }

  private withModelRef(source: SourceRef, value: IValue): SourceRef {
    const step: IModelRefStep = { kind: MODEL_REF_PROVENANCE, value, constraints: this.constraints };
    if (source instanceof FileSet || source instanceof RepositoryRef) {
      return source.withStep(step);
    }
    return source;
  }

  /**
   * Resolve the Names as they appear in a target property list to their respective targets
   * (potentially causing them to be queued for evaluation), along with the declaration
   * the name resolved to (if it named a target or property rather than plain files).
   * @param name
   */
  private resolveFileSource(
    name: Name,
    relativeTo: INamedDecl,
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
            /* Names into a repository become references, deferred until the
             * consuming collection point resolves them jointly (and finding
             * into an existing reference narrows it); container sources answer
             * immediately. Result names follow the written-name rule: a
             * slash-form reference keeps the written prefix, a colon-form
             * reference strips it. */
            return target.then((t): IResolvedFileSource | Computable<IResolvedFileSource> => {
              const references: SourceRef[] = [];
              const containers: FileSource[] = [];
              for (const source of t) {
                if (source instanceof RepositoryRef) {
                  references.push(source.find(rest, retainedPrefix));
                } else if (isRepository(source)) {
                  /* The rest is a requirement identifier, not a file path:
                   * the written-name rule applies to projections into
                   * delivered content, not to the delivery itself */
                  references.push(new RepositoryRef(source, rest));
                } else {
                  containers.push(source);
                }
              }
              if (containers.length === 0) {
                return { sources: references, decl };
              }
              return FileSet.findAll(containers, rest)
                .then(data => (retainedPrefix ? data.remap(name => retainedPrefix + name) : data))
                .then(data => ({ sources: [...references, data], decl }));
            });
          }
        } else {
          /* Not an identified target; check the filesystem relative to the target decl */
          const baseName = relativeTo.source.file;
          return relativeTo.source.fs.find(substName.relativeTo(baseName)).then(data => ({ sources: [data] }));
        }
      }
    });
  }

  private substituteNameVars(name: Name, stack?: IDependencyStack): Computable<Name> {
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

  private resolveTarget(target: ITargetDecl, stack?: IDependencyStack): Computable<FileSource | Repository> {
    const targetDef = this.model.getTargetDef(target.type);
    if (!targetDef) {
      throw new Error("Targetdef '" + target.type + "' not found"); /* Can't happen due to earlier checks */
    }
    /* Repositories are not rule-built targets: the provider constructs the
     * instance lazily, interned per context via the target cache. No build
     * events, no build-cache entries of its own. */
    const provider = getRepositoryProvider(target.type);
    if (provider) {
      return provider(new RepositoryContext(target, this)).catch(err => {
        throw new DependencyFailedError(target, err);
      });
    }
    const rule = getTargetRule(target.type, this.constraints);
    if (!rule) {
      const configuration = Object.entries(this.constraints)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ");
      throw new Error(
        `No rule found to build '${target.type}'${configuration ? ` (${configuration})` : ""}\n` +
          `    at ${target.name} (${stringifyLoc(target)})\n` +
          stringifyDependencyStack(stack)
      );
    }
    return this.evaluateTarget(new DeclaredTargetContext(target, this, stack), rule);
  }

  /**
   * The shared evaluation core, uniform for declared and anonymous targets:
   * run the rule's evaluate, execute a yielded BuildAction through the cache,
   * stamp the producing target's provenance, and make the target the error
   * boundary (any failure wrapped to identify it). No reporting happens here —
   * the model layer doesn't log; the driver renders the failure tree.
   */
  private evaluateTarget(context: TargetContext, rule: IRuleDefinition): Computable<FileSource | Repository> {
    return rule
      .evaluate(context)
      .then(result => (result instanceof BuildAction ? this.runAction(result, context) : result))
      .then(result => (result instanceof FileSet ? context.stampProvenance(result) : result))
      .catch(err => {
        throw context.failure(err);
      });
  }

  /**
   * Build an anonymous target of the given (typically internal) type with the
   * given concrete inputs, returning its cached output — the mechanism a rule
   * composes sub-builds with (compile → run, object → link). It is an ordinary
   * target: same evaluation core, its own context (bag-backed), provenance and
   * error boundary — differing from a declared target only in having no
   * namespace entry and in receiving its inputs directly. Rule selection runs
   * under the owner's constraints (with explicit overrides available).
   */
  public buildSubTarget(
    owner: TargetContext,
    type: string,
    inputs: BuildActionInputs,
    options?: { label?: string; constraints?: Constraints }
  ): Computable<FileSet> {
    const buildContext = options?.constraints ? this.getContextWithOverrides(options.constraints) : this;
    const rule = getTargetRule(type, buildContext.constraints);
    if (!rule) {
      throw new Error(`No rule found for anonymous target type '${type}'`);
    }
    const context = new AnonymousTargetContext(buildContext, inputs, owner.getDeclaredContext(), options?.label ?? type, owner.stack);
    return buildContext.evaluateTarget(context, rule).then(result => {
      if (result instanceof FileSet) {
        return result;
      }
      throw new Error(`Anonymous target type '${type}' did not produce file content`);
    });
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
    return this.getCachedOrBuild(key, targetDir => {
      context.announceBuilding();
      return action.step.run(action.inputs, targetDir);
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
      .then(sources => materializeAll(sources))
      .then(sources => sources.filter((source): source is FileSet => source instanceof FileSet));
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
   */
  public collect(parts: Record<string, SourceRef[] | Computable<SourceRef[]>>): Computable<Record<string, FileSet[]>> {
    const names = Object.keys(parts);
    return Computable.forAll(
      names.map(name => {
        const value = parts[name];
        return value instanceof Computable ? value : Computable.resolve(value);
      }),
      (...lists: SourceRef[][]) => {
        const flat = lists.flat();
        return materializeAll(flat).then(resolved => {
          const result: Record<string, FileSet[]> = {};
          let index = 0;
          names.forEach((name, i) => {
            const slice = resolved.slice(index, index + lists[i].length);
            index += lists[i].length;
            result[name] = slice.filter((source): source is FileSet => source instanceof FileSet);
          });
          return result;
        });
      }
    );
  }

  /**
   * Build an anonymous target of the given internal type with concrete
   * inputs, returning its cached output — how a rule composes a sub-build
   * (e.g. the compiled tree consumed by both the package and the test run).
   * The sub-target's rule reads those inputs through the same context
   * accessors (getFileSet, getRequiredString, …) as any target.
   */
  public subTarget(
    type: string,
    inputs: BuildActionInputs,
    options?: { label?: string; constraints?: Constraints }
  ): Computable<FileSet> {
    return this.context.buildSubTarget(this, type, inputs, options);
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
      .then(sources => materializeAll(sources));
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
  private announced = false;

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
    return this.getContext(overrides).resolveFileProperty(prop, this.target, this.stack);
  }

  public getDeclaredContext(): DeclaredTargetContext {
    return this;
  }

  public stampProvenance(result: FileSet): FileSet {
    const step: ITargetOrigin = { kind: TARGET_PROVENANCE, decl: this.target, parent: result.origin };
    return result.withOrigin(step);
  }

  public failure(err: Error): DependencyFailedError {
    return new DependencyFailedError(this.target, err);
  }

  public announceBuilding(): void {
    if (this.announced) {
      return;
    }
    this.announced = true;
    this.notifyProgress({
      kind: "target-build",
      target: this.target,
      operation: this.context.getOperation(),
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
    /* The umbrella "Building X" (the declared target, once), then this
     * specific step ("Compiling X") attributed to it. */
    this.declared.announceBuilding();
    this.notifyProgress({ kind: "sub-target-build", declared: this.declared.target, label: this.label });
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
   * (a miss) is announced as progress, attributed to this repository.
   */
  public fetch(url: string, tag: string, process: (content: Readable, targetDir: string) => Computable<FileSet>): Computable<FileSet> {
    return this.context.getCachedOrFetch(url, tag, (content, targetDir) => {
      this.notifyProgress({ kind: "fetch", url, target: this.target });
      return process(content, targetDir);
    });
  }

  public notifyProgress(event: ProgressEvent): void {
    this.context.execution.notifyProgress(event);
  }
}
