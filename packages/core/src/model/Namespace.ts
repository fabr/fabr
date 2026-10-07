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

import { DeclKind, INamespaceDecl, IPropertyDecl, ITargetDecl, ITargetDefDecl } from "./AST";
import { NAME_COMPONENT_SEPARATOR, Name } from "../core/Name";

/**
 * What a name maps to when it names a property: every declaration of it, in the
 * two tiers a read consults — those written ordinarily, and those written
 * `default`, which supply the property exactly when no ordinary declaration's
 * guard matched.
 *
 */
export interface IPropertyEntry {
  kind: DeclKind.Property;
  decls: IPropertyDecl[];
  defaults: IPropertyDecl[];
  /** A `default` TARGET of the same name, which answers wherever none of the
   * property's declarations applies (its guards exclude the configuration). */
  fallbackTarget?: ITargetDecl;
}

type ContentType = Namespace | ITargetDecl | IPropertyEntry;

export interface IPrefixMatch {
  /* The matched declaration, or — for a property — all of them */
  decl: ITargetDecl | IPropertyEntry;
  /* The matched name, qualified by any namespace path it was found under */
  name: string;
  /* The part of the prefix string after the last ':' in the matched prefix (if any).
   * That is, if we match e.g. a/b:c/d at c, then `c` is the retained part
   */
  retainedPrefix: string;
  /* The part of the string that's left over after matching decl */
  rest: Name;
}

/**
 * A namespace is a target-like entity that contains other targets or properties.
 *
 */
export class Namespace {
  private content: Map<string, ContentType>;

  private targetDefs: Map<string, ITargetDefDecl>;

  /* If it's an explicit namespace, keep it here; leave undefined for implicit ones */
  private decl?: INamespaceDecl;

  /** The declaration answering names under this namespace that nothing
   *  declares — and the name of the namespace itself, as a target. */
  private fallback?: ITargetDecl;

  constructor(content: Map<string, ContentType>, targetDefs: Map<string, ITargetDefDecl>, decl?: INamespaceDecl, fallback?: ITargetDecl) {
    this.content = content;
    this.decl = decl;
    this.targetDefs = targetDefs;
    this.fallback = fallback;
  }

  /**
   * @return every declaration of the property with the given name, in the two
   * tiers a read consults, or undefined if there is no such property (either the
   * name does not exist or it is not a property)
   */
  public getProperty(name: string): IPropertyEntry | undefined {
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

  public getTargetDef(name: string): ITargetDefDecl | undefined {
    const parts = name.split(NAME_COMPONENT_SEPARATOR);
    const targetName = parts.pop()!; /* Array must contain at least 1 element */
    return this.getNamespacePrefix(parts)?.targetDefs.get(targetName);
  }

  /** @return this namespace's own targetdefs, in declaration order (does not
   * recurse into sub-namespaces — targetdefs are conventionally top-level). */
  public getTargetDefs(): ITargetDefDecl[] {
    return [...this.targetDefs.values()];
  }

  /** @return every target declared in this namespace and, recursively, its
   * sub-namespaces — each paired with its fully-qualified name (a sub-namespace
   * target carries its namespace path, `ns/target`). Repository instances share
   * the target-decl shape and are included here; a caller wanting only buildable
   * targets filters by type. */
  public getTargets(prefix = ""): { name: string; decl: ITargetDecl }[] {
    const result: { name: string; decl: ITargetDecl }[] = [];
    for (const [key, item] of this.content) {
      const qualified = prefix === "" ? key : prefix + NAME_COMPONENT_SEPARATOR + key;
      if (item instanceof Namespace) {
        if (item.fallback !== undefined) {
          result.push({ name: qualified, decl: item.fallback });
        }
        result.push(...item.getTargets(qualified));
      } else if (item.kind === DeclKind.Target) {
        result.push({ name: qualified, decl: item });
      }
    }
    return result;
  }

  /** @return every property declared in this namespace and, recursively, its
   * sub-namespaces, each paired with its fully-qualified name — the effective
   * set (a `default` folded in unless overridden). Used to document the global
   * configuration surface (`BUILD_TYPE`, `JS_TARGET`, …). */
  public getProperties(prefix = ""): { name: string; decl: IPropertyDecl }[] {
    const result: { name: string; decl: IPropertyDecl }[] = [];
    for (const [key, item] of this.content) {
      const qualified = prefix === "" ? key : prefix + NAME_COMPONENT_SEPARATOR + key;
      if (item instanceof Namespace) {
        result.push(...item.getProperties(qualified));
      } else if (item.kind === DeclKind.Property) {
        /* One row per NAME: this documents the configuration surface, so a
         * property declared once per platform is still one property. The first
         * declaration represents it (a default only if nothing else declares
         * it). */
        const first = item.decls[0] ?? item.defaults[0];
        if (first) {
          result.push({ name: qualified, decl: first });
        }
      }
    }
    return result;
  }

  /**
   * Given a Name, return the first target or prop that can be identified
   * as a prefix of the Name.
   * Note this requires the name to have a literal prefix.
   * @return the target or prop whose name forms a prefix of the name, or the
   * fallback of the namespace the name reaches; undefined if neither.
   */
  public getPrefixMatch(name: Name): IPrefixMatch | undefined {
    const literalPrefix = name.getLiteralPathPrefix();
    if (literalPrefix === "") {
      return undefined;
    }
    const parts = literalPrefix.split(/[:/]/);
    let node: Namespace = this;

    const matchAt = (decl: ITargetDecl | IPropertyEntry, count: number): IPrefixMatch => {
      const matched = parts.slice(0, count).join(NAME_COMPONENT_SEPARATOR);
      const matchPrefix = literalPrefix.substring(0, matched.length + 1);
      const rest = name.substring(matched.length + 1);
      const colonIdx = matchPrefix.lastIndexOf(":");
      const retainedPrefix = colonIdx === -1 ? matchPrefix : matchPrefix.substring(colonIdx + 1);
      return { decl, name: matched, retainedPrefix, rest };
    };

    for (let idx = 0; idx < parts.length; idx++) {
      const next = node.content.get(parts[idx]);
      if (next instanceof Namespace) {
        node = next;
      } else if (next?.kind === DeclKind.Target || next?.kind === DeclKind.Property) {
        return matchAt(next, idx + 1);
      } else {
        /* Nothing declared here: the namespace's fallback answers, if it has one. */
        return next === undefined && node.fallback !== undefined ? matchAt(node.fallback, idx) : undefined;
      }
    }
    /* The name IS a namespace: its fallback is what it names as a target. */
    return node.fallback !== undefined ? matchAt(node.fallback, parts.length) : undefined;
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
   */
  public getDecl(name: string): ITargetDecl | IPropertyEntry | INamespaceDecl | undefined {
    const parts = name.split(NAME_COMPONENT_SEPARATOR);
    const targetName = parts.pop()!; /* Array must contain at least 1 element */
    const item = this.getNamespacePrefix(parts)?.content.get(targetName);
    if (item instanceof Namespace) {
      return item.decl ?? item.fallback;
    } else {
      return item;
    }
  }

  private getNamespacePrefix(parts: string[]): Namespace | undefined {
    let ns: Namespace = this;
    for (let idx = 0; idx < parts.length; ++idx) {
      const next = ns.content.get(parts[idx]);
      if (!(next instanceof Namespace)) {
        return undefined;
      }
      ns = next;
    }
    return ns;
  }
}
