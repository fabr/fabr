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
  INamespaceDecl,
  IPropertyDecl,
  ITargetDecl,
  ITargetDefDecl,
} from "./AST";
import { NAME_COMPONENT_SEPARATOR } from "../core/Name";
import { IPropertyEntry, Namespace } from "./Namespace";

const DIAG_DUPLICATE_DECL = Diagnostic.Error<{ kind: string; name: string; loc: ISourcePosition }>(
  "Duplicate declaration of {kind} '{name}'"
);

const DIAG_CONFLICT_DECL = Diagnostic.Error<{ kind: string; name: string; loc: ISourcePosition }>(
  "Conflicting declaration of {kind} '{name}'"
);

const DIAG_IMPLICIT_NAMESPACE_CONFLICT = Diagnostic.Error<{ kind: string; name: string; other: string; loc: ISourcePosition }>(
  "Declaration of {kind} '{name}' conflicts with implicit namespace containing '{other}'"
);
const DIAG_EXPLICIT_NAMESPACE_CONFLICT = Diagnostic.Error<{ kind: string; name: string; other: string; loc: ISourcePosition }>(
  "Declaration of {kind} '{name}' conflicts with namespace '{other}'"
);

const DIAG_UNKNOWN_TARGET_TYPE = Diagnostic.Error<{ type: string; loc: ISourcePosition }>("Unknown target type '{type}'");

/* A name holds what the finished namespace will hold: a sub-namespace still
 * under construction, a target, or the {@link IPropertyEntry} collecting every
 * declaration of one property (a guard lets one be declared once per
 * configuration it applies in). */
type BuilderEntry = NSBuilderNode | ITargetDecl | IPropertyEntry;

interface NSBuilderNode {
  self?: INamedDecl;
  /** The declaration of this namespace that answers names nothing under it
   * declares (see RepositoryRegistration.declaresNamespace). */
  fallback?: ITargetDecl;
  targetDefs: Map<string, ITargetDefDecl>;
  content: Map<string, BuilderEntry>;
  /** `default` TARGETS only, held aside until the whole file set is in: an
   * ordinary target of the name supersedes one outright, and an ordinary
   * property keeps it as its fallback — either may not have been seen yet. A
   * default property needs no such holding area — its two tiers both live in
   * its entry, because which of them supplies it is not decided here at all
   * (see {@link IPropertyEntry}). */
  defaultTargets: Map<string, ITargetDecl>;
}

function newBuilderNode(self?: INamedDecl): NSBuilderNode {
  return { self, content: new Map(), defaultTargets: new Map(), targetDefs: new Map() };
}

/** Whether a name is held by a (sub-)namespace rather than by declarations. */
function isBuilderNode(entry: BuilderEntry): entry is NSBuilderNode {
  return !("kind" in entry);
}

/** What to blame in a conflict against an existing entry: for a property, its
 * first declaration — they all share the name, and Validate has already made
 * them tell each other apart. */
function blameFor(entry: BuilderEntry): INamedDecl | NSBuilderNode {
  if (isBuilderNode(entry)) {
    return entry;
  }
  return entry.kind === DeclKind.Property ? entry.decls[0] ?? entry.defaults[0] : entry;
}

export class NamespaceBuilder {
  private log: Log;
  private root: NSBuilderNode;
  /** The target types whose declaration declares a namespace with a fallback. */
  private readonly namespaceTypes: ReadonlySet<string>;

  constructor(log: Log, namespaceTypes: ReadonlySet<string> = new Set()) {
    this.log = log;
    this.root = newBuilderNode();
    this.namespaceTypes = namespaceTypes;
  }

  public addNamespaceDecl(decl: INamespaceDecl, root: NSBuilderNode = this.root): boolean {
    const nameParts = declName(decl).split(NAME_COMPONENT_SEPARATOR);
    const simpleName = nameParts.pop()!;
    const parent = this.getNodeFor(root, nameParts, decl);
    if (parent) {
      let node: NSBuilderNode;
      const current = parent.content.get(simpleName);
      if (current) {
        if (!isBuilderNode(current)) {
          this.conflictError(blameFor(current), decl);
          return false;
        } else {
          /* merge; if it was implicit add the decl */
          if (!current.self || current.self.kind !== DeclKind.Namespace) {
            current.self = decl;
          }
          node = current;
        }
      } else {
        node = newBuilderNode(decl);
        parent.content.set(simpleName, node);
      }
      decl.namespaces.forEach(ns => this.addNamespaceDecl(ns, node));
      decl.properties.forEach(prop => this.addDecl(prop, node));
      decl.targets.forEach(target => this.addDecl(target, node));
      decl.defaults.forEach(child => this.addDefaultDecl(child, node));
      return true;
    }
    return false;
  }

  public addDecl(decl: ITargetDefDecl | ITargetDecl | IPropertyDecl, root: NSBuilderNode = this.root): boolean {
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

  public addDefaultDecl(decl: IResolvableDecl, root: NSBuilderNode = this.root): boolean {
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
    node: NSBuilderNode,
    simpleName: string,
    decl: IResolvableDecl,
    tier: "decls" | "defaults"
  ): boolean {
    const existing = node.content.get(simpleName);
    if (decl.kind === DeclKind.Target && tier === "decls" && this.namespaceTypes.has(decl.type)) {
      return this.addNamespaceFallback(node, simpleName, decl);
    }
    if (decl.kind === DeclKind.Target) {
      if (tier === "defaults") {
        /* Held aside until every file is in (see NSBuilderNode.defaultTargets). A
         * name that is a namespace is not a target's to take, and a second
         * `default` of the name — target or property — is a duplicate, not an
         * override. */
        const clash =
          node.defaultTargets.get(simpleName) ??
          (existing !== undefined && (isBuilderNode(existing) || (existing.kind === DeclKind.Property && existing.defaults.length > 0))
            ? existing
            : undefined);
        if (clash) {
          this.conflictError(blameFor(clash), decl);
          return false;
        }
        node.defaultTargets.set(simpleName, decl);
        return true;
      }
      /* An ordinary target takes the name, superseding a property that has only
       * `default` declarations; anything else there is a conflict. */
      if (existing !== undefined && !(!isBuilderNode(existing) && existing.kind === DeclKind.Property && existing.decls.length === 0)) {
        this.conflictError(blameFor(existing), decl);
        return false;
      }
      if (existing !== undefined && !isBuilderNode(existing) && existing.kind === DeclKind.Property) {
        /* Superseded, but declared: validated like any declaration. */
        existing.defaults.forEach(superseded => this.validateDecl(superseded));
      }
      node.content.set(simpleName, decl);
      return true;
    }
    if (tier === "defaults") {
      if (existing !== undefined && !isBuilderNode(existing) && existing.kind === DeclKind.Target) {
        /* An ordinary target supersedes a `default` property outright. */
        this.validateDecl(decl);
        return true;
      }
      const defaultTarget = node.defaultTargets.get(simpleName);
      if (defaultTarget) {
        this.conflictError(defaultTarget, decl);
        return false;
      }
    }
    if (existing && (isBuilderNode(existing) || existing.kind !== DeclKind.Property)) {
      this.conflictError(blameFor(existing), decl);
      return false;
    }
    const entry: IPropertyEntry = existing ?? { kind: DeclKind.Property, decls: [], defaults: [] };
    const clash = entry[tier].find(other => other.name.toString() === decl.name.toString());
    if (clash) {
      this.conflictError(clash, decl);
      return false;
    }
    entry[tier].push(decl);
    node.content.set(simpleName, entry);
    return true;
  }

  /**
   * Add a declaration that declares the namespace `simpleName` names, as that
   * namespace's fallback. It merges with a namespace other declarations imply;
   * anything else of the name — a target, a property, a second fallback — is a
   * conflict.
   */
  private addNamespaceFallback(node: NSBuilderNode, simpleName: string, decl: ITargetDecl): boolean {
    const existing = node.content.get(simpleName) ?? node.defaultTargets.get(simpleName);
    if (existing === undefined) {
      node.content.set(simpleName, { ...newBuilderNode(decl), fallback: decl });
      return true;
    }
    if (!isBuilderNode(existing) || existing.fallback !== undefined) {
      this.conflictError(isBuilderNode(existing) ? existing.fallback! : blameFor(existing), decl);
      return false;
    }
    existing.fallback = decl;
    existing.self = decl;
    return true;
  }

  public toNamespace(): Namespace {
    return this.buildNamespace(this.root);
  }

  private getNodeFor(root: NSBuilderNode, parts: string[], decl: INamedDecl): NSBuilderNode | undefined {
    let node = root;
    for (const part of parts) {
      const existing = node.content.get(part) ?? node.defaultTargets.get(part);
      if (existing) {
        if (!isBuilderNode(existing)) {
          /* Is not a namespace but we needed one */
          this.conflictError(blameFor(existing), decl);
          return undefined;
        } else {
          node = existing;
        }
      } else {
        const next = newBuilderNode(decl);
        node.content.set(part, next);
        node = next;
      }
    }
    return node;
  }

  private resolveTargetDef(name: string): ITargetDefDecl | undefined {
    return this.root.targetDefs.get(name);
  }

  public resolve(node: NSBuilderNode = this.root): void {
    node.content.forEach(child => {
      if (isBuilderNode(child)) {
        this.resolve(child);
      } else {
        this.validateEntry(child);
      }
    });
    if (node.fallback !== undefined) {
      this.validateDecl(node.fallback);
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

  private buildNamespace(node: NSBuilderNode): Namespace {
    const content = new Map<string, Namespace | ITargetDecl | IPropertyEntry>();
    node.content.forEach((child, key) => {
      content.set(key, isBuilderNode(child) ? this.buildNamespace(child) : child);
    });
    /* The one thing left to decide: where a `default` target applies. Where
     * nothing else claimed the name, it takes it; an ordinary target supersedes
     * it outright (a target carries no guard, so that is knowable here); an
     * ordinary property keeps it as the fallback for configurations none of its
     * declarations applies to, which only a read can know. A namespace cannot
     * be here — that is the add-time conflict. */
    node.defaultTargets.forEach((child, key) => {
      const claimant = content.get(key);
      if (claimant === undefined) {
        content.set(key, child);
      } else if (!(claimant instanceof Namespace) && claimant.kind === DeclKind.Property) {
        content.set(key, { ...claimant, fallbackTarget: child });
      }
    });
    const decl = node.self?.kind === DeclKind.Namespace ? node.self : undefined;
    return new Namespace(content, node.targetDefs, decl, node.fallback);
  }

  private conflictError(decl: INamedDecl | NSBuilderNode, newDecl: INamedDecl): void {
    const oldDecl = "kind" in decl ? decl : decl.self!;
    const name = declName(newDecl);
    if (declName(oldDecl) === name) {
      this.log.log(oldDecl.kind === newDecl.kind ? DIAG_DUPLICATE_DECL : DIAG_CONFLICT_DECL, {
        kind: getDeclKindName(oldDecl.kind),
        loc: declPosn(newDecl),
        name,
      });
    } else {
      this.log.log(oldDecl.kind === DeclKind.Namespace ? DIAG_EXPLICIT_NAMESPACE_CONFLICT : DIAG_IMPLICIT_NAMESPACE_CONFLICT, {
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
