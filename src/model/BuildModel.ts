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

import { INamespaceDecl, IPropertyDecl, ITargetDecl, ITargetDefDecl } from "./AST";
import { IPrefixMatch, Namespace } from "./Namespace";
import { BuildContext, Constraints } from "./BuildContext";
import { Name } from "./Name";
import { BuildCache } from "../core/BuildCache";

/**
 * Build model holds the generalized model-as-it-is-written in the build files.
 *
 * It primarily exists to maintain a cache from constraint sets to active
 */
export class BuildModel {
  private root: Namespace;
  private configs: BuildContext[] = [];
  private buildCache: BuildCache;

  constructor(root: Namespace, cache: BuildCache) {
    this.root = root;
    this.buildCache = cache;
  }

  /**
   * @return the build configuration under the given (possibly empty set of) constraints
   */
  public getConfig(constraints: Constraints = {}): BuildContext {
    /* Todo: hash the constraints instead of linearly scanning */
    for (const config of this.configs) {
      if (config.hasConstraints(constraints)) {
        return config;
      }
    }
    const config = new BuildContext(this, constraints);
    this.configs.push(config);
    return config;
  }

  public getDecl(name: string): IPropertyDecl | ITargetDecl | INamespaceDecl | undefined {
    return this.root.getDecl(name);
  }

  public getTargetDef(name: string): ITargetDefDecl | undefined {
    return this.root.getTargetDef(name);
  }

  public getPrefixMatch(name: Name): IPrefixMatch | undefined {
    return this.root.getPrefixMatch(name);
  }

  public getBuildCache(): BuildCache {
    return this.buildCache;
  }
}
