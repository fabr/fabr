/*
 * Copyright (c) 2022 Nathan Keynes <nkeynes@deadcoderemoval.net>
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

import { BuildConfig } from "../../model/BuildModel";
import { ResolvedType } from "../Types";
import { BaseLanguageSchema } from "../Common";
import { Computable } from "../../core/Computable";
import { FileSet } from "../../core/FileSet";
import { registerTargetRule } from "../Registry";

const JSPackageSchema = BaseLanguageSchema;
type JSPackageType = ResolvedType<typeof JSPackageSchema>;

function buildJsPackage(spec: JSPackageType, config: BuildConfig): Computable<FileSet> {
  /* STUB */
  return new Computable<FileSet>();
}

registerTargetRule("js_package", JSPackageSchema, buildJsPackage);
