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

import * as fs from "fs";
import { builtinModules } from "module";
import * as path from "path";
import * as ts from "typescript";
import { SKIPPED_DIRECTORIES } from "./Workspace";

/** The extensions of the source files scanned for imports. */
export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** Directories holding a package manager's or a build's output, never sources. */
const OUTPUT_DIRECTORIES = new Set(["dist", "build", "out", "coverage", ".next", ".turbo", ".cache"]);

/** A tool's configuration at a package's root (`jest.config.js`, `.eslintrc.cjs`), which is no source. */
const TOOL_CONFIG = /^(?:\..*|.*\.config\.[^.]+)$/;

/** The test frameworks' calls whose first argument names a module (`jest.mock("x")`). */
const MODULE_CALLS = new Map([
  ["jest", new Set(["mock", "doMock", "unmock", "requireActual", "requireMock"])],
  ["vi", new Set(["mock", "doMock", "unmock", "importActual", "importMock"])],
]);

const PACKAGE_NAME = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;

const BUILTINS = new Set(builtinModules);

/** The source files of a package and the packages they import. */
export interface SourceScan {
  /** The source files, relative to the package's directory. */
  readonly files: ReadonlyArray<string>;
  /** The package names the files import by a bare specifier, builtins excluded. */
  readonly imports: ReadonlySet<string>;
}

/** @return the package a bare `specifier` imports, or undefined where it imports
 * a file, a builtin or a scheme (`node:`, `virtual:`). */
export function importedPackage(specifier: string): string | undefined {
  if (/^[./#~]/.test(specifier) || specifier.includes(":") || specifier.startsWith("@/")) {
    return undefined;
  }
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  return PACKAGE_NAME.test(name) && !BUILTINS.has(name) ? name : undefined;
}

/** @return the module `node` names where it is a string literal, otherwise undefined. */
function literal(node: ts.Node | undefined): string | undefined {
  return node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined;
}

/** @return the module a node of a source names, or undefined where it names none: an import or
 * export declaration, `import x = require()`, `require()`, `import()`, an `import("x")` type, or a
 * test framework's module call. */
function specifierOf(node: ts.Node): string | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return literal(node.moduleSpecifier);
  }
  if (ts.isExternalModuleReference(node)) {
    return literal(node.expression);
  }
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
    return literal(node.argument.literal);
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const named =
      callee.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(callee) && callee.text === "require") ||
      (ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        MODULE_CALLS.get(callee.expression.text)?.has(callee.name.text) === true);
    return named ? literal(node.arguments[0]) : undefined;
  }
  return undefined;
}

/** @return the packages the source `text` of `fileName` imports, leaving out a specifier `isLocal`
 * says names one of the project's own files. */
export function importsOf(text: string, fileName: string, isLocal: (specifier: string) => boolean = () => false): Set<string> {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false);
  const specifiers = source.typeReferenceDirectives.map(directive => directive.fileName);
  const visit = (node: ts.Node): void => {
    const specifier = specifierOf(node);
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const found = new Set<string>();
  for (const specifier of specifiers) {
    const name = isLocal(specifier) ? undefined : importedPackage(specifier);
    if (name !== undefined) {
      found.add(name);
    }
  }
  return found;
}

/** Scan the package in `dir` (absolute), leaving out the directories in `nested`
 * (other packages within it, absolute), and the specifiers `isLocal` says name
 * the project's own files. */
export function scanSources(dir: string, nested: ReadonlySet<string>, isLocal?: (specifier: string) => boolean): SourceScan {
  const files: string[] = [];
  const imports = new Set<string>();
  const walk = (rel: string): void => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name) && !OUTPUT_DIRECTORIES.has(entry.name) && !nested.has(path.join(dir, child))) {
          walk(child);
        }
      } else if (
        entry.isFile() &&
        SOURCE_EXTENSIONS.includes(path.extname(entry.name)) &&
        !(rel === "" && TOOL_CONFIG.test(entry.name))
      ) {
        files.push(child);
        importsOf(fs.readFileSync(path.join(dir, child), "utf8"), child, isLocal).forEach(name => imports.add(name));
      }
    }
  };
  walk("");
  return { files: files.sort(), imports };
}
