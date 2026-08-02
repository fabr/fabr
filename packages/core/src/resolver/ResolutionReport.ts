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
 * Reporting a failed (or refused) resolution, and computing its repair —
 * ecosystem-generic, beside {@link ResolutionProvenance} in the "explain a
 * resolution" family. A repository contributes two things: how a reference is
 * WRITTEN in its grammar ({@link RefRenderer} — a suggestion must be
 * pasteable), and how to reach its registry ({@link SuggestSources} — the
 * version list, and a memoized re-resolve for verification). Everything else
 * — conflict grouping, both-sides provenance, the sanction suggestions, and
 * the one-pass complete-repair fixpoint — is shared.
 */

import { Computable } from "../core/Computable";
import { attachHelp, ResolutionWalkError } from "../core/Errors";
import { nodeId, resolutionExplainer, ResolutionExplainer } from "./ResolutionGraph";
import { canonicalRequirements } from "./Overrides";
import { IResolutionError, MVSResolution, Requirement, ROOT_REQUIRER, Selected, VersionDomain, Violation } from "./Types";

/** Render a reference as the repository's users write it — `@npm:pkg:1.4.2?`
 * — so a suggestion pastes verbatim into a deps list. */
export type RefRenderer = (pkg: string, versionText: string, marker?: "?" | "!") => string;

/** The subset of a resolution the reporting and suggestion machinery reads —
 * satisfied by {@link MVSResolution} and by a repository's deserialized doc. */
export type ResolvedTree<V> = Pick<MVSResolution<V>, "selections" | "violations" | "requirements">;

/** What the suggester needs from the repository: the domain, the written
 * reference form, the registry's (mutable, failure-path-only) version list,
 * and a memoized re-resolve that rejects with {@link ResolutionWalkError} on
 * hard errors and applies NO reporting of its own. `resolve` always receives
 * roots in canonical ({@link requirementKey}-sorted) order — an implementation
 * keying a memo by them can join them as given. */
export interface SuggestSources<V, C> {
  domain: VersionDomain<V, C>;
  refText: RefRenderer;
  availableVersions(pkg: string): Computable<V[] | undefined>;
  resolve(roots: Requirement[]): Computable<ResolvedTree<V>>;
}

/**
 * Violations collapsed to one entry per *conflict* — the (pkg, constraint,
 * selected) triple: a widely-declared requirement (tslib '^1.11.1' across a
 * dozen @aws-* siblings) violates once per requirer, but the conflict, its
 * "selected by" side, and its remedy are identical for all of them — a dozen
 * near-identical stanzas bury the second distinct conflict. The first
 * requirer (walk order — canonical) keeps the full detail; the rest are
 * summarised by name on one line.
 */
export function groupViolations<V>(
  violations: readonly Violation<V>[],
  versionToString: (version: V) => string
): Array<{ first: Violation<V>; others: string[] }> {
  const groups = new Map<string, { first: Violation<V>; others: string[] }>();
  for (const violation of violations) {
    const key = `${violation.pkg}\n${violation.constraint}\n${versionToString(violation.selected)}`;
    const group = groups.get(key);
    if (group) {
      group.others.push(violation.requiredBy);
    } else {
      groups.set(key, { first: violation, others: [] });
    }
  }
  return [...groups.values()];
}

/** The one-line summary of a conflict's further requirers: the first few by
 * name, the rest by count. */
function alsoRequiredBy(constraint: string, others: readonly string[]): string[] {
  if (others.length === 0) {
    return [];
  }
  const shown = others.slice(0, 4);
  const more = others.length - shown.length;
  return [`  '${constraint}' also required by: ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`];
}

/**
 * The two questions a violation raises beyond the fact of it: which
 * requirement pushed the package to the version that violates the bound (and
 * where *that* requirer came from), and where the losing requirement itself
 * came from. Rendered as detail lines under the violation, indented one level;
 * empty for a resolution carrying no provenance edges (persisted before they
 * existed) or a requirer since superseded out of the selections.
 */
function explainViolation<V>(
  violation: Violation<V>,
  explainer: ResolutionExplainer<V>,
  versionToString: (version: V) => string
): string[] {
  const { find, pathTo } = explainer;
  const selection = find(`${violation.pkg}@${versionToString(violation.selected)}`);
  const selected = versionToString(violation.selected);
  const lines = selection?.selectedBy ? [`  ${selected} selected by: ${winnerOf(selection, selection.selectedBy, explainer)}`] : [];
  /* Only where there is a path to add: the requirer is already named on the
   * violation line, so repeating it alone would say nothing. */
  const requirer = violation.requiredBy === ROOT_REQUIRER ? undefined : find(violation.requiredBy);
  if (requirer !== undefined) {
    lines.push(`  '${violation.constraint}' required via: ${pathTo(requirer).join(" -> ")}`);
  }
  return lines;
}

/** The requirement whose floor won `selection` its version, as the path from a
 * root down to it. */
function winnerOf<V>(
  selection: Selected<V>,
  winner: { requiredBy: string; constraint: string },
  explainer: ResolutionExplainer<V>
): string {
  if (winner.requiredBy === ROOT_REQUIRER) {
    return `the requested '${winner.constraint}'`;
  }
  const winnerNode = explainer.find(winner.requiredBy);
  if (!winnerNode) {
    /* The winning requirement was declared by a version itself since superseded */
    return `${winner.requiredBy} requiring '${winner.constraint}' (since superseded)`;
  }
  const chosen = `${explainer.id(selection)} (${winner.constraint})`;
  return [...explainer.pathTo(winnerNode), chosen].join(" -> ");
}

/** Where each coexisting version of a package was required from — the same
 * question a violation raises, asked of every version rather than one. */
function explainDuplicate<V>(
  pkg: string,
  versions: readonly V[],
  explainer: ResolutionExplainer<V>,
  versionToString: (version: V) => string
): string[] {
  return versions.flatMap(version => {
    const selection = explainer.find(`${pkg}@${versionToString(version)}`);
    const via = selection?.reachedVia;
    if (selection === undefined || via === undefined) {
      return [];
    }
    return via.requiredBy === ROOT_REQUIRER
      ? [`  ${versionToString(version)} required directly ('${via.constraint}')`]
      : [`  ${versionToString(version)} required via: ${explainer.pathTo(selection).join(" -> ")}`];
  });
}

/**
 * The strict (linked) delivery's judgment of a repaired closure: every repair
 * reachable from the requested roots, reported together — violations and
 * coexisting versions as the structural facts they are — rather than one
 * build-fail-pin iteration each. (Floor raises are deliberately NOT judged: a
 * raised floor is the constraint's plain meaning when its literal minimum was
 * never published, acceptable in every delivery mode.)
 *
 * `selections` is the delivered closure, read for the provenance edges that
 * explain each repair; `written` (the user's `?`/pin set, when any exists for
 * a violated package) drives the partial-sanction set-mismatch note; the
 * suggester's pasteable repair set arrives pre-rendered as `suggestion` and
 * becomes the help.
 */
export function conflictError<V>(
  root: string,
  violations: Violation<V>[],
  duplicates: Array<[string, V[]]>,
  selections: readonly Selected<V>[],
  versionToString: (version: V) => string,
  refText: RefRenderer,
  written?: ReadonlyMap<string, ReadonlySet<string>>,
  suggestion?: string[]
): Error {
  const explainer = resolutionExplainer(selections, versionToString);
  const lines: string[] = [];
  const violatedPkgs = new Set(violations.map(violation => violation.pkg));
  const sanctionNoted = new Set<string>();
  for (const { first, others } of groupViolations(violations, versionToString)) {
    const moreRequirers = others.length > 0 ? ` (and ${others.length} more)` : "";
    lines.push(
      `${first.pkg}@${versionToString(first.selected)} does not satisfy '${first.constraint}' ` +
        `required by ${first.requiredBy}${moreRequirers}`,
      ...explainViolation(first, explainer, versionToString),
      ...alsoRequiredBy(first.constraint, others)
    );
    /* A partial sanction is a set mismatch, called out where the conflict is
     * reported: the versions this delivery needs vs the versions written. */
    const declared = written?.get(first.pkg);
    if (declared && declared.size > 0 && !sanctionNoted.has(first.pkg)) {
      sanctionNoted.add(first.pkg);
      const shipped = selections.filter(sel => sel.pkg === first.pkg).map(sel => versionToString(sel.version));
      const missing = shipped.filter(version => !declared.has(version));
      if (missing.length > 0) {
        lines.push(
          `  required ${first.pkg} versions: ${shipped.join(", ")} — allowed: ${[...declared].join(", ")}; ` +
            `add ${missing.map(version => refText(first.pkg, version, "?")).join(", ")}`
        );
      }
    }
  }
  /* A coexisting-versions entry restates a violation on the same package (a
   * fork exists exactly because an edge violated), so only packages with no
   * violation entry report here — a safety net for a multiplicity nothing
   * above explained, not the normal path. */
  for (const [pkg, versions] of duplicates.filter(([pkg]) => !violatedPkgs.has(pkg))) {
    lines.push(
      `requires multiple versions of ${pkg} (${versions.map(versionToString).join(", ")}), ` +
        `which the flat package layout cannot represent`,
      ...explainDuplicate(pkg, versions, explainer, versionToString)
    );
  }
  /* The help IS the remedy: the suggester's pasteable override set when it
   * produced one, else the generic statement of the two fixes. */
  const help =
    suggestion !== undefined && suggestion.length > 0
      ? suggestion
      : ["pin a single version satisfying every requirement, or write '?' overrides naming each version to ship"];
  return attachHelp(new Error(`Unable to resolve ${root}:\n  ${lines.join("\n  ")}`), help);
}

/**
 * The every-mode failure for violated edges the resolver could not repair: no
 * published version of the package satisfies the constraint, so no delivery —
 * flat or nested — can honor it. Reported with the same provenance detail as
 * the strict judgment; coercion (`!`) is this failure's designed remedy, if
 * the user judges the constraint bogus, and is suggested as such.
 */
export function unrepairableError<V>(
  root: string,
  violations: Violation<V>[],
  selections: readonly Selected<V>[],
  versionToString: (version: V) => string,
  refText: RefRenderer
): Error {
  const explainer = resolutionExplainer(selections, versionToString);
  const groups = groupViolations(violations, versionToString);
  const lines = groups.flatMap(({ first, others }) => [
    `no published version of ${first.pkg} satisfies '${first.constraint}' required by ${first.requiredBy}`,
    ...explainViolation(first, explainer, versionToString),
    ...alsoRequiredBy(first.constraint, others),
  ]);
  const forceLines = [...new Map(groups.map(({ first }) => [first.pkg, first])).values()].map(violation =>
    refText(violation.pkg, versionToString(violation.selected), "!")
  );
  const help = [
    "correct the requirement, or pin its requirer to a version whose requirement is satisfiable",
    `if the constraint is wrong (an over-tight pin), force the delivered version — '!' overrides every requirement on the package: ${forceLines.join(" ")}`,
  ];
  return attachHelp(new Error(`Unable to resolve ${root}:\n  ${lines.join("\n  ")}`), help);
}

/** The latest suggestion-eligible version, per the domain's stability rule. */
function latestStable<V, C>(sources: SuggestSources<V, C>, pkg: string): Computable<V | undefined> {
  const { domain } = sources;
  return sources.availableVersions(pkg).then(
    versions =>
      versions
        ?.filter(version => domain.isStable?.(version) ?? true)
        .sort((a, b) => domain.compare(a, b))
        .at(-1),
    () => undefined
  );
}

/** One suggestion line per package: its permitted versions as written `?`
 * references (already-written versions omitted — the line completes the set,
 * it does not restate it). */
function sanctionLine<V, C>(
  sources: SuggestSources<V, C>,
  selections: readonly Selected<V>[],
  written: (pkg: string) => ReadonlySet<string>,
  pkg: string
): string[] {
  const { domain } = sources;
  const principal = selections.find(sel => sel.pkg === pkg && sel.fork === undefined);
  const forks = selections.filter(sel => sel.pkg === pkg && sel.fork !== undefined);
  /* Principal optional: a package can survive as forks alone (its pool winner
   * was a pruned phantom and several forks remain). */
  if (forks.length === 0) {
    return [];
  }
  const already = written(pkg);
  const entries = [...(principal ? [principal] : []), ...forks]
    .map(sel => domain.versionToString(sel.version))
    .filter(version => !already.has(version))
    .map(version => sources.refText(pkg, version, "?"));
  return entries.length > 0 ? [entries.join(" ")] : [];
}

/** Shape suggested entries as `help:` lines: one compact line for a single
 * entry, else one multi-line block entry (the `help:` prefix lands only on
 * its lead line, so the group copies cleanly), commentary separate. */
function asHelp(entries: string[]): string[] {
  if (entries.length === 0) {
    return [];
  }
  const preamble = "add to the failing deps (or a shared catalog)";
  const explainer = entries.some(entry => entry.includes("?"))
    ? ["('?' allows a version to ship; the extra versions nest where required — they are not dependencies)"]
    : [];
  return entries.length === 1
    ? [`${preamble}: ${entries[0]}`, ...explainer]
    : [`${preamble}:\n${entries.map(entry => `  ${entry}`).join("\n")}`, ...explainer];
}

/**
 * Failure-time fix suggestions for the strict gate: a **verified working
 * set** of override lines the user can paste. Per conflicted package, in
 * order of preference: a **single-version pin** where one exists — a
 * published version at or above the principal satisfying every in-scope
 * constraint (only reachable for disjunctive ranges: for convex ranges the
 * violation is the proof no such version exists) — verified by one
 * re-resolution with the candidate pins added; otherwise the **`?` sanction
 * lines matching the resolution's actual forks**, correct by construction
 * since the forks demonstrably repair every violated edge. If the
 * verification resolution still shows conflicts, every pin is demoted to its
 * sanction lines — the always-safe suggestion. Runs only on the failure path;
 * degrades to the sanction lines when the registry is unreachable.
 */
export function suggestSanctions<V, C>(
  outstanding: readonly Violation<V>[],
  tree: ResolvedTree<V>,
  needed: readonly Selected<V>[],
  demanded: readonly Requirement[],
  sources: SuggestSources<V, C>
): Computable<string[]> {
  const { domain } = sources;
  const conflicted = [...new Set(outstanding.map(violation => violation.pkg))];
  /* Every constraint in scope on the package: the root demands plus each
   * delivered node's declared edges (a pin must satisfy the already-happy
   * requirers too). */
  const constraintsOn = (pkg: string): C[] => {
    /* Override requirements are permissions/substitutions, not constraints a
     * pin must satisfy. */
    const texts = new Set(demanded.filter(req => req.pkg === pkg && req.override === undefined).map(req => req.constraint));
    for (const sel of needed) {
      for (const req of tree.requirements.get(nodeId(domain, sel.pkg, sel.version)) ?? []) {
        if (req.pkg === pkg) {
          texts.add(req.constraint);
        }
      }
    }
    const parsed: C[] = [];
    for (const text of texts) {
      try {
        parsed.push(domain.parseConstraint(text));
      } catch {
        /* unparseable constraints are hard errors elsewhere */
      }
    }
    return parsed;
  };
  /* '?' sanctions only — resolution-pure: a sanction is no dependency (no
   * floor, no mount), so pasting it into a deps list adds nothing to the
   * consumer's dependency surface. The whole coexisting set must be written,
   * so the line completes it against what is already there. */
  const written = (pkg: string): ReadonlySet<string> => {
    const versions = new Set<string>();
    for (const req of demanded) {
      if (req.pkg === pkg && (req.override === "alternate" || domain.exactVersion?.(req.constraint) !== undefined)) {
        versions.add(req.constraint);
      }
    }
    return versions;
  };
  const sanctionsOnly = (): string[] => asHelp(conflicted.flatMap(pkg => sanctionLine(sources, tree.selections, written, pkg)));
  const singleFix = (pkg: string): Computable<V | undefined> => {
    const constraints = constraintsOn(pkg);
    const principal = tree.selections.find(sel => sel.pkg === pkg && sel.fork === undefined);
    return sources.availableVersions(pkg).then(
      versions => {
        if (!versions || !principal) {
          return undefined;
        }
        return versions
          .filter(version => domain.compare(version, principal.version) >= 0 && constraints.every(c => domain.satisfies(version, c)))
          .sort((a, b) => domain.compare(a, b))[0];
      },
      () => undefined
    );
  };
  return Computable.forAll(conflicted.map(singleFix), (...fixes: Array<V | undefined>) => {
    const pins = conflicted.flatMap((pkg, index) => {
      const fix = fixes[index];
      return fix !== undefined ? [{ pkg, version: fix }] : [];
    });
    if (pins.length === 0) {
      return Computable.resolve(sanctionsOnly());
    }
    /* Verify the pins by one re-resolution (a pin is just a root floor). Any
     * remaining conflict demotes the whole set to the construction-verified
     * sanction lines rather than presenting an unverified promise. */
    const pinReqs: Requirement[] = pins.map(pin => ({ pkg: pin.pkg, constraint: domain.versionToString(pin.version) }));
    return sources.resolve(canonicalRequirements([...demanded, ...pinReqs]).roots).then(
      verify => {
        if (verify.violations.length > 0) {
          return sanctionsOnly();
        }
        const pinLines = pins.map(
          pin => `${sources.refText(pin.pkg, domain.versionToString(pin.version))} (satisfies every requirement on ${pin.pkg})`
        );
        const sanctionLines = conflicted
          .filter(pkg => !pins.some(pin => pin.pkg === pkg))
          .flatMap(pkg => sanctionLine(sources, tree.selections, written, pkg));
        return asHelp([...pinLines, ...sanctionLines]);
      },
      () => sanctionsOnly()
    );
  });
}

/**
 * Group and enrich a walk's hard errors into ONE combined failure carrying
 * the COMPLETE repair set, computed in one pass: supply the latest stable for
 * each floorless-only package, RE-RESOLVE with those as `?` alternates
 * (attach-last — exactly what the user will paste), iterate while the
 * completion surfaces further floorless packages, then fold the completed
 * resolution's divergence sanctions (principal + forks per conflicted
 * package) into the same list — so one paste resolves, rather than a second
 * round of errors. Non-repairable failures (unparseable constraints) stay
 * separate. All registry reads are failure-path only; on any misstep the
 * loop degrades to what it has.
 */
export function completeRepairSet<V, C>(
  errors: IResolutionError[],
  roots: Requirement[],
  sources: SuggestSources<V, C>
): Computable<IResolutionError[]> {
  const { domain } = sources;
  const others = errors.filter(error => error.pkg === undefined);
  if (errors.length === others.length) {
    return Computable.resolve(others);
  }
  const supplies = new Map<string, V>();
  const requirersOf = new Map<string, Set<string>>();
  const recordFloorless = (failures: ReadonlyArray<{ pkg?: string; requiredBy?: string }>): string[] => {
    const fresh: string[] = [];
    for (const failure of failures) {
      if (failure.pkg === undefined) {
        continue;
      }
      const requirers = requirersOf.get(failure.pkg) ?? new Set();
      requirersOf.set(failure.pkg, requirers.add(failure.requiredBy ?? "a requirement"));
      if (!supplies.has(failure.pkg) && !fresh.includes(failure.pkg)) {
        fresh.push(failure.pkg);
      }
    }
    return fresh;
  };
  const supply = (fresh: string[], round: number): Computable<ResolvedTree<V> | undefined> =>
    Computable.forAll(
      fresh.map(pkg => latestStable(sources, pkg)),
      (...latest: Array<V | undefined>) => {
        fresh.forEach((pkg, index) => {
          const version = latest[index];
          if (version !== undefined) {
            supplies.set(pkg, version);
          }
        });
        if (latest.every(version => version === undefined)) {
          return Computable.resolve<ResolvedTree<V> | undefined>(undefined);
        }
        const supplyReqs: Requirement[] = [...supplies].map(([pkg, version]) => ({
          pkg,
          constraint: domain.versionToString(version),
          override: "alternate",
        }));
        return sources.resolve(canonicalRequirements([...roots, ...supplyReqs]).roots).then(
          resolved => resolved,
          err => {
            if (err instanceof ResolutionWalkError && round < 4) {
              const next = recordFloorless(err.failures);
              if (next.length > 0) {
                return supply(next, round + 1);
              }
            }
            return undefined;
          }
        );
      }
    );
  return supply(recordFloorless(errors), 0).then(completed => {
    /* One suggestion line per package: its supplied version and/or the
     * divergent set (principal + forks) the completed resolution ships. */
    const suggest = new Map<string, Set<string>>();
    for (const [pkg, version] of supplies) {
      suggest.set(pkg, new Set([domain.versionToString(version)]));
    }
    const conflicts = new Set<string>();
    if (completed !== undefined) {
      for (const violation of completed.violations) {
        conflicts.add(violation.pkg);
        const versions = suggest.get(violation.pkg) ?? new Set();
        for (const sel of completed.selections.filter(sel => sel.pkg === violation.pkg)) {
          versions.add(domain.versionToString(sel.version));
        }
        suggest.set(violation.pkg, versions);
      }
    }
    const detailLines = [...requirersOf.keys()].sort().map(pkg => {
      const requirers = [...requirersOf.get(pkg)!].sort();
      const shown = requirers.slice(0, 3);
      const more = requirers.length - shown.length;
      return `  '${pkg}' — required by ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`;
    });
    /* The forecast conflicts are stated, not just counted — the grouped
     * one-line form (the full provenance stanzas belong to the dedicated
     * conflict error, when one is hit directly). */
    const conflictNote =
      completed !== undefined && conflicts.size > 0
        ? [
            `completing the resolution with those versions also hits ${conflicts.size} version conflict(s), sanctioned by the list below:`,
            ...groupViolations(completed.violations, domain.versionToString).map(({ first, others }) => {
              const more = others.length > 0 ? ` (and ${others.length} more)` : "";
              return `  ${first.pkg}@${domain.versionToString(first.selected)} does not satisfy '${first.constraint}' required by ${first.requiredBy}${more}`;
            }),
          ]
        : [];
    const entries = [...suggest.keys()]
      .sort()
      .map(pkg => [...suggest.get(pkg)!].map(version => sources.refText(pkg, version, "?")).join(" "));
    /* ONE help entry for the pasteable block (the `help:` prefix lands only
     * on its lead line, so the group copies cleanly), commentary separate. */
    const help =
      entries.length > 0
        ? [
            `add to the failing deps (or a shared catalog):\n${entries.map(entry => `  ${entry}`).join("\n")}`,
            "(each '?' names a version allowed to resolve and ship — none is a direct dependency)",
          ]
        : undefined;
    const combined: IResolutionError = {
      message:
        `the following packages are required only without a version lower bound ('*'), ` +
        `so no version is selectable — name one explicitly:\n${[...detailLines, ...conflictNote].join("\n")}`,
      rootPkg: errors.find(error => error.pkg !== undefined)!.rootPkg,
      help,
    };
    return [combined, ...others];
  });
}
