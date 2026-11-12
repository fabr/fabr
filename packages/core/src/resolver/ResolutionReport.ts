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
 * The errors for a failed or refused resolution, and the repairs they
 * suggest, for any ecosystem. A repository supplies how a reference is written
 * in its grammar ({@link RefRenderer}, so a suggestion can be pasted) and how
 * to reach its registry ({@link SuggestSources}). A sanction, throughout, is a
 * `?` reference naming a version allowed to ship.
 */

import { Computable } from "../core/Computable";
import { FabrError, ResolutionWalkError } from "../core/Errors";
import { nodeId, nodeLabel, ResolutionExplainer, MVSResolution } from "./MVSResolution";
import { canonicalRequirements, isBuildVersion, requiredAs, versionConstraintText, versionText } from "./Requirement";
import {
  IRequirementEdge,
  IResolutionError,
  PackageIdentity,
  ROOT_REQUIRER,
  Requirement,
  Selected,
  VersionDomain,
  Violation,
} from "./Types";

/** Render a reference to a package as the repository's users write it
 * (`@npm:pkg:1.4.2?`, `@npm:pkg:1.4.2 -> name`), to be pasted into a deps
 * list. */
export type RefRenderer = (pkg: PackageIdentity, versionText: string, marker?: "?" | "!") => string;

/**
 * Describe a root requirement of the resolution that the consumer did not
 * write — a pin — as "pinned by …", or undefined where the requirement is the
 * consumer's own.
 */
export type RootRenderer = (name: string, versionConstraint: string | undefined) => string | undefined;

/** Make a requirement on `pkg` at exactly `version`. */
function requirementAt(pkg: PackageIdentity, version: string): Requirement {
  return pkg.publishedName === undefined
    ? { name: pkg.name, versionConstraint: version }
    : { name: pkg.publishedName, versionConstraint: version, renameTo: pkg.name };
}

/** Find the selected package named `name` among `selections`, by name alone
 * where none is selected. */
function identityOf<V>(selections: readonly Selected<V>[], name: string): PackageIdentity {
  return selections.find(sel => sel.name === name) ?? { name };
}

/** The parts of a resolution the suggestions read (an {@link MVSResolution}
 * is one). */
export type ResolvedTree<V> = Pick<MVSResolution<V>, "selections" | "violations" | "requirements">;

/** The repository's side of the suggestions: its version domain, how it
 * writes a reference, the registry's published versions of a package, and a
 * memoized resolve. `resolve` rejects with {@link ResolutionWalkError} where
 * the walk reports errors, and reports nothing of its own; it is always given
 * roots in canonical (`requirementKey`-sorted) order, so a memo may key on
 * them as given. */
export interface SuggestSources<V, C> {
  domain: VersionDomain<V, C>;
  refText: RefRenderer;
  availableVersions(pkg: PackageIdentity): Computable<V[] | undefined>;
  resolve(roots: Requirement[]): Computable<ResolvedTree<V>>;
}

/**
 * Group violations by package, constraint and selected version, in the order
 * given: each group's `first` violation is reported in full, and `others`
 * names the requirers of the rest. (tslib '^1.11.1' required by a dozen
 * @aws-* packages is one group.)
 */
export function groupViolations<V>(
  violations: readonly Violation<V>[],
  versionToString: (version: V) => string
): Array<{ first: Violation<V>; others: string[] }> {
  const groups = new Map<string, { first: Violation<V>; others: string[] }>();
  for (const violation of violations) {
    const key = `${violation.name}\n${violation.versionConstraint}\n${versionToString(violation.selected)}`;
    const group = groups.get(key);
    if (group) {
      group.others.push(violation.requiredBy);
    } else {
      groups.set(key, { first: violation, others: [] });
    }
  }
  return [...groups.values()];
}

/** Summarise a conflict's further requirers on one line: the first few by
 * name, the rest by count. */
function alsoRequiredBy(name: string, constraint: string, others: readonly string[]): string[] {
  if (others.length === 0) {
    return [];
  }
  const shown = others.slice(0, 4).map(nodeLabel);
  const more = others.length - shown.length;
  return [`  ${versionConstraintText(constraint, name)} also required by: ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`];
}

/**
 * Explain a violation as detail lines, indented one level: the chain of the
 * requirement that selected the violating version, where the resolution
 * records one, and the chain the violated requirement's requirer is reached
 * by, where the requirer is a package among the selections. Either line is
 * left out where its chain is unknown.
 */
function explainViolation<V>(
  violation: Violation<V>,
  explainer: ResolutionExplainer<V>,
  versionToString: (version: V) => string
): string[] {
  const { find, pathTo } = explainer;
  const selection = find(`${violation.name}@${versionToString(violation.selected)}`);
  const selected = versionText(versionToString(violation.selected), violation.name);
  const lines = selection?.selectedBy ? [`  ${selected} selected by: ${winnerOf(selection, selection.selectedBy, explainer)}`] : [];
  /* Only where there is a chain: the violation line already names the
   * requirer. */
  const requirer = violation.requiredBy === ROOT_REQUIRER ? undefined : find(violation.requiredBy);
  if (requirer !== undefined) {
    lines.push(
      `  ${versionConstraintText(violation.versionConstraint, violation.name)} required via: ${pathTo(requirer).join(" -> ")}`
    );
  }
  return lines;
}

/**
 * Write a violation as two requirements on one package that no one version
 * meets, the violated one and the one that selected the version, each with
 * the chain it was reached by. Where the resolution does not record what
 * selected the version, write that the selected version does not satisfy the
 * violated requirement, with {@link explainViolation}'s detail.
 */
function conflictLines<V>(
  violation: Violation<V>,
  moreRequirers: string,
  explainer: ResolutionExplainer<V>,
  versionToString: (version: V) => string,
  rootText?: RootRenderer
): string[] {
  const { find, pathTo } = explainer;
  const selected = versionToString(violation.selected);
  const winner = find(`${violation.name}@${selected}`)?.selectedBy;
  if (winner === undefined) {
    return [
      `${nodeLabel(`${violation.name}@${selected}`)} does not satisfy ${versionConstraintText(violation.versionConstraint, violation.name)} required by ${nodeLabel(violation.requiredBy)}${moreRequirers}`,
      ...explainViolation(violation, explainer, versionToString),
    ];
  }
  const via = (edge: { requiredBy: string; versionConstraint: string | undefined }): string => {
    if (edge.requiredBy === ROOT_REQUIRER) {
      return rootText?.(violation.name, edge.versionConstraint) ?? "required directly";
    }
    const requirer = find(edge.requiredBy);
    return `required via: ${requirer === undefined ? nodeLabel(edge.requiredBy) : pathTo(requirer).join(" -> ")}`;
  };
  const violated = versionConstraintText(violation.versionConstraint, violation.name);
  const winning = versionConstraintText(winner.versionConstraint, violation.name);
  return [
    `${violation.name} is required as ${violated} and as ${winning}, and no one version is both`,
    `  ${violated} ${via(violation)}${moreRequirers}`,
    `  ${winning} ${via(winner)}`,
  ];
}

/** Trace `winner`, the requirement that selected `selection`'s version, as the
 * chain from a root down to it. */
function winnerOf<V>(selection: Selected<V>, winner: IRequirementEdge, explainer: ResolutionExplainer<V>): string {
  if (winner.requiredBy === ROOT_REQUIRER) {
    return `the requested ${versionConstraintText(winner.versionConstraint, selection.name)}`;
  }
  const winnerNode = explainer.find(winner.requiredBy);
  if (!winnerNode) {
    /* Declared by a version since displaced by a higher one */
    return `${nodeLabel(winner.requiredBy)} requiring ${versionConstraintText(winner.versionConstraint, selection.name)} (since superseded)`;
  }
  const chosen = `${nodeLabel(explainer.id(selection))} (${winner.versionConstraint === undefined ? "any version" : versionConstraintText(winner.versionConstraint, selection.name)})`;
  return [...explainer.pathTo(winnerNode), chosen].join(" -> ");
}

/** Explain each of a package's versions as the chain it was reached by, one
 * line per version the resolution records a chain for. */
function explainDuplicate<V>(
  pkg: string,
  versions: readonly V[],
  explainer: ResolutionExplainer<V>,
  versionToString: (version: V) => string,
  rootText?: RootRenderer
): string[] {
  return versions.flatMap(version => {
    const selection = explainer.find(`${pkg}@${versionToString(version)}`);
    const via = selection?.reachedVia;
    if (selection === undefined || via === undefined) {
      return [];
    }
    const shown = versionText(versionToString(version), pkg);
    const stated =
      via.versionConstraint === undefined || isBuildVersion(via.versionConstraint)
        ? ""
        : ` (${versionConstraintText(via.versionConstraint, pkg)})`;
    return via.requiredBy === ROOT_REQUIRER
      ? [`  ${shown} ${rootText?.(pkg, via.versionConstraint) ?? "required directly"}${stated}`]
      : [`  ${shown} required via: ${explainer.pathTo(selection).join(" -> ")}`];
  });
}

/**
 * Make the error refusing a strict collection that ships several versions of
 * a package, reporting every conflict at once under the heading `Resolution
 * requires multiple versions of the same package:`.
 *
 * - Each group of `violations` ({@link groupViolations}) is written as the two
 *   requirements that disagree (`rootText` describes a root requirement the
 *   consumer did not write), and the further requirers on one line.
 * - Where `written` names versions of a violated package and some version of
 *   it in `needed` (what the collection ships) is not among them, a line lists
 *   both and the `?` references to add.
 * - Each of `duplicates` (a package and its versions) on a package with no
 *   violation is written as its versions, each with the chain it was reached
 *   by.
 *
 * Chains are read from `graph` (one resolution, or several combined), which
 * may hold packages `needed` does not. The help is `suggestion`, where it is
 * not empty, else a generic statement of the two remedies. Raised lower bounds
 * are not reported.
 */
export function conflictError<V>(
  violations: Violation<V>[],
  duplicates: Array<[string, V[]]>,
  needed: readonly Selected<V>[],
  graph: Pick<MVSResolution<V>, "versionToString" | "explainer">,
  refText: RefRenderer,
  written?: ReadonlyMap<string, ReadonlySet<string>>,
  suggestion?: string[],
  rootText?: RootRenderer
): Error {
  const { versionToString } = graph;
  /* Chains go through the whole resolution, which may hold packages this
   * collection does not ship; the note on written versions reads `needed`
   * alone. */
  const explainer = graph.explainer();
  const lines: string[] = [];
  const violatedPkgs = new Set(violations.map(violation => violation.name));
  const sanctionNoted = new Set<string>();
  for (const { first, others } of groupViolations(violations, versionToString)) {
    const moreRequirers = others.length > 0 ? ` (and ${others.length} more)` : "";
    lines.push(
      ...conflictLines(first, moreRequirers, explainer, versionToString, rootText),
      ...alsoRequiredBy(first.name, first.versionConstraint, others)
    );
    /* Versions written for the package that leave a shipped one out: list
     * both, and the `?` references to add. */
    const declared = written?.get(first.name);
    if (declared && declared.size > 0 && !sanctionNoted.has(first.name)) {
      sanctionNoted.add(first.name);
      const shipped = needed.filter(sel => sel.name === first.name).map(sel => versionToString(sel.version));
      const missing = shipped.filter(version => !declared.has(version));
      if (missing.length > 0) {
        lines.push(
          `  required ${first.name} versions: ${shipped.map(version => versionText(version, first.name)).join(", ")} — allowed: ${[...declared].map(version => versionText(version, first.name)).join(", ")}; ` +
            `add ${missing.map(version => refText(identityOf(needed, first.name), version, "?")).join(", ")}`
        );
      }
    }
  }
  /* A package with a violation is already reported above. */
  for (const [pkg, versions] of duplicates.filter(([pkg]) => !violatedPkgs.has(pkg))) {
    lines.push(
      `${pkg} is required at ${versions.map(version => versionText(versionToString(version), pkg)).join(" and ")}`,
      ...explainDuplicate(pkg, versions, explainer, versionToString, rootText)
    );
  }
  const help =
    suggestion !== undefined && suggestion.length > 0
      ? suggestion
      : ["pin a single version satisfying every requirement, or write '?' overrides naming each version to ship"];
  return new FabrError(`Resolution requires multiple versions of the same package:\n  ${lines.join("\n  ")}`).withHelp(help);
}

/**
 * Make the error `Unable to resolve <root>:` for violations no published
 * version satisfies, in any collection: each group of `violations` with
 * {@link explainViolation}'s detail and its further requirers. The help
 * suggests correcting the requirement, or forcing each package's selected
 * version with `!`.
 */
export function unrepairableError<V>(root: string, violations: Violation<V>[], graph: MVSResolution<V>, refText: RefRenderer): Error {
  const { versionToString } = graph;
  const explainer = graph.explainer();
  const groups = groupViolations(violations, versionToString);
  const lines = groups.flatMap(({ first, others }) => [
    `no published version of ${first.name} satisfies ${versionConstraintText(first.versionConstraint, first.name)} required by ${nodeLabel(first.requiredBy)}`,
    ...explainViolation(first, explainer, versionToString),
    ...alsoRequiredBy(first.name, first.versionConstraint, others),
  ]);
  const forceLines = [...new Map(groups.map(({ first }) => [first.name, first])).values()].map(violation =>
    refText(identityOf(graph.selections, violation.name), versionToString(violation.selected), "!")
  );
  const help = [
    "correct the requirement, or pin its requirer to a version whose requirement is satisfiable",
    `if the constraint is wrong (an over-tight pin), force the delivered version — '!' overrides every requirement on the package: ${forceLines.join(" ")}`,
  ];
  return new FabrError(`Unable to resolve ${root}:\n  ${lines.join("\n  ")}`).withHelp(help);
}

/** Find the latest published version of `pkg` that the domain counts as
 * stable, or undefined where there is none or the registry fails to answer. */
function latestStable<V, C>(sources: SuggestSources<V, C>, pkg: PackageIdentity): Computable<V | undefined> {
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

/** Write the sanction line for a package with forks: a `?` reference to each
 * of its selected versions not already `written`. None for a package without
 * forks, or with every version written. */
function sanctionLine<V, C>(
  sources: SuggestSources<V, C>,
  selections: readonly Selected<V>[],
  written: (name: string) => ReadonlySet<string>,
  pkg: string
): string[] {
  const { domain } = sources;
  const principal = selections.find(sel => sel.name === pkg && sel.fork === undefined);
  const forks = selections.filter(sel => sel.name === pkg && sel.fork !== undefined);
  /* A package may have several forks and no unforked selection. */
  if (forks.length === 0) {
    return [];
  }
  const already = written(pkg);
  const entries = [...(principal ? [principal] : []), ...forks]
    .filter(sel => !already.has(domain.versionToString(sel.version)))
    .map(sel => sources.refText(sel, domain.versionToString(sel.version), "?"));
  return entries.length > 0 ? [entries.join(" ")] : [];
}

/** Make `help:` lines for suggested entries: one line for a single entry,
 * else one multi-line help (its `help:` prefix only on the lead line, so the
 * block copies cleanly), then, where an entry has a `?`, a line saying what
 * `?` means. */
export function sanctionHelp(entries: string[]): string[] {
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
 * Suggest a set of references to paste that settles the `outstanding`
 * violations of a strict collection, as `help:` lines ({@link sanctionHelp}).
 *
 * For each violated package, the suggestion is a pin where one exists: the
 * lowest published version at or above its unforked selection in `tree` that
 * satisfies every requirement on it, from `demanded` (the roots, `?` and `!`
 * left out) and from the packages in `needed` (what the collection ships).
 * A package with no pin gets its sanction line ({@link sanctionLine}): `?`
 * references to the versions shipped that `written` does not already name (a
 * package with no forks gets none). The pins are checked by resolving
 * `demanded` with them added; where that resolution leaves a violation or
 * fails, every package gets its sanction line instead. A registry failure
 * while looking for a pin leaves that package without one.
 */
export function suggestSanctions<V, C>(
  outstanding: readonly Violation<V>[],
  tree: ResolvedTree<V>,
  needed: readonly Selected<V>[],
  demanded: readonly Requirement[],
  written: ReadonlyMap<string, ReadonlySet<string>>,
  sources: SuggestSources<V, C>
): Computable<string[]> {
  const { domain } = sources;
  const conflicted = [...new Set(outstanding.map(violation => violation.name))];
  /* Every constraint on the package: the roots', and those of each package
   * shipped, satisfied or not. */
  const constraintsOn = (pkg: string): C[] => {
    /* A `?` or `!` root is no constraint a pin must satisfy. */
    const texts = new Set(
      demanded.flatMap(req =>
        requiredAs(req) === pkg && req.override === undefined && req.versionConstraint !== undefined ? [req.versionConstraint] : []
      )
    );
    for (const sel of needed) {
      for (const req of tree.requirements.get(nodeId(domain, sel.name, sel.version)) ?? []) {
        if (requiredAs(req) === pkg && req.versionConstraint !== undefined) {
          texts.add(req.versionConstraint);
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
  const writtenOf = (pkg: string): ReadonlySet<string> => written.get(pkg) ?? new Set();
  const sanctionsOnly = (): string[] => sanctionHelp(conflicted.flatMap(pkg => sanctionLine(sources, needed, writtenOf, pkg)));
  const singleFix = (pkg: string): Computable<V | undefined> => {
    const constraints = constraintsOn(pkg);
    const principal = tree.selections.find(sel => sel.name === pkg && sel.fork === undefined);
    if (!principal) {
      return Computable.resolve(undefined);
    }
    return sources.availableVersions(principal).then(
      versions => {
        if (!versions) {
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
      return fix !== undefined ? [{ pkg: identityOf(tree.selections, pkg), version: fix }] : [];
    });
    if (pins.length === 0) {
      return Computable.resolve(sanctionsOnly());
    }
    /* Check the pins, added as roots, by one resolution: any violation left
     * replaces the whole set with the sanction lines. */
    const pinReqs: Requirement[] = pins.map(pin => requirementAt(pin.pkg, domain.versionToString(pin.version)));
    return sources.resolve(canonicalRequirements([...demanded, ...pinReqs]).roots).then(
      verify => {
        if (verify.violations.length > 0) {
          return sanctionsOnly();
        }
        const pinLines = pins.map(
          pin => `${sources.refText(pin.pkg, domain.versionToString(pin.version))} (satisfies every requirement on ${pin.pkg.name})`
        );
        const sanctionLines = conflicted
          .filter(pkg => !pins.some(pin => pin.pkg.name === pkg))
          .flatMap(pkg => sanctionLine(sources, needed, writtenOf, pkg));
        return sanctionHelp([...pinLines, ...sanctionLines]);
      },
      () => sanctionsOnly()
    );
  });
}

/**
 * Combine a walk's `errors` on packages required only without a lower bound
 * (those with a `name`) into one error whose help is a set of `?` references
 * that completes the resolution of `roots` at once. Errors without a `name`
 * are returned unchanged, after it; with none to combine, `errors` is
 * returned as it is.
 *
 * Each such package is given its latest stable version as a `?` reference,
 * and `roots` resolved again with them. Packages that resolution finds
 * required only without a lower bound are given one in turn, for up to four
 * further resolutions. Where the last resolution has violations, the help also
 * names every selected version of each violated package, and the message lists
 * the violations. The combined error lists each package with its requirers
 * (`floorless`, sorted); a package with no stable version is listed but gets
 * no reference. Where a round finds no stable version for any of its
 * packages, or a resolution fails for another reason, the help names only the
 * versions given so far.
 */
export function completeRepairSet<V, C>(
  errors: IResolutionError[],
  roots: Requirement[],
  sources: SuggestSources<V, C>
): Computable<IResolutionError[]> {
  const { domain } = sources;
  const others = errors.filter(error => error.name === undefined);
  if (errors.length === others.length) {
    return Computable.resolve(others);
  }
  const supplies = new Map<string, V>();
  const requirersOf = new Map<string, Set<string>>();
  /* Each package required only without a lower bound, as a reference to it is
   * written. */
  const identities = new Map<string, PackageIdentity>();
  const identity = (pkg: string): PackageIdentity => identities.get(pkg) ?? { name: pkg };
  const recordFloorless = (failures: ReadonlyArray<{ name?: string; publishedName?: string; requiredBy?: string }>): string[] => {
    const fresh: string[] = [];
    for (const failure of failures) {
      if (failure.name === undefined) {
        continue;
      }
      identities.set(failure.name, {
        name: failure.name,
        ...(failure.publishedName === undefined ? {} : { publishedName: failure.publishedName }),
      });
      const requirers = requirersOf.get(failure.name) ?? new Set();
      requirersOf.set(failure.name, requirers.add(failure.requiredBy ?? "a requirement"));
      if (!supplies.has(failure.name) && !fresh.includes(failure.name)) {
        fresh.push(failure.name);
      }
    }
    return fresh;
  };
  const supply = (fresh: string[], round: number): Computable<ResolvedTree<V> | undefined> =>
    Computable.forAll(
      fresh.map(pkg => latestStable(sources, identity(pkg))),
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
          ...requirementAt(identity(pkg), domain.versionToString(version)),
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
    /* One suggestion line per package: the version given it, and every
     * version the last resolution selects of a violated package. */
    const suggest = new Map<string, Set<string>>();
    for (const [pkg, version] of supplies) {
      suggest.set(pkg, new Set([domain.versionToString(version)]));
    }
    const conflicts = new Set<string>();
    if (completed !== undefined) {
      for (const violation of completed.violations) {
        conflicts.add(violation.name);
        const versions = suggest.get(violation.name) ?? new Set();
        for (const sel of completed.selections.filter(sel => sel.name === violation.name)) {
          versions.add(domain.versionToString(sel.version));
        }
        suggest.set(violation.name, versions);
      }
    }
    const detailLines = [...requirersOf.keys()].sort().map(pkg => {
      const requirers = [...requirersOf.get(pkg)!].sort();
      const shown = requirers.slice(0, 3);
      const more = requirers.length - shown.length;
      return `  '${pkg}' — required by ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`;
    });
    /* The violations the last resolution has, one line per group. */
    const conflictNote =
      completed !== undefined && conflicts.size > 0
        ? [
            `completing the resolution with those versions also hits ${conflicts.size} version conflict(s), sanctioned by the list below:`,
            ...groupViolations(completed.violations, domain.versionToString).map(({ first, others }) => {
              const more = others.length > 0 ? ` (and ${others.length} more)` : "";
              return `  ${nodeLabel(`${first.name}@${domain.versionToString(first.selected)}`)} does not satisfy ${versionConstraintText(first.versionConstraint, first.name)} required by ${nodeLabel(first.requiredBy)}${more}`;
            }),
          ]
        : [];
    const entries = [...suggest.keys()]
      .sort()
      .map(pkg => [...suggest.get(pkg)!].map(version => sources.refText(identity(pkg), version, "?")).join(" "));
    /* One help for the block (its `help:` prefix only on the lead line, so it
     * copies cleanly), then the line saying what `?` means. */
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
      rootName: errors.find(error => error.name !== undefined)!.rootName,
      floorless: [...requirersOf.keys()].sort().map(identity),
      help,
    };
    return [combined, ...others];
  });
}
