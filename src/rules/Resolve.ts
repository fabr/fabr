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
import { EMPTY_FILESET, FileSet } from "../core/FileSet";
import { BuildConfig } from "../model/BuildModel";
import { Name } from "../model/Name";
import { INamedDecl, IPropertyDecl, ITargetDecl } from "../model/AST";
import { ITargetSchema, PropertyType, ResolvedType } from "./Types";
import { Property } from "../model/Property";

/**
 * Resolve everything needed to actually be able to build the target and yield a resolved
 * version of the target schema. Assumes that the target has already been validated.
 *
 * @param decl
 * @param schema
 * @param config
 * @returns
 */
export function resolveTarget<S extends ITargetSchema>(
  decl: ITargetDecl,
  schema: S,
  config: BuildConfig
): Computable<ResolvedType<S>> {
  const dependsOn: Computable<string[] | FileSet>[] = [];

  /**
   * Collect all of the values in a single dependency list to allow
   * for concurrent processing
   **/
  decl.properties.forEach(prop => {
    const propType = schema[prop.name].type;
    prop.values.forEach(value => {
      if (propType === PropertyType.FileSet) {
        dependsOn.push(resolveFileSet(value.value, config, decl));
      } else {
        dependsOn.push(resolveString(value.value, config, decl));
      }
    });
  });
  /**
   * And then split it back out into the target property structure
   * after resolution finishes.
   */
  return Computable.forAll(dependsOn, (...resolved) => {
    const result: Record<string, Array<string | FileSet>> = {};
    let idx = 0;
    decl.properties.forEach(prop => {
      const propLength = prop.values.length;
      const propEnd = idx + propLength;
      result[prop.name] = resolved.slice(idx, propEnd).flat();
      idx += propLength;
    });
    return result as ResolvedType<S>;
  });
}

export function resolveProperty(prop: IPropertyDecl, config: BuildConfig): Computable<Property> {
  const dependsOn: Computable<string[]>[] = [];
  prop.values.forEach(value => {
    dependsOn.push(resolveString(value.value, config, prop));
  });
  return Computable.forAll(dependsOn, (...resolved) => new Property(resolved.flat()));
}

function toSubstitutionMap(old: string[], subst: Property[]): Record<string, string> {
  return old.reduce<Record<string, string>>((result, key, index) => {
    result[key] = subst[index].toString();
    return result;
  }, {});
}

/**
 * Resolve the Names as they appear in a target property list to their respective targets
 * (potentially causing them to be queued for evaluation)
 * @param name
 */
export function resolveFileSet(name: Name, context: BuildConfig, relativeTo: INamedDecl): Computable<FileSet> {
  const vars = name.getVariables();
  return Computable.forAll(
    vars.map(varName => context.getProperty(varName)),
    (...resolvedVars) => {
      const substName = name.substitute(toSubstitutionMap(vars, resolvedVars));
      if (substName.isEmpty()) {
        /* Nothing to do, so quietly ignore it */
        return EMPTY_FILESET;
      } else {
        const targetDep = context.getPrefixTargetIfExists(substName);
        if (targetDep) {
          const [target, rest] = targetDep;
          if (rest.isEmpty()) {
            return target;
          } else {
            return target.then(t => t.find(rest));
          }
        } else {
          /* Not an identified target; check the filesystem relative to the target decl */
          const baseName = relativeTo.source.file;
          return relativeTo.source.fs.find(substName.relativeTo(baseName));
        }
      }
    }
  );
}

export function resolveString(name: Name, context: BuildConfig, relativeTo: INamedDecl): Computable<string[]> {
  /* STUB: this isn't remotely right */
  const vars = name.getVariables();
  return Computable.forAll(
    vars.map(varName => context.getProperty(varName)),
    (...resolvedVars) => {
      const substName = name.substitute(toSubstitutionMap(vars, resolvedVars));
      return [substName.toString()];
    }
  );
}
