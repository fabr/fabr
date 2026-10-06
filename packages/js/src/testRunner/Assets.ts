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
 * Non-JavaScript imports, under test.
 *
 * A component that does `import styles from "./Card.module.scss"` is asking a
 * BUNDLER for something; under test there is no bundler, and handing the file
 * to node gets a syntax error. Every jest project solves this the same way — a
 * `moduleNameMapper` entry pointing stylesheets at an identity proxy and
 * binaries at a string stub — so fabr does it in the loader instead, because
 * the loader is already the place a request is intercepted. That is one fewer
 * thing a project has to declare, and it removes the commonest reason a suite
 * needs `moduleNameMapper` at all.
 *
 * Shared by every runner flavour: the stubs ({@link assetStubFor}) are what an
 * asset import yields, and {@link installAssetHooks} puts them on node's own
 * loader seams for a flavour that loads through node directly. The jest
 * flavour consults the stubs from its own module registry instead, so that an
 * explicit `jest.mock()` keeps precedence over them.
 *
 * Executes in test child processes: no dependency on the host's core.
 */

import { Module } from "node:module";
import * as path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

/** Stylesheets: the import yields the class-name map a css-modules loader would
 * have produced. */
const STYLESHEET_EXTENSIONS = ["css", "scss", "sass", "less", "styl"];

/** Binaries a bundler would have turned into a URL. */
const BINARY_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "bmp", "ico", "woff", "woff2", "ttf", "otf", "eot", "mp4", "webm", "ogg", "mp3", "wav"];

function extensionPattern(extensions: string[]): RegExp {
  return new RegExp(`\\.(${extensions.join("|")})$`, "i");
}

const STYLESHEET = extensionPattern(STYLESHEET_EXTENSIONS);
const BINARY = extensionPattern(BINARY_EXTENSIONS);
const ASSET = extensionPattern([...STYLESHEET_EXTENSIONS, ...BINARY_EXTENSIONS]);

/**
 * The stub for `request`, or undefined if it is ordinary JavaScript.
 *
 * Judged on the REQUEST rather than the resolved path, deliberately: a
 * stylesheet that was never staged (not among the target's `srcs`) does not
 * resolve at all, and it must still be stubbed rather than becoming a confusing
 * "cannot find module". `undefined` means "ordinary JavaScript, not ours".
 */
export function assetStubFor(request: string): unknown {
  if (STYLESHEET.test(request)) {
    return styleProxy();
  }
  if (BINARY.test(request)) {
    /* What a bundler emits is a URL; what a test can meaningfully assert on is
     * the file's name, which is also what the common stub modules return. */
    return basenameOf(request);
  }
  return undefined;
}

/**
 * Make every asset import in this process yield its stub, on both of node's
 * loader seams: CommonJS (`require`, and the `import` of a test compiled to
 * CommonJS) through the module system's resolve and extension hooks, and ES
 * modules through `module.registerHooks`. Both judge the request, as
 * {@link assetStubFor} does, so an asset that is not in the installation stubs
 * rather than failing to resolve. Call once, before any test file loads.
 *
 * The ES-module seam needs node 22.15; on an older node only CommonJS is
 * covered, which is all a flavour whose tests compile to CommonJS loads.
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
  /* Reached dynamically: registerHooks postdates the @types/node fabr builds
   * against. */
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
          /* The stub cannot be handed over as a value, only as module source:
           * one that reaches back here for it. */
          const stub = `createRequire(${JSON.stringify(url)})(${JSON.stringify(__filename)}).assetStubFor(${JSON.stringify(fileURLToPath(url))})`;
          return { format: "module", source: `import { createRequire } from "node:module";\nexport default ${stub};\n`, shortCircuit: true };
        }
        return next(url, context);
      },
    });
  }
}

/** The parts of node's CommonJS loader the hooks sit on; not in its typings. */
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
 * The css-modules identity proxy: every property is its own name, so
 * `styles.cardTitle` is `"cardTitle"` and a className assertion reads exactly as
 * the source does.
 *
 * The interop members are the subtlety. A compiled `import styles from "…scss"`
 * becomes `__importDefault(require("…scss")).default`, and the helper branches
 * on `__esModule` — so a proxy that answered every property with its own name
 * would report `__esModule` as the truthy string `"__esModule"`, be taken for an
 * ES module, and hand back `"default"` as the styles object. Answering
 * `__esModule` with `true` and `default` with the proxy itself makes both the
 * default-import and the plain-`require` forms yield the map.
 */
function styleProxy(): unknown {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_target, property) {
        /* Symbols are the runtime's own probing (inspection, iteration,
         * coercion); answering them with a string breaks it. */
        if (typeof property !== "string") {
          return undefined;
        }
        if (property === "__esModule") {
          return true;
        }
        if (property === "default") {
          return proxy;
        }
        /* Coercion must not blow up. `${styles}` looks up `toString` and then
         * `valueOf`, and a map that answered those with their own NAMES would
         * hand back a string where a function is required — "Cannot convert
         * object to primitive value", from a template literal that reads
         * perfectly reasonably. Behaving like a plain object is the least
         * surprising thing available. */
        if (property === "toString" || property === "valueOf") {
          return () => "[object Object]";
        }
        return property;
      },
    }
  );
  return proxy;
}

function basenameOf(request: string): string {
  const at = request.lastIndexOf("/");
  return at === -1 ? request : request.slice(at + 1);
}
