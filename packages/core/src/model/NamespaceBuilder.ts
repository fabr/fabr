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
  IBuildFile,
  IBuildFileContents,
  declPosn,
  getDeclKindName,
  IResolvableDecl,
  INamedDecl,
  IPropertyDecl,
  ITargetDecl,
  ITargetDefDecl,
  propertyTypeName,
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
const DIAG_UNKNOWN_BASE = Diagnostic.Error<{ name: string; base: string; loc: ISourcePosition }>(
  "Targetdef '{name}' extends '{base}', which is not a targetdef"
);
const DIAG_INHERITANCE_CYCLE = Diagnostic.Error<{ name: string; loc: ISourcePosition }>("Targetdef '{name}' extends itself");
const DIAG_INCOMPATIBLE_PROPERTY = Diagnostic.Error<{ name: string; key: string; problem: string; loc: ISourcePosition }>(
  "Targetdef '{name}' redeclares the property '{key}' incompatibly: it {problem}"
);
const DIAG_UNKNOWN_TARGET_TYPE = Diagnostic.Error<{ type: string; loc: ISourcePosition }>("Unknown target type '{type}'");

/** Get the declaration to report a conflict with `entry` against: a
 *  property's first declaration, else the entry itself. */
function blameFor(entry: NamespaceEntry): INamedDecl | NamespaceNode {
  if (isNamespaceNode(entry)) {
    return entry;
  }
  return entry.kind === DeclKind.Property ? (entry.decls[0] ?? entry.defaults[0]) : entry;
}

/**
 * The builder of a model's namespace: it adds each file's declarations to the
 * public namespace or to the file's private one, reporting conflicts to the
 * log as it goes, and validates what it holds when asked.
 */
export class NamespaceBuilder {
  private log: Log;
  private root: NamespaceNode;
  /** Declarations superseded as they were added, validated with the rest by {@link validate}. */
  private superseded: IResolvableDecl[] = [];
  /** Each file's private declarations, by the file's name. */
  private readonly scopes = new Map<string, NamespaceNode>();

  constructor(log: Log) {
    this.log = log;
    this.root = newNamespaceNode();
  }

  /** Add an ordinary declaration under its name in `root`; returns false,
   *  having reported the conflict, where it could not be added. */
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
          parent.inheritedTargetDefs = undefined;
          this.root.inheritedTargetDefs = undefined;
          return true;
        }
      } else {
        return this.addResolvableDecl(parent, simpleName, decl, "decls");
      }
    }
    return false;
  }

  /** Add a `default` declaration under its name in `root`; returns false,
   *  having reported the conflict, where it could not be added. */
  public addDefaultDecl(decl: IResolvableDecl, root: NamespaceNode = this.root): boolean {
    const nameParts = declName(decl).split(NAME_COMPONENT_SEPARATOR);
    const simpleName = nameParts.pop()!;
    const parent = this.getNodeFor(root, nameParts, decl);
    return parent ? this.addResolvableDecl(parent, simpleName, decl, "defaults") : false;
  }

  /**
   * Add one target or property declaration under `simpleName` in `node`, in
   * `tier` (ordinary or `default`). Returns false, having reported the
   * conflict, where it is not added.
   *
   * - A property joins the entry of its name, in its tier; the key as written,
   *   guard included (`name.toString()`), must be unique within the tier. A
   *   property of a namespace's name is that namespace's fallback.
   * - An ordinary declaration supersedes a `default` one of the other kind: an
   *   ordinary target takes the name from a property with only `default`
   *   declarations, which are still validated; an ordinary property keeps a
   *   `default` target as its `fallbackTarget`.
   * - Two `default`s of one name conflict, whatever their kinds.
   * - Anything else (two targets, a target and an ordinary property, a target
   *   and a namespace) conflicts.
   */
  private addResolvableDecl(node: NamespaceNode, simpleName: string, decl: IResolvableDecl, tier: "decls" | "defaults"): boolean {
    const existing = node.content.get(simpleName);
    if (decl.kind === DeclKind.Target) {
      if (tier === "defaults") {
        /* Kept apart (see NamespaceNode.defaultTargets). It conflicts with a
         * namespace of its name and with another `default` of it. */
        const clash =
          node.defaultTargets.get(simpleName) ??
          (existing !== undefined &&
          (isNamespaceNode(existing) || (existing.kind === DeclKind.Property && existing.defaults.length > 0))
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
      if (
        existing !== undefined &&
        !(!isNamespaceNode(existing) && existing.kind === DeclKind.Property && existing.decls.length === 0)
      ) {
        this.conflictError(blameFor(existing), decl);
        return false;
      }
      if (existing !== undefined && !isNamespaceNode(existing) && existing.kind === DeclKind.Property) {
        /* Superseded, but still validated. */
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

  /** @return the public namespace, which reads what is added later too. */
  public toNamespace(): Namespace {
    return Namespace.of(this.root);
  }

  /**
   * Add the declarations of `file`: a public one to the namespace, a private
   * one to the namespace of that file's private names. A private declaration
   * of a name the file also declares publicly is the ordinary conflict.
   */
  public addFile(file: IBuildFileContents): void {
    const resolvable = [...file.properties, ...file.targets];
    file.properties.filter(prop => !prop.private).forEach(prop => this.addDecl(prop));
    file.defaults.forEach(decl => this.addDefaultDecl(decl));
    file.targetdefs.forEach(def => this.addDecl(def));
    file.targets.filter(target => !target.private).forEach(target => this.addDecl(target));
    const declared = new Map([...resolvable.filter(decl => !decl.private), ...file.defaults].map(decl => [declName(decl), decl]));
    for (const decl of resolvable.filter(decl => decl.private)) {
      const publicDecl = declared.get(declName(decl));
      if (publicDecl !== undefined) {
        this.conflictError(publicDecl, decl);
        continue;
      }
      const scope = this.scopes.get(decl.source.file) ?? newNamespaceNode();
      this.scopes.set(decl.source.file, scope);
      this.addDecl(decl, scope);
    }
  }

  /** @return the names of the files that declare `name` privately, in name order. */
  public getPrivateFiles(name: string): string[] {
    return [...this.scopes]
      .filter(([, scope]) => Namespace.of(scope).getDecl(name) !== undefined)
      .map(([file]) => file)
      .sort();
  }

  /** @return the namespace of the private names of the file named `file`, or undefined where it declares none. */
  public getScope(file: string): Namespace | undefined {
    const scope = this.scopes.get(file);
    return scope === undefined ? undefined : Namespace.of(scope);
  }

  /** Get the node for the namespace path `parts` under `root`, making the
   *  namespaces it lacks; undefined, having reported the conflict, where a
   *  part names something other than a namespace. */
  private getNodeFor(root: NamespaceNode, parts: string[], decl: INamedDecl): NamespaceNode | undefined {
    let node = root;
    for (const part of parts) {
      const existing = this.namespaceOf(node, part, decl);
      if (existing) {
        if (!isNamespaceNode(existing)) {
          /* Not a namespace, where one is needed. */
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

  /** Look up the targetdef `name` with what it inherits. */
  private resolveTargetDef(name: string): ITargetDefDecl | undefined {
    return Namespace.of(this.root).getTargetDef(name);
  }

  /**
   * Check that each targetdef extending another can: its base is declared, the
   * chain of bases does not lead back to it, and each property it redeclares
   * keeps the base's type and does not make a required property optional.
   */
  private validateInheritance(parsed: (decl: { source: IBuildFile }) => boolean): void {
    const namespace = Namespace.of(this.root);
    for (const def of this.root.targetDefs.values()) {
      if (def.extends === undefined || !parsed(def)) {
        continue;
      }
      const loc = { ...def.source, offset: def.extends.offset };
      const base = namespace.getTargetDef(def.extends.name);
      if (base === undefined) {
        this.log.log(DIAG_UNKNOWN_BASE, { name: def.name, base: def.extends.name, loc });
        continue;
      }
      if (namespace.getTargetDefChain(def.extends.name).some(ancestor => ancestor.name === def.name)) {
        this.log.log(DIAG_INHERITANCE_CYCLE, { name: def.name, loc });
        continue;
      }
      def.properties.forEach((own, key) => {
        const inherited = base.properties.get(key);
        if (inherited === undefined) {
          return;
        }
        const problem =
          own.type !== inherited.type
            ? `declares it ${propertyTypeName(own)}, where '${base.name}' declares it ${propertyTypeName(inherited)}`
            : inherited.required && !own.required
              ? `does not declare it REQUIRED, where '${base.name}' does`
              : undefined;
        if (problem !== undefined) {
          this.log.log(DIAG_INCOMPATIBLE_PROPERTY, { name: def.name, key, problem, loc: { ...def.source, offset: def.offset } });
        }
      });
    }
  }

  /** Validate every declaration added so far that `parsed` says came from a
   *  file that parsed, against the targetdefs added so far, reporting to the
   *  log. */
  public validate(parsed: (decl: { source: IBuildFile }) => boolean): void {
    this.validateInheritance(parsed);
    const validate = (decl: ITargetDefDecl | ITargetDecl | IPropertyDecl): void => {
      if (parsed(decl)) {
        this.validateDecl(decl);
      }
    };
    this.resolve(this.root, validate, parsed);
    this.scopes.forEach(scope => this.resolve(scope, validate, parsed));
    this.superseded.forEach(validate);
  }

  /** Call `validate` on every declaration under `node`, recursively, and
   *  validate each targetdef's schema. */
  private resolve(
    node: NamespaceNode,
    validate: (decl: ITargetDefDecl | ITargetDecl | IPropertyDecl) => void,
    parsed: (decl: { source: IBuildFile }) => boolean
  ): void {
    node.content.forEach(child => {
      if (isNamespaceNode(child)) {
        this.resolve(child, validate, parsed);
      } else if (child.kind === DeclKind.Property) {
        [...child.decls, ...child.defaults].forEach(validate);
      } else {
        validate(child);
      }
    });
    if (node.fallback !== undefined) {
      [...node.fallback.decls, ...node.fallback.defaults].forEach(validate);
    }
    /* Default targets are kept apart from `content`; validate each, whether
     * or not it answers for its name. */
    node.defaultTargets.forEach(validate);
    /* Validate each targetdef's own `default` values against their declared
     * types. */
    node.targetDefs.forEach(def => parsed(def) && validateTargetDef(def, this.log));
  }

  /** Validate one declaration: a target against its targetdef, a global
   *  property on its own. */
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

  /** Report `newDecl` as conflicting with `decl`: a duplicate or conflicting
   *  declaration of one name, or a conflict with an implicit namespace. */
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

  /** Report `decl`'s type as unknown. */
  private unknownTargetDefError(decl: ITargetDecl): void {
    this.log.log(DIAG_UNKNOWN_TARGET_TYPE, { type: decl.type, loc: { ...decl.source, offset: decl.typeOffset } });
  }
}
