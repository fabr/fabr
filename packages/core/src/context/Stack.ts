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

import { INameValue, IPropertyDecl, ITargetDecl } from "../model/AST";
import { IUseSite } from "../model/Errors";

/** A written value being looked up: `value` in `property`, which is `target`'s
 * own property, or a global's where there is no `target`. */
export interface IUseFrame {
  target?: ITargetDecl;
  property: IPropertyDecl;
  value: INameValue;
  next?: IDependencyStack;
}

/** A target whose rule is being selected and evaluated: everything below it on
 * the stack is read on its behalf, whether or not through one of its own
 * properties (a global its rule reads, a key its rule is selected on). */
export interface IEvaluationFrame {
  evaluating: ITargetDecl;
  next?: IDependencyStack;
}

/**
 * The chain of demand that led to what is being looked up, nearest first: the
 * written values being looked up ({@link IUseFrame}) and the targets being
 * evaluated ({@link IEvaluationFrame}). Read to say who required what; a cycle
 * is found in the Computable graph, not here.
 */
export type IDependencyStack = IUseFrame | IEvaluationFrame;

function isEvaluation(frame: IDependencyStack): frame is IEvaluationFrame {
  return "evaluating" in frame;
}

/** Get the nearest use frame on the stack: the written value being looked up. */
export function useFrameOf(stack: IDependencyStack | undefined): IUseFrame | undefined {
  let node = stack;
  while (node && isEvaluation(node)) {
    node = node.next;
  }
  return node;
}

/** Get the target a frame puts on the stack, if any: the one being evaluated,
 * or the owner of the property being looked up. */
function targetOf(frame: IDependencyStack): ITargetDecl | undefined {
  return isEvaluation(frame) ? frame.evaluating : frame.target;
}

/** Get the use site of the nearest use frame on the stack, where there is one. */
export function useSiteOf(stack: IDependencyStack | undefined): IUseSite | undefined {
  const frame = useFrameOf(stack);
  return frame ? { value: frame.value, property: frame.property, target: frame.target } : undefined;
}

/**
 * Get the distinct targets on the dependency stack (nearest requester first,
 * `target` itself excluded): the chain of demand that led to `target` being
 * evaluated. Empty for a target requested directly.
 */
export function requestingTargets(target: ITargetDecl, stack?: IDependencyStack): ITargetDecl[] {
  const result: ITargetDecl[] = [];
  for (let node = stack; node; node = node.next) {
    const requester = targetOf(node);
    if (requester && requester !== target && !result.includes(requester)) {
      result.push(requester);
    }
  }
  return result;
}
