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
 * Stubs for non-JavaScript imports under test, as a jest `moduleNameMapper`
 * entry conventionally supplies them: a stylesheet import
 * (`import styles from "./Card.module.scss"`) yields an identity proxy, a
 * binary one its file name.
 *
 * Shared by every runner flavour: {@link assetStubFor} gets the stub for an
 * import, and {@link installAssetHooks} installs the stubs on node's own module
 * loaders. The jest flavour consults {@link assetStubFor} from its own module
 * registry instead, so that an explicit `jest.mock()` takes precedence.
 *
 * Runs in test processes: do not depend on core at runtime.
 */

import { Module } from "node:module";
import * as path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

/** The extensions of stylesheets, whose import yields {@link styleProxy}. */
const STYLESHEET_EXTENSIONS = ["css", "scss", "sass", "less", "styl"];

/** The extensions of binary files, whose import yields the file's name. */
const BINARY_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "avif",
  "bmp",
  "ico",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "mp4",
  "webm",
  "ogg",
  "mp3",
  "wav",
];

/** @return a pattern matching a name ending in one of `extensions`. */
function extensionPattern(extensions: string[]): RegExp {
  return new RegExp(`\\.(${extensions.join("|")})$`, "i");
}

const STYLESHEET = extensionPattern(STYLESHEET_EXTENSIONS);
const BINARY = extensionPattern(BINARY_EXTENSIONS);
const ASSET = extensionPattern([...STYLESHEET_EXTENSIONS, ...BINARY_EXTENSIONS]);

/**
 * Get the stub for an import of `request`: a fresh {@link styleProxy} for a
 * stylesheet, the file's name for a binary file, or undefined for anything
 * else. Judged on the request as written, not the resolved path, so a
 * stylesheet that was never staged (not among the target's `srcs`) is stubbed
 * too.
 */
export function assetStubFor(request: string): unknown {
  if (STYLESHEET.test(request)) {
    return styleProxy();
  }
  if (BINARY.test(request)) {
    return basenameOf(request);
  }
  return undefined;
}

/**
 * Make every stylesheet or binary import in this process yield its stub, in
 * both of node's module loaders: CommonJS (`require`, and the `import` of a
 * test compiled to CommonJS) through `Module._resolveFilename` and
 * `Module._extensions`, and ES modules through `module.registerHooks`. Both
 * judge the request as {@link assetStubFor} does, so a file that is not in the
 * installation is stubbed rather than failing to resolve. Call once, before
 * any test file loads.
 *
 * Before node 22.15, which has no `module.registerHooks`, only CommonJS
 * imports are stubbed.
 */
export function installAssetHooks(): void {
  const loader = Module as unknown as ICommonJSLoader;
  const resolveFilename = loader._resolveFilename;
  loader._resolveFilename = function (request, parent, ...rest) {
    if (ASSET.test(request)) {
      return request.startsWith(".") && parent?.filename ? path.resolve(path.dirname(parent.filename), request) : request;
    }
    return resolveFilename.call(this, request, parent, ...rest);
  };
  for (const extension of [...STYLESHEET_EXTENSIONS, ...BINARY_EXTENSIONS]) {
    loader._extensions[`.${extension}`] = (module, filename) => {
      module.exports = assetStubFor(filename);
    };
  }
  /* Absent before node 22.15. */
  const { registerHooks } = Module as unknown as { registerHooks?: (hooks: IModuleHooks) => void };
  if (registerHooks !== undefined) {
    registerHooks({
      resolve(specifier, context, next) {
        if (ASSET.test(specifier)) {
          return { url: new URL(specifier, context.parentURL ?? pathToFileURL(`${process.cwd()}/`)).href, shortCircuit: true };
        }
        return next(specifier, context);
      },
      load(url, context, next) {
        if (ASSET.test(url)) {
          /* A load hook returns module source, not a value: make the source
           * require this module and export assetStubFor's answer. */
          const stub = `createRequire(${JSON.stringify(url)})(${JSON.stringify(__filename)}).assetStubFor(${JSON.stringify(fileURLToPath(url))})`;
          return {
            format: "module",
            source: `import { createRequire } from "node:module";\nexport default ${stub};\n`,
            shortCircuit: true,
          };
        }
        return next(url, context);
      },
    });
  }
}

/** The members of node's CommonJS loader the hooks replace, which its typings omit. */
interface ICommonJSLoader {
  _resolveFilename(this: unknown, request: string, parent: { filename?: string } | undefined, ...rest: unknown[]): string;
  _extensions: Record<string, (module: { exports: unknown }, filename: string) => void>;
}

/** `module.registerHooks`'s argument, the two hooks as this module uses them. */
interface IModuleHooks {
  resolve(specifier: string, context: { parentURL?: string }, next: (specifier: string, context: unknown) => IResolved): IResolved;
  load(url: string, context: unknown, next: (url: string, context: unknown) => ILoaded): ILoaded;
}
interface IResolved {
  url: string;
  shortCircuit?: boolean;
}
interface ILoaded {
  format: string;
  source?: string;
  shortCircuit?: boolean;
}

/**
 * Make the css-modules identity proxy: every string property is its own name,
 * so `styles.cardTitle` is `"cardTitle"`. The exceptions:
 * - `__esModule` is `true` and `default` is the proxy itself, so both a
 *   compiled default import (`__importDefault(require("…scss")).default`) and
 *   a plain `require` yield the proxy.
 * - `toString` and `valueOf` behave as a plain object's, so `${styles}` is
 *   `"[object Object]"` rather than a TypeError.
 * - A symbol property is undefined, for the runtime's own inspection,
 *   iteration and coercion.
 */
function styleProxy(): unknown {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== "string") {
          return undefined;
        }
        if (property === "__esModule") {
          return true;
        }
        if (property === "default") {
          return proxy;
        }
        if (property === "toString" || property === "valueOf") {
          return () => "[object Object]";
        }
        return property;
      },
    }
  );
  return proxy;
}

/** @return the last `/`-separated part of `request`. */
function basenameOf(request: string): string {
  const at = request.lastIndexOf("/");
  return at === -1 ? request : request.slice(at + 1);
}
