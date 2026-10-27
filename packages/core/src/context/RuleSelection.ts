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

import { Computable } from "../core/Computable";
import { FabrError, toError } from "../core/Errors";
import { Name, NameConstraint } from "../core/Name";
import { IJudgedKey } from "../model/Errors";
import { parseName } from "../model/Parser";
import { Property } from "../model/Property";
import { SelectableRule } from "../rules/Types";
import type { IDependencyStack } from "./Stack";
import type { TargetContext } from "./TargetContext";

/** The outcome of selecting a rule for a target: the rule, if one applies, and
 * how each rule of the target's own type was judged. */
export interface IRuleSelection<R extends SelectableRule = SelectableRule> {
  rule: R | undefined;
  candidates: IJudgedKey[][];
}

/** Parse a rule's guard record into a guard, each pattern parsed. */
function guardOf(record: Record<string, string> | undefined): NameConstraint[] {
  return Object.entries(record ?? {}).map(([key, pattern]): NameConstraint => [key, rulePattern(pattern)]);
}

/** Parsed once per distinct pattern: a rule's guards are read on every
 * selection. */
const rulePatterns = new Map<string, Name>();
function rulePattern(written: string): Name {
  let pattern = rulePatterns.get(written);
  if (pattern === undefined) {
    pattern = parseName(written);
    rulePatterns.set(written, pattern);
  }
  return pattern;
}

/**
 * Pick the rule to select among those whose guards admit a target: the one naming
 * the most keys, over both of its guards, a rule naming none being the
 * wildcard. Undefined if `applicable` is empty; two equally specific rules are
 * an error. `ruleSet` names the candidates in that error.
 */
function mostSpecificRule<R extends SelectableRule>(applicable: R[], ruleSet: string): R | undefined {
  if (applicable.length === 0) {
    return undefined;
  }
  const specificity = (rule: R): number => guardOf(rule.properties).length + guardOf(rule.targetProperties).length;
  let best = applicable[0];
  let tiedAt: R | undefined;
  for (const rule of applicable.slice(1)) {
    if (specificity(rule) > specificity(best)) {
      best = rule;
      tiedAt = undefined;
    } else if (specificity(rule) === specificity(best)) {
      tiedAt = rule;
    }
  }
  if (tiedAt) {
    /* Two equally specific rules both apply, and neither is picked. */
    const show = (rule: R): string =>
      `{${[...guardOf(rule.properties), ...guardOf(rule.targetProperties)].map(([key, pattern]) => `${key}=${pattern.toString()}`).join(", ")}}`;
    throw new FabrError(`Ambiguous ${ruleSet} rule selection: ${show(best)} and ${show(tiedAt)} are equally specific`);
  }
  return best;
}

/** How a rule's guard on the configuration is read: a key's value there, and
 * whether a pattern matches a value. */
export interface IRuleGuards {
  /** Read the property `key`, undefined where it has no value. */
  read(key: string, stack?: IDependencyStack): Computable<Property | undefined>;
  admits(pattern: Name, value: Property, stack?: IDependencyStack): Computable<boolean>;
}

/**
 * Select the rule that builds `target`, a target of `type`, or undefined if
 * none applies. A rule applies where both its guards admit: its `properties`
 * judged against the configuration, its `targetProperties` against the
 * target's own. The most specific applicable rule is selected (see
 * {@link mostSpecificRule}), and `defaults` (the all-types rules) are consulted
 * only where none of `own` applies.
 *
 * A key with no value makes the rule inapplicable. A selection that fails is
 * the target's failure. How each of `own` was judged comes back with it, for
 * saying why none applied.
 */
export function selectRule<R extends SelectableRule>(
  own: R[],
  defaults: R[],
  type: string,
  target: TargetContext,
  guards: IRuleGuards
): Computable<IRuleSelection<R>> {
  const judge = (rules: R[]): Computable<IJudgedKey[][]> =>
    Computable.forAll(
      rules.map(rule => judgeRule(rule, target, guards)),
      (...judged: IJudgedKey[][]) => judged
    );
  const pick = (rules: R[], judged: IJudgedKey[][], ruleSet: string): R | undefined =>
    mostSpecificRule(
      rules.filter((_, i) => judged[i].every(key => key.matched)),
      ruleSet
    );
  try {
    return judge(own)
      .then(candidates => {
        const rule = pick(own, candidates, `'${type}'`);
        return rule ? { rule, candidates } : judge(defaults).then(judged => ({ rule: pick(defaults, judged, "default"), candidates }));
      })
      .catch(err => {
        throw target.failure(err);
      });
  } catch (err) {
    /* A read that throws as it is made rather than rejecting (an unknown
     * property). */
    return Computable.reject(target.failure(toError(err)));
  }
}

/** Judge each key of `rule`'s guards for `target`: the rule applies where
 * every one matched. A key with no value does not match. */
function judgeRule(rule: SelectableRule, target: TargetContext, guards: IRuleGuards): Computable<IJudgedKey[]> {
  const stack = target.stack;
  const judge = (key: string, own: boolean, pattern: Name, value: Property | undefined): Computable<IJudgedKey> =>
    (value === undefined ? Computable.resolve(false) : guards.admits(pattern, value, stack)).then(matched => ({
      key,
      own,
      pattern: pattern.toString(),
      value: value?.toString(),
      matched,
    }));
  return Computable.forAll(
    [
      ...guardOf(rule.properties).map(([key, pattern]) => guards.read(key, stack).then(value => judge(key, false, pattern, value))),
      ...guardOf(rule.targetProperties).map(([key, pattern]) => target.getProperty(key).then(value => judge(key, true, pattern, value))),
    ],
    (...judged: IJudgedKey[]) => judged
  );
}
