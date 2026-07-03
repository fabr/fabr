import { Readable } from "stream";
import { BuildCache } from "../core/BuildCache";
import { Computable } from "../core/Computable";
import { EMPTY_FILESET, FileSet, FileSource } from "../core/FileSet";
import { isRepository, materializeAll, Repository, RepositoryRef, SourceRef } from "../core/Repository";
import { Flag } from "../core/Flag";
import {
  IProvenanceStep,
  IRenderContext,
  registerProvenanceDescriber,
  registerProvenanceRenderer,
} from "../core/Provenance";
import { getTargetRule } from "../rules/Registry";
import { ITargetOrigin, TARGET_PROVENANCE } from "./Target";
import { DeclKind, IDecl, INamedDecl, INamespaceDecl, IPropertyDecl, ITargetDecl, ITargetDefDecl, IValue } from "./AST";
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
  getConfig(constraints: Constraints): BuildContext;
  getDecl(name: string): IPropertyDecl | ITargetDecl | INamespaceDecl | undefined;
  getTargetDef(name: string): ITargetDefDecl | undefined;
  getPrefixMatch(name: Name): IPrefixMatch | undefined;
  getBuildCache(): BuildCache;
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

  constructor(target: ITargetDecl, cause: Error) {
    super(`dependency '${target.name}' failed`);
    this.target = target;
    this.cause = cause;
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
  protected constraints: Constraints;
  private model: IBuildModel;
  private propCache: Record<string, Computable<Property>>;
  private targetCache: Record<string, Computable<SourceRef[]>>;

  constructor(model: IBuildModel, constraints: Constraints) {
    this.model = model;
    this.constraints = constraints;
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
    const combined = { ...this.constraints, ...overrides };
    return this.model.getConfig(combined).getProperty(name);
  }

  public getTargetWithOverrides(name: string, overrides: Constraints): Computable<SourceRef[]> {
    const combined = { ...this.constraints, ...overrides };
    return this.model.getConfig(combined).getTarget(name);
  }

  public getContextWithOverrides(overrides: Constraints): BuildContext {
    const combined = { ...this.constraints, ...overrides };
    return this.model.getConfig(combined);
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
   * the matched declaration and a new Name representing the unmatched suffix.
   * If no such target can be found, returns undefined.
   *
   * e.g. given a name of "mylib/lib/*" and a declared target 'mylib', will return
   * the Computable for mylib and the remaining name "lib/*".
   *
   * Note: target names are not pattern matched against globs (ie only the literal prefix
   * of the name is looked up)
   */
  public getPrefixTargetIfExists(
    name: Name,
    stack?: IDependencyStack
  ): { target: Computable<SourceRef[]>; rest: Name; decl: ITargetDecl | IPropertyDecl } | undefined {
    const result = this.model.getPrefixMatch(name);
    if (result) {
      return { target: this.getTarget(result.decl.name, stack), rest: result.rest, decl: result.decl };
    }
    return undefined;
  }

  public getCachedOrBuild(manifest: string, create: (targetDir: string) => Computable<FileSet>): Computable<FileSet> {
    return this.model.getBuildCache().getOrCreate(manifest, create);
  }

  public getCachedOrFetch(url: string, process: (content: Readable, targetDir: string) => Computable<FileSet>): Computable<FileSet> {
    return this.model.getBuildCache().getOrFetch(url, process);
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
          const { target, rest, decl } = targetDep;
          if (rest.isEmpty()) {
            return target.then(sources => ({ sources, decl }));
          } else {
            /* Names into a repository become references, deferred until the
             * consuming collection point resolves them jointly (and finding
             * into an existing reference narrows it); container sources answer
             * immediately. */
            return target.then((t): IResolvedFileSource | Computable<IResolvedFileSource> => {
              const references: SourceRef[] = [];
              const containers: FileSource[] = [];
              for (const source of t) {
                if (source instanceof RepositoryRef) {
                  references.push(source.find(rest));
                } else if (isRepository(source)) {
                  references.push(new RepositoryRef(source, rest));
                } else {
                  containers.push(source);
                }
              }
              if (containers.length === 0) {
                return { sources: references, decl };
              }
              return FileSet.findAll(containers, rest).then(data => ({ sources: [...references, data], decl }));
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
    /* The target is the error boundary: any failure is wrapped to identify the
     * target it belongs to, and propagates onwards to the target's dependants.
     * No reporting happens here — the model layer doesn't log; the driver
     * renders the failure tree. Successful FileSet results are stamped with the
     * producing target's provenance.
     */
    return rule
      .evaluate(new TargetContext(target, this, stack))
      .then(result => {
        if (result instanceof FileSet) {
          const step: ITargetOrigin = { kind: TARGET_PROVENANCE, decl: target, parent: result.origin };
          return result.withOrigin(step);
        }
        return result;
      })
      .catch(err => {
        throw new DependencyFailedError(target, err);
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
 * The context for an individual target.
 */
export class TargetContext {
  public target: ITargetDecl;
  public context: BuildContext;
  public stack?: IDependencyStack;
  private props: Record<string, IPropertyDecl>;

  constructor(target: ITargetDecl, context: BuildContext, stack?: IDependencyStack) {
    this.target = target;
    this.context = context;
    this.stack = stack;
    this.props = {};
    target.properties.forEach(prop => {
      this.props[prop.name] = prop;
    });
  }

  public getRequiredProperty(name: string, overrides?: Constraints): Computable<Property> {
    const prop = this.props[name];
    if (!prop) {
      throw new Error("Missing required property " + name);
    }
    return this.getContext(overrides).resolveStringProperty(prop, this.target, this.stack);
  }

  public getProperty(name: string, overrides?: Constraints): Computable<Property | undefined> {
    const prop = this.props[name];
    if (!prop) {
      return Computable.resolve(undefined);
    }
    return this.getContext(overrides).resolveStringProperty(prop, this.target, this.stack);
  }

  public getRequiredString(name: string, overrides?: Constraints): Computable<string> {
    return this.getRequiredProperty(name, overrides).then(prop => prop.toString());
  }

  public getFileSources(name: string, overrides?: Constraints): Computable<SourceRef[]> {
    const prop = this.props[name];
    if (!prop) {
      return Computable.resolve([]);
    }
    return this.getContext(overrides).resolveFileProperty(prop, this.target, this.stack);
  }

  public getFlags(name: string, overrides?: Constraints): Computable<Flag[]> {
    return this.getFileSources(name, overrides).then(sources => sources.filter(source => source instanceof Flag) as Flag[]);
  }

  /**
   * Resolve a FILES property to its individual (fully materialized) FileSets —
   * one per contributing source, before any merging. This is the collection
   * point at which deferred repository references are resolved jointly.
   */
  public getFileSets(name: string): Computable<FileSet[]> {
    const prop = this.props[name];
    if (!prop) {
      return Computable.resolve([]);
    }
    return this.getContext()
      .resolveFileProperty(prop, this.target, this.stack)
      .then(sources => materializeAll(sources))
      .then(sources => sources.filter((source): source is FileSet => source instanceof FileSet));
  }

  public getFileSet(name: string): Computable<FileSet> {
    return this.getFileSets(name).then(sets => FileSet.unionAll(...sets));
  }

  public getCachedOrBuild(manifest: string, create: (targetDir: string) => Computable<FileSet>): Computable<FileSet> {
    return this.context.getCachedOrBuild(manifest, create);
  }

  public getCachedOrFetch(url: string, process: (content: Readable, targetDir: string) => Computable<FileSet>): Computable<FileSet> {
    return this.context.getCachedOrFetch(url, process);
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

  private getContext(overrides?: Constraints): BuildContext {
    return overrides ? this.context.getContextWithOverrides(overrides) : this.context;
  }
}
