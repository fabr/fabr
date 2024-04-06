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

import { Log } from "../support/Log";
import { BuildModel } from "./BuildModel";
import { IBuildFileContents } from "./AST";
import { NamespaceBuilder } from "./NamespaceBuilder";

/**
 * Collate and validate  the declarations from all included build files to the extent
 * that we can (ie we accept that some potential issues can only be detected given
 * a concrete BuildConfig)
 */
export function toBuildModel(files: IBuildFileContents[], log: Log): BuildModel {
  const builder = new NamespaceBuilder(log);

  files.forEach(file => {
    file.namespaces.forEach(ns => builder.addNamespaceDecl(ns));
    file.properties.forEach(prop => builder.addDecl(prop));
    file.defaults.forEach(prop => builder.addDefaultDecl(prop));
    file.targetdefs.forEach(def => builder.addDecl(def));
    file.targets.forEach(target => builder.addDecl(target));
  });

  builder.resolve();

  return new BuildModel(builder.toNamespace());
}
