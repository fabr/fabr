/*
 * Copyright (c) 2026 Nathan Keynes <nkeynes@deadcoderemoval.net>
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

import { IProvenanceStep, IRenderContext, registerProvenanceDescriber, registerProvenanceRenderer } from "../core/Provenance";
import { IDiagnosticNote } from "../support/Log";
import { declName, declPosn, INameValue, IPropertyDecl, ITargetDecl } from "./AST";
import { Constraints, shownConstraints } from "./Constraints";
import { ITargetOrigin, TARGET_PROVENANCE } from "./Target";

export const MODEL_PROVENANCE = "model";

/**
 * Provenance step for a FileSet that was included by writing a name in a
 * property value: the written value (with its source position), and the
 * constraint set it was looked up under. Steps chain along the data path, each
 * lookup wrapping what it finds, so a nested property expansion makes a chain
 * of several steps.
 */
export interface IModelStep extends IProvenanceStep {
  kind: typeof MODEL_PROVENANCE;
  value: INameValue;
  constraints: Constraints;
  /** The property the value was written in, and its owning target (absent for
   * a global/default property) — the "required by <target> <property>" facts */
  property: IPropertyDecl;
  target?: ITargetDecl;
  /** The `${...}` the written value substituted, with what each gave. */
  substitutions?: readonly ISubstitution[];
}

/** One `${NAME}` substituted into a written value: the text it gave, and the
 *  declaration that answered it (none for a value given as a constraint). */
export interface ISubstitution {
  name: string;
  value: string;
  origin?: IPropertyDecl;
}

registerProvenanceRenderer(MODEL_PROVENANCE, (step, context) => renderModelStep(step as IModelStep, context));
registerProvenanceRenderer(TARGET_PROVENANCE, step => {
  const target = (step as ITargetOrigin).decl;
  return [{ message: `built by ${target.type} '${target.name}'`, loc: declPosn(target) }];
});

/* Short attribution ("the name it was written as") for one-line messages */
registerProvenanceDescriber(MODEL_PROVENANCE, step => (step as IModelStep).value.value.toString());
registerProvenanceDescriber(TARGET_PROVENANCE, step => declName((step as ITargetOrigin).decl));

function renderModelStep(step: IModelStep, context: IRenderContext): IDiagnosticNote[] {
  const verb = context.stepIndex === 0 ? "from" : "via";
  return [
    {
      message: `${verb} '${step.value.value.toString()}' (${describeUseSite(step.property, step.target)})`,
      loc: declPosn(step.value),
      label: constraintText(step, context),
    },
    ...substitutionNotes(step),
  ];
}

/** Make a note for each `${NAME}` in a reference, at the declaration that gave
 *  its value. */
export function substitutionNotes(step: IModelStep): IDiagnosticNote[] {
  return (step.substitutions ?? []).flatMap(({ name, value, origin }) => {
    const values = origin?.values ?? [];
    return origin === undefined || values.length === 0
      ? []
      : [{ message: `${name} is '${value}'`, loc: { ...declPosn(values[0]), endOffset: values[values.length - 1].endOffset } }];
  });
}

/** Describe a use site as `<target> <property>`, or `<property>` for a global:
 * the attribution model step notes and the driver's dependant chain share. */
export function describeUseSite(property: IPropertyDecl, target: ITargetDecl | undefined): string {
  return target ? `${declName(target)} ${property.name.toBaseString()}` : property.name.toBaseString();
}

/**
 * Describe the constraint set a reference was looked up under, but only where
 * it is informative: the deepest model step shows its (non-empty) constraints,
 * other steps show only the entries that differ from the next model step
 * down the chain (i.e. override boundaries), and the caller's ambient keys
 * (context.elideConstraintKeys) are omitted throughout. Undefined when there
 * is nothing to say.
 */
export function constraintText(step: IModelStep, context: IRenderContext): string | undefined {
  const deeper = findNextModelStep(step.parent);
  const entries = shownConstraints(step.constraints, context.elideConstraintKeys ?? new Set()).filter(([key, value]) =>
    deeper ? deeper.constraints.get(key) !== value : true
  );
  if (entries.length === 0) {
    return undefined;
  }
  return `with ${entries.map(([key, value]) => `${key}=${value}`).sort().join(" ")}`;
}

function findNextModelStep(step: IProvenanceStep | undefined): IModelStep | undefined {
  for (let current = step; current; current = current.parent) {
    if (current.kind === MODEL_PROVENANCE) {
      return current as IModelStep;
    }
  }
  return undefined;
}
