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

/* Core's rules (flag, files, script[run], serve[run], generate, patched, sync),
 * repository types (catalog, fetch, repository_group, fabr_home) and
 * lib/STD.fabr are its contribution to every load, assembled by
 * `coreContribution()` (model/Loader). Language-specific rules live in their own
 * packages (@fabr-build/js et al) and contribute through their plugin's
 * `activate()`. */

export * from "./Constants";
export * from "./Audit";
export * from "./Fabr";
export * from "./core/BuildCache";
export * from "./core/Computable";
export * from "./core/Credential";
export * from "./core/Fetch";
export * from "./core/FileSet";
export * from "./core/FSFileSource";
export * from "./core/Staging";
export * from "./core/PackageFileSet";
export * from "./core/Reference";
export * from "./core/NamespaceRef";
export * from "./core/PartialRepositoryRef";
export * from "./core/TargetRef";
export { contentStream, deleteTree, HASH_ALGORITHM, hashString, symlink } from "./core/FSWrapper";
export * from "./core/FileSetRef";
export * from "./core/RunnableFileSet";
export * from "./core/PublishableFileSet";
export * from "./core/Flag";
export * from "./core/MemoryFS";
export * from "./core/SymlinkFile";
export * from "./core/Errors";
export * from "./core/Provenance";
export * from "./core/Repository";
export * from "./core/BuildAction";
export * from "./core/Manifest";
export * from "./core/SourceFileSource";
export * from "./core/WatchController";
export * from "./core/WorkList";
export * from "./core/WriteBack";
export * from "./context/index";
export * from "./model/ModelProvenance";
export * from "./model/Target";
export * from "./model/Constraints";
export { pluginLibsOf, pluginPackageJson } from "./model/Plugin";
export * from "./model/BuildModel";
export * from "./model/BuildEvents";
export * from "./model/ErrorFormatter";
export * from "./model/ExecutionContext";
export * from "./model/Loader";
export * from "./model/Errors";
export { parseBuildString, parseName } from "./model/Parser";
export * from "./editor/Language";
export * from "./core/Name";
export * from "./model/Property";
export { declName, declPosn, isNameValue, isPropertyDecl, PropertyType, propertyTypeName, syntheticValue } from "./model/AST";
export type { IBuildFileContents, INameValue, IPropertyDecl, ITargetDecl, ITargetDefDecl, IPropertySchema } from "./model/AST";
export * from "./resolver/MVSResolver";
export * from "./resolver/Overrides";
export * from "./resolver/Requirement";
export * from "./resolver/MVSResolution";
export * from "./resolver/ResolutionProvenance";
export * from "./resolver/ResolutionReport";
export * from "./resolver/Semver";
export * from "./resolver/Types";
export * from "./support/Description";
export * from "./support/Execute";
export * from "./support/Semaphore";
export * from "./support/Expand";
export * from "./support/Functional";
export * from "./support/FetchDocument";
export * from "./support/Integrity";
export * from "./support/MemoryCache";
export * from "./support/Json";
export * from "./support/Log";
export * from "./support/Mime";
export * from "./support/Platform";
export { StringReader } from "./support/StringReader";
export * from "./support/Coverage";
export * from "./support/Sarif";
export * from "./support/TestResult";
export * from "./support/Unpack";
export * from "./support/UnpackTar";
export * from "./support/UnpackZip";
export * from "./support/PackTar";
export * from "./support/PackZip";
export type { TarEntryHeader, TarEntryType, TarHeader } from "./support/TarHeader";
export * from "./support/TarExtract";
export * from "./support/TarPack";
export * from "./support/Paths";
export * from "./resolver/PackageFormat";
export * from "./resolver/PackageResolver";
export * from "./resolver/ResolutionDoc";
export { Conflicts, NO_CONFLICTS } from "./resolver/StrictCollection";
export * from "./rules/BuildSync";
export * from "./rules/CatalogRepository";
export * from "./rules/ContentPackage";
export * from "./rules/ExecAction";
export * from "./rules/RepositoryGroup";
export * from "./rules/Types";
