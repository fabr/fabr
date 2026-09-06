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
 * Check and emit the files a change actually reaches (see DESIGN-file-deps.md).
 * A change's frontier stops wherever the edge target's interface artifact is
 * unchanged, following forwarding edges transitively and use edges one hop —
 * two kinds, because a type can flow through a declaration whose bytes never
 * moved.
 *
 * All checking happens against one program built from the current sources, so a
 * waved file in an import cycle sees its partner's live types. The base is
 * always green, a red cycle committing no entry, so the wave never resumes from
 * a broken state.
 *
 * This module is the driver's and must not import fabr; the plan it walks is
 * the driver's own (Planning.ts).
 */

import { DriverMemo, ICompilePlan, IMemoEdge } from "./Planning";

/** What the wave needs of the world around it — supplied by the driver, which
 * owns the program, the resolution and the emit. */
export interface IWaveHost {
  /** Every project file this compile holds, by node name: the wave's
   * universe when global scope forces it wide. */
  projectFiles(): string[];
  /** How to build a wave member — check and emit it, answering whether what
   * its consumers can see of it changed: its emitted declaration against the
   * base build's, or, for a file that emits no interface artifact, whether its
   * own content moved (which the plan's seeds already state). Undefined where
   * there is nothing to build: a deleted file, or a dependency's declaration
   * (which this compile reads but never emits). */
  fileFor(name: string): (() => boolean) | undefined;
  /** Whether the file now at `name` affects global scope — asked of the file's
   * NEW form, since removing a global declaration changes global scope just as
   * adding one does. Undefined for a name with no file (a deletion). */
  isGlobal(name: string): boolean | undefined;
  /** What an edge of `from` names, resolved as this compile resolves — the
   * driver is the authority, so a memo edge that recorded no target is answered
   * rather than guessed at. */
  targetOf(from: string, edge: IMemoEdge): string | undefined;
  /** Whether THIS program is rooted at a subset of the project — the question
   * the plan's own bound cannot answer, since the caller's fallback hands the
   * same plan to a program rooted at everything. */
  isBoundRooted(): boolean;
  /** The wave is about to become every project file: the carried base output
   * tree cannot be incrementally corrected by a full emit (an output whose name
   * nothing current produces would linger), so the host discards it first. */
  expanding(): void;
}

/** What a wave run came to. */
export interface IWaveResult {
  /** The members, in the order the wave grew — the changed set first, then what
   * each shape change reached. */
  wave: string[];
  /** Why the wave was the whole project, where it was. */
  expanded?: { reason: string; cause?: string };
  /** Whether this run must be abandoned and redone rooted at every project file
   * — the change turned out to affect global scope, which a bound-rooted program
   * cannot answer for. */
  fellBack?: boolean;
}

/**
 * Run the wave: build each member, and extend by the interface rule until
 * nothing new is reached.
 *
 * A member expands the wave when what its consumers can see of it has changed:
 *
 * - a **deleted** file, or a changed **dependency declaration**, always — the
 *   first has a shape of nothing (which differs from whatever it was), and the
 *   second is in the seeds precisely because its bytes moved;
 * - a **project file** whose build answers that its interface moved. A file the
 *   base never emitted for (an addition) counts as differing: there is no
 *   artifact to have matched.
 *
 * Expansion follows the plan's own edges — the base build's memo, which is the
 * only account of the world the wave has for the files it is not building.
 */
export function runWave(plan: ICompilePlan, host: IWaveHost): IWaveResult {
  /* A plan with no seeds is a full compile decided before this run began (cold,
   * or a change no edge can bound); the emit tree was started fresh, so there
   * is no expansion to decide and nothing to fall back from. */
  const everything = plan.seeds === undefined;
  const expanded = everything ? undefined : globalExpansion(plan.seeds!, plan.memo, host);
  if (expanded !== undefined && host.isBoundRooted()) {
    /* Global scope is all-or-nothing and a bound-rooted program does not hold
     * every project file, so nothing here can be trusted. The plan catches a
     * file that WAS global; this is the one only parsing reveals.
     *
     * Ask what THIS program is rooted at, never what the plan bounded: the
     * rebuild gets the same plan, so a guard reading it bails again, and a bail
     * emits nothing the caller would commit as a green empty delta. */
    return { wave: [], expanded, fellBack: true };
  }
  if (expanded !== undefined) {
    host.expanding();
  }
  const wave: string[] = [];
  const seen = new Set<string>();
  const pending = everything || expanded !== undefined ? host.projectFiles() : [...plan.seeds!];
  const forwarders = reverseEdges(plan.memo, host, "forwarding");
  const users = reverseEdges(plan.memo, host, "use");
  /* An index cursor rather than shift(): BFS order is wanted (the telemetry
   * reports the wave in growth order), and shift() is O(n) per dequeue —
   * quadratic over a whole-project expansion. */
  for (let at = 0; at < pending.length; at++) {
    const name = pending[at];
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    wave.push(name);
    const build = host.fileFor(name);
    /* Deleted, or a dependency's declaration that changed under us: both are in
     * the wave because their content moved, and neither has an interface
     * artifact of ours to compare — so both expand. */
    const changesInterface = build === undefined ? true : build();
    if (everything || expanded !== undefined || !changesInterface) {
      continue;
    }
    /* The conduits — everything that republishes this file's interface — and
     * then the bodies that consume each of them, one hop and no further. */
    for (const conduit of closure(name, forwarders)) {
      for (const affected of [conduit, ...(users.get(conduit) ?? [])]) {
        if (!seen.has(affected)) {
          pending.push(affected);
        }
      }
    }
  }
  return { wave, expanded };
}

/**
 * Whether this change bounds nothing — a file affecting **global scope**, whose
 * declarations are facts about the whole program rather than about anyone who
 * imports it. Nothing imports a global, so no edge can reach its dependents and
 * the only honest wave is every file.
 *
 * Judged against the memo's flag AND the file's new form, because both
 * directions count: adding a global declaration and removing one each change
 * what every other file sees.
 */
function globalExpansion(seeds: ReadonlySet<string>, memo: DriverMemo, host: IWaveHost): { reason: string; cause?: string } | undefined {
  for (const name of seeds) {
    if (memo.get(name)?.global === true) {
      return { reason: "a file that affected global scope changed", cause: name };
    }
    if (host.isGlobal(name) === true) {
      return { reason: "a changed file affects global scope", cause: name };
    }
  }
  return undefined;
}

/** The reverse of one edge kind over the plan's memo: for each node, who names
 * it. */
function reverseEdges(memo: DriverMemo, host: IWaveHost, kind: "use" | "forwarding"): Map<string, string[]> {
  const reverse = new Map<string, string[]>();
  for (const [name, file] of memo) {
    for (const edge of kind === "use" ? file.use : file.forwarding) {
      const target = host.targetOf(name, edge);
      if (target === undefined) {
        continue;
      }
      const dependers = reverse.get(target) ?? [];
      reverse.set(target, dependers);
      dependers.push(name);
    }
  }
  return reverse;
}

/** Everything that transitively republishes `name`, itself included. Grow-only,
 * so a forwarding cycle terminates. */
function closure(name: string, forwarders: ReadonlyMap<string, string[]>): Set<string> {
  const found = new Set<string>();
  const pending = [name];
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (found.has(next)) {
      continue;
    }
    found.add(next);
    for (const depender of forwarders.get(next) ?? []) {
      pending.push(depender);
    }
  }
  return found;
}
