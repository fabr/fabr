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
import { MetadataFetchError, toError, VersionNotFoundError } from "../core/Errors";
import { edgeBinding, nodeId as idOf } from "./ResolutionGraph";
import {
  IRequirementEdge,
  IResolutionError,
  RequirementSource,
  RaisedFloor,
  Requirement,
  MVSResolution,
  ROOT_REQUIRER,
  Selected,
  VersionDomain,
  Violation,
} from "./Types";

/**
 * Minimal Version Selection resolver (after Go's MVS): every constraint is
 * interpreted as a lower bound, and each package **name** is resolved to the
 * maximum over all lower bounds declared in the reachable requirement graph —
 * the **principal** selection, the one version per name a flat delivery ships.
 *
 * The **requirement graph is the whole demanded closure**: every version any
 * reachable requirement demands is expanded, not merely the ones that improve
 * the current selection (Go's module graph, likewise). This is what makes the
 * result a pure function of the requirement set rather than of metadata
 * arrival order — a demanded version that loses its slot still contributes its
 * own requirements' floors, whether it is reached before or after the winner.
 * (Expanding only improving versions would make a superseded package's floors
 * count or not count according to which fetch landed first — and the result is
 * persisted, so a cache flush could then change a build.) Selection is
 * consequently monotone: a max over a set, computed once the walk is quiet.
 * Superseded versions are pruned from the *result* by the post-walk
 * reachability pass, which follows the edge bindings only.
 *
 * The result therefore depends only on what the packages in the graph declare,
 * never on what else the repository happens to contain, so it is deterministic
 * without a lockfile (provided published metadata is immutable). Upper bounds
 * are checked after selection. For **convex** constraints this check is a
 * satisfiability proof: any flat assignment must sit at or above every floor,
 * hence at or above the principal, so a principal breaking some cap means no
 * flat assignment exists at all — the constraints are jointly unsatisfiable,
 * reported in MVSResolution.violations as data, not failure. (A disjunctive
 * range can in principle be satisfiable above the minimal point; suggesting
 * such a cross-disjunct pin is a corrections concern, not the resolver's.)
 *
 * Each violated edge is then repaired by a **fork**: a further selection of
 * the same package (Selected.fork > 0), packed greedily so that the fewest
 * forks jointly satisfy the violated edges — max-of-floors *within the pack*,
 * exactly the MVS rule applied to the edges the principal cannot serve. Fork
 * subtrees resolve **jointly in the one graph**: a fork's own requirement
 * edges bind by satisfaction against the same selections (usually the
 * principals — sharing is the default), and edges they in turn violate fork
 * further, iterated to a fixpoint. There is no second resolution world, so
 * root pins govern fork subtrees exactly as they govern everything else. The
 * consumer judges forks per delivery: a strict (linked) delivery refuses
 * reachable forks (the violations carry the report), a sealed tool delivery
 * nests them privately. A violated edge nothing published satisfies gets no
 * fork and stays a bare violation — undeliverable in every mode, judged where
 * it is in scope.
 *
 * The one relaxation of pure lower-bound selection is the **floor raise**: a
 * requirement whose declared minimum was never published (the registry rejects
 * it with VersionNotFoundError) degrades to attach-first semantics, judged at
 * convergence — an existing selection satisfying the constraint (a root pin,
 * typically) answers the request outright, with no registry read at all;
 * otherwise, if the registry offers `lowestAvailable`, the requirement's
 * contribution is raised to the lowest *published* satisfying version — the
 * request was for the constraint, and the first published version meeting it
 * is an acceptable answer (>=5 where the 5.x line was never published is
 * answered from major 6; edges bind by satisfaction, so the moved demand
 * cannot vanish from the closure). Raises are recorded in MVSResolution.raises
 * when they win. An unpublished winner nothing needs is simply excluded from
 * the result: edges are resolved against the *published* selections only, so a
 * demand's phantom slot entry serves no edge and needs no withdrawal.
 *
 * Principal repairs fire only when no repair-free resolution exists, and only
 * for the nodes that prove it: resolution runs first with repairs disabled,
 * tolerating an unpublished demanded version as an unexpandable pending
 * selection (a transient winner superseded by a higher declared floor never
 * mattered, and must not trigger — or be failed by — a repair). Only if the
 * CONVERGED tree has an edge no published selection answers — whose slot
 * winner is an unpublished version, the proof that the tree is unresolvable
 * without repair — is the walk rerun, with the raise hook armed for **exactly
 * those nodes**. Each rerun can expose further blocking nodes (a raise changes
 * selections), so the armed set grows and the walk repeats until the tree
 * converges clean or stops growing; it is bounded by the finite node set, so
 * this terminates. (A **fork** candidate needs no such arming: a fork exists
 * only because a converged tree proved the violated edges need it, so its
 * unpublished floor is raised directly.)
 *
 * The hook is armed per node, not globally for the rerun: a broken floor phase 1
 * tolerated *is* tolerable, and raising it would move a selection nothing asked
 * to be moved — coupling that package's version to whether some unrelated
 * subtree needed repairing. The judgment is likewise independent of visit order:
 * an eagerly-probed transient floor whose range has no published version must
 * not fail a tree a later declared floor makes clean. Without the hook the same
 * tolerance applies, and a live unpublished winner at convergence is the
 * terminal failure.
 *
 * Note: if the registry rejects a metadata fetch (other than a raisable
 * version-not-found), the returned Computable rejects with a
 * MetadataFetchError identifying the failing package and the requirement chain
 * that first reached it (the requirement graph cannot be determined, which is
 * unlike a constraint violation and so is not reported via the result).
 */
export function resolveMVS<V, C>(
  roots: Requirement[],
  domain: VersionDomain<V, C>,
  registry: RequirementSource<V>
): Computable<MVSResolution<V>> {
  const attempt = (repairable: ReadonlySet<string>): Computable<MVSResolution<V>> =>
    resolvePhase(roots, domain, registry, repairable).catch(err => {
      if (err instanceof RepairsRequired) {
        return attempt(new Set([...repairable, ...err.nodes]));
      }
      throw err;
    });
  return attempt(new Set());
}

/** Internal signal: the converged tree has edges only these (unpublished)
 * nodes could answer, and the hook has not yet been armed for them — so no
 * repair-free resolution exists and the walk must rerun with them raisable.
 * Never escapes resolveMVS; `nodes` is non-empty (a converged tree whose
 * blocking nodes were all already armed is the terminal failure instead). */
class RepairsRequired extends Error {
  constructor(public readonly nodes: string[]) {
    super("resolution requires repairs");
  }
}

/** Lexicographic order on strings, for the canonical orderings a persisted
 * resolution needs (its lists must not carry the walk's arrival order). */
function compareText(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/** One requirement's demand for a node: the requirement itself and who
 * declared it — everything needed to re-offer the demand at a raised floor. */
interface Demand {
  req: Requirement;
  requiredBy: string;
}

function resolvePhase<V, C>(
  roots: Requirement[],
  domain: VersionDomain<V, C>,
  registry: RequirementSource<V>,
  /** Node ids ({@link nodeId}) whose floors this walk may raise — the ones a
   * previous walk converged on as unpublished *winners*. Empty on the first
   * walk, so it is repair-free. */
  repairable: ReadonlySet<string>
): Computable<MVSResolution<V>> {
  return Computable.from((resolve, reject) => {
    /* Forced packages (a `!` root override): every requirement on the package
     * is substituted with exactly this version — npm-`overrides` semantics.
     * The caller validates at most one force per package (a generic defensive
     * first-in-canonical-order would mask the error); the resolver takes the
     * first. */
    const forced = new Map<string, V>();
    for (const root of roots) {
      if (root.override === "force" && !forced.has(root.pkg)) {
        try {
          forced.set(root.pkg, domain.minimumOf(domain.parseConstraint(root.constraint)));
        } catch {
          /* Unparseable force constraint: reported by followEdge as usual */
        }
      }
    }
    /** Whether this walk may raise the floors demanding `id`: the registry must
     * offer the hook, and the node must be one a converged tree proved blocking
     * — and never a forced package's (the user pinned it; a raise would move a
     * version that was explicitly forced). */
    const canRepair = (id: string): boolean =>
      registry.lowestAvailable !== undefined && repairable.has(id) && !forced.has(id.substring(0, id.lastIndexOf("@")));
    /* Highest minimum seen so far, per package name — the principal winner */
    const selected = new Map<string, Selected<V>>();
    /* Fork selections per package, in creation order (each round's packing is
     * deterministic, so this order is too); canonical indices are assigned at
     * finalize. Every fork's version is a *published* version by construction
     * (created only once its metadata answered). */
    const forks = new Map<string, Selected<V>[]>();
    /* Raise answers for fork candidates, per "pkg\nconstraint": in flight,
     * the raised version, or null when nothing published satisfies. */
    const forkRaises = new Map<string, V | null | "pending">();
    /* Violated edges no fork can repair — nothing published satisfies their
     * constraint ("pkg\nconstraint"); they stay bare violations. */
    const unrepairable = new Set<string>();
    /* Declared requirements of every pkg@version visited (including superseded ones) */
    const nodeRequirements = new Map<string, Requirement[]>();
    /* First reacher of every visited node (a node id, or ROOT_REQUIRER), for
     * attributing a metadata failure back to a root requirement */
    const nodeParents = new Map<string, string>();
    /* The requirement(s) whose minimum demanded each node — the floor(s) to
     * raise if the node turns out to be unpublished */
    const nodeDemands = new Map<string, Demand[]>();
    /* Nodes the registry reported unpublished — the phantoms. Serves three
     * duties: a demand arriving after the 404 is repaired on the same terms as
     * one that preceded it (the raise must not depend on whether the answer
     * beat the demand); the result view is filtered by it (a phantom slot
     * winner serves no edge — see the convergence rounds); and convergence
     * reads the terminal failure's cause from it. */
    const notPublished = new Map<string, VersionNotFoundError>();
    /* Raises applied during the walk; filtered to the winners at finish */
    const candidateRaises: RaisedFloor<V>[] = [];
    /* (node, demand) pairs already floor-raised, so a repair is attempted once
     * however often its demand is re-offered (see raiseFloors) */
    const raisedDemands = new Set<string>();
    /* Soft (peer) requirements deferred to quiescence: each is primarily a
     * constraint on whatever the tree selects; one whose package the converged
     * tree doesn't select at all fires as an ordinary demand (auto-install as
     * last resort). */
    const softReqs: Array<{ req: Requirement; requiredBy: string }> = [];
    const softFired = new Set<{ req: Requirement; requiredBy: string }>();
    /* Written `?` alternates (attach-last: supply a version to a package the
     * tree requires only floorlessly), and the packages seen floorlessly
     * required — the trigger condition, judged at quiescence. */
    const alternateAnswers = new Map<string, V>();
    const alternateFired = new Set<string>();
    const floorlessRequired = new Set<string>();

    /** The root package whose subtree contains `requirer` (for attributing an
     * error on one of its requirements): walk the first-reacher parents to the
     * root, as `annotate` does for fetch failures. A ROOT_REQUIRER requirer
     * means the erring requirement is itself a root — it is its own root. */
    const rootPkgOf = (requirer: string, ownPkg: string): string => {
      if (requirer === ROOT_REQUIRER) {
        return ownPkg;
      }
      let rootId = requirer;
      for (let parent = nodeParents.get(rootId); parent && parent !== ROOT_REQUIRER; parent = nodeParents.get(parent)) {
        rootId = parent;
      }
      return rootId.substring(0, rootId.lastIndexOf("@"));
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
        constraint = domain.parseConstraint(req.constraint);
      } catch {
        /* An unparseable constraint is reported at the reachability walk
         * (followEdge), not here: the fixpoint walk visits superseded/pruned
         * requirements too, and a bad constraint in one that doesn't survive
         * pruning must not fail the whole resolution. followEdge reparses the
         * constraint anyway (deterministically the same error) on exactly the
         * edges that are in effect, so reporting there is both truthful and free. */
        return;
      }
      if (req.override === "alternate") {
        /* Attach-LAST (the mirror of a peer's attach-first): an alternate
         * demands nothing and shapes nothing — unless the converged tree
         * requires the package ONLY floorlessly, where no version is
         * selectable deterministically; then the written alternate supplies
         * one (fired at quiescence, like the other convergence repairs).
         * Recorded here; never an ordinary demand. */
        const version = domain.minimumOf(constraint);
        const current = alternateAnswers.get(req.pkg);
        if (current === undefined || domain.compare(version, current) > 0) {
          alternateAnswers.set(req.pkg, version);
        }
        return;
      }
      const forcedVersion = forced.get(req.pkg);
      if (forcedVersion !== undefined) {
        /* Substitution: whatever this requirement asked for, the forced
         * version is what it gets — its own floor is never offered (nor its
         * version's metadata fetched). The original constraint is judged at
         * convergence: unsatisfied means coerced, recorded as data. The force
         * root's own edge is the one demand offered to the pool, so the
         * principal is the forced version by construction. */
        if (req.override === "force") {
          attempt(req, forcedVersion, requiredBy);
        } else {
          visit(req.pkg, forcedVersion, requiredBy, req);
        }
        return;
      }
      if (domain.isFloorless(constraint)) {
        /* No lower bound ('*', or an upper-bound-only range): contributes no
         * selection of its own, and is satisfied by whatever the floored
         * requirements select (resolved during the convergence rounds, where
         * any upper bound is still violation-checked; a floorless-only package
         * is an error there — unless a written alternate supplies the version,
         * for which the package is remembered here). */
        floorlessRequired.add(req.pkg);
        return;
      }
      if (req.soft) {
        softReqs.push({ req, requiredBy });
        return;
      }
      attempt(req, domain.minimumOf(constraint), requiredBy);
    };

    /** Canonical order on requirement edges, for breaking a tie between two
     * requirements demanding the same winning floor: `selectedBy` must be a
     * function of the requirement set, not of which fetch landed first. */
    const edgeOrder = (edge: IRequirementEdge): string => `${edge.requiredBy}\n${edge.constraint}`;

    /** Offer `version` as a lower bound for the package (a requirement's
     * declared minimum, or its raised floor): it is selected iff it beats the
     * current principal, and expanded either way — a demanded version
     * contributes its own requirements to the graph even when it loses (see
     * the Go MVS note above; `visit` dedups, so each pkg@version is fetched
     * once). */
    const attempt = (req: Requirement, version: V, requiredBy: string): void => {
      const current = selected.get(req.pkg);
      const edge: IRequirementEdge = { requiredBy, constraint: req.constraint };
      const order = current === undefined ? 1 : domain.compare(version, current.version);
      if (order > 0 || (order === 0 && current!.selectedBy !== undefined && edgeOrder(edge) < edgeOrder(current!.selectedBy))) {
        selected.set(req.pkg, { pkg: req.pkg, version, selectedBy: edge });
      }
      visit(req.pkg, version, requiredBy, req);
    };

    /**
     * The demanded version was never published: raise each of `demands`'
     * contribution to the lowest published version satisfying its constraint
     * (re-offered through the normal max-of-minimums rule). A requirement
     * nothing published satisfies raises nothing, so the node keeps its
     * unpublished declared version — tolerated here and judged at convergence
     * exactly as in phase 1, since the walk expands superseded versions too
     * and an unrepairable floor on one of those never mattered. One an
     * in-effect edge still needs at convergence is the terminal failure.
     *
     * Takes the demands to repair rather than reading them off the node,
     * because they arrive on both sides of the registry's answer: the demands
     * known when it lands are repaired together, and each later one is repaired
     * as it arrives. The caller holds a `pending` token for the duration.
     */
    const raiseFloors = (pkg: string, version: V, demands: Demand[]): void => {
      /* Each (node, demand) is raised once. Since the raise is a pure function
       * of the two, re-raising could only repeat itself — and would not
       * terminate if the hook offers a version the registry then rejects in
       * turn (the offer is re-demanded, found already demanded, and repaired
       * again). Termination is otherwise by the finite demand set. */
      const id = nodeId(pkg, version);
      const fresh = demands.filter(demand => {
        const signature = `${id}\n${demand.requiredBy}\n${demand.req.constraint}`;
        if (raisedDemands.has(signature)) {
          return false;
        }
        raisedDemands.add(signature);
        return true;
      });
      /* A repair that cannot be evaluated at all (the hook itself failed — an
       * unreachable registry, say) is attributed like the metadata failure that
       * provoked it: it belongs to the same node, so it must reach the consumer
       * pointing at the requirement chain that demanded it, not bare against
       * the target being built. */
      Computable.forAll(
        fresh.map(demand =>
          registry.lowestAvailable!(pkg, demand.req.constraint).then(raised => {
            /* Nothing published satisfies the constraint at all: the demand
             * contributes nothing further and its phantom stays the slot
             * winner, reported at convergence (terminal, since this node is
             * armed) if an in-effect edge still needs it. */
            if (raised === undefined) {
              return;
            }
            /* The raise re-offers the constraint's answer through the normal
             * max rule. The request was for the constraint, and the first
             * published version meeting it is an acceptable answer, whatever
             * major it lives in (npm: '>=5' where the 5.x line was never
             * published raises into major 6); edges bind by satisfaction, so
             * the moved demand cannot vanish from the delivered closure. */
            candidateRaises.push({ pkg, constraint: demand.req.constraint, declared: version, raised, requiredBy: demand.requiredBy });
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
     * The registry's verdict that pkg@version was never published, applied to
     * the demands recorded so far: repaired by floor raises when the phase and
     * registry allow it, else tolerated as an unexpandable pending selection
     * (judged at convergence — only one an in-effect edge still needs proves
     * repair is required). Consumes the `pending` token the caller holds for
     * the node.
     */
    const nodeNotPublished = (id: string, pkg: string, version: V, err: VersionNotFoundError): void => {
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
     * the failing node: walk the first-reacher parents back to a root. The
     * first reacher may be a later-superseded version — still a truthful
     * "required by" trace, and the only one available if the walk cannot finish.
     */
    const annotate = (id: string, pkg: string, version: V, err: unknown): MetadataFetchError => {
      const path: string[] = [];
      for (let parent = nodeParents.get(id); parent && parent !== ROOT_REQUIRER; parent = nodeParents.get(parent)) {
        path.push(parent);
      }
      const rootId = path.at(-1) ?? id;
      const rootPkg = rootId.substring(0, rootId.lastIndexOf("@"));
      return new MetadataFetchError(pkg, domain.versionToString(version), path, rootPkg, toError(err));
    };

    const visit = (pkg: string, version: V, requiredBy: string, req: Requirement): void => {
      const id = nodeId(pkg, version);
      const entry: Demand = { req, requiredBy };
      const demands = nodeDemands.get(id);
      if (demands) {
        /* Metadata already demanded (or resolved); record the demand for raise
         * attribution should the node turn out unpublished — or repair it now
         * if that answer is already in, so a demand is treated the same either
         * side of it. */
        demands.push(entry);
        const known = notPublished.get(id);
        if (known && canRepair(id)) {
          pending++;
          raiseFloors(pkg, version, [entry]);
        }
        return;
      }
      nodeDemands.set(id, [entry]);
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
        registry.getRequirements(pkg, version).then(requirements => {
          nodeRequirements.set(id, requirements);
          for (const req of requirements) {
            enqueue(req, id);
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
     * Quiescence gate: before judging the converged tree, fire any deferred
     * soft requirement whose package the tree selects nothing for — as an
     * ordinary demand, stripped of softness — and keep walking. Judged at
     * quiescence so the outcome is a function of the converged state, not of
     * visit order (the same discipline as the repair phases); a fired demand
     * may itself declare more soft requirements, so this repeats until quiet.
     */
    const settle = (): void => {
      if (failed) {
        return;
      }
      const selectedPkgs = new Set([...selected.values()].map(sel => sel.pkg));
      /* Attach-last alternates: a package the converged tree requires only
       * floorlessly (nothing selects it) takes its written `?` version — the
       * deterministic answer the requirements alone cannot give. "Selects" is
       * judged over PUBLISHED selections, the same view judgeConverged takes:
       * a phantom occupying the slot is no deliverable answer, so its package
       * still wants the alternate. (The soft-req guard keeps the full view
       * deliberately — a phantom's demand is still a demand, answered by the
       * raise machinery, not by installing the peer.) */
      const publishedPkgs = new Set(
        [...selected.values()].filter(sel => !notPublished.has(nodeId(sel.pkg, sel.version))).map(sel => sel.pkg)
      );
      const firing = softReqs.filter(entry => !softFired.has(entry) && !selectedPkgs.has(entry.req.pkg));
      const supplying = [...alternateAnswers].filter(
        ([pkg]) => !alternateFired.has(pkg) && floorlessRequired.has(pkg) && !publishedPkgs.has(pkg)
      );
      if (firing.length === 0 && supplying.length === 0) {
        finish();
        return;
      }
      pending++;
      for (const entry of firing) {
        softFired.add(entry);
        enqueue({ pkg: entry.req.pkg, constraint: entry.req.constraint }, entry.requiredBy);
      }
      for (const [pkg, version] of supplying) {
        alternateFired.add(pkg);
        /* A phantom in the slot (an unpublished floor from a superseded
         * demand) must not out-floor the supplied answer — evict it so the
         * supply reads as the root selection it is. An in-effect edge that
         * genuinely needed the phantom still fails at convergence: it now
         * judges against the supplied version and violates. */
        const current = selected.get(pkg);
        if (current && notPublished.has(nodeId(current.pkg, current.version))) {
          selected.delete(pkg);
        }
        attempt({ pkg, constraint: domain.versionToString(version) }, version, ROOT_REQUIRER);
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

    /** Everything one convergence round judges of the quiet walk: the
     * reachable graph and its attributions, the violations against the
     * principals, and the edges no current selection satisfies (the packing
     * input). */
    interface Round {
      selectionsByPkg: Map<string, Selected<V>[]>;
      reachable: Map<Selected<V>, Selected<V>>;
      violations: Violation<V>[];
      coerced: Violation<V>[];
      unsatisfied: PackEdge[];
      errors: Map<string, IResolutionError>;
    }

    /**
     * The fixpoint walk visits the requirements of superseded versions too, so
     * each convergence round recomputes reachability through the *published*
     * selections only, following each edge's binding: this prunes packages
     * dragged in solely by superseded versions, validates upper bounds only
     * for requirements actually in effect, and reaches forks exactly through
     * the violated edges bound to them. Undefined when the round failed the
     * walk instead (a needed phantom — terminal, or the armed-rerun signal).
     */
    const judgeConverged = (): Round | undefined => {
      /* The selections of each package: the principal first (published only —
       * an unpublished slot winner, a phantom, is no deliverable answer, so
       * edges resolve against the published selections; a phantom an in-effect
       * edge still *needs* is detected below, where the edge finds no
       * candidates at all), then the forks in their canonical creation order.
       * The map's iteration order is not consumed — reachability order comes
       * from the roots and each node's declared requirement order. */
      const selectionsByPkg = new Map<string, Selected<V>[]>();
      for (const selection of selected.values()) {
        if (notPublished.has(nodeId(selection.pkg, selection.version))) {
          continue;
        }
        selectionsByPkg.set(selection.pkg, [selection]);
      }
      for (const [pkg, packed] of forks) {
        /* A principal CAN go phantom after its forks were created — a fork
         * subtree's expansion can raise the pool to an unpublished floor.
         * Dropping the forks with it is deliberate: the round then sees no
         * candidates for the package, records the needed phantom below, and
         * the armed rerun rebuilds fork state from scratch against the
         * repaired principal. */
        selectionsByPkg.get(pkg)?.push(...packed);
      }

      const errors = new Map<string, IResolutionError>();
      const violations: Violation<V>[] = [];
      const coerced: Violation<V>[] = [];
      const unsatisfied: PackEdge[] = [];
      /* Reachable selections, each annotated (as a copy) with how it was
       * first reached; keyed by the underlying selection instance */
      const reachable = new Map<Selected<V>, Selected<V>>();
      const visited = new Set<string>();
      /* Alternate roots are not demands: an unfired one has (by design) no
       * selection to lead to, so it is no reachability edge either. */
      const demandRoots = roots.filter(root => root.override !== "alternate");
      const queue: Array<{ from: string; requirements: Requirement[] }> = [{ from: ROOT_REQUIRER, requirements: demandRoots }];
      /* Phantoms an in-effect edge still needs — an edge for which no published
       * selection exists at all, whose slot winner the registry never
       * published. The proof the tree is unresolvable without repair: unarmed
       * ones become the next walk's repairable set, armed ones are terminal. */
      const neededPhantoms = new Map<string, { pkg: string; version: V; err: VersionNotFoundError }>();

      const followEdge = (from: string, req: Requirement): void => {
        let constraint: C;
        try {
          constraint = domain.parseConstraint(req.constraint);
        } catch (err) {
          /* An unparseable constraint on an edge that is actually in effect
           * (reachable through selected versions): report it here, where
           * pruning has already dropped superseded/unreachable requirements. */
          const message = `${toError(err).message} in requirement '${req.pkg}: ${req.constraint}' (required by ${from})`;
          errors.set(message, { message, rootPkg: rootPkgOf(from, req.pkg) });
          return;
        }
        const candidates = selectionsByPkg.get(req.pkg) ?? [];
        if (candidates.length === 0 && domain.isFloorless(constraint)) {
          const message =
            `'${req.pkg}' is required by ${from} without a version lower bound ('${req.constraint}'),` +
            ` and no versioned requirement for it exists — add one explicitly`;
          errors.set(message, { message, rootPkg: rootPkgOf(from, req.pkg), pkg: req.pkg, requiredBy: from });
          return;
        }
        if (candidates.length === 0) {
          /* No published selection of the package at all. For a floored edge
           * that means its slot winner is a phantom (an unpublished declared
           * floor nothing yet raised or satisfied) — every constrained demand
           * otherwise leaves a published selection the binding rule reaches.
           * Record it for the convergence judgment; anything else is a real
           * internal error, reported rather than dropped — a resolution that
           * lost a dependency must never look complete. */
          const winner = selected.get(req.pkg);
          const winnerId = winner && nodeId(winner.pkg, winner.version);
          const phantomErr = winnerId !== undefined ? notPublished.get(winnerId) : undefined;
          if (winner && winnerId !== undefined && phantomErr) {
            neededPhantoms.set(winnerId, { pkg: winner.pkg, version: winner.version, err: phantomErr });
            return;
          }
          const message = `internal error: requirement '${req.pkg}: ${req.constraint}' (required by ${from}) matches no selection`;
          errors.set(message, { message, rootPkg: rootPkgOf(from, req.pkg) });
          return;
        }
        /* A violation is judged against the PRINCIPAL — what a flat delivery
         * ships — whether or not a fork repairs the edge (the fork is the
         * repair record; strict mode reports the violation). A FORCED
         * package's unsatisfied edges are instead COERCED — the force
         * suppresses the conflict by design, so they are recorded as data and
         * never packed into forks. The packing input is stricter than the
         * violation judgment: an edge no current selection satisfies at all. */
        const forcedPkg = forced.has(req.pkg);
        const principal = candidates.find(sel => !sel.fork);
        const bound = edgeBinding(domain, candidates, req)!;
        /* Judged against the flat winner when there is one; a package whose
         * principal went phantom (candidates are forks alone) is judged
         * against what actually ships — an edge satisfied by neither must
         * still record, or an unsatisfiable delivery would look clean. */
        const judged = principal ?? bound;
        if (!domain.satisfies(judged.version, constraint)) {
          (forcedPkg ? coerced : violations).push({ pkg: req.pkg, constraint: req.constraint, requiredBy: from, selected: judged.version });
        }
        if (!forcedPkg && !domain.satisfies(bound.version, constraint)) {
          unsatisfied.push({ req, requiredBy: from, constraint });
        }
        if (!reachable.has(bound)) {
          reachable.set(bound, { ...bound, reachedVia: { requiredBy: from, constraint: req.constraint } });
          const id = nodeId(bound.pkg, bound.version);
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

      /* Convergence judgment on tolerated unpublished versions: one an
       * in-effect edge still needs (collected by followEdge above) means the
       * tree is unresolvable without repair. Those the hook was not armed for
       * are handed back as the next walk's repairable set (only they need
       * raising — see resolveMVS); one that WAS armed has already had its
       * turn, so nothing published satisfies it and the failure is terminal.
       * Phantoms every edge resolved past — superseded, pruned, raised away,
       * or answered by an existing satisfying selection — never mattered and
       * are dropped silently. Ordered by node id so the reported failure
       * doesn't depend on which metadata answer landed first. */
      if (neededPhantoms.size > 0) {
        const needed = [...neededPhantoms.entries()].sort(([a], [b]) => compareText(a, b));
        /* A forced package's phantom is terminal outright — the user pinned
         * the version, so arming a raise for it would be a pointless rerun. */
        const unarmed = needed.filter(([id, info]) => !repairable.has(id) && !forced.has(info.pkg)).map(([id]) => id);
        const [id, info] = needed[0];
        fail(
          registry.lowestAvailable && unarmed.length > 0
            ? new RepairsRequired(unarmed)
            : annotate(id, info.pkg, info.version, info.err)
        );
        return undefined;
      }
      return { selectionsByPkg, reachable, violations, coerced, unsatisfied, errors };
    };

    /** What one packing pass did: demanded new metadata / requested raises
     * (async — the walk continues and re-converges), created forks, or marked
     * edges unrepairable (both sync — the convergence loop re-judges). */
    interface PackStep {
      asyncWork: boolean;
      progressed: boolean;
    }

    /**
     * Pack the violated edges no current selection satisfies into new fork
     * selections: greedy first-fit per package in canonical edge order, a
     * candidate version being the max of its members' floors (the MVS rule
     * applied to the edges the principal cannot serve), admitted only while it
     * satisfies every member. A candidate's floor was necessarily demanded
     * already (every floored requirement's minimum is visited), so its
     * published status is known at quiescence: published → the fork is created
     * outright; unpublished → its floor is raised (no arming — the converged
     * violations are the proof of need), and the raised version is demanded so
     * the fork lands once its metadata answers. An edge whose class can offer
     * no published satisfier is marked unrepairable and stays a bare
     * violation. A floorless violated edge (an upper-bound-only range the
     * principal exceeds) has no floor to propose and goes straight to the
     * raise hook.
     */
    const packForks = (unsatisfied: PackEdge[]): PackStep => {
      const step: PackStep = { asyncWork: false, progressed: false };
      const edgeSig = (edge: PackEdge): string => `${edge.req.pkg}\n${edge.req.constraint}`;
      /* Canonical packing order; identical (pkg, constraint) edges collapse
       * (satisfaction does not depend on the requirer — keep the first, whose
       * requiredBy is canonical, for attribution). */
      const seen = new Set<string>();
      const edges = unsatisfied
        .filter(edge => !unrepairable.has(edgeSig(edge)))
        .sort(
          (a, b) =>
            compareText(a.req.pkg, b.req.pkg) || compareText(a.req.constraint, b.req.constraint) || compareText(a.requiredBy, b.requiredBy)
        )
        .filter(edge => {
          const sig = edgeSig(edge);
          if (seen.has(sig)) {
            return false;
          }
          seen.add(sig);
          return true;
        });

      /** The raise answer for a fork candidate constraint, requesting it on
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
        registry.lowestAvailable(pkg, constraint)
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

      /** Create the fork, or demand what it still needs: `declared` is the
       * class's max-of-floors, undefined when `candidate` is already a raise's
       * answer (a floorless class's, or the recursive call's) — in which case
       * a 404 on it is terminal for the edge, not a second raise (the hook
       * would only repeat the same offer). */
      const forkAt = (candidate: V, declared: V | undefined, floorEdge: PackEdge): void => {
        const id = nodeId(floorEdge.req.pkg, candidate);
        if (!nodeDemands.has(id)) {
          /* A raised candidate nothing yet demanded: expand it; the fork is
           * created next round, when its metadata (hence subtree) is known. */
          step.asyncWork = true;
          visit(floorEdge.req.pkg, candidate, floorEdge.requiredBy, floorEdge.req);
          return;
        }
        if (notPublished.has(id)) {
          if (declared === undefined) {
            /* The raise's own offer was rejected by the registry: re-asking
             * could only repeat it, so the edge is unrepairable. */
            unrepairable.add(edgeSig(floorEdge));
            step.progressed = true;
            return;
          }
          /* The class floor itself was never published: raise it. */
          const answer = raiseAnswer(floorEdge.req.pkg, floorEdge.req.constraint, floorEdge);
          if (answer === "pending") {
            step.asyncWork = true;
            return;
          }
          if (answer === null) {
            /* Nothing published satisfies this edge — it stays a bare
             * violation; any other members repack without it next round. */
            unrepairable.add(edgeSig(floorEdge));
            step.progressed = true;
            return;
          }
          candidateRaises.push({
            pkg: floorEdge.req.pkg,
            constraint: floorEdge.req.constraint,
            declared,
            raised: answer,
            requiredBy: floorEdge.requiredBy,
          });
          forkAt(answer, undefined, floorEdge);
          return;
        }
        const packed = forks.get(floorEdge.req.pkg) ?? [];
        forks.set(floorEdge.req.pkg, packed);
        packed.push({
          pkg: floorEdge.req.pkg,
          version: candidate,
          selectedBy: { requiredBy: floorEdge.requiredBy, constraint: floorEdge.req.constraint },
          fork: packed.length + 1,
        });
        step.progressed = true;
      };

      /* First-fit classes per package, this round. A class holds the members
       * packed so far and the floor (+ its contributing edge) that is its
       * candidate. */
      interface NewClass {
        floor: V;
        floorEdge: PackEdge;
        members: PackEdge[];
      }
      const classesByPkg = new Map<string, NewClass[]>();
      for (const edge of edges) {
        const pkg = edge.req.pkg;
        /* A fork created earlier in this very pass may already cover it */
        if ((forks.get(pkg) ?? []).some(fork => domain.satisfies(fork.version, edge.constraint))) {
          continue;
        }
        if (domain.isFloorless(edge.constraint)) {
          /* No floor to propose: the raise hook picks the lowest published
           * satisfier (its own singleton class — a capped floorless range is
           * rare enough not to share). */
          const answer = raiseAnswer(pkg, edge.req.constraint, edge);
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
        const floor = domain.minimumOf(edge.constraint);
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
      /* Mark, for each root, which selections it (transitively) reaches,
       * following the same bindings reachability followed. */
      const targetsOf = (req: Requirement): Selected<V> | undefined =>
        edgeBinding(domain, round.selectionsByPkg.get(req.pkg) ?? [], req);
      roots.forEach((root, rootIndex) => {
        if (root.override === "alternate") {
          /* Never requested as a delivery of its own; the supplied selection
           * is reached (and marked) through the floorless edges that need it. */
          return;
        }
        const visitedNodes = new Set<string>();
        const mark = (requirements: Requirement[]): void => {
          for (const req of requirements) {
            const target = targetsOf(req);
            const selection = target && round.reachable.get(target);
            if (!selection) {
              continue;
            }
            const from = (selection.reachableFrom ??= []);
            if (!from.includes(rootIndex)) {
              from.push(rootIndex);
            }
            const id = nodeId(selection.pkg, selection.version);
            if (!visitedNodes.has(id)) {
              visitedNodes.add(id);
              mark(nodeRequirements.get(id) ?? []);
            }
          }
        };
        mark([root]);
      });

      const selections = [...round.reachable.values()].sort((a, b) => {
        if (a.pkg !== b.pkg) {
          return a.pkg < b.pkg ? -1 : 1;
        }
        return domain.compare(a.version, b.version);
      });
      /* A package whose ONLY reachable version is a fork has no divergence at
       * all: its principal was a phantom of the whole-closure pool (a
       * superseded node's floor that no in-effect edge ever bound — pruned
       * above), so the single shipping version IS the selection. Promote it,
       * and drop the violations judged against the pruned phantom — with one
       * version delivered and every in-effect edge bound to it, there is
       * nothing to sanction. (A package with several surviving forks keeps
       * them: that is a real divergence.) */
      const perPkg = new Map<string, Selected<V>[]>();
      for (const selection of selections) {
        perPkg.set(selection.pkg, [...(perPkg.get(selection.pkg) ?? []), selection]);
      }
      const promoted = new Map<string, V>();
      for (const [pkg, group] of perPkg) {
        if (group.length === 1 && group[0].fork !== undefined) {
          group[0].fork = undefined;
          promoted.set(pkg, group[0].version);
        }
      }
      /* Dropped only where moot: an edge the PROMOTED version satisfies was
       * never really in conflict. One it does not satisfy (an unrepairable
       * range beside the repaired ones) remains a violation — re-pointed at
       * the version actually shipping, not the pruned phantom. */
      const violations = round.violations.flatMap(violation => {
        const promotedVersion = promoted.get(violation.pkg);
        if (promotedVersion === undefined) {
          return [violation];
        }
        try {
          return domain.satisfies(promotedVersion, domain.parseConstraint(violation.constraint))
            ? []
            : [{ ...violation, selected: promotedVersion }];
        } catch {
          return [];
        }
      });
      /* Canonical fork indices: per package, ascending version order among the
       * reachable forks — the walk's creation order got them into the graph,
       * but the persisted identity must not depend on it. */
      const forkCount = new Map<string, number>();
      for (const selection of selections) {
        if (selection.fork !== undefined) {
          const next = (forkCount.get(selection.pkg) ?? 0) + 1;
          forkCount.set(selection.pkg, next);
          selection.fork = next;
        }
      }
      /* Keep only the raises that shaped the result: the raised version must
       * be a reachable selection (a raise superseded by a higher floor —
       * possibly a root pin that answered the request itself — or pruned with
       * a superseded subtree, never mattered) — then dedup identical
       * (pkg, constraint) raises from parallel demands, in a canonical order
       * (they are pushed as the registry answers). */
      const raiseKeys = new Set<string>();
      const ordered = [...candidateRaises].sort(
        (a, b) => compareText(a.pkg, b.pkg) || compareText(a.constraint, b.constraint) || compareText(a.requiredBy, b.requiredBy)
      );
      const raises = ordered.filter(raise => {
        const winner = selections.some(sel => sel.pkg === raise.pkg && domain.compare(sel.version, raise.raised) === 0);
        const dedup = `${raise.pkg}\n${raise.constraint}`;
        if (!winner || raiseKeys.has(dedup)) {
          return false;
        }
        raiseKeys.add(dedup);
        return true;
      });
      /* The edges of the *selected* graph, for a consumer laying the result
       * out: the requirements of every surviving node (forks included), in the
       * selections' canonical order (superseded/pruned nodes are dropped with
       * their subtrees, exactly as the reachability walk dropped them). */
      const requirements = new Map<string, Requirement[]>(
        selections.map(sel => {
          const id = nodeId(sel.pkg, sel.version);
          return [id, nodeRequirements.get(id) ?? []];
        })
      );
      /* Candidates per package, in the canonical order — binding an edge only
       * ever considers selections of its own package, so this is what the walk
       * itself passes to edgeBinding (see targetsOf). Built locally: the
       * ResolutionGraph (which indexes the same way) wraps the *finished*
       * resolution, which this is still becoming. */
      const candidates = new Map<string, Selected<V>[]>();
      for (const selection of selections) {
        const held = candidates.get(selection.pkg);
        if (held) {
          held.push(selection);
        } else {
          candidates.set(selection.pkg, [selection]);
        }
      }
      /* Where each of those edges LEADS, resolved once here rather than by
       * every consumer: the delivery walks this instead of searching the
       * selections per edge. Computed after the fork renumbering above, so the
       * ids it names are the persisted ones. */
      const edges = new Map<string, Map<string, string>>(
        selections.map(sel => {
          const from = new Map<string, string>();
          for (const req of requirements.get(nodeId(sel.pkg, sel.version)) ?? []) {
            /* The requirer's own name for the edge — first declaration wins, as
             * the layout reads it. */
            const name = req.alias ?? req.pkg;
            if (from.has(name)) {
              continue;
            }
            const target = edgeBinding(domain, candidates.get(req.pkg) ?? [], req);
            if (target) {
              from.set(name, nodeId(target.pkg, target.version));
            }
          }
          return [nodeId(sel.pkg, sel.version), from];
        })
      );
      /* A root binds against what it reaches, not against everything: a fork
       * packed for some other root's violated edge must not answer this one.
       * Recorded as a position in `selections`, which is what a delivery needs
       * to reach the node without a table of its own. */
      const rootBindings = roots.map((root, rootIndex) => {
        if (root.override === "alternate") {
          return undefined;
        }
        const reachable = (candidates.get(root.pkg) ?? []).filter(sel => sel.reachableFrom?.includes(rootIndex));
        const bound = edgeBinding(domain, reachable, root);
        const at = bound === undefined ? -1 : selections.indexOf(bound);
        return at < 0 ? undefined : at;
      });
      resolve({
        selections,
        errors: [...round.errors.values()],
        violations,
        coerced: round.coerced,
        raises,
        requirements,
        edges,
        rootBindings,
      });
    };

    /**
     * Judge the quiet walk, pack forks for what the judgment cannot satisfy,
     * and either finalize (nothing left to pack), keep walking (packing
     * demanded metadata or a raise — finish re-runs at the next quiescence),
     * or loop (packing changed the graph synchronously — forks created or
     * edges retired — so the judgment must re-run).
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
