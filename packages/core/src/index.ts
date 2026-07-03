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

/* Importing @fabr/core registers the bootstrap rules (enough to build any
 * further rules as plugins): js_package, npm_repository, flag, and friends. */
import "./rules/js";
import "./rules/FlagTarget";
import "./rules/GenericTarget";

export * from "./core/BuildCache";
export * from "./core/Computable";
export * from "./core/Fetch";
export * from "./core/FileSet";
export * from "./core/Flag";
export * from "./core/MemoryFS";
export * from "./core/MultiError";
export * from "./core/Provenance";
export * from "./core/Repository";
export * from "./core/SourceFileSource";
export * from "./model/BuildContext";
export * from "./model/BuildModel";
export * from "./model/Loader";
export * from "./model/Name";
export * from "./model/Property";
export { declPosn } from "./model/AST";
export * from "./support/Execute";
export * from "./support/Log";
export * from "./rules/Registry";
