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

/* The generic bootstrap rules (flag, files, script[run], run) and core's own
 * lib/ are core's contribution to every build's registry — assembled by
 * `coreContribution()` (model/Loader) and seeded per load, not registered by an
 * import side effect. Language-specific rules live in their own packages
 * (@fabr-build/js et al) and contribute via their plugin `activate()`: the bootstrap
 * set is core + js + fabr; anything beyond that can be built by fabr itself and
 * loaded via a plugin declaration. */

export * from "./core/BuildCache";
export * from "./core/Computable";
export * from "./core/Fetch";
export * from "./core/FileSet";
export * from "./core/FSFileSource";
export * from "./core/Staging";
export * from "./core/PackageFileSet";
export * from "./core/FileSetRef";
export * from "./core/RunnableFileSet";
export * from "./core/PublishableFileSet";
export * from "./core/Flag";
export * from "./core/MemoryFS";
export * from "./core/SymlinkFile";
export * from "./core/Errors";
export * from "./core/Provenance";
export * from "./core/Repository";
export * from "./core/SourceFileSource";
export * from "./core/WatchController";
export * from "./core/WorkList";
export * from "./core/WriteBack";
export * from "./model/BuildContext";
export * from "./model/Constraints";
export * from "./model/BuildModel";
export * from "./model/ExecutionContext";
export * from "./model/Loader";
export * from "./model/Errors";
export { parseName } from "./model/Parser";
export * from "./core/Name";
export * from "./model/Property";
export { declName, declPosn, isNameValue, PropertyType, syntheticValue } from "./model/AST";
export type { INameValue, IPropertyDecl, ITargetDecl, ITargetDefDecl, IPropertySchema } from "./model/AST";
export * from "./resolver/MVSResolver";
export * from "./resolver/Overrides";
export * from "./resolver/ResolutionGraph";
export * from "./resolver/ResolutionProvenance";
export * from "./resolver/ResolutionReport";
export * from "./resolver/Semver";
export * from "./resolver/Types";
export * from "./support/Execute";
export * from "./support/Expand";
export * from "./support/Functional";
export * from "./support/Integrity";
export * from "./support/Json";
export * from "./support/Log";
export * from "./support/Mime";
export * from "./support/Platform";
export { StringReader } from "./support/StringReader";
export * from "./support/TestResult";
export * from "./support/Unpack";
export * from "./support/Pack";
export * from "./support/Paths";
export * from "./resolver/PackageFormat";
export * from "./resolver/PackageResolver";
export * from "./resolver/ResolutionDoc";
export * from "./rules/BuildSync";
export * from "./rules/CatalogRepository";
export * from "./rules/ContentPackage";
export * from "./rules/ExecAction";
export * from "./rules/RepositoryGroup";
export * from "./rules/Types";
