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
  collectCoverage: true,
  collectCoverageFrom: [
    "**/src/**/*.ts",
    "!**/node_modules/**",
    "!**/*.d.ts",
    /* The astro docs site (docs/src) is not a fabr TS package — its `astro:*`
     * virtual imports don't resolve under ts-jest */
    "!**/docs/**",
    /* The runner runtime executes standalone under fabr test, not under jest */
    "!**/packages/js/src/testRunner/**",
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
  },
  moduleDirectories: ["node_modules"],
  moduleFileExtensions: ["ts", "js"],
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
