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
 * The wave: check and emit the files a change reaches, starting from the
 * plan's seeds (see Planning.ts). A file whose interface changed reaches the
 * files importing it through forwarding edges (imports of emitted
 * declarations), directly or through other files, and the files with a use
 * edge (an import of a body) to it or to any of those. A file whose interface
 * did not change reaches nothing.
 *
 * Every file is checked in one program built from the current sources.
 *
 * This module must not import fabr.
 */

import { DriverMemo, ICompilePlan, IMemoEdge } from "./Planning";

/** The driver's side of a wave run: the program, resolution and emit. */
export interface IWaveHost {
  /** @return every project file this compile holds, by node name. */
  projectFiles(): string[];
  /** @return a function that checks and emits the file at `name` and returns
   * true if its interface changed: its emitted declaration differs from the
   * base build's (or the base emitted none for it), or, for a file that emits
   * no declaration, its content changed. Undefined for a deleted file or a
   * dependency's declaration, which this compile does not emit. */
  fileFor(name: string): (() => boolean) | undefined;
  /** @return true if the file now at `name` affects global scope, otherwise
   * false; undefined for a name with no file (a deletion). */
  isGlobal(name: string): boolean | undefined;
  /** @return the node name an edge of `from` resolves to in this compile, or
   * undefined where it resolves to none. */
  targetOf(from: string, edge: IMemoEdge): string | undefined;
  /** @return true if this program is rooted at the plan's bound rather than at
   * every project file, otherwise false. */
  isBoundRooted(): boolean;
  /** Prepare for the wave to become every project file: discard the base
   * build's outputs, so that none that no current source produces remains. */
  expanding(): void;
  /** @return true if this run is void, otherwise false: {@link fileFor} was
   * asked for a project file on disk that the program does not hold. Asked
   * after each member. */
  voided(): boolean;
}

/** The outcome of a wave run. */
export interface IWaveResult {
  /** The files checked, in the order they were reached: the seeds (or every
   * project file) first. */
  wave: string[];
  /** Present where the wave became every project file because a seed affects
   * global scope: why, and that seed. */
  expanded?: { reason: string; cause?: string };
  /** true if the run must be redone rooted at every project file: a seed
   * affects global scope and the program is rooted at the bound, or the run
   * was voided. */
  fellBack?: boolean;
}

/**
 * Run the wave: check and emit each member, adding the files each member's
 * change reaches, until no new file is reached.
 *
 * A member's interface counts as changed where it is deleted, is a
 * dependency's declaration (a seed because it changed), or the function
 * `host.fileFor` gives for it returns true. The edges followed are the base
 * build's memo's, resolved by `host.targetOf`.
 *
 * - A plan with no seeds (a full compile) checks every project file and
 *   follows no edge.
 * - Where a seed affects global scope, by its memo line or its current form,
 *   the wave is every project file, `expanded` says why, and `host.expanding`
 *   is called first. Where the program is rooted at the bound, the run instead
 *   returns at once, empty, with `fellBack`.
 * - Where `host.voided()` becomes true, the run stops with `fellBack`.
 */
export function runWave(plan: ICompilePlan, host: IWaveHost): IWaveResult {
  /* No seeds: a full compile, whose emit directory the driver already started
   * fresh. */
  const everything = plan.seeds === undefined;
  const expanded = everything ? undefined : globalExpansion(plan.seeds!, plan.memo, host);
  if (expanded !== undefined && host.isBoundRooted()) {
    /* A program rooted at the bound cannot check a change to global scope:
     * return, emitting nothing, for the caller to redo the run rooted at every
     * file. Ask the host what this program is rooted at, not the plan: the
     * redo is given the same plan. */
    return { wave: [], expanded, fellBack: true };
  }
  if (expanded !== undefined) {
    host.expanding();
  }
  const wave: string[] = [];
  const seen = new Set<string>();
  const whole = everything || expanded !== undefined;
  const pending = whole ? host.projectFiles() : [...plan.seeds!];
  /* Only a bounded wave follows edges; a whole-project one never reads them. */
  const forwarders = whole ? new Map<string, string[]>() : reverseEdges(plan.memo, host, "forwarding");
  const users = whole ? new Map<string, string[]>() : reverseEdges(plan.memo, host, "use");
  /* Breadth-first, the order `wave` reports. */
  for (let at = 0; at < pending.length; at++) {
    const name = pending[at];
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    wave.push(name);
    const build = host.fileFor(name);
    if (host.voided()) {
      /* What was emitted came from an incomplete program: stop, for the caller
       * to redo the run rooted at every file. */
      return { wave, fellBack: true };
    }
    /* A deleted file or a dependency's declaration has no emitted declaration
     * to compare: count its interface as changed. */
    const changesInterface = build === undefined ? true : build();
    if (whole || !changesInterface) {
      continue;
    }
    /* This file and every file importing it through forwarding edges, directly
     * or through others, and each file with a use edge to one of those. */
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
 * @return why the wave must be every project file, or undefined where it need
 * not: a seed that affected global scope in the base build (its memo line) or
 * does now (`host.isGlobal`), with that seed as `cause`.
 */
function globalExpansion(
  seeds: ReadonlySet<string>,
  memo: DriverMemo,
  host: IWaveHost
): { reason: string; cause?: string } | undefined {
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

/** @return for each node name, the files of the memo with an edge of `kind` to
 * it, as `host.targetOf` resolves them. */
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

/** @return `name` and every file importing it through forwarding edges,
 * directly or through other files. */
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
