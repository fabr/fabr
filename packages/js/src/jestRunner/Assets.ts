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
 * binaries at a string stub — so fabr does it directly in the loader instead,
 * because the loader is already the place a request is intercepted. That is one
 * fewer thing a project has to declare, and it removes the commonest reason a
 * suite needs `moduleNameMapper` at all.
 *
 * A project that wants something else keeps full control: an explicit
 * `jest.mock()` is consulted first (see Registry.serve), so these are defaults,
 * not policy.
 */

/** Stylesheets: the import yields the class-name map a css-modules loader would
 * have produced. */
const STYLESHEET = /\.(css|scss|sass|less|styl)$/i;

/** Binaries a bundler would have turned into a URL. */
const BINARY = /\.(png|jpe?g|gif|svg|webp|avif|bmp|ico|woff2?|ttf|otf|eot|mp4|webm|ogg|mp3|wav)$/i;

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
