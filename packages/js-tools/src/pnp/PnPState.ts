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

/* The serialized PnP table (`.pnp.data.json`): what the plugin writes for a
 * consumer and the resolver reads. */

/**
 * A dependency's target as PnP spells it: a bare reference when the name the
 * requirer uses is the depended-on package's own, a `[name, reference]` tuple
 * when it is an alias, and `null` for a peer nothing satisfied.
 */
export type PnpDependencyTarget = string | [string, string] | null;

/** One row's payload. `linkType` is advisory for consumers that copy rather
 * than link; a package's tree is a real directory, hence `HARD`. */
export interface IPnpPackageInfo {
  packageLocation: string;
  packageDependencies: Array<[string, PnpDependencyTarget]>;
  linkType: "HARD" | "SOFT";
  packagePeers?: string[];
  discardFromLookup?: boolean;
}

/**
 * The serialized manifest (`.pnp.data.json`), the subset of Yarn's state that
 * resolution actually consumes. `packageRegistryData` is a nested association
 * list — name → reference → info — with the top-level package keyed by a
 * `null` name and reference, exactly as Yarn writes it.
 */
export interface IPnpSerializedState {
  __info: string[];
  dependencyTreeRoots: Array<{ name: string; reference: string }>;
  enableTopLevelFallback: boolean;
  ignorePatternData: string | null;
  fallbackExclusionList: Array<[string, string[]]>;
  fallbackPool: Array<[string, PnpDependencyTarget]>;
  packageRegistryData: Array<[string | null, Array<[string | null, IPnpPackageInfo]>]>;
}
