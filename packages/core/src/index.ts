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

/* Importing @fabr/core registers the generic bootstrap rules (flag, script,
 * run) and core's own lib/ on the system include path. Language-specific rules
 * live in their own packages (@fabr/js et al) — the bootstrap set is
 * core + js + fabr; anything beyond that can be built by fabr itself and
 * loaded via a plugin declaration. */
import "./rules/FlagTarget";
import "./rules/DefaultFilesRule";
import "./rules/RunScript";
import "./rules/BuildRun";
import { packageLibDir, registerSystemIncludeDir } from "./model/Loader";

registerSystemIncludeDir(packageLibDir("@fabr/core"));

export * from "./core/BuildCache";
export * from "./core/Computable";
export * from "./core/Fetch";
export * from "./core/FileSet";
export * from "./core/FSFileSource";
export * from "./core/PackageFileSet";
export * from "./core/RunnableFileSet";
export * from "./core/Flag";
export * from "./core/MemoryFS";
export * from "./core/SymlinkFile";
export * from "./core/MultiError";
export * from "./core/Provenance";
export * from "./core/Repository";
export * from "./core/SourceFileSource";
export * from "./core/WatchController";
export * from "./model/BuildContext";
export * from "./model/BuildModel";
export * from "./model/ExecutionContext";
export * from "./model/Loader";
export * from "./model/Name";
export * from "./model/Property";
export { declPosn } from "./model/AST";
export * from "./resolver/MVSResolver";
export * from "./resolver/ResolutionProvenance";
export * from "./resolver/Semver";
export * from "./resolver/Types";
export * from "./support/Execute";
export * from "./support/Log";
export * from "./support/TestResult";
export * from "./support/Unpack";
export * from "./rules/ExecAction";
export * from "./rules/Registry";
export * from "./rules/Types";
