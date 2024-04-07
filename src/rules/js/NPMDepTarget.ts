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

import { BuildContext } from "../../model/BuildContext";
import { PropertyType, ResolvedType } from "../Types";
import { BaseDependencySchema } from "../Common";
import { Computable } from "../../core/Computable";
import { EMPTY_FILESET, FileSet } from "../../core/FileSet";
import { registerTargetRule } from "../Registry";
import { fetchUrl } from "../../core/Fetch";

const NPMDepSchema = {
  properties: {
    deps: {
      required: true,
      type: PropertyType.StringList,
    },
    ...BaseDependencySchema.properties,
  },
  globals: {
    npm_repo: PropertyType.String,
  },
} as const;

type NPMDepType = ResolvedType<typeof NPMDepSchema>;

interface IDepSpec {
  name: string;
  version: string;
}

export function parseDepSpec(dep: string): IDepSpec {
  const idx = dep.indexOf(":");
  if (idx === -1) {
    return { name: dep, version: "latest" };
  } else {
    return { name: dep.substring(0, idx), version: dep.substring(idx + 1) };
  }
}

interface Signature {
  keyid: string;
  sig: string;
}
interface NPMPackageMetadata {
  dependencies: Record<string, string>;
  dist: {
    fileCount: number;
    integrity: string;
    "npm-signature": string;
    shasum: string;
    signatures: Signature[];
    tarball: string;
    unpackedSize: number;
  };
  name: string;
  version: string;
  /* and potentially lots of other stuff that we don't need */
}

function getNpmMetadata(repo: string, spec: IDepSpec): Computable<NPMPackageMetadata> {
  /* FIXME: Validate response schema */
  const url = `${repo}/${spec.name}/${spec.version}`;
  return fetchUrl(url).then(data => JSON.parse(data.toString()));
}

function fetchNpmDeps(spec: NPMDepType, config: BuildContext): Computable<FileSet> {
  /* STUB */
  const baseUrl = spec.npm_repo;
  console.log("Fetching from " + baseUrl);
  const deps = spec.deps.map(dep => {
    const ds = parseDepSpec(dep);
    return getNpmMetadata(baseUrl, ds);
  });

  return Computable.forAll(deps, (...npm) => {
    npm.forEach(pkg => {
      console.log(pkg.name + ": " + pkg.dist.tarball);
    });

    return EMPTY_FILESET;
  });
}

registerTargetRule("npm_dep", NPMDepSchema, fetchNpmDeps);
