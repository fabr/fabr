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

import { DeclKind, INamedDecl, IPropertyDecl, ITargetDecl, ITargetDefDecl } from "./AST";
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

/** What a name in a namespace holds: a sub-namespace, a target, or the
 * {@link IPropertyEntry} collecting every declaration of one property. */
export type NamespaceEntry = NamespaceNode | ITargetDecl | IPropertyEntry;

/** What one namespace holds: {@link NamespaceBuilder} adds to it, and a {@link Namespace} reads it. */
export interface NamespaceNode {
  self?: INamedDecl;
  /** The property of this namespace's own name, which answers names nothing
   * under it declares. */
  fallback?: IPropertyEntry;
  targetDefs: Map<string, ITargetDefDecl>;
  content: Map<string, NamespaceEntry>;
  /** `default` TARGETS, kept apart: one answers for its name where nothing in
   * `content` does, and is a property's `fallbackTarget` where a property
   * holds the name. */
  defaultTargets: Map<string, ITargetDecl>;
  /** The namespace reading this node, made the first time one is asked for. */
  view?: Namespace;
}

/** Make a node holding nothing, for the namespace `self` declares, if any. */
export function newNamespaceNode(self?: INamedDecl): NamespaceNode {
  return { self, content: new Map(), defaultTargets: new Map(), targetDefs: new Map() };
}

/** @return true if a name is held by a (sub-)namespace rather than by declarations, otherwise false. */
export function isNamespaceNode(entry: NamespaceEntry): entry is NamespaceNode {
  return !("kind" in entry);
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

/** The separator the rest of a name was written after, given the
 *  {@link IPrefixMatch.retainedPrefix} of its match: `:`, which retains
 *  nothing, or `/`, which retains the prefix through it. */
export function writtenSeparator(retainedPrefix: string): ":" | "/" {
  return retainedPrefix === "" ? ":" : "/";
}

/**
 * A namespace is a target-like entity that contains other targets or properties.
 *
 */
export class Namespace {
  /** Make the namespace reading `node`, which reads what is added to it later too. */
  constructor(private readonly node: NamespaceNode) {}

  /** @return the namespace reading `node`. */
  public static of(node: NamespaceNode): Namespace {
    return (node.view ??= new Namespace(node));
  }

  /** The property of this namespace's own name: it answers names under the
   *  namespace that nothing declares (the rest of the name is a projection
   *  into its value), and the namespace's name itself. */
  private get fallback(): IPropertyEntry | undefined {
    return this.node.fallback;
  }

  /** @return what `key` names here: what `content` holds, else a `default` target of the name. */
  private entry(key: string): ContentType | undefined {
    const found = this.node.content.get(key) ?? this.node.defaultTargets.get(key);
    return found !== undefined && isNamespaceNode(found) ? Namespace.of(found) : found;
  }

  /** @return every name here with what it names, those `content` holds first. */
  private entries(): Array<[string, ContentType]> {
    const keys = [...this.node.content.keys(), ...[...this.node.defaultTargets.keys()].filter(key => !this.node.content.has(key))];
    return keys.map((key): [string, ContentType] => [key, this.entry(key)!]);
  }

  public getTargetDef(name: string): ITargetDefDecl | undefined {
    const parts = name.split(NAME_COMPONENT_SEPARATOR);
    const targetName = parts.pop()!; /* Array must contain at least 1 element */
    return this.getNamespacePrefix(parts)?.node.targetDefs.get(targetName);
  }

  /** @return this namespace's own targetdefs, in declaration order (does not
   * recurse into sub-namespaces — targetdefs are conventionally top-level). */
  public getTargetDefs(): ITargetDefDecl[] {
    return [...this.node.targetDefs.values()];
  }

  /** @return every target declared in this namespace and, recursively, its
   * sub-namespaces — each paired with its fully-qualified name (a sub-namespace
   * target carries its namespace path, `ns/target`). Repository instances share
   * the target-decl shape and are included here; a caller wanting only buildable
   * targets filters by type. */
  public getTargets(prefix = ""): { name: string; decl: ITargetDecl }[] {
    const result: { name: string; decl: ITargetDecl }[] = [];
    for (const [key, item] of this.entries()) {
      const qualified = prefix === "" ? key : prefix + NAME_COMPONENT_SEPARATOR + key;
      if (item instanceof Namespace) {
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
    /* One row per NAME: this documents the configuration surface, so a
     * property declared once per platform is still one property. The first
     * declaration represents it (a default only if nothing else declares it). */
    const add = (name: string, entry: IPropertyEntry): void => {
      const first = entry.decls[0] ?? entry.defaults[0];
      if (first) {
        result.push({ name, decl: first });
      }
    };
    for (const [key, item] of this.entries()) {
      const qualified = prefix === "" ? key : prefix + NAME_COMPONENT_SEPARATOR + key;
      if (item instanceof Namespace) {
        if (item.fallback !== undefined) {
          add(qualified, item.fallback);
        }
        result.push(...item.getProperties(qualified));
      } else if (item.kind === DeclKind.Property) {
        add(qualified, item);
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
      const next = node.entry(parts[idx]);
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
   * @return the decl with the given name, or undefined if there is no such decl.
   */
  public getDecl(name: string): ITargetDecl | IPropertyEntry | undefined {
    const parts = name.split(NAME_COMPONENT_SEPARATOR);
    const targetName = parts.pop()!; /* Array must contain at least 1 element */
    const item = this.getNamespacePrefix(parts)?.entry(targetName);
    return item instanceof Namespace ? item.fallback : item;
  }

  private getNamespacePrefix(parts: string[]): Namespace | undefined {
    let ns: Namespace = this;
    for (let idx = 0; idx < parts.length; ++idx) {
      const next = ns.entry(parts[idx]);
      if (!(next instanceof Namespace)) {
        return undefined;
      }
      ns = next;
    }
    return ns;
  }
}
