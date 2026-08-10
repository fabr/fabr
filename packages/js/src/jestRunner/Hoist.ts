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
 * The load-time hoist. `jest.mock(...)` must take effect before the `require`
 * calls it affects, but a compiler emits it where it was written — after them.
 * Jest solves this by rewriting the source as it transforms it; fabr owns
 * compilation and keeps the compiled tree PURE (one artifact serves the package
 * build and the test run alike), so the rewrite happens here instead, at
 * require time, on a file about to be loaded.
 *
 * **The transform is swc's**, not jest's `babel-plugin-jest-hoist`, for two
 * measured reasons:
 *
 * 1. **babel's plugin rejects real code.** It also *validates* a factory's free
 *    variables, allowing only `mock`-prefixed names, known globals and pure
 *    `const`s — so a plain function declaration fails, though it is correct
 *    (the factory runs lazily, by which time JS has hoisted the declaration).
 *    Measured against a real suite, that rejected **18 of 40** test files. swc
 *    hoists without judging, which is why such code is ordinary today, and fabr
 *    follows it: a deliberate *lenience* divergence — fabr accepts a superset of
 *    what babel-jest accepts, never a subset, so a suite that runs under jest
 *    keeps running here.
 * 2. **It is far faster where it counts.** Each test file gets its own process,
 *    so the first-call cost is paid per file and never amortised: ~124ms with
 *    babel against ~8.5ms with swc, on that same corpus.
 *
 * Source maps are threaded through deliberately (see {@link inputMapFor}): the
 * hoist MOVES statements, so line numbers shift, and without chaining the
 * compiler's map every stack trace in a failure would point at compiled lines
 * rather than the original TypeScript.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Module } from "node:module";
import { isCodeUnderTest, jestLibrary } from "./Tools";

/** The calls jest hoists. A file mentioning none of them needs no transform,
 * which is the overwhelming majority — so this cheap token scan is what keeps
 * the hoist off the hot path. */
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
 * Wrap `Module.prototype._compile` so first-party sources are hoisted as they
 * load.
 *
 * **Scope: the code under test only, never node_modules.** The wrap sees every
 * CommonJS module in the process, and plenty of published test-utility packages
 * merely *contain* the token `jest.mock` in their shipped code; feeding one of
 * those through a transform could fail to parse and break a module that loads
 * fine today. Restricting to the staged tree is the fixed-convention analogue
 * of jest's default `transformIgnorePatterns`.
 */
export function installHoist(root: string): void {
  const compiling = Module as unknown as { prototype: ICompilingModule };
  const original = compiling.prototype._compile;
  let swc: ISwc | undefined;
  compiling.prototype._compile = function (content: string, filename: string): unknown {
    if (isCodeUnderTest(root, filename) && HOISTABLE.test(content)) {
      swc ??= jestLibrary("@swc/core") as ISwc;
      content = hoisted(swc, content, filename);
    }
    return original.call(this, content, filename);
  };
}

function hoisted(swc: ISwc, content: string, filename: string): string {
  return swc.transformSync(content, {
    filename,
    /* Already-compiled CommonJS. `isModule: false` parses it as a script, so a
     * stray top-level `this` reads as it does at runtime, and no module
     * transform is applied — the only change wanted here is the hoist. */
    isModule: false,
    jsc: {
      parser: { syntax: "ecmascript" },
      target: "es2022",
      /* The hoist pass. Undocumented in swc's published types, but load-bearing
       * for `@swc/jest` — swc's own jest transformer sets exactly this — so it
       * cannot move without breaking their own package. Should it ever move,
       * going through `@swc/jest` is the fallback (it owns the name), at the
       * cost of the per-file input map below, which it cannot accept. */
      transform: { hidden: { jest: true } },
    },
    sourceMaps: "inline",
    inputSourceMap: inputMapFor(content, filename),
  }).code;
}

/**
 * The compiler's own source map for this file, as JSON, so the hoist's map can
 * be chained onto it and a stack trace still names the original TypeScript.
 *
 * Both spellings are handled because both occur: an inline `data:` map (what a
 * single-file transform emits) and a sibling `.map` file (what fabr's `tsc`
 * emits). Undefined when there is none — a release build strips them — in which
 * case the hoist maps to the compiled file, as it must.
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
    /* Named but absent: the hoist is still correct, only less well mapped. */
    return undefined;
  }
}
