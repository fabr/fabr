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
  declPosn,
  getDeclKindName,
  IDefaultableDecl,
  INamedDecl,
  INamespaceDecl,
  IPropertyDecl,
  ITargetDecl,
  ITargetDefDecl,
} from "./AST";
import { NAME_COMPONENT_SEPARATOR } from "../core/Name";
import { Namespace } from "./Namespace";

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

interface NSBuilderNode {
  self?: INamedDecl;
  targetDefs: Map<string, ITargetDefDecl>;
  content: Map<string, NSBuilderNode | ITargetDecl | IPropertyDecl>;
  defaultContent: Map<string, IDefaultableDecl>;
}

function newBuilderNode(self?: INamedDecl): NSBuilderNode {
  return { self, content: new Map(), defaultContent: new Map(), targetDefs: new Map() };
}

export class NamespaceBuilder {
  private log: Log;
  private root: NSBuilderNode;

  constructor(log: Log) {
    this.log = log;
    this.root = newBuilderNode();
  }

  public addNamespaceDecl(decl: INamespaceDecl, root: NSBuilderNode = this.root): boolean {
    const nameParts = decl.name.split(NAME_COMPONENT_SEPARATOR);
    const simpleName = nameParts.pop()!;
    const parent = this.getNodeFor(root, nameParts, decl);
    if (parent) {
      let node: NSBuilderNode;
      const current = parent.content.get(simpleName);
      if (current) {
        if ("kind" in current) {
          this.conflictError(current, decl);
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
    const nameParts = decl.name.split(NAME_COMPONENT_SEPARATOR);
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
        const existing = parent.content.get(simpleName);
        if (existing) {
          this.conflictError(existing, decl);
        } else {
          parent.content.set(simpleName, decl);
          return true;
        }
      }
    }
    return false;
  }

  public addDefaultDecl(decl: IDefaultableDecl, root: NSBuilderNode = this.root): boolean {
    const nameParts = decl.name.split(NAME_COMPONENT_SEPARATOR);
    const simpleName = nameParts.pop()!;
    const parent = this.getNodeFor(root, nameParts, decl);
    if (parent) {
      const existing = parent.defaultContent.get(simpleName);
      if (existing) {
        this.conflictError(existing, decl);
      } else {
        parent.defaultContent.set(simpleName, decl);
        return true;
      }
    }
    return false;
  }

  public toNamespace(): Namespace {
    return this.buildNamespace(this.root);
  }

  private getNodeFor(root: NSBuilderNode, parts: string[], decl: INamedDecl): NSBuilderNode | undefined {
    let node = root;
    for (const part of parts) {
      const existing = node.content.get(part);
      if (existing) {
        if ("kind" in existing) {
          /* Is not a namespace but we needed one */
          this.conflictError(existing, decl);
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
      if ("kind" in child) {
        this.validateDecl(child);
      } else {
        this.resolve(child);
      }
    });
    /* Default properties/targets live apart from `content` but are validated the
     * same way (a `default X = …;` is a schema-less property like any global). */
    node.defaultContent.forEach(child => this.validateDecl(child));
    /* Targetdefs likewise live apart: each schema's own `default` values are
     * validated against the declared type here, so a malformed default fails
     * the load rather than the first resolution that takes it. */
    node.targetDefs.forEach(def => validateTargetDef(def, this.log));
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
    const content = new Map<string, Namespace | ITargetDecl | IPropertyDecl>();
    node.defaultContent.forEach((child, key) => {
      content.set(key, child);
    });
    node.content.forEach((child, key) => {
      content.set(key, "kind" in child ? child : this.buildNamespace(child));
    });
    const decl = node.self?.kind === DeclKind.Namespace ? node.self : undefined;
    return new Namespace(content, node.targetDefs, decl);
  }

  private conflictError(decl: INamedDecl | NSBuilderNode, newDecl: INamedDecl): void {
    const oldDecl = "kind" in decl ? decl : decl.self!;
    if (oldDecl.name === newDecl.name) {
      this.log.log(oldDecl.kind === newDecl.kind ? DIAG_DUPLICATE_DECL : DIAG_CONFLICT_DECL, {
        kind: getDeclKindName(oldDecl.kind),
        loc: declPosn(newDecl),
        name: newDecl.name,
      });
    } else {
      this.log.log(oldDecl.kind === DeclKind.Namespace ? DIAG_EXPLICIT_NAMESPACE_CONFLICT : DIAG_IMPLICIT_NAMESPACE_CONFLICT, {
        kind: getDeclKindName(newDecl.kind),
        loc: declPosn(newDecl),
        name: newDecl.name,
        other: oldDecl.name,
      });
    }
  }

  private unknownTargetDefError(decl: ITargetDecl): void {
    this.log.log(DIAG_UNKNOWN_TARGET_TYPE, { type: decl.type, loc: { ...decl.source, offset: decl.typeOffset } });
  }
}
