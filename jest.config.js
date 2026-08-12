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

module.exports = {
  /* Many suites spawn real OS processes (the e2e CLI, Execute's pipeline tests);
   * under full-suite parallelism their process startup contends for CPU, so the
   * 5s jest default is too tight and flakes. 30s gives headroom while still
   * failing a genuine hang in bounded time (the e2e harness has its own 180s
   * spawnSync cap; watch/serve suites raise this further per-file). A future
   * cleanup is for unit tests not to spawn real processes at all. */
  testTimeout: 30000,
  collectCoverage: true,
  collectCoverageFrom: [
    "**/src/**/*.ts",
    "!**/node_modules/**",
    "!**/*.d.ts",
    /* The astro docs site (docs/src) is not a fabr TS package — its `astro:*`
     * virtual imports don't resolve under ts-jest */
    "!**/docs/**",
    /* The runner runtimes execute standalone in test child processes, not under
     * jest (the jest-compat one loads jest's libraries from its own tool mount) */
    "!**/packages/js/src/testRunner/**",
    "!**/packages/js/src/jestRunner/**",
    /* The bundle driver executes standalone in the bundle step (requires esbuild) */
    "!**/packages/js/src/bundleDriver/**",
    /* The CSS driver executes standalone in the css step (requires sass-embedded + lightningcss) */
    "!**/packages/js/src/cssDriver/**",
  ],
  moduleNameMapper: {
    "^@fabr-build/core$": "<rootDir>/packages/core/src/index.ts",
    "^@fabr-build/js$": "<rootDir>/packages/js/src/index.ts",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "tsconfig.base.json" }],
    /* `@napi-rs/lzma` ships its pure streaming logic as a single ESM source that
     * its CJS entries pull in with `require(esm)` — fine on the Node fabr
     * supports (and under fabr's own test runner, which uses Node's real
     * loader), but jest's module system compiles it as CJS and chokes on
     * `export`. Downlevel it so the REAL library runs here too, rather than
     * mocking the one thing the xz path depends on. */
    "^.+\\.mjs$": ["ts-jest", { tsconfig: { allowJs: true, module: "commonjs", target: "es2019" } }],
  },
  transformIgnorePatterns: ["/node_modules/(?!@napi-rs/lzma/)"],
  moduleDirectories: ["node_modules"],
  moduleFileExtensions: ["ts", "js", "mjs"],
  testRegex: ".*\\.test\\.ts$",
  /* The runner runtime's tests are node:test based and run under the fabr
   * test harness itself (fabr test @fabr-build/js), not under jest */
  testPathIgnorePatterns: [
    "/node_modules/",
    "/build/",
    "/packages/js/src/testRunner/",
    "/packages/js/src/bundleDriver/",
    "/packages/js/src/cssDriver/",
  ],
};
