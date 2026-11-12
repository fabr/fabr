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
import { FabrError, MetadataFetchError, toError, VersionNotFoundError } from "../core/Errors";
import { compareText } from "../support/Functional";
import { constraintOf, dependencyNameOf, excludedBy, requiredAs, versionConstraintText } from "./Requirement";
import { edgeBinding, MVSResolution, nodeId as idOf } from "./MVSResolution";
import {
  IRequirementEdge,
  IResolutionError,
  RequirementSource,
  RaisedFloor,
  Requirement,
  ROOT_REQUIRER,
  Selected,
  VersionDomain,
  Violation,
} from "./Types";

/**
 * Resolve `roots` by minimal version selection, as Go modules do: each
 * constraint's lower bound is a demand, and each package selects the highest
 * version demanded of it. The walk reads the requirements of every demanded
 * version (`registry.getRequirements`), including a version a higher demand
 * displaces, and the result keeps only the selections the roots reach, sorted
 * by package and version. Each root's entry in `rootBindings` names the
 * selection it binds to among those it reaches.
 *
 * Kinds of requirement:
 * - A `force` requirement (`!`) fixes its package's version for every
 *   requirement on it, as does a BOM dependency of a forced root.
 *   Requirements the forced version leaves unsatisfied are listed in
 *   `coerced`.
 * - An `alternate` requirement (`?`) demands nothing. Its version raises every
 *   requirement on its package that it satisfies, and is selected where the
 *   package is otherwise required only without a lower bound.
 * - A requirement with no lower bound (such as `*`) demands nothing, and is
 *   met by whatever the other requirements select.
 * - A `bom` requirement demands its version only for a package something else
 *   requires.
 * - A `provided` requirement demands its version only where nothing else
 *   selects its package, and an `"optional"` one never does; either binds to
 *   its package's one selection.
 * - A requirement on a package that every path to its requirer `excludes` is
 *   left out.
 *
 * Upper bounds are checked once selection is done. A requirement its
 * package's selection does not satisfy is listed in `violations`, or in
 * `shared` for a `provided` requirement where `domain.providedMismatch`
 * tolerates it. Unless `domain.flat`, an unsatisfied requirement that is
 * neither forced nor provided gets a fork where a published version satisfies
 * it: a further selection of the same package (`Selected.fork`, numbered in
 * ascending version order). Unsatisfied requirements share forks greedily,
 * each fork selecting the highest lower bound among those it serves, and a
 * fork's own requirements resolve the same way until no new fork is needed. A
 * package whose only reachable selection is a fork takes that version as its
 * selection, and the violations it satisfies are dropped.
 *
 * A lower bound the registry never published (it answers VersionNotFoundError)
 * is met by an existing selection that satisfies the constraint, if there is
 * one. Otherwise, where the registry offers `lowestAvailable`, it is raised to
 * the lowest published version that satisfies the constraint, in any major
 * version, and listed in `raises`. The first pass raises nothing; a package
 * still selected at an unpublished version when the walk settles is raised in
 * a further pass, repeated until none remains. A forced version is never
 * raised.
 *
 * A problem with one requirement is listed in `errors`, and the rest of the
 * resolution is still returned: an unparseable constraint, a package required
 * only without a lower bound, or two different packages required under one
 * name. Rejects with a MetadataFetchError, naming the package and the
 * requirement chain that reached it, where the registry fails to answer, or a
 * package is left selected at an unpublished version.
 */
export function resolveMVS<V, C>(
  roots: Requirement[],
  domain: VersionDomain<V, C>,
  registry: RequirementSource<V>
): Computable<MVSResolution<V>> {
  return forcedByBoms(roots, domain, registry).then(managed => {
    const attempt = (repairable: ReadonlySet<string>): Computable<MVSResolution<V>> =>
      resolvePhase(roots, domain, registry, repairable, managed).catch(err => {
        if (err instanceof RepairsRequired) {
          return attempt(new Set([...repairable, ...err.nodes]));
        }
        throw err;
      });
    return attempt(new Set());
  });
}

/**
 * Get the versions forced BOMs force: of each root forced with `!`, the BOM
 * dependencies its version states, by package, each forcing the version it
 * gives. A package a root forces itself, or an earlier BOM, keeps that force.
 */
function forcedByBoms<V, C>(
  roots: readonly Requirement[],
  domain: VersionDomain<V, C>,
  registry: RequirementSource<V>
): Computable<Map<string, V>> {
  const forcedRoots = roots.filter(root => root.override === "force");
  const explicit = new Set(forcedRoots.map(root => requiredAs(root)));
  const versionOf = (req: Requirement): V | undefined => {
    try {
      return domain.minimumOf(constraintOf(domain, req.versionConstraint));
    } catch {
      return undefined;
    }
  };
  return Computable.forAll(
    forcedRoots.map(root => {
      const version = versionOf(root);
      if (version === undefined) {
        return Computable.resolve<Requirement[]>([]);
      }
      try {
        return registry.getRequirements(root.name, version).catch(() => [] as Requirement[]);
      } catch {
        return Computable.resolve<Requirement[]>([]);
      }
    }),
    (...requirements: Requirement[][]) => {
      const managed = new Map<string, V>();
      for (const req of requirements.flat()) {
        const version = req.bom === true && req.versionConstraint !== undefined ? versionOf(req) : undefined;
        if (version !== undefined && !explicit.has(requiredAs(req)) && !managed.has(requiredAs(req))) {
          managed.set(requiredAs(req), version);
        }
      }
      return managed;
    }
  );
}

/** Thrown by a walk that settled with packages selected at unpublished
 * versions it may not raise (`nodes`, never empty): resolveMVS reruns the
 * walk with raising enabled for them. Never escapes resolveMVS. */
class RepairsRequired extends Error {
  constructor(public readonly nodes: string[]) {
    super("resolution requires repairs");
  }
}

/** Get the constraint a floored requirement states. One that states none has
 * no floor, so it is never raised or violated, and never reaches a caller of
 * this. */
function statedConstraint(req: Requirement): string {
  if (req.versionConstraint === undefined) {
    throw new FabrError(`internal: '${req.name}' states no version, so has no floor to raise`);
  }
  return req.versionConstraint;
}

/** One requirement's demand for a node: the requirement itself and who
 * declared it — everything needed to re-offer the demand at a raised floor. */
interface Demand {
  req: Requirement;
  requiredBy: string;
}

/** Get the name a requirement's package is published under, where the
 * requirement renames it. */
function publishedBy(req: Requirement): { publishedName?: string } {
  return requiredAs(req) === req.name ? {} : { publishedName: req.name };
}

/**
 * Run one walk of {@link resolveMVS}, forcing the versions in `managed` and
 * raising unpublished lower bounds only for the nodes in `repairable`.
 * Rejects with RepairsRequired where the walk settles with other packages
 * selected at unpublished versions.
 */
function resolvePhase<V, C>(
  roots: Requirement[],
  domain: VersionDomain<V, C>,
  registry: RequirementSource<V>,
  /** Node ids ({@link nodeId}) whose lower bounds this walk may raise: those
   * a previous walk settled on at an unpublished version. Empty on the first
   * walk. */
  repairable: ReadonlySet<string>,
  /** The versions forced BOMs force, by package ({@link forcedByBoms}). */
  managed: ReadonlyMap<string, V> = new Map()
): Computable<MVSResolution<V>> {
  /* The walk knows a package by the name it is required as (its slot); the
   * registry is asked for it by the name it is published under. */
  return Computable.from((resolve, reject) => {
    /* Forced packages (a `!` root): every requirement on the package is
     * answered by exactly this version, as npm's `overrides` do. Callers allow
     * at most one force per package; the first is taken. */
    const forced = new Map<string, V>(managed);
    for (const root of roots) {
      if (root.override === "force" && !forced.has(requiredAs(root))) {
        try {
          forced.set(requiredAs(root), domain.minimumOf(constraintOf(domain, root.versionConstraint)));
        } catch {
          /* Unparseable force constraint: reported by followEdge as usual */
        }
      }
    }
    /* The versions written `?` allows, per package, highest first: each
     * raises the floor of every requirement on its package it satisfies. */
    const allowed = new Map<string, V[]>();
    for (const root of roots) {
      if (root.override === "alternate" && root.versionConstraint !== undefined) {
        try {
          const version = domain.minimumOf(constraintOf(domain, root.versionConstraint));
          allowed.set(requiredAs(root), [...(allowed.get(requiredAs(root)) ?? []), version]);
        } catch {
          /* An unparseable alternate allows nothing to raise to */
        }
      }
    }
    for (const versions of allowed.values()) {
      versions.sort((a, b) => domain.compare(b, a));
    }
    /** @return the floor a requirement on `name` demands: its constraint's
     * minimum, raised to the highest written `?` version it satisfies. */
    const floorOf = (name: string, constraint: C): V => {
      const minimum = domain.minimumOf(constraint);
      const raised = allowed.get(name)?.find(version => domain.satisfies(version, constraint));
      return raised !== undefined && domain.compare(raised, minimum) > 0 ? raised : minimum;
    };
    /** @return true if this walk may raise the lower bounds demanding `id`,
     * otherwise false: the registry offers `lowestAvailable`, `id` is in
     * `repairable`, and its package is not forced. */
    const canRepair = (id: string): boolean =>
      registry.lowestAvailable !== undefined && repairable.has(id) && !forced.has(packageOf(id));
    /* The highest lower bound demanded so far, per package name: its
     * selection without a fork. */
    const selected = new Map<string, Selected<V>>();
    /* Fork selections per package, in creation order; their indices are
     * assigned at finalize. A fork is made only once its version's metadata
     * has answered, so every fork's version is published. */
    const forks = new Map<string, Selected<V>[]>();
    /* Raise answers for fork candidates, per "pkg\nconstraint": in flight,
     * the raised version, or null when nothing published satisfies. */
    const forkRaises = new Map<string, V | null | "pending">();
    /* Violated edges no fork can repair — nothing published satisfies their
     * constraint ("pkg\nconstraint"); they stay bare violations. */
    const unrepairable = new Set<string>();
    /* The package of every node visited, by its id: a build's version text
     * may hold an `@`, so an id is never split to find it. */
    const nodePackages = new Map<string, string>();
    /** @return the package the visited node `id` is of. */
    const packageOf = (id: string): string => nodePackages.get(id) ?? id;
    /* Declared requirements of every pkg@version visited (including superseded ones) */
    const nodeRequirements = new Map<string, Requirement[]>();
    /* First reacher of every visited node (a node id, or ROOT_REQUIRER), for
     * attributing a metadata failure back to a root requirement */
    const nodeParents = new Map<string, string>();
    /* The requirement(s) whose minimum demanded each node — the floor(s) to
     * raise if the node turns out to be unpublished */
    const nodeDemands = new Map<string, Demand[]>();
    /* Nodes the registry reported unpublished. A demand arriving after the
     * report is raised as one before it would be; such a node is left out of
     * the result; and the terminal failure takes its cause from here. */
    const notPublished = new Map<string, VersionNotFoundError>();
    /* Raises applied during the walk; filtered to the winners at finish */
    const candidateRaises: RaisedFloor<V>[] = [];
    /* (node, demand) pairs already floor-raised, so a repair is attempted once
     * however often its demand is re-offered (see raiseFloors) */
    const raisedDemands = new Set<string>();
    /* Expected-provided requirements, deferred until the walk is quiet: one
     * whose package nothing selects then fires as an ordinary demand. */
    const providedReqs: Array<{ req: Requirement; requiredBy: string }> = [];
    const providedFired = new Set<{ req: Requirement; requiredBy: string }>();
    /* Written `?` versions, supplied when the walk is quiet to a package
     * required only without a lower bound; and the packages so required. */
    const alternateAnswers = new Map<string, { version: V; publishedName?: string }>();
    /* BOM dependencies, deferred to quiescence: each fires as an ordinary
     * demand once the tree requires its package by another edge. */
    const bomReqs: Array<{ req: Requirement; requiredBy: string }> = [];
    const bomFired = new Set<{ req: Requirement; requiredBy: string }>();
    /* The edges reaching each package, by the name it is selected under
     * (an edge binds to the selection, whatever version it demanded), with
     * the package requiring it and the exclusions written on each; and the
     * requirements left out because every path to their requirer excludes
     * their package — each fired once a path that does not exclude it is
     * found (see excludedAt). */
    const incoming = new Map<string, Array<{ from: string; excludes?: readonly string[] }>>();
    const nodeDeclared = new Map<string, Requirement[]>();
    const excludedReqs: Array<{ req: Requirement; requiredBy: string }> = [];
    const excludedFired = new Set<{ req: Requirement; requiredBy: string }>();
    /* Whether any edge walked so far carries exclusions (none: nothing is excluded) */
    let excluding = false;
    const alternateFired = new Set<string>();
    const floorlessRequired = new Set<string>();

    /** Find the root package whose subtree contains `requirer` (for
     * attributing an error on one of its requirements): walk the first-reacher
     * parents to the root, as `annotate` does for fetch failures. A
     * ROOT_REQUIRER requirer means the erring requirement is itself a root —
     * it is its own root. */
    const rootPkgOf = (requirer: string, ownPkg: string): string => {
      if (requirer === ROOT_REQUIRER) {
        return ownPkg;
      }
      let rootId = requirer;
      for (let parent = nodeParents.get(rootId); parent && parent !== ROOT_REQUIRER; parent = nodeParents.get(parent)) {
        rootId = parent;
      }
      return packageOf(rootId);
    };
    /* Outstanding metadata fetches, plus one guard token held while seeding */
    let pending = 1;
    let failed = false;

    const fail = (err: Error): void => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    };

    const nodeId = (pkg: string, version: V): string => idOf(domain, pkg, version);

    const enqueue = (req: Requirement, requiredBy: string): void => {
      let constraint: C;
      try {
        constraint = constraintOf(domain, req.versionConstraint);
      } catch {
        /* Reported by followEdge, for a requirement that is in effect. */
        return;
      }
      if (req.bom) {
        bomReqs.push({ req, requiredBy });
        return;
      }
      if (req.override === "alternate") {
        /* Never a demand: recorded to raise the requirements it satisfies
         * (floorOf), and to be supplied when the walk is quiet (settle). One
         * stating no version (`@npm:debug?`) has none to supply. */
        if (req.versionConstraint === undefined) {
          return;
        }
        const version = domain.minimumOf(constraint);
        const current = alternateAnswers.get(requiredAs(req));
        if (current === undefined || domain.compare(version, current.version) > 0) {
          alternateAnswers.set(requiredAs(req), { version, ...publishedBy(req) });
        }
        return;
      }
      if (forced.has(requiredAs(req))) {
        const forcedVersion = forced.get(requiredAs(req)) as V;
        /* The requirement gets the forced version, whatever it asked for; its
         * own lower bound is never offered. The force root is the one demand
         * offered; a version a forced BOM forces has no root, so each
         * requirement on it offers it. */
        if (req.override === "force" || managed.has(requiredAs(req))) {
          attempt(req, forcedVersion, requiredBy);
        } else {
          visit(requiredAs(req), forcedVersion, requiredBy, req);
        }
        return;
      }
      if (domain.isFloorless(constraint)) {
        /* No lower bound ('*', or an upper-bound-only range): no demand. The
         * package is remembered for a written `?` version to supply. */
        floorlessRequired.add(requiredAs(req));
        return;
      }
      if (req.provided === "optional") {
        /* Never a demand; still recorded (nodeRequirements), so it binds if
         * something else selects the package. */
        return;
      }
      if (req.provided !== undefined) {
        providedReqs.push({ req, requiredBy });
        return;
      }
      attempt(req, floorOf(requiredAs(req), constraint), requiredBy);
    };

    /** Key a requirement edge in canonical order, for breaking a tie between two
     * requirements demanding the same winning floor: `selectedBy` must be a
     * function of the requirement set, not of which fetch landed first. */
    const edgeOrder = (edge: IRequirementEdge): string => `${edge.requiredBy}\n${edge.versionConstraint}`;

    /** Offer `version` as a lower bound for the package: it is selected if it
     * is higher than the current selection, and its requirements are read
     * either way (`visit` reads each version once). */
    const attempt = (req: Requirement, version: V, requiredBy: string): void => {
      const name = requiredAs(req);
      const current = selected.get(name);
      const edge: IRequirementEdge = { requiredBy, versionConstraint: req.versionConstraint };
      const order = current === undefined ? 1 : domain.compare(version, current.version);
      if (order > 0 || (order === 0 && current!.selectedBy !== undefined && edgeOrder(edge) < edgeOrder(current!.selectedBy))) {
        selected.set(name, { name, ...publishedBy(req), version, selectedBy: edge });
      }
      visit(name, version, requiredBy, req);
    };

    /**
     * Raise each of `demands`, on a version that was never published, to the
     * lowest published version satisfying its constraint, offered as any
     * demand is. A demand nothing published satisfies is not raised, and the
     * unpublished version is judged when the walk settles. Each (node, demand)
     * pair is raised once. The caller holds a `pending` token for the
     * duration.
     */
    const raiseFloors = (pkg: string, version: V, demands: Demand[]): void => {
      const id = nodeId(pkg, version);
      const fresh = demands.filter(demand => {
        const signature = `${id}\n${demand.requiredBy}\n${demand.req.versionConstraint}`;
        if (raisedDemands.has(signature)) {
          return false;
        }
        raisedDemands.add(signature);
        return true;
      });
      /* A failure of `lowestAvailable` is attributed to the node, as a
       * metadata failure is. */
      Computable.forAll(
        fresh.map(demand =>
          registry.lowestAvailable!(demand.req.name, statedConstraint(demand.req)).then(raised => {
            /* Nothing published satisfies it: judged when the walk settles. */
            if (raised === undefined) {
              return;
            }
            /* In any major version: '>=5' with no 5.x published raises to 6.x. */
            candidateRaises.push({
              name: pkg,
              versionConstraint: statedConstraint(demand.req),
              declared: version,
              raised,
              requiredBy: demand.requiredBy,
            });
            attempt(demand.req, raised, demand.requiredBy);
          })
        ),
        () => {
          if (--pending === 0) {
            settle();
          }
        }
      ).catch(raiseErr => fail(annotate(id, pkg, version, raiseErr)));
    };

    /**
     * Record that pkg@version was never published, and raise the demands
     * recorded so far where this walk may (canRepair); otherwise the version
     * stays selected, to be judged when the walk settles. Consumes the
     * `pending` token the caller holds for the node.
     */
    const nodeNotPublished = (id: string, pkg: string, version: V, err: VersionNotFoundError): void => {
      if (allowed.get(pkg)?.some(written => domain.compare(written, version) === 0)) {
        fail(new FabrError(`'${pkg}:${domain.versionToString(version)}?' allows a version of ${pkg} that was never published`));
        return;
      }
      notPublished.set(id, err);
      if (canRepair(id)) {
        raiseFloors(pkg, version, nodeDemands.get(id) ?? []);
        return;
      }
      if (--pending === 0) {
        settle();
      }
    };

    /**
     * Attribute a metadata failure to the requirement chain that first reached
     * the failing node, walking first reachers back to a root. The chain may
     * pass through a version that was later displaced.
     */
    const annotate = (id: string, pkg: string, version: V, err: unknown): MetadataFetchError => {
      const path: string[] = [];
      for (let parent = nodeParents.get(id); parent && parent !== ROOT_REQUIRER; parent = nodeParents.get(parent)) {
        path.push(parent);
      }
      const rootId = path.at(-1) ?? id;
      const rootPkg = rootId === id ? pkg : packageOf(rootId);
      return new MetadataFetchError(pkg, domain.versionToString(version), path, rootPkg, toError(err));
    };

    /**
     * @return true if every path from a root to the node `id` excludes the
     * package `name`, otherwise false: a path that excludes it carries an
     * edge whose requirement excludes it. A node no edge reaches is not
     * excluded.
     */
    const excludedAt = (id: string, name: string): boolean => {
      if (!excluding) {
        return false;
      }
      const start = packageOf(id);
      if (!incoming.has(start)) {
        return false;
      }
      const seen = new Set<string>([start]);
      const stack = [start];
      for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
        for (const { from, excludes } of incoming.get(at) ?? []) {
          if (excludedBy(excludes, name)) {
            continue;
          }
          if (from === ROOT_REQUIRER) {
            return false;
          }
          const requirer = packageOf(from);
          if (!seen.has(requirer)) {
            seen.add(requirer);
            stack.push(requirer);
          }
        }
      }
      return true;
    };

    /** Record the node `id`'s requirements that no path's exclusions leave out as its edges. */
    const keepRequirements = (id: string): void => {
      nodeRequirements.set(
        id,
        (nodeDeclared.get(id) ?? []).filter(req => !req.bom && !excludedAt(id, requiredAs(req)))
      );
    };

    const visit = (pkg: string, version: V, requiredBy: string, req: Requirement): void => {
      const id = nodeId(pkg, version);
      const entry: Demand = { req, requiredBy };
      incoming.set(pkg, [...(incoming.get(pkg) ?? []), { from: requiredBy, excludes: req.excludes }]);
      excluding ||= (req.excludes?.length ?? 0) > 0;
      const demands = nodeDemands.get(id);
      if (demands) {
        /* Already read, or being read: record the demand in case the version
         * is unpublished, and raise it now if that is already known. */
        demands.push(entry);
        const known = notPublished.get(id);
        if (known && canRepair(id)) {
          pending++;
          raiseFloors(pkg, version, [entry]);
        }
        return;
      }
      nodeDemands.set(id, [entry]);
      nodePackages.set(id, pkg);
      nodeRequirements.set(id, []);
      nodeParents.set(id, requiredBy);
      pending++;
      const onMetadataError = (err: unknown): void => {
        if (err instanceof VersionNotFoundError) {
          nodeNotPublished(id, pkg, version, err);
        } else {
          fail(annotate(id, pkg, version, err));
        }
      };
      try {
        registry.getRequirements(req.name, version).then(requirements => {
          /* A BOM's dependencies are no edges of the node: they only offer
           * floors (see enqueue). A requirement every path to the node
           * excludes waits for a path that does not. */
          nodeDeclared.set(id, requirements);
          keepRequirements(id);
          for (const req of requirements) {
            if (!req.bom && excludedAt(id, requiredAs(req))) {
              excludedReqs.push({ req, requiredBy: id });
            } else {
              enqueue(req, id);
            }
          }
          if (--pending === 0) {
            settle();
          }
        }, onMetadataError);
      } catch (err) {
        /* A registry that throws instead of rejecting gets the same treatment */
        onMetadataError(err);
      }
    };

    /**
     * Run when the walk is quiet: fire the deferred requirements that now
     * apply (an expected-provided requirement whose package nothing selects,
     * a written `?` version for a package required only without a lower bound,
     * a BOM dependency on a package something requires, an excluded
     * requirement a path no longer excludes) and keep walking; once none
     * applies, finish.
     */
    const settle = (): void => {
      if (failed) {
        return;
      }
      const selectedPkgs = new Set([...selected.values()].map(sel => sel.name));
      /* A written `?` version is supplied where no published version is
       * selected; an expected-provided requirement fires only where no version
       * at all is selected. */
      const publishedPkgs = new Set(
        [...selected.values()].filter(sel => !notPublished.has(nodeId(sel.name, sel.version))).map(sel => sel.name)
      );
      const firing = providedReqs.filter(entry => !providedFired.has(entry) && !selectedPkgs.has(requiredAs(entry.req)));
      const supplying = [...alternateAnswers].filter(
        ([pkg]) => !alternateFired.has(pkg) && floorlessRequired.has(pkg) && !publishedPkgs.has(pkg)
      );
      /* A BOM's dependency on a package the tree requires by another edge,
       * floored or not, offers its floor. */
      const flooring = bomReqs.filter(
        entry => !bomFired.has(entry) && (selectedPkgs.has(requiredAs(entry.req)) || floorlessRequired.has(requiredAs(entry.req)))
      );
      /* An excluded requirement a path found since no longer excludes. */
      const lifting = excludedReqs.filter(entry => !excludedFired.has(entry) && !excludedAt(entry.requiredBy, requiredAs(entry.req)));
      if (firing.length === 0 && supplying.length === 0 && flooring.length === 0 && lifting.length === 0) {
        finish();
        return;
      }
      pending++;
      for (const entry of lifting) {
        excludedFired.add(entry);
        keepRequirements(entry.requiredBy);
        enqueue(entry.req, entry.requiredBy);
      }
      for (const entry of firing) {
        providedFired.add(entry);
        enqueue({ ...entry.req, provided: undefined }, entry.requiredBy);
      }
      for (const entry of flooring) {
        bomFired.add(entry);
        enqueue({ ...entry.req, bom: undefined }, entry.requiredBy);
      }
      for (const [pkg, { version, publishedName }] of supplying) {
        alternateFired.add(pkg);
        /* An unpublished version selected for the package gives way to the
         * supplied one. */
        const current = selected.get(pkg);
        if (current && notPublished.has(nodeId(current.name, current.version))) {
          selected.delete(pkg);
        }
        attempt(
          publishedName === undefined
            ? { name: pkg, versionConstraint: domain.versionToString(version) }
            : { name: publishedName, versionConstraint: domain.versionToString(version), renameTo: pkg },
          version,
          ROOT_REQUIRER
        );
      }
      if (--pending === 0) {
        settle();
      }
    };

    /** One violated edge awaiting fork packing, its constraint pre-parsed. */
    interface PackEdge {
      req: Requirement;
      requiredBy: string;
      constraint: C;
    }

    /** What one round of judging the quiet walk finds: the reachable
     * selections and how each was reached, what is unsatisfied, and the edges
     * no selection satisfies, to be packed into forks. */
    interface Round {
      selectionsByPkg: Map<string, Selected<V>[]>;
      reachable: Map<Selected<V>, Selected<V>>;
      violations: Violation<V>[];
      coerced: Violation<V>[];
      shared: Violation<V>[];
      unsatisfied: PackEdge[];
      errors: Map<string, IResolutionError>;
    }

    /**
     * Judge the quiet walk: from the roots, follow each requirement to the
     * published selection it binds to (edgeBinding), checking its upper bound
     * on the way. Only what is reached this way is in effect. Undefined where
     * a requirement in effect still binds to an unpublished version, in which
     * case the walk has been failed (with RepairsRequired, or terminally).
     */
    const judgeConverged = (): Round | undefined => {
      /* The published selections of each package: the one without a fork
       * first, then the forks in creation order. */
      const selectionsByPkg = new Map<string, Selected<V>[]>();
      for (const selection of selected.values()) {
        if (notPublished.has(nodeId(selection.name, selection.version))) {
          continue;
        }
        selectionsByPkg.set(selection.name, [selection]);
      }
      for (const [pkg, packed] of forks) {
        /* A package whose selection became unpublished after its forks were
         * made drops its forks too. */
        selectionsByPkg.get(pkg)?.push(...packed);
      }

      const errors = new Map<string, IResolutionError>();
      const violations: Violation<V>[] = [];
      const coerced: Violation<V>[] = [];
      const shared: Violation<V>[] = [];
      const unsatisfied: PackEdge[] = [];
      /* Reachable selections, each annotated (as a copy) with how it was
       * first reached; keyed by the underlying selection instance */
      const reachable = new Map<Selected<V>, Selected<V>>();
      const visited = new Set<string>();
      /* An alternate root is not followed. */
      const demandRoots = roots.filter(root => root.override !== "alternate");
      const queue: Array<{ from: string; requirements: Requirement[] }> = [{ from: ROOT_REQUIRER, requirements: demandRoots }];
      /* Unpublished selected versions a requirement in effect still needs. */
      const neededPhantoms = new Map<string, { name: string; version: V; err: VersionNotFoundError }>();

      const followEdge = (from: string, req: Requirement): void => {
        if (req.provided === "optional") {
          /* Not followed; finalize still binds it where its package is
           * reached. */
          return;
        }
        const name = requiredAs(req);
        let constraint: C;
        try {
          constraint = constraintOf(domain, req.versionConstraint);
        } catch (err) {
          const message = `${toError(err).message} in requirement '${name}: ${req.versionConstraint}' (required by ${from})`;
          errors.set(message, { message, rootName: rootPkgOf(from, name) });
          return;
        }
        const candidates = selectionsByPkg.get(name) ?? [];
        if (candidates.length === 0 && domain.isFloorless(constraint)) {
          const message =
            `'${name}' is required by ${from} without a version lower bound (${versionConstraintText(req.versionConstraint)}),` +
            ` and no versioned requirement for it exists — add one explicitly`;
          errors.set(message, { message, rootName: rootPkgOf(from, name), name, ...publishedBy(req), requiredBy: from });
          return;
        }
        if (candidates.length === 0) {
          /* No published selection of the package: its selected version is
           * unpublished, or this is an internal error. */
          const winner = selected.get(name);
          const winnerId = winner && nodeId(winner.name, winner.version);
          const phantomErr = winnerId !== undefined ? notPublished.get(winnerId) : undefined;
          if (winner && winnerId !== undefined && phantomErr) {
            neededPhantoms.set(winnerId, { name: winner.name, version: winner.version, err: phantomErr });
            return;
          }
          const message = `internal error: requirement '${name}: ${
            req.versionConstraint ?? "any version"
          }' (required by ${from}) matches no selection`;
          errors.set(message, { message, rootName: rootPkgOf(from, name) });
          return;
        }
        /* The upper bound is checked against the selection without a fork,
         * whether or not a fork satisfies the requirement; a forced package's
         * unsatisfied requirements are coerced. A requirement no current
         * selection satisfies is packed into a fork, unless it is forced,
         * provided, or the domain is flat. */
        const forcedPkg = forced.has(name);
        const providedEdge = req.provided !== undefined;
        const tolerated = providedEdge && domain.providedMismatch === "tolerate";
        const principal = candidates.find(sel => !sel.fork);
        const bound = edgeBinding(domain, candidates, req)!;
        /* One name is one package: a requirement renaming another package to
         * a name already selected is an error. */
        const held = bound.publishedName ?? bound.name;
        if (held !== req.name) {
          const message =
            `'${name}' is required as two different packages: '${held}' (by ${bound.selectedBy?.requiredBy ?? "a requirement"})` +
            ` and '${req.name}' (by ${from})`;
          errors.set(message, { message, rootName: rootPkgOf(from, name) });
          return;
        }
        /* Where the package has only forks, judged against what it binds to. */
        const judged = principal ?? bound;
        if (!domain.satisfies(judged.version, constraint)) {
          (forcedPkg ? coerced : tolerated ? shared : violations).push({
            name,
            versionConstraint: statedConstraint(req),
            requiredBy: from,
            selected: judged.version,
          });
        }
        if (!forcedPkg && !providedEdge && !domain.flat && !domain.satisfies(bound.version, constraint)) {
          unsatisfied.push({ req, requiredBy: from, constraint });
        }
        if (!reachable.has(bound)) {
          reachable.set(bound, { ...bound, reachedVia: { requiredBy: from, versionConstraint: req.versionConstraint } });
          const id = nodeId(bound.name, bound.version);
          if (!visited.has(id)) {
            visited.add(id);
            queue.push({ from: id, requirements: nodeRequirements.get(id) ?? [] });
          }
        }
      };

      let entry: { from: string; requirements: Requirement[] } | undefined;
      while ((entry = queue.shift())) {
        for (const req of entry.requirements) {
          followEdge(entry.from, req);
        }
      }

      /* An unpublished version a requirement in effect still needs: those
       * this walk could not raise are handed back for the next walk
       * (RepairsRequired); otherwise the walk fails with the first, by node
       * id. Unpublished versions nothing in effect needs are dropped. */
      if (neededPhantoms.size > 0) {
        const needed = [...neededPhantoms.entries()].sort(([a], [b]) => compareText(a, b));
        /* A forced package's version is never raised. */
        const unarmed = needed.filter(([id, info]) => !repairable.has(id) && !forced.has(info.name)).map(([id]) => id);
        const [id, info] = needed[0];
        fail(
          registry.lowestAvailable && unarmed.length > 0
            ? new RepairsRequired(unarmed)
            : annotate(id, info.name, info.version, info.err)
        );
        return undefined;
      }
      return { selectionsByPkg, reachable, violations, coerced, shared, unsatisfied, errors };
    };

    /** What one packing pass did: demanded new metadata / requested raises
     * (async — the walk continues and re-converges), created forks, or marked
     * edges unrepairable (both sync — the convergence loop re-judges). */
    interface PackStep {
      asyncWork: boolean;
      progressed: boolean;
    }

    /**
     * Pack the requirements no current selection satisfies into new forks:
     * first-fit per package, in a canonical order, each fork's version the
     * highest lower bound among its members, admitted only while it
     * satisfies every member. A published version becomes a fork at once; an
     * unpublished one is raised (without waiting for a further walk) and the
     * raised version read, to become a fork next round. A requirement with no
     * lower bound is raised directly. One nothing published satisfies is
     * marked unrepairable and stays a violation.
     */
    const packForks = (unsatisfied: PackEdge[]): PackStep => {
      const step: PackStep = { asyncWork: false, progressed: false };
      const edgeSig = (edge: PackEdge): string => `${requiredAs(edge.req)}\n${edge.req.versionConstraint}`;
      /* Canonical packing order, identical (package, constraint) edges kept
       * once, attributed to the first. */
      const seen = new Set<string>();
      const edges = unsatisfied
        .filter(edge => !unrepairable.has(edgeSig(edge)))
        .sort(
          (a, b) =>
            compareText(requiredAs(a.req), requiredAs(b.req)) ||
            compareText(a.req.versionConstraint ?? "", b.req.versionConstraint ?? "") ||
            compareText(a.requiredBy, b.requiredBy)
        )
        .filter(edge => {
          const sig = edgeSig(edge);
          if (seen.has(sig)) {
            return false;
          }
          seen.add(sig);
          return true;
        });

      /** Get the raise answer for a fork candidate constraint, requesting it on
       * first ask: the raised version, null when nothing satisfies or the
       * registry offers no hook, or "pending" while in flight. */
      const raiseAnswer = (pkg: string, constraint: string, provokedBy: PackEdge): V | null | "pending" => {
        const sig = `${pkg}\n${constraint}`;
        const known = forkRaises.get(sig);
        if (known !== undefined) {
          return known;
        }
        if (!registry.lowestAvailable) {
          forkRaises.set(sig, null);
          return null;
        }
        forkRaises.set(sig, "pending");
        pending++;
        registry
          .lowestAvailable(provokedBy.req.name, constraint)
          .then(raised => {
            forkRaises.set(sig, raised ?? null);
            if (--pending === 0) {
              settle();
            }
          })
          .catch(raiseErr => {
            const principal = selected.get(pkg);
            const version = principal?.version ?? domain.minimumOf(provokedBy.constraint);
            fail(annotate(nodeId(pkg, version), pkg, version, raiseErr));
          });
        return "pending";
      };

      /** Create the fork at `candidate`, or demand what it still needs.
       * `declared` is the group's highest lower bound, undefined where
       * `candidate` is already a raised version, which is not raised again. */
      const forkAt = (candidate: V, declared: V | undefined, floorEdge: PackEdge): void => {
        const name = requiredAs(floorEdge.req);
        const id = nodeId(name, candidate);
        if (!nodeDemands.has(id)) {
          /* Read it; the fork is made next round. */
          step.asyncWork = true;
          visit(name, candidate, floorEdge.requiredBy, floorEdge.req);
          return;
        }
        if (notPublished.has(id)) {
          if (declared === undefined) {
            /* A raised version the registry rejects: unrepairable. */
            unrepairable.add(edgeSig(floorEdge));
            step.progressed = true;
            return;
          }
          /* The group's lower bound was never published: raise it. */
          const answer = raiseAnswer(name, statedConstraint(floorEdge.req), floorEdge);
          if (answer === "pending") {
            step.asyncWork = true;
            return;
          }
          if (answer === null) {
            /* Nothing published satisfies it: the other members repack
             * without it next round. */
            unrepairable.add(edgeSig(floorEdge));
            step.progressed = true;
            return;
          }
          candidateRaises.push({
            name,
            versionConstraint: statedConstraint(floorEdge.req),
            declared,
            raised: answer,
            requiredBy: floorEdge.requiredBy,
          });
          forkAt(answer, undefined, floorEdge);
          return;
        }
        const packed = forks.get(name) ?? [];
        forks.set(name, packed);
        packed.push({
          name,
          ...publishedBy(floorEdge.req),
          version: candidate,
          selectedBy: { requiredBy: floorEdge.requiredBy, versionConstraint: floorEdge.req.versionConstraint },
          fork: packed.length + 1,
        });
        step.progressed = true;
      };

      /* The groups packed per package this round: each holds its members and
       * its highest lower bound, with the requirement stating it. */
      interface NewClass {
        floor: V;
        floorEdge: PackEdge;
        members: PackEdge[];
      }
      const classesByPkg = new Map<string, NewClass[]>();
      for (const edge of edges) {
        const pkg = requiredAs(edge.req);
        /* A fork created earlier in this very pass may already cover it */
        if ((forks.get(pkg) ?? []).some(fork => domain.satisfies(fork.version, edge.constraint))) {
          continue;
        }
        if (domain.isFloorless(edge.constraint)) {
          /* No lower bound: raised alone, to the lowest published version
           * that satisfies it. */
          const answer = raiseAnswer(pkg, statedConstraint(edge.req), edge);
          if (answer === "pending") {
            step.asyncWork = true;
          } else if (answer === null) {
            unrepairable.add(edgeSig(edge));
            step.progressed = true;
          } else {
            forkAt(answer, undefined, edge);
          }
          continue;
        }
        const floor = floorOf(pkg, edge.constraint);
        const classes = classesByPkg.get(pkg) ?? [];
        classesByPkg.set(pkg, classes);
        let placed = false;
        for (const cls of classes) {
          const jointFloor = domain.compare(floor, cls.floor) > 0 ? floor : cls.floor;
          if ([...cls.members, edge].every(member => domain.satisfies(jointFloor, member.constraint))) {
            cls.members.push(edge);
            if (domain.compare(jointFloor, cls.floor) > 0) {
              cls.floor = jointFloor;
              cls.floorEdge = edge;
            }
            placed = true;
            break;
          }
        }
        if (!placed) {
          classes.push({ floor, floorEdge: edge, members: [edge] });
        }
      }
      for (const classes of classesByPkg.values()) {
        for (const cls of classes) {
          forkAt(cls.floor, cls.floor, cls.floorEdge);
        }
      }
      return step;
    };

    /** Finalize the converged, fully-packed graph into the resolution. */
    const finalize = (round: Round): void => {
      /* Mark, for each root, the selections it reaches. */
      const targetsOf = (req: Requirement): Selected<V> | undefined =>
        edgeBinding(domain, round.selectionsByPkg.get(requiredAs(req)) ?? [], req);
      roots.forEach((root, rootIndex) => {
        if (root.override === "alternate") {
          /* Reached through the requirements it supplies. */
          return;
        }
        const visitedNodes = new Set<string>();
        const mark = (requirements: Requirement[]): void => {
          for (const req of requirements) {
            if (req.provided === "optional") {
              /* Not followed, as in followEdge. */
              continue;
            }
            const target = targetsOf(req);
            const selection = target && round.reachable.get(target);
            if (!selection) {
              continue;
            }
            const from = (selection.reachableFrom ??= []);
            if (!from.includes(rootIndex)) {
              from.push(rootIndex);
            }
            const id = nodeId(selection.name, selection.version);
            if (!visitedNodes.has(id)) {
              visitedNodes.add(id);
              mark(nodeRequirements.get(id) ?? []);
            }
          }
        };
        mark([root]);
      });

      const selections = [...round.reachable.values()].sort((a, b) => {
        if (a.name !== b.name) {
          return a.name < b.name ? -1 : 1;
        }
        return domain.compare(a.version, b.version);
      });
      /* A package whose only reachable version is a fork takes it as its
       * selection without a fork. */
      const perPkg = new Map<string, Selected<V>[]>();
      for (const selection of selections) {
        perPkg.set(selection.name, [...(perPkg.get(selection.name) ?? []), selection]);
      }
      const promoted = new Map<string, V>();
      for (const [pkg, group] of perPkg) {
        if (group.length === 1 && group[0].fork !== undefined) {
          group[0].fork = undefined;
          promoted.set(pkg, group[0].version);
        }
      }
      /* Its violations are dropped where the version satisfies them, and
       * otherwise name that version. */
      const violations = round.violations.flatMap(violation => {
        const promotedVersion = promoted.get(violation.name);
        if (promotedVersion === undefined) {
          return [violation];
        }
        try {
          return domain.satisfies(promotedVersion, domain.parseConstraint(violation.versionConstraint))
            ? []
            : [{ ...violation, selected: promotedVersion }];
        } catch {
          return [];
        }
      });
      /* Fork indices: per package, in ascending version order. */
      const forkCount = new Map<string, number>();
      for (const selection of selections) {
        if (selection.fork !== undefined) {
          const next = (forkCount.get(selection.name) ?? 0) + 1;
          forkCount.set(selection.name, next);
          selection.fork = next;
        }
      }
      /* The raises whose version is selected, each (package, constraint)
       * once, in a canonical order. */
      const raiseKeys = new Set<string>();
      const ordered = [...candidateRaises].sort(
        (a, b) =>
          compareText(a.name, b.name) ||
          compareText(a.versionConstraint, b.versionConstraint) ||
          compareText(a.requiredBy, b.requiredBy)
      );
      const raises = ordered.filter(raise => {
        const winner = selections.some(sel => sel.name === raise.name && domain.compare(sel.version, raise.raised) === 0);
        const dedup = `${raise.name}\n${raise.versionConstraint}`;
        if (!winner || raiseKeys.has(dedup)) {
          return false;
        }
        raiseKeys.add(dedup);
        return true;
      });
      /* The declared requirements of every selection, forks included. */
      const requirements = new Map<string, Requirement[]>(
        selections.map(sel => {
          const id = nodeId(sel.name, sel.version);
          return [id, nodeRequirements.get(id) ?? []];
        })
      );
      /* The selections of each package, as edgeBinding takes them. */
      const candidates = new Map<string, Selected<V>[]>();
      for (const selection of selections) {
        const held = candidates.get(selection.name);
        if (held) {
          held.push(selection);
        } else {
          candidates.set(selection.name, [selection]);
        }
      }
      /* The selection each requirement binds to, by node id (after the fork
       * renumbering). */
      const edges = new Map<string, Map<string, string>>(
        selections.map(sel => {
          const from = new Map<string, string>();
          for (const req of requirements.get(nodeId(sel.name, sel.version)) ?? []) {
            /* The requirer's own name for the edge — first declaration wins, as
             * the layout reads it. A variant is an edge of its own, bound to the
             * package's selection. */
            const name = dependencyNameOf(req);
            if (from.has(name)) {
              continue;
            }
            const target = edgeBinding(domain, candidates.get(requiredAs(req)) ?? [], req);
            if (target) {
              from.set(name, nodeId(target.name, target.version));
            }
          }
          return [nodeId(sel.name, sel.version), from];
        })
      );
      /* Each root binds among the selections it reaches, as a position in
       * `selections`. */
      const rootBindings = roots.map((root, rootIndex) => {
        if (root.override === "alternate") {
          return undefined;
        }
        const reachable = (candidates.get(requiredAs(root)) ?? []).filter(sel => sel.reachableFrom?.includes(rootIndex));
        const bound = edgeBinding(domain, reachable, root);
        const at = bound === undefined ? -1 : selections.indexOf(bound);
        return at < 0 ? undefined : at;
      });
      resolve(
        new MVSResolution(domain.versionToString.bind(domain), {
          selections,
          errors: [...round.errors.values()],
          violations,
          coerced: round.coerced,
          shared: round.shared,
          raises,
          requirements,
          edges,
          rootBindings,
        })
      );
    };

    /**
     * Judge the quiet walk and pack forks for what it leaves unsatisfied, then
     * finalize where nothing was packed, return where packing started reads
     * (the walk settles again), or judge again where packing changed the
     * graph.
     */
    const finish = (): void => {
      for (;;) {
        if (failed) {
          return;
        }
        const round = judgeConverged();
        if (round === undefined) {
          return;
        }
        const step = packForks(round.unsatisfied);
        if (step.asyncWork) {
          return;
        }
        if (!step.progressed) {
          finalize(round);
          return;
        }
      }
    };

    for (const root of roots) {
      enqueue(root, ROOT_REQUIRER);
    }
    if (--pending === 0) {
      settle();
    }
  });
}
