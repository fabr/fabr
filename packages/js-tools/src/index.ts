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

/*
 * The runtime side of fabr's JavaScript support, as the plugin and its tests
 * use it: the documents a rule writes for a tool and a tool's reports read back
 * (options, the PnP table, the read set), the resolver behind every tool's
 * module lookup, and the drivers whose logic the plugin's tests drive. The test
 * runners are not exported: they load into test processes only.
 */

export * from "./bundleDriver/BundleOptions";
export * from "./cssDriver/Options";
export * from "./cssDriver/Support";
export * from "./pnp/PackageExports";
export * from "./pnp/PnPApi";
export * from "./pnp/PnPResolver";
export * from "./pnp/PnPState";
export * from "./pnp/ReadSet";
export * from "./pnp/VirtualPath";
export * from "./tscDriver/Planning";
export * as BundleDriver from "./bundleDriver/bundle-driver";
export * as SassDriver from "./cssDriver/sass-driver";
export * as TscDriver from "./tscDriver/tsc-driver";
