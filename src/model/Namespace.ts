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

import { DeclKind, INamespaceDecl, IPropertyDecl, ITargetDecl } from "./AST";
import { NAME_COMPONENT_SEPARATOR } from "./Name";

type ContentType = Namespace | ITargetDecl | IPropertyDecl;

/**
 * A namespace is a target-like entity that contains other targets or properties.
 *
 */
export class Namespace {
  private content: Record<string, ContentType>;

  /* If it's an explicit namespace, keep it here; leave undefined for implicit ones */
  private decl?: INamespaceDecl;

  constructor(content: Record<string, ContentType>, decl?: INamespaceDecl) {
    this.content = content;
    this.decl = decl;
  }

  /**
   * @return the property with the given name or undefined if there is no such property
   * (either the name does not exist or it is not a property)
   */
  public getProperty(name: string): IPropertyDecl | undefined {
    const item = this.getDecl(name);
    if (item?.kind === DeclKind.Property) {
      return item;
    }
  }

  /**
   * @return the target with the given name or undefined if there is no such target
   * (either the name does not exist or it is not a target)
   */
  public getTarget(name: string): ITargetDecl | undefined {
    const item = this.getDecl(name);
    if (item?.kind === DeclKind.Target) {
      return item;
    }
  }

  /**
   * @return the target whose name forms a prefix of the given string, plus the
   *   matched prefix of the string.
   */
  public getPrefixTarget(name: string): [ITargetDecl, string] | undefined {
    const parts = name.split(NAME_COMPONENT_SEPARATOR);
    let node: Namespace = this;
    for (let idx = 0; idx < parts.length; idx++) {
      const next = node.content[parts[idx]];
      if (next instanceof Namespace) {
        node = next;
      } else {
        if (next.kind === DeclKind.Target) {
          return [next, parts.slice(0, idx + 1).join(NAME_COMPONENT_SEPARATOR)];
        } else {
          return undefined;
        }
      }
    }
  }

  /**
   * @return the explicit (declared) namespace with the given name or undefined if there
   * is no such namespace (either the name does not exist or it is not a namespace)
   */
  public getNamespace(name: string): INamespaceDecl | undefined {
    const item = this.getDecl(name);
    if (item?.kind === DeclKind.Namespace) {
      return item;
    }
  }

  /**
   * @return the decl with the given name, or undefined if there is no such decl.
   * @param name
   * @returns
   */
  public getDecl(name: string): ITargetDecl | IPropertyDecl | INamespaceDecl | undefined {
    const parts = name.split(NAME_COMPONENT_SEPARATOR);
    const targetName = parts.pop()!; /* Array must contain at least 1 element */
    const item = this.getNamespacePrefix(parts)?.content[targetName];
    if (item instanceof Namespace) {
      return item.decl;
    } else {
      return item;
    }
  }

  private getNamespacePrefix(parts: string[]): Namespace | undefined {
    let ns: Namespace = this;
    for (let idx = 0; idx < parts.length; ++idx) {
      const next = ns.content[parts[idx]];
      if (!(next instanceof Namespace)) {
        return undefined;
      }
      ns = next;
    }
    return ns;
  }
}
