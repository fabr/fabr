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

import { compareVersions, parseConstraint, SemverConstraint, SemverVersion } from "@fabr-build/core";

/** A dependency spec as a package manager reads it. */
export type Spec =
  /** A registry package: `packageName` is the name it is published under,
   * which an alias (`npm:real@^1`) makes another than the dependency's. */
  | { readonly kind: "registry"; readonly packageName: string; readonly range: string; readonly patched?: boolean }
  /** A workspace package (`workspace:*`, `workspace:^`, `workspace:../x`). */
  | { readonly kind: "workspace" }
  /** A pnpm catalog's entry (`catalog:`, `catalog:<name>`). */
  | { readonly kind: "catalog"; readonly catalog: string }
  /** A dist-tag (`latest`, `next`), which fabr does not read. */
  | { readonly kind: "tag"; readonly tag: string }
  /** Anything else: a file, link, git or tarball URL, which fabr reads no registry for. */
  | { readonly kind: "other" };

/** @return the constraint `range` states, or undefined where it is no semver range. */
export function constraintOf(range: string): SemverConstraint | undefined {
  try {
    return parseConstraint(range);
  } catch {
    return undefined;
  }
}

/** Read the spec `text`, written for the dependency `name`. */
export function parseSpec(name: string, text: string): Spec {
  const spec = text.trim();
  if (spec.startsWith("workspace:")) {
    return { kind: "workspace" };
  }
  if (spec.startsWith("catalog:")) {
    const catalog = spec.slice("catalog:".length);
    return { kind: "catalog", catalog: catalog === "" ? "default" : catalog };
  }
  if (spec.startsWith("patch:")) {
    /* yarn's `patch:name@npm%3A1.2.3#…`: the package patched, read as the spec it patches. */
    const inner = decodeURIComponent(spec.slice("patch:".length).replace(/#.*$/, ""));
    const at = inner.lastIndexOf("@");
    const patched = at > 0 ? parseSpec(inner.slice(0, at), inner.slice(at + 1)) : undefined;
    return patched?.kind === "registry" ? { ...patched, patched: true } : { kind: "other" };
  }
  if (spec.startsWith("npm:")) {
    const target = spec.slice("npm:".length);
    if (constraintOf(target) !== undefined) {
      return { kind: "registry", packageName: name, range: target };
    }
    const at = target.lastIndexOf("@");
    return at > 0
      ? { kind: "registry", packageName: target.slice(0, at), range: target.slice(at + 1) || "*" }
      : { kind: "registry", packageName: target, range: "*" };
  }
  if (/^(file:|link:|portal:|git\+|git:|github:|gitlab:|bitbucket:|https?:|ssh:|exec:)/.test(spec) || /^[^@\s][^\s]*\/[^\s]+$/.test(spec)) {
    return { kind: "other" };
  }
  const range = spec === "" || spec === "latest" ? undefined : spec;
  if (range !== undefined && constraintOf(range) !== undefined) {
    return { kind: "registry", packageName: name, range };
  }
  return { kind: "tag", tag: spec === "" ? "latest" : spec };
}

/** @return the lowest version `constraint` admits: its least lower bound. */
export function floorOf(constraint: SemverConstraint): SemverVersion {
  return constraint.ranges.map(range => range.min).reduce((low, each) => (compareVersions(each, low) < 0 ? each : low));
}

/** @return true if `range` has no lower bound (`*`, `<4.1.0`), otherwise false. */
export function isFloorless(range: string): boolean {
  const constraint = constraintOf(range);
  if (constraint === undefined) {
    return false;
  }
  const floor = floorOf(constraint);
  return floor.major === 0 && floor.minor === 0 && floor.patch === 0 && floor.prerelease.length === 0;
}

/** @return `range` as a fabr reference writes it: as it is where it is plain, quoted where it holds
 * a character the reference grammar reads (a space, `<`, `>`, `|`). */
export function rangeText(range: string): string {
  return /^[\w.^~*+-]+$/.test(range) ? range : JSON.stringify(range);
}
