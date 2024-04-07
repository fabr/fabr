import { Computable } from "../core/Computable";
import { FileSet } from "../core/FileSet";
import { getTargetRule } from "../rules/Registry";
import { DeclKind, INamedDecl, INamespaceDecl, IPropertyDecl, ITargetDecl, ITargetDefDecl, PropertyType } from "./AST";
import { Name } from "./Name";
import { Property } from "./Property";
import { Target } from "./Target";

export type Constraints = Record<string, Property>;

interface IBuildModel {
  getConfig(constraints: Constraints): BuildContext;
  getDecl(name: string): IPropertyDecl | ITargetDecl | INamespaceDecl | undefined;
  getTargetDef(name: string): ITargetDefDecl | undefined;
  getPrefixMatch(name: string): [ITargetDecl | IPropertyDecl, string] | undefined;
}

/**
 * A BuildConfig is (effectively) the BuildModel instantiated with an explicit set of additional
 * constraints (which may be the empty set).
 *
 * As a practical matter, this is where everything is actually resolved and evaluated.
 */
export class BuildContext {
  protected constraints: Constraints;
  private model: IBuildModel;
  private propCache: Record<string, Computable<Property> | null>;
  private targetCache: Record<string, Computable<Target[]> | null>;

  constructor(model: IBuildModel, constraints: Constraints) {
    this.model = model;
    this.constraints = constraints;
    this.propCache = {};
    this.targetCache = {};
    // Pre-force the constraints so we don't have to check this later.
    Object.keys(constraints).forEach(key => (this.propCache[key] = Computable.resolve(constraints[key])));
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

  public getTargetWithOverrides(name: string, overrides: Constraints): Computable<Target[]> {
    const combined = { ...this.constraints, ...overrides };
    return this.model.getConfig(combined).getTarget(name);
  }

  public getProperty(name: string): Computable<Property> {
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
      this.propCache[name] = null;
      const result = this.resolveStringProperty(def);
      this.propCache[name] = result;
      return result;
    }
  }

  public getTarget(name: string): Computable<Target[]> {
    if (name in this.targetCache) {
      /* Already seen */
      const result = this.targetCache[name];
      if (result === null) {
        throw new Error("Circular dependency at '" + name + "'");
      } else {
        return result;
      }
    } else {
      const def = this.model.getDecl(name);
      if (def?.kind === DeclKind.Target) {
        this.targetCache[name] = null;
        const result = this.resolveTarget(def).then(target => [target]);
        this.targetCache[name] = result;
        return result;
      } else if (def?.kind === DeclKind.Property) {
        this.targetCache[name] = null;
        const result = this.getProperty(name).then(prop =>
          Computable.forAll(
            prop.getValues().map(value => this.getTarget(value)),
            (...resolved) => resolved.flat()
          )
        );
        this.targetCache[name] = result;
        return result;
      } else {
        throw new Error("Unresolved name '" + name + "'"); /* TODO: actual error reporting */
      }
    }
  }

  /**
   * Find and return a target from the literal prefix of the given name, and return
   * a new Name representing the unmatched suffix. If no such target can be found,
   * returns undefined.
   *
   * e.g. given a name of "mylib/lib/*" and a declared target 'mylib', will return
   * the Computable for mylib and the remaining name "lib/*".
   *
   * Note: target names are not pattern matched against globs (ie only the literal prefix
   * of the name is looked up)
   */
  public getPrefixTargetIfExists(name: Name): [Computable<Target[]>, Name] | undefined {
    const literalPrefix = name.getLiteralPathPrefix();
    if (literalPrefix !== "") {
      const result = this.model.getPrefixMatch(literalPrefix);
      if (result) {
        /* Fixme Could be more efficient */
        const matched = result[1];
        return [this.getTarget(matched), name.withoutPrefix(matched)];
      }
    }
    return undefined;
  }

  private resolveStringProperty(prop: IPropertyDecl): Computable<Property> {
    return Computable.forAll(
      prop.values.map(value => this.substituteNameVars(value.value)),
      (...resolved) => new Property(resolved.map(name => name.toString()))
    );
  }

  private resolveFileProperty(prop: IPropertyDecl): Computable<FileSet[]> {
    return Computable.forAll(
      prop.values.map(value => this.resolveFileSet(value.value, prop)),
      (...resolved) => resolved.flat()
    );
  }

  /**
   * Resolve the Names as they appear in a target property list to their respective targets
   * (potentially causing them to be queued for evaluation)
   * @param name
   */
  private resolveFileSet(name: Name, relativeTo: INamedDecl): Computable<FileSet[]> {
    return this.substituteNameVars(name).then(substName => {
      if (substName.isEmpty()) {
        return [];
      } else {
        const targetDep = this.getPrefixTargetIfExists(substName);
        if (targetDep) {
          const [target, rest] = targetDep;
          if (rest.isEmpty()) {
            return target;
          } else {
            return target.then(t => FileSet.unionAll(...t).find(rest)).then(data => [data]);
          }
        } else {
          /* Not an identified target; check the filesystem relative to the target decl */
          const baseName = relativeTo.source.file;
          return relativeTo.source.fs.find(substName.relativeTo(baseName)).then(data => [data]);
        }
      }
    });
  }

  private substituteNameVars(name: Name): Computable<Name> {
    const vars = name.getVariables();
    return Computable.forAll(
      vars.map(varName => this.getProperty(varName)),
      (...resolvedVars) => {
        const substName = name.substitute(
          vars,
          resolvedVars.map(prop => prop.toString())
        );
        return substName;
      }
    );
  }

  private resolveTarget(target: ITargetDecl): Computable<Target> {
    const targetDef = this.model.getTargetDef(target.type);
    if (!targetDef) {
      throw new Error("Targetdef '" + target.type + "' not found"); /* Can't happen due to earlier checks */
    }
    const rule = getTargetRule(target.type)!;
    if (!rule) {
      throw new Error("No rule found to build '" + target.type + "'");
    }
    const resolvedProps = target.properties.map(prop => {
      const type = targetDef.properties[prop.name];
      switch (type.type) {
        case PropertyType.String:
        case PropertyType.StringList:
          return this.resolveStringProperty(prop);
        case PropertyType.FileSet:
        case PropertyType.FileSetList:
          return this.resolveFileProperty(prop);
        default:
          throw new Error("Unsupported property type");
      }
    });

    return Computable.forAll(resolvedProps, (...resolved) => {
      const keys = Object.keys(target.properties);
      const resolvedTarget = keys.reduce<Record<string, Property | FileSet[]>>((m, k, idx) => {
        m[k] = resolved[idx];
        return m;
      }, {});
      return rule.evaluate(resolvedTarget);
    });
  }
}
