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

import { validateProperty, validateTarget, validateTargetDef } from "./Validate";
import { Diagnostic, ISourcePosition, Log } from "../support/Log";
import {
  DeclKind,
  declName,
  declPosn,
  getDeclKindName,
  IResolvableDecl,
  INamedDecl,
  IPropertyDecl,
  ITargetDecl,
  ITargetDefDecl,
} from "./AST";
import { NAME_COMPONENT_SEPARATOR } from "../core/Name";
import { IPropertyEntry, isNamespaceNode, Namespace, NamespaceEntry, NamespaceNode, newNamespaceNode } from "./Namespace";

const DIAG_DUPLICATE_DECL = Diagnostic.Error<{ kind: string; name: string; loc: ISourcePosition }>(
  "Duplicate declaration of {kind} '{name}'"
);

const DIAG_CONFLICT_DECL = Diagnostic.Error<{ kind: string; name: string; loc: ISourcePosition }>(
  "Conflicting declaration of {kind} '{name}'"
);

const DIAG_IMPLICIT_NAMESPACE_CONFLICT = Diagnostic.Error<{ kind: string; name: string; other: string; loc: ISourcePosition }>(
  "Declaration of {kind} '{name}' conflicts with implicit namespace containing '{other}'"
);
const DIAG_UNKNOWN_TARGET_TYPE = Diagnostic.Error<{ type: string; loc: ISourcePosition }>("Unknown target type '{type}'");

/** What to blame in a conflict against an existing entry: for a property, its
 * first declaration — they all share the name, and `addResolvableDecl` keeps
 * their written keys distinct. */
function blameFor(entry: NamespaceEntry): INamedDecl | NamespaceNode {
  if (isNamespaceNode(entry)) {
    return entry;
  }
  return entry.kind === DeclKind.Property ? entry.decls[0] ?? entry.defaults[0] : entry;
}

export class NamespaceBuilder {
  private log: Log;
  private root: NamespaceNode;
  /** Declarations superseded as they were added, validated with the rest by {@link resolve}. */
  private superseded: IResolvableDecl[] = [];

  constructor(log: Log) {
    this.log = log;
    this.root = newNamespaceNode();
  }

  public addDecl(decl: ITargetDefDecl | ITargetDecl | IPropertyDecl, root: NamespaceNode = this.root): boolean {
    const nameParts = declName(decl).split(NAME_COMPONENT_SEPARATOR);
    const simpleName = nameParts.pop()!;
    const parent = this.getNodeFor(root, nameParts, decl);
    if (parent) {
      if (decl.kind === DeclKind.TargetDef) {
        const existing = parent.targetDefs.get(simpleName);
        if (existing) {
          this.conflictError(existing, decl);
        } else {
          parent.targetDefs.set(simpleName, decl);
          return true;
        }
      } else {
        return this.addResolvableDecl(parent, simpleName, decl, "decls");
      }
    }
    return false;
  }

  public addDefaultDecl(decl: IResolvableDecl, root: NamespaceNode = this.root): boolean {
    const nameParts = declName(decl).split(NAME_COMPONENT_SEPARATOR);
    const simpleName = nameParts.pop()!;
    const parent = this.getNodeFor(root, nameParts, decl);
    return parent ? this.addResolvableDecl(parent, simpleName, decl, "defaults") : false;
  }

  /**
   * Add one target or property declaration under `simpleName`, into the given
   * `tier` (ordinary, or `default`).
   *
   * A property joins the entry already under that name, in its own tier — so
   * what must be unique is the key **as written**, guard included, which is what
   * `name.toString()` renders, and an ordinary declaration never collides with a
   * `default` one of the same key (they are different tiers). Across kinds the
   * tiers work the same way: an ordinary
   * declaration supersedes a `default` one of the other kind (a property keeps
   * a default target as its fallback — see {@link buildNamespace}), while two
   * `default`s of one name conflict whatever their kinds. Anything else — a
   * repeated key within a tier, an unguarded redeclaration, two targets, a
   * clash with a namespace — is the duplicate it looks like.
   */
  private addResolvableDecl(
    node: NamespaceNode,
    simpleName: string,
    decl: IResolvableDecl,
    tier: "decls" | "defaults"
  ): boolean {
    const existing = node.content.get(simpleName);
    if (decl.kind === DeclKind.Target) {
      if (tier === "defaults") {
        /* Kept apart (see NamespaceNode.defaultTargets). A name that is a
         * namespace is not a target's to take, and a second `default` of the
         * name — target or property — is a duplicate, not an override. */
        const clash =
          node.defaultTargets.get(simpleName) ??
          (existing !== undefined && (isNamespaceNode(existing) || (existing.kind === DeclKind.Property && existing.defaults.length > 0))
            ? existing
            : undefined);
        if (clash) {
          this.conflictError(blameFor(clash), decl);
          return false;
        }
        node.defaultTargets.set(simpleName, decl);
        if (existing !== undefined && !isNamespaceNode(existing) && existing.kind === DeclKind.Property) {
          existing.fallbackTarget = decl;
        }
        return true;
      }
      /* An ordinary target takes the name, superseding a property that has only
       * `default` declarations; anything else there is a conflict. */
      if (existing !== undefined && !(!isNamespaceNode(existing) && existing.kind === DeclKind.Property && existing.decls.length === 0)) {
        this.conflictError(blameFor(existing), decl);
        return false;
      }
      if (existing !== undefined && !isNamespaceNode(existing) && existing.kind === DeclKind.Property) {
        /* Superseded, but declared: validated like any declaration. */
        this.superseded.push(...existing.defaults);
      }
      node.content.set(simpleName, decl);
      return true;
    }
    if (tier === "defaults") {
      if (existing !== undefined && !isNamespaceNode(existing) && existing.kind === DeclKind.Target) {
        /* An ordinary target supersedes a `default` property outright. */
        this.superseded.push(decl);
        return true;
      }
      const defaultTarget = node.defaultTargets.get(simpleName);
      if (defaultTarget) {
        this.conflictError(defaultTarget, decl);
        return false;
      }
    }
    if (existing && !isNamespaceNode(existing) && existing.kind !== DeclKind.Property) {
      this.conflictError(blameFor(existing), decl);
      return false;
    }
    /* A property of a namespace's name is the namespace's fallback. */
    const entry: IPropertyEntry =
      existing === undefined
        ? { kind: DeclKind.Property, decls: [], defaults: [] }
        : isNamespaceNode(existing)
          ? (existing.fallback ??= { kind: DeclKind.Property, decls: [], defaults: [] })
          : existing;
    const clash = entry[tier].find(other => other.name.toString() === decl.name.toString());
    if (clash) {
      this.conflictError(clash, decl);
      return false;
    }
    entry[tier].push(decl);
    entry.fallbackTarget ??= node.defaultTargets.get(simpleName);
    if (existing === undefined) {
      node.content.set(simpleName, entry);
    }
    return true;
  }

  /**
   * Get the entry under `key` in `parent`, as a namespace where it is a
   * property: a property of a namespace's name is that namespace's fallback, so
   * the namespace takes it over. Anything else there is returned as it is.
   */
  private namespaceOf(parent: NamespaceNode, key: string, decl: INamedDecl): NamespaceEntry | undefined {
    const existing = parent.content.get(key) ?? parent.defaultTargets.get(key);
    if (existing === undefined || isNamespaceNode(existing) || existing.kind !== DeclKind.Property) {
      return existing;
    }
    const node: NamespaceNode = { ...newNamespaceNode(decl), fallback: existing };
    parent.content.set(key, node);
    return node;
  }

  /** @return the namespace of everything added, which reads what is added later too. */
  public toNamespace(): Namespace {
    return Namespace.of(this.root);
  }

  private getNodeFor(root: NamespaceNode, parts: string[], decl: INamedDecl): NamespaceNode | undefined {
    let node = root;
    for (const part of parts) {
      const existing = this.namespaceOf(node, part, decl);
      if (existing) {
        if (!isNamespaceNode(existing)) {
          /* Is not a namespace but we needed one */
          this.conflictError(blameFor(existing), decl);
          return undefined;
        } else {
          node = existing;
        }
      } else {
        const next = newNamespaceNode(decl);
        node.content.set(part, next);
        node = next;
      }
    }
    return node;
  }

  private resolveTargetDef(name: string): ITargetDefDecl | undefined {
    return this.root.targetDefs.get(name);
  }

  /** Validate every declaration added so far against the targetdefs added so far. */
  public validate(): void {
    this.resolve(this.root);
    this.superseded.forEach(decl => this.validateDecl(decl));
  }

  private resolve(node: NamespaceNode): void {
    node.content.forEach(child => {
      if (isNamespaceNode(child)) {
        this.resolve(child);
      } else {
        this.validateEntry(child);
      }
    });
    if (node.fallback !== undefined) {
      this.validateEntry(node.fallback);
    }
    /* Default targets live apart from `content` but are validated the same way:
     * declared ⇒ validated, whether or not anything ends up taking it. (A
     * default *property* is inside its entry, so the walk above covers it.) */
    node.defaultTargets.forEach(child => this.validateDecl(child));
    /* Targetdefs likewise live apart: each schema's own `default` values are
     * validated against the declared type here, so a malformed default fails
     * the load rather than the first resolution that takes it. */
    node.targetDefs.forEach(def => validateTargetDef(def, this.log));
  }

  /** Validate every declaration under one name — a property having as many as
   * its guards distinguish, in either tier, each validated in its own right. */
  private validateEntry(entry: ITargetDecl | IPropertyEntry): void {
    if (entry.kind === DeclKind.Property) {
      [...entry.decls, ...entry.defaults].forEach(decl => this.validateDecl(decl));
    } else {
      this.validateDecl(entry);
    }
  }

  /** Validate one collated declaration: a target against its targetdef schema, a
   * schema-less property (global or default) structurally. (A targetdef's own
   * schema is validated in {@link resolve}, off `targetDefs`.) */
  private validateDecl(decl: ITargetDefDecl | ITargetDecl | IPropertyDecl): void {
    if (decl.kind === DeclKind.Target) {
      const targetDef = this.resolveTargetDef(decl.type);
      if (!targetDef) {
        this.unknownTargetDefError(decl);
      } else {
        validateTarget(decl, targetDef, this.log);
      }
    } else if (decl.kind === DeclKind.Property) {
      validateProperty(decl, this.log);
    }
  }

  private conflictError(decl: INamedDecl | NamespaceNode, newDecl: INamedDecl): void {
    const oldDecl = "kind" in decl ? decl : decl.self!;
    const name = declName(newDecl);
    if (declName(oldDecl) === name) {
      this.log.log(oldDecl.kind === newDecl.kind ? DIAG_DUPLICATE_DECL : DIAG_CONFLICT_DECL, {
        kind: getDeclKindName(oldDecl.kind),
        loc: declPosn(newDecl),
        name,
      });
    } else {
      this.log.log(DIAG_IMPLICIT_NAMESPACE_CONFLICT, {
        kind: getDeclKindName(newDecl.kind),
        loc: declPosn(newDecl),
        name,
        other: declName(oldDecl),
      });
    }
  }

  private unknownTargetDefError(decl: ITargetDecl): void {
    this.log.log(DIAG_UNKNOWN_TARGET_TYPE, { type: decl.type, loc: { ...decl.source, offset: decl.typeOffset } });
  }
}
