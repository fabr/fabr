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
 */

/**
 * The PnP runtime API (https://yarnpkg.com/advanced/pnp-spec, and Yarn's
 * `pnpapi` module): the public interface a PnP-aware tool resolves through,
 * written out here so that implementing it takes no dependency on Yarn. Paths
 * are native paths.
 *
 * A failure is thrown as an `Error` carrying `pnpCode` (one of
 * {@link PnpErrorCode}) and `code` — `MODULE_NOT_FOUND` for a lookup that
 * found nothing, node's own code where node's algorithm failed.
 */

import type { PnpDependencyTarget } from "../PnPManifest";

export interface IPhysicalPackageLocator {
  name: string;
  reference: string;
}

export interface ITopLevelPackageLocator {
  name: null;
  reference: null;
}

export type PackageLocator = IPhysicalPackageLocator | ITopLevelPackageLocator;

export interface IPackageInformation {
  packageLocation: string;
  packageDependencies: Map<string, PnpDependencyTarget>;
  packagePeers: Set<string>;
  linkType: "HARD" | "SOFT";
  discardFromLookup: boolean;
}

export interface IResolveToUnqualifiedOptions {
  considerBuiltins?: boolean;
}

export interface IResolveUnqualifiedOptions {
  extensions?: string[];
  conditions?: Set<string>;
}

export type ResolveRequestOptions = IResolveToUnqualifiedOptions & IResolveUnqualifiedOptions;

export interface IPnpApi {
  VERSIONS: { std: number; [key: string]: number };
  topLevel: ITopLevelPackageLocator;
  getLocator(name: string, referencish: string | [string, string]): IPhysicalPackageLocator;
  getDependencyTreeRoots(): IPhysicalPackageLocator[];
  getAllLocators?(): IPhysicalPackageLocator[];
  getPackageInformation(locator: PackageLocator): IPackageInformation | null;
  findPackageLocator(location: string): PackageLocator | null;
  resolveToUnqualified(request: string, issuer: string | null, opts?: IResolveToUnqualifiedOptions): string | null;
  resolveUnqualified(unqualified: string, opts?: IResolveUnqualifiedOptions): string;
  resolveRequest(request: string, issuer: string | null, opts?: ResolveRequestOptions): string | null;
  resolveVirtual?(path: string): string | null;
}

export type PnpErrorCode =
  | "API_ERROR"
  | "BUILTIN_NODE_RESOLUTION_FAILED"
  | "EXPORTS_RESOLUTION_FAILED"
  | "INTERNAL"
  | "MISSING_DEPENDENCY"
  | "MISSING_PEER_DEPENDENCY"
  | "QUALIFIED_PATH_RESOLUTION_FAILED"
  | "UNDECLARED_DEPENDENCY"
  | "UNSUPPORTED";

/** The codes a lookup that found nothing is reported under, as node reports a
 * missing module. */
const NOT_FOUND: ReadonlySet<PnpErrorCode> = new Set<PnpErrorCode>([
  "BUILTIN_NODE_RESOLUTION_FAILED",
  "MISSING_DEPENDENCY",
  "MISSING_PEER_DEPENDENCY",
  "QUALIFIED_PATH_RESOLUTION_FAILED",
  "UNDECLARED_DEPENDENCY",
]);

export interface IPnpError extends Error {
  code: string;
  pnpCode: PnpErrorCode;
  data: Record<string, unknown>;
}

/** A PnP API failure, shaped as the runtime throws them. */
export function pnpError(pnpCode: PnpErrorCode, message: string, data: Record<string, unknown> = {}, code?: string): IPnpError {
  return Object.assign(new Error(message), {
    code: code ?? (NOT_FOUND.has(pnpCode) ? "MODULE_NOT_FOUND" : pnpCode),
    pnpCode,
    data,
  });
}
