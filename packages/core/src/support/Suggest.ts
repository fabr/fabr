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

/**
 * The closest candidate to `input` by edit distance (case-insensitive), or
 * undefined when no candidate is plausibly a slip of it — the "did you mean?"
 * primitive behind unresolved-name diagnostics. The allowance scales with the
 * input (one edit per three characters, capped at three), so a short name only
 * matches a near-exact slip while a long one tolerates a few. Ties break to
 * the earliest candidate (declaration order).
 */
export function closestMatch(input: string, candidates: Iterable<string>): string | undefined {
  const target = input.toLowerCase();
  const limit = Math.min(3, Math.max(1, Math.floor(input.length / 3)));
  let best: string | undefined;
  let bestDistance = limit + 1;
  for (const candidate of candidates) {
    const distance = editDistance(target, candidate.toLowerCase(), bestDistance - 1);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** Levenshtein distance, capped: any true distance above `cap` reports as
 * `cap + 1` (with a cheap length-difference pre-check and an early exit when a
 * whole row exceeds the cap — the usual bounded-DP shape). */
function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) {
    return cap + 1;
  }
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      row.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > cap) {
      return cap + 1;
    }
    prev = row;
  }
  return prev[b.length];
}
