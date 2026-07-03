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

import { validateTarget } from "./Validate";
import { Diagnostic, ISourcePosition, Log } from "../support/Log";
import { DeclKind, declPosn, getDeclKindName, INamedDecl, INamespaceDecl, IPropertyDecl, ITargetDecl, ITargetDefDecl } from "./AST";
import { NAME_COMPONENT_SEPARATOR } from "./Name";
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
  targetDefs: Record<string, ITargetDefDecl>;
  content: Record<string, NSBuilderNode | ITargetDecl | IPropertyDecl>;
  defaultContent: Record<string, ITargetDecl | IPropertyDecl>;
}

function newBuilderNode(self?: INamedDecl): NSBuilderNode {
  return { self, content: {}, defaultContent: {}, targetDefs: {} };
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
      if (simpleName in parent.content) {
        const current = parent.content[simpleName];
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
        parent.content[simpleName] = node;
      }
      decl.namespaces.forEach(ns => this.addNamespaceDecl(ns, node));
      decl.properties.forEach(prop => this.addDecl(prop, node));
      decl.targets.forEach(target => this.addDecl(target, node));
      decl.defaults.forEach(prop => this.addDefaultDecl(prop, node));
      return true;
    }
    return false;
  }

  public addDecl(decl: ITargetDefDecl | ITargetDecl | IPropertyDecl, root: NSBuilderNode = this.root): boolean {
    const nameParts = decl.name.split(NAME_COMPONENT_SEPARATOR);
    const simpleName = nameParts.pop()!;
    const parent = this.getNodeFor(root, nameParts, decl);
    if (parent) {
      const content = decl.kind === DeclKind.TargetDef ? parent.targetDefs : parent.content;
      if (simpleName in content) {
        this.conflictError(content[simpleName], decl);
      } else {
        content[simpleName] = decl;
        return true;
      }
    }
    return false;
  }

  public addDefaultDecl(decl: ITargetDecl | IPropertyDecl, root: NSBuilderNode = this.root): boolean {
    const nameParts = decl.name.split(NAME_COMPONENT_SEPARATOR);
    const simpleName = nameParts.pop()!;
    const parent = this.getNodeFor(root, nameParts, decl);
    if (parent) {
      if (simpleName in parent.defaultContent) {
        this.conflictError(parent.defaultContent[simpleName], decl);
      } else {
        parent.defaultContent[simpleName] = decl;
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
      if (part in node.content) {
        const next = node.content[part];
        if ("kind" in next) {
          /* Is not a namespace but we needed one */
          this.conflictError(next, decl);
          return undefined;
        } else {
          node = next;
        }
      } else {
        const next = newBuilderNode(decl);
        node.content[part] = next;
        node = next;
      }
    }
    return node;
  }

  private resolveTargetDef(name: string): ITargetDefDecl | undefined {
    return this.root.targetDefs[name];
  }

  public resolve(node: NSBuilderNode = this.root): void {
    Object.values(node.content).forEach(child => {
      if ("kind" in child) {
        if (child.kind === DeclKind.Target) {
          const targetDef = this.resolveTargetDef(child.type);
          if (!targetDef) {
            this.unknownTargetDefError(child);
          } else {
            validateTarget(child, targetDef, this.log);
          }
        }
      } else {
        this.resolve(child);
      }
    });
  }

  private buildNamespace(node: NSBuilderNode): Namespace {
    const content: Record<string, Namespace | ITargetDecl | IPropertyDecl> = {};
    Object.entries(node.defaultContent).forEach(([key, child]) => {
      content[key] = child;
    });
    Object.entries(node.content).forEach(([key, child]) => {
      if ("kind" in child) {
        content[key] = child;
      } else {
        content[key] = this.buildNamespace(child);
      }
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
