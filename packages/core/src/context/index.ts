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

/* The build context's public API: a configuration of the model and the
 * context a rule runs in. Modules of this directory not exported here are
 * the framework's own. */
export { BuildContext } from "./BuildContext";
export { ResolvedTarget } from "./ResolvedTarget";
export { mapEntryError, mapEntryOrigin, PropertyMap, PropertyMapValue, toEnvironment } from "./PropertyMap";
export { TargetContext } from "./TargetContext";
export { CommandValue, MaterializedCommandPipeline, MaterializedCommandStage } from "./Commands";
export { collectLists, PERMISSIVE_RESOLUTION, ResolutionOptions } from "./CollectionPoint";
export {
  ContainedSources,
  DEPENDENCIES_KEY,
  MaterializedRequirements,
  LooseSources,
  OPTIONAL_PROVIDED_KEY,
  PackageSources,
  Permissive,
  permissive,
  PROVIDED_KEY,
  RequiredSources,
  Requirements,
  ResolvedRequirements,
  Unmaterialized,
} from "./Collection";
