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
 * The declarations of facts about the machine fabr runs on, made in code at
 * the start of a run rather than read from a build file: `HOST` in `<host>`,
 * and `ENV`, the environment fabr was started with, in `<environment>`. They
 * are ordinary declarations, so a project's own declaration of either name is
 * a conflict, and only a constraint (`-D`) answers for them instead.
 */

import { EMPTY_FILESET } from "../core/FileSet";
import { Name } from "../core/Name";
import { SecureString } from "../core/SecureString";
import { StringReader } from "../support/StringReader";
import { DeclKind, IBuildFile, IBuildFileContents, IPropertyDecl } from "./AST";
import { ENV, HOST } from "./Constraints";

/** The virtual build file `HOST` is declared in. */
export const HOST_FILE = "<host>";

/** The virtual build file `ENV` is declared in. */
export const ENVIRONMENT_FILE = "<environment>";

/**
 * Make the declarations of the machine fabr runs on: `HOST = <host>;`, the
 * platform triple, and `ENV`, a MAP of each variable of `environment` to its
 * value, each value masked, shown as `${ENV.NAME}`.
 */
export function hostDeclarations(host: string, environment: ReadonlyMap<string, string>): IBuildFileContents[] {
  return [hostFile(host), environmentFile(environment)];
}

/** Make `<host>`, declaring `HOST = <host>;`. */
function hostFile(host: string): IBuildFileContents {
  const text = `${HOST} = ${host};\n`;
  const source = virtualFile(HOST_FILE, text);
  const valueAt = text.indexOf("=") + 2;
  return contentsOf({
    kind: DeclKind.Property,
    name: Name.fromLiteral(HOST),
    source,
    offset: 0,
    endOffset: HOST.length,
    values: [{ kind: DeclKind.NameValue, value: Name.fromLiteral(host), source, offset: valueAt, endOffset: valueAt + host.length }],
  });
}

/**
 * Make `<environment>`, declaring `ENV = { NAME = value; … };`, the
 * variables in name order. Its text, which a diagnostic excerpts, shows each
 * value as it is shown everywhere else, `${ENV.NAME}`.
 */
function environmentFile(environment: ReadonlyMap<string, string>): IBuildFileContents {
  const names = [...environment.keys()].sort();
  let text = `${ENV} = {\n`;
  const at: Array<{ name: string; offset: number; valueAt: number; shown: string }> = [];
  for (const name of names) {
    const shown = "${" + `${ENV}.${name}` + "}";
    const offset = text.length + 2;
    at.push({ name, offset, valueAt: offset + name.length + 3, shown });
    text += `  ${name} = ${shown};\n`;
  }
  text += "};\n";
  const source = virtualFile(ENVIRONMENT_FILE, text);
  const entries = at.map(({ name, offset, valueAt, shown }): IPropertyDecl => ({
    kind: DeclKind.Property,
    name: Name.fromLiteral(name),
    source,
    offset,
    endOffset: offset + name.length,
    values: [
      {
        kind: DeclKind.NameValue,
        value: Name.fromSecureString(SecureString.masked(environment.get(name)!, shown)),
        source,
        offset: valueAt,
        endOffset: valueAt + shown.length,
      },
    ],
  }));
  const blockAt = text.indexOf("{");
  return contentsOf({
    kind: DeclKind.Property,
    name: Name.fromLiteral(ENV),
    source,
    offset: 0,
    endOffset: ENV.length,
    entriesOnly: true,
    values: [{ kind: DeclKind.MapValue, entries, source, offset: blockAt, endOffset: text.lastIndexOf("}") + 1 }],
  });
}

/** Make the virtual build file `file`, whose text is `text`. */
function virtualFile(file: string, text: string): IBuildFile {
  return { fs: EMPTY_FILESET, file, reader: new StringReader(text) };
}

/** Make a build file's contents of the one declaration `property`. */
function contentsOf(property: IPropertyDecl): IBuildFileContents {
  return {
    targets: [],
    targetdefs: [],
    properties: [property],
    defaults: [],
    includes: [],
    plugins: [],
    rules: [],
    repositories: [],
  };
}
