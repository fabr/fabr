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

/**
 * The load-time hoist: `jest.mock(...)` and its kin are moved above the
 * `require` calls they affect as a compiled file is loaded, by swc's jest hoist
 * pass. Unlike jest's `babel-plugin-jest-hoist`, it does not check a mock
 * factory's free variables, so it accepts every file babel-jest accepts and
 * more. The compiler's source map is chained into the hoisted file's, so a
 * stack trace still names the original source.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Module } from "node:module";
import { isCodeUnderTest, runnerDependency } from "./Tools";

/** The calls jest hoists. A file mentioning none of them is not transformed. */
const HOISTABLE = /\bjest\s*\.\s*(mock|unmock|deepUnmock|enableAutomock|disableAutomock)\s*\(/;

/** Where a compiled file names its source map. */
const MAP_URL = /\/\/#\s*sourceMappingURL=(\S+)\s*$/m;

interface ICompilingModule {
  _compile(content: string, filename: string): unknown;
}

interface ISwc {
  transformSync(code: string, options: unknown): { code: string };
}

/**
 * Wrap `Module.prototype._compile` so that a file of the code under test below
 * `root` that calls a hoistable `jest` method is hoisted as it loads. Nothing
 * in `node_modules` is transformed, as with jest's default
 * `transformIgnorePatterns`: a published package may contain the token and fail
 * to parse as a script.
 */
export function installHoist(root: string): void {
  const compiling = Module as unknown as { prototype: ICompilingModule };
  const original = compiling.prototype._compile;
  let swc: ISwc | undefined;
  compiling.prototype._compile = function (content: string, filename: string): unknown {
    if (isCodeUnderTest(root, filename) && HOISTABLE.test(content)) {
      swc ??= runnerDependency("@swc/core") as ISwc;
      content = hoisted(swc, content, filename);
    }
    return original.call(this, content, filename);
  };
}

function hoisted(swc: ISwc, content: string, filename: string): string {
  return swc.transformSync(content, {
    filename,
    /* Already-compiled CommonJS: parse it as a script, so a top-level `this`
     * reads as at runtime, and apply no module transform. */
    isModule: false,
    jsc: {
      parser: { syntax: "ecmascript" },
      target: "es2022",
      /* The hoist pass: undocumented in swc's types, and what `@swc/jest`
       * sets. */
      transform: { hidden: { jest: true } },
    },
    sourceMaps: "inline",
    inputSourceMap: inputMapFor(content, filename),
  }).code;
}

/**
 * Read the source map a compiled file names, as JSON text: an inline base64
 * `data:` map, or a file relative to it (what the tsc driver emits).
 * @return the map, or undefined where the file names none (a release build) or
 *   the named file cannot be read.
 */
function inputMapFor(content: string, filename: string): string | undefined {
  const url = MAP_URL.exec(content)?.[1];
  if (url === undefined) {
    return undefined;
  }
  const inline = /^data:application\/json;(?:charset=[^;]+;)?base64,(.*)$/.exec(url);
  if (inline) {
    return Buffer.from(inline[1], "base64").toString("utf8");
  }
  try {
    return fs.readFileSync(path.resolve(path.dirname(filename), url), "utf8");
  } catch {
    /* Named but absent: hoist without an input map. */
    return undefined;
  }
}
