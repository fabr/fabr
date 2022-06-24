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

import { Computable } from "../core/Computable";
import { evaluateTarget } from "../rules/Evaluate";
import { resolveProperty } from "../rules/Resolve";
import { IPropertyDecl, ITargetDecl } from "./AST";
import { Name } from "./Name";
import { Namespace } from "./Namespace";
import { Property } from "./Property";
import { Target } from "./Target";

export type Constraints = Record<string, Property>;

/**
 * Build model holds the generalized model-as-it-is-written in the build files.
 */
export class BuildModel {
  private root: Namespace;
  private configs: BuildConfig[] = [];

  constructor(root: Namespace) {
    this.root = root;
  }

  /**
   * @return the build configuration under the given (possibly empty set of) constraints
   */
  public getConfig(constraints: Constraints = {}): BuildConfig {
    /* Todo: hash the constraints instead of linearly scanning */
    for (const config of this.configs) {
      if (config.hasConstraints(constraints)) {
        return config;
      }
    }
    const config = new BuildConfig(this, constraints);
    this.configs.push(config);
    return config;
  }

  public getProperty(name: string): IPropertyDecl | undefined {
    return this.root.getProperty(name);
  }

  public getTarget(name: string): ITargetDecl | undefined {
    return this.root.getTarget(name);
  }

  public getPrefixTarget(name: string): [ITargetDecl, string] | undefined {
    return this.root.getPrefixTarget(name);
  }
}

export class BuildConfig {
  protected constraints: Constraints;
  private model: BuildModel;
  private propCache: Record<string, Computable<Property> | null>;
  private targetCache: Record<string, Computable<Target> | null>;

  constructor(model: BuildModel, constraints: Constraints) {
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

  public getTargetWithOverrides(name: string, overrides: Constraints): Computable<any> {
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
      const def = this.model.getProperty(name);
      if (!def) {
        throw new Error("Unresolved name '" + name + "'"); /* TODO: actual error reporting */
      }
      this.propCache[name] = null;
      const result = resolveProperty(def, this);
      this.propCache[name] = result;
      return result;
    }
  }

  public hasTarget(name: string): boolean {
    return Boolean(this.model.getTarget(name));
  }

  public getTarget(name: string): Computable<Target> {
    if (name in this.targetCache) {
      /* Already seen */
      const result = this.targetCache[name];
      if (result === null) {
        throw new Error("Circular dependency at '" + name + "'");
      } else {
        return result;
      }
    } else {
      const def = this.model.getTarget(name);
      if (!def) {
        throw new Error("Unresolved name '" + name + "'"); /* TODO: actual error reporting */
      }
      this.targetCache[name] = null;
      const result = evaluateTarget(def, this);
      this.targetCache[name] = result;
      return result;
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
  public getPrefixTargetIfExists(name: Name): [Computable<Target>, Name] | undefined {
    const literalPrefix = name.getLiteralPathPrefix();
    if (literalPrefix !== "") {
      const result = this.model.getPrefixTarget(literalPrefix);
      if (result) {
        /* Fixme Could be more efficient */
        const [decl, matched] = result;
        return [this.getTarget(matched), name.withoutPrefix(matched)];
      }
    }
    return undefined;
  }
}
