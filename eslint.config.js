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

const tslint = require("typescript-eslint");
const eslint = require("@eslint/js");

module.exports = tslint.config(
  { ignores: ["**/build/**", "**/node_modules/**", "coverage/**"] },
  eslint.configs.recommended,
  ...tslint.configs.recommended,
  {rules: {
    "@typescript-eslint/no-empty-function": 0,
    "@typescript-eslint/no-this-alias": 0,
    "@typescript-eslint/indent": 0,
    "@typescript-eslint/explicit-function-return-type": ["error", {allowExpressions: true}],
    "@typescript-eslint/no-inferrable-types": 0,
    "@typescript-eslint/no-namespace": 0,
    "@typescript-eslint/no-non-null-assertion": 0,
    "@typescript-eslint/no-explicit-any": "warn",
    /* A `_`-prefixed parameter is deliberately unused — the convention throughout,
     * used to keep an interface method's signature readable in an implementation
     * that ignores an argument. The default `args: "after-used"` honors it only in
     * non-trailing position, which flags exactly the same intent inconsistently. */
    "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
  }},
);